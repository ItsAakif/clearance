// =====================================================================================
// tailor/ops.ts - THE OPERATION VOCABULARY, and nothing else (T1080; 06-design sec.E.3).
//
// WHAT THIS MODULE IS. The nine operations a tailoring pass may propose, the target
// grammar they address the document with, and the machine-readable refusal vocabulary.
// It decides NOTHING about whether an operation is allowed - that is `validate.ts` - and it
// changes NOTHING about a document - that is `apply.ts`. It is the shared spelling that
// keeps those two from drifting, and the single place a new op has to be registered.
//
// WHY OPERATIONS AND NOT A DOCUMENT. 06 sec.E.3's own sentence: "The tailoring request
// never returns a whole rewritten document; it returns ops only." The reason is not taste.
// A document is an un-reviewable diff: the user cannot see which sentence moved, why, or
// which claim it came from, and "accept the rewrite" is not a decision anybody can make.
// An operation is a reviewable one: `(op, target, before, after, reason, sourceClaimIds)`.
// The whole design of this module follows from keeping that unit small enough for a human
// to accept or decline, and from the fact that an operation is the ONLY thing a tailoring
// pass is allowed to produce.
//
// WHAT IS NOT HERE, AND WHY IT IS NOT HERE:
//   - NO SCORE. E.6 forbids the single number, and a "how well does this match" figure on
//     an operation is that number wearing a hat. `targetRequirementIds` says WHICH
//     requirement an op answers; nothing combines them.
//   - NO FABRICATION PATH. There is no operation that CREATES a claim, and none that
//     asserts a fact. 05 sec.6.1: "The tailoring engine outputs text plus sourceClaimIds; it
//     never creates claims." The only way new text reaches the document is `apply.ts`
//     writing a `tailored` usage over an existing CONFIRMED claim.
//   - NO LLM. The AI-OPTIONAL proposal stage (ADR-041 D5) lives in the route; this module
//     is the shape the model's answer has to parse into and the shape a client posts back.
//
// THE TARGET GRAMMAR IS DELIBERATELY NARROW, because a target that can name any JSON path
// is a target that can name `x-clearance.claims[0].status`. Every target an operation may
// use is checked against `TARGET_SHAPES` below, and the claim ledger is not one of them.
// `render.templateId` is the single member outside the document, and it exists because a
// style choice is a RENDER-TIME fact (ADR-044 D3) that must be recorded without ever
// entering the snapshot.
// =====================================================================================

import { ResumeChangeOp } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every operation the tailoring pass may propose. Sourced from the enum, never re-spelled. */
export const TAILOR_OPS: readonly ResumeChangeOp[] = Object.freeze([
  ResumeChangeOp.rewrite_bullet,
  ResumeChangeOp.reword_summary,
  ResumeChangeOp.reorder,
  ResumeChangeOp.include,
  ResumeChangeOp.exclude,
  ResumeChangeOp.add_skill,
  ResumeChangeOp.remove_skill,
  ResumeChangeOp.retitle,
  ResumeChangeOp.customize_style,
]);

