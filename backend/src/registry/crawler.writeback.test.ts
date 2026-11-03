// Registry verification write-back tests (T760 STEP 4 table + STEP 7/9).
// Every outcome is driven through crawlBatch with a mocked transport and
// asserted against the stored CompanyCareerPage-shaped row. Fixtures are
// synthetic (example.test hosts, invented tokens).
import { describe, it, expect } from 'vitest';
import { nextCheckAt as stalenessNextCheckAt } from './staleness.js';
import {
  LAST_ERROR_MAX_CHARS,
  buildVerificationUpdate,
  crawlBatch,
  type CrawlOutcome,
  type CrawlStore,
  type CrawlUnit,
  type ProbeFn,
  type StoredCareerPage,
} from './crawler.js';

const NOW = new Date('2026-09-21T00:00:00.000Z');
const OLD = new Date('2026-09-01T00:00:00.000Z');

function page(partial: Partial<StoredCareerPage> & { id: string }): StoredCareerPage {
  return {
    url: `https://careers.${partial.id}.example.test/`,
    provider: 'greenhouse',
    boardToken: 'acme',
    tier: 1,
    isActive: true,
    verifyStatus: 'unverified',
    verifyMethod: null,
    verifiedAt: null,
    lastCheckedAt: null,
    httpStatus: null,
    resultCount: 0,
    failureCount: 2,
    nextCheckAt: null,
    lastError: 'stale error',
    ...partial,
  };
}

interface FakeStore extends CrawlStore {
  rows: Map<string, StoredCareerPage>;
  calls: string[];
}

function makeFake(seed: StoredCareerPage[]): FakeStore {
  const rows = new Map(seed.map((p) => [p.id, { ...p }]));
  const calls: string[] = [];
  return {
    rows,
    calls,
    async listDue(): Promise<StoredCareerPage[]> {
      calls.push('listDue');
      return [...rows.values()].map((p) => ({ ...p }));
    },
    async readForUpdate(pageId: string): Promise<StoredCareerPage | null> {
      calls.push('readForUpdate');
      const found = rows.get(pageId);
      return found ? { ...found } : null;
    },
    async writeVerification(
      pageId: string,
      update: Parameters<CrawlStore['writeVerification']>[1],
    ): Promise<void> {
      calls.push('writeVerification');
      const found = rows.get(pageId);
      if (!found) throw new Error(`fake store: missing page ${pageId}`);
      rows.set(pageId, { ...found, ...update });
    },
  };
}

function fixedProbe(outcome: Omit<CrawlOutcome, 'pageId' | 'latencyMs'>): ProbeFn {
  return async (unit: CrawlUnit): Promise<CrawlOutcome> => ({
    ...outcome,
    pageId: unit.pageId,
    latencyMs: 1,
  });
}

async function crawlOneJourney(
  seed: StoredCareerPage,
  outcome: Omit<CrawlOutcome, 'pageId' | 'latencyMs'>,
): Promise<{ row: StoredCareerPage; outcome: CrawlOutcome; store: FakeStore }> {
  const store = makeFake([seed]);
  const outcomes = await crawlBatch(10, { now: NOW }, { store, probe: fixedProbe(outcome) });
  const row = store.rows.get(seed.id);
  if (!row) throw new Error('seed row vanished');
  return { row, outcome: outcomes[0], store };
}

function expectedNextCheckAt(row: StoredCareerPage): number {
  return stalenessNextCheckAt(
    {
      verifyStatus: row.verifyStatus,
      verifiedAt: row.verifiedAt,
      lastCheckedAt: NOW,
      failureCount: row.failureCount,
    },
    NOW,
  ).getTime();
}

