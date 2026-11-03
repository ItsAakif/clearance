// Jobs, Tailor, Applications & BYOK API services - connected to Clearance backend.
import { apiClient } from "./client";
import type { SeniorityValue } from "../../features/jobs/seniority";
import type { SourceGroup } from "../../features/jobs/sourceGroups";
import type { SweepPoliteness } from "../../features/jobs/runProgress";
// Generated board-type contract (T625, ADR-031): the registry-emitted
// shared/job-sources.json is the single source of truth for board types.
import sourceContract from "../../../shared/job-sources.json";
import { serialiseCatalogueParams } from "../../features/jobs/catalogueParams";

// ==================== TYPES ====================
/**
 * Wave-3 date-provenance vocabulary, mirrored from
 * `backend/src/discovery/provenance.ts` (`PostedAtSource`). A local type
 * alias, not a runtime list: source ids and their ordering still come only
 * from the generated contract (`shared/job-sources.json`).
 */
export type JobPostedAtSource =
  | 'source-posted'
  | 'source-updated'
  | 'page-derived'
  | 'discovery-at'
  | 'index-date'
  | 'unknown';

/**
 * One wave-3 source observation, mirrored from
 * `backend/src/discovery/dedupe.ts` (`SourceRef`).
 */
export interface JobSourceRef {
  source: string;
  sourceUrl?: string;
  applyUrl?: string;
  externalId?: string;
}

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
  ghost?: { level: 'clear' | 'watch'; evidence: string[] };
  // Wave 7 (T743) additive search-item flags: `cancelled` (the run was
  // cancelled, results are partial-but-kept) and `partial` (the run's boards
  // are not all `ok`). OPTIONAL so rows shaped by an older backend still
  // type-check. Never drive progress rendering off these; the run snapshot
  // (RunSnapshot.cancelled / BoardRunState.status) owns progress state.
  cancelled?: boolean;
  partial?: boolean;
  // Wave 10 (T803) additive provenance fields, mirroring the wave-3 listing
  // response (`backend/src/discovery/persistence.ts` `shapeListingResponse`).
  // OPTIONAL so rows shaped by an older backend still type-check. `source`
  // keeps its name, type and meaning (the legacy source filter reads it);
  // `postedAtSource` uses the exact wave-3 vocabulary above. `sources`
  // accepts plain ids and `{ source }` refs because the wire carries
  // `SourceRef` objects. `firstSeenAt` is intentionally absent: wave 3
  // stamps it in storage but does not emit it on listing responses.
  sources?: Array<string | JobSourceRef>;
  postedAtSource?: JobPostedAtSource;
}

// T1101: THE DERIVED VERDICT IS NOT IN THIS TYPE, and neither is the six-number breakdown. The
// backend still computes all seven and still stores them on `JobEvaluation` (FREEZE B-16 keeps the
// evaluator as an internal signal), but `POST /jobs/:id/evaluate` and `GET /jobs/evaluations` now
// project them away, so declaring them here would make the type lie about the wire - which is the
// reason the carve-out that used to sit in `noDerivedScore.test.ts` (`RANKING_MEMBERS`) is gone.
// What a caller gets is the decision, the scam fact and the evaluator's prose. See
// `backend/src/routes/jobs.ts` `JobEvaluationWire` / `toEvaluationWire`.
export interface JobEvaluation {
  id: string;
  recommendation: 'apply' | 'maybe' | 'skip';
  isScam: boolean;
  roleSummary?: string | null;
  reportJson: Record<string, unknown>;
  jobListing?: { title: string; company: string; applyUrl?: string | null } | null;
}

export type JobSort = 'relevance' | 'matchScore' | 'newest';
export type JobWorkMode = 'all' | 'remote' | 'hybrid' | 'onsite';

/**
 * Search-depth vocabulary shared by filters, controls and API requests.
 * `fast` remains the backend default for callers that omit `mode`, but the
 * product switch intentionally exposes only Standard, Deep and Full
 * (ADR-033 decision 1).
 */
export type JobSearchMode = 'fast' | 'standard' | 'deep' | 'full';

