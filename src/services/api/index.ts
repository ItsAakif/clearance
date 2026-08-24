// Central API exports
export { resumeApi } from "./resume";
export { atsApi } from "./ats";
export { authApi } from "./auth";
export { templateApi } from "./templates";
export { adminApi } from "./admin";
export { jobsApi, tailorApi, applicationsApi, keysApi, profileApi, boardsApi, searchesApi, questionAnswersApi, alertsApi } from "./jobs";
export { aiApi } from "./ai";
export type {
  JobListingSummary, JobEvaluation, TailoredResume, Application, ApplicationEvent, ApplicationEventType,
  ApplicationStatus, ApplicationMatchSummary, ApplicationJobListing, CreateApplicationEventInput, UpdateApplicationEventInput,
  ApiKey, CareerProfile, ParseProfileResponse, JobBoard, SavedSearch, QuestionAnswer, JobAlert, JobComparisonItem, QuestionAnswerFilters,
  JobSort, JobWorkMode, JobSearchFilters, JobMatchBreakdown, NormalizedJobInsights
} from "./jobs";
export type { InterviewAnswerCategory, GenerateInterviewAnswerInput, GenerateInterviewAnswerResponse } from "./ai";
export { apiClient, ApiClientError } from "./client";
