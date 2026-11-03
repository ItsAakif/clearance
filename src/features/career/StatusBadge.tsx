// Career claim status badge (T1020).
//
// DOT + TEXT, NEVER COLOUR ALONE (06 E.11 "unconfirmed vs confirmed"). The label and the
// tone both come from `claimPresentation.ts`, so the rule is asserted in a unit test
// rather than trusted to this file's markup; the Tailwind classes below are the ONLY place
// a status becomes a colour, which is what makes it possible to check that nothing here
// conveys state through colour on its own. The surface stays neutral - status is a flat dot
// and a word, never a tinted box.

import { Badge } from "@/components/ui/badge";
import {
  statusPresentation,
  type StatusPresentation,
  type StatusTone,
} from "./claimPresentation";

/**
 * TONE -> CLASS. A tone is a NAME, so a new status cannot arrive with a colour and no
 * name: it arrives as a tone, and an unmapped tone falls back to the pending styling -
 * which is the fail-closed direction, because "looks pending" keeps an unverified claim
 * out of a rendered resume.
 */
const TONE_CLASS: Record<StatusTone, string> = {
  confirmed: "text-[hsl(var(--status-confirmed))]",
  pending: "text-[hsl(var(--status-inferred))]",
  decided: "text-[hsl(var(--status-draft))]",
};

interface StatusBadgeProps {
  status: string | null | undefined;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const presentation: StatusPresentation = statusPresentation(status);
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

export default StatusBadge;
