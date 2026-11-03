// =====================================================================================
// match/levels.ts - the FOUR evidence levels, derived (T1070; 06-design sec. E.2, E.6).
//
// WHAT THIS MODULE IS. A pure function from (requirements, claims, potential matches) to
// one evidence level per requirement, plus the counts and the NAMED gaps. No I/O, no
// clock, no model, no store - so every rule below is assertable in a unit test with three
// literals, and the same function is the single definition of "direct" for the write path
// (`match/report.ts`) and the read path.
//
// THE FOUR BUCKETS (E.2's table, verbatim):
//   direct       - a CONFIRMED claim states exactly this requirement. Produced by the
//                  deterministic join on `normalizedKey`. Needs no confirmation: the claim
//                  is already confirmed.
//   contextual   - a CONFIRMED claim implies it without naming it. A proposal, not a fact.
//   potential    - plausible from the profile, no confirming claim. A proposal, not a fact.
//   unsupported  - no evidence at all. Reported as a NAMED GAP, never as a deduction.
//
// THE ONE RULE THAT MAKES THIS HONEST (E.2 "Invariants"):
//   "Contextual/potential never count as direct in the report until confirmed."
// It is not a promise in prose - it is the ORDER of the checks below. A pending
// `PotentialMatch` can only ever produce `contextual` or `potential`, and a requirement
// reaches `direct` through exactly two doors: a confirmed claim joins on `normalizedKey`,
// or the user CONFIRMED a potential match (which created that confirmed claim). There is
// no third path, and mutation (a) in the T1070 note is the evidence that it holds.
//
// NO SCORE, NO PERCENTAGE, NO WEIGHT (E.6). This module computes FOUR INTEGERS and a list
// of names. `JobRequirement.weight` is deliberately NOT read: the schema calls it a
// "display weight, not a score component", and reading it here would be the first step
// towards the single number E.6 forbids. The counts are not weighted by importance and
// are never combined into anything.
//
// REUSE, NOT A SECOND OPINION. The join key is `normalizedKeyFor` from
// `jobs/requirements.ts` - the SAME function that derived `JobRequirement.normalizedKey`
// at analysis time, so both sides of the join are computed by one rule and cannot drift.
// "Is this claim confirmed?" is `isRenderableClaimStatus` from `career/claimUsage.ts`, the
// career layer's own predicate; this module deliberately never names a confirming status
// literal (`career/claimWriterAI.test.ts` guards that), because the career layer owns that
// vocabulary and a second spelling of it here would be a second thing to keep in step.
// =====================================================================================

import type { ClaimKind, ClaimStatus, EvidenceLevel } from '@prisma/client';
import { isRenderableClaimStatus } from '../career/claimUsage.js';
import { findLiteralOccurrence, normalizedKeyFor } from '../jobs/requirements.js';
import { SKILL_SYNONYMS, normalizeKeyword } from '../evaluation/matcher.js';
import { ROLE_KEYWORD_BANKS } from '../jobSources/roleKeywords.js';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The four buckets, in the order the UI shows them. Sourced from the Prisma enum rather
 * than re-spelled, so a level the schema adds cannot be missing here.
 */
export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  'direct',
  'contextual',
  'potential',
  'unsupported',
];

/** The two levels that are PROPOSALS. Neither is ever a fact until the user confirms. */
export const PROPOSED_EVIDENCE_LEVELS: readonly EvidenceLevel[] = ['contextual', 'potential'];

/** What the client is asked to do about a requirement (E.6's `action`). */
export type MatchAction = 'none' | 'confirm_or_reject';

/** `PotentialMatch.status`. `unsupported` never appears here (E.2, schema comment). */
export type PotentialStatus = 'pending' | 'confirmed' | 'rejected';

// ---------------------------------------------------------------------------
// Inputs (the narrowest shape each side needs)
// ---------------------------------------------------------------------------

/** A `JobRequirement` row, as the join reads it. */
export interface MatchRequirementRow {
  id: string;
  kind: string;
  importance: string;
  text: string;
  normalizedKey: string;
}

/** A `CareerClaim` row, as the join reads it. Status is judged by the career layer. */
export interface MatchClaimRow {
  id: string;
  statement: string;
  kind: ClaimKind;
  status: ClaimStatus;
}

