// =====================================================================================
// interview/risks.ts - INTERVIEW RISKS ARE DERIVED, NEVER GENERATED (T1090; 06-design
// sec. E.4, sec. E.8 stage 11).
//
// THE ONE SENTENCE THIS MODULE EXISTS TO MAKE TRUE. 06 sec. E.4's first line: "Risks are
// derived from the generated resume vs the confirmed evidence, so questions are grounded,
// not generic." So a risk here is not a sentence a model wrote and a validator approved -
// it is a FACT ABOUT ROWS, carrying the ids of the rows it was read from. `deriveInterviewRisks`
// is a pure function of `(document, usages, claims, changes, requirements, now)`. There is no
// provider call, no clock read, no store and no randomness in this file, and `risks.test.ts`
// greps it to prove that: no `runLlmCompletion`, no `leaseNextLlmKey`, no `fetch`, no
// `Date.now`. If that grep ever fails, this module has stopped deriving and has started
// guessing, which is the whole failure mode E.4 exists to prevent.
//
// WHY THE ANCHOR IS NOT OPTIONAL. Every risk carries `anchors: RiskAnchor[]` - the
// `source:id` pairs of the exact rows it was read from - and `anchoredRisk` REFUSES to
// build one without at least one. `assertRisksAreAnchored` re-checks the whole set, so a
// kind added later without a data source fails a NAMED test rather than shipping a risk a
// user cannot audit and a reviewer cannot reproduce. This is the "risks are derived from
// data, not free generation" acceptance item expressed as code: a risk with no anchor is a
// sentence, and a sentence is not a risk.
//
// THE SEVEN KINDS AND WHERE EACH ONE IS READ FROM. E.4's table, with the data source named
// so a reader never has to guess where a risk came from:
//
//   kind              read from                                              severity
//   ----------------  -----------------------------------------------------  ---------
//   new_claim         a RENDERED usage whose claim was confirmed < 30 days    medium
//                     ago, or is user_entered with no EvidenceSource          high
//   emphasized_tech   a technology/skill claim on the FIRST SCREEN that is    low
//                     `direct` for >= 2 must-have requirements                medium
//   inferred_claim    LEAKAGE: a text-changing ResumeChange whose `after`     high
//                     introduces an entity, or a `tailored` usage on a        high
//                     non-confirmed claim, or a `tailored` renderedText       high
//                     whose entity is on neither the claim nor the page
//   rewritten_bullet  an accepted rewrite that keeps every entity but shares  low/medium
//                     little of its wording with what it replaced            medium
//   overclaim         an accepted text change whose `after` carries a metric  high
//                     larger than every metric in `before`
//   gap               a `must`/`should` requirement the match report names    medium/high
//                     UNSUPPORTED (a named gap, never a deduction)            by importance
//   thin_evidence     a rendered confirmed claim with no EvidenceSource and   low
//                     no corroborating claim
//
// WHY THE ENTITY VOCABULARY IS `tailor/factDelta.ts` AND NOT A SECOND EXTRACTOR. E.3 rule 3
// and E.4 both talk about "entities" - numbers, dates, employers, technologies - and this
// module needs exactly the same reading of that word, or a bullet could pass the tailoring
// guard and trip the interview guard (or worse, the reverse). `extractFacts` /
// `detectFactDelta` are imported, so "mentions Kubernetes" means the same thing to both
// stages and `claimJoinKeys` under them is the matcher's own vocabulary. A second extractor
// would make the two disagree at exactly the moment that matters.
//
// WHY `inferred_claim` IS DETECTED IN THREE PLACES RATHER THAN ONE. The spec's own wording
// is "a `ResumeClaimUsage.usage = tailored` row whose `before` had no such fact (should be
// impossible; a detection of leakage)". Three DIFFERENT rows can carry that fact and all
// three are checked, because a check that covers one of them has two holes:
//   1. the CHANGE ledger - `apply.ts` is the only writer of new document text, so an
//      `after` holding an entity that is in neither `before` nor a named source claim nor
//      elsewhere on the page is a fact delta that got through. This is the acceptance
//      fixture.
//   2. the USAGE - a `tailored` rendering of a claim whose status is NOT the confirming one.
//      The pre-render gate would block the revision at render time; a risk is worth raising
//      before it is rendered, and `high` is the honest severity.
//   3. the RENDERED TEXT - a `tailored` usage whose `renderedText` asserts an entity that is
//      in neither the claim's own statement nor anywhere else on the page. This is E.4's
//      sentence literally: the before-state (the claim) had no such fact.
//
// WHAT THIS MODULE DOES NOT DECIDE. It does not write. There is no store seam, no `create`,
// no `update`: `routes/interview-prep.ts` persists what this returns and `questions.ts` turns
// the risks into questions. It also scores nothing (E.6) and names no status literal of its
// own - "is this claim confirmed" is asked of `career/claimUsage.ts#isRenderableClaimStatus`,
// the career layer's predicate.
// =====================================================================================

import {
  ClaimKind,
  ClaimProvenance,
  type ClaimStatus,
  type EvidenceLevel,
  type InterviewRiskKind,
  type ResumeUsage,
  type ResumeChangeOp,
  type Severity,
} from '@prisma/client';

import { GATED_USAGES, isRenderableClaimStatus } from '../career/claimUsage.js';
import { isTextChangingOp } from '../tailor/ops.js';
import {
  detectFactDelta,
  extractFacts,
  factsOfTexts,
  type FactSet,
} from '../tailor/factDelta.js';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The seven kinds, SOURCED FROM THE LITERAL LIST rather than re-spelled per branch, so every
 * `kind` in this file is checked against it and a typo is a type error. `risks.test.ts`
 * asserts the list equals the Prisma enum's values.
 */
export const INTERVIEW_RISK_KINDS: readonly InterviewRiskKind[] = Object.freeze([
  'new_claim',
  'emphasized_tech',
  'inferred_claim',
  'rewritten_bullet',
  'gap',
  'overclaim',
  'thin_evidence',
] as InterviewRiskKind[]);

/** `kind` on the wire, defensively. A value outside the list is `null`, never a guess. */
export function isInterviewRiskKind(value: unknown): value is InterviewRiskKind {
  return typeof value === 'string' && (INTERVIEW_RISK_KINDS as readonly string[]).includes(value);
}

/** Severity, ordered worst-first. The first component of the output's TOTAL order. */
export const SEVERITY_ORDER: readonly Severity[] = Object.freeze([
  'high',
  'medium',
  'low',
] as Severity[]);

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITY_ORDER as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The ANCHOR: what a risk was read from
// ---------------------------------------------------------------------------

/**
 * WHERE a risk's evidence lives, as a closed vocabulary. Each member names one table, and
 * every risk anchors at least one row in one of them - which is what "derived from data"
 * means operationally.
 */