/**
 * THE TEXT-CHANGING OPERATIONS, and the reason the split exists.
 *
 * 06 sec.E.3 rule 2: "`sourceClaimIds` is non-empty for any text-changing op; every id
 * resolves to a claim with the CONFIRMING status". Which ops those are is a judgement
 * the spec states as a category rather than a list, so the list is here, and it is drawn
 * on the only line that matters: **does the operation put NEW PROSE into the document?**
 *
 *   - `rewrite_bullet` / `reword_summary` - a new sentence for a claim-backed path. The
 *     canonical case, and the one the fact-delta guard exists for.
 *   - `retitle` - `work[i].position` and `basics.label` are strings a renderer prints
 *     exactly like a bullet. A retitle that says "Principal Engineer" when the confirmed
 *     claim says "Staff Engineer" is the same fabrication with a shorter string, so it is
 *     in this set and not treated as "just a title".
 *   - `add_skill` - appends a NAME the document did not carry. A skill name is an assertion
 *     about what the candidate can do, so it is a fact, not formatting.
 *
 * `exclude`, `remove_skill` and `reorder` are STRUCTURAL in the plain sense: they move or
 * remove text that is already in the document or already in the ledger, so none of them can
 * put a word on the page that was not already there. `customize_style` touches no document
 * member at all.
 *
 * `include` IS STRUCTURAL, AND THE REASON IS NOT "IT MOVES TEXT" - `include` WRITES text, and
 * getting that distinction right is the whole point of this set. What makes an `include` safe
 * is that the text it writes is the NAMED CLAIM'S OWN STATEMENT and cannot be anything else,
 * and that is ENFORCED rather than assumed:
 *   - `validate.ts` refuses an `include` whose `after` carries text that is not the statement
 *     of the claim it names (`CLAIM_TEXT_MISMATCH`, compared with the normalisation
 *     `career/claims.ts#normalizeStatement` gives a claim its identity), and accepts it with
 *     NO `after` at all - the purely structural form, in which `apply.ts` sources the text
 *     from the claim row;
 *   - `apply.ts` writes `claim.statement.trim()` from the resolved grounding claim rather than
 *     the operation's own `after` bytes.
 * An `include` is therefore `rewrite_bullet` with the fact-delta guard correctly switched OFF,
 * and it is safe for exactly the reason a rewrite is safe: the words are the user's own
 * confirmed words, quoted, not composed here.
 *
 * THIS PARAGRAPH USED TO SAY THE STRUCTURAL OPS "cannot put a word on the page that was not
 * already there" WITHOUT THAT QUALIFIER. For `exclude`/`remove_skill`/`reorder` it was true.
 * For `include` - the ONE structural op whose `after` is free text - it was FALSE, and the
 * reasoning error was in this comment rather than only in a review: any confirmed,
 * currently-`omitted` claim could be named by an `include` carrying arbitrary prose, and that
 * prose rendered as that claim's verified text. The rule now lives in the module that enforces
 * it, and the module that enforces it is named here so a reader of this list can find it.
 */
export const TEXT_CHANGING_OPS: readonly ResumeChangeOp[] = Object.freeze([
  ResumeChangeOp.rewrite_bullet,
  ResumeChangeOp.reword_summary,
  ResumeChangeOp.retitle,
  ResumeChangeOp.add_skill,
]);

/** The operations that MOVE or REMOVE existing content without writing any new prose. */
export const STRUCTURAL_OPS: readonly ResumeChangeOp[] = Object.freeze(
  TAILOR_OPS.filter((op) => !TEXT_CHANGING_OPS.includes(op)),
);

