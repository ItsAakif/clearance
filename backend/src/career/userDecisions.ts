// =====================================================================================
// career/userDecisions.ts - the application service behind the verification endpoints
// (T1020, ADR-036 item 3).
//
// WHY THIS EXISTS AS A SEPARATE MODULE. `career/verification.ts` is the only writer of
// `CareerClaim.status` in the system, and it guarantees - structurally - that a
// status change and its `ClaimVerification` audit row commit in ONE transaction. A route
// that needs a confirm endpoint must therefore reach it somehow, and the repo's existing
// guard (`career/claimWriterAI.test.ts`, "a route can only reach the career layer through
// the modules allowed to touch it") forbids a route from importing `verification.js` or
// `claimWriterAI.js` DIRECTLY: a route holding those two imports could write a claim or
// confirm one straight out of an HTTP body, which is the failure ADR-036 item 2 is about.
//
// So the policy lives here, in the directory that owns the invariant, and the route calls
// five functions that cannot be misused:
//
//   - a hand-entered claim is created UNCONFIRMED. Typing a fact is not verifying it.
//     `createClaim` cannot be handed a confirming status, so this is structural rather
//     than a convention; `confirm: true` below is the user saying BOTH in one gesture,
//     and it still goes through `confirmClaim`, which writes the audit row.
//   - an edit without a confirm records `action = edit` and leaves the status alone. A
//     user who re-words an inferred claim has still not asserted it.
//   - a confirm, an edit-and-confirm, a reject and a reopen each return the service's own
//     result, including the audit row - so a caller cannot report success while omitting
//     the record of the decision, and an idempotent repeat is visibly a no-op
//     (`changed: false`, `verification: null`) instead of a second row.
//
// There is NO function here that writes a status without an audit row, because every
// status write is a call into `verification.ts`, which does both in one transaction.
// The DB seam is INJECTED (`CareerStore`); no module under `backend/src/career/` imports
// the `prisma` singleton.
// =====================================================================================

import { ClaimKind, ClaimProvenance, type CareerClaim } from '@prisma/client';
import {
  createClaim,
  type CareerStore,
  type ClaimCreateInput,
} from './claims.js';
import { IMPORTED_CLAIM_STATUS } from './claimUsage.js';
import {
  confirmClaim,
  editConfirmClaim,
  recordClaimEdit,
  rejectClaim,
  reopenClaim,
  type ClaimDecisionResult,
} from './verification.js';

/**
 * Re-exported so a CALLER can classify a decision failure without importing
 * `verification.js` itself.
 *
 * This is not indirection for its own sake: a route has to map this error onto a status
 * code, and the repo's guard (`career/claimWriterAI.test.ts`) forbids a route from
 * importing the status writer directly - for the same reason it must not be able to call
 * it from a request body. `claims.ts` already re-exports the career layer's other typed
 * errors the same way, so this is the existing convention rather than a new one.
 */
export { ClaimVerificationError } from './verification.js';
export type { ClaimVerificationErrorCode } from './verification.js';

/** The provenance of a fact the user TYPED, as opposed to one extracted from a document. */
export const USER_ENTERED_PROVENANCE = ClaimProvenance.user_entered;

export interface UserClaimDecisionInput {
  claimId: string;
  /** Non-null by contract: a claim decision is a human decision with an accountable actor. */
  actorUserId: string;
  note?: string | null;
  now?: Date;
}

export type UserConfirmInput = UserClaimDecisionInput & { statement?: string | null };
export type UserRejectInput = UserClaimDecisionInput & { reason?: string | null };

export interface UserCreateClaimInput {
  profileId: string;
  kind: ClaimKind;
  statement: string;
  /** Required only when `confirm` is true: a decision has an accountable actor. */
  actorUserId?: string;
  note?: string | null;
  /**
   * The user asking for the new claim to be confirmed on creation. It is a USER gesture,
   * not an inference, and it still produces a `ClaimVerification` row - which is exactly
   * why it is a boolean the caller must set rather than a status it may pass.
   */
  confirm?: boolean;
}

export interface UserEditClaimInput {
  claimId: string;
  actorUserId: string;
  statement: string;
  note?: string | null;
  confirm?: boolean;
}

export interface UserClaimResult {
  claim: CareerClaim;
  /** The audit row, or `null` for an idempotent repeat (no second row is written). */
  verification: ClaimDecisionResult['verification'];
  /** `false` when the claim was already in the target state (idempotent no-op). */
  changed: boolean;
  action: ClaimDecisionResult['action'];
}

