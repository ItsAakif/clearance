// Pure run-progress grouping (Wave 10, T800, ADR-031 decision 3).
//
// `BoardProgressList` (T802) stays thin and calls into here. Pure: no React,
// no network, no clock.
//
// The helper accepts BOTH snapshot shapes: boards carrying the wave-7
// additive fields (`tier`, `group`, `skippedReason`, `truncated`) and boards
// without them. Grouping key is `group` when present, else the board `type`
// (the pre-wave grouping) - one code path, no shape branching, so old
// snapshots aggregate exactly as before. Group order is first-seen in the
// boards array: the only drift-free deterministic order, because the group
// vocabulary lives in snapshot data (and the generated contract owns source
// ids, not group names), never in a local list.
//
// Counting rules:
// - done: every terminal status (`ok`, `failed`, `needs_key`, plus the
//   wave-7 `cancelled` and a future `skipped` status). Old snapshots never
//   carry the newer statuses, so their `done` counts match the pre-wave
//   header math exactly.
// - skipped: any board with a non-empty `skippedReason`, whatever its
//   status. A group toggled off therefore appears as skipped-with-reason,
//   never as failed.
// - failed: `status === 'failed'` WITHOUT a `skippedReason`.
// - `truncated` is accepted on input (forward-compatible) and left to the
//   component to render per row; it does not change the counts.

/** One snapshot unit; wave-7 fields optional so both shapes type-check. */
export interface ProgressUnitLike {
  boardId: string;
  name?: string;
  type?: string;
  status: string;
  resultCount?: number;
  tier?: number;
  group?: string;
  truncated?: boolean;
  skippedReason?: string;
}

/** Minimal snapshot shape; accepts the frontend `RunSnapshot` as-is. */
export interface ProgressSnapshotLike {
  runId?: string;
  startedAt?: string;
  finishedAt?: string;
  boards: readonly ProgressUnitLike[];
  totalListings?: number;
  mode?: string;
  registryProcessed?: number;
  registryTotal?: number;
}

export interface GroupProgress {
  group: string;
  done: number;
  total: number;
  skipped: number;
  failed: number;
}

export interface ProgressTotals {
  done: number;
  total: number;
  skipped: number;
  failed: number;
}

/** Terminal statuses: the unit will not move again. */
const DONE_STATUSES: readonly string[] = ['ok', 'failed', 'needs_key', 'cancelled', 'skipped'];

function groupKeyOf(unit: ProgressUnitLike): string {
  if (unit && typeof unit.group === 'string' && unit.group.trim()) return unit.group.trim();
  if (unit && typeof unit.type === 'string' && unit.type.trim()) return unit.type.trim();
  return 'unknown';
}

function hasSkippedReason(unit: ProgressUnitLike): boolean {
  return (
    !!unit && typeof unit.skippedReason === 'string' && unit.skippedReason.trim().length > 0
  );
}

const REGISTRY_NUMBER_FORMAT = new Intl.NumberFormat('en-US');

/**
 * Honest aggregate progress for the Full registry sweep. The optional total
 * is the readiness signal: old snapshots and the first pre-seed window return
 * `undefined`, so the component adds no DOM and renders exactly as before.
 */
export function registryProgressText(
  snapshot: ProgressSnapshotLike | undefined,
): string | undefined {
  if (
    !snapshot ||
    typeof snapshot.registryTotal !== 'number' ||
    !Number.isFinite(snapshot.registryTotal) ||
    snapshot.registryTotal < 0
  ) {
    return undefined;
  }
  const processed =
    typeof snapshot.registryProcessed === 'number' &&
    Number.isFinite(snapshot.registryProcessed) &&
    snapshot.registryProcessed >= 0
      ? Math.floor(snapshot.registryProcessed)
      : 0;
  return (
    `Registry: ${REGISTRY_NUMBER_FORMAT.format(processed)} of ` +
    `${REGISTRY_NUMBER_FORMAT.format(snapshot.registryTotal)} career pages`
  );
}

// ==================== Full-sweep live speed / ETA (T911) ====================
//
// Client-side only (spec `full-sweep-progress-ui.md` decision D1): every input
// comes from the Full-scan batch loop's own responses, so no clock polling and
// no new backend field are involved. `processed` is CUMULATIVE server-side,
// therefore samples are cumulative positions, never deltas.

// ==================== TYPES ====================
/** One cumulative progress observation taken after a batch response lands. */
export type SweepSample = { processed: number; at: number }; // at = epoch ms

/**
 * Per-batch rate-limit marker, mirrored from the backend's
 * `politenessResponseMarker` (`mode`, `signals`, `blocks`, `deferred`,
 * `wiringOk`). The gate is constructed per request, so the counters describe
 * the LATEST batch only (decision D2): no cross-batch accumulation.
 */
