import { CheckCircle2, XCircle, Lightbulb, AlertTriangle, Sparkles, ArrowRight, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface MatchResultsProps {
  matchScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  suggestions: string[];
  detectedRole?: string | null;
  criticalMissing?: string[];
  preferredMissing?: string[];
  roleSuggestions?: string[];
  tailoringTips?: string[];
  onBuildTailored?: () => void;
  isBuilding?: boolean;
}

function labelRole(roleKey?: string | null): string {
  if (!roleKey) return "";
  return roleKey
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function JobMatchResults({
  matchScore,
  matchedKeywords,
  missingKeywords,
  suggestions,
  detectedRole,
  criticalMissing = [],
  preferredMissing = [],
  roleSuggestions = [],
  tailoringTips = [],
  onBuildTailored,
  isBuilding = false,
}: MatchResultsProps) {
  return (
    <div className="space-y-6">
      {onBuildTailored && (
        <Card className="flex flex-col items-start justify-between gap-3 p-5 sm:flex-row sm:items-center">
          <div>
            <h3 className="font-semibold text-foreground">Turn this into a tailored resume</h3>
            <p className="text-sm text-muted-foreground">
              Open the builder pre-loaded with this job's critical and preferred skills.
            </p>
          </div>
          <Button onClick={onBuildTailored} className="shrink-0 gap-2" disabled={isBuilding}>
            {isBuilding ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Building...
              </>
            ) : (
              <>
                Build Tailored Resume
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </Card>
      )}

      {/* Match Score */}
      <Card className="p-6">
        <div className="flex items-center gap-6">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-accent">
            <span className="text-2xl font-semibold text-foreground">
              {matchScore}%
            </span>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              Job Match Score
            </h3>
            <p className="text-sm text-muted-foreground">
              {matchScore >= 80
                ? "Excellent match! Your resume aligns well with this role."
                : matchScore >= 60
                ? "Good match. A few additions could strengthen your application."
                : "Some gaps exist. Consider tailoring your resume for this role."}
            </p>
            {detectedRole && (
              <p className="mt-1 text-xs text-muted-foreground">
                Detected role: {labelRole(detectedRole)}
              </p>
            )}
          </div>
        </div>
      </Card>

      {/* Critical missing (hard requirements) */}
      {criticalMissing.length > 0 && (
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <h3 className="font-semibold text-foreground">
              Critical Missing Skills ({criticalMissing.length})
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {criticalMissing.map((keyword) => (
              <Badge
                key={keyword}
                variant="secondary"
                className="bg-destructive/10 text-destructive"
              >
                {keyword}
              </Badge>
            ))}
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            These are hard requirements in the job description that are absent from
            your resume. Add them (with evidence) to pass ATS screening.
          </p>
        </Card>
      )}

      {/* Preferred missing (nice-to-have) */}
      {preferredMissing.length > 0 && (
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-warning" />
            <h3 className="font-semibold text-foreground">
              Preferred Skills ({preferredMissing.length})
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {preferredMissing.map((keyword) => (
              <Badge
                key={keyword}
                variant="secondary"
                className="bg-warning/10 text-warning"
              >
                {keyword}
              </Badge>
            ))}
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Nice-to-have skills. Including them can give you an edge but they are
            not strict requirements.
          </p>
        </Card>
      )}

      {/* Matched Keywords */}
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <h3 className="font-semibold text-foreground">
            Matched Keywords ({matchedKeywords.length})
          </h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {matchedKeywords.map((keyword) => (
            <Badge
              key={keyword}
              variant="secondary"
              className="bg-success/10 text-success"
            >
              {keyword}
            </Badge>
          ))}
        </div>
      </Card>

      {/* Missing Keywords (all unmatched job terms) */}
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <XCircle className="h-5 w-5 text-muted-foreground" />
          <h3 className="font-semibold text-foreground">
            Other Missing Keywords ({missingKeywords.length})
          </h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {missingKeywords.map((keyword) => (
            <Badge
              key={keyword}
              variant="secondary"
              className="bg-accent text-muted-foreground"
            >
              {keyword}
            </Badge>
          ))}
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Additional terms from the job description not found in your resume.
        </p>
      </Card>

      {/* Role suggestions (candidate has but job omitted) */}
      {roleSuggestions.length > 0 && (
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-foreground">
              Your Strengths For This Role
            </h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {roleSuggestions.map((keyword) => (
              <Badge
                key={keyword}
                variant="secondary"
                className="bg-primary/10 text-primary"
              >
                {keyword}
              </Badge>
            ))}
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Skills you already have that are valued for this role (the job posting
            may not list them explicitly).
          </p>
        </Card>
      )}

      {/* LLM tailoring tips */}
      {tailoringTips.length > 0 && (
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h3 className="font-semibold text-foreground">Tailoring Tips</h3>
          </div>
          <ul className="space-y-3">
            {tailoringTips.map((tip, index) => (
              <li key={index} className="flex gap-3 text-sm">
                <span className="shrink-0 text-muted-foreground">{index + 1}.</span>
                <span className="text-foreground">{tip}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Suggestions */}
      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <Lightbulb className="h-5 w-5 text-accent-emphasis" />
          <h3 className="font-semibold text-foreground">Suggestions</h3>
        </div>
        <ul className="space-y-3">
          {suggestions.map((suggestion, index) => (
            <li key={index} className="flex gap-3 text-sm">
              <span className="shrink-0 text-muted-foreground">{index + 1}.</span>
              <span className="text-foreground">{suggestion}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
