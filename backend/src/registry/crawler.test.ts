// Registry crawler tests (T760): batch selection, tier routing, bounds,
// failure isolation. All fixtures are synthetic: every host lives under
// example.test and every token is invented.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Mocked transports: tier 1 (greenhouse API) and tier 3 (career page).
// The crawler must route through the wave-4 mapping down to these fetchers.
vi.mock('../jobSources/adapters/greenhouse.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/adapters/greenhouse.js')>();
  return {
    ...orig,
    fetchGreenhouse: vi.fn(async () => [
      { source: 'greenhouse', sourceUrl: 'https://example.test/1', title: 'Eng', company: 'Acme', description: 'x' },
      { source: 'greenhouse', sourceUrl: 'https://example.test/2', title: 'Eng', company: 'Acme', description: 'x' },
      { source: 'greenhouse', sourceUrl: 'https://example.test/3', title: 'Eng', company: 'Acme', description: 'x' },
    ]),
  };
});
vi.mock('../jobSources/adapters/career-page.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/adapters/career-page.js')>();
  return { ...orig, fetchCareerPage: vi.fn(async () => []) };
});
// Tier-4 browser tier: the engine reports skipped-with-reason (never a real
// launch in tests). The lazy path lives in providerRegistry; the crawler
// only reaches it through the descriptor table.
vi.mock('../browser/tier.js', () => ({
  fetchViaBrowser: vi.fn(async () => {
    throw {
      name: 'BrowserTierSkippedError',
      skipped: true,
      reason: 'browser engine absent in test',
      message: 'browser tier skipped: browser engine absent in test',
    };
  }),
}));

import { fetchGreenhouse } from '../jobSources/adapters/greenhouse.js';
import { fetchCareerPage } from '../jobSources/adapters/career-page.js';
import { fetchViaBrowser } from '../browser/tier.js';
import {
  CRAWL_BATCH_SIZE,
  CRAWL_CONCURRENCY,
  classifyProbeError,
  crawlBatch,
  nextBatch,
  type CrawlOutcome,
  type CrawlStore,
  type CrawlUnit,
  type ProbeFn,
  type StoredCareerPage,
} from './crawler.js';
import { HttpStatusError } from '../jobSources/httpStatus.js';

const NOW = new Date('2026-09-21T00:00:00.000Z');
const CRAWLER_SRC = readFileSync(path.join(__dirname, 'crawler.ts'), 'utf8');

