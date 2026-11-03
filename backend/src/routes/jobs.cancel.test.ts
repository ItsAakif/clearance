// Wave 11 (T820) - a cancelled search returns the partial result set and
// never rolls back persisted listings (N16, ADR-027/ADR-013).
//
// Part A pins the orchestrator contract directly: mid-flight cancel RESOLVES
// with partials + `cancelled: true`, in-flight units observe the abort
// signal (the wave-6 T723 release path), the boundary rule is deterministic
// (rows received win -> `ok`; error after cancel -> `cancelled`, never
// `failed`), cancel at 0 results is an honest empty set, and neither the
// orchestrator nor the route carries a listing delete path.
// Part B pins the HTTP contract: GET /jobs/search cancelled mid-flight
// returns 200 with the partial items flagged `cancelled: true` /
// `partial: true` (legacy callers without `mode` keep working), the N
// listings persisted before the cancel are all still queryable after, and
// an unknown/expired run is the documented 404.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RawJob } from '../jobSources/adapters/http.js';
import type { JobSourceConfig } from '../jobSources/index.js';
import { searchIntentSchema, type SearchIntent } from '../discovery/searchIntent.js';
import type { RunBudget } from '../discovery/budgets.js';
import {
  cancelRun,
  resetOrchestratorForTests,
  runSearch,
  type ExecutableUnit,
  type UserBoardRef,
} from '../discovery/orchestrator.js';