export interface JobSearchFilters {
  query: string;
  minMatchScore?: number;
  location: string[];
  company?: string;
  workMode: JobWorkMode;
  sources: string[];
  postedWithin: 'all' | 'day' | 'week' | 'month';
  sortBy: JobSort;
  /**
   * Client-side only by design: the backend has no level data, so this is
   * never sent as a request parameter. Starts empty on every run (D2,
   * reset-by-default); the confirm-gated profile match may set it per run.
   */
  experienceLevel: SeniorityValue[];
  /**
   * Wave 10 (T801): intent-expressible fields surfaced in the filter sheet.
   * Every existing field above keeps its meaning; `sources` stays the
   * source-id filter. `sourceGroups` holds the intent group names whose
   * member ids are all selected in `sources` (a group toggles a set of
   * source ids); `mode` uses the same vocabulary as the three-mode switch.
   */
  roles: string[];
  skills: string[];
  exclusions: string[];
  companies: string[];
  sourceGroups: SourceGroup[];
  mode: JobSearchMode;
}

// Persisted rows may hold a legacy single string or a JSON-encoded array (ADR-008).
export type StoredLocation = string | string[] | null;

/** Wire shape of one `GET /jobs/locations` row. The server contract, unchanged. */
export interface LocationSuggestionRow { value: string; count: number }

/**
 * UI shape of one suggestion, whatever produced it. Static city rows have no `count`
 * and carry a richer `display`; see the location spec's "Static city list" section.
 */
