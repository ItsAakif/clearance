// React Query hooks for Jobs, Tailor, Applications & BYOK keys.
import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  jobsApi, applicationsApi, keysApi, profileApi, boardsApi, searchesApi,
  questionAnswersApi, alertsApi, uploadedFilesApi
} from '@/services/api';
import type {
  ApiKey, CareerProfile, ParseProfileResponse, JobBoard, SavedSearch,
  JobSearchMode,
  QuestionAnswer, JobAlert, ApplicationEvent, ApplicationEventType,
  ApplicationStatus,
  LocationSuggestion
} from '@/services/api';
import { loadCities, mergeSuggestions, searchCities } from '@/features/jobs/citySearch';
import type { CityRow } from '@/features/jobs/citySearch';
import { toast } from './use-toast';

// ==================== BYOK KEYS ====================
export const keysQueryKey = ['keys'] as const;

export function useApiKeys() {
  return useQuery({ queryKey: keysQueryKey, queryFn: () => keysApi.list() });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { provider: string; apiKey: string; label?: string }) =>
      keysApi.create(vars.provider, vars.apiKey, vars.label),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keysQueryKey });
      toast({ title: 'Key added', description: 'Your API key was saved securely.' });
    },
    onError: (e: Error) => toast({ title: 'Failed to add key', description: e.message, variant: 'destructive' }),
  });
}

export function useDeleteApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => keysApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keysQueryKey });
      toast({ title: 'Key removed' });
    },
    onError: (e: Error) => toast({ title: 'Failed to remove key', description: e.message, variant: 'destructive' }),
  });
}

// ==================== JOBS ====================
export function useJobSearch() {
  return useMutation({
    mutationFn: (vars: { q: string; sources?: string[]; runId?: string; postedWithin?: 'day' | 'week' | 'month'; location?: string[]; company?: string; mode?: JobSearchMode; roles?: string[]; skills?: string[]; exclusions?: string[]; companies?: string[]; sourceGroups?: string[] }) =>
      jobsApi.search(vars.q, vars.sources, { runId: vars.runId, postedWithin: vars.postedWithin, location: vars.location, company: vars.company, mode: vars.mode, roles: vars.roles, skills: vars.skills, exclusions: vars.exclusions, companies: vars.companies, sourceGroups: vars.sourceGroups }),
    onError: (e: Error) => toast({ title: 'Search failed', description: e.message, variant: 'destructive' }),
  });
}

// Wave 10 (T804): cancel control for the T743 endpoint. On success the
// cancelled snapshot is re-read through the existing run query so progress
// renders `cancelled` with no polling-cadence change and no new transport.
// Results and polling flags are untouched (wave 11 owns the persistence
// semantics); `useDiscoveryRun` and `isRunSnapshotGone` keep their exact
// signatures.
export function useCancelDiscoveryRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => jobsApi.cancelRun(runId),
    onSuccess: (snapshot) => {
      qc.invalidateQueries({ queryKey: ['jobs', 'run', snapshot.runId] });
      toast({ title: 'Search cancelled' });
    },
    onError: (e: Error) => toast({ title: 'Cancel failed', description: e.message, variant: 'destructive' }),
  });
}

export function useDiscoveryRun(runId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['jobs', 'run', runId],
    queryFn: () => jobsApi.runStatus(runId!),
    enabled: !!runId && enabled,
    // Run snapshots live in the backend's in-memory registry (cap 50 +
    // 5-min TTL, ADR-013): a backend restart or TTL expiry wipes them, so
    // GET /jobs/runs/:runId can 404 mid-poll. That is terminal-gone, not a
    // failure — stop polling silently and let the plain search results
    // settle on their own. Any other status keeps the 600 ms poll and keeps
    // surfacing through the query error state as before. A 404 before any
    // snapshot was observed is the benign early-poll race (beginRun has not
    // run yet) and keeps polling; only a 404 after a snapshot was seen is
    // terminal-gone. The number of silent early 404s is bounded by the search
    // duration because the query is only enabled while the mutation is pending.
    refetchInterval: (query) =>
      isRunSnapshotGone(query.state.error) && query.state.data !== undefined ? false : 600,
    staleTime: 0,
    retry: false,
  });
}

