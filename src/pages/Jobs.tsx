import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Loader2, UserCog, Target, AlertCircle } from "lucide-react";
import { JobFiltersSheet } from "@/features/jobs/JobFiltersSheet";
import { JobListPanel } from "@/features/jobs/JobListPanel";
import { JobDetailPanel } from "@/features/jobs/JobDetailPanel";
import { BoardManager } from "@/features/jobs/BoardManager";
import { SavedSearchManager } from "@/features/jobs/SavedSearchManager";
import {
  useJobSearch, useBoards, useScanBoards, useCareerProfile,
  useApplications, useSavedSearches, useCreateApplication,
} from "@/hooks/useJobs";
import { filterAndSortJobs } from "@/features/jobs/jobSearchUtils";
import { useJobSearchShortcuts, type UseJobSearchShortcutsOptions } from "@/features/jobs/useJobSearchShortcuts";
import type { JobListingSummary, JobSearchFilters, JobSort, SavedSearch } from "@/services/api";

const DEFAULT_FILTERS: JobSearchFilters = {
  query: "",
  minMatchScore: undefined,
  location: "",
  company: "",
  workMode: 'all',
  sources: [],
  postedWithin: 'all',
  sortBy: 'relevance',
};

const SOURCES = ['greenhouse', 'ashby', 'lever', 'workday', 'rss'] as const;

function computeActiveFilterCount(filters: JobSearchFilters): number {
  let count = 0;
  if (filters.location.trim()) count++;
  if (filters.company.trim()) count++;
  if (filters.minMatchScore !== undefined && filters.minMatchScore > 0) count++;
  if (filters.workMode !== 'all') count++;
  if (filters.sources.length > 0) count++;
  if (filters.postedWithin !== 'all') count++;
  if (filters.sortBy !== 'relevance') count++;
  return count;
}

