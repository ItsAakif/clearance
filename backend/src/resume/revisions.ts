// =====================================================================================
// resume/revisions.ts - immutable ResumeRevision snapshots (T1030; 05 sec.5, sec.6.2)
// NORMATIVE: 05 sec.6.2, sec.7.7. DECISION: ADR-035 (item 3).
//
// THE INVARIANT THIS MODULE OWNS, in the spec's own words (05 sec.6.2):
//
//   "Revisions are immutable. Editing produces revision N+1; revision N keeps its exact
//    resumeJson + the claim usage that was valid at that time."
//
// WHY THAT MATTERS HERE AND NOT ONLY FOR HISTORY. `ResumeClaimUsage` is the input to
// the pre-render gate, and the gate asks "was this claim CONFIRMED when this document
// was written?". A mutable revision destroys that question: a claim confirmed today
// would retroactively legitimise a revision that quoted it while it was still an
// inference, and the audit 05 sec.6.5 depends on ("this resume used claim X, which was
// later rejected") becomes unanswerable. So immutability here is an AUDIT property, not
// a tidiness property.
//
// HOW IT IS ENFORCED - THREE LAYERS, because one is a refactor away from deletion:
//   1. TYPE. This module exports no update function. There is no `updateRevision`, no
//      `patchRevision`, no generic data setter - the update surface does not exist, so
//      a caller cannot reach it. `revisions.test.ts` asserts the export surface.
//   2. THE STORE SEAM. `createRevision`'s parameter type is `ResumeRevisionStore`, whose
//      `resumeRevision` member is `ResumeRevisionWriteSeam`: only `create`, `findFirst`,
//      `findMany` and `findUnique`. The mutating delegate methods are not on the type,
//      so writing to an existing revision is a COMPILE error in this repository, not a
//      code-review finding. This is the layer that cannot be defeated by a well-meaning
//      refactor, and it is asserted against the type `createRevision` actually takes.
//   3. THE FAKE. `FakeCareerStore.resumeRevision` (career fixtures) implements no
//      mutating method either, and records every call, so "creating revision N+1 writes
//      nothing to revision N" is an assertion about observed behaviour rather than an
//      inference from a type.
//
// `@@unique([resumeId, revisionNumber])` is the database's half of the same rule: two
// concurrent creators of revision N+1 cannot both succeed, and the loser gets P2002
// rather than a silently merged revision.
//
// DETERMINISM OF `jsonHash`. The hash is `sha256` over `canonicalJsonString` of the
// document, so it is a function of the DOCUMENT BYTES and nothing else - not of a
// clock, not of insertion order, not of a hash-map iteration order. The same profile
// projects to the same hash on any host; a changed claim statement changes it.
//
// NO PRISMA SINGLETON. The seam is injected (`career/claims.ts` convention), so the
// whole revision lifecycle - create, list, get, current, diff - is provable with no
// live database.
// =====================================================================================

import {
  ResumeChangeSource,
  ResumeChangeOp,
  type Prisma,
  type PrismaClient,
  type Resume,
  type ResumeChange,
  type ResumeRevision,
} from '@prisma/client';

import {
  X_CLEARANCE_KEY,
  canonicalJsonHash,
  canonicalJsonString,
  readClearanceBlock,
  type ClearanceBlock,
  type ResumeJson,
} from './json/jsonresume.js';
import { assertValidResumeJson } from './json/validate.js';
import {
  GATED_USAGES,
  PreRenderGateInputError,
  assertClaimUsagesRecordable,
  assertPreRenderGate,
  evaluatePreRenderGate,
  loadGateUsages,
  type ClaimUsageInput,
  type ClaimUsageScope,
  type GateVerdict,
  recordClaimUsages,
  type ResumeClaimUsageStore,
} from '../career/claimUsage.js';
import { refreshClearanceFromClaims } from './json/project.js';
import { claimBackedTextAt } from './json/claimSurface.js';

// ---------------------------------------------------------------------------
// The injected DB seam - READ + CREATE ONLY
// ---------------------------------------------------------------------------

/**
 * The narrowest seam the revision writer needs.
 *
 * `Pick<PrismaClient, 'resumeRevision'>` would select the WHOLE delegate, including its
 * mutating methods, so the point is made structurally instead: `ResumeRevisionWriteSeam`
 * below narrows it to the four call shapes this module may use, and every write path in
 * this file goes through that type. Prisma's generated delegate does expose mutation
 * methods; they are unreachable through this seam, so editing a revision is a compile
 * error here rather than a code-review finding.
 */
/**
 * `createRevision` takes THIS, and `revisions.test.ts` asserts (under `tsc`, via
 * `@ts-expect-error`) that it does not expose `update`. The previous version of this
 * type was `Pick<PrismaClient, 'resumeRevision' | ...>`, which selected Prisma's WHOLE
 * delegate: an `update` through `store.resumeRevision` compiled inside this file, so the header
 * claim ("writing to an existing revision is a COMPILE error in this repository") was
 * false - only the source guard and the fake's missing method actually held. Narrowing
 * the DELEGATE rather than the client is what makes the claim true; the other three
 * delegates stay `Pick`ed because they are read/append-only by their own tables'
 * invariants and narrowing them buys nothing.
 */
export type ResumeRevisionStore = Pick<
  PrismaClient,
  'resumeChange' | 'resumeClaimUsage' | 'careerClaim'
> & {
  resumeRevision: ResumeRevisionWriteSeam;
};

/**
 * The ONLY operations on `ResumeRevision` this module may perform. Anything else -
 * `update`, `delete`, `upsert` - is absent from the type, so it cannot be called.
 * `revisions.test.ts` asserts this is the whole write vocabulary, AND that
 * `createRevision`'s own parameter type does not expose `update` either.
 */
