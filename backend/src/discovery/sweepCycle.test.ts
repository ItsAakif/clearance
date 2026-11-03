// Cycle runner contract (discovery/sweepCycle.ts).
//
// Everything runs against fakes: a settings map standing in for AppSetting, a
// page list standing in for the registry, and a fake JobListing store for the
// soft-close. Pins:
//   - the batch loop accumulates every counter and stops on exhaustion;
//   - the hard stops (maxBatches / maxMinutes) leave a resumable cursor and
//     never report completion;
//   - a cycle resumes from the stored cursor and keeps the original start stamp;
//   - soft-close happens ONLY on completion + closeAfterCycle, with the exact
//     source-scoped, isActive-scoped, lastVerifiedAt-bounded predicate;
//   - dry run fetches/persists nothing and reports the due-board count.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SWEEPED_SOURCES,
  SWEEP_PROVIDER_SOURCES,
  closeStalePostings,
  runSweepCycle,
  type JobListingCloseStore,
  type StaleCloseFilter,
  type SweepCycleBatchOptions,
  type SweepCycleDeps,
} from './sweepCycle.js';
import type { SweepResult } from './boardSweep.js';

interface FakePage {
  id: string;
  provider: string;
  boardToken: string;
}

interface Harness {
  deps: SweepCycleDeps;
  state: { cursor: string; cycle: number; startedAt: string };
  batchCalls: SweepCycleBatchOptions[];
  closeCalls: StaleCloseFilter[];
  progress: Array<{ batch: number; boards: number; cursor: string }>;
  runCycle(options?: Partial<Parameters<typeof runSweepCycle>[1]>): ReturnType<typeof runSweepCycle>;
}

const PAGES: FakePage[] = [
  { id: 'p1', provider: 'greenhouse', boardToken: 'acme' },
  { id: 'p2', provider: 'breezy', boardToken: 'beta' },
  { id: 'p3', provider: 'workable', boardToken: 'gamma' },
  { id: 'p4', provider: 'lever', boardToken: 'delta' },
  { id: 'p5', provider: 'rippling', boardToken: 'epsilon' },
];

function sweepResult(over: Partial<SweepResult>): SweepResult {
  return {
    boards: 0,
    ok: 0,
    failed: 0,
    rowsFetched: 0,
    rowsPersisted: 0,
    nextCursor: '',
    exhausted: false,
    failures: [],
    deactivated: 0,
    backedOff: 0,
    ...over,
  };
}

/**
 * Fake cycle deps over a page list. Each visited board yields 3 fetched rows
 * and 2 persisted rows; the first board of every batch fails once so the
 * ok/failed split is non-trivial.
 */
function harness(
  pages: FakePage[] = PAGES,
  options: { batchDelayMs?: number; closedCount?: number; seedCursor?: string; seedStartedAt?: string } = {},
): Harness {
  const state = {
    cursor: options.seedCursor ?? '',
    cycle: 0,
    startedAt: options.seedStartedAt ?? '',
  };
  const batchCalls: SweepCycleBatchOptions[] = [];
  const closeCalls: StaleCloseFilter[] = [];
  const progress: Array<{ batch: number; boards: number; cursor: string }> = [];

  const deps: SweepCycleDeps = {
    readCursor: async () => state.cursor,
    // Mirrors persistSweepCursor in routes/jobs.ts: a full batch advances the
    // cursor, an exhausted batch resets it and bumps the cycle counter.
    persistCursor: async (result) => {
      if (result.exhausted) {
        state.cursor = '';
        state.cycle += 1;
        return;
      }
      state.cursor = result.nextCursor;
    },
    readCycleStartedAt: async () => state.startedAt,
    writeCycleStartedAt: async (value) => {
      state.startedAt = value;
    },
    runBatch: async (o) => {
      batchCalls.push(o);
      if (options.batchDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.batchDelayMs));
      }
      const rows = pages
        .filter((p) => p.id > o.cursor)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, o.maxBoards);
      if (rows.length === 0) {
        return sweepResult({ exhausted: pages.length < o.maxBoards, nextCursor: o.cursor });
      }
      return sweepResult({
        boards: rows.length,
        ok: rows.length - 1,
        failed: 1,
        rowsFetched: rows.length * 3,
        rowsPersisted: rows.length * 2,
        nextCursor: rows[rows.length - 1].id,
        exhausted: rows.length < o.maxBoards,
        deactivated: 0,
        backedOff: 1,
      });
    },
    countDueBoards: async () => pages.length,
    closeStale: async (filter) => {
      closeCalls.push(filter);
      return options.closedCount ?? 4;
    },
    onBatch: (info) => progress.push({ batch: info.batch, boards: info.boards, cursor: info.cursor }),
  };

  return {
    deps,
    state,
    batchCalls,
    closeCalls,
    progress,
    runCycle: (over = {}) =>
      runSweepCycle(deps, {
        batchSize: 2,
        maxRowsPerBatch: 100,
        concurrency: 4,
        perBoardTimeoutMs: 1000,
        maxBatches: 10,
        maxMinutes: 0,
        closeAfterCycle: true,
        ...over,
      }),
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.useRealTimers();
});

