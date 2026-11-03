// =====================================================================================
// tailor/apply.ts - OPERATIONS -> A NEW DOCUMENT, PURELY (T1080; 06 sec.E.3 "Derived-variant
// semantics" and "Before/after diff UX").
//
// WHAT THIS MODULE DOES, AND THE ORDER IT DOES IT IN. It folds the ACCEPTED operations over
// the current revision's document and returns the RESULT plus one `ResumeChange` row per
// operation - including the refused ones, recorded with `accepted: false` and no effect on
// the document, which is 06 sec.E.3's own requirement: "Rejected ops are recorded
// (`accepted=false`) but not applied; they remain visible as 'suggested, declined' so the user
// can see what the engine wanted and why."
//
// IT WRITES NOTHING. Not a revision, not a change row, not a claim. `createRevision` is the
// ONLY writer of a revision anywhere in this repository, and this module's output is its
// input. That is the whole of the immutability story for tailoring: a tailoring pass produces
// a value, and the value goes through the same writer, the same write-time checks and the
// same pre-render gate as a revision the Studio autosaved.
//
// THE LEDGER IS PART OF THE DOCUMENT, AND THAT IS THE HARD PART OF THIS MODULE.
// `x-clearance` is not metadata about the document; it is a member of it, and the belt
// (ADR-043 rule 5) requires every claim-backed string to be named at its exact path, with
// its exact text, by a text-rendering entry of that same block. So an operation that writes
// text MUST, in the same fold, move the ledger entry that names it - its `renderedText` and
// its `usage` (`verbatim` -> `tailored`, 05 sec.6.3: "tailoring may reuse a confirmed claim's
// text in a new phrasing ... as long as the FACTS come from confirmed claims or from the
// user's own edit"). An operation that REMOVES text MUST flip every entry whose `jsonPath`
// falls inside the removed subtree to `omitted` with a null path - otherwise the ledger keeps
// claiming a text placement the document no longer has, which is precisely the lie
// `assertRevisionRenderableInScope` step 4 and step 5 are built to catch.
//
// WHAT IS NOT RE-DERIVED HERE, AND WHY IT MATTERS. The ledger's `status` members are COPIED,
// never computed. They are copies of `CareerClaim.status` read by the projector, and
// `createRevision` cross-checks them against the rows (`assertClearanceMatchesClaims`), so a
// tailoring pass cannot state a status the database does not hold: if this module set one,
// the write would be refused as `CLEARANCE_DISAGREES_WITH_CLAIMS`. That refusal is the reason
// the module has no access to the claim rows' statuses at all.
//
// TWO INVARIANTS THIS FOLD OWES, BOTH PLACED HERE RATHER THAN IN `validate.ts`, and both about
// the BATCH rather than about one operation.
//   1. AN `include` WRITES THE NAMED CLAIM'S OWN STATEMENT. `validate.ts` requires the
//      operation's `after` to BE that statement when it carries text, and accepts the
//      operation with no `after` at all; the text written here is read from the resolved
//      grounding claim (`statement.trim()`, the projector's own verbatim form), never from the
//      request. So the ledger's `renderedText` is a fact about the CLAIM, and the two checks
//      together mean an `include` cannot carry prose under a confirmed claim's name - which is
//      the one thing `include` being a structural op (and so exempt from the fact-delta pass)
//      must never mean.
//   2. ONE SLOT, ONE TEXT, ONE CLAIM. Each operation is checked against the ACCUMULATING
//      document - the one the operations before it produced - rather than against the parent
//      every operation was validated against (`validate.ts#rule9AgainstRunningDocument`). A
//      second `include` landing on a slot the batch has already filled is REFUSED with
//      `TARGET_ALREADY_FILLED` and recorded `accepted: false`, because validating every
//      operation against the parent is what let two claims be recorded as rendering text at one
//      `jsonPath` - a collision `assertOneUsagePerClaimId` cannot see, because it keys on
//      `claimId`.
//
// DETERMINISM. No clock, no randomness, no I/O, no module state. The same document and the
// same accepted operations produce byte-identical output, which is what makes `jsonHash` a
// usable snapshot identity for the resulting revision.
// =====================================================================================

