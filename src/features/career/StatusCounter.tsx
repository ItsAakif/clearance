// The permanent "N unconfirmed" counter (T1020, 06 E.11 flow 1 + flow 3).
//
// ALWAYS VISIBLE, and always derived from the same rule the server uses
// (`UNCONFIRMED_STATUSES`), so the number on this card and the `counts` in the API
// response can never disagree. `unconfirmedCount` prefers the server's count - which
// describes the WHOLE profile, not the filtered list - and falls back to a local tally
// for a response that carries claims but no counts.
//
// ICON + TEXT: the digits are the accessible part; the colour only reinforces them.

import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { ShieldCheck, Sparkles } from "lucide-react";
import type { CareerClaim, CareerClaimCounts } from "@/services/api/career";
import {
  CONFIRMED_STATUS,
  confirmationProgress,
  emptyStateMessage,
  unconfirmedCount,
} from "./claimPresentation";

interface StatusCounterProps {
  claims: readonly CareerClaim[] | null | undefined;
  counts: CareerClaimCounts | null | undefined;
  /** How many evidence sources this profile has. Shown beside the claim totals. */
  sourcesCount?: number | null;
}

/**
 * `percent` is how much of the list is CONFIRMED, not how much is left. A progress bar
 * that fills towards "done" is the direction a user can act on; one that fills towards
 * "to do" reads as a task queue and never reaches full.
 */
function confirmedPercent(counts: CareerClaimCounts): number {
  if (counts.total === 0) return 0;
  return Math.round(((counts[CONFIRMED_STATUS] ?? 0) / counts.total) * 100);
}

export function StatusCounter({ claims, counts, sourcesCount }: StatusCounterProps) {
  if (!counts) return null;
  const unconfirmed = unconfirmedCount(claims, counts);
  const confirmed = counts[CONFIRMED_STATUS] ?? 0;
  const empty = emptyStateMessage(counts);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-ink" data-testid="career-unconfirmed">
            <Sparkles className="mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden="true" />
            <span className="text-lg font-semibold tabular-nums">{unconfirmed}</span>{" "}
            {unconfirmed === 1 ? "statement" : "statements"} still to confirm
          </p>
          <p className="text-sm text-ink-3" data-testid="career-progress">
            <ShieldCheck className="mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden="true" />
            {confirmationProgress(counts)}
          </p>
        </div>

        <Progress
          value={confirmedPercent(counts)}
          aria-label={`${confirmationProgress(counts)}. ${unconfirmed} still to confirm.`}
        />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs2 text-ink-3 sm:grid-cols-4">
          <div>
            <dt className="inline">Confirmed</dt>
            <dd className="ml-1 inline font-medium tabular-nums text-ink">{confirmed}</dd>
          </div>
          <div>
            <dt className="inline">Rejected</dt>
            <dd className="ml-1 inline font-medium tabular-nums text-ink">
              {counts.rejected ?? 0}
            </dd>
          </div>
          <div>
            <dt className="inline">Sources</dt>
            <dd className="ml-1 inline font-medium tabular-nums text-ink">
              {typeof sourcesCount === 'number' ? sourcesCount : 0}
            </dd>
          </div>
          <div>
            <dt className="inline">Total</dt>
            <dd className="ml-1 inline font-medium tabular-nums text-ink">{counts.total}</dd>
          </div>
        </dl>

        {empty ? (
          <p className="text-sm text-ink-3" data-testid="career-empty-state">
            {empty}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default StatusCounter;
