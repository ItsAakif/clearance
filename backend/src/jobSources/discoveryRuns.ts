// In-memory, request-scoped discovery run snapshots (ADR-013).
// On-demand only: no DB, no timers, no scheduler. Bounded to MAX_RUNS entries
// with a RUN_TTL_MS time-to-live; expiry is swept lazily on write and on read.

export type BoardRunStatus = 'pending' | 'running' | 'ok' | 'failed' | 'needs_key' | 'cancelled';

export interface BoardRunState {
  boardId: string;
  name: string;
  type: string;
  status: BoardRunStatus;
  resultCount: number;
  latencyMs?: number;
  error?: string;
  // Wave 7 additive extension: per-unit orchestrator context. Every field is
  // OPTIONAL so a snapshot written by an older code path still type-checks
  // and still renders (run-progress contract unchanged).
  tier?: number;
  group?: string;
  truncated?: boolean;
  skippedReason?: string;
  unitKind?: string;
}

export interface RunSnapshot {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  boards: BoardRunState[];
  totalListings: number;
  // Wave 7 additive extension: run-level orchestrator context. OPTIONAL so a
  // snapshot written by an older code path still type-checks and still renders.
  mode?: string;
  cancelled?: boolean;
  intent?: unknown;
  // Wave 9 (T783) additive extension: evaluation summary for the run
  // (`requested/completed/skipped`, optional pipeline `reason`, and the
  // pre-pass cost `estimate`). OPTIONAL so older snapshots still type-check
  // and still render. Written post-persist by `setRunEvaluation` - the six
  // mutators below keep their EXACT signatures.
  evaluation?: RunEvaluationSummary;
  // Wave 13 (T883) Full-scan-only additive fields. They are optional so a
  // legacy snapshot without Full-scan progress still type-checks and renders.
  // The client-driven Full scan uses this keyset cursor and aggregate counters
  // to resume batches without introducing persistence or a scheduler.
  cursor?: string | null;
  registryProcessed?: number;
  registryTotal?: number;
  // Deep-only additive catalogue-sweep summary. Optional so every other mode
  // and every older snapshot keeps its exact shape.
  sweep?: RunSweepSummary;
}

/**
 * Deep-search catalogue sweep summary. Counts only - never page content,
 * tokens, or adapter payloads. `error` is the bounded first failure reason.
 */
export interface RunSweepSummary {
  boards: number;
  ok: number;
  failed: number;
  rowsFetched: number;
  rowsPersisted: number;
  exhausted: boolean;
  error?: string;
}

/**
 * Wave 9 (T783) evaluation summary carried on the run snapshot. Mirrors the
 * orchestrator's `RunEvaluationSummary` field-for-field. Counts and the
 * reason only - never prompts, keys, payloads, or description text.
 */
export interface RunEvaluationSummary {
  requested: number;
  completed: number;
  skipped: number;
  reason?: string;
  estimate: { calls: number; approxTokens: number };
}

interface BoardSeed {
  id: string;
  name: string;
  type: string;
  // Wave 7 additive seed: the new per-unit data rides in through beginRun's
  // board seed so the six mutator signatures stay EXACTLY as they were.
  tier?: number;
  group?: string;
  unitKind?: string;
}

interface RunEntry {
  userId: string;
  snapshot: RunSnapshot;
  expiresAt: number;
  startedAtMs: number;
}

export const MAX_RUNS = 50;
export const RUN_TTL_MS = 5 * 60 * 1000;
const MAX_ERROR_CHARS = 500;

const runs = new Map<string, RunEntry>();

function nowMs(): number {
  return Date.now();
}

function sweepExpired(now: number): void {
  for (const [key, entry] of runs) {
    if (entry.expiresAt <= now) runs.delete(key);
  }
}

