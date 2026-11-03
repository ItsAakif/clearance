// The four integer counts (T1100, 06 sec. E.6 / E.11).
//
// FOUR PLAIN INTEGERS over named things. Not a total, not a proportion, not a progress bar: E.6
// forbids a derived single number and this component has no arithmetic at all - it renders
// `counts[label]` exactly as the server counted it, beside a label that says what the number
// counts.
//
// THE TONE IS NEUTRAL. A gap is an accurate description of evidence, not a failure the user
// committed, so the "no project can close these" row uses the same muted treatment as the rest
// rather than the red the retired score surfaces used.

import { Card, CardContent } from "@/components/ui/card";
import { CircleSlash, Hammer, ListChecks, Target } from "lucide-react";
import { countsRows } from "./projectPresentation";
import type { ProjectDiscoveryCounts } from "@/services/api/projectDiscovery";

const ICONS = [ListChecks, Target, CircleSlash, Hammer] as const;

interface RunCountsProps {
  counts: ProjectDiscoveryCounts;
  className?: string;
}

export function RunCounts({ counts, className }: RunCountsProps) {
  const rows = countsRows(counts);
  return (
    <dl className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-4 ${className ?? ""}`}>
      {rows.map((row, index) => {
        const Icon = ICONS[index] ?? ListChecks;
        return (
          <Card key={row.label} className="p-4">
            <CardContent className="space-y-1 p-0">
              <dt className="flex items-center gap-1.5 text-xs2 font-medium text-ink-3">
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {row.label}
              </dt>
              {/* The integer, exactly as counted. `tabular-nums` so four numbers line up
                  without the layout implying a proportion between them. */}
              <dd className="text-2xl font-semibold tabular-nums text-ink">{row.value}</dd>
            </CardContent>
          </Card>
        );
      })}
    </dl>
  );
}

export default RunCounts;