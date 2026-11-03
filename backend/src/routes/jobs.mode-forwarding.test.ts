// Mode/evaluate forwarding regression (Wave 10 follow-up to T804; extended by
// ADR-033 / T886 for the four-value vocabulary).
//
// T744's `intentForLegacySearch` dropped `mode`/`evaluate`, so every legacy
// search executed as fast+deterministic and the UI's `mode=deep` param was
// silently ignored server-side. This file pins the fix at two levels:
//
// - unit: `intentForLegacySearch` carries mode + evaluate into the intent,
//   including through the adversarial-input fallback literal, and omitting
//   them keeps the byte-identical fast+deterministic legacy default;
// - route: `GET /search` and `GET /scan` forward the query flags to the
//   orchestrator (asserted by capturing the intent `runSearch` receives;
//   execution still runs the real orchestrator, so behaviour is covered).
//
// T886 adds the ADR-033 contract on the SAME two routes:
//   - `standard`/`deep` forward; `full` is route-exclusive and degrades to
//     `fast` exactly like an unknown value (never a 400);
//   - `/search` picks its company-scope resolver BY MODE: fast/no-mode keeps
//     `boardsOnlyCompanyScope`, standard/deep omit the key so the
//     orchestrator's default registry-backed resolver applies (standard's
//     registryCap=0 short-circuits it with an explicit skip), and `/scan`
//     stays boards-only in every mode (it carries no company filter);
//   - the run snapshot TTL is mode-scoped: deep -> DEEP_RUN_TTL_MS, everything
//     else -> beginRun's own RUN_TTL_MS default;
//   - no response shape changes.
//
// NOTE on fixtures: `prismaMocks` deliberately has NO `jobEvaluation` model
// mock, mirroring jobs.orchestrated-search.test.ts. It DOES carry `company`
// (count/findFirst) from T886 onwards - the standard/deep `/search` path is
// now allowed to consult the registry, so the mock is the seam for the
// default registry-backed resolver; `not.toHaveBeenCalled()` on it is what
// pins "the fast path still touches no registry row" (see the NOTE on the
// mode-scoped resolver selection below).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

interface CapturedCall {
  intent: any;
  opts: any;
  deps: any;
  outcome?: any;
}

const { prismaMocks, runSourceMock, seedMock, healthMocks, capturedIntents, capturedCalls, beginRunCalls } = vi.hoisted(() => ({
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    // ADR-033/T886: the default registry-backed resolver seam (Company ->
    // active career pages). Absent from the mocks before T886, which is what
    // made a registry read on the legacy routes fail loudly.
    company: { count: vi.fn(), findFirst: vi.fn() },
  },
  runSourceMock: vi.fn(),
  seedMock: vi.fn(),
  healthMocks: { recordSourceSuccess: vi.fn(), recordSourceFailure: vi.fn() },
  capturedIntents: [] as Array<{ mode: string; evaluate: string }>,
  capturedCalls: [] as unknown as CapturedCall[],
  beginRunCalls: [] as unknown as any[][],
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

vi.mock('../jobSources/defaultBoards.js', () => ({
  seedDefaultBoardsForUser: (...args: any[]) => seedMock(...args),
}));

// Keep the real boardToConfig so config wiring is exercised; stub only runSource
// so no board network is ever hit.
vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

vi.mock('../jobSources/sourceHealth.js', () => ({
  recordSourceSuccess: (...args: any[]) => healthMocks.recordSourceSuccess(...args),
  recordSourceFailure: (...args: any[]) => healthMocks.recordSourceFailure(...args),
}));

// Capture the intent + deps each route hands the orchestrator, plus the
// outcome it resolves with, then delegate to the REAL runSearch so the
// request still executes end to end (skips/reasons included).
vi.mock('../discovery/orchestrator.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../discovery/orchestrator.js')>();
  return {
    ...orig,
    runSearch: async (intent: any, opts: any, deps: any) => {
      capturedIntents.push(intent);
      const call: CapturedCall = { intent, opts, deps };
      capturedCalls.push(call);
      const outcome = await orig.runSearch(intent, opts, deps);
      // The outcome carries the mode-scoped skips/reasons the response body
      // deliberately does NOT expose (no response shape change), so the tests
      // assert them here.
      call.outcome = outcome;
      return outcome;
    },
  };
});

