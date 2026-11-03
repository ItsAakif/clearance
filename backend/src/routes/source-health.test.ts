import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock runSource but keep the real boardToConfig so config wiring is exercised.
const runSourceMock = vi.fn();
vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

const requireAuthMock = vi.fn((req: any, _res: any, next: any) => {
  req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
  next();
});
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => requireAuthMock(req, res, next),
}));

vi.mock('../jobSources/defaultBoards.js', () => ({
  seedDefaultBoardsForUser: vi.fn(async () => undefined),
}));

const findManyBoardsMock = vi.fn();
const findUniqueBoardMock = vi.fn();
const createBoardMock = vi.fn();
const updateBoardMock = vi.fn();
const upsertHealthMock = vi.fn();
const upsertListingMock = vi.fn();
const findUniqueSearchMock = vi.fn();
const findUniqueAlertMock = vi.fn();
const updateAlertMock = vi.fn();
vi.mock('../lib/prisma.js', () => ({
  default: {
    jobBoard: {
      findMany: (...args: any[]) => findManyBoardsMock(...args),
      findUnique: (...args: any[]) => findUniqueBoardMock(...args),
      create: (...args: any[]) => createBoardMock(...args),
      update: (...args: any[]) => updateBoardMock(...args),
    },
    jobSourceHealth: { upsert: (...args: any[]) => upsertHealthMock(...args) },
    jobListing: { upsert: (...args: any[]) => upsertListingMock(...args), update: vi.fn().mockResolvedValue({}) },
    savedSearch: { findUnique: (...args: any[]) => findUniqueSearchMock(...args) },
    jobAlert: {
      findUnique: (...args: any[]) => findUniqueAlertMock(...args),
      update: (...args: any[]) => updateAlertMock(...args),
    },
  },
}));

import jobsRouter from './jobs.js';
import boardsRouter from './boards.js';
import savedSearchesRouter from './saved-searches.js';
import jobAlertsRouter from './job-alerts.js';

function makeApp(router: any, mount = '/') {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  return app;
}

