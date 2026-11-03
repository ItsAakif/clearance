// Search scope step: honest per-mode summary and confirmation gate
// (T889, ADR-031/ADR-033, master-spec N2/N18).
//
// RENDER ONLY: every figure and rule comes from `./deepSearchScope`
// (`buildScopeSummary` / `confirmationFor`, T888) and product names come from
// `./deepSearch` (`modeLabel`). This file holds no group vocabulary (the
// browser mark reads `BROWSER_GROUP` from the generated-contract module
// `./sourceGroups`), no budget, no duration and no cap. The gate decision is
// driven off `confirmation.requiresConfirmation`, so legacy fast renders no
// gate and no estimate even if the owner passes one.
//
// CONFIRM-GATE STYLE: the radix AlertDialog primitives from
// `@/components/ui/alert-dialog` - the same confirm-gate style the Jobs
// flow used before (T402 `ProfileMatchDialog`; since replaced by the
// inline profile toggle). No second dialog style is introduced. No theme
// change (existing utility classes only), no new dependency, no transport.

import { useMemo } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { JobSearchMode } from '@/services/api/jobs';
import {
  buildScopeSummary,
  confirmationFor,
} from '@/features/jobs/deepSearchScope';
import type {
  Confirmation,
  ScopeSummary,
} from '@/features/jobs/deepSearchScope';
import { formatCostEstimate, modeLabel } from '@/features/jobs/deepSearch';
import { BROWSER_GROUP } from '@/features/jobs/sourceGroups';
import type { CostEstimateDisplay } from '@/features/jobs/DeepSearchPanel';

export interface DeepSearchScopePanelProps {
  /**
   * The search depth. The owner passes the live filter value; an unknown
   * value degrades to fast inside `buildScopeSummary`, never here.
   */
  mode: JobSearchMode;
  /**
   * The intent company names the run will cover (the owner folds the
   * legacy single-company field in, exactly as the filter sheet does for
   * validation). `buildScopeSummary` applies the backend cap; the raw
   * length here is the requested count behind the "capped from N" note.
   */
  companies: readonly string[];
  /**
   * The intent source groups for this run, from the generated contract
   * (`filters.sourceGroups`). Displayed verbatim after the helper dedupes
   * and orders them - never replaced by a local list.
   */
  contractGroups: readonly string[];
  /**
   * The wave-9 cost estimate when one was produced (snapshot-derived by
   * the owner). Absent pre-run: the gate then shows the honest
   * "unavailable" fallback, never a zero. Fast mode never sees it (the
   * helper nulls it).
   */
  estimate?: CostEstimateDisplay | null;
  /**
   * False when a run snapshot reported the browser tier unavailable (N2:
   * informational - the run proceeds anyway and the confirm button keeps
   * working). True when no snapshot says otherwise.
   */
  browserTierAvailable: boolean;
  /**
   * Owner-owned gate open state (the double-answer guard stays
   * parent-owned: the first answer closes the gate, same contract as the
   * old profile gate). The gate renders only when the helper requires
   * confirmation, whatever `open` says.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The owner starts the run and closes the gate. */
  onConfirm: () => void;
  /** True while the confirm-triggered run is being issued. */
  confirmPending?: boolean;
  /**
   * True while a cost estimate is expected but not yet ready: the confirm
   * action stays disabled until it resolves (the estimate gate). False
   * today - the wave-9 estimate is snapshot-reported, so no pre-run
   * estimate source exists yet; the prop keeps the blocking path
   * prop-driven for the lane that introduces one.
   */
  estimatePending?: boolean;
}

/**
 * Display-only minutes rendering of the helper's millisecond band. The
 * band itself is derived from the budget constants inside
 * `confirmationFor` - this formats it, never sources it.
 */
function formatTimeBand(timeBand: Confirmation['timeBand']): string {
  const minMinutes = Math.max(1, Math.ceil(timeBand.minMs / 60_000));
  const maxMinutes = Math.max(1, Math.ceil(timeBand.maxMs / 60_000));
  if (minMinutes >= maxMinutes) {
    return `about ${maxMinutes} minute${maxMinutes === 1 ? '' : 's'}`;
  }
  return `about ${minMinutes} to ${maxMinutes} minutes`;
}

/**
 * The honest company-count form, written so the selection reads as OPTIONAL
 * (empty means no company filter in every mode - nothing is skipped because
 * the strip is blank):
 * - 0 selected -> `any company (optional)`. The cap belongs in the non-empty
 *   forms only; here it read like a requirement to fill the field in.
 * - 1..cap -> `N selected (max ${cap})` - the searched count plus the cap
 *   budget. The old `1 of 10 company` wording also read as an obligation.
 * - truncated -> `${cap} selected (capped from ${requested})` - what runs
 *   versus what was asked for. Only the strings changed; the counts come from
 *   `buildScopeSummary` (`companyCount` is the post-cap count, so it equals
 *   `companyCap` exactly when `truncated` is true).
 */
function formatCompanyCount(scope: ScopeSummary, requested: number): string {
  if (scope.companyCount === 0) {
    return 'any company (optional)';
  }

  if (scope.truncated) {
    return `${scope.companyCap} selected (capped from ${requested})`;
  }
  return `${scope.companyCount} selected (max ${scope.companyCap})`;
}

