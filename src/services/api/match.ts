// Evidence-level match report API - the V2 matching surface (T1070).
//
// House pattern (`services/api/*`): a thin typed wrapper over `apiClient`, transforming wire
// shapes into the frontend's own vocabulary and nothing else. No React, no flags, no
// components - this module is imported by the page and is testable in isolation.
//
// NOTHING HERE DECIDES ANYTHING. There is no call that sends a status: a confirmation is
// `POST /matches/:id/potential/:pmId/confirm`, which on the server creates the claim
// unconfirmed and then runs `career/verification.ts`, writing the status change AND its
// `ClaimVerification` row in one transaction (ADR-036 item 3). The client cannot write a
// status, which is why this client cannot accidentally become a second confirmation path.
//
// NO SCORE, NO PERCENTAGE, ANYWHERE IN THIS FILE. `MatchCounts` has exactly five integer
// members and no derived field; there is no `score`, no `percentage`, no `ratio`, and no
// helper that could compute one. `features/match/noScore.test.ts` greps this module and
// fails if a score-like member is ever added - the ban is a test, not a convention.

import { apiClient } from "./client";

// ---------------------------------------------------------------------------
// Vocabulary (the wire spelling, mirrored not generated - the frontend has no Prisma)
// ---------------------------------------------------------------------------

/** `EvidenceLevel` on the wire. Mirrors `backend/prisma/schema.prisma`. */
export type MatchEvidenceLevel = "direct" | "contextual" | "potential" | "unsupported";

/** What the client may be asked to do about a requirement. */
export type MatchAction = "none" | "confirm_or_reject";

/** `PotentialMatch.status` on the wire. */
export type MatchPotentialStatus = "pending" | "confirmed" | "rejected";

/** One confirmed claim backing a `direct` requirement. */
export interface MatchEvidence {
  claimId: string;
  statement: string;
  kind: string;
  status: string;
  /** How this claim reached this requirement; shown so `direct` is always attributable. */
  via: "normalized_key_join" | "confirmed_match" | string;
}

/** The proposal covering one requirement, when one exists in ANY state. */
export interface MatchPotentialMatch {
  id: string;
  level: MatchEvidenceLevel;
  status: MatchPotentialStatus | string;
  claimId: string | null;
  /** What we think the user did, in the user's own confirmed words. */
  proposedEvidence: string;
  rationale: string;
}

/** One requirement with its level, its evidence and its action. */
export interface MatchRequirement {
  /** `id` is the `JobRequirement` id, named so a client need not guess the field. */
  id: string;
  text: string;
  kind: string;
  importance: string;
  normalizedKey: string;
  level: MatchEvidenceLevel;
  evidence: MatchEvidence[];
  potentialMatch: MatchPotentialMatch | null;
  action: MatchAction;
}

/**
 * The four integer counts plus the total.
 *
 * FIVE MEMBERS, NO MORE. There is no `score`, no `percentage`, no `weightedTotal`: E.6
 * forbids a single derived number, and the shape of this type is where that ban starts.
 */
export interface MatchCounts {
  direct: number;
  contextual: number;
  potential: number;
  unsupported: number;
  total: number;
}

/** A named gap: the absence of evidence, named. Never a deduction, never a number. */
export interface MatchGap {
  requirementId: string;
  normalizedKey: string;
  text: string;
  kind: string;
  importance: string;
}

/** What the proposal stage did, reported either way (ADR-041 D5). */
export interface MatchProposalStage {
  status: "applied" | "skipped";
  /** `ok` | `no_ai_provider_configured` | `provider_unavailable` | `not_evaluated` | ... */
  reason: string;
  provider: string | null;
  model: string | null;
  createdCount: number;
  /** What the deterministic guards refused, with the reason for each. */
  dropped: Array<{ reason: string; detail: string }>;
}

