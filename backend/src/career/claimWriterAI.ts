// =====================================================================================
// career/claimWriterAI.ts - the ONLY path by which AI output becomes a CareerClaim
// (T1011, ADR-036 item 2, 05 sec.2.2).
//
// ADR-036 item 2: "All AI writes go through ONE writer (claimWriterAI) that hard-codes
// status = inferred (or contextual) with provenance = llm_inferred. No other AI code
// path writes claims."
//
// The guarantee is built in DEPTH, because a single layer of defence is one refactor
// away from being deleted:
//
//   TYPE    `InferredClaimInput.status` is `AIWritableClaimStatus` - a two-member union
//           of 'inferred' | 'contextual'. `user_confirmed`, `rejected` and `superseded`
//           are not assignable, so the failure is a COMPILE error (proved by
//           `@ts-expect-error` cases that `npx tsc --noEmit` would fail on).
//   INPUT   the input has no `provenance` and no `supersedesClaimId` member at all.
//           `provenance` is hard-coded to `llm_inferred`; 05 sec.2.4 requires
//           `supersedesClaimId` to stay unset unless the USER confirms the replacement.
//   RUNTIME `assertAIWritableClaimStatus` re-checks after the value has crossed an
//           untyped boundary (a route body, an LLM JSON blob, an `as any`): a
//           smuggled confirming status THROWS instead of being written.
//   SQL     every row goes through `createClaim`, which dedupes on
//           `(profileId, fingerprint)` and NEVER updates an existing claim. So a
//           re-run cannot duplicate a claim, cannot change its status, and cannot
//           resurrect a `rejected` one (ADR-036 items 4-5). The DB backs this with
//           `@@unique([profileId, fingerprint])`.
//
// The seam is injected (`CareerStore`); the `prisma` singleton is never imported, so
// this module is unit testable with no live database.
// =====================================================================================

import {
  ClaimProvenance,
  ClaimStatus,
  type ClaimKind,
} from '@prisma/client';
import {
  ClaimInvariantError,
  assertAIWritableClaimStatus,
  createClaim,
  isClaimKind,
  type AIWritableClaimStatus,
  type CareerClaimStore,
} from './claims.js';

/**
 * Keys a caller must never supply. `provenance` is hard-coded (llm_inferred) and
 * `supersedesClaimId` stays unset until a user confirms (05 sec.2.4). They are absent
 * from `InferredClaimInput` on purpose; the runtime guard below catches the case where
 * untyped input smuggles one past the type.
 */
export const FORBIDDEN_AI_INPUT_KEYS = ['provenance', 'supersedesClaimId', 'userId', 'id'] as const;

/** What the model may hand us. Every field is OPTIONAL except kind and statement. */
export interface InferredClaimInput {
  kind: ClaimKind;
  /** The atomic assertion, in plain language. Normalized only for the fingerprint. */
  statement: string;
  /**
   * `inferred` (the default) or `contextual`. NOTHING else is assignable: the
   * confirming and terminal statuses are not in this type at all.
   */
  status?: AIWritableClaimStatus;
  /** Producer belief in [0,1]. Metadata only - it NEVER affects `status`. */
  confidence?: number | null;
  /** e.g. "jd_extract" | "resume_import" | "career_interview" | "github". */
  inferenceMethod?: string | null;
  /** provider/model id for the audit. No secrets, ever. */
  producedByModel?: string | null;
  evidenceSourceId?: string | null;
  experienceId?: string | null;
  educationId?: string | null;
  projectId?: string | null;
  skillId?: string | null;
  certificationId?: string | null;
  achievementId?: string | null;
}

export interface InferredClaimWriteResult {
  /** Claims whose fingerprint was new: rows actually inserted. */
  created: number;
  /** Claims whose fingerprint was already observed: no write at all. */
  deduped: number;
}

