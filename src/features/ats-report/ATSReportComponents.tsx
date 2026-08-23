import { CheckCircle2, AlertCircle, XCircle, Sparkles, TrendingUp, Lightbulb, FileText } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { IssueLevel, LLMEvaluation, LLMCategoryScore } from "@/types/ats";

const CATEGORY_LABELS: Record<string, string> = {
  parseability: "Parseability",
  keywords: "Keyword Tailoring",
  actionVerbs: "Action Verbs",
  contactInfo: "Contact Info",
  sectionCompleteness: "Section Completeness",
  experienceSignals: "Experience Signals",
};

interface ScoreCardProps {
  score: number;
  status: "excellent" | "good" | "needs-work" | "poor";
  issueCount?: number;
  matchedKeywordsCount?: number;
  missingKeywordsCount?: number;
}

const statusConfig = {
  excellent: {
    label: "Excellent",
    description: "Your resume is well-optimised for ATS systems.",
    colorClass: "text-success",
    bgClass: "bg-success/10",
  },
  good: {
    label: "Good",
    description: "Minor improvements could boost your chances.",
    colorClass: "text-success",
    bgClass: "bg-success/10",
  },
  "needs-work": {
    label: "Needs Work",
    description: "Several issues should be addressed before applying.",
    colorClass: "text-warning",
    bgClass: "bg-warning/10",
  },
  poor: {
    label: "Poor",
    description: "Significant changes are needed for better ATS compatibility.",
    colorClass: "text-destructive",
    bgClass: "bg-destructive/10",
  },
};

export function ATSScoreCard({ score, status, issueCount = 0, matchedKeywordsCount = 0, missingKeywordsCount = 0 }: ScoreCardProps) {
  const config = statusConfig[status];

  return (
    <Card className="p-6">
      <div className="flex items-start gap-6">
        {/* Score circle */}
        <div
          className={cn(
            "flex h-24 w-24 shrink-0 items-center justify-center rounded-full",
            config.bgClass
          )}
        >
          <span className={cn("text-3xl font-semibold", config.colorClass)}>
            {score}
          </span>
        </div>

        {/* Status info */}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">
              ATS Compatibility Score
            </h2>
            <span
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-medium",
                config.bgClass,
                config.colorClass
              )}
            >
              {config.label}
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {config.description}
          </p>

          {/* Quick stats */}
          <div className="mt-4 flex gap-6">
            <div>
              <span className="text-2xl font-semibold text-foreground">{issueCount}</span>
              <p className="text-xs text-muted-foreground">Issues found</p>
            </div>
            <div>
              <span className="text-2xl font-semibold text-foreground">{matchedKeywordsCount}</span>
              <p className="text-xs text-muted-foreground">Keywords matched</p>
            </div>
            <div>
              <span className="text-2xl font-semibold text-foreground">{missingKeywordsCount}</span>
              <p className="text-xs text-muted-foreground">Missing keywords</p>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

interface IssueRowProps {
  title: string;
  description: string;
  level: IssueLevel;
  suggestion?: string;
}

export function IssueRow({ title, description, level, suggestion }: IssueRowProps) {
  const icons = {
    good: <CheckCircle2 className="h-4 w-4 text-success" />,
    warning: <AlertCircle className="h-4 w-4 text-warning" />,
    issue: <XCircle className="h-4 w-4 text-destructive" />,
  };

  return (
    <div className="flex gap-3 border-b border-border py-4 last:border-0">
      <div className="mt-0.5">{icons[level]}</div>
      <div className="flex-1">
        <h4 className="font-medium text-foreground">{title}</h4>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        {suggestion && (
          <p className="mt-2 rounded-md bg-accent/50 px-3 py-2 text-sm text-foreground">
            <span className="font-medium">Suggestion:</span> {suggestion}
          </p>
        )}
      </div>
    </div>
  );
}

interface CategoryBreakdownProps {
  categories: Array<{
    name: string;
    score: number;
    maxScore: number;
    issues: Array<{
      id: string;
      title: string;
      description: string;
      level: IssueLevel;
      suggestion?: string;
    }>;
  }>;
}

export function CategoryBreakdown({ categories }: CategoryBreakdownProps) {
  return (
    <div className="space-y-4">
      {categories.map((category) => (
        <Card key={category.name} className="overflow-hidden">
          <div className="flex items-center justify-between bg-secondary/50 px-5 py-3">
            <h3 className="font-medium text-foreground">{category.name}</h3>
            <span className="text-sm text-muted-foreground">
              {category.score}/{category.maxScore}
            </span>
          </div>
          <div className="px-5">
            {category.issues.length > 0 ? (
              category.issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  title={issue.title}
                  description={issue.description}
                  level={issue.level}
                  suggestion={issue.suggestion}
                />
              ))
            ) : (
              <div className="py-4 text-sm text-muted-foreground">
                No issues found in this category.
              </div>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ==================== LLM EVALUATION REPORT ====================

function ScoreBar({ score, max }: { score: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function LLMEvaluationReport({ evaluation }: { evaluation: LLMEvaluation }) {
  const catEntries = Object.entries(evaluation.categories) as [
    keyof LLMEvaluation["categories"],
    LLMCategoryScore
  ][];

  return (
    <div className="space-y-6">
      {/* Category scores with evidence */}
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          <h3 className="font-semibold text-foreground">Detailed Category Scores</h3>
        </div>
        <div className="space-y-5">
          {catEntries.map(([key, cat]) => (
            <div key={key}>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-medium text-foreground">
                  {CATEGORY_LABELS[key] ?? key}
                </span>
                <span className="text-sm text-muted-foreground">
                  {cat.score}/{cat.max}
                </span>
              </div>
              <ScoreBar score={cat.score} max={cat.max} />
              <p className="mt-2 text-sm text-muted-foreground">{cat.evidence}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Bonus & Deductions */}
      {(evaluation.bonusPoints.total > 0 || evaluation.deductions.total > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {evaluation.bonusPoints.total > 0 && (
            <Card className="p-5">
              <div className="mb-2 flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-success" />
                <h4 className="font-medium text-foreground">
                  Bonus Points (+{evaluation.bonusPoints.total})
                </h4>
              </div>
              <p className="text-sm text-muted-foreground">{evaluation.bonusPoints.breakdown}</p>
            </Card>
          )}
          {evaluation.deductions.total > 0 && (
            <Card className="p-5">
              <div className="mb-2 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-destructive" />
                <h4 className="font-medium text-foreground">
                  Deductions (-{evaluation.deductions.total})
                </h4>
              </div>
              <p className="text-sm text-muted-foreground">{evaluation.deductions.reasons}</p>
            </Card>
          )}
        </div>
      )}

      {/* Strengths & Improvements */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <h4 className="font-medium text-foreground">Key Strengths</h4>
          </div>
          <ul className="space-y-2">
            {evaluation.keyStrengths.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-warning" />
            <h4 className="font-medium text-foreground">Areas for Improvement</h4>
          </div>
          <ul className="space-y-2">
            {evaluation.areasForImprovement.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Reasoning */}
      <Card className="p-5">
        <div className="mb-2 flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          <h4 className="font-medium text-foreground">Evaluator Reasoning</h4>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{evaluation.reasoning}</p>
      </Card>
    </div>
  );
}
