// Full-scan route contract tests (T885). The orchestrator, keyset seam, and
// snapshot registry remain real; only external source/Prisma calls are faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  prismaMocks,
  runSourceMock,
  seedMock,
  healthMocks,
  registryBatchMock,
  orchestratorMock,
  readPageMock,
  writeVerificationMock,
} = vi.hoisted(() => ({
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    companyCareerPage: { findUnique: vi.fn(), update: vi.fn() },
  },
  runSourceMock: vi.fn(),
  seedMock: vi.fn(),
  healthMocks: { recordSourceSuccess: vi.fn(), recordSourceFailure: vi.fn() },
  registryBatchMock: vi.fn(),
  orchestratorMock: vi.fn(),
  readPageMock: vi.fn(),
  writeVerificationMock: vi.fn(),
}));

// Hoisted mocks shared by the SEARCH_ATTRIBUTION=on describe block. The
// route re-imports under that case, so the mock factories are also re-
// installed via vi.doMock, but the underlying vi.fn() instances must be
// hoisted to module scope (the vitest 4.1 rule: vi.hoisted() is only
// valid at the top level of the module). The describe block uses these
// named handles directly so the imports stay grep-able.
const HOISTED_ATTR_ON_MOCKS = vi.hoisted(() => ({
  prisma: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
    companyCareerPage: { findUnique: vi.fn(), update: vi.fn() },
  },
  runSource: vi.fn(),
  seed: vi.fn(),
  health: { recordSourceSuccess: vi.fn(), recordSourceFailure: vi.fn() },
  registryBatch: vi.fn(),
  orchestrator: vi.fn(),
  readPage: vi.fn(),
  writeVerification: vi.fn(),
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
  const original = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...original, runSource: (...args: any[]) => runSourceMock(...args) };
});
vi.mock('../jobSources/sourceHealth.js', () => ({
  recordSourceSuccess: (...args: any[]) => healthMocks.recordSourceSuccess(...args),
  recordSourceFailure: (...args: any[]) => healthMocks.recordSourceFailure(...args),
}));
vi.mock('../discovery/registrySweep.js', () => ({
  resolveRegistryPageBatch: (...args: any[]) => registryBatchMock(...args),
}));
vi.mock('../discovery/orchestrator.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../discovery/orchestrator.js')>();
  return { ...original, runSearch: (...args: any[]) => orchestratorMock(...args) };
});
// T904: mock the prisma-backed verifyStore so we can drive the write-back
// path with a fake store. Without this mock, real Prisma is required for
// these tests.
vi.mock('../registry/verifyStore.js', () => ({
  readPageForUpdate: (...args: any[]) => readPageMock(...args),
  writePageVerification: (...args: any[]) => writeVerificationMock(...args),
}));

import jobsRouter from './jobs.js';
import { getRun, resetRunsForTests } from '../jobSources/discoveryRuns.js';
import { resetOrchestratorForTests } from '../discovery/orchestrator.js';
import { FULL_BATCH_PAGES, FULL_BATCH_BUDGET, FULL_RUN_TTL_MS } from '../discovery/budgets.js';
import { env } from '../config/env.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

function boardRow() {
  return {
    id: 'board-1',
    name: 'Board One',
    type: 'rss',
    boardId: null,
    feedUrl: 'https://example.com/feed.xml',
    searchQuery: null,
    searchSite: null,
    scraperProvider: null,
    scraperLocation: null,
    scraperResults: null,
    scraperUseProxy: false,
    aggregatorProvider: null,
    aggregatorLocation: null,
  };
}

function page(id: string): { id: string; companyName: string; url: string; provider: string; boardToken: string } {
  return {
    id,
    companyName: `Company ${id}`,
    url: `https://careers.example.test/${id}`,
    provider: 'greenhouse',
    boardToken: `token-${id}`,
  };
}

function pageJob(id: string) {
  return {
    externalId: `job-${id}`,
    source: 'greenhouse',
    sourceUrl: `https://careers.example.test/${id}`,
    title: `Engineer ${id}`,
    company: `Company ${id}`,
    location: 'Remote',
    description: 'Build reliable systems.',
    applyUrl: `https://careers.example.test/${id}`,
    postedAt: null,
  };
}

/** N distinct postings on one page (distinct URL, external id and content). */
function pageJobs(pageId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    ...pageJob(`${pageId}-${index}`),
    // A per-page posting count above the legacy per-source caps is what makes
    // this route's batch survive dedupe as `count` rows, not one merged row.
    title: `Engineer ${pageId} role ${index}`,
  }));
}

function storedListing(create: any) {
  return {
    id: `stored-${create.source}-${create.externalId}`,
    source: create.source,
    title: create.title,
    company: create.company,
    location: create.location,
    description: create.description,
    applyUrl: create.applyUrl,
    sourceUrl: create.sourceUrl,
    postedAt: create.postedAt ?? null,
    isActive: true,
    postedAtSource: null,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { runSearch } = await vi.importActual<typeof import('../discovery/orchestrator.js')>(
    '../discovery/orchestrator.js',
  );
  orchestratorMock.mockImplementation(
    (intent: any, opts: any, deps: any) => runSearch(intent, opts, deps),
  );
  resetRunsForTests();
  resetOrchestratorForTests();
  prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
  prismaMocks.jobListing.findUnique.mockResolvedValue(null);
  prismaMocks.jobListing.upsert.mockImplementation(async ({ create }: any) => storedListing(create));
  prismaMocks.companyCareerPage.findUnique.mockResolvedValue(null);
  prismaMocks.companyCareerPage.update.mockResolvedValue(undefined);
  readPageMock.mockResolvedValue(null);
  writeVerificationMock.mockResolvedValue(undefined);
  seedMock.mockResolvedValue(undefined);
  healthMocks.recordSourceSuccess.mockResolvedValue(undefined);
  healthMocks.recordSourceFailure.mockResolvedValue(undefined);
  runSourceMock.mockImplementation(async (config: any) => {
    if (config.type === 'rss') return [];
    if (config.type === 'greenhouse') {
      const id = String(config.board).replace('token-', '');
      return [pageJob(id)];
    }
    return [];
  });
  registryBatchMock.mockImplementation(async (after: string | null) => {
    if (after === null) {
      return { pages: [page('p1'), page('p2')], total: 3, hasMore: true, nextCursor: 'p2' };
    }
    return { pages: [page('p3')], total: 3, hasMore: false, nextCursor: null };
  });
});

