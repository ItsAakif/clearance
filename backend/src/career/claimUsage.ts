// =====================================================================================
// career/claimUsage.ts - `ResumeClaimUsage` recording + THE PRE-RENDER GATE
// (T1030; ADR-036 item 6; 05 sec.2.5, sec.5, sec.6.3, sec.6.4).
//
// This module is the load-bearing one. Everything else in the resume derivation layer
// can be refactored; if this stops working, an unconfirmed claim reaches a PDF.
//
// THE GATE, in one sentence: a `ResumeRevision` whose `ResumeClaimUsage` says
// `verbatim` or `tailored` for a claim whose status is anything other than the
// confirming one is REFUSED, and the refusal carries a machine-readable reason. An
// `inferred` claim may exist in the profile, may be shown to the user as a
// "suggestion", and may be re-projected - it may not enter a rendered or exported
// artifact. `omitted` usage is always fine; it is exactly the "the profile knows this
// and the resume does not say it" case.
//
// WHY THE STATUS IS READ FROM THE DATABASE, NEVER FROM THE DOCUMENT. The snapshot in
// `ResumeRevision.resumeJson` carries an `x-clearance` block that states each claim's
// status, and it would be far cheaper to gate on that. It is refused on purpose: the
// document is a DERIVED artifact (05 sec.1), it is a JSON payload that crossed the
// network and a file system, and a status that a renderer can read is a status a
// renderer can be shown lying about. `evaluatePreRenderGate` is a pure function over
// `(claimId, usage, claimStatus)` tuples; the tuples come from
// `CareerClaim.status`, read fresh. `loadGateUsages` is the only thing in the
// repository that produces them, and it is a `careerClaim.findMany`.
//
// WHY IT IS A PURE FUNCTION PLUS A GUARD, NOT A ROUTE INLINE. `evaluatePreRenderGate`
// has no clock, no I/O, no randomness and a total order on its output, so every
// branch of the truth table is a unit test rather than an HTTP test. `withPreRenderGate`
// is the guard: it loads, evaluates, THROWS on a block, and only then calls the render
// thunk. A caller cannot get the render without passing through the gate, because
// "call the render" is not reachable except as the thunk argument - and the ordering
// test proves the thunk is never entered on a blocked revision, which is the property
// the whole system rests on.
//
// THE WRITE-TIME GUARD IS NARROWER THAN THE GATE, DELIBERATELY. 05 sec.6.4 says
// "`usage` creation validates `status IN (user_confirmed)`; a rejected claim has no
// valid usage". Taken literally that would make `inferred` usage unrecordable, and the
// gate could then never fire for it - which would delete ADR-036 item 6's mandatory
// test (e) ("the pre-render gate blocks an unconfirmed claim") and leave the system
// with no working demonstration of the control at all. So the two layers are split the
// only way that keeps both promises:
//   - WRITE TIME (`recordClaimUsages`): a usage may never reference a claim that does
//     not exist, and may never RENDER a `rejected` claim. ADR-036 item 5 - a rejection
//     is cleared only by a user `reopen`, and a rejected claim can never be USED as
//     text at any layer, not just at render time.
//   - RENDER TIME (this gate): the full rule. Every non-confirmed status, including
//     `rejected`, is refused with its own reason.
//
// WHY THE WRITE-TIME REFUSAL IS GATED ON THE USAGE, AND NOT ON THE STATUS ALONE (the
// defect round, finding F1). It used to refuse a `rejected` claim for EVERY usage,
// which contradicted this header (rule 4 at `:303`), contradicted `evaluatePreRenderGate`
// (which returns early for anything not in `GATED_USAGES`), and made the belt a DEAD END
// rather than a control: `project.ts` records every claim it did not place as
// `usage: omitted`, and the `x-clearance` block is the document's own complete account of
// itself, so ONE rejected statement anywhere in a profile made EVERY revision write 409 -
// with no way back except a `reopen` that puts the statement back on the claim rail.
// An `omitted` usage puts NOTHING on the page and is inert at render time, so refusing it
// protected nothing that was not already protected by the gate. The refusal now applies
// exactly where the gate applies: to a usage that would RENDER the claim.
// The result is a STRICT SUPERSET of sec.6.4: nothing that rule forbids can be used,
// and the gate is still reachable, so it is still real. 05 sec.6.4 item 4 NOW CARRIES
// THIS RESOLUTION (the spec was corrected during T1030; see the T1030 progress note),
// so the two documents agree about who decided what.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DECIDE. `evaluatePreRenderGate` is a pure
// function over `(claimId, usage, claimStatus)` tuples, so it can only answer "is the
// usage set I was handed clean?". It cannot answer "WHERE DID THIS USAGE SET COME
// FROM?", and that was a real hole: an empty set is vacuously clean, so a revision
// whose document quoted text and recorded no usage passed the gate with a green
// verdict. The fix is NOT in this function - changing its truth table would delete
// `omitted`-is-always-fine and make the pure half impure. It is in
// `resume/revisions.ts`, which (a) DERIVES the usage set from the document's
// `x-clearance` block at write time so a revision cannot exist without one, (b) refuses
// a block naming one `claimId` twice, and (c) re-derives the set, compares it to the
// recorded rows as a MULTISET of `(claimId, usage)`, and accounts for every claim-backed
// string in the stored document - all in `assertRevisionRenderableInScope`, the read-time
// enforcement point. The route guard runs that; the pure gate below is unchanged.
//
// The DB seam is INJECTED (`ResumeClaimUsageStore`), following `career/claims.ts`:
// no module here imports the `prisma` singleton, and the whole truth table is proven
// with no live database.
// =====================================================================================

