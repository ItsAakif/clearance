import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { PageBody } from "@/components/layout";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { UserCog, AlertCircle, Bookmark, Search, RefreshCw, SlidersHorizontal } from "lucide-react";
import { JobFiltersSheet } from "@/features/jobs/JobFiltersSheet";
import { DeepSearchPanel } from "@/features/jobs/DeepSearchPanel";
import { CatalogueFilters } from "@/features/jobs/CatalogueFilters";
import { CatalogueFiltersSheet } from "@/features/jobs/CatalogueFiltersSheet";
import { CatalogueResults } from "@/features/jobs/CatalogueResults";
import { activeRunMode, browserTierUnavailable, buildSearchParams, fullScanShouldContinue, isRunCancellable } from "@/features/jobs/deepSearch";
import { buildScopeSummary, confirmationFor } from "@/features/jobs/deepSearchScope";
import { JobDetailPanel } from "@/features/jobs/JobDetailPanel";
import { BoardProgressList } from "@/features/jobs/BoardProgressList";
import { SavedSearchManager } from "@/features/jobs/SavedSearchManager";
import {
  useJobSearch, useBoards, useScanBoards, useCareerProfile,
  useApplications, useCreateApplication,
  useMergedLocationSuggestions, useDiscoveryRun, isRunSnapshotGone,
  useCancelDiscoveryRun,
} from "@/hooks/useJobs";
import { useCatalogue } from "@/hooks/useCatalogue";
import { filterAndSortJobs, mergeResultRows, normalizeLocations } from "@/features/jobs/jobSearchUtils";
import { appendSweepSample } from "@/features/jobs/runProgress";
import type { SweepPoliteness, SweepSample } from "@/features/jobs/runProgress";
import {
  buildProfileMatch,
  applyProfileMatch,
  mergeQueryWithKeywords,
} from "@/features/jobs/ProfileMatch";
import { useJobSearchShortcuts, type UseJobSearchShortcutsOptions } from "@/features/jobs/useJobSearchShortcuts";
import type { JobListingSummary, JobSearchFilters, JobSort, SavedSearch } from "@/services/api";
import { jobsApi } from "@/services/api/jobs";
import type { FullScanBatchResponse, SearchDocument, CatalogueSort } from "@/services/api/jobs";
import {
  activeCatalogueFilterCount,
  applyCatalogueFilterChange,
  createEmptyCatalogueFilters,
  describeCatalogueFilters,
  type CatalogueFilterState,
} from "@/features/jobs/catalogueParams";
import jobSourcesContract from "../../shared/job-sources.json";

const NO_RANKING_SIGNAL: Readonly<Record<string, number>> = Object.freeze({});

const DEFAULT_FILTERS: JobSearchFilters = {
  query: "",
  minMatchScore: undefined,
  location: [],
  company: "",
  workMode: 'all',
  sources: [],
  postedWithin: 'all',
  sortBy: 'relevance',
  experienceLevel: [],
  roles: [],
  skills: [],
  exclusions: [],
  companies: [],
  sourceGroups: [],
  mode: 'standard',
};

function computeActiveFilterCount(filters: JobSearchFilters): number {
  let count = 0;
  if (filters.location.length > 0) count++;
  if (filters.company.trim()) count++;
  if (filters.minMatchScore !== undefined && filters.minMatchScore > 0) count++;
  if (filters.workMode !== 'all') count++;
  if (filters.sources.length > 0) count++;
  if (filters.postedWithin !== 'all') count++;
  if (filters.sortBy !== 'relevance') count++;
  if (filters.experienceLevel.length > 0) count++;
  if (filters.roles.length > 0) count++;
  if (filters.skills.length > 0) count++;
  if (filters.exclusions.length > 0) count++;
  if (filters.companies.length > 0) count++;
  if (filters.mode !== 'standard') count++;
  return count;
}

function catalogueToSummary(job: SearchDocument): JobListingSummary {
  return {
    id: job.id,
    source: job.source,
    title: job.title,
    company: job.company,
    location: job.location ?? undefined,
    applyUrl: job.applyUrl ?? undefined,
    postedAt: job.postedAt ?? undefined,
    isActive: job.isActive,
    skills: job.skills,
    workMode: job.workMode ?? undefined,
    ghost: job.ghost,
  };
}