/** A `PotentialMatch` row. `status` is a string because the column is a string. */
export interface MatchPotentialRow {
  id: string;
  requirementId: string;
  claimId: string | null;
  level: EvidenceLevel;
  status: PotentialStatus | string;
  proposedEvidence: string;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** One confirmed claim backing a `direct` requirement. Named, never summarised. */
export interface LevelEvidence {
  claimId: string;
  statement: string;
  kind: ClaimKind;
  status: ClaimStatus;
  /** How this claim reached this requirement: `normalized_key_join` or `confirmed_match`. */
  via: 'normalized_key_join' | 'confirmed_match';
}

export interface RequirementLevel {
  requirementId: string;
  kind: string;
  importance: string;
  text: string;
  normalizedKey: string;
  level: EvidenceLevel;
  evidence: LevelEvidence[];
  /** The proposal covering this requirement, when one exists (any status). */
  potentialMatch: {
    id: string;
    level: EvidenceLevel;
    status: string;
    claimId: string | null;
    proposedEvidence: string;
    rationale: string;
  } | null;
  action: MatchAction;
}

/** The four integer counts plus the total. `total` is a SUM OF COUNTS, not a rating. */
export interface RequirementCounts {
  direct: number;
  contextual: number;
  potential: number;
  unsupported: number;
  total: number;
}

/** A named gap: E.6 requires the absence of evidence to be NAMED, never scored. */
export interface MatchGap {
  requirementId: string;
  normalizedKey: string;
  text: string;
  kind: string;
  importance: string;
}

export interface EvidenceLevels {
  requirements: RequirementLevel[];
  counts: RequirementCounts;
  gaps: MatchGap[];
}

export interface DeriveLevelsInput {
  requirements: readonly MatchRequirementRow[];
  /** Every claim of the profile. Non-confirmed ones are ignored here, not deleted. */
  claims: readonly MatchClaimRow[];
  potentialMatches: readonly MatchPotentialRow[];
}

// ---------------------------------------------------------------------------
// The join key
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The specificity gate: a form must NAME something before it may join
// ---------------------------------------------------------------------------

/**
 * Ordinary-English words that the shipped role banks also use as technology keywords.
 *
 * Each entry is here because its EVERYDAY use in a CV or a claim is at least as likely as
 * its technical use, and the everyday sentence is a routine one:
 *   `rest`       - "owned the rest of the migration" (the paradigm case: `findLiteralOccurrence`
 *                  is case-insensitive, so `REST` in a claim and `rest` in a JD are the same
 *                  match, and word boundaries cannot help when the whole word IS the ambiguity)
 *   `brand`      - "managed the brand for three products"
 *   `campaigns`  - "ran campaigns in two markets"
 *   `reporting`  - "reporting to the Head of Sales"
 *
 * This is a CLOSED list and it is a judgement, which is why it is written down where the
 * next reader can disagree with it: a new ambiguous word is added HERE with a test, not
 * smuggled in by a length rule that would take the short technologies with it.
 */
export const AMBIGUOUS_FORMS: ReadonlySet<string> = new Set([
  'brand',
  'campaigns',
  'reporting',
  'rest',
]);

/**
 * A form shorter than this is not a named thing. In the shipped vocabulary that is exactly
 * one entry - `r`, the data-analyst language - and "worked in R&D" or "Python/R" would join
 * an `r` requirement. It is refused as a CLAIM-SIDE form; a confirmed claim whose whole
 * statement is the term itself still joins through the whole-statement check at the top of
 * `claimJoinKeys`.
 */
const MIN_SPECIFIC_FORM_CHARS = 2;

/**
 * May this surface form be looked for in a claim's text?
 *
 * WHY THE GATE EXISTS AT ALL. The role banks are keyword SUGGESTIONS for a job description,
 * so they legitimately contain ordinary English words, and a word-boundary match cannot tell
 * "REST services" from "the rest of the migration". The over-join is the dangerous direction
 * because it INFLATES `direct` - the one bucket that is asserted rather than proposed (see
 * the ladder in `deriveEvidenceLevels`). Refusing the form instead sends such a requirement
 * to `unsupported`, which is a NAMED GAP the user can see and act on: fail-closed, in the
 * direction E.2 asks for.
 *
 * WHY IT CANNOT SWALLOW A LEGITIMATE JOIN. The index exists to catch SPELLINGS (`k8s` for
 * `kubernetes`) and CONTEXT ("Wrote Go services"). A claim that STATES the requirement
 * outright is joined by the whole-statement check in `claimJoinKeys` regardless of this
 * gate, because that check needs no vocabulary at all. So what is lost here is only the
 * accidental matches.
 *
 * WHAT IS DELIBERATELY KEPT. `go`, `api`, `sql`, `aws`, `gcp`, `ml` and every other short
 * technology name stay in the index: removing them would delete legitimate joins outright
 * (`levels.test.ts` pins that "Wrote Go services for payments" joins the key `go`). The trade
 * is accepted on purpose - an over-join on `go` needs an unusual sentence ("go-to-market",
 * "go live"), while an over-join on `rest` needs the most ordinary sentence there is. A
 * MULTI-WORD phrase is never refused either: `data analysis` and `system design` are ordinary
 * words too, but a phrase names a competency, and only a BARE word is ambiguous.
 */
export function isSpecificSurfaceForm(form: string): boolean {
  return form.length >= MIN_SPECIFIC_FORM_CHARS && !AMBIGUOUS_FORMS.has(form);
}

/**
 * Every SURFACE FORM that means a canonical key: the key itself plus each member of its
 * synonym family plus each role-bank alias that canonicalizes onto it.
 *
 * WHY THIS EXISTS, AND WHY IT IS BUILT FROM THE SAME TWO TABLES `jobs/requirements.ts`
 * READS. `normalizedKeyFor` canonicalizes ONE term (`k8s` -> `kubernetes`). A claim is a
 * sentence - "Ran K8s in production" - and canonicalizing the whole sentence yields
 * "ran k8s in production", which is not a requirement's key and joins nothing. So the join
 * runs the other way: for each REQUIREMENT key, ask whether the claim's text contains one
 * of its spellings as a STANDALONE phrase.
 *
 * That is `findLiteralOccurrence` doing the word-boundary work - the same
 * fail-closed rule T1060 uses to re-verify the vocabulary, and the reason "go" does not
 * match "MongoDB" - with the key derived by the same `normalizedKeyFor`. Neither the
 * synonym table nor the role banks are re-spelled here; both are read from the modules that
 * own them.
 */
const SURFACE_FORMS: ReadonlyMap<string, readonly string[]> = buildSurfaceForms();

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

function buildSurfaceForms(): ReadonlyMap<string, readonly string[]> {
  const byKey = new Map<string, Set<string>>();
  const add = (key: string, form: string): void => {
    // The KEY is canonicalized (`k8s` and `kubernetes` share one entry); the FORM is not
    // (a literal search for "kubernetes" would never find "K8s" in a claim). Canonicalizing
    // the form too would collapse every synonym onto its head and silently reduce the whole
    // join to "does the claim say the canonical spelling".
    const normalizedKey = normalizedKeyFor(key);
    const normalizedForm = normalizeKeyword(form);
    if (normalizedKey.length === 0 || normalizedForm.length === 0) return;
    // The SPECIFICITY GATE. An ambiguous or sub-word-length form never enters the index, so
    // no claim can join a requirement through it; the requirement falls to `unsupported`.
    if (!isSpecificSurfaceForm(normalizedForm)) return;
    const bucket = byKey.get(normalizedKey) ?? new Set<string>();
    bucket.add(normalizedForm);
    byKey.set(normalizedKey, bucket);
  };

  for (const [canonical, synonyms] of Object.entries(SKILL_SYNONYMS)) {
    add(canonical, canonical);
    for (const synonym of synonyms) add(canonical, synonym);
  }
  for (const bank of Object.values(ROLE_KEYWORD_BANKS)) {
    for (const term of [...bank.critical, ...bank.preferred]) {
      add(term, term);
      const alias = bank.aliases?.[term];
      if (alias) add(term, alias);
    }
  }

  return new Map([...byKey.entries()].map(([key, forms]) => [key, [...forms].sort()] as const));
}

/**
 * Every requirement key this claim's text states outright.
 *
 * Each key is checked against every spelling of it, so "K8s", "Kubernetes" and "Kubernetes
 * container orchestration" all resolve to the family head `kubernetes` when the family head
 * is the requirement - while a multi-word requirement ("years of experience", a
 * responsibility phrase) is checked against its OWN text, because no synonym table has an
 * entry for it. An empty result is the common, correct case: most sentences name no
 * requirement at all, and the direct bucket must stay small for that reason.
 *
 * THE FIRST CHECK IS NOT THE INDEX, and that ordering is what makes the specificity gate
 * affordable: a claim whose own normalized text IS the key joins with no vocabulary at all.
 * So a claim that STATES "REST" still makes a `rest` requirement `direct`, and what the gate
 * removes is only the accidental match - "the rest of the migration" - which is the whole
 * point of removing it.
 */
export function claimJoinKeys(statement: string): string[] {
  const text = typeof statement === 'string' ? statement : '';
  if (text.trim().length === 0) return [];
  const keys = new Set<string>();
  const direct = normalizedKeyFor(text);
  if (findLiteralOccurrence(text, direct) !== null) keys.add(direct);
  for (const [key, forms] of SURFACE_FORMS) {
    if (forms.some((form) => findLiteralOccurrence(text, form) !== null)) keys.add(key);
  }
  return [...keys];
}

/**
 * The join key for a requirement, i.e. the canonical form of its own text. Exported
 * because it is the SAME function the analysis used to write `normalizedKey`, and a test
 * that compares the two sides of the join is worth being able to write.
 */
export function requirementJoinKey(text: string): string {
  return normalizedKeyFor(typeof text === 'string' ? text : '');
}

/** Is this claim one the user has confirmed? The career layer owns that answer. */
export function isConfirmedClaim(claim: MatchClaimRow): boolean {
  return isRenderableClaimStatus(claim.status);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function emptyCounts(): RequirementCounts {
  return { direct: 0, contextual: 0, potential: 0, unsupported: 0, total: 0 };
}

/** A `PotentialMatch.status` read as one of the three values the schema documents. */
function potentialStatus(value: string): PotentialStatus | null {
  return value === 'pending' || value === 'confirmed' || value === 'rejected' ? value : null;
}

/**
 * Index the claims by join key ONCE, keeping only the confirmed ones.
 *
 * Rejected and unconfirmed claims are EXCLUDED, not down-weighted: a rejected claim is the
 * user saying "that is not my experience" (ADR-036 item 5), so letting it support a
 * requirement would invert the decision they just made.
 */
function indexConfirmedClaims(claims: readonly MatchClaimRow[]): Map<string, MatchClaimRow[]> {
  const index = new Map<string, MatchClaimRow[]>();
  for (const claim of claims) {
    if (!isConfirmedClaim(claim)) continue;
    for (const key of claimJoinKeys(claim.statement)) {
      const bucket = index.get(key);
      if (bucket) bucket.push(claim);
      else index.set(key, [claim]);
    }
  }
  return index;
}

/**
 * The single derivation.
 *
 * Order of the checks is the whole design, so it is written as an if/else ladder with the
 * two `direct` doors first and no early return that could reorder them:
 *
 *   1. A CONFIRMED potential match (the user pressed Confirm) - direct. The claim that
 *      confirm created is a confirmed claim, and it is named in `evidence`, so `direct` is
 *      never asserted without naming the claim that carries it.
 *   2. A CONFIRMED claim whose join key equals the requirement's - direct.
 *   3. A PENDING proposal - reported at the level it proposes (contextual | potential).
 *      NEVER direct, whatever the proposal says and however confident its rationale reads.
 *   4. Anything else - unsupported, and therefore a named gap. A REJECTED proposal lands
 *      here on purpose: rejecting is a decision, and its consequence is that the
 *      requirement is a gap the user can see and act on.
 */
export function deriveEvidenceLevels(input: DeriveLevelsInput): EvidenceLevels {
  const requirements = input.requirements ?? [];
  const claims = input.claims ?? [];
  const potentialMatches = input.potentialMatches ?? [];

  const confirmedByKey = indexConfirmedClaims(claims);
  const claimsById = new Map(claims.map((claim) => [claim.id, claim] as const));

  // One proposal per requirement: the newest row wins, so a re-run that proposes again
  // supersedes the previous proposal instead of stacking duplicates on one requirement.
  const proposalByRequirement = new Map<string, MatchPotentialRow>();
  for (const row of [...potentialMatches].sort((a, b) => a.id.localeCompare(b.id))) {
    proposalByRequirement.set(row.requirementId, row);
  }

  const counts = emptyCounts();
  const derived: RequirementLevel[] = [];
  const gaps: MatchGap[] = [];

  for (const requirement of requirements) {
    const proposal = proposalByRequirement.get(requirement.id) ?? null;
    const proposalState = proposal ? potentialStatus(proposal.status) : null;

    // ONE key per requirement: the stored `normalizedKey`, and only that. Re-deriving it
    // from the text as a second attempt would let two requirements with the same text and
    // different keys both join the same claim, which is an over-join in the direction that
    // inflates `direct`. The key is trustworthy because `jobs/analyze.ts` derived it from
    // the text with this same function.
    const evidence: LevelEvidence[] = [];
    for (const claim of confirmedByKey.get(requirement.normalizedKey) ?? []) {
      evidence.push({
        claimId: claim.id,
        statement: claim.statement,
        kind: claim.kind,
        status: claim.status,
        via: 'normalized_key_join',
      });
    }

    // Door 1: the user confirmed this proposal. The claim it created (or the claim it
    // pointed at, when that claim is itself confirmed) is named even if its wording does
    // not join on the key - the evidence is "you told us you have this", not "the words
    // matched".
    if (proposalState === 'confirmed' && proposal?.claimId) {
      const claim = claimsById.get(proposal.claimId);
      if (claim && isConfirmedClaim(claim) && !evidence.some((row) => row.claimId === claim.id)) {
        evidence.push({
          claimId: claim.id,
          statement: claim.statement,
          kind: claim.kind,
          status: claim.status,
          via: 'confirmed_match',
        });
      }
    }

    let level: EvidenceLevel;
    if (evidence.length > 0) {
      level = 'direct';
    } else if (
      proposalState === 'pending' &&
      proposal &&
      (proposal.level === 'contextual' || proposal.level === 'potential')
    ) {
      // Door 3. The proposal is a HYPOTHESIS. It is reported, it is actionable, and it is
      // not evidence: nothing here can turn it into `direct`.
      level = proposal.level;
    } else {
      // Door 4, which also covers a rejected proposal and a proposal row that claims a
      // level outside {contextual, potential} - a row nobody can act on must not silently
      // promote a requirement out of the gaps.
      level = 'unsupported';
    }

    counts[level] += 1;
    counts.total += 1;

    if (level === 'unsupported') {
      gaps.push({
        requirementId: requirement.id,
        normalizedKey: requirement.normalizedKey,
        text: requirement.text,
        kind: requirement.kind,
        importance: requirement.importance,
      });
    }

    derived.push({
      requirementId: requirement.id,
      kind: requirement.kind,
      importance: requirement.importance,
      text: requirement.text,
      normalizedKey: requirement.normalizedKey,
      level,
      evidence,
      potentialMatch: proposal
        ? {
            id: proposal.id,
            level: proposal.level,
            status: proposal.status,
            claimId: proposal.claimId,
            proposedEvidence: proposal.proposedEvidence,
            rationale: proposal.rationale,
          }
        : null,
      action: level === 'contextual' || level === 'potential' ? 'confirm_or_reject' : 'none',
    });
  }

  return { requirements: derived, counts, gaps };
}

/**
 * The four counters as a plain object, for the `MatchReport` columns.
 *
 * A thin projection rather than a second count: the columns and the response body are the
 * SAME numbers, so they cannot drift apart, and there is no arithmetic here beyond the
 * total the derivation already counted.
 */
export function countsForPersistence(counts: RequirementCounts): {
  directCount: number;
  contextualCount: number;
  potentialCount: number;
  unsupportedCount: number;
  totalRequirements: number;
} {
  return {
    directCount: counts.direct,
    contextualCount: counts.contextual,
    potentialCount: counts.potential,
    unsupportedCount: counts.unsupported,
    totalRequirements: counts.total,
  };
}

/**
 * Every count is a whole number of named things.
 *
 * Exported so the invariant is testable without re-reading the source: a fractional or
 * negative count means something upstream started weighting, which E.6 forbids.
 */
export function countsAreWholeNumbers(counts: RequirementCounts): boolean {
  return EVIDENCE_LEVELS.every((level) => {
    const value = counts[level];
    return Number.isInteger(value) && value >= 0;
  }) && Number.isInteger(counts.total) && counts.total >= 0;
}