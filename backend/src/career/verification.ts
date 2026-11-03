// =====================================================================================
// career/verification.ts - the ONLY module permitted to set CareerClaim.status (T1011).
//
// ADR-036 item 3: "status = user_confirmed is settable ONLY together with a
// ClaimVerification row (action IN (confirm, edit_confirm), non-null actorUserId). There
// is no code path that sets user_confirmed without writing that row. A DB trigger
// (BEFORE UPDATE) is the belt-and-braces version; a Prisma-level guard is the minimum."
//
// The database cannot give us that. "user_confirmed requires an audit row" is not
// expressible in Prisma (05 sec.8) and the T1010 migration deliberately ships no raw
// trigger, so THIS FILE IS THE GUARANTEE. Four things make it real:
//
//   1. TRANSITION TABLE. A claim's status can only move along the five rows of
//      `CLAIM_TRANSITIONS`. `user_confirmed` is reachable ONLY from an unconfirmed,
//      un-rejected claim, and ONLY through `confirmClaim` / `editConfirmClaim`.
//      Everything else throws `ClaimVerificationError`, and this module exports no
//      generic setter (`verification.test.ts` asserts the module's export surface).
//   2. ONE TRANSACTION. Each decision writes the status change AND the
//      `ClaimVerification` row in a single `$transaction`. A claim can therefore
//      never be `user_confirmed` without its audit row, and a failed audit write
//      rolls the status change back with it.
//   3. NO MACHINE PATH TO CONFIRMED. `rejected` is cleared only by `reopenClaim`, and
//      a rejected claim is blocked from `confirm` / `edit_confirm` / `edit` until it
//      is reopened: an AI re-run can never "re-find" a rejected claim.
//   4. A `reopen` only returns the claim to `inferred`. Reopening is not confirming;
//      the user still has to confirm, which is the second audit row.
//
// The DB seam is injected (`CareerStore`); this module never imports the `prisma`
// singleton and is unit testable with no live database.
// =====================================================================================

import {
  ClaimStatus,
  VerificationAction,
  VerificationTarget,
  type Prisma,
} from '@prisma/client';
import {
  ClaimInvariantError,
  ClaimNotFoundError,
  claimFingerprint,
  requireClaimById,
  type CareerClaimRow,
  type CareerStore,
  type CareerTxStore,
  type ClaimVerificationRow,
} from './claims.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ClaimVerificationErrorCode = 'illegal_transition' | 'not_found' | 'invalid_input';

/** An illegal claim decision (bad transition, bad actor, missing claim). */
export class ClaimVerificationError extends Error {
  readonly code: ClaimVerificationErrorCode;