// T886: capture beginRun's argument list so the mode-scoped snapshot TTL is
// observable, then delegate to the real implementation (the run registry
// itself stays real, so GET /runs/:runId and the cancel endpoint work).
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

import jobsRouter, { intentForLegacySearch } from './jobs.js';
import { getRun, resetRunsForTests } from '../jobSources/discoveryRuns.js';
import { resetOrchestratorForTests } from '../discovery/orchestrator.js';
import { RUN_TTL_MS } from '../jobSources/discoveryRuns.js';
import { DEEP_RUN_TTL_MS } from '../discovery/budgets.js';

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

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const JSON_ROWS = [
  {
    externalId: 'json-1',
    source: 'json',
    sourceUrl: 'https://example.com/jobs/1',
    title: 'Backend Engineer',
    company: 'Acme Corp',
    location: 'Berlin',
    description: 'Build backend APIs.',
    applyUrl: 'https://example.com/jobs/1',
    postedAt: new Date(NOW - DAY_MS),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  capturedIntents.length = 0;
  capturedCalls.length = 0;
  beginRunCalls.length = 0;
  resetRunsForTests();
  resetOrchestratorForTests();
  prismaMocks.jobListing.findUnique.mockResolvedValue(null);
  prismaMocks.jobListing.upsert.mockImplementation(async ({ create }: any) => ({
    id: `id-${create.source}-${create.externalId}`,
    source: create.source,
    title: create.title,
    company: create.company,
    location: create.location,
    applyUrl: create.applyUrl,
    sourceUrl: create.sourceUrl,
    postedAt: create.postedAt ?? null,
    isActive: true,
  }));
  prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
  // Registry defaults: an EMPTY registry, so a deep run that names a company
  // reports 'registry empty' unless a test seeds a match. Tests that must
  // prove "no registry access" assert these were never called.
  prismaMocks.company.count.mockResolvedValue(0);
  prismaMocks.company.findFirst.mockResolvedValue(null);
  runSourceMock.mockImplementation(async () => [...JSON_ROWS]);
});

describe('intentForLegacySearch - mode/evaluate forwarding', () => {
  it('omitted flags keep the legacy default: fast + deterministic', () => {
    const intent = intentForLegacySearch({
      q: 'backend engineer',
      sources: undefined,
      locations: [],
      company: undefined,
      limit: 30,
      postedWithin: undefined,
    });
    expect(intent.mode).toBe('fast');
    expect(intent.evaluate).toBe('deterministic');
  });

  it('mode deep and an evaluate option ride through to the intent', () => {
    const intent = intentForLegacySearch({
      q: 'backend engineer',
      sources: undefined,
      locations: ['Berlin'],
      company: 'acme',
      limit: 30,
      postedWithin: 'week',
      mode: 'deep',
      evaluate: 'ai-subset',
    });
    expect(intent.mode).toBe('deep');
    expect(intent.evaluate).toBe('ai-subset');
    // The legacy fields still map losslessly around the flags.
    expect(intent.locations).toEqual(['Berlin']);
    expect(intent.companies).toEqual(['acme']);
    expect(intent.postedWithin).toBe('week');
  });

  it('unknown flag values fall back without throwing (fast + deterministic)', () => {
    const intent = intentForLegacySearch({
      q: 'backend engineer',
      sources: undefined,
      locations: [],
      company: undefined,
      limit: 30,
      postedWithin: undefined,
      mode: 'turbo',
      evaluate: 'sometimes',
    });
    expect(intent.mode).toBe('fast');
    expect(intent.evaluate).toBe('deterministic');
  });

  it('the adversarial-input fallback literal still carries mode/evaluate', () => {
    // A single >100-char token exceeds the roles item cap, so deriveIntent
    // throws and the catch literal runs (jobSearchSchema itself accepts it).
    const adversarial = 'x'.repeat(150);
    const deep = intentForLegacySearch({
      q: adversarial,
      sources: undefined,
      locations: [],
      company: undefined,
      limit: 30,
      postedWithin: undefined,
      mode: 'deep',
      evaluate: 'ai-subset',
    });
    expect(deep.query).toBe(adversarial);
    expect(deep.mode).toBe('deep');
    expect(deep.evaluate).toBe('ai-subset');

    const legacy = intentForLegacySearch({
      q: adversarial,
      sources: undefined,
      locations: [],
      company: undefined,
      limit: 30,
      postedWithin: undefined,
    });
    expect(legacy.mode).toBe('fast');
    expect(legacy.evaluate).toBe('deterministic');
  });
});

