// One candidate: the plan, the feasibility facts, and the three decisions (T1100,
// 06 sec. E.5's output shape and its accept -> complete -> confirm loop).
//
// WHAT IS ON THE CARD, and why each part is here:
//   - the NAMED GAP it closes, because an unattributable candidate is not actionable;
//   - the two-day budget in hours and the three-word difficulty, because the feasibility screen
//     is a budget rather than a rating and nothing on this card is a judgement of the person;
//   - day 1, day 2, milestones, in scope, NOT built, and the ORIGINAL design decision, which is
//     E.5's output requirement and the rule the anti-copy guard enforces;
//   - the references, with their licences, under a heading that says inspiration only.
//
// THE BUTTONS ARE THE LOOP, AND THEIR ORDER IS THE PROMISSE. Accept asserts nothing about the
// user. Complete writes nothing to the profile - and the card says so, in words, at the moment
// it matters: when `awaitingYourConfirmation` is true, the confirmation prompt is on the card in
// full, not hidden behind a toast. Only Confirm creates a statement, and the server's decision
// message is rendered verbatim underneath.

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, CircleDot, Hammer, Loader2 } from "lucide-react";
import { ReferenceList } from "./ReferenceList";
import {
  availableActions,
  actionHint,
  budgetNote,
  designDecision,
  gapFor,
  lifecycleSteps,
  planSections,
  stackLine,
  statusView,
  type DecisionAction,
} from "./projectPresentation";
import type { ProjectOpportunity, TeachableGap } from "@/services/api/projectDiscovery";

const DIFFICULTY_TONE: Readonly<Record<string, string>> = {
  low: "text-[hsl(var(--status-screening))]",
  medium: "text-[hsl(var(--status-offer))]",
  high: "text-ink-2",
};

interface ProjectCandidateCardProps {
  candidate: ProjectOpportunity;
  selectedGaps: TeachableGap[];
  busyAction: DecisionAction | null;
  notice: string | null;
  onDecide: (candidate: ProjectOpportunity, action: DecisionAction) => void;
}

export function ProjectCandidateCard({
  candidate,
  selectedGaps,
  busyAction,
  notice,
  onDecide,
}: ProjectCandidateCardProps) {
  const gap = gapFor(candidate, selectedGaps);
  const status = statusView(candidate.status);
  const actions = availableActions(candidate);
  const steps = lifecycleSteps(candidate);
  const sections = planSections(candidate.plan);
  // E.5's output requirement. The server refuses a candidate without one, so an empty string here
  // would mean a row this engine did not write.
  const decision = designDecision(candidate.plan);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {candidate.title}
          <Badge
            variant="outline"
            className={`text-xs2 ${DIFFICULTY_TONE[candidate.difficulty] ?? DIFFICULTY_TONE.medium}`}
          >
            {candidate.difficulty} difficulty
          </Badge>
          <Badge variant="outline" className="text-xs2">
            {status.label}
          </Badge>
        </CardTitle>
        <CardDescription>
          {gap ? (
            <>
              Closes the named gap <span className="text-ink">{gap.text}</span>
              {gap.importance === "must" ? " (required)" : ` (${gap.importance})`}.
            </>
          ) : (
            candidate.relevance
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <p className="text-sm text-ink">{candidate.idea}</p>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs2 text-ink-3">
          <div className="flex gap-1">
            <dt>Budget:</dt>
            <dd className="text-ink">{budgetNote(candidate.estimatedHours)}</dd>
          </div>
          {candidate.stack.length > 0 ? (
            <div className="flex gap-1">
              <dt>Runs on:</dt>
              <dd className="text-ink">{stackLine(candidate)}</dd>
            </div>
          ) : null}
        </dl>

        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs2" aria-label="Lifecycle">
          {steps.map((step) => (
            <li
              key={step.label}
              className={
                step.state === "done"
                  ? "flex items-center gap-1 text-ink"
                  : step.state === "current"
                    ? "flex items-center gap-1 font-medium text-ink"
                    : "flex items-center gap-1 text-ink-3"
              }
            >
              {step.state === "done" ? (
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <CircleDot className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {step.label}
              <span className="sr-only">
                {step.state === "done" ? " (done)" : step.state === "current" ? " (next)" : " (not yet)"}
              </span>
            </li>
          ))}
        </ol>

        <div className="grid gap-3 sm:grid-cols-2">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="text-xs2 font-medium text-ink-3">{section.title}</h3>
              <ul className="mt-1 space-y-1 text-sm text-ink">
                {section.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div>
          <h3 className="text-xs2 font-medium text-ink-3">Original design decision</h3>
          <p className="mt-1 text-sm text-ink">{decision}</p>
        </div>

        <ReferenceList references={candidate.references} />

        {candidate.awaitingYourConfirmation ? (
          <Alert>
            <AlertTitle className="flex items-center gap-2">
              <Hammer className="h-4 w-4" aria-hidden="true" />
              Finished, and still only a plan
            </AlertTitle>
            <AlertDescription>
              Your profile has not changed. Nothing is recorded until you press confirm below, and
              that is the only thing in this flow that writes a statement.
            </AlertDescription>
          </Alert>
        ) : null}

        {notice ? <p className="text-xs2 text-ink-3">{notice}</p> : null}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={!actions.canAccept || busyAction !== null}
          onClick={() => onDecide(candidate, "accept")}
        >
          Accept this plan
        </Button>
        <Button
          disabled={!actions.canComplete || busyAction !== null}
          onClick={() => onDecide(candidate, "complete")}
        >
          Mark complete
        </Button>
        <Button
          disabled={!actions.canConfirm || busyAction !== null}
          onClick={() => onDecide(candidate, "confirm")}
        >
          Confirm this is mine
        </Button>
        {busyAction !== null ? (
          <span className="flex items-center gap-2 text-xs2 text-ink-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Recording that decision
          </span>
        ) : null}
        {actionHint("confirm", candidate) ? (
          <span className="text-xs2 text-ink-3">{actionHint("confirm", candidate)}</span>
        ) : null}
      </CardFooter>
    </Card>
  );
}

export default ProjectCandidateCard;