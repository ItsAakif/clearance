// Sweep cycle - run the WHOLE company registry in one long, resumable pass.
//
// A single `sweepBoards` batch (boardSweep.ts) is bounded by design: it walks a
// keyset slice and a later call continues from the stored cursor. This module
// adds the loop around that primitive - the "cycle" - so one operator call (or
// one scheduler tick) can cover the registry without the caller having to
// babysit the cursor:
//
//   batch -> persist cursor -> (exhausted ? wrap + close : continue)
//
// The pass is RESUMABLE: the cursor is written after every batch through the
// same dependency the route uses (`AppSetting` `deepSweep:cursor`), so killing
// the process mid-cycle loses at most the batch in flight and a later run
// continues from that point. Nothing here holds the cursor in memory beyond the
// current batch.
//
// COMPLETION means "the cursor wrapped": a batch came back `exhausted`
// (pages.length < maxBoards). Only completion allows soft-close, because only
// then has every due board been visited at least once.
//
// SOFT-CLOSE (when `closeAfterCycle` and the cycle completed): deactivate the
// `JobListing` rows the pass did not see. The safety conditions are all in
// `closeStalePostings` / `runSweepCycle`:
//   - only `source IN (<canonical sources of the swept providers>)`. RSS/JSON/
//     search aggregators cannot be swept by a board pass, so touching them
//     would be data loss (they are refreshed by their own sources);
//   - only rows with `isActive = true` (idempotent: the second run matches 0);
//   - only rows with `lastVerifiedAt < cycleStartedAt`. `upsertDiscoveredJobs`
//     stamps `lastVerifiedAt = now` on every persisted row, so a row this
//     cycle saw can never satisfy the predicate. A NULL `lastVerifiedAt` is
//     never closed either (NULL comparison is not true - conservative);
//   - only when the cycle actually swept at least one board, and only when the
//     cycle start stamp is present. A resumed cycle with no stamp (e.g. the
//     setting was cleared by hand) skips the close instead of guessing.
//
// CYCLE START: `AppSetting` `deepSweep:cycleStartedAt` is stamped (ISO) at the
// first batch of a cycle - the commit point where the cursor is empty - and
// cleared when the cycle completes. It is stamped BEFORE the first fetch so
// every row the cycle persists carries `lastVerifiedAt > cycleStartedAt`.
//
// Dependency-injected like boardSweep.ts: no Prisma import and no adapter
// import here, so the loop, the hard stops, the resume behaviour and the
// close selection are unit-testable with fakes.

import type { SweepResult } from './boardSweep.js';

export interface SweepCycleOptions {
  /** Boards per batch. */
  batchSize: number;
  maxRowsPerBatch: number;
  concurrency: number;
  perBoardTimeoutMs: number;
  /** Hard stop: never run more than this many batches in one call. */
  maxBatches: number;
  /** Wall-clock stop in minutes; <= 0 means no clock limit. */
  maxMinutes: number;
  /** Soft-close when the cursor wraps (see module header). */
  closeAfterCycle: boolean;
  /** Report only how many boards are due - fetch nothing, persist nothing. */
  dryRun?: boolean;
}

export interface CycleResult {
  batches: number;
  boards: number;
  ok: number;
  failed: number;
  rowsFetched: number;
  rowsPersisted: number;
  deactivated: number;
  backedOff: number;
  closed: number;
  elapsedMs: number;
  /** True only when the cursor wrapped (a batch came back `exhausted`). */
  completed: boolean;
}

/** One batch as the cycle requests it (cursor is the cycle's own, not the store's). */
export interface SweepCycleBatchOptions {
  cursor: string;
  maxBoards: number;
  maxRows: number;
  concurrency: number;
  perBoardTimeoutMs: number;
}

/** Structured per-batch progress handed to `onBatch` (no urls, no secrets). */
export interface SweepCycleProgress {
  batch: number;
  boards: number;
  ok: number;
  failed: number;
  fetched: number;
  persisted: number;
  cursor: string;
  elapsedMs: number;
  completed: boolean;
}