import {
  ClaimProvenance,
  ClaimStatus,
  ResumeUsage,
  type CareerClaim,
  type ResumeClaimUsage,
} from '@prisma/client';
import { ClaimInvariantError, ClaimNotFoundError, claimFingerprint } from './claims.js';

// ---------------------------------------------------------------------------
// The imported/derived status vocabulary (imported by the resume layer)
// ---------------------------------------------------------------------------

/**
 * The ONLY status a claim created by an import, a lowering or a backfill may carry.
 *
 * Exported so the resume layer never re-declares the vocabulary. 05 sec.7.7 makes this
 * explicit for the legacy backfill: a user's existing resume must appear in the new
 * studio as an UNVERIFIED DRAFT, because that is the honest state, and "Never
 * auto-confirm imported content" is the sentence the whole migration rests on.
 *
 * `typeof IMPORTED_CLAIM_STATUS` is the literal type `'inferred'`, so a field typed
 * with it cannot be assigned the confirming status without a compile error.
 */
export const IMPORTED_CLAIM_STATUS = ClaimStatus.inferred;

/** The provenance every imported claim carries (05 sec.4: "document_import"). */
export const IMPORTED_CLAIM_PROVENANCE = ClaimProvenance.document_import;

/** `InferenceMethod` for an import: this is where 05 sec.7.7's backfill records itself. */
export const IMPORTED_INFERENCE_METHOD = 'json_resume_import';

// ---------------------------------------------------------------------------
// The status vocabulary, re-exported for modules outside `career/`
// ---------------------------------------------------------------------------

const CLAIM_STATUS_VALUES: readonly string[] = Object.values(ClaimStatus);
const RESUME_USAGE_VALUES: readonly string[] = Object.values(ResumeUsage);

/**
 * Every status the database can hold. Exported so the resume layer's schema and its
 * validators describe the REAL enum instead of a copy of it that can drift (and so
 * neither has to hard-code a status literal).
 */
export const CLAIM_STATUSES: readonly ClaimStatus[] = CLAIM_STATUS_VALUES as ClaimStatus[];

export function isClaimStatus(value: unknown): value is ClaimStatus {
  return typeof value === 'string' && CLAIM_STATUS_VALUES.includes(value);
}

