// Admin observability tests (Wave 13, T860).
//
// The real requireAdmin gate is exercised (not mocked): requireAuth is mocked
// to simulate (a) no session -> 401, (b) non-admin -> 403 via the real
// requireAdmin, (c) admin -> 200. Prisma is mocked; run fixtures use the REAL
// discoveryRuns module; provider assertions compare against PROVIDERS (never
// a literal list). Fixtures are synthetic (example.test hosts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks } = vi.hoisted(() => ({
  authState: { mode: 'admin' as 'admin' | 'non-admin' | 'none' },
  prismaMocks: {
    company: { count: vi.fn() },
    companyCareerPage: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    jobBoard: { findMany: vi.fn() },
    aIProviderKey: { findMany: vi.fn() },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (authState.mode === 'none') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = {
      id: 'user-1',
      email: 'test@example.com',
      isAdmin: authState.mode === 'admin',
    };
    next();
  },
}));

// requireAdmin is intentionally NOT mocked - the gate wiring is under test.
vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

import adminRouter from '../routes/admin.js';
import {
  beginRun,
  markOk,
  markFailed,
  markCancelled,
  finishRun,
  setRunEvaluation,
  resetRunsForTests,
  MAX_RUNS,
  type RunListEntry,
} from '../jobSources/discoveryRuns.js';
import * as discoveryRuns from '../jobSources/discoveryRuns.js';
import { PROVIDERS } from '../jobSources/providerRegistry.js';
import {
  buildRunsData,
  buildCostsData,
  buildFailuresData,
  runUnitFailures,
  OBS_PROVIDERS_DEFAULT_LIMIT,
  OBS_PROVIDERS_MAX_LIMIT,
  OBS_RUNS_MAX_LIMIT,
  OBS_FAILURES_DEFAULT_LIMIT,
  OBS_FAILURES_MAX_LIMIT,
  USER_BOARD_HEALTH_KIND,
  REGISTRY_HEALTH_KIND,
} from './observability.js';

const SIX_PATHS = ['/providers', '/registry', '/runs', '/sources', '/costs', '/failures'];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', adminRouter);
  return app;
}

function seedRuns(): void {
  beginRun(
    'run-obs-a',
    'user-1',
    [
      { id: 'b1', name: 'Board One', type: 'json', tier: 1, group: 'ats', unitKind: 'board' },
      { id: 'b2', name: 'Board Two', type: 'rss' },
    ],
  );
  markOk('run-obs-a', 'b1', 7, 123);
  markFailed('run-obs-a', 'b2', 'Fetch failed 500', 45);
  finishRun('run-obs-a', 7);
  beginRun('run-obs-b', 'user-2', [{ id: 'b3', name: 'Board Three', type: 'search' }]);
  markCancelled('run-obs-b');
}

function boardRow(overrides: Record<string, any> = {}) {
  return {
    id: 'jb-1',
    name: 'Json Board',
    type: 'json',
    isActive: true,
    // Junk a naive spread-projection would leak: the route must drop these.
    feedUrl: 'https://feeds.example.test/jobs.json',
    boardId: 'some-board-token',
    userId: 'user-1',
    sourceHealth: {
      status: 'ok',
      consecutiveFailures: 0,
      lastRunAt: new Date('2026-09-20T10:00:00Z'),
      lastSuccessAt: new Date('2026-09-20T10:00:00Z'),
      lastFailureAt: null,
      lastError: null,
      lastResultCount: 5,
      lastLatencyMs: 120,
    },
    ...overrides,
  };
}