describe('runSweepCycle - batch loop', () => {
  it('walks the registry in batches and completes when the cursor wraps', async () => {
    const h = harness();
    const result = await h.runCycle();

    // 5 boards / batchSize 2 -> 3 batches, the last one short = wrap.
    expect(result.batches).toBe(3);
    expect(h.batchCalls.map((c) => c.cursor)).toEqual(['', 'p2', 'p4']);
    expect(h.batchCalls[0]).toMatchObject({
      maxBoards: 2,
      maxRows: 100,
      concurrency: 4,
      perBoardTimeoutMs: 1000,
    });

    expect(result.boards).toBe(5);
    expect(result.ok).toBe(2);
    expect(result.failed).toBe(3);
    expect(result.rowsFetched).toBe(15);
    expect(result.rowsPersisted).toBe(10);
    expect(result.backedOff).toBe(3);
    expect(result.completed).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    // Cursor persistence mirrors the route: p2, p4, then wrap.
    expect(h.state.cursor).toBe('');
    expect(h.state.cycle).toBe(1);
    expect(h.progress.map((p) => p.cursor)).toEqual(['p2', 'p4', '(wrapped)']);
  });

  it('stamps the cycle start on the first batch and clears it on completion', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00.000Z') });
    const h = harness();
    const result = await h.runCycle();

    expect(result.completed).toBe(true);
    // Cleared after completion.
    expect(h.state.startedAt).toBe('');
    const stamps = logSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((line: string) => line.startsWith('[sweep-cycle] close'));
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toContain('cycleStartedAt=2026-01-01T00:00:00.000Z');
  });

  it('logs one structured line per batch with no urls', async () => {
    const h = harness();
    await h.runCycle();
    const lines = logSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((line: string) => line.startsWith('[sweep-cycle] batch='));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^\[sweep-cycle\] batch=1 boards=2 ok=1 failed=1 fetched=6 persisted=4 cursor=p2 elapsed=\d+\.\ds totalBoards=2$/,
    );
    for (const line of lines) expect(line).not.toMatch(/https?:\/\//);
  });
});

describe('runSweepCycle - hard stops', () => {
  it('stops at maxBatches without completing and keeps the cursor resumable', async () => {
    const h = harness();
    const result = await h.runCycle({ maxBatches: 2 });

    expect(result.batches).toBe(2);
    expect(result.completed).toBe(false);
    expect(result.boards).toBe(4);
    expect(h.state.cursor).toBe('p4');
    expect(h.state.cycle).toBe(0);
    // A started but unfinished cycle keeps its stamp for the resuming run.
    expect(h.state.startedAt).not.toBe('');
    expect(h.closeCalls).toHaveLength(0);
  });

  it('stops at maxMinutes without completing', async () => {
    const h = harness(PAGES, { batchDelayMs: 60 });
    // 0.0005 min = 30ms: the first batch already consumes the budget.
    const result = await h.runCycle({ maxMinutes: 0.0005 });

    expect(result.batches).toBe(1);
    expect(result.completed).toBe(false);
    expect(h.state.cursor).toBe('p2');
    expect(h.state.startedAt).not.toBe('');
    expect(h.closeCalls).toHaveLength(0);
  });

  it('resumes from the stored cursor without restamping the cycle start', async () => {
    const h = harness(PAGES, {
      seedCursor: 'p2',
      seedStartedAt: '2025-12-31T00:00:00.000Z',
    });
    const result = await h.runCycle();

    expect(h.batchCalls[0].cursor).toBe('p2');
    expect(result.completed).toBe(true);
    expect(result.boards).toBe(3);
    expect(h.closeCalls).toHaveLength(1);
    expect(h.closeCalls[0].cycleStartedAt.toISOString()).toBe('2025-12-31T00:00:00.000Z');
  });

  it('skips the close on a resumed cycle with no start stamp', async () => {
    const h = harness(PAGES, { seedCursor: 'p2', seedStartedAt: '' });
    const result = await h.runCycle();

    expect(result.completed).toBe(true);
    expect(result.closed).toBe(0);
    expect(h.closeCalls).toHaveLength(0);
  });
});