export default function JobsPage() {
  const navigate = useNavigate();
  const { id: urlJobId } = useParams<{ id: string }>();

  // -- Browse (catalogue) state -------------------------------------------
  const [catalogueFilters, setCatalogueFilters] = useState<CatalogueFilterState>(
    createEmptyCatalogueFilters,
  );
  const [catalogueSearchDraft, setCatalogueSearchDraft] = useState('');
  const [catalogueFilterSheetOpen, setCatalogueFilterSheetOpen] = useState(false);
  const [catalogueSelected, setCatalogueSelected] = useState<SearchDocument | null>(null);
  const [savedSearchesOpen, setSavedSearchesOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const catalogueSearchRef = useRef<HTMLInputElement>(null);
  const catalogue = useCatalogue(catalogueFilters);

  const catalogueRows = useMemo(
    () => catalogue.data?.pages.flatMap((page) => page.data) ?? [],
    [catalogue.data],
  );
  const catalogueMeta = useMemo(() => {
    const pages = catalogue.data?.pages ?? [];
    return pages.length > 0 ? pages[pages.length - 1].meta : undefined;
  }, [catalogue.data]);
  const catalogueTotal = catalogueMeta?.total ?? 0;
  const catalogueActiveCount = activeCatalogueFilterCount(catalogueFilters);
  const catalogueSummary = describeCatalogueFilters(catalogueFilters);
  const catalogueCurrency =
    catalogueRows.find((row) => row.salary !== null)?.salary?.currency ?? null;
  const hasCatalogueSalary = catalogueRows.some((row) => row.salary !== null);

  const handleCatalogueFilterChange = useCallback((next: CatalogueFilterState) => {
    setCatalogueFilters(next);
  }, []);

  const handleCatalogueClearAll = useCallback(() => {
    setCatalogueFilters(createEmptyCatalogueFilters());
    setCatalogueSearchDraft('');
    setCatalogueSelected(null);
  }, []);

  // Debounced Browse search
  useEffect(() => {
    const timer = setTimeout(() => {
      setCatalogueFilters((current) =>
        applyCatalogueFilterChange(current, { q: catalogueSearchDraft }),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [catalogueSearchDraft]);

  // -- Deep search state (unchanged) --------------------------------------
  const [filters, setFilters] = useState<JobSearchFilters>(DEFAULT_FILTERS);
  const [results, setResults] = useState<JobListingSummary[]>([]);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [locationQuery, setLocationQuery] = useState('');
  const [locationEngaged, setLocationEngaged] = useState(false);

  const handleRequestLocationSuggestions = useCallback((q: string) => {
    setLocationQuery(q);
    setLocationEngaged(true);
  }, []);

  const { suggestions: locationSuggestions, isLoading: locationSuggestionsLoading } =
    useMergedLocationSuggestions(locationQuery, locationEngaged);

  const search = useJobSearch();
  const { data: boards } = useBoards();
  const scan = useScanBoards();
  const { data: profile } = useCareerProfile();
  const { data: applications = [] } = useApplications();
  const createApp = useCreateApplication();

  const [activeRunId, setActiveRunId] = useState<string | undefined>(undefined);
  const [lastRunId, setLastRunId] = useState<string | undefined>(undefined);
  const [fullScanPending, setFullScanPending] = useState(false);
  const [sweep, setSweep] = useState<
    { samples: SweepSample[]; total: number; politeness?: SweepPoliteness } | undefined
  >(undefined);
  const activeRunIdRef = useRef<string | undefined>(undefined);
  useEffect(() => { activeRunIdRef.current = activeRunId; }, [activeRunId]);
  const [scopeGateOpen, setScopeGateOpen] = useState(false);
  const [runDisplayQuery, setRunDisplayQuery] = useState('');

  const isSearchPending = search.isPending || scan.isPending || fullScanPending;
  const pollRunId = activeRunId ?? lastRunId;
  const run = useDiscoveryRun(pollRunId, isSearchPending);
  const runGone = isRunSnapshotGone(run.error);
  const observedRunGone = run.data !== undefined && runGone;
  const runCancelledRef = useRef(false);
  const runGoneRef = useRef(false);
  useEffect(() => {
    runCancelledRef.current = run.data?.cancelled === true;
  }, [run.data?.cancelled]);
  useEffect(() => {
    runGoneRef.current = observedRunGone;
  }, [observedRunGone]);

  const searchMode = filters.mode;
  const runSnapshot = run.data;
  const showsModeEvaluation = searchMode === 'deep' || searchMode === 'full';
  const modeEvaluation = showsModeEvaluation ? runSnapshot?.evaluation : undefined;
  const modeEstimate = modeEvaluation?.estimate;
  let modeEvalSkippedReason: string | undefined;
  if (
    modeEvaluation &&
    modeEvaluation.completed === 0 &&
    modeEvaluation.skipped > 0 &&
    modeEvaluation.reason
  ) {
    modeEvalSkippedReason = modeEvaluation.reason;
  }
  const modeEstimateUnknown =
    showsModeEvaluation &&
    (isSearchPending || runSnapshot !== undefined) &&
    modeEstimate === undefined &&
    modeEvalSkippedReason === undefined;
  const cancelRun = useCancelDiscoveryRun();
  const cancelMode = activeRunMode(searchMode, fullScanPending);
  const canCancel = !cancelRun.isPending && isRunCancellable({
    mode: cancelMode,
    fullScanLoopActive: fullScanPending,
    snapshot: runSnapshot,
  });
  const scopeCompanies = useMemo(() => {
    const legacy = filters.company !== undefined ? filters.company.trim() : '';
    return legacy ? [legacy, ...filters.companies] : [...filters.companies];
  }, [filters.company, filters.companies]);

  const deepRequiresConfirmation = useMemo(() => {
    const scope = buildScopeSummary(
      { companies: scopeCompanies, mode: filters.mode },
      filters.sourceGroups,
    );
    return confirmationFor(
      filters.mode,
      scope,
      modeEstimate ?? null,
      !browserTierUnavailable(runSnapshot),
    ).requiresConfirmation;
  }, [scopeCompanies, filters.mode, filters.sourceGroups, modeEstimate, runSnapshot]);

  const handleCancelRun = useCallback(async () => {
    const id = pollRunId;
    if (!id || cancelRun.isPending) return;
    try {
      await cancelRun.mutateAsync(id);
    } catch {
      // error already toasted
    }
  }, [pollRunId, cancelRun]);

  useEffect(() => {
    const fireBestEffortCancel = () => {
      const id = activeRunIdRef.current;
      if (!id) return;
      void jobsApi.cancelRun(id).then(() => undefined, () => undefined);
    };
    const handleBeforeUnload = () => {
      fireBestEffortCancel();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      fireBestEffortCancel();
    };
  }, []);

  const savedIds = useMemo(
    () => new Set(applications.map((a) => (a.jobListing as any)?.id ?? a.jobListingId)),
    [applications],
  );

  const filteredJobs = useMemo(
    () => filterAndSortJobs(results, filters, NO_RANKING_SIGNAL),
    [results, filters],
  );

  const activeFilterCount = useMemo(() => computeActiveFilterCount(filters), [filters]);

  const hasCompleteProfile = !!profile &&
    Array.isArray(profile.targetRoles) && profile.targetRoles.length > 0 &&
    !!profile.seniority &&
    Array.isArray(profile.topSkills) && profile.topSkills.length > 0;

  const filtersRef = useRef(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);


  const profileMatchSummary = useMemo(() => buildProfileMatch(profile), [profile]);
  const profileMatchAvailable = profileMatchSummary !== null;
  const [matchProfileOn, setMatchProfileOn] = useState(false);
  const matchProfileRef = useRef(false);
  useEffect(() => { matchProfileRef.current = matchProfileOn; }, [matchProfileOn]);
  const [appliedKeywords, setAppliedKeywords] = useState<string[]>([]);
  const appliedKeywordsRef = useRef<string[]>([]);
  useEffect(() => { appliedKeywordsRef.current = appliedKeywords; }, [appliedKeywords]);

  useEffect(() => {
    if (profileMatchSummary === null && matchProfileOn) {
      matchProfileRef.current = false;
      setMatchProfileOn(false);
      appliedKeywordsRef.current = [];
      setAppliedKeywords([]);
    }
  }, [profileMatchSummary, matchProfileOn]);

  const applyResults = useCallback((data: JobListingSummary[]) => {
    const rows = data ?? [];
    setResults(rows);
  }, []);

  const runSearch = useCallback(async () => {
    const effective = filtersRef.current;
    const base = effective.query.trim();
    const q = mergeQueryWithKeywords(base, appliedKeywordsRef.current ?? []);
    if (!q) return;
    setRunDisplayQuery(base);
    const heldSources = (effective.sources ?? []);
    const sources = heldSources.length > 0 ? heldSources : undefined;
    const postedWithin = effective.postedWithin;
    const searchLocations = effective.location;
    const searchCompany = effective.company;
    const runId = crypto.randomUUID();
    setActiveRunId(runId);
    try {
      const legacyCompany = effective.company !== undefined ? effective.company.trim() : '';
      const intentCompanies = legacyCompany
        ? [legacyCompany, ...effective.companies]
        : [...effective.companies];
      const data = await search.mutateAsync(buildSearchParams({
        q,
        ...(sources !== undefined ? { sources } : {}),
        runId,
        ...(postedWithin !== 'all' ? { postedWithin } : {}),
        ...(searchLocations.length > 0 ? { location: searchLocations } : {}),
        ...(searchCompany.trim() ? { company: searchCompany.trim() } : {}),
        mode: effective.mode,
        ...(effective.roles.length > 0 ? { roles: effective.roles } : {}),
        ...(effective.skills.length > 0 ? { skills: effective.skills } : {}),
        ...(effective.exclusions.length > 0 ? { exclusions: effective.exclusions } : {}),
        ...(intentCompanies.length > 0 ? { companies: intentCompanies } : {}),
        ...(effective.sourceGroups.length > 0 ? { sourceGroups: [...effective.sourceGroups] } : {}),
      }));
      applyResults(data ?? []);
    } finally {
      setActiveRunId(undefined);
      setLastRunId(runId);
      // Refresh catalogue with run query
      setCatalogueSearchDraft(base);
      setCatalogueFilters((current) =>
        applyCatalogueFilterChange(current, {
          q: base,
          ...(searchLocations.length > 0 ? { location: searchLocations[0] } : {}),
          ...(searchCompany.trim() ? { company: searchCompany.trim() } : {}),
        }),
      );
      void catalogue.refetch();
    }
  }, [search, applyResults, catalogue]);

  const runFullScan = useCallback(async () => {
    const effective = filtersRef.current;
    const base = effective.query.trim();
    const q = mergeQueryWithKeywords(base, appliedKeywordsRef.current ?? []);
    if (!q) return;
    const heldSources = effective.sources ?? [];
    const sources = heldSources.length > 0 ? heldSources : undefined;
    const postedWithin = effective.postedWithin;
    const searchLocations = effective.location;
    const searchCompany = effective.company;
    const legacyCompany = effective.company !== undefined ? effective.company.trim() : '';
    const intentCompanies = legacyCompany
      ? [legacyCompany, ...effective.companies]
      : [...effective.companies];
    const runId = crypto.randomUUID();
    setRunDisplayQuery(base);
    runCancelledRef.current = false;
    runGoneRef.current = false;
    setFullScanPending(true);
    setSweep(undefined);
    setActiveRunId(runId);
    let after: string | null | undefined;
    let accumulator: JobListingSummary[] = [];
    try {
      while (true) {
        if (runCancelledRef.current || runGoneRef.current) break;
        let batch: FullScanBatchResponse;
        try {
          batch = await jobsApi.fullScan({
            runId,
            ...(after ? { after } : {}),
            q,
            ...(sources !== undefined ? { sources } : {}),
            ...(postedWithin !== 'all' ? { postedWithin } : {}),
            ...(searchLocations.length > 0 ? { location: searchLocations } : {}),
            ...(searchCompany.trim() ? { company: searchCompany.trim() } : {}),
            ...(effective.roles.length > 0 ? { roles: effective.roles } : {}),
            ...(effective.skills.length > 0 ? { skills: effective.skills } : {}),
            ...(effective.exclusions.length > 0 ? { exclusions: effective.exclusions } : {}),
            ...(intentCompanies.length > 0 ? { companies: intentCompanies } : {}),
            ...(effective.sourceGroups.length > 0 ? { sourceGroups: [...effective.sourceGroups] } : {}),
          });
        } catch (error) {
          if (isRunSnapshotGone(error)) break;
          throw error;
        }
        accumulator = mergeResultRows(accumulator, batch.results ?? []);
        applyResults(accumulator);
        setSweep((prev) => ({
          samples: appendSweepSample(prev?.samples ?? [], batch.processed, Date.now()),
          total: batch.total,
          politeness: batch.politeness,
        }));
        if (
          runCancelledRef.current ||
          runGoneRef.current ||
          !fullScanShouldContinue(batch)
        ) {
          break;
        }
        after = batch.nextCursor;
      }
      return accumulator;
    } finally {
      setActiveRunId(undefined);
      setLastRunId(runId);
      setFullScanPending(false);
      setCatalogueSearchDraft(base);
      setCatalogueFilters((current) =>
        applyCatalogueFilterChange(current, {
          q: base,
          ...(searchLocations.length > 0 ? { location: searchLocations[0] } : {}),
          ...(searchCompany.trim() ? { company: searchCompany.trim() } : {}),
        }),
      );
      void catalogue.refetch();
    }
  }, [applyResults, catalogue]);

  const runSelectedMode = useCallback(async () => {
    if (filtersRef.current.mode === 'full') {
      await runFullScan();
      return;
    }
    await runSearch();
  }, [runFullScan, runSearch]);

  const performSearch = useCallback(async (_opts?: { manual?: boolean }) => {
    filtersRef.current = filters;
    const composed = mergeQueryWithKeywords(filters.query.trim(), appliedKeywordsRef.current ?? []);
    if (!composed) return;
    if (deepRequiresConfirmation) {
      setScopeGateOpen(true);
      return;
    }
    await runSelectedMode();
  }, [filters, runSelectedMode, deepRequiresConfirmation]);

  const handleScopeConfirm = useCallback(async () => {
    setScopeGateOpen(false);
    await runSelectedMode();
  }, [runSelectedMode]);

  const handleProfileMatch = useCallback(() => {
    if (matchProfileOn) {
      matchProfileRef.current = false;
      setMatchProfileOn(false);
      const reset = {
        ...filtersRef.current,
        location: [] as string[],
        experienceLevel: [] as JobSearchFilters['experienceLevel'],
        workMode: 'all' as const,
        mode: 'standard' as const,
      };
      appliedKeywordsRef.current = [];
      setAppliedKeywords([]);
      filtersRef.current = reset;
      setFilters(reset);
      return;
    }
    if (!profileMatchSummary) return;
    filtersRef.current = filters;
    const updated = applyProfileMatch(true, filtersRef.current, profileMatchSummary);
    filtersRef.current = updated;
    setFilters(updated);
    appliedKeywordsRef.current = [...profileMatchSummary.candidate.keywords];
    setAppliedKeywords([...profileMatchSummary.candidate.keywords]);
    matchProfileRef.current = true;
    setMatchProfileOn(true);
  }, [filters, profileMatchSummary, matchProfileOn]);

  const handleScan = useCallback(async () => {
    const composed = mergeQueryWithKeywords(filters.query.trim(), appliedKeywordsRef.current ?? []);
    const scanMode = filters.mode === 'deep' ? 'deep' : 'standard';
    const runId = crypto.randomUUID();
    setRunDisplayQuery(filters.query.trim());
    setActiveRunId(runId);
    try {
      const data = await scan.mutateAsync({ query: composed || undefined, boardIds: [], runId, mode: scanMode });
      matchProfileRef.current = false;
      setMatchProfileOn(false);
      appliedKeywordsRef.current = [];
      setAppliedKeywords([]);
      applyResults(data ?? []);
    } finally {
      setActiveRunId(undefined);
      setLastRunId(runId);
      const base = filters.query.trim();
      setCatalogueSearchDraft(base);
      setCatalogueFilters((current) =>
        applyCatalogueFilterChange(current, { q: base }),
      );
      void catalogue.refetch();
    }
  }, [filters.query, filters.mode, scan, applyResults, catalogue]);

  const handleClearFilters = useCallback(() => {
    filtersRef.current = DEFAULT_FILTERS;
    setFilters(DEFAULT_FILTERS);
    setLocationQuery('');
    matchProfileRef.current = false;
    setMatchProfileOn(false);
    appliedKeywordsRef.current = [];
    setAppliedKeywords([]);
  }, []);

  const handleSelectJob = useCallback((job: SearchDocument) => {
    setCatalogueSelected(job);
  }, []);

  const handleSaveJob = useCallback(async (job: JobListingSummary) => {
    try {
      await createApp.mutateAsync({ jobListingId: job.id, status: 'saved' });
    } catch {
      // error already toasted
    }
  }, [createApp]);

  const handleRunSavedSearch = useCallback(async (s: SavedSearch) => {
    const trimmed = s.query.trim();
    const liveMode = filtersRef.current.mode === 'deep' ? 'deep' : 'standard';
    const runId = crypto.randomUUID();
    setRunDisplayQuery(trimmed);
    setActiveRunId(runId);
    try {
      const data = await search.mutateAsync({ q: trimmed, sources: undefined, runId, mode: liveMode });
      applyResults(data ?? []);
      const nextFilters: JobSearchFilters = {
        query: trimmed,
        location: normalizeLocations(s.location),
        company: s.company ?? "",
        workMode: s.remoteOnly ? 'remote' : 'all',
        sources: [],
        minMatchScore: s.minMatchScore,
        postedWithin: 'all',
        sortBy: (s.sortBy as JobSort) ?? 'relevance',
        experienceLevel: [],
        roles: [],
        skills: [],
        exclusions: [],
        companies: [],
        sourceGroups: [],
        mode: 'standard',
      };
      setFilters(nextFilters);
      filtersRef.current = nextFilters;
      matchProfileRef.current = false;
      setMatchProfileOn(false);
      appliedKeywordsRef.current = [];
      setAppliedKeywords([]);
      setCatalogueSearchDraft(trimmed);
      setCatalogueFilters((current) =>
        applyCatalogueFilterChange(current, { q: trimmed }),
      );
      void catalogue.refetch();
    } catch {
      // error already toasted
    } finally {
      setActiveRunId(undefined);
      setLastRunId(runId);
    }
  }, [search, applyResults, catalogue]);

  const handleLoadSavedSearch = useCallback((s: SavedSearch) => {
    setSavedSearchesOpen(false);
    void handleRunSavedSearch(s);
  }, [handleRunSavedSearch]);

  const hasSelection = !!catalogueSelected;
  const selectedJob = catalogueSelected ? catalogueToSummary(catalogueSelected) : undefined;

  const shortcuts = useRef<UseJobSearchShortcutsOptions>({
    enabled: true,
    hasSelection: false,
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
        if (catalogueRows.length === 0) return;
        const idx = catalogueSelected ? catalogueRows.findIndex((j) => j.id === catalogueSelected.id) : -1;
        const nextIdx = idx >= 0 && idx < catalogueRows.length - 1 ? idx + 1 : 0;
        const next = catalogueRows[nextIdx];
        if (next) setCatalogueSelected(next);
      },
      onPrevious: () => {
        if (catalogueRows.length === 0) return;
        const idx = catalogueSelected ? catalogueRows.findIndex((j) => j.id === catalogueSelected.id) : -1;
        const prevIdx = idx > 0 ? idx - 1 : catalogueRows.length - 1;
        const prev = catalogueRows[prevIdx];
        if (prev) setCatalogueSelected(prev);
      },
      onSave: () => {
        if (catalogueSelected) handleSaveJob(catalogueToSummary(catalogueSelected));
      },
      onOpen: () => {
        const url = catalogueSelected?.applyUrl;
        if (url) window.open(url, '_blank', 'noreferrer');
      },
      onAnalyse: () => {
        const btn = document.querySelector('[data-analyse-btn]') as HTMLButtonElement | null;
        if (btn && !btn.disabled) btn.click();
      },
    };
  }, [catalogueRows, catalogueSelected, handleSaveJob]);

  useJobSearchShortcuts(shortcuts.current);

  const handleBackToList = useCallback(() => {
    setCatalogueSelected(null);
  }, []);

  const showLiveProgress = isSearchPending;
  const showSettledProgress = !isSearchPending && !!run.data && !!pollRunId && !runGone;

  const filterSheetProps = {
    filters,
    onChange: setFilters,
    onSearch: performSearch,
    onClear: handleClearFilters,
    sources: jobSourcesContract.sources,
    resultCount: filteredJobs.length,
    pending: isSearchPending,
    activeFilterCount,
    locationSuggestions,
    locationSuggestionsLoading,
    onRequestLocationSuggestions: handleRequestLocationSuggestions,
    profileMatchAvailable,
    onProfileMatch: handleProfileMatch,
    profileMatchPending: isSearchPending,
    profileMatchApplied: matchProfileOn,
  };

  const panelProps = {
    mode: searchMode,
    onModeChange: (m: JobSearchFilters['mode']) => {
      const next = { ...filtersRef.current, mode: m };
      filtersRef.current = next;
      setFilters(next);
    },
    estimate: modeEstimate,
    estimateUnknown: modeEstimateUnknown,
    aiSkippedReason: modeEvalSkippedReason,
    browserTierKnownUnavailable: browserTierUnavailable(runSnapshot),
    runId: pollRunId,
    cancelPending: cancelRun.isPending,
    canCancel,
    onCancel: handleCancelRun,
    companies: scopeCompanies,
    contractGroups: filters.sourceGroups,
    scopeGateOpen,
    onScopeGateOpenChange: setScopeGateOpen,
    onScopeConfirm: handleScopeConfirm,
    scopeConfirmPending: isSearchPending,
    scopeEstimatePending: false,
    runCancelled: runSnapshot?.cancelled === true,
    keptResultCount: results.length,
    runFailed: search.isError,
  };

  const liveContextLine = catalogueMeta
    ? `${catalogueTotal.toLocaleString()} live posting${catalogueTotal === 1 ? '' : 's'}${
        (catalogueMeta.facets.workMode.remote ?? 0) > 0
          ? ` · ${catalogueMeta.facets.workMode.remote.toLocaleString()} remote`
          : ''
      }`
    : 'Live postings from public job boards';

  const handleTopSearchSubmit = (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    setCatalogueFilters((current) =>
      applyCatalogueFilterChange(current, { q: catalogueSearchDraft }),
    );
    void performSearch();
  };

  return (
    <div className="flex min-h-full flex-col overflow-x-clip">
      <header className="border-b border-border bg-paper px-8 py-5 print:hidden">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="page-title text-ink">
              Jobs
            </h1>
            <p className="mt-1 text-sm text-ink-3" aria-live="polite">
              {liveContextLine}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-ink-2"
              onClick={() => setSavedSearchesOpen(true)}
            >
              <Bookmark className="h-4 w-4" /> Saved searches
            </Button>
            {catalogueActiveCount > 0 && (
              <button
                type="button"
                onClick={handleCatalogueClearAll}
                className="text-sm text-ink-3 underline-offset-4 hover:text-ink hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        </div>
      </header>

      {!hasCompleteProfile && (
        <div className="flex items-center justify-between gap-3 border-b border-rule bg-paper-2 px-6 py-2 lg:px-8">
          <p className="text-sm text-ink-2">
            Complete your career profile for better matches &amp; tailoring.
          </p>
          <Button size="sm" variant="outline" onClick={() => navigate('/app/profile')}>
            <UserCog className="mr-1 h-4 w-4" /> Profile
          </Button>
        </div>
      )}

      <PageBody width="full" className="flex flex-1 items-start">
        <aside className="hidden w-[300px] shrink-0 lg:block">
          <div className="sticky top-0 max-h-[calc(100vh-1rem)] overflow-y-auto px-6 py-6">
            <div className="surface-card p-4">
              <CatalogueFilters
                facets={catalogueMeta?.facets}
                filters={catalogueFilters}
                onChange={handleCatalogueFilterChange}
                onClearAll={handleCatalogueClearAll}
                currency={catalogueCurrency}
                showSalary={hasCatalogueSalary}
              />
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <div className="w-full max-w-4xl px-6 py-6 lg:px-8">
            <form
              role="search"
              onSubmit={handleTopSearchSubmit}
              className="surface-card flex flex-wrap items-center gap-3 p-3"
            >
              {/* One search surface: the input sits on paper inside a 1px rule,
                  the mode select shares that surface, the Search button is ink. */}
              <div className="flex h-9 min-w-[240px] flex-1 items-center gap-2 rounded-control border border-border bg-card px-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
                <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-3" />
                <Input
                  ref={catalogueSearchRef}
                  type="search"
                  value={catalogueSearchDraft}
                  onChange={(event) => {
                    const v = event.target.value;
                    setCatalogueSearchDraft(v);
                    setFilters((current) => ({ ...current, query: v }));
                  }}
                  placeholder="Search title, company, skill..."
                  aria-label="Search jobs"
                  className="h-8 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm focus-visible:border-0 focus-visible:ring-0"
                />
              </div>
              <select
                value={filters.mode}
                onChange={(event) => {
                  const m = event.target.value as JobSearchFilters['mode'];
                  const next = { ...filtersRef.current, mode: m };
                  filtersRef.current = next;
                  setFilters(next);
                }}
                aria-label="Search mode"
                className="h-9 rounded-control border border-border bg-card px-2 text-sm text-ink-2 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
              >
                <option value="standard">Standard</option>
                <option value="deep">Deep</option>
                <option value="full">Full</option>
              </select>
              <Button type="submit" size="sm" className="shrink-0">
                <Search className="mr-2 h-4 w-4" /> Search
              </Button>
              <button
                type="button"
                onClick={() => void performSearch()}
                aria-label="Refresh results"
                className="flex h-9 w-9 items-center justify-center rounded-control border border-border bg-card text-ink-2 hover:bg-paper-2 hover:text-ink"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <CatalogueFiltersSheet
                open={catalogueFilterSheetOpen}
                onOpenChange={setCatalogueFilterSheetOpen}
                activeCount={catalogueActiveCount}
                facets={catalogueMeta?.facets}
                filters={catalogueFilters}
                onChange={handleCatalogueFilterChange}
                onClearAll={handleCatalogueClearAll}
                currency={catalogueCurrency}
                showSalary={hasCatalogueSalary}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="shrink-0"
              >
                <SlidersHorizontal className="mr-2 h-4 w-4" /> Advanced
              </Button>
            </form>

            <details open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)} className="surface-card mt-4 p-3">
              <summary className="cursor-pointer px-1 py-1 text-sm text-ink-2">Advanced options</summary>
              {advancedOpen && (
                <div className="space-y-3 px-1 py-3">
                  <DeepSearchPanel {...panelProps} />
                  <JobFiltersSheet {...filterSheetProps} open={filterSheetOpen} onOpenChange={setFilterSheetOpen} />
                </div>
              )}
            </details>

            <div className="flex items-center justify-between gap-3 py-3">
              {catalogue.isLoading ? (
                <p className="text-xs text-ink-3" aria-live="polite">
                  Loading postings...
                </p>
              ) : (
                <p className="text-sm text-ink-2" aria-live="polite">
                  {catalogueTotal.toLocaleString()} job{catalogueTotal === 1 ? '' : 's'}
                </p>
              )}
              {catalogueSummary && (
                <p className="min-w-0 truncate text-xs text-ink-3">{catalogueSummary}</p>
              )}
            </div>

            {(showLiveProgress || showSettledProgress) && (
              <div className="mb-2 shrink-0">
                {showLiveProgress ? (
                  <BoardProgressList
                    snapshot={run.data}
                    pending
                    query={runDisplayQuery}
                    sweep={fullScanPending ? sweep : undefined}
                  />
                ) : (
                  run.data && (
                    <details className="border-y border-rule py-2">
                      <summary className="cursor-pointer text-xs text-ink-3">
                        Show board progress (Total: {filteredJobs.length} listings)
                      </summary>
                      <div className="mt-2">
                        <BoardProgressList snapshot={run.data} pending={false} query={runDisplayQuery} />
                      </div>
                    </details>
                  )
                )}
              </div>
            )}

            <CatalogueResults
              rows={catalogueRows}
              total={catalogueTotal}
              loading={catalogue.isLoading}
              error={catalogue.isError}
              onRetry={() => void catalogue.refetch()}
              onSelect={handleSelectJob}
              selectedId={catalogueSelected?.id}
              onClearAll={handleCatalogueClearAll}
              hasNextPage={catalogue.hasNextPage}
              loadingMore={catalogue.isFetchingNextPage}
              onLoadMore={() => void catalogue.fetchNextPage()}
            />
          </div>
        </div>
      </PageBody>

      {search.isError && (
        <div className="border-t border-rule bg-paper px-6 py-2 lg:px-8">
          <Alert variant="destructive" className="py-2">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between">
              <span>Search failed. Check the backend job sources connection.</span>
              <Button variant="outline" size="sm" onClick={() => performSearch({ manual: false })} className="gap-1">
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      )}

      <Sheet
        open={catalogueSelected !== null}
        onOpenChange={(open) => {
          if (!open) setCatalogueSelected(null);
        }}
      >
        <SheetContent
          side="right"
          className="w-full overflow-y-auto p-0 sm:max-w-2xl [&>button]:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Job detail</SheetTitle>
            <SheetDescription>Description, analysis and actions for this job.</SheetDescription>
          </SheetHeader>
          <JobDetailPanel
            jobId={catalogueSelected?.id}
            job={selectedJob}
            ghost={catalogueSelected?.ghost}
            onBack={() => setCatalogueSelected(null)}
          />
        </SheetContent>
      </Sheet>

      <Sheet open={savedSearchesOpen} onOpenChange={setSavedSearchesOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Saved searches</SheetTitle>
            <SheetDescription>Reuse a search across sessions.</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <SavedSearchManager currentFilters={filters} onLoad={handleLoadSavedSearch} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}