export interface ResumeRevisionWriteSeam {
  create(args: { data: Prisma.ResumeRevisionUncheckedCreateInput }): Promise<ResumeRevision>;
  findFirst(args: unknown): Promise<ResumeRevision | null>;
  findMany(args: unknown): Promise<ResumeRevision[]>;
  findUnique(args: unknown): Promise<ResumeRevision | null>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RevisionErrorReason =
  | 'INVALID_INPUT'
  | 'RESUME_NOT_FOUND'
  | 'REVISION_NOT_FOUND'
  | 'INVALID_JSON'
  | 'UNSUPPORTED_MODEL_VERSION'
  // F1: the two write-time reasons that make the gate's input non-optional.
  | 'CLEARANCE_BLOCK_REQUIRED'
  | 'CLEARANCE_DISAGREES_WITH_CLAIMS';

const REVISION_REASON_TEXT: Readonly<Record<RevisionErrorReason, string>> = Object.freeze({
  INVALID_INPUT: 'the revision request is malformed',
  RESUME_NOT_FOUND: 'the resume does not exist',
  REVISION_NOT_FOUND: 'the revision does not exist',
  INVALID_JSON: 'the document does not satisfy the Resume JSON schema',
  UNSUPPORTED_MODEL_VERSION: 'the resume model version is not one this layer can project',
  CLEARANCE_BLOCK_REQUIRED:
    'a V2 revision document must carry an x-clearance block; without one the gate has no claim accounting to read and the revision cannot be audited',
  CLEARANCE_DISAGREES_WITH_CLAIMS:
    "the document's x-clearance block and the CareerClaim rows in play for it are not the same set of claims; one names a claim that resolves to no row, or one omits a claim that is in play",
});

export class ResumeRevisionError extends Error {
  readonly code = 'resume_revision_failed' as const;
  readonly reason: RevisionErrorReason;
  /** Present for `INVALID_JSON`: the schema issues, so a route can show them. */
  readonly issues: readonly { path: string; keyword: string; message: string }[];

  constructor(reason: RevisionErrorReason, detail: string, issues: readonly { path: string; keyword: string; message: string }[] = []) {
    super(`resume_revision_failed: ${REVISION_REASON_TEXT[reason]} (${detail})`);
    this.name = 'ResumeRevisionError';
    this.reason = reason;
    this.issues = Object.freeze([...issues]);
  }

  toJSON(): {
    code: 'resume_revision_failed';
    reason: RevisionErrorReason;
    issues: readonly { path: string; keyword: string; message: string }[];
  } {
    return { code: this.code, reason: this.reason, issues: this.issues };
  }
}

// ---------------------------------------------------------------------------
// Creating revision N+1
// ---------------------------------------------------------------------------

export interface CreateRevisionInput {
  resumeId: string;
  /** The document to snapshot. Validated against the schema BEFORE it is stored. */
  document: ResumeJson;
  createdBy: ResumeChangeSource;
  createdByUserId?: string | null;
  reason?: string | null;
  /** Typst/LaTeX versions at authoring time, so a later render is reproducible. */
  enginePins?: Record<string, unknown>;
  /**
   * The claim usage this revision had, as the DOCUMENT declares it.
   *
   * THIS IS NOT THE SOURCE OF TRUTH, and a caller may not make it one. It is an
   * assertion the writer CROSS-CHECKS against the document's `x-clearance` block and
   * against the `CareerClaim` rows, and it is a mismatch - in either direction - that
   * is refused. See `assertUsagesMatchDocument` for the exact rule; the short version
   * is that the usage set is DERIVED from the document, so a caller can neither add a
   * usage the document does not declare nor omit one it does.
   *
   * `undefined` is not "no usages": it means "derive them from the document", which is
   * what every existing caller wants and what makes the bypass unreachable.
   */
  usages?: readonly ClaimUsageInput[];
  /** The op log for this revision (05 sec.5 `ResumeChange`). */
  changes?: readonly CreateChangeInput[];
  /** Injected for tests; defaults to the database default (`now()`). */
  createdAt?: Date;
}

export interface CreateChangeInput {
  op: ResumeChangeOp;
  /** e.g. `work[0].highlights[2]`. */
  jsonPath: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  targetRequirementIds?: readonly string[];
  sourceClaimIds?: readonly string[];
  appliedBy?: ResumeChangeSource;
  accepted?: boolean;
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ResumeRevisionError('INVALID_INPUT', `${field} is required`);
  }
}

const CHANGE_SOURCE_VALUES: readonly string[] = Object.values(ResumeChangeSource);
const CHANGE_OP_VALUES: readonly string[] = Object.values(ResumeChangeOp);

// ---------------------------------------------------------------------------
// THE DOCUMENT -> USAGE BINDING (F1: the thing that makes the bypass unreachable)
// ---------------------------------------------------------------------------

/** The `ResumeUsage` values a document entry may declare, without re-typing the enum. */
function isDeclaredUsage(value: unknown): value is ClaimUsageInput['usage'] {
  return value === 'verbatim' || value === 'tailored' || value === 'omitted';
}

/**
 * The usage set a document DECLARES, read from its `x-clearance` block.
 *
 * This is the derivation the whole F1 fix rests on. The pre-render gate reads
 * `ResumeClaimUsage` rows; a row is a claim id plus a usage. The document already says
 * which claims it uses, where, and with what rendered text - `x-clearance.claims[]`,
 * written by the projector from the claim rows themselves. So the usage set does not
 * have to be supplied by the HTTP client at all: it is a FUNCTION of the document, and
 * the writer records that function.
 *
 * Every entry, INCLUDING the `omitted` ones. The block lists what the projection
 * considered as well as what it placed, so the recorded set is the document's own
 * account of itself and is therefore complete by construction. An `omitted` entry is
 * inert at render time (the gate returns before the status check for it), so listing it
 * costs nothing and gains the audit row 05 sec.6.5 asks for.
 *
 * WHY NOT JUST `jsonPath` + `renderedText` FROM THE DOCUMENT BODY. That is the
 * alternative - parse `work[0].highlights[2]` and ask which claim put it there - and it
 * is exactly the forging hole: the mapping from placed text to claim id is what the
 * block records, and reconstructing it from the text would let a caller relabel any
 * highlight as any claim. The block is the projector speaking, not the client.
 */
export function deriveUsageFromDocument(document: unknown): ClaimUsageInput[] {
  const block = readClearanceBlock(document);
  if (block === null || !Array.isArray(block.claims)) return [];
  const usages: ClaimUsageInput[] = [];
  for (const entry of block.claims) {
    if (entry === null || typeof entry !== 'object') continue;
    if (typeof entry.claimId !== 'string' || entry.claimId.length === 0) continue;
    if (!isDeclaredUsage(entry.usage)) continue;
    usages.push({
      claimId: entry.claimId,
      usage: entry.usage,
      renderedText: typeof entry.renderedText === 'string' ? entry.renderedText : null,
    });
  }
  return usages;
}

/**
 * Refuse a caller-supplied usage set that DISAGREES with the document.
 *
 * The document is the source of truth; this function exists so a client cannot quietly
 * disagree with it. Both directions are refused, and both matter:
 *   - a usage the document does not declare would be a claim the document does not say
 *     it renders, recorded as if it did. The gate would gate a phantom, and the audit
 *     would list a usage that never happened;
 *   - an OMITTED usage is the bypass. A document full of `work[].highlights` with an
 *     empty `x-clearance.claims` declares NO usage; recording that empty set is what
 *     made the gate return `{allowed: true, checked: 0}` for a document full of
 *     unconfirmed text. The document cannot be allowed to under-declare.
 *
 * The comparison is on the DERIVED set, so an entry's `usage` and `renderedText` must
 * match too, not just its `claimId`. Ordering is irrelevant: the derived set is sorted
 * and the caller's is compared as a set.
 */