  constructor(code: ClaimVerificationErrorCode, message: string) {
    super(message);
    this.name = 'ClaimVerificationError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The transition table (the whole legal surface)
// ---------------------------------------------------------------------------

export interface ClaimTransition {
  /** Statuses the action may start from. */
  readonly from: readonly ClaimStatus[];
  /** Destination status, or `null` when the action changes no status at all. */
  readonly to: ClaimStatus | null;
}

/**
 * The COMPLETE set of claim status transitions (05 sec.2, ADR-036 items 3-6). Any
 * move that is not a row here is impossible: no other module may set `status` at all
 * (`claims.ts` REFUSES a `status` patch), and this module offers no generic setter.
 *
 * The asymmetries are the point:
 * - INTO `user_confirmed`: from `inferred|contextual` only, action `confirm|edit_confirm`;
 * - OUT OF `rejected`: only via `reopen` (to `inferred`) - never by a machine write;
 * - a `rejected` claim is not in any `from` list except `reopen`'s, so confirm and
 *   edit are refused until the user reopens it (see `assertTransitionAllowed`).
 */
export const CLAIM_TRANSITIONS: Readonly<Record<VerificationAction, ClaimTransition>> = {
  [VerificationAction.confirm]: {
    from: [ClaimStatus.inferred, ClaimStatus.contextual],
    to: ClaimStatus.user_confirmed,
  },
  [VerificationAction.edit_confirm]: {
    from: [ClaimStatus.inferred, ClaimStatus.contextual],
    to: ClaimStatus.user_confirmed,
  },
  [VerificationAction.reject]: {
    from: [
      ClaimStatus.inferred,
      ClaimStatus.contextual,
      ClaimStatus.user_confirmed,
      ClaimStatus.superseded,
    ],
    to: ClaimStatus.rejected,
  },
  [VerificationAction.reopen]: {
    from: [ClaimStatus.rejected],
    to: ClaimStatus.inferred,
  },
  [VerificationAction.edit]: {
    from: [ClaimStatus.inferred, ClaimStatus.contextual, ClaimStatus.superseded],
    to: null,
  },
};

/** Machine-readable reason for "a rejected claim needs an explicit reopen first". */
const REJECTED_BLOCK =
  'this claim is rejected: reopen it first (verification.reopenClaim) before confirming or editing it - a rejection is never cleared implicitly (ADR-036 item 5)';

// ---------------------------------------------------------------------------
// Inputs / results
// ---------------------------------------------------------------------------

export interface ClaimDecisionInput {
  claimId: string;
  /** The human who decided. Non-null by contract: a machine has no actor. */
  actorUserId: string;
  note?: string | null;
  /** Injected clock; defaults to `new Date()`. */
  now?: Date;
}

export type ConfirmClaimInput = ClaimDecisionInput;

export interface EditConfirmClaimInput extends ClaimDecisionInput {
  statement: string;
}

export interface RejectClaimInput extends ClaimDecisionInput {
  reason?: string | null;
}

export interface RecordClaimEditInput extends ClaimDecisionInput {
  statement: string;
}

export interface ClaimDecisionResult {
  claim: CareerClaimRow;
  /** The audit row, or `null` for an idempotent repeat (no second row is written). */
  verification: ClaimVerificationRow | null;
  /** `false` when the claim was already in the target state (idempotent no-op). */
  changed: boolean;
  action: VerificationAction;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** The auditable surface of a claim. Deliberately excludes `jobRelevance` (derived). */
function claimSnapshot(claim: CareerClaimRow): Prisma.InputJsonObject {
  return {
    status: claim.status,
    statement: claim.statement,
    fingerprint: claim.fingerprint,
    provenance: claim.provenance,
    confidence: claim.confidence ?? null,
    confidenceIsMetadataOnly: true,
    confirmedAt: isoOrNull(claim.confirmedAt),
    rejectedAt: isoOrNull(claim.rejectedAt),
    rejectedReason: claim.rejectedReason ?? null,
  };
}

// ---------------------------------------------------------------------------
// The single decision runner
// ---------------------------------------------------------------------------

interface DecisionPlan<TInput extends ClaimDecisionInput> {
  action: VerificationAction;
  /** The status this decision sends the claim to (`null` = no status change). */
  to: ClaimStatus | null;
  /** Extra claim columns the decision owns (timestamps, rejection reason, ...). */
  buildData: (args: { now: Date; input: TInput }) => Prisma.CareerClaimUncheckedUpdateInput;
  /** Repeat of the same decision: idempotent no-op instead of an error. */
  alreadyApplied: (claim: CareerClaimRow, statement: string | undefined) => boolean;
  /** Extra legality beyond the table. */
  assertInput?: (input: TInput) => void;
}

function requireActor(actorUserId: unknown, context: string): string {
  if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
    throw new ClaimVerificationError(
      'invalid_input',
      `${context}: actorUserId is required and must be non-null - a claim decision is a human decision with an accountable actor (ADR-036 item 3)`,
    );
  }
  return actorUserId;
}

function resolveNow(now: unknown): Date {
  if (now === undefined || now === null) return new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ClaimVerificationError('invalid_input', 'now must be a valid Date');
  }
  return now;
}

function optionalStatement(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ClaimVerificationError('invalid_input', `${context}: a non-empty statement is required`);
  }
  return value.trim();
}

function assertTransitionAllowed(action: VerificationAction, claim: CareerClaimRow): void {
  const transition = CLAIM_TRANSITIONS[action];
  if (!transition) {
    throw new ClaimVerificationError(
      'illegal_transition',
      `unknown verification action ${JSON.stringify(action)}; the only legal claim decisions are ${Object.keys(
        CLAIM_TRANSITIONS,
      ).join(', ')}`,
    );
  }
  if (claim.status === ClaimStatus.rejected && !transition.from.includes(ClaimStatus.rejected)) {
    throw new ClaimVerificationError('illegal_transition', `${REJECTED_BLOCK} (claim ${claim.id})`);
  }
  if (!transition.from.includes(claim.status)) {
    throw new ClaimVerificationError(
      'illegal_transition',
      `cannot ${action} a claim with status ${claim.status} (claim ${claim.id}); ${action} requires status ${transition.from.join('|')}`,
    );
  }
}

