import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { prismaMocks, runSourceMock, seedMock, healthMocks } = vi.hoisted(() => ({
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { upsert: vi.fn(), update: vi.fn() },
  },
  runSourceMock: vi.fn(),
  seedMock: vi.fn(),
  healthMocks: { recordSourceSuccess: vi.fn(), recordSourceFailure: vi.fn() },
}));

// Auth passthrough driven by the x-test-user header: missing header -> 401.
// This proves the new /runs/:runId route is behind requireAuth and lets us
// exercise per-user isolation of the run registry.
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

import jobsRouter from './jobs.js';
import { beginRun, resetRunsForTests } from '../jobSources/discoveryRuns.js';

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

const rawJob = {
  externalId: 'remotive-1',
  source: 'json',
  sourceUrl: 'https://remotive.com/jobs/1',
  title: 'Senior Backend Engineer',
  company: 'RemotiveCo',
  location: 'Worldwide',
  description: 'Build APIs.',
  applyUrl: 'https://remotive.com/jobs/1',
};

describe('discovery run progress wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    prismaMocks.jobListing.upsert.mockImplementation(async ({ create }: any) => ({
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
  });

  it('GET /search with runId records a terminal snapshot readable via /runs/:runId', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow({ id: 'board-1', name: 'Board One' }),
      boardRow({ id: 'board-2', name: 'Board Two', type: 'jobicy', feedUrl: null }),
    ]);
    runSourceMock.mockImplementation(async (config: any) =>
      config.type === 'jobicy' ? [] : [{ ...rawJob }],
    );
    const search = await request(makeApp())
      .get('/jobs/search?q=engineer&runId=run-search-1')
      .set('x-test-user', 'user-1');
    expect(search.status).toBe(200);
    // Existing response shape unchanged: array of listings.
    expect(Array.isArray(search.body)).toBe(true);

    const snap = await request(makeApp()).get('/jobs/runs/run-search-1').set('x-test-user', 'user-1');
    expect(snap.status).toBe(200);
    expect(snap.body.runId).toBe('run-search-1');
    expect(snap.body.finishedAt).toBeTruthy();
    expect(snap.body.totalListings).toBe(1);
    expect(snap.body.boards).toHaveLength(2);
    for (const b of snap.body.boards) expect(b.status).toBe('ok');
  });

  it('classifies missing-key failures as needs_key and other failures as failed', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow({ id: 'board-key', name: 'Key Board', type: 'rss', feedUrl: 'https://example.com/rss' }),
      boardRow({ id: 'board-bad', name: 'Bad Board' }),
    ]);
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type === 'rss') throw new Error('No search API keys configured. Add an Exa key in Settings (BYOK).');
      throw new Error('Fetch failed 500');
    });
    const res = await request(makeApp())
      .get('/jobs/scan?query=engineer&runId=run-scan-needskey')
      .set('x-test-user', 'user-1');
    expect(res.status).toBe(200);

    const snap = await request(makeApp()).get('/jobs/runs/run-scan-needskey').set('x-test-user', 'user-1');
    expect(snap.status).toBe(200);
    const byId = Object.fromEntries(snap.body.boards.map((b: any) => [b.boardId, b]));
    expect(byId['board-key'].status).toBe('needs_key');
    expect(byId['board-bad'].status).toBe('failed');
    expect(snap.body.finishedAt).toBeTruthy();
  });

  it('omitting runId leaves routes unchanged and records nothing', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([{ ...rawJob }]);
    const res = await request(makeApp()).get('/jobs/search?q=engineer').set('x-test-user', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const missing = await request(makeApp()).get('/jobs/runs/any-run-id-here').set('x-test-user', 'user-1');
    expect(missing.status).toBe(404);
  });

  it('an invalid runId on /search is rejected with 400 (T308 strict validation)', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([{ ...rawJob }]);
    const res = await request(makeApp())
      .get('/jobs/search?q=engineer&runId=bad!!')
      .set('x-test-user', 'user-1');
    expect(res.status).toBe(400);
    const missing = await request(makeApp()).get('/jobs/runs/bad!!').set('x-test-user', 'user-1');
    expect(missing.status).toBe(404);
  });

  it('an invalid runId on /scan is still treated as absent (no 400, nothing recorded)', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([{ ...rawJob }]);
    const res = await request(makeApp())
      .get('/jobs/scan?query=engineer&runId=bad!!')
      .set('x-test-user', 'user-1');
    expect(res.status).toBe(200);
  });

  it('GET /runs/:runId requires auth and isolates users', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([]);
    await request(makeApp()).get('/jobs/search?q=engineer&runId=run-private-1').set('x-test-user', 'user-1');

    const noAuth = await request(makeApp()).get('/jobs/runs/run-private-1');
    expect(noAuth.status).toBe(401);

    const otherUser = await request(makeApp()).get('/jobs/runs/run-private-1').set('x-test-user', 'user-2');
    expect(otherUser.status).toBe(404);
    expect(otherUser.body).toEqual({ error: 'Discovery run not found or expired' });
  });
});