function assertUsagesMatchDocument(
  declared: readonly ClaimUsageInput[],
  supplied: readonly ClaimUsageInput[] | undefined,
): void {
  if (supplied === undefined) return;
  if (!Array.isArray(supplied)) {
    throw new ResumeRevisionError('INVALID_INPUT', 'usages must be an array when present');
  }

  // N5: the key is the TUPLE, not a delimited join of its members. A join is only
  // injective while no member can contain the separator; a claim id is caller
  // supplied and a statement is free text, so any separator is an assumption. The
  // delimiter it used was a NUL byte, which renders as nothing and reads as an
  // empty separator. JSON.stringify of the array is injective on string tuples and
  // needs no separator at all.
  const key = (usage: ClaimUsageInput): string =>
    JSON.stringify([usage.claimId, usage.usage, (usage.renderedText ?? '').trim()]);
  const declaredKeys = new Set(declared.map(key));
  const suppliedKeys = new Set<string>();
  for (const [index, usage] of supplied.entries()) {
    if (usage === null || typeof usage !== 'object') {
      throw new ResumeRevisionError('INVALID_INPUT', `usages[${index}] must be an object`);
    }
    if (typeof usage.claimId !== 'string' || usage.claimId.length === 0) {
      throw new ResumeRevisionError('INVALID_INPUT', `usages[${index}].claimId is required`);
    }
    if (!isDeclaredUsage(usage.usage)) {
      throw new ResumeRevisionError('INVALID_INPUT', `usages[${index}].usage is not a ResumeUsage`);
    }
    const usageKey = key(usage);
    if (suppliedKeys.has(usageKey)) {
      throw new ResumeRevisionError('INVALID_INPUT', `usages[${index}] is a duplicate entry`);
    }
    suppliedKeys.add(usageKey);
  }

  for (const usageKey of suppliedKeys) {
    if (!declaredKeys.has(usageKey)) {
      throw new ResumeRevisionError(
        'INVALID_INPUT',
        'the supplied claim usage does not match the document x-clearance block; the usage set is derived from the document, so it may be restated but not changed',
      );
    }
  }
  for (const usageKey of declaredKeys) {
    if (!suppliedKeys.has(usageKey)) {
      throw new ResumeRevisionError(
        'INVALID_INPUT',
        'the supplied claim usage omits an entry the document x-clearance block declares; a document may not under-declare the claims it uses',
      );
    }
  }
}

/**
 * N2 / ADR-043 decision 4: ONE `ResumeClaimUsage` ROW PER `claimId`, AS A FUNCTION OF THE
 * DOCUMENT.
 *
 * `X_CLEARANCE_SCHEMA.claims` has no uniqueness constraint on `claimId`, and the
 * validator's `uniqueItems` only catches byte-identical entries - so two entries for one
 * claim with a different `usage` validate. `deriveUsageFromDocument` then emits BOTH, and
 * `recordClaimUsages` writes ONE row for the pair (`@@unique([revisionId, claimId])`,
 * first entry wins). Declare a claim `omitted` first and `verbatim` second and the gate
 * reads `omitted` - which is inert - on a document that declares AND PLACES that claim's
 * text. The read-time comparison could not see it either, because it compared claimIds,
 * so 2 declared vs 1 recorded was invisible.
 *
 * The fix is at the point where the ambiguity is still a DOCUMENT rather than a collapsed
 * row log: refuse a derived set that names one `claimId` twice. Byte-identical duplicates
 * are also refused, because two identical entries are not two usages; the schema's
 * `uniqueItems` already rejects them, and saying so here means the rule does not depend on
 * which validator ran.
 */
function assertOneUsagePerClaimId(usages: readonly ClaimUsageInput[]): void {
  const seen = new Set<string>();
  for (const usage of usages) {
    if (seen.has(usage.claimId)) {
      throw new ResumeRevisionError(
        'INVALID_INPUT',
        'the x-clearance block names the same claim more than once; one revision records one usage per claim, and a second entry for the same claim makes the recorded usage depend on entry order',
      );
    }
    seen.add(usage.claimId);
  }
}

/**
 * ADR-043 rule 5, the WRITE-TIME half: every claim-backed string in this document must be
 * named, at that exact path, by a text-rendering entry of this document's own block, with
 * the same text.
 *
 * The belt's domain comes from `json/claimSurface.ts` - the SAME constant the projector
 * builds its `jsonPath`s from - so a new verbatim site cannot exist without this seeing
 * it, and a template with no emission site fails the drift test in `claimSurface.test.ts`.
 *
 * It runs UNCONDITIONALLY, never gated on the declared set being empty. The attempt-2
 * belt was `declared.length === 0 && hasCareerBearingText(document)`, which meant any
 * document declaring even ONE claim escaped the text check entirely.
 *
 * `INVALID_INPUT` rather than a gate reason: at write time the document has no history, so
 * text the block does not account for is a malformed request, not a stale snapshot. The
 * read-time half of the same predicate is `assertRevisionRenderableInScope` step 5.
 */
function assertClaimBackedTextAccounted(document: unknown): void {
  const declared = declaredTextPlacements(document);
  for (const { path, text } of claimBackedTextAt(document)) {
    const accounted = declared.some(
      (entry) =>
        entry.jsonPath === path &&
        GATED_USAGES.includes(entry.usage) &&
        (entry.renderedText ?? '').trim() === text,
    );
    if (!accounted) {
      throw new ResumeRevisionError(
        'INVALID_INPUT',
        `the document places claim-backed text at ${path} that no x-clearance entry names at that path with that text; a string on the claim rail must be accounted for by the claims the document declares`,
      );
    }
  }
}

/** One `x-clearance` entry that names a place in the document and the text it puts there. */
interface DeclaredTextPlacement {
  jsonPath: string | null;
  usage: ClaimUsageInput['usage'];
  renderedText: string | null;
}

/**
 * The `x-clearance` entries that put TEXT in the document.
 *
 * Read from the block rather than from `deriveUsageFromDocument`, because that function
 * drops `jsonPath` - and the path is the whole of the comparison. A block entry is
 * included whatever its usage, so the caller applies the `GATED_USAGES` test itself; the
 * write-time predicate and the read-time rule apply the identical test.
 */