/**
 * The only place in the whole career layer that writes `CareerClaim.status`.
 * Module-private on purpose: no caller can reach a generic setter, and the status
 * write is never separable from the audit row that justifies it.
 */
async function runDecision<TInput extends ClaimDecisionInput>(
  input: TInput,
  plan: DecisionPlan<TInput>,
  store: CareerStore,
): Promise<ClaimDecisionResult> {
  if (input === null || typeof input !== 'object') {
    throw new ClaimVerificationError('invalid_input', 'a claim decision needs an input object');
  }
  plan.assertInput?.(input);
  const actorUserId = requireActor(input.actorUserId, plan.action);
  const now = resolveNow(input.now);
  const statement = optionalStatement(
    (input as { statement?: unknown }).statement,
    plan.action,
  );

  return store.$transaction(async (tx: CareerTxStore) => {
    let claim: CareerClaimRow;
    try {
      claim = await requireClaimById(input.claimId, tx);
    } catch (error) {
      if (error instanceof ClaimNotFoundError) {
        throw new ClaimVerificationError('not_found', error.message);
      }
      throw error;
    }

    // Idempotent repeat: the same decision twice writes NO second audit row
    // (ADR-036 consequence (d) / T1012 case (e)).
    if (plan.alreadyApplied(claim, statement)) {
      return { claim, verification: null, changed: false, action: plan.action };
    }

    assertTransitionAllowed(plan.action, claim);

    // A statement change moves the fingerprint with it, otherwise the claim's
    // identity would describe text the row no longer holds.
    let fingerprint: string | undefined;
    if (statement !== undefined && statement !== claim.statement) {
      fingerprint = claimFingerprint(claim.kind, statement);
      const clash = await tx.careerClaim.findFirst({
        where: { profileId: claim.profileId, fingerprint },
      });
      if (clash && clash.id !== claim.id) {
        throw new ClaimInvariantError(
          `claim ${claim.id} would collide with existing claim ${clash.id} (same kind + statement)`,
        );
      }
    }

    const updated = await tx.careerClaim.update({
      where: { id: claim.id },
      data: {
        ...(statement !== undefined ? { statement } : {}),
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        ...plan.buildData({ now, input }),
      },
    });

    // The audit row. `actorUserId` is non-null by construction and `action` is one of
    // the five the table allows - the two facts that make a `user_confirmed` row legal.
    const verification = await tx.claimVerification.create({
      data: {
        userId: actorUserId,
        actorUserId,
        targetType: VerificationTarget.career_claim,
        targetId: claim.id,
        claimId: claim.id,
        action: plan.action,
        before: claimSnapshot(claim),
        after: claimSnapshot(updated),
        note: input.note ?? null,
        createdAt: now,
      },
    });

    return { claim: updated, verification, changed: true, action: plan.action };
  });
}

// ---------------------------------------------------------------------------
// The five public decisions
// ---------------------------------------------------------------------------

/**
 * User confirms an inferred claim -> `user_confirmed` + exactly one `ClaimVerification`
 * (`action = confirm`, non-null `actorUserId`) in the same transaction.
 *
 * A `rejected` claim is REFUSED: the user must `reopenClaim` first, so a rejection
 * can never be laundered into a confirmation (ADR-036 item 5). A second `confirmClaim`
 * on an already-confirmed claim is an idempotent no-op that writes no second row.
 */
export function confirmClaim(
  input: ConfirmClaimInput,
  store: CareerStore,
): Promise<ClaimDecisionResult> {
  return runDecision(
    input,
    {
      action: VerificationAction.confirm,
      to: ClaimStatus.user_confirmed,
      alreadyApplied: (claim) => claim.status === ClaimStatus.user_confirmed,
      buildData: ({ now }) => ({
        status: ClaimStatus.user_confirmed,
        confirmedAt: now,
        rejectedAt: null,
        rejectedReason: null,
      }),
    },
    store,
  );
}

/**
 * User edits AND confirms in one gesture -> `user_confirmed` + exactly one
 * `ClaimVerification` (`action = edit_confirm`). The fingerprint follows the new text;
 * the status does not depend on the fingerprint.
 */
