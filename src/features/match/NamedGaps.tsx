// The named gaps (T1070, 06 sec. E.6 / E.11 flow 7).
//
// A LIST OF NAMES. Every row is a requirement the user does not have confirmed evidence for,
// written out in full so it can be acted on: not a count, not a deduction, not a percentage.
// This is the component E.6 asks for by name - "gaps are always named" - and the reason the
// section exists at all instead of the numbers having been folded into a single figure.
//
// THE TONE IS NEUTRAL, NOT RED. A gap is an accurate description of the evidence, not a
// failure the user committed, and colouring it as an error would be the same verdict-by-
// colour the level badges refuse.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CircleSlash } from "lucide-react";
import { NO_SCORE_NOTE } from "./matchPresentation";
import type { MatchGap } from "@/services/api/match";

const IMPORTANCE_LABEL: Record<string, string> = {
  must: "Required",
  should: "Expected",
  nice: "Nice to have",
};

interface NamedGapsProps {
  gaps: MatchGap[];
  className?: string;
}

export function NamedGaps({ gaps, className }: NamedGapsProps) {
  return (
    <Card className={className ?? ""}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleSlash className="h-4 w-4 text-ink-3" aria-hidden="true" />
          Named gaps
        </CardTitle>
        <CardDescription>
          {gaps.length === 0
            ? "Nothing is missing: every requirement is covered by evidence you have confirmed."
            : `${gaps.length} requirement${gaps.length === 1 ? "" : "s"} with nothing in your confirmed evidence. ${NO_SCORE_NOTE}`}
        </CardDescription>
      </CardHeader>
      {gaps.length > 0 ? (
        <CardContent>
          <ul className="space-y-2">
            {gaps.map((gap) => (
              <li
                key={gap.requirementId}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule py-2"
              >
                <span className="text-sm text-ink">{gap.text}</span>
                <span className="text-xs2 text-ink-3">
                  {IMPORTANCE_LABEL[gap.importance] ?? gap.importance} &middot;{" "}
                  {gap.kind.replace(/_/g, " ")}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}

export default NamedGaps;