function declaredTextPlacements(document: unknown): DeclaredTextPlacement[] {
  const block = readClearanceBlock(document);
  const out: DeclaredTextPlacement[] = [];
  for (const entry of block?.claims ?? []) {
    if (entry === null || typeof entry !== 'object') continue;
    if (!isDeclaredUsage(entry.usage)) continue;
    out.push({
      jsonPath: typeof entry.jsonPath === 'string' ? entry.jsonPath : null,
      usage: entry.usage,
      renderedText: typeof entry.renderedText === 'string' ? entry.renderedText : null,
    });
  }
  return out;
}

/**
 * Read the `x-clearance` block and refuse a V2 document that has none.
 *
 * THE DECISION (F1, item 2), stated rather than left implicit: **a revision whose
 * `x-clearance.sourceModelVersion >= 2` MUST carry an `x-clearance` block.** A V2
 * document is, by definition, one under clearance control - the block is where the
 * provenance lives - and a V2 document with no block is a document that asserts it uses
 * no claim while carrying a career history. Silently allowing it is the bypass.
 *
 * The check is keyed on the DOCUMENT, not on a route parameter, so it cannot be turned
 * off by choosing an endpoint. A document that has no block at all is treated as V2 (the
 * stricter reading): a caller cannot escape the requirement by omitting the block that
 * carries the version.
 *
 * THERE IS NO VERSION BRANCH HERE, and the previous version of this docstring claimed
 * there was: it said `modelVersion: 1` "is EXEMPT". The function takes only a block, so
 * it cannot know a version, and a V1-shaped document with no block is refused exactly
 * like a V2 one. Nothing is lost by that. 05 sec.7.7 backfills a legacy row into
 * all-inferred drafts, and the LEGACY PROJECTION emits an `x-clearance` block of its own
 * (`projectResumeJson`, `sourceModelVersion: 1`), so the migration path is not blocked -
 * a document that has not been through a projector was never backfilled in the first
 * place. The claim the false paragraph was making - that no caller can pick the shape by
 * picking a parameter - is true, and it is true for a different reason: there is no
 * parameter.
 */
function requireClearanceBlockForV2(block: ClearanceBlock | null): ClearanceBlock {
  if (block !== null) return block;
  throw new ResumeRevisionError(
    'CLEARANCE_BLOCK_REQUIRED',
    'a revision document must carry an x-clearance block; the claim usage the gate reads is derived from it, and a document with no block has no claim accounting to gate',
  );
}

/**
 * Create revision N+1 as an IMMUTABLE SNAPSHOT.
 *
 * Order of operations, and why:
 *   1. validate the request and the DOCUMENT against the JSON Resume + `x-clearance`
 *      schema - a snapshot that does not validate would fail later, at a render, with
 *      the user no longer able to tell which of their N edits broke it;
 *   2. DERIVE the claim usage from the document's `x-clearance` block, REFRESH the
 *      block's row-derived members from the `CareerClaim` rows (refusing only the
 *      structural disagreements), cross-check any caller-supplied usage set against the
 *      document, refuse a block that names one `claimId` twice, and run the
 *      claim-backed-text belt. ALL FIVE happen BEFORE the insert;
 *   3. compute `jsonHash` from the CANONICAL form of the STORED (refreshed) document, so
 *      the hash is a function of the bytes and not of key order;
 *   4. find the current `max(revisionNumber)` and add one;
 *   5. INSERT. Never update.
 *
 * STEP 2 IS THE POINT, AND IT IS WHY THE ORDER IS THIS WAY. The gate's input is
 * `ResumeClaimUsage`, and until now nothing tied those rows to the document: a caller
 * could post a document full of unconfirmed text, send no usages, and the gate returned
 * `{allowed: true, checked: 0}` - a green verdict on a document it had never read. Now
 * the usage set is a function of the document, the document is checked against the claim
 * ROWS, and the caller may restate the set but not change it.
 *
 * AND THE CHECK REFRESHES WHERE IT USED TO REFUSE. It refused any disagreement between a
 * block's row-derived members and the rows, which meant the Studio's autosave 400'd on
 * every resume whose claims had moved since its revision was written - the block was
 * STALE, not forged, and the two are the same disagreement. It now overwrites those
 * members with the rows' own values and refuses only the disagreements that are not
 * about a stale field: a named claim that resolves to no row, a row in play the block does
 * not name, or an unusable entry. The stored snapshot is the REFRESHED document, so the
 * audit trail records what the database holds rather than what the caller typed. See
 * `refreshClearanceFromClaims` for why a forged status could never have made anything
 * render, which is the fact that makes refreshing sufficient.
 *
 * Step 4 + 5 are not in a transaction. The `@@unique([resumeId, revisionNumber])`
 * constraint is the real guard: two concurrent creators of N+1 produce one row and one
 * P2002, which the caller can retry, rather than a silently interleaved history. A
 * transaction would be nicer but the constraint is sufficient and it is the one the
 * schema already has. What a transaction WOULD buy - no orphan on a mid-flight failure
 * - is bought more cheaply here by doing every check that can throw before the insert.
 */