describe('legacy routes - flags reach the orchestrator', () => {
  it('GET /search without flags runs fast + deterministic (default unchanged)', async () => {
    const res = await request(makeApp()).get('/jobs/search').query({ q: 'engineer' });
    expect(res.status).toBe(200);
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0].mode).toBe('fast');
    expect(capturedIntents[0].evaluate).toBe('deterministic');
  });

  it('GET /search?mode=deep reaches the orchestrator with mode set', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: 'deep' });
    expect(res.status).toBe(200);
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0].mode).toBe('deep');
    // No evaluate flag sent means the deterministic default still holds.
    expect(capturedIntents[0].evaluate).toBe('deterministic');
  });

  it('GET /search forwards the evaluate option', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: 'deep', evaluate: 'ai-subset' });
    expect(res.status).toBe(200);
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0].mode).toBe('deep');
    expect(capturedIntents[0].evaluate).toBe('ai-subset');
  });

  it('GET /search ignores an unknown mode (never a 400) and stays fast', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: 'turbo' });
    expect(res.status).toBe(200);
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0].mode).toBe('fast');
  });

  it('GET /scan?mode=deep reaches the orchestrator with mode set', async () => {
    const res = await request(makeApp())
      .get('/jobs/scan')
      .query({ query: 'engineer', mode: 'deep' });
    expect(res.status).toBe(200);
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0].mode).toBe('deep');
  });

  it('GET /scan without flags stays fast + deterministic (default unchanged)', async () => {
    const res = await request(makeApp()).get('/jobs/scan').query({ query: 'engineer' });
    expect(res.status).toBe(200);
    expect(capturedIntents).toHaveLength(1);
    expect(capturedIntents[0].mode).toBe('fast');
    expect(capturedIntents[0].evaluate).toBe('deterministic');
  });
});

// ---------------------------------------------------------------------------
// T886 / ADR-033: the four-value vocabulary on /search and /scan.
// `full` is ROUTE-EXCLUSIVE (it belongs to GET /jobs/full-scan) and degrades
// to the documented `fast` default on both of these routes - never a 400,
// never a partial sweep.
// ---------------------------------------------------------------------------

const PAGE_ROW = {
  externalId: 'acme-careers-1',
  source: 'career-page',
  sourceUrl: 'https://careers.acme.example/jobs/1',
  title: 'Platform Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'Build the platform team.',
  applyUrl: 'https://careers.acme.example/jobs/1',
  postedAt: new Date(NOW - DAY_MS),
};

/** Registry fixture: one company, one ACTIVE career page (tier-3 row). */
function seedRegistryWithAcmePage(): void {
  prismaMocks.company.count.mockResolvedValue(1);
  prismaMocks.company.findFirst.mockResolvedValue({
    name: 'Acme',
    careerPages: [
      { url: 'https://careers.acme.example', provider: null, boardToken: null },
    ],
  });
  runSourceMock.mockImplementation(async (config: any) =>
    config?.type === 'career-page' ? [{ ...PAGE_ROW }] : [...JSON_ROWS],
  );
}

function lastCall(): CapturedCall {
  expect(capturedCalls.length).toBeGreaterThan(0);
  return capturedCalls[capturedCalls.length - 1];
}

function lastBeginRunArgs(): any[] {
  expect(beginRunCalls.length).toBeGreaterThan(0);
  return beginRunCalls[beginRunCalls.length - 1];
}

