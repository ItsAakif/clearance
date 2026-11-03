// Route/integration contract for the Deep catalogue sweep.
//
// Real `sweepBoards` and the real route wiring run against fake Prisma and a
// fake workable adapter (no network). Pins:
//   - a deep run calls the sweep and writes `sweep` onto the run snapshot,
//   - a failed sweep leaves the title-search response intact,
//   - POST /jobs/sweep requires auth and validates its body,
//   - the cursor/cycle progress stored in AppSetting.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { prismaMocks, runSourceMock, seedMock, healthMocks, fetchWorkableMock } = vi.hoisted(() => ({
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    appSetting: { findUnique: vi.fn(), upsert: vi.fn() },
    companyCareerPage: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  runSourceMock: vi.fn(),
  seedMock: vi.fn(),
  healthMocks: { recordSourceSuccess: vi.fn(), recordSourceFailure: vi.fn() },
  fetchWorkableMock: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id || typeof id !== 'string') return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

vi.mock('../jobSources/defaultBoards.js', () => ({
  seedDefaultBoardsForUser: (...args: any[]) => seedMock(...args),
}));

vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

vi.mock('../jobSources/sourceHealth.js', () => ({
  recordSourceSuccess: (...args: any[]) => healthMocks.recordSourceSuccess(...args),
  recordSourceFailure: (...args: any[]) => healthMocks.recordSourceFailure(...args),
}));

// Only workable rows are seeded, so only this adapter needs a fake. Any other
// provider would be a real network call, which the fixtures never create.
vi.mock('../jobSources/adapters/workable.js', () => ({
  fetchWorkable: (...args: any[]) => fetchWorkableMock(...args),
}));

import jobsRouter, { SWEEP_PROVIDER_ADAPTERS } from './jobs.js';
import { SWEEP_PROVIDER_SOURCES } from '../discovery/sweepCycle.js';
import { resetRunsForTests } from '../jobSources/discoveryRuns.js';

const settings = new Map<string, string>();
let careerPages: Array<{ id: string; provider: string; boardToken: string }> = [];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

function boardRow(overrides: Record<string, any> = {}) {
  return {
    id: 'board-1',
    name: 'Board One',
    type: 'json',
    boardId: null,
    feedUrl: 'https://remotive.com/api/remote-jobs',
    searchQuery: null,
    searchSite: null,
    scraperProvider: null,
    scraperLocation: null,
    scraperResults: null,
    scraperUseProxy: false,
    aggregatorProvider: null,
    aggregatorLocation: null,
    ...overrides,
  };
}

function careerPage(id: string, token: string) {
  return { id, provider: 'workable', boardToken: token };
}

function rawJob(token: string, n: number) {
  return {
    externalId: `${token}-${n}`,
    source: 'workable',
    sourceUrl: `https://example.com/${token}/${n}`,
    title: `Engineer ${token}-${n}`,
    company: 'Acme',
    location: 'Remote',
    description: `Build things ${n}.`,
    applyUrl: `https://example.com/${token}/${n}`,
  };
}

const TITLE_JOB = {
  externalId: 'json-1',
  source: 'json',
  sourceUrl: 'https://example.com/jobs/1',
  title: 'Senior Backend Engineer',
  company: 'Acme Corp',
  location: 'Berlin',
  description: 'Build backend APIs.',
  applyUrl: 'https://example.com/jobs/1',
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRunsForTests();
  settings.clear();
  careerPages = [];

  prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
  prismaMocks.jobListing.findUnique.mockResolvedValue(null);
  prismaMocks.jobListing.update.mockResolvedValue(undefined);
  prismaMocks.jobListing.upsert.mockImplementation(async ({ create }: any) => ({
    id: `id-${create.source}-${create.externalId}`,
    source: create.source,
    title: create.title,
    company: create.company,
    location: create.location,
    applyUrl: create.applyUrl,
    sourceUrl: create.sourceUrl,
    postedAt: create.postedAt ?? null,
    firstSeenAt: create.firstSeenAt ?? null,
    isActive: true,
    description: create.description,
    searchDocument: null,
  }));
  prismaMocks.appSetting.findUnique.mockImplementation(async ({ where }: any) => {
    return settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null;
  });
  prismaMocks.appSetting.upsert.mockImplementation(async ({ where, update, create }: any) => {
    settings.set(where.key, update?.value ?? create?.value);
    return { key: where.key, value: update?.value ?? create?.value };
  });
  prismaMocks.companyCareerPage.findMany.mockImplementation(async ({ where, take }: any) => {
    const after = where?.id?.gt ?? '';
    const supported: string[] = where?.provider?.in ?? [];
    return careerPages
      .filter((p) => p.id > after && supported.includes(p.provider))
      .slice(0, take);
  });
  prismaMocks.companyCareerPage.findUnique.mockResolvedValue({
    failureCount: 0,
    isActive: true,
    verifiedAt: null,
  });
  prismaMocks.companyCareerPage.update.mockResolvedValue(undefined);

  runSourceMock.mockResolvedValue([{ ...TITLE_JOB }]);
  fetchWorkableMock.mockImplementation(async (token: string) =>
    token === 'token-1' ? [rawJob(token, 1), rawJob(token, 2)] : [rawJob(token, 3)],
  );
});