/** Is this a text-changing op? The one predicate `validate.ts` asks about. */
export function isTextChangingOp(op: ResumeChangeOp): boolean {
  return TEXT_CHANGING_OPS.includes(op);
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * The paths a claim-backed string may occupy, as patterns. `*` is an index.
 *
 * The first two are the highlight templates and the third is `basics.summary` - the SAME
 * three members `resume/json/claimSurface.ts` declares, restated here as a PATTERN rather
 * than as a second list of templates, because `apply.ts` needs to know whether a target is
 * a claim-backed path (and therefore has an `x-clearance` entry to keep in step) while
 * `claimSurface.ts` needs to know how to WALK the document. `target.test.ts` asserts the
 * two agree, in both directions, on a projected fixture - so they cannot drift.
 */
export const CLAIM_BACKED_TARGET_PATTERNS: readonly string[] = Object.freeze([
  'work.*.highlights.*',
  'projects.*.highlights.*',
  'basics.summary',
]);

/** Every array an operation may reorder, exclude from, or append to. */
export const REORDERABLE_TARGETS: readonly string[] = Object.freeze([
  'work',
  'projects',
  'skills',
  'education',
  'certificates',
]);

/** The one target outside the resume document. A render-time fact, recorded, never embedded. */
export const STYLE_TARGET = 'render.templateId';

/** `work[0].highlights[2]` -> `['work', '0', 'highlights', '2']`; `null` when it is not a path. */
export function targetTokens(target: string): string[] | null {
  if (typeof target !== 'string' || target.length === 0) return null;
  if (target === STYLE_TARGET) return ['render', 'templateId'];
  if (!/^[A-Za-z][A-Za-z]*(\[\d+\]|\.[A-Za-z][A-Za-z]*)*$/.test(target)) return null;
  return target.match(/[A-Za-z][A-Za-z]*|\d+/g) ?? null;
}

/** Does this path name a claim-backed string (the surface the belt and the ledger govern)? */
export function isClaimBackedTarget(target: string): boolean {
  const tokens = targetTokens(target);
  if (tokens === null) return false;
  // One token per step, every index collapsed to `*`, then an exact shape match. Exact
  // because this is the function that decides whether an operation may rewrite a
  // claim-backed string, and a prefix or substring rule here would eventually accept
  // `work[0].highlightsX` or `work[0].highlights[0].name`.
  return CLAIM_BACKED_TARGET_PATTERNS.includes(
    tokens.map((token) => (/^\d+$/.test(token) ? '*' : token)).join('.'),
  );
}

/**
 * Is this path inside the `x-clearance` ledger? NOTHING may address it.
 *
 * Not "it is refused today": there is no code path in `validate.ts` that reaches it, because
 * an operation's target is matched against the shapes above and against the section names.
 * A target naming `x-clearance` fails `TARGET_UNRESOLVED` because no such node is in the
 * allowed shape set - and `ops.test.ts` asserts it, so adding a permissive branch later
 * cannot quietly open the ledger.
 */
export function addressesLedger(target: string): boolean {
  return typeof target === 'string' && /(^|\.)x-clearance(\.|\[|$)/.test(target);
}

/** `['work','0','highlights','2']` -> `work[0].highlights[2]`. The inverse of `targetTokens`. */
export function renderTokens(tokens: readonly string[]): string {
  let path = '';
  for (const token of tokens) {
    if (/^\d+$/.test(token)) path = `${path}[${token}]`;
    else path = path === '' ? token : `${path}.${token}`;
  }
  return path;
}

// ---------------------------------------------------------------------------
// Reading and writing a document by path
// ---------------------------------------------------------------------------

type Container = Record<string, unknown> | unknown[];

function containerOf(value: unknown): Container | null {
  if (value === null || typeof value !== 'object') return null;
  return Array.isArray(value) ? (value as unknown[]) : (value as Record<string, unknown>);
}

/** The value at `tokens`, or `undefined` when any step is absent. Never throws. */
export function readTargetPath(document: unknown, tokens: readonly string[]): unknown {
  let cursor: unknown = document;
  for (const token of tokens) {
    const container = containerOf(cursor);
    if (container === null) return undefined;
    cursor = Array.isArray(container)
      ? container[Number(token)]
      : (container as Record<string, unknown>)[token];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/** The value at a target string, or `undefined`. The reader every validator starts with. */
export function readTarget(document: unknown, target: string): unknown {
  const tokens = targetTokens(target);
  return tokens === null ? undefined : readTargetPath(document, tokens);
}

/**
 * Does `document` already hold something at `target`?
 *
 * ONE predicate for TWO documents, which is the point of naming it. `include` asks it of the
 * PARENT (rule 1 / the op's shape rule: "a slot that is currently empty"), and the fold asks
 * it again of the document the earlier operations have produced - because a slot empty in the
 * parent is not still empty once a previous `include` in the same batch has filled it. Two
 * hand-written reads of "is it occupied" is how those two would come to disagree, and one of
 * them being permissive is how two claims end up recorded as rendering text at one `jsonPath`.
 */
export function targetIsOccupied(document: unknown, target: string): boolean {
  return readTarget(document, target) !== undefined;
}

/**
 * `document` with `tokens` set to `value`, as a NEW document.
 *
 * IMMUTABLE on the spine only: every container along the path is copied, so the caller's
 * document is never mutated. That is what lets `apply.ts` fold a list of accepted
 * operations one at a time without the previous fold's intermediate states leaking into the
 * next, and it is why this is a function and not a setter.
 *
 * Setting an array index that does not exist yet EXTENDS the array, because `include` is
 * exactly "put a confirmed claim's text at a claim-backed slot that is currently empty".
 * Any other shape mismatch (`work` where a string is expected, a non-numeric key on an
 * array) returns the document UNCHANGED - a silent no-op is better here than a throw,
 * because `validate.ts` has already proved the path resolves.
 */
export function writeTargetPath(document: unknown, tokens: readonly string[], value: unknown): unknown {
  if (tokens.length === 0) return value;
  const [head, ...rest] = tokens as [string, ...string[]];
  const container = containerOf(document);
  if (container === null) return document;

  if (Array.isArray(container)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0) return document;
    const next = [...container];
    // Extending is the `include` case; past the end of a sparse tail would create holes,
    // which JSON Resume validation would (rightly) refuse.
    while (next.length < index) next.push(null);
    next[index] = rest.length === 0 ? value : writeTargetPath(next[index], rest, value);
    return next;
  }

  const record = container as Record<string, unknown>;
  return {
    ...record,
    [head]: rest.length === 0 ? value : writeTargetPath(record[head], rest, value),
  };
}

/** `document` with the ARRAY INDEX at `tokens` removed, as a NEW document. */
export function removeTargetPath(document: unknown, tokens: readonly string[]): unknown {
  if (tokens.length === 0) return undefined;
  const [head, ...rest] = tokens as [string, ...string[]];
  const container = containerOf(document);
  if (container === null) return document;

  if (Array.isArray(container)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= container.length) return document;
    if (rest.length > 0) {
      const next = [...container];
      next[index] = removeTargetPath(next[index], rest);
      return next;
    }
    // The whole entry goes, and so does the gap it leaves: a `null` hole would fail
    // validation, and an `exclude` that shifted every later path without re-recording
    // them would silently break the ledger's paths.
    return [...container.slice(0, index), ...container.slice(index + 1)];
  }

  const record = container as Record<string, unknown>;
  if (rest.length > 0) {
    return { ...record, [head]: removeTargetPath(record[head], rest) };
  }
  const next = { ...record };
  delete next[head];
  return next;
}

// ---------------------------------------------------------------------------
// One operation, as it arrives and as it is normalised
// ---------------------------------------------------------------------------

/** The wire shape: what a model returns and what a client posts back. Unvalidated. */
export interface TailorOperationInput {
  op: string;
  target: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  targetRequirementIds?: readonly string[];
  sourceClaimIds?: readonly string[];
}

/**
 * An operation after normalisation: the op is one of the nine, the fields have types, and
 * nothing has been decided about whether it may be applied.
 *
 * NORMALISATION IS NOT VALIDATION. `parseOperation` answers "is this shaped like an
 * operation"; `validate.ts` answers "may this operation be applied". Keeping them apart is
 * what lets the proposal stage report a rejection for an operation it could not even parse -
 * a client is told `OP_UNKNOWN` for a typo instead of receiving a 400 with no operations in
 * it.
 */
export interface TailorOperation {
  readonly op: ResumeChangeOp;
  readonly target: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly targetRequirementIds: readonly string[];
  readonly sourceClaimIds: readonly string[];
}

// ---------------------------------------------------------------------------
// The refusal vocabulary
// ---------------------------------------------------------------------------

/**
 * Every way an operation can be refused. A CLOSED set, and every member has fixed text.
 *
 * A closed set is the point: E.3 requires "a machine-readable reason", and a reason
 * vocabulary that grows at the call site is a vocabulary no client can switch on. The text
 * interpolates NOTHING from the caller - the offending value is reported in `detail`, which
 * is a separate field and is the only place a caller-supplied string is echoed.
 */
export const OP_REJECTION_CODES = Object.freeze([
  /** The `op` is not one of the nine. */
  'OP_UNKNOWN',
  /** The operation is not shaped like an operation (missing/ill-typed member). */
  'OP_MALFORMED',
  /** `target` is missing, is not a path, or names the claim ledger. */
  'TARGET_MALFORMED',
  /** The target does not resolve to a node in the current revision. */
  'TARGET_UNRESOLVED',
  /** The target's shape is not one this op may address. */
  'TARGET_NOT_APPLICABLE',
  /** A text-changing op with an empty `sourceClaimIds`. */
  'SOURCE_CLAIMS_REQUIRED',
  /** A named claim resolves to no `CareerClaim` row in this profile. */
  'SOURCE_CLAIM_NOT_FOUND',
  /** A named claim exists but is not confirmed. ADR-036 item 5: a rejected claim has no valid use. */
  'SOURCE_CLAIM_NOT_CONFIRMED',
  /** A text op whose target is backed by a claim the op did not name. */
  'TARGET_CLAIM_MISMATCH',
  /** `include`'s `after` is text the claim it names did not say. The `include` fabrication path. */
  'CLAIM_TEXT_MISMATCH',
  /** `after` introduces an employer/date/metric/technology that is in neither the before-state nor a confirmed claim. */
  'FACT_DELTA',
  /** `remove_skill`/`exclude` would empty a section the chosen template requires. */
  'SECTION_REQUIRED_BY_TEMPLATE',
  /** `reorder`'s `after` is not a permutation of the existing indices. */
  'REORDER_NOT_A_PERMUTATION',
  /** `add_skill`'s name is already in the skills list, or `remove_skill`/`exclude` names nothing there. */
  'TARGET_NOT_FOUND',
  /** `include` named a claim that is already rendered. */
  'CLAIM_ALREADY_RENDERED',
  /** An earlier operation in this batch already filled the slot this one addresses. */
  'TARGET_ALREADY_FILLED',
  /** `customize_style` named a template the registry cannot resolve. */
  'TEMPLATE_UNKNOWN',
  /** The proposed `before` does not equal what the document actually holds. */
  'BEFORE_MISMATCH',
] as const);

export type OpRejectionCode = (typeof OP_REJECTION_CODES)[number];

const REJECTION_TEXT: Readonly<Record<OpRejectionCode, string>> = Object.freeze({
  OP_UNKNOWN: 'the operation is not one this tailoring pass may propose',
  OP_MALFORMED: 'the operation is missing a member or carries one of the wrong type',
  TARGET_MALFORMED: 'the target is not a path this tailoring pass may address',
  TARGET_UNRESOLVED: 'the target does not resolve to a node in the current revision',
  TARGET_NOT_APPLICABLE: 'this operation may not address that kind of target',
  SOURCE_CLAIMS_REQUIRED:
    'a text-changing operation must name the confirmed claim its new wording comes from',
  SOURCE_CLAIM_NOT_FOUND: 'a named source claim does not exist in this career profile',
  SOURCE_CLAIM_NOT_CONFIRMED: 'a named source claim is not confirmed, so it cannot ground new wording',
  TARGET_CLAIM_MISMATCH:
    'the claim that placed this text is not among the operation source claims, so the operation would re-ground it',
  CLAIM_TEXT_MISMATCH:
    'an include may only carry the statement of the claim it names, never wording of its own',
  FACT_DELTA:
    'the proposed wording introduces an employer, date, metric or technology that is in neither the current wording nor a confirmed claim',
  SECTION_REQUIRED_BY_TEMPLATE: 'the chosen template requires that section, so removing its only entry is refused',
  REORDER_NOT_A_PERMUTATION: 'a reorder may only permute the entries that already exist',
  TARGET_NOT_FOUND: 'the operation names an entry the document does not have',
  CLAIM_ALREADY_RENDERED: 'the named claim is already rendered in this document',
  TARGET_ALREADY_FILLED:
    'an earlier operation in this batch already filled that slot, so this one would collide with it',
  TEMPLATE_UNKNOWN: 'the named template is not one the registry can resolve',
  BEFORE_MISMATCH: 'the proposed before value is not what the document holds',
});

/** Why an operation was refused. `detail` is the only member that echoes caller data. */
export interface OpRejection {
  readonly code: OpRejectionCode;
  readonly reason: string;
  readonly detail: string | null;
}

/** Build a refusal. The only constructor, so no caller can invent a code. */
export function reject(code: OpRejectionCode, detail: string | null = null): OpRejection {
  return { code, reason: REJECTION_TEXT[code], detail };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function isOp(value: unknown): value is ResumeChangeOp {
  return typeof value === 'string' && (TAILOR_OPS as readonly string[]).includes(value);
}

function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) return null;
    out.push(entry.trim());
  }
  return out;
}

