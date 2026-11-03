// Wave 12 (T844) - job-alert intent storage + orchestrator replay tests.
//
// Covers the task's STEP 7 list: legacy create stores a derived intent;
// intent create stores both; run replays through the orchestrator with a
// pollable runId; savedSearchId precedence; null-intent replay without
// write-back; dead board id fails that board only; notification behaviour
// untouched; provider-agnostic (no source.kind branching, asserted by grep).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// Mock runSource but keep the real boardToConfig so config wiring is exercised.
const runSourceMock = vi.fn();
const { capturedRunSearchCalls, beginRunCalls } = vi.hoisted(() => ({
  capturedRunSearchCalls: [] as any[][],
  beginRunCalls: [] as any[][],
}));

vi.mock('../discovery/orchestrator.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../discovery/orchestrator.js')>();
  return {
    ...orig,
    runSearch: async (...args: any[]) => {
      capturedRunSearchCalls.push(args);
      return orig.runSearch(args[0], args[1], args[2]);
    },
  };
});

vi.mock('../jobSources/discoveryRuns.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/discoveryRuns.js')>();
  return {
    ...orig,
    beginRun: (...args: any[]) => {
      beginRunCalls.push(args);
      return orig.beginRun(args[0], args[1], args[2], args[3]);
    },
  };
});

vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

const findUniqueAlertMock = vi.fn();
const createAlertMock = vi.fn();
const updateAlertMock = vi.fn();
const findUniqueSearchMock = vi.fn();
const findManyBoardsMock = vi.fn();
const upsertMock = vi.fn();
const companyCountMock = vi.fn();
const companyFindFirstMock = vi.fn();
vi.mock('../lib/prisma.js', () => ({
  default: {
    jobAlert: {
      findUnique: (...args: any[]) => findUniqueAlertMock(...args),
      create: (...args: any[]) => createAlertMock(...args),
      update: (...args: any[]) => updateAlertMock(...args),
    },
    savedSearch: {
      findUnique: (...args: any[]) => findUniqueSearchMock(...args),
    },
    jobBoard: { findMany: (...args: any[]) => findManyBoardsMock(...args) },
    jobListing: { upsert: (...args: any[]) => upsertMock(...args), update: vi.fn().mockResolvedValue({}) },
    // Present so recordSourceSuccess/Failure take the real write path (the
    // route still wraps them so a rejection can never fail the request).
    jobSourceHealth: { upsert: async () => ({}) },
    company: {
      count: (...args: any[]) => companyCountMock(...args),
      findFirst: (...args: any[]) => companyFindFirstMock(...args),
    },
  },
}));

import jobAlertsRouter from './job-alerts.js';
import { getRun, resetRunsForTests } from '../jobSources/discoveryRuns.js';
import { searchIntentSchema } from '../discovery/searchIntent.js';
import { DEEP_RUN_TTL_MS } from '../discovery/budgets.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', jobAlertsRouter);
  return app;
}

beforeEach(() => {
  capturedRunSearchCalls.length = 0;
  beginRunCalls.length = 0;
});

const sharedJob = {
  source: 'greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  title: 'Senior Frontend Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'Build React apps.',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
};

function boardRow(overrides: Record<string, any> = {}) {
  return {
    id: 'board-1',
    userId: 'user-1',
    type: 'greenhouse',
    name: 'Acme board',
    boardId: 'acme',
    feedUrl: null,
    searchQuery: null,
    searchSite: null,
    scraperProvider: null,
    scraperLocation: null,
    scraperResults: null,
    scraperUseProxy: false,
    aggregatorProvider: null,
    aggregatorLocation: null,
    isActive: true,
    ...overrides,
  };
}

function ownerAlert(overrides: Record<string, any> = {}) {
  return {
    id: 'alert-1',
    userId: 'user-1',
    name: 'Old',
    query: 'frontend',
    location: null,
    sources: ['board-1'],
    savedSearchId: null,
    minMatchScore: null,
    remoteOnly: false,
    isActive: true,
    notifyInApp: true,
    notifyEmail: false,
    intent: null,
    ...overrides,
  };
}