/**
 * Runtime guard for one AI input. Throws `ClaimInvariantError` on a confirming
 * status, a foreign provenance, a supersede link, or a bad `kind`.
 *
 * Exported so a route/import pipeline can validate a model response BEFORE it reaches
 * the writer (and so the test suite can prove the guard fires when the type is cast
 * away).
 */
export function assertAIWritableInput(
  input: unknown,
  index: number,
): asserts input is InferredClaimInput {
  const context = `writeInferredClaims[${index}]`;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ClaimInvariantError(`${context}: each claim must be an object`);
  }
  const record = input as Record<string, unknown>;
  for (const key of FORBIDDEN_AI_INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ClaimInvariantError(
        `${context}: the AI writer owns "${key}" and refuses an input that carries it - provenance is always llm_inferred and supersedesClaimId stays unset until a user confirms (ADR-036 / 05 sec.2.4)`,
      );
    }
  }
  if (!isClaimKind(record.kind)) {
    throw new ClaimInvariantError(
      `${context}: kind must be a ClaimKind enum value, got ${JSON.stringify(record.kind)}`,
    );
  }
  if (typeof record.statement !== 'string' || record.statement.trim().length === 0) {
    throw new ClaimInvariantError(`${context}: a non-empty statement is required`);
  }
  // The type already admits only inferred|contextual; this is the runtime half.
  assertAIWritableClaimStatus(record.status ?? ClaimStatus.inferred, context);
}

/**
 * Write model output as claims. The ONLY entry point in the system for
 * AI-produced career facts.
 *
 * Per claim:
 * - the status is `inferred` unless the caller explicitly says `contextual`
 *   (both hard-coded values; nothing else can be produced);
 * - the provenance is ALWAYS `llm_inferred`;
 * - an already-observed `(profileId, fingerprint)` is counted as `deduped` and left
 *   completely alone - no status change, no confidence rewrite, no resurrection of a
 *   `rejected` claim.
 *
 * Nothing is written when any single input is invalid: the inputs are validated up
 * front, so a malformed model response can never half-apply.
 */
export async function writeInferredClaims(
  profileId: string,
  claims: readonly InferredClaimInput[],
  store: CareerClaimStore,
): Promise<InferredClaimWriteResult> {
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new ClaimInvariantError('writeInferredClaims: a non-empty profileId is required');
  }
  if (!Array.isArray(claims)) {
    throw new ClaimInvariantError('writeInferredClaims: claims must be an array');
  }
  // Validate everything BEFORE the first write (all-or-nothing on malformed input).
  // Reachable even though the parameter is typed: a JSON model response and an
  // `as any` cast both arrive here without the compiler's blessing.
  claims.forEach((claim, index) => assertAIWritableInput(claim, index));

  let created = 0;
  let deduped = 0;
  for (const [index, raw] of claims.entries()) {
    const input = raw as InferredClaimInput;
    const result = await createClaim(
      {
        profileId,
        kind: input.kind,
        statement: input.statement,
        // Hard-coded: the ONLY two values a model-produced claim can ever carry.
        status: assertAIWritableClaimStatus(
          input.status ?? ClaimStatus.inferred,
          `writeInferredClaims[${index}]`,
        ),
        // Hard-coded: nothing downstream may re-label a model-produced claim.
        provenance: ClaimProvenance.llm_inferred,
        confidence: input.confidence ?? null,
        inferenceMethod: input.inferenceMethod ?? null,
        producedByModel: input.producedByModel ?? null,
        evidenceSourceId: input.evidenceSourceId ?? null,
        experienceId: input.experienceId ?? null,
        educationId: input.educationId ?? null,
        projectId: input.projectId ?? null,
        skillId: input.skillId ?? null,
        certificationId: input.certificationId ?? null,
        achievementId: input.achievementId ?? null,
      },
      store,
    );
    if (result.outcome === 'created') created += 1;
    else deduped += 1;
  }
  return { created, deduped };
}