describe('GET /jobs/full-scan', () => {
  it('mints a runId and forces Full even when the caller supplies another mode', async () => {
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ q: 'engineer', mode: 'fast' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.runId).toMatch(/^full-[0-9a-f-]{36}$/);
    expect(response.body.total).toBe(3);
    // A real Full route snapshot must carry its resolved mode even when the
    // caller supplied a conflicting value.
    expect(getRun(response.body.runId, 'user-1')?.mode).toBe('full');
  });

  it('does not include a timing key when SEARCH_ATTRIBUTION is off (default)', async () => {
    // env.SEARCH_ATTRIBUTION defaults to 'off' in env.ts (z.default('off')).
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-attr-off', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('timing');
    // Spot-check: the response keys are byte-stable against the pre-wave
    // baseline (every key except `timing` is still present, plus the
    // T904 additive `verification` key which is present whenever
    // SEARCH_FULL_VERIFY_WRITEBACK is on - the default).
    //
    // T908 (marker shape change): the additive `politeness` key is now
    // present in the DEFAULT `'on'` mode too, carrying the bounded
    // `{ mode, signals, blocks, deferred, wiringOk }` object. It was the
    // string `'off'` and present only with the knob off (T907). Every
    // pre-existing key keeps its name and type - this list only grows.
    expect(Object.keys(response.body).sort()).toEqual(
      [
        'cancelled',
        'failed',
        'failedCount',
        'hasMore',
        'nextCursor',
        'persisted',
        'politeness',
        'processed',
        'results',
        'runId',
        'skipped',
        'skippedCount',
        'total',
        'truncated',
        'truncatedCount',
        'verification',
      ].sort(),
    );
    expect(response.body.verification).toMatchObject({ written: expect.any(Number), failed: expect.any(Number) });
    // A healthy batch (no 429/503 observed) reports the marker at rest.
    expect(response.body.politeness).toEqual({
      mode: 'on',
      signals: 0,
      blocks: 0,
      deferred: 0,
      wiringOk: true,
    });
  });

  it('advances a fresh run through the keyset cursor and accumulates aggregate progress', async () => {
    const app = makeApp();
    const first = await request(app)
      .get('/jobs/full-scan')
      .query({ runId: 'full-run-1', q: 'engineer' })
      .set('x-test-user', 'user-1');

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      runId: 'full-run-1',
      hasMore: true,
      nextCursor: 'p2',
      processed: 2,
      total: 3,
      persisted: 2,
      cancelled: false,
    });
    expect(first.body.results).toHaveLength(2);
    expect(registryBatchMock).toHaveBeenNthCalledWith(1, null, FULL_BATCH_PAGES);

    const firstSnapshot = getRun('full-run-1', 'user-1');
    expect(firstSnapshot?.finishedAt).toBeUndefined();
    expect(firstSnapshot?.cursor).toBe('p2');
    expect(firstSnapshot?.registryProcessed).toBe(2);
    expect(firstSnapshot?.registryTotal).toBe(3);
    // Page units are aggregate progress only; they are not appended to boards.
    expect(firstSnapshot?.boards).toHaveLength(1);
    expect(firstSnapshot?.boards.every((board) => !board.boardId.startsWith('page:'))).toBe(true);

    const second = await request(app)
      .get('/jobs/full-scan')
      .query({ runId: 'full-run-1', after: 'p2', q: 'engineer' })
      .set('x-test-user', 'user-1');

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      hasMore: false,
      nextCursor: null,
      processed: 3,
      total: 3,
      persisted: 1,
    });
    expect(registryBatchMock).toHaveBeenNthCalledWith(2, 'p2', FULL_BATCH_PAGES);
    const finalSnapshot = getRun('full-run-1', 'user-1');
    expect(finalSnapshot?.finishedAt).toBeTruthy();
    expect(finalSnapshot?.registryProcessed).toBe(3);
    expect(finalSnapshot?.totalListings).toBe(3);
    expect(finalSnapshot?.boards).toHaveLength(1);
  });

  it('persists every matched row of a batch and never applies the caller limit', async () => {
    // Live defect (T892 find #2, run-live-full-2): the handler used to persist
    // `locationFiltered.slice(0, limit)`, where `limit` is the caller's
    // response page size (default 30) and NOT a per-batch row budget. The batch
    // had already keyset-advanced past these pages, so every matched row past
    // the slice was never stored AND never revisited in the run - every live
    // batch reported exactly persisted=30. Full is a sweep, so a batch must
    // persist all of its matched rows.
    const perPage = 25;
    const pages = [page('p1'), page('p2'), page('p3')];
    registryBatchMock.mockResolvedValue({
      pages,
      total: pages.length,
      hasMore: false,
      nextCursor: null,
    });
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type !== 'greenhouse') return [];
      const id = String(config.board).replace('token-', '');
      return pageJobs(id, perPage);
    });
    // 75 matches: above the schema default of 30 and above the explicit 5.
    const matched = pages.length * perPage;
    const app = makeApp();

    // (1) The live request shape: no `limit` at all, so the default 30 applied.
    const defaulted = await request(app)
      .get('/jobs/full-scan')
      .query({ runId: 'full-all-rows-default-limit', q: 'engineer' })
      .set('x-test-user', 'user-1');

    expect(defaulted.status).toBe(200);
    expect(defaulted.body.persisted).toBe(matched);
    expect(defaulted.body.results).toHaveLength(matched);
    // Cursor/progress accounting is untouched by the persistence rule.
    expect(defaulted.body).toMatchObject({
      hasMore: false,
      nextCursor: null,
      processed: 3,
      total: 3,
      cancelled: false,
    });
    expect(prismaMocks.jobListing.upsert).toHaveBeenCalledTimes(matched);
    expect(getRun('full-all-rows-default-limit', 'user-1')).toMatchObject({
      cursor: null,
      registryProcessed: 3,
      registryTotal: 3,
      totalListings: matched,
    });

    // (2) An explicit small limit must not truncate a sweep either.
    prismaMocks.jobListing.upsert.mockClear();
    const limited = await request(app)
      .get('/jobs/full-scan')
      .query({ runId: 'full-all-rows-explicit-limit', q: 'engineer', limit: 5 })
      .set('x-test-user', 'user-1');

    expect(limited.status).toBe(200);
    expect(limited.body.persisted).toBe(matched);
    expect(limited.body.results).toHaveLength(matched);
    expect(prismaMocks.jobListing.upsert).toHaveBeenCalledTimes(matched);
    // Every returned row is a distinct persisted listing, so the UI's
    // totalListings accumulation and mergeResultRows id-dedupe report honest,
    // duplicate-free coverage.
    const ids = limited.body.results.map((row: any) => row.id);
    expect(new Set(ids).size).toBe(matched);
  });

  it('retries a maxUnits-truncated Full page without repeats across batches', async () => {
    // T910 (D7): FULL_BATCH_BUDGET.maxUnits is derived as
    // FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM (= 200 + 120 = 320).
    // The fixture uses FULL_BATCH_BUDGET.maxUnits - FULL_BATCH_PAGES + 1
    // (= 121) tier-1 personal boards so the total candidate count is
    // maxUnits + 1 (= 321) and exactly one registry page (the last) is
    // dropped. This pins both the new cap and the rewind seam: the
    // continuation cursor must rewind to the page immediately before the
    // dropped page (p198), the dropped page appears in `skipped[0]` with
    // reason `truncated: exceeds maxUnits=320`, and the second batch
    // finishes the sweep with no repeats.
    const boardCount = FULL_BATCH_BUDGET.maxUnits - FULL_BATCH_PAGES + 1; // 121
    const pages = Array.from({ length: FULL_BATCH_PAGES }, (_, index) => page(`p${index}`));
    prismaMocks.jobBoard.findMany.mockResolvedValue(
      Array.from({ length: boardCount }, (_, index) => ({
        ...boardRow(),
        id: `personal-board-${index}`,
        name: `Personal Board ${index}`,
        type: 'greenhouse',
        boardId: `personal-${index}`,
        feedUrl: null,
      })),
    );
    registryBatchMock.mockImplementation(async (after: string | null) => {
      const start = after === null ? 0 : Number.parseInt(after.slice(1), 10) + 1;
      const selected = pages.slice(start, start + FULL_BATCH_PAGES);
      const hasMore = start + selected.length < pages.length;
      return {
        pages: selected,
        total: pages.length,
        hasMore,
        nextCursor: hasMore ? selected[selected.length - 1]?.id ?? null : null,
      };
    });

    const executedPageIds: string[] = [];
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type === 'greenhouse' && String(config.board).startsWith('token-')) {
        executedPageIds.push(String(config.board).replace('token-', ''));
      }
      return [];
    });

    const app = makeApp();
    const first = await request(app)
      .get('/jobs/full-scan')
      .query({ runId: 'full-max-units-run', q: 'engineer' })
      .set('x-test-user', 'user-1');

    // The truncation drop: 121 boards + 200 pages = 321 candidates;
    // maxUnits = 320 -> page index 199 (the last page) is dropped, the
    // remaining 99 succeed. The rewound cursor is p198 (the predecessor).
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      runId: 'full-max-units-run',
      hasMore: true,
      nextCursor: 'p198',
      processed: 199,
      total: 200,
      truncated: true,
      truncatedCount: 1,
    });
    expect(getRun('full-max-units-run', 'user-1')).toMatchObject({
      cursor: 'p198',
      registryProcessed: 199,
      registryTotal: 200,
    });
    expect(getRun('full-max-units-run', 'user-1')?.finishedAt).toBeUndefined();
    // The bounded response window keeps the dropped page inside the
    // reported window when prioritized first.
    expect(first.body.skipped[0]).toMatchObject({
      unitId: 'page:199',
      reason: 'truncated: exceeds maxUnits=320',
    });
    // Other skip reasons still fill the bounded window below the
    // truncation reason; skippedCount reflects the honest total and the
    // pre-T910 `> 20` bound still holds under the new fixture, so the
    // assertion is RESTORED, not re-derived away.
    // T910: the measured total is 202, re-derived from this fixture as
    //   1   x `truncated: exceeds maxUnits=320` (page:199, the cap drop)
    // + 1   x `group:browser` / `group disabled: browser` (the intent does
    //         not enable the browser group, so orchestrator.ts:761 reports it
    //         once)
    // + 200 x `cheaper tier succeeded` (one browser follow-up skip per
    //         FETCHED page - `plan.pageUnits` is filled at fetch time, so the
    //         truncated page:199 contributes its follow-up skip too)
    // = 202 > 20, so `skippedCount > 20` holds with margin; `skipped.length`
    // stays inside the bounded 20-item response window.
    expect(first.body.skipped.length).toBeLessThanOrEqual(20);
    expect(first.body.skippedCount).toBeGreaterThan(20);

    const second = await request(app)
      .get('/jobs/full-scan')
      .query({ runId: 'full-max-units-run', after: 'p198', q: 'engineer' })
      .set('x-test-user', 'user-1');

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      hasMore: false,
      nextCursor: null,
      processed: 200,
      total: 200,
      persisted: 0,
    });
    expect(registryBatchMock).toHaveBeenNthCalledWith(1, null, FULL_BATCH_PAGES);
    expect(registryBatchMock).toHaveBeenNthCalledWith(2, 'p198', FULL_BATCH_PAGES);
    expect(executedPageIds).toHaveLength(200);
    expect(new Set(executedPageIds)).toEqual(
      new Set(pages.map((entry) => entry.boardToken.replace('token-', ''))),
    );
    expect(executedPageIds.filter((id, index) => executedPageIds.indexOf(id) !== index)).toEqual([]);
    expect(getRun('full-max-units-run', 'user-1')).toMatchObject({
      cursor: null,
      registryProcessed: 200,
      registryTotal: 200,
    });
    expect(getRun('full-max-units-run', 'user-1')?.finishedAt).toBeTruthy();
  });

  it('persists the orchestrator wall-clock rewind and retries only omitted Full pages', async () => {
    const pages = Array.from({ length: 10 }, (_, index) => page(`p${index + 1}`));
    registryBatchMock.mockImplementation(async (after: string | null) => {
      const start = after === null ? 0 : pages.findIndex((entry) => entry.id === after) + 1;
      const selected = pages.slice(start, start + FULL_BATCH_PAGES);
      return {
        pages: selected,
        total: pages.length,
        hasMore: start + selected.length < pages.length,
        nextCursor: start + selected.length < pages.length
          ? selected[selected.length - 1]?.id ?? null
          : null,
      };
    });

    const executedPageIds: string[] = [];
    let secondBatch = false;
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type === 'rss') return [];
      if (!secondBatch) return [];
      const id = String(config.board).replace('token-', '');
      executedPageIds.push(id);
      return [pageJob(id)];
    });

    const app = makeApp();
    // This is the route contract for the orchestrator's repaired budget
    // outcome: the handler must persist the returned rewind rather than the
    // reader's stale last-fetched id, and the next keyset read must retry only
    // the omitted suffix. The real wall-clock stop is pinned independently in
    // orchestrator.test.ts with the injected small budget.
    registryBatchMock.mockImplementation(async (after: string | null) => {
      const start = after === null ? 0 : pages.findIndex((entry) => entry.id === after) + 1;
      const selected = pages.slice(start, start + FULL_BATCH_PAGES);
      return {
        pages: selected,
        total: pages.length,
        hasMore: false,
        nextCursor: null,
      };
    });
    // This test file exercises persistence, while the adjacent orchestrator
    // regression proves the wall-clock outcome that supplies these values.
    const persistedRewind = {
      jobs: Array.from({ length: 8 }, (_, index) => pageJob(`p${index + 1}`)),
      cancelled: false,
      truncated: true,
      skipped: [
        { unitId: 'page:8', reason: 'budget exhausted' },
        { unitId: 'page:9', reason: 'budget exhausted' },
      ],
      units: Array.from({ length: 8 }, (_, index) => ({
        unitId: `page:${index}`,
        kind: 'registry-page' as const,
        providerType: 'greenhouse',
        tier: 1,
        group: 'ats',
        status: 'ok' as const,
        resultCount: 1,
        latencyMs: 1,
      })),
      hasMore: true,
      nextCursor: 'p8',
      registry: { processed: 10, total: 10 },
    };
    orchestratorMock.mockResolvedValueOnce(persistedRewind as any);
    const first = await request(app)
      .get('/jobs/full-scan')
      .query({ runId: 'full-wall-clock-run', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(first.status).toBe(200);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      hasMore: true,
      nextCursor: 'p8',
      processed: 8,
      total: 10,
      truncated: true,
    });
    expect(first.body.skipped).toEqual(expect.arrayContaining([
      { unitId: 'page:8', reason: 'budget exhausted' },
      { unitId: 'page:9', reason: 'budget exhausted' },
    ]));
    expect(getRun('full-wall-clock-run', 'user-1')).toMatchObject({
      cursor: 'p8',
      registryProcessed: 8,
      registryTotal: 10,
    });
    expect(getRun('full-wall-clock-run', 'user-1')?.finishedAt).toBeUndefined();

    // The default mock implementation delegates to the real orchestrator, so
    // this second request executes only the suffix selected by persisted p8.
    secondBatch = true;
    const { runSearch: actualRunSearch } = await vi.importActual<
      typeof import('../discovery/orchestrator.js')
    >('../discovery/orchestrator.js');
    orchestratorMock.mockImplementation(
      (intent: any, opts: any, deps: any) => actualRunSearch(intent, opts, deps),
    );
    const second = await request(app)
      .get('/jobs/full-scan')
      .query({ runId: 'full-wall-clock-run', after: 'p8', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      hasMore: false,
      nextCursor: null,
      processed: 10,
      total: 10,
    });
    expect(registryBatchMock).toHaveBeenNthCalledWith(1, 'p8', FULL_BATCH_PAGES);
    expect(executedPageIds).toEqual(['p9', 'p10']);
    expect(new Set(executedPageIds)).toEqual(new Set(['p9', 'p10']));
    expect(getRun('full-wall-clock-run', 'user-1')).toMatchObject({
      cursor: null,
      registryProcessed: 10,
      registryTotal: 10,
    });
    expect(getRun('full-wall-clock-run', 'user-1')?.finishedAt).toBeTruthy();
  });

  it('returns bounded registry-page failure reasons, including timeout and budget exhaustion', async () => {
    registryBatchMock.mockResolvedValue({
      pages: [page('failed-timeout'), page('failed-budget'), page('ok')],
      total: 3,
      hasMore: false,
      nextCursor: null,
    });
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type !== 'greenhouse') return [];
      const id = String(config.board).replace('token-', '');
      if (id === 'failed-timeout') throw new Error('timeout after 20000ms');
      if (id === 'failed-budget') throw new Error('budget_exhausted');
      return [];
    });

    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-failure-report-run', q: 'engineer' })
      .set('x-test-user', 'user-1');

    expect(response.status).toBe(200);
    // A failed page is still an attempted/accounted page unit.
    expect(response.body.processed).toBe(3);
    expect(response.body.failedCount).toBe(2);
    expect(response.body.failed).toHaveLength(2);
    expect(response.body.failed).toEqual(
      expect.arrayContaining([
        { unitId: 'page:0', reason: 'timeout after 20000ms' },
        { unitId: 'page:1', reason: 'budget_exhausted' },
      ]),
    );
    expect(response.body.truncated).toBe(false);
    expect(response.body.truncatedCount).toBe(0);
  });

  it('refreshes the full-run TTL on every batch', async () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      const first = await request(app)
        .get('/jobs/full-scan')
        .query({ runId: 'full-ttl-run', q: 'engineer' })
        .set('x-test-user', 'user-1');
      expect(first.status).toBe(200);

      // Arrive just before the original 30-minute expiry, then let more than
      // that original window elapse. The second request's touchRun must keep
      // the snapshot readable even though the first batch is long finished.
      vi.setSystemTime(Date.now() + FULL_RUN_TTL_MS - 1_000);
      const second = await request(app)
        .get('/jobs/full-scan')
        .query({ runId: 'full-ttl-run', after: 'p2', q: 'engineer' })
        .set('x-test-user', 'user-1');
      expect(second.status).toBe(200);
      vi.setSystemTime(Date.now() + 2_000);

      expect(getRun('full-ttl-run', 'user-1')).toBeDefined();
      expect(FULL_RUN_TTL_MS).toBe(30 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps partial rows and marks the run cancelled without rolling them back', async () => {
    const app = makeApp();
    let greenhouseCalls = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    registryBatchMock.mockImplementation(async (after: string | null) => {
      if (after === null) {
        return { pages: [page('p1'), page('p2')], total: 3, hasMore: true, nextCursor: 'p2' };
      }
      return { pages: [page('p3')], total: 3, hasMore: false, nextCursor: null };
    });
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type === 'rss') return [];
      greenhouseCalls += 1;
      markStarted();
      if (greenhouseCalls === 1) return [pageJob('p1')];
      await held;
      return [pageJob('p2')];
    });

    const pending = request(app)
      .get('/jobs/full-scan')
      .query({ runId: 'full-cancel-run', q: 'engineer' })
      .set('x-test-user', 'user-1')
      .then((response) => response);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancelled = await request(app)
      .post('/jobs/runs/full-cancel-run/cancel')
      .set('x-test-user', 'user-1');
    expect(cancelled.status).toBe(200);
    release();

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body.cancelled).toBe(true);
    expect(response.body.hasMore).toBe(false);
    expect(response.body.persisted).toBeGreaterThanOrEqual(1);
    expect(response.body.results.length).toBeGreaterThanOrEqual(1);
    expect(prismaMocks.jobListing.upsert).toHaveBeenCalled();
    const snapshot = getRun('full-cancel-run', 'user-1');
    expect(snapshot?.cancelled).toBe(true);
    expect(snapshot?.finishedAt).toBeTruthy();
  });

  it('returns 404 for a continuation cursor without a live owned run', async () => {
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-missing-run', after: 'p2', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Discovery run not found or expired' });
  });

  it('requires authentication', async () => {
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ q: 'engineer' });
    expect(response.status).toBe(401);
  });

  it('does not write JobSourceHealth for registry-page units', async () => {
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-health-run', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(healthMocks.recordSourceSuccess).toHaveBeenCalledTimes(1);
    expect(healthMocks.recordSourceSuccess.mock.calls[0][0]).toBe('board-1');
  });
});