export async function createRevision(
  input: CreateRevisionInput,
  store: ResumeRevisionStore,
): Promise<ResumeRevision> {
  if (input === null || typeof input !== 'object') {
    throw new ResumeRevisionError('INVALID_INPUT', 'createRevision needs an input object');
  }
  assertNonEmpty(input.resumeId, 'createRevision: resumeId');
  if (input.document === null || typeof input.document !== 'object') {
    throw new ResumeRevisionError('INVALID_INPUT', 'createRevision: document is required');
  }
  if (!CHANGE_SOURCE_VALUES.includes(input.createdBy)) {
    throw new ResumeRevisionError(
      'INVALID_INPUT',
      `createdBy must be one of ${CHANGE_SOURCE_VALUES.join('|')}`,
    );
  }
  if (input.createdByUserId !== undefined && input.createdByUserId !== null && typeof input.createdByUserId !== 'string') {
    throw new ResumeRevisionError('INVALID_INPUT', 'createdByUserId must be a string or null');
  }

  // 1. Schema validation, BEFORE anything is written. `assertValidResumeJson` is the
  //    throwing form; its issues ride along on the error so a route can return them.
  try {
    assertValidResumeJson(input.document);
  } catch (error) {
    const issues =
      error && typeof error === 'object' && Array.isArray((error as { errors?: unknown }).errors)
        ? ((error as { errors: { path: string; keyword: string; message: string }[] }).errors)
        : [];
    throw new ResumeRevisionError(
      'INVALID_JSON',
      error instanceof Error ? error.message : String(error),
      issues,
    );
  }

  // 1b. THE GATE'S INPUT, RESOLVED FROM THE DOCUMENT. A V2 document must carry an
  //     `x-clearance` block; without one there is no claim accounting, and a revision
  //     with no accounting is the bypass (a document full of unconfirmed text, zero
  //     usage rows, and therefore a vacuously green gate). `undefined` is treated as V2
  //     so the requirement cannot be escaped by omitting the block that carries the
  //     version.
  const clearance = requireClearanceBlockForV2(readClearanceBlock(input.document));

  // 1c. The claim rows the block names, and THE CROSS-CHECK - WHICH NOW REFRESHES.
  //
  //     It USED TO REFUSE (`assertClearanceMatchesClaims`), and that refused the Studio's
  //     autosave on any resume whose claims had moved after its revision was written: the
  //     Studio loads the current revision's document, the user edits it, a claim has been
  //     CONFIRMED in the meantime, and the block's statuses are STALE - honest, and out
  //     of date. One test could not tell those apart, and a guard that can only tell a
  //     forgery from a stale snapshot by refusing both is not a guard.
  //
  //     The database is authoritative, so `refreshClearanceFromClaims` overwrites the
  //     block's row-derived members (`status`, `provenance`, `confidence`,
  //     `evidenceSourceId`, and the three counts) with the rows' own values and REFUSES
  //     only the structural disagreements: a named claim that resolves to no row, a row
  //     in play the block does not name, or an unusable entry. Refresh, do not refuse.
  //
  //     WHY THAT IS NOT WEAKER. The pre-render gate reads status from the DATABASE and
  //     the render path re-derives the block, so a forged status never made anything
  //     render - there is no code path where the document's stated status is the status
  //     acted on. Refusing bought a stored block that is never a lie; overwriting the
  //     row's values delivers that more completely than a 400, and a 400 in the honest
  //     case was the entire cost. `assertClaimBackanceMatchesClaims`'s stronger sibling
  //     remains the PROJECTOR's own post-condition in `project.ts`, where a disagreement
  //     is a bug rather than a stale snapshot.
  const declaredUsages = deriveUsageFromDocument(input.document);
  const claimScope: ClaimUsageScope = { profileId: clearance.profileId };
  const resolvedClaims = await assertClaimUsagesRecordable(
    declaredUsages,
    store as unknown as ResumeClaimUsageStore,
    claimScope,
  );
  let refreshedBlock: ClearanceBlock;
  try {
    refreshedBlock = refreshClearanceFromClaims(clearance, [...resolvedClaims.values()]).clearance;
  } catch (error) {
    throw new ResumeRevisionError(
      'CLEARANCE_DISAGREES_WITH_CLAIMS',
      error instanceof Error ? error.message : String(error),
    );
  }

  // The SNAPSHOT carries the refreshed block, and everything downstream - the derived
  // usage set, the belt, the hash, the stored bytes - reads THAT document, not the
  // caller's. Storing the caller's stale block and refreshing it only in memory would put
  // the lie the ruling exists to remove straight back into the audit trail.
  //
  // A shallow copy: `x-clearance` is replaced wholesale, and no other member of the
  // document is touched, so the caller's object graph is not mutated underneath it.
  const document: ResumeJson = {
    ...(input.document as Record<string, unknown>),
    [X_CLEARANCE_KEY]: refreshedBlock,
  } as ResumeJson;

  // Re-derived from the REFRESHED document, not reused from the caller's. The refresh
  // preserves `usage` / `jsonPath` / `renderedText`, so the two sets are equal - and
  // deriving from what is actually STORED means a future refresh that did touch one of
  // them could not leave the recorded usage set describing a document nobody kept.
  const storedUsages = deriveUsageFromDocument(document);

  // 1d. A caller-supplied usage set may RESTATE the derived set and may not change it.
  //     A mismatch in either direction is refused before any write.
  assertUsagesMatchDocument(storedUsages, input.usages);

  // 1e. SELF-CONSISTENCY OF THE DERIVED SET ITSELF (ADR-043 decision 4, closing N2).
  //     One `claimId` twice in the block would collapse to ONE `ResumeClaimUsage` row
  //     (first entry wins), so the recorded usage would be a function of entry ORDER and
  //     the read-time set comparison could not see the difference. Refused here, where
  //     the ambiguity is still two entries rather than one row.
  assertOneUsagePerClaimId(storedUsages);

  // 1f. THE BELT, AT BOTH ENDS (ADR-043 decision 7). This is the same predicate
  //     `assertRevisionRenderableInScope` step 5 runs over the STORED bytes; running it
  //     here as well means a malformed document is refused at the request that carried it,
  //     with the offending path in the message, rather than surfacing as a
  //     `DOCUMENT_UNAUDITED` at a render the user has already been told succeeded.
  assertClaimBackedTextAccounted(document);

  // 2. The hash is over the CANONICAL bytes of the REFRESHED document: two documents that
  //    differ only in key insertion order are the same revision, and hashing the raw object
  //    would say otherwise on every process. It must be the STORED bytes' hash, or
  //    `revisionHashMatches` fails at the very next render.
  const jsonHash = canonicalJsonHash(document);

  // 3. N+1.
  const latest = await store.resumeRevision.findFirst({
    where: { resumeId: input.resumeId },
    orderBy: { revisionNumber: 'desc' },
  });
  const revisionNumber = (latest?.revisionNumber ?? 0) + 1;

  const data: Prisma.ResumeRevisionUncheckedCreateInput = {
    resumeId: input.resumeId,
    revisionNumber,
    resumeJson: document as unknown as Prisma.InputJsonValue,
    jsonHash,
    enginePins: (input.enginePins ?? {}) as Prisma.InputJsonValue,
    createdBy: input.createdBy,
    createdByUserId: input.createdByUserId ?? null,
    reason: input.reason ?? null,
    ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
  };

  // 4. Validate the op log BEFORE the insert. It used to be validated after, which
  //    meant a bad `op` left an ORPHAN REVISION behind - a snapshot in the history with
  //    no op log and no claim usage, i.e. one that reads to the diff view as "this
  //    revision changed nothing" when in fact the request was rejected. Found by
  //    `revisions.test.ts`; the all-or-nothing shape is the point of a snapshot.
  const changes = input.changes ?? [];
  for (const [index, change] of changes.entries()) {
    if (change === null || typeof change !== 'object') {
      throw new ResumeRevisionError('INVALID_INPUT', `changes[${index}] must be an object`);
    }
    if (!CHANGE_OP_VALUES.includes(change.op)) {
      throw new ResumeRevisionError(
        'INVALID_INPUT',
        `changes[${index}].op must be one of ${CHANGE_OP_VALUES.join('|')}, got ${JSON.stringify(change.op)}`,
      );
    }
    if (typeof change.jsonPath !== 'string' || change.jsonPath.length === 0) {
      throw new ResumeRevisionError('INVALID_INPUT', `changes[${index}].jsonPath is required`);
    }
  }

  // 5. INSERT. This is the only write to a revision anywhere in the repository.
  const revision = await store.resumeRevision.create({ data });

  // The op log and the claim usage are children of the revision, so writing them here -
  // after the insert - means a revision without its usage cannot exist. Both lists were
  // fully validated above, so neither of these writes can fail on a bad value: a
  // rejected claim, an unknown claim, a missing renderedText and a malformed op have all
  // already been refused. What is left is a foreign-key or a lost connection, and the
  // honest statement about those is that they need a transaction, not that they are
  // impossible.
  for (const change of changes) {
    await store.resumeChange.create({
      data: {
        revisionId: revision.id,
        op: change.op,
        jsonPath: change.jsonPath,
        before: (change.before ?? null) as Prisma.InputJsonValue,
        after: (change.after ?? null) as Prisma.InputJsonValue,
        reason: change.reason ?? null,
        targetRequirementIds: [...(change.targetRequirementIds ?? [])] as unknown as Prisma.InputJsonValue,
        sourceClaimIds: [...(change.sourceClaimIds ?? [])] as unknown as Prisma.InputJsonValue,
        appliedBy: change.appliedBy ?? input.createdBy,
        accepted: change.accepted ?? true,
      },
    });
  }

  // The DERIVED set - re-derived from the stored document above, not the caller's.
  if (storedUsages.length > 0) {
    await recordClaimUsages(
      revision.id,
      storedUsages,
      store as unknown as ResumeClaimUsageStore,
      claimScope,
    );
  }

  return revision;
}