describe('write-back table, field by field', () => {
  const cases: Array<{
    name: string;
    status: CrawlOutcome['status'];
    httpStatus?: number;
    resultCount: number;
    error?: string;
  }> = [
    { name: 'ok', status: 'ok', httpStatus: 200, resultCount: 5, error: undefined },
    { name: 'empty', status: 'empty', httpStatus: 200, resultCount: 0, error: undefined },
    { name: 'blocked interstitial', status: 'blocked', httpStatus: 200, resultCount: 0, error: 'HTTP 200 with HTML login interstitial at login wall: treated as blocked, not empty' },
    { name: 'http_error', status: 'http_error', httpStatus: 500, resultCount: 0, error: 'Fetch failed 500 for https://boards.greenhouse.io/acme' },
    { name: 'timeout', status: 'timeout', httpStatus: undefined, resultCount: 0, error: 'request timed out after 15000ms' },
    { name: 'invalid redirect', status: 'invalid', httpStatus: 301, resultCount: 0, error: 'redirected to retired provider host "rippling.example.test": no routable adapter, not a timeout' },
  ];

  for (const c of cases) {
    it(`writes exactly the specified fields for ${c.name}`, async () => {
      const { row } = await crawlOneJourney(page({ id: 'p' }), {
        status: c.status,
        httpStatus: c.httpStatus,
        resultCount: c.resultCount,
        error: c.error,
      });
      // verifyStatus mirrors the outcome (ok needs resultCount > 0 by construction).
      expect(row.verifyStatus).toBe(c.status);
      // verifiedAt is set ONLY on ok/empty.
      if (c.status === 'ok' || c.status === 'empty') {
        expect(row.verifiedAt?.getTime()).toBe(NOW.getTime());
      } else {
        expect(row.verifiedAt).toBeNull();
      }
      // The mechanism actually used.
      expect(row.verifyMethod).toBe('adapter');
      expect(row.httpStatus).toBe(c.httpStatus ?? null);
      expect(row.resultCount).toBe(c.resultCount);
      expect(row.lastCheckedAt?.getTime()).toBe(NOW.getTime());
      // failureCount: reset on verified ok/empty, +1 on failure.
      expect(row.failureCount).toBe(c.status === 'ok' || c.status === 'empty' ? 0 : 3);
      // lastError carries the bounded error (or clears on clean success).
      if (c.error) {
        expect(row.lastError).toContain(c.error.slice(0, 40));
        expect(row.lastError!.length).toBeLessThanOrEqual(LAST_ERROR_MAX_CHARS);
      } else {
        expect(row.lastError).toBeNull();
      }
      // nextCheckAt comes from staleness under the injected clock.
      expect(row.nextCheckAt?.getTime()).toBe(expectedNextCheckAt(row));
    });
  }

  it('a blocked interstitial is blocked, NOT empty', async () => {
    const { row } = await crawlOneJourney(page({ id: 'p' }), {
      status: 'blocked',
      httpStatus: 200,
      resultCount: 0,
      error: 'HTTP 200 with HTML login interstitial: blocked, not empty',
    });
    expect(row.verifyStatus).toBe('blocked');
    expect(row.verifyStatus).not.toBe('empty');
    expect(row.verifiedAt).toBeNull();
  });

  it('verifiedAt set on empty even with zero postings', async () => {
    const { row } = await crawlOneJourney(page({ id: 'p', failureCount: 4 }), {
      status: 'empty',
      httpStatus: 200,
      resultCount: 0,
    });
    expect(row.verifyStatus).toBe('empty');
    expect(row.verifiedAt?.getTime()).toBe(NOW.getTime());
    expect(row.failureCount).toBe(0);
  });
});

describe('failureCount across ok/failure sequences', () => {
  it('increments per failure and resets to 0 on ok', async () => {
    const store = makeFake([page({ id: 'p', failureCount: 0, resultCount: 0 })]);
    const run = (outcome: Omit<CrawlOutcome, 'pageId' | 'latencyMs'>): Promise<CrawlOutcome[]> => {
      // Requeue the page: a real second run happens after nextCheckAt passes.
      store.rows.get('p')!.nextCheckAt = null;
      return crawlBatch(10, { now: NOW }, { store, probe: fixedProbe(outcome) });
    };
    await run({ status: 'http_error', httpStatus: 500, resultCount: 0, error: 'boom 1' });
    expect(store.rows.get('p')?.failureCount).toBe(1);
    await run({ status: 'timeout', resultCount: 0, error: 'boom 2' });
    expect(store.rows.get('p')?.failureCount).toBe(2);
    await run({ status: 'ok', httpStatus: 200, resultCount: 3 });
    const row = store.rows.get('p');
    expect(row?.failureCount).toBe(0);
    expect(row?.verifyStatus).toBe('ok');
    expect(row?.lastError).toBeNull();
  });
});

describe('provider correction with audit (never silent)', () => {
  it('writes the corrected provider/boardToken AND retains the previous value', async () => {
    const { row } = await crawlOneJourney(page({ id: 'p' }), {
      status: 'ok',
      httpStatus: 200,
      resultCount: 2,
      observedProvider: 'ashby',
      observedBoardToken: 'acme2',
    });
    expect(row.provider).toBe('ashby');
    expect(row.boardToken).toBe('acme2');
    expect(row.lastError).toMatch(/greenhouse/);
    expect(row.lastError).toMatch(/acme/);
    expect(row.lastError).toMatch(/ashby/);
    expect(row.lastError).toMatch(/corrected/);
  });

  it('an observed unknown/removed host retains the stored provider', async () => {
    const { row } = await crawlOneJourney(page({ id: 'p' }), {
      status: 'ok',
      httpStatus: 200,
      resultCount: 2,
      observedProvider: 'rippling',
      observedBoardToken: 'acme',
    });
    expect(row.provider).toBe('greenhouse');
    expect(row.boardToken).toBe('acme');
    expect(row.lastError ?? '').not.toMatch(/corrected/);
  });

  it('an identical observed provider writes no audit', async () => {
    const { row } = await crawlOneJourney(page({ id: 'p' }), {
      status: 'ok',
      httpStatus: 200,
      resultCount: 2,
      observedProvider: 'greenhouse',
      observedBoardToken: 'acme',
    });
    expect(row.provider).toBe('greenhouse');
    expect(row.lastError).toBeNull();
  });
});