export default function JobsPage() {
  const navigate = useNavigate();
  const { id: urlJobId } = useParams<{ id: string }>();

  const [filters, setFilters] = useState<JobSearchFilters>(DEFAULT_FILTERS);
  const [results, setResults] = useState<JobListingSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [evaluationsByJob, setEvaluationsByJob] = useState<Record<string, any>>({});
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const search = useJobSearch();
  const { data: boards } = useBoards();
  const scan = useScanBoards();
  const { data: profile } = useCareerProfile();
  const { data: applications = [] } = useApplications();
  const { data: savedSearches = [] } = useSavedSearches();
  const createApp = useCreateApplication();

  const isSearchPending = search.isPending || scan.isPending;
  const savedIds = useMemo(
    () => new Set(applications.map((a) => (a.jobListing as any)?.id ?? a.jobListingId)),
    [applications]
  );

  const evaluatedScores = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, ev] of Object.entries(evaluationsByJob)) {
      out[id] = Math.round((ev.overallScore / 5) * 100);
    }
    return out;
  }, [evaluationsByJob]);

  const filteredJobs = useMemo(
    () => filterAndSortJobs(results, filters, evaluatedScores),
    [results, filters, evaluatedScores]
  );

  const activeFilterCount = useMemo(() => computeActiveFilterCount(filters), [filters]);

  const hasCompleteProfile = !!profile &&
    Array.isArray(profile.targetRoles) && profile.targetRoles.length > 0 &&
    !!profile.seniority &&
    Array.isArray(profile.topSkills) && profile.topSkills.length > 0;

  const performSearch = useCallback(async () => {
    const trimmed = filters.query.trim();
    if (!trimmed) return;
    const sources = filters.sources.length > 0 ? filters.sources : undefined;
    const data = await search.mutateAsync({ q: trimmed, sources });
    setResults(data);
    return data;
  }, [filters.query, filters.sources, search]);

  const handleScan = useCallback(async () => {
    const data = await scan.mutateAsync({ query: filters.query.trim() || undefined, boardIds: [] });
    setResults(data);
    return data;
  }, [filters.query, scan]);

  const handleClearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
  }, []);

  const handleSelectJob = useCallback((job: JobListingSummary) => {
    setSelectedId(job.id);
    setMobileDetailOpen(true);
    navigate('/app/jobs/' + job.id);
  }, [navigate]);

  const handleSelectAdjacent = useCallback((direction: 'next' | 'previous') => {
    if (!filteredJobs.length || !selectedId) return;
    const idx = filteredJobs.findIndex((j) => j.id === selectedId);
    if (idx === -1) return;
    const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
    if (nextIdx < 0 || nextIdx >= filteredJobs.length) return;
    const nextJob = filteredJobs[nextIdx];
    setSelectedId(nextJob.id);
    navigate('/app/jobs/' + nextJob.id);
  }, [filteredJobs, selectedId, navigate]);

  const handleSaveJob = useCallback(async (job: JobListingSummary) => {
    try {
      await createApp.mutateAsync({ jobListingId: job.id, status: 'saved' });
    } catch {
      // error already toasted
    }
  }, [createApp]);

  const handleRunSavedSearch = useCallback(async (s: SavedSearch) => {
    const trimmed = s.query.trim();
    try {
      const data = await search.mutateAsync({ q: trimmed, sources: undefined });
      setResults(data);
      const nextFilters: JobSearchFilters = {
        query: trimmed,
        location: s.location ?? "",
        company: s.company ?? "",
        workMode: s.remoteOnly ? 'remote' : 'all',
        sources: [],
        minMatchScore: s.minMatchScore,
        postedWithin: 'all',
        sortBy: (s.sortBy as JobSort) ?? 'relevance',
      };
      setFilters(nextFilters);
    } catch {
      // error already toasted
    }
  }, [search]);

  useEffect(() => {
    if (urlJobId) {
      if (selectedId !== urlJobId) {
        setSelectedId(urlJobId);
      }
    }
  }, [urlJobId, selectedId]);

  useEffect(() => {
    if (results.length > 0 && !selectedId && !urlJobId) {
      const first = results[0];
      setSelectedId(first.id);
      navigate('/app/jobs/' + first.id, { replace: true });
    }
  }, [results, selectedId, navigate, urlJobId]);

  const hasSelection = !!selectedId && filteredJobs.some((j) => j.id === selectedId);
  const selectedJob = useMemo(
    () => filteredJobs.find((j) => j.id === selectedId),
    [filteredJobs, selectedId]
  );

  const shortcuts = useRef<UseJobSearchShortcutsOptions>({
    enabled: true,
    hasSelection,
    onNext: () => {},
    onPrevious: () => {},
    onSave: () => {},
    onOpen: () => {},
    onAnalyse: () => {},
  });

  useEffect(() => {
    shortcuts.current = {
      enabled: true,
      hasSelection,
      onNext: () => {
        if (filteredJobs.length === 0) return;
        const idx = filteredJobs.findIndex((j) => j.id === selectedId);
        const nextIdx = idx < filteredJobs.length - 1 ? idx + 1 : 0;
        const nextJob = filteredJobs[nextIdx];
        setSelectedId(nextJob.id);
        navigate('/app/jobs/' + nextJob.id);
        setMobileDetailOpen(true);
      },
      onPrevious: () => {
        if (filteredJobs.length === 0) return;
        const idx = filteredJobs.findIndex((j) => j.id === selectedId);
        const prevIdx = idx > 0 ? idx - 1 : filteredJobs.length - 1;
        const prevJob = filteredJobs[prevIdx];
        setSelectedId(prevJob.id);
        navigate('/app/jobs/' + prevJob.id);
        setMobileDetailOpen(true);
      },
      onSave: () => {
        const job = filteredJobs.find((j) => j.id === selectedId);
        if (job) handleSaveJob(job);
      },
      onOpen: () => {
        const job = filteredJobs.find((j) => j.id === selectedId);
        if (job?.applyUrl) {
          window.open(job.applyUrl, '_blank', 'noreferrer');
        }
      },
      onAnalyse: () => {
        const btn = document.querySelector('[data-analyse-btn]') as HTMLButtonElement | null;
        if (btn && !btn.disabled) btn.click();
      },
    };
  }, [filteredJobs, selectedId, navigate, hasSelection, handleSaveJob]);

  useJobSearchShortcuts(shortcuts.current);

  const showMobileDetail = mobileDetailOpen && !!selectedId;

  return (
    <AppLayout>
      <div className="flex h-full flex-col overflow-x-hidden">
        <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-4 py-3 md:px-6">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Job Search</h1>
            <p className="text-sm text-muted-foreground">
              Discover roles from public job boards, then evaluate &amp; tailor
            </p>
          </div>
          <Button onClick={() => navigate('/app/match')} className="shrink-0">
            <Target className="mr-2 h-4 w-4" /> Match jobs
          </Button>
        </header>

        {!hasCompleteProfile && (
          <div className="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 md:px-6">
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Complete your career profile for better matches &amp; tailoring.
            </p>
            <Button size="sm" variant="outline" onClick={() => navigate('/app/profile')}>
              <UserCog className="mr-1 h-4 w-4" /> Profile
            </Button>
          </div>
        )}

        <div className="hidden md:block border-b border-border bg-card/50 px-4 py-2 md:px-6">
          <JobFiltersSheet
            filters={filters}
            onChange={setFilters}
            onSearch={performSearch}
            onClear={handleClearFilters}
            sources={SOURCES}
            resultCount={filteredJobs.length}
            pending={isSearchPending}
            open={filterSheetOpen}
            onOpenChange={setFilterSheetOpen}
            activeFilterCount={activeFilterCount}
          />
        </div>

        <div className="flex min-h-0 flex-1 overflow-x-hidden">
          {showMobileDetail ? (
            <div className="md:hidden flex h-full min-w-0 flex-1 flex-col">
              <JobDetailPanel
                jobId={selectedId}
                job={selectedJob}
                onBack={() => { setMobileDetailOpen(false); setSelectedId(undefined); }}
              />
            </div>
          ) : (
            <>
              <div className="flex w-full md:w-[min(38%,28rem)] md:shrink-0 flex-col border-r border-border bg-card/30">
                <div className="flex items-center justify-between border-b border-border px-3 py-2 md:hidden">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {filteredJobs.length} result{filteredJobs.length !== 1 ? 's' : ''}
                  </span>
                  <JobFiltersSheet
                    filters={filters}
                    onChange={setFilters}
                    onSearch={() => { performSearch(); setFilterSheetOpen(false); }}
                    onClear={handleClearFilters}
                    sources={SOURCES}
                    resultCount={filteredJobs.length}
                    pending={isSearchPending}
                    open={filterSheetOpen}
                    onOpenChange={setFilterSheetOpen}
                    activeFilterCount={activeFilterCount}
                  />
                </div>
                <div className="flex-1 overflow-hidden p-3">
                  <JobListPanel
                    jobs={filteredJobs}
                    selectedId={selectedId}
                    evaluatedScores={evaluatedScores}
                    savedIds={savedIds}
                    onSelect={handleSelectJob}
                    onSave={handleSaveJob}
                    loading={search.isPending}
                    error={search.isError}
                    onRetry={performSearch}
                  />
                </div>
              </div>

              <div className="hidden md:flex flex-1 min-w-0 flex-col bg-background">
                <JobDetailPanel
                  jobId={selectedId}
                  job={selectedJob}
                  onSelectAdjacent={handleSelectAdjacent}
                />
              </div>
            </>
          )}
        </div>

        {search.isError && (
          <div className="border-t border-border bg-card/50 px-4 py-2 md:px-6">
            <Alert variant="destructive" className="py-2">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between">
                <span>Search failed. Check the backend job sources connection.</span>
                <Button variant="outline" size="sm" onClick={performSearch} className="gap-1">
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