function evictOldestIfOverCap(): void {
  while (runs.size > MAX_RUNS) {
    let oldestKey: string | undefined;
    let oldestStarted = Infinity;
    for (const [key, entry] of runs) {
      if (entry.startedAtMs < oldestStarted) {
        oldestStarted = entry.startedAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey === undefined) break;
    runs.delete(oldestKey);
  }
}

function findBoard(snapshot: RunSnapshot, boardId: string): BoardRunState | undefined {
  return snapshot.boards.find((b) => b.boardId === boardId);
}

function boundError(message: string): string {
  return message.slice(0, MAX_ERROR_CHARS);
}

/**
 * Defensive copy of a stored snapshot: boards are copied per-row and the
 * evaluation summary (plus its estimate) is copied, so callers can never
 * mutate the live registry entry through a read. Primitive Full-scan fields
 * (cursor and registry counters) ride along through the spread.
 */
function copySnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {
    ...snapshot,
    boards: snapshot.boards.map((b) => ({ ...b })),
    ...(snapshot.evaluation !== undefined
      ? {
          evaluation: {
            ...snapshot.evaluation,
            estimate: { ...snapshot.evaluation.estimate },
          },
        }
      : {}),
    ...(snapshot.sweep !== undefined ? { sweep: { ...snapshot.sweep } } : {}),
  };
}

export function beginRun(
  runId: string,
  userId: string,
  boards: BoardSeed[],
  ttlMs: number = RUN_TTL_MS,
): void {
  const now = nowMs();
  sweepExpired(now);
  const startedAt = new Date(now).toISOString();
  const snapshot: RunSnapshot = {
    runId,
    startedAt,
    boards: boards.map((b) => ({
      boardId: b.id,
      name: b.name,
      type: b.type,
      status: 'pending' as BoardRunStatus,
      resultCount: 0,
      ...(b.tier !== undefined ? { tier: b.tier } : {}),
      ...(b.group !== undefined ? { group: b.group } : {}),
      ...(b.unitKind !== undefined ? { unitKind: b.unitKind } : {}),
    })),
    totalListings: 0,
  };
  runs.set(runId, { userId, snapshot, expiresAt: now + ttlMs, startedAtMs: now });
  evictOldestIfOverCap();
}

export function markRunning(runId: string, boardId: string): void {
  const entry = runs.get(runId);
  if (!entry) return;
  const board = findBoard(entry.snapshot, boardId);
  if (!board) return;
  board.status = 'running';
}

export function markOk(runId: string, boardId: string, resultCount: number, latencyMs: number): void {
  const entry = runs.get(runId);
  if (!entry) return;
  const board = findBoard(entry.snapshot, boardId);
  if (!board) return;
  board.status = 'ok';
  board.resultCount = resultCount;
  board.latencyMs = latencyMs;
  delete board.error;
}

export function markFailed(runId: string, boardId: string, error: string, latencyMs: number): void {
  const entry = runs.get(runId);
  if (!entry) return;
  const board = findBoard(entry.snapshot, boardId);
  if (!board) return;
  board.status = 'failed';
  board.error = boundError(error);
  board.latencyMs = latencyMs;
}

export function markNeedsKey(runId: string, boardId: string, reason: string): void {
  const entry = runs.get(runId);
  if (!entry) return;
  const board = findBoard(entry.snapshot, boardId);
  if (!board) return;
  board.status = 'needs_key';
  board.error = boundError(reason);
}

export function finishRun(runId: string, totalListings: number): void {
  const entry = runs.get(runId);
  if (!entry) return;
  entry.snapshot.finishedAt = new Date(nowMs()).toISOString();
  entry.snapshot.totalListings = totalListings;
  for (const board of entry.snapshot.boards) {
    // A cancelled unit must NOT look broken: only still-in-flight boards are
    // force-failed. 'cancelled' (plus every other terminal status) is
    // intentionally left untouched here.
    if (board.status === 'pending' || board.status === 'running') {
      board.status = 'failed';
      board.error = 'run ended before this board reported';
    }
  }
}

/**
 * Wave 7 additive cancel marker. Flags the run cancelled and releases every
 * still-in-flight board as `cancelled` (never `failed`). Idempotent: a repeat
 * call changes nothing. A run that already finished (`finishedAt` set) is a
 * documented no-op - the snapshot is left unchanged. Unknown runIds are a
 * no-op and never throw. NOTE: this helper is NOT user-scoped by itself;
 * callers (the cancel route) must prove ownership via getRun first.
 */