/** The usages that put a claim's text into the document. `omitted` is not one. */
export const GATED_USAGES: readonly ResumeUsage[] = [ResumeUsage.verbatim, ResumeUsage.tailored];

export function isResumeUsage(value: unknown): value is ResumeUsage {
  return typeof value === 'string' && RESUME_USAGE_VALUES.includes(value);
}

/**
 * The single status whose claims may be rendered. Everything else is refused. It is a
 * derived set rather than a negated test (`status !== rejected && ...`) so that a
 * status ADDED to the enum later is refused by default until someone decides about it
 * - fail closed on a vocabulary change.
 */
export const RENDERABLE_CLAIM_STATUSES: readonly ClaimStatus[] = [ClaimStatus.user_confirmed];

export function isRenderableClaimStatus(status: ClaimStatus): boolean {
  return RENDERABLE_CLAIM_STATUSES.includes(status);
}

/**
 * Is this the status a user REJECTION leaves behind?
 *
 * Named here so that no module outside `career/` hard-codes `ClaimStatus.rejected` - the
 * source guard in `claimWriterAI.test.ts` exists precisely because the claim status vocabulary
 * belongs to this layer, and the projector (F3) needed the same question this module already
 * answers in three places. It is a predicate over the vocabulary rather than an exported
 * constant because "rejected" is a status, and the set of statuses a caller may name is the
 * gate's business, not this module's.
 */
export function isRejectedClaimStatus(status: ClaimStatus): boolean {
  return status === ClaimStatus.rejected;
}

// ---------------------------------------------------------------------------
// The rejection vocabulary (closed, machine-readable, no caller data in the message)
// ---------------------------------------------------------------------------

/**
 * The CLOSED set of reasons the gate may refuse a revision with. Mirrors the pattern
 * `render/stage.ts` uses for its own error surface, for the same reason: a reason set
 * that is an open `string` is a reason set that grows by accident.
 */
export const GATE_REJECTION_REASONS = Object.freeze([
  /** A rendered usage points at a claim that is not the confirming status. */
  'CLAIM_NOT_CONFIRMED',
  /** A usage points at a claim id that resolves to no row. Fail closed. */
  'CLAIM_NOT_FOUND',
  /** A usage value is outside the `ResumeUsage` enum. Fail closed. */
  'USAGE_UNKNOWN',
] as const);

export type GateRejectionReason = (typeof GATE_REJECTION_REASONS)[number];

/** Fixed text per reason. No claim id, no statement, no document path is interpolated. */
const REASON_TEXT: Readonly<Record<GateRejectionReason, string>> = Object.freeze({
  CLAIM_NOT_CONFIRMED:
    'a claim rendered by this revision is not user-confirmed; an inference is never user-confirmed experience (ADR-036 item 6)',
  CLAIM_NOT_FOUND:
    'a claim rendered by this revision does not resolve to a claim row; the gate fails closed on an unresolvable reference',
  USAGE_UNKNOWN: 'a claim usage is outside the verbatim|tailored|omitted vocabulary',
});

/** One offending usage. Everything a caller needs to fix it, and nothing more. */
export interface GateViolation {
  claimId: string;
  /** `null` when the claim id resolved to no row. */
  status: ClaimStatus | null;
  usage: ResumeUsage | 'unknown';
  reason: GateRejectionReason;
}

export type PreRenderGateErrorCode = 'PRE_RENDER_GATE_BLOCKED' | 'PRE_RENDER_GATE_INVALID';

/** The gate refused. Carries the reason and every violation, sorted by `claimId`. */
export class PreRenderGateError extends Error {
  readonly code: PreRenderGateErrorCode = 'PRE_RENDER_GATE_BLOCKED';
  readonly reason: GateRejectionReason;
  readonly violations: readonly GateViolation[];
  /** How many usages were examined, so a caller can report "12 checked, 2 blocking". */
  readonly checked: number;