export interface SweepCycleDeps {
  /** Read the sweep cursor (`deepSweep:cursor`). */
  readCursor(): Promise<string>;
  /** Persist the cursor/cycle state exactly as the single-batch route does. */
  persistCursor(result: SweepResult): Promise<void>;
  /** Read the cycle start stamp (`deepSweep:cycleStartedAt`); '' when absent. */
  readCycleStartedAt(): Promise<string>;
  /** Write the cycle start stamp, or '' to clear it. */
  writeCycleStartedAt(value: string): Promise<void>;
  /** Run exactly one `sweepBoards` batch at an explicit cursor. */
  runBatch(options: SweepCycleBatchOptions): Promise<SweepResult>;
  /** Number of boards a cycle would visit now (dry run / preflight). */
  countDueBoards(): Promise<number>;
  /** Deactivate (or, when `dryRun`, count) the rows the cycle did not see. */
  closeStale(filter: StaleCloseFilter): Promise<number>;
  /** Optional structured progress sink (tests, scripts). The log still prints. */
  onBatch?(progress: SweepCycleProgress): void;
  /** Optional: recompute the unfiltered catalogue facet cache after completion. */
  refreshFacetCache?(): Promise<void>;
}

/**
 * Canonical `JobListing.source` per registry provider id. The registry's host
 * table spells two of them differently from the adapters' `source` field
 * (`breezy` -> `breezyhr`, `pinpointhq` -> `pinpoint`), so the sweep summary
 * and the soft-close filter must translate instead of copying the registry id.
 */
export const SWEEP_PROVIDER_SOURCES: Readonly<Record<string, string>> = {
  greenhouse: 'greenhouse',
  ashby: 'ashby',
  lever: 'lever',
  workable: 'workable',
  bamboohr: 'bamboohr',
  breezy: 'breezyhr',
  jobvite: 'jobvite',
  pinpointhq: 'pinpoint',
  teamtailor: 'teamtailor',
  recruitee: 'recruitee',
  smartrecruiters: 'smartrecruiters',
  freshteam: 'freshteam',
  rippling: 'rippling',
};

/**
 * Every source a complete, unfiltered cycle swept. A soft-close is scoped to
 * exactly this list; aggregator sources (rss/json/search) are never in it.
 */
export const SWEEPED_SOURCES: readonly string[] = [...new Set(Object.values(SWEEP_PROVIDER_SOURCES))];

export interface StaleCloseFilter {
  cycleStartedAt: Date;
  sources: readonly string[];
  /** Count only - the caller asked for a dry run. */
  dryRun?: boolean;
}

/** The predicate of the soft-close. Kept exported so tests can pin it. */
export interface StaleCloseWhere {
  isActive: true;
  lastVerifiedAt: { lt: Date };
  source: { in: string[] };
}

/**
 * The two `JobListing` calls the soft-close needs. Structural on purpose: the
 * real Prisma client satisfies it without a cast, and a fake store can record
 * the exact `where` it was handed.
 */
export interface JobListingCloseStore {
  jobListing: {
    count(args: { where: StaleCloseWhere }): Promise<number>;
    updateMany(args: {
      where: StaleCloseWhere;
      data: { isActive: false };
    }): Promise<{ count: number }>;
  };
}

/**
 * Soft-close: ONE statement (or one count, when `dryRun`) selecting the rows a
 * complete cycle did not verify. Idempotent - `isActive: true` makes the second
 * run match nothing - and source-scoped so a board pass can never deactivate a
 * row an aggregator owns.
 */
export async function closeStalePostings(
  store: JobListingCloseStore,
  filter: StaleCloseFilter,
): Promise<number> {
  const sources = [...new Set(filter.sources.filter((s) => typeof s === 'string' && s.length > 0))];
  if (sources.length === 0) return 0;
  const where: StaleCloseWhere = {
    isActive: true,
    lastVerifiedAt: { lt: filter.cycleStartedAt },
    source: { in: sources },
  };
  if (filter.dryRun) return store.jobListing.count({ where });
  const updated = await store.jobListing.updateMany({ where, data: { isActive: false } });
  return typeof updated?.count === 'number' ? updated.count : 0;
}