export function markCancelled(runId: string): void {
  const entry = runs.get(runId);
  if (!entry) return;
  if (entry.snapshot.finishedAt !== undefined) return;
  entry.snapshot.cancelled = true;
  entry.snapshot.finishedAt = new Date(nowMs()).toISOString();
  for (const board of entry.snapshot.boards) {
    if (board.status === 'pending' || board.status === 'running') {
      board.status = 'cancelled';
    }
  }
}

export function getRun(runId: string, userId: string): RunSnapshot | undefined {
  const entry = runs.get(runId);
  if (!entry) return undefined;
  if (entry.expiresAt <= nowMs()) {
    runs.delete(runId);
    return undefined;
  }
  if (entry.userId !== userId) return undefined;
  return copySnapshot(entry.snapshot);
}

/**
 * Additive writer for the mode resolved by the discovery route. Keeping this
 * separate from beginRun leaves every existing mutator signature unchanged
 * and keeps beginRun-only/legacy snapshots (which have no mode) valid. Unknown
 * or expired runIds are silent no-ops.
 */
export function setRunMode(runId: string, mode: string): void {
  const now = nowMs();
  const entry = runs.get(runId);
  if (!entry || entry.expiresAt <= now) return;
  entry.snapshot.mode = mode;
}

/**
 * Wave 13 (T883) additive Full-scan progress writer. Records the keyset
 * cursor and aggregate registry counters on a live run snapshot. The fields
 * are primitive values, so assigning them copies the caller's progress values
 * rather than retaining its object. Unknown or expired runIds are no-ops and
 * never throw.
 */
export function setRunRegistryProgress(
  runId: string,
  progress: { cursor: string | null; processed: number; total: number },
): void {
  const now = nowMs();
  const entry = runs.get(runId);
  if (!entry || entry.expiresAt <= now) {
    return;
  }
  entry.snapshot.cursor = progress.cursor;
  entry.snapshot.registryProcessed = progress.processed;
  entry.snapshot.registryTotal = progress.total;
}

/**
 * Additive Full-scan bridge for the existing total-listings field. A client-
 * driven sweep persists each batch independently, so intermediate batches need
 * to carry their cumulative count without stamping `finishedAt` via finishRun.
 * Unknown or expired runIds are silent no-ops, matching the other additive
 * progress writers. This does not change any pre-existing mutator signature.
 */
export function setRunTotalListings(runId: string, totalListings: number): void {
  const now = nowMs();
  const entry = runs.get(runId);
  if (!entry || entry.expiresAt <= now) return;
  if (!Number.isFinite(totalListings)) return;
  entry.snapshot.totalListings = Math.max(0, Math.floor(totalListings));
}

/**
 * Wave 13 (T883) additive TTL refresh for client-driven Full-scan batches.
 * A live entry is extended to `now + ttlMs`; unknown and expired entries are
 * no-ops and never throw. This intentionally creates no timer or scheduler:
 * callers refresh explicitly between requests.
 */
export function touchRun(runId: string, ttlMs: number = RUN_TTL_MS): void {
  const now = nowMs();
  const entry = runs.get(runId);
  if (!entry || entry.expiresAt <= now) {
    return;
  }
  entry.expiresAt = now + ttlMs;
}

/**
 * Wave 9 (T783) additive evaluation writer. Records the pipeline's
 * `{ requested, completed, skipped, reason?, estimate }` summary on a live
 * run AFTER persistence - callers (the search routes) invoke it once their
 * own upsert has stored the rows, so evaluations attach to stored rows.
 * A NEW function: the six mutators keep their EXACT signatures. Unknown
 * runIds are a no-op and never throw. A defensive copy is stored, so later
 * caller-side mutation cannot rewrite the snapshot.
 */
