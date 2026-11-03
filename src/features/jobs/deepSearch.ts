// Pure three-mode search controls and Full-scan loop state
// (T888, ADR-031/ADR-033).
//
// This module is the testable logic surface for the three product modes, the
// honest time warning, the cost-estimate display, cancellation state and the
// client-driven Full-scan batch decisions. UI components stay thin and call
// into here. Pure: no React, no network, no clock.
//
// BUDGET SOURCE OF TRUTH: the wall-clock bounds live in
// `backend/src/discovery/budgets.ts` (`FAST_BUDGET.totalBudgetMs = 20000`,
// `STANDARD_BUDGET.totalBudgetMs = 240000`, `DEEP_BUDGET.totalBudgetMs =
// 600000`, and `FULL_BATCH_BUDGET.totalBudgetMs = 180000`). The frontend has
// no runtime access to those values, so they are mirrored below as named
// constants - never as marketing literals in a component - and duration bands
// are derived from those mirrors. If the backend module moves, these mirrors
// must move with it. The server may additionally override the bounds per
// deployment, so bounded figures are upper-bound estimates, never promises.
//
// HONESTY RULES (stated in copy, honoured in code):
// - the time warning is a warning, not a promise ("up to about N minutes");
// - the cost figure is labelled an estimate, never a measured token count
//   (the backend `estimateCost` documents the same honest-precision notice);
// - a skipped AI pass is reported as skipped with its reason, never as a
//   completed evaluation;
// - fast mode requests no AI pass: `buildSearchParams` never emits an
//   `evaluate`/AI field, whatever the mode.

/** Mirror of backend `FAST_BUDGET.totalBudgetMs` (see header). */
export const FAST_TOTAL_BUDGET_MS = 20_000;

/** Mirror of backend `STANDARD_BUDGET.totalBudgetMs` (see header). */
export const STANDARD_TOTAL_BUDGET_MS = 240_000;

/** Mirror of backend `DEEP_BUDGET.totalBudgetMs` (see header). */
export const DEEP_TOTAL_BUDGET_MS = 600_000;

/** Mirror of backend `FULL_BATCH_BUDGET.totalBudgetMs` (see header). */
export const FULL_BATCH_BUDGET_MS = 180_000;

/** Search depth. Mirrors the backend `SearchMode` wire vocabulary. */
export type SearchDepth = 'fast' | 'standard' | 'deep' | 'full';

export interface UiModeOption {
  value: SearchDepth;
  label: string;
  description: string;
}

/**
 * The three user-visible modes. Fast remains a valid legacy/API mode but is
 * deliberately absent from the product switch.
 */
export const UI_MODE_OPTIONS: readonly UiModeOption[] = [
  {
    value: 'standard',
    label: 'Standard Scan',
    description:
      'Mainstream boards and aggregators - about 3-4 minutes',
  },
  {
    value: 'deep',
    label: 'Deep Scan',
    description:
      'Adds search, dorking, scraping and company career pages - about 10 minutes',
  },
  {
    value: 'full',
    label: 'Full Scan',
    description:
      'Every company career page in the registry - can take hours, cancellable',
  },
];

/** Product label for a wire mode; the option table is the only UI copy source. */
export function modeLabel(mode: SearchDepth): string {
  if (mode === 'fast') return 'Fast';
  return (
    UI_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? 'Fast'
  );
}

/** True for every confirm-gated mode; fast remains the interactive legacy mode. */
export function isLongMode(mode: SearchDepth): boolean {
  return mode !== 'fast';
}

/** Return the mirrored wall-clock budget for a mode. */
export function budgetMsForMode(mode: SearchDepth): number {
  switch (mode) {
    case 'standard':
      return STANDARD_TOTAL_BUDGET_MS;
    case 'deep':
      return DEEP_TOTAL_BUDGET_MS;
    case 'full':
      return FULL_BATCH_BUDGET_MS;
    case 'fast':
    default:
      return FAST_TOTAL_BUDGET_MS;
  }
}

/** A duration band: a range, never a false-precision single number. */
export interface DeepTimeBand {
  lowMinutes: number;
  highMinutes: number;
}

/**
 * Derive the deep-search duration band from a wall-clock budget in
 * milliseconds. `highMinutes` is the ceiling of the budget in minutes (the
 * run is bounded by it, never promised it); `lowMinutes` is one minute
 * below, floored at 1, so the band is always an honest range. Defaults to
 * the mirrored deep budget; accepts an override so a future snapshot field
 * (or test) can supply the real server number when one exists.
 */
export function deepTimeBand(
  totalBudgetMs: number = DEEP_TOTAL_BUDGET_MS,
): DeepTimeBand {
  const sane =
    typeof totalBudgetMs === 'number' && Number.isFinite(totalBudgetMs) && totalBudgetMs > 0
      ? totalBudgetMs
      : DEEP_TOTAL_BUDGET_MS;
  const highMinutes = Math.max(1, Math.ceil(sane / 60_000));
  return { lowMinutes: Math.max(1, highMinutes - 1), highMinutes };
}