describe('SUSPECT resultCount drops stay visible', () => {
  it('a 200 -> 1 collapse is still ok but recorded SUSPECT', async () => {
    const { row } = await crawlOneJourney(page({ id: 'p', resultCount: 200 }), {
      status: 'ok',
      httpStatus: 200,
      resultCount: 1,
    });
    expect(row.verifyStatus).toBe('ok');
    expect(row.lastError).toMatch(/SUSPECT/);
    expect(row.lastError).toMatch(/200 -> 1/);
  });

  it('a small fluctuation is not flagged', async () => {
    const { row } = await crawlOneJourney(page({ id: 'p', resultCount: 200 }), {
      status: 'ok',
      httpStatus: 200,
      resultCount: 190,
    });
    expect(row.verifyStatus).toBe('ok');
    expect(row.lastError).toBeNull();
  });

  it('T904: writing rawResultCount=60 against stored=200 produces no SUSPECT-drop', async () => {
    // The Full sweep's write-back stores `rawResultCount ?? resultCount`
    // so an ok page whose true yield is 60 (above any perSourceResultCap)
    // keeps the stored row at 60, NOT at the post-cap slice. The SUSPECT-
    // drop rule's "previous >= 20 AND new*10 <= previous" predicate must
    // NOT fire on this pair (60 >= 20, but 60*10=600 > 200).
    const stored = page({ id: 'p', resultCount: 200, failureCount: 0 });
    const detail = buildVerificationUpdate(
      stored,
      {
        pageId: 'p',
        status: 'ok',
        // The route passes rawResultCount here (uncapped, 60).
        resultCount: 60,
        latencyMs: 1,
      },
      NOW,
    );
    expect(detail.suspectDrop).toBe(false);
    expect(detail.update.resultCount).toBe(60);
    expect(detail.update.lastError).toBeNull();
  });
});

describe('skipped tiers retain state but advance nextCheckAt', () => {
  it('retains verifyStatus/verifiedAt/failureCount and records the reason', async () => {
    const seed = page({
      id: 'p',
      verifyStatus: 'ok',
      verifiedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
      resultCount: 12,
      failureCount: 0,
      lastError: null,
      tier: 4,
      provider: null,
      boardToken: null,
    });
    const { row } = await crawlOneJourney(seed, {
      status: 'skipped',
      resultCount: 0,
      error: 'browser engine absent: tier 4 not servable in this runtime',
    });
    expect(row.verifyStatus).toBe('ok');
    expect(row.verifiedAt?.getTime()).toBe(seed.verifiedAt?.getTime());
    expect(row.failureCount).toBe(0);
    expect(row.verifyMethod).toBe('browser');
    expect(row.lastCheckedAt?.getTime()).toBe(NOW.getTime());
    expect(row.lastError).toMatch(/browser engine absent/);
    // Advanced on the normal curve (fresh ok page: verifiedAt + 7d, in the future).
    expect(row.nextCheckAt?.getTime()).toBe(expectedNextCheckAt(row));
    expect(row.nextCheckAt!.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('verifyMethod per tier', () => {
  it('tier-3 pages record the page mechanism', async () => {
    const { row } = await crawlOneJourney(
      page({ id: 'p', provider: null, boardToken: null, tier: 3 }),
      { status: 'ok', httpStatus: 200, resultCount: 2 },
    );
    expect(row.verifyMethod).toBe('page');
  });
});

describe('global vs per-user state (no-write assertion)', () => {
  it('registry verification touches ONLY the verification store surface', async () => {
    const store = makeFake([
      page({ id: 'a', nextCheckAt: null }),
      page({ id: 'b', nextCheckAt: null }),
    ]);
    const outcomes = await crawlBatch(
      10,
      { now: NOW },
      {
        store,
        probe: async (unit) => ({
          pageId: unit.pageId,
          status: 'ok',
          httpStatus: 200,
          resultCount: 1,
          latencyMs: 1,
        }),
      },
    );
    expect(outcomes).toHaveLength(2);
    // The ONLY store interactions are the bounded read and the per-page
    // verification write. The CrawlStore interface exposes no other table,
    // so a registry result cannot land anywhere else.
    expect(store.calls).toContain('listDue');
    const writes = store.calls.filter((c) => c === 'writeVerification');
    expect(writes).toHaveLength(2);
    for (const call of store.calls) {
      expect(['listDue', 'readForUpdate', 'writeVerification']).toContain(call);
    }
  });
});

describe('lastError bound', () => {
  it('truncates an over-long transport error to the 500-char convention', async () => {
    const { row } = await crawlOneJourney(page({ id: 'p' }), {
      status: 'http_error',
      httpStatus: 500,
      resultCount: 0,
      error: `x`.repeat(600),
    });
    expect(row.lastError?.length).toBe(LAST_ERROR_MAX_CHARS);
  });
});