// ---------------------------------------------------------------------------
// Read: list / get / current
// ---------------------------------------------------------------------------

/** How many revisions `listRevisions` returns when no limit is given. */
export const DEFAULT_REVISION_PAGE = 50;
export const MAX_REVISION_PAGE = 200;

export interface ListRevisionsQuery {
  resumeId: string;
  limit?: number;
  offset?: number;
}

/** Every revision of a resume, OLDEST FIRST. Order is a contract, not a default. */
export async function listRevisions(
  query: ListRevisionsQuery,
  store: ResumeRevisionStore,
): Promise<ResumeRevision[]> {
  if (query === null || typeof query !== 'object') {
    throw new ResumeRevisionError('INVALID_INPUT', 'listRevisions needs a query object');
  }
  assertNonEmpty(query.resumeId, 'listRevisions: resumeId');
  const limit =
    typeof query.limit === 'number' && Number.isFinite(query.limit) && query.limit >= 1
      ? Math.min(Math.floor(query.limit), MAX_REVISION_PAGE)
      : DEFAULT_REVISION_PAGE;
  const rows = await store.resumeRevision.findMany({
    where: { resumeId: query.resumeId },
    orderBy: { revisionNumber: 'asc' },
    take: limit,
    ...(typeof query.offset === 'number' && query.offset > 0 ? { skip: Math.floor(query.offset) } : {}),
  });
  return [...rows].sort((a, b) => a.revisionNumber - b.revisionNumber);
}

export async function getRevision(
  revisionId: string,
  store: ResumeRevisionStore,
): Promise<ResumeRevision | null> {
  assertNonEmpty(revisionId, 'getRevision: revisionId');
  return store.resumeRevision.findFirst({ where: { id: revisionId } });
}

export async function getRevisionByNumber(
  resumeId: string,
  revisionNumber: number,
  store: ResumeRevisionStore,
): Promise<ResumeRevision | null> {
  assertNonEmpty(resumeId, 'getRevisionByNumber: resumeId');
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
    throw new ResumeRevisionError('INVALID_INPUT', 'revisionNumber must be an integer >= 1');
  }
  return store.resumeRevision.findFirst({ where: { resumeId, revisionNumber } });
}