/**
 * The honest time warning shown AT THE MOMENT deep is chosen. A warning,
 * not a promise: "up to about N minutes".
 */
export function formatDeepTimeWarning(band: DeepTimeBand): string {
  if (band.lowMinutes >= band.highMinutes) {
    return (
      `Deep search may take a while - up to about ${band.highMinutes} ` +
      `minute${band.highMinutes === 1 ? '' : 's'}. You can cancel at any time.`
    );
  }
  return (
    `Deep search may take a while - typically about ${band.lowMinutes} to ` +
    `${band.highMinutes} minutes (up to about ${band.highMinutes} minutes). ` +
    `You can cancel at any time.`
  );
}

// ---------------------------------------------------------------------------
// Search request payload (N18: deterministic before AI)
// ---------------------------------------------------------------------------

export interface SearchRequestInput {
  q: string;
  sources?: string[];
  runId?: string;
  postedWithin?: 'day' | 'week' | 'month';
  location?: string[];
  company?: string;
  /** Omitted (legacy callers) means fast - the backend default. */
  mode?: SearchDepth;
  /**
   * Wave-11 (T823) intent fields, from the T801 filter sheet. All OPTIONAL:
   * omitted (legacy callers, fast searches that never set them) means the
   * params stay byte-identical to the pre-wave shape. Present, they ride
   * the query additively so the contract is ready when the legacy routes
   * forward them (today the routes derive structure from q / location /
   * company / sources; unknown query keys are ignored, never a 400).
   */
  roles?: string[];
  skills?: string[];
  exclusions?: string[];
  companies?: string[];
  sourceGroups?: string[];
}

/**
 * Modes that `/jobs/search` may carry. Omission means fast (the backend
 * default). Full is route-exclusive and is deliberately absent: the
 * dedicated `/jobs/full-scan` endpoint owns it, while sending `full` to
 * `/jobs/search` degrades server-side to fast and would misrepresent the
 * requested scope.
 */
export type SearchRequestMode = 'standard' | 'deep';

export interface SearchRequestParams {
  q: string;
  sources?: string[];
  runId?: string;
  postedWithin?: 'day' | 'week' | 'month';
  location?: string[];
  company?: string;
  mode?: SearchRequestMode;
  roles?: string[];
  skills?: string[];
  exclusions?: string[];
  companies?: string[];
  sourceGroups?: string[];
}

/**
 * The existing jobs API accepted only the legacy fast/deep input union.
 * Keep that call shape sound until its consumer adopts the widened wire mode;
 * a Standard literal selects the full overload below at runtime and in types.
 */
type LegacySearchRequestParams = Omit<SearchRequestParams, 'mode'> & {
  mode?: 'deep';
};

/**
 * Build the search request params from the current filters. FAST MODE MUST
 * NOT CHANGE AND MUST NOT CALL AI: a fast input yields exactly the legacy
 * params (no `mode` key, no `evaluate`/AI key of any kind). Standard and
 * Deep add only their wire `mode`, never an AI request field. Full belongs
 * to `/jobs/full-scan`; it is never emitted here because that legacy route
 * treats `full` as an unknown value and degrades it to fast. The scope step
 * owns the confirmation gate; nothing here invents one. Intent fields copy
 * through only when supplied, so legacy and intent-free calls stay additive.
 */
export function buildSearchParams(
  input: SearchRequestInput & { mode?: 'fast' | 'deep' },
): LegacySearchRequestParams;
export function buildSearchParams(input: SearchRequestInput): SearchRequestParams;
export function buildSearchParams(input: SearchRequestInput): SearchRequestParams {
  const params: SearchRequestParams = { q: input.q };
  if (input.sources !== undefined) params.sources = input.sources;
  if (input.runId !== undefined) params.runId = input.runId;
  if (input.postedWithin !== undefined) params.postedWithin = input.postedWithin;
  if (input.location !== undefined) params.location = input.location;
  if (input.company !== undefined) params.company = input.company;
  if (input.mode === 'standard' || input.mode === 'deep') {
    params.mode = input.mode;
  }
  if (input.roles !== undefined) params.roles = input.roles;
  if (input.skills !== undefined) params.skills = input.skills;
  if (input.exclusions !== undefined) params.exclusions = input.exclusions;
  if (input.companies !== undefined) params.companies = input.companies;
  if (input.sourceGroups !== undefined) params.sourceGroups = input.sourceGroups;
  return params;
}

// ---------------------------------------------------------------------------
// Full-scan client batch state (the loop itself remains owner-controlled)
// ---------------------------------------------------------------------------

export interface FullScanBatch {
  runId: string;
  hasMore: boolean;
  nextCursor: string | null;
  processed: number;
  total: number;
  persisted: number;
  cancelled: boolean;
}

/**
 * Whether the client should issue the next bounded Full-scan request.
 * Missing, cancelled, complete and cursor-less batches are terminal. The
 * run-gone condition is owned by the loop because it comes from polling,
 * not from a batch response.
 */
