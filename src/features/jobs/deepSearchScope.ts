// Pure deep-search scope / confirmation / cancellation-reducer logic
// (Wave 11, T821, ADR-027/ADR-031, master-spec N16/N18).
//
// Every user-visible rule this wave adds lives in this ONE pure module so it
// is provable by the frontend vitest runner (node environment, `.test.ts`
// only - ADR-031 decision 3 forbids jsdom/component tests). No React, no
// network, no clock. T822/T823 consume these functions; no logic here moves
// into a component.
//
// REUSE, NOT DUPLICATION (T804 owns the wave-10 surface):
// - budget mirrors (`DEEP_TOTAL_BUDGET_MS` / `FAST_TOTAL_BUDGET_MS`) and the
//   duration-band derivation (`deepTimeBand`) are imported from
//   `./deepSearch` - this module derives its own millisecond band from them
//   and never hardcodes a duration;
// - the cost-estimate shape reuses `EstimateLike` from `./deepSearch`;
// - the honest-precision wording for estimates follows the backend
//   `estimateCost` doc comment (`backend/src/evaluation/aiSubset.ts`,
//   T782): `approxTokens` is a heuristic, never a measured count.
//
// SCOPE CAP SOURCE OF TRUTH: the per-mode table lives in
// `backend/src/discovery/budgets.ts` (T880). The frontend has no runtime
// access to it, so the table is mirrored below and pinned by test against
// that backend file. `COMPANY_SCOPE_CAP` remains exported as the legacy/fast
// value. Run TTLs are mirrored the same way: the legacy value from
// `backend/src/jobSources/discoveryRuns.ts`, and Deep/Full from `budgets.ts`.

import {
  DEEP_TOTAL_BUDGET_MS,
  FAST_TOTAL_BUDGET_MS,
  STANDARD_TOTAL_BUDGET_MS,
  deepTimeBand,
} from './deepSearch';
import type { EstimateLike } from './deepSearch';

/** Mirror of backend `MODE_SCOPE_CAPS` (see header). */
export const MODE_SCOPE_CAPS = {
  fast: { companyCap: 10, registryCap: 50 },
  standard: { companyCap: 10, registryCap: 0 },
  deep: { companyCap: 10, registryCap: 200 },
  full: {
    companyCap: 10,
    registryCap: Number.POSITIVE_INFINITY,
  },
} as const;

/** Backward-compatible mirror of backend `COMPANY_SCOPE_CAP` (the fast cap). */
export const COMPANY_SCOPE_CAP: number = MODE_SCOPE_CAPS.fast.companyCap;

/** Mirror of legacy backend `RUN_TTL_MS` (fast and standard). */
export const RUN_TTL_MS: number = 5 * 60 * 1000;

/** Mirror of backend `DEEP_RUN_TTL_MS`. */
export const DEEP_RUN_TTL_MS: number = 12 * 60 * 1000;

/** Mirror of backend `FULL_RUN_TTL_MS`, refreshed after every batch. */
export const FULL_RUN_TTL_MS: number = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Scope summary (wave-11 scope item 1: honest company count against the cap)
// ---------------------------------------------------------------------------

/** Search depth. Omission or an unknown value means fast (the backend default). */
export type ScopeMode = 'fast' | 'standard' | 'deep' | 'full';

export type RegistryMode = 'off' | 'capped' | 'all';

function resolveScopeMode(mode: string | undefined): ScopeMode {
  return mode === 'standard' || mode === 'deep' || mode === 'full'
    ? mode
    : 'fast';
}

function registryModeFor(mode: ScopeMode): RegistryMode {
  if (mode === 'standard') return 'off';
  if (mode === 'full') return 'all';
  return 'capped';
}

/** The intent fields this module reads. Structural: the real intent satisfies this. */
export interface ScopeIntentLike {
  companies?: readonly string[] | undefined;
  /** Omitted (legacy callers) means fast - the backend default. */
  mode?: string | undefined;
}