const baseJob = {
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

describe('source-health wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
      next();
    });
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    findUniqueBoardMock.mockResolvedValue(boardRow());
    upsertHealthMock.mockResolvedValue({});
    upsertListingMock.mockImplementation(async ({ create }: any) => ({
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
    findUniqueSearchMock.mockResolvedValue({ id: 'search-1', userId: 'user-1', query: 'frontend', sources: null });
    findUniqueAlertMock.mockResolvedValue({ id: 'alert-1', userId: 'user-1', query: 'frontend', sources: null, savedSearchId: null });
    updateAlertMock.mockResolvedValue({});
    runSourceMock.mockResolvedValue([{ ...baseJob }, { ...baseJob, sourceUrl: 'https://boards.greenhouse.io/acme/jobs/124', applyUrl: 'https://boards.greenhouse.io/acme/jobs/124' }]);
  });

  it('successful scan records a healthy row with count + latency', async () => {
    const res = await request(makeApp(jobsRouter)).get('/scan?query=frontend');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    const args = upsertHealthMock.mock.calls[0][0];
    expect(args.where).toEqual({ jobBoardId: 'board-1' });
    expect(args.create.status).toBe('healthy');
    expect(args.create.consecutiveFailures).toBe(0);
    expect(args.create.lastResultCount).toBe(2);
    expect(typeof args.create.lastLatencyMs).toBe('number');
    expect(args.create.lastLatencyMs).toBeGreaterThanOrEqual(0);
    expect(args.update.status).toBe('healthy');
  });

  it('failed source records a failed row with incremented consecutiveFailures and sanitized error, returning []', async () => {
    const longError = new Error(`boom ${'x'.repeat(3000)}`);
    runSourceMock.mockRejectedValueOnce(longError);
    const res = await request(makeApp(jobsRouter)).get('/scan?query=frontend');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    const args = upsertHealthMock.mock.calls[0][0];
    expect(args.create.status).toBe('failed');
    expect(args.update.status).toBe('failed');
    expect(args.update.consecutiveFailures).toEqual({ increment: 1 });
    const storedError: string = args.create.lastError;
    expect(storedError).toContain('boom');
    expect(storedError.length).toBeLessThanOrEqual(2000);
  });

  it('a health-write rejection never fails the scan', async () => {
    upsertHealthMock.mockRejectedValueOnce(new Error('db down'));
    const res = await request(makeApp(jobsRouter)).get('/scan?query=frontend');
    // sourceHealth.ts swallows the write error, so the request still succeeds.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('saved-search run records health per board', async () => {
    const res = await request(makeApp(savedSearchesRouter)).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    expect(upsertHealthMock.mock.calls[0][0].create.status).toBe('healthy');
    expect(upsertHealthMock.mock.calls[0][0].where).toEqual({ jobBoardId: 'board-1' });
  });

  it('job-alert run records health per board', async () => {
    findUniqueAlertMock.mockResolvedValue({
      id: 'alert-1', userId: 'user-1', query: 'frontend',
      sources: ['board-1'], savedSearchId: null,
    });
    const res = await request(makeApp(jobAlertsRouter)).post('/alert-1/run');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    expect(upsertHealthMock.mock.calls[0][0].create.status).toBe('healthy');
  });

  it('GET /boards includes sourceHealth', async () => {
    findManyBoardsMock.mockResolvedValue([{ ...boardRow(), sourceHealth: { status: 'healthy', consecutiveFailures: 0 } }]);
    const res = await request(makeApp(boardsRouter)).get('/');
    expect(res.status).toBe(200);
    expect(findManyBoardsMock).toHaveBeenCalledWith(
      expect.objectContaining({ include: { sourceHealth: true } }),
    );
    expect(res.body[0].sourceHealth).toMatchObject({ status: 'healthy' });
  });

  it('GET /boards/:id/health returns 401 when unauthenticated', async () => {
    requireAuthMock.mockImplementationOnce((_req: any, res: any, _next: any) => {
      res.status(401).json({ error: 'Authentication required' });
    });
    const res = await request(makeApp(boardsRouter)).get('/board-1/health');
    expect(res.status).toBe(401);
  });

  it('GET /boards/:id/health returns 404 for a missing board', async () => {
    findUniqueBoardMock.mockResolvedValueOnce(null);
    const res = await request(makeApp(boardsRouter)).get('/missing/health');
    expect(res.status).toBe(404);
  });

  it('GET /boards/:id/health returns 403 for a board owned by someone else', async () => {
    findUniqueBoardMock.mockResolvedValueOnce(boardRow({ userId: 'user-2', sourceHealth: null }));
    const res = await request(makeApp(boardsRouter)).get('/board-1/health');
    expect(res.status).toBe(403);
  });

  it('GET /boards/:id/health returns the health row for the owner', async () => {
    findUniqueBoardMock.mockResolvedValueOnce(
      boardRow({ sourceHealth: { status: 'healthy', consecutiveFailures: 0, lastResultCount: 5 } }),
    );
    const res = await request(makeApp(boardsRouter)).get('/board-1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'healthy', lastResultCount: 5 });
  });

  it('GET /boards/:id/health returns a default when no health row exists', async () => {
    findUniqueBoardMock.mockResolvedValueOnce(boardRow({ sourceHealth: null }));
    const res = await request(makeApp(boardsRouter)).get('/board-1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unknown', consecutiveFailures: 0, lastResultCount: 0 });
  });
});