import { ResumeChangeOp } from '@prisma/client';

import type { CreateChangeInput } from '../resume/revisions.js';
import type { ResumeJson } from '../resume/json/jsonresume.js';
import {
  REORDERABLE_TARGETS,
  STYLE_TARGET,
  isClaimBackedTarget,
  reject,
  removeTargetPath,
  targetTokens,
  writeTargetPath,
} from './ops.js';
import type { OpRejection, TailorOperation } from './ops.js';
import { rule9AgainstRunningDocument, type ValidatedOperation } from './validate.js';

/**
 * One operation as the caller has decided about it: validated, or refused with its code.
 *
 * `operation` is REQUIRED on both branches. An input the parser could not turn into an
 * operation at all (`OP_UNKNOWN`, `OP_MALFORMED`, a bad target) is not an operation, so it
 * never becomes a `ReviewedOperation` and never gets a change row: `ResumeChange.op` is a
 * non-null enum and recording a declined `rewrite_bullet` for an input that was not one
 * would put a lie in the audit log to satisfy a column. The route reports those entries in
 * the response's rejection list instead, which is where a client learns about them.
 */
export type ReviewedOperation =
  | { readonly accepted: true; readonly validated: ValidatedOperation }
  | {
      readonly accepted: false;
      readonly rejection: OpRejection;
      readonly operation: TailorOperation;
    };

export interface ApplyInput {
  readonly document: unknown;
  readonly operations: readonly ReviewedOperation[];
}

