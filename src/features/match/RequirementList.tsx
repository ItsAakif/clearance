// The requirement list, with evidence and Confirm/Reject (T1070, 06 sec. E.11 flow 7).
//
// WHAT THIS RENDERS, IN THE ORDER THE SPEC FIXES: a requirement with its level, the evidence
// behind that level, and - ONLY for the two proposal levels - a Confirm and a Reject. A
// `direct` requirement has no buttons, because it is already evidenced by something the user
// confirmed; a gap has no buttons either, because the honest action on a gap is to go and
// create the experience, not to confirm a guess about it.
//
// EVERY LEVEL IS NAMED. The badge carries an icon AND a label, and the pending levels say in
// their own copy that they are waiting for a decision, so a screen reader user and a
// colour-blind user get the same information this screen is built to give.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { EvidenceLevelBadge } from "./EvidenceLevelBadge";
import { actionFor, levelPresentation } from "./matchPresentation";
import type { MatchReport, MatchRequirement } from "@/services/api/match";

/** `must` / `should` / `nice`, spelled out: "must" is the employer's own gate, not a rating. */
const IMPORTANCE_LABEL: Record<string, string> = {
  must: "Required",
  should: "Expected",
  nice: "Nice to have",
};

function importanceLabel(importance: string): string {
  return IMPORTANCE_LABEL[importance] ?? importance;
}

interface RequirementListProps {
  requirements: MatchRequirement[];
  /** The report id every decision is addressed to; null until a report exists. */
  matchReportId: string | null;
  /** Which proposal is mid-decision, so only that row shows a spinner. */
  busyPotentialId: string | null;
  onConfirm: (requirement: MatchRequirement) => void;
  onReject: (requirement: MatchRequirement) => void;
  errors: Record<string, string>;
}

export function RequirementList({
  requirements,
  matchReportId,
  busyPotentialId,
  onConfirm,
  onReject,
  errors,
}: RequirementListProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What this job asks for</CardTitle>
        <CardDescription>
          Each requirement is one line with its evidence level. Direct means a statement you
          confirmed says it outright. Contextual and potential are suggestions we have not
          verified, and they count for nothing until you confirm them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {requirements.map((requirement) => {
          const action = actionFor(requirement);
          const presentation = levelPresentation(requirement.level);
          const proposal = requirement.potentialMatch;
          const busy = proposal !== null && busyPotentialId === proposal.id;
          const error = errors[requirement.id] ?? null;

          return (
            <article
              key={requirement.id}
              className="space-y-2 border-b border-rule py-3"
              aria-label={`${requirement.text}: ${presentation.label}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-ink">{requirement.text}</h3>
                  <p className="text-xs2 text-ink-3">
                    {importanceLabel(requirement.importance)} &middot; {requirement.kind.replace(/_/g, " ")}
                  </p>
                </div>
                <EvidenceLevelBadge level={requirement.level} />
              </div>

              <p className="text-xs2 text-ink-3">{presentation.description}</p>

              {requirement.evidence.length > 0 ? (
                <ul className="space-y-1">
                  {requirement.evidence.map((evidence) => (
                    <li
                      key={evidence.claimId}
                      className="border-l-2 border-rule py-0.5 pl-2 text-xs2 text-ink"
                    >
                      <span className="font-medium">Your statement: </span>
                      {evidence.statement}
                      <span className="ml-1 text-ink-3">
                        ({evidence.via === "confirmed_match" ? "you confirmed this" : "named directly"})
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {proposal ? (
                <div className="space-y-2 border-l-2 border-rule pl-3">
                  <p className="text-xs2 text-ink">
                    <span className="font-medium">Why we suggest this: </span>
                    {proposal.rationale}
                  </p>
                  <p className="text-xs2 text-ink-3">
                    Based on your statement: {proposal.proposedEvidence}
                  </p>
                  {proposal.status === "rejected" ? (
                    <p className="text-xs2 text-ink-3">
                      You rejected this suggestion, so it is a named gap below. It stays on the
                      record.
                    </p>
                  ) : null}
                  {proposal.status === "confirmed" ? (
                    <p className="text-xs2 text-ink-3">
                      You confirmed this, so it is direct evidence now.
                    </p>
                  ) : null}
                  {action === "confirm_or_reject" && matchReportId ? (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => onConfirm(requirement)}
                      >
                        {busy ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : null}
                        Confirm this is my experience
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => onReject(requirement)}
                      >
                        Reject this suggestion
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {error ? (
                <p className="text-xs2 text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </article>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** Re-exported so the page can pass the whole report without widening its own types. */
export type { MatchReport };
export default RequirementList;