function pageRow(overrides: Record<string, any> = {}) {
  return {
    id: 'page-1',
    url: 'https://boards.greenhouse.io/acme.example.test',
    host: 'boards.greenhouse.io',
    // A naive projection would leak this company token: must be absent.
    // (Distinct canary: the URL/host/company name are public registry data
    // the wave-8 surface already exposes - only THIS value must not appear.)
    boardToken: 'SECRET-BOARD-TOKEN-CANARY-9f2c',
    provider: 'greenhouse',
    tier: 1,
    verifyStatus: 'blocked',
    lastError: 'access denied by provider',
    lastCheckedAt: new Date('2026-09-20T00:00:00Z'),
    httpStatus: 403,
    resultCount: 0,
    failureCount: 3,
    company: { id: 'company-1', slug: 'acme', name: 'Acme' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRunsForTests();
  authState.mode = 'admin';
  prismaMocks.company.count.mockResolvedValue(0);
  prismaMocks.companyCareerPage.count.mockResolvedValue(0);
  prismaMocks.companyCareerPage.groupBy.mockResolvedValue([]);
  prismaMocks.companyCareerPage.findMany.mockResolvedValue([]);
  prismaMocks.jobBoard.findMany.mockResolvedValue([]);
  prismaMocks.aIProviderKey.findMany.mockResolvedValue([]);
});

// A key-name scan: no response object key may name a secret. Compound count
// nouns (approxTokens) do NOT match - only standalone secret indicators.
const SECRET_KEY_RE = /api[_-]?key|^secret|password|passwd|(^|[_-])token([_-]|$)/i;

function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectKeys(v, out);
    }
  }
  return out;
}

function expectNoSecretKeys(body: unknown): void {
  const bad = collectKeys(body).filter((k) => SECRET_KEY_RE.test(k));
  expect(bad).toEqual([]);
}

describe('admin observability auth gate (criterion 1)', () => {
  it.each(SIX_PATHS)('%s returns 401 unauthenticated', async (path) => {
    authState.mode = 'none';
    const res = await request(makeApp()).get(path);
    expect(res.status).toBe(401);
  });

  it.each(SIX_PATHS)('%s returns 403 for a non-admin session', async (path) => {
    authState.mode = 'non-admin';
    const res = await request(makeApp()).get(path);
    expect(res.status).toBe(403);
  });

  it.each(SIX_PATHS)('%s returns 200 with the envelope for an admin', async (path) => {
    authState.mode = 'admin';
    const res = await request(makeApp()).get(path);
    expect(res.status).toBe(200);
    expect(typeof res.body.generatedAt).toBe('string');
    expect(res.body.data).toBeDefined();
  });
});

describe('GET /providers (criterion 2)', () => {
  it('type set equals the registry set (compared against PROVIDERS)', async () => {
    const res = await request(makeApp()).get('/providers');
    expect(res.status).toBe(200);
    const types = res.body.data.providers.map((p: any) => p.type).sort();
    expect(types).toEqual(PROVIDERS.map((p) => p.type).sort());
    expect(res.body.data.count).toBe(PROVIDERS.length);
    expect(OBS_PROVIDERS_DEFAULT_LIMIT).toBe(50);
    expect(OBS_PROVIDERS_MAX_LIMIT).toBe(200);
    expect(res.body.data.limit).toBe(OBS_PROVIDERS_DEFAULT_LIMIT);
  });

  it('projects the allow-list only: no handler, no second list', async () => {
    const res = await request(makeApp()).get('/providers');
    for (const p of res.body.data.providers) {
      expect(Object.keys(p).sort()).toEqual(
        ['auth', 'enabledByDefault', 'kind', 'requires', 'sourceIds', 'tier', 'type'].sort(),
      );
    }
    expect(JSON.stringify(res.body)).not.toContain('handler');
  });

  it('clamps an over-large limit and rejects an invalid one', async () => {
    const clamped = await request(makeApp()).get('/providers?limit=10000');
    expect(clamped.status).toBe(200);
    expect(clamped.body.data.limit).toBe(OBS_PROVIDERS_MAX_LIMIT);
    expect((await request(makeApp()).get('/providers?limit=0')).status).toBe(400);
  });
});