export type SweepPoliteness = {
  mode: 'on' | 'off';
  signals: number;
  blocks: number;
  deferred: number;
  wiringOk: boolean;
};

/** Only the newest few samples are ever consulted; older ones cannot help. */
const SWEEP_SAMPLE_CAP = 10;

/** Warm-up guard: below this gap the rate is noise, so nothing is shown. */
const SWEEP_RATE_MIN_GAP_MS = 5000;

/** ==================== PURE HELPERS ==================== */

/**
 * Append one observation and keep only the newest {@link SWEEP_SAMPLE_CAP}.
 * Pure: the input array is never mutated, so the caller can hand it straight
 * to `setState` without an extra copy.
 */
export function appendSweepSample(
  samples: readonly SweepSample[],
  processed: number,
  at: number,
): SweepSample[] {
  const next = [...samples, { processed, at }];
  return next.length > SWEEP_SAMPLE_CAP ? next.slice(next.length - SWEEP_SAMPLE_CAP) : next;
}

/**
 * pages/s between the newest sample and the newest sample at least
 * {@link SWEEP_RATE_MIN_GAP_MS} older. Spanning batch boundaries is the point:
 * a single batch is too short to time honestly.
 *
 * `null` when: fewer than 2 samples, no eligible older sample yet (warm-up),
 * or the eligible window processed nothing (delta <= 0).
 */
export function sweepRate(samples: readonly SweepSample[]): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const newest = samples[samples.length - 1];
  if (!newest) return null;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const candidate = samples[index];
    if (!candidate) continue;
    const gapMs = newest.at - candidate.at;
    if (gapMs < SWEEP_RATE_MIN_GAP_MS) continue;
    const deltaProcessed = newest.processed - candidate.processed;
    if (deltaProcessed <= 0) return null;
    return deltaProcessed / (gapMs / 1000);
  }
  return null;
}

/** One-decimal speed string, e.g. `7.1 pages/s`. */
export function rateText(rate: number): string {
  return `${rate.toFixed(1)} pages/s`;
}

/**
 * Honest finish estimate from the measured rate. `null` whenever the estimate
 * would be invented: no usable rate, no known total, or nothing left to do.
 */
export function etaText(
  processed: number,
  total: number,
  rate: number | null,
): string | null {
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null;
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(processed) || processed >= total) return null;
  const secs = (total - processed) / rate;
  if (!Number.isFinite(secs) || secs < 0) return null;
  if (secs < 60) return 'under a minute';
  if (secs < 3600) return `about ${Math.round(secs / 60)} m left`;
  const hours = Math.floor(secs / 3600);
  const minutes = Math.round((secs % 3600) / 60);
  // Rounding can reach 60 (3599 s -> "1 h 60 m"); carry it into the hours.
  if (minutes === 60) return `about ${hours + 1} h 0 m left`;
  return `about ${hours} h ${minutes} m left`;
}

/**
 * Amber rate-limit note for the latest batch, or `null` for nothing to say.
 * Evaluation order is fixed and short-circuits at the first satisfied step:
 * the wiring anomaly is a real defect and outranks a "clean" batch.
 */
export function politenessNoticeText(p: SweepPoliteness | undefined): string | null {
  if (!p || p.mode !== 'on') return null;
  if (p.wiringOk === false) {
    return 'Rate-limit backoff is not engaging - wiring check failed (SEARCH_FULL_POLITENESS)';
  }
  if (p.signals === 0 && p.blocks === 0 && p.deferred === 0) return null;
  return (
    `Rate limited by a job board - cooling down (${p.signals} responses, ` +
    `${p.blocks} cool-downs, ${p.deferred} pages deferred this batch)`
  );
}

export function groupProgress(snapshot: ProgressSnapshotLike): {
  groups: GroupProgress[];
  totals: ProgressTotals;
} {
  const empty = { done: 0, total: 0, skipped: 0, failed: 0 };
  if (!snapshot || !Array.isArray(snapshot.boards)) {
    return { groups: [], totals: { ...empty } };
  }
  const byKey = new Map<string, GroupProgress>();
  for (const unit of snapshot.boards) {
    if (!unit || typeof unit !== 'object') continue;
    const key = groupKeyOf(unit);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { group: key, done: 0, total: 0, skipped: 0, failed: 0 };
      byKey.set(key, entry);
    }
    entry.total += 1;
    if (DONE_STATUSES.includes(unit.status)) entry.done += 1;
    const skipped = hasSkippedReason(unit);
    if (skipped) entry.skipped += 1;
    if (unit.status === 'failed' && !skipped) entry.failed += 1;
  }
  const groups = [...byKey.values()];
  const totals: ProgressTotals = { done: 0, total: 0, skipped: 0, failed: 0 };
  for (const entry of groups) {
    totals.done += entry.done;
    totals.total += entry.total;
    totals.skipped += entry.skipped;
    totals.failed += entry.failed;
  }
  return { groups, totals };
}
