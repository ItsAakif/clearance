// =====================================================================================
// tailor/validate.ts - THE DETERMINISTIC GATE ON AN OPERATION (T1080; 06 sec.E.3, the
// five numbered rules).
//
// THE WHOLE DESIGN IN ONE SENTENCE. "Deterministic validation before any op is applied
// (the LLM NEVER mutates the DB)" - so this module is PURE, reads no clock and no
// environment, and is handed every fact it needs in a `ValidationContext` that the route
// assembled from the database. Two consequences follow and both are the point:
//
//   1. The same operation + the same context always produce the same verdict, whether the
//      operation came from a model or from an HTTP body. A caller cannot obtain a laxer
//      validation by arriving through a different route.
//   2. The whole rule set is assertable in unit tests with three literals, and the
//      fabricated-metric fixture is a fixture rather than an integration test.
//
// THE FIVE RULES, AND WHERE EACH ONE LIVES.
//   1. `target` resolves to an existing node in the revision's `resumeJson`.
//        -> `targetResolves`. Also refuses a target that is not shaped like a path, and a
//        target that names the claim ledger (`addressesLedger`).
//   2. `sourceClaimIds` is non-empty for any text-changing op; every id resolves to a claim
//      with the CONFIRMING status; otherwise the op is rejected with a machine-readable
//        reason.
//        -> `claimsGround`. The status test is `isRenderableClaimStatus` from the career
//        layer, NEVER a literal: the career layer owns that vocabulary
//        (`career/claimWriterAI.test.ts` fails a module outside it that spells one).
//   3. Fact-preservation: `entities(after) subset-of entities(before) union
//      entities(confirmed claims)`; a new number/employer/technology sets `factDelta` and
//      BLOCKS.
//        -> `noFactDelta`, delegating every extraction to `factDelta.ts`.
//   4. `remove_skill`/`exclude` require the entry to be absent from `requiredDictKeys` for
//      the chosen template, or the op is downgraded.
//        -> `templateStillHasItsSection`. The downgrade E.3 names is not implemented as a
//        silent downgrade: an op that has to be downgraded is REFUSED, because the caller's
//        `accepted` flag would then describe an operation that was not the one they accepted.
//        See the docstring on the rule for the exact condition.
//   5. `reorder` operates on a permutation of existing node ids only.
//        -> `isPermutation`.
//
// AND THE RULE THAT IS NOT IN E.3's LIST AT ALL, BECAUSE E.3 BELIEVED IT WAS COVERED.
//   6. `include` CARRIES NO PROSE OF ITS OWN. `include` is STRUCTURAL (`ops.ts`), so rule 3
//      does not run on it - which is correct only because of what `include` is allowed to
//      write. Its `after`, WHEN IT CARRIES TEXT AT ALL, must BE the statement of the claim it
//      names, compared with `career/claims.ts#normalizeStatement` (the normalisation that
//      gives a claim its fingerprint, and so the engine's own answer to "are these the same
//      words"). Anything else is `CLAIM_TEXT_MISMATCH`. An `include` with NO `after` is
//      accepted, and that is the purely structural form: `apply.ts` then writes the claim row's
//      own `statement.trim()` - the projector's own verbatim form - and never the request's
//      bytes. Neither form can put a word on the page that the confirmed claim did not say,
//      which is why rule 3's absence costs nothing.
//        -> the `include` entry of `OP_SHAPE`.
//
// AND THE SECOND RULE THIS MODULE ADDS, WHICH IS ABOUT THE BATCH AND NOT ABOUT THE OPERATION.
//      `validateOperation` sees ONE operation against ONE document, and the document the route
//      hands it is the PARENT - assembled once, before any operation is applied. So "the slot
//      is empty" is true of the parent for EVERY `include` in the batch, including two that
//      address the SAME slot, and both would validate. One slot, one text, one claim is
//      therefore not a property of validation; it has to be a property of the FOLD, checked
//      against the document as it stands after the operations before it.
//        -> `rule9AgainstRunningDocument`, called by `apply.ts` per operation.
//
// WHAT IS DELIBERATELY NOT VALIDATED HERE, AND WHY.
//   - NOT the QUALITY of the wording. This module asks "is this grounded?", never "is this
//     good?". A better phrasing of a confirmed claim is the user's call, and a module that
//     scored phrasing would become a scorer, which E.6 forbids.
//   - NOT whether the JD requirement is real. `targetRequirementIds` are RECORDED, never
//     resolved: the requirement ids are the report's audit trail, and a tailoring pass that
//     checked them would have to own the matcher's evidence levels. A requirement id that
//     does not exist is not a fabrication risk - nothing is written from it.
//   - NOT the template's own validity. `ValidationContext.knownTemplateIds` is advisory: when
//     the route supplies the registry's ids, an unknown `customize_style` target is refused;
//     when it does not, the op is accepted and recorded. The route is the enforcement point
//     because the registry is an I/O-backed module and this one is not.
//
// NO PARTIAL VALIDITY. `validateOperation` returns either a validated operation or a single
// refusal - never an operation with warnings attached. A caller that wants to know "could I
// have this without the fact delta?" reads the refusal's `code`, which is exactly why the
// codes are a closed vocabulary.
// =====================================================================================