export interface LocationSuggestion {
  /** The string committed as a chip and used for matching. Never a display string. */
  value: string;
  /** Richer row text, e.g. "Pune, Maharashtra, IN". Falls back to `value`. */
  display?: string;
  /** Listing-derived rows carry a frequency. Static city rows do not. */
  count?: number;
  /** Which source produced the row. Drives ordering and the muted count text. */
  source: 'city' | 'listing';
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

// T1101: `overallScore` is GONE from this summary type. It was read by exactly two renders -
// `ApplicationPipeline`'s `Match: {…}` line and `JobComparisonDialog`'s - and both are gone. The
// evaluation itself is untouched: the backend still computes and stores `JobEvaluation.overallScore`,
// and `minMatchScore` still filters and sorts on it. Presenting it is what 06 sec. E.6 forbids;
// computing it is what FREEZE B-16 requires. Note the same number is no longer even ON THE WIRE -
// `POST /jobs/:id/evaluate` projects it away - so this type is now honest about both.
export interface ApplicationMatchSummary {
  evaluatedAt: string;
}

export interface ApplicationJobListing {
  title: string;
  company: string;
  location?: string | null;
  description?: string;
  sourceUrl?: string | null;
  applyUrl?: string | null;
  match?: ApplicationMatchSummary | null;
  /**
   * The derived catalogue row (T1101) carries the facts the posting itself does not repeat:
   * work mode and the advertised salary range. Both are optional because older rows predate
   * the backfill; the workspace omits a meta item rather than inventing one.
   */
  searchDocument?: {
    workMode?: string | null;
    salary?: {
      min?: number | null;
      max?: number | null;
      currency?: string | null;
    } | null;
  } | null;
}

export interface ApplicationMatch {
  direct: number;
  contextual: number;
  potential: number;
  unsupported: number;
  total: number;
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
  job?: ApplicationJobListing | null;
  match?: ApplicationMatch | null;
  matchGaps?: unknown[] | null;
  tailoredResume?: {
    id: string;
    title: string;
    templateId: string;
    /**
     * READ-ONLY resolution of the resume this tailored version came from. There is no
     * `Application.resumeId` column (see `backend/prisma/schema.prisma`), so this is the only
     * honest path from an application to a renderable resume.
     */
    sourceResumeId?: string | null;
  } | null;
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
  // Registry LLM ids (groq/openai/…/lmstudio), `custom:<slug>`, or non-LLM
  // providers (tavily/exa/adzuna/usajobs/reed/findwork/firecrawl/crawl4ai/rapidapi).
  // careerjet/jooble may still appear on stored rows (retired, deletable).
  provider: string;
  label?: string;
  maskedKey: string;
  isActive: boolean;
  lastValidatedAt?: string;
  lastUsedAt?: string;
  failureCount: number;
}

// ==================== DISCOVERY RUNS ====================
// Mirrors backend/src/jobSources/discoveryRuns.ts (ADR-013). Snapshot-only:
// polled via GET /jobs/runs/:runId, never subscribed or scheduled.
// Wave-7 fields (tier/group/truncated/skippedReason/unitKind, mode/cancelled/
// intent) and the wave-9 evaluation summary are ADDITIVE and OPTIONAL, mirroring
// backend/src/jobSources/discoveryRuns.ts field-for-field, so a snapshot written
// by an older code path still type-checks and still renders (T802).
export type BoardRunStatus = 'pending' | 'running' | 'ok' | 'failed' | 'needs_key' | 'cancelled';

export interface BoardRunState {
  boardId: string;
  name: string;
  type: string;
  status: BoardRunStatus;
  resultCount: number;
  latencyMs?: number;
  error?: string;
  tier?: number;
  group?: string;
  truncated?: boolean;
  skippedReason?: string;
  unitKind?: string;
}

/**
 * Wave 9 (T783) evaluation summary carried on the run snapshot. Mirrors the
 * backend `RunEvaluationSummary` field-for-field. Counts and the reason only -
 * never prompts, keys, payloads, or description text.
 */
export interface RunEvaluationSummary {
  requested: number;
  completed: number;
  skipped: number;
  reason?: string;
  estimate: { calls: number; approxTokens: number };
}

export interface RunSnapshot {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  boards: BoardRunState[];
  totalListings: number;
  mode?: string;
  cancelled?: boolean;
  intent?: unknown;
  evaluation?: RunEvaluationSummary;
  // Full-scan-only additive state (ADR-033 decision 4). Optional so snapshots
  // produced by every other mode and by older backends keep their exact shape.
  cursor?: string | null;
  registryProcessed?: number;
  registryTotal?: number;
  // Deep-only additive catalogue-sweep summary. Optional so every other mode
  // and older snapshots keep their exact shape.
  sweep?: RunSweepSummary;
}

/** Deep-search catalogue sweep summary (mirrors the backend field-for-field). */
export interface RunSweepSummary {
  boards: number;
  ok: number;
  failed: number;
  rowsFetched: number;
  rowsPersisted: number;
  exhausted: boolean;
  error?: string;
}

export type PostedWithinParam = 'day' | 'week' | 'month';

/** One bounded unit excluded from a Full-scan batch, with its honest reason. */
export interface FullScanSkip {
  unitId: string;
  reason: string;
}

/** Response returned by one bounded `GET /jobs/full-scan` batch. */
export interface FullScanBatchResponse {
  results: JobListingSummary[];
  runId: string;
  hasMore: boolean;
  nextCursor: string | null;
  processed: number;
  total: number;
  persisted: number;
  skipped: FullScanSkip[];
  cancelled: boolean;
  // T911 additive: the bounded per-batch rate-limit marker the backend already
  // always sends (`mode`, `signals`, `blocks`, `deferred`, `wiringOk`). The
  // client type previously omitted it and the UI dropped the signal silently.
  // Optional so an older backend response shape keeps type-checking.
  politeness?: SweepPoliteness;
}

/** Additive request fields accepted by the Full-scan batch endpoint. */
export interface FullScanOptions {
  runId: string;
  after?: string;
  q: string;
  sources?: string[];
  postedWithin?: PostedWithinParam;
  location?: string[];
  company?: string;
  roles?: string[];
  skills?: string[];
  exclusions?: string[];
  companies?: string[];
  sourceGroups?: string[];
}

function setCommaSeparatedParam(
  params: URLSearchParams,
  key: string,
  values: readonly string[] | undefined,
): void {
  const cleaned = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (cleaned.length > 0) params.set(key, cleaned.join(','));
}

// ==================== CATALOGUE BROWSE (wire shape) ====================
// Mirrors `backend/src/search/document.ts` (`SearchDocument`) and
// `backend/src/search/query.ts` (`CatalogueFacets`). One row already carries
// every display field; no join or client-side mapping is needed beyond the
// small adapter the detail panel uses.
export type CatalogueWorkMode = 'remote' | 'hybrid';
export type CatalogueSeniority =
  | 'junior' | 'mid' | 'senior' | 'staff' | 'lead' | 'principal';
export type CatalogueSpecialization =
  | 'data-scientist' | 'data-analyst' | 'devops-engineer' | 'security-engineer'
  | 'qa-engineer' | 'mobile-engineer' | 'fullstack-engineer' | 'frontend-engineer'
  | 'backend-engineer' | 'engineering-manager' | 'product-manager' | 'designer'
  | 'marketing' | 'software-engineer';
export type CatalogueRegion =
  | 'us' | 'uk' | 'eu' | 'latam' | 'mena' | 'africa' | 'apac' | 'cis';
export type CatalogueSalaryCurrency = 'USD' | 'EUR' | 'GBP';
export type CatalogueSort = 'newest' | 'relevance';
export type CataloguePostedWithin = 1 | 3 | 7 | 14 | 30;

export interface CatalogueSalary {
  min: number;
  max: number;
  currency: CatalogueSalaryCurrency;
}

/** The browse wire shape; exactly what the backend stores in `searchDocument`. */
export interface SearchDocument {
  id: string;
  title: string;
  company: string;
  location: string | null;
  source: string;
  sourceUrl: string | null;
  applyUrl: string | null;
  postedAt: string | null;
  firstSeenAt: string | null;
  isActive: boolean;
  workMode: CatalogueWorkMode | null;
  seniority: CatalogueSeniority | null;
  specialization: CatalogueSpecialization | null;
  skills: string[];
  salary: CatalogueSalary | null;
  region: CatalogueRegion | null;
  descriptionExcerpt: string;
  docVersion: string;
  ghost?: { level: 'clear' | 'watch'; evidence: string[] };
}

export interface CatalogueFacets {
  region: Record<string, number>;
  workMode: Record<string, number>;
  seniority: Record<string, number>;
  specialization: Record<string, number>;
  skills: Record<string, number>;
  source: Record<string, number>;
  postedWithin: Record<string, number>;
}

export interface CatalogueMeta {
  total: number;
  page: number;
  limit: number;
  facets: CatalogueFacets;
}

export interface CatalogueResponse {
  data: SearchDocument[];
  meta: CatalogueMeta;
}

/** Query parameters accepted by `GET /jobs/catalogue`. */
export interface CatalogueParams {
  q?: string;
  location?: string;
  workMode?: readonly string[];
  seniority?: readonly string[];
  specialization?: readonly string[];
  skills?: readonly string[];
  salaryMin?: number;
  postedWithin?: number;
  source?: readonly string[];
  company?: string;
  sort?: CatalogueSort;
  page?: number;
  limit?: number;
}

// ==================== JOBS ====================
export const jobsApi = {
  search: (q: string, sources?: string[], opts?: { runId?: string; postedWithin?: PostedWithinParam; location?: string[]; company?: string; mode?: JobSearchMode; roles?: string[]; skills?: string[]; exclusions?: string[]; companies?: string[]; sourceGroups?: string[] }) => {
    const params = new URLSearchParams();
    params.set('q', q);
    if (sources?.length) params.set('sources', sources.join(','));
    if (opts?.runId) params.set('runId', opts.runId);
    if (opts?.postedWithin) params.set('postedWithin', opts.postedWithin);
    setCommaSeparatedParam(params, 'location', opts?.location);
    const company = opts?.company?.trim();
    if (company) params.set('company', company);
    // ADR-033: `/jobs/search` carries only the two bounded product modes.
    // Omitting `mode` is the frozen legacy fast default. Full is rejected as
    // unknown on this route and belongs exclusively to `/jobs/full-scan`,
    // so forwarding it here would silently run a fast search instead.
    if (opts?.mode === 'standard' || opts?.mode === 'deep') {
      params.set('mode', opts.mode);
    }
    // Wave 11 (T823): additive intent fields from the T801 filter sheet.
    // Each rides the query comma-joined only when non-empty; omission keeps
    // the legacy shape valid (same additivity rule as `mode` above, wave-11
    // acceptance criterion 8). The legacy routes derive structure from
    // q/location/company/sources today and ignore these keys (never a 400),
    // so they are contract-ready for when forwarding lands - like `mode`
    // was before its forwarding landed. Never an `evaluate`/AI field here.
    setCommaSeparatedParam(params, 'roles', opts?.roles);
    setCommaSeparatedParam(params, 'skills', opts?.skills);
    setCommaSeparatedParam(params, 'exclusions', opts?.exclusions);
    setCommaSeparatedParam(params, 'companies', opts?.companies);
    setCommaSeparatedParam(params, 'sourceGroups', opts?.sourceGroups);
    return apiClient.get<JobListingSummary[]>(`/jobs/search?${params.toString()}`);
  },
  fullScan: (opts: FullScanOptions): Promise<FullScanBatchResponse> => {
    const params = new URLSearchParams();
    params.set('runId', opts.runId);
    if (opts.after) params.set('after', opts.after);
    params.set('q', opts.q);
    if (opts.sources?.length) params.set('sources', opts.sources.join(','));
    if (opts.postedWithin) params.set('postedWithin', opts.postedWithin);
    setCommaSeparatedParam(params, 'location', opts.location);
    const company = opts.company?.trim();
    if (company) params.set('company', company);
    setCommaSeparatedParam(params, 'roles', opts.roles);
    setCommaSeparatedParam(params, 'skills', opts.skills);
    setCommaSeparatedParam(params, 'exclusions', opts.exclusions);
    setCommaSeparatedParam(params, 'companies', opts.companies);
    setCommaSeparatedParam(params, 'sourceGroups', opts.sourceGroups);
    // Full is route-exclusive, so this request deliberately carries no `mode`
    // key. Every optional intent field is omitted when empty, matching search.
    return apiClient.get<FullScanBatchResponse>(`/jobs/full-scan?${params.toString()}`);
  },
  /**
   * Faceted catalogue browse. `GET /jobs/catalogue` returns the rows and the
   * facets from the SAME filtered set, so the rail always describes the
   * current query. Serialisation lives in the pure `buildCatalogueQueryString`
   * helper so the client and its tests share one wire shape.
   */
  catalogue: (params: CatalogueParams = {}) => {
    const query = serialiseCatalogueParams(params);
    return apiClient.get<CatalogueResponse>(`/jobs/catalogue${query ? `?${query}` : ''}`);
  },
  runStatus: (runId: string) => apiClient.get<RunSnapshot>(`/jobs/runs/${runId}`),
  // Wave 10 (T804): cancel control for the T743 endpoint. POST
  // /jobs/runs/:runId/cancel is auth-scoped and idempotent; unknown or
  // foreign runs answer 404 and surface through the mutation error state.
  cancelRun: (runId: string) =>
    apiClient.post<RunSnapshot>(`/jobs/runs/${encodeURIComponent(runId)}/cancel`, {}),
  get: (id: string) => apiClient.get<JobListingSummary & { description: string }>(`/jobs/${id}`),
  getMd: (id: string) =>
    apiClient.get<JobListingSummary & { description: string; descriptionMd: string | null; descriptionMdHash: string | null }>(`/jobs/${id}?format=md`),
  normalize: (id: string) => apiClient.post<NormalizeResult>(`/jobs/${id}/normalize`, {}),
  normalizeBatch: (ids: string[]) =>
    apiClient.post<NormalizeBatchResponse>('/jobs/normalize', { ids }),
  locations: (q?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    return apiClient
      .get<{ locations: LocationSuggestionRow[] }>(`/jobs/locations${qs ? `?${qs}` : ''}`)
      .then((d) => d.locations ?? [])
      .catch((e: unknown) => {
        // Stale backend or unknown route: /locations fell through to /:id
        // ('Job Listing not found') or missed the /api mount ('Not found').
        // Either way the city asset still works offline, so fail soft.
        if (e && typeof e === 'object' && (e as { statusCode?: number }).statusCode === 404) return [];
        throw e;
      });
  },
  evaluate: (id: string, resumeId: string, jobDescription?: string) =>
    apiClient.post<JobEvaluation>(`/jobs/${id}/evaluate`, { resumeId, jobDescription }),
  listEvaluations: () => apiClient.get<JobEvaluation[]>('/jobs/evaluations'),
};

// ==================== EVALUATE ERRORS ====================
// Distinct codes returned by POST /jobs/:id/evaluate (see backend
// mapEvaluateErrorToResponse): posting_closed (409), llm_key_missing (409),
// no_description (400), rate_limited (429). The apiClient preserves the
// server `code` on the thrown error; this helper reads it defensively.
export type EvaluateErrorCode =
  | 'posting_closed'
  | 'llm_key_missing'
  | 'no_description'
  | 'rate_limited';

const EVALUATE_ERROR_FALLBACK =
  'Evaluation failed. You may need to add your own LLM key in Settings (BYOK).';

function isEvaluateErrorCode(value: unknown): value is EvaluateErrorCode {
  return (
    value === 'posting_closed' ||
    value === 'llm_key_missing' ||
    value === 'no_description' ||
    value === 'rate_limited'
  );
}

export function readEvaluateError(e: unknown): {
  message: string;
  code?: EvaluateErrorCode;
} {
  if (!e || typeof e !== 'object') {
    return { message: EVALUATE_ERROR_FALLBACK };
  }
  const rec = e as Record<string, unknown>;
  const rawMessage = rec.message;
  const message =
    typeof rawMessage === 'string' && rawMessage.length > 0
      ? rawMessage
      : EVALUATE_ERROR_FALLBACK;
  const rawCode = rec.code;
  if (isEvaluateErrorCode(rawCode)) {
    return { message, code: rawCode };
  }
  return { message };
}

// ==================== NORMALIZE ERRORS ====================
// Distinct codes returned by POST /jobs/:id/normalize, POST /jobs/normalize
// and GET /jobs/:id?format=md (see backend mapNormalizeErrorToResponse):
// no_description (400), llm_key_missing (409), rate_limited (429),
// normalization_failed (502), not_found (batch per-item). Same defensive
// code-reader style as readEvaluateError above.
export type NormalizeErrorCode =
  | 'no_description'
  | 'llm_key_missing'
  | 'rate_limited'
  | 'normalization_failed'
  | 'not_found';

export interface NormalizeResult {
  markdown: string;
  title: string | null;
  company: string | null;
  location: string | null;
  sections: Partial<Record<'summary' | 'responsibilities' | 'requirements' | 'benefits' | 'compensation', string[]>>;
  cached: boolean;
  model: string;
  provider: string;
}

export interface NormalizeBatchItemResult {
  id: string;
  ok: boolean;
  markdown?: string;
  cached?: boolean;
  errorCode?: string;
}

export interface NormalizeBatchResponse {
  results: NormalizeBatchItemResult[];
}

const NORMALIZE_ERROR_FALLBACK =
  'Formatting failed. The original description is unchanged.';

function isNormalizeErrorCode(value: unknown): value is NormalizeErrorCode {
  return (
    value === 'no_description' ||
    value === 'llm_key_missing' ||
    value === 'rate_limited' ||
    value === 'normalization_failed' ||
    value === 'not_found'
  );
}

export function readNormalizeError(e: unknown): {
  message: string;
  code?: NormalizeErrorCode;
} {
  if (!e || typeof e !== 'object') {
    return { message: NORMALIZE_ERROR_FALLBACK };
  }
  const rec = e as Record<string, unknown>;
  const rawMessage = rec.message;
  const message =
    typeof rawMessage === 'string' && rawMessage.length > 0
      ? rawMessage
      : NORMALIZE_ERROR_FALLBACK;
  const rawCode = rec.code;
  if (isNormalizeErrorCode(rawCode)) {
    return { message, code: rawCode };
  }
  return { message };
}

// T1110: the legacy `tailorApi` (POST /tailor, GET /tailor, GET /tailor/:id/export) is GONE.
// FREEZE A-39 retired all three, and the backend answers each with a 410 naming the V2
// successor, so a client that could still call them would only ever collect deprecation bodies.
// The V2 client is `services/api/tailor.ts` - OPERATIONS, before/after, reason and grounding
// claim - reached through `/app/tailor`. `TailoredResume` the type is still declared below: it is
// the historical `Application.tailoredResumeId` relation and prisma still has the table.

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
  create: (provider: string, apiKey: string, label?: string) =>
    apiClient.post<ApiKey>('/keys', { provider, apiKey, label }),
  remove: (id: string) => apiClient.delete(`/keys/${id}`),
};

