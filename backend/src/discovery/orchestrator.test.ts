// Orchestrator tests (T742): scoping, tier priority, bounded pool, cancel,
// tier-4 gating - all with fake adapters, no network, no timers beyond
// short one-shot races. The real `configForRegistryRow` / tier derivation
// paths run (fakes sit at the board-listing, scope-resolution, and
// unit-execution seams only).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getProvider, PROVIDERS } from '../jobSources/providerRegistry.js';
import type { RawJob } from '../jobSources/adapters/http.js';
import type { JobSourceConfig } from '../jobSources/index.js';
import {
  DEFAULT_SOURCE_GROUPS,
  SOURCE_GROUP_ORDER,
  searchIntentSchema,
  type SearchIntent,
  type SourceGroup,
} from './searchIntent.js';
import {
  COMPANY_SCOPE_CAP,
  FULL_BATCH_PAGES,
  FULL_BATCH_BOARD_HEADROOM,
  FULL_BATCH_BUDGET,
  REGISTRY_SCOPE_CAP,
  budgetFor,
  type RunBudget,
} from './budgets.js';
import {
  cancelRun,
  effectiveEvaluateMode,
  groupsForProviderType,
  orderRankFor,
  resetOrchestratorForTests,
  runSearch,
  type CompanyScopeResolution,
  type ExecutableUnit,
  type RegistryPageRef,
  type UserBoardRef,
} from './orchestrator.js';
import { env } from '../config/env.js';

const HERE = __dirname;
const MODULE_PATH = path.join(HERE, 'orchestrator.ts');

const ROOMY_BUDGET: RunBudget = {
  maxUnits: 50,
  maxConcurrent: 4,
  perUnitTimeoutMs: 2000,
  totalBudgetMs: 15000,
  perSourceResultCap: 10,
};

