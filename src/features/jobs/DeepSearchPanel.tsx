// Three-mode search switch, honest per-mode warnings, cost estimate display,
// and cancel control (T889, ADR-033/ADR-031).
//
// PRESENTATION ONLY: mode labels and descriptions, duration bands, gate
// decisions, scope caps and warning copy come from the pure T888 helpers.
// This component keeps no mode list, budget, cap, duration or confirmation
// rule of its own. Legacy fast remains supported by the owner/API, but it is
// deliberately not one of the three product options.

import { useMemo } from 'react';
import type { JobSearchMode } from '@/services/api/jobs';
import {
  UI_MODE_OPTIONS,
  budgetMsForMode,
  deepTimeBand,
  formatCostEstimate,
  formatDeepTimeWarning,
  modeLabel,
} from '@/features/jobs/deepSearch';
import {
  buildScopeSummary,
  confirmationFor,
} from '@/features/jobs/deepSearchScope';
import { DeepSearchScopePanel } from '@/features/jobs/DeepSearchScopePanel';

export interface CostEstimateDisplay {
  calls: number;
  approxTokens: number;
}

export interface DeepSearchPanelProps {
  /** Live search depth. The switch exposes Standard, Deep and Full only. */
  mode: JobSearchMode;
  onModeChange: (mode: JobSearchMode) => void;
  /**
   * The run snapshot's AI estimate. The owner passes `undefined` when a run
   * has not produced one; Standard ignores it and Fast never displays it.
   */
  estimate?: CostEstimateDisplay;
  /**
   * True when a run is active or settled but its snapshot carries no AI
   * estimate. False when no estimate display is expected.
   */
  estimateUnknown?: boolean;
  /**
   * A skipped AI pass and its reason. It is reported as skipped, never as a
   * completed evaluation. Standard/Fast do not run this pass.
   */
  aiSkippedReason?: string;
  /**
   * True when a run reported the browser tier unavailable. Browser follow-ups
   * are optional for Deep and Full, so the run proceeds without the tier.
   */
  browserTierKnownUnavailable?: boolean;
  /** Present while a run exists (in flight or settled); absent when idle. */
  runId?: string;
  /** True while the cancel mutation is in flight. */
  cancelPending?: boolean;
  /** False once the run is terminal; the owner derives it via `isRunTerminal`. */
  canCancel?: boolean;
  onCancel?: () => void;
  // -- Scope step: optional pre-run summary and per-mode confirmation gate.
  /**
   * Intent company names. Rendered only together with `contractGroups` so a
   * half-wired scope summary cannot appear.
   */
  companies?: readonly string[];
  /**
   * Intent source groups from the generated source contract. Rendered only
   * together with `companies`.
   */
  contractGroups?: readonly string[];
  /** Owner-owned gate open state for the confirmation dialog. */
  scopeGateOpen?: boolean;
  onScopeGateOpenChange?: (open: boolean) => void;
  /** The owner starts the run and closes the gate. */
  onScopeConfirm?: () => void;
  /** True while the confirm-triggered run is being issued. */
  scopeConfirmPending?: boolean;
  /**
   * True while an AI estimate is expected but not ready. The confirm action
   * stays disabled until it resolves.
   */
  scopeEstimatePending?: boolean;
  /**
   * True when the run snapshot reports cancellation. The header distinguishes
   * kept partial results from a failed request.
   */
  runCancelled?: boolean;
  /** Rows kept on screen after cancel. */
  keptResultCount?: number;
  /** True when the search request itself failed. */
  runFailed?: boolean;
}