// ==================== CAREER PROFILE ====================
export interface CareerProfile {
  id?: string;
  userId?: string;
  /**
   * Person fields carried by GET /profile (the columns live on `User`). Optional because
   * PUT /profile does not accept them and a round-tripped object may omit them.
   */
  name?: string | null;
  email?: string | null;
  headline?: string | null;
  links?: {
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    github?: string | null;
    linkedin?: string | null;
  } | null;
  country?: string | null;
  targetRoles?: string[];
  seniority?: SeniorityValue;
  minSalary?: number;
  maxSalary?: number;
  currency?: string;
  locationPref?: StoredLocation;
  remoteOnly?: boolean;
  topSkills?: string[];
  industries?: string[];
  redFlags?: string[];
  proofPoints?: string[];
  summary?: string;
  parsedFromResumeId?: string | null;
  isComplete?: boolean;
}

export interface ParseProfileResponse {
  suggested: Partial<CareerProfile>;
  missing: string[];
}

// Only these keys are editable through PUT /profile. Server-owned keys
// (id, userId, createdAt, updatedAt, isComplete) are dropped client-side so
// a round-tripped GET response never 400s; the backend picks these too.
const EDITABLE_PROFILE_KEYS = [
  'targetRoles',
  'seniority',
  'minSalary',
  'maxSalary',
  'currency',
  'locationPref',
  'remoteOnly',
  'topSkills',
  'industries',
  'redFlags',
  'proofPoints',
  'summary',
  'parsedFromResumeId',
] as const;