describe('GET /runs (criterion 3)', () => {
  it('reports terminal states, cancelled flags, truncation and skipped reasons, bounded by MAX_RUNS', async () => {
    seedRuns();
    const res = await request(makeApp()).get('/runs');
    expect(res.status).toBe(200);
    expect(res.body.data.hasData).toBe(true);
    expect(res.body.data.runCount).toBe(2);
    // Same-millisecond seeds tie on startedAt, so locate by id (newest-first
    // ordering across distinct timestamps is asserted at builder level below).
    const runB = res.body.data.runs.find((r: any) => r.runId === 'run-obs-b');
    expect(runB.cancelled).toBe(true);
    expect(runB.units[0].status).toBe('cancelled');
    const runA = res.body.data.runs.find((r: any) => r.runId === 'run-obs-a');
    expect(runA.units.find((u: any) => u.boardId === 'b1')).toMatchObject({
      status: 'ok',
      resultCount: 7,
      latencyMs: 123,
      tier: 1,
      group: 'ats',
      unitKind: 'board',
    });
    expect(runA.units.find((u: any) => u.boardId === 'b2')).toMatchObject({
      status: 'failed',
      error: 'Fetch failed 500',
    });
    expect(OBS_RUNS_MAX_LIMIT).toBe(MAX_RUNS);
    expect(MAX_RUNS).toBe(50);
  });

  it('evicts the oldest run once the cap is exceeded', async () => {
    for (let i = 0; i < MAX_RUNS + 1; i++) {
      beginRun(`run-cap-${String(i).padStart(3, '0')}`, 'user-1', [
        { id: 'b', name: 'B', type: 'json' },
      ]);
    }
    const res = await request(makeApp()).get('/runs?limit=100');
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(MAX_RUNS);
    expect(res.body.data.runs).toHaveLength(MAX_RUNS);
    expect(res.body.data.runs.map((r: any) => r.runId)).not.toContain('run-cap-000');
  });

  it('reports no-data (not zero) when memory is empty', async () => {
    const res = await request(makeApp()).get('/runs');
    expect(res.body.data).toMatchObject({ hasData: false, runCount: 0, runs: [] });
  });

  it('builder surfaces per-unit truncation, skipped reasons, newest-first order', () => {
    const older: RunListEntry = {
      userId: 'user-1',
      snapshot: {
        runId: 'run-old',
        startedAt: new Date('2026-09-18T00:00:00Z').toISOString(),
        totalListings: 0,
        boards: [],
      },
    };
    const newer: RunListEntry = {
      userId: 'user-1',
      snapshot: {
        runId: 'run-trunc',
        startedAt: new Date('2026-09-20T00:00:00Z').toISOString(),
        totalListings: 3,
        boards: [
          {
            boardId: 'b1',
            name: 'B1',
            type: 'json',
            status: 'ok',
            resultCount: 3,
            truncated: true,
            skippedReason: 'budget stop',
          },
        ],
      },
    };
    // Input in oldest-first order: the builder must still emit newest-first.
    const data = buildRunsData([older, newer], 20);
    expect(data.hasData).toBe(true);
    expect(data.runs.map((r) => r.runId)).toEqual(['run-trunc', 'run-old']);
    expect(data.runs[0].truncated).toBe(true);
    expect(data.runs[0].skippedReasons).toEqual(['budget stop']);
    expect(data.runs[0].units[0]).toMatchObject({ truncated: true, skippedReason: 'budget stop' });
  });
});

describe('no secret values (criterion 4)', () => {
  it('key-name scan finds no secret-shaped key on any of the six bodies', async () => {
    seedRuns();
    setRunEvaluation('run-obs-a', {
      requested: 2,
      completed: 2,
      skipped: 0,
      estimate: { calls: 2, approxTokens: 500 },
    });
    prismaMocks.company.count.mockResolvedValue(1);
    prismaMocks.companyCareerPage.count.mockResolvedValue(1);
    prismaMocks.companyCareerPage.groupBy.mockImplementation(async (args: any) => {
      if (args.by[0] === 'provider') return [{ provider: 'greenhouse', _count: { _all: 1 } }];
      if (args.by[0] === 'tier') return [{ tier: 1, _count: { _all: 1 } }];
      return [{ verifyStatus: 'blocked', _count: { _all: 1 } }];
    });
    prismaMocks.companyCareerPage.findMany.mockResolvedValue([pageRow()]);
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    prismaMocks.aIProviderKey.findMany.mockResolvedValue([
      {
        provider: 'tavily',
        isActive: true,
        lastUsedAt: new Date('2026-09-20T10:00:00Z'),
        rateLimitedUntil: new Date(Date.now() + 60_000),
      },
    ]);
    for (const path of SIX_PATHS) {
      const res = await request(makeApp()).get(path);
      expect(res.status).toBe(200);
      expectNoSecretKeys(res.body);
      // The planted company token must not appear as a VALUE either.
      expect(JSON.stringify(res.body)).not.toContain('SECRET-BOARD-TOKEN-CANARY-9f2c');
    }
  });

  it('never selects the apiKey column (allow-list at the query level)', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    await request(makeApp()).get('/sources');
    await request(makeApp()).get('/failures');
    expect(prismaMocks.aIProviderKey.findMany).toHaveBeenCalled();
    for (const call of prismaMocks.aIProviderKey.findMany.mock.calls) {
      expect(call[0].select).not.toHaveProperty('apiKey');
    }
  });

  it('board junk fields never reach the sources response (projection, not spread)', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    const res = await request(makeApp()).get('/sources');
    expect(res.status).toBe(200);
    const board = res.body.data.userBoardHealth.boards[0];
    expect(Object.keys(board).sort()).toEqual(
      [
        'boardId',
        'boardName',
        'boardType',
        'consecutiveFailures',
        'isActive',
        'lastError',
        'lastFailureAt',
        'lastLatencyMs',
        'lastResultCount',
        'lastRunAt',
        'lastSuccessAt',
        'status',
      ].sort(),
    );
  });
});