describe('job-alert intent storage (T844 STEP 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    findUniqueAlertMock.mockResolvedValue(ownerAlert());
    createAlertMock.mockImplementation(async ({ data }: any) => ({ id: 'alert-new', ...data }));
    updateAlertMock.mockImplementation(async ({ where, data }: any) => ({ ...ownerAlert(), id: where.id, ...data }));
    companyCountMock.mockResolvedValue(0);
    companyFindFirstMock.mockResolvedValue(null);
  });

  it('create with a legacy payload stores a valid derived intent (AC 2)', async () => {
    const res = await request(makeApp()).post('/').send({ name: 'A', query: 'frontend' });
    expect(res.status).toBe(201);
    expect(createAlertMock).toHaveBeenCalledTimes(1);
    const data = createAlertMock.mock.calls[0][0].data;
    // Legacy values kept VERBATIM for old readers...
    expect(data.query).toBe('frontend');
    // ...and a valid derived intent stored alongside.
    expect(searchIntentSchema.safeParse(data.intent).success).toBe(true);
    expect(res.body.intent).toBeDefined();
  });

  it('create with an intent stores both the intent and the derived legacy fields (AC 3)', async () => {
    const intent = searchIntentSchema.parse({ roles: ['backend'], remoteOnly: true });
    const res = await request(makeApp())
      .post('/')
      .send({ name: 'A', query: 'ignored-text', intent });
    expect(res.status).toBe(201);
    const data = createAlertMock.mock.calls[0][0].data;
    expect(data.intent).toEqual(intent);
    // Legacy columns derived from the intent, not from the supplied text.
    expect(data.query).toContain('backend');
    expect(data.query).not.toContain('ignored-text');
    expect(data.remoteOnly).toBe(true);
  });

  it('create with no criteria is rejected with a 400 (AC 8)', async () => {
    const noQuery = await request(makeApp()).post('/').send({ name: 'A' });
    expect(noQuery.status).toBe(400);
    const emptyIntent = await request(makeApp())
      .post('/')
      .send({ name: 'A', intent: searchIntentSchema.parse({}) });
    expect(emptyIntent.status).toBe(400);
    expect(createAlertMock).not.toHaveBeenCalled();
  });

  it('PATCH with only a name leaves the intent untouched (M12-3)', async () => {
    const stored = searchIntentSchema.parse({ roles: ['backend'] });
    findUniqueAlertMock.mockResolvedValue(ownerAlert({ intent: stored }));
    const res = await request(makeApp()).patch('/alert-1').send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    const data = updateAlertMock.mock.calls[0][0].data;
    expect(data.name).toBe('Renamed');
    expect(data).not.toHaveProperty('intent');
  });

  it('PATCH with a criteria-bearing intent stores both', async () => {
    const intent = searchIntentSchema.parse({ roles: ['backend'] });
    const res = await request(makeApp()).patch('/alert-1').send({ intent });
    expect(res.status).toBe(200);
    const data = updateAlertMock.mock.calls[0][0].data;
    expect(data.intent).toEqual(intent);
    expect(data.query).toContain('backend');
  });

  it('create with a standard intent stores mode standard unchanged', async () => {
    const intent = searchIntentSchema.parse({ roles: ['backend'], mode: 'standard' });
    const res = await request(makeApp()).post('/').send({ name: 'Standard', intent });
    expect(res.status).toBe(201);
    expect(createAlertMock.mock.calls[0][0].data.intent.mode).toBe('standard');
  });

  it('rejects Full on create and PATCH with the shared coded 400', async () => {
    const full = searchIntentSchema.parse({ roles: ['backend'], mode: 'full' });
    const created = await request(makeApp()).post('/').send({ name: 'Full', intent: full });
    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({
      code: 'full_mode_not_persistable',
      error: expect.stringContaining('Standard'),
    });
    expect(createAlertMock).not.toHaveBeenCalled();

    const patched = await request(makeApp()).patch('/alert-1').send({ intent: full });
    expect(patched.status).toBe(400);
    expect(patched.body).toMatchObject({
      code: 'full_mode_not_persistable',
      error: expect.stringContaining('Deep'),
    });
    expect(updateAlertMock).not.toHaveBeenCalled();
  });

  it('create preserves the notification flags verbatim (N9)', async () => {
    const res = await request(makeApp())
      .post('/')
      .send({ name: 'A', query: 'frontend', notifyInApp: false, notifyEmail: true });
    expect(res.status).toBe(201);
    const data = createAlertMock.mock.calls[0][0].data;
    expect(data.notifyInApp).toBe(false);
    expect(data.notifyEmail).toBe(true);
  });
});

