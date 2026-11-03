// Tailoring API - typed wrappers over the V2 tailoring surface (T1080).
//
// HOUSE PATTERN (`services/api/*`, cf. `studio.ts` / `career.ts`): a thin typed wrapper over
// `apiClient`, transforming wire shapes into the frontend's own vocabulary and nothing else.
// No React, no flags, no components - so `features/tailor/tailorModel.test.ts` can assert the
// ENDPOINTS these methods call, which is the only way to prove the preview/apply wiring
// without rendering a page.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT HAVE:
//   - NO method that returns a whole resume document. `propose` returns OPERATIONS and the
//     server says so itself (`operationsContainDocument: false`); 06 sec.E.3's rule that the
//     tailoring request never returns a document is mirrored here by there being no field to
//     put one in.
//   - NO score, no percentage of fit, on any type. E.6 forbids the single number, and a
//     "how well does this op match" figure would be that number one layer down.
//   - NO way to accept SOME operations on the client and have them applied without a
//     round trip: `apply` takes the operation list as the caller assembled it, and the server
//     re-validates every entry. The client's `accepted` flags are a UI concern; the server's
//     verdicts are the truth, and both are shown.
//
// EVERY REFUSAL CARRIES THE SERVER'S CODE. `TailorRejection.code` is the closed vocabulary in
// `backend/src/tailor/ops.ts` (`OP_REJECTION_CODES`). The UI branches on it rather than on
// prose, because the reason a proposal was refused is the single most useful thing on the
// screen and a paraphrase would be the one place it got lost.

import { apiClient } from "./client";

/** Mirrors `ResumeChangeOp`. The nine operations a tailoring pass may propose. */
export type TailorOp =
  | "rewrite_bullet"
  | "reword_summary"
  | "reorder"
  | "include"
  | "exclude"
  | "add_skill"
  | "remove_skill"
  | "retitle"
  | "customize_style";

/**
 * The closed refusal vocabulary (`backend/src/tailor/ops.ts` `OP_REJECTION_CODES`).
 *
 * Typed as `string` rather than as the union on purpose: a server that grows a code must not
 * break the frontend's build, and every consumer has to handle "some code I do not know" anyway.
 * The known ones are named so a caller CAN branch on them.
 */
export type TailorRejectionCode =
  | "OP_UNKNOWN"
  | "OP_MALFORMED"
  | "TARGET_MALFORMED"
  | "TARGET_UNRESOLVED"
  | "TARGET_NOT_APPLICABLE"
  | "SOURCE_CLAIMS_REQUIRED"
  | "SOURCE_CLAIM_NOT_FOUND"
  | "SOURCE_CLAIM_NOT_CONFIRMED"
  | "TARGET_CLAIM_MISMATCH"
  | "FACT_DELTA"
  | "SECTION_REQUIRED_BY_TEMPLATE"
  | "REORDER_NOT_A_PERMUTATION"
  | "TARGET_NOT_FOUND"
  | "CLAIM_ALREADY_RENDERED"
  | "TEMPLATE_UNKNOWN"
  | "BEFORE_MISMATCH";

export interface TailorRejection {
  code: TailorRejectionCode | string;
  /** Fixed server text. Never a paraphrase on this side. */
  reason: string;
  /** The offending value, when there is one. The ONLY member that echoes caller data. */
  detail: string | null;
}

/** One proposed operation, as the server validated it. */
export interface TailorOperation {
  op: TailorOp;
  target: string;
  before: unknown;
  /** `null` when the operation was refused - the proposal is not applied. */
  after: unknown;
  reason: string | null;
  targetRequirementIds: string[];
  sourceClaimIds: string[];
  /** `true` would mean a new fact was proposed. It is never `true` on a returned operation. */
  factDelta: boolean;
  accepted: boolean;
  rejection: TailorRejection | null;
  /** Present on an accepted operation: the claims that grounded it. */
  groundingClaimIds?: string[];
}

/** `POST /resumes/:id/tailor`. */
export interface TailorProposal {
  proposal: {
    status: "ok" | "skipped" | "failed";
    /** Machine-readable. `no_ai_provider_configured` is the ADR-041 D5 case. */
    reason: string;
    provider: string;
  };
  baseRevision: TailorRevisionRef;
  templateId: string;
  /** The server's own statement that no document is in the response. */
  operationsContainDocument: boolean;
  operations: TailorOperation[];
}

