import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

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

const findUniqueSearchMock = vi.fn();
const createSearchMock = vi.fn();
const findManyBoardsMock = vi.fn();
const upsertMock = vi.fn();
// Wave 12 (T843): the run path never writes the row back (asserted below),
// but the mock carries `update` so any write-back attempt is observable
// instead of a TypeError. `company` backs the orchestrator's default
// registry resolver for company intents (STEP 5).
const updateSearchMock = vi.fn();
const companyCountMock = vi.fn();
const companyFindFirstMock = vi.fn();
vi.mock('../lib/prisma.js', () => ({
  default: {
    savedSearch: {
      findUnique: (...args: any[]) => findUniqueSearchMock(...args),
      create: (...args: any[]) => createSearchMock(...args),
      update: (...args: any[]) => updateSearchMock(...args),
    },
    jobBoard: { findMany: (...args: any[]) => findManyBoardsMock(...args) },
    jobListing: { upsert: (...args: any[]) => upsertMock(...args), update: vi.fn().mockResolvedValue({}) },
    company: {
      count: (...args: any[]) => companyCountMock(...args),
      findFirst: (...args: any[]) => companyFindFirstMock(...args),
    },
  },
}));

import savedSearchesRouter from './saved-searches.js';
import { getRun, resetRunsForTests } from '../jobSources/discoveryRuns.js';
import { searchIntentSchema } from '../discovery/searchIntent.js';
import { DEEP_RUN_TTL_MS } from '../discovery/budgets.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', savedSearchesRouter);
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

const otherJob = {
  source: 'jobicy',
  sourceUrl: 'https://jobicy.com/jobs/999',
  title: 'Backend Engineer',
  company: 'Beta',
  location: 'Remote',
  description: 'Build APIs.',
  applyUrl: 'https://jobicy.com/jobs/999',
};

function boardRow(overrides: Record<string, any> = {}) {
  return {
    id: 'board-1',
    type: 'greenhouse',
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
    ...overrides,
  };
}

describe('saved-search run route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    createSearchMock.mockImplementation(async ({ data }: any) => ({ id: 'search-new', ...data }));
    findUniqueSearchMock.mockResolvedValue({ id: 'search-1', userId: 'user-1', query: 'frontend', sources: null });
    findManyBoardsMock.mockResolvedValue([
      boardRow({ id: 'board-1', type: 'greenhouse', boardId: 'acme' }),
      boardRow({ id: 'board-2', type: 'aggregator', boardId: null, aggregatorProvider: 'adzuna', aggregatorLocation: 'in:Bengaluru' }),
    ]);
    // Board 1 returns the shared job; board 2 returns the same job (dup) + a distinct one.
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.board === 'acme') return [{ ...sharedJob }];
      return [{ ...sharedJob }, { ...otherJob }];
    });
    upsertMock.mockImplementation(async ({ where, create }: any) => ({
      id: `id-${create.source}-${create.externalId}`,
      source: create.source,
      title: create.title,
      company: create.company,
      location: create.location,
      applyUrl: create.applyUrl,
      sourceUrl: create.sourceUrl,
      postedAt: null,
      isActive: true,
      _where: where,
    }));
  });

  it('(e) passes userId to every boardToConfig so keyed sources resolve BYOK keys', async () => {
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(runSourceMock).toHaveBeenCalledTimes(2);
    for (const call of runSourceMock.mock.calls) {
      expect(call[0]).toMatchObject({ userId: 'user-1', query: 'frontend' });
    }
    // Aggregator board keeps its provider/location alongside the userId.
    const aggCall = runSourceMock.mock.calls.find((c) => c[0].aggregatorProvider === 'adzuna');
    expect(aggCall).toBeTruthy();
    expect(aggCall![0]).toMatchObject({ userId: 'user-1', aggregatorLocation: 'in:Bengaluru' });
  });

  it('(a) dedupes the same job from two boards into one upsert', async () => {
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    // 3 raw results (1 + 2 with one dup) -> 2 upserts.
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(res.body).toHaveLength(2);
  });

  it('(c) repeated runs upsert the same keys (update, not duplicates)', async () => {    await request(makeApp()).post('/search-1/run');
    const firstWheres = upsertMock.mock.calls.map((c) => c[0].where);
    expect(firstWheres).toHaveLength(2);
    for (const w of firstWheres) {
      expect(w.source_externalId.externalId).toBeTruthy();
      expect(w.source_externalId.externalId).not.toMatch(/^manual-/);
    }

    vi.clearAllMocks();
    // Re-register defaults cleared by clearAllMocks.
    findUniqueSearchMock.mockResolvedValue({ id: 'search-1', userId: 'user-1', query: 'frontend', sources: null });
    findManyBoardsMock.mockResolvedValue([
      boardRow({ id: 'board-1', type: 'greenhouse', boardId: 'acme' }),
      boardRow({ id: 'board-2', type: 'aggregator', boardId: null, aggregatorProvider: 'adzuna', aggregatorLocation: 'in:Bengaluru' }),
    ]);
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.board === 'acme') return [{ ...sharedJob }];
      return [{ ...sharedJob }, { ...otherJob }];
    });
    upsertMock.mockImplementation(async ({ where, create }: any) => ({
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

    await request(makeApp()).post('/search-1/run');
    const secondWheres = upsertMock.mock.calls.map((c) => c[0].where);
    expect(secondWheres).toEqual(firstWheres);
  });
});