  constructor(reason: GateRejectionReason, violations: readonly GateViolation[], checked: number) {
    super(`PRE_RENDER_GATE_BLOCKED: ${REASON_TEXT[reason]}`);
    this.name = 'PreRenderGateError';
    this.reason = reason;
    this.violations = Object.freeze([...violations]);
    this.checked = checked;
  }

  /** A flat, log-safe, caller-data-free summary. Never the statements. */
  toJSON(): {
    code: PreRenderGateErrorCode;
    reason: GateRejectionReason;
    checked: number;
    violations: readonly GateViolation[];
  } {
    return {
      code: this.code,
      reason: this.reason,
      checked: this.checked,
      violations: this.violations,
    };
  }
}

/** A malformed gate call (a non-array, a non-object entry) - a programming error. */
export class PreRenderGateInputError extends Error {
  readonly code = 'pre_render_gate_invalid' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PreRenderGateInputError';
  }
}

// ---------------------------------------------------------------------------
// The injected DB seam
// ---------------------------------------------------------------------------

/**
 * The narrowest seam the usage recorder and the gate need, `Pick`ed from the generated
 * client so a column name cannot drift while the whole thing stays trivially fakeable.
 * `CareerStore` (career/claims.ts) is NOT enough: these tables are part of the resume
 * derivation layer, not the claim layer.
 *
 * ONLY THE MEMBERS THIS MODULE ACTUALLY CALLS. It used to `Pick` the whole
 * `resumeClaimUsage | careerClaim | resumeRevision` delegates, which is a wider promise
 * than the code keeps: nothing here reads a revision. A seam that names a delegate the
 * module never touches is a seam a future edit can start using by accident - and this
 * one is the seam `resume/revisions.ts` hands its own (deliberately narrowed) store
 * through, so an over-wide type there would have forced a cast and thrown the
 * immutability narrowing away.
 */
export type ResumeClaimUsageStore = {
  careerClaim: { findMany(args: unknown): Promise<CareerClaim[]> };
  resumeClaimUsage: {
    create(args: unknown): Promise<ResumeClaimUsage>;
    findMany(args: unknown): Promise<ResumeClaimUsage[]>;
  };
};

/**
 * Optional narrowing for `recordClaimUsages` / `assertClaimUsagesRecordable`.
 *
 * `profileId` scopes the claim load to ONE career profile, so a revision cannot record
 * a usage naming another tenant's claim. It is optional because the callers that
 * genuinely have no profile in hand (the unit tests, the seam-only assertions) must keep
 * working, and because scoping is a caller-supplied constraint, not something this
 * module can invent. `createRevision` DOES have it - the `x-clearance` block names its
 * own `profileId` - so the production write path is always scoped.
 */
export interface ClaimUsageScope {
  profileId?: string | null;
}

// ---------------------------------------------------------------------------
// THE GATE - a pure function over resolved statuses
// ---------------------------------------------------------------------------

/** One usage paired with the status its claim has RIGHT NOW. */
export interface GateUsage {
  readonly claimId: string;
  readonly usage: ResumeUsage;
  /** `null` when the claim id resolved to no row. Never guess; fail closed. */
  readonly claimStatus: ClaimStatus | null;
}

export interface GateAllowed {
  readonly allowed: true;
  /** Every usage examined, including the `omitted` ones. */
  readonly checked: number;
  /** How many of them were `verbatim` or `tailored`. */
  readonly rendered: number;
}

export interface GateBlocked {
  readonly allowed: false;
  readonly reason: GateRejectionReason;
  readonly violations: readonly GateViolation[];
  readonly checked: number;
  readonly rendered: number;
}

export type GateVerdict = GateAllowed | GateBlocked;