export interface UserCreateClaimResult {
  claim: CareerClaim;
  verification: ClaimDecisionResult['verification'];
  changed: boolean;
  /** Whether the row was new, or already observed (fingerprint dedupe). */
  outcome: 'created' | 'deduped';
  /** Whether the create also confirmed. There is no audit row when it did not. */
  confirmed: boolean;
  /** The verification action; present only when `confirmed` is true. */
  action?: ClaimDecisionResult['action'];
}

/** Confirm (or edit-and-confirm, when a `statement` is supplied). */
export function confirmUserClaim(
  input: UserConfirmInput,
  store: CareerStore,
): Promise<UserClaimResult> {
  const statement = typeof input.statement === 'string' ? input.statement.trim() : undefined;
  const decision =
    statement !== undefined && statement.length > 0
      ? editConfirmClaim(
          {
            claimId: input.claimId,
            actorUserId: input.actorUserId,
            statement,
            note: input.note ?? null,
            ...(input.now ? { now: input.now } : {}),
          },
          store,
        )
      : confirmClaim(
          {
            claimId: input.claimId,
            actorUserId: input.actorUserId,
            note: input.note ?? null,
            ...(input.now ? { now: input.now } : {}),
          },
          store,
        );
  return decision;
}

export function rejectUserClaim(
  input: UserRejectInput,
  store: CareerStore,
): Promise<UserClaimResult> {
  return rejectClaim(
    {
      claimId: input.claimId,
      actorUserId: input.actorUserId,
      reason: input.reason ?? null,
      note: input.note ?? null,
      ...(input.now ? { now: input.now } : {}),
    },
    store,
  );
}

/** Clear a rejection. NOT a confirmation - reopening is the first of two decisions. */
export function reopenUserClaim(
  input: UserClaimDecisionInput,
  store: CareerStore,
): Promise<UserClaimResult> {
  return reopenClaim(
    {
      claimId: input.claimId,
      actorUserId: input.actorUserId,
      note: input.note ?? null,
      ...(input.now ? { now: input.now } : {}),
    },
    store,
  );
}

/**
 * A hand-entered claim, born UNCONFIRMED.
 *
 * The status is `IMPORTED_CLAIM_STATUS` - the same literal an import uses, and for the
 * same reason: nothing about how a claim came to exist tells us the user has verified
 * it. "I typed this" is a provenance (`user_entered`), not a confirmation.
 */
export async function createUserClaim(
  input: UserCreateClaimInput,
  store: CareerStore,
): Promise<UserCreateClaimResult> {
  const data: ClaimCreateInput = {
    profileId: input.profileId,
    kind: input.kind,
    statement: input.statement,
    status: IMPORTED_CLAIM_STATUS,
    provenance: USER_ENTERED_PROVENANCE,
    confidence: null,
    inferenceMethod: null,
    evidenceSourceId: null,
    experienceId: null,
    educationId: null,
    projectId: null,
    skillId: null,
    certificationId: null,
    achievementId: null,
  };
  const created = await createClaim(data, store);
  if (input.confirm !== true) {
    return {
      claim: created.claim,
      verification: null,
      // "Changed" means a NEW row was written. A deduped create changed nothing, which
      // is the honest report of a fingerprint that was already observed.
      changed: created.outcome === 'created',
      outcome: created.outcome,
      confirmed: false,
    };
  }
  const result = await confirmClaim(
    {
      claimId: created.claim.id,
      // `confirmClaim` refuses an empty actor with an `invalid_input` error, so this is
      // a loud failure rather than an anonymous audit row if a caller forgets it.
      actorUserId: input.actorUserId ?? '',
      note: input.note ?? null,
    },
    store,
  );
  return {
    claim: result.claim,
    verification: result.verification,
    changed: result.changed,
    action: result.action,
    outcome: created.outcome,
    confirmed: true,
  };
}

/**
 * Re-word a claim, with or without confirming it in the same gesture.
 *
 * `confirm: false` records `action = edit`, which is RECORDED and does NOT confirm. A
 * `user_confirmed` claim must be re-worded through `confirmUserClaim` with a statement,
 * so the audit row always describes the text that is actually in the row.
 */
export function editUserClaim(
  input: UserEditClaimInput,
  store: CareerStore,
): Promise<UserClaimResult> {
  return input.confirm === true
    ? editConfirmClaim(
        {
          claimId: input.claimId,
          actorUserId: input.actorUserId,
          statement: input.statement,
          note: input.note ?? null,
        },
        store,
      )
    : recordClaimEdit(
        {
          claimId: input.claimId,
          actorUserId: input.actorUserId,
          statement: input.statement,
          note: input.note ?? null,
        },
        store,
      );
}