// Wave 12 (T843) - replay through the orchestrator with a pollable runId.
describe('saved-search orchestrator replay (T843)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    createSearchMock.mockImplementation(async ({ data }: any) => ({ id: 'search-new', ...data }));
    findUniqueSearchMock.mockResolvedValue({ id: 'search-1', userId: 'user-1', query: 'frontend', sources: null });
    findManyBoardsMock.mockResolvedValue([
      boardRow({ id: 'board-1', type: 'greenhouse', boardId: 'acme' }),
      boardRow({ id: 'board-2', type: 'aggregator', boardId: null, aggregatorProvider: 'adzuna', aggregatorLocation: 'in:Bengaluru' }),
    ]);
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.board === 'acme') return [{ ...sharedJob }];
      return [{ ...sharedJob }, { ...otherJob }];
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
    companyCountMock.mockResolvedValue(0);
    companyFindFirstMock.mockResolvedValue(null);
  });

  it('mints a runId exposed on the response with a pollable snapshot (AC 4, ADR-024)', async () => {
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    // The listing array keeps its exact shape (existing fields intact).
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    const runId = res.headers['x-run-id'];
    expect(runId).toMatch(/^ss-[A-Za-z0-9-]{8,64}$/);
    const snapshot = getRun(runId, 'user-1');
    expect(snapshot).toBeDefined();
    expect(snapshot!.runId).toBe(runId);
    expect(snapshot!.finishedAt).toBeDefined();
    expect(snapshot!.totalListings).toBe(2);
    // Snapshots are user-scoped.
    expect(getRun(runId, 'user-2')).toBeUndefined();
  });

  it('replays the STORED intent, not the legacy string', async () => {
    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'frontend',
      sources: null,
      intent: searchIntentSchema.parse({ roles: ['backend'] }),
    });
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(runSourceMock).toHaveBeenCalledTimes(2);
    // The orchestrator-planned query comes from the stored intent's roles.
    for (const call of runSourceMock.mock.calls) {
      expect(call[0]).toMatchObject({ userId: 'user-1', query: 'backend' });
    }
  });

  it('a pre-existing null-intent row replays via derivation without write-back (AC 5)', async () => {
    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'frontend',
      sources: null,
      intent: null,
    });
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.headers['x-run-id']).toBeTruthy();
    expect(updateSearchMock).not.toHaveBeenCalled();
  });

  it('a company intent with no registry match reports the empty scope with a reason (STEP 5)', async () => {
    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'engineer',
      sources: ['board-9'],
      intent: searchIntentSchema.parse({ roles: ['engineer'], companies: ['GhostCo'] }),
    });
    // The saved board is gone and the registry has companies but no match.
    findManyBoardsMock.mockResolvedValue([]);
    companyCountMock.mockResolvedValue(4);
    companyFindFirstMock.mockResolvedValue(null);
    const res = await request(makeApp()).post('/search-1/run');
    // Never an error...
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    // ...with the wave-7 reason reported, not a silent widening: the board
    // filter is preserved (no fallback to all boards).
    expect(findManyBoardsMock).toHaveBeenCalledWith({
      where: { userId: 'user-1', isActive: true, id: { in: ['board-9'] } },
    });
    expect(res.headers['x-run-skipped']).toContain('no registry match');
    expect(res.headers['x-run-id']).toBeTruthy();
    expect(updateSearchMock).not.toHaveBeenCalled();
  });

  it('a deep-mode intent replays deep with no route-level special-casing', async () => {
    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'frontend',
      sources: null,
      intent: searchIntentSchema.parse({ roles: ['frontend'], mode: 'deep' }),
    });
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.headers['x-run-id']).toBeTruthy();
    // Deep budgets cover both boards (fast maxUnits 24 would too - the point
    // is the route never branches on mode; budgets come from the intent).
    expect(runSourceMock).toHaveBeenCalledTimes(2);
  });

  it('an adversarial-but-legal legacy query falls back without a 500 or a widening', async () => {
    // A single >100-char token is accepted by the legacy column but rejected
    // by deriveIntent's token caps - the replay keeps the verbatim query.
    const longToken = 'x'.repeat(150);
    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: longToken,
      sources: null,
      intent: null,
    });
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(runSourceMock).toHaveBeenCalledTimes(2);
    for (const call of runSourceMock.mock.calls) {
      expect(call[0]).toMatchObject({ userId: 'user-1', query: longToken });
    }
  });
});