import type { CareerClaim } from '@prisma/client';

import { isRenderableClaimStatus } from '../career/claimUsage.js';
import { normalizeStatement } from '../career/claims.js';
import {
  addressesLedger,
  isClaimBackedTarget,
  isTextChangingOp,
  parseOperation,
  readTarget,
  reject,
  renderTokens,
  targetIsOccupied,
  targetTokens,
  REORDERABLE_TARGETS,
  STYLE_TARGET,
  type OpRejection,
  type TailorOperation,
} from './ops.js';
import {
  detectFactDelta,
  describeFactDelta,
  extractFacts,
  factsOfTexts,
  unionFacts,
} from './factDelta.js';

// ---------------------------------------------------------------------------
// The context the route assembles
// ---------------------------------------------------------------------------

/**
 * Everything validation needs, and nothing it does not.
 *
 * `claims` is the set of claims this operation may ground, RESOLVED BY THE ROUTE from the
 * block's own `profileId` - the same scope `assertRevisionRenderableInScope` uses. A caller
 * that assembled this from an unscoped query could pass another tenant's confirmed claim and
 * satisfy rule 2 with it, so the scope is the caller's responsibility and is named here as
 * a field (`profileId`) rather than being inferred.
 */
export interface ValidationContext {
  /** The revision's `resumeJson`, i.e. the BEFORE state. Never mutated. */
  readonly document: unknown;
  /** The block's own `profileId`. Echoed into the result so a caller can assert the scope. */
  readonly profileId: string;
  /** Claims of THIS profile. `confirmedById` is derived from this list, never supplied. */
  readonly claims: readonly CareerClaim[];
  /** `TemplateMetadata.requiredDictKeys` for the chosen template (a SECTION vocabulary). */
  readonly requiredDictKeys: readonly string[];
  /** The template's id, for the record. Not validated. */
  readonly templateId: string;
  /** The employers this resume already knows, from `work[].name` and attached experiences. */
  readonly knownEmployers?: readonly string[];
  /** The registry's template ids. Supplied by the route; absent means "not checked". */
  readonly knownTemplateIds?: readonly string[];
}

export type ValidationResult =
  | { readonly ok: true; readonly validated: ValidatedOperation }
  | { readonly ok: false; readonly rejection: OpRejection };

/** A validated operation: the operation, plus what the validator resolved while checking it. */
export interface ValidatedOperation {
  readonly operation: TailorOperation;
  /** The confirmed claims this operation is grounded in. NEVER empty for a text op. */
  readonly groundingClaims: readonly CareerClaim[];
  /** `true` when `factDelta` was computed and is clean. `false` when the op has no new text. */
  readonly factChecked: boolean;
}

// ---------------------------------------------------------------------------
// Rule 1: the target resolves
// ---------------------------------------------------------------------------

/**
 * The target's PARENT: the same path with its last STEP removed, in path syntax.
 *
 * `work[0].highlights[2]` -> `work[0].highlights` (the ARRAY the slot is in), `basics.summary`
 * -> `basics`, `work` -> `''` (the document root).
 *
 * Needed twice and worth a name: `include` requires the parent to EXIST and to be an array -
 * that is what "a slot that is currently empty" means, and creating a parent means creating a
 * SECTION, which this engine may not do - and the reviewer needs to be able to ask "what is
 * the parent of this target?" without reconstructing the grammar.
 */
export function parentTarget(target: string): string {
  const tokens = targetTokens(target);
  if (tokens === null || tokens.length === 0) return '';
  return renderTokens(tokens.slice(0, -1));
}

/** The SECTION a target belongs to: `work[1].highlights[0]` -> `work`. `''` for a root member. */
export function sectionOf(target: string): string {
  const tokens = targetTokens(target);
  return tokens === null || tokens.length === 0 ? '' : (tokens[0] as string);
}

/**
 * THE FIVE OPS WHOSE "THE TARGET IS ABSENT" ANSWER BELONGS TO THE SHAPE RULE, NOT TO RULE 1.
 *
 * `exclude`, `remove_skill` and `include` all address a slot that may legitimately be empty -
 * "remove the skill at `skills[3]`" is a sensible request about a resume with two skills, and
 * "put this claim at `work[0].highlights[2]`" is exactly what `include` means. Refusing them
 * at rule 1 with `TARGET_UNRESOLVED` would make the vocabulary unusable; their own shape rules
 * answer `TARGET_NOT_FOUND` / `CLAIM_ALREADY_RENDERED` with the more specific code.
 *
 * `add_skill` and `reorder` are in the list for the same reason and are named in
 * `REORDERABLE_TARGETS`: a resume with no skills has no `skills` array, and creating one is
 * what `add_skill` is for.
 */