export interface MatchReport {
  matchReportId: string;
  jobId: string;
  job: {
    id: string;
    title: string | null;
    company: string | null;
    seniority: string | null;
    sourceKind: string;
  };
  profileId: string;
  resumeId: string | null;
  createdAt: string;
  /** How many statements were confirmed, and therefore eligible to be evidence at all. */
  confirmedClaimCount: number;
  proposalStage: MatchProposalStage;
  requirementCounts: MatchCounts;
  requirements: MatchRequirement[];
  gaps: MatchGap[];
  notes: string;
  rule: string;
}

/** The audit row shape both decisions return. `before`/`after` are server-side only. */
export interface MatchDecisionVerification {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
}

/**
 * What a Confirm or a Reject returns.
 *
 * `report` is the FRESH derivation, not a cached one, so the page can show the new count (or
 * the new named gap) in the same gesture that created it - which is why a decision never
 * needs a second round trip to render correctly.
 */
export interface MatchDecisionResult {
  changed: boolean;
  potentialMatch: {
    id: string;
    requirementId: string;
    claimId: string | null;
    level: string;
    status: string;
    resolvedAt: string | null;
  };
  claim: { id: string; kind: string; statement: string; status: string } | null;
  /** The `career_claim` audit row written by the verification service (Confirm only). */
  claimVerification: MatchDecisionVerification | null;
  /** The `potential_match` audit row for the decision about the inference itself. */
  potentialVerification: MatchDecisionVerification | null;
  report: MatchReport;
}

/** `POST /jobs/analyze`, narrowed to what this page uses. */
export interface JobAnalysisResponse {
  jobId: string;
  created: boolean;
  sourceKind: string;
  analysis: {
    method: "deterministic" | "llm";
    llm: { status: string; reason: string; provider: string | null; model: string | null };
    requirements: Array<{ kind: string; text: string; normalizedKey: string }>;
  };
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

export const matchApi = {
  /**
   * Analyse a pasted job description into a `Job` + requirements, then match it.
   *
   * Two calls because they are two server concerns: analysis is idempotent on the cleaned
   * text (the same JD twice is one `Job`), and matching re-derives from whatever the analysis
   * produced. A caller that already has a `jobId` skips straight to `matchJob`.
   */
  async analyzeJob(text: string): Promise<JobAnalysisResponse> {
    return apiClient.post<JobAnalysisResponse>("/jobs/analyze", { text });
  },

  /** Match a job's requirements against the caller's confirmed statements. */
  async matchJob(jobId: string, options: { resumeId?: string } = {}): Promise<MatchReport> {
    return apiClient.post<MatchReport>(
      `/jobs/${encodeURIComponent(jobId)}/match`,
      options.resumeId ? { resumeId: options.resumeId } : {},
    );
  },

  /** Read one report back. The server re-derives it, so this is never a stale read. */
  async getReport(matchReportId: string): Promise<MatchReport> {
    return apiClient.get<MatchReport>(`/matches/${encodeURIComponent(matchReportId)}`);
  },

  /**
   * Confirm a suggestion.
   *
   * The server creates the statement unconfirmed and then confirms it through the
   * verification service, so this call writes a status AND its audit row in one request.
   * `statement` is optional and overrides the requirement's own wording, for the case where
   * the user would rather assert the requirement in their own words.
   */
  async confirmPotential(
    matchReportId: string,
    potentialMatchId: string,
    input: { statement?: string; note?: string } = {},
  ): Promise<MatchDecisionResult> {
    return apiClient.post<MatchDecisionResult>(
      `/matches/${encodeURIComponent(matchReportId)}/potential/${encodeURIComponent(potentialMatchId)}/confirm`,
      input,
    );
  },

  /**
   * Reject a suggestion.
   *
   * The server records the decision and the requirement re-derives as a named gap; nothing
   * is deleted and no statement is created. `reason` is recorded, never required.
   */
  async rejectPotential(
    matchReportId: string,
    potentialMatchId: string,
    input: { reason?: string; note?: string } = {},
  ): Promise<MatchDecisionResult> {
    return apiClient.post<MatchDecisionResult>(
      `/matches/${encodeURIComponent(matchReportId)}/potential/${encodeURIComponent(potentialMatchId)}/reject`,
      input,
    );
  },
};