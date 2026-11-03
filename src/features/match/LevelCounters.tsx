// The four counters (T1070, 06 sec. E.6 / E.11 flow 7).
//
// FOUR PLAIN INTEGERS. Not a score, not a ring, not a progress bar, not "7 of 16" - E.6
// forbids a derived single number and this component has no arithmetic at all: it renders
// `counts[level]` exactly as the server counted it, plus a label and an icon.
//
// The visual language is the accessibility requirement, not decoration: each counter names
// its bucket in text beside an icon, so the four states are distinguishable without colour,
// and the `gap` counter's tone is neutral rather than red - a gap is an honest list of names,
// not a failure the user committed.

import { Card, CardContent } from "@/components/ui/card";
import { BadgeCheck, CircleSlash, HelpCircle, Sparkles, type LucideIcon } from "lucide-react";
import { counterHint, levelCounters, type LevelTone } from "./matchPresentation";
import type { MatchCounts } from "@/services/api/match";

const ICONS: Record<ReturnType<typeof levelCounters>[number]["level"], LucideIcon> = {
  direct: BadgeCheck,
  contextual: Sparkles,
  potential: Sparkles,
  unsupported: CircleSlash,
};

const TONE_CLASS: Record<LevelTone, string> = {
  confirmed: "text-[hsl(var(--status-confirmed))]",
  pending: "text-[hsl(var(--status-inferred))]",
  gap: "text-[hsl(var(--status-draft))]",
};

interface LevelCountersProps {
  counts: MatchCounts;
  className?: string;
}

export function LevelCounters({ counts, className }: LevelCountersProps) {
  const counters = levelCounters(counts);
  return (
    <dl className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-4 ${className ?? ""}`}>
      {counters.map((counter) => {
        const Icon = ICONS[counter.level] ?? HelpCircle;
        const hint = counterHint(counts, counter.level);
        return (
          <Card key={counter.level} className="p-4">
            <CardContent className="space-y-1 p-0">
              <dt className="flex items-center gap-1.5 text-xs2 font-medium text-ink-3">
                <Icon
                  className={`h-3.5 w-3.5 ${TONE_CLASS[counter.tone]}`}
                  aria-hidden="true"
                />
                {counter.label}
              </dt>
              {/* The integer, exactly as counted. `tabular-nums` so four numbers line up
                  without the layout implying a proportion. */}
              <dd className="text-2xl font-semibold tabular-nums text-ink">{counter.value}</dd>
              {hint ? <p className="text-xs2 text-ink-3">{hint}</p> : null}
            </CardContent>
          </Card>
        );
      })}
    </dl>
  );
}

export default LevelCounters;