const SHAPE_DECIDES_ABSENCE: readonly string[] = Object.freeze([
  'exclude',
  'remove_skill',
  'include',
]);

function rule1TargetResolves(op: TailorOperation, ctx: ValidationContext): OpRejection | null {
  if (addressesLedger(op.target)) {
    return reject('TARGET_MALFORMED', 'no operation may address the claim ledger');
  }
  const tokens = targetTokens(op.target);
  if (tokens === null) {
    return reject('TARGET_MALFORMED', `${op.op} ${JSON.stringify(op.target)}`);
  }
  // `customize_style` addresses the RENDER, which is not a document member by design
  // (ADR-044 D3: one snapshot, many layouts). It has no node to resolve.
  if (op.target === STYLE_TARGET) return null;
  // The section arrays, and the three ops above.
  if (REORDERABLE_TARGETS.includes(op.target) || SHAPE_DECIDES_ABSENCE.includes(op.op)) return null;
  return readTarget(ctx.document, op.target) === undefined
    ? reject('TARGET_UNRESOLVED', `${op.op} ${op.target}`)
    : null;
}

// ---------------------------------------------------------------------------
// Rule 2: the operation is grounded in CONFIRMED claims
// ---------------------------------------------------------------------------

/**
 * Rule 2, and the claim that an operation's source claim must be the one that PLACED the
 * text it is rewriting.
 *
 * That second half is not in the spec's wording and it is the part that closes the obvious
 * hole. Without it, a caller could name ANY confirmed claim as the source of a rewrite of a
 * bullet placed by a different claim: the guard would see "this operation names a confirmed
 * claim", and the resulting bullet would carry the named claim's status in the ledger while
 * saying something the named claim never asserted. So for a claim-backed target, the entry at
 * that path in the document's own `x-clearance` block must be one of the operation's
 * `sourceClaimIds`.
 *
 * Returns the resolved claims so the caller does not re-resolve them, and `[]` for an op that
 * needs no grounding.
 */
function rule2ClaimsGround(
  op: TailorOperation,
  ctx: ValidationContext,
): { claims: CareerClaim[]; rejection: OpRejection | null } {
  const byId = new Map(ctx.claims.map((claim) => [claim.id, claim] as const));

  if (!isTextChangingOp(op.op)) {
    // A STRUCTURAL op may name claims, but it may not name an unconfirmed one either:
    // recording "this exclusion is justified by <rejected claim>" would put a rejected
    // claim into an audit trail as if it were evidence.
    for (const id of op.sourceClaimIds) {
      const claim = byId.get(id);
      if (!claim) return { claims: [], rejection: reject('SOURCE_CLAIM_NOT_FOUND', id) };
      if (!isRenderableClaimStatus(claim.status)) {
        return { claims: [], rejection: reject('SOURCE_CLAIM_NOT_CONFIRMED', id) };
      }
    }
    return { claims: op.sourceClaimIds.map((id) => byId.get(id) as CareerClaim), rejection: null };
  }

  if (op.sourceClaimIds.length === 0) {
    return { claims: [], rejection: reject('SOURCE_CLAIMS_REQUIRED', op.op) };
  }
  const resolved: CareerClaim[] = [];
  for (const id of op.sourceClaimIds) {
    const claim = byId.get(id);
    if (!claim) return { claims: [], rejection: reject('SOURCE_CLAIM_NOT_FOUND', id) };
    if (!isRenderableClaimStatus(claim.status)) {
      return { claims: [], rejection: reject('SOURCE_CLAIM_NOT_CONFIRMED', id) };
    }
    resolved.push(claim);
  }

  // The claim that PLACED this text must be among them.
  if (isClaimBackedTarget(op.target)) {
    const placedBy = claimPlacingTarget(ctx.document, op.target);
    if (placedBy === null) {
      // The text is there and no ledger entry names it: the revision is already unrenderable
      // (rule 5 of the belt), so a rewrite of it would be grounded in nothing.
      return { claims: [], rejection: reject('TARGET_CLAIM_MISMATCH', op.target) };
    }
    if (!op.sourceClaimIds.includes(placedBy)) {
      return { claims: [], rejection: reject('TARGET_CLAIM_MISMATCH', `${op.target} is placed by ${placedBy}`) };
    }
  }
  return { claims: resolved, rejection: null };
}

/**
 * The `claimId` whose `x-clearance` entry places TEXT at `target`, or `null`.
 *
 * Read from the block rather than recomputed, so "who put this text here" has exactly one
 * answer in this codebase - the projector's - and a tailoring pass cannot hold a second
 * opinion about it.
 */