function formatRegistryScope(scope: ScopeSummary): string {
  if (scope.registryMode === 'off') {
    return 'not searched in this mode';
  }
  if (scope.registryMode === 'all') {
    return 'every active career page (count shown once the scan starts)';
  }
  return `up to ${scope.registryCap} career pages`;
}

/** One group label; browser follow-ups are optional in Deep and Full. */
function formatGroup(group: string): string {
  return group === BROWSER_GROUP
    ? `${group} (optional, ${modeLabel('deep')}/${modeLabel('full')} only)`
    : group;
}

export function DeepSearchScopePanel({
  mode,
  companies,
  contractGroups,
  estimate,
  browserTierAvailable,
  open,
  onOpenChange,
  onConfirm,
  confirmPending = false,
  estimatePending = false,
}: DeepSearchScopePanelProps) {
  const requestedCompanyCount = Array.isArray(companies) ? companies.length : 0;
  const scope: ScopeSummary = useMemo(
    () => buildScopeSummary({ companies, mode }, contractGroups),
    [companies, mode, contractGroups],
  );
  const confirmation: Confirmation = useMemo(
    () =>
      confirmationFor(mode, scope, estimate ?? null, browserTierAvailable),
    [mode, scope, estimate, browserTierAvailable],
  );
  // THE gate rule: the dialog exists only when the helper requires
  // confirmation. Standard, Deep and Full all require it; legacy fast does
  // not. There is deliberately no local mode check in this file.
  const showGate = confirmation.requiresConfirmation;
  const productMode = modeLabel(scope.mode);
  const groupText =
    scope.groups.length > 0
      ? scope.groups.map(formatGroup).join(', ')
      : 'all sources';
  const companyText = formatCompanyCount(scope, requestedCompanyCount);
  const registryText = formatRegistryScope(scope);
  const timeBandText =
    confirmation.timeBand.maxMs === 0
      ? 'Unbounded - can take hours'
      : formatTimeBand(confirmation.timeBand);
  const confirmBlocked = confirmPending || estimatePending;

  return (
    <>
      <div
        className="rounded-control border border-rule bg-muted/50 px-3 py-2"
      >
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
          aria-live="polite"
        >
          <span className="text-ink-3">
            Scope:{' '}
            <span className="font-medium text-foreground" aria-label={`Source groups: ${groupText}`}>
              {groupText}
            </span>
          </span>
          <span className="text-ink-3">
            Companies:{' '}
            <span className="font-medium text-foreground" aria-label={`Companies to search: ${companyText}`}>
              {companyText}
            </span>
          </span>
          <span className="text-ink-3">
            Registry:{' '}
            <span className="font-medium text-foreground">{registryText}</span>
          </span>
          <span className="text-ink-3">
            Mode:{' '}
            <span className="font-medium text-foreground" aria-label={`Search mode: ${productMode}`}>
              {productMode}
            </span>
          </span>
          {showGate && (
            <span className="text-ink-3">
              Expected duration:{' '}
              <span className="font-medium text-foreground" aria-label={`Expected duration: ${timeBandText}`}>
                {timeBandText}
              </span>
            </span>
          )}
        </div>
      </div>

      {showGate && (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm {productMode}</AlertDialogTitle>
              <AlertDialogDescription>
                Review the {productMode} scope and coverage before it starts.
                You can cancel at any time; results already found are kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <dl className="space-y-2 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-3">Mode:</dt>
                <dd className="font-medium text-foreground">{productMode}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-3">Source groups:</dt>
                <dd className="font-medium text-foreground">{groupText}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-3">Companies:</dt>
                <dd className="font-medium text-foreground">{companyText}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-3">Registry:</dt>
                <dd className="font-medium text-foreground">{registryText}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-3">Expected duration:</dt>
                <dd className="font-medium text-foreground">{timeBandText}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-ink-3">AI cost:</dt>
                <dd
                  className="font-medium text-foreground"
                  aria-live="polite"
                >
                  {confirmation.estimate !== null
                    ? formatCostEstimate(confirmation.estimate)
                    : estimatePending
                      ? 'Estimating AI cost - the confirm button unlocks when the estimate is ready.'
                      : formatCostEstimate(undefined)}
                </dd>
              </div>
            </dl>
            {confirmation.warnings.length > 0 && (
              <ul aria-label={`${productMode} warnings`} className="space-y-1">
                {confirmation.warnings.map((warning, index) => (
                  <li
                    key={index}
                    className="text-xs text-warning"
                    role="note"
                  >
                    {warning}
                  </li>
                ))}
              </ul>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel>Back</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  if (confirmBlocked) {
                    event.preventDefault();
                    return;
                  }
                  onConfirm();
                }}
                aria-disabled={confirmBlocked}
                aria-label={
                  estimatePending
                    ? `Start ${productMode} (disabled until the cost estimate is ready)`
                    : `Start ${productMode}`
                }
              >
                {confirmPending ? 'Starting...' : `Start ${productMode}`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