export function fullScanShouldContinue(batch: FullScanBatch | undefined): boolean {
  return (
    batch !== undefined &&
    !batch.cancelled &&
    batch.hasMore &&
    batch.nextCursor !== null
  );
}

/** Honest aggregate registry progress for a Full-scan batch. */
export function fullScanProgressText(
  batch: FullScanBatch | undefined,
): string {
  if (!batch) return 'Preparing registry scan...';
  if (batch.cancelled) {
    return `Cancelled - ${batch.processed} of ${batch.total} scanned`;
  }
  if (batch.hasMore) {
    return `Scanning registry: ${batch.processed} of ${batch.total} career pages`;
  }
  return `Registry scan complete: ${batch.processed} career pages`;
}

// ---------------------------------------------------------------------------
// Run snapshot readings (structural types: the real `RunSnapshot` satisfies
// these, and tests stay free of the api-client import)
// ---------------------------------------------------------------------------

export interface EstimateLike {
  calls: number;
  approxTokens: number;
}

export interface EvaluationLike {
  requested: number;
  completed: number;
  skipped: number;
  reason?: string;
  estimate: EstimateLike;
}

export interface RunUnitLike {
  status: string;
  skippedReason?: string;
}

export interface RunSnapshotLike {
  cancelled?: boolean;
  boards: RunUnitLike[];
  evaluation?: EvaluationLike;
}

/** Board statuses that still hold the run open. Anything else is terminal. */
function isLiveStatus(status: string): boolean {
  return status === 'pending' || status === 'running';
}

/**
 * True once the run is in a terminal state and cancel must disable: the
 * snapshot is flagged `cancelled`, or every unit has left
 * `pending`/`running` (`ok`/`failed`/`needs_key`/`cancelled`/etc). An
 * unknown/absent snapshot is NOT terminal, so cancel stays reachable for
 * the whole run - including the early window before the first snapshot
 * arrives (cancelling then still needs a runId, owned by the caller).
 */
export function isRunTerminal(snapshot: RunSnapshotLike | undefined): boolean {
  if (!snapshot) return false;
  if (snapshot.cancelled === true) return true;
  const boards = Array.isArray(snapshot.boards) ? snapshot.boards : [];
  if (boards.length === 0) return false;
  return boards.every((b) => !isLiveStatus(b?.status));
}

export interface RunCancellabilityState {
  mode: SearchDepth;
  /** True from before the first Full request through its final `finally`. */
  fullScanLoopActive: boolean;
  snapshot: RunSnapshotLike | undefined;
}

/**
 * Resolve the mode that owns the current run for cancelability. The mode
 * selector is mutable while a run is active; a page-owned Full loop is the
 * authoritative active-mode signal until its final `finally`.
 */
export function activeRunMode(
  selectedMode: SearchDepth,
  fullScanLoopActive: boolean,
): SearchDepth {
  return fullScanLoopActive ? 'full' : selectedMode;
}

/**
 * Whether the page may offer cancel for the current run. Full is a
 * page-owned sequence, so its loop state - not the first batch's retained
 * board rows - owns liveness until the loop completes, stops or reports a
 * cancellation. Fast, Standard and Deep deliberately keep the exact
 * `isRunTerminal` decision they had before Full batching was introduced.
 */
export function isRunCancellable(state: RunCancellabilityState): boolean {
  if (state.mode === 'full') {
    return (
      state.fullScanLoopActive && state.snapshot?.cancelled !== true
    );
  }
  return !isRunTerminal(state.snapshot);
}

/**
 * True when the run reported the browser tier unavailable (N2: the tier is
 * optional and the UI stays fully usable without it - the run proceeds and
 * simply reports the tier unavailable). Detected from a unit
 * `skippedReason` naming the browser tier (`'browser tier unavailable'` /
 * `'browser tier skipped'`, `backend/src/discovery/orchestrator.ts`
 * `browserTierAvailable`), case-insensitively, so future rewordings that
 * keep the tier name still match.
 */
export function browserTierUnavailable(
  snapshot: RunSnapshotLike | undefined,
): boolean {
  if (!snapshot || !Array.isArray(snapshot.boards)) return false;
  return snapshot.boards.some((b) => {
    const reason = b?.skippedReason;
    return (
      typeof reason === 'string' &&
      reason.length > 0 &&
      /browser tier/i.test(reason)
    );
  });
}

/**
 * Honest cost-estimate label for the pre-AI-pass display. The figure is
 * always called an estimate, never a measured count. `undefined` (no
 * estimate on the snapshot) is reported as unavailable, never as zero.
 */
export function formatCostEstimate(
  estimate: EstimateLike | undefined,
): string {
  if (!estimate) return 'AI cost estimate unavailable for this run.';
  if (estimate.calls <= 0) {
    return 'Estimated AI cost: none - no AI calls planned for this run.';
  }
  const calls = `about ${estimate.calls} AI call${estimate.calls === 1 ? '' : 's'}`;
  const tokens = `about ${estimate.approxTokens} tokens`;
  return (
    `Estimated AI cost: ${calls} (${tokens}). ` +
    `This is an estimate, not a measured count.`
  );
}