/**
 * Normalise one wire operation, or say precisely why it could not be normalised.
 *
 * `before` is OPTIONAL on the wire and is not trusted when present: `validate.ts` compares
 * it with the document and refuses a mismatch (`BEFORE_MISMATCH`), because an operation
 * whose `before` is fiction would make the diff view show a change that never happened.
 */
export function parseOperation(input: unknown): TailorOperation | OpRejection {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return reject('OP_MALFORMED', 'an operation must be an object');
  }
  const candidate = input as TailorOperationInput;
  if (!isOp(candidate.op)) {
    return reject('OP_UNKNOWN', typeof candidate.op === 'string' ? candidate.op : typeof candidate.op);
  }
  if (typeof candidate.target !== 'string' || candidate.target.trim().length === 0) {
    return reject('TARGET_MALFORMED', 'target must be a non-empty string');
  }
  const target = candidate.target.trim();
  if (addressesLedger(target)) {
    return reject('TARGET_MALFORMED', 'no operation may address the claim ledger');
  }
  const requirements = stringList(candidate.targetRequirementIds);
  if (requirements === null) {
    return reject('OP_MALFORMED', 'targetRequirementIds must be an array of non-empty strings');
  }
  const sources = stringList(candidate.sourceClaimIds);
  if (sources === null) {
    return reject('OP_MALFORMED', 'sourceClaimIds must be an array of non-empty strings');
  }
  if (candidate.reason !== undefined && candidate.reason !== null && typeof candidate.reason !== 'string') {
    return reject('OP_MALFORMED', 'reason must be a string when present');
  }
  return {
    op: candidate.op,
    target,
    before: candidate.before ?? null,
    after: candidate.after ?? null,
    reason: typeof candidate.reason === 'string' && candidate.reason.trim().length > 0 ? candidate.reason.trim() : null,
    targetRequirementIds: Object.freeze(requirements),
    sourceClaimIds: Object.freeze([...new Set(sources)].sort()),
  };
}