export const profileApi = {
  get: () => apiClient.get<CareerProfile | null>('/profile'),
  upsert: (data: Partial<CareerProfile>) => {
    const payload: Record<string, unknown> = {};
    for (const key of EDITABLE_PROFILE_KEYS) {
      const value = (data as Record<string, unknown>)[key];
      // undefined = absent (omit); null passes through for nullable fields
      // such as parsedFromResumeId.
      if (value !== undefined) payload[key] = value;
    }
    return apiClient.put<CareerProfile>('/profile', payload);
  },
  parse: (resumeId: string) =>
    apiClient.post<ParseProfileResponse>(`/profile/parse-from-resume/${resumeId}`, {}),
  parseFromUploadedFile: (fileId: string) =>
    apiClient.post<ParseProfileResponse>(`/profile/parse-from-uploaded-file/${fileId}`, {}),
};

// ==================== JOB BOARDS ====================
// Derived from the generated contract's board-type list (T625): adding a
// provider updates JobBoardType with no frontend edit. Recorded choice:
// TypeScript widens JSON string arrays to `string[]` (verified: an arbitrary
// string assigns to the indexed access below with no error), so a literal
// union is not expressible without a cast; a cast would need the 14 values
// hand-listed in the assertion, reintroducing the maintenance hazard this
// removes. The indexed access is therefore the narrowest honest type, and the
// `JobBoardType` alias is kept in every public signature (nothing falls back
// to a bare `string`). Runtime membership is enforced server-side (400 on
// unknown board types).
export type JobBoardType = (typeof sourceContract.boardTypes)[number];