export function claimPlacingTarget(document: unknown, target: string): string | null {
  const record = document as { 'x-clearance'?: { claims?: unknown } } | null;
  const claims = record?.['x-clearance']?.claims;
  if (!Array.isArray(claims)) return null;
  for (const entry of claims) {
    if (entry === null || typeof entry !== 'object') continue;
    const candidate = entry as { claimId?: unknown; jsonPath?: unknown; usage?: unknown };
    if (candidate.jsonPath !== target) continue;
    if (candidate.usage !== 'verbatim' && candidate.usage !== 'tailored') continue;
    return typeof candidate.claimId === 'string' ? candidate.claimId : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 3: no new fact
// ---------------------------------------------------------------------------

/**
 * `entities(after) subset-of entities(before) union entities(confirmed claims)`.
 *
 * `before` is the DOCUMENT's own text at the target when the target holds a string, and
 * empty otherwise - so `add_skill` on a `skills` array compares the new NAME against the
 * whole resume's entities, which is right: a skill name is a fact and the only facts allowed
 * are the ones already on the page or in the claims the op names.
 *
 * The grounding claims' statements are read from the CONTEXT, not from the document: the
 * claims are rows, and a row's statement is the text the user confirmed.
 */
function rule3NoFactDelta(
  op: TailorOperation,
  ctx: ValidationContext,
  grounding: readonly CareerClaim[],
): OpRejection | null {
  if (!isTextChangingOp(op.op)) return null;
  const after = typeof op.after === 'string' ? op.after.trim() : '';
  if (after.length === 0) {
    // An empty `after` is not a re-wording, it is a deletion wearing a text op's clothes.
    // `exclude` is the op for removing content, and it records the claim's usage properly.
    return reject('OP_MALFORMED', `${op.op} after must be a non-empty string`);
  }

  const employers = ctx.knownEmployers ?? [];
  const before =
    typeof op.before === 'string' && op.before.trim().length > 0
      ? op.before
      : // The document is the authority on what the text IS. An operation that omits
        // `before` still gets its fact-delta checked against the real text, so a client
        // cannot dodge the guard by leaving the field out.
        readDocumentTextAt(ctx.document, op.target);
  const allowed = unionFacts(
    extractFacts(before, employers),
    factsOfTexts(
      grounding.map((claim) => claim.statement),
      employers,
    ),
    // The whole resume is part of "the before state" for a text op on a new name: the
    // document already states these employers and metrics elsewhere, so naming one again is
    // not a new fact. `reword_summary` in particular must be able to say something the
    // bullets already say.
    factsOfTexts(documentTexts(ctx.document), employers),
  );
  const delta = detectFactDelta(extractFacts(after, employers), allowed);
  return delta === null ? null : reject('FACT_DELTA', describeFactDelta(delta));
}

/** Every non-empty string anywhere in the document, at depth, for the "already on the page" set. */
function documentTexts(document: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof document === 'string') {
    if (document.trim().length > 0) out.push(document);
    return out;
  }
  if (Array.isArray(document)) {
    for (const entry of document) documentTexts(entry, out, depth + 1);
    return out;
  }
  if (document !== null && typeof document === 'object') {
    for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
      // The ledger is not text on the page: it is metadata about it. Reading it in would let
      // a claim's own `renderedText` ground a rewrite of itself.
      if (key === 'x-clearance') continue;
      documentTexts(value, out, depth + 1);
    }
  }
  return out;
}

function readDocumentTextAt(document: unknown, target: string): string {
  const value = readTarget(document, target);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string').join(' ');
  return '';
}

// ---------------------------------------------------------------------------
// Rule 4: the template still has the sections it requires
// ---------------------------------------------------------------------------

/**
 * Rule 4, and the exact condition it is enforced under.
 *
 * E.3 rule 4 says a `remove_skill`/`exclude` needs the entry to be "absent from
 * `requiredDictKeys` for the chosen template, or the op is downgraded to exclude-from-preview".
 * `requiredDictKeys` is a SECTION vocabulary (`contact`, `summary`, `experience`,
 * `education`, `skills`) - it names no individual skill - so "this skill is required" is not a
 * question the metadata can answer. What it CAN answer, and what the rule is really about, is
 * whether the removal would leave a REQUIRED SECTION EMPTY. `render/dict.ts` rule 1 makes
 * every declared key present with a typed default, so an empty section still renders; what
 * breaks is a template whose layout has nowhere to put the candidate's experience at all.
 *
 * SO: a removal is refused when it would EMPTY a section the chosen template requires. It is
 * NOT "downgraded": the downgrade E.3 offers is an `exclude` that shows up in a preview but
 * not in the document, and this module has no preview to put it in - it produces either a
 * document change or a refusal. Emitting a change row with `accepted: false` and no document
 * effect is the honest form of "declined", and `apply.ts` writes exactly that for a refused op.
 */
/**
 * DOCUMENT MEMBER -> RENDER-DICTIONARY SECTION.
 *
 * Rule 4 compares against `TemplateMetadata.requiredDictKeys`, and that vocabulary is the
 * DICTIONARY's (`render/dict.ts#RESUME_DICT_SECTIONS`): `contact`, `summary`, `experience`,
 * `projects`, `education`, `skills`, `certifications`. A resume document has no `contact` or
 * `experience` member - JSON Resume calls them `basics` and `work` - so the two vocabularies
 * have to be related rather than compared, and this table is that relation.
 *
 * IT IS A TABLE, NOT A DERIVATION, and it is small on purpose: seven entries, each one a fact
 * about the canonical projector that `render/dict.ts` already documents in its own header
 * table. A member missing here is a section whose removal is never checked, so the table is
 * asserted complete against `RESUME_DICT_SECTIONS` in `validate.test.ts`.
 */