/** Every normalised operation in a batch, paired with the refusal for the ones that failed. */
export interface ParsedOperation {
  readonly index: number;
  readonly operation: TailorOperation | null;
  readonly rejection: OpRejection | null;
}

/** Parse a whole batch, preserving order. A malformed entry never stops the batch. */
export function parseOperations(inputs: readonly unknown[]): ParsedOperation[] {
  return inputs.map((input, index) => {
    const parsed = parseOperation(input);
    return 'code' in parsed
      ? { index, operation: null, rejection: parsed }
      : { index, operation: parsed, rejection: null };
  });
}

// ---------------------------------------------------------------------------
// The proposal prompt
// ---------------------------------------------------------------------------

/**
 * The prompt that proposes operations. Read from the version-controlled `.jinja` file, so
 * the model's instructions are auditable and editable without touching code - the same
 * discipline as `ats/promptLoader.ts`, and for the same reason.
 *
 * WHY THE RESOLUTION CHAIN, WHICH IS THREE DEEP AND NOT DECORATION. `tsc` does not copy a
 * `.jinja` file into `outDir`, so in the shipped image `dist/ats/prompts/` does not exist
 * while `src/ats/prompts/` does (verified against the running container). A single
 * `join(__dirname, 'prompts', name)` therefore works in a dev tree and throws ENOENT in the
 * image - which is exactly the latent failure the shipped prompt path already has, and it is
 * escalated rather than silently duplicated here. The chain tries the built location, then
 * the source tree relative to the compiled module, then the working directory, and the LAST
 * successful read wins; a missing file is reported by NAME so an operator can see which
 * asset is missing rather than getting a bare ENOENT.
 */