export function setRunEvaluation(runId: string, summary: RunEvaluationSummary): void {
  const entry = runs.get(runId);
  if (!entry) return;
  entry.snapshot.evaluation = {
    requested: summary.requested,
    completed: summary.completed,
    skipped: summary.skipped,
    ...(summary.reason !== undefined ? { reason: summary.reason } : {}),
    estimate: {
      calls: summary.estimate.calls,
      approxTokens: summary.estimate.approxTokens,
    },
  };
}

/**
 * Deep-only additive catalogue-sweep writer. Counts are copied; `error` is
 * bounded like every other snapshot error. Unknown/expired runIds are silent
 * no-ops, matching the other additive writers.
 */
export function setRunSweep(runId: string, summary: RunSweepSummary): void {
  const entry = runs.get(runId);
  if (!entry) return;
  entry.snapshot.sweep = {
    boards: summary.boards,
    ok: summary.ok,
    failed: summary.failed,
    rowsFetched: summary.rowsFetched,
    rowsPersisted: summary.rowsPersisted,
    exhausted: summary.exhausted,
    ...(summary.error !== undefined ? { error: boundError(summary.error) } : {}),
  };
}

const MISSING_KEY_PATTERNS: RegExp[] = [
  /requires an? .*key/i,
  /no .*api keys? configured/i,
  /add .*in settings/i,
  /no scraping backend configured/i,
];

export function isLikelyMissingKeyError(message: string): boolean {
  return MISSING_KEY_PATTERNS.some((re) => re.test(message));
}

export function resetRunsForTests(): void {
  runs.clear();
}

// ---------------------------------------------------------------------------
// Wave 13 (T860) additive READ-ONLY helpers for the admin observability
// surface. These never mutate the registry: every snapshot handed out is a
// defensive copy (copySnapshot), and the internal Map is NOT exported -
// a caller mutating a returned snapshot cannot corrupt live runs.
// ---------------------------------------------------------------------------

/** One admin-visible run: its owner plus a defensive snapshot copy. */
export interface RunListEntry {
  userId: string;
  snapshot: RunSnapshot;
}

/**
 * List live (unexpired) runs, newest first, bounded by MAX_RUNS.
 * Admin callers omit `userId` to see every user's runs; passing a `userId`
 * scopes to that owner (same ownership rule getRun enforces per-run).
 */
export function listRuns(userId?: string): RunListEntry[] {
  sweepExpired(nowMs());
  const out: RunListEntry[] = [];
  for (const entry of runs.values()) {
    if (userId !== undefined && entry.userId !== userId) continue;
    out.push({ userId: entry.userId, snapshot: copySnapshot(entry.snapshot) });
  }
  // startedAt is ISO-8601 so lexicographic order is chronological order.
  // Array.prototype.sort is stable: same-millisecond runs keep insert order.
  out.sort((a, b) =>
    a.snapshot.startedAt < b.snapshot.startedAt
      ? 1
      : a.snapshot.startedAt > b.snapshot.startedAt
        ? -1
        : 0,
  );
  return out.slice(0, MAX_RUNS);
}

/** Aggregate counts over the live runs. `hasData` distinguishes "no data
 * yet" (server restarted, nothing in memory) from a real zero. */
export interface RunsSummary {
  runCount: number;
  hasData: boolean;
  totalListings: number;
  cancelledRuns: number;
  byUnitStatus: Record<string, number>;
}

/** Summarize live (unexpired) runs without materialising snapshots. */
export function summarizeRuns(userId?: string): RunsSummary {
  const entries = listRuns(userId);
  const byUnitStatus: Record<string, number> = {};
  let totalListings = 0;
  let cancelledRuns = 0;
  for (const { snapshot } of entries) {
    totalListings += snapshot.totalListings;
    if (snapshot.cancelled === true) cancelledRuns += 1;
    for (const board of snapshot.boards) {
      byUnitStatus[board.status] = (byUnitStatus[board.status] ?? 0) + 1;
    }
  }
  return {
    runCount: entries.length,
    hasData: entries.length > 0,
    totalListings,
    cancelledRuns,
    byUnitStatus,
  };
}