export interface TailorRevisionRef {
  id: string;
  revisionNumber: number;
  jsonHash: string;
}

/** One stored `ResumeChange` row, read back from the database rather than echoed. */
export interface TailorChangeRow {
  id: string;
  op: TailorOp;
  jsonPath: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  targetRequirementIds: string[];
  sourceClaimIds: string[];
  appliedBy: string;
  accepted: boolean;
}

/** The source claim a change rests on, resolved so a person can CHECK it. */
export interface TailorSourceClaim {
  id: string;
  kind: string;
  statement: string;
  status: string;
  provenance: string;
}

export interface TailorChangeRowWithClaims extends TailorChangeRow {
  sourceClaims: TailorSourceClaim[];
}

/** `POST /resumes/:id/tailor/apply`. */
export interface TailorApplyResult {
  /** The revision the operations were applied to. UNCHANGED - the immutability evidence. */
  parent: TailorRevisionRef;
  revision: TailorRevisionRef & { createdBy: string; reason: string | null };
  summary: {
    documentChanged: boolean;
    acceptedCount: number;
    declinedCount: number;
    changeCount: number;
  };
  changes: TailorChangeRow[];
  /** Entries that were not operations at all, so they get no `ResumeChange` row. */
  unparsable: Array<{ rejection: TailorRejection }>;
  gate: { allowed: boolean; reason?: string; checked?: number; rendered?: number };
}

/** `GET /resumes/:id/tailor/changes`. */
export interface TailorChangeLog {
  revision: TailorRevisionRef;
  changes: TailorChangeRowWithClaims[];
}

/** The gate verdict, reported verbatim rather than re-derived. */
export type TailorGateVerdict = TailorApplyResult["gate"];

export const tailorApi = {
  /**
   * Ask the server to PROPOSE operations. AI-OPTIONAL: with no provider configured the
   * response is 200 with `proposal.status = 'skipped'` and an EMPTY operation list, and every
   * other method here still works (ADR-041 D5).
   */
  async propose(resumeId: string, input: { jobId?: string; templateId?: string } = {}): Promise<TailorProposal> {
    return apiClient.post<TailorProposal>(`/resumes/${resumeId}/tailor`, {
      // Conditional, not `jobId: undefined`: an absent member and an explicit undefined are
      // the same JSON on the wire, but a member that is always present would be a promise the
      // default path does not keep.
      ...(input.jobId ? { jobId: input.jobId } : {}),
      ...(input.templateId ? { templateId: input.templateId } : {}),
    });
  },

  /**
   * Apply the operations the user ACCEPTED.
   *
   * `operations` is the caller's list, not the server's proposal: an operation the user
   * declined is either omitted or sent and left unaccepted, and the server re-validates every
   * entry regardless - the client's `accepted` flags are a UI concern, the server's verdicts
   * are the truth.
   *
   * `baseRevisionId` is the revision the caller believed it was tailoring. A mismatch is a 409
   * rather than a silent overwrite of the other pass's work.
   */
  async apply(
    resumeId: string,
    operations: readonly unknown[],
    options: { baseRevisionId?: string; templateId?: string } = {},
  ): Promise<TailorApplyResult> {
    return apiClient.post<TailorApplyResult>(`/resumes/${resumeId}/tailor/apply`, {
      operations,
      ...(options.baseRevisionId ? { baseRevisionId: options.baseRevisionId } : {}),
      ...(options.templateId ? { templateId: options.templateId } : {}),
    });
  },

  /**
   * The change log of one revision, with the SOURCE CLAIM STATEMENTS resolved.
   *
   * The statements are what make the diff reviewable: a claim id is not a fact a person can
   * check. Omitting `revision` means "the current one".
   */
  async listChanges(resumeId: string, revision?: number): Promise<TailorChangeLog> {
    const query = typeof revision === "number" ? `?revision=${encodeURIComponent(String(revision))}` : "";
    return apiClient.get<TailorChangeLog>(`/resumes/${resumeId}/tailor/changes${query}`);
  },
};

export default tailorApi;