describe('T886 - mode vocabulary and resolver selection on /search', () => {
  it('no mode stays byte-identical: fast, boards-only resolver, no registry read, default TTL', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', company: 'Acme', runId: 'run-legacy-fast-1' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const call = lastCall();
    expect(call.intent.mode).toBe('fast');
    // The legacy boards-only resolver is still injected...
    expect(typeof call.deps.resolveCompanies).toBe('function');
    // ...so the registry is never read on this path.
    expect(prismaMocks.company.count).not.toHaveBeenCalled();
    expect(prismaMocks.company.findFirst).not.toHaveBeenCalled();
    // And the snapshot keeps beginRun's own 5-minute default TTL.
    expect(lastBeginRunArgs()[3] ?? RUN_TTL_MS).toBe(RUN_TTL_MS);
  });

  it('mode=standard reaches runSearch as standard, omits the resolver, and records the registry-disabled skip', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', company: 'Acme', mode: 'standard' });
    expect(res.status).toBe(200);

    const call = lastCall();
    expect(call.intent.mode).toBe('standard');
    // Standard omits `resolveCompanies` so the orchestrator's default
    // registry-backed resolver applies...
    expect(call.deps.resolveCompanies).toBeUndefined();
    // ...and its own registryCap=0 short-circuits the lookup: NO registry
    // read happens for the named company.
    expect(prismaMocks.company.count).not.toHaveBeenCalled();
    expect(prismaMocks.company.findFirst).not.toHaveBeenCalled();
    // The skip is explicit - nothing is silently dropped.
    expect(call.outcome.skipped).toContainEqual({
      unitId: 'scope:registry',
      reason: 'registry scope disabled: standard mode',
    });
    // No registry page unit is ever scheduled in Standard mode.
    expect(call.outcome.units.some((u: any) => u.kind === 'registry-page')).toBe(false);
  });

  it('mode=deep with a named company uses the registry-backed resolver and schedules the page unit', async () => {
    // `company` (the legacy single-string filter) is what the intent's
    // `companies` list is derived from - the route's company param.
    seedRegistryWithAcmePage();
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', company: 'Acme', mode: 'deep' });
    expect(res.status).toBe(200);

    const call = lastCall();
    expect(call.intent.mode).toBe('deep');
    expect(call.intent.companies).toEqual(['Acme']);
    expect(call.deps.resolveCompanies).toBeUndefined();
    // The default resolver ran: the registry was read for the named company.
    expect(prismaMocks.company.count).toHaveBeenCalled();
    expect(prismaMocks.company.findFirst).toHaveBeenCalled();
    expect(
      prismaMocks.company.findFirst.mock.calls.some(
        (args: any[]) => String(args[0]?.where?.name?.equals).toLowerCase() === 'acme',
      ),
    ).toBe(true);
    // A page unit is planned, executed, and reported ok.
    const pageUnit = call.outcome.units.find((u: any) => u.kind === 'registry-page');
    expect(pageUnit).toBeDefined();
    expect(pageUnit.status).toBe('ok');
    expect(pageUnit.providerType).toBe('career-page');
    // No registry-disabled skip in Deep mode, and no truncation for one page.
    expect(
      call.outcome.skipped.some((s: any) => String(s.reason).includes('registry scope disabled')),
    ).toBe(false);
    // The page's row flows through the unchanged response shape.
    expect(res.body.some((item: any) => item.source === 'career-page')).toBe(true);
  });

  it('mode=full degrades to fast on /search (route-exclusive) and never reaches the intent as full', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: 'full' });
    expect(res.status).toBe(200);
    const call = lastCall();
    expect(call.intent.mode).toBe('fast');
    expect(call.intent.mode).not.toBe('full');
    // Degraded to the legacy fast path (boards-only resolver, no registry
    // read, no batch continuation) - not a half-full sweep.
    expect(typeof call.deps.resolveCompanies).toBe('function');
    expect(prismaMocks.company.count).not.toHaveBeenCalled();
    expect(call.outcome.hasMore).toBeUndefined();
  });

  it('mode=bogus still degrades to fast (unchanged unknown-value contract)', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: 'bogus' });
    expect(res.status).toBe(200);
    expect(lastCall().intent.mode).toBe('fast');
  });

  it('mode casing/whitespace is tolerated without changing the resolved mode', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: '  STANDARD  ' });
    expect(res.status).toBe(200);
    expect(lastCall().intent.mode).toBe('standard');
  });
});