const DICT_KEY_FOR_SECTION: Readonly<Record<string, string>> = Object.freeze({
  basics: 'contact',
  summary: 'summary',
  work: 'experience',
  projects: 'projects',
  education: 'education',
  skills: 'skills',
  certificates: 'certifications',
});

/** The dictionary key a document member's section renders under, or `null` when it has none. */
export function dictKeyForSection(section: string): string | null {
  return DICT_KEY_FOR_SECTION[section] ?? null;
}

function rule4TemplateStillHasItsSection(
  op: TailorOperation,
  ctx: ValidationContext,
): OpRejection | null {
  if (op.op !== 'exclude' && op.op !== 'remove_skill') return null;
  const section = sectionOf(op.target);
  if (section === '') return null;
  const dictKey = dictKeyForSection(section);
  if (dictKey === null || !ctx.requiredDictKeys.includes(dictKey)) return null;
  const container = readTarget(ctx.document, section);
  if (!Array.isArray(container) || container.length !== 1) return null;
  // The last entry of a section the template REQUIRES. One more refusal is available -
  // removing it would leave a required section with nothing in it at all.
  return reject('SECTION_REQUIRED_BY_TEMPLATE', `${section} has exactly one entry`);
}

// ---------------------------------------------------------------------------
// Rule 5: a reorder is a permutation
// ---------------------------------------------------------------------------

/**
 * `after` is a permutation of the section's EXISTING INDICES.
 *
 * Indices rather than ids, because a JSON Resume array member has no id: the document is the
 * whole of what identifies an entry, and an index is the only handle a client and the server
 * can agree on without inventing an identifier the schema does not have. The permutation
 * check is what makes that safe - it cannot introduce, drop or duplicate an entry, so the
 * reordering is provably a reordering.
 */