describe('job-alert orchestrator replay (T844 STEP 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    findUniqueAlertMock.mockResolvedValue(ownerAlert());
    findUniqueSearchMock.mockResolvedValue(null);
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.board === 'acme') return [{ ...sharedJob }];
      return [];
    });
    upsertMock.mockImplementation(async ({ create }: any) => ({
      id: `id-${create.source}-${create.externalId}`,
      source: create.source,
      title: create.title,
      company: create.company,
      location: create.location,
      applyUrl: create.applyUrl,
      sourceUrl: create.sourceUrl,
      postedAt: null,
      isActive: true,
    }));
    updateAlertMock.mockResolvedValue({});
    companyCountMock.mockResolvedValue(0);
    companyFindFirstMock.mockResolvedValue(null);
  });

  it('run replays through the orchestrator with a pollable runId (AC 4)', async () => {
    const res = await request(makeApp()).post('/alert-1/run');
    expect(res.status).toBe(200);
    // Historical shape preserved, runId gained additively.
    expect(res.body.matchCount).toBe(1);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results).toHaveLength(1);
    expect(typeof res.body.runId).toBe('string');
    const runId = res.headers['x-run-id'];
    expect(runId).toBe(res.body.runId);
    expect(runId).toMatch(/^alert-[A-Za-z0-9-]{8,64}$/);
    const snapshot = getRun(runId, 'user-1');
    expect(snapshot).toBeDefined();
    expect(snapshot!.runId).toBe(runId);
    expect(snapshot!.finishedAt).toBeDefined();
    expect(snapshot!.totalListings).toBe(1);
    // Snapshots are user-scoped.
    expect(getRun(runId, 'user-2')).toBeUndefined();
  });

  it('the savedSearchId link wins: the linked search intent replays (precedence)', async () => {
    findUniqueAlertMock.mockResolvedValue(
      ownerAlert({ query: 'alert-query', sources: ['board-2'], savedSearchId: 'search-1' }),
    );
    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'search-query',
      sources: ['board-1'],
      intent: searchIntentSchema.parse({ roles: ['backend'] }),
    });
    const res = await request(makeApp()).post('/alert-1/run');
    expect(res.status).toBe(200);
    // The search's board filter wins...
    expect(findManyBoardsMock).toHaveBeenCalledWith({
      where: { userId: 'user-1', isActive: true, id: { in: ['board-1'] } },
    });
    // ...and the orchestrator-planned query comes from the search's intent.
    expect(runSourceMock).toHaveBeenCalledTimes(1);
    expect(runSourceMock.mock.calls[0][0]).toMatchObject({ userId: 'user-1', query: 'backend' });
  });

  it('two alerts sharing a savedSearchId both keep working', async () => {
    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'search-query',
      sources: ['board-1'],
      intent: searchIntentSchema.parse({ roles: ['backend'] }),
    });
    findUniqueAlertMock.mockResolvedValueOnce(
      ownerAlert({ id: 'alert-a', query: 'a-query', savedSearchId: 'search-1' }),
    );
    const first = await request(makeApp()).post('/alert-a/run');
    expect(first.status).toBe(200);
    findUniqueAlertMock.mockResolvedValueOnce(
      ownerAlert({ id: 'alert-b', query: 'b-query', savedSearchId: 'search-1' }),
    );
    const second = await request(makeApp()).post('/alert-b/run');
    expect(second.status).toBe(200);
    expect(first.body.runId).not.toBe(second.body.runId);
  });

  it('a pre-existing null-intent alert replays via derivation without write-back (AC 5)', async () => {
    findUniqueAlertMock.mockResolvedValue(ownerAlert({ intent: null }));
    const res = await request(makeApp()).post('/alert-1/run');
    expect(res.status).toBe(200);
    expect(res.body.matchCount).toBe(1);
    expect(res.headers['x-run-id']).toBeTruthy();
    // The only write is the run bookkeeping - the derived intent is never
    // written back.
    expect(updateAlertMock).toHaveBeenCalledTimes(1);
    const data = updateAlertMock.mock.calls[0][0].data;
    expect(data).toHaveProperty('lastRunAt');
    expect(data).toHaveProperty('lastMatchCount');
    expect(data).not.toHaveProperty('intent');
    expect(data).not.toHaveProperty('query');
  });

  it('a dead board id fails that board only and the run continues', async () => {
    findUniqueAlertMock.mockResolvedValue(
      ownerAlert({ sources: ['board-gone', 'board-1'] }),
    );
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    const res = await request(makeApp()).post('/alert-1/run');
    expect(res.status).toBe(200);
    // The live board still produced its row.
    expect(res.body.matchCount).toBe(1);
    const runId = res.headers['x-run-id'];
    const snapshot = getRun(runId, 'user-1');
    expect(snapshot).toBeDefined();
    const byId = new Map(snapshot!.boards.map((b) => [b.boardId, b]));
    expect(byId.get('board-1')!.status).toBe('ok');
    expect(byId.get('board-gone')!.status).toBe('failed');
    expect(byId.get('board-gone')!.error).toContain('board-gone');
  });

  it('the run bookkeeping touches no notification field (N9)', async () => {
    await request(makeApp()).post('/alert-1/run');
    expect(updateAlertMock).toHaveBeenCalledTimes(1);
    const data = updateAlertMock.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('notifyInApp');
    expect(data).not.toHaveProperty('notifyEmail');
  });

  it('passes standard and deep modes unchanged to the orchestrator', async () => {
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([]);
    upsertMock.mockResolvedValue({});

    findUniqueAlertMock.mockResolvedValue(
      ownerAlert({ intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'standard' }) }),
    );
    const standard = await request(makeApp()).post('/alert-1/run');
    expect(standard.status).toBe(200);
    expect(capturedRunSearchCalls.at(-1)?.[0].mode).toBe('standard');

    findUniqueAlertMock.mockResolvedValue(
      ownerAlert({ intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' }) }),
    );
    const deep = await request(makeApp()).post('/alert-1/run');
    expect(deep.status).toBe(200);
    expect(capturedRunSearchCalls.at(-1)?.[0].mode).toBe('deep');
  });

  it('uses the extended Deep run TTL while leaving legacy null-intent rows fast', async () => {
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([]);
    upsertMock.mockResolvedValue({});

    findUniqueAlertMock.mockResolvedValue(
      ownerAlert({ intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' }) }),
    );
    const deep = await request(makeApp()).post('/alert-1/run');
    expect(deep.status).toBe(200);
    expect(beginRunCalls.at(-1)?.[3]).toBe(DEEP_RUN_TTL_MS);

    findUniqueAlertMock.mockResolvedValue(ownerAlert({ intent: null }));
    const legacy = await request(makeApp()).post('/alert-1/run');
    expect(legacy.status).toBe(200);
    expect(capturedRunSearchCalls.at(-1)?.[0].mode).toBe('fast');
  });
});

