// Jobs, Tailor, Applications & BYOK API services - connected to Clearance backend.
import { apiClient } from "./client";

// ==================== TYPES ====================
export interface JobListingSummary {
  id: string;
  source: string;
  title: string;
  company: string;
  location?: string;
  applyUrl?: string;
  postedAt?: string;
  isActive: boolean;
  skills?: string[];
  workMode?: 'remote' | 'hybrid' | 'onsite' | string;
  employmentType?: string;
}

export interface JobEvaluation {
  id: string;
  overallScore: number;
  recommendation: 'apply' | 'maybe' | 'skip';
  isScam: boolean;
  scores: {
    cvMatch: number;
    levelFit: number;
    compFit: number;
    personalization: number;
    interviewPrep: number;
    legitimacy: number;
  };
  roleSummary?: string;
  reportJson: Record<string, unknown>;
  jobListing?: { title: string; company: string; applyUrl?: string };
}

export type JobSort = 'relevance' | 'matchScore' | 'newest';
export type JobWorkMode = 'all' | 'remote' | 'hybrid' | 'onsite';

export interface JobSearchFilters {
  query: string;
  minMatchScore?: number;
  location?: string;
  company?: string;
  workMode: JobWorkMode;
  sources: string[];
  postedWithin: 'all' | 'day' | 'week' | 'month';
  sortBy: JobSort;
}

export interface JobMatchBreakdown {
  skills?: number;
  experience?: number;
  keywords?: number;
  seniority?: number;
}

export interface NormalizedJobInsights {
  keySkills: string[];
  skillGaps: string[];
  breakdown: JobMatchBreakdown;
  evaluationResults: string[];
}

export interface TailoredResume {
  id: string;
  title: string;
  templateId: string;
  createdAt: string;
  content?: any;
  html?: string;
}

export type ApplicationStatus =
  | 'saved' | 'tailored' | 'applied' | 'interview' | 'offer' | 'rejected' | 'withdrawn' | 'ghosted';

export type ApplicationEventType =
  | 'status_change' | 'note_added' | 'follow_up' | 'interview_scheduled' | 'offer_received' | 'rejected' | 'withdrawn';

export interface ApplicationMatchSummary {
  overallScore: number;
  evaluatedAt: string;
}

export interface ApplicationJobListing {
  title: string;
  company: string;
  location?: string | null;
  description?: string;
  applyUrl?: string | null;
  match?: ApplicationMatchSummary | null;
}

export interface Application {
  id: string;
  status: ApplicationStatus;
  notes?: string | null;
  appliedAt?: string | null;
  followUpAt?: string | null;
  ghostedAt?: string | null;
  withdrawnAt?: string | null;
  createdAt: string;
  jobListingId?: string;
  jobListing?: ApplicationJobListing | null;
  tailoredResume?: { id: string; title: string; templateId: string } | null;
}