function rule5IsPermutation(op: TailorOperation, ctx: ValidationContext): OpRejection | null {
  if (op.op !== 'reorder') return null;
  if (!REORDERABLE_TARGETS.includes(op.target)) {
    return reject('TARGET_NOT_APPLICABLE', `${op.target} is not a reorderable section`);
  }
  if (!Array.isArray(op.after)) {
    return reject('OP_MALFORMED', 'reorder after must be an array of the existing indices');
  }
  const container = readTarget(ctx.document, op.target);
  const length = Array.isArray(container) ? container.length : 0;
  const seen = new Set<number>();
  for (const value of op.after) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= length) {
      return reject('REORDER_NOT_A_PERMUTATION', `${op.target} has ${length} entries`);
    }
    if (seen.has(value)) return reject('REORDER_NOT_A_PERMUTATION', `index ${value} appears twice`);
    seen.add(value);
  }
  if (seen.size !== length) {
    return reject('REORDER_NOT_A_PERMUTATION', `expected ${length} indices, got ${seen.size}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-op shape rules
// ---------------------------------------------------------------------------

/**
 * What each op's `target` and `after` have to look like, beyond "it resolves".
 *
 * Kept as one table of predicates rather than a switch so the vocabulary and the rules are
 * readable together - the reviewer's question is always "what may this op address?", and one
 * table answers it without reading the function bodies.
 */
const OP_SHAPE: Readonly<Record<string, (op: TailorOperation, ctx: ValidationContext) => OpRejection | null>> =
  Object.freeze({
    rewrite_bullet: (op, ctx) => {
      const tokens = targetTokens(op.target);
      if (tokens === null || !/^(work|projects)$/.test(tokens[0] ?? '') || tokens[2] !== 'highlights') {
        return reject('TARGET_NOT_APPLICABLE', 'rewrite_bullet targets work|projects highlights');
      }
      const current = readTarget(ctx.document, op.target);
      if (typeof current !== 'string') {
        return reject('TARGET_NOT_APPLICABLE', `${op.target} is not a string`);
      }
      return typeof op.after === 'string' ? null : reject('OP_MALFORMED', 'after must be a string');
    },
    reword_summary: (op, ctx) => {
      if (op.target !== 'basics.summary') {
        return reject('TARGET_NOT_APPLICABLE', 'reword_summary targets basics.summary');
      }
      if (typeof readTarget(ctx.document, 'basics.summary') !== 'string') {
        return reject('TARGET_NOT_APPLICABLE', 'this document has no summary to re-word');
      }
      return typeof op.after === 'string' ? null : reject('OP_MALFORMED', 'after must be a string');
    },
    retitle: (op, ctx) => {
      const tokens = targetTokens(op.target);
      if (tokens === null) return reject('TARGET_NOT_APPLICABLE', op.target);
      const isWorkTitle = tokens[0] === 'work' && tokens[2] === 'position';
      const isLabel = op.target === 'basics.label';
      if (!isWorkTitle && !isLabel) {
        return reject('TARGET_NOT_APPLICABLE', 'retitle targets work[].position or basics.label');
      }
      const current = readTarget(ctx.document, op.target);
      if (typeof current !== 'string') {
        return reject('TARGET_NOT_APPLICABLE', `${op.target} is not a string`);
      }
      return typeof op.after === 'string' ? null : reject('OP_MALFORMED', 'after must be a string');
    },
    add_skill: (op, ctx) => {
      if (op.target !== 'skills') {
        return reject('TARGET_NOT_APPLICABLE', 'add_skill targets the skills array');
      }
      const name = typeof op.after === 'string' ? op.after.trim() : '';
      if (name.length === 0) return reject('OP_MALFORMED', 'add_skill after must be a skill name');
      const existing = readTarget(ctx.document, 'skills');
      const present = Array.isArray(existing)
        ? existing.some((entry) => typeof entry?.name === 'string' && entry.name.trim().toLowerCase() === name.toLowerCase())
        : false;
      return present ? reject('TARGET_NOT_FOUND', name) : null;
    },
    remove_skill: (op, ctx) => {
      const tokens = targetTokens(op.target);
      if (tokens === null || tokens[0] !== 'skills' || tokens.length !== 2) {
        return reject('TARGET_NOT_APPLICABLE', 'remove_skill targets skills[i]');
      }
      return readTarget(ctx.document, op.target) === undefined
        ? reject('TARGET_NOT_FOUND', op.target)
        : null;
    },
    exclude: (op, ctx) => {
      const tokens = targetTokens(op.target);
      if (tokens === null || tokens.length !== 2) {
        return reject('TARGET_NOT_APPLICABLE', 'exclude targets work[i]|projects[i]|skills[i]');
      }
      return readTarget(ctx.document, op.target) === undefined
        ? reject('TARGET_NOT_FOUND', op.target)
        : null;
    },
    include: (op, ctx) => {
      if (!isClaimBackedTarget(op.target)) {
        return reject('TARGET_NOT_APPLICABLE', 'include targets a claim-backed slot');
      }
      const parent = parentTarget(op.target);
      const container = readTarget(ctx.document, parent);
      if (!Array.isArray(container)) {
        // `include` is "put a confirmed claim's text where a slot is empty". A missing
        // PARENT is a different operation - creating a section - and creating a section means
        // creating an entity, which this engine may not do (05 sec.6.1).
        return reject('TARGET_NOT_APPLICABLE', `${parent} is not an array in this document`);
      }
      // Empty in the PARENT. Empty again in the running fold - `rule9AgainstRunningDocument`.
      if (targetIsOccupied(ctx.document, op.target)) {
        return reject('TARGET_NOT_FOUND', `${op.target} is occupied`);
      }
      const grounded = op.sourceClaimIds.length === 1 ? op.sourceClaimIds[0] : null;
      if (grounded === null) {
        return reject('SOURCE_CLAIMS_REQUIRED', 'include names exactly one claim');
      }
      const claim = ctx.claims.find((row) => row.id === grounded);
      if (claim === undefined) {
        // Rule 2 would refuse this too, with this code - but the shape rule cannot ask "is
        // there text here that the claim did not say?" without resolving the claim first, so
        // it resolves it itself and fails CLOSED rather than letting an unresolvable id past
        // a check it is about to need.
        return reject('SOURCE_CLAIM_NOT_FOUND', grounded);
      }
      if (typeof op.after !== 'string' && op.after !== null && op.after !== undefined) {
        return reject('OP_MALFORMED', 'include after must be the claim statement, or absent');
      }
      // RULE 6, THE ONE THAT MAKES `include` STRUCTURAL. Read this as the question the op
      // answers: "include THIS claim here" means the text at the target is that claim's
      // statement, so `after` may echo it and may add nothing. The alternative - treating
      // `include` as a rewrite and running rule 3 over it - was rejected: rule 2's
      // `claimPlacingTarget` branch refuses an EMPTY slot outright (`TARGET_CLAIM_MISMATCH`),
      // because the rule assumes every claim-backed path is already placed by some claim, so
      // the fact-delta path cannot reach `include` at all. Equality is also the honest rule
      // rather than a permissive one: ONE mechanical comparison with ONE fixed refusal, and
      // it makes the ledger entry `apply.ts` writes TRUE BY CONSTRUCTION instead of true
      // because a guard happened to check.
      if (!includeTextIsClaimStatement(op.after, claim)) {
        return reject('CLAIM_TEXT_MISMATCH', `${op.target} must carry ${grounded}'s own statement`);
      }
      return claimIsOmitted(ctx.document, grounded)
        ? null
        : reject('CLAIM_ALREADY_RENDERED', grounded);
    },
    reorder: () => null,
    customize_style: (op, ctx) => {
      const before = op.before === null ? '' : op.before;
      const after = typeof op.after === 'string' ? op.after.trim() : '';
      if (before !== '' && typeof op.before !== 'string') {
        return reject('OP_MALFORMED', 'before must be a string when present');
      }
      if (after.length === 0) return reject('OP_MALFORMED', 'after must be a template id');
      if (ctx.knownTemplateIds !== undefined && !ctx.knownTemplateIds.includes(after)) {
        return reject('TEMPLATE_UNKNOWN', after);
      }
      return null;
    },
  });

