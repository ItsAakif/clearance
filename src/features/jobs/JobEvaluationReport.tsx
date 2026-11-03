// T1101: the six-dimension 0-5 rubric and the `/ 5.0 overall` figure are GONE.
//
// 06 sec. E.6: "No universal score, no single number, no grade." A `4.2 / 5.0` is a single number with
// a grade implied by its colour, and six `{v.toFixed(1)}` bars are the same verdict at six grains.
// What is LEFT is the part of the evaluation that is categorical or prose and can be acted on
// without arithmetic:
//
//   - the RECOMMENDATION (`apply` / `maybe` / `skip`) - a decision the evaluator made, not a
//     number the reader has to interpret;
//   - the SCAM flag, which is a yes/no fact about the listing;
//   - the role summary, the interview-prep bullets and the red flags - all sentences.
//
// The numbers are still COMPUTED and still STORED (`JobEvaluation.overallScore` is what
// `minMatchScore` filters and sorts on, and 07 sec. F.5 freezes job discovery). Nothing presents
// them. `src/noDerivedScore.test.ts` fails if one comes back onto a screen.
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, CheckCircle2, AlertTriangle } from "lucide-react";
import type { JobEvaluation } from "@/services/api";

interface Props {
  evaluation: JobEvaluation;
}

export function JobEvaluationReport({ evaluation }: Props) {
  const rec = evaluation.recommendation;
  const recBadge =
    rec === "apply" ? <Badge className="text-success">Apply</Badge>
      : rec === "maybe" ? <Badge className="text-warning">Maybe</Badge>
        : <Badge className="text-destructive">Skip</Badge>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          {recBadge}
          <span className="text-xs text-ink-3">
            Recommendation from the job evaluation
          </span>
        </div>
        {evaluation.isScam && (
          <Badge variant="destructive" className="gap-1">
            <ShieldAlert className="h-3.5 w-3.5" /> Likely scam / ghost job
          </Badge>
        )}
      </div>

      {evaluation.roleSummary && (
        <section className="border-t border-rule pt-3">
          <h4 className="section-label">Role summary</h4>
          <p className="mt-1 text-sm text-ink-2">{evaluation.roleSummary}</p>
        </section>
      )}

      {Array.isArray((evaluation.reportJson as any)?.interviewPrepBullets) && (
        <section className="border-t border-rule pt-3">
          <h4 className="section-label flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" /> Interview prep (STAR+R)
          </h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
            {((evaluation.reportJson as any).interviewPrepBullets as string[]).map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </section>
      )}

      {Array.isArray((evaluation.reportJson as any)?.redFlags) && ((evaluation.reportJson as any).redFlags as string[]).length > 0 && (
        <section className="border-t border-rule pt-3">
          <h4 className="section-label flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" /> Red flags
          </h4>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
            {((evaluation.reportJson as any).redFlags as string[]).map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