describe('T887 saved-search mode persistence and replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    createSearchMock.mockImplementation(async ({ data }: any) => ({ id: 'search-new', ...data }));
    updateSearchMock.mockImplementation(async ({ data }: any) => ({
      id: 'search-1',
      userId: 'user-1',
      query: 'frontend',
      ...data,
    }));
    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'frontend',
      sources: null,
      name: 'Search',
    });
    findManyBoardsMock.mockResolvedValue([]);
    upsertMock.mockResolvedValue({});
  });

  it('stores a standard intent unchanged on create', async () => {
    const intent = searchIntentSchema.parse({ roles: ['backend'], mode: 'standard' });
    const res = await request(makeApp()).post('/').send({ name: 'Standard', intent });
    expect(res.status).toBe(201);
    expect(createSearchMock).toHaveBeenCalledTimes(1);
    expect(createSearchMock.mock.calls[0][0].data.intent.mode).toBe('standard');
  });

  it('rejects Full on create and PATCH with the shared coded 400', async () => {
    const full = searchIntentSchema.parse({ roles: ['backend'], mode: 'full' });
    const created = await request(makeApp()).post('/').send({ name: 'Full', intent: full });
    expect(created.status).toBe(400);
    expect(created.body).toMatchObject({
      code: 'full_mode_not_persistable',
      error: expect.stringContaining('Standard'),
    });
    expect(createSearchMock).not.toHaveBeenCalled();

    const patched = await request(makeApp()).patch('/search-1').send({ intent: full });
    expect(patched.status).toBe(400);
    expect(patched.body).toMatchObject({
      code: 'full_mode_not_persistable',
      error: expect.stringContaining('Deep'),
    });
    expect(updateSearchMock).not.toHaveBeenCalled();
  });

  it('passes standard and deep modes unchanged to the orchestrator', async () => {
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([]);
    upsertMock.mockResolvedValue({});

    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'backend',
      sources: null,
      intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'standard' }),
    });
    const standard = await request(makeApp()).post('/search-1/run');
    expect(standard.status).toBe(200);
    expect(capturedRunSearchCalls.at(-1)?.[0].mode).toBe('standard');

    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'backend',
      sources: null,
      intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' }),
    });
    const deep = await request(makeApp()).post('/search-1/run');
    expect(deep.status).toBe(200);
    expect(capturedRunSearchCalls.at(-1)?.[0].mode).toBe('deep');
  });

  it('uses the extended Deep run TTL while leaving legacy null-intent rows fast', async () => {
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([]);
    upsertMock.mockResolvedValue({});

    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'backend',
      sources: null,
      intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' }),
    });
    const deep = await request(makeApp()).post('/search-1/run');
    expect(deep.status).toBe(200);
    expect(beginRunCalls.at(-1)?.[3]).toBe(DEEP_RUN_TTL_MS);

    findUniqueSearchMock.mockResolvedValue({
      id: 'search-1',
      userId: 'user-1',
      query: 'backend',
      sources: null,
      intent: null,
    });
    const legacy = await request(makeApp()).post('/search-1/run');
    expect(legacy.status).toBe(200);
    expect(capturedRunSearchCalls.at(-1)?.[0].mode).toBe('fast');
  });
});