/** Is this claim recorded `omitted` in the document's own block? */
export function claimIsOmitted(document: unknown, claimId: string): boolean {
  const record = document as { 'x-clearance'?: { claims?: unknown } } | null;
  const claims = record?.['x-clearance']?.claims;
  if (!Array.isArray(claims)) return false;
  return claims.some((entry) => {
    if (entry === null || typeof entry !== 'object') return false;
    const candidate = entry as { claimId?: unknown; usage?: unknown };
    return candidate.claimId === claimId && candidate.usage === 'omitted';
  });
}

/**
 * May this text be an `include`'s `after`? TRUE when it is the claim's own statement, or when
 * there is no text at all.
 *
 * THE NORMALISATION IS THE CAREER LAYER'S, not one invented here. `normalizeStatement` (NFKC,
 * lowercase, interior whitespace collapsed, trimmed) is what `claimFingerprint` hashes, so two
 * strings that normalise equal are the SAME CLAIM by the definition the database already
 * enforces - `@@unique([profileId, fingerprint])`. Re-spelling a statement in different case
 * or with different whitespace therefore does not make a different claim, and refusing it
 * would be refusing the user's own words. What it does not license is a different SENTENCE,
 * and that is the entire rule.
 *
 * NO TEXT IS NOT AN EXEMPTION, IT IS THE STRUCTURAL FORM. `include` means "put this claim
 * here"; when the request does not echo the text back, `apply.ts` writes the claim row's own
 * `statement.trim()`. So the two accepted forms differ only in whether the caller repeated a
 * string the engine already had - and NEITHER form can carry a word the claim did not say,
 * which is what `include` being a structural op has to mean for rule 3 not to run on it.
 */
export function includeTextIsClaimStatement(after: unknown, claim: CareerClaim): boolean {
  const text = typeof after === 'string' ? after.trim() : '';
  if (text.length === 0) return true;
  return normalizeStatement(text) === normalizeStatement(claim.statement);
}

// ---------------------------------------------------------------------------
// Rule 9: the operation, against the document the operations before it produced
// ---------------------------------------------------------------------------

/**
 * THE FOLD'S HALF OF RULE 1, and the reason it cannot live in `validateOperation`.
 *
 * `validateOperation(op, ctx)` answers "may this operation be applied?" about ONE operation
 * and ONE document, and the document a route assembles is the PARENT - read once, before
 * anything is folded. So for a batch, "the slot is empty" is answered against the parent for
 * every operation in it, and two `include`s naming two different `omitted` claims at the SAME
 * slot both pass: each one's `TARGET_NOT_FOUND` read finds the slot still empty, and each
 * names a claim that is currently `omitted`. The fold then runs twice at one path and the
 * ledger records two claims as rendering text at one `jsonPath` - a collision invisible to
 * `assertOneUsagePerClaimId` (which keys on `claimId`) and to the write-time belt (which asks
 * whether SOME entry names the path), with the document left holding whichever text folded
 * last while the earlier entry records a `renderedText` that is no longer there.
 *
 * So the check is here, and it is asked of the ACCUMULATING document rather than the parent:
 * one slot, one text, one claim - structurally, not by test. `apply.ts` calls it once per
 * operation with the document as it stands at that point in the fold, and records a refusal
 * as `accepted: false` exactly as it does for a validation refusal, so the caller learns about
 * it from the same place and in the same shape.
 *
 * IT IS `include` ONLY, and that is not a special case but the op's definition: `include` is
 * the one operation that addresses an EMPTY slot. Two `rewrite_bullet`s at one path are a
 * history the diff view is built to show, and their ledger entries are the same single entry
 * moving twice - no collision exists to prevent.
 *
 * THE SECOND REFUSAL IS FAIL-CLOSED. An `include` whose validated form carries no resolved
 * grounding claim has no text this engine is allowed to write: the text comes from the claim
 * row (`apply.ts`), not from the operation. `validateOperation` cannot produce such an
 * operation - it resolves exactly one confirmed claim or refuses - so this is unreachable
 * through the route, and it exists so that a future relaxation of that rule writes NOTHING
 * and says so, instead of falling back to the operation's own `after` bytes.
 */
