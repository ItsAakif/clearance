// React Query hooks for Jobs, Tailor, Applications & BYOK keys.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  jobsApi, tailorApi, applicationsApi, keysApi, profileApi, boardsApi, searchesApi,
  questionAnswersApi, alertsApi, aiApi
} from '@/services/api';
import type {
  ApiKey, CareerProfile, ParseProfileResponse, JobBoard, SavedSearch,
  QuestionAnswer, JobAlert, ApplicationEvent, ApplicationEventType,
  ApplicationStatus, GenerateInterviewAnswerInput, InterviewAnswerCategory
} from '@/services/api';
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
    mutationFn: (vars: { q: string; sources?: string[] }) => jobsApi.search(vars.q, vars.sources),
    onError: (e: Error) => toast({ title: 'Search failed', description: e.message, variant: 'destructive' }),
  });
}

export function useEvaluateJob() {
  return useMutation({
    mutationFn: (vars: { jobId: string; resumeId: string; jobDescription?: string }) =>
      jobsApi.evaluate(vars.jobId, vars.resumeId, vars.jobDescription),
    onError: (e: Error) => toast({ title: 'Evaluation failed', description: e.message, variant: 'destructive' }),
  });
}

// ==================== TAILOR ====================
export function useTailorResume() {
  return useMutation({
    mutationFn: (payload: { jobEvaluationId?: string; jobDescription?: string; resumeId: string; templateId: string; jobListingId?: string }) =>
      tailorApi.create(payload),
    onError: (e: Error) => toast({ title: 'Tailoring failed', description: e.message, variant: 'destructive' }),
  });
}

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

export function useGenerateInterviewAnswer() {
  return useMutation({
    mutationFn: (data: GenerateInterviewAnswerInput) => aiApi.generateInterviewAnswer(data),
    onError: (e: Error) => toast({ title: 'AI answer generation failed', description: e.message, variant: 'destructive' }),
  });
}

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
    mutationFn: (vars: { query?: string; boardIds?: string[] }) => boardsApi.scan(vars.query, vars.boardIds),
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
    mutationFn: (data: { name: string; query: string; location?: string; company?: string; boards?: string[]; minMatchScore?: number; remoteOnly?: boolean; sortBy?: string }) =>
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
    mutationFn: (data: { name: string; query: string; location?: string; sources?: string[]; savedSearchId?: string; minMatchScore?: number; remoteOnly?: boolean; isActive?: boolean; notifyInApp?: boolean; notifyEmail?: boolean }) =>
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
    mutationFn: (vars: { id: string; name?: string; query?: string; location?: string; sources?: string[]; savedSearchId?: string; minMatchScore?: number; remoteOnly?: boolean; isActive?: boolean; notifyInApp?: boolean; notifyEmail?: boolean }) =>
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