function page(partial: Partial<StoredCareerPage> & { id: string }): StoredCareerPage {
  return {
    url: `https://careers.${partial.id}.example.test/`,
    provider: null,
    boardToken: null,
    tier: 3,
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

interface FakeStore extends CrawlStore {
  rows: Map<string, StoredCareerPage>;
  listDueCalls: Array<{ limit: number; now: Date }>;
}

/**
 * Deliberately naive store: listDue returns EVERYTHING and lets nextBatch's
 * production selection (selectDueBatch) enforce the contract - so these
 * tests pin the real queue semantics, not a clever fake.
 */
function makeFake(seed: StoredCareerPage[]): FakeStore {
  const rows = new Map(seed.map((p) => [p.id, { ...p }]));
  const listDueCalls: Array<{ limit: number; now: Date }> = [];
  return {
    rows,
    listDueCalls,
    async listDue(limit: number, now: Date): Promise<StoredCareerPage[]> {
      listDueCalls.push({ limit, now });
      return [...rows.values()].map((p) => ({ ...p }));
    },
    async readForUpdate(pageId: string): Promise<StoredCareerPage | null> {
      const found = rows.get(pageId);
      return found ? { ...found } : null;
    },
    async writeVerification(pageId: string, update: Parameters<CrawlStore['writeVerification']>[1]): Promise<void> {
      const found = rows.get(pageId);
      if (!found) throw new Error(`fake store: missing page ${pageId}`);
      rows.set(pageId, { ...found, ...update });
    },
  };
}

const okProbe = (resultCount: number): ProbeFn => async (unit: CrawlUnit): Promise<CrawlOutcome> => ({
  pageId: unit.pageId,
  status: 'ok',
  httpStatus: 200,
  resultCount,
  latencyMs: 1,
});

describe('nextBatch work-queue selection', () => {
  it('returns only active, due pages in nextCheckAt order with id tie-break', async () => {
    const store = makeFake([
      page({ id: 'future', nextCheckAt: new Date('2026-09-30T00:00:00.000Z') }),
      page({ id: 'inactive', isActive: false, nextCheckAt: new Date('2026-09-01T00:00:00.000Z') }),
      page({ id: 'b-due', nextCheckAt: new Date('2026-09-10T00:00:00.000Z') }),
      page({ id: 'a-due', nextCheckAt: new Date('2026-09-10T00:00:00.000Z') }),
      page({ id: 'older', nextCheckAt: new Date('2026-09-01T00:00:00.000Z') }),
      page({ id: 'never', nextCheckAt: null }),
    ]);
    const batch = await nextBatch(10, NOW, { store });
    // Never-scheduled (null) sorts first, then ascending, id tie-break.
    expect(batch.map((u) => u.pageId)).toEqual(['never', 'older', 'a-due', 'b-due']);
    expect(batch.every((u) => u.pageId !== 'inactive')).toBe(true);
    expect(batch.every((u) => u.pageId !== 'future')).toBe(true);
  });

  it('respects the limit and maps rows to crawl units', async () => {
    const store = makeFake([
      page({ id: 'p1', nextCheckAt: new Date('2026-09-01T00:00:00.000Z'), provider: 'greenhouse', boardToken: 'acme', tier: 1, url: 'https://boards.greenhouse.io/acme' }),
      page({ id: 'p2', nextCheckAt: new Date('2026-09-02T00:00:00.000Z') }),
      page({ id: 'p3', nextCheckAt: new Date('2026-09-03T00:00:00.000Z') }),
    ]);
    const batch = await nextBatch(2, NOW, { store });
    expect(batch).toHaveLength(2);
    expect(batch[0]).toEqual({
      pageId: 'p1',
      url: 'https://boards.greenhouse.io/acme',
      provider: 'greenhouse',
      boardToken: 'acme',
      tier: 1,
    });
  });

  it('a non-positive limit returns [] without touching the store', async () => {
    const store = makeFake([page({ id: 'p1' })]);
    expect(await nextBatch(0, NOW, { store })).toEqual([]);
    expect(await nextBatch(-3, NOW, { store })).toEqual([]);
    expect(store.listDueCalls).toHaveLength(0);
  });

  it('inactive pages are never enqueued even when everything else is due', async () => {
    const store = makeFake([
      page({ id: 'off-1', isActive: false }),
      page({ id: 'off-2', isActive: false, nextCheckAt: new Date('2020-01-01T00:00:00.000Z') }),
    ]);
    expect(await nextBatch(10, NOW, { store })).toEqual([]);
    expect(await crawlBatch(10, { now: NOW }, { store, probe: okProbe(1) })).toEqual([]);
  });
});

describe('tier routing through the wave-4 mapping (default probe)', () => {
  it('routes tier 1 via the adapter, tier 3 via the page fetch, tier 4 via the browser tier', async () => {
    const store = makeFake([
      page({
        id: 'gh', tier: 1, provider: 'greenhouse', boardToken: 'acme',
        url: 'https://boards.greenhouse.io/acme',
        nextCheckAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
      page({
        id: 'cp', tier: 3, provider: null, boardToken: null,
        url: 'https://careers.cp.example.test/',
        nextCheckAt: new Date('2026-09-02T00:00:00.000Z'),
      }),
      page({
        id: 't4', tier: 4, provider: null, boardToken: null,
        url: 'https://careers.t4.example.test/',
        nextCheckAt: new Date('2026-09-03T00:00:00.000Z'),
      }),
    ]);
    // No probe override: the DEFAULT probe runs against mocked transports.
    const outcomes = await crawlBatch(10, { now: NOW }, { store });
    expect(vi.mocked(fetchGreenhouse)).toHaveBeenCalledWith('acme', '');
    expect(vi.mocked(fetchCareerPage)).toHaveBeenCalledWith('https://careers.cp.example.test/', '');
    expect(vi.mocked(fetchViaBrowser)).toHaveBeenCalledTimes(1);

    const byId = new Map(outcomes.map((o) => [o.pageId, o]));
    expect(byId.get('gh')?.status).toBe('ok');
    expect(byId.get('gh')?.resultCount).toBe(3);
    expect(byId.get('cp')?.status).toBe('empty');
    // T902: a successful probe that did not observe a specific HTTP status
    // returns httpStatus: undefined (rendered as null). The success branch
    // no longer invents 200.
    expect(byId.get('gh')?.httpStatus).toBeUndefined();
    expect(byId.get('cp')?.httpStatus).toBeUndefined();
    // An unserviceable tier is skipped-with-reason, never a failure.
    expect(byId.get('t4')?.status).toBe('skipped');
    expect(byId.get('t4')?.error).toMatch(/browser engine absent/);

    expect(store.rows.get('gh')?.verifyStatus).toBe('ok');
    expect(store.rows.get('gh')?.verifyMethod).toBe('adapter');
    expect(store.rows.get('cp')?.verifyStatus).toBe('empty');
    expect(store.rows.get('cp')?.verifyMethod).toBe('page');
    expect(store.rows.get('t4')?.verifyStatus).toBe('unverified');
    expect(store.rows.get('t4')?.verifyMethod).toBe('browser');
    expect(store.rows.get('t4')?.failureCount).toBe(0);
  });

  it('routes through configForRegistryRow, not a per-provider ladder (source check)', () => {
    expect(CRAWLER_SRC).toMatch(/configForRegistryRow/);
    for (const id of ['greenhouse', 'ashby', 'lever', 'workday', 'breezy', 'teamtailor']) {
      expect(CRAWLER_SRC, `ladder case for ${id}`).not.toMatch(new RegExp(`case\\s+'${id}'`));
    }
  });
});

describe('bounded batch + concurrency caps', () => {
  function dueSeed(count: number): StoredCareerPage[] {
    const out: StoredCareerPage[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = `p${String(i).padStart(2, '0')}`;
      out.push(page({ id, nextCheckAt: new Date(Date.UTC(2026, 8, 1 + i)) }));
    }
    return out;
  }

  it('clamps a limit above CRAWL_BATCH_SIZE (never crawls the whole registry)', async () => {
    const store = makeFake(dueSeed(30));
    let probeCalls = 0;
    const outcomes = await crawlBatch(
      CRAWL_BATCH_SIZE + 1000,
      { now: NOW },
      {
        store,
        probe: async (unit) => {
          probeCalls += 1;
          return { pageId: unit.pageId, status: 'ok', httpStatus: 200, resultCount: 1, latencyMs: 1 };
        },
      },
    );
    expect(outcomes).toHaveLength(CRAWL_BATCH_SIZE);
    expect(probeCalls).toBe(CRAWL_BATCH_SIZE);
    // The store itself receives the clamped bound.
    expect(store.listDueCalls).toHaveLength(1);
    expect(store.listDueCalls[0].limit).toBe(CRAWL_BATCH_SIZE);
    // Queue order is preserved in the returned records.
    expect(outcomes[0].pageId).toBe('p00');
    expect(outcomes[CRAWL_BATCH_SIZE - 1].pageId).toBe(`p${String(CRAWL_BATCH_SIZE - 1).padStart(2, '0')}`);
  });

  it('caps in-flight units at CRAWL_CONCURRENCY', async () => {
    const store = makeFake(dueSeed(6));
    let inFlight = 0;
    let maxInFlight = 0;
    const outcomes = await crawlBatch(
      6,
      { now: NOW },
      {
        store,
        probe: async (unit) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { pageId: unit.pageId, status: 'empty', resultCount: 0, latencyMs: 1 };
        },
      },
    );
    expect(outcomes).toHaveLength(6);
    expect(maxInFlight).toBeLessThanOrEqual(CRAWL_CONCURRENCY);
    expect(maxInFlight).toBe(CRAWL_CONCURRENCY);
  });
});

describe('per-company failure isolation', () => {
  it('a throwing transport becomes that page’s http_error; the batch completes', async () => {
    const store = makeFake([
      page({ id: 'good-1', nextCheckAt: null }),
      page({ id: 'bad', nextCheckAt: null }),
      page({ id: 'good-2', nextCheckAt: null }),
    ]);
    const outcomes = await crawlBatch(
      10,
      { now: NOW },
      {
        store,
        probe: async (unit) => {
          if (unit.pageId === 'bad') throw new Error('socket hang up');
          return { pageId: unit.pageId, status: 'ok', httpStatus: 200, resultCount: 2, latencyMs: 1 };
        },
      },
    );
    expect(outcomes).toHaveLength(3);
    const byId = new Map(outcomes.map((o) => [o.pageId, o]));
    expect(byId.get('good-1')?.status).toBe('ok');
    expect(byId.get('good-2')?.status).toBe('ok');
    expect(byId.get('bad')?.status).toBe('http_error');
    expect(byId.get('bad')?.error).toMatch(/socket hang up/);
    expect(store.rows.get('bad')?.verifyStatus).toBe('http_error');
    expect(store.rows.get('bad')?.failureCount).toBe(1);
    expect(store.rows.get('good-1')?.verifyStatus).toBe('ok');
  });

  it('a write-back failure for one page does not lose sibling outcomes', async () => {
    const base = makeFake([
      page({ id: 'good', nextCheckAt: null }),
      page({ id: 'broken', nextCheckAt: null }),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store: CrawlStore = {
        ...base,
        async writeVerification(pageId, update) {
          if (pageId === 'broken') throw new Error('db gone');
          return base.writeVerification(pageId, update);
        },
      };
      const outcomes = await crawlBatch(10, { now: NOW }, { store, probe: okProbe(1) });
      expect(outcomes).toHaveLength(2);
      expect(outcomes.every((o) => o.status === 'ok')).toBe(true);
      expect(base.rows.get('good')?.verifyStatus).toBe('ok');
      expect(base.rows.get('broken')?.verifyStatus).toBe('unverified');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a page deleted mid-batch keeps its outcome with no write', async () => {
    const base = makeFake([page({ id: 'ghost', nextCheckAt: null })]);
    const store: CrawlStore = {
      ...base,
      async readForUpdate() {
        return null;
      },
    };
    const outcomes = await crawlBatch(10, { now: NOW }, { store, probe: okProbe(4) });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('ok');
    expect(outcomes[0].resultCount).toBe(4);
  });
});

describe('structural guards (ADR-013 + wave-8 constraints)', () => {
  it('contains no scheduler, cron, worker, or background loop', () => {
    expect(CRAWLER_SRC).not.toMatch(/setInterval|cron|node-cron/i);
    expect(CRAWLER_SRC).not.toMatch(/setTimeout/);
  });

  it('never references user-board health state', () => {
    expect(CRAWLER_SRC).not.toMatch(/jobsourcehealth/i);
  });

  it('holds no static or dynamic reference to the browser tree (N2)', () => {
    for (const line of CRAWLER_SRC.split('\n')) {
      if (/^\s*import\b(?!\s*\()/.test(line) || /^\s*export\b.*\bfrom\b/.test(line)) {
        expect(line).not.toMatch(/browser\//);
      }
    }
    expect(CRAWLER_SRC).not.toMatch(/import\s*\([^)]*browser\//);
  });

  it('reads policy time only from the injected clock', () => {
    // Date.now appears solely for latencyMs measurement, never as policy input.
    const uses = CRAWLER_SRC.match(/Date\.now\(\)/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.length).toBeLessThanOrEqual(3);
    expect(CRAWLER_SRC).toMatch(/policy time.*injected/i);
  });
});

describe('defaultProbe - T902 removes invented httpStatus: 200 on success', () => {
  // T902: a successful probe that did not observe a specific HTTP status
  // writes httpStatus: undefined (rendered as null). The success branch no
  // longer invents 200.
  it('tier-1 success returns httpStatus: undefined (no invented 200)', async () => {
    const store = makeFake([
      page({
        id: 'p1', tier: 1, provider: 'greenhouse', boardToken: 'acme',
        url: 'https://boards.greenhouse.io/acme',
        nextCheckAt: new Date('2026-09-01T00:00:00.000Z'),
      }),
    ]);
    const outcomes = await crawlBatch(10, { now: NOW }, { store });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('ok');
    expect(outcomes[0].httpStatus).toBeUndefined();
  });

  it('tier-4 skipped outcome also has httpStatus: undefined (no invented 200)', async () => {
    // The browser tier mock at file scope throws BrowserTierSkippedError,
    // which goes through the catch block (where classified.httpStatus is
    // undefined for a branded skip). Asserting here proves the catch path
    // does not invent a 200 either.
    const store = makeFake([
      page({
        id: 'p4', tier: 4, provider: null, boardToken: null,
        url: 'https://careers.t4.example.test/',
        nextCheckAt: new Date('2026-09-03T00:00:00.000Z'),
      }),
    ]);
    const outcomes = await crawlBatch(10, { now: NOW }, { store });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('skipped');
    expect(outcomes[0].httpStatus).toBeUndefined();
  });

  it('tier-4 SUCCESS returns httpStatus: undefined (no invented 200 on the browser tier success branch)', async () => {
    // T902: the tier-4 success branch in `defaultProbe` is one of the two
    // branches that used to invent `httpStatus: 200`. The file-scope browser
    // mock throws BrowserTierSkippedError, so without this override the only
    // reachable tier-4 outcome is the catch path (which never wrote 200).
    vi.mocked(fetchViaBrowser).mockResolvedValueOnce([
      {
        source: 'browser',
        sourceUrl: 'https://careers.t4ok.example.test/1',
        title: 'Eng',
        company: 'Acme',
        description: 'x',
      },
    ]);
    const store = makeFake([
      page({
        id: 'p4ok', tier: 4, provider: null, boardToken: null,
        url: 'https://careers.t4ok.example.test/',
        nextCheckAt: new Date('2026-09-03T00:00:00.000Z'),
      }),
    ]);
    const outcomes = await crawlBatch(10, { now: NOW }, { store });
    expect(outcomes).toHaveLength(1);
    // The success branch ran, not the catch path.
    expect(outcomes[0].status).toBe('ok');
    expect(outcomes[0].resultCount).toBe(1);
    expect(outcomes[0].httpStatus).toBeUndefined();
    // Write-back renders undefined as null.
    expect(store.rows.get('p4ok')?.httpStatus).toBeNull();
  });
});

describe('classifyProbeError - T902 structured path', () => {
  // T902: the structured error from jobSources/httpStatus.js is the primary
  // path; the regex fallback is kept for inputs the structured path declined.
  it('an HttpStatusError(429) whose message does NOT contain "Fetch failed 429" still returns blocked+429', () => {
    // T902: proves the structured path, not the regex. The fallback regex
    // (the documented message-heuristic) only matches `/fetch failed (\d{3})/i`;
    // a message that omits that phrasing but still embeds the status falls
    // through to the structured read (`error.status`).
    const err = new HttpStatusError(
      429,
      'https://x.example.test/',
      '60',
      'rate limited (429) by upstream CDN',
    );
    expect(err.message).not.toMatch(/Fetch failed 429/i);
    const result = classifyProbeError(err);
    expect(result.status).toBe('blocked');
    expect(result.httpStatus).toBe(429);
  });

  it('an HttpStatusError(304) returns skipped with a not modified (304) reason and httpStatus: 304', () => {
    const err = new HttpStatusError(304, 'https://x.example.test/');
    const result = classifyProbeError(err);
    expect(result.status).toBe('skipped');
    expect(result.httpStatus).toBe(304);
    expect(result.error).toMatch(/not modified \(304\)/);
  });

  it('an HttpStatusError(503) returns blocked+503 (real status from structure)', () => {
    const result = classifyProbeError(new HttpStatusError(503, 'https://x.example.test/'));
    expect(result.status).toBe('blocked');
    expect(result.httpStatus).toBe(503);
  });

  it('an HttpStatusError(404) returns http_error+404', () => {
    const result = classifyProbeError(new HttpStatusError(404, 'https://x.example.test/'));
    expect(result.status).toBe('http_error');
    expect(result.httpStatus).toBe(404);
  });

  it('an HttpStatusError(408) returns timeout+408', () => {
    const result = classifyProbeError(new HttpStatusError(408, 'https://x.example.test/'));
    expect(result.status).toBe('timeout');
    expect(result.httpStatus).toBe(408);
  });

  it('the legacy message-only path still classifies a plain 500 Error as http_error', () => {
    // Regression: the regex fallback still works for inputs the structured
    // path declined (plain Error throws from non-HTTP code paths).
    const result = classifyProbeError(new Error('Fetch failed 500 for https://x.example.test/'));
    expect(result.status).toBe('http_error');
    expect(result.httpStatus).toBe(500);
  });
});