const { prismaMocks, runSourceMock, seedMock, healthMocks } = vi.hoisted(() => ({
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
  runSourceMock: vi.fn(),
  seedMock: vi.fn(),
  healthMocks: { recordSourceSuccess: vi.fn(), recordSourceFailure: vi.fn() },
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

import jobsRouter from './jobs.js';
import { resetRunsForTests } from '../jobSources/discoveryRuns.js';

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

const HERE = __dirname;
const ORCHESTRATOR_PATH = path.join(HERE, '..', 'discovery', 'orchestrator.ts');
const ROUTES_PATH = path.join(HERE, 'jobs.ts');

const SMALL_BUDGET: RunBudget = {
  maxUnits: 10,
  maxConcurrent: 1,
  perUnitTimeoutMs: 1500,
  totalBudgetMs: 10000,
  perSourceResultCap: 10,
};

function makeJob(source: string, id: string): RawJob {
  return {
    externalId: id,
    source,
    sourceUrl: `https://example.com/${source}/${id}`,
    title: `Engineer ${id}`,
    company: 'Acme',
    description: 'Build things.',
  };
}

function board(id: string, type: string): UserBoardRef {
  return {
    boardId: id,
    name: `${type} ${id}`,
    type,
    config: { type, query: '', userId: 'u1' } as JobSourceConfig,
  };
}

function intentOf(overrides: Partial<Record<string, unknown>> = {}): SearchIntent {
  return searchIntentSchema.parse({ mode: 'fast', ...overrides });
}

function abortError(): Error {
  const err = new Error('aborted for test');
  err.name = 'AbortError';
  return err;
}

/** Executor that hangs until the run signal aborts (cooperative cancel). */
function hangUntilAbort(): (unit: ExecutableUnit, signal: AbortSignal) => Promise<RawJob[]> {
  return (_unit, signal) =>
    new Promise<RawJob[]>((_resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Watchdog: a hanging promise fails the test instead of hanging vitest. */
async function resolvesOrHangs<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label} - the cancel hung`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Part A - orchestrator cancel retention
// ---------------------------------------------------------------------------

describe('T820 orchestrator: cancel returns partials, never rolls back', () => {
  beforeEach(() => {
    resetOrchestratorForTests();
  });

  it('a run cancelled mid-flight RESOLVES with the non-empty partial set and cancelled:true', async () => {
    const hang = hangUntilAbort();
    const deps = {
      budget: SMALL_BUDGET,
      listUserBoards: async () => [
        board('first', 'greenhouse'),
        board('second', 'rss'),
        board('third', 'search'),
      ],
      executeUnit: async (unit: ExecutableUnit, signal: AbortSignal) => {
        if (unit.unitId === 'board:second') return hang(unit, signal);
        return [makeJob(unit.providerType, `${unit.unitId}-1`)];
      },
    };
    const pending = runSearch(intentOf(), { runId: 't820-a1', userId: 'u1' }, deps);
    await tick(40);
    expect(cancelRun('t820-a1', 'u1')).toBe(true);
    // The request RESOLVES (the watchdog turns a hang into a failure).
    const outcome = await resolvesOrHangs(pending, 'cancelled runSearch');
    expect(outcome.cancelled).toBe(true);
    // Partial rows from the finished unit are kept, not rolled back.
    expect(outcome.jobs).toHaveLength(1);
    expect(outcome.truncated).toBe(false);
    // Unscheduled units are reported cancelled, never silently dropped.
    expect(outcome.skipped).toContainEqual({ unitId: 'board:third', reason: 'cancelled' });
  });

  it('a unit stopped by cancel is cancelled, not failed - and observes the abort signal (release path)', async () => {
    const hang = hangUntilAbort();
    let slowSignal: AbortSignal | undefined;
    const deps = {
      budget: SMALL_BUDGET,
      listUserBoards: async () => [board('slow', 'greenhouse')],
      executeUnit: async (unit: ExecutableUnit, signal: AbortSignal) => {
        slowSignal = signal;
        return hang(unit, signal);
      },
    };
    const pending = runSearch(intentOf(), { runId: 't820-a2', userId: 'u1' }, deps);
    await tick(30);
    expect(cancelRun('t820-a2', 'u1')).toBe(true);
    const outcome = await resolvesOrHangs(pending, 'cancelled runSearch');
    expect(outcome.cancelled).toBe(true);
    // The in-flight unit observed the abort: session-owning executors
    // release on this signal (wave-6 T723 hook), so sessions cannot leak.
    expect(slowSignal?.aborted).toBe(true);
    const slow = outcome.units.find((u) => u.unitId === 'board:slow')!;
    expect(slow.status).toBe('cancelled');
    expect(slow.status).not.toBe('failed');
  });

  it('boundary rule: rows received win - a unit resolving with rows after the flag is ok and its rows are kept', async () => {
    const deps = {
      budget: SMALL_BUDGET,
      listUserBoards: async () => [board('racy', 'greenhouse')],
      // Resolves WITH rows after a delay longer than the cancel below, so
      // the cancel flag is already set when the result is recorded.
      executeUnit: async () => {
        await tick(80);
        return [makeJob('greenhouse', 'racy-1')];
      },
    };
    const pending = runSearch(intentOf(), { runId: 't820-a3', userId: 'u1' }, deps);
    await tick(15);
    expect(cancelRun('t820-a3', 'u1')).toBe(true);
    const outcome = await resolvesOrHangs(pending, 'cancelled runSearch');
    expect(outcome.cancelled).toBe(true);
    const racy = outcome.units.find((u) => u.unitId === 'board:racy')!;
    expect(racy.status).toBe('ok');
    expect(outcome.jobs).toHaveLength(1);
  });

  it('cancel at 0 results resolves an honest empty cancelled set, distinct from an error', async () => {
    const deps = {
      budget: SMALL_BUDGET,
      listUserBoards: async () => [board('hung', 'greenhouse')],
      executeUnit: hangUntilAbort(),
    };
    const pending = runSearch(intentOf(), { runId: 't820-a4', userId: 'u1' }, deps);
    // Cancel on the same tick the run starts: nothing could have completed
    // (and with a width-1 pool the flag lands before the first unit is even
    // scheduled, so no unit record exists - the empty set is still honest).
    expect(cancelRun('t820-a4', 'u1')).toBe(true);
    const outcome = await resolvesOrHangs(pending, 'cancelled runSearch');
    expect(outcome.cancelled).toBe(true);
    expect(outcome.jobs).toEqual([]);
    expect(outcome.units).toEqual([]);
    expect(outcome.skipped).toContainEqual({ unitId: 'board:hung', reason: 'cancelled' });
  });

  it('N16 structural guard: no listing delete path exists in the orchestrator or the route', () => {
    // A cancel that deletes or rolls back an already-persisted listing
    // violates N16 and destroys user data - pin the absence in code.
    for (const [label, file] of [
      ['orchestrator', ORCHESTRATOR_PATH],
      ['routes/jobs', ROUTES_PATH],
    ] as const) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${label} must carry no listing delete path`).not.toMatch(/deleteMany/);
    }
  });
});