// True only for the terminal-gone run snapshot (backend restart wiped the
// in-memory registry, or the 5-min TTL expired). Other API errors must keep
// surfacing normally — never treat them as gone.
export function isRunSnapshotGone(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

export function useEvaluateJob() {
  return useMutation({
    mutationFn: (vars: { jobId: string; resumeId: string; jobDescription?: string }) =>
      jobsApi.evaluate(vars.jobId, vars.resumeId, vars.jobDescription),
    onError: (e: Error) => toast({ title: 'Evaluation failed', description: e.message, variant: 'destructive' }),
  });
}

// ==================== DESCRIPTION NORMALIZE ====================
// On-demand AI markdown formatting (ADR-020). User-triggered only; the raw
// description and the Analyse flow are untouched.
export function useNormalizeJob() {
  return useMutation({
    mutationFn: (id: string) => jobsApi.normalize(id),
    onError: (e: Error) => toast({ title: 'Formatting failed', description: e.message, variant: 'destructive' }),
  });
}

export function useNormalizeJobs() {
  return useMutation({
    mutationFn: (ids: string[]) => jobsApi.normalizeBatch(ids),
    onError: (e: Error) => toast({ title: 'Batch formatting failed', description: e.message, variant: 'destructive' }),
  });
}

export const locationSuggestionsQueryKey = ['jobLocations'] as const;

/**
 * Debounced suggestion lookup for the listing-derived location source. The static city list is
 * a separate hook with no network; `useMergedLocationSuggestions` composes the two.
 */
export function useLocationSuggestions(query: string, enabled = true) {
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(t);
  }, [query]);
  const trimmed = debounced.trim();
  return useQuery({
    queryKey: [...locationSuggestionsQueryKey, trimmed] as const,
    queryFn: async () =>
      // The one place the wire shape becomes the UI shape. Do not push `source` into the
      // server response or into the generic api layer.
      (await jobsApi.locations(trimmed || undefined, 8)).map((row) => ({
        ...row,
        source: 'listing' as const,
      })),
    enabled: enabled && trimmed.length > 0,
    staleTime: 60_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

/**
 * Static city source. One asset fetch per session, no React Query, no server cache.
 * Owns the 150 ms debounce for the local recall search.
 */
export function useCitySuggestions(
  query: string,
  enabled: boolean,
): { cities: LocationSuggestion[]; citiesReady: boolean } {
  const [rows, setRows] = useState<CityRow[] | null>(null);
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (!enabled || rows !== null) return;
    let alive = true;
    loadCities().then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [enabled, rows]);
  const cities = useMemo(
    () => (rows ? searchCities(rows, debounced) : []),
    [rows, debounced],
  );
  return { cities, citiesReady: rows !== null };
}

/** The one hook the UI consumes: local first, then listing rows, deduped. The pool runs
 *  to CITY_RESULT_LIMIT; LocationFilter renders the first CITY_UI_LIMIT rows with a
 *  show-more expander for the rest. */
export function useMergedLocationSuggestions(query: string, enabled = true) {
  const { cities, citiesReady } = useCitySuggestions(query, enabled);
  // Pass the RAW query: useLocationSuggestions owns its own 250 ms debounce (T216).
  const { data: listings = [], isFetching } = useLocationSuggestions(query, enabled);
  const suggestions = useMemo(() => mergeSuggestions(cities, listings), [cities, listings]);
  return { suggestions, isLoading: !citiesReady && isFetching };
}

// T1110: `useTailorResume` is GONE. Its only caller was `features/jobs/TailorPanel.tsx`, which
// existed to drive the legacy whole-document tailor (`POST /tailor`, now a 410 - FREEZE A-39).
// The successor is the V2 operation surface: `features/tailor/TailorPanel.tsx` via
// `services/api/tailor.ts`, reached at `/app/tailor`. That file is untouched.

// ==================== APPLICATIONS ====================
export const applicationsQueryKey = ['applications'] as const;

export function useApplications() {
  return useQuery({ queryKey: applicationsQueryKey, queryFn: () => applicationsApi.list() });
}

export function useApplication(id: string) {
  return useQuery({
    queryKey: ['applications', id],
    queryFn: () => applicationsApi.get(id),
    enabled: !!id,
  });
}

export function useCreateApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { jobListingId: string; tailoredResumeId?: string; status?: ApplicationStatus; notes?: string }) =>
      applicationsApi.create(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: applicationsQueryKey });
      toast({ title: 'Saved to pipeline' });
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });
}

export function useUpdateApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; status?: ApplicationStatus; notes?: string; appliedAt?: string; followUpAt?: string | null; ghostedAt?: string | null; withdrawnAt?: string | null }) =>
      applicationsApi.update(vars.id, { status: vars.status, notes: vars.notes, appliedAt: vars.appliedAt, followUpAt: vars.followUpAt, ghostedAt: vars.ghostedAt, withdrawnAt: vars.withdrawnAt }),
    onSuccess: () => qc.invalidateQueries({ queryKey: applicationsQueryKey }),
    onError: (e: Error) => toast({ title: 'Update failed', description: e.message, variant: 'destructive' }),
  });
}