export function DeepSearchPanel({
  mode,
  onModeChange,
  estimate,
  estimateUnknown = false,
  aiSkippedReason,
  browserTierKnownUnavailable = false,
  runId,
  cancelPending = false,
  canCancel = false,
  onCancel,
  companies,
  contractGroups,
  scopeGateOpen = false,
  onScopeGateOpenChange,
  onScopeConfirm,
  scopeConfirmPending = false,
  scopeEstimatePending = false,
  runCancelled = false,
  keptResultCount = 0,
  runFailed = false,
}: DeepSearchPanelProps) {
  const selectedOption = UI_MODE_OPTIONS.find((option) => option.value === mode);
  const scope = useMemo(
    () =>
      buildScopeSummary(
        { companies: companies ?? [], mode },
        contractGroups ?? [],
      ),
    [companies, contractGroups, mode],
  );
  // The same pure decision drives the visible mode notes and the child gate.
  // Fast resolves to no gate, no estimate and no warning even if the owner
  // supplies estimate-related props.
  const confirmation = useMemo(
    () =>
      confirmationFor(
        mode,
        scope,
        estimate ?? null,
        !browserTierKnownUnavailable,
      ),
    [browserTierKnownUnavailable, estimate, mode, scope],
  );
  const deepTimeWarning =
    confirmation.mode === 'deep'
      ? formatDeepTimeWarning(
          deepTimeBand(budgetMsForMode(confirmation.mode)),
        )
      : undefined;
  const modeWarning = deepTimeWarning ?? selectedOption?.description;
  const showCancel = runId !== undefined;
  const showScope =
    Array.isArray(companies) && Array.isArray(contractGroups);
  // Standard never runs the AI pass. Deep and Full may do so and therefore
  // keep the existing estimate and skipped-reason affordances.
  const showsAiRun =
    confirmation.mode === 'deep' || confirmation.mode === 'full';
  const kept = Number.isFinite(keptResultCount) && keptResultCount >= 0
    ? Math.floor(keptResultCount)
    : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset className="flex flex-wrap items-center gap-3">
          <legend className="sr-only">Search depth</legend>
          <span className="text-xs text-ink-3" aria-hidden="true">
            Search depth
          </span>
          {UI_MODE_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-1.5 text-sm"
            >
              <input
                type="radio"
                name="search-depth"
                value={option.value}
                checked={mode === option.value}
                onChange={() => onModeChange(option.value)}
                aria-label={`${option.label} search depth`}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>

        {modeWarning && (
          <p className="text-sm text-ink-3" role="note">
            {modeWarning}
          </p>
        )}

        {confirmation.requiresConfirmation &&
          confirmation.warnings.length > 0 && (
            <ul className="space-y-1" aria-label={`${modeLabel(mode)} warnings`}>
              {confirmation.warnings.map((warning, index) => (
                <li
                  key={`${index}-${warning}`}
                  className="text-sm text-warning"
                  role="note"
                >
                  {warning}
                </li>
              ))}
            </ul>
          )}

        {showsAiRun && browserTierKnownUnavailable && (
          <p className="text-xs text-warning" role="note">
            The browser extraction tier is unavailable, so{' '}
            {modeLabel(mode)} proceeds without it.
          </p>
        )}

        {showsAiRun && (estimate !== undefined || estimateUnknown) && (
          <p className="text-xs text-ink-3" aria-live="polite">
            {estimate !== undefined
              ? formatCostEstimate(estimate)
              : formatCostEstimate(undefined)}
          </p>
        )}

        {showsAiRun && aiSkippedReason && (
          <p className="text-xs text-warning" aria-live="polite">
            AI evaluation skipped: {aiSkippedReason}
          </p>
        )}

        {showCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={!canCancel || cancelPending}
            aria-label="Cancel search"
            className="h-8 rounded-control border border-rule bg-transparent px-2 text-xs text-ink-2 hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelPending ? 'Cancelling...' : 'Cancel search'}
          </button>
        )}

        {runCancelled && (
          <p className="text-xs text-ink-3" role="status">
            Cancelled - showing {kept} result{kept !== 1 ? 's' : ''} found
            before you stopped
          </p>
        )}

        {runFailed && !runCancelled && (
          <p className="text-xs text-destructive" role="alert">
            Search failed. Check the backend job sources connection.
          </p>
        )}
      </div>
      {showScope && (
        <DeepSearchScopePanel
          mode={mode}
          companies={companies ?? []}
          contractGroups={contractGroups ?? []}
          estimate={estimate ?? null}
          browserTierAvailable={!browserTierKnownUnavailable}
          open={scopeGateOpen}
          onOpenChange={(next) => onScopeGateOpenChange?.(next)}
          onConfirm={() => onScopeConfirm?.()}
          confirmPending={scopeConfirmPending}
          estimatePending={scopeEstimatePending}
        />
      )}
    </div>
  );
}