export interface SourceHealth {
  status: 'unknown' | 'healthy' | 'failed' | string;
  consecutiveFailures: number;
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  lastError?: string | null;
  lastResultCount: number;
  lastLatencyMs?: number | null;
}

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
  sourceHealth?: SourceHealth | null;
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
  scan: (query?: string, boardIds?: string[], runId?: string, mode?: JobSearchMode) => {
    // Full is valid only on `/jobs/full-scan`; never forward it to this
    // bounded search route, where it would degrade to legacy Fast.
    const params = [
      query ? `query=${encodeURIComponent(query)}` : '',
      boardIds?.length ? `boardIds=${boardIds.join(',')}` : '',
      runId ? `runId=${encodeURIComponent(runId)}` : '',
      mode === 'standard' || mode === 'deep' ? `mode=${mode}` : '',
    ].filter(Boolean);
    const queryString = params.join('&');
    return apiClient.get<JobListingSummary[]>(`/jobs/scan${queryString ? `?${queryString}` : ''}`);
  },
};

// ==================== SAVED SEARCHES ====================
// Wave 12 (T844, ADR-027): additive optional `intent` on the row and the
// payloads. `query` on create is now conditionally optional: with a
// criteria-bearing intent it may be absent (the server derives the legacy
// fields); legacy callers keep sending it exactly as before. No field
// renamed, no signature broken.
export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  location?: StoredLocation;
  company?: string;
  boards?: string[];
  minMatchScore?: number;
  remoteOnly?: boolean;
  sortBy?: string;
  lastRunAt?: string;
  matchCount?: number;
  createdAt?: string;
  intent?: unknown;
}

