// Career evidence API - the V2 import + verification surface (T1020).
//
// House pattern (`services/api/*`): a thin typed wrapper over `apiClient`, transforming
// wire shapes into the frontend's own vocabulary and nothing else. No React, no flags,
// no components: this module is imported by the page and is testable in isolation.
//
// NOTHING HERE DECIDES ANYTHING. There is no call that sends a status, because there is
// no endpoint that accepts one: a confirmation is `POST /career/claims/:id/confirm`, which
// writes the claim's status AND its `ClaimVerification` audit row in the same transaction
// on the server (ADR-036 item 3). The client cannot write a status, which is why this
// client cannot accidentally become a second confirmation path.
//
// The Career Interview (`startInterview` / `submitInterviewAnswers`) is the surface that
// REPLACED the fabricating AI wizard, and it inherits the same property by construction:
// neither call carries a status, and the claims it produces are `inferred` until the user
// confirms each one on `/app/career`.
//
// The status/provenance unions below are the wire vocabulary as the server spells it
// (`backend/prisma/schema.prisma` ClaimStatus / ClaimProvenance). They are duplicated
// rather than imported because the frontend has no Prisma client, and the UI is written
// against the vocabulary's MEANING ("confirmed" vs "still to confirm"), not against the
// generated enum - `UNKNOWN_STATUS` in `features/career/claimPresentation.ts` is what
// stops a status this build has never heard of from rendering as "Confirmed".

import { apiClient } from "./client";

/** `ClaimStatus` on the wire. Mirrors `backend/prisma/schema.prisma`. */
export type CareerClaimStatus =
  | "inferred"
  | "contextual"
  | "user_confirmed"
  | "rejected"
  | "superseded";

/** `ClaimProvenance` on the wire. Mirrors `backend/prisma/schema.prisma`. */
export type CareerClaimProvenance =
  | "user_entered"
  | "document_import"
  | "llm_inferred"
  | "derived"
  | "github_derived"
  | "external_verified";

/** `ClaimKind` on the wire. Mirrors `backend/prisma/schema.prisma`. */
export type CareerClaimKind =
  | "role"
  | "responsibility"
  | "achievement"
  | "metric"
  | "skill"
  | "technology"
  | "domain"
  | "education"
  | "certification"
  | "project"
  | "language"
  | "soft_skill";

/** `EvidenceKind` on the wire. */
export type CareerEvidenceKind =
  | "document"
  | "url"
  | "manual"
  | "import_json"
  | "github_repo"
  | "job_posting";