// ADR-033 (T887): the alert replay snapshot reports the RESOLVED mode, exactly
// like /search, /scan and /jobs/full-scan. Before this, an alert run wrote a
// run with no `mode` at all, so a client polling GET /jobs/runs/:runId could
// not tell a Fast replay from a Deep one. `beginRun`'s signature and the legacy
// snapshot shape are unchanged - only the additive `setRunMode` writer runs,
// right after `beginRun`, inside the same `safeRegistry` guard.
describe('ADR-033 - job-alert replay snapshots record the resolved mode (T887)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    findUniqueSearchMock.mockResolvedValue(null);
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([]);
    upsertMock.mockResolvedValue({});
    updateAlertMock.mockResolvedValue({});
    companyCountMock.mockResolvedValue(0);
    companyFindFirstMock.mockResolvedValue(null);
  });

  it('records fast, standard, and deep for a stored intent, and fast for a legacy null-intent row', async () => {
    const cases: Array<{ label: string; intent: unknown; expected: string }> = [
      {
        label: 'fast',
        intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'fast' }),
        expected: 'fast',
      },
      {
        label: 'standard',
        intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'standard' }),
        expected: 'standard',
      },
      {
        label: 'deep',
        intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' }),
        expected: 'deep',
      },
      // A pre-migration alert derives on the fly (never written back) and its
      // derived mode is fast - the snapshot must say so, not stay undefined.
      { label: 'legacy-null-intent', intent: null, expected: 'fast' },
    ];

    for (const testCase of cases) {
      findUniqueAlertMock.mockResolvedValue(ownerAlert({ intent: testCase.intent }));
      const res = await request(makeApp()).post('/alert-1/run');
      expect(res.status, testCase.label).toBe(200);
      const runId = res.body.runId as string;
      expect(runId, testCase.label).toMatch(/^alert-/);
      // The REAL snapshot, not a mock capture: this is the field a client
      // polls GET /jobs/runs/:runId for.
      expect(getRun(runId, 'user-1')?.mode, testCase.label).toBe(testCase.expected);
      // The derived/stored mode the orchestrator ran with agrees.
      expect(capturedRunSearchCalls.at(-1)?.[0].mode, testCase.label).toBe(testCase.expected);
    }
  });

  it('records the LINKED saved-search mode when the savedSearchId precedence resolves it', async () => {
    for (const mode of ['fast', 'standard', 'deep'] as const) {
      findUniqueAlertMock.mockResolvedValue(
        ownerAlert({
          savedSearchId: 'search-1',
          // The alert's own intent would say fast; the link must win.
          intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'fast' }),
        }),
      );
      findUniqueSearchMock.mockResolvedValue({
        id: 'search-1',
        userId: 'user-1',
        query: 'search-query',
        sources: ['board-1'],
        intent: searchIntentSchema.parse({ roles: ['backend'], mode }),
      });
      const res = await request(makeApp()).post('/alert-1/run');
      expect(res.status, mode).toBe(200);
      expect(getRun(res.body.runId as string, 'user-1')?.mode, mode).toBe(mode);
    }
  });

  it('keeps the mode-scoped TTL and the mode field independent (deep gets both)', async () => {
    findUniqueAlertMock.mockResolvedValue(
      ownerAlert({ intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' }) }),
    );
    const res = await request(makeApp()).post('/alert-1/run');
    expect(res.status).toBe(200);
    expect(beginRunCalls.at(-1)?.[3]).toBe(DEEP_RUN_TTL_MS);
    expect(getRun(res.body.runId as string, 'user-1')?.mode).toBe('deep');
  });

  it('writes no notification field while recording the mode (N9 unchanged)', async () => {
    findUniqueAlertMock.mockResolvedValue(
      ownerAlert({ intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' }) }),
    );
    const res = await request(makeApp()).post('/alert-1/run');
    expect(res.status).toBe(200);
    expect(getRun(res.body.runId as string, 'user-1')?.mode).toBe('deep');
    expect(updateAlertMock).toHaveBeenCalledTimes(1);
    const data = updateAlertMock.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('notifyInApp');
    expect(data).not.toHaveProperty('notifyEmail');
    expect(data).not.toHaveProperty('mode');
  });
});

describe('job-alert route invariants (T844 STEP 3, N9)', () => {
  const source = readFileSync(path.join(__dirname, 'job-alerts.ts'), 'utf8');

  it('the alert path never branches on a source kind (provider-agnostic)', () => {
    expect(source).not.toContain('source.kind');
  });

  it('the alert path sends nothing new (mailer untouched)', () => {
    expect(source).not.toContain('mailer');
  });
});