export interface ApplicationEvent {
  id: string;
  applicationId: string;
  type: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  title?: string | null;
  description?: string | null;
  scheduledAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

export interface CreateApplicationEventInput {
  type: ApplicationEventType;
  fromStatus?: string;
  toStatus?: string;
  title?: string;
  description?: string;
  scheduledAt?: string;
  completedAt?: string;
}

export interface UpdateApplicationEventInput {
  title?: string | null;
  description?: string | null;
  scheduledAt?: string | null;
  completedAt?: string | null;
}

export interface ApiKey {
  id: string;
  provider: 'openai' | 'groq' | 'openrouter' | 'gemini' | 'tavily' | 'adzuna' | 'jooble' | 'careerjet' | 'firecrawl' | 'crawl4ai' | 'rapidapi';
  label?: string;
  maskedKey: string;
  isActive: boolean;
  lastValidatedAt?: string;
  lastUsedAt?: string;
  failureCount: number;
}

// ==================== JOBS ====================
export const jobsApi = {
  search: (q: string, sources?: string[]) =>
    apiClient.get<JobListingSummary[]>(
      `/jobs/search?q=${encodeURIComponent(q)}${sources?.length ? `&sources=${sources.join(',')}` : ''}`
    ),
  get: (id: string) => apiClient.get<JobListingSummary & { description: string }>(`/jobs/${id}`),
  evaluate: (id: string, resumeId: string, jobDescription?: string) =>
    apiClient.post<JobEvaluation>(`/jobs/${id}/evaluate`, { resumeId, jobDescription }),
  listEvaluations: () => apiClient.get<JobEvaluation[]>('/jobs/evaluations'),
};

// ==================== TAILOR ====================
export const tailorApi = {
  create: (payload: { jobEvaluationId?: string; jobDescription?: string; resumeId: string; templateId: string; jobListingId?: string }) =>
    apiClient.post<TailoredResume>('/tailor', payload),
  list: () => apiClient.get<TailoredResume[]>('/tailor'),
  export: (id: string, format: 'pdf' | 'docx') =>
    apiClient.download(`/tailor/${id}/export?format=${format}`),
};

// ==================== APPLICATIONS ====================
export const applicationsApi = {
  create: (payload: { jobListingId: string; tailoredResumeId?: string; status?: string; notes?: string }) =>
    apiClient.post<Application>('/applications', payload),
  list: () => apiClient.get<Application[]>('/applications'),
  get: (id: string) => apiClient.get<Application>(`/applications/${id}`),
  update: (id: string, payload: { status?: string; notes?: string; appliedAt?: string; followUpAt?: string | null; ghostedAt?: string | null; withdrawnAt?: string | null }) =>
    apiClient.patch<Application>(`/applications/${id}`, payload),
  remove: (id: string) => apiClient.delete(`/applications/${id}`),
  listEvents: (applicationId: string) =>
    apiClient.get<ApplicationEvent[]>(`/applications/${applicationId}/events`),
  createEvent: (applicationId: string, payload: CreateApplicationEventInput) =>
    apiClient.post<ApplicationEvent>(`/applications/${applicationId}/events`, payload),
  updateEvent: (applicationId: string, eventId: string, payload: UpdateApplicationEventInput) =>
    apiClient.patch<ApplicationEvent>(`/applications/${applicationId}/events/${eventId}`, payload),
};

// ==================== BYOK KEYS ====================
export const keysApi = {
  list: () => apiClient.get<ApiKey[]>('/keys'),
  create: (provider: ApiKey['provider'], apiKey: string, label?: string) =>
    apiClient.post<ApiKey>('/keys', { provider, apiKey, label }),
  remove: (id: string) => apiClient.delete(`/keys/${id}`),
};

// ==================== CAREER PROFILE ====================
export interface CareerProfile {
  id?: string;
  userId?: string;
  targetRoles?: string[];
  seniority?: 'junior' | 'mid' | 'senior' | 'staff' | 'lead' | 'principal';
  minSalary?: number;
  maxSalary?: number;
  currency?: string;
  locationPref?: string;
  remoteOnly?: boolean;
  topSkills?: string[];
  industries?: string[];
  redFlags?: string[];
  proofPoints?: string[];
  summary?: string;
  parsedFromResumeId?: string;
  isComplete?: boolean;
}

export interface ParseProfileResponse {
  suggested: Partial<CareerProfile>;
  missing: string[];
}

export const profileApi = {
  get: () => apiClient.get<CareerProfile | null>('/profile'),
  upsert: (data: Partial<CareerProfile>) => apiClient.put<CareerProfile>('/profile', data),
  parse: (resumeId: string) =>
    apiClient.post<ParseProfileResponse>(`/profile/parse-from-resume/${resumeId}`, {}),
};

// ==================== JOB BOARDS ====================
export type JobBoardType =
  | 'greenhouse' | 'ashby' | 'lever' | 'workday' | 'rss' | 'json' | 'search'
  | 'smartrecruiters' | 'recruitee' | 'personio' | 'jobicy' | 'hnalgolia' | 'scraper' | 'aggregator';

export interface JobBoard {
  id: string;
  userId?: string;
  type: JobBoardType;
  name: string;
  boardId?: string | null;
  feedUrl?: string | null;
  searchQuery?: string | null;
  searchSite?: string | null;
  scraperProvider?: string | null;
  scraperLocation?: string | null;
  scraperResults?: number | null;
  scraperUseProxy?: boolean;
  aggregatorProvider?: string | null;
  aggregatorLocation?: string | null;
  isActive?: boolean;
  lastScannedAt?: string;
  createdAt?: string;
}

export interface JobBoardCreateInput {
  type: JobBoardType;
  name: string;
  boardId?: string;
  feedUrl?: string;
  searchQuery?: string;
  searchSite?: string;
  scraperProvider?: string;
  scraperLocation?: string;
  scraperResults?: number;
  scraperUseProxy?: boolean;
  aggregatorProvider?: string;
  aggregatorLocation?: string;
  isActive?: boolean;
}

export const boardsApi = {
  list: () => apiClient.get<JobBoard[]>('/boards'),
  create: (data: JobBoardCreateInput) =>
    apiClient.post<JobBoard>('/boards', data),
  update: (id: string, data: Partial<JobBoardCreateInput>) =>
    apiClient.patch<JobBoard>(`/boards/${id}`, data),
  remove: (id: string) => apiClient.delete(`/boards/${id}`),
  scan: (query?: string, boardIds?: string[]) =>
    apiClient.get<JobListingSummary[]>(
      `/jobs/scan?${query ? `query=${encodeURIComponent(query)}&` : ''}${boardIds?.length ? `boardIds=${boardIds.join(',')}` : ''}`
    ),
};

// ==================== SAVED SEARCHES ====================
export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  location?: string;
  company?: string;
  boards?: string[];
  minMatchScore?: number;
  remoteOnly?: boolean;
  sortBy?: string;
  lastRunAt?: string;
  matchCount?: number;
  createdAt?: string;
}