/**
 * THE PRE-RENDER GATE. Pure: no clock, no I/O, no randomness, no store, no module
 * state. The same input array yields the same verdict array, in the same order, on
 * every host and in every process.
 *
 * The rules, in the order they are applied to each usage:
 *   1. a usage outside the `ResumeUsage` enum        -> `USAGE_UNKNOWN`;
 *   2. a usage whose claim id resolves to no row      -> `CLAIM_NOT_FOUND`;
 *   3. a `verbatim` / `tailored` usage on a claim
 *      whose status is not the confirming one          -> `CLAIM_NOT_CONFIRMED`;
 *   4. anything else passes. `omitted` is always fine, whatever the status.
 *
 * Rule 3 is the whole invariant. It is expressed as membership of
 * `RENDERABLE_CLAIM_STATUSES` rather than as "not one of the bad ones", so a status
 * added to the enum in a later migration blocks by default instead of silently
 * becoming renderable.
 *
 * The `reason` on a blocked verdict is the reason of the FIRST violation in the
 * returned (claimId-sorted) order, and EVERY violation is returned regardless - a
 * caller that surfaces only the first would make the user fix one claim per round
 * trip.
 */
export function evaluatePreRenderGate(usages: readonly unknown[]): GateVerdict {
  if (!Array.isArray(usages)) {
    throw new PreRenderGateInputError('evaluatePreRenderGate needs an array of usages');
  }

  const violations: GateViolation[] = [];
  let rendered = 0;

  usages.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PreRenderGateInputError(
        `evaluatePreRenderGate: usage[${index}] must be an object with { claimId, usage, claimStatus }`,
      );
    }
    const entry = raw as Record<string, unknown>;
    const claimId = typeof entry.claimId === 'string' ? entry.claimId : '';
    if (claimId.length === 0) {
      throw new PreRenderGateInputError(
        `evaluatePreRenderGate: usage[${index}] needs a non-empty claimId`,
      );
    }

    // 1. Vocabulary, checked BEFORE anything is interpreted: a usage we cannot name is
    //    a usage we cannot reason about, and defaulting it to `verbatim` (or to
    //    `omitted`) would be a guess in the one direction that must never happen.
    if (!isResumeUsage(entry.usage)) {
      violations.push({
        claimId,
        status: isClaimStatus(entry.claimStatus) ? entry.claimStatus : null,
        usage: 'unknown',
        reason: 'USAGE_UNKNOWN',
      });
      return;
    }
    const usage: ResumeUsage = entry.usage;

    if (!GATED_USAGES.includes(usage)) return;
    rendered += 1;

    // 2. A reference that resolves to nothing is refused rather than skipped. The
    //    schema has an FK, so this is unreachable through the ORM; it is reachable
    //    through any other writer, and a gate that ignores an unresolvable reference
    //    is a gate with a hole exactly the size of "a second writer exists".
    if (!isClaimStatus(entry.claimStatus)) {
      violations.push({ claimId, status: null, usage, reason: 'CLAIM_NOT_FOUND' });
      return;
    }
    const claimStatus: ClaimStatus = entry.claimStatus;

    // 3. THE RULE.
    if (!isRenderableClaimStatus(claimStatus)) {
      violations.push({ claimId, status: claimStatus, usage, reason: 'CLAIM_NOT_CONFIRMED' });
    }
  });

  if (violations.length > 0) {
    // A TOTAL order, so the reported reason does not depend on the order the rows
    // happened to come back from the database. `reason` is decided after the sort.
    violations.sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
    return Object.freeze({
      allowed: false as const,
      reason: violations[0].reason,
      violations: Object.freeze(violations),
      checked: usages.length,
      rendered,
    });
  }

  return Object.freeze({ allowed: true as const, checked: usages.length, rendered });
}

/**
 * Throw unless the verdict allows rendering. The assertion half of the gate, so a
 * caller can use the pure function for a preview and this one on the path that matters.
 */
export function assertPreRenderGate(verdict: GateVerdict): GateVerdict {
  if (verdict.allowed) return verdict;
  throw new PreRenderGateError(verdict.reason, verdict.violations, verdict.checked);
}