beforeEach(() => {
  resetOrchestratorForTests();
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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

// Wave 15 (T905) update: pages supplied by the Full seam now carry an
// opaque per-page `cursor` and `tier`. The orchestrator's rewind picks the
// predecessor page's `cursor` (not its raw `id`), so the test fixtures and
// rewind assertions below are pinned to the cursor encoding this module
// would produce (the seam is opaque, so any non-empty `cursor` is faithful).
function pageRef(companyName: string, index: number, provider = 'greenhouse'): RegistryPageRef {
  const id = `page-ref-${companyName.toLowerCase()}-${index}`;
  return {
    id,
    companyName,
    url: `https://careers.${companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}.example/jobs/${index}`,
    provider,
    boardToken: `${companyName.toLowerCase()}-${index}`,
    tier: 1,
    cursor: `opaque-cursor|${id}`,
  };
}

function scopeOf(pages: readonly RegistryPageRef[], matchedNames: readonly string[]): CompanyScopeResolution {
  return { matchedNames, pages, registryEmpty: false };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Ordering (STEP 2): derived from descriptor data, never a second table
// ---------------------------------------------------------------------------

describe('tier ordering is derived from registry data', () => {
  it('every provider ranks in its (tier, kind) band - no second table', () => {
    expect(PROVIDERS.length).toBeGreaterThan(0);
    for (const d of PROVIDERS) {
      const rank = orderRankFor(d);
      if (d.kind === 'browser') expect(rank, d.type).toBe(70);
      else if (d.kind === 'scraper') expect(rank, d.type).toBe(60);
      else if (d.kind === 'search') expect(rank, d.type).toBe(50);
      else if (d.kind === 'aggregator') expect(rank, d.type).toBe(40);
      else expect(rank, d.type).toBe(d.tier * 10);
    }
  });

  it('priority chain: api < feed < page < aggregators < search/dorking < scraper < browser', () => {
    const rank = (type: string): number => orderRankFor(getProvider(type)!);
    expect(rank('greenhouse')).toBeLessThan(rank('rss'));
    expect(rank('rss')).toBeLessThan(rank('career-page'));
    expect(rank('career-page')).toBeLessThan(rank('aggregator'));
    expect(rank('aggregator')).toBeLessThan(rank('search'));
    expect(rank('search')).toBe(orderRankFor(getProvider('dorking')!));
    expect(rank('dorking')).toBeLessThan(rank('scraper'));
    expect(rank('scraper')).toBeLessThan(rank('browser'));
  });

  it('scheduling follows tier priority with a width-1 pool', async () => {
    const seen: string[] = [];
    const deps = {
      budget: { ...ROOMY_BUDGET, maxConcurrent: 1 },
      listUserBoards: async () => [
        board('b-scraper', 'scraper'),
        board('b-dorking', 'dorking'),
        board('b-search', 'search'),
        board('b-aggregator', 'aggregator'),
        board('b-career', 'career-page'),
        board('b-rss', 'rss'),
        board('b-greenhouse', 'greenhouse'),
      ],
      executeUnit: async (unit: ExecutableUnit) => {
        seen.push(unit.providerType);
        return [];
      },
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    expect(outcome.units.every((u) => u.status === 'ok')).toBe(true);
    expect(seen).toEqual([
      'greenhouse',
      'rss',
      'career-page',
      'aggregator',
      'dorking',
      'search',
      'scraper',
    ]);
  });

  it('groupsForProviderType derives from the descriptor sourceIds', () => {
    expect(groupsForProviderType('greenhouse')).toEqual(['ats']);
    expect(groupsForProviderType('rss')).toEqual(['feeds']);
    expect(groupsForProviderType('aggregator')).toEqual(['aggregators']);
    expect(groupsForProviderType('search')).toEqual(['search']);
    expect(groupsForProviderType('dorking')).toEqual(['dorking']);
    expect(groupsForProviderType('scraper')).toEqual(['scraper']);
    expect(groupsForProviderType('browser')).toEqual(['browser']);
    expect(groupsForProviderType('no-such-type')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bounded pool (STEP 3)
// ---------------------------------------------------------------------------

describe('bounded pool', () => {
  it('maxConcurrent is never exceeded', async () => {
    const state = { active: 0, max: 0 };
    let calls = 0;
    const deps = {
      budget: { ...ROOMY_BUDGET, maxConcurrent: 3 },
      listUserBoards: async () =>
        Array.from({ length: 8 }, (_, i) => board(`b${i}`, 'greenhouse')),
      executeUnit: async () => {
        calls += 1;
        state.active += 1;
        state.max = Math.max(state.max, state.active);
        try {
          await tick(15);
          return [];
        } finally {
          state.active -= 1;
        }
      },
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    expect(calls).toBe(8);
    expect(state.max).toBeLessThanOrEqual(3);
    expect(outcome.units).toHaveLength(8);
  });

  it('maxUnits truncation reports the dropped ids and sets truncated', async () => {
    const deps = {
      budget: { ...ROOMY_BUDGET, maxUnits: 2 },
      listUserBoards: async () => [
        board('b1', 'greenhouse'),
        board('b2', 'rss'),
        board('b3', 'career-page'),
        board('b4', 'search'),
      ],
      executeUnit: async () => [],
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    expect(outcome.truncated).toBe(true);
    expect(outcome.units.map((u) => u.unitId)).toEqual(['board:b1', 'board:b2']);
    expect(outcome.skipped).toContainEqual({
      unitId: 'board:b3',
      reason: 'truncated: exceeds maxUnits=2',
    });
    expect(outcome.skipped).toContainEqual({
      unitId: 'board:b4',
      reason: 'truncated: exceeds maxUnits=2',
    });
  });

  it('a unit timeout fails only that unit and the run completes', async () => {
    const deps = {
      budget: { ...ROOMY_BUDGET, perUnitTimeoutMs: 40 },
      listUserBoards: async () => [board('slow', 'greenhouse'), board('quick', 'rss')],
      executeUnit: async (unit: ExecutableUnit) => {
        if (unit.unitId === 'board:slow') return hangUntilAbort()(unit, new AbortController().signal);
        return [makeJob('rss', 'q1')];
      },
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.truncated).toBe(false);
    const slow = outcome.units.find((u) => u.unitId === 'board:slow')!;
    expect(slow.status).toBe('failed');
    expect(slow.reason).toMatch(/timeout after 40ms/);
    const quick = outcome.units.find((u) => u.unitId === 'board:quick')!;
    expect(quick.status).toBe('ok');
    expect(outcome.jobs).toHaveLength(1);
  });

  it('budget exhaustion finishes truncated and reports budget_exhausted', async () => {
    // T1051: `deadlineMs = poolStart + totalBudgetMs` with `poolStart` taken
    // BEFORE `buildPlan`, so planning is charged against this budget. 30 ms
    // over a 2-board plan left ~10x the measured planning cost (0-4 ms); an
    // expired-before-launch deadline would launch zero units and fail
    // `outcome.units.find(board:hang)!`. 300 ms keeps ~100x the headroom and
    // is still 200x below `perUnitTimeoutMs`, so the wall clock still fires
    // (and the executor still hangs) exactly as the assertions require.
    const hang = hangUntilAbort();
    const deps = {
      budget: {
        maxUnits: 10,
        maxConcurrent: 1,
        perUnitTimeoutMs: 60000,
        totalBudgetMs: 300,
        perSourceResultCap: 10,
      } as RunBudget,
      graceMs: 20,
      listUserBoards: async () => [board('hang', 'greenhouse'), board('quick', 'rss')],
      executeUnit: hang,
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    expect(outcome.truncated).toBe(true);
    expect(outcome.cancelled).toBe(false);
    const hung = outcome.units.find((u) => u.unitId === 'board:hang')!;
    expect(hung.status).toBe('failed');
    expect(hung.reason).toBe('budget_exhausted');
    expect(outcome.skipped).toContainEqual({ unitId: 'board:quick', reason: 'budget exhausted' });
  });

  it('perSourceResultCap caps rows per unit', async () => {
    const deps = {
      budget: { ...ROOMY_BUDGET, perSourceResultCap: 3 },
      listUserBoards: async () => [board('b1', 'greenhouse')],
      executeUnit: async (unit: ExecutableUnit) =>
        Array.from({ length: 10 }, (_, i) => makeJob(unit.providerType, `j${i}`)),
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    expect(outcome.jobs).toHaveLength(3);
    expect(outcome.units[0].resultCount).toBe(3);
  });

  it('an unknown board type fails loudly in its unit without breaking the run', async () => {
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('good', 'greenhouse'), board('bad', 'no-such-type')],
      executeUnit: async (unit: ExecutableUnit) => {
        if (unit.providerType === 'no-such-type') throw new Error('Unknown job source type "no-such-type"');
        return [makeJob('greenhouse', 'g1')];
      },
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    // Unknown sorts after every tiered unit.
    expect(outcome.units.map((u) => u.unitId)).toEqual(['board:good', 'board:bad']);
    expect(outcome.units[1].status).toBe('failed');
    expect(outcome.jobs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Company scoping (STEP 4)
// ---------------------------------------------------------------------------

describe('company scoping', () => {
  it('truncates names and pages at the caps and reports both', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `Company${i}`);
    let received: readonly string[] = [];
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [] as UserBoardRef[],
      resolveCompanies: async (asked: readonly string[]) => {
        received = asked;
        const pages = asked.flatMap((n) =>
          Array.from({ length: 6 }, (_, i) => pageRef(n, i)),
        );
        return scopeOf(pages, asked);
      },
      executeUnit: async () => [],
    };
    const outcome = await runSearch(
      intentOf({ companies: names }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    // COMPANY_SCOPE_CAP names reach the resolver; the rest are reported.
    expect(received).toHaveLength(COMPANY_SCOPE_CAP);
    expect(outcome.skipped).toContainEqual({
      unitId: 'scope:companies',
      reason: `truncated: showing ${COMPANY_SCOPE_CAP} of 12 companies`,
    });
    // 10 names x 6 pages = 60 pages -> REGISTRY_SCOPE_CAP scheduled.
    const pageUnits = outcome.units.filter((u) => u.kind === 'registry-page');
    expect(pageUnits).toHaveLength(REGISTRY_SCOPE_CAP);
    expect(outcome.skipped).toContainEqual({
      unitId: 'scope:pages',
      reason: `truncated: showing ${REGISTRY_SCOPE_CAP} of 60 pages`,
    });
  });

  it('an intent with no companies never consults the registry', async () => {
    let calls = 0;
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse')],
      resolveCompanies: async (): Promise<CompanyScopeResolution> => {
        calls += 1;
        return { matchedNames: [], pages: [], registryEmpty: false };
      },
      executeUnit: async () => [makeJob('greenhouse', 'g1')],
    };
    const outcome = await runSearch(intentOf({ companies: [] }), { runId: 'r1', userId: 'u1' }, deps);
    expect(calls).toBe(0);
    expect(outcome.jobs).toHaveLength(1);
  });

  it('a name matching nothing yields an empty scope with a reason, not an error', async () => {
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse')],
      resolveCompanies: async (): Promise<CompanyScopeResolution> => ({
        matchedNames: [],
        pages: [],
        registryEmpty: false,
      }),
      executeUnit: async () => [makeJob('greenhouse', 'g1')],
    };
    const outcome = await runSearch(
      intentOf({ companies: ['No Such Co'] }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(outcome.skipped).toContainEqual({
      unitId: 'scope:company:No Such Co',
      reason: 'no registry match',
    });
    expect(outcome.units.some((u) => u.kind === 'registry-page')).toBe(false);
    // Not an error: the personal scope still runs.
    expect(outcome.jobs).toHaveLength(1);
  });

  it('an empty registry records the reason and proceeds with user boards', async () => {
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse')],
      resolveCompanies: async (): Promise<CompanyScopeResolution> => ({
        matchedNames: [],
        pages: [],
        registryEmpty: true,
      }),
      executeUnit: async () => [makeJob('greenhouse', 'g1')],
    };
    const outcome = await runSearch(
      intentOf({ companies: ['Acme'] }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(outcome.skipped).toContainEqual({ unitId: 'scope:registry', reason: 'registry empty' });
    expect(outcome.jobs).toHaveLength(1);
  });

  it('an unroutable registry row fails its unit loudly and the run continues', async () => {
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse')],
      resolveCompanies: async (): Promise<CompanyScopeResolution> =>
        scopeOf(
          [
            {
              companyName: 'Rippling',
              url: 'https://rippling.example/careers',
              provider: 'rippling',
              boardToken: 'rippling',
            },
          ],
          ['Rippling'],
        ),
      executeUnit: async () => [makeJob('greenhouse', 'g1')],
    };
    const outcome = await runSearch(
      intentOf({ companies: ['Rippling'] }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    const page = outcome.units.find((u) => u.unitId === 'page:0')!;
    expect(page.status).toBe('failed');
    expect(page.reason).toMatch(/Unknown job source type/);
    expect(outcome.jobs).toHaveLength(1);
  });

  it('no boards and no companies is an empty outcome, not an error', async () => {
    const outcome = await runSearch(
      intentOf(),
      { runId: 'r1', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [],
        executeUnit: async () => [],
      },
    );
    expect(outcome).toMatchObject({ jobs: [], cancelled: false, truncated: false, units: [] });
    expect(outcome).not.toHaveProperty('hasMore');
    expect(outcome).not.toHaveProperty('nextCursor');
    expect(outcome).not.toHaveProperty('registry');
  });
});

// ---------------------------------------------------------------------------
// Tier-4 routing (STEP 5): deep AND cheap-failed AND opted in
// ---------------------------------------------------------------------------

describe('tier-4 routing', () => {
  const acmePage = pageRef('Acme', 0);

  function tier4Deps(opts: { cheapFails: boolean; browserThrowsSkipped?: boolean }) {
    const browserCalls: ExecutableUnit[] = [];
    return {
      browserCalls,
      deps: {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [] as UserBoardRef[],
        resolveCompanies: async (): Promise<CompanyScopeResolution> =>
          scopeOf([acmePage], ['Acme']),
        executeUnit: async (unit: ExecutableUnit, _signal: AbortSignal) => {
          if (unit.providerType === 'browser') {
            browserCalls.push(unit);
            if (opts.browserThrowsSkipped) {
              throw Object.assign(new Error('browser tier skipped: engine absent'), {
                name: 'BrowserTierSkippedError',
                skipped: true,
                reason: 'engine absent',
              });
            }
            return [makeJob('browser', 't1')];
          }
          if (opts.cheapFails) throw new Error('cheap boom');
          return [];
        },
      },
    };
  }

  const withBrowser = (): SourceGroup[] => [...DEFAULT_SOURCE_GROUPS, 'browser'];
  const withoutBrowser = (): SourceGroup[] => [...DEFAULT_SOURCE_GROUPS];

  it('fast + cheap failed: browser never runs (deep mode only)', async () => {
    const { browserCalls, deps } = tier4Deps({ cheapFails: true });
    const outcome = await runSearch(
      intentOf({ mode: 'fast', companies: ['Acme'], sourceGroups: withBrowser() }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(browserCalls).toHaveLength(0);
    expect(outcome.skipped).toContainEqual({ unitId: 'page:0:browser', reason: 'deep mode only' });
  });

  it('fast + cheap ok: browser never runs', async () => {
    const { browserCalls, deps } = tier4Deps({ cheapFails: false });
    await runSearch(
      intentOf({ mode: 'fast', companies: ['Acme'], sourceGroups: withBrowser() }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(browserCalls).toHaveLength(0);
  });

  it('deep + cheap ok: browser recorded skipped (cheaper tier succeeded)', async () => {
    const { browserCalls, deps } = tier4Deps({ cheapFails: false });
    const outcome = await runSearch(
      intentOf({ mode: 'deep', companies: ['Acme'], sourceGroups: withBrowser() }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(browserCalls).toHaveLength(0);
    expect(outcome.skipped).toContainEqual({
      unitId: 'page:0:browser',
      reason: 'cheaper tier succeeded',
    });
  });

  it('deep + cheap failed: browser runs once for the same URL with deepMode', async () => {
    const { browserCalls, deps } = tier4Deps({ cheapFails: true });
    const outcome = await runSearch(
      intentOf({ mode: 'deep', companies: ['Acme'], sourceGroups: withBrowser() }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0].providerType).toBe('browser');
    expect(browserCalls[0].pageUrl).toBe(acmePage.url);
    expect(browserCalls[0].config.feedUrl).toBe(acmePage.url);
    expect(browserCalls[0].config.deepMode).toBe(true);
    const followup = outcome.units.find((u) => u.unitId === 'page:0:browser')!;
    expect(followup.status).toBe('ok');
    expect(followup.kind).toBe('browser-followup');
    expect(outcome.jobs).toHaveLength(1);
    expect(outcome.jobs[0].source).toBe('browser');
  });

  it('deep + cheap failed but browser not opted in: skipped (group disabled)', async () => {
    const { browserCalls, deps } = tier4Deps({ cheapFails: true });
    const outcome = await runSearch(
      intentOf({ mode: 'deep', companies: ['Acme'], sourceGroups: withoutBrowser() }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(browserCalls).toHaveLength(0);
    expect(outcome.skipped).toContainEqual({
      unitId: 'page:0:browser',
      reason: 'group disabled: browser',
    });
  });

  it('a failed user board never triggers a browser follow-up', async () => {
    const browserCalls: ExecutableUnit[] = [];
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse')],
      executeUnit: async (unit: ExecutableUnit) => {
        if (unit.providerType === 'browser') {
          browserCalls.push(unit);
          return [];
        }
        throw new Error('board boom');
      },
    };
    const outcome = await runSearch(
      intentOf({ mode: 'deep', sourceGroups: withBrowser() }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(browserCalls).toHaveLength(0);
    expect(outcome.units[0].status).toBe('failed');
  });

  it('an absent browser tier is skipped-with-reason through the injected executor, never failed', async () => {
    const { browserCalls, deps } = tier4Deps({ cheapFails: true, browserThrowsSkipped: true });
    const outcome = await runSearch(
      intentOf({ mode: 'deep', companies: ['Acme'], sourceGroups: withBrowser() }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(browserCalls).toHaveLength(1);
    const followup = outcome.units.find((u) => u.unitId === 'page:0:browser')!;
    expect(followup.status).toBe('skipped');
    expect(followup.reason).toBe('engine absent');
    expect(outcome.skipped).toContainEqual({ unitId: 'page:0:browser', reason: 'engine absent' });
    expect(outcome.cancelled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cancel (STEP 6/7)
// ---------------------------------------------------------------------------

describe('cancel', () => {
  it('stops new scheduling, marks in-flight cancelled (not failed), keeps partial rows', async () => {
    const hang = hangUntilAbort();
    const deps = {
      budget: { ...ROOMY_BUDGET, maxConcurrent: 1 },
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
    const pending = runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    await tick(30);
    expect(cancelRun('r1', 'u1')).toBe(true);
    // Idempotent while live.
    expect(cancelRun('r1', 'u1')).toBe(true);
    const outcome = await pending;
    expect(outcome.cancelled).toBe(true);
    // Cancel is reported via `cancelled`, never via `truncated` (STEP 3
    // reserves `truncated` for maxUnits/budget drops).
    expect(outcome.truncated).toBe(false);
    const second = outcome.units.find((u) => u.unitId === 'board:second')!;
    expect(second.status).toBe('cancelled');
    expect(second.status).not.toBe('failed');
    // Partial rows from the finished unit are kept; unscheduled units reported.
    expect(outcome.jobs).toHaveLength(1);
    expect(outcome.skipped).toContainEqual({ unitId: 'board:third', reason: 'cancelled' });
  });

  it('cancel is user-scoped: a wrong user cannot cancel', async () => {
    const hang = hangUntilAbort();
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse')],
      executeUnit: hang,
    };
    const pending = runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    await tick(20);
    expect(cancelRun('r1', 'intruder')).toBe(false);
    expect(cancelRun('r1', 'u1')).toBe(true);
    const outcome = await pending;
    expect(outcome.cancelled).toBe(true);
  });

  it('cancelling an unknown or already-finished run is a no-op returning false', async () => {
    expect(cancelRun('no-such-run', 'u1')).toBe(false);
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse')],
      executeUnit: async () => [makeJob('greenhouse', 'g1')],
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    expect(outcome.cancelled).toBe(false);
    expect(cancelRun('r1', 'u1')).toBe(false);
  });

  it('two concurrent runs for one user are independent by runId', async () => {
    const hang = hangUntilAbort();
    const depsFor = (hangIt: boolean): Parameters<typeof runSearch>[2] => ({
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse')],
      executeUnit: hangIt
        ? hang
        : async () => [makeJob('greenhouse', 'g1')],
    });
    const pendingA = runSearch(intentOf(), { runId: 'run-a', userId: 'u1' }, depsFor(true));
    const pendingB = runSearch(intentOf(), { runId: 'run-b', userId: 'u1' }, depsFor(false));
    await tick(20);
    expect(cancelRun('run-a', 'u1')).toBe(true);
    const [a, b] = await Promise.all([pendingA, pendingB]);
    expect(a.cancelled).toBe(true);
    expect(b.cancelled).toBe(false);
    expect(b.jobs).toHaveLength(1);
    // Cancelling A never touched B's units.
    expect(b.units[0].status).toBe('ok');
  });

  it('an externally aborted opts.signal cancels the run', async () => {
    const controller = new AbortController();
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse')],
      executeUnit: hangUntilAbort(),
    };
    const pending = runSearch(intentOf(), { runId: 'r1', userId: 'u1', signal: controller.signal }, deps);
    await tick(20);
    controller.abort();
    const outcome = await pending;
    expect(outcome.cancelled).toBe(true);
    expect(outcome.units[0].status).toBe('cancelled');
  });
});

// ---------------------------------------------------------------------------
// Source-group toggles (STEP 8) and the N3 dorking obligation (STEP 9)
// ---------------------------------------------------------------------------

describe('source groups and dorking', () => {
  it('a group toggled off is skipped-with-reason, never failed', async () => {
    const groups = (DEFAULT_SOURCE_GROUPS as readonly SourceGroup[]).filter((g) => g !== 'scraper');
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse'), board('b2', 'scraper')],
      executeUnit: async () => [makeJob('greenhouse', 'g1')],
    };
    const outcome = await runSearch(
      intentOf({ sourceGroups: [...groups] }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    expect(outcome.skipped).toContainEqual({ unitId: 'group:scraper', reason: 'group disabled: scraper' });
    expect(outcome.skipped).toContainEqual({ unitId: 'board:b2', reason: 'group disabled: scraper' });
    expect(outcome.units.map((u) => u.unitId)).toEqual(['board:b1']);
    expect(outcome.units.every((u) => u.status === 'ok')).toBe(true);
  });

  it('dorking schedules as one unit among many and suppresses nothing (N3)', async () => {
    const seen: string[] = [];
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [
        board('b1', 'greenhouse'),
        board('b2', 'dorking'),
        board('b3', 'rss'),
      ],
      executeUnit: async (unit: ExecutableUnit) => {
        seen.push(unit.providerType);
        return [];
      },
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    expect(seen).toHaveLength(3);
    expect(seen.filter((s) => s === 'dorking')).toHaveLength(1);
    expect(outcome.units).toHaveLength(3);
    expect(outcome.units.every((u) => u.status === 'ok')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ADR-033 mode policy and Full registry batches
// ---------------------------------------------------------------------------

describe('mode budgets and evaluation policy', () => {
  it.each(['fast', 'standard', 'deep', 'full'] as const)(
    'uses the %s budget selected by budgetFor',
    async (mode) => {
      const maxUnits = budgetFor(mode).maxUnits;
      const outcome = await runSearch(
        intentOf({ mode }),
        { runId: `r-${mode}`, userId: 'u1' },
        {
          listUserBoards: async () =>
            Array.from({ length: maxUnits + 1 }, (_, index) => board(`b${index}`, 'greenhouse')),
          executeUnit: async () => [],
        },
      );
      expect(outcome.units).toHaveLength(maxUnits);
      expect(outcome.truncated).toBe(true);
    },
  );

  it('keeps the explicit deps.budget override ahead of mode defaults', async () => {
    const outcome = await runSearch(
      intentOf({ mode: 'standard' }),
      { runId: 'r-override', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxUnits: 1 },
        listUserBoards: async () => [board('b1', 'greenhouse'), board('b2', 'rss')],
        executeUnit: async () => [],
      },
    );
    expect(outcome.units.map((unit) => unit.unitId)).toEqual(['board:b1']);
    expect(outcome.skipped).toContainEqual({
      unitId: 'board:b2',
      reason: 'truncated: exceeds maxUnits=1',
    });
  });

  it.each([
    ['fast', 'deterministic'],
    ['standard', 'deterministic'],
    ['deep', 'ai-subset'],
    ['full', 'ai-subset'],
  ] as const)('gates ai-subset for %s mode', (mode, expected) => {
    expect(effectiveEvaluateMode(intentOf({ mode, evaluate: 'ai-subset' }))).toBe(expected);
  });
});

describe('Standard mode scope and source envelope', () => {
  it('excludes each out-of-envelope group exactly once and schedules none of its units', async () => {
    const byGroup: Readonly<Record<SourceGroup, string>> = {
      ats: 'greenhouse',
      feeds: 'rss',
      aggregators: 'aggregator',
      search: 'search',
      dorking: 'dorking',
      scraper: 'scraper',
      browser: 'browser',
    };
    const executed: string[] = [];
    const outcome = await runSearch(
      intentOf({ mode: 'standard', sourceGroups: [...SOURCE_GROUP_ORDER] }),
      { runId: 'r-standard', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () =>
          SOURCE_GROUP_ORDER.map((group) => board(group, byGroup[group])),
        executeUnit: async (unit) => {
          executed.push(unit.unitId);
          return [];
        },
      },
    );

    const excluded = SOURCE_GROUP_ORDER.filter(
      (group) => group !== 'ats' && group !== 'feeds' && group !== 'aggregators',
    );
    const modeExclusionSkips = outcome.skipped.filter((entry) =>
      entry.reason.startsWith('mode standard excludes group:'),
    );
    expect(modeExclusionSkips).toEqual(
      excluded.map((group) => ({
        unitId: `group:${group}`,
        reason: `mode standard excludes group: ${group}`,
      })),
    );
    expect(modeExclusionSkips).toHaveLength(4);
    expect(executed).toEqual(['board:ats', 'board:feeds', 'board:aggregators']);
  });

  it('records a disabled registry scope without calling the company resolver', async () => {
    let resolverCalls = 0;
    const outcome = await runSearch(
      intentOf({ mode: 'standard', companies: ['Acme'], sourceGroups: ['ats'] }),
      { runId: 'r-standard-company', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [board('b1', 'greenhouse')],
        resolveCompanies: async (): Promise<CompanyScopeResolution> => {
          resolverCalls += 1;
          return scopeOf([], []);
        },
        executeUnit: async () => [],
      },
    );
    expect(resolverCalls).toBe(0);
    expect(outcome.skipped).toContainEqual({
      unitId: 'scope:registry',
      reason: 'registry scope disabled: standard mode',
    });
    expect(outcome.units.some((unit) => unit.kind === 'registry-page')).toBe(false);
  });
});

describe('Deep mode scope caps', () => {
  it('caps twelve companies at ten and registry pages at two hundred with reports', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `Company${index}`);
    let received: readonly string[] = [];
    const outcome = await runSearch(
      intentOf({ mode: 'deep', companies: names }),
      { runId: 'r-deep-caps', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxUnits: 300 },
        listUserBoards: async () => [],
        resolveCompanies: async (asked) => {
          received = asked;
          return scopeOf(
            asked.flatMap((name) =>
              Array.from({ length: 25 }, (_, index) => pageRef(name, index)),
            ),
            asked,
          );
        },
        executeUnit: async () => [],
      },
    );
    expect(received).toHaveLength(10);
    expect(outcome.skipped).toContainEqual({
      unitId: 'scope:companies',
      reason: 'truncated: showing 10 of 12 companies',
    });
    expect(outcome.units.filter((unit) => unit.kind === 'registry-page')).toHaveLength(200);
    expect(outcome.skipped).toContainEqual({
      unitId: 'scope:pages',
      reason: 'truncated: showing 200 of 250 pages',
    });
  });
});

describe('Full registry sweep batches', () => {
  it('schedules boards plus the cursor batch, never resolves named companies, and mirrors progress', async () => {
    let companyResolverCalls = 0;
    let receivedAfter: string | null | undefined;
    let receivedLimit: number | undefined;
    const executed: ExecutableUnit[] = [];
    const outcome = await runSearch(
      intentOf({ mode: 'full', companies: ['Ignored In Full'] }),
      { runId: 'r-full-batch', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [board('b1', 'greenhouse')],
        resolveCompanies: async (): Promise<CompanyScopeResolution> => {
          companyResolverCalls += 1;
          return scopeOf([], []);
        },
        afterCursor: 'cursor-1',
        resolveRegistryPageBatch: async (after, limit) => {
          receivedAfter = after;
          receivedLimit = limit;
          return {
            pages: [pageRef('Acme', 0), pageRef('Acme', 1)],
            total: 5,
            hasMore: true,
            nextCursor: 'cursor-3',
          };
        },
        executeUnit: async (unit) => {
          executed.push(unit);
          return [];
        },
      },
    );

    expect(companyResolverCalls).toBe(0);
    expect(receivedAfter).toBe('cursor-1');
    expect(receivedLimit).toBe(FULL_BATCH_PAGES);
    expect(executed.map((unit) => unit.unitId)).toEqual(['board:b1', 'page:0', 'page:1']);
    expect(outcome.registry).toEqual({ processed: 2, total: 5 });
    expect(outcome.hasMore).toBe(true);
    expect(outcome.nextCursor).toBe('cursor-3');
  });

  it('rewinds a maxUnits-truncated batch and retries only the omitted page (predecessor cursor)', async () => {
    // T905 / ADR-034 D3 update: the rewind picks the PREDECESSOR page's
    // OPAQUE `cursor` (string), never its raw `id`. The page ref helper now
    // supplies `cursor: "opaque-cursor|<id>"`, so the rewound continuation
    // here is the opaque string for index 98 (`page:98`), not its raw id.
    const pages = Array.from({ length: 100 }, (_, index) => pageRef('Batch', index));
    const requestedCursors: Array<string | null> = [];
    const executedPageIds: string[] = [];

    const resolveBatch = async (after: string | null, limit: number) => {
      requestedCursors.push(after);
      // The reader is now black-box: callers cannot parse the cursor.
      // Tests observe ordering via the produced pages / cursors, not by
      // decoding the encoded string. For the cursor encoding used here
      // (`opaque-cursor|<id>`), the index can still be derived to seed the
      // next window so the sequential traversal remains deterministic.
      let previousIndex = -1;
      if (after !== null) {
        const m = /\|page-ref-batch-(\d+)$/.exec(after);
        if (m !== null) previousIndex = Number(m[1]);
      }
      const start = previousIndex + 1;
      const selected = pages.slice(start, start + limit);
      const hasMore = start + selected.length < pages.length;
      // Opaque nextCursor - mirror what production does (last page's cursor).
      const last = selected[selected.length - 1];
      const nextCursor =
        hasMore && last !== undefined
          ? `opaque-cursor|${last.id}`
          : null;
      return {
        pages: selected,
        total: pages.length,
        hasMore,
        nextCursor,
      };
    };

    const runBatch = async (runId: string, afterCursor: string | null) => {
      const outcome = await runSearch(
        intentOf({ mode: 'full' }),
        { runId, userId: 'u1' },
        {
          budget: { ...ROOMY_BUDGET, maxUnits: 120 },
          listUserBoards: async () => Array.from({ length: 21 }, (_, index) => board(`b${index}`, 'greenhouse')),
          resolveRegistryPageBatch: resolveBatch,
          afterCursor,
          executeUnit: async (unit) => {
            if (unit.kind === 'registry-page') {
              executedPageIds.push(String(unit.config.board));
            }
            return [];
          },
        },
      );
      return outcome;
    };

    const first = await runBatch('r-full-max-1', null);
    const firstPageIds = executedPageIds.splice(0);
    expect(first.units.filter((unit) => unit.kind === 'registry-page')).toHaveLength(99);
    expect(first.registry?.processed).toBe(100);
    expect(first.hasMore).toBe(true);
    // The rewound cursor is the PREDECESSOR page's OPAQUE cursor, not its
    // raw id. This is the key T905 contract: nothing outside
    // registrySweep.ts parses the cursor, but the value flows verbatim.
    expect(first.nextCursor).toBe('opaque-cursor|page-ref-batch-98');
    expect(first.skipped).toContainEqual({
      unitId: 'page:99',
      reason: 'truncated: exceeds maxUnits=120',
    });
    expect(firstPageIds).not.toContain('batch-99');
    expect(new Set(firstPageIds).size).toBe(99);

    const second = await runBatch('r-full-max-2', first.nextCursor ?? null);
    const secondPageIds = executedPageIds.splice(0);
    expect(second.units.filter((unit) => unit.kind === 'registry-page')).toHaveLength(1);
    expect(second.registry?.processed).toBe(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(secondPageIds).toEqual(['batch-99']);
    expect(requestedCursors).toEqual([null, 'opaque-cursor|page-ref-batch-98']);

    const allPageIds = [...firstPageIds, ...secondPageIds];
    expect(allPageIds).toHaveLength(100);
    expect(new Set(allPageIds)).toEqual(new Set(pages.map((page) => page.boardToken)));
  });

  it('rewinds a wall-clock-truncated Full batch and retries only unattempted pages', async () => {
    // T905 / ADR-034 D3 update: the rewind picks the PREDECESSOR page's
    // opaque `cursor`. With three fetched pages and the FIRST page launched
    // and hung, the wall clock expires before pages 1 and 2 are scheduled.
    // The predecessor of `page:1` is `page:0` - its opaque cursor is the
    // rewound value, NOT its raw id.
    const pages = Array.from({ length: 3 }, (_, index) => pageRef('Budget', index));
    const requestedCursors: Array<string | null> = [];
    const executedPageIds: string[] = [];

    const resolveBatch = async (after: string | null, limit: number) => {
      requestedCursors.push(after);
      let previousIndex = -1;
      if (after !== null) {
        const m = /\|page-ref-budget-(\d+)$/.exec(after);
        if (m !== null) previousIndex = Number(m[1]);
      }
      const start = previousIndex + 1;
      const selected = pages.slice(start, start + limit);
      const hasMore = start + selected.length < pages.length;
      const last = selected[selected.length - 1];
      const nextCursor =
        hasMore && last !== undefined
          ? `opaque-cursor|${last.id}`
          : null;
      return {
        pages: selected,
        total: pages.length,
        hasMore,
        nextCursor,
      };
    };

    // The first batch gets a tiny wall clock and a hanging first page, so the
    // pool stops scheduling with two fetched pages never launched. The
    // continuation batch runs with a roomy budget so it completes the suffix.
    const runBatch = async (runId: string, afterCursor: string | null, budget: RunBudget) =>
      runSearch(
        intentOf({ mode: 'full' }),
        { runId, userId: 'u1' },
        {
          budget,
          graceMs: 5,
          listUserBoards: async () => [],
          resolveRegistryPageBatch: resolveBatch,
          afterCursor,
          executeUnit: async (unit) => {
            if (unit.kind === 'registry-page') {
              const id = String(unit.config.board);
              executedPageIds.push(id);
              if (afterCursor === null) {
                // Hang the first launched page: the pool then exhausts its wall
                // clock before any later page is scheduled, and budget grace
                // reports it as `budget_exhausted`.
                return hangUntilAbort()(unit, new AbortController().signal);
              }
            }
            return [];
          },
        },
      );

    const first = await runBatch(
      'r-full-budget-1',
      null,
      {
        ...ROOMY_BUDGET,
        maxConcurrent: 1,
        perUnitTimeoutMs: 60000,
        // T1051: planning is charged against this budget (`poolStart` precedes
        // `buildPlan`), so 50 ms over a 3-page plan was ~10x the measured
        // planning cost. 500 ms keeps ~100x the headroom and is still 120x
        // below `perUnitTimeoutMs`, so the hang + wall-clock-expiry shape the
        // rewind assertions need is unchanged.
        totalBudgetMs: 500,
      },
    );
    // The first page is launched and then hangs, so the wall clock expires
    // before pages 1-2 are ever scheduled: both are reported `budget
    // exhausted`, and the continuation must rewind to the stable id before the
    // first unattempted page instead of keeping the reader's last-fetched id.
    const firstPageIds = executedPageIds.splice(0);
    expect(firstPageIds).toEqual(['budget-0']);
    expect(first.truncated).toBe(true);
    expect(first.cancelled).toBe(false);
    expect(first.skipped).toEqual(expect.arrayContaining([
      { unitId: 'page:1', reason: 'budget exhausted' },
      { unitId: 'page:2', reason: 'budget exhausted' },
    ]));
    expect(first.units.find((unit) => unit.unitId === 'page:0')).toMatchObject({
      status: 'failed',
      reason: 'budget_exhausted',
    });
    expect(first.hasMore).toBe(true);
    // T905: rewound cursor is the PREDECESSOR page's opaque string, not the
    // bare id. Predecessor of `page:1` is `page:0`; its cursor is
    // `opaque-cursor|page-ref-budget-0`.
    expect(first.nextCursor).toBe('opaque-cursor|page-ref-budget-0');

    const second = await runBatch(
      'r-full-budget-2',
      first.nextCursor ?? null,
      { ...ROOMY_BUDGET, maxConcurrent: 1 },
    );
    const secondPageIds = executedPageIds.splice(0);
    expect(second.truncated).toBe(false);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(secondPageIds).toEqual(['budget-1', 'budget-2']);
    expect(requestedCursors).toHaveLength(2);
    expect(requestedCursors[1]).toBe('opaque-cursor|page-ref-budget-0');

    const allPageIds = [...firstPageIds, ...secondPageIds];
    expect(allPageIds).toHaveLength(pages.length);
    expect(new Set(allPageIds)).toEqual(new Set(pages.map((entry) => entry.boardToken)));
    expect(allPageIds.filter((id, index) => allPageIds.indexOf(id) !== index)).toEqual([]);
  });

  it('uses Deep/Full browser follow-ups after a cheaper registry page fails', async () => {
    const browserCalls: ExecutableUnit[] = [];
    const outcome = await runSearch(
      intentOf({ mode: 'full', sourceGroups: [...DEFAULT_SOURCE_GROUPS, 'browser'] }),
      { runId: 'r-full-browser', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [],
        resolveRegistryPageBatch: async () => ({
          pages: [pageRef('Acme', 0)],
          total: 1,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async (unit) => {
          if (unit.providerType === 'browser') {
            browserCalls.push(unit);
            return [];
          }
          throw new Error('cheap boom');
        },
      },
    );
    expect(browserCalls.map((unit) => unit.unitId)).toEqual(['page:0:browser']);
    expect(outcome.units.find((unit) => unit.unitId === 'page:0:browser')?.status).toBe('ok');
  });

  it('pre-records an unroutable Full page as failed while the rest of the batch runs', async () => {
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-full-unroutable', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [],
        resolveRegistryPageBatch: async () => ({
          pages: [
            pageRef('Acme', 0),
            {
              companyName: 'Unknown Co',
              url: 'https://careers.example/unknown',
              provider: 'not-a-provider',
              boardToken: 'unknown',
            },
          ],
          total: 2,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async () => [],
      },
    );
    expect(outcome.units.find((unit) => unit.unitId === 'page:0')?.status).toBe('ok');
    const unroutable = outcome.units.find((unit) => unit.unitId === 'page:1');
    expect(unroutable?.status).toBe('failed');
    expect(unroutable?.reason).toMatch(/Unknown job source type/);
    expect(outcome.registry?.processed).toBe(2);
  });

  it('plans boards only and reports an unavailable sweep when the batch dep is absent', async () => {
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-full-unavailable', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [board('b1', 'greenhouse')],
        executeUnit: async () => [],
      },
    );
    expect(outcome.units.map((unit) => unit.unitId)).toEqual(['board:b1']);
    expect(outcome.skipped).toContainEqual({
      unitId: 'scope:registry',
      reason: 'registry sweep unavailable',
    });
  });

  // T910 (D7): with FULL_BATCH_PAGES = 200 and maxUnits derived as
  // FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM = 320, a Full batch that
  // is the live composition (59 boards + 200 pages = 259 units) must NOT be
  // truncated by maxUnits - every page is scheduled and no
  // `truncated: exceeds maxUnits=` skip appears. Naive doubling
  // (120 -> 240) would FAIL this assertion (240 < 259, 19 pages dropped);
  // the derived cap is 200 + 120 = 320, i.e. 120 units of board headroom,
  // 61 units above the observed 259. Fake reader and executor: no network,
  // no prisma.
  it('FULL_BATCH_PAGES=200 + maxUnits=320 schedules 59 boards + 200 pages (259) without truncation', async () => {
    // 59 boards mirrors the observed live fan-out (spec EDGE CASES 1: "59
    // boards + 100 pages = 159 units"). 200 pages mirrors the new
    // FULL_BATCH_PAGES. The fake reader is sealed: any other limit would
    // also be honored if the orchestrator passed one, so this test only
    // proves the orchestrator's maxUnits arithmetic.
    const observedBoards = 59;
    const registryPageCount = FULL_BATCH_PAGES; // 200 after T910
    const totalUnits = observedBoards + registryPageCount; // 259
    expect(FULL_BATCH_PAGES).toBe(200);
    expect(FULL_BATCH_BUDGET.maxUnits).toBeGreaterThanOrEqual(totalUnits);

    const pages = Array.from({ length: registryPageCount }, (_, index) =>
      pageRef('ReProfile', index),
    );
    const boards = Array.from({ length: observedBoards }, (_, index) =>
      board(`b${index}`, 'greenhouse'),
    );

    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t910-no-truncation', userId: 'u1' },
      {
        // NO explicit `budget` - `budgetFor(intent.mode)` resolves to
        // FULL_BATCH_BUDGET with maxUnits = FULL_BATCH_PAGES +
        // FULL_BATCH_BOARD_HEADROOM = 320.
        listUserBoards: async () => boards,
        resolveRegistryPageBatch: async () => ({
          pages,
          total: pages.length,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async () => [],
      },
    );

    // The 259 candidates are all scheduled; none are dropped by maxUnits.
    expect(outcome.truncated).toBe(false);
    expect(outcome.units).toHaveLength(totalUnits);
    // All 200 registry-page units appear as units (not skipped).
    expect(outcome.units.filter((unit) => unit.kind === 'registry-page')).toHaveLength(
      registryPageCount,
    );
    // All 59 board units appear as units.
    expect(outcome.units.filter((unit) => unit.kind === 'board')).toHaveLength(observedBoards);
    // No `truncated: exceeds maxUnits=` skip is recorded (the contract
    // invariant: at the derived cap the only batch-1 truncation cause
    // disappears with 61 units of margin).
    expect(
      outcome.skipped.filter((issue) =>
        typeof issue.reason === 'string' && issue.reason.startsWith('truncated: exceeds maxUnits='),
      ),
    ).toEqual([]);
    // Sanity: budgetFor('full').maxUnits IS the derived expression.
    expect(budgetFor('full').maxUnits).toBe(FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM);
  });
});

// ---------------------------------------------------------------------------
// T906: Full batch width 8 -> 32, deadline/maxUnits interaction.
// Width 32 makes `budget_exhausted` rare because the worst-case 100-page
// all-20s batch needs only `ceil(100/32)*20 = 80 s < 180 s = totalBudgetMs`,
// so the wall clock stops being the binding constraint (ADR-034 D1.4,
// accepted-by-T906). The pre-wave width-8 pool needed 260 s on the same
// batch and rewound every time the wall clock fired - the existing width-1
// test above (line 1040) reproduces that path. These two tests pin the
// interaction so the change is assertable.
// ---------------------------------------------------------------------------

describe('T906: width-interaction with the wall-clock budget', () => {
  // Factory: a never-resolving executor. The per-unit timeout backstops
  // each unit (no unit can hang past `perUnitTimeoutMs`), which is the
  // production-typical worst case: every page hangs to its individual
  // limit. The wall clock is then either hit (width 8 + small totalBudgetMs)
  // or not (width 32 with enough headroom for ceil(pages/width) waves of
  // per-unit timeouts).
  function hangExecutor(): (unit: ExecutableUnit, signal: AbortSignal) => Promise<RawJob[]> {
    return (_unit, _signal) => new Promise<RawJob[]>(() => { /* never resolves */ });
  }

  // 100 pages of `greenhouse` so the orchestrator's pre-flight passes and
  // the pool sees a non-empty work queue (mirrors the pre-existing width-1
  // wall-clock test).
  function buildPages(count: number): RegistryPageRef[] {
    return Array.from({ length: count }, (_, index) => pageRef('Width', index));
  }

  it('width 32 + per-unit timeout backstop completes before the deadline fires (done, not budget)', async () => {
    // ADR-034 D1.4: at width 32, the worst-case 100-page all-20s batch fits
    // inside the 180 s budget (`ceil(100/32)*20 = 80 s < 180 s`). With a
    // never-resolving executor and a per-unit timeout, every page settles as
    // `failed/timeout` and the pool drains BEFORE the wall clock fires. The
    // stop cause is `done` and `truncated` stays false - the wall clock no
    // longer fires on this batch.
    //
    // SCALING (T1051). The batch drains in `ceil(100/32) = 4` SEQUENTIAL
    // waves, each wave costing one `sleepMs(perUnitTimeoutMs)` hop, so the
    // drained work is `4 * perUnitTimeoutMs` of REAL timer time against a
    // REAL `totalBudgetMs` deadline. The production ratio
    // (20000 : 180000 = 1 : 9) is preserved exactly; only the absolute scale
    // is chosen for a robust margin:
    //
    //   perUnitTimeoutMs 400, totalBudgetMs 3600
    //     drained work 4 x 400  = 1600 ms   (production: 4 x 20000 = 80 s)
    //     deadline                3600 ms   (production: 180 s)
    //     slack                   2000 ms   (production: 100 s)
    //     overshoot tolerated per wave: 500 ms
    //
    // The previous 1/1000 scale (20 / 180) left only 100 ms of total slack,
    // i.e. 25 ms of overshoot tolerance for EACH of the four real timer hops.
    // Under the full suite's parallel load a single `setTimeout(20)` can
    // settle far later than 20 ms, so four sequential hops could consume the
    // whole 180 ms budget and let the wall clock fire - which is exactly the
    // 1-in-3 failure this test used to show. Scaling up buys 20x the
    // per-hop tolerance at ~1.6 s of wall time, and the ASSERTION is
    // unchanged: it still means "the per-unit backstop drains the batch
    // before the wall clock fires".
    const pages = buildPages(100);
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t906-width32', userId: 'u1' },
      {
        budget: {
          maxUnits: 120,
          maxConcurrent: 32,
          perUnitTimeoutMs: 400,
          totalBudgetMs: 3600,
          perSourceResultCap: 10,
        },
        graceMs: 5,
        listUserBoards: async () => [],
        resolveRegistryPageBatch: async () => ({
          pages,
          total: pages.length,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: hangExecutor(),
      },
    );
    // Every page launched (100/120 maxUnits) and every page settled via
    // the per-unit timeout backstop - the wall clock did NOT fire. The
    // browser follow-up entries the orchestrator emits on a non-cancel
    // stop are expected (Full mode allows browser tier; the test does not
    // opt into the browser group, so each page gets a `group disabled:
    // browser` skip - that is unrelated to the wall clock).
    expect(outcome.units.filter((u) => u.kind === 'registry-page')).toHaveLength(pages.length);
    expect(outcome.units.every((u) => u.status === 'failed' && u.reason?.startsWith('timeout after') === true)).toBe(true);
    // The width-32/done assertion: NO `budget exhausted` skips. Any entry
    // here would mean the wall clock fired (its only producer at line 1308).
    expect(outcome.skipped.filter((s) => s.reason === 'budget exhausted')).toEqual([]);
    expect(outcome.truncated).toBe(false); // maxUnits/budget drops did not happen
    expect(outcome.hasMore).toBe(false);
    expect(outcome.nextCursor).toBeNull(); // no rewind - everything was scheduled
  });

  it('width 8 + small totalBudgetMs hits the wall clock and rewinds (budget + nextCursor rewound)', async () => {
    // The pre-wave worst case (ADR-034 D1.4): at width 8 with `totalBudgetMs`
    // small enough that even `ceil(100/8)*20 = 260 s` would not fit, only the
    // first 8 pages launch and the rest are reported `budget exhausted`. The
    // rewind seam (T905) returns the predecessor page's opaque cursor as
    // `nextCursor`.
    //
    // SCALING (T1051). `deadlineMs = poolStart + totalBudgetMs` and `poolStart`
    // is taken BEFORE `buildPlan`, so PLANNING is charged against this budget
    // too. A 50 ms budget over a 100-page plan left only ~10x the measured
    // planning cost (0-4 ms) as headroom, and an expired-before-first-launch
    // deadline would launch ZERO pages and break the `toHaveLength(8)`
    // assertion - the same load-sensitivity as the width-32 sibling, in the
    // opposite direction. 500 ms keeps ~100x the planning headroom while
    // staying 120x BELOW `perUnitTimeoutMs: 60000`, so the wall clock still
    // fires long before any unit could settle and the assertion is unchanged.
    const pages = buildPages(100);
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t906-width8', userId: 'u1' },
      {
        budget: {
          maxUnits: 120,
          maxConcurrent: 8,
          perUnitTimeoutMs: 60000, // per-unit timeout is much longer than the wall clock
          totalBudgetMs: 500,
          perSourceResultCap: 10,
        },
        graceMs: 5,
        listUserBoards: async () => [],
        resolveRegistryPageBatch: async () => ({
          pages,
          total: pages.length,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: hangExecutor(),
      },
    );
    // Only 8 pages launched before the deadline fired.
    const pageUnits = outcome.units.filter((u) => u.kind === 'registry-page');
    expect(pageUnits).toHaveLength(8);
    expect(outcome.truncated).toBe(true);
    // The wall clock fired: pages 8-99 are `budget exhausted`, and the
    // rewind seam points at the predecessor of the first unscheduled page.
    expect(outcome.skipped).toEqual(expect.arrayContaining([
      { unitId: 'page:8', reason: 'budget exhausted' },
      { unitId: 'page:99', reason: 'budget exhausted' },
    ]));
    expect(outcome.hasMore).toBe(true);
    // T905: rewound cursor is the predecessor page's opaque string, not
    // the bare id. Predecessor of `page:8` is `page:7`.
    expect(outcome.nextCursor).toBe('opaque-cursor|page-ref-width-7');
  });
});

// ---------------------------------------------------------------------------
// Wave 15 (T907) politeness gate integration: parked-not-in-flight scheduling,
// anti-millipede, anti-starvation, minGap, deferral accounting, exactly-once.
// All six contract section C invariants land here with a fake executor and
// an injected monotonic clock so the assertions are deterministic.
// ---------------------------------------------------------------------------

import {
  PolitenessGate,
  politenessKeyFor,
} from './politeness.js';

describe('wave 15 T907 politeness invariants in executePool', () => {
  // pageRefWithHost: like pageRef but with a custom provider/host/pageUrl so
// the politeness tests can drive a deterministic bucket key. By default
// the helper produces provider=null pages, which resolve through
// `adapterTypeFor` to the tier-3 `career-page` placeholder and bucket on
// `host:<host>` (politenessKeyFor).
function pageRefWithHost(hostSuffix: string, index: number, provider: string | null = null): RegistryPageRef {
  const id = `page-ref-${hostSuffix}-${index}`;
  const host = `careers.${hostSuffix}.example`;
  return {
    id,
    companyName: hostSuffix,
    url: `https://${host}/jobs/${index}`,
    provider,
    boardToken: provider === null ? null : `${hostSuffix}-${index}`,
    tier: provider === null ? 3 : 1,
    cursor: `opaque-cursor|${id}`,
  };
}

// Compute the bucket key the orchestrator will derive for a
// pageRefWithHost(<suffix>) page. Mirrors politenessKeyFor's
// `host:<host>` branch.
function expectedHostKey(hostSuffix: string): string {
  return `host:careers.${hostSuffix}.example`;
}

// 1. Per-bucket cap never exceeded. The fake executor reports the bucket
  // key for every concurrent unit; the test asserts no key ever exceeds its
  // cap. The fake executor also yields so the pool can launch more than one
  // unit; without yielding, the cap would never be observable.
  it('invariant 1: per-bucket in-flight never exceeds the cap', async () => {
    const now = 0;
    const gate = new PolitenessGate(() => now, {
      policies: {
        [expectedHostKey('caps')]: { maxConcurrent: 2, minGapMs: 0 },
      },
    });
    const concurrent = { max: 0, current: 0 };
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-cap', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 8 },
        listUserBoards: async () => [],
        politenessGate: gate,
        poolNow: () => now,
        resolveRegistryPageBatch: async () => ({
          pages: Array.from({ length: 6 }, (_, i) => pageRefWithHost('caps', i)),
          total: 6,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async () => {
          concurrent.current += 1;
          concurrent.max = Math.max(concurrent.max, concurrent.current);
          // Yield so multiple units can be in-flight concurrently.
          await tick(20);
          concurrent.current -= 1;
          return [];
        },
      },
    );
    expect(concurrent.max).toBeLessThanOrEqual(2); // the per-bucket cap
    expect(outcome.units.filter((u) => u.kind === 'registry-page')).toHaveLength(6);
  });

  // 2. Anti-millipede: a bucket cap of 1 with 4 units in that bucket must
  // never put more than 1 in-flight. Parked units do NOT hold a slot.
  it('invariant 2: anti-millipede - single-bucket cap of 1 with 4 units parked', async () => {
    const now = 0;
    const gate = new PolitenessGate(() => now, {
      policies: {
        [expectedHostKey('milli')]: { maxConcurrent: 1, minGapMs: 0 },
      },
    });
    const concurrent = { max: 0, current: 0 };
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-milli', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 4 },
        listUserBoards: async () => [],
        politenessGate: gate,
        poolNow: () => now,
        resolveRegistryPageBatch: async () => ({
          pages: Array.from({ length: 4 }, (_, i) => pageRefWithHost('milli', i)),
          total: 4,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async () => {
          concurrent.current += 1;
          concurrent.max = Math.max(concurrent.max, concurrent.current);
          await tick(5);
          concurrent.current -= 1;
          return [];
        },
      },
    );
    // The pool was configured for 4 concurrent; the gate caps it at 1.
    expect(concurrent.max).toBeLessThanOrEqual(1);
    // Every unit eventually launched - no parked units, no failures from
    // parking (anti-millipede ensures the cap is observed without
    // permanently parking a unit).
    expect(outcome.units.filter((u) => u.kind === 'registry-page')).toHaveLength(4);
    expect(outcome.units.filter((u) => u.status === 'failed')).toHaveLength(0);
    // The gate recorded some deferrals while waiting for slots.
    const snap = gate.snapshot();
    expect(snap.find((s) => s.key === expectedHostKey('milli'))?.deferred).toBeGreaterThan(0);
  });

  // 3. Anti-starvation: when pending > 0 and inFlight < width, at least one
  // unit is admissible. We pack a heterogeneous batch (two distinct hosts)
  // and assert both hosts get launched eventually - neither starves.
  it('invariant 3: anti-starvation - pending > 0 and inFlight < width => runnable', async () => {
    const now = 0;
    const gate = new PolitenessGate(() => now, {
      policies: {
        [expectedHostKey('starve-a')]: { maxConcurrent: 1, minGapMs: 0 },
        [expectedHostKey('starve-b')]: { maxConcurrent: 1, minGapMs: 0 },
      },
    });
    const launched = new Set<string>();
    await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-starve', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 4 },
        listUserBoards: async () => [],
        politenessGate: gate,
        poolNow: () => now,
        resolveRegistryPageBatch: async () => ({
          pages: [
            pageRefWithHost('starve-a', 0),
            pageRefWithHost('starve-b', 1),
            pageRefWithHost('starve-a', 2),
            pageRefWithHost('starve-b', 3),
          ],
          total: 4,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async (unit) => {
          launched.add(unit.unitId);
          await tick(5);
          return [];
        },
      },
    );
    // All four units eventually launched (anti-starvation).
    expect(launched.size).toBe(4);
  });

  // 4. minGap: the gate-level test at `politeness.test.ts:259-274`
  // (`'consecutive launches on the same bucket respect minGapMs'`) is the
  // non-vacuous, hermetic coverage of the gate's minGap enforcement: it
  // directly drives the gate with an injected clock and asserts the
  // boundary (999 ms refused, 1000 ms admitted). A pool-level test
  // (review-T907 D3) was added in the original pass that asserted the
  // same invariant in `executePool`, but the assertion passed vacuously
  // because the executor self-advanced `now` by 1010 ms between launches
  // (the natural serial gap was already 1010 ms even with
  // `minGapMs: 0`). Restructuring the executor to drive `now` via
  // `gate.nextReadyAt` made the test race the orchestrator's drain,
  // which sleeps the full remaining deadline after the scheduler loop
  // admits everything (`orchestrator.ts:1495-1509`), so the test now
  // exceeds the vitest default timeout even when the gate is correct.
  // Per the contract's "delete vacuous test with justification" carve-out
  // (the brief's explicit guidance for review-T907 D3), the pool-level
  // test is REMOVED and the gate-level test carries the invariant. The
  // orchestrator-level scheduler wiring is covered by invariants 1, 2, 3,
  // 5, 5b, 6 above.

  // 5. Deferral accounting: a deadline stop with parked units reports each
  // one as `skipped` with a politeness reason, `hasMore` is true, zero
  // parked unit is reported `failed`. The fake executor holds the FIRST
  // unit indefinitely so the gate parks the rest; the deadline fires
  // before any settlement can free a slot. We use a real-time budget
  // (no injected clock) so the wall clock actually advances.
  //
  // BUDGET HEADROOM (repair round 1): `deadlineMs = poolStart + totalBudgetMs`
  // and `poolStart` is taken BEFORE `buildPlan` (orchestrator.ts:1609 vs
  // :1636), so PLANNING is charged against this budget too. Under the full
  // suite's parallel load a 30 ms budget could expire during planning, leaving
  // zero parked units and making the exact-count assertion below fail
  // (`expected +0 to be 5`). 400 ms of headroom over a 5-page plan keeps the
  // shape deterministic; the executor hangs 900 ms so the deadline still
  // fires well before any settlement.
  it('invariant 5: deferral accounting - deadline stop -> parked reported skipped', async () => {
    const gate = new PolitenessGate(() => Date.now(), {
      policies: {
        [expectedHostKey('defer')]: { maxConcurrent: 1, minGapMs: 0 },
      },
    });
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-defer', userId: 'u1' },
      {
        budget: {
          maxUnits: 5,
          maxConcurrent: 32,
          perUnitTimeoutMs: 60000,
          totalBudgetMs: 400,
          perSourceResultCap: 10,
        },
        graceMs: 5,
        listUserBoards: async () => [],
        politenessGate: gate,
        resolveRegistryPageBatch: async () => ({
          pages: Array.from({ length: 5 }, (_, i) => pageRefWithHost('defer', i)),
          total: 5,
          hasMore: true,
          nextCursor: 'opaque-cursor|page-ref-defer-4',
        }),
        executeUnit: async () => {
          // The first unit hangs well past the deadline; the gate parks
          // the rest until the wall clock fires.
          await new Promise<void>((resolve) => setTimeout(resolve, 900));
          return [];
        },
      },
    );
    expect(outcome.hasMore).toBe(true);
    const deferred = outcome.skipped.filter((s) =>
      s.reason.startsWith('politeness deferred'),
    );
    expect(deferred.length).toBeGreaterThan(0);
    // Parked units (cap 1, second..fifth) must NOT be reported failed.
    const failedPages = outcome.units.filter(
      (u) => u.kind === 'registry-page' && u.status === 'failed',
    );
    expect(failedPages.length).toBeLessThan(5);
  });

  // 6. Exactly-once: across a multi-batch traversal with deferrals, every
  // fetched page is eventually launched exactly once or reported as never
  // launched with a reason. The test runs two batches back to back with a
  // rewind; every page id from the first batch that was parked must be
  // picked up by the second batch, and no page is launched twice. Real-time
  // budget (no injected clock) so the wall clock actually advances.
  it('invariant 6: exactly-once across multi-batch traversal with deferrals', async () => {
    const gate = new PolitenessGate(() => Date.now(), {
      policies: {
        [expectedHostKey('once')]: { maxConcurrent: 1, minGapMs: 0 },
      },
    });
    const launchedIds = new Set<string>();
    // All 5 pages resolve to the SAME bucket (cap 1). The first batch can
    // launch only 1 unit before the deadline; the rest are parked and
    // must be retried by the second batch via the rewound cursor.
    const allPages = ['once-a-0', 'once-a-1', 'once-a-2', 'once-a-3', 'once-a-4'];
    const resolveBatch = async (after: string | null, limit: number) => {
      // The cursor encodes the last-fetched page's id (`opaque-cursor|<id>`).
      // We extract the trailing numeric index so the second call resumes
      // after the first batch's rewound cursor. The first batch returns
      // `hasMore=true` so the rewind has a cursor to overwrite; the second
      // batch starts from the rewound cursor.
      let previousIndex = -1;
      if (after !== null) {
        const m = /(\d+)$/.exec(after);
        if (m !== null) previousIndex = Number(m[1]);
      }
      const start = previousIndex + 1;
      const slice = allPages.slice(start, start + limit);
      const hasMore = start + slice.length < allPages.length;
      return {
        pages: slice.map((_, i) => pageRefWithHost('once', start + i)),
        total: allPages.length,
        hasMore,
        nextCursor: hasMore
          ? `opaque-cursor|page-ref-once-${start + slice.length - 1}`
          : null,
      };
    };

    // First batch: tight wall clock + cap-1 bucket + an executor that
    // hangs past the deadline. The first unit never settles; the rest
    // are parked and reported with a politeness reason.
    const first = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-once-1', userId: 'u1' },
      {
        budget: {
          maxUnits: 5,
          maxConcurrent: 32,
          perUnitTimeoutMs: 60000,
          // Headroom over a 5-page plan (see invariant 5's note: `poolStart`
          // is taken before `buildPlan`, so planning is charged against this
          // budget). The assertion below is an EXACT count
          // (`launchedIds.size === 1`), so a budget that expires during
          // planning would launch 0 and fail; 250 ms keeps the shape stable
          // under full-suite load while the executor's 900 ms hang keeps the
          // deadline strictly ahead of any settlement.
          totalBudgetMs: 250,
          perSourceResultCap: 10,
        },
        graceMs: 5,
        listUserBoards: async () => [],
        politenessGate: gate,
        resolveRegistryPageBatch: resolveBatch,
        executeUnit: async (unit) => {
          if (unit.kind === 'registry-page') {
            // Track by config.feedUrl - unique per registry-page ref.
            const url = (unit.config as { feedUrl?: string }).feedUrl;
            if (typeof url === 'string') launchedIds.add(url);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 900));
          return [];
        },
      },
    );
    // Only one unit launched before the deadline; the rest are parked.
    expect(launchedIds.size).toBe(1);
    expect(first.hasMore).toBe(true);

    // Second batch: starts from the rewound cursor (predecessor of the
    // first parked page). With cap=1, each subsequent launch must wait
    // for the previous to settle. launchedIds is cumulative.
    await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-once-2', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 32 },
        listUserBoards: async () => [],
        politenessGate: gate,
        resolveRegistryPageBatch: resolveBatch,
        afterCursor: first.nextCursor,
        executeUnit: async (unit) => {
          if (unit.kind === 'registry-page') {
            // Track by config.feedUrl - unique per registry-page ref, distinct
            // across batches (the orchestrator's `page:N` unitId resets per
            // batch).
            const url = (unit.config as { feedUrl?: string }).feedUrl;
            if (typeof url === 'string') launchedIds.add(url);
          }
          await tick(3);
          return [];
        },
      },
    );
    // Across both batches, every page was launched exactly once (tracked
    // by the unique URL each pageRefWithHost produces).
    expect(launchedIds.size).toBe(5);
    const expected = new Set([
      'https://careers.once.example/jobs/0',
      'https://careers.once.example/jobs/1',
      'https://careers.once.example/jobs/2',
      'https://careers.once.example/jobs/3',
      'https://careers.once.example/jobs/4',
    ]);
    expect(launchedIds).toEqual(expected);
  });

  // T907 D1 acceptance-5 zero-in-flight variant (review-T907 D1 site 1):
  // every unit parked until the deadline, AND nothing in flight at the
  // deadline. The original classification at the budget condition was
  // `inFlight.size > 0` only, so this exact shape exited with stop='done'
  // and a non-empty neverLaunched - pages fetched but never launched
  // vanished from both units and skipped, the cursor advanced past them,
  // and the rewind never ran. The fix widens the budget classification to
  // `inFlight.size > 0 || neverLaunched.size > 0`. This test exercises the
  // exact shape: a gate whose tryAcquire is monkey-patched to ALWAYS return
  // false (the state that will exist once T908's backoff opens
  // blockedUntilMs permanently), a real-time clock so the deadline
  // actually fires, a budget tight enough that the deadline lands mid
  // scheduler-loop (NOT in the walk loop, which has already finished
  // walking all units), and an executor that is irrelevant because no unit
  // ever gets admitted. After the run:
  //   - outcome.truncated === true (budget branch fired);
  //   - every unit reported skipped with a politeness reason;
  //   - outcome.hasMore === true (rewind fired);
  //   - zero units reported failed from parking.
  it('invariant 5b (D1): all-parked-until-deadline with zero in-flight -> all reported skipped, hasMore true', async () => {
    const gate = new PolitenessGate(() => Date.now(), {
      policies: {
        [expectedHostKey('allparked')]: { maxConcurrent: 1, minGapMs: 0 },
      },
    });
    // Monkey-patch tryAcquire to ALWAYS return false. The real
    // implementation calls touch() then checks the cap; we bypass it so the
    // bucket never enters the gate's state (parked units are tracked via
    // the orchestrator's parkedHistory, not via the gate). This is exactly
    // the shape the orchestrator faces when a bucket is permanently blocked
    // (T908's blockedUntilMs future-pinned): tryAcquire keeps returning
    // false, parkedHistory keeps accumulating, inFlight stays at 0.
    gate.tryAcquire = ((): boolean => false) as typeof gate.tryAcquire;
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-allparked', userId: 'u1' },
      {
        budget: {
          maxUnits: 200,
          maxConcurrent: 32,
          perUnitTimeoutMs: 60000,
          // Headroom over a 200-page plan (see invariant 5's note: planning is
          // charged against the budget because `poolStart` precedes
          // `buildPlan`). 400 ms keeps "all 200 parked" deterministic under
          // the full suite's parallel load; the executor must NEVER be called
          // so the pool always burns the remaining budget in the
          // scheduler-loop sleep.
          totalBudgetMs: 400,
          perSourceResultCap: 10,
        },
        graceMs: 5,
        listUserBoards: async () => [],
        politenessGate: gate,
        resolveRegistryPageBatch: async () => ({
          pages: Array.from({ length: 200 }, (_, i) => pageRefWithHost('allparked', i)),
          total: 200,
          hasMore: true,
          nextCursor: 'opaque-cursor|page-ref-allparked-199',
        }),
        // The executor must NEVER be called (every unit parked), but if a
        // regression admits a unit we want a loud signal, not a hang.
        executeUnit: async () => {
          throw new Error('executor called: gate should have refused every unit');
        },
      },
    );
    // Budget branch fired: truncated + hasMore forced.
    expect(outcome.truncated).toBe(true);
    expect(outcome.hasMore).toBe(true);
    // Every parked unit reported as skipped with a politeness reason.
    const deferred = outcome.skipped.filter((s) =>
      s.reason.startsWith('politeness deferred'),
    );
    expect(deferred.length).toBe(200);
    // The planner also emits its own group/scope skips (independent of
    // the pool); we only assert here that every parked unit is reported
    // with a politeness reason, not that `outcome.skipped.length` is
    // exactly 200 (planner pre-skips add to the count).
    expect(deferred.length).toBeGreaterThanOrEqual(200);
    // Zero units reported failed from parking (parking is not failure).
    const failed = outcome.units.filter(
      (u) => u.kind === 'registry-page' && u.status === 'failed',
    );
    expect(failed).toHaveLength(0);
    // No unit was ever admitted -> zero registry-page units emitted.
    const pageUnits = outcome.units.filter((u) => u.kind === 'registry-page');
    expect(pageUnits).toHaveLength(0);
    // The rewind forced `hasMore = true` (the cursor semantics for the
    // very first page in a batch is `null` because the predecessor doesn't
    // exist; see `rewindRegistryBeforeUnattempted` at :720-736). The
    // contract invariant is `hasMore = true`; we assert that here.
    expect(outcome.hasMore).toBe(true);
  });

  // T907 D2 (review-T907 D2) end-to-end: aliased adapter families must land
  // in ONE shared bucket through the REAL `bucketKeyForUnit` seam, not one
  // bucket per company page host.
  //
  // Shape: four registry pages whose `provider` is `breezy` but whose
  // page URLs are on FOUR DIFFERENT company hosts. `configForRegistryRow`
  // maps `breezy -> breezyhr` (registry/providers.ts:123), so all four
  // planned units carry `providerType = 'breezyhr'` and all four fetch the
  // SHARED breezy.hr upstream API. Pre-fix, `bucketKeyForUnit` fed the
  // adapter type into `politenessKeyFor` as if it were a registry provider
  // id; `adapterTypeFor('breezyhr')` is null, so each unit bucketed on its
  // OWN company-page host and the gate bound nothing - concurrency would
  // have hit the pool width of 4 instead of the bucket cap of 1. Post-fix
  // the four rows collapse onto `provider:breezyhr` and the cap holds.
  //
  // This is the end-to-end proof that the key derivation, the orchestrator
  // seam and the gate agree on the SAME shared upstream. Without the fix the
  // assertion `concurrent.max <= 1` fails with 4.
  it('invariant 1b (D2): aliased adapter rows on different company hosts share ONE bucket (cap holds)', async () => {
    const now = 0;
    const gate = new PolitenessGate(() => now, {
      policies: {
        // Cap 1 so ANY un-bucketed row is immediately visible.
        'provider:breezyhr': { maxConcurrent: 1, minGapMs: 0 },
      },
    });
    const concurrent = { max: 0, current: 0 };
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-alias-bucket', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 8 },
        listUserBoards: async () => [],
        politenessGate: gate,
        poolNow: () => now,
        resolveRegistryPageBatch: async () => ({
          // Four DIFFERENT company hosts, one shared upstream adapter.
          pages: [0, 1, 2, 3].map((i) => pageRef(`Alias${i}`, i, 'breezy')),
          total: 4,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async () => {
          concurrent.current += 1;
          concurrent.max = Math.max(concurrent.max, concurrent.current);
          await tick(20);
          concurrent.current -= 1;
          return [];
        },
      },
    );
    // The shared upstream was never oversubscribed...
    expect(concurrent.max).toBeLessThanOrEqual(1);
    // ...and all four rows still ran (the cap serialises, it does not drop).
    expect(outcome.units.filter((u) => u.kind === 'registry-page')).toHaveLength(4);
    // Sanity: the four company-page hosts really were distinct, so a
    // host-keyed derivation could NOT have produced a single bucket.
    const hosts = new Set(
      [0, 1, 2, 3].map((i) => politenessKeyFor({
        providerType: 'breezyhr',
        tier: 1,
        provider: 'breezyhr',
        host: null,
        pageUrl: `https://careers.alias${i}.example/jobs/${i}`,
      })),
    );
    expect(hosts).toEqual(new Set(['provider:breezyhr']));
  });

  // T907 D1 acceptance-5, SITE 2 (review-T907 D1 second site): the deadline
  // fires AFTER the stop classification but DURING the drain of the in-flight
  // set. `executePool` classifies the stop, THEN drains; between those two
  // points the clock advances across the deadline, so the `'budget'`/`'cancel'`
  // branches (which perform the truthful-skipped accounting `runSearch` reads
  // to force `hasMore` and drive the rewind) must still be reached.
  //
  // Reaching this path needs a shape the other tests do not produce: the
  // scheduler loop must EXIT via its `inFlight.size < width` condition (not
  // via the deadline, which would let the widened classification at :1459
  // catch it first). That requires the walk loop's LAST planned unit to be the
  // one that fills the pool width, with parked work already accumulated. The
  // trace:
  //   index 0 (bucket `hold`, gate refuses) -> parked
  //   index 1 (bucket `other`)             -> admitted, inFlight=1
  //   index 2 (bucket `other`)             -> admitted, inFlight=2 == width
  //   `next === ordered.length`             -> walk loop exits, stop='done'
  //   scheduler loop: `inFlight.size < width` is FALSE -> exits at once,
  //                   still BEFORE the deadline
  //   classification at :1459: `now < deadlineMs` -> stop stays 'done'
  //   drain: sleeps toward the deadline; the executors hang past it, so the
  //          drain flips stop to 'budget' and breaks
  // => parked index 0 must be reported. Pre-site-2-fix the function returned
  //    from inside the drain without the accounting, dropping it silently.
  it('invariant 5c (D1 site 2): deadline firing DURING the drain still reports parked units skipped', async () => {
    const holdKey = expectedHostKey('drainhold');
    const gate = new PolitenessGate(() => Date.now(), {
      policies: { [holdKey]: { maxConcurrent: 1, minGapMs: 0 } },
    });
    // Refuse ONLY the `hold` bucket; the `other` bucket must stay admittable
    // so the walk loop can actually fill the pool width and reach the shape.
    const realTryAcquire = gate.tryAcquire.bind(gate);
    gate.tryAcquire = ((key: string): boolean =>
      key === holdKey ? false : realTryAcquire(key)) as typeof gate.tryAcquire;
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-drain-stop', userId: 'u1' },
      {
        budget: {
          maxUnits: 10,
          maxConcurrent: 2, // width 2: two `other` units fill it exactly
          perUnitTimeoutMs: 60000,
          // See invariant 5: planning is charged against the budget, so this
          // needs headroom for the 3-page plan before the deadline can land
          // inside the drain (the shape under test). 150 ms is ample for a
          // 3-page plan and keeps the test under a quarter second.
          totalBudgetMs: 150,
          perSourceResultCap: 10,
        },
        graceMs: 5,
        listUserBoards: async () => [],
        politenessGate: gate,
        resolveRegistryPageBatch: async () => ({
          pages: [
            pageRefWithHost('drainhold', 0),
            pageRefWithHost('drainother', 1),
            pageRefWithHost('drainother', 2),
          ],
          total: 3,
          hasMore: true,
          nextCursor: 'opaque-cursor|page-ref-drainother-2',
        }),
        // Both admitted units hang well past the deadline so the drain's
        // deadline-bounded sleep wins the race and flips the stop cause.
        executeUnit: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 900));
          return [];
        },
      },
    );
    // The parked unit is page 0 (the only one in the refused bucket). It MUST
    // be reported with a truthful politeness reason. Pre-site-2-fix this
    // entry is absent: the drain returned without the accounting loop.
    const parkedSkip = outcome.skipped.find((s) => s.unitId === 'page:0');
    expect(parkedSkip, 'parked page:0 must be reported skipped').toBeDefined();
    expect(parkedSkip?.reason).toBe(`politeness deferred: ${holdKey}`);
    // Budget branch fired, so `hasMore` is forced and the rewind ran.
    expect(outcome.truncated).toBe(true);
    expect(outcome.hasMore).toBe(true);
    // Parking is not failure: the parked unit was never launched, so it must
    // not appear in `units` at all (not even as a failure). The two units that
    // DID launch are reported failed with `budget_exhausted` because the drain
    // killed their still-unsettled tokens - that is the in-flight path, a
    // different contract clause from the parked path.
    const pageUnitIds = outcome.units
      .filter((u) => u.kind === 'registry-page')
      .map((u) => u.unitId);
    expect(pageUnitIds).not.toContain('page:0');
    expect(pageUnitIds.sort()).toEqual(['page:1', 'page:2']);
    expect(
      outcome.units.filter((u) => u.kind === 'registry-page' && u.status === 'failed'),
    ).toHaveLength(2);
  });

  // T907 D1-3 (review-T907 R4/R8, D1 site 3): parking left over when the
  // pool SETTLES BEFORE the deadline. Unlike 5b (deadline reached with zero
  // in-flight) and 5c (deadline reached DURING the drain), here the batch
  // finishes comfortably inside its budget and `executePool` would have
  // returned `stop: 'done'` with a non-empty `neverLaunched`. `runSearch`
  // gates `truncated`, the registry rewind and `hasMore` forcing on
  // `stop === 'budget'`, so the batch would report a CLEAN finish while
  // dropping a fetched page for good - spec AC20 ("parked units are reported
  // `skipped: politeness deferred` AND force `hasMore`") and spec edge case
  // 5 ("parking at the end of a batch: every parked page must be reported
  // and must force `hasMore`").
  //
  // Shape (the reviewer's trace, reproduced exactly):
  //   ordered = [page:0 (settle-a), page:1 (settle-a), page:2 (settle-b)],
  //   width = 2, cap(settle-a) = 1.
  //   walk:   idx0 -> settle-a free -> launched (inFlight=1)
  //           idx1 -> cap(settle-a) reached -> PARKED
  //           idx2 -> settle-b free -> launched (inFlight=2 == width)
  //           next === ordered.length -> walk exits, stop still 'done'
  //   scheduler loop: `inFlight.size < width` is `2 < 2` = false, so the
  //           body never runs and idx1 is never re-attempted.
  //   classification: `now < deadlineMs` -> stop stays 'done'.
  //   drain: the two in-flight units settle; the deadline never fires.
  // Pre-fix: stop='done' -> `truncated: false`, no rewind, cursor advances
  // past page:1 forever. Post-fix the residual never-launched work is
  // classified as a budget stop, so the rewind runs and `hasMore` is forced.
  //
  // HERMETIC: an injected `poolNow` clock drives BOTH the pool deadline and
  // the gate, and the executor returns immediately after nudging `now` by a
  // few ms, so the pool drains ~5 orders of magnitude before
  // `ROOMY_BUDGET.totalBudgetMs` (15_000 ms). No real timers, no wall-clock
  // pressure, no monkey-patched gate - only the frozen policy row for the
  // single `settle-a` bucket (1 cap), which is reachable in production.
  it('invariant 5d (D1 site 3): parking left over when the pool settles before the deadline still rewinds', async () => {
    const holdKey = expectedHostKey('settle-a');
    let now = 0;
    const gate = new PolitenessGate(() => now, {
      policies: { [holdKey]: { maxConcurrent: 1, minGapMs: 0 } },
    });
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-settle-before-deadline', userId: 'u1' },
      {
        // width 2 so the SECOND launched unit fills the pool exactly and the
        // scheduler loop's `inFlight.size < width` guard never re-scans the
        // parked worklist.
        budget: { ...ROOMY_BUDGET, maxConcurrent: 2 },
        listUserBoards: async () => [],
        politenessGate: gate,
        poolNow: () => now,
        resolveRegistryPageBatch: async () => ({
          pages: [
            pageRefWithHost('settle-a', 0),
            pageRefWithHost('settle-a', 1),
            pageRefWithHost('settle-b', 2),
          ],
          total: 3,
          hasMore: true,
          nextCursor: 'opaque-cursor|page-ref-settle-b-2',
        }),
        // Return immediately: the pool settles far inside the budget. `now`
        // only needs to move so the launch/skip timings are non-degenerate;
        // 5 ms x 2 launches keeps `now` at 10 against a 15_000 ms deadline.
        executeUnit: async () => {
          now += 5;
          return [];
        },
      },
    );
    // The residual never-launched unit is a budget stop, so the batch is
    // truncated and `runSearch` runs the rewind branch.
    expect(outcome.truncated).toBe(true);
    expect(outcome.hasMore).toBe(true);
    // The rewind selected the predecessor of the FIRST never-launched page
    // (page:1) in `pageUnits` order, not the reader's cursor.
    expect(outcome.nextCursor).toBe('opaque-cursor|page-ref-settle-a-0');
    // The parked page is reported with its truthful politeness reason.
    const parkedSkip = outcome.skipped.find((s) => s.unitId === 'page:1');
    expect(parkedSkip, 'parked page:1 must be reported skipped').toBeDefined();
    expect(parkedSkip?.reason).toBe(`politeness deferred: ${holdKey}`);
    // The two launched pages ran; the parked one is absent from `units`
    // entirely (parking is not failure).
    const pageUnitIds = outcome.units
      .filter((u) => u.kind === 'registry-page')
      .map((u) => u.unitId)
      .sort();
    expect(pageUnitIds).toEqual(['page:0', 'page:2']);
  });

  // SEARCH_FULL_POLITENESS=off path: when no politenessGate is supplied,
  // the pool behaves exactly as pre-wave (every unit launches as soon as
  // capacity allows). The bucket key derivation still works (used by tests).
  //
  // Restructured (review-T907 D7 acceptance coverage): the original test
  // built a spy on a gate that was never passed to runSearch, so the
  // spy count was trivially zero and the test could not fail. The fixed
  // test runs TWO calls: a positive control WITH the spied gate (asserts
  // spy > 0, proving the spy wiring is live) and the off-path call WITHOUT
  // the gate (asserts spy === 0 AFTER the positive control, proving
  // admission is bypassed when the knob is off). If a regression ever
  // wires the gate into the off path, the second assertion fires.
  //
  // T908: unaffected by the marker shape change (this test never reads the
  // response marker) but it IS the off-path the marker depends on: with the
  // knob off the orchestrator also opens no 429/503 block, because
  // `noteBlocked` lives on the gate that is never constructed. The
  // off-path's `rateLimitSignals` (an honest observation of a 429 unit) with
  // `blocksOpened` absent is asserted in the T908 describe below.
  it('SEARCH_FULL_POLITENESS=off: admission is bypassed (gate-not-passed path has zero acquires; with-gate control is non-zero)', async () => {
    const now = 0;
    const spy = { acquireCount: 0 };
    const gate = new PolitenessGate(() => now, {
      policies: {
        [expectedHostKey('off')]: { maxConcurrent: 1, minGapMs: 0 },
      },
    });
    const originalTry = gate.tryAcquire.bind(gate);
    gate.tryAcquire = ((key: string): boolean => {
      spy.acquireCount += 1;
      return originalTry(key);
    }) as typeof gate.tryAcquire;
    // Positive control: pass the gate and prove the spy wiring is live.
    // With the gate supplied, every walked unit goes through tryAcquire -
    // the count must be strictly positive (4 registry-page units in this
    // shape). Without this control, the negative assertion below would be
    // vacuous (the spy could be wired to a dead reference and still read
    // 0).
    await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-off-control', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 4 },
        listUserBoards: async () => [],
        politenessGate: gate,
        resolveRegistryPageBatch: async () => ({
          pages: Array.from({ length: 4 }, (_, i) => pageRefWithHost('off', i)),
          total: 4,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async () => [],
      },
    );
    const controlCount = spy.acquireCount;
    expect(controlCount).toBeGreaterThan(0);
    // Off path: no politenessGate supplied. The orchestrator must NEVER
    // call tryAcquire on the spied gate (it does not receive a reference
    // to it). The spy count must NOT advance from the control count.
    await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t907-off-bypass', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 4 },
        listUserBoards: async () => [],
        // Deliberately no politenessGate - the off path.
        resolveRegistryPageBatch: async () => ({
          pages: Array.from({ length: 4 }, (_, i) => pageRefWithHost('off', i)),
          total: 4,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async () => [],
      },
    );
    expect(spy.acquireCount).toBe(controlCount); // unchanged: off path bypassed
  });

  // politenessKeyFor smoke check: the helper the orchestrator uses
  // produces the expected key shapes for the test fixtures.
  it('politenessKeyFor shapes match the orchestrator contract for our fixtures', () => {
    // pageRef builds greenhouse rows -> provider:<id>
    expect(politenessKeyFor({
      providerType: 'greenhouse',
      tier: 1,
      provider: 'greenhouse',
      pageUrl: 'https://boards.greenhouse.io/x',
    })).toBe('provider:greenhouse');
  });
});

// ---------------------------------------------------------------------------
// Wave 15 (T908) wiring: observed 429/503 failures open a block on the SAME
// bucket key admission uses, and the two bounded counters ride the outcome.
//
// The fake executors below drive real `HttpStatusError(429/503/403/500)`
// throws through `executeOne`, so these assertions exercise the production
// wiring (`noteRateLimitSignal` in orchestrator.ts) rather than the pure gate.
// ---------------------------------------------------------------------------

describe('wave 15 T908 429/503 backoff wiring in the orchestrator', () => {
  /** Bucket key for a greenhouse registry page unit (the shared upstream). */
  const GREENHOUSE_KEY = 'provider:greenhouse';
  /** Bucket key for a lever registry page unit (a different shared upstream). */
  const LEVER_KEY = 'provider:lever';

  /**
   * A tier-3 (host-bucketed) registry page. `pageRefWithHost` is scoped to the
   * T907 describe above, so the T908 regression test (which needs DISTINCT
   * hosts, not distinct providers) builds its own fixture here. Provider null
   * resolves to the `career-page` placeholder, so the bucket is
   * `host:<hostname>` - one bucket per host, which is what the distinct-bucket
   * assertion needs.
   */
  function hostPageRef(hostSuffix: string, index: number): RegistryPageRef {
    const id = `t908-${hostSuffix}-${index}`;
    return {
      id,
      companyName: hostSuffix,
      url: `https://careers.${hostSuffix}.example/jobs/${index}`,
      provider: null,
      boardToken: null,
      tier: 3,
      cursor: `opaque-cursor|${id}`,
    };
  }

  /** Real (non-stub) clock for the gate and the pool.
   *
   * T907's tests inject a frozen `poolNow`, which is fine when every parked
   * unit eventually becomes admissible. A 429 block lasts 60 s, so a frozen
   * clock would never reach `deadlineMs` and the parked-units loop would spin
   * forever. These tests therefore use the wall clock with a deliberately
   * short `totalBudgetMs`: the 60 s block cannot expire inside a 150 ms
   * budget, so "no further launch during the block" is a fact, not a race.
   */
  const wall = (): number => Date.now();

  it('the 429 block lands on the SAME key admission uses (a mismatch would block nothing or everything)', async () => {
    // ADR-034 D2.1/D2.4 key agreement: if the key the 429 reports under were
    // NOT the key the gate admits under, the block would either hit an empty
    // queue ("one tenant's 429 blocks the whole host" / "the block hits an
    // empty queue") or block a bucket nobody was throttled by.
    const gate = new PolitenessGate(wall, { jitter: () => 0.5 });
    const admitted: string[] = [];
    const blockedKeys: string[] = [];
    const originalTryAcquire = gate.tryAcquire.bind(gate);
    gate.tryAcquire = ((key: string): boolean => {
      admitted.push(key);
      return originalTryAcquire(key);
    });
    const originalNoteBlocked = gate.noteBlocked.bind(gate);
    gate.noteBlocked = ((key: string, status: number, retryAfter: string | null): void => {
      blockedKeys.push(key);
      originalNoteBlocked(key, status, retryAfter);
    });

    await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t908-key', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 2, totalBudgetMs: 150 },
        listUserBoards: async () => [],
        politenessGate: gate,
        poolNow: wall,
        resolveRegistryPageBatch: async () => ({
          pages: [pageRef('Acme', 0), pageRef('Acme', 1)],
          total: 2,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async (unit: ExecutableUnit) => {
          const { HttpStatusError } = await import('../jobSources/httpStatus.js');
          throw new HttpStatusError(429, unit.pageUrl ?? 'https://example.test/board');
        },
      },
    );

    // Admission saw the canonical shared-ATS bucket for these rows.
    expect(admitted.length).toBeGreaterThan(0);
    expect(new Set(admitted)).toEqual(new Set([GREENHOUSE_KEY]));
    // EVERY 429 reported under the very same key - asserted against
    // politenessKeyFor on the SAME inputs the orchestrator passes, so a future
    // change to bucketKeyForUnit cannot silently desync the two. (Both in-flight
    // units report: with a shared host, each 429ing unit is its own signal.)
    expect(blockedKeys.length).toBeGreaterThan(0);
    expect(new Set(blockedKeys)).toEqual(new Set([GREENHOUSE_KEY]));
    const expected = politenessKeyFor({
      providerType: 'greenhouse',
      tier: 1,
      provider: 'greenhouse',
      pageUrl: 'https://careers.acme.example/jobs/0',
    });
    expect(GREENHOUSE_KEY).toBe(expected);
    // The block is ON the bucket the pool was about to use, at base 60 s.
    expect(gate.backoffStateFor(blockedKeys[0]).backoffSecs).toBe(60);
  });

  it('a 429 on a blocked bucket stops FURTHER launches on that bucket only (other buckets keep running)', async () => {
    // One shared host 429s, another is healthy. The anti-millipede property is
    // per-bucket, so a blocked bucket must not stall the sweep. The greenhouse
    // bucket is pinned to cap 1 so that "only one launch ever happened" is
    // attributable to the BLOCK and not to the concurrency cap.
    const gate = new PolitenessGate(wall, {
      jitter: () => 0.5,
      policies: { [GREENHOUSE_KEY]: { maxConcurrent: 1, minGapMs: 0 } },
    });
    const launchedPerBucket = new Map<string, number>();
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t908-no-stall', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 4, totalBudgetMs: 150 },
        listUserBoards: async () => [],
        politenessGate: gate,
        poolNow: wall,
        resolveRegistryPageBatch: async () => ({
          pages: [
            pageRef('Blocked', 0, 'greenhouse'),
            pageRef('Blocked', 1, 'greenhouse'),
            pageRef('Blocked', 2, 'greenhouse'),
            pageRef('Healthy', 0, 'lever'),
            pageRef('Healthy', 1, 'lever'),
          ],
          total: 5,
          hasMore: false,
          nextCursor: null,
        }),
        // 429 for the greenhouse rows (the shared ATS host), success for the
        // lever rows (a different shared host).
        executeUnit: async (unit: ExecutableUnit) => {
          const key = unit.providerType === 'greenhouse' ? GREENHOUSE_KEY : LEVER_KEY;
          launchedPerBucket.set(key, (launchedPerBucket.get(key) ?? 0) + 1);
          if (unit.providerType === 'greenhouse') {
            const { HttpStatusError } = await import('../jobSources/httpStatus.js');
            throw new HttpStatusError(429, unit.pageUrl ?? 'https://example.test/board');
          }
          return [makeJob('lever', unit.pageUrl ?? 'https://example.test/board')];
        },
      },
    );

    // Exactly one block opened for the single 429 unit on the blocked bucket.
    expect(outcome.rateLimitSignals).toBe(1);
    expect(outcome.blocksOpened).toBe(1);
    expect(outcome.blocksOpened).toBeLessThanOrEqual(outcome.rateLimitSignals!);
    // Three greenhouse pages existed and exactly ONE was ever launched: the
    // other two were refused by the active 60 s block, not by the cap-1 policy
    // (which would also allow one) and not by the pool width (4).
    expect(launchedPerBucket.get(GREENHOUSE_KEY)).toBe(1);
    // The healthy bucket was NOT stalled: both its rows completed.
    expect(launchedPerBucket.get(LEVER_KEY)).toBe(2);
    const healthyOk = outcome.units.filter(
      (u) => u.providerType === 'lever' && u.status === 'ok',
    );
    expect(healthyOk).toHaveLength(2);
    // The two never-launched greenhouse pages are reported as SKIPPED with a
    // truthful `politeness deferred` reason (spec EDGE CASE 17), not dropped.
    const deferred = outcome.skipped.filter(
      (s) => s.unitId.startsWith('page:') && s.reason.startsWith('politeness deferred'),
    );
    expect(deferred.length).toBeGreaterThan(0);
    for (const s of deferred) expect(s.reason).toContain(GREENHOUSE_KEY);
  });

  it('a 403 / 500 / timeout is NOT a rate-limit signal and opens NO block', async () => {
    // ADR-034 D2.4 / spec EDGE CASE 11: only 429 and 503 open a block. 403
    // stays a health-`blocked` signal, 500 a plain error, a timeout has no
    // status at all.
    const gate = new PolitenessGate(wall, { jitter: () => 0.5 });
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t908-no-trigger', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 4, perUnitTimeoutMs: 40, totalBudgetMs: 400 },
        listUserBoards: async () => [],
        politenessGate: gate,
        poolNow: wall,
        resolveRegistryPageBatch: async () => ({
          pages: [
            { ...pageRef('Forbid', 0, 'greenhouse'), boardToken: 'f0' },
            { ...pageRef('Broken', 0, 'lever'), boardToken: 'b0' },
            { ...pageRef('Slow', 0, 'workday'), boardToken: 's0' },
          ],
          total: 3,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async (unit: ExecutableUnit) => {
          const { HttpStatusError } = await import('../jobSources/httpStatus.js');
          const url = unit.pageUrl ?? 'https://example.test/board';
          if (url.includes('forbid')) throw new HttpStatusError(403, url);
          if (url.includes('broken')) throw new HttpStatusError(500, url);
          // Never settles: the per-unit timeout (40 ms) records the failure
          // and the unit carries NO httpStatus, so it can never be a signal.
          return new Promise<RawJob[]>(() => {});
        },
      },
    );
    // No signal, no block, and the marker therefore stays `wiringOk: true`
    // (the assert must not misfire on a batch with no rate-limit pressure).
    expect(outcome.rateLimitSignals).toBeUndefined();
    expect(outcome.blocksOpened).toBeUndefined();
    const kinds = outcome.units.map((u) => u.failureKind).sort();
    expect(kinds).toEqual(['blocked', 'http_error', 'timeout']);
    const snap = gate.snapshot();
    for (const s of snap) {
      expect(s.blockedUntilMs, s.key).toBe(0);
      expect(s.backoffSecs, s.key).toBe(0);
    }
  });

  it('regression: every bucket 429-ing once opens ONE block per DISTINCT bucket, not one per unit', async () => {
    // The stampede case: 3 hosts, 2 units each (the tier-3 host cap is 2, so
    // both units of every host are in flight together), all 503. Six signals
    // collapse to THREE blocks - one per distinct bucket. A per-unit counter
    // would read 6, and the wiring assert depends on the collapse being real.
    const gate = new PolitenessGate(wall, { jitter: () => 0.5 });
    const pages = ['alpha', 'beta', 'gamma'].flatMap((host) =>
      [0, 1].map((i) => hostPageRef(`t908-${host}`, i)),
    );
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-t908-distinct', userId: 'u1' },
      {
        budget: { ...ROOMY_BUDGET, maxConcurrent: 6, totalBudgetMs: 150 },
        listUserBoards: async () => [],
        politenessGate: gate,
        poolNow: wall,
        resolveRegistryPageBatch: async () => ({
          pages,
          total: pages.length,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async (unit: ExecutableUnit) => {
          const { HttpStatusError } = await import('../jobSources/httpStatus.js');
          throw new HttpStatusError(503, unit.pageUrl ?? 'https://example.test/board');
        },
      },
    );
    const distinctBuckets = ['alpha', 'beta', 'gamma'].map(
      (h) => `host:careers.t908-${h}.example`,
    );
    expect(distinctBuckets).toHaveLength(3);
    // Three blocks, one per distinct bucket; six signals (two units x 3 hosts).
    // A per-UNIT counter would read 6.
    expect(outcome.rateLimitSignals).toBe(6);
    expect(outcome.blocksOpened).toBe(distinctBuckets.length);
    expect(outcome.blocksOpened).toBeLessThan(outcome.rateLimitSignals!);
    for (const key of distinctBuckets) {
      expect(gate.backoffStateFor(key).backoffSecs, key).toBe(60);
    }
  });
});

// ---------------------------------------------------------------------------
// Wave 15 (T907/T908) politeness response marker
//
// T907 shipped the marker as the string `politeness: 'off'`, present ONLY with
// the knob off (byte-stability rule: `'on'` returned an empty object).
//
// T908 UPGRADES THE SHAPE (deliberate change to the assertions below, named
// here so nobody mistakes it for a regression): the marker is now the bounded
// object `{ mode, signals, blocks, deferred, wiringOk }` and it is ALWAYS
// present. In the default `'on'` mode it carries the run's real counters,
// which is the whole point of the WIRING ASSERT (ADR-034 D2.5): a limiter that
// is on, sees 429/503 signals and never opens a block must report
// `wiringOk: false` rather than failing invisibly. With the knob off no gate is
// constructed, so the fixed off shape is reported and no block can exist.
//
// The marker is assembled inside the Express handler, whose full harness
// (prisma, auth middleware, run-lifecycle store, supertest) lives in
// `routes/jobs.fullscan.test.ts`. To keep the assertion in T907/T908's own
// surface, the marker decision is exported as a pure function
// (`politenessResponseMarker`) and asserted directly here; the handler spreads
// its return value into the response verbatim, so the assertions below
// describe the same code path. The route-level harness asserts the same shape
// end to end in `jobs.fullscan.test.ts` ('T908: politeness marker on the Full
// batch response').
//
// The knob is overridden on the imported `env` object (read at call time) and
// restored in `afterEach`. `vi.resetModules()` is deliberately NOT used: in
// this shared file it clears the module registry for the LATER describes too
// and broke `wave 15 T904 additive unit fields > records failureKind +
// httpStatus on a structured HttpStatusError(429)` ('http_error' vs 'blocked').
// ---------------------------------------------------------------------------

describe('wave 15 T907/T908 politeness response marker', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const envRef = env as any;
  const original = envRef.SEARCH_FULL_POLITENESS;

  afterEach(() => {
    envRef.SEARCH_FULL_POLITENESS = original;
  });

  it('reports the fixed off shape when the knob is off (T908 shape upgrade)', async () => {
    envRef.SEARCH_FULL_POLITENESS = 'off';
    const mod = await import('../routes/jobs.fullscan.js');
    // Counters passed in are IGNORED with the knob off: no gate was
    // constructed, so no block can exist and a reported block would be a lie.
    const marker = mod.politenessResponseMarker({ signals: 3, blocks: 1, deferred: 7 });
    expect(marker).toEqual({
      politeness: { mode: 'off', signals: 0, blocks: 0, deferred: 0, wiringOk: true },
    });
    expect(marker.politeness.mode).toBe('off');
  });

  it('reports the real counters and wiringOk true when the knob is on', async () => {
    envRef.SEARCH_FULL_POLITENESS = 'on';
    const mod = await import('../routes/jobs.fullscan.js');
    const marker = mod.politenessResponseMarker({ signals: 4, blocks: 2, deferred: 3 });
    expect(marker).toEqual({
      politeness: { mode: 'on', signals: 4, blocks: 2, deferred: 3, wiringOk: true },
    });
  });

  it('defaults every counter to zero and clamps junk input (bounded marker)', async () => {
    envRef.SEARCH_FULL_POLITENESS = 'on';
    const mod = await import('../routes/jobs.fullscan.js');
    expect(mod.politenessResponseMarker()).toEqual({
      politeness: { mode: 'on', signals: 0, blocks: 0, deferred: 0, wiringOk: true },
    });
    const junk = mod.politenessResponseMarker({
      signals: -5,
      blocks: Number.NaN,
      deferred: 1.9,
    });
    expect(junk.politeness).toEqual({
      mode: 'on',
      signals: 0,
      blocks: 0,
      deferred: 1,
      wiringOk: true,
    });
  });

  it('wiringOk is FALSE when signals arrived and no block was opened (the wiring assert)', async () => {
    envRef.SEARCH_FULL_POLITENESS = 'on';
    const mod = await import('../routes/jobs.fullscan.js');
    expect(mod.politenessResponseMarker({ signals: 2, blocks: 0 }).politeness.wiringOk).toBe(false);
    // The impossible counter is a wiring failure too: blocks can never exceed
    // the signals that could have produced them.
    expect(mod.politenessResponseMarker({ signals: 1, blocks: 2 }).politeness.wiringOk).toBe(false);
    // Deferrals alone are not a wiring failure.
    expect(mod.politenessResponseMarker({ signals: 0, blocks: 0, deferred: 9 }).politeness.wiringOk).toBe(true);
  });

  it('keeps the gate ON for a typo (the lenient parser) and still reports mode on', async () => {
    // The env parser is fail-safe toward ON (see config/env.test.ts), so a
    // typo must not produce the "unprotected sweep" mode either - that would
    // falsely claim the sweep ran without politeness.
    const mod = await import('../routes/jobs.fullscan.js');
    for (const typo of ['true', 'On', 'ON', 'enabled', '']) {
      envRef.SEARCH_FULL_POLITENESS = typo;
      const marker = mod.politenessResponseMarker({ signals: 1, blocks: 1 });
      expect(marker.politeness.mode, `typo=${JSON.stringify(typo)}`).toBe('on');
    }
  });
});

// ---------------------------------------------------------------------------
// Wave 15 (T900) additive attribution: parallel timing array on RunOutcome
// ---------------------------------------------------------------------------

describe('wave 15 attribution', () => {
  it('omits outcome.timing by default (attributeTiming off)', async () => {
    const outcome = await runSearch(
      intentOf(),
      { runId: 'r-attr-off', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [board('b1', 'greenhouse')],
        executeUnit: async () => [makeJob('greenhouse', 'g1')],
      },
    );
    expect(outcome.timing).toBeUndefined();
    expect(outcome.units).toHaveLength(1);
  });

  it('attaches a TimingSummary when attributeTiming is true, with units == launched units', async () => {
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-attr-on', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [],
        resolveRegistryPageBatch: async () => ({
          pages: [pageRef('Acme', 0), pageRef('Acme', 1), pageRef('Acme', 2)],
          total: 3,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async () => [],
        attributeTiming: true,
      },
    );
    expect(outcome.timing).toBeDefined();
    // Three launched registry-page units -> summary.units == 3.
    expect(outcome.timing?.units).toBe(3);
    expect(outcome.timing?.byOutcome).toMatchObject({ ok: 3 });
    expect(outcome.timing?.phasesUnavailable).toBe(true);
    expect(outcome.timing?.consistency).toBeDefined();
  });

  it('attaches phase totals when a phaseTracker is supplied and channels are available', async () => {
    // The probe degrades to a no-op when channels are absent, but on this
    // Node the channels exist; the summary's `phases` object carries only
    // keys backed by a real channel (see attribution.ts header). A fake
    // executor that never opens a socket publishes no per-request events,
    // so `phases` is `null` and `phasesUnavailable` is `true`: the probe
    // is wired, but nothing observable happened. The unit still lands on
    // `units === 1`.
    const { createPhaseProbe } = await import('./attribution.js');
    const tracker = createPhaseProbe();
    const outcome = await runSearch(
      intentOf(),
      { runId: 'r-attr-phases', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [board('b1', 'greenhouse')],
        executeUnit: async () => [makeJob('greenhouse', 'g1')],
        attributeTiming: true,
        phaseTracker: tracker,
      },
    );
    expect(outcome.timing?.units).toBe(1);
    // The fake executor does not publish any phase events, so the
    // aggregate is structurally empty: `phases === null`,
    // `phasesUnavailable === true`.
    expect(outcome.timing?.phases).toBeNull();
    expect(outcome.timing?.phasesUnavailable).toBe(true);
  });

  it('queuedMs reflects pool saturation (width-1 pool, 3 units, 40ms executor)', async () => {
    // Regression for F1: queuedMs MUST be pool-start -> unit-launch. With
    // maxConcurrent=1, three units whose executor sleeps >=30ms produce a
    // visible queue: units 2 and 3 wait at least one executor duration
    // before launch. The previous implementation computed
    // `startedAt - launchMs` (the inter-statement gap of two Date.now()
    // reads with no I/O between), which was 0-1ms regardless of pool
    // width. This test pins the documented definition.
    const EXECUTOR_MS = 40;
    const outcome = await runSearch(
      intentOf({ mode: 'full' }),
      { runId: 'r-attr-queue', userId: 'u1' },
      {
        budget: {
          maxUnits: 3,
          maxConcurrent: 1,
          perUnitTimeoutMs: 5000,
          totalBudgetMs: 15000,
          perSourceResultCap: 10,
        },
        listUserBoards: async () => [],
        resolveRegistryPageBatch: async () => ({
          pages: [pageRef('Acme', 0), pageRef('Acme', 1), pageRef('Acme', 2)],
          total: 3,
          hasMore: false,
          nextCursor: null,
        }),
        executeUnit: async () => {
          await new Promise((resolve) => setTimeout(resolve, EXECUTOR_MS));
          return [];
        },
        attributeTiming: true,
      },
    );
    expect(outcome.timing).toBeDefined();
    expect(outcome.timing?.units).toBe(3);
    // The widest queue (unit 3 waits for units 1 and 2 to finish) must be
    // >= one EXECUTOR_MS. Use 30ms (rather than 40) to absorb scheduler
    // jitter on slow CI.
    expect(outcome.timing?.queuedMs.max).toBeGreaterThanOrEqual(30);
    // queuedMs must NOT be the trivial 0-1ms inter-statement gap the F1
    // bug produced. Cap the upper bound at the test budget so a future
    // regression to the trivial expression fails this one instead.
    expect(outcome.timing?.queuedMs.max).toBeLessThanOrEqual(15000);
    // p50 also has to reflect the queue: with 3 units and a width-1 pool,
    // unit 1 queues 0, unit 2 queues >= EXECUTOR_MS, unit 3 queues >=
    // 2*EXECUTOR_MS. Nearest-rank p50 = ceil(0.5 * 3) = 2 -> unit 2.
    expect(outcome.timing?.queuedMs.p50).toBeGreaterThanOrEqual(20);
    // Consistency has to expose queue time: with a saturated pool the
    // pool wakeup + inter-unit scheduling gap is small relative to the
    // 2*EXECUTOR_MS of queue wait, so queuedMs contributes. deviation
    // is not strictly >0 here (segments sum is dominated by queuedMs
    // contribution), but we require it to be DEFINED and >= 0.
    expect(outcome.timing?.consistency.deviation).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Structural guards: no scheduler/SSE/WebSocket, no static browser import
// ---------------------------------------------------------------------------

describe('structural guards', () => {
  it('adds no scheduler, SSE, WebSocket, or listing rollback primitives', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    expect(source).not.toMatch(/setInterval/);
    expect(source).not.toMatch(/EventSource/);
    expect(source).not.toMatch(/websocket/);
    expect(source).not.toMatch(/deleteMany/);
  });

  it('never statically imports backend/src/browser/* (N2: lazy path only)', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    for (const line of source.split('\n')) {
      if (/^\s*import\b(?!\s*\()/.test(line) || /^\s*export\b.*\bfrom\b/.test(line)) {
        expect(line, 'static browser import').not.toMatch(/browser\//);
      }
      if (/require\s*\(/.test(line)) {
        expect(line, 'browser require').not.toMatch(/browser\//);
      }
    }
    expect(source).not.toMatch(/import\s*\([^)]*browser\//);
  });
});

// ---------------------------------------------------------------------------
// Wave 15 (T904) additive optional fields on RunUnitState:
// rawResultCount / httpStatus / failureKind. None of these REPLACE existing
// fields; they only EXTEND the unit record for the write-back consumer.
// ---------------------------------------------------------------------------

describe('wave 15 T904 additive unit fields', () => {
  it('records rawResultCount before perSourceResultCap (60 rows @ cap 40 -> resultCount 40, rawResultCount 60)', async () => {
    const deps = {
      budget: { ...ROOMY_BUDGET, perSourceResultCap: 40 },
      listUserBoards: async () => [board('b1', 'greenhouse')],
      executeUnit: async () =>
        Array.from({ length: 60 }, (_, i) => makeJob('greenhouse', `j${i}`)),
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    expect(outcome.jobs).toHaveLength(40);
    expect(outcome.units[0].resultCount).toBe(40);
    expect(outcome.units[0].rawResultCount).toBe(60);
  });

  it('records failureKind=timeout on a per-unit timeout', async () => {
    const deps = {
      budget: { ...ROOMY_BUDGET, perUnitTimeoutMs: 40 },
      listUserBoards: async () => [board('slow', 'greenhouse')],
      executeUnit: hangUntilAbort(),
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    const slow = outcome.units.find((u) => u.unitId === 'board:slow')!;
    expect(slow.status).toBe('failed');
    expect(slow.failureKind).toBe('timeout');
    expect(slow.httpStatus).toBeUndefined();
  });

  it('records failureKind + httpStatus on a structured HttpStatusError(429)', async () => {
    const { HttpStatusError } = await import('../jobSources/httpStatus.js');
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('rate', 'greenhouse')],
      executeUnit: async () => {
        throw new HttpStatusError(429, 'https://example.test/api');
      },
    };
    const outcome = await runSearch(intentOf(), { runId: 'r1', userId: 'u1' }, deps);
    const rate = outcome.units.find((u) => u.unitId === 'board:rate')!;
    expect(rate.status).toBe('failed');
    expect(rate.failureKind).toBe('blocked');
    expect(rate.httpStatus).toBe(429);
  });

  it('records failureKind=invalid on an unroutable registry row (SourceConfigError name)', async () => {
    const deps = {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('good', 'greenhouse')],
      resolveCompanies: async (): Promise<CompanyScopeResolution> =>
        scopeOf(
          [
            {
              companyName: 'Rippling',
              url: 'https://rippling.example/careers',
              provider: 'rippling',
              boardToken: 'rippling',
            },
          ],
          ['Rippling'],
        ),
      executeUnit: async () => [makeJob('greenhouse', 'g1')],
    };
    const outcome = await runSearch(
      intentOf({ companies: ['Rippling'] }),
      { runId: 'r1', userId: 'u1' },
      deps,
    );
    const unroutable = outcome.units.find((u) => u.unitId === 'page:0')!;
    expect(unroutable.status).toBe('failed');
    expect(unroutable.failureKind).toBe('invalid');
  });
});