describe('T886 - mode vocabulary on /scan (boards-only scope preserved)', () => {
  it('mode=standard forwards standard through the orchestrator, resolver stays boards-only', async () => {
    const res = await request(makeApp())
      .get('/jobs/scan')
      .query({ query: 'engineer', mode: 'standard' });
    expect(res.status).toBe(200);
    const call = lastCall();
    expect(call.intent.mode).toBe('standard');
    // /scan carries no company filter, so its scope stays boards-only in
    // EVERY mode - only the vocabulary widens.
    expect(typeof call.deps.resolveCompanies).toBe('function');
    expect(prismaMocks.company.count).not.toHaveBeenCalled();
    // The Standard source-group envelope applies through the orchestrator.
    expect(
      call.outcome.skipped.some(
        (s: any) => String(s.unitId).startsWith('group:') && String(s.reason).includes('excludes group'),
      ),
    ).toBe(true);
  });

  it('mode=deep forwards deep and keeps the boards-only resolver', async () => {
    const res = await request(makeApp())
      .get('/jobs/scan')
      .query({ query: 'engineer', mode: 'deep' });
    expect(res.status).toBe(200);
    const call = lastCall();
    expect(call.intent.mode).toBe('deep');
    expect(typeof call.deps.resolveCompanies).toBe('function');
    expect(prismaMocks.company.count).not.toHaveBeenCalled();
  });

  it('mode=full degrades to fast on /scan (route-exclusive)', async () => {
    const res = await request(makeApp())
      .get('/jobs/scan')
      .query({ query: 'engineer', mode: 'full' });
    expect(res.status).toBe(200);
    expect(lastCall().intent.mode).toBe('fast');
  });
});

describe('T886 - mode-scoped run snapshot TTL', () => {
  it('/search with mode=deep seeds the run with DEEP_RUN_TTL_MS', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: 'deep', runId: 'run-deep-ttl-1' });
    expect(res.status).toBe(200);
    expect(lastBeginRunArgs()[0]).toBe('run-deep-ttl-1');
    expect(lastBeginRunArgs()[3]).toBe(DEEP_RUN_TTL_MS);
    expect(DEEP_RUN_TTL_MS).toBeGreaterThan(RUN_TTL_MS);
  });

  it('/search with mode=standard keeps the 5-minute RUN_TTL_MS default', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: 'standard', runId: 'run-standard-ttl-1' });
    expect(res.status).toBe(200);
    // `undefined` means beginRun's own default parameter applies - the
    // snapshot TTL is unchanged for non-deep modes.
    expect(lastBeginRunArgs()[3]).toBeUndefined();
    expect(lastBeginRunArgs()[3] ?? RUN_TTL_MS).toBe(RUN_TTL_MS);
  });

  it('/search with no mode keeps the 5-minute RUN_TTL_MS default', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', runId: 'run-legacy-ttl-1' });
    expect(res.status).toBe(200);
    expect(lastBeginRunArgs()[3] ?? RUN_TTL_MS).toBe(RUN_TTL_MS);
  });

  it('/scan applies the same mode-scoped TTL', async () => {
    const deep = await request(makeApp())
      .get('/jobs/scan')
      .query({ query: 'engineer', mode: 'deep', runId: 'run-scan-deep-ttl' });
    expect(deep.status).toBe(200);
    expect(lastBeginRunArgs()[3]).toBe(DEEP_RUN_TTL_MS);

    const fast = await request(makeApp())
      .get('/jobs/scan')
      .query({ query: 'engineer', runId: 'run-scan-fast-ttl' });
    expect(fast.status).toBe(200);
    expect(lastBeginRunArgs()[3] ?? RUN_TTL_MS).toBe(RUN_TTL_MS);
  });

  it('no runId means no snapshot at all (unchanged)', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: 'deep' });
    expect(res.status).toBe(200);
    expect(beginRunCalls).toHaveLength(0);
  });
});

