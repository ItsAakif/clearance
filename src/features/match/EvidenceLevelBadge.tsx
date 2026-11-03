// Evidence-level badge: which of the four buckets a requirement is in (T1070, 06 E.11
// flow 7).
//
// DOT + TEXT, NEVER COLOUR ALONE, for the same accessibility reason as
// `features/career/StatusBadge.tsx` - and here it is load-bearing in a second way: two of
// the four levels are PROPOSALS and two are facts. A colour-only treatment would leave a
// colour-blind user unable to tell an inference from experience, which is the exact
// confusion this feature exists to prevent.
//
// The label and tone all come from `matchPresentation.ts`, so the rule is asserted in
// `matchPresentation.test.ts` rather than trusted to this file's markup, and the Tailwind
// classes below are the ONLY place a level becomes a colour.

import { Badge } from "@/components/ui/badge";
import { levelPresentation, type LevelTone } from "./matchPresentation";

/**
 * TONE -> CLASS. A tone is a NAME, so a new level cannot arrive with a colour and no name:
 * it arrives as a tone, and an unmapped tone falls back to the gap styling - which is the
 * fail-closed direction, because "looks like a gap" keeps an unrecognised inference out of
 * a resume.
 */
const TONE_CLASS: Record<LevelTone, string> = {
  confirmed: "text-[hsl(var(--status-confirmed))]",
  pending: "text-[hsl(var(--status-inferred))]",
  gap: "text-[hsl(var(--status-draft))]",
};

interface EvidenceLevelBadgeProps {
  level: string | null | undefined;
  className?: string;
}

export function EvidenceLevelBadge({ level, className }: EvidenceLevelBadgeProps) {
  const presentation = levelPresentation(level);
  return (
    <Badge
      variant="outline"
      className={`gap-1.5 ${TONE_CLASS[presentation.tone]} ${className ?? ""}`}
      title={presentation.description}
    >
      {presentation.label}
    </Badge>
  );
}

export default EvidenceLevelBadge;
