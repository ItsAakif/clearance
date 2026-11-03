// The gap selection: what a two-day project COULD close, and what it could not (T1100,
// 06 sec. E.5's first box).
//
// EVERY REFUSAL IS NAMED, WITH ITS RULE. The second list is the reason this component is not
// just a row of names: a requirement the user can see on the match report does not appear as a
// candidate, and "we looked and found nothing" would be a different - and false - claim. So
// every refusal carries the machine-readable reason as a sentence and the server's own detail
// under it.
//
// THE SELECTION IS NOT A RANKING. The list is in importance order, which is an ORDER over named
// things and nothing else: there is no number attached to a gap and nothing is combined.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Ban, Sparkles } from "lucide-react";
import { exclusionRows } from "./projectPresentation";
import type { ExcludedGap, TeachableGap } from "@/services/api/projectDiscovery";

interface GapSelectionProps {
  selected: TeachableGap[];
  excluded: ExcludedGap[];
  className?: string;
}

export function GapSelection({ selected, excluded, className }: GapSelectionProps) {
  const refusals = exclusionRows(excluded);
  return (
    <div className={`space-y-4 ${className ?? ""}`}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-ink-3" aria-hidden="true" />
            Gaps a two-day project could close
          </CardTitle>
          <CardDescription>
            {selected.length === 0
              ? "Nothing in this job's requirements is a gap a weekend project could answer."
              : "Each of these is a requirement your confirmed evidence does not cover, and that a repository could."}
          </CardDescription>
        </CardHeader>
        {selected.length > 0 ? (
          <CardContent>
            <ul className="space-y-2">
              {selected.map((gap) => (
                <li
                  key={gap.requirementId}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-rule py-2"
                >
                  <span className="text-sm text-ink">{gap.text}</span>
                  <span className="text-xs2 text-ink-3">
                    {gap.importance} &middot; {gap.kind.replace(/_/g, " ")}
                    {gap.skillTargets.length > 0 ? ` · ${gap.skillTargets.join(", ")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ban className="h-4 w-4 text-ink-3" aria-hidden="true" />
            Gaps no project can close
          </CardTitle>
          <CardDescription>
            {refusals.length === 0
              ? "Nothing was refused: every named gap was something a project could answer."
              : "Each of these is still a gap on your match report. It is listed here because no project can close it."}
          </CardDescription>
        </CardHeader>
        {refusals.length > 0 ? (
          <CardContent>
            <ul className="space-y-2">
              {refusals.map((row, index) => (
                <li
                  key={`${row.text}-${index}`}
                  className="border-b border-rule py-2"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm text-ink">{row.text}</span>
                    <span className="text-xs2 text-ink-3">{row.label}</span>
                  </div>
                  <p className="mt-1 text-xs2 text-ink-3">{row.detail}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}

export default GapSelection;