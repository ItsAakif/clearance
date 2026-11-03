// The derived risk list (T1090; 06 sec. E.11 flow 8).
//
// A LIST OF DERIVED RISKS, EACH WITH THE ROWS IT CAME FROM. 06 sec. E.11 flow 8 asks for
// "kind + severity + statement + the evidence it is grounded in", and the last of those is the
// part that matters: a risk a user cannot trace back to a row of their own data is an assertion,
// and this feature exists to replace assertions with derivations.
//
// TWO THINGS THIS COMPONENT REFUSES TO RENDER, both of them the client's half of acceptance
// item 1:
//   1. A risk with NO ANCHORS. `isAttributable` is checked here rather than trusted to the
//      server, so a payload that skipped the server's own invariant produces a visible refusal
//      row ("we could not attribute this") instead of an unattributable warning box. The server
//      asserts the same invariant on the way out; the two layers agreeing is the point.
//   2. A risk whose SEVERITY or KIND this build does not know, presented as anything other than
//      alarming. `riskPresentation` fails closed for both, and the badge says so.
//
// THE ANCHORS ARE SHOWN AS SENTENCES, not as ids. A `resume_change:chg-7` id is the audit trail
// and belongs in the DOM for a reviewer; "an accepted rewrite, which introduces a fact the
// before-state did not have" is what a person can act on. Both are rendered: the sentence for
// the reader, the id in a `title` for the reviewer.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FilePlus, FileQuestion, Link2, PencilLine, Sparkles, TrendingUp } from "lucide-react";
import { RiskSeverityBadge } from "./RiskSeverityBadge";
import { anchorSentence, isAttributable, riskKindPresentation } from "./riskPresentation";
import type { InterviewRisk } from "@/services/api/interview";

const KIND_ICONS: Record<ReturnType<typeof riskKindPresentation>["icon"], typeof FilePlus> = {
  "file-plus": FilePlus,
  "triangle-alert": Sparkles,
  sparkles: Sparkles,
  "pencil-line": PencilLine,
  "circle-slash": Link2,
  "trending-up": TrendingUp,
  "file-question": FileQuestion,
};

interface RiskListProps {
  risks: InterviewRisk[];
  className?: string;
}

export function RiskList({ risks, className }: RiskListProps) {
  if (risks.length === 0) return null;

  return (
    <section className="space-y-3" aria-label="Derived interview risks">
      <h2 className="section-title">
        Risks derived from this resume ({risks.length})
      </h2>
      <ul className="space-y-3">
        {risks.map((risk) => {
          const kind = riskKindPresentation(risk.kind);
          const Icon = KIND_ICONS[kind.icon] ?? Sparkles;
          const attributable = isAttributable(risk.anchors);

          return (
            <li key={risk.key}>
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <Icon className="h-4 w-4 text-ink-3" aria-hidden="true" />
                    {kind.label}
                    <RiskSeverityBadge severity={risk.severity} />
                  </CardTitle>
                  <CardDescription>{kind.description}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-ink">{risk.statement}</p>

                  <div className="border-l-2 border-rule pl-3">
                    <p className="mb-1 text-xs2 font-medium text-ink-3">
                      What this is based on
                    </p>
                    {attributable ? (
                      <ul className="space-y-1">
                        {risk.anchors.map((anchor) => (
                          <li
                            key={`${anchor.source}:${anchor.id}:${anchor.detail}`}
                            className="flex items-start gap-1.5 text-xs2 text-ink-3"
                            title={`${anchor.source}:${anchor.id}`}
                          >
                            <Link2 className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                            <span>{anchorSentence(anchor)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      // The refusal row. It says what is WRONG rather than hiding the card, so a
                      // user who is told "3 risks" is never silently shown an unattributable one.
                      <p className="text-xs2 text-destructive">
                        This risk names no row it was derived from, so we are not showing it as
                        something we found in your evidence.
                      </p>
                    )}
                  </div>

                  <p className="text-xs2 text-ink-3">
                    <span className="font-medium text-ink">Likely probe: </span>
                    {risk.focus}
                  </p>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default RiskList;