describe('run snapshot extension + cancel endpoint (T743)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    prismaMocks.jobListing.upsert.mockImplementation(async ({ create }: any) => ({
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
  });

  it('GET /jobs/runs/:runId still returns every pre-existing field with the same type', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([{ ...rawJob }]);
    await request(makeApp()).get('/jobs/search?q=engineer&runId=run-compat-1').set('x-test-user', 'user-1');

    const snap = await request(makeApp()).get('/jobs/runs/run-compat-1').set('x-test-user', 'user-1');
    expect(snap.status).toBe(200);
    // The pre-existing key set is a subset of the new one: nothing removed
    // or renamed (run-progress contract).
    for (const key of ['runId', 'startedAt', 'finishedAt', 'boards', 'totalListings']) {
      expect(snap.body).toHaveProperty(key);
    }
    expect(typeof snap.body.runId).toBe('string');
    expect(typeof snap.body.startedAt).toBe('string');
    expect(typeof snap.body.finishedAt).toBe('string');
    expect(Array.isArray(snap.body.boards)).toBe(true);
    expect(typeof snap.body.totalListings).toBe('number');
    for (const b of snap.body.boards) {
      for (const key of ['boardId', 'name', 'type', 'status', 'resultCount']) {
        expect(b).toHaveProperty(key);
      }
      expect(typeof b.boardId).toBe('string');
      expect(typeof b.resultCount).toBe('number');
    }
  });

  it('search items gain additive cancelled/partial booleans and lose no field', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([{ ...rawJob }]);
    const res = await request(makeApp())
      .get('/jobs/search?q=engineer&runId=run-flags-1')
      .set('x-test-user', 'user-1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const item = res.body[0];
    // Pre-existing key set asserted intact (verified shape).
    for (const key of ['id', 'source', 'title', 'company', 'location', 'applyUrl', 'postedUrl', 'postedAt', 'isActive']) {
      expect(item).toHaveProperty(key);
    }
    expect(item).toHaveProperty('cancelled', false);
    expect(item).toHaveProperty('partial', false);
    expect(typeof item.cancelled).toBe('boolean');
    expect(typeof item.partial).toBe('boolean');
  });

  it('cancel marks a live run cancelled and is idempotent', async () => {
    beginRun('run-live-cancel-1', 'user-1', [{ id: 'board-1', name: 'Board One', type: 'json' }]);

    const first = await request(makeApp())
      .post('/jobs/runs/run-live-cancel-1/cancel')
      .set('x-test-user', 'user-1');
    expect(first.status).toBe(200);
    expect(first.body.runId).toBe('run-live-cancel-1');
    expect(first.body.cancelled).toBe(true);
    expect(first.body.finishedAt).toBeTruthy();
    expect(first.body.boards).toHaveLength(1);
    expect(first.body.boards[0].status).toBe('cancelled');

    // Idempotent: a repeat cancel returns the same snapshot unchanged.
    const second = await request(makeApp())
      .post('/jobs/runs/run-live-cancel-1/cancel')
      .set('x-test-user', 'user-1');
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    // The reader reflects the cancelled state too.
    const snap = await request(makeApp()).get('/jobs/runs/run-live-cancel-1').set('x-test-user', 'user-1');
    expect(snap.status).toBe(200);
    expect(snap.body.cancelled).toBe(true);
  });

  it('cancel is scoped to the caller: another user run is untouched', async () => {
    beginRun('run-victim-1', 'user-1', [{ id: 'board-1', name: 'Board One', type: 'json' }]);

    const intruder = await request(makeApp())
      .post('/jobs/runs/run-victim-1/cancel')
      .set('x-test-user', 'user-2');
    expect(intruder.status).toBe(404);
    expect(intruder.body).toEqual({ error: 'Discovery run not found or expired' });

    // The owner's snapshot is unaffected: still live, not cancelled.
    const snap = await request(makeApp()).get('/jobs/runs/run-victim-1').set('x-test-user', 'user-1');
    expect(snap.status).toBe(200);
    expect(snap.body.cancelled).toBeUndefined();
    expect(snap.body.finishedAt).toBeUndefined();
    expect(snap.body.boards[0].status).toBe('pending');
  });

  it('cancel of an unknown run is a documented 404 and requires auth', async () => {
    const missing = await request(makeApp())
      .post('/jobs/runs/no-such-run-1/cancel')
      .set('x-test-user', 'user-1');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Discovery run not found or expired' });

    const noAuth = await request(makeApp()).post('/jobs/runs/no-such-run-1/cancel');
    expect(noAuth.status).toBe(401);
  });

  it('cancel of an already-finished run is a no-op returning the snapshot unchanged', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([{ ...rawJob }]);
    await request(makeApp()).get('/jobs/search?q=engineer&runId=run-done-1').set('x-test-user', 'user-1');

    const before = await request(makeApp()).get('/jobs/runs/run-done-1').set('x-test-user', 'user-1');
    expect(before.status).toBe(200);

    const cancelled = await request(makeApp())
      .post('/jobs/runs/run-done-1/cancel')
      .set('x-test-user', 'user-1');
    expect(cancelled.status).toBe(200);
    // Finished snapshot unchanged: no cancelled flag, boards still ok.
    expect(cancelled.body).toEqual(before.body);
    expect(cancelled.body.cancelled).toBeUndefined();
    for (const b of cancelled.body.boards) expect(b.status).toBe('ok');
  });
});