// Wave 4 (T684, STEP 4): the new sources get JobSourceHealth rows through
// the EXISTING recordSourceSuccess/recordSourceFailure path - no new health
// model, no migration. Sites checked (all three build configs with the same
// `...boardToConfig(b)` spread and call the same `runSource(c)` + health
// helpers, with no per-type branch):
//   - routes/jobs.ts /scan + /search (boardToConfig spread + health write)
//   - routes/saved-searches.ts:111-115 (identical spread + health write)
//   - routes/job-alerts.ts:134-150 (identical spread + health write)
// runSource itself is mocked here but the REAL boardToConfig is kept (file
// header mock strategy), so these tests prove the new board types flow
// through boardToConfig with no special case and reach the existing health
// write; runSource routing for the same types is pinned with mocked
// fetchers in runSource.registry.test.ts.
describe('wave-4 source health (existing path, no new model)', () => {
  // One stored board per new type: board-token types carry boardId, the
  // tier-3 page carries feedUrl (same fields boardToConfig reads).
  const wave4Boards = [
    boardRow({ id: 'board-workable', type: 'workable', boardId: 'acme' }),
    boardRow({ id: 'board-bamboohr', type: 'bamboohr', boardId: 'acme' }),
    boardRow({ id: 'board-breezyhr', type: 'breezyhr', boardId: 'acme' }),
    boardRow({ id: 'board-jobvite', type: 'jobvite', boardId: 'acme' }),
    boardRow({ id: 'board-teamtailor', type: 'teamtailor', boardId: 'acme' }),
    boardRow({ id: 'board-pinpoint', type: 'pinpoint', boardId: 'acme' }),
    boardRow({ id: 'board-freshteam', type: 'freshteam', boardId: 'acme' }),
    boardRow({ id: 'board-career-page', type: 'career-page', boardId: null, feedUrl: 'https://careers.acme.example.test/' }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
      next();
    });
    upsertHealthMock.mockResolvedValue({});
    upsertListingMock.mockImplementation(async ({ create }: any) => ({
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
    findUniqueSearchMock.mockResolvedValue({ id: 'search-1', userId: 'user-1', query: 'frontend', sources: null });
    findUniqueAlertMock.mockResolvedValue({ id: 'alert-1', userId: 'user-1', query: 'frontend', sources: null, savedSearchId: null });
    runSourceMock.mockResolvedValue([{ ...baseJob, source: 'workable', externalId: 'w-1' }]);
  });

  it('a scan over one board of each new type records a healthy row per board', async () => {
    findManyBoardsMock.mockResolvedValue(wave4Boards);
    const res = await request(makeApp(jobsRouter)).get('/scan?query=frontend');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(wave4Boards.length);
    const seenIds = upsertHealthMock.mock.calls.map((c) => c[0].where.jobBoardId).sort();
    expect(seenIds).toEqual(wave4Boards.map((b) => b.id).sort());
    for (const call of upsertHealthMock.mock.calls) {
      expect(call[0].create.status).toBe('healthy');
    }
  });

  it('new-type boards flow through boardToConfig with no special case (board/feedUrl wired)', async () => {
    findManyBoardsMock.mockResolvedValue(wave4Boards);
    await request(makeApp(jobsRouter)).get('/scan?query=frontend');
    expect(runSourceMock).toHaveBeenCalledTimes(wave4Boards.length);
    const byType = new Map(runSourceMock.mock.calls.map((c) => [c[0].type, c[0]]));
    for (const boardType of ['workable', 'bamboohr', 'breezyhr', 'jobvite', 'teamtailor', 'pinpoint', 'freshteam']) {
      expect(byType.get(boardType), `${boardType}.board`).toMatchObject({ type: boardType, board: 'acme' });
    }
    expect(byType.get('career-page')).toMatchObject({
      type: 'career-page',
      feedUrl: 'https://careers.acme.example.test/',
    });
  });

  it('a failing new-type source records a failed row through the existing path', async () => {
    findManyBoardsMock.mockResolvedValue([boardRow({ id: 'board-freshteam', type: 'freshteam', boardId: 'acme' })]);
    runSourceMock.mockRejectedValueOnce(new Error('Fetch failed 500'));
    const res = await request(makeApp(jobsRouter)).get('/scan?query=frontend');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    expect(upsertHealthMock.mock.calls[0][0].where).toEqual({ jobBoardId: 'board-freshteam' });
    expect(upsertHealthMock.mock.calls[0][0].create.status).toBe('failed');
  });

  it('a saved-search run over a new-type board records health', async () => {
    findManyBoardsMock.mockResolvedValue([boardRow({ id: 'board-workable', type: 'workable', boardId: 'acme' })]);
    const res = await request(makeApp(savedSearchesRouter)).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    expect(upsertHealthMock.mock.calls[0][0].create.status).toBe('healthy');
  });

  it('a job-alert run over a new-type board records health', async () => {
    findUniqueAlertMock.mockResolvedValue({
      id: 'alert-1', userId: 'user-1', query: 'frontend',
      sources: ['board-career-page'], savedSearchId: null,
    });
    findManyBoardsMock.mockResolvedValue([
      boardRow({ id: 'board-career-page', type: 'career-page', boardId: null, feedUrl: 'https://careers.acme.example.test/' }),
    ]);
    const res = await request(makeApp(jobAlertsRouter)).post('/alert-1/run');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    expect(upsertHealthMock.mock.calls[0][0].create.status).toBe('healthy');
  });
});

describe('aggregator provider gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createBoardMock.mockImplementation(async ({ data }: any) => ({ id: 'board-new', ...data }));
    updateBoardMock.mockImplementation(async ({ data }: any) => ({ ...boardRow(), ...data }));
  });

  it("POST /boards rejects a retired provider with the supported set", async () => {
    const res = await request(makeApp(boardsRouter))
      .post('/')
      .send({ type: 'aggregator', name: 'Old', aggregatorProvider: 'jooble' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Supported:');
    expect(createBoardMock).not.toHaveBeenCalled();
  });

  it("POST /boards accepts 'usajobs' and echoes the provider", async () => {
    const res = await request(makeApp(boardsRouter))
      .post('/')
      .send({ type: 'aggregator', name: 'Federal', aggregatorProvider: 'usajobs' });
    expect(res.status).toBe(201);
    expect(res.body.aggregatorProvider).toBe('usajobs');
  });

  it("POST /boards/validate reports a deprecated provider as non-scrapable", async () => {
    const res = await request(makeApp(boardsRouter))
      .post('/validate')
      .send({ type: 'aggregator', name: 'Old', aggregatorProvider: 'careerjet' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scrapable: false, via: 'aggregator' });
    expect(res.body.reason).toContain('no longer supported');
  });

  it("PATCH on a legacy row can deactivate without touching the provider", async () => {
    findUniqueBoardMock.mockResolvedValueOnce(
      boardRow({ type: 'aggregator', aggregatorProvider: 'careerjet' }),
    );
    const res = await request(makeApp(boardsRouter))
      .patch('/board-1')
      .send({ isActive: false });
    expect(res.status).toBe(200);
    expect(updateBoardMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isActive: false }) }),
    );
  });

  it("PATCH echoing the stored legacy provider succeeds", async () => {
    findUniqueBoardMock.mockResolvedValueOnce(
      boardRow({ type: 'aggregator', aggregatorProvider: 'careerjet' }),
    );
    const res = await request(makeApp(boardsRouter))
      .patch('/board-1')
      .send({ aggregatorProvider: 'careerjet', name: 'Renamed' });
    expect(res.status).toBe(200);
  });

  it("PATCH switching to a different retired provider is rejected", async () => {
    findUniqueBoardMock.mockResolvedValueOnce(
      boardRow({ type: 'aggregator', aggregatorProvider: 'careerjet' }),
    );
    const res = await request(makeApp(boardsRouter))
      .patch('/board-1')
      .send({ aggregatorProvider: 'jooble' });
    expect(res.status).toBe(400);
    expect(updateBoardMock).not.toHaveBeenCalled();
  });

  it("apiKeyProviderSchema still accepts retired ids", async () => {
    const { validateInput, createApiKeySchema } = await import('../shared/validation.js');
    expect(() =>
      validateInput(createApiKeySchema, { provider: 'careerjet', apiKey: 'x'.repeat(10) }),
    ).not.toThrow();
    expect(() =>
      validateInput(createApiKeySchema, { provider: 'jooble', apiKey: 'x'.repeat(10) }),
    ).not.toThrow();
  });
});