describe('GET /costs no-data vs zero (criterion 5)', () => {
  it('reports no-data when no live run carries an estimate', async () => {
    seedRuns();
    const res = await request(makeApp()).get('/costs');
    expect(res.body.data).toMatchObject({
      hasData: false,
      totalRunsSeen: 2,
      runsWithEstimates: 0,
      perRun: [],
    });
  });

  it('a real zero estimate still counts as data', async () => {
    seedRuns();
    setRunEvaluation('run-obs-a', {
      requested: 2,
      completed: 0,
      skipped: 2,
      reason: 'no keys',
      estimate: { calls: 0, approxTokens: 0 },
    });
    const res = await request(makeApp()).get('/costs');
    expect(res.body.data).toMatchObject({
      hasData: true,
      runsWithEstimates: 1,
      totalCalls: 0,
      totalApproxTokens: 0,
    });
    expect(res.body.data.perRun[0]).toMatchObject({ runId: 'run-obs-a', calls: 0 });
  });

  it('builder aggregates across runs', () => {
    seedRuns();
    setRunEvaluation('run-obs-a', {
      requested: 2,
      completed: 2,
      skipped: 0,
      estimate: { calls: 2, approxTokens: 500 },
    });
    const { listRuns } = discoveryRuns;
    const data = buildCostsData(listRuns(), 20);
    expect(data).toMatchObject({
      hasData: true,
      totalRunsSeen: 2,
      runsWithEstimates: 1,
      totalCalls: 2,
      totalApproxTokens: 500,
    });
  });
});

describe('GET /sources health labelling (criterion 6)', () => {
  it('labels user-board vs registry health distinctly', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow(),
      boardRow({ id: 'jb-2', name: 'Rss Board', type: 'rss', sourceHealth: null }),
    ]);
    prismaMocks.aIProviderKey.findMany.mockResolvedValue([
      {
        provider: 'tavily',
        isActive: true,
        lastUsedAt: new Date('2026-09-20T10:00:00Z'),
        rateLimitedUntil: new Date(Date.now() + 60_000),
      },
    ]);
    prismaMocks.companyCareerPage.groupBy.mockImplementation(async (args: any) => {
      if (args.by[0] === 'provider') return [{ provider: 'greenhouse', _count: { _all: 4 } }];
      if (args.by[0] === 'tier') return [{ tier: 1, _count: { _all: 4 } }];
      return [{ verifyStatus: 'ok', _count: { _all: 4 } }];
    });
    prismaMocks.companyCareerPage.count.mockImplementation(async (args: any) =>
      args?.where?.isActive === false ? 1 : 5,
    );
    const res = await request(makeApp()).get('/sources');
    expect(res.status).toBe(200);
    expect(USER_BOARD_HEALTH_KIND).toBe('user-board');
    expect(REGISTRY_HEALTH_KIND).toBe('global-registry');
    expect(res.body.data.userBoardHealth.healthKind).toBe('user-board');
    expect(res.body.data.registryHealth.healthKind).toBe('global-registry');
    // A board that never ran keeps latency null (renders "-"), never 0ms.
    const byType = res.body.data.userBoardHealth.byType;
    expect(byType.find((t: any) => t.type === 'json')).toMatchObject({
      boards: 1,
      successes: 1,
      avgLatencyMs: 120,
      totalListings: 5,
    });
    expect(byType.find((t: any) => t.type === 'rss')).toMatchObject({
      boards: 1,
      avgLatencyMs: null,
    });
    // Cooldown is presence + timestamp only.
    expect(res.body.data.keyCooldowns).toEqual([
      {
        provider: 'tavily',
        hasKey: true,
        keyCount: 1,
        inCooldown: true,
        rateLimitedUntil: expect.any(String),
        lastUsedAt: expect.any(String),
      },
    ]);
  });
});