export const searchesApi = {
  list: () => apiClient.get<SavedSearch[]>('/searches'),
  create: (data: { name: string; query?: string; location?: string | string[]; company?: string; boards?: string[]; minMatchScore?: number; remoteOnly?: boolean; sortBy?: string; intent?: unknown }) =>
    apiClient.post<SavedSearch>('/searches', data),
  update: (id: string, data: { name?: string; query?: string; location?: string | string[]; company?: string; boards?: string[]; minMatchScore?: number; remoteOnly?: boolean; sortBy?: string; intent?: unknown }) =>
    apiClient.patch<SavedSearch>(`/searches/${id}`, data),
  remove: (id: string) => apiClient.delete(`/searches/${id}`),
  run: (id: string) => apiClient.post<JobListingSummary[]>(`/searches/${id}/run`, {}),
};

// ==================== QUESTION ANSWERS ====================
// Mirrors backend Prisma `QuestionAnswer` (schema.prisma): id, userId,
// question, answer, category?, notes?, tags?, createdAt, updatedAt.
// Dates arrive as ISO strings over JSON; tags arrive as a JSON array.
// T1110: this type used to live in `services/api/ai.ts` next to the interview-answer GENERATOR,
// which is gone (FREEZE A-35/A-38). It was never a generator type: it is the category vocabulary
// of the user's OWN hand-written Q&A bank, and `features/question-answers/QuestionAnswerForm.tsx`
// uses it to label a dropdown. So it moves here rather than disappearing - deleting it would have
// deleted the Q&A bank's own taxonomy along with the endpoint that happened to declare it.
export type InterviewAnswerCategory = 'behavioral' | 'technical' | 'situational' | 'general';

