// Board-catalogue sweep (freehire-style coverage for Deep search).
//
// Deep search still runs its title-search phase exactly as before. This module
// adds a second, catalogue-oriented phase: walk every active company career
// page (CompanyCareerPage) in keyset order, fetch its full board with an EMPTY
// query (queryMatch.ts treats "no tokens" as "match everything"), dedupe the
// batch and persist it through the caller's upsert path. Full scan is not
// touched; this is a Deep-only additive ingest.
//
// Dependency-injected on purpose: the module imports no Prisma and no network
// adapter, so the cursor/pool/timeout/dedupe/cap behaviour is unit-testable
// with fakes. The caller (routes/jobs.ts) owns the AppSetting cursor, the
// provider -> adapter map and `upsertDiscoveredJobs` (which derives
// `searchDocument`).
//
// REGISTRY HYGIENE (this round): every board outcome is written back through
// `recordPageResult`, so a dead token stops consuming the keyset cursor:
//   - success clears the failure streak and schedules no retry;
//   - failure records `lastCheckedAt`, a bounded `lastError`, a growing
//     `nextCheckAt` (1d, 3d, 7d, then 30d) and a verifyStatus derived from the
//     observed HTTP status;
//   - three consecutive 404/410 failures deactivate the page (`isActive:
//     false`); a 429/403 never deactivates.
// The pure write-back policy lives in `applyPageResult` below so the
// threshold/backoff table is unit-testable without Prisma or a clock.
//
// Backoff note: `registry/staleness.ts` already owns the crawler's vocabulary
// (`verifyStatus`, failure-count recomputation, nextCheckAt) but its curve is
// 1/2/4/8/16/30 days (frozen by its own tests). The sweep contract specifies
// 1/3/7/30 days, so this module uses a sweep-local table and deliberately does
// NOT mutate the shared registry curve. The reused pieces are the canonical
// verifyStatus values and the crawler's "success clears / failure increments"
// failure-count semantics.

import type { RawJob } from '../jobSources/adapters/http.js';
import { dedupeJobs } from '../jobSources/jobIdentity.js';

export interface SweepPage {
  id: string;
  provider: string;
  boardToken: string;
  /**
   * Registry company name (`CompanyCareerPage.company.name`). When present and
   * non-empty it overrides the adapter's `company` value (usually the board
   * token) on every fetched row; the token remains the row's identity.
   */
  companyName?: string;
}

export interface SweepOptions {
  cursor: string;
  maxBoards: number;
  concurrency: number;
  maxRows: number;
  perBoardTimeoutMs: number;
  /** Optional provider filter; empty/undefined means every supported provider. */
  providers?: string[];
}

/** One board outcome handed to the registry write-back. */
export interface PageFetchResult {
  ok: boolean;
  /** Observed HTTP status for a failure (undefined for a timeout/transport throw). */
  status?: number;
  /** Rows fetched from the board (0 on failure). */
  rows: number;
  /** Bounded error text (no credentials; the registry store bounds it again). */
  error?: string;
}

/** What the registry write-back changed, for the sweep summary. */
export interface PageRecordOutcome {
  deactivated: boolean;
  backedOff: boolean;
}

export interface SweepResult {
  boards: number;
  ok: number;
  failed: number;
  rowsFetched: number;
  rowsPersisted: number;
  nextCursor: string;
  exhausted: boolean;
  failures: Array<{ pageId: string; provider: string; reason: string }>;
  /** Rows deactivated by this batch (three consecutive gone failures). */
  deactivated: number;
  /** Rows whose nextCheckAt was pushed into the future by this batch. */
  backedOff: number;
}

export interface SweepDeps {
  pages(args: { cursor: string; take: number; providers?: string[] }): Promise<SweepPage[]>;
  fetchBoard(
    provider: string,
    token: string,
    query: string,
    companyName?: string,
  ): Promise<RawJob[]>;
  persist(rows: RawJob[]): Promise<number>;
  /**
   * Registry write-back. Optional so existing callers/tests can omit it, but
   * the production sweep always supplies it (routes/jobs.ts).
   */
  recordPageResult?(pageId: string, result: PageFetchResult): Promise<PageRecordOutcome | void>;
}

export const SWEEP_EMPTY_QUERY = '';

/** Registry error text is bounded (the crawler uses 500; the sweep contract ~200). */
export const PAGE_ERROR_MAX_CHARS = 200;

/** Day length used by the sweep backoff table. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep backoff curve: 1, 3, 7, then 30 days for every further failure.
 * Indexed by the POST-increment failureCount (1 -> 1d ... 4+ -> 30d).
 */
export const SWEEP_BACKOFF_DAYS = [1, 3, 7, 30] as const;

/** Consecutive gone (404/410) failures before a page is deactivated. */
export const SWEEP_DEACTIVATE_AFTER = 3;