export function rule9AgainstRunningDocument(
  validated: ValidatedOperation,
  document: unknown,
): OpRejection | null {
  const op = validated.operation;
  if (op.op !== 'include') return null;
  if (targetIsOccupied(document, op.target)) {
    return reject('TARGET_ALREADY_FILLED', `${op.target} was filled by an earlier operation`);
  }
  if (validated.groundingClaims[0] === undefined) {
    return reject('SOURCE_CLAIM_NOT_FOUND', op.sourceClaimIds[0] ?? null);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Validate ONE operation against a context. Never throws: a malformed input is a refusal.
 *
 * THE ORDER IS DELIBERATE and follows the spec's numbering, because the order decides which
 * reason a caller sees for an operation that is wrong in two ways at once:
 *   1. shape/normalisation  - a target that is not a path is refused before anything is read
 *   2. rule 1, resolves      - so a typo in the target is never reported as "unconfirmed claim"
 *   3. op shape             - so a `rewrite_bullet` aimed at `basics.label` is refused as
 *                             inapplicable rather than as a claim problem
 *   4. rule 2, grounding     - the expensive database-backed half, once the target is known good
 *   5. rule 4, template      - a section rule before a text rule, because it is about the
 *                             DOCUMENT's shape rather than the wording
 *   6. rule 3, fact delta    - LAST, because it is the most expensive and the most specific
 *   7. rule 5, permutation   - a pure structural check
 *   8. `before` agreement    - last of all: it is the only check that can fail for an
 *                             operation that is otherwise perfect
 */
export function validateOperation(input: unknown, ctx: ValidationContext): ValidationResult {
  if (ctx === null || typeof ctx !== 'object' || ctx.document === undefined) {
    return { ok: false, rejection: reject('OP_MALFORMED', 'a validation context is required') };
  }
  const parsed = parseOperation(input);
  if ('code' in parsed) return { ok: false, rejection: parsed };
  const op = parsed;

  const resolved = rule1TargetResolves(op, ctx);
  if (resolved !== null) return { ok: false, rejection: resolved };

  const shape = OP_SHAPE[op.op];
  if (shape === undefined) return { ok: false, rejection: reject('OP_UNKNOWN', op.op) };
  const shapeRejection = shape(op, ctx);
  if (shapeRejection !== null) return { ok: false, rejection: shapeRejection };

  const grounded = rule2ClaimsGround(op, ctx);
  if (grounded.rejection !== null) return { ok: false, rejection: grounded.rejection };

  const templateRejection = rule4TemplateStillHasItsSection(op, ctx);
  if (templateRejection !== null) return { ok: false, rejection: templateRejection };

  const factRejection = rule3NoFactDelta(op, ctx, grounded.claims);
  if (factRejection !== null) return { ok: false, rejection: factRejection };

  const permutationRejection = rule5IsPermutation(op, ctx);
  if (permutationRejection !== null) return { ok: false, rejection: permutationRejection };

  // `before`, when supplied, must be what the document holds. An operation whose `before` is
  // fiction would make the diff view show a change that never happened, which is the one
  // thing the diff UX exists to prevent. `customize_style` is exempt: its `before` is the
  // RENDER's current template, which is not a document member and is recorded rather than
  // compared.
  const beforeRejection = rule8BeforeAgrees(op, ctx);
  if (beforeRejection !== null) return { ok: false, rejection: beforeRejection };

  return {
    ok: true,
    validated: {
      operation: op,
      groundingClaims: Object.freeze(grounded.claims),
      factChecked: isTextChangingOp(op.op),
    },
  };
}

/**
 * Rule 8, which E.3 does not number because E.3 does not mention it: a supplied `before` must
 * equal what the document holds.
 *
 * It is a separate rule rather than part of rule 1 because it is the only check that can fail
 * for an operation that is otherwise perfect, and it is the one that makes the diff view
 * honest. `before` is OPTIONAL - a model that returns only `after` is fine, and rule 3 then
 * reads the document for the real text - but a model that returns a `before` which is not
 * what is on the page has described a change that did not happen.
 */
function rule8BeforeAgrees(op: TailorOperation, ctx: ValidationContext): OpRejection | null {
  if (op.op === 'customize_style') return null;
  if (op.before === null || op.before === undefined) return null;
  if (typeof op.before === 'string') {
    const current = readTarget(ctx.document, op.target);
    const currentText = typeof current === 'string' ? current : readDocumentTextAt(ctx.document, op.target);
    return op.before.trim() === currentText.trim() ? null : reject('BEFORE_MISMATCH', op.target);
  }
  if (typeof op.before === 'object') {
    const current = readTarget(ctx.document, op.target);
    const same = JSON.stringify(current ?? null) === JSON.stringify(op.before);
    return same ? null : reject('BEFORE_MISMATCH', op.target);
  }
  return reject('OP_MALFORMED', 'before must be a string, an array, an object or absent');
}

/**
 * The same entry point, typed for the caller that wants the validated form rather than a
 * discriminated union.
 *
 * Two functions rather than an overload because the caller has to branch on the outcome
 * anyway, and a single function returning the union would force every caller to re-narrow it.
 * `ops.test.ts` asserts that a refusal NEVER has a validated form - so the two branches
 * cannot be confused for one another downstream.
 */
export function validate(input: unknown, ctx: ValidationContext): ValidatedOperation | OpRejection {
  const result = validateOperation(input, ctx);
  return result.ok ? result.validated : result.rejection;
}