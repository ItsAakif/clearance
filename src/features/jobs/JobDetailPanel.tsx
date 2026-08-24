import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { jobsApi } from "@/services/api";
import type { JobListingSummary, JobEvaluation } from "@/services/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, ArrowRight, Loader2, Bookmark, FileSearch, Briefcase, ExternalLink,
  RefreshCw, ClipboardList, AlertCircle,
} from "lucide-react";
import { useResumes } from "@/hooks/useResumeApi";
import { useEvaluateJob, useCreateApplication, useUpdateApplication, useApplications } from "@/hooks/useJobs";
import { useToast } from "@/hooks/use-toast";
import { normalizeJobInsights, getPostedLabel } from "@/features/jobs/jobSearchUtils";
import { JobEvaluationReport } from "@/features/jobs/JobEvaluationReport";
import { TailorPanel } from "@/features/jobs/TailorPanel";

interface JobDetailPanelProps {
  jobId?: string;
  job?: JobListingSummary;
  onBack?: () => void;
  onSelectAdjacent?: (direction: 'next' | 'previous') => void;
}

export function JobDetailPanel({ jobId, job: initialJob, onBack, onSelectAdjacent }: JobDetailPanelProps) {
  const { data: resumes = [], isLoading: loadingResumes } = useResumes();
  const { data: applications = [] } = useApplications();
  const navigate = useNavigate();
  const evaluate = useEvaluateJob();
  const createApp = useCreateApplication();
  const updateApp = useUpdateApplication();
  const { toast } = useToast();

  const [selectedResumeId, setSelectedResumeId] = useState("");
  const [localEvaluation, setLocalEvaluation] = useState<JobEvaluation | null>(null);
  const [evaluationJobId, setEvaluationJobId] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['jobs', 'detail', jobId],
    queryFn: () => jobsApi.get(jobId!),
    enabled: !!jobId,
  });

  const detail = detailQuery.data ?? initialJob ?? null;
  const description = detail?.description ?? null;

  const existingApplication = jobId
    ? applications.find((a) => a.jobListing?.id === jobId || (a as any).jobListingId === jobId)
    : undefined;

  const saved = !!existingApplication;
  const savePending = createApp.isPending || updateApp.isPending;

  const handleSave = useCallback(async () => {
    if (!jobId) return;
    if (existingApplication) {
      updateApp.mutate({ id: existingApplication.id, status: 'saved' });
      return;
    }
    createApp.mutate({ jobListingId: jobId, status: 'saved' });
  }, [jobId, existingApplication, createApp, updateApp]);

  const handleAnalyse = useCallback(async () => {
    if (!jobId || !description) return;
    if (resumes.length === 0) {
      toast({ title: 'Create a resume first', variant: 'destructive' });
      return;
    }
    if (!selectedResumeId) {
      toast({ title: 'Select a resume first', variant: 'destructive' });
      return;
    }
    try {
      const result = await evaluate.mutateAsync({ jobId, resumeId: selectedResumeId, jobDescription: description });
      setLocalEvaluation(result);
      setEvaluationJobId(jobId);
    } catch {
      // error already toasted
    }
  }, [jobId, description, resumes, selectedResumeId, evaluate, toast]);

  const currentEvaluation = evaluationJobId === jobId ? localEvaluation : undefined;
  const insights = normalizeJobInsights(currentEvaluation ?? null);

  const handleTrack = useCallback(async () => {
    if (!jobId) return;
    if (existingApplication) {
      navigate('/app/applications');
      return;
    }
    try {
      const app = await createApp.mutateAsync({ jobListingId: jobId, status: 'saved' });
      navigate('/app/applications');
    } catch {
      // error already toasted
    }
  }, [jobId, existingApplication, createApp, navigate]);

  if (!jobId) {
    return (
      <section aria-labelledby="jd-empty" className="flex h-full flex-col items-center justify-center text-center text-muted-foreground p-6">
        <FileSearch className="mb-3 h-10 w-10 opacity-40" />
        <p id="jd-empty" className="text-sm">Select a job to see its description, analysis, and actions.</p>
      </section>
    );
  }

  if (detailQuery.isLoading) {
    return (
      <section aria-label="Job detail" className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden">
        <div className="p-4 space-y-4">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </section>
    );
  }

  if (detailQuery.isError || (!detail && !initialJob)) {
    return (
      <section aria-label="Job detail" className="flex h-full min-w-0 flex-col items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-sm">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between gap-2">
            <span>Failed to load job details.</span>
            <Button variant="outline" size="sm" onClick={() => detailQuery.refetch()} className="gap-1 shrink-0">
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const title = detail?.title ?? initialJob?.title ?? 'Job';
  const company = detail?.company ?? initialJob?.company ?? '';
  const location = detail?.location ?? initialJob?.location;
  const source = detail?.source ?? initialJob?.source ?? '';
  const posted = detail?.postedAt ? getPostedLabel(detail.postedAt) : (initialJob?.postedAt ? getPostedLabel(initialJob.postedAt) : 'Date unavailable');
  const applyUrl = detail?.applyUrl ?? initialJob?.applyUrl;
  const hasEvaluation = !!currentEvaluation;

  return (
    <section aria-labelledby="jd-heading" className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden">
      <div className="sticky top-0 z-10 border-b border-border bg-card/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {onBack && (
              <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to job list" className="shrink-0">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <div className="min-w-0">
              <h2 id="jd-heading" className="truncate text-sm font-semibold text-foreground">{title}</h2>
              <p className="truncate text-xs text-muted-foreground">
                {company}{location ? ` · ${location}` : ''} · {source}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant={saved ? "secondary" : "ghost"}
              size="icon"
              className="h-9 w-9"
              onClick={handleSave}
              disabled={savePending}
              aria-label={saved ? "Remove from saved" : "Save job"}
              aria-pressed={saved}
              aria-busy={savePending}
            >
              <Bookmark className={`h-4 w-4 ${saved ? "fill-current" : ""}`} />
            </Button>
            {onSelectAdjacent && (
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => onSelectAdjacent('previous')} aria-label="Previous job">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            {onSelectAdjacent && (
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => onSelectAdjacent('next')} aria-label="Next job">
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-5 p-4">
        {evaluate.isError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Evaluation failed. You may need to add your own LLM key in Settings (BYOK).
            </AlertDescription>
          </Alert>
        )}

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold text-foreground">Job Description</h3>
          <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {description || 'No description available.'}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {posted}</span>
            {applyUrl && (
              <a href={applyUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
                <ExternalLink className="h-3 w-3" /> Open Original
              </a>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">Match Score</h3>
          {hasEvaluation ? (
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-foreground">{currentEvaluation.overallScore.toFixed(1)}</span>
              <span className="text-sm text-muted-foreground">/ 5.0 overall</span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Not analysed</p>
          )}

          {insights.breakdown.skills !== undefined || insights.breakdown.experience !== undefined || insights.breakdown.keywords !== undefined || insights.breakdown.seniority !== undefined ? (
            <div className="mt-3 space-y-2">
              {insights.breakdown.skills !== undefined && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Skills</span>
                    <span className="font-medium">{insights.breakdown.skills}%</span>
                  </div>
                  <Progress value={insights.breakdown.skills} className="h-1.5" />
                </div>
              )}
              {insights.breakdown.experience !== undefined && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Experience</span>
                    <span className="font-medium">{insights.breakdown.experience}%</span>
                  </div>
                  <Progress value={insights.breakdown.experience} className="h-1.5" />
                </div>
              )}
              {insights.breakdown.keywords !== undefined && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Keywords</span>
                    <span className="font-medium">{insights.breakdown.keywords}%</span>
                  </div>
                  <Progress value={insights.breakdown.keywords} className="h-1.5" />
                </div>
              )}
              {insights.breakdown.seniority !== undefined && (
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Seniority</span>
                    <span className="font-medium">{insights.breakdown.seniority}%</span>
                  </div>
                  <Progress value={insights.breakdown.seniority} className="h-1.5" />
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Breakdown is not available yet</p>
          )}
        </Card>

        {insights.skillGaps.length > 0 ? (
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Skill Gaps</h3>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {insights.skillGaps.map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          </Card>
        ) : hasEvaluation && (
          <Card className="p-4">
            <h3 className="mb-1 text-sm font-semibold text-foreground">Skill Gaps</h3>
            <p className="text-xs text-muted-foreground">No skill gaps identified.</p>
          </Card>
        )}

        {insights.evaluationResults.length > 0 && (
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Evaluation Results</h3>
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {insights.evaluationResults.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </Card>
        )}

        {hasEvaluation && currentEvaluation && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Full Evaluation Report</h3>
            <JobEvaluationReport evaluation={currentEvaluation} />
          </div>
        )}

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-foreground">Actions</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleSave}
              disabled={savePending || !jobId}
              variant={saved ? "secondary" : "default"}
              size="sm"
            >
              {saved ? 'Saved' : 'Save'}
            </Button>

            {resumes.length === 0 ? (
              <Button variant="outline" size="sm" onClick={() => navigate('/app/resumes')}>
                Create a resume first
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Select value={selectedResumeId} onValueChange={setSelectedResumeId}>
                  <SelectTrigger className="h-9 w-auto text-xs" aria-label="Select resume">
                    <SelectValue placeholder="Select resume" />
                  </SelectTrigger>
                  <SelectContent>
                    {resumes.map((r) => (
                      <SelectItem key={r.id} value={r.id} className="text-xs">{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  onClick={handleAnalyse}
                  disabled={!selectedResumeId || evaluate.isPending}
                  size="sm"
                  data-analyse-btn
                >
                  {evaluate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSearch className="mr-2 h-4 w-4" />}
                  Analyse
                </Button>
              </div>
            )}

            {hasEvaluation && selectedResumeId && (
              <div className="w-full">
                <TailorPanel
                  jobId={jobId}
                  resumeId={selectedResumeId}
                  evaluationId={currentEvaluation.id}
                  jobDescription={description ?? undefined}
                />
              </div>
            )}

            <Button variant="outline" size="sm" onClick={handleTrack} disabled={savePending}>
              <ClipboardList className="mr-2 h-4 w-4" /> Track Application
            </Button>

            {applyUrl ? (
              <Button variant="outline" size="sm" asChild>
                <a href={applyUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="mr-2 h-4 w-4" /> Open Original
                </a>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled>
                <ExternalLink className="mr-2 h-4 w-4" /> No URL
              </Button>
            )}
          </div>
        </Card>
      </div>
    </section>
  );
}