// ---------------------------------------------------------------------------
// Loading the gate's input: claim statuses read from the DATABASE
// ---------------------------------------------------------------------------

/** A usage row plus the status the gate needs, joined. */
export interface ResolvedUsage extends GateUsage {
  renderedText: string | null;
}

function assertRevisionId(revisionId: unknown, context: string): asserts revisionId is string {
  if (typeof revisionId !== 'string' || revisionId.length === 0) {
    throw new PreRenderGateInputError(`${context}: a non-empty revisionId is required`);
  }
}

/**
 * The gate's input, read fresh from the database.
 *
 * The statuses come from `careerClaim`, NOT from the `x-clearance` block inside
 * `ResumeRevision.resumeJson`. That is the single most important line in this module.
 * The document is derived, it has crossed a network and a file system, and a status a
 * renderer can read is a status a renderer can be lied to.
 *
 * A usage whose claim row has been deleted resolves to `claimStatus: null` rather than
 * being dropped, so the gate sees the unresolvable reference and fails closed on it.
 * (The schema's FK has `onDelete: Cascade`, so this is a defence against a writer that
 * bypassed the ORM, not an expected state.)
 */
export async function loadGateUsages(
  revisionId: string,
  store: ResumeClaimUsageStore,
): Promise<ResolvedUsage[]> {
  assertRevisionId(revisionId, 'loadGateUsages');
  const rows = await store.resumeClaimUsage.findMany({ where: { revisionId } });
  if (rows.length === 0) return [];

  const claimIds = [...new Set(rows.map((row) => row.claimId))].sort();
  const claims = await store.careerClaim.findMany({ where: { id: { in: claimIds } } });
  const statusById = new Map<string, ClaimStatus>(
    claims.map((claim: CareerClaim) => [claim.id, claim.status]),
  );

  return rows
    .map((row: ResumeClaimUsage) => ({
      claimId: row.claimId,
      // NOT `isResumeUsage(row.usage) ? row.usage : ...`: an out-of-enum value is
      // passed through as-is so `evaluatePreRenderGate` can refuse it with
      // `USAGE_UNKNOWN` instead of this function quietly repairing it.
      usage: row.usage as ResumeUsage,
      claimStatus: statusById.get(row.claimId) ?? null,
      renderedText: row.renderedText ?? null,
    }))
    .sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
}

/** Load, then evaluate. The two steps are split so the pure half stays pure. */
export async function evaluateRevisionPreRenderGate(
  revisionId: string,
  store: ResumeClaimUsageStore,
): Promise<GateVerdict> {
  return evaluatePreRenderGate(await loadGateUsages(revisionId, store));
}

/**
 * THE ROUTE GUARD. Throws `PreRenderGateError` unless the revision may be rendered.
 * A render route calls this as its first statement, before it touches a template, a
 * sandbox, a compiler or an output directory.
 */
export async function assertRevisionRenderable(
  revisionId: string,
  store: ResumeClaimUsageStore,
): Promise<GateVerdict> {
  return assertPreRenderGate(await evaluateRevisionPreRenderGate(revisionId, store));
}

/**
 * The gate AND the render, in that order, with no way to reach the second without the
 * first.
 *
 * `render` is reachable only as this thunk, so "run the render" is not something a
 * caller can do without passing the gate. On a blocked revision the thunk is NEVER
 * entered - which is the property the test suite proves, and the property that makes
 * the ordering a fact rather than a convention.
 */
export async function withPreRenderGate<T>(
  revisionId: string,
  store: ResumeClaimUsageStore,
  render: () => Promise<T>,
): Promise<T> {
  if (typeof render !== 'function') {
    throw new PreRenderGateInputError('withPreRenderGate needs a render function');
  }
  await assertRevisionRenderable(revisionId, store);
  return render();
}

// ---------------------------------------------------------------------------
// Recording usage for a revision
// ---------------------------------------------------------------------------