export const searchesApi = {
  list: () => apiClient.get<SavedSearch[]>('/searches'),
  create: (data: { name: string; query: string; location?: string; company?: string; boards?: string[]; minMatchScore?: number; remoteOnly?: boolean; sortBy?: string }) =>
    apiClient.post<SavedSearch>('/searches', data),
  update: (id: string, data: { name?: string; query?: string; location?: string; company?: string; boards?: string[]; minMatchScore?: number; remoteOnly?: boolean; sortBy?: string }) =>
    apiClient.patch<SavedSearch>(`/searches/${id}`, data),
  remove: (id: string) => apiClient.delete(`/searches/${id}`),
  run: (id: string) => apiClient.post<JobListingSummary[]>(`/searches/${id}/run`, {}),
};

// ==================== QUESTION ANSWERS ====================
export interface QuestionAnswerFilters {
  category?: string;
  q?: string;
}

export const questionAnswersApi = {
  list: (filters?: QuestionAnswerFilters) => {
    const params = new URLSearchParams();
    if (filters?.category) params.set('category', filters.category);
    if (filters?.q) params.set('q', filters.q);
    const qs = params.toString();
    return apiClient.get<QuestionAnswer[]>(`/question-answers${qs ? `?${qs}` : ''}`);
  },
  create: (payload: { question: string; answer: string; category?: string; notes?: string; tags?: string[] }) =>
    apiClient.post<QuestionAnswer>('/question-answers', payload),
  update: (id: string, payload: { question?: string; answer?: string; category?: string; notes?: string; tags?: string[] }) =>
    apiClient.patch<QuestionAnswer>(`/question-answers/${id}`, payload),
  remove: (id: string) => apiClient.delete(`/question-answers/${id}`),
};

// ==================== JOB ALERTS ====================
export interface JobAlert {
  id: string;
  savedSearchId?: string | null;
  name: string;
  query: string;
  location?: string | null;
  sources?: string[] | null;
  minMatchScore?: number | null;
  remoteOnly: boolean;
  isActive: boolean;
  lastRunAt?: string | null;
  lastMatchCount: number;
  notifyInApp: boolean;
  notifyEmail: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface JobComparisonItem extends JobListingSummary {
  description: string;
  expiresAt?: string;
  lastVerifiedAt?: string;
}

export const alertsApi = {
  list: () => apiClient.get<JobAlert[]>('/job-alerts'),
  create: (payload: { name: string; query: string; location?: string; sources?: string[]; savedSearchId?: string; minMatchScore?: number; remoteOnly?: boolean; isActive?: boolean; notifyInApp?: boolean; notifyEmail?: boolean }) =>
    apiClient.post<JobAlert>('/job-alerts', payload),
  update: (id: string, payload: { name?: string; query?: string; location?: string; sources?: string[]; savedSearchId?: string; minMatchScore?: number; remoteOnly?: boolean; isActive?: boolean; notifyInApp?: boolean; notifyEmail?: boolean }) =>
    apiClient.patch<JobAlert>(`/job-alerts/${id}`, payload),
  remove: (id: string) => apiClient.delete(`/job-alerts/${id}`),
  run: (id: string) => apiClient.post<{ matchCount: number; results: unknown[] }>(`/job-alerts/${id}/run`, {}),
};