describe('Deep /search - catalogue sweep wiring', () => {
  it('runs the sweep after the title phase and records it on the snapshot', async () => {
    careerPages = [careerPage('p001', 'token-1'), careerPage('p002', 'token-2')];

    const search = await request(makeApp())
      .get('/jobs/search?q=engineer&mode=deep&runId=run-deep-sweep-1')
      .set('x-test-user', 'user-1');

    expect(search.status).toBe(200);
    // The response remains the title-search array (sweep rows are catalogue
    // rows, not response rows).
    expect(Array.isArray(search.body)).toBe(true);
    expect(search.body).toHaveLength(1);

    expect(fetchWorkableMock).toHaveBeenCalledWith('token-1', '');
    expect(fetchWorkableMock).toHaveBeenCalledWith('token-2', '');

    const snap = await request(makeApp())
      .get('/jobs/runs/run-deep-sweep-1')
      .set('x-test-user', 'user-1');
    expect(snap.status).toBe(200);
    expect(snap.body.sweep).toEqual({
      boards: 2,
      ok: 2,
      failed: 0,
      rowsFetched: 3,
      rowsPersisted: 3,
      exhausted: true,
    });
  });

  it('a failed sweep never fails the search and is recorded as an error', async () => {
    prismaMocks.companyCareerPage.findMany.mockRejectedValueOnce(new Error('registry down'));

    const search = await request(makeApp())
      .get('/jobs/search?q=engineer&mode=deep&runId=run-deep-sweep-fail')
      .set('x-test-user', 'user-1');

    expect(search.status).toBe(200);
    expect(search.body).toHaveLength(1);

    const snap = await request(makeApp())
      .get('/jobs/runs/run-deep-sweep-fail')
      .set('x-test-user', 'user-1');
    expect(snap.status).toBe(200);
    expect(snap.body.sweep).toMatchObject({
      boards: 0,
      ok: 0,
      failed: 0,
      rowsFetched: 0,
      rowsPersisted: 0,
      exhausted: false,
      error: 'registry down',
    });
  });

  it('does not sweep outside deep mode', async () => {
    careerPages = [careerPage('p001', 'token-1')];

    const search = await request(makeApp())
      .get('/jobs/search?q=engineer&runId=run-fast-no-sweep')
      .set('x-test-user', 'user-1');
    expect(search.status).toBe(200);
    expect(fetchWorkableMock).not.toHaveBeenCalled();

    const snap = await request(makeApp())
      .get('/jobs/runs/run-fast-no-sweep')
      .set('x-test-user', 'user-1');
    expect(snap.body.sweep).toBeUndefined();
  });
});