/** The current revision: `max(revisionNumber)`, per 05 sec.5. `null` when there is none. */
export async function getCurrentRevision(
  resumeId: string,
  store: ResumeRevisionStore,
): Promise<ResumeRevision | null> {
  assertNonEmpty(resumeId, 'getCurrentRevision: resumeId');
  return store.resumeRevision.findFirst({
    where: { resumeId },
    orderBy: { revisionNumber: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// The change log and the diff
// ---------------------------------------------------------------------------

export interface ListChangesQuery {
  revisionId: string;
}

/** The op log of one revision, oldest first, in insertion order within an op. */
export async function listRevisionChanges(
  query: ListChangesQuery,
  store: Pick<ResumeRevisionStore, 'resumeChange'>,
): Promise<ResumeChange[]> {
  assertNonEmpty(query?.revisionId, 'listRevisionChanges: revisionId');
  const rows = await store.resumeChange.findMany({ where: { revisionId: query.revisionId } });
  return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

export type DiffChangeKind = 'added' | 'removed' | 'changed';

/** One difference between two revisions, addressed by JSON path. */
export interface DiffEntry {
  kind: DiffChangeKind;
  /** e.g. `work[0].highlights[2]`. Root is `''`. */
  jsonPath: string;
  before: unknown;
  after: unknown;
}

export interface RevisionDiff {
  from: { revisionId: string; revisionNumber: number; jsonHash: string };
  to: { revisionId: string; revisionNumber: number; jsonHash: string };
  /** True when the two canonical byte strings are identical. */
  identical: boolean;
  entries: DiffEntry[];
  /**
   * The claim-status movement between the two documents. This is the diff a reviewer
   * actually needs ("this revision swapped an inferred claim for a confirmed one"),
   * and it is derived from the `x-clearance` blocks - as a READING of the two
   * snapshots, never as the gate's input.
   */
  claimStatusChanges: Array<{
    claimId: string;
    from: string | null;
    to: string | null;
  }>;
}

const SKIP_KEYS = new Set([X_CLEARANCE_KEY]);

function walkDiff(before: unknown, after: unknown, path: string, out: DiffEntry[]): void {
  if (out.length >= 500) return; // bounded: a diff is for a human, not for a machine
  const beforeIsObject =
    before !== null && typeof before === 'object' && !Array.isArray(before);
  const afterIsObject = after !== null && typeof after === 'object' && !Array.isArray(after);

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const childPath = `${path}[${index}]`;
      if (index >= before.length) out.push({ kind: 'added', jsonPath: childPath, before: null, after: after[index] });
      else if (index >= after.length) out.push({ kind: 'removed', jsonPath: childPath, before: before[index], after: null });
      else walkDiff(before[index], after[index], childPath, out);
    }
    return;
  }

  if (beforeIsObject && afterIsObject) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      // `x-clearance` is reported separately (as claim-status movement), not as a
      // wholesale key replacement: a diff that says "changed /x-clearance.claims[0].status"
      // is technically true and practically useless.
      if (SKIP_KEYS.has(key)) continue;
      const childPath = path === '' ? key : `${path}.${key}`;
      if (!(key in left)) out.push({ kind: 'added', jsonPath: childPath, before: null, after: right[key] });
      else if (!(key in right)) out.push({ kind: 'removed', jsonPath: childPath, before: left[key], after: null });
      else walkDiff(left[key], right[key], childPath, out);
    }
    return;
  }

  if (canonicalJsonString(before) !== canonicalJsonString(after)) {
    out.push({ kind: 'changed', jsonPath: path, before, after });
  }
}

function clearanceOf(revision: ResumeRevision): ClearanceBlock | null {
  const document = revision.resumeJson as unknown as Record<string, unknown> | null;
  if (document === null || typeof document !== 'object') return null;
  const block = document[X_CLEARANCE_KEY];
  if (block === null || typeof block !== 'object') return null;
  return block as ClearanceBlock;
}

/** The claim statuses each document reports, read from its `x-clearance` block. */
function statusesOf(revision: ResumeRevision): Map<string, string> {
  const block = clearanceOf(revision);
  const out = new Map<string, string>();
  for (const entry of block?.claims ?? []) {
    if (entry && typeof entry.claimId === 'string' && typeof entry.status === 'string') {
      out.set(entry.claimId, entry.status);
    }
  }
  return out;
}

/**
 * The change log between two revisions (06-design E.10: `GET /resumes/:id/diff`).
 *
 * Two halves, because the diff UX has two questions: "what text changed?" (the walk)
 * and "did the EVIDENCE behind it change?" (the claim-status movement). The second half
 * is the one that makes a diff reviewable - a bullet that was rewritten from an
 * inferred claim into a CONFIRMED one is the whole point of the feature.
 *
 * The `x-clearance` block is EXCLUDED from the structural walk on purpose; see
 * `SKIP_KEYS`.
 */
export function diffRevisions(from: ResumeRevision, to: ResumeRevision): RevisionDiff {
  if (!from || !to) {
    throw new ResumeRevisionError('INVALID_INPUT', 'diffRevisions needs two revisions');
  }
  const entries: DiffEntry[] = [];
  walkDiff(from.resumeJson, to.resumeJson, '', entries);
  entries.sort((a, b) => (a.jsonPath < b.jsonPath ? -1 : a.jsonPath > b.jsonPath ? 1 : 0));

  const before = statusesOf(from);
  const after = statusesOf(to);
  const claimStatusChanges: RevisionDiff['claimStatusChanges'] = [];
  for (const claimId of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(claimId) ?? null;
    const right = after.get(claimId) ?? null;
    if (left !== right) claimStatusChanges.push({ claimId, from: left, to: right });
  }

  return {
    from: { revisionId: from.id, revisionNumber: from.revisionNumber, jsonHash: from.jsonHash },
    to: { revisionId: to.id, revisionNumber: to.revisionNumber, jsonHash: to.jsonHash },
    identical: entries.length === 0 && claimStatusChanges.length === 0,
    entries,
    claimStatusChanges,
  };
}

/** The canonical bytes of a stored revision - what its `jsonHash` was computed over. */
export function revisionCanonicalJson(revision: ResumeRevision): string {
  return canonicalJsonString(revision.resumeJson);
}

/**
 * Does the stored row still hash to its recorded `jsonHash`?
 *
 * A cheap tripwire for the immutability property: if anything ever DID update a
 * revision, the two would disagree. It is a check on a fact rather than a proof that
 * no write path exists - the type-level seam in `ResumeRevisionWriteSeam` and the
 * export-surface test are the proofs - but it catches a write that bypassed this
 * module.
 *
 * It is also load-bearing at RENDER time now: `assertRevisionRenderableInScope` runs it
 * before the gate, so the document the gate is about to vouch for is the document that
 * was actually written. A tampered row is refused rather than rendered.
 */
export function revisionHashMatches(revision: ResumeRevision): boolean {
  return canonicalJsonHash(revision.resumeJson) === revision.jsonHash;
}

// ---------------------------------------------------------------------------
// THE READ-TIME HALF: the same document -> usage binding, verified before a render
// ---------------------------------------------------------------------------

/**
 * The closed set of reasons a revision may be refused at READ time, before the gate
 * even runs. Separate from `GateRejectionReason` on purpose: these are about the
 * INTEGRITY of the audit trail (does the log still describe this document?), while the
 * gate's reasons are about the STATUS of the claims. A client has to be able to tell
 * "this revision's audit trail does not match its document" (a server-side integrity
 * problem) from "you have not confirmed these claims yet" (the ordinary case).
 */
export const REVISION_AUDIT_REASONS = Object.freeze([
  /** The stored bytes no longer hash to the stored `jsonHash`. */
  'REVISION_TAMPERED',
  /** The `x-clearance` block names a claim the usage log does not record, or vice versa. */
  'USAGE_SET_MISMATCH',
  /** A V2 document carries career text but declares no claim at all. */
  'DOCUMENT_UNAUDITED',
  /** The block names a claim id that resolves to no `CareerClaim` row. */
  'CLAIM_UNRESOLVED',
] as const);

export type RevisionAuditReason = (typeof REVISION_AUDIT_REASONS)[number];

const AUDIT_REASON_TEXT: Readonly<Record<RevisionAuditReason, string>> = Object.freeze({
  REVISION_TAMPERED:
    'the stored revision no longer hashes to its recorded jsonHash, so its content changed after it was written',
  USAGE_SET_MISMATCH:
    "the recorded claim usage does not match the document's x-clearance block; the audit trail does not describe this document",
  DOCUMENT_UNAUDITED:
    'a V2 resume document that carries career text must declare the claims it uses; a document with no claim accounting cannot be rendered',
  CLAIM_UNRESOLVED:
    "the document's x-clearance block names a claim that resolves to no claim row",
});

/** A revision refused because its audit trail is not intact. Carries a stable code. */
export class RevisionAuditError extends Error {
  readonly code = 'resume_revision_audit_failed' as const;
  readonly reason: RevisionAuditReason;

  constructor(reason: RevisionAuditReason) {
    super(`resume_revision_audit_failed: ${AUDIT_REASON_TEXT[reason]}`);
    this.name = 'RevisionAuditError';
    this.reason = reason;
  }

  toJSON(): { code: 'resume_revision_audit_failed'; reason: RevisionAuditReason } {
    return { code: this.code, reason: this.reason };
  }
}

/**
 * The read-time binding, then the gate. This is what a render route calls.
 *
 * ADR-043: the six steps, in this order, and the order IS the point.
 *   1. `REVISION_TAMPERED` - the row must still hash to its `jsonHash`. A tampered
 *      revision is not audited, because there is no longer a version of it that was.
 *   2. `DOCUMENT_UNAUDITED` - no `x-clearance` block at all.
 *   3. `CLAIM_UNRESOLVED` - every `claimId` the block names must resolve to a
 *      `CareerClaim` row, scoped to the block's own `profileId`.
 *   4. `USAGE_SET_MISMATCH` - the recorded log and the document's declared set must
 *      be the same MULTISET of `(claimId, usage)`, in both directions, WITH
 *      multiplicity. Keyed on `claimId` alone (the attempt-2 form) this step could
 *      not see a block that declared one claim twice.
 *   5. `DOCUMENT_UNAUDITED` - every claim-backed string in the stored document must
 *      be named, at that exact path, with that exact text, by a text-rendering
 *      entry of this document's own block. UNCONDITIONAL: never gated on the
 *      declared set being non-empty, which is what let a document declaring one
 *      claim escape the text check entirely.
 *   6. and only then does the gate run, unchanged, on `loadGateUsages`.
 *
 * WHAT IS DELIBERATELY ABSENT: a read-time status cross-check. A
 * revision is a SNAPSHOT of the statuses that were true when it was written, so a
 * block that disagrees with its rows at READ time is STALE, not forged - the user
 * confirmed the claim afterwards. Refusing on that basis would make a resume stop
 * being renderable because it got SAFER. The status the gate acts on is the one
 * `loadGateUsages` read from the DATABASE, which is the design; the write-time
 * cross-check is where forgery is handled, and it now REFRESHES the block from the rows rather than refusing them (`refreshClearanceFromClaims`), so a stored block already carries the database's value. This is a deviation from the review's
 * suggested fix, accepted by the re-review (review-T1030-attempt2.md sec. 5).
 *
 * THE SCOPE IS THE BLOCK'S OWN `profileId`, so the tenant bound is a property of
 * this check rather than something inherited from write time. Not exploitable
 * today - the stored block was already profile-scoped when it was written - but a
 * check that keys on the block's own scope cannot be widened by anything else.
 */
export async function assertRevisionRenderableInScope(
  revision: ResumeRevision,
  store: ResumeClaimUsageStore,
): Promise<GateVerdict> {
  if (revision === null || typeof revision !== 'object' || typeof revision.id !== 'string') {
    throw new PreRenderGateInputError('assertRevisionRenderableInScope needs a revision row');
  }

  // 1. Integrity of the snapshot itself.
  if (!revisionHashMatches(revision)) {
    throw new RevisionAuditError('REVISION_TAMPERED');
  }

  // 2. The block must EXIST. A document with no `x-clearance` has no claim accounting,
  //    and a claim-accounting-free document is exactly the bypass the gate exists to
  //    refuse. Unconditional, and before anything is read from the database.
  const block = readClearanceBlock(revision.resumeJson);
  if (block === null) {
    throw new RevisionAuditError('DOCUMENT_UNAUDITED');
  }

  const declared = deriveUsageFromDocument(revision.resumeJson);
  const claimIds = [...new Set(declared.map((usage) => usage.claimId))].sort();
  const profileId =
    typeof block.profileId === 'string' && block.profileId.length > 0 ? block.profileId : null;
  const claims =
    claimIds.length === 0
      ? []
      : await store.careerClaim.findMany({
          where:
            profileId === null ? { id: { in: claimIds } } : { id: { in: claimIds }, profileId },
        });
  if (claims.length !== claimIds.length) {
    throw new RevisionAuditError('CLAIM_UNRESOLVED');
  }
  // DELIBERATELY NOT A STATUS CROSS-CHECK HERE, and the reason is the whole
  // design of this module. A revision is a SNAPSHOT: it recorded the statuses that were
  // true when it was written, and a user who confirms or rejects a claim afterwards makes
  // the stored block stale. Refusing a stale block would mean a resume stopped being
  // renderable because a claim was CONFIRMED, which is backwards. The status the gate
  // acts on is the one `loadGateUsages` read from the DATABASE, so a stale block is
  // harmless - it is a historical record, and the gate is not reading it.
  //
  // The cross-check belongs on the WRITE path, where there is no history to preserve and
  // a block that disagrees with its rows at creation time is a forgery rather than a
  // snapshot, so the WRITE path REFRESHES the block from the rows rather than refusing
  // (`refreshClearanceFromClaims`) - so a block written through this module already
  // agrees with its rows and can only go stale afterwards, which is exactly the state this
  // function declines to refuse. Step 3 above still requires every claim the block names to
  // RESOLVE, which is the structural half that must hold at read time.

  // 4. The log must describe this document, as a MULTISET of `(claimId, usage)`.
  //    N6: the attempt-2 form compared `claimId` alone, so it could not see the one
  //    dimension the gate acts on - which is what made N2 work. With the pair as the
  //    key AND multiplicity counted, a document that declares one claim twice gives
  //    2 declared against 1 recorded and can never be equal.
  const recorded = await loadGateUsages(revision.id, store);
  const pairKey = (claimId: string, usage: string): string => JSON.stringify([claimId, usage]);
  const multiset = (pairs: readonly (readonly [string, string])[]): string[] =>
    pairs.map(([claimId, usage]) => pairKey(claimId, usage)).sort();
  const declaredPairs = multiset(
    declared.map((usage) => [usage.claimId, usage.usage] as readonly [string, string]),
  );
  const recordedPairs = multiset(
    recorded.map((usage) => [usage.claimId, usage.usage] as readonly [string, string]),
  );
  if (
    declaredPairs.length !== recordedPairs.length ||
    declaredPairs.some((pair, index) => pair !== recordedPairs[index])
  ) {
    throw new RevisionAuditError('USAGE_SET_MISMATCH');
  }

  // 5. THE BELT. Every claim-backed string in the STORED bytes must be named, at that
  //    exact path, with that exact text, by a text-rendering entry of this document's
  //    own block. The domain is `claimSurface.ts` - the same constant the projector
  //    builds its jsonPaths from - and the walk is exhaustive over every array
  //    element, which is what the attempt-2 `find`-on-`*` version missed (N1).
  //    It runs unconditionally, never gated on the declared set being non-empty.
  const placements = declaredTextPlacements(revision.resumeJson);
  for (const { path, text } of claimBackedTextAt(revision.resumeJson)) {
    const accounted = placements.some(
      (entry) =>
        entry.jsonPath === path &&
        GATED_USAGES.includes(entry.usage) &&
        (entry.renderedText ?? '').trim() === text,
    );
    if (!accounted) {
      throw new RevisionAuditError('DOCUMENT_UNAUDITED');
    }
  }

  // 6. The gate itself, unchanged.
  return assertPreRenderGate(evaluatePreRenderGate(recorded));
}

export type { Resume, ResumeRevision, ResumeChange };
export { PreRenderGateInputError };