describe('GET /failures bounded newest-first (criterion 7)', () => {
  it('merges run-units, registry pages and rate-limits newest-first and bounded', async () => {
    seedRuns();
    prismaMocks.companyCareerPage.findMany.mockResolvedValue([
      pageRow({
        id: 'page-old',
        lastCheckedAt: new Date('2026-09-18T00:00:00Z'),
        lastError: 'older failure',
      }),
      pageRow({
        id: 'page-new',
        lastCheckedAt: new Date('2026-09-20T00:00:00Z'),
        lastError: 'newer failure',
      }),
    ]);
    prismaMocks.aIProviderKey.findMany.mockResolvedValue([
      {
        provider: 'tavily',
        isActive: true,
        lastUsedAt: new Date('2026-09-20T10:00:00Z'),
        rateLimitedUntil: new Date(Date.now() + 60_000),
      },
    ]);
    const res = await request(makeApp()).get('/failures?limit=2');
    expect(res.status).toBe(200);
    expect(OBS_FAILURES_DEFAULT_LIMIT).toBe(20);
    expect(OBS_FAILURES_MAX_LIMIT).toBe(100);
    expect(res.body.data.limit).toBe(2);
    expect(res.body.data.failures).toHaveLength(2);
    expect(res.body.data.hasData).toBe(true);
    expect(res.body.data.failureCount).toBe(4);
    // Newest-first across kinds: the cooldown (future) leads, then the run
    // unit (finished now), then the registry rows by lastCheckedAt.
    const full = await request(makeApp()).get('/failures');
    const kinds = full.body.data.failures.map((f: any) => f.kind);
    expect(kinds).toEqual(['rate-limit', 'run-unit', 'registry-page', 'registry-page']);
    const ats = full.body.data.failures.map((f: any) => f.at);
    const sorted = [...ats].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(ats).toEqual(sorted);
  });

  it('run-unit projection only picks failed units', () => {
    seedRuns();
    const { listRuns } = discoveryRuns;
    const items = runUnitFailures(listRuns());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'run-unit',
      reason: 'Fetch failed 500',
      runId: 'run-obs-a',
      boardId: 'b2',
    });
    const empty = buildFailuresData([], 20);
    expect(empty).toMatchObject({ hasData: false, failureCount: 0, failures: [] });
  });
});

describe('legacy routes unchanged (criterion 8)', () => {
  it('/status keeps its bare body (no envelope)', async () => {
    const res = await request(makeApp()).get('/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'test@example.com', isAdmin: true });
    expect(res.body.generatedAt).toBeUndefined();
    expect(res.body.data).toBeUndefined();
  });

  it('/templates keeps its bare array body (no envelope)', async () => {
    const res = await request(makeApp()).get('/templates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('discoveryRuns read-only helpers are additive', () => {
  it('listRuns scopes by user, returns copies, and never exports the Map', async () => {
    seedRuns();
    const { listRuns, summarizeRuns } = discoveryRuns;
    expect(listRuns()).toHaveLength(2);
    expect(listRuns('user-1').map((e) => e.snapshot.runId)).toEqual(['run-obs-a']);
    // Mutating a returned snapshot cannot corrupt live runs.
    const first = listRuns()[0];
    first.snapshot.boards.push({
      boardId: 'evil',
      name: 'evil',
      type: 'x',
      status: 'ok',
      resultCount: 99,
    });
    expect(listRuns()).toHaveLength(2);
    expect(listRuns()[0].snapshot.boards.find((b) => b.boardId === 'evil')).toBeUndefined();
    // The internal Map is not exported.
    expect((discoveryRuns as Record<string, unknown>).runs).toBeUndefined();
    const summary = summarizeRuns();
    expect(summary).toMatchObject({ runCount: 2, hasData: true, cancelledRuns: 1 });
    expect(summary.byUnitStatus).toMatchObject({ ok: 1, failed: 1, cancelled: 1 });
    resetRunsForTests();
    expect(summarizeRuns()).toMatchObject({ runCount: 0, hasData: false });
  });
});