export function editConfirmClaim(
  input: EditConfirmClaimInput,
  store: CareerStore,
): Promise<ClaimDecisionResult> {
  return runDecision(
    input,
    {
      action: VerificationAction.edit_confirm,
      to: ClaimStatus.user_confirmed,
      assertInput: (decision) => {
        optionalStatement(decision.statement, 'edit_confirm');
      },
      alreadyApplied: (claim, statement) =>
        claim.status === ClaimStatus.user_confirmed && statement === claim.statement,
      buildData: ({ now }) => ({
        status: ClaimStatus.user_confirmed,
        confirmedAt: now,
        rejectedAt: null,
        rejectedReason: null,
      }),
    },
    store,
  );
}

/**
 * User rejects a claim -> `rejected` + one `ClaimVerification` (`action = reject`).
 * Rejecting a confirmed claim clears `confirmedAt`; the old value survives in the
 * audit row's `before`. After this, no machine path - including `claimWriterAI` -
 * can touch the claim again without a `reopenClaim`.
 */
export function rejectClaim(
  input: RejectClaimInput,
  store: CareerStore,
): Promise<ClaimDecisionResult> {
  return runDecision(
    input,
    {
      action: VerificationAction.reject,
      to: ClaimStatus.rejected,
      assertInput: (decision) => {
        const reason = decision.reason;
        if (reason !== undefined && reason !== null && typeof reason !== 'string') {
          throw new ClaimVerificationError('invalid_input', 'reject: reason must be a string or null');
        }
      },
      alreadyApplied: (claim) => claim.status === ClaimStatus.rejected,
      buildData: ({ now, input: decision }) => ({
        status: ClaimStatus.rejected,
        rejectedAt: now,
        rejectedReason: decision.reason ?? null,
        confirmedAt: null,
      }),
    },
    store,
  );
}

/**
 * User reopens a rejected claim -> back to `inferred` (NOT `user_confirmed`: a reopen
 * only clears the rejection; confirming it is a separate, second decision) + one
 * `ClaimVerification` (`action = reopen`). Throws unless the claim is `rejected`.
 */
export function reopenClaim(
  input: ClaimDecisionInput,
  store: CareerStore,
): Promise<ClaimDecisionResult> {
  return runDecision(
    input,
    {
      action: VerificationAction.reopen,
      to: ClaimStatus.inferred,
      alreadyApplied: () => false,
      buildData: () => ({
        status: ClaimStatus.inferred,
        rejectedAt: null,
        rejectedReason: null,
        confirmedAt: null,
      }),
    },
    store,
  );
}

/**
 * User re-words a claim WITHOUT confirming it -> one `ClaimVerification`
 * (`action = edit`), status untouched (05 sec.4: `edit` is "recorded, does not
 * confirm"). A confirmed claim must use `editConfirmClaim` instead, and a rejected
 * one must be reopened first.
 */
export function recordClaimEdit(
  input: RecordClaimEditInput,
  store: CareerStore,
): Promise<ClaimDecisionResult> {
  return runDecision(
    input,
    {
      action: VerificationAction.edit,
      to: null,
      assertInput: (decision) => {
        optionalStatement(decision.statement, 'edit');
      },
      alreadyApplied: (claim, statement) => statement !== undefined && statement === claim.statement,
      buildData: () => ({}),
    },
    store,
  );
}

// ---------------------------------------------------------------------------
// Read: the audit trail
// ---------------------------------------------------------------------------

export const DEFAULT_VERIFICATION_PAGE = 100;
export const MAX_VERIFICATION_PAGE = 500;

export interface ListVerificationsQuery {
  claimId: string;
  limit?: number;
  offset?: number;
}

/** The append-only human-decision history of one claim, newest first. */
export async function listClaimVerifications(
  query: ListVerificationsQuery,
  store: CareerStore,
): Promise<ClaimVerificationRow[]> {
  if (query === null || typeof query !== 'object') {
    throw new ClaimVerificationError('invalid_input', 'listClaimVerifications needs a query object');
  }
  if (typeof query.claimId !== 'string' || query.claimId.length === 0) {
    throw new ClaimVerificationError('invalid_input', 'listClaimVerifications needs a non-empty claimId');
  }
  const limit =
    typeof query.limit === 'number' && Number.isFinite(query.limit) && query.limit >= 1
      ? Math.min(Math.floor(query.limit), MAX_VERIFICATION_PAGE)
      : DEFAULT_VERIFICATION_PAGE;
  return store.claimVerification.findMany({
    where: { claimId: query.claimId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(typeof query.offset === 'number' && query.offset > 0 ? { skip: Math.floor(query.offset) } : {}),
  });
}