/** One usage to record. `status` is ABSENT on purpose - see the module header. */
export interface ClaimUsageInput {
  claimId: string;
  usage: ResumeUsage;
  /** The exact text that will appear. Required for `verbatim` / `tailored`. */
  renderedText?: string | null;
}

export interface RecordClaimUsagesResult {
  /** Rows actually inserted. */
  created: number;
  /** Usages already present for this revision (the `@@unique` pair); left untouched. */
  existing: number;
  rows: ResumeClaimUsage[];
}

/**
 * Validate a usage list WITHOUT writing anything, and hand back the claims it resolved.
 *
 * This is the VALIDATION HALF of `recordClaimUsages`, split out because the revision
 * writer has to run it BEFORE `store.resumeRevision.create`. It used to run only inside
 * the recorder, which ran only after the insert, so a usage naming a `rejected` claim
 * threw and left a fully-formed ORPHAN revision with ZERO usage rows behind - and zero
 * usage rows means the gate has nothing to read. `resume/revisions.ts` calls this
 * first for exactly that reason; the all-or-nothing shape of a snapshot is the point.
 *
 * Returns the resolved claims keyed by id so a caller that needs them (the revision
 * writer cross-checks the document's `x-clearance` block against them) does not pay for
 * a second query.
 *
 * `scope.profileId`, when given, is a TENANT BOUND: a usage naming a claim that exists
 * but belongs to another profile is refused as `ClaimNotFoundError` - the same answer as
 * a claim that does not exist, so a cross-tenant probe learns nothing.
 *
 * F1: the `rejected` refusal applies to a `verbatim` / `tailored` usage only, exactly as
 * `evaluatePreRenderGate` does. An `omitted` usage of a rejected claim is RECORDABLE and
 * is what `project.ts` writes for every claim the document considered and did not place.
 */