export function useApplicationEvents(applicationId: string) {
  return useQuery({
    queryKey: ['applications', applicationId, 'events'],
    queryFn: () => applicationsApi.listEvents(applicationId),
    enabled: !!applicationId,
  });
}

export function useCreateApplicationEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { applicationId: string; type: ApplicationEventType; fromStatus?: string; toStatus?: string; title?: string; description?: string; scheduledAt?: string; completedAt?: string }) =>
      applicationsApi.createEvent(vars.applicationId, vars),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['applications', vars.applicationId, 'events'] });
      qc.invalidateQueries({ queryKey: applicationsQueryKey });
    },
    onError: (e: Error) => toast({ title: 'Failed to add event', description: e.message, variant: 'destructive' }),
  });
}

export function useUpdateApplicationEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { applicationId: string; eventId: string; title?: string; description?: string; scheduledAt?: string | null; completedAt?: string | null }) =>
      applicationsApi.updateEvent(vars.applicationId, vars.eventId, vars),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ['applications', vars.applicationId, 'events'] }),
    onError: (e: Error) => toast({ title: 'Failed to update event', description: e.message, variant: 'destructive' }),
  });
}

// T1110: `useGenerateInterviewAnswer` is GONE with `services/api/ai.ts` (FREEZE A-35). Its only
// caller was the Q&A bank's "generate an answer" dialog, which called
// `POST /ai/generate-interview-answer` - a free-form answer generator with nothing anchoring it to
// anything the candidate has done, now a 410. The successor is `/app/interview-prep`, whose
// questions are derived from the risks and gaps in the user's own confirmed evidence.

// ==================== CAREER PROFILE ====================
export const profileQueryKey = ['careerProfile'] as const;

export function useCareerProfile() {
  return useQuery({ queryKey: profileQueryKey, queryFn: () => profileApi.get() });
}

export function useUpsertProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<CareerProfile>) => profileApi.upsert(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileQueryKey });
      toast({ title: 'Profile saved' });
    },
    onError: (e: Error) => toast({ title: 'Failed to save profile', description: e.message, variant: 'destructive' }),
  });
}

export function useParseProfile() {
  return useMutation({
    mutationFn: (resumeId: string) => profileApi.parse(resumeId),
    onError: (e: Error) => toast({ title: 'Parse failed', description: e.message, variant: 'destructive' }),
  });
}

// ==================== UPLOADED FILES ====================
export const uploadedFilesQueryKey = ['uploadedFiles'] as const;

export function useUploadedFiles() {
  return useQuery({ queryKey: uploadedFilesQueryKey, queryFn: () => uploadedFilesApi.list() });
}

// Direct resume-file upload for pages other than Job Match (Profile autofill
// empty state, My Resumes Uploaded tab). Invalidates the list so the new file
// appears immediately; the caller selects it (e.g. setPendingUploadedFileId).
export function useUploadUploadedFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadedFilesApi.upload(file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: uploadedFilesQueryKey });
    },
    onError: (e: Error) => toast({ title: 'Upload failed', description: e.message, variant: 'destructive' }),
  });
}

export function useParseProfileFromUploadedFile() {
  return useMutation({
    mutationFn: (fileId: string) => profileApi.parseFromUploadedFile(fileId),
    onError: (e: Error) => toast({ title: 'Could not read that file', description: e.message, variant: 'destructive' }),
  });
}

// Object URLs for the PDF/DOCX preview path are NOT cached in React Query
// because the cache has no eviction hook for `revokeObjectURL`; only the
// text path goes through a query.
export function useUploadedFileText(fileId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...uploadedFilesQueryKey, fileId, 'text'] as const,
    queryFn: () => uploadedFilesApi.getText(fileId!),
    enabled: enabled && !!fileId,
  });
}

// ==================== JOB BOARDS ====================
export const boardsQueryKey = ['boards'] as const;

export function useBoards() {
  return useQuery({ queryKey: boardsQueryKey, queryFn: () => boardsApi.list() });
}

export function useCreateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { type: JobBoard['type']; name: string; boardId?: string; feedUrl?: string; isActive?: boolean }) =>
      boardsApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: boardsQueryKey });
      toast({ title: 'Board added' });
    },
    onError: (e: Error) => toast({ title: 'Failed to add board', description: e.message, variant: 'destructive' }),
  });
}

export function useDeleteBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => boardsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: boardsQueryKey });
      toast({ title: 'Board removed' });
    },
    onError: (e: Error) => toast({ title: 'Failed to remove board', description: e.message, variant: 'destructive' }),
  });
}

