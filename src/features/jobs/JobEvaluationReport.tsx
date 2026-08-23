import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ShieldAlert, CheckCircle2, AlertTriangle } from "lucide-react";
import type { JobEvaluation } from "@/services/api";

interface Props {
  evaluation: JobEvaluation;
}

const SCORE_LABELS: Record<string, string> = {
  cvMatch: "CV Match",
  levelFit: "Level Fit",
  compFit: "Comp Fit",
  personalization: "Personalization",
  interviewPrep: "Interview Prep",
  legitimacy: "Legitimacy",
};

function scoreColor(v: number) {
  if (v >= 4) return "bg-success";
  if (v >= 3) return "bg-primary";
  if (v >= 2) return "bg-warning";
  return "bg-destructive";
}

export function JobEvaluationReport({ evaluation }: Props) {
  const rec = evaluation.recommendation;
  const recBadge =
    rec === "apply" ? <Badge className="bg-success/10 text-success">Apply</Badge>
      : rec === "maybe" ? <Badge className="bg-warning/10 text-warning">Maybe</Badge>
        : <Badge className="bg-destructive/10 text-destructive">Skip</Badge>;

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-3xl font-bold text-foreground">{evaluation.overallScore.toFixed(1)}</span>
          <span className="text-sm text-muted-foreground">/ 5.0 overall</span>
          {recBadge}
        </div>
        {evaluation.isScam && (
          <Badge variant="destructive" className="gap-1">
            <ShieldAlert className="h-3.5 w-3.5" /> Likely scam / ghost job
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Object.entries(SCORE_LABELS).map(([key, label]) => {
          const v = (evaluation.scores as any)[key] ?? 0;
          return (
            <div key={key}>
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{v.toFixed(1)}</span>
              </div>
              <Progress value={(v / 5) * 100} className={`h-2 [&>div]:${scoreColor(v)}`} />
            </div>
          );
        })}
      </div>

      {evaluation.roleSummary && (
        <Card className="p-4">
          <h4 className="mb-1 text-sm font-semibold text-foreground">Role Summary</h4>
          <p className="text-sm text-muted-foreground">{evaluation.roleSummary}</p>
        </Card>
      )}

      {Array.isArray((evaluation.reportJson as any)?.interviewPrepBullets) && (
        <Card className="p-4">
          <h4 className="mb-2 flex items-center gap-1 text-sm font-semibold text-foreground">
            <CheckCircle2 className="h-4 w-4 text-primary" /> Interview Prep (STAR+R)
          </h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {((evaluation.reportJson as any).interviewPrepBullets as string[]).map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </Card>
      )}

      {Array.isArray((evaluation.reportJson as any)?.redFlags) && ((evaluation.reportJson as any).redFlags as string[]).length > 0 && (
        <Card className="border-warning/40 p-4">
          <h4 className="mb-2 flex items-center gap-1 text-sm font-semibold text-warning">
            <AlertTriangle className="h-4 w-4" /> Red Flags
          </h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {((evaluation.reportJson as any).redFlags as string[]).map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