export interface ScopeSummary {
  /** From the generated contract, deduped, deterministically ordered. */
  groups: string[];
  /** What will ACTUALLY be searched: the intent count after the cap. */
  companyCount: number;
  /** The mode-specific company cap that was applied. */
  companyCap: number;
  /** The mode-specific registry-page cap; Full is unbounded. */
  registryCap: number;
  /** How the panel should describe registry coverage. */
  registryMode: RegistryMode;
  /** True when the intent asked for more companies than the cap. */
  truncated: boolean;
  mode: ScopeMode;
}

/**
 * Build the scope summary for the pre-run scope step.
 *
 * - `companyCount` is the POST-cap count (what will actually be searched),
 *   never the requested count: reporting the requested count as the
 *   searched count is the specific dishonesty this field prevents.
 * - `truncated` is true exactly when the intent exceeded the cap.
 * - `groups` come from the caller's generated-contract list (deduped,
 *   deterministically ordered), never from a local array - this module
 *   holds no group vocabulary at all.
 * - Registry coverage is mode-scoped: Standard disables registry resolution,
 *   Deep caps it, and Full is unbounded.
 * - An omitted/unknown mode degrades to `fast` (the backend default).
 */
export function buildScopeSummary(
  intent: ScopeIntentLike | undefined,
  contractGroups: readonly string[] | undefined,
): ScopeSummary {
  const seen = new Set<string>();
  if (Array.isArray(contractGroups)) {
    for (const group of contractGroups) {
      if (typeof group === 'string' && group.length > 0 && !seen.has(group)) {
        seen.add(group);
      }
    }
  }
  const groups = [...seen].sort();
  const mode = resolveScopeMode(intent?.mode);
  const caps = MODE_SCOPE_CAPS[mode];
  const requested =
    intent && Array.isArray(intent.companies) ? intent.companies.length : 0;
  const companyCount = Math.min(requested, caps.companyCap);
  return {
    groups,
    companyCount,
    companyCap: caps.companyCap,
    registryCap: caps.registryCap,
    registryMode: registryModeFor(mode),
    truncated: requested > caps.companyCap,
    mode,
  };
}

// ---------------------------------------------------------------------------
// Confirmation gate (N18: deterministic before AI; wave-10 criterion 6)
// ---------------------------------------------------------------------------

/** A duration band in milliseconds: a range, never a false-precision single number. */
export interface TimeBandMs {
  minMs: number;
  maxMs: number;
}

/**
 * Derive the millisecond duration band from a wall-clock budget. The band
 * is derived from the budget constants (via `deepTimeBand`), never
 * hardcoded: `maxMs` is the budget bound itself and `minMs` is the band
 * floor one minute below. Defaults to the mirrored deep budget.
 */
export function confirmationTimeBand(
  totalBudgetMs: number = DEEP_TOTAL_BUDGET_MS,
): TimeBandMs {
  const sane =
    typeof totalBudgetMs === 'number' &&
    Number.isFinite(totalBudgetMs) &&
    totalBudgetMs > 0
      ? totalBudgetMs
      : DEEP_TOTAL_BUDGET_MS;
  const band = deepTimeBand(sane);
  return { minMs: band.lowMinutes * 60_000, maxMs: sane };
}

export interface Confirmation {
  mode: ScopeMode;
  requiresConfirmation: boolean;
  timeBand: TimeBandMs;
  estimate: EstimateLike | null;
  browserTierAvailable: boolean;
  warnings: string[];
}