// ---------------------------------------------------------------------------
// Part B - HTTP: cancelled /search returns the flagged partial set, N16 holds
// ---------------------------------------------------------------------------

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

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function httpJob(source: string, id: string) {
  return {
    externalId: id,
    source,
    sourceUrl: `https://example.com/${source}/${id}`,
    title: `Senior Backend Engineer ${id}`,
    company: 'Acme Corp',
    location: 'Berlin',
    description: 'Build backend APIs for engineers.',
    applyUrl: `https://example.com/${source}/${id}`,
  };
}

/** In-memory JobListing stand-in keyed like the source_externalId unique. */
const store = new Map<string, any>();
const storeKey = (source: string, externalId: string): string => `${source}::${externalId}`;

function seedStoredListing(id: string, source: string, externalId: string): void {
  store.set(storeKey(source, externalId), {
    id,
    source,
    externalId,
    title: `Stored Engineer ${externalId}`,
    company: 'StoredCo',
    location: 'Berlin',
    description: 'A previously persisted listing that a cancel must never remove.',
    applyUrl: `https://example.com/${source}/${externalId}`,
    sourceUrl: `https://example.com/${source}/${externalId}`,
    postedAt: null,
    isActive: true,
  });
}

describe('T820 HTTP: cancelled search returns flagged partials, persisted rows survive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunsForTests();
    resetOrchestratorForTests();
    store.clear();
    prismaMocks.jobListing.findUnique.mockImplementation(async ({ where }: any) => {
      const key = where?.source_externalId;
      if (!key) return null;
      return store.get(storeKey(key.source, key.externalId)) ?? null;
    });
    prismaMocks.jobListing.upsert.mockImplementation(async ({ create }: any) => {
      const row = {
        id: `id-${create.source}-${create.externalId}`,
        source: create.source,
        title: create.title,
        company: create.company,
        location: create.location,
        applyUrl: create.applyUrl,
        sourceUrl: create.sourceUrl,
        postedAt: create.postedAt ?? null,
        isActive: true,
      };
      store.set(storeKey(create.source, create.externalId), row);
      return row;
    });
  });

  it('mid-flight cancel on /search (no mode param) resolves 200 with the partial items flagged cancelled/partial', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow({ id: 'board-fast', name: 'Fast Board', feedUrl: 'https://fast-board.example/api' }),
      boardRow({ id: 'board-slow', name: 'Slow Board', feedUrl: 'https://slow-board.example/api' }),
    ]);
    runSourceMock.mockImplementation(async (config: any) => {
      if (typeof config.feedUrl === 'string' && config.feedUrl.includes('fast-board')) {
        await delay(50);
        return [httpJob('json', 'fast-1')];
      }
      if (typeof config.feedUrl === 'string' && config.feedUrl.includes('slow-board')) {
        await delay(600);
        return [httpJob('json', 'slow-1')];
      }
      return [];
    });

    const app = makeApp();
    // Legacy contract: no `mode` query param (acceptance criterion 8).
    // NOTE: the request is wrapped in an async IIFE so it is SENT
    // immediately - a bare supertest Test only sends once awaited, which
    // would let the cancel below land before the run exists.
    const searchPromise = (async () =>
      request(app).get('/jobs/search?q=engineer&runId=run-cancel-partial-1').set('x-test-user', 'user-1'))();
    await delay(150);
    const cancel = await request(app)
      .post('/jobs/runs/run-cancel-partial-1/cancel')
      .set('x-test-user', 'user-1');
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled).toBe(true);

    // The in-flight request RESOLVES (watchdog turns a hang into a failure).
    const search = await resolvesOrHangs(searchPromise, 'cancelled /search', 10000);
    expect(search.status).toBe(200);
    expect(Array.isArray(search.body)).toBe(true);
    // Non-empty partial set: both boards resolve with rows; cancel only
    // flags the run, it never empties what was collected.
    expect(search.body.length).toBeGreaterThan(0);
    for (const item of search.body) {
      // Additive flags ride on top of the untouched pre-existing shape.
      for (const key of ['id', 'source', 'title', 'company', 'location', 'applyUrl', 'postedUrl', 'postedAt', 'isActive']) {
        expect(item).toHaveProperty(key);
      }
      expect(item).toHaveProperty('cancelled', true);
      expect(item).toHaveProperty('partial', true);
    }

    // The snapshot reports the cancelled terminal state, not a failure.
    const snap = await request(app).get('/jobs/runs/run-cancel-partial-1').set('x-test-user', 'user-1');
    expect(snap.status).toBe(200);
    expect(snap.body.cancelled).toBe(true);
    for (const b of snap.body.boards) expect(b.status).not.toBe('failed');
  });

  it('N16: listings persisted before the cancel are all still queryable after - no rollback', async () => {
    // Persist N = 3 listings BEFORE the cancelled run (the durability
    // backstop owned by upsertDiscoveredJobs).
    seedStoredListing('seed-1', 'json', 'seed-1');
    seedStoredListing('seed-2', 'json', 'seed-2');
    seedStoredListing('seed-3', 'json', 'seed-3');

    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow({ id: 'board-fast', name: 'Fast Board', feedUrl: 'https://fast-board.example/api' }),
      boardRow({ id: 'board-slow', name: 'Slow Board', feedUrl: 'https://slow-board.example/api' }),
    ]);
    runSourceMock.mockImplementation(async (config: any) => {
      if (typeof config.feedUrl === 'string' && config.feedUrl.includes('fast-board')) {
        await delay(50);
        return [httpJob('json', 'fast-1')];
      }
      if (typeof config.feedUrl === 'string' && config.feedUrl.includes('slow-board')) {
        await delay(600);
        return [httpJob('json', 'slow-1')];
      }
      return [];
    });

    const app = makeApp();
    // Sent immediately (see the note above): the cancel must land mid-run.
    const searchPromise = (async () =>
      request(app).get('/jobs/search?q=engineer&runId=run-cancel-norollback-1').set('x-test-user', 'user-1'))();
    await delay(150);
    await request(app).post('/jobs/runs/run-cancel-norollback-1/cancel').set('x-test-user', 'user-1');
    const search = await resolvesOrHangs(searchPromise, 'cancelled /search', 10000);
    expect(search.status).toBe(200);

    // All N pre-existing rows are still queryable, byte-identical by id.
    for (const id of ['seed-1', 'seed-2', 'seed-3']) {
      const row = store.get(storeKey('json', id));
      expect(row, `persisted listing ${id} must survive cancel`).toBeDefined();
      expect(row.id).toBe(id);
    }
    // The cancel path exposes no listing delete surface at all.
    expect('deleteMany' in prismaMocks.jobListing).toBe(false);
    expect('delete' in prismaMocks.jobListing).toBe(false);
  });

  it('cancel of an unknown/expired run returns the documented unknown-run response', async () => {
    const res = await request(makeApp())
      .post('/jobs/runs/run-never-existed-1/cancel')
      .set('x-test-user', 'user-1');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Discovery run not found or expired' });
  });
});