// ADR-033 (T887): the replay snapshot reports the RESOLVED mode, exactly like
// /search, /scan and /jobs/full-scan. Before this, a saved-search replay wrote
// a run with no `mode` at all, so a client polling GET /jobs/runs/:runId could
// not tell a Fast replay from a Deep one. `beginRun`'s signature and the
// legacy snapshot shape are unchanged - only the additive `setRunMode` writer
// runs, right after `beginRun`, inside the same `safeRegistry` guard.
describe('ADR-033 - saved-search replay snapshots record the resolved mode (T887)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    createSearchMock.mockImplementation(async ({ data }: any) => ({ id: 'search-new', ...data }));
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([]);
    upsertMock.mockResolvedValue({});
    companyCountMock.mockResolvedValue(0);
    companyFindFirstMock.mockResolvedValue(null);
  });

  function searchRowWithIntent(intent: unknown) {
    return { id: 'search-1', userId: 'user-1', query: 'backend', sources: null, intent };
  }

  it('records fast, standard, and deep for a stored intent, and fast for a legacy null-intent row', async () => {
    const cases: Array<{ label: string; intent: unknown; expected: string }> = [
      { label: 'fast', intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'fast' }), expected: 'fast' },
      { label: 'standard', intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'standard' }), expected: 'standard' },
      { label: 'deep', intent: searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' }), expected: 'deep' },
      // A pre-migration row derives on the fly (never written back) and its
      // derived mode is fast - the snapshot must say so rather than staying
      // undefined.
      { label: 'legacy-null-intent', intent: null, expected: 'fast' },
    ];

    for (const testCase of cases) {
      findUniqueSearchMock.mockResolvedValue(searchRowWithIntent(testCase.intent));
      const res = await request(makeApp()).post('/search-1/run');
      expect(res.status, testCase.label).toBe(200);
      const runId = res.headers['x-run-id'] as string;
      expect(runId, testCase.label).toMatch(/^ss-/);
      const snapshot = getRun(runId, 'user-1');
      expect(snapshot, testCase.label).toBeDefined();
      // The REAL snapshot, not a mock capture: this is the field a client
      // polls GET /jobs/runs/:runId for.
      expect(snapshot!.mode, testCase.label).toBe(testCase.expected);
      // The derived/stored mode the orchestrator ran with agrees.
      expect(capturedRunSearchCalls.at(-1)?.[0].mode, testCase.label).toBe(testCase.expected);
    }
  });

  it('records the linked resolution on a run even when the intent carries no mode key', async () => {
    // An intent row persisted before the mode field existed parses with the
    // schema default (fast), so the snapshot is populated, not left undefined.
    findUniqueSearchMock.mockResolvedValue(
      searchRowWithIntent(searchIntentSchema.parse({ roles: ['backend'] })),
    );
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(getRun(res.headers['x-run-id'] as string, 'user-1')?.mode).toBe('fast');
  });

  it('keeps the mode-scoped TTL and the mode field independent (deep gets both)', async () => {
    findUniqueSearchMock.mockResolvedValue(
      searchRowWithIntent(searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' })),
    );
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(beginRunCalls.at(-1)?.[3]).toBe(DEEP_RUN_TTL_MS);
    expect(getRun(res.headers['x-run-id'] as string, 'user-1')?.mode).toBe('deep');
  });
});