export interface ApplyResult {
  /** The document the accepted operations produce. The caller's input is never mutated. */
  readonly document: ResumeJson;
  /** One row per supplied operation, accepted or not, in the order they were supplied. */
  readonly changes: readonly CreateChangeInput[];
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

interface ClearanceEntry {
  claimId?: unknown;
  jsonPath?: unknown;
  usage?: unknown;
  renderedText?: unknown;
}

function ledgerOf(document: unknown): ClearanceEntry[] {
  const record = document as { 'x-clearance'?: { claims?: unknown } } | null;
  const claims = record?.['x-clearance']?.claims;
  return Array.isArray(claims) ? (claims as ClearanceEntry[]) : [];
}

/**
 * `document` with `mutate` applied to a COPY of every ledger entry.
 *
 * The copy is what keeps this module pure: the entries are shared objects inside the stored
 * document, and mutating one in place would change the BEFORE state that the caller's diff is
 * computed from. So the ledger array is rebuilt, every entry is rebuilt, and only the ones
 * `mutate` returns a new value for are replaced.
 */
function withLedger(document: unknown, mutate: (entry: ClearanceEntry) => ClearanceEntry | null): unknown {
  const record = document as Record<string, unknown> | null;
  if (record === null || typeof record !== 'object') return document;
  const block = record['x-clearance'];
  if (block === null || typeof block !== 'object') return document;
  const blockRecord = block as Record<string, unknown>;
  const claims = blockRecord.claims;
  if (!Array.isArray(claims)) return document;

  const next: unknown[] = [];
  for (const raw of claims) {
    if (raw === null || typeof raw !== 'object') {
      next.push(raw);
      continue;
    }
    const entry = raw as ClearanceEntry;
    const replacement = mutate(entry);
    next.push(replacement ?? { ...entry });
  }
  return {
    ...record,
    'x-clearance': { ...blockRecord, claims: next },
  };
}

/** Is `path` at, or inside, the subtree named by `root`? `work[1]` covers `work[1].highlights[2]`. */
function withinPath(path: string, root: string): boolean {
  if (path === root) return true;
  // `work[1]` is a prefix of `work[10]` only up to the bracket, so the separator is checked.
  return path.startsWith(`${root}.`) || path.startsWith(`${root}[`);
}

/**
 * The TEXT-RENDERING entry at `target`, promoted to `tailored` with the new text.
 *
 * A target with no such entry is a document the belt would already refuse, so there is
 * nothing to update - and `validate.ts` has already refused such an operation with
 * `TARGET_CLAIM_MISMATCH`, so reaching here without an entry means the caller supplied a
 * non-text op at a claim-backed path, which the shape table does not allow.
 */
function entryRewritten(target: string, text: string) {
  return (entry: ClearanceEntry): ClearanceEntry | null =>
    entry.jsonPath === target && (entry.usage === 'verbatim' || entry.usage === 'tailored')
      ? { ...entry, usage: 'tailored', renderedText: text }
      : null;
}

/**
 * THE `omitted` ENTRY OF THE ONE CLAIM THE OPERATION NAMED, promoted to `verbatim` at `target`.
 * Every sibling `omitted` entry stays `omitted`.
 *
 * The `claimId` scope is the whole point of this function, and it is what makes the ledger an
 * account of itself. An `include`/`add_skill` says "claim X now renders this text at this path".
 * It says NOTHING about claim Y, so promoting Y too would make the block assert that N claims
 * render text at ONE path - and that collision is invisible to every other check:
 *   - `assertOneUsagePerClaimId` keys on `claimId`, not on `jsonPath`, so N distinct claims at
 *     one path pass it;
 *   - the write-time belt (`assertClaimBackedTextAccounted`) asks whether SOME entry names the
 *     path, which a collision still answers yes to;
 *   - and if any flipped sibling is not at a renderable status it now carries a GATED usage, so
 *     `evaluatePreRenderGate` refuses the whole revision with `CLAIM_NOT_CONFIRMED` - one honest
 *     `include` would brick the resume it was written to improve.
 * Matching on the claim id makes that unrepresentable: the operation names one claim
 * (`validate.ts`: `include` requires exactly one, `add_skill` a non-empty confirmed set) and
 * exactly that one entry moves.
 *
 * `claimId === null` PROMOTES NOTHING - this module does not guess which omitted claim an
 * operation meant. Both call sites are validated to name a claim, so the branch is unreachable
 * through `validate`; it exists so that a future relaxation of either rule fails LOUDLY at the
 * write-time belt (`DOCUMENT_UNAUDITED` - the text has no entry) instead of quietly promoting
 * every omitted entry, which is the state this function used to produce.
 */
function entryIncluded(target: string, text: string, claimId: string | null) {
  return (entry: ClearanceEntry): ClearanceEntry | null =>
    claimId !== null &&
    entry.usage === 'omitted' &&
    typeof entry.claimId === 'string' &&
    entry.claimId === claimId
      ? { ...entry, usage: 'verbatim', jsonPath: target, renderedText: text }
      : null;
}

/** Every entry whose placement fell inside a removed subtree becomes `omitted`. */
function entriesOmitted(root: string) {
  return (entry: ClearanceEntry): ClearanceEntry | null =>
    typeof entry.jsonPath === 'string' &&
    entry.jsonPath !== null &&
    withinPath(entry.jsonPath, root) &&
    (entry.usage === 'verbatim' || entry.usage === 'tailored')
      ? { ...entry, usage: 'omitted', jsonPath: null, renderedText: null }
      : null;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** The text at `target`, or `null`. What a change row's `before` column records. */
function beforeAt(document: unknown, target: string): unknown {
  const tokens = targetTokens(target);
  if (tokens === null) return null;
  let cursor: unknown = document;
  for (const token of tokens) {
    if (cursor === null || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[token] ?? (cursor as unknown as never);
    if (cursor === undefined) return null;
  }
  return cursor === undefined ? null : cursor;
}

/**
 * Apply ONE accepted operation to the document. Pure; returns a new document.
 *
 * The switch is the operation vocabulary written as its effect, which is the reviewer's
 * question - "what does this op DO to the document?" - answered in one place. Two ops are
 * deliberately absent from it as document writers:
 *   - `customize_style` records a RENDER-TIME choice (ADR-044 D3: the template is not a
 *     member of the snapshot, and the same revision renders in any of them). It produces a
 *     change row and leaves the document byte-identical, which is why applying one alone
 *     yields a revision whose `jsonHash` equals its parent's. That is the honest outcome,
 *     not a bug: a layout choice is not content.
 *   - `reorder` writes an array in a new order, which is a document write, and is handled
 *     in the switch like the others.
 */
function applyOne(document: ResumeJson, validated: ValidatedOperation): ResumeJson {
  const op = validated.operation;
  switch (op.op) {
    case ResumeChangeOp.rewrite_bullet:
    case ResumeChangeOp.reword_summary:
    case ResumeChangeOp.retitle: {
      // 1. the ledger entry that names this text, moved to `tailored` with the new text;
      // 2. the text itself. Ledger first, because the text is what the ledger will be
      //    compared against - doing it the other way round would leave a window in which the
      //    document says one thing and the ledger another, and `createRevision` runs in the
      //    same synchronous turn, so the window is only theoretical. It is still the order
      //    that makes the intermediate states individually consistent.
      const withUsage = withLedger(document, entryRewritten(op.target, String(op.after).trim()));
      return writeTargetPath(withUsage, targetTokens(op.target) as string[], String(op.after).trim()) as ResumeJson;
    }
    case ResumeChangeOp.include: {
      // THE TEXT IS THE CLAIM'S, NOT THE REQUEST'S. `validate.ts` has already refused any
      // `after` that is not this claim's statement, and accepts the operation with no `after`
      // at all, so the operation's own bytes are REDUNDANT here by construction - and reading
      // them anyway would make the ledger's `renderedText` a statement about the request
      // rather than about the claim. `statement.trim()` is also the projector's own verbatim
      // form (`resume/json/project.ts#renderedTextFor`), so an included bullet and a projected
      // one are the same string, which is what "verbatim" in the usage means.
      //
      // Unreachable with no claim: `rule9AgainstRunningDocument` refuses that operation in the
      // fold below, so this branch is a second line rather than the only one.
      const claims = validated.groundingClaims;
      const claim = claims.length === 0 ? undefined : claims[0];
      const text = claim === undefined ? '' : claim.statement.trim();
      // Scoped to the claim this op NAMES, not to "any omitted claim" - see `entryIncluded`.
      const withUsage = withLedger(document, entryIncluded(op.target, text, claim?.id ?? null));
      return writeTargetPath(withUsage, targetTokens(op.target) as string[], text) as ResumeJson;
    }
    case ResumeChangeOp.add_skill: {
      // The appended skill has NO `Skill` row - this engine never creates an entity (05
      // sec.6.1) - so its name is backed by the confirmed claim the op named, recorded at
      // `skills[n].name`. `skills[].name` is NOT on the claim rail (R-ENTITY), so the belt
      // does not check the text there; the ledger entry is the audit record that says whose
      // assertion it is.
      const existing = Array.isArray(document.skills) ? document.skills : [];
      const next = [...existing, { name: String(op.after).trim() }];
      const path = `skills[${next.length - 1}].name`;
      // Same scope as `include`: the FIRST named claim backs this name, and no other omitted
      // entry may claim the path with it.
      const withUsage = withLedger(document, entryIncluded(path, String(op.after).trim(), op.sourceClaimIds[0] ?? null));
      return { ...(withUsage as ResumeJson), skills: next };
    }
    case ResumeChangeOp.remove_skill:
    case ResumeChangeOp.exclude: {
      const withUsage = withLedger(document, entriesOmitted(op.target));
      return removeTargetPath(withUsage, targetTokens(op.target) as string[]) as ResumeJson;
    }
    case ResumeChangeOp.reorder: {
      const container = (document as Record<string, unknown>)[op.target];
      if (!Array.isArray(container)) return document;
      const order = op.after as number[];
      const next = order.map((index) => container[index]);
      return { ...(document as Record<string, unknown>), [op.target]: next } as ResumeJson;
    }
    case ResumeChangeOp.customize_style:
      return document;
    default:
      return document;
  }
}

/**
 * The change row for a REFUSED operation: recorded, not applied (06 sec.E.3).
 *
 * `before` is the document's value at the target as it stands BEFORE this operation, so a
 * declined row shows the reviewer the text the engine was proposing to replace even though
 * nothing was replaced.
 */
function declinedChange(
  operation: TailorOperation,
  rejection: OpRejection,
  document: unknown,
): CreateChangeInput {
  return {
    op: operation.op as CreateChangeInput['op'],
    jsonPath: operation.target,
    before: beforeAt(document, operation.target),
    after: null,
    reason: `${rejection.code}: ${rejection.reason}${rejection.detail === null ? '' : ` (${rejection.detail})`}`,
    targetRequirementIds: operation.targetRequirementIds,
    sourceClaimIds: operation.sourceClaimIds,
    accepted: false,
  };
}

/** The change row for an ACCEPTED operation. */
function appliedChange(
  operation: TailorOperation,
  before: unknown,
  after: unknown,
): CreateChangeInput {
  return {
    op: operation.op as CreateChangeInput['op'],
    jsonPath: operation.target,
    before: before ?? null,
    after: after ?? null,
    reason: operation.reason,
    targetRequirementIds: operation.targetRequirementIds,
    sourceClaimIds: operation.sourceClaimIds,
    accepted: true,
  };
}

/**
 * Fold the accepted operations and record one change row per operation.
 *
 * THE `before` OF EACH ROW IS READ FROM THE DOCUMENT *BEFORE* THAT OPERATION IS APPLIED -
 * not from the original document. With two operations on the same target that is the
 * difference between a diff that reads as a history and one that reads as if both ops
 * started from the same place, and a reviewer reading the first row would see a `before`
 * that never existed on the page at that revision.
 *
 * EACH OPERATION IS ALSO CHECKED AGAINST THAT RUNNING DOCUMENT BEFORE IT IS APPLIED
 * (`validate.ts#rule9AgainstRunningDocument`), so a refusal can be about the STATE THE BATCH
 * has reached rather than about the operation on its own - an `include` whose slot an earlier
 * `include` has already filled. That refusal is recorded exactly like a validation refusal
 * (`accepted: false`, the code in the reason, no effect on the document) because to the
 * caller it IS one: an operation that may not be applied.
 *
 * A caller may pass `accepted: false` for an operation the USER declined, with a synthetic
 * rejection - that is how "suggested, declined" survives to the diff view with the reason the
 * user or the validator gave.
 */
export function applyOperations(input: ApplyInput): ApplyResult {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('applyOperations needs an input object');
  }
  let document = input.document as ResumeJson;
  const changes: CreateChangeInput[] = [];

  for (const reviewed of input.operations) {
    if (!reviewed.accepted) {
      changes.push(declinedChange(reviewed.operation, reviewed.rejection, document));
      continue;
    }
    const op = reviewed.validated.operation;
    // Rule 9, against `document` AS IT NOW STANDS - which is why it is asked here and not in
    // the validation loop: every operation was validated against the parent, so only the fold
    // can see that a slot two `include`s address is no longer empty by the second one.
    const foldRejection = rule9AgainstRunningDocument(reviewed.validated, document);
    if (foldRejection !== null) {
      changes.push(declinedChange(op, foldRejection, document));
      continue;
    }
    // `customize_style`'s before is the RENDER's template id, not a document member, so it
    // is recorded from the operation rather than read from the snapshot.
    const before =
      op.op === ResumeChangeOp.customize_style
        ? (op.before ?? null)
        : beforeAt(document, op.target);
    const next = applyOne(document, reviewed.validated);
    const after =
      op.op === ResumeChangeOp.reorder
        ? (next as Record<string, unknown>)[op.target]
        : beforeAt(next, op.target);
    changes.push(appliedChange(op, before, after));
    document = next;
  }

  return { document, changes: Object.freeze(changes) };
}

/**
 * What a caller needs to know to describe the result, without the module knowing about HTTP.
 *
 * `documentChanged` is false when the accepted operations were all `customize_style` or were
 * all declined - i.e. when the new revision's `jsonHash` will equal its parent's. That is a
 * fact worth surfacing rather than a failure: the change log says what happened, and the
 * snapshot says the content did not move.
 */
export function applySummary(result: ApplyResult, parentHash: string, nextHash: string): {
  documentChanged: boolean;
  acceptedCount: number;
  declinedCount: number;
  changeCount: number;
} {
  const acceptedCount = result.changes.filter((change) => change.accepted !== false).length;
  return {
    documentChanged: parentHash !== nextHash,
    acceptedCount,
    declinedCount: result.changes.length - acceptedCount,
    changeCount: result.changes.length,
  };
}

export { REORDERABLE_TARGETS, STYLE_TARGET, isClaimBackedTarget };