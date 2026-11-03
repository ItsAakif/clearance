// Central API exports
export { resumeApi, uploadedFilesApi } from "./resume";
export { careerApi } from "./career";
export type {
  CareerClaim, CareerClaimCounts, CareerClaimKind, CareerClaimProvenance, CareerClaimStatus,
  CareerCreateClaimResponse, CareerDecisionResult, CareerEnrichmentReport, CareerEvidenceKind,
  CareerEvidenceSource, CareerImportResult, CareerProfileResponse, CareerProfileSummary,
  CareerVerification, CareerClaimsResponse,
} from "./career";
// T1110: `services/api/ats.ts` is GONE. It was the client for `ATSReport.overallScore` and
// `JobMatch.matchScore`, and its `transformReport` copied both out of the wire. The backend no
// longer returns either member (`routes/ats.ts` projects them out), so the client had nothing
// honest left to map - and `buildFromJd` in it called `POST /ai/build-from-jd`, which is now a
// 410. The deterministic scanner itself is untouched and still runs server-side as an internal
// signal (FREEZE B-16/B-17/B-18).
// T1070: the evidence-level match report. Exported with NO score-shaped member anywhere -
// `features/match/noScore.test.ts` fails if one is added to these types.
export { matchApi } from "./match";
export type {
  MatchAction, MatchCounts, MatchDecisionResult, MatchDecisionVerification, MatchEvidence,
  MatchEvidenceLevel, MatchGap, MatchPotentialMatch, MatchPotentialStatus, MatchProposalStage,
  MatchReport, MatchRequirement, JobAnalysisResponse,
} from "./match";
// T1100: the two-day project engine. Exported with no verdict-shaped member anywhere: the run
// reports four integer counts over named things, a three-word difficulty and the two-day budget
// a candidate claims - and `features/project-discovery/noVerdict.test.ts` fails if one is added.
export { projectDiscoveryApi } from "./projectDiscovery";
export type {
  ExcludedGap, ProjectClaimVerification, ProjectDecision, ProjectDiscovery,
  ProjectDiscoveryCounts, ProjectDiscoveryInput, ProjectGap, ProjectOpportunity, ProjectPlan,
  ProjectProposalStage, ProjectReference, ProjectReferenceKind, ProjectResearchStage,
  ProjectStatus, TeachableGap,
} from "./projectDiscovery";
// T1090: the DERIVED interview risks and the grounded questions. Exported with no
// verdict-shaped member anywhere and with `modelAnswer: string | null` rather than `string`,
// because "no answer was stored" and "an empty answer was stored" are different states -
// `features/interview-prep/noVerdict.test.ts` fails if either is changed.
export { interviewApi } from "./interview";
export type {
  InterviewAnchor, InterviewAnchorSource, InterviewAnswerStage, InterviewPrep,
  InterviewQuestion, InterviewQuestionCategory, InterviewRisk, InterviewRiskKind,
  InterviewSeverity, PrepareInterviewInput,
} from "./interview";
export { authApi } from "./auth";
export { templateApi } from "./templates";
export { adminApi } from "./admin";
export { jobsApi, applicationsApi, keysApi, profileApi, boardsApi, searchesApi, questionAnswersApi, alertsApi, readEvaluateError, readNormalizeError } from "./jobs";
export { insightsApi } from "./insights";
export type { CatalogueInsights } from "./insights";
export { settingsApi, LLM_MODEL_PROVIDERS } from "./settings";
export { catalogueApi } from "./catalogue";
export type {
  CatalogueSnapshotImportResult,
  CatalogueSnapshotStatus,
  CatalogueSnapshotSyncResult,
} from "./catalogue";
export type {
  JobListingSummary, JobEvaluation, TailoredResume, Application, ApplicationEvent, ApplicationEventType,
  ApplicationStatus, ApplicationMatchSummary, ApplicationJobListing, CreateApplicationEventInput, UpdateApplicationEventInput,
  ApiKey, CareerProfile, ParseProfileResponse, JobBoard, JobBoardType, JobBoardCreateInput, SavedSearch, QuestionAnswer, JobAlert, JobComparisonItem, QuestionAnswerFilters,
  JobSort, JobWorkMode, JobSearchFilters, JobMatchBreakdown, NormalizedJobInsights, LocationSuggestion, LocationSuggestionRow, StoredLocation, InterviewAnswerCategory,
  EvaluateErrorCode, BoardRunStatus, BoardRunState, RunSnapshot, PostedWithinParam, JobSearchMode,
  NormalizeErrorCode, NormalizeResult, NormalizeBatchItemResult, NormalizeBatchResponse
} from "./jobs";
export type { UploadedFileSummary } from "./resume";
export type { SeniorityValue, InferredLevel } from "../../features/jobs/seniority";
// T1110: `services/api/ai.ts` is GONE (FREEZE A-35). Its only member called
// `POST /ai/generate-interview-answer`, which is now a 410; the successor is the V2 interview-prep
// surface at `/app/interview-prep`, whose questions are grounded in the user's own evidence.
//
// T1101: `Resume.lastATSScore` is dropped from the CLIENT type below. The column still exists and
// `routes/ats.ts` still writes it; nothing reads it for display. Removing it from the wire type
// is what makes "a score came back and something might render it" impossible rather than merely
// unlikely.
export type { SourceGroup } from "../../features/jobs/sourceGroups";
// T1110: `services/api/ai.ts` is GONE (FREEZE A-35). Its only member called
// `POST /ai/generate-interview-answer`, which is now a 410; the successor is the V2 interview-prep
// surface at `/app/interview-prep`, whose questions are grounded in the user's own evidence.
export type { ModelSettings, LlmModelProvider, ProviderPreset, ProviderGroup } from "./settings";
export { apiClient, ApiClientError } from "./client";