export interface CareerClaim {
  id: string;
  profileId: string;
  kind: CareerClaimKind;
  statement: string;
  status: CareerClaimStatus;
  provenance: CareerClaimProvenance;
  confidence: number | null;
  inferenceMethod: string | null;
  producedByModel: string | null;
  evidenceSourceId: string | null;
  experienceId: string | null;
  educationId: string | null;
  projectId: string | null;
  skillId: string | null;
  certificationId: string | null;
  achievementId: string | null;
  confirmedAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The audit row the server returns after a decision. Never carries before/after blobs. */
export interface CareerVerification {
  id: string;
  claimId: string | null;
  action: "confirm" | "edit_confirm" | "reject" | "reopen" | "edit";
  actorUserId: string | null;
  userId: string | null;
  targetType: string;
  targetId: string;
  note: string | null;
  createdAt: string;
}

/** Counts for every status, plus `total` and `unconfirmed`. Always fully populated. */
export type CareerClaimCounts = Record<CareerClaimStatus, number> & {
  total: number;
  unconfirmed: number;
};

export interface CareerEvidenceSource {
  id: string;
  kind: CareerEvidenceKind;
  title: string;
  url: string | null;
  mimeType: string | null;
  storageKey: string | null;
  byteSize: number | null;
  uploadedFileId: string | null;
  contentHash: string;
  trustLevel: number;
  capturedAt: string;
  createdAt: string;
}

export interface CareerProfileSummary {
  id: string;
  headline: string | null;
  summary: string | null;
  seniority: string | null;
  targetRoles: unknown;
  topSkills: unknown;
  industries: unknown;
  locationPref: string | null;
  remoteOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CareerProfileResponse {
  profile: CareerProfileSummary | null;
  counts: CareerClaimCounts;
  unconfirmed: number;
}

/**
 * What the optional AI pass did, reported either way (ADR-041 D5).
 *
 * `reason` is the field the UI branches on. `'no_ai_provider_configured'` is the common
 * case and is NOT an error: the import completed, deterministically, and the wording says
 * so rather than leaving the user to wonder whether something was missed.
 */
export interface CareerEnrichmentReport {
  provider: string;
  status: "applied" | "skipped";
  reason:
    | "ok"
    | "no_ai_provider_configured"
    | "provider_unavailable"
    | "no_enricher_configured"
    | string;
  created: number;
  deduped: number;
}

export interface CareerImportResult {
  profileId: string;
  evidenceSourceId: string;
  evidenceSource: "created" | "deduped";
  claims: { created: number; deduped: number; extracted: number; total: number };
  statusAssigned: CareerClaimStatus;
  provenanceAssigned: CareerClaimProvenance;
  counts: CareerClaimCounts;
  enrichment: CareerEnrichmentReport;
  items: CareerClaim[];
  note: string;
}

export interface CareerClaimsResponse {
  claims: CareerClaim[];
  counts: CareerClaimCounts;
  unconfirmed: number;
}

export interface CareerDecisionResult {
  claim: CareerClaim;
  verification: CareerVerification | null;
  changed: boolean;
  action: string;
}

export interface CareerCreateClaimResponse {
  mode: "create" | "create_confirm" | "edit" | "edit_confirm";
  claim: CareerClaim;
  verification: CareerVerification | null;
  changed: boolean;
  outcome?: "created" | "deduped";
  action?: string;
  note?: string;
}

export interface CareerClaimQuery {
  status?: CareerClaimStatus;
  kind?: CareerClaimKind;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// The entity surface (T1054)
// ---------------------------------------------------------------------------
//
// The resume is a PROJECTION of entity rows with claims attached to them
// (`backend/src/resume/json/project.ts` buckets every claim by its own foreign key), so a
// profile with statements and no entities projects an empty document. These calls are how a
// user fills it in, and they are USER-AUTHORED: nothing here is inferred, and nothing here
// decides anything about a statement.
//
// THE TWO CALLS THAT TOUCH A CLAIM ARE NOT DECISIONS. `attachClaim` writes a claim's entity
// foreign key and writes NO `ClaimVerification` row and NO status: the server attaches through
// the one career-layer writer whose type has no `status` member. So this client cannot
// confirm a statement, and there is no member here through which it could try.

/** The six entity kinds, in the order the projector reads them. Mirrors `CAREER_ENTITY_KINDS`. */
export type CareerEntityKind =
  | "experience"
  | "education"
  | "project"
  | "skill"
  | "certification"
  | "achievement";

/** The wire shape every entity row shares. */
export interface CareerEntityBase {
  id: string;
  profileId: string;
  createdAt: string;
  updatedAt?: string;
  /**
   * `Certification` has no such column in the schema, so a certification row omits it. Typed
   * as absent rather than `number | null` so a form that renders an order control for every
   * kind cannot compile into one.
   */
  sortOrder?: number;
}

export interface ExperienceEntity extends CareerEntityBase {
  title: string;
  company: string;
  location: string | null;
  employmentType: string | null;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  sortOrder: number;
}

export interface EducationEntity extends CareerEntityBase {
  degree: string;
  institution: string;
  field: string | null;
  location: string | null;
  graduationYear: string | null;
  sortOrder: number;
}

export interface ProjectEntity extends CareerEntityBase {
  name: string;
  role: string | null;
  description: string | null;
  repoUrl: string | null;
  liveUrl: string | null;
  tech: string[];
  startDate: string | null;
  endDate: string | null;
  sortOrder: number;
}

export interface SkillEntity extends CareerEntityBase {
  name: string;
  /** Derived by the server from `name`; never sent. Unique per profile. */
  normalized: string;
  category: string | null;
  level: string | null;
  sortOrder: number;
}

export interface CertificationEntity extends CareerEntityBase {
  name: string;
  issuer: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  credentialUrl: string | null;
}

export interface AchievementEntity extends CareerEntityBase {
  statement: string;
  /** The experience this achievement hangs off, or `null`. A reference, never free text. */
  experienceId: string | null;
  sortOrder: number;
}

export type CareerEntity =
  | ExperienceEntity
  | EducationEntity
  | ProjectEntity
  | SkillEntity
  | CertificationEntity
  | AchievementEntity;

/** What a create body may carry. `profileId` is the router's own addressing member. */
export type CareerEntityInput = Record<string, string | number | boolean | string[] | null>;

export interface CareerEntityListResponse {
  kind: CareerEntityKind;
  entities: CareerEntity[];
}

export interface CareerEntityResponse {
  kind: CareerEntityKind;
  entity: CareerEntity;
}

/** What a delete reports. `detachedClaims` is the number of statements that lost a placement. */
export interface CareerEntityDeleteResult {
  id: string;
  kind: CareerEntityKind;
  detachedClaims: number;
}

export interface CareerAttachmentResult {
  claim: CareerClaim;
  attachment: { kind: CareerEntityKind; entityId: string | null };
  changed: boolean;
  field?: string;
  fields?: string[];
  note: string;
}

export interface CareerDetachResult {
  claim: CareerClaim;
  changed: boolean;
  fields: string[];
  note: string;
}

// ---------------------------------------------------------------------------
// The Career Interview wire shapes (T1021)
// ---------------------------------------------------------------------------
//
// The questionnaire is SERVER-OWNED and comes down in `startInterview` rather than being
// duplicated here. A client copy would be a second thing to keep in step with
// `backend/src/career/interview.ts`, and a wizard that asked the wrong questions would be
// asking them against a stage that no longer has them - which is the failure the retirement
// of `AIBuild` was about.

export interface CareerInterviewField {
  id: string;
  label: string;
  /** One line telling the user what belongs here. Rendered above the input. */
  hint: string;
  required: boolean;
}

export interface CareerInterviewStep {
  id: string;
  title: string;
  summary: string;
  fields: readonly CareerInterviewField[];
}

/** One answer, keyed by the questionnaire's own ids. */
export interface CareerInterviewAnswer {
  stepId: string;
  fieldId: string;
  value: string;
}

export interface CareerInterviewStart {
  /** Opaque correlation handle. It grants nothing; see the backend's own docstring. */
  sessionId: string;
  profileId: string;
  /** The provider id, for the user to see which one will read their answers. */
  provider: string;
  model: string;
  steps: readonly CareerInterviewStep[];
  totalSteps: number;
  /** Echoed from the server so the UI states what the rows WILL carry, not what it hopes. */
  statusAssigned: CareerClaimStatus;
  provenanceAssigned: CareerClaimProvenance;
  inferenceMethod: string;
  requiresProvider: boolean;
  manualPath: string;
  note: string;
}

/** Why a produced claim was refused. Mirrors `INTERVIEW_CLAIM_DROP_REASONS` on the server. */
export type CareerInterviewDropReason =
  | "unknown_kind"
  | "no_statement"
  | "statement_too_short"
  | "statement_too_long"
  | "invalid_confidence"
  | "invented_entity"
  | "duplicate"
  | "too_many_claims";

export interface CareerInterviewDrop {
  reason: CareerInterviewDropReason;
  detail: string;
  /** The entities the answers do not contain. Empty unless the reason is `invented_entity`. */
  invented: readonly string[];
}

export interface CareerInterviewResult {
  sessionId: string;
  profileId: string;
  provider: string | null;
  model: string | null;
  claims: {
    /** How many the provider returned. */
    extracted: number;
    /** How many survived the deterministic guard. */
    accepted: number;
    /** Rows actually inserted; `deduped` were already on file and left completely alone. */
    created: number;
    deduped: number;
    total: number;
  };
  counts: CareerClaimCounts;
  unconfirmed: number;
  statusAssigned: CareerClaimStatus;
  provenanceAssigned: CareerClaimProvenance;
  inferenceMethod: string;
  /** What the guard refused, with the reason. Present even when empty. */
  dropped: readonly CareerInterviewDrop[];
  /** Where the wizard hands the user: the verification list. */
  nextPath: string;
  note: string;
}

/**
 * The code that means "this stage needs an AI provider".
 *
 * A constant rather than a scattered literal because the UI branches on it in two places
 * (the start screen and the submit handler) and a message check would break the moment the
 * wording is reworded for a person.
 */
export const INTERVIEW_PROVIDER_REQUIRED = "interview_provider_required";

function queryString(query: CareerClaimQuery): string {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.kind) params.set("kind", query.kind);
  if (typeof query.limit === "number") params.set("limit", String(query.limit));
  if (typeof query.offset === "number") params.set("offset", String(query.offset));
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

export const careerApi = {
  /**
   * Import a resume (or an already-uploaded raw file) into the career evidence layer.
   *
   * `file` and `uploadedFileId` are alternatives, not both. The upload goes through
   * `apiClient.upload`'s multipart path, which is the only client method that lets the
   * browser set its own `Content-Type` with the boundary; the optional `profileId` and
   * `title` ride along on the SAME FormData, which the server reads as `req.body`.
   */
  async importResume(
    file: File,
    options: { profileId?: string; title?: string } = {},
  ): Promise<CareerImportResult> {
    return apiClient.upload<CareerImportResult>("/career/import/resume", file, "file", {
      profileId: options.profileId,
      title: options.title,
    });
  },

  /** Import a file the user already uploaded through the raw-upload surface. */
  async importUploadedFile(
    uploadedFileId: string,
    options: { profileId?: string; title?: string } = {},
  ): Promise<CareerImportResult> {
    return apiClient.post<CareerImportResult>("/career/import/resume", {
      uploadedFileId,
      ...options,
    });
  },

  async getProfile(): Promise<CareerProfileResponse> {
    return apiClient.get<CareerProfileResponse>("/career/profile");
  },

  // -------------------------------------------------------------------------
  // The Career Interview (T1021)
  // -------------------------------------------------------------------------
  //
  // TWO CALLS, AND THE FIRST ONE CAN FAIL HONESTLY. `startInterview` answers 503 with
  // `code: "interview_provider_required"` when no AI provider is configured, and that is the
  // WHOLE design of this feature rather than a bug in it: the interview turns the user's
  // answers into candidate claims with a language model, and without one it says so and
  // points at the manual path instead of running a template questionnaire that would look
  // like the real thing. There is no third "degraded" mode.
  //
  // NOTHING HERE CONFIRMS ANYTHING. Neither call takes a status and neither returns a
  // decision: the claims that come back are `inferred`, and confirming one is
  // `confirmClaim` - a separate, audited human action (ADR-036).

  /**
   * Open an interview: the questionnaire, the provider, and an opaque session id.
   *
   * REJECTS with `interview_provider_required` (503) when there is no provider. The caller
   * is expected to branch on `ApiClientError.code` rather than on the message, which is why
   * the server sends both.
   */
  async startInterview(): Promise<CareerInterviewStart> {
    return apiClient.post<CareerInterviewStart>("/career/interview/start", {});
  },

  /**
   * Submit the answers, receive candidate claims.
   *
   * The three refusals are distinguishable by `code`, which is the whole reason the server
   * maps them to three different statuses: `interview_provider_required` (503, no provider
   * any more), `interview_schema_invalid` (502, the provider answered in a shape the stage
   * will not guess at), `interview_provider_unavailable` (502, the call failed), and
   * `interview_invalid_input` (400, the submission cannot be acted on).
   *
   * On success `dropped` says what the guard refused and why - the fabricated-claim case -
   * so the UI can show it rather than the user discovering a missing statement later.
   */
  async submitInterviewAnswers(
    sessionId: string,
    answers: readonly CareerInterviewAnswer[],
  ): Promise<CareerInterviewResult> {
    return apiClient.post<CareerInterviewResult>(
      `/career/interview/${sessionId}/answers`,
      { answers },
    );
  },

  async getSources(): Promise<{ sources: CareerEvidenceSource[] }> {
    return apiClient.get<{ sources: CareerEvidenceSource[] }>("/career/sources");
  },

  async getClaims(query: CareerClaimQuery = {}): Promise<CareerClaimsResponse> {
    return apiClient.get<CareerClaimsResponse>(`/career/claims${queryString(query)}`);
  },

  /**
   * Create a hand-entered claim, or edit an existing one.
   *
   * `confirm: true` is the ONLY way this call can produce a confirmed claim, and it is a
   * user gesture: the server creates the row unconfirmed and then, in the same request,
   * runs the verification service - which writes the status change AND its audit row
   * together. There is no `status` field on this input, by design.
   */
  async createClaim(input: {
    kind?: CareerClaimKind;
    statement: string;
    profileId?: string;
    id?: string;
    note?: string | null;
    confirm?: boolean;
  }): Promise<CareerCreateClaimResponse> {
    return apiClient.post<CareerCreateClaimResponse>("/career/claims", input);
  },

  /** Confirm, or edit-and-confirm when `statement` is supplied. */
  async confirmClaim(
    claimId: string,
    input: { note?: string | null; statement?: string } = {},
  ): Promise<CareerDecisionResult> {
    return apiClient.post<CareerDecisionResult>(`/career/claims/${claimId}/confirm`, input);
  },

  async rejectClaim(
    claimId: string,
    input: { reason?: string | null; note?: string | null } = {},
  ): Promise<CareerDecisionResult> {
    return apiClient.post<CareerDecisionResult>(`/career/claims/${claimId}/reject`, input);
  },

  /** Clear a rejection. NOT a confirmation: confirming is a second, separate decision. */
  async reopenClaim(
    claimId: string,
    input: { note?: string | null } = {},
  ): Promise<CareerDecisionResult> {
    return apiClient.post<CareerDecisionResult>(`/career/claims/${claimId}/reopen`, input);
  },

  // -------------------------------------------------------------------------
  // The entity surface (T1054)
  // -------------------------------------------------------------------------

  /** Every row of one kind, in the order the projector will place them. */
  async listEntities(kind: CareerEntityKind): Promise<CareerEntityListResponse> {
    return apiClient.get<CareerEntityListResponse>(`/career/entities/${kind}`);
  },

  /**
   * Add one entry. The body is the schema's own fields for that kind - the server refuses an
   * unknown member rather than dropping it, so a typo is a 400 and not a lost edit.
   */
  async createEntity(
    kind: CareerEntityKind,
    input: CareerEntityInput,
  ): Promise<CareerEntityResponse> {
    return apiClient.post<CareerEntityResponse>(`/career/entities/${kind}`, input);
  },

  /** Change only the members named. Anything absent keeps its value. */
  async updateEntity(
    kind: CareerEntityKind,
    id: string,
    patch: CareerEntityInput,
  ): Promise<CareerEntityResponse> {
    return apiClient.patch<CareerEntityResponse>(`/career/entities/${kind}/${id}`, patch);
  },

  /**
   * Remove an entry. The statements that named it are KEPT (the schema's own
   * `onDelete: SetNull`), and the response says how many lost their placement.
   */
  async deleteEntity(kind: CareerEntityKind, id: string): Promise<CareerEntityDeleteResult> {
    return apiClient.delete<CareerEntityDeleteResult>(`/career/entities/${kind}/${id}`);
  },

  /**
   * File a statement under an entry.
   *
   * NOT A CONFIRMATION, and this client says so at the type level: there is no `status`, no
   * `confirm` and no `note` member, so there is nothing here that could change what the user
   * has or has not asserted. The server's `note` in the response repeats it.
   */
  async attachClaim(
    claimId: string,
    input: { kind: CareerEntityKind; entityId: string },
  ): Promise<CareerAttachmentResult> {
    return apiClient.post<CareerAttachmentResult>(`/career/claims/${claimId}/attach`, input);
  },

  /**
   * Take a statement back out of whatever entry it is filed under.
   *
   * `kind` narrows it to one column and `entityId` narrows it to one pair; omitting both
   * detaches from whatever the statement names. It is idempotent, so a retry is safe.
   */
  async detachClaim(
    claimId: string,
    input: { kind?: CareerEntityKind; entityId?: string } = {},
  ): Promise<CareerDetachResult> {
    return apiClient.post<CareerDetachResult>(`/career/claims/${claimId}/detach`, input);
  },
};

export default careerApi;