export interface QuestionAnswer {
  id: string;
  userId: string;
  question: string;
  answer: string;
  category?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

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
// Wave 12 (T844, ADR-027): same additive treatment as saved searches -
// optional `intent` on the row and the payloads, conditionally optional
// `query` on create. No field renamed, no signature broken.
export interface JobAlert {
  id: string;
  savedSearchId?: string | null;
  name: string;
  query: string;
  location?: StoredLocation;
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
  intent?: unknown;
}

export interface JobComparisonItem extends JobListingSummary {
  description: string;
  expiresAt?: string;
  lastVerifiedAt?: string;
}

export const alertsApi = {
  list: () => apiClient.get<JobAlert[]>('/job-alerts'),
  create: (payload: { name: string; query?: string; location?: string | string[]; sources?: string[]; savedSearchId?: string; minMatchScore?: number; remoteOnly?: boolean; isActive?: boolean; notifyInApp?: boolean; notifyEmail?: boolean; intent?: unknown }) =>
    apiClient.post<JobAlert>('/job-alerts', payload),
  update: (id: string, payload: { name?: string; query?: string; location?: string | string[]; sources?: string[]; savedSearchId?: string; minMatchScore?: number; remoteOnly?: boolean; isActive?: boolean; notifyInApp?: boolean; notifyEmail?: boolean; intent?: unknown }) =>
    apiClient.patch<JobAlert>(`/job-alerts/${id}`, payload),
  remove: (id: string) => apiClient.delete(`/job-alerts/${id}`),
  // Wave 12 (T844): the run mints a pollable runId (ADR-024), returned
  // additively alongside the historical { matchCount, results } shape.
  // OPTIONAL so responses shaped by an older backend still type-check.
  run: (id: string) => apiClient.post<{ matchCount: number; results: unknown[]; runId?: string }>(`/job-alerts/${id}/run`, {}),
};