export const RISK_ANCHOR_SOURCES = Object.freeze([
  /** `ResumeClaimUsage` - a claim this revision renders, and how. */
  'resume_claim_usage',
  /** `CareerClaim` - the statement behind a usage, or the subject of a gap. */
  'career_claim',
  /** the matcher's `unsupported` requirements (what `MatchReport.gaps` stores). */
  'match_gap',
  /** `ResumeChange` - one accepted operation and its before/after. */
  'resume_change',
  /** `JobRequirement` - the requirement text a gap or an emphasised technology refers to. */
  'requirement',
] as const);

export type RiskAnchorSource = (typeof RISK_ANCHOR_SOURCES)[number];

/** Every `detail` an anchor may carry, as a closed vocabulary. */
export const RISK_ANCHOR_DETAILS = Object.freeze({
  /** A rendered claim confirmed inside the recency window. */
  RECENTLY_CONFIRMED: 'recently_confirmed',
  /** `user_entered` with no `EvidenceSource` behind it. */
  USER_ENTERED_WITHOUT_SOURCE: 'user_entered_without_evidence_source',
  /** The claim has no `EvidenceSource` row. */
  NO_EVIDENCE_SOURCE: 'no_evidence_source',
  /** No second confirmed claim shares a technology or an employer with it. */
  NO_CORROBORATING_CLAIM: 'no_corroborating_claim',
  /** The claim's text sits at `basics.summary` or a `skills[].name`. */
  FIRST_SCREEN_PLACEMENT: 'first_screen_placement',
  /** The claim is `direct` evidence for this must-have requirement. */
  DIRECT_MUST_REQUIREMENT: 'direct_must_requirement',
  /** The accepted change's `after` holds an entity the before-state did not. */
  CHANGE_FACT_DELTA: 'change_fact_delta',
  /** A `tailored` usage rendering a claim that is not confirmed. */
  TAILORED_ON_UNCONFIRMED_CLAIM: 'tailored_on_unconfirmed_claim',
  /** The tailored `renderedText` holds an entity the claim and the page do not. */
  RENDERED_TEXT_FACT_DELTA: 'rendered_text_fact_delta',
  /** The operation was ACCEPTED, so it is on the page. */
  ACCEPTED_REWRITE: 'accepted_rewrite',
  /** `after` and `before` share less wording than `REWRITTEN_BULLET_OVERLAP_MAX`. */
  MATERIAL_REWORDING: 'material_rewording',
  /** Every entity in `after` is also in `before`. */
  ENTITY_PRESERVING: 'entity_preserving',
  /** A metric in `after` exceeds every metric in `before`. */
  METRIC_EXCEEDS_BEFORE: 'metric_exceeds_before',
  /** The requirement re-derives as `unsupported`, i.e. it is a named gap. */
  UNSUPPORTED_REQUIREMENT: 'unsupported_requirement',
  /** The requirement's importance, which is what sets the severity. */
  REQUIREMENT_IMPORTANCE: 'requirement_importance',
} as const);

export type RiskAnchorDetail =
  (typeof RISK_ANCHOR_DETAILS)[keyof typeof RISK_ANCHOR_DETAILS];

/** One row a risk was read from, and why that row is the reason. */
export interface RiskAnchor {
  source: RiskAnchorSource;
  /** The row's own id - a usage's `claimId`, a change's `id`, a requirement's `id`. */
  id: string;
  detail: RiskAnchorDetail;
}

// ---------------------------------------------------------------------------
// The refusal vocabulary (fail closed)
// ---------------------------------------------------------------------------

/** Every way risk derivation refuses. Two, and only two. */
export const RISK_REJECTION_REASONS = Object.freeze([
  /** A risk was built with no usable data anchor. A risk with no anchor is a sentence. */
  'UNANCHORED_RISK',
  /** `now` is not a usable date, so "confirmed recently" cannot be answered at all. */
  'INVALID_CLOCK',
] as const);

export type RiskRejectionReason = (typeof RISK_REJECTION_REASONS)[number];

export type RiskRejectionCode = `RISK_${RiskRejectionReason}`;

/** Derivation refused. Carries the machine-readable reason; no caller data in the message. */
export class InterviewRiskError extends Error {
  readonly code: RiskRejectionCode;
  readonly reason: RiskRejectionReason;
  /** The risks that could not be built. Empty for `INVALID_CLOCK`. */
  readonly rejected: ReadonlyArray<{ kind: InterviewRiskKind; statement: string }>;

  constructor(
    reason: RiskRejectionReason,
    rejected: ReadonlyArray<{ kind: InterviewRiskKind; statement: string }> = [],
  ) {
    super(`RISK_${reason}: an interview risk must name the data it was derived from`);
    this.name = 'InterviewRiskError';
    this.code = `RISK_${reason}`;
    this.reason = reason;
    this.rejected = Object.freeze(rejected.map((row) => Object.freeze({ ...row })));
  }
}

// ---------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------

/**
 * One derived risk.
 *
 * `anchors` is the audit trail and the acceptance item. `key` is the DETERMINISTIC identity,
 * used by the optional provider stage in `questions.ts`, which may sharpen a derived risk and
 * may never create one.
 */
export interface DerivedRisk {
  readonly kind: InterviewRiskKind;
  readonly severity: Severity;
  /** What is risky, in one sentence, with every entity it names taken from the rows. */
  readonly statement: string;
  /** NEVER empty. The rows this risk was read from. */
  readonly anchors: readonly RiskAnchor[];
  /** `<source>:<id>` of the first anchor. Stable across runs for the same input. */
  readonly key: string;
  /** Claims a model answer for this risk may cite. A subset of the profile's claims. */
  readonly groundedClaimIds: readonly string[];
  /** `JobRequirement.id` when the risk is about one requirement; else `null`. */
  readonly requirementId: string | null;
  /** `CareerClaim.id` when the risk is about one claim; else `null`. */
  readonly claimId: string | null;
  /**
   * The DETERMINISTIC interview probe for this risk kind. The provider stage may sharpen it;
   * this is what every risk carries with no provider configured, and it is what the question
   * templates are written around.
   */
  readonly focus: string;
}

/**
 * Every risk kind's deterministic probe.
 *
 * This table is the reason the risk stage needs no provider to be USEFUL: with no key
 * configured the risks are still derived AND still say what an interviewer will do with them.
 * The provider stage only makes the wording sharper, and a sharper wording that invents a
 * fact is discarded by the same entity check as a model answer.
 */