describe('ADR-033 - resolved mode is stored on every /search and /scan run', () => {
  it('records Fast, Standard, and Deep for both discovery routes', async () => {
    const app = makeApp();
    const cases: Array<{
      path: '/jobs/search' | '/jobs/scan';
      queryKey: 'q' | 'query';
      requested: string | undefined;
      runId: string;
      expected: string;
    }> = [];

    for (const path of ['/jobs/search', '/jobs/scan'] as const) {
      for (const requested of [undefined, 'fast', 'standard', 'deep'] as const) {
        cases.push({
          path,
          queryKey: path === '/jobs/search' ? 'q' : 'query',
          requested,
          runId: `${path.split('/').pop()}-${requested ?? 'omitted'}-mode-run`,
          expected: requested ?? 'fast',
        });
      }
    }

    for (const testCase of cases) {
      const query: Record<string, string> = {
        [testCase.queryKey]: 'engineer',
        runId: testCase.runId,
      };
      if (testCase.requested !== undefined) query.mode = testCase.requested;
      const response = await request(app).get(testCase.path).query(query);
      expect(response.status).toBe(200);
      expect(getRun(testCase.runId, 'user-1')?.mode).toBe(testCase.expected);
    }
  });

  it('records the resolved Fast fallback when a route-exclusive Full value is supplied', async () => {
    const search = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', mode: 'full', runId: 'run-search-full-degraded-mode' });
    expect(search.status).toBe(200);
    expect(getRun('run-search-full-degraded-mode', 'user-1')?.mode).toBe('fast');

    const scan = await request(makeApp())
      .get('/jobs/scan')
      .query({ query: 'engineer', mode: 'full', runId: 'run-scan-full-degraded-mode' });
    expect(scan.status).toBe(200);
    expect(getRun('run-scan-full-degraded-mode', 'user-1')?.mode).toBe('fast');
  });
});

describe('T886 - a deep /search is still cancellable through the existing endpoint', () => {
  const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('POST /jobs/runs/:runId/cancel stops a live deep run and keeps the partial set', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow({ id: 'board-fast', name: 'Fast Board', feedUrl: 'https://fast-board.example/api' }),
      boardRow({ id: 'board-slow', name: 'Slow Board', feedUrl: 'https://slow-board.example/api' }),
    ]);
    runSourceMock.mockImplementation(async (config: any) => {
      if (typeof config?.feedUrl === 'string' && config.feedUrl.includes('fast-board')) {
        await delay(40);
        return [{ ...JSON_ROWS[0], externalId: 'deep-fast-1' }];
      }
      if (typeof config?.feedUrl === 'string' && config.feedUrl.includes('slow-board')) {
        await delay(600);
        return [{ ...JSON_ROWS[0], externalId: 'deep-slow-1' }];
      }
      return [];
    });

    const app = makeApp();
    // Sent immediately (a bare supertest Test only sends once awaited, which
    // would let the cancel land before the run exists).
    const searchPromise = (async () =>
      request(app).get('/jobs/search').query({
        q: 'engineer',
        mode: 'deep',
        runId: 'run-deep-cancel-1',
      }))();
    await delay(150);

    const cancel = await request(app).post('/jobs/runs/run-deep-cancel-1/cancel');
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled).toBe(true);

    const search = await searchPromise;
    expect(search.status).toBe(200);
    expect(search.body.length).toBeGreaterThan(0);
    for (const item of search.body) {
      expect(item).toHaveProperty('cancelled', true);
      expect(item).toHaveProperty('partial', true);
    }
    // Cancelled, never failed - and the deep TTL kept the snapshot alive.
    const snap = await request(app).get('/jobs/runs/run-deep-cancel-1');
    expect(snap.status).toBe(200);
    expect(snap.body.cancelled).toBe(true);
    for (const b of snap.body.boards) expect(b.status).not.toBe('failed');
  });
});

describe('T886 - intentForLegacySearch fallback literal covers the four values', () => {
  it('standard and full ride through the adversarial fallback, unknown still fast', () => {
    const adversarial = 'x'.repeat(150);
    const build = (mode?: string) =>
      intentForLegacySearch({
        q: adversarial,
        sources: undefined,
        locations: [],
        company: undefined,
        limit: 30,
        postedWithin: undefined,
        ...(mode !== undefined ? { mode } : {}),
      });
    expect(build('standard').mode).toBe('standard');
    expect(build('deep').mode).toBe('deep');
    expect(build('fast').mode).toBe('fast');
    // `full` is route-exclusive, but the helper's widened literal must still
    // carry it verbatim rather than silently rewriting a caller's value.
    expect(build('full').mode).toBe('full');
    expect(build('nonsense').mode).toBe('fast');
    expect(build().mode).toBe('fast');
  });
});