/**
 * Build the confirmation gate for a mode.
 *
 * `scope` is the `buildScopeSummary` output the gate is shown for: the UI
 * (T822) displays its groups/company count alongside this gate, so the two
 * travel together even though the gate decision itself is mode-driven.
 *
 * - FAST: no confirmation gate, no estimate (fast requests no AI pass), and
 *   no warnings. The time band is still derived from the fast budget so the
 *   field is never a marketing literal, but it is not displayed.
 * - STANDARD: requires confirmation, derives its bounded band from the
 *   Standard budget, suppresses the estimate and says AI evaluation is off.
 * - DEEP: requires confirmation, derives its bounded band from the Deep
 *   budget and passes the estimate through when one was produced.
 * - FULL: requires confirmation, uses `{ minMs: 0, maxMs: 0 }` as the
 *   unbounded marker and states the honest hours/cancellable/kept-results
 *   contract instead of showing a batch duration as a total-run promise.
 * - `browserTierAvailable: false` adds an INFORMATIONAL warning for the modes
 *   that may use browser follow-ups. It never blocks the run (N2).
 * - An unknown mode degrades to fast (the backend default).
 */
export function confirmationFor(
  mode: string | undefined,
  scope: ScopeSummary,
  estimate: EstimateLike | null | undefined,
  browserTierAvailable: boolean,
): Confirmation {
  void scope;
  const resolved = resolveScopeMode(mode);
  if (resolved === 'fast') {
    return {
      mode: resolved,
      requiresConfirmation: false,
      timeBand: confirmationTimeBand(FAST_TOTAL_BUDGET_MS),
      estimate: null,
      browserTierAvailable,
      warnings: [],
    };
  }
  if (resolved === 'standard') {
    return {
      mode: resolved,
      requiresConfirmation: true,
      timeBand: confirmationTimeBand(STANDARD_TOTAL_BUDGET_MS),
      estimate: null,
      browserTierAvailable,
      warnings: ['AI evaluation is off in this mode.'],
    };
  }

  const warnings: string[] = [];
  if (resolved === 'full') {
    warnings.push(
      'Full Scan scans every company career page and can take hours. ' +
        'You can cancel at any time; results found before cancellation are kept.',
    );
  }
  if (estimate) {
    warnings.push(formatScopeEstimateWarning(estimate));
  }
  if (browserTierAvailable === false) {
    warnings.push(
      'Browser tier unavailable - the run proceeds anyway without it. ' +
        'Results may have less coverage, but nothing is blocked.',
    );
  }
  return {
    mode: resolved,
    requiresConfirmation: true,
    timeBand:
      resolved === 'full'
        ? { minMs: 0, maxMs: 0 }
        : confirmationTimeBand(DEEP_TOTAL_BUDGET_MS),
    estimate: estimate ?? null,
    browserTierAvailable,
    warnings,
  };
}

/**
 * Honest estimate warning: the figure is always called an estimate, never
 * a measured count (T782 `estimateCost` honest-precision notice).
 */
function formatScopeEstimateWarning(estimate: EstimateLike): string {
  if (estimate.calls <= 0) {
    return (
      'Estimated AI cost: none - no AI calls planned for this run. ' +
      'This is an estimate, not a measured count.'
    );
  }
  return (
    `Estimated AI cost: about ${estimate.calls} AI ` +
    `call${estimate.calls === 1 ? '' : 's'} ` +
    `(about ${estimate.approxTokens} tokens). ` +
    'This is an estimate, not a measured count.'
  );
}

// ---------------------------------------------------------------------------
// Run-state reducer (N16: cancel preserves the previous result set)
// ---------------------------------------------------------------------------

/** Terminal run statuses. `cancelled` is distinct from `failed` by design. */
export type RunStatus = 'running' | 'completed' | 'cancelled' | 'expired' | 'failed';

/** Per-unit terminal state. A unit stopped by cancel is `cancelled`, never `failed`. */
export type RunUnitStatus = 'pending' | 'ok' | 'cancelled' | 'failed';

export interface RunUnitState {
  id: string;
  status: RunUnitStatus;
}

export interface RunState {
  status: RunStatus;
  /** Collected rows. Cancel/expiry NEVER clears these (N16). */
  rows: unknown[];
  units: RunUnitState[];
}

export type RunEvent =
  | { type: 'unit-ok'; unitId: string; rows?: readonly unknown[] }
  | { type: 'unit-failed'; unitId: string }
  | { type: 'cancelled' }
  | { type: 'run-gone' }
  | { type: 'completed' }
  | { type: 'failed' };