export async function assertClaimUsagesRecordable(
  usages: readonly ClaimUsageInput[],
  store: ResumeClaimUsageStore,
  scope: ClaimUsageScope = {},
): Promise<ReadonlyMap<string, CareerClaim>> {
  if (!Array.isArray(usages)) {
    throw new PreRenderGateInputError('assertClaimUsagesRecordable needs an array of usages');
  }

  const profileId = typeof scope.profileId === 'string' && scope.profileId.length > 0
    ? scope.profileId
    : null;
  // Only ids that are usable strings go into the query; a malformed ENTRY is reported by
  // the per-entry loop below, so it is never a `TypeError` out of `.map()`.
  const claimIds = [
    ...new Set(
      usages
        .filter((usage): usage is ClaimUsageInput => usage !== null && typeof usage === 'object')
        .map((usage) => usage.claimId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ].sort();
  const claims = claimIds.length
    ? await store.careerClaim.findMany({
        where: profileId === null ? { id: { in: claimIds } } : { id: { in: claimIds }, profileId },
      })
    : [];
  const byId = new Map<string, CareerClaim>(
    claims.map((claim: CareerClaim) => [claim.id, claim]),
  );

  usages.forEach((usage, index) => {
    const context = `claim usage[${index}]`;
    if (usage === null || typeof usage !== 'object') {
      throw new PreRenderGateInputError(`${context}: each usage must be an object`);
    }
    if (typeof usage.claimId !== 'string' || usage.claimId.length === 0) {
      throw new PreRenderGateInputError(`${context}: a non-empty claimId is required`);
    }
    if (!isResumeUsage(usage.usage)) {
      throw new PreRenderGateInputError(
        `${context}: usage must be one of ${RESUME_USAGE_VALUES.join('|')}, got ${JSON.stringify(usage.usage)}`,
      );
    }
    const claim = byId.get(usage.claimId);
    if (!claim) {
      throw new ClaimNotFoundError(usage.claimId);
    }
    if (isRejectedClaimStatus(claim.status) && GATED_USAGES.includes(usage.usage)) {
      throw new ClaimInvariantError(
        `${context}: claim ${claim.id} is rejected, so it has no valid RENDERING usage - a rejection is cleared only by a user reopen and a rejected claim can never be used as text (ADR-036 item 5). An 'omitted' usage is still recordable: it renders nothing, so it is the document's own account of what it left out`,
      );
    }
    if (GATED_USAGES.includes(usage.usage) && (usage.renderedText ?? '').trim().length === 0) {
      throw new PreRenderGateInputError(
        `${context}: usage=${usage.usage} requires the renderedText that will appear - an audit that records THAT a claim was used, never WHAT was said for it`,
      );
    }
  });

  return byId;
}

/**
 * Record which claims a revision used, and how.
 *
 * `@@unique([revisionId, claimId])` makes a re-record a no-op rather than a second
 * row: a revision is an immutable snapshot, so re-running the recorder for the same
 * revision must not grow the usage set underneath the gate.
 *
 * The guard here is the NARROW one described in the module header: every claim must
 * exist, and no usage may RENDER a `rejected` claim (ADR-036 item 5 - a rejection is
 * cleared only by a user `reopen`, and a rejected claim can never be used as text at any
 * layer). An `omitted` usage is recordable whatever the status, which is what keeps the
 * document's own `x-clearance` block writable. The full status rule is the gate's job, at
 * render time.
 *
 * The validation is `assertClaimUsagesRecordable`, which runs BEFORE the first insert,
 * so a rejected claim in the middle of a list cannot leave a half-recorded revision
 * behind. It is also exported so a caller that writes the PARENT row first (the revision
 * writer) can run the same checks before its own insert - which is the difference
 * between a rejected request and an orphan revision that passes the gate.
 */
export async function recordClaimUsages(
  revisionId: string,
  usages: readonly ClaimUsageInput[],
  store: ResumeClaimUsageStore,
  scope: ClaimUsageScope = {},
): Promise<RecordClaimUsagesResult> {
  assertRevisionId(revisionId, 'recordClaimUsages');
  await assertClaimUsagesRecordable(usages, store, scope);

  const already = await store.resumeClaimUsage.findMany({ where: { revisionId } });
  const existingIds = new Set(already.map((row: ResumeClaimUsage) => row.claimId));

  const rows: ResumeClaimUsage[] = [];
  let existing = 0;
  for (const usage of usages) {
    if (existingIds.has(usage.claimId)) {
      existing += 1;
      continue;
    }
    const row = await store.resumeClaimUsage.create({
      data: {
        revisionId,
        claimId: usage.claimId,
        usage: usage.usage,
        renderedText: usage.renderedText ?? null,
      },
    });
    rows.push(row);
    existingIds.add(usage.claimId);
  }

  return { created: rows.length, existing, rows };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The recorded usages of one revision, claimId-ascending. */
export async function listRevisionClaimUsages(
  revisionId: string,
  store: ResumeClaimUsageStore,
): Promise<ResumeClaimUsage[]> {
  assertRevisionId(revisionId, 'listRevisionClaimUsages');
  const rows = await store.resumeClaimUsage.findMany({ where: { revisionId } });
  return [...rows].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
}

/** The usages of one CLAIM across every revision - the "which resumes say this?" query. */
export async function listClaimUsages(
  claimId: string,
  store: ResumeClaimUsageStore,
): Promise<ResumeClaimUsage[]> {
  if (typeof claimId !== 'string' || claimId.length === 0) {
    throw new PreRenderGateInputError('listClaimUsages needs a non-empty claimId');
  }
  const rows = await store.resumeClaimUsage.findMany({ where: { claimId } });
  return [...rows].sort((a, b) => (a.revisionId < b.revisionId ? -1 : a.revisionId > b.revisionId ? 1 : 0));
}

/**
 * The fingerprint a lowered draft will be stored under. Re-exported from
 * `career/claims.ts` so the resume layer has ONE fingerprint implementation: an import
 * that hashed differently from the claim layer would dedupe against nothing and a
 * re-observation would create a duplicate row.
 */
export { claimFingerprint };