/** Cycle batch defaults shared by the scheduler and the CLI script. */
export const DEFAULT_CYCLE_BATCH_SIZE = 500;
export const DEFAULT_CYCLE_MAX_ROWS_PER_BATCH = 5000;
export const DEFAULT_CYCLE_CONCURRENCY = 8;
export const DEFAULT_CYCLE_PER_BOARD_TIMEOUT_MS = 20_000;

const LOG_PREFIX = '[sweep-cycle]';

function log(line: string): void {
  console.log(line);
}

function positiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function parseStamp(raw: string): Date | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Run the registry in one resumable pass.
 *
 * Hard stops (`maxBatches`, `maxMinutes`) are checked BETWEEN batches: a batch
 * already in flight finishes, its rows persist and its cursor is written, so a
 * stopped cycle resumes exactly where it stopped.
 *
 * `completed` is true only when a batch came back `exhausted` - a limit stop is
 * an unfinished cycle, and an unfinished cycle never soft-closes.
 */
export async function runSweepCycle(
  deps: SweepCycleDeps,
  options: SweepCycleOptions,
): Promise<CycleResult> {
  const startedAt = Date.now();
  const result: CycleResult = {
    batches: 0,
    boards: 0,
    ok: 0,
    failed: 0,
    rowsFetched: 0,
    rowsPersisted: 0,
    deactivated: 0,
    backedOff: 0,
    closed: 0,
    elapsedMs: 0,
    completed: false,
  };

  // Dry run: the preflight the Action uses. Nothing is fetched, persisted or
  // re-activated - it only answers "how many boards is an unfiltered cycle
  // due to visit right now?" (`boards` carries that count).
  if (options.dryRun) {
    const due = await deps.countDueBoards();
    result.boards = due;
    result.elapsedMs = Date.now() - startedAt;
    log(`${LOG_PREFIX} dry-run boards=${due} (no fetch, no persist)`);
    return result;
  }

  const batchSize = positiveInt(options.batchSize, DEFAULT_CYCLE_BATCH_SIZE);
  const maxRows = positiveInt(options.maxRowsPerBatch, DEFAULT_CYCLE_MAX_ROWS_PER_BATCH);
  const concurrency = positiveInt(options.concurrency, DEFAULT_CYCLE_CONCURRENCY);
  const perBoardTimeoutMs = positiveInt(
    options.perBoardTimeoutMs,
    DEFAULT_CYCLE_PER_BOARD_TIMEOUT_MS,
  );
  const maxBatches = Number.isFinite(options.maxBatches)
    ? Math.max(0, Math.floor(options.maxBatches))
    : 0;
  const deadline =
    Number.isFinite(options.maxMinutes) && options.maxMinutes > 0
      ? startedAt + options.maxMinutes * 60_000
      : Number.POSITIVE_INFINITY;

  const cursorAtStart = await deps.readCursor();
  let cycleStartedAt = await deps.readCycleStartedAt();
  if (cursorAtStart === '') {
    // A cycle begins here. Stamp it BEFORE the first fetch: every row this
    // pass persists then carries `lastVerifiedAt > cycleStartedAt`, which is
    // exactly the predicate the soft-close excludes.
    cycleStartedAt = new Date().toISOString();
    await deps.writeCycleStartedAt(cycleStartedAt);
  }

  let cursor = cursorAtStart;
  let sweptBoards = 0;
  let stoppedEarly = false;

  for (;;) {
    if (result.batches >= maxBatches) break;
    if (Date.now() >= deadline) {
      stoppedEarly = true;
      break;
    }

    const batch = await deps.runBatch({
      cursor,
      maxBoards: batchSize,
      maxRows,
      concurrency,
      perBoardTimeoutMs,
    });

    result.batches += 1;
    result.boards += batch.boards;
    result.ok += batch.ok;
    result.failed += batch.failed;
    result.rowsFetched += batch.rowsFetched;
    result.rowsPersisted += batch.rowsPersisted;
    result.deactivated += batch.deactivated;
    result.backedOff += batch.backedOff;
    sweptBoards += batch.boards;

    // The cursor is written after EVERY batch (the route's own persistence
    // helper), so a crash/limit stop resumes from here.
    await deps.persistCursor(batch);

    const batchElapsed = Date.now() - startedAt;
    const cursorLabel = batch.exhausted ? '(wrapped)' : batch.nextCursor;
    const progress: SweepCycleProgress = {
      batch: result.batches,
      boards: batch.boards,
      ok: batch.ok,
      failed: batch.failed,
      fetched: batch.rowsFetched,
      persisted: batch.rowsPersisted,
      cursor: cursorLabel,
      elapsedMs: batchElapsed,
      completed: batch.exhausted,
    };
    log(
      `${LOG_PREFIX} batch=${progress.batch} boards=${progress.boards} ok=${progress.ok} ` +
        `failed=${progress.failed} fetched=${progress.fetched} persisted=${progress.persisted} ` +
        `cursor=${progress.cursor} elapsed=${seconds(progress.elapsedMs)} ` +
        `totalBoards=${sweptBoards}`,
    );
    deps.onBatch?.(progress);

    if (batch.exhausted) {
      result.completed = true;
      cursor = '';
      break;
    }

    cursor = batch.nextCursor;
    if (batch.boards === 0) {
      // Defensive: a batch that visited nothing but did not report exhaustion
      // would spin. Stop and leave the cursor where it is so the next run can
      // retry the same page.
      log(`${LOG_PREFIX} empty non-final batch at cursor=${cursor} - stopping`);
      break;
    }
  }

  result.elapsedMs = Date.now() - startedAt;

  if (result.completed && options.closeAfterCycle) {
    const startedDate = parseStamp(cycleStartedAt);
    if (startedDate === null) {
      log(`${LOG_PREFIX} close skipped: no cycle start stamp on a resumed cycle`);
    } else if (sweptBoards === 0) {
      log(`${LOG_PREFIX} close skipped: the cycle swept no boards`);
    } else {
      try {
        result.closed = await deps.closeStale({
          cycleStartedAt: startedDate,
          sources: SWEEPED_SOURCES,
        });
        log(
          `${LOG_PREFIX} close closed=${result.closed} sources=${SWEEPED_SOURCES.length} ` +
            `cycleStartedAt=${startedDate.toISOString()}`,
        );
      } catch (error) {
        // A close failure must not lose the completed cycle's own bookkeeping;
        // the rows stay active (safe default) and the next cycle retries.
        const message = error instanceof Error ? error.message : String(error);
        log(`${LOG_PREFIX} close failed: ${message}`);
      }
    }
  }

  if (result.completed) {
    // The active set was just verified end-to-end; refresh the unfiltered facet
    // cache now rather than making the next browse request pay for it.
    try {
      await deps.refreshFacetCache?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`${LOG_PREFIX} facet cache refresh failed: ${message}`);
    }
    // Completion clears the stamp (next cycle stamps its own).
    await deps.writeCycleStartedAt('');
  } else if (stoppedEarly) {
    log(`${LOG_PREFIX} stopped by limits batches=${result.batches} (resumable)`);
  }

  log(
    `${LOG_PREFIX} summary batches=${result.batches} boards=${result.boards} ok=${result.ok} ` +
      `failed=${result.failed} fetched=${result.rowsFetched} persisted=${result.rowsPersisted} ` +
      `deactivated=${result.deactivated} backedOff=${result.backedOff} closed=${result.closed} ` +
      `completed=${result.completed} elapsed=${seconds(result.elapsedMs)}`,
  );

  return result;
}
