// Severity badge for a derived interview risk (T1090, 06 sec. E.11 flow 8).
//
// DOT + TEXT, NEVER COLOUR ALONE, for the same accessibility reason as
// `features/match/EvidenceLevelBadge.tsx` - and here it is load-bearing in a second way. The
// three severities are not styling preferences: `high` means an interviewer is likely to catch
// the user out, and a colour-blind user has to be able to read that difference from the screen.
// A colour-only treatment would make `high` and `low` the same thing to someone who cannot
// separate the tones.
//
// TONE -> CLASS, and the mapping is a RECORD OVER THE THREE PRESENTATION TONES, so a fourth
// tone cannot arrive with a colour and no name. An unmapped tone falls back to the URGENT
// styling - the fail-closed direction, because an unrecognised severity must not look
// reassuring. The label and tone all come from `riskPresentation.ts`, so the rule is
// asserted in `riskPresentation.test.ts` rather than trusted to this file's markup, and the
// Tailwind classes below are the ONLY place a severity becomes a colour.

import { Badge } from "@/components/ui/badge";
import { severityPresentation, type SeverityTone } from "./riskPresentation";

const TONE_CLASS: Record<SeverityTone, string> = {
  urgent: "text-[hsl(var(--status-rejected))]",
  attention: "text-[hsl(var(--status-offer))]",
  neutral: "text-[hsl(var(--status-draft))]",
};

interface RiskSeverityBadgeProps {
  severity: string | null | undefined;
  className?: string;
}

export function RiskSeverityBadge({ severity, className }: RiskSeverityBadgeProps) {
  const presentation = severityPresentation(severity);
  return (
    <Badge
      variant="outline"
      className={`gap-1.5 ${TONE_CLASS[presentation.tone]} ${className ?? ""}`}
      title={presentation.description}
    >
      {presentation.label} severity
    </Badge>
  );
}

export default RiskSeverityBadge;