/** The safe initial state: running, nothing collected yet. */
export function initialRunState(): RunState {
  return { status: 'running', rows: [], units: [] };
}

/**
 * Reduce a run event to the next run state (N16 reducer).
 *
 * - `cancelled`: collected rows are KEPT (N rows in, N rows out - a
 *   reducer that clears rows on cancel is the exact defect N16 exists to
 *   prevent). Status becomes `cancelled` (distinct from `failed`, so the
 *   header can read "Cancelled - showing N results found before you
 *   stopped"). Pending units become `cancelled`. No-op on an already
 *   finished run (cancel after completion shows the completed set).
 * - BOUNDARY RULE (mirrors the backend T820 rule in
 *   `backend/src/discovery/orchestrator.ts` `executeOne`, identically):
 *   rows received win over cancel - a `unit-ok` event records `ok` even on
 *   a cancelled run; a unit settling WITHOUT a result after cancel
 *   (`unit-failed` on a cancelled run) records `cancelled`, never
 *   `failed`. If this rule and the backend rule diverge, one of them is
 *   wrong.
 * - `run-gone` (unknown/expired run: the 5-minute `RUN_TTL_MS` can expire
 *   mid-run): keeps the rows already received and marks the run `expired`.
 *   It never clears rows and never leaves the state `running`. No-op on an
 *   already finished run.
 * - `completed` / `failed`: terminal transitions from `running` only; rows
 *   are kept in both cases.
 * - An unrecognised event degrades to the previous state object unchanged,
 *   never `undefined` fields. A malformed state degrades to the initial
 *   state.
 */
export function reduceRunState(
  state: RunState,
  event: RunEvent,
): RunState {
  if (!state || typeof state !== 'object') return initialRunState();
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const units = Array.isArray(state.units) ? state.units : [];
  const eventType =
    event && typeof event === 'object'
      ? (event as { type?: unknown }).type
      : undefined;

  switch (eventType) {
    case 'unit-ok': {
      const { unitId, rows: incoming } = event as {
        type: 'unit-ok';
        unitId: string;
        rows?: readonly unknown[];
      };
      const index = units.findIndex((unit) => unit?.id === unitId);
      if (index === -1) return state;
      const nextUnits = units.map((unit, i) =>
        i === index ? { ...unit, status: 'ok' as RunUnitStatus } : unit,
      );
      const nextRows =
        Array.isArray(incoming) && incoming.length > 0
          ? [...rows, ...incoming]
          : rows;
      return { ...state, rows: nextRows, units: nextUnits };
    }
    case 'unit-failed': {
      const { unitId } = event as { type: 'unit-failed'; unitId: string };
      const index = units.findIndex((unit) => unit?.id === unitId);
      if (index === -1) return state;
      // No result settled: on a cancelled run it is `cancelled`, never `failed`.
      const settled: RunUnitStatus =
        state.status === 'cancelled' ? 'cancelled' : 'failed';
      const nextUnits = units.map((unit, i) =>
        i === index ? { ...unit, status: settled } : unit,
      );
      return { ...state, rows, units: nextUnits };
    }
    case 'cancelled': {
      if (state.status !== 'running') return state;
      return {
        ...state,
        status: 'cancelled',
        rows,
        units: units.map((unit) =>
          unit?.status === 'pending'
            ? { ...unit, status: 'cancelled' as RunUnitStatus }
            : unit,
        ),
      };
    }
    case 'run-gone': {
      if (state.status !== 'running') return state;
      return { ...state, status: 'expired', rows, units };
    }
    case 'completed': {
      if (state.status !== 'running') return state;
      return { ...state, status: 'completed', rows, units };
    }
    case 'failed': {
      if (state.status !== 'running') return state;
      return { ...state, status: 'failed', rows, units };
    }
    default:
      return state;
  }
}
