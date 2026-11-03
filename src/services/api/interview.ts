// Interview-prep API - the derived risk + grounded question surface (T1090).
//
// House pattern (`services/api/*`): a thin typed wrapper over `apiClient`, transforming wire
// shapes into the frontend's own vocabulary and nothing else. No React, no flags, no
// components - this module is imported by the page and is testable in isolation.
//
// NOTHING HERE DECIDES ANYTHING, AND NOTHING HERE COMPUTES A NUMBER OUT OF THE NUMBERS.
// `riskCounts` is seven integers keyed by the seven risk kinds and `questionCounts` is four
// keyed by the four categories; there is no `score`, no `percentage`, no `ratio` and no helper
// that could produce one, because 06 sec. E.6 forbids a single derived figure and this feature
// would otherwise be the one surface that invents one. `features/interview-prep/noVerdict.test.ts`
// greps this file and fails if a verdict-shaped member is ever added - the ban is a test, not a
// convention.
//
// NO CALL SENDS A CONFIRMATION OR A STATUS. The risks and the questions are DERIVED and, with
// no provider configured, the questions exist with NO model answer - which the client cannot
// change, because there is no endpoint that would write one.
//
// A SEPARATE MODULE FROM `services/api/match.ts` DELIBERATELY: that one is the match REPORT and
// must not grow a prep surface, and this one is the PREP surface and must not grow a report.

import { apiClient } from "./client";

// ---------------------------------------------------------------------------
// Vocabulary (the wire spelling, mirrored not generated - the frontend has no Prisma)
// ---------------------------------------------------------------------------

/** `InterviewRiskKind` on the wire. Mirrors `backend/prisma/schema.prisma`. */
export type InterviewRiskKind =
  | "new_claim"
  | "emphasized_tech"
  | "inferred_claim"
  | "rewritten_bullet"
  | "gap"
  | "overclaim"
  | "thin_evidence";

/** `Severity` on the wire. */
export type InterviewSeverity = "low" | "medium" | "high";

/** `InterviewQuestion.category`, the four values the schema documents. */
export type InterviewQuestionCategory = "behavioral" | "technical" | "situational" | "general";

/** Where a risk's evidence lives. Mirrors `RISK_ANCHOR_SOURCES`. */
export type InterviewAnchorSource =
  | "resume_claim_usage"
  | "career_claim"
  | "match_gap"
  | "resume_change"
  | "requirement";

/**
 * ONE ROW A RISK WAS READ FROM, WITH THE MACHINE-READABLE REASON.
 *
 * `detail` is not decoration: it is what makes the risk auditable. A risk with an anchor and no
 * detail says "we looked at something"; the detail says which of the five derivations fired.
 */
export interface InterviewAnchor {
  source: InterviewAnchorSource;
  id: string;
  detail: string;
}

/** What the optional answer stage did, per question. */
export interface InterviewAnswerStage {
  status: "answered" | "skipped" | "rejected";
  /**
   * `ok` | `no_ai_provider_configured` | `provider_unavailable` | `no_grounded_evidence` |
   * `ungrounded_entities_after_regeneration` | `not_evaluated`.
   */
  reason: string;
  provider: string | null;
  model: string | null;
  /** How many times the provider was asked. `0` when it was never asked. */
  attempts: number;
  /** The entities the refused answer named. Empty when nothing was refused. */
  rejectedEntities: string[];
  dropped: Array<{ reason: string; detail: string }>;
}

export interface InterviewRisk {
  id: string | null;
  /** The deterministic anchor key, e.g. `resume_claim_usage:clm-k8s`. */
  key: string;
  kind: InterviewRiskKind;
  severity: InterviewSeverity;
  statement: string;
  /** NEVER empty. The rows this risk was read from. */
  anchors: InterviewAnchor[];
  requirementId: string | null;
  claimId: string | null;
  /** The interviewer's angle: the derived probe, or a grounded sharpening of it. */
  focus: string;
}

export interface InterviewQuestion {
  id: string | null;
  /** Deterministic `<riskKey>#<category>`; stable across runs for the same derivation. */
  questionId: string;
  /** The `InterviewRisk.id` this question is anchored to. */
  riskId: string | null;
  requirementId: string | null;
  category: InterviewQuestionCategory;
  question: string;
  /** `null` when no answer was stored. NEVER an invented one, and never `""`. */
  modelAnswer: string | null;
  groundedClaimIds: string[];
  focus: string;
  answerStage: InterviewAnswerStage;
}

export interface InterviewPrep {
  resumeId: string;
  /** `null` on a read: that request derived nothing, so it has no revision to report. */
  revision: {
    id: string;
    revisionNumber: number;
    jsonHash: string;
    usageCount: number;
    changeCount: number;
  } | null;
  match: {
    matchReportId: string | null;
    jobId: string | null;
    /** `null` on a read. */
    requirementCount: number | null;
    /** `null` on a read. */
    gapCount: number | null;
  };
  /** Seven integers, one per risk kind. A count per kind, never a verdict. */
  riskCounts: Record<InterviewRiskKind, number>;
  /** Four integers, one per question category. */
  questionCounts: Record<InterviewQuestionCategory, number>;
  risks: InterviewRisk[];
  questions: InterviewQuestion[];
  briefStage: {
    status: "applied" | "skipped";
    reason: string;
    provider: string | null;
    model: string | null;
    appliedCount: number;
    dropped: Array<{ reason: string; detail: string }>;
  };
  /**
   * Why the answers are the way they are. `no_ai_provider_configured` is the case this feature
   * is designed around, so the client can say it in words rather than showing an empty box.
   */
  answerStageSummary: {
    answered: number;
    skipped: number;
    rejected: number;
    reasons: Record<string, string>;
  };
  notes: string;
  rule: string;
}

/** What to derive against. A job or a match report is OPTIONAL; both add requirement risks. */
export interface PrepareInterviewInput {
  resumeId: string;
  /** The match report whose named gaps and levels become the requirement-side risks. */
  matchReportId?: string;
  /** A job to derive the levels against when no report is named. */
  jobId?: string;
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

export const interviewApi = {
  /**
   * Derive the risks for a resume, answer them, and read both back.
   *
   * POST rather than GET because the run WRITES: the risks and the questions are persisted, so
   * the anchor ids the questions point at are real ids the client can link to, and a repeat
   * POST replaces the previous set rather than stacking a duplicate list.
   */
  async prepare(input: PrepareInterviewInput): Promise<InterviewPrep> {
    return apiClient.post<InterviewPrep>("/interview-prep", {
      resumeId: input.resumeId,
      ...(input.matchReportId ? { matchReportId: input.matchReportId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
    });
  },

  /**
   * Read back the last run's risks and questions.
   *
   * The server does NOT re-derive here, and that is deliberate: a read cannot know why an
   * answer was refused, so re-deriving would erase the evidence the feature exists to produce.
   */
  async get(resumeId: string): Promise<InterviewPrep> {
    return apiClient.get<InterviewPrep>(`/interview-prep/${encodeURIComponent(resumeId)}`);
  },
};