export const RISK_KIND_FOCUS: Readonly<Record<InterviewRiskKind, string>> = Object.freeze({
  new_claim:
    'This statement is new to your resume. Be ready to say where it came from: a date, a document, or a person who can corroborate it.',
  emphasized_tech:
    'This technology is on your first screen and carries more than one must-have requirement. Expect to go deeper than the resume line allows.',
  inferred_claim:
    'This wording says something your confirmed evidence does not. Expect to be asked for the detail behind it, and expect to be caught out if you cannot produce it.',
  rewritten_bullet:
    'This bullet was reworded. Expect a follow-up on the original achievement behind it, so you can describe it the way you described it first.',
  overclaim:
    'This number is larger than the number it replaced. Expect to be asked how it was measured and over what window.',
  gap:
    'This requirement has nothing behind it in your evidence. Expect a direct question, and the honest answer is what you have not done.',
  thin_evidence:
    'Nothing corroborates this statement. Expect to be asked where it comes from, because there is no document behind it.',
});

/**
 * THE ONLY CONSTRUCTOR, and it refuses an unanchored risk.
 *
 * This is the single most important line in the file: it is the difference between a risk and
 * a sentence. It also refuses a severity outside the enum's three values, so a fourth value
 * cannot appear as an "urgent" that no client knows how to render.
 */
function anchoredRisk(input: {
  kind: InterviewRiskKind;
  severity: Severity;
  statement: string;
  anchors: readonly RiskAnchor[];
  groundedClaimIds?: readonly string[];
  requirementId?: string | null;
  claimId?: string | null;
}): DerivedRisk {
  const anchors = (input.anchors ?? []).filter(
    (anchor) =>
      anchor !== null &&
      typeof anchor === 'object' &&
      typeof anchor.id === 'string' &&
      anchor.id.length > 0 &&
      (RISK_ANCHOR_SOURCES as readonly string[]).includes(anchor.source) &&
      typeof anchor.detail === 'string' &&
      anchor.detail.length > 0,
  );
  if (anchors.length === 0 || !isSeverity(input.severity)) {
    throw new InterviewRiskError('UNANCHORED_RISK', [
      { kind: input.kind, statement: clamp(input.statement, MAX_STATEMENT_CHARS) },
    ]);
  }
  return Object.freeze({
    kind: input.kind,
    severity: input.severity,
    statement: clamp(input.statement, MAX_STATEMENT_CHARS),
    anchors: Object.freeze(anchors),
    key: `${anchors[0].source}:${anchors[0].id}`,
    groundedClaimIds: Object.freeze([...new Set(input.groundedClaimIds ?? [])].sort()),
    requirementId: input.requirementId ?? null,
    claimId: input.claimId ?? null,
    focus: RISK_KIND_FOCUS[input.kind],
  });
}

/**
 * The whole set re-checked, in one place, so the invariant is assertable from OUTSIDE this
 * module. `risks.test.ts` names it; the derivation also runs it on its own output, so a
 * builder that stops anchoring fails the derivation itself rather than only the test.
 */
export function assertRisksAreAnchored(risks: readonly DerivedRisk[]): readonly DerivedRisk[] {
  if (!Array.isArray(risks)) throw new InterviewRiskError('UNANCHORED_RISK', []);
  const rejected = risks
    .filter(
      (risk) =>
        risk === null ||
        typeof risk !== 'object' ||
        !isInterviewRiskKind(risk.kind) ||
        !isSeverity(risk.severity) ||
        !Array.isArray(risk.anchors) ||
        risk.anchors.length === 0 ||
        risk.anchors.every(
          (anchor: RiskAnchor) =>
            anchor === null ||
            typeof anchor !== 'object' ||
            typeof anchor.id !== 'string' ||
            anchor.id.length === 0 ||
            !(RISK_ANCHOR_SOURCES as readonly string[]).includes(anchor.source) ||
            typeof anchor.detail !== 'string' ||
            anchor.detail.length === 0,
        ),
    )
    .map((risk) => ({
      kind: (risk as DerivedRisk | null)?.kind ?? ('gap' as InterviewRiskKind),
      statement: (risk as DerivedRisk | null)?.statement ?? '(no statement)',
    }));
  if (rejected.length > 0) throw new InterviewRiskError('UNANCHORED_RISK', rejected);
  return Object.freeze([...risks]);
}

// ---------------------------------------------------------------------------
// Bounds (E.9 data minimization: a bounded slice of a revision, not the whole profile)
// ---------------------------------------------------------------------------

/** A statement longer than this is truncated - a risk is a sentence, not a document. */
export const MAX_STATEMENT_CHARS = 400;
/** `new_claim`'s recency rule: strictly fewer than this many days before `now`. */
export const NEW_CLAIM_CONFIRMATION_WINDOW_DAYS = 30;
/** `emphasized_tech` fires at this many must-have `direct` requirements. */
export const EMPHASIZED_TECH_MUST_MIN = 2;
/** ...and is `medium` from this many. */
export const EMPHASIZED_TECH_MUST_HIGH = 3;
/** `rewritten_bullet` fires BELOW this Jaccard overlap between `before` and `after`. */
export const REWRITTEN_BULLET_OVERLAP_MAX = 0.6;
/** ...and is `medium` below this. */
export const REWRITTEN_BULLET_OVERLAP_HIGH = 0.35;
/** The most grounding claims any ONE risk names, so a prompt cannot grow with the profile. */
export const MAX_GROUNDED_CLAIMS_PER_RISK = 6;

/**
 * Whitespace-collapsed and truncated, to `max` characters INCLUDING the ellipsis.
 *
 * The bound is on the STRING, not on the body: `slice(0, max - 1)` followed by `'...'` would
 * hand back three characters more than promised, and a bound that is off by three is a bound
 * nobody can rely on.
 */
