import { useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, Link } from "react-router-dom";
import { jobsApi, readEvaluateError } from "@/services/api";
import type { JobListingSummary, JobEvaluation } from "@/services/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft, ArrowRight, Loader2, Bookmark, FileSearch, ExternalLink,
  RefreshCw, ClipboardList, AlertCircle, Clock,
} from "lucide-react";
import { useResumes } from "@/hooks/useResumeApi";
import { useEvaluateJob, useCreateApplication, useUpdateApplication, useApplications } from "@/hooks/useJobs";
import { useToast } from "@/hooks/use-toast";
import { normalizeJobInsights, getPostedLabel } from "@/features/jobs/jobSearchUtils";
import { sourceBadges, dateLabelFor } from "@/features/jobs/provenanceLabel";
import { MarkdownText } from "@/features/jobs/MarkdownText";
import { JobEvaluationReport } from "@/features/jobs/JobEvaluationReport";
import { Scissors } from "lucide-react";

interface JobDetailPanelProps {
  jobId?: string;
  job?: JobListingSummary;
  ghost?: { level: 'clear' | 'watch'; evidence: string[] };
  onBack?: () => void;
  onSelectAdjacent?: (direction: 'next' | 'previous') => void;
}

export function JobDetailPanel({ jobId, job: initialJob, ghost: ghostProp, onBack, onSelectAdjacent }: JobDetailPanelProps) {
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

  // Auto-select the first resume once the list loads so Analyse is not a
  // dead control. The manual Select still overrides this choice.
  useEffect(() => {
    if (!selectedResumeId && resumes.length > 0) setSelectedResumeId(resumes[0].id);
  }, [resumes, selectedResumeId]);

  const detailQuery = useQuery({
    queryKey: ['jobs', 'detail', jobId],
    queryFn: () => jobsApi.get(jobId!),
    // List-row data is primary: only fetch when the selected job has no row
    // in the current list, so the detail never shows a job outside it.
    enabled: !!jobId && initialJob === undefined,
  });

  // List-row data is primary; the server fetch is a fallback for rows absent
  // from the current list (deep links) and never overrides a present row.
  // List rows carry no description; the detail fetch adds it.
  const detail: (JobListingSummary & { description?: string }) | null =
    initialJob ?? detailQuery.data ?? null;

  // Cached normalized markdown (ADR-020): read-only auto fetch. When the
  // backend has stored markdown it renders via MarkdownText; otherwise the
  // raw description shows. No manual Format action, no toggle, no spinner.
  const mdQuery = useQuery({
    queryKey: ['jobs', 'md', jobId],
    queryFn: async () => {
      try {
        return await jobsApi.getMd(jobId!);
      } catch (error) {
        const status =
          error && typeof error === 'object'
            ? (error as { statusCode?: number; status?: number }).statusCode ??
              (error as { status?: number }).status
            : undefined;
        if (status === 409) return null;
        throw error;
      }
    },
    enabled: !!jobId,
    retry: false,
  });
  const rawQuery = useQuery({
    queryKey: ['jobs', 'detail-raw', jobId],
    queryFn: () => jobsApi.get(jobId!),
    enabled: !!jobId && initialJob !== undefined && mdQuery.isError,
    retry: false,
  });
  const description = detail?.description ?? mdQuery.data?.description ?? rawQuery.data?.description ?? null;
  const cachedMarkdown = mdQuery.data?.descriptionMd ?? null;

  const existingApplication = jobId
    ? applications.find((a) => (a.jobListing as { id?: string } | null | undefined)?.id === jobId || (a as { jobListingId?: string }).jobListingId === jobId)
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
    if (!jobId && !initialJob) {
      toast({ title: 'Select a job first', variant: 'destructive' });
      return;
    }
    if (resumes.length === 0) {
      toast({ title: 'Create a resume first', variant: 'destructive' });
      return;
    }
    if (!description || description.trim().length < 50) {
      toast({ title: 'This listing has no usable description to analyse.', variant: 'destructive' });
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
      await createApp.mutateAsync({ jobListingId: jobId, status: 'saved' });
      navigate('/app/applications');
    } catch {
      // error already toasted
    }
  }, [jobId, existingApplication, createApp, navigate]);

  if (!jobId && !initialJob) {
    return (
      <section aria-labelledby="jd-empty" className="flex min-h-full min-w-0 flex-col items-center justify-center text-center text-ink-3 p-6">
        <FileSearch className="mb-3 h-6 w-6 opacity-40" />
        <p id="jd-empty" className="text-sm">Select a job to see its description, analysis, and actions.</p>
      </section>
    );
  }

  if (detailQuery.isLoading) {
    return (
      <section aria-label="Job detail" className="flex min-h-full min-w-0 flex-col overflow-x-clip">
        <div className="p-6 space-y-4">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </section>
    );
  }

  if (detailQuery.isError || !detail) {
    return (
      <section aria-label="Job detail" className="flex min-h-full min-w-0 flex-col items-center justify-center p-6">
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
  // Wave-10 provenance (T803, N11): every source, never just the first.
  // sourceBadges unions the legacy `source` in, so an old-shaped row still
  // shows its single source and the existing source filter keeps working.
  // flex-wrap keeps the full list inside the mobile drawer (Jobs.tsx:71) -
  // no +N truncation here; that is a card-density affordance only.
  const allSources = sourceBadges({
    source: detail?.source ?? initialJob?.source ?? '',
    sources: detail?.sources ?? initialJob?.sources,
  });
  // dateLabelFor: Posted / Updated / Found, or null for old-shaped and
  // unknown rows - null renders no label, so those rows show the date
  // exactly as today (including 'Date unavailable') and an index-date row
  // is never labelled Posted (N4).
  const provenanceDateLabel = dateLabelFor({
    postedAtSource: detail?.postedAtSource ?? initialJob?.postedAtSource ?? null,
  });
  const posted = detail?.postedAt ? getPostedLabel(detail.postedAt) : (initialJob?.postedAt ? getPostedLabel(initialJob.postedAt) : 'Date unavailable');
  const applyUrl = detail?.applyUrl ?? initialJob?.applyUrl;
  const hasEvaluation = !!currentEvaluation;
  const ghost = ghostProp ?? detail?.ghost ?? initialJob?.ghost;
  const descriptionUsable = !!description && description.trim().length >= 50;
  const evaluateError =
    evaluate.isError && evaluate.error ? readEvaluateError(evaluate.error) : null;

  return (
    <section aria-labelledby="jd-heading" className="flex min-h-full min-w-0 flex-col overflow-x-clip">
      <div className="sticky top-0 z-10 border-b border-rule bg-paper px-6 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {onBack && (
              <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to job list" className="shrink-0">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <div className="min-w-0">
              <h2 id="jd-heading" className="truncate text-xl font-medium text-ink">{title}</h2>
              <p className="truncate text-xs text-ink-3">
                {company}{location ? ` � ${location}` : ''}
              </p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {allSources.map((name) => (
                  <Badge key={name.toLowerCase()} variant="secondary" className="shrink-0 capitalize">{name}</Badge>
                ))}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant={saved ? "secondary" : "ghost"}
              size="icon"
              onClick={handleSave}
              disabled={savePending}
              aria-label={saved ? "Remove from saved" : "Save job"}
              aria-pressed={saved}
              aria-busy={savePending}
            >
              <Bookmark className={`h-4 w-4 ${saved ? "fill-current" : ""}`} />
            </Button>
            {onSelectAdjacent && (
              <Button variant="ghost" size="icon" onClick={() => onSelectAdjacent('previous')} aria-label="Previous job">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            {onSelectAdjacent && (
              <Button variant="ghost" size="icon" onClick={() => onSelectAdjacent('next')} aria-label="Next job">
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 space-y-8 p-6">
        {ghost && ghost.level === 'watch' && ghost.evidence.length > 0 && (
          <section className="border-t border-rule pt-4">
            <p className="section-label">Posting health</p>
            <ul className="mt-1 space-y-0.5 text-xs text-ink-3">
              {ghost.evidence.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        )}
        {evaluateError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {evaluateError.code === 'posting_closed' ? (
                <span className="flex items-center justify-between gap-2">
                  <span>This posting looks closed. The link no longer responds.</span>
                  <Button variant="outline" size="sm" onClick={() => void handleAnalyse()} className="gap-1 shrink-0">
                    <RefreshCw className="h-3.5 w-3.5" /> Retry
                  </Button>
                </span>
              ) : evaluateError.code === 'llm_key_missing' ? (
                <span>
                  No LLM key configured. Add an LLM provider key in{' '}
                  <a href="/app/settings" className="underline underline-offset-2">Settings</a>.
                </span>
              ) : evaluateError.code === 'no_description' ? (
                <span>This listing has no description to analyse.</span>
              ) : evaluateError.code === 'rate_limited' ? (
                <span>The provider rate-limited this evaluation. Try again shortly.</span>
              ) : (
                <span>Evaluation failed. You may need to add your own LLM key in Settings (BYOK).</span>
              )}
            </AlertDescription>
          </Alert>
        )}

        <section className="border-t border-rule pt-4">
          <h3 className="section-label">Job description</h3>
          <div className="mt-2">
            {cachedMarkdown ? (
              <MarkdownText markdown={cachedMarkdown} />
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm text-ink-2">
                {description || 'No description available.'}
              </p>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-3">
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {provenanceDateLabel ? `${provenanceDateLabel} � ${posted}` : posted}</span>
            {applyUrl && (
              <a href={applyUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-accent-emphasis hover:underline">
                <ExternalLink className="h-3 w-3" /> Open Original
              </a>
            )}
          </div>
        </section>

        {/* T1101: this section used to be headed "Match Score" and showed `overallScore.toFixed(1)`
            out of 5.0 plus four `{breakdown.x}%` bars. 06 sec. E.6 forbids a single derived number
            anywhere, and a percentage per dimension is the same verdict at four grains. What
            survives below it is the honest half of the same analysis: `insights.skillGaps` are
            NAMED gaps, and the recommendation badge (`JobEvaluationReport`) is a categorical
            Apply/Maybe/Skip rather than a number. The evaluation is still computed and still
            stored - `overallScore` is an internal ranking signal (FREEZE B-16) and `minMatchScore`
            still filters on it - it is simply no longer a number on a screen. */}

        {insights.skillGaps.length > 0 ? (
          <section className="border-t border-rule pt-4">
            <h3 className="section-label">Skill gaps</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
              {insights.skillGaps.map((g, i) => <li key={i}>{g}</li>)}
            </ul>
          </section>
        ) : hasEvaluation && (
          <section className="border-t border-rule pt-4">
            <h3 className="section-label">Skill gaps</h3>
            <p className="mt-2 text-sm text-ink-2">No skill gaps identified.</p>
          </section>
        )}

        {insights.evaluationResults.length > 0 && (
          <section className="border-t border-rule pt-4">
            <h3 className="section-label">Evaluation results</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-2">
              {insights.evaluationResults.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </section>
        )}

        {hasEvaluation && currentEvaluation && (
          <section>
            <h3 className="section-label">Full evaluation report</h3>
            <div className="mt-2">
              <JobEvaluationReport evaluation={currentEvaluation} />
            </div>
          </section>
        )}

        <section className="border-t border-rule pt-4">
          <h3 className="section-label">Actions</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={handleSave}
              disabled={savePending || !jobId}
              variant={saved ? "secondary" : "default"}
              size="sm"
            >
              {saved ? 'Saved' : 'Save'}
            </Button>

            {resumes.length === 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => navigate('/app/resumes')}>
                  Create a resume first
                </Button>
                <Button
                  onClick={handleAnalyse}
                  disabled
                  size="sm"
                  data-analyse-btn
                >
                  <FileSearch className="mr-2 h-4 w-4" />
                  Analyse
                </Button>
                <p className="w-full text-xs text-ink-3">Create a resume first to analyse this job.</p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Select value={selectedResumeId} onValueChange={setSelectedResumeId}>
                  <SelectTrigger className="w-auto text-xs" aria-label="Select resume">
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
                  disabled={evaluate.isPending}
                  size="sm"
                  data-analyse-btn
                >
                  {evaluate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSearch className="mr-2 h-4 w-4" />}
                  Analyse
                </Button>
                {!evaluate.isPending && !selectedResumeId && (
                  <p className="w-full text-xs text-ink-3">Select a resume to analyse.</p>
                )}
                {!evaluate.isPending && selectedResumeId && !descriptionUsable && (
                  <p className="w-full text-xs text-ink-3">This listing has no usable description to analyse.</p>
                )}
              </div>
            )}

            {/* T1110: the legacy `features/jobs/TailorPanel` is GONE. It existed to drive
                `POST /tailor` - the whole-document rewrite that wrote a `TailoredResume` row from
                unvalidated model prose, now a 410 (FREEZE A-39). Tailoring is reached at
                `/app/match/tailor`, where the engine proposes OPERATIONS with a before/after, a reason
                and the confirmed claim that grounds each one. */}
            {hasEvaluation && selectedResumeId && (
              <div className="w-full">
                <Button variant="outline" size="sm" asChild>
                  <Link to="/app/match/tailor">
                    <Scissors className="mr-2 h-4 w-4" /> Tailor this resume
                  </Link>
                </Button>
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
        </section>
      </div>
    </section>
  );
}