export function useScanBoards() {
  return useMutation({
    mutationFn: (vars: { query?: string; boardIds?: string[]; runId?: string; mode?: JobSearchMode }) => boardsApi.scan(vars.query, vars.boardIds, vars.runId, vars.mode),
    onError: (e: Error) => toast({ title: 'Scan failed', description: e.message, variant: 'destructive' }),
  });
}

// ==================== SAVED SEARCHES ====================
export const searchesQueryKey = ['searches'] as const;

export function useSavedSearches() {
  return useQuery({ queryKey: searchesQueryKey, queryFn: () => searchesApi.list() });
}

export function useCreateSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; query?: string; location?: string | string[]; company?: string; boards?: string[]; minMatchScore?: number; remoteOnly?: boolean; sortBy?: string; intent?: unknown }) =>
      searchesApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: searchesQueryKey });
      toast({ title: 'Saved search created' });
    },
    onError: (e: Error) => toast({ title: 'Failed to create search', description: e.message, variant: 'destructive' }),
  });
}

export function useRunSearch() {
  return useMutation({
    mutationFn: (id: string) => searchesApi.run(id),
    onError: (e: Error) => toast({ title: 'Run search failed', description: e.message, variant: 'destructive' }),
  });
}

export function useDeleteSearch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => searchesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: searchesQueryKey });
      toast({ title: 'Saved search removed' });
    },
    onError: (e: Error) => toast({ title: 'Failed to remove search', description: e.message, variant: 'destructive' }),
  });
}

// ==================== QUESTION ANSWERS ====================
export const questionAnswersQueryKey = ['question-answers'] as const;

export function useQuestionAnswers(filters?: { category?: string; q?: string }) {
  return useQuery({
    queryKey: [...questionAnswersQueryKey, filters],
    queryFn: () => questionAnswersApi.list(filters),
  });
}

export function useCreateQuestionAnswer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { question: string; answer: string; category?: string; notes?: string; tags?: string[] }) =>
      questionAnswersApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: questionAnswersQueryKey });
      toast({ title: 'Q&A added' });
    },
    onError: (e: Error) => toast({ title: 'Failed to add Q&A', description: e.message, variant: 'destructive' }),
  });
}

export function useUpdateQuestionAnswer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; question?: string; answer?: string; category?: string; notes?: string; tags?: string[] }) =>
      questionAnswersApi.update(vars.id, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: questionAnswersQueryKey });
      toast({ title: 'Q&A updated' });
    },
    onError: (e: Error) => toast({ title: 'Failed to update Q&A', description: e.message, variant: 'destructive' }),
  });
}

export function useDeleteQuestionAnswer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => questionAnswersApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: questionAnswersQueryKey });
      toast({ title: 'Q&A removed' });
    },
    onError: (e: Error) => toast({ title: 'Failed to remove Q&A', description: e.message, variant: 'destructive' }),
  });
}

// ==================== JOB ALERTS ====================
export const alertsQueryKey = ['alerts'] as const;

export function useAlerts() {
  return useQuery({ queryKey: alertsQueryKey, queryFn: () => alertsApi.list() });
}

export function useCreateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; query?: string; location?: string | string[]; sources?: string[]; savedSearchId?: string; minMatchScore?: number; remoteOnly?: boolean; isActive?: boolean; notifyInApp?: boolean; notifyEmail?: boolean; intent?: unknown }) =>
      alertsApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: alertsQueryKey });
      toast({ title: 'Alert created' });
    },
    onError: (e: Error) => toast({ title: 'Failed to create alert', description: e.message, variant: 'destructive' }),
  });
}

export function useUpdateAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; name?: string; query?: string; location?: string | string[]; sources?: string[]; savedSearchId?: string; minMatchScore?: number; remoteOnly?: boolean; isActive?: boolean; notifyInApp?: boolean; notifyEmail?: boolean; intent?: unknown }) =>
      alertsApi.update(vars.id, vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: alertsQueryKey });
      toast({ title: 'Alert updated' });
    },
    onError: (e: Error) => toast({ title: 'Failed to update alert', description: e.message, variant: 'destructive' }),
  });
}

export function useDeleteAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => alertsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: alertsQueryKey });
      toast({ title: 'Alert removed' });
    },
    onError: (e: Error) => toast({ title: 'Failed to remove alert', description: e.message, variant: 'destructive' }),
  });
}

export function useRunAlert() {
  return useMutation({
    mutationFn: (id: string) => alertsApi.run(id),
    onError: (e: Error) => toast({ title: 'Alert run failed', description: e.message, variant: 'destructive' }),
  });
}