// ---------------------------------------------------------------------------
// T906: Full batch budget is resolved PER REQUEST through `budgetFor('full')`.
// The self-hoster env knob `SEARCH_FULL_MAX_CONCURRENCY` was previously dead
// (the route passed the frozen `FULL_BATCH_BUDGET`); now the route passes
// `budgetFor('full')`, so the env value (clamped to
// `[1, FULL_CONCURRENCY_CEILING=64]`) flows through to `runSearch`'s
// `deps.budget`. `SEARCH_FULL_MAX_CONCURRENCY` is read at runtime inside
// `budgetFor`, so no `vi.resetModules()` is needed - we set the env, drive
// a request, and inspect the `orchestratorMock` capture seam (third arg =
// `deps`, with `deps.budget.maxConcurrent`).
// ---------------------------------------------------------------------------

describe('T906: Full route honours SEARCH_FULL_MAX_CONCURRENCY per request', () => {
  const FULL_OVERRIDE_VARS = [
    'SEARCH_FULL_MAX_CONCURRENCY',
    'SEARCH_FULL_BUDGET_MS',
  ] as const;

  afterEach(() => {
    for (const name of FULL_OVERRIDE_VARS) delete process.env[name];
    vi.clearAllMocks();
  });

  it('default (no env) passes the frozen FULL_BATCH_BUDGET pool width (32) to runSearch', async () => {
    // T906: the route no longer passes the frozen FULL_BATCH_BUDGET constant.
    // It calls budgetFor('full'), which with no env set returns the frozen
    // 32-wide default. The capture seam is the third arg of orchestratorMock.
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-pool-default', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    // orchestratorMock is invoked exactly once for this one-shot request.
    expect(orchestratorMock).toHaveBeenCalledTimes(1);
    const deps = orchestratorMock.mock.calls[0][2] as { budget: { maxConcurrent: number } };
    expect(deps.budget.maxConcurrent).toBe(32);
  });

  it('SEARCH_FULL_MAX_CONCURRENCY=24 -> runSearch receives maxConcurrent=24', async () => {
    // T906 acceptance: with the env knob set, the route honours it. 24 is
    // inside the [1, 64] clamp range so it passes through verbatim.
    process.env.SEARCH_FULL_MAX_CONCURRENCY = '24';
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-pool-24', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(orchestratorMock).toHaveBeenCalledTimes(1);
    const deps = orchestratorMock.mock.calls[0][2] as { budget: { maxConcurrent: number } };
    expect(deps.budget.maxConcurrent).toBe(24);
  });

  it('SEARCH_FULL_MAX_CONCURRENCY=9999 clamps to FULL_CONCURRENCY_CEILING (64)', async () => {
    // The clamp is enforced inside budgetFor('full'), not in the route - so
    // the route simply passes through whatever budgetFor returns.
    process.env.SEARCH_FULL_MAX_CONCURRENCY = '9999';
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-pool-clamp', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(orchestratorMock).toHaveBeenCalledTimes(1);
    const deps = orchestratorMock.mock.calls[0][2] as { budget: { maxConcurrent: number } };
    expect(deps.budget.maxConcurrent).toBe(64);
  });

  it('SEARCH_FULL_MAX_CONCURRENCY=0 / abc falls back to the frozen default (32)', async () => {
    // An invalid value falls back to the frozen FULL_BATCH_BUDGET.maxConcurrent,
    // NOT to the clamp floor of 1. envPositiveInt returns the fallback when
    // the value is missing / non-numeric / < 1.
    for (const bad of ['0', 'abc']) {
      process.env.SEARCH_FULL_MAX_CONCURRENCY = bad;
      const response = await request(makeApp())
        .get('/jobs/full-scan')
        .query({ runId: `full-pool-bad-${bad}`, q: 'engineer' })
        .set('x-test-user', 'user-1');
      expect(response.status).toBe(200);
      const deps = orchestratorMock.mock.calls.at(-1)![2] as {
        budget: { maxConcurrent: number };
      };
      expect(deps.budget.maxConcurrent).toBe(32);
    }
    // Two requests in this test, one per bad value.
    expect(orchestratorMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Wave 15 (T900) attribution: SEARCH_ATTRIBUTION=on -> response has `timing`
//
// config/env.ts parses process.env at import time, so the on-case is a
// separate describe block that re-imports a fresh module copy with
// SEARCH_ATTRIBUTION=on set.
// ---------------------------------------------------------------------------

describe('GET /jobs/full-scan with SEARCH_ATTRIBUTION=on', () => {
  const origAttr = process.env.SEARCH_ATTRIBUTION;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let attrOnApp: any;
  const attrOnPrisma = HOISTED_ATTR_ON_MOCKS.prisma;
  const attrOnRegistryBatch = HOISTED_ATTR_ON_MOCKS.registryBatch;
  const attrOnRunSource = HOISTED_ATTR_ON_MOCKS.runSource;
  const attrOnSeed = HOISTED_ATTR_ON_MOCKS.seed;
  const attrOnHealth = HOISTED_ATTR_ON_MOCKS.health;
  const attrOnOrchestrator = HOISTED_ATTR_ON_MOCKS.orchestrator;
  const attrOnReadPage = HOISTED_ATTR_ON_MOCKS.readPage;
  const attrOnWriteVerification = HOISTED_ATTR_ON_MOCKS.writeVerification;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SEARCH_ATTRIBUTION = 'on';
    // The hoisted mock factory at module scope (above) defines vi.fn()
    // instances shared with the freshly-imported route module via
    // vi.doMock factories below. We re-mock the seams here so the
    // route picks them up; defaults are wired the same way the off-case
    // test wired them.
    vi.doMock('../middleware/auth.js', () => ({
      requireAuth: (req: any, res: any, next: any) => {
        const id = req.headers['x-test-user'];
        if (!id || typeof id !== 'string') return res.status(401).json({ error: 'Unauthorized' });
        req.user = { id, email: 'test@example.com', isAdmin: false };
        next();
      },
    }));
    vi.doMock('../lib/prisma.js', () => ({ default: attrOnPrisma }));
    vi.doMock('../jobSources/defaultBoards.js', () => ({ seedDefaultBoardsForUser: (...a: any[]) => attrOnSeed(...a) }));
    vi.doMock('../jobSources/index.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../jobSources/index.js')>();
      return { ...original, runSource: (...a: any[]) => attrOnRunSource(...a) };
    });
    vi.doMock('../jobSources/sourceHealth.js', () => ({
      recordSourceSuccess: (...a: any[]) => attrOnHealth.recordSourceSuccess(...a),
      recordSourceFailure: (...a: any[]) => attrOnHealth.recordSourceFailure(...a),
    }));
    vi.doMock('../discovery/registrySweep.js', () => ({ resolveRegistryPageBatch: (...a: any[]) => attrOnRegistryBatch(...a) }));
    vi.doMock('../discovery/orchestrator.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../discovery/orchestrator.js')>();
      return { ...original, runSearch: (...a: any[]) => attrOnOrchestrator(...a) };
    });
    vi.doMock('../registry/verifyStore.js', () => ({
      readPageForUpdate: (...a: any[]) => attrOnReadPage(...a),
      writePageVerification: (...a: any[]) => attrOnWriteVerification(...a),
    }));
    // Wire defaults (mirrors the off-case beforeEach in this file).
    attrOnPrisma.jobBoard.findMany.mockResolvedValue([{
      id: 'board-1', name: 'Board One', type: 'rss',
      boardId: null, feedUrl: 'https://example.com/feed.xml',
      searchQuery: null, searchSite: null, scraperProvider: null,
      scraperLocation: null, scraperResults: null, scraperUseProxy: false,
      aggregatorProvider: null, aggregatorLocation: null,
    }]);
    attrOnPrisma.jobListing.findUnique.mockResolvedValue(null);
    attrOnPrisma.jobListing.upsert.mockImplementation(async ({ create }: any) => ({
      id: `stored-${create.source}-${create.externalId}`,
      source: create.source,
      title: create.title,
      company: create.company,
      location: create.location,
      description: create.description,
      applyUrl: create.applyUrl,
      sourceUrl: create.sourceUrl,
      postedAt: create.postedAt ?? null,
      isActive: true,
      postedAtSource: null,
    }));
    attrOnPrisma.companyCareerPage.findUnique.mockResolvedValue(null);
    attrOnPrisma.companyCareerPage.update.mockResolvedValue(undefined);
    attrOnReadPage.mockResolvedValue(null);
    attrOnWriteVerification.mockResolvedValue(undefined);
    attrOnSeed.mockResolvedValue(undefined);
    attrOnHealth.recordSourceSuccess.mockResolvedValue(undefined);
    attrOnHealth.recordSourceFailure.mockResolvedValue(undefined);
    attrOnRunSource.mockImplementation(async (config: any) => {
      if (config.type === 'rss') return [];
      if (config.type === 'greenhouse') {
        const id = String(config.board).replace('token-', '');
        return [{
          externalId: `job-${id}`, source: 'greenhouse',
          sourceUrl: `https://careers.example.test/${id}`,
          title: `Engineer ${id}`, company: `Company ${id}`,
          location: 'Remote', description: 'Build reliable systems.',
          applyUrl: `https://careers.example.test/${id}`,
          postedAt: null,
        }];
      }
      return [];
    });
    const page = (id: string) => ({ id, companyName: `Company ${id}`, url: `https://careers.example.test/${id}`, provider: 'greenhouse', boardToken: `token-${id}` });
    attrOnRegistryBatch.mockImplementation(async (after: string | null) => {
      if (after === null) {
        return { pages: [page('p1'), page('p2')], total: 3, hasMore: true, nextCursor: 'p2' };
      }
      return { pages: [page('p3')], total: 3, hasMore: false, nextCursor: null };
    });
    // Re-import the route's dependencies after mocking, then wire the real
    // orchestrator to the mock so we exercise the env-flag path end-to-end.
    const { runSearch } = await vi.importActual<typeof import('../discovery/orchestrator.js')>('../discovery/orchestrator.js');
    attrOnOrchestrator.mockImplementation((intent: any, opts: any, deps: any) => runSearch(intent, opts, deps));
    const { default: jobs } = await import('./jobs.js');
    attrOnApp = jobs;
    const { resetRunsForTests } = await import('../jobSources/discoveryRuns.js');
    const { resetOrchestratorForTests } = await import('../discovery/orchestrator.js');
    resetRunsForTests();
    resetOrchestratorForTests();
  });

  afterEach(() => {
    if (origAttr === undefined) delete process.env.SEARCH_ATTRIBUTION;
    else process.env.SEARCH_ATTRIBUTION = origAttr;
    vi.resetModules();
  });

  function makeAttrApp() {
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/jobs', attrOnApp);
    return app;
  }

  it('includes a timing key whose units match the executed units (board + registry pages)', async () => {
    const response = await request(makeAttrApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-attr-on', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.timing).toBeDefined();
    // One personal board (rss) + two registry pages = 3 executed units.
    // The attribution module records every unit, so units === executed count.
    expect(response.body.timing.units).toBe(3);
    expect(response.body.timing.byOutcome).toMatchObject({ ok: 3 });
    expect(response.body.timing.consistency).toBeDefined();
    expect(response.body.timing.p50Ms).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Wave 15 (T904) per-page verification write-back.
//
// The route reads the captured batch, maps each terminal registry-page unit
// to a CrawlOutcome, drives the shared verifyStore (mocked here), and
// reports a bounded `verification: { written, failed }` counter on the
// response. We drive the orchestrator mock directly with hand-built
// outcomes so the assertion targets the write-back path exactly.
// ---------------------------------------------------------------------------

describe('GET /jobs/full-scan verification write-back (T904)', () => {
  function storedPage(partial: Record<string, unknown>): any {
    return {
      id: 'p1',
      url: 'https://careers.example.test/p1',
      provider: 'greenhouse',
      boardToken: 'token-p1',
      tier: 1,
      isActive: true,
      verifyStatus: 'unverified',
      verifyMethod: null,
      verifiedAt: null,
      lastCheckedAt: null,
      httpStatus: null,
      resultCount: 0,
      failureCount: 0,
      nextCheckAt: null,
      lastError: null,
      ...partial,
    };
  }

  function buildOutcome(units: any[]): any {
    return {
      jobs: [],
      cancelled: false,
      truncated: false,
      skipped: [],
      units,
      registry: { processed: units.length, total: units.length },
    };
  }

  beforeEach(() => {
    registryBatchMock.mockResolvedValue({
      pages: [page('p1'), page('p2')],
      total: 2,
      hasMore: false,
      nextCursor: null,
    });
    // Two pages return rawResultCount 12 and 0 respectively so the
    // write records the honest count (12, not the cap-sliced value).
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type !== 'greenhouse') return [];
      const id = String(config.board).replace('token-', '');
      if (id === 'p1') return pageJobs(id, 12);
      if (id === 'p2') return [];
      return [];
    });
    readPageMock.mockImplementation(async (pageId: string) => {
      if (pageId === 'p1') return storedPage({ id: 'p1', resultCount: 12 });
      if (pageId === 'p2') return storedPage({ id: 'p2', resultCount: 0 });
      return null;
    });
    writeVerificationMock.mockResolvedValue(undefined);
  });

  it('writes verification for terminal registry-page units and counts the outcome', async () => {
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-verify-writeback', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.verification).toEqual({ written: 2, failed: 0 });
    expect(readPageMock).toHaveBeenCalledTimes(2);
    expect(writeVerificationMock).toHaveBeenCalledTimes(2);
    // The first write stores rawResultCount (12), not the capped value (5) -
    // the SUSPECT-drop rule's safe path. The second stores 0 ('empty').
    const updates = writeVerificationMock.mock.calls.map((c) => c[1]);
    expect(updates[0].resultCount).toBe(12);
    expect(updates[0].verifyStatus).toBe('ok');
    expect(updates[0].failureCount).toBe(0);
    // D2 (acceptance bullet 4): the ok write must carry verifiedAt set
    // (Date) and httpStatus null - buildVerificationUpdate populates them
    // from the success branch (crawler.ts:312,320,374).
    expect(updates[0].verifiedAt).toBeInstanceOf(Date);
    expect(updates[0].httpStatus).toBeNull();
    expect(updates[1].verifyStatus).toBe('empty');
    expect(updates[1].resultCount).toBe(0);
    // empty also counts as success in buildVerificationUpdate (line 312),
    // so verifiedAt is set and httpStatus is null too.
    expect(updates[1].verifiedAt).toBeInstanceOf(Date);
    expect(updates[1].httpStatus).toBeNull();
    // Stored listings never written on this path - the route's existing
    // JobSourceHealth surface stays untouched.
    expect(healthMocks.recordSourceSuccess).toHaveBeenCalledTimes(1);
    expect(healthMocks.recordSourceSuccess.mock.calls[0][0]).toBe('board-1');
  });

  it('maps the failure kind to the canonical verifyStatus on the write', async () => {
    // Drive the route through the real orchestrator (so the captured
    // batch is populated end-to-end). The two greenhouse pages throw
    // HttpStatusError(500) (p1) and a name-tagged UnknownSourceTypeError
    // (p2) so the orchestrator classifies them as 'http_error' and
    // 'invalid' respectively; the route then maps both onto the 8-value
    // verifyStatus vocabulary via `crawlOutcomeForRegistryPage`.
    const { HttpStatusError } = await vi.importActual<typeof import('../jobSources/httpStatus.js')>(
      '../jobSources/httpStatus.js',
    );
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type !== 'greenhouse') return [];
      const id = String(config.board).replace('token-', '');
      if (id === 'p1') {
        throw new HttpStatusError(500, 'https://careers.example.test/p1');
      }
      if (id === 'p2') {
        const e: any = new Error('Unknown job source type: rippling');
        e.name = 'UnknownSourceTypeError';
        throw e;
      }
      return [];
    });
    readPageMock.mockImplementation(async (pageId: string) => storedPage({ id: pageId }));

    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-verify-failure', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.verification).toEqual({ written: 2, failed: 0 });
    // Sort the updates by pageId for order-agnostic assertion: the pool
    // completes units in race order, not in `page:<index>` order, so the
    // writes can land in any sequence.
    const updatesByPage = new Map<string, any>(
      writeVerificationMock.mock.calls.map((c) => [c[0] as string, c[1]]),
    );
    expect(updatesByPage.get('p1')?.verifyStatus).toBe('http_error');
    expect(updatesByPage.get('p1')?.httpStatus).toBe(500);
    expect(updatesByPage.get('p1')?.failureCount).toBe(1);
    expect(updatesByPage.get('p2')?.verifyStatus).toBe('invalid');
    expect(updatesByPage.get('p2')?.httpStatus).toBeNull();
  });

  it('cancelled and skipped units cause ZERO store calls', async () => {
    orchestratorMock.mockImplementation(() => Promise.resolve(buildOutcome([
      {
        unitId: 'page:0', kind: 'registry-page', providerType: 'greenhouse', tier: 1, group: 'ats',
        status: 'cancelled', resultCount: 0, latencyMs: 1, reason: 'cancelled',
      },
      {
        unitId: 'page:1', kind: 'registry-page', providerType: 'greenhouse', tier: 1, group: 'ats',
        status: 'skipped', resultCount: 0, latencyMs: 1, reason: 'browser tier skipped',
      },
    ])));

    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-verify-skip-cancel', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.verification).toEqual({ written: 0, failed: 0 });
    expect(readPageMock).toHaveBeenCalledTimes(0);
    expect(writeVerificationMock).toHaveBeenCalledTimes(0);
  });

  it('a timeout unit is recorded at the store as verifyStatus "timeout" (D2)', async () => {
    // D2 acceptance bullet 4: drive a `timeout` failureKind through the real
    // orchestrator's error branch (orchestrator.ts:1099-1126). `runSource`
    // throws an `Error('timeout after 20000ms')`; the message-heuristic
    // fallback in `classifyTransportFailure` (httpStatus.ts:148) maps it to
    // `failureKind: 'timeout'`, the orchestrator records it on the unit, and
    // the route's mapping arm (jobs.fullscan.ts:227) writes
    // `verifyStatus: 'timeout'`.
    //
    // This exercises the writer path WITHOUT driving the orchestrator's
    // Promise.race timer (FULL_BATCH_BUDGET.perUnitTimeoutMs is frozen at
    // 20s and cannot be overridden in this lane).
    registryBatchMock.mockResolvedValue({
      pages: [page('p1')],
      total: 1,
      hasMore: false,
      nextCursor: null,
    });
    runSourceMock.mockImplementation(async (config: any) => {
      throw new Error('timeout after 20000ms');
    });
    readPageMock.mockImplementation(async (pageId: string) => storedPage({ id: pageId }));

    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-verify-timeout', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.verification).toEqual({ written: 1, failed: 0 });
    const update = writeVerificationMock.mock.calls[0][1];
    expect(update.verifyStatus).toBe('timeout');
    // failureCount recomputed (not a blind increment); httpStatus is undefined
    // on a timeout so the stored field is null.
    expect(update.failureCount).toBe(1);
    expect(update.httpStatus).toBeNull();
  });

  it('an unroutable registry row is recorded at the store as verifyStatus "invalid" (D2)', async () => {
    // D2 acceptance bullet 4: the unroutable path is the `addRegistryPages`
    // catch (orchestrator.ts:759-786) - a deferred/unknown provider triggers
    // `UnknownSourceTypeError` inside `configForRegistryRow`, the unit is
    // pre-recorded with `status: 'failed', failureKind: 'invalid'`, and the
    // mapping at jobs.fullscan.ts:228 then writes `verifyStatus: 'invalid'`.
    registryBatchMock.mockResolvedValue({
      pages: [{
        id: 'p-rippling',
        companyName: 'Rippling',
        url: 'https://rippling.example/careers',
        provider: 'rippling',
        boardToken: 'rippling',
      }],
      total: 1,
      hasMore: false,
      nextCursor: null,
    });
    readPageMock.mockImplementation(async (pageId: string) => storedPage({ id: pageId }));

    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-verify-unroutable', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.verification).toEqual({ written: 1, failed: 0 });
    const update = writeVerificationMock.mock.calls[0][1];
    // The unit's recorded status in the run outcome is `failed` (preserved);
    // only the store-level verifyStatus is mapped to `invalid`.
    expect(update.verifyStatus).toBe('invalid');
    expect(update.failureCount).toBe(1);
    expect(update.httpStatus).toBeNull();
  });

  it('a not_modified (304) unit is recorded at the store as verifyStatus "skipped" - never http_error (D1)', async () => {
    // D1 regression: `failureKind: 'not_modified'` is a member of the
    // contract's union (orchestrator.ts:244, produced by HttpStatusError(304)
    // via classifyTransportFailure at httpStatus.ts:139). It MUST NOT default
    // to 'http_error'. The mapping arm at jobs.fullscan.ts:229 must send it
    // to 'skipped', so buildVerificationUpdate preserves the prior
    // verifyStatus, does NOT increment failureCount, and advances
    // lastCheckedAt (crawler.ts:319-321).
    const { HttpStatusError } = await vi.importActual<typeof import('../jobSources/httpStatus.js')>(
      '../jobSources/httpStatus.js',
    );
    registryBatchMock.mockResolvedValue({
      pages: [page('p1')],
      total: 1,
      hasMore: false,
      nextCursor: null,
    });
    runSourceMock.mockImplementation(async (config: any) => {
      throw new HttpStatusError(304, 'https://careers.example.test/p1');
    });
    // Prior store has a non-trivial state so the "preserved" assertions are
    // meaningful: a stored `http_error` page stays `http_error` (skipped is
    // not a failure), a stored failureCount of 4 stays 4 (NOT incremented).
    readPageMock.mockImplementation(async (pageId: string) => storedPage({
      id: pageId,
      verifyStatus: 'http_error',
      failureCount: 4,
    }));

    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-verify-not-modified', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.verification).toEqual({ written: 1, failed: 0 });
    const update = writeVerificationMock.mock.calls[0][1];
    // Prior verifyStatus PRESERVED (skipped branch in buildVerificationUpdate).
    expect(update.verifyStatus).toBe('http_error');
    // failureCount NOT incremented (skipped branch keeps storedFailures).
    expect(update.failureCount).toBe(4);
    // httpStatus is forwarded (304 -> 304), NOT nulled.
    expect(update.httpStatus).toBe(304);
    // lastCheckedAt is advanced so the page is not retried immediately.
    expect(update.lastCheckedAt).toBeInstanceOf(Date);
    // The D1 trap: even when the prior state is `http_error`, the write
    // must be a `skipped`-semantic update (failureCount preserved, lastCheckedAt
    // advanced, verifyStatus carried through verbatim). A naive fix would
    // produce a `verifyStatus: 'http_error'` write with `failureCount: 5`
    // (re-incremented), `httpStatus: 304`, `lastError: 'Fetch failed 304...'` -
    // the exact "304 recorded as failure" outcome D1 forbids.
    expect(update.failureCount).toBe(4);
    expect(update.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('a throwing store counts as failed, never throws, and keeps the batch shape', async () => {
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type !== 'greenhouse') return [];
      const id = String(config.board).replace('token-', '');
      if (id === 'p1') return [pageJob('p1')];
      if (id === 'p2') return [pageJob('p2')];
      return [];
    });
    readPageMock.mockImplementation(async (pageId: string) => storedPage({ id: pageId }));
    writeVerificationMock.mockImplementation(async (pageId: string) => {
      if (pageId === 'p2') throw new Error('DB down');
    });

    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-verify-throw', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.verification).toEqual({ written: 1, failed: 1 });
    // Existing keys unchanged: the persisted listings still land; no
    // rethrow, no JobSourceHealth write, batch succeeds.
    expect(response.body.persisted).toBe(2);
    expect(response.body.results.length).toBe(2);
  });

  it('SEARCH_FULL_VERIFY_WRITEBACK=off => zero store calls and no verification key', async () => {
    const origVerify = process.env.SEARCH_FULL_VERIFY_WRITEBACK;
    process.env.SEARCH_FULL_VERIFY_WRITEBACK = 'off';
    vi.resetModules();
    try {
      vi.doMock('../middleware/auth.js', () => ({
        requireAuth: (req: any, res: any, next: any) => {
          const id = req.headers['x-test-user'];
          if (!id || typeof id !== 'string') return res.status(401).json({ error: 'Unauthorized' });
          req.user = { id, email: 'test@example.com', isAdmin: false };
          next();
        },
      }));
      vi.doMock('../lib/prisma.js', () => ({ default: prismaMocks }));
      vi.doMock('../jobSources/defaultBoards.js', () => ({ seedDefaultBoardsForUser: (...a: any[]) => seedMock(...a) }));
      vi.doMock('../jobSources/index.js', async (importOriginal) => {
        const original = await importOriginal<typeof import('../jobSources/index.js')>();
        return { ...original, runSource: (...a: any[]) => runSourceMock(...a) };
      });
      vi.doMock('../jobSources/sourceHealth.js', () => ({
        recordSourceSuccess: (...a: any[]) => healthMocks.recordSourceSuccess(...a),
        recordSourceFailure: (...a: any[]) => healthMocks.recordSourceFailure(...a),
      }));
      vi.doMock('../discovery/registrySweep.js', () => ({ resolveRegistryPageBatch: (...a: any[]) => registryBatchMock(...a) }));
      vi.doMock('../discovery/orchestrator.js', async (importOriginal) => {
        const original = await importOriginal<typeof import('../discovery/orchestrator.js')>();
        return { ...original, runSearch: (...a: any[]) => orchestratorMock(...a) };
      });
      vi.doMock('../registry/verifyStore.js', () => ({
        readPageForUpdate: (...a: any[]) => readPageMock(...a),
        writePageVerification: (...a: any[]) => writeVerificationMock(...a),
      }));
      const { runSearch: actualRunSearch } = await vi.importActual<typeof import('../discovery/orchestrator.js')>('../discovery/orchestrator.js');
      orchestratorMock.mockImplementation((intent: any, opts: any, deps: any) => actualRunSearch(intent, opts, deps));
      const { default: jobsOff } = await import('./jobs.js');
      const express = require('express');
      const app = express();
      app.use(express.json());
      app.use('/jobs', jobsOff);
      resetRunsForTests();
      resetOrchestratorForTests();

      const response = await request(app)
        .get('/jobs/full-scan')
        .query({ runId: 'full-verify-off', q: 'engineer' })
        .set('x-test-user', 'user-1');
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('verification');
      // Spy count 0 - the env-off path skips the verifyStore seam entirely.
      // The factory mocks were re-imported via vi.doMock so calls land on
      // the module-scope instances.
      expect(readPageMock).toHaveBeenCalledTimes(0);
      expect(writeVerificationMock).toHaveBeenCalledTimes(0);
    } finally {
      if (origVerify === undefined) delete process.env.SEARCH_FULL_VERIFY_WRITEBACK;
      else process.env.SEARCH_FULL_VERIFY_WRITEBACK = origVerify;
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// Wave 15 (T908): the bounded `politeness` marker on the batch response.
//
// `politeness: { mode, signals, blocks, deferred, wiringOk }` is ALWAYS
// present (T907 carried the string `'off'`, and only with the knob off). The
// `on` case reports the run's real counters so the WIRING ASSERT is visible:
// a limiter that is on, sees 429/503 signals and never opens a block reports
// `wiringOk: false` instead of failing silently. The knob is read at request
// time from the imported `env`, so overriding it in place needs no module
// re-import (the route constructs its gate inside the handler).
// ---------------------------------------------------------------------------

describe('T908: politeness marker on the Full batch response', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envRef = env as any;
  const originalKnob = envRef.SEARCH_FULL_POLITENESS;

  afterEach(() => {
    envRef.SEARCH_FULL_POLITENESS = originalKnob;
  });

  it('reports signals and blocks for an observed 429 (wiringOk true)', async () => {
    // Both registry pages in the batch resolve to the SAME bucket
    // (`provider:greenhouse`, ADR-034 D2.1), so two 429 units are ONE
    // congestion event: `signals` counts both units, `blocks` counts the one
    // block that was opened (the second signal was absorbed by the active
    // window - one-event-per-window).
    const { HttpStatusError } = await vi.importActual<typeof import('../jobSources/httpStatus.js')>(
      '../jobSources/httpStatus.js',
    );
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type !== 'greenhouse') return [];
      throw new HttpStatusError(429, `https://careers.example.test/${String(config.board)}`, '120');
    });
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-t908-429', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.politeness.mode).toBe('on');
    expect(response.body.politeness.signals).toBe(2);
    expect(response.body.politeness.blocks).toBe(1);
    expect(response.body.politeness.blocks).toBeLessThanOrEqual(
      response.body.politeness.signals,
    );
    expect(response.body.politeness.wiringOk).toBe(true);
  });

  it('a 403 storm is a health-`blocked` signal but never a rate-limit block', async () => {
    // Spec EDGE CASE 11: 403 is classified `blocked` (T902) yet opens NO
    // rate-limit block, so `signals === 0` and `blocks === 0` - the wiring
    // assert must not misfire on 403.
    const { HttpStatusError } = await vi.importActual<typeof import('../jobSources/httpStatus.js')>(
      '../jobSources/httpStatus.js',
    );
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type !== 'greenhouse') return [];
      throw new HttpStatusError(403, `https://careers.example.test/${String(config.board)}`);
    });
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-t908-403', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.politeness).toMatchObject({
      mode: 'on',
      signals: 0,
      blocks: 0,
      wiringOk: true,
    });
    expect(response.body.failedCount).toBe(2);
  });

  it('SEARCH_FULL_POLITENESS=off reports the fixed off shape and opens no block', async () => {
    envRef.SEARCH_FULL_POLITENESS = 'off';
    const { HttpStatusError } = await vi.importActual<typeof import('../jobSources/httpStatus.js')>(
      '../jobSources/httpStatus.js',
    );
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type !== 'greenhouse') return [];
      throw new HttpStatusError(429, `https://careers.example.test/${String(config.board)}`);
    });
    const response = await request(makeApp())
      .get('/jobs/full-scan')
      .query({ runId: 'full-t908-off', q: 'engineer' })
      .set('x-test-user', 'user-1');
    expect(response.status).toBe(200);
    expect(response.body.politeness).toEqual({
      mode: 'off',
      signals: 0,
      blocks: 0,
      deferred: 0,
      wiringOk: true,
    });
    // No gate was constructed, so the orchestrator received none: the 429s
    // still failed their units but could not open any block.
    const deps = orchestratorMock.mock.calls.at(-1)![2] as { politenessGate?: unknown };
    expect(deps.politenessGate).toBeUndefined();
  });
});