function clamp(text: string, max: number): string {
  const collapsed = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

// ---------------------------------------------------------------------------
// The first screen
// ---------------------------------------------------------------------------

/**
 * WHERE "the resume's first screen" lives, as PATTERNS. `basics.summary` is the summary and
 * `skills[*].name` is the top-skills block - the two members a reader sees before the work
 * history, and the two a tailoring `reword_summary` / `add_skill` can move.
 *
 * IT IS A PATTERN LIST RATHER THAN A DERIVATION because "first screen" is a LAYOUT judgement
 * and this module holds no template metadata; a template that moves skills into a sidebar does
 * not change which claims the reader met first in the document they sent us. Exported so the
 * question templates can name the same two paths.
 */
export const FIRST_SCREEN_TARGET_PATTERNS: readonly string[] = Object.freeze([
  'basics.summary',
  'skills.*.name',
]);

/**
 * `skills[2].name` -> `skills.*.name`; `work[0].highlights[1]` -> `null`.
 *
 * The pattern SPELLING IS THE ONE `tailor/ops.ts#CLAIM_BACKED_TARGET_PATTERNS` uses -
 * `section.*.member`, not `section[*].member` - so "is this a claim-backed path" has one
 * spelling in the repository and a future edit to either list cannot make the two disagree
 * about what `skills[2].name` is.
 */
export function firstScreenPattern(target: string): string | null {
  if (typeof target !== 'string' || target.length === 0) return null;
  const shaped = target.replace(/\[\d+\]/g, '[*]').replace(/\[\*\]/g, '.*');
  return FIRST_SCREEN_TARGET_PATTERNS.includes(shaped) ? shaped : null;
}

// ---------------------------------------------------------------------------
// Reading the document: the ledger, the page text
// ---------------------------------------------------------------------------

interface LedgerEntry {
  claimId: string | null;
  jsonPath: string | null;
  usage: string | null;
  renderedText: string | null;
}

/**
 * The `x-clearance` block, as the rows the projector wrote.
 *
 * A LOCAL reader rather than a third export, for a reason worth stating: `apply.ts` reads the
 * block to MOVE entries while it folds operations (its shape is a mutation, not a read) and
 * `revisions.ts` reads it to DERIVE the usage set at write time. This module needs a third
 * thing - which claim placed TEXT at which path - and widening either of the other two to
 * serve it would reach into a module the whole pre-render belt depends on. The block is the
 * projector speaking, so it is trusted here exactly as far as those two trust it: read, never
 * reconstructed.
 */
function ledgerEntries(document: unknown): LedgerEntry[] {
  const record = document as { 'x-clearance'?: { claims?: unknown } } | null;
  const claims = record?.['x-clearance']?.claims;
  if (!Array.isArray(claims)) return [];
  const out: LedgerEntry[] = [];
  for (const raw of claims) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    out.push({
      claimId: typeof entry.claimId === 'string' ? entry.claimId : null,
      jsonPath: typeof entry.jsonPath === 'string' ? entry.jsonPath : null,
      usage: typeof entry.usage === 'string' ? entry.usage : null,
      renderedText: typeof entry.renderedText === 'string' ? entry.renderedText : null,
    });
  }
  return out;
}

/**
 * Every non-empty string in the document, at depth.
 *
 * THE LEDGER IS EXCLUDED, for the same reason `tailor/validate.ts#documentTexts` excludes it
 * and for the same reason it gives: the ledger is metadata ABOUT the page, so reading it in
 * would let a claim's own `renderedText` ground a check on that claim's `renderedText`.
 */
function pageTexts(document: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof document === 'string') {
    if (document.trim().length > 0) out.push(document);
    return out;
  }
  if (Array.isArray(document)) {
    for (const entry of document) pageTexts(entry, out, depth + 1);
    return out;
  }
  if (document !== null && typeof document === 'object') {
    for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
      if (key === 'x-clearance') continue;
      pageTexts(value, out, depth + 1);
    }
  }
  return out;
}

/**
 * THE PAGE AS IT WAS BEFORE ONE STRING EXISTED.
 *
 * WHY IT IS NEEDED, AND IT IS THE WHOLE POINT: the document a risk is derived from is the
 * revision AS STORED, which means the `after` of a rewrite and the `renderedText` of a
 * tailored usage are BOTH ALREADY IN IT. An "everything else on the page" set read naively
 * therefore always contains the very text under test, and every leakage check would pass
 * vacuously - which is the most dangerous kind of test failure, because the suite would be
 * green and the guard would be decorative.
 *
 * So the one string being judged is removed FIRST, by byte equality, exactly once. Two
 * byte-identical placements on one page is possible, and then the guard is stricter than the
 * truth requires - which is the direction that is safe. An `exclude` of `null` or `''` returns
 * the page unchanged, so a caller with nothing to exclude is unaffected.
 */
function pageTextsExcluding(document: unknown, exclude: string | null): string[] {
  const texts = pageTexts(document);
  const needle = typeof exclude === 'string' ? exclude : '';
  if (needle.length === 0) return texts;
  const index = texts.findIndex((text) => text === needle);
  if (index === -1) return texts;
  return [...texts.slice(0, index), ...texts.slice(index + 1)];
}

// ---------------------------------------------------------------------------
// Token overlap - the "materially different" measure
// ---------------------------------------------------------------------------

