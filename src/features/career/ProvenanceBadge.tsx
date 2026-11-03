// Provenance badge: WHERE a claim came from (T1020, 06 E.11 flow 3).
//
// Distinct from `StatusBadge` on purpose. Provenance answers "where did this text come
// from" and status answers "have you vouched for it"; conflating them is how a document
// extraction ends up looking like something the user said. A claim that was extracted from
// a file and then confirmed is BOTH "from a document" AND "confirmed", and both badges say
// so.
//
// ICON + TEXT again, for the same accessibility reason as the status badge - and here it
// is load-bearing in a second way: the four document-ish provenances (document, model,
// repo, out-of-band) are all "not written by the user", and a colour-only treatment
// would leave a colour-blind user unable to tell their own words from a model's.

import { Badge } from "@/components/ui/badge";
import {
  BadgeCheck,
  FileText,
  GitBranch,
  HelpCircle,
  Layers,
  Sparkles,
  User,
  type LucideIcon,
} from "lucide-react";
import {
  provenancePresentation,
  type ProvenancePresentation,
} from "./claimPresentation";

const ICONS: Record<ProvenancePresentation["icon"], LucideIcon> = {
  user: User,
  "file-text": FileText,
  sparkles: Sparkles,
  "git-branch": GitBranch,
  "badge-check": BadgeCheck,
  layers: Layers,
  "help-circle": HelpCircle,
};

/** Neutral styling for every provenance: provenance carries no urgency, status does. */
const CLASS = "gap-1 border-rule bg-muted/60 text-ink-3";

interface ProvenanceBadgeProps {
  provenance: string | null | undefined;
  className?: string;
}

export function ProvenanceBadge({ provenance, className }: ProvenanceBadgeProps) {
  const presentation = provenancePresentation(provenance);
  const Icon = ICONS[presentation.icon] ?? HelpCircle;
  return (
    <Badge variant="outline" className={`${CLASS} ${className ?? ""}`} title={presentation.description}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {presentation.label}
    </Badge>
  );
}

export default ProvenanceBadge;