describe('runSweepCycle - soft-close gating', () => {
  it('closes only when the cycle completed and closeAfterCycle is on', async () => {
    const h = harness();
    const result = await h.runCycle({ closeAfterCycle: true });
    expect(result.completed).toBe(true);
    expect(result.closed).toBe(4);
    expect(h.closeCalls).toHaveLength(1);
    expect(h.closeCalls[0].sources).toEqual(SWEEPED_SOURCES);
    expect(h.closeCalls[0].dryRun).toBeUndefined();
  });

  it('does not close when closeAfterCycle is off', async () => {
    const h = harness();
    const result = await h.runCycle({ closeAfterCycle: false });
    expect(result.completed).toBe(true);
    expect(result.closed).toBe(0);
    expect(h.closeCalls).toHaveLength(0);
  });

  it('does not close a cycle that hit a limit', async () => {
    const h = harness();
    const result = await h.runCycle({ maxBatches: 1, closeAfterCycle: true });
    expect(result.completed).toBe(false);
    expect(result.closed).toBe(0);
    expect(h.closeCalls).toHaveLength(0);
  });

  it('does not close when the cycle swept no boards', async () => {
    const h = harness([]);
    const result = await h.runCycle();
    expect(result.completed).toBe(true);
    expect(result.closed).toBe(0);
    expect(h.closeCalls).toHaveLength(0);
  });

  it('a close failure is logged and does not throw', async () => {
    const h = harness();
    h.deps.closeStale = async () => {
      throw new Error('jobListing updateMany failed');
    };
    const result = await h.runCycle();
    expect(result.completed).toBe(true);
    expect(result.closed).toBe(0);
    const lines = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines.some((line: string) => line.includes('close failed: jobListing updateMany failed'))).toBe(true);
    // Completion still cleared the start stamp.
    expect(h.state.startedAt).toBe('');
  });
});

describe('runSweepCycle - dry run', () => {
  it('reports the due-board count and fetches/persists nothing', async () => {
    const h = harness();
    const result = await h.runCycle({ dryRun: true });

    expect(result.boards).toBe(PAGES.length);
    expect(result.batches).toBe(0);
    expect(result.rowsFetched).toBe(0);
    expect(result.rowsPersisted).toBe(0);
    expect(result.completed).toBe(false);
    expect(h.batchCalls).toHaveLength(0);
    expect(h.closeCalls).toHaveLength(0);
    // The cursor and cycle stamp are untouched by a preflight.
    expect(h.state.cursor).toBe('');
    expect(h.state.startedAt).toBe('');
    const lines = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(lines.some((line: string) => line === `[sweep-cycle] dry-run boards=${PAGES.length} (no fetch, no persist)`)).toBe(true);
  });
});

describe('closeStalePostings - selection', () => {
  function fakeStore() {
    const calls: Array<{ kind: 'count' | 'updateMany'; where: unknown; data?: unknown }> = [];
    const store: JobListingCloseStore = {
      jobListing: {
        count: async ({ where }) => {
          calls.push({ kind: 'count', where });
          return 9;
        },
        updateMany: async ({ where, data }) => {
          calls.push({ kind: 'updateMany', where, data });
          return { count: 5 };
        },
      },
    };
    return { store, calls };
  }

  const cycleStartedAt = new Date('2026-02-02T02:02:02.000Z');

  it('deactivates only active, unseen, swept-source rows in one statement', async () => {
    const { store, calls } = fakeStore();
    const closed = await closeStalePostings(store, { cycleStartedAt, sources: SWEEPED_SOURCES });

    expect(closed).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('updateMany');
    expect(calls[0].data).toEqual({ isActive: false });
    expect(calls[0].where).toEqual({
      isActive: true,
      lastVerifiedAt: { lt: cycleStartedAt },
      source: { in: [...SWEEPED_SOURCES] },
    });
  });

  it('never includes aggregator sources', async () => {
    const { store, calls } = fakeStore();
    await closeStalePostings(store, { cycleStartedAt, sources: SWEEPED_SOURCES });
    const where = calls[0].where as { source: { in: string[] } };
    for (const aggregator of ['rss', 'json', 'adzuna', 'jobicy', 'hnalgolia', 'workday']) {
      expect(where.source.in).not.toContain(aggregator);
    }
    expect(where.source.in).toContain('breezyhr');
    expect(where.source.in).toContain('pinpoint');
  });

  it('counts instead of updating on a dry run', async () => {
    const { store, calls } = fakeStore();
    const closed = await closeStalePostings(store, {
      cycleStartedAt,
      sources: SWEEPED_SOURCES,
      dryRun: true,
    });
    expect(closed).toBe(9);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('count');
  });

  it('refuses an empty source list (no unscoped deactivation)', async () => {
    const { store, calls } = fakeStore();
    const closed = await closeStalePostings(store, { cycleStartedAt, sources: [] });
    expect(closed).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('canonical source map', () => {
  it('translates the two registry ids that differ from the adapter source names', () => {
    expect(SWEEP_PROVIDER_SOURCES.breezy).toBe('breezyhr');
    expect(SWEEP_PROVIDER_SOURCES.pinpointhq).toBe('pinpoint');
    expect(SWEEPED_SOURCES).toHaveLength(13);
    expect(new Set(SWEEPED_SOURCES).size).toBe(13);
  });
});