/** A word is two or more characters of letters, digits or `+ # .`, lowercased. */
const WORD_PATTERN = /[a-z0-9][a-z0-9+#.]*/g;

function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  const source = typeof text === 'string' ? text.toLowerCase() : '';
  WORD_PATTERN.lastIndex = 0;
  for (let match = WORD_PATTERN.exec(source); match !== null; match = WORD_PATTERN.exec(source)) {
    const word = match[0].replace(/[.#-]+$/, '');
    if (word.length >= 2) out.add(word);
  }
  return out;
}

/**
 * Jaccard overlap of two texts' words: `|A and B| / |A or B|`, in `[0, 1]`.
 *
 * CHOSEN OVER CONTAINMENT because it is symmetric: a rewrite that only ADDS words and a
 * rewrite that only DROPS them are equally far from the original, and a directional measure
 * would rate one of them as identical to it. Two texts with no shared word score `0`, which is
 * the fail-closed end - "these say nothing in common" is exactly the case `rewritten_bullet`
 * exists to name.
 */
export function wordOverlap(before: string, after: string): number {
  const a = wordSet(before);
  const b = wordSet(after);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

// ---------------------------------------------------------------------------
// The input rows - the narrowest shape each derivation needs
// ---------------------------------------------------------------------------

/** A `ResumeClaimUsage`, as the derivation reads it. */
export interface RiskUsageRow {
  claimId: string;
  usage: ResumeUsage | string;
  renderedText: string | null;
}

/** A `CareerClaim`, as the derivation reads it. Status is JUDGED by the career layer. */
export interface RiskClaimRow {
  id: string;
  kind: ClaimKind;
  statement: string;
  status: ClaimStatus;
  provenance: ClaimProvenance;
  /** `null` when nothing corroborates the claim (E.4's `thin_evidence`). */
  evidenceSourceId: string | null;
  /** `null` when the claim was never confirmed. The recency rule's only input. */
  confirmedAt: Date | null;
}

/** A `ResumeChange`, as the derivation reads it. */
export interface RiskChangeRow {
  id: string;
  op: ResumeChangeOp | string;
  jsonPath: string;
  before: unknown;
  after: unknown;
  accepted: boolean;
  sourceClaimIds: readonly string[];
}

/** One requirement's derived level, i.e. a row of `deriveEvidenceLevels`'s output. */
export interface RiskRequirementRow {
  requirementId: string;
  kind: string;
  importance: string;
  text: string;
  level: EvidenceLevel;
  evidence: ReadonlyArray<{ claimId: string }>;
}

export interface RiskDerivationInput {
  /** The revision's `resumeJson`. The page, and the ledger, read from it. */
  document: unknown;
  usages: readonly RiskUsageRow[];
  claims: readonly RiskClaimRow[];
  changes: readonly RiskChangeRow[];
  /**
   * The derived levels of the match report. ABSENT means "no match report was read", and the
   * `gap` and `emphasized_tech` kinds then find nothing - which is the honest result, rather
   * than a risk invented from the resume alone.
   */
  requirements?: readonly RiskRequirementRow[];
  /** Injected clock. `new_claim`'s recency rule is the ONLY thing that reads it. */
  now: Date;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export interface DerivedRiskSet {
  /** Every risk, in a TOTAL order: severity, then kind, then anchor key. */
  risks: readonly DerivedRisk[];
  /** How many of each kind. Seven integers, always all seven keys. Never a score. */
  counts: Readonly<Record<InterviewRiskKind, number>>;
  /** What was read, so the view can say "derived from N usages and M changes". */
  derivedFrom: {
    usages: number;
    claims: number;
    changes: number;
    requirements: number;
  };
}

/** Every kind at zero, so the counts map always has the same seven keys. */
function emptyCounts(): Record<InterviewRiskKind, number> {
  return {
    new_claim: 0,
    emphasized_tech: 0,
    inferred_claim: 0,
    rewritten_bullet: 0,
    gap: 0,
    overclaim: 0,
    thin_evidence: 0,
  };
}

/**
 * THE SINGLE DERIVATION.
 *
 * ORDER: the leakage checks first, because they are the ones whose absence would let a lie
 * through; then the per-claim risks; then the change risks; then the requirement risks. The
 * result is then put in a TOTAL order - severity, then kind, then anchor key - so a client
 * never has to care about the order rows came back from the database, and two runs over the
 * same data produce the same list.
 *
 * WITH NO PROVIDER THIS FUNCTION IS THE WHOLE RISK FEATURE. Nothing here calls a model, so
 * the risk stage cannot be skipped, degraded or invented: it is the deterministic half of
 * E.8 stage 11 and the reason a question can be anchored at all.
 */
export function deriveInterviewRisks(input: RiskDerivationInput): DerivedRiskSet {
  const now = input?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InterviewRiskError('INVALID_CLOCK');
  }

  const document = input.document;
  const claims = input.claims ?? [];
  const changes = input.changes ?? [];
  const requirements = input.requirements ?? [];
  const usages = input.usages ?? [];

  const claimById = new Map(claims.map((claim) => [claim.id, claim] as const));

  // Only a usage that RENDERS is in scope. An `omitted` usage puts nothing on the page, so it
  // is inert for every kind here - which is exactly what `career/claimUsage.ts` says of it at
  // the gate.
  const rendered: Array<{ usage: RiskUsageRow; claim: RiskClaimRow }> = [];
  for (const usage of usages) {
    if (!isRenderedUsage(String(usage.usage))) continue;
    const claim = claimById.get(usage.claimId);
    if (!claim) continue;
    rendered.push({ usage, claim });
  }

  const risks: DerivedRisk[] = [
    ...inferredClaimRisks(document, claims, changes, usages),
    ...newClaimRisks(rendered, now),
    ...emphasizedTechRisks(document, claims, requirements),
    ...thinEvidenceRisks(rendered, claims),
    ...changeRisks(changes),
    ...gapRisks(requirements),
  ];

  const sorted = [...risks].sort((a, b) => {
    const severity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (severity !== 0) return severity;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  assertRisksAreAnchored(sorted);

  const counts = emptyCounts();
  for (const risk of sorted) counts[risk.kind] += 1;

  return Object.freeze({
    risks: Object.freeze(sorted),
    counts: Object.freeze(counts),
    derivedFrom: Object.freeze({
      usages: usages.length,
      claims: claims.length,
      changes: changes.length,
      requirements: requirements.length,
    }),
  });
}

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

/** Does this usage put the claim's text ON the page? `omitted` does not. */
function isRenderedUsage(usage: string): boolean {
  return (GATED_USAGES as readonly string[]).includes(usage);
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** The claim ids an anchor set names, capped so one risk cannot name the whole profile. */
function grounded(anchorIds: Iterable<string>, extra: readonly string[] = []): readonly string[] {
  return Object.freeze(
    [...new Set([...anchorIds, ...extra])].filter((id) => id.length > 0).slice(0, MAX_GROUNDED_CLAIMS_PER_RISK).sort(),
  );
}

/** One `career_claim` anchor per id, capped like the grounded set. */
function claimAnchors(
  ids: Iterable<string>,
  detail: RiskAnchorDetail,
): ReadonlyArray<{ source: 'career_claim'; id: string; detail: RiskAnchorDetail }> {
  return [...new Set(ids)]
    .slice(0, MAX_GROUNDED_CLAIMS_PER_RISK)
    .map((id) => ({ source: 'career_claim' as const, id, detail }));
}

// ---------------------------------------------------------------------------
// `new_claim`
// ---------------------------------------------------------------------------

/**
 * `new_claim`: a claim the reader has not had time to live with.
 *
 * E.4's derivation has two clauses and both are implemented, with different severities
 * because they are different asks. "Confirmed in the last 30 days" is `medium` - the reader
 * will ask where it came from. "Provenance is `user_entered` and nothing corroborates it" is
 * `high`: there is no document behind it at all.
 *
 * ONE RISK PER CLAIM, at the WORST severity of its clauses. Two risks for one line on the
 * resume would read as two separate problems to a person, and would teach them that the list
 * counts events rather than statements.
 */
function newClaimRisks(
  rendered: ReadonlyArray<{ usage: RiskUsageRow; claim: RiskClaimRow }>,
  now: Date,
): DerivedRisk[] {
  const notes = new Map<
    string,
    { usage: RiskUsageRow; claim: RiskClaimRow; details: RiskAnchorDetail[]; severity: Severity }
  >();

  for (const entry of rendered) {
    const { claim, usage } = entry;
    const details: RiskAnchorDetail[] = [];
    let severity: Severity | null = null;

    if (claim.confirmedAt instanceof Date && !Number.isNaN(claim.confirmedAt.getTime())) {
      const age = daysBetween(claim.confirmedAt, now);
      // A claim confirmed in the FUTURE has a negative age. That is clock skew, not evidence
      // of recency, so it is skipped - reading it as "confirmed today" would invent a risk.
      if (age >= 0 && age < NEW_CLAIM_CONFIRMATION_WINDOW_DAYS) {
        details.push(RISK_ANCHOR_DETAILS.RECENTLY_CONFIRMED);
        severity = 'medium';
      }
    }
    if (claim.provenance === ClaimProvenance.user_entered && claim.evidenceSourceId === null) {
      details.push(RISK_ANCHOR_DETAILS.USER_ENTERED_WITHOUT_SOURCE);
      severity = 'high';
    }
    if (severity === null || details.length === 0) continue;

    const existing = notes.get(claim.id);
    if (existing) {
      existing.details = [...new Set([...existing.details, ...details])];
      if (SEVERITY_ORDER.indexOf(severity) < SEVERITY_ORDER.indexOf(existing.severity)) {
        existing.severity = severity;
      }
      continue;
    }
    notes.set(claim.id, { usage, claim, details, severity });
  }

  return [...notes.entries()].map(([claimId, note]) =>
    anchoredRisk({
      kind: 'new_claim',
      severity: note.severity,
      statement: `"${note.claim.statement}" is on this resume, and it ${describe(note.details)}.`,
      anchors: [
        ...note.details.map((detail, index) =>
          index === 0
            ? {
                source: 'resume_claim_usage' as const,
                id: note.usage.claimId,
                detail,
              }
            : { source: 'career_claim' as const, id: claimId, detail },
        ),
      ],
      groundedClaimIds: grounded([claimId]),
      claimId,
    }),
  );
}

/** The two clauses, in words. Fixed strings: the statement names them, not the code. */
function describe(details: readonly RiskAnchorDetail[]): string {
  const parts: string[] = [];
  if (details.includes(RISK_ANCHOR_DETAILS.RECENTLY_CONFIRMED)) {
    parts.push(`was confirmed less than ${NEW_CLAIM_CONFIRMATION_WINDOW_DAYS} days ago`);
  }
  if (details.includes(RISK_ANCHOR_DETAILS.USER_ENTERED_WITHOUT_SOURCE)) {
    parts.push('has no document behind it');
  }
  return parts.join(' and ');
}

// ---------------------------------------------------------------------------
// `emphasized_tech`
// ---------------------------------------------------------------------------

/**
 * `emphasized_tech`: a technology on the FIRST SCREEN carrying more than one must-have.
 *
 * The `direct` half comes from `match/levels.ts`'s own output rather than a second join, so
 * `direct` means here exactly what it means on the match report - and it means it AFTER
 * confirmation, never before (E.2's invariant). Two must-haves is the floor because one
 * requirement is an ordinary match; three is where a reader will reasonably expect the
 * technology to hold up on its own.
 *
 * The placement half comes from the document's own ledger, NOT from "the claim's kind is
 * technology" - a technology in the middle of the work history is not on the first screen,
 * and calling it one would produce a risk the reader could not act on.
 */
function emphasizedTechRisks(
  document: unknown,
  claims: readonly RiskClaimRow[],
  requirements: readonly RiskRequirementRow[],
): DerivedRisk[] {
  const mustDirect = new Map<string, string[]>();
  for (const requirement of requirements) {
    if (requirement.level !== 'direct' || requirement.importance !== 'must') continue;
    for (const row of requirement.evidence ?? []) {
      const bucket = mustDirect.get(row.claimId) ?? [];
      bucket.push(requirement.requirementId);
      mustDirect.set(row.claimId, bucket);
    }
  }
  if (mustDirect.size === 0) return [];

  const claimById = new Map(claims.map((claim) => [claim.id, claim] as const));
  const out: DerivedRisk[] = [];
  const seen = new Set<string>();

  for (const entry of ledgerEntries(document)) {
    if (entry.claimId === null || entry.jsonPath === null) continue;
    if (!isRenderedUsage(entry.usage ?? '')) continue;
    if (firstScreenPattern(entry.jsonPath) === null) continue;
    const claim = claimById.get(entry.claimId);
    if (!claim) continue;
    if (claim.kind !== ClaimKind.technology && claim.kind !== ClaimKind.skill) continue;
    const requirementIds = (mustDirect.get(claim.id) ?? []).sort();
    if (requirementIds.length < EMPHASIZED_TECH_MUST_MIN) continue;
    // One risk per claim, even if it sits in two first-screen slots (a summary AND a skill
    // line): the reader will be asked about the technology, not about the two places.
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);
    out.push(
      anchoredRisk({
        kind: 'emphasized_tech',
        severity: requirementIds.length >= EMPHASIZED_TECH_MUST_HIGH ? 'medium' : 'low',
        statement: `"${entry.jsonPath}" puts "${claim.statement}" on the first screen, and that one statement is the direct evidence for ${requirementIds.length} must-have requirements.`,
        anchors: [
          {
            source: 'resume_claim_usage',
            id: claim.id,
            detail: RISK_ANCHOR_DETAILS.FIRST_SCREEN_PLACEMENT,
          },
          ...requirementIds
            .slice(0, MAX_GROUNDED_CLAIMS_PER_RISK)
            .map((requirementId) => ({
              source: 'requirement' as const,
              id: requirementId,
              detail: RISK_ANCHOR_DETAILS.DIRECT_MUST_REQUIREMENT,
            })),
        ],
        groundedClaimIds: grounded([claim.id]),
        claimId: claim.id,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// `inferred_claim` - LEAKAGE, in the three places it can hide
// ---------------------------------------------------------------------------

/**
 * The allowed set `tailor/validate.ts` rule 3 would compute: the before-state, the named
 * grounding claims, and everything else already on the page. Built from the SAME members in
 * the SAME order, so a change the tailoring guard refuses is a risk here rather than a second
 * opinion. Where the two ever disagree it is the tailoring guard that is right, and this
 * module only ever reports.
 */
function allowedFactsForChange(
  change: RiskChangeRow,
  claims: ReadonlyMap<string, RiskClaimRow>,
  document: unknown,
): FactSet {
  const grounding = change.sourceClaimIds
    .map((id) => claims.get(id))
    .filter((claim): claim is RiskClaimRow => claim !== undefined);
  const employers = grounding.flatMap((claim) => extractFacts(claim.statement).employers);
  return factsOfTexts(
    [
      typeof change.before === 'string' ? change.before : '',
      ...grounding.map((claim) => claim.statement),
      // The page MINUS the text this change wrote: see `pageTextsExcluding`.
      ...pageTextsExcluding(
        document,
        typeof change.after === 'string' ? change.after : null,
      ),
    ],
    employers,
  );
}

/** All three leakage checks. Every one of them is `high`: each is a fact nobody confirmed. */
function inferredClaimRisks(
  document: unknown,
  claims: readonly RiskClaimRow[],
  changes: readonly RiskChangeRow[],
  usages: readonly RiskUsageRow[],
): DerivedRisk[] {
  const claimById = new Map(claims.map((claim) => [claim.id, claim] as const));
  const out: DerivedRisk[] = [];

  // 1. THE CHANGE LEDGER. `apply.ts` is the only writer of new document text, so an `after`
  //    holding an entity that is in neither `before` nor a named claim nor elsewhere on the
  //    page is a fact delta that got through. THE ACCEPTANCE FIXTURE IS THIS ONE.
  for (const change of changes) {
    if (!change.accepted) continue;
    if (!isTextChangingOp(change.op as ResumeChangeOp)) continue;
    const after = typeof change.after === 'string' ? change.after : '';
    if (after.trim().length === 0) continue;
    const delta = detectFactDelta(
      extractFacts(after, []),
      allowedFactsForChange(change, claimById, document),
    );
    if (delta === null) continue;
    out.push(
      anchoredRisk({
        kind: 'inferred_claim',
        severity: 'high',
        statement: `The accepted ${change.op} at ${change.jsonPath} introduces ${delta.introduced.join(', ')}, which is in neither the wording it replaced nor any statement you confirmed.`,
        anchors: [
          {
            source: 'resume_change',
            id: change.id,
            detail: RISK_ANCHOR_DETAILS.CHANGE_FACT_DELTA,
          },
          ...claimAnchors(change.sourceClaimIds, RISK_ANCHOR_DETAILS.CHANGE_FACT_DELTA),
        ],
        groundedClaimIds: grounded(change.sourceClaimIds),
      }),
    );
  }

  // 2. THE USAGE. A `tailored` rendering of a claim that is not the confirming status. The
  //    pre-render gate blocks the revision at render time; this says so before it is rendered.
  for (const usage of usages) {
    if (usage.usage !== 'tailored') continue;
    const claim = claimById.get(usage.claimId);
    if (!claim || isRenderableClaimStatus(claim.status)) continue;
    out.push(
      anchoredRisk({
        kind: 'inferred_claim',
        severity: 'high',
        statement: `This resume renders "${claim.statement}" as tailored wording, and that statement is not one you confirmed.`,
        anchors: [
          {
            source: 'resume_claim_usage',
            id: usage.claimId,
            detail: RISK_ANCHOR_DETAILS.TAILORED_ON_UNCONFIRMED_CLAIM,
          },
          {
            source: 'career_claim',
            id: claim.id,
            detail: RISK_ANCHOR_DETAILS.TAILORED_ON_UNCONFIRMED_CLAIM,
          },
        ],
        groundedClaimIds: [],
        claimId: claim.id,
      }),
    );
  }

  // 3. THE RENDERED TEXT. E.4's sentence literally: the before-state (the claim) had no such
  //    fact. The allowed set is the claim's OWN statement plus the page MINUS this usage's own
  //    rendered text - the same composition as rule 3 of the tailoring validator, with the
  //    text under test taken out rather than in.
  for (const usage of usages) {
    if (usage.usage !== 'tailored') continue;
    const rendered = typeof usage.renderedText === 'string' ? usage.renderedText.trim() : '';
    if (rendered.length === 0) continue;
    const claim = claimById.get(usage.claimId);
    if (!claim) continue;
    const employers = employersOfClaims(claims, claim.id);
    const allowed = factsOfTexts(
      [claim.statement, ...pageTextsExcluding(document, rendered)],
      employers,
    );
    const delta = detectFactDelta(extractFacts(rendered, employers), allowed);
    if (delta === null) continue;
    out.push(
      anchoredRisk({
        kind: 'inferred_claim',
        severity: 'high',
        statement: `The tailored wording on this resume introduces ${delta.introduced.join(', ')}, which is in neither "${claim.statement}" nor anywhere else on the page.`,
        anchors: [
          {
            source: 'resume_claim_usage',
            id: usage.claimId,
            detail: RISK_ANCHOR_DETAILS.RENDERED_TEXT_FACT_DELTA,
          },
          {
            source: 'career_claim',
            id: claim.id,
            detail: RISK_ANCHOR_DETAILS.RENDERED_TEXT_FACT_DELTA,
          },
        ],
        groundedClaimIds: grounded([claim.id]),
        claimId: claim.id,
      }),
    );
  }

  return out;
}

/** Every employer name any OTHER claim mentions, so `extractFacts` recognises each of them. */
function employersOfClaims(
  claims: readonly RiskClaimRow[],
  excludeClaimId: string,
): readonly string[] {
  const out = new Set<string>();
  for (const claim of claims) {
    if (claim.id === excludeClaimId) continue;
    for (const employer of extractFacts(claim.statement).employers) out.add(employer);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// `thin_evidence`
// ---------------------------------------------------------------------------

/**
 * Is `claim` corroborated by another confirmed claim in the same evidence neighbourhood?
 *
 * CORROBORATION IS SHARED GROUND, NOT SIMILARITY. Two claims about the same employer or the
 * same technology are about the same work; two claims with similar wording may be about
 * different years of a different job. Unconfirmed neighbours do not count - a hypothesis does
 * not corroborate anything (E.2's invariant, applied here).
 */
function isCorroborated(claim: RiskClaimRow, claims: readonly RiskClaimRow[]): boolean {
  const own = extractFacts(claim.statement);
  const technologies = new Set(own.technologies);
  const employers = new Set(own.employers);
  if (technologies.size === 0 && employers.size === 0) return false;
  return claims.some((other) => {
    if (other.id === claim.id) return false;
    if (!isRenderableClaimStatus(other.status)) return false;
    const theirs = extractFacts(other.statement);
    return (
      theirs.technologies.some((value) => technologies.has(value)) ||
      theirs.employers.some((value) => employers.has(value))
    );
  });
}

/**
 * `thin_evidence`: a confirmed statement with nothing behind it and nothing beside it.
 *
 * BOTH halves of E.4's row are checked - no `EvidenceSource`, AND no second claim sharing an
 * employer or a technology. `low` severity, because a thin claim is not a lie; it is a claim
 * that will need a source before it needs a defence.
 */
function thinEvidenceRisks(
  rendered: ReadonlyArray<{ usage: RiskUsageRow; claim: RiskClaimRow }>,
  claims: readonly RiskClaimRow[],
): DerivedRisk[] {
  const out: DerivedRisk[] = [];
  for (const entry of rendered) {
    const { claim, usage } = entry;
    if (!isRenderableClaimStatus(claim.status)) continue;
    if (claim.evidenceSourceId !== null) continue;
    if (isCorroborated(claim, claims)) continue;
    out.push(
      anchoredRisk({
        kind: 'thin_evidence',
        severity: 'low',
        statement: `"${claim.statement}" is confirmed, but no evidence source and no other statement corroborates it.`,
        anchors: [
          {
            source: 'career_claim',
            id: claim.id,
            detail: RISK_ANCHOR_DETAILS.NO_EVIDENCE_SOURCE,
          },
          {
            source: 'career_claim',
            id: claim.id,
            detail: RISK_ANCHOR_DETAILS.NO_CORROBORATING_CLAIM,
          },
          {
            source: 'resume_claim_usage',
            id: usage.claimId,
            detail: RISK_ANCHOR_DETAILS.NO_CORROBORATING_CLAIM,
          },
        ],
        groundedClaimIds: grounded([claim.id]),
        claimId: claim.id,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// `rewritten_bullet` and `overclaim` - the two readings of one change
// ---------------------------------------------------------------------------

/** The numeric part of a metric string, or `null`. `12k` -> 12, `12000s` -> 12000. */
function metricValue(metric: string): number | null {
  const parsed = Number.parseFloat(metric);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * THE TWO RISKS THAT READ THE CHANGE LEDGER AS A REWRITE, and the split between them is the
 * point.
 *
 * `overclaim` is the dishonest one: a number that got BIGGER than every number it replaced.
 * The tailoring guard (E.3 rule 3) blocks that; a risk here says so out loud rather than
 * waiting for the render to be refused.
 *
 * `rewritten_bullet` is the HONEST rewrite - every entity preserved, the framing changed -
 * and it is what a reader will probe because it does not read like the user's own words.
 *
 * `overclaim` REQUIRES `before` to carry at least one metric, and that requirement is what
 * keeps the taxonomy from losing anything: with no metric in `before` there is nothing to
 * exceed, so the case is a fact delta and `inferred_claim` reports it. Every number a change
 * introduces is therefore reported AT LEAST ONCE, and a number that both appears for the
 * first time and exceeds every number before it is reported TWICE - once as "nobody
 * confirmed this figure" and once as "this figure is bigger than the one it replaced", which
 * are two different things an interviewer would ask about. A change that inflated a number
 * AND reworded it produces ONE risk from here, because the metric story is the one a reader
 * must hear first.
 */
function changeRisks(changes: readonly RiskChangeRow[]): DerivedRisk[] {
  const out: DerivedRisk[] = [];

  for (const change of changes) {
    if (!change.accepted) continue;
    if (!isTextChangingOp(change.op as ResumeChangeOp)) continue;
    const before = typeof change.before === 'string' ? change.before : '';
    const after = typeof change.after === 'string' ? change.after : '';
    if (before.trim().length === 0 || after.trim().length === 0) continue;

    const beforeFacts = extractFacts(before);
    const afterFacts = extractFacts(after);

    const beforeMetrics = beforeFacts.metrics
      .map(metricValue)
      .filter((value): value is number => value !== null);
    if (beforeMetrics.length > 0) {
      const largest = Math.max(...beforeMetrics);
      const exceeded = afterFacts.metrics
        .map(metricValue)
        .filter((value): value is number => value !== null && value > largest)
        .sort((a, b) => b - a);
      if (exceeded.length > 0) {
        out.push(
          anchoredRisk({
            kind: 'overclaim',
            severity: 'high',
            statement: `The accepted ${change.op} at ${change.jsonPath} carries ${exceeded.join(', ')}, larger than every number the wording it replaced carried (${beforeMetrics.sort((a, b) => b - a).join(', ')}).`,
            anchors: [
              {
                source: 'resume_change',
                id: change.id,
                detail: RISK_ANCHOR_DETAILS.METRIC_EXCEEDS_BEFORE,
              },
              ...claimAnchors(change.sourceClaimIds, RISK_ANCHOR_DETAILS.METRIC_EXCEEDS_BEFORE),
            ],
            groundedClaimIds: grounded(change.sourceClaimIds),
          }),
        );
        continue;
      }
    }

    const entityPreserving = detectFactDelta(afterFacts, beforeFacts) === null;
    if (!entityPreserving) continue;
    const overlap = wordOverlap(before, after);
    if (overlap >= REWRITTEN_BULLET_OVERLAP_MAX) continue;
    out.push(
      anchoredRisk({
        kind: 'rewritten_bullet',
        severity: overlap < REWRITTEN_BULLET_OVERLAP_HIGH ? 'medium' : 'low',
        statement: `The accepted ${change.op} at ${change.jsonPath} keeps every fact but shares only ${Math.round(overlap * 100)}% of its wording with the line it replaced.`,
        anchors: [
          { source: 'resume_change', id: change.id, detail: RISK_ANCHOR_DETAILS.ACCEPTED_REWRITE },
          { source: 'resume_change', id: change.id, detail: RISK_ANCHOR_DETAILS.MATERIAL_REWORDING },
          { source: 'resume_change', id: change.id, detail: RISK_ANCHOR_DETAILS.ENTITY_PRESERVING },
          ...claimAnchors(change.sourceClaimIds, RISK_ANCHOR_DETAILS.ACCEPTED_REWRITE),
        ],
        groundedClaimIds: grounded(change.sourceClaimIds),
      }),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// `gap`
// ---------------------------------------------------------------------------

/**
 * `gap`: a requirement the match report names UNSUPPORTED.
 *
 * E.4's derivation says "a `must` requirement in `MatchReport.gaps`" and its severity column
 * says "medium/high by importance", which cannot both hold for a single importance. So the
 * rule is the one that satisfies both halves: `must` fires at `high` and `should` fires at
 * `medium`, so the column's second value is real. A `nice`-to-have gap is not an interview
 * risk - nobody opens with the thing they called a bonus - so it is not emitted, and this kind
 * therefore never produces a `low`, matching the column exactly.
 *
 * THE GAP IS REPORTED BY NAME WITH NO EVIDENCE ATTACHED, because there is none. A risk whose
 * statement hinted the user might have it would be the inference E.2 spent four levels
 * preventing. `groundedClaimIds` is empty and that is the honest value: an answer to this
 * question may speak about the REQUIREMENT and never about the person.
 */
function gapRisks(requirements: readonly RiskRequirementRow[]): DerivedRisk[] {
  const out: DerivedRisk[] = [];
  for (const requirement of requirements) {
    if (requirement.level !== 'unsupported') continue;
    const severity: Severity | null =
      requirement.importance === 'must'
        ? 'high'
        : requirement.importance === 'should'
          ? 'medium'
          : null;
    if (severity === null) continue;
    out.push(
      anchoredRisk({
        kind: 'gap',
        severity,
        statement: `"${requirement.text}" is a ${requirement.importance} requirement this job asks for, and nothing in your confirmed evidence covers it.`,
        anchors: [
          {
            source: 'match_gap',
            id: requirement.requirementId,
            detail: RISK_ANCHOR_DETAILS.UNSUPPORTED_REQUIREMENT,
          },
          {
            source: 'requirement',
            id: requirement.requirementId,
            detail: RISK_ANCHOR_DETAILS.REQUIREMENT_IMPORTANCE,
          },
        ],
        groundedClaimIds: [],
        requirementId: requirement.requirementId,
      }),
    );
  }
  return out;
}