const PROMPT_DIR_CANDIDATES: readonly string[] = Object.freeze([
  join(__dirname, '..', 'ats', 'prompts'),
  join(__dirname, 'prompts'),
  join(__dirname, '..', '..', 'src', 'ats', 'prompts'),
  join(process.cwd(), 'src', 'ats', 'prompts'),
]);

/** The shipped prompt file's name. Named so a test and an operator can both find it. */
export const TAILOR_OPS_PROMPT = 'tailor_ops_v1.jinja';

/** The prompt's bytes, from the first candidate directory that has it. */
export function readTailorPromptSource(): string {
  const tried: string[] = [];
  for (const dir of PROMPT_DIR_CANDIDATES) {
    tried.push(dir);
    try {
      return readFileSync(join(dir, TAILOR_OPS_PROMPT), 'utf-8');
    } catch {
      // Try the next shape. A miss is the normal case in the shipped image, not an error.
    }
  }
  throw new Error(
    `tailor prompt ${TAILOR_OPS_PROMPT} was not found; looked in ${tried.join(', ')}`,
  );
}

/**
 * Render the proposal prompt.
 *
 * The system text is STATIC and mentions no job-description content; the JD, the
 * requirements and the candidate's confirmed statements go in as `{{ variables }}` that are
 * interpolated into a DATA section (06 sec.E.9.5 mitigation 1). A job description that says
 * "ignore previous instructions" is therefore data, not an instruction, by construction.
 */
export function renderTailorPrompt(vars: Readonly<Record<string, string>>): string {
  return readTailorPromptSource().replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}