/** Backoff delay for a failure count, per the table in the module header. */
export function sweepBackoffMs(failureCount: number): number {
  const failures =
    Number.isFinite(failureCount) && failureCount > 0 ? Math.floor(failureCount) : 1;
  const index = Math.min(failures - 1, SWEEP_BACKOFF_DAYS.length - 1);
  return SWEEP_BACKOFF_DAYS[index] * DAY_MS;
}

/** Bound a registry error string; the store must never receive an unbounded one. */
export function boundPageError(text: string): string {
  return text.slice(0, PAGE_ERROR_MAX_CHARS);
}

const GONE_STATUSES = new Set([404, 410]);
const BLOCKED_STATUSES = new Set([403, 429]);
const TIMEOUT_MESSAGE = /timed?\s*out|abort|ETIMEDOUT|EAI_AGAIN/i;

/** Registry state the sweep write-back needs (a subset of CompanyCareerPage). */
export interface PageWriteState {
  failureCount: number;
  isActive: boolean;
  verifiedAt: Date | null;
}

/** The columns `applyPageResult` writes. */
export interface PageWriteUpdate {
  failureCount: number;
  lastError: string | null;
  lastCheckedAt: Date;
  nextCheckAt: Date | null;
  resultCount: number;
  verifyStatus: string;
  verifiedAt: Date | null;
  isActive: boolean;
}

export interface PageWriteDetail {
  update: PageWriteUpdate;
  deactivated: boolean;
  backedOff: boolean;
}

function failureStatusOf(result: PageFetchResult): string {
  const status = result.status;
  if (status !== undefined) {
    if (GONE_STATUSES.has(status)) return 'http_error';
    if (BLOCKED_STATUSES.has(status)) return 'blocked';
    if (status === 408) return 'timeout';
  }
  if (TIMEOUT_MESSAGE.test(result.error ?? '')) return 'timeout';
  return 'http_error';
}

/**
 * Pure registry write-back policy (no clock, no Prisma):
 *
 * SUCCESS -> failureCount 0, lastError null, lastCheckedAt now,
 *            nextCheckAt null, resultCount rows.length,
 *            verifyStatus ok/empty, verifiedAt now, row stays active.
 * FAILURE -> failureCount + 1, lastCheckedAt now, nextCheckAt now + the
 *            1/3/7/30-day curve, verifyStatus http_error for 404/410,
 *            blocked for 429/403, timeout for a timeout, http_error otherwise.
 *            A 404/410 failure deactivates the row once the streak reaches
 *            `SWEEP_DEACTIVATE_AFTER`; 429/403/timeouts never deactivate.
 */
export function applyPageResult(
  state: PageWriteState,
  result: PageFetchResult,
  now: Date,
): PageWriteDetail {
  const previousFailures =
    Number.isFinite(state.failureCount) && state.failureCount > 0
      ? Math.floor(state.failureCount)
      : 0;

  if (result.ok) {
    return {
      update: {
        failureCount: 0,
        lastError: null,
        lastCheckedAt: now,
        nextCheckAt: null,
        resultCount: Math.max(0, Math.floor(result.rows)),
        verifyStatus: result.rows > 0 ? 'ok' : 'empty',
        verifiedAt: now,
        isActive: state.isActive,
      },
      deactivated: false,
      backedOff: false,
    };
  }

  const failureCount = previousFailures + 1;
  const status = failureStatusOf(result);
  const gone = result.status !== undefined && GONE_STATUSES.has(result.status);
  const deactivated =
    state.isActive && gone && failureCount >= SWEEP_DEACTIVATE_AFTER;
  const errorText =
    typeof result.error === 'string' && result.error.length > 0
      ? result.error
      : result.status !== undefined
        ? `fetch failed (${result.status})`
        : 'fetch failed';

  return {
    update: {
      failureCount,
      lastError: boundPageError(errorText),
      lastCheckedAt: now,
      nextCheckAt: new Date(now.getTime() + sweepBackoffMs(failureCount)),
      resultCount: 0,
      verifyStatus: status,
      verifiedAt: state.verifiedAt,
      isActive: deactivated ? false : state.isActive,
    },
    deactivated,
    backedOff: true,
  };
}

/** Marker error for the per-board timeout wrapper (surfaced as reason 'timeout'). */
export class SweepTimeoutError extends Error {
  constructor(ms: number) {
    super(`board fetch timed out after ${ms}ms`);
    this.name = 'SweepTimeoutError';
  }
}

function positiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored > 0 ? floored : fallback;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SweepTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Extract the observed HTTP status without importing the transport class:
 * adapters throw `HttpStatusError` (which carries `.status`) and tests may
 * throw any object with the same shape.
 */
function statusOf(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object') {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) return status;
  }
  return undefined;
}

function failureReason(error: unknown): string {
  if (error instanceof SweepTimeoutError) return 'timeout';
  if (error instanceof Error && error.name === 'SweepTimeoutError') return 'timeout';
  if (error instanceof Error) return error.message || error.name || 'failed';
  if (typeof error === 'string' && error.length > 0) return error;
  return 'failed';
}

/**
 * Run one bounded catalogue-sweep batch.
 *
 * - `pages` is read ONCE for the batch (keyset by id asc, `take: maxBoards`).
 * - Boards run through a fixed-size worker pool; a timeout/throw is recorded in
 *   `failures` and never rejects the batch.
 * - New boards stop being launched once `rowsFetched >= maxRows`; already
 *   in-flight boards are allowed to finish.
 * - The collected rows are deduped with `dedupeJobs` before a single
 *   `persist` call.
 * - Every outcome is written back through `recordPageResult` (best-effort:
 *   a write-back error is logged and never fails the batch).
 * - `nextCursor` is the last processed page id (the caller's cursor is kept
 *   when nothing was processed). `exhausted` is the contract's short-batch
 *   signal: `pages.length < maxBoards`.
 */
export async function sweepBoards(deps: SweepDeps, options: SweepOptions): Promise<SweepResult> {
  const maxBoards = Math.max(0, Math.floor(options.maxBoards));
  const concurrency = positiveInt(options.concurrency, 1);
  const maxRows = Math.max(0, Math.floor(options.maxRows));
  const providers =
    Array.isArray(options.providers) && options.providers.length > 0
      ? options.providers
      : undefined;

  const pages = maxBoards > 0
    ? await deps.pages(
        providers === undefined
          ? { cursor: options.cursor, take: maxBoards }
          : { cursor: options.cursor, take: maxBoards, providers },
      )
    : [];

  const result: SweepResult = {
    boards: 0,
    ok: 0,
    failed: 0,
    rowsFetched: 0,
    rowsPersisted: 0,
    nextCursor: options.cursor,
    exhausted: pages.length < maxBoards,
    failures: [],
    deactivated: 0,
    backedOff: 0,
  };

  if (pages.length === 0) return result;

  const collected: RawJob[] = [];
  let nextIndex = 0;
  let processed = 0;

  const record = async (pageId: string, outcome: PageFetchResult): Promise<void> => {
    if (!deps.recordPageResult) return;
    try {
      const write = await deps.recordPageResult(pageId, outcome);
      if (write?.deactivated) result.deactivated += 1;
      if (write?.backedOff) result.backedOff += 1;
    } catch (error) {
      // Registry hygiene is best-effort isolation, exactly like the crawler's
      // write-back: a failing write never loses the observed board outcome.
      console.warn(
        `[boardSweep] registry write-back failed for page ${pageId}: ${boundPageError(failureReason(error))}`,
      );
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      // Checked before every launch: once the row cap is reached no NEW board
      // starts, but workers already awaiting a fetch still finish.
      if (result.rowsFetched >= maxRows) return;
      const index = nextIndex;
      if (index >= pages.length) return;
      nextIndex += 1;
      const page = pages[index];

      processed += 1;
      result.boards = processed;
      const companyName =
        typeof page.companyName === 'string' ? page.companyName.trim() : '';
      try {
        const fetched = await withTimeout(
          companyName.length > 0
            ? deps.fetchBoard(page.provider, page.boardToken, SWEEP_EMPTY_QUERY, companyName)
            : deps.fetchBoard(page.provider, page.boardToken, SWEEP_EMPTY_QUERY),
          options.perBoardTimeoutMs,
        );
        // The adapter returns the board token as `company` for many boards.
        // The registry's name replaces that token when present, but a real
        // name another adapter already supplied is never overwritten.
        const rows =
          companyName.length > 0
            ? fetched.map((row) => {
                const current = typeof row.company === 'string' ? row.company.trim() : '';
                const stillToken = current.length === 0 || current === page.boardToken;
                return stillToken ? { ...row, company: companyName } : row;
              })
            : fetched;
        result.ok += 1;
        result.rowsFetched += rows.length;
        if (rows.length > 0) collected.push(...rows);
        await record(page.id, { ok: true, rows: rows.length });
      } catch (error) {
        const reason = failureReason(error);
        result.failed += 1;
        result.failures.push({
          pageId: page.id,
          provider: page.provider,
          reason,
        });
        await record(page.id, {
          ok: false,
          status: statusOf(error),
          rows: 0,
          error: boundPageError(reason),
        });
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, pages.length) },
    () => worker(),
  );
  await Promise.all(workers);

  // `processed` is the length of the launched PREFIX (nextIndex is monotonic),
  // so the keyset resume point is the last launched page - never whichever
  // board happened to settle last.
  if (processed > 0) result.nextCursor = pages[processed - 1].id;

  // `dedupeJobs` is the single tiered implementation used by every discovery
  // path; it also unions `sources`, so the persisted survivor keeps every
  // board that saw it.
  const deduped = dedupeJobs(collected);
  if (deduped.length > 0) {
    result.rowsPersisted = await deps.persist(deduped);
  }

  return result;
}