describe('POST /jobs/sweep', () => {
  it('requires auth', async () => {
    const res = await request(makeApp()).post('/jobs/sweep').send({ boards: 1 });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect(fetchWorkableMock).not.toHaveBeenCalled();
  });

  it('validates boards and maxRows', async () => {
    const zero = await request(makeApp())
      .post('/jobs/sweep')
      .set('x-test-user', 'user-1')
      .send({ boards: 0 });
    expect(zero.status).toBe(400);
    expect(zero.body.error).toBe('boards must be a positive number');

    const badRows = await request(makeApp())
      .post('/jobs/sweep')
      .set('x-test-user', 'user-1')
      .send({ maxRows: 'many' });
    expect(badRows.status).toBe(400);
    expect(badRows.body.error).toBe('maxRows must be a positive number');
    expect(fetchWorkableMock).not.toHaveBeenCalled();
  });

  it('sweeps a batch and persists the cursor; a short batch wraps and bumps the cycle', async () => {
    careerPages = [
      careerPage('p001', 'token-1'),
      careerPage('p002', 'token-2'),
      careerPage('p003', 'token-3'),
    ];

    const first = await request(makeApp())
      .post('/jobs/sweep')
      .set('x-test-user', 'user-1')
      .send({ boards: 2 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      boards: 2,
      ok: 2,
      failed: 0,
      rowsFetched: 3,
      rowsPersisted: 3,
      nextCursor: 'p002',
      exhausted: false,
      failures: [],
    });
    expect(settings.get('deepSweep:cursor')).toBe('p002');

    const second = await request(makeApp())
      .post('/jobs/sweep')
      .set('x-test-user', 'user-1')
      .send({ boards: 5 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      boards: 1,
      ok: 1,
      nextCursor: 'p003',
      exhausted: true,
    });
    expect(settings.get('deepSweep:cursor')).toBe('');
    expect(settings.get('deepSweep:cycle')).toBe('1');
    expect(fetchWorkableMock).toHaveBeenCalledTimes(3);
  });
});

describe('provider map', () => {
  it('covers every registry provider with a keyless adapter (including rippling)', () => {
    expect(Object.keys(SWEEP_PROVIDER_ADAPTERS).sort()).toEqual([
      'ashby',
      'bamboohr',
      'breezy',
      'freshteam',
      'greenhouse',
      'jobvite',
      'lever',
      'pinpointhq',
      'recruitee',
      'rippling',
      'smartrecruiters',
      'teamtailor',
      'workable',
    ]);
    expect(SWEEP_PROVIDER_ADAPTERS.rippling).toBeTypeOf('function');
  });

  it('has a canonical JobListing source for every swept provider', () => {
    // The soft-close filter is built from this map, so a provider with an
    // adapter but no source name would silently never be closed (and a stale
    // entry would close a source no adapter owns).
    expect(Object.keys(SWEEP_PROVIDER_SOURCES).sort()).toEqual(
      Object.keys(SWEEP_PROVIDER_ADAPTERS).sort(),
    );
  });
});

describe('POST /jobs/sweep - provider filter', () => {
  it('validates unknown providers', async () => {
    const res = await request(makeApp())
      .post('/jobs/sweep')
      .set('x-test-user', 'user-1')
      .send({ boards: 1, providers: ['not-a-provider'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('providers must be an array');
  });

  it('uses a filtered cursor key and only reads the requested provider', async () => {
    careerPages = [careerPage('p001', 'token-1'), careerPage('p002', 'token-2')];

    const res = await request(makeApp())
      .post('/jobs/sweep')
      .set('x-test-user', 'user-1')
      .send({ boards: 5, providers: ['workable'] });
    expect(res.status).toBe(200);
    expect(res.body.boards).toBe(2);
    expect(settings.get('deepSweep:cursor:workable')).toBe('');
    // The global scheduler cursor is untouched by a targeted run.
    expect(settings.has('deepSweep:cursor')).toBe(false);
  });

  it('sends the nextCheckAt/isActive hygiene predicate and skips backed-off rows', async () => {
    careerPages = [careerPage('p001', 'token-1')];
    await request(makeApp())
      .post('/jobs/sweep')
      .set('x-test-user', 'user-1')
      .send({ boards: 1 });

    const where = prismaMocks.companyCareerPage.findMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    expect(where.OR).toEqual([
      { nextCheckAt: null },
      { nextCheckAt: { lte: expect.any(Date) } },
    ]);
    // Both a success and its write-back ran.
    expect(prismaMocks.companyCareerPage.update).toHaveBeenCalledTimes(1);
    const data = prismaMocks.companyCareerPage.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ failureCount: 0, verifyStatus: 'ok', nextCheckAt: null });
  });
});
