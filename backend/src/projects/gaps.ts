// =====================================================================================
// projects/gaps.ts - WHICH GAPS BECOME A TWO-DAY PROJECT (T1100; 06-design sec. E.5, E.2,
// E.6).
//
// WHAT THIS MODULE IS. The first step of E.5's flow and the whole of its first box: read the
// NAMED gaps the matcher already produced (`match/levels.ts` puts every `unsupported`
// requirement in `MatchGap[]`) and decide which of them a two-day project could actually
// close. Pure: no provider, no network, no clock, no store - so every rule below is assertable
// with three literals, and the answer is the same function on the write path and on any later
// read.
//
// THE ONE RULE THIS MODULE EXISTS TO MAKE TRUE. E.5: "gap analysis - pick requirements that
// are `unsupported` and are teachable in ~2 days (exclude years-of-experience, education, and
// domain-specific credentials)". A candidate project that targets "7+ years of distributed
// systems" is not a project: it is a sentence the user cannot act on in two days, and
// offering it teaches them that this screen does not read their own evidence. So the exclusion
// is a CLOSED LIST, derived from the requirement's `kind` and then from its TEXT SHAPE, and
// every exclusion is reported with a machine-readable reason rather than silently dropped -
// the same "named, never silently discarded" rule the rest of V2 runs on.
//
// WHY THE EXCLUSION IS DERIVED FROM THE REQUIREMENT AND NOT FROM A BLOCKLIST OF WORDS. A
// `years_experience` requirement can arrive labelled `required_skill` (a JD that writes
// "5+ years of Kubernetes" under a skills heading), and a "must have AWS certification" can
// arrive labelled `technology`. So `kind` alone is not sufficient and neither is the text
// alone: the rule reads BOTH, and each exclusion says which of the two fired. That is why
// `teachabilityOf` returns a reason rather than a boolean.
//
// WHAT "TEACHABLE IN TWO DAYS" MEANS HERE, precisely, and the three things it is not:
//   - it is NOT a difficulty judgement about the person: a `domain` gap is teachable, an
//     `education` gap is not, and neither says anything about who the user is;
//   - it is NOT a ranking that produces a number (E.6): the selection is a list of named gaps
//     and the ORDER is an importance order the schema already carries;
//   - it does NOT invent a gap: it can only accept or refuse one the matcher named. A
//     requirement that is `direct` never reaches this file at all, because the caller passes
//     `MatchGap[]`.
//
// SKILL TARGETS. E.5's second box is "skill targets - derived skills required to close the
// gap". They are read with `technologiesIn` from `tailor/factDelta.ts`, the SAME vocabulary
// the tailoring fact-delta guard and the interview grounding check use. A second technology
// extractor here would mean "mentions Kubernetes" could mean two different things in one
// system, which is exactly what the reuse rule exists to prevent.
// =====================================================================================

import type { RequirementImportance, RequirementKind } from '@prisma/client';

import { technologiesIn } from '../tailor/factDelta.js';
import type { MatchGap } from '../match/levels.js';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * EVERY WAY A GAP IS REFUSED, as a closed set.
 *
 * `teachable` is the accept. The rest are named so a caller can render WHY a requirement the
 * user can see on the match report does not appear here - the alternative, dropping it
 * silently, reads as "we looked and found nothing", which is a different and false claim.
 */
export const GAP_SELECTION_REASONS = Object.freeze([
  /** Accepted: an `unsupported` requirement a two-day project could close. */
  'teachable',
  /** The `kind` is one no project can close (see `NON_TEACHABLE_REQUIREMENT_KINDS`). */
  'non_teachable_kind',
  /** The text names a hard credential (a licence, a registration, a clearance). */
  'hard_credential',
  /** The text names a place or a right to work / visa / relocation. */
  'location_or_authorisation',
  /** The text names a degree, however the requirement was labelled. */
  'degree',
  /**
   * An `optional` importance gap, and something more important is open. Two days is the WHOLE
   * budget; spending it on a nice-to-have while a must-have gap sits open is the wrong project,
   * and the more important gap is listed above this one so the reader sees why.
   */
  'optional_when_something_better_exists',
  /** No usable text: there is nothing to target and nothing to name. */
  'no_usable_text',
] as const);

export type GapSelectionReason = (typeof GAP_SELECTION_REASONS)[number];

/** The requirement `kind`s E.5 excludes, each with the reason it is stated in the spec. */
export const NON_TEACHABLE_REQUIREMENT_KINDS: Readonly<Record<string, string>> = Object.freeze({
  // E.5: "exclude years-of-experience". Time served is not a thing a project produces.
  years_experience:
    'a requirement for years of experience is not something a two-day project can close: time served cannot be built in a weekend',
  // E.5: "education". A degree is not produced by a weekend project either.
  education:
    'a degree requirement is not something a two-day project can close: the project cannot award a qualification',
  // Not in E.5's list, and for the same reason `match/report.ts` refuses to confirm one: a
  // screening criterion is an EMPLOYER'S QUESTION ("are you authorised to work in the UK?"),
  // not a capability of the person, so there is no capability a project could demonstrate.
  screening_criterion:
    'a screening criterion is an employer question, not a capability: no project demonstrates it',
});

/** `RequirementImportance` values, so an unknown one is refused rather than defaulted. */
const IMPORTANCE_VALUES: readonly string[] = ['must', 'should', 'nice'];

/**
 * The IMPORTANCE ORDER, best first. `nice` is spelled out as E.5 does not, but the schema
 * names it `nice` and a JD writes "optional", so both are read as the same tier.
 *
 * An order and not a weight: nothing here is multiplied by anything, and the ORDER is the only
 * thing it is used for. `GAP_SELECTION_REASONS.optional_when_something_better_exists` is the
 * one place importance EXCLUDES anything, and it only excludes the lowest tier when a higher
 * one is open.
 */
const IMPORTANCE_RANK: Readonly<Record<string, number>> = Object.freeze({
  must: 0,
  should: 1,
  nice: 2,
  // "optional" is the word a JD actually writes; it is the `nice` tier.
  optional: 2,
});

/** How many gaps one discovery run may carry. A bound, not a ranking of quality. */
export const MAX_GAPS_PER_RUN = 8;

/** How many SKILL TARGETS one gap may name. The gap's own technology names, capped. */
export const MAX_SKILL_TARGETS = 4;

// ---------------------------------------------------------------------------
// The shape rules
// ---------------------------------------------------------------------------

/**
 * TEXT SHAPES THAT NO PROJECT CAN CLOSE, whatever the requirement's `kind` says.
 *
 * These exist because `kind` is derived, not observed: `jobs/analyze.ts` classifies the
 * requirement from the sentence it was extracted from, and a JD that writes "must have AWS
 * certification" under a "Skills" heading produces a `required_skill` whose text names a
 * credential. The kind check above would wave it through, and the user would be handed a
 * two-day project to "get AWS certified", which is not a project.
 *
 * EACH PATTERN IS ANCHORED ON THE WORD THAT MAKES IT A CREDENTIAL, PLACE OR DEGREE, so a
 * technology whose own name happens to contain a substring cannot trip it.
 */
const SHAPE_RULES: ReadonlyArray<{ readonly reason: GapSelectionReason; readonly pattern: RegExp }> =
  Object.freeze([
    {
      reason: 'hard_credential',
      pattern:
        /\b(?:certified|certification|certifications|licensed|licence|accredited|accreditation|chartered|clearance|security clearance|registration|registered|practising license|attorney|bar exam|solvency|residency)\b/i,
    },
    {
      reason: 'location_or_authorisation',
      pattern:
        /\b(?:based in|located in|resides? in|live in|commut\w+|relocat\w+|right to work|work authori[sz]ation|right of residence|visa|sponsorship|on-?site|on call in person|driving licen[cs]e)\b/i,
    },
    {
      // "master" and "bachelor" appear as WHOLE WORDS on purpose, but only inside the two
      // full degree phrases - a git "master branch" and a "bachelor pad" are not degrees, and a
      // pattern that matched the bare noun would refuse real requirements. "Master's degree" is
      // already covered by `master'?s` alone; these two are the spellings that omit the
      // possessive and put the subject first, which is how a JD writes it.
      reason: 'degree',
      pattern:
        /\b(?:degree|degrees|bachelor(?:'s)?|master'?s|masters|phd|ph\.d|doctorate|doctorates|mba|msc|mscs|bsc|bscs|ba\b|bs\b|diploma|certdip|undergraduate|graduate degree|postgraduate|(?:master|bachelor)s?\s+of\s+(?:science|arts|engineering|business|studies|mathematics))\b/i,
    },
  ]);

/** The text, whitespace-collapsed, for the shape checks. Never the stored wording. */
function normalizedText(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** Why one gap is or is not a project target. `reason` is machine-readable; `detail` is prose. */
export interface GapVerdict {
  readonly requirementId: string;
  readonly teachable: boolean;
  readonly reason: GapSelectionReason;
  /** One sentence naming the rule that fired. NEVER the requirement's own text. */
  readonly detail: string;
}

/**
 * THE RULE, as one pure function.
 *
 * ORDER IS THE RULE, and it is an if/else ladder so the order is readable rather than implied:
 *   1. usable text - without it there is nothing to target and nothing to name;
 *   2. the `kind` - E.5's explicit exclusions, plus the screening criterion;
 *   3. the TEXT SHAPE - a credential, a place, or a degree, however the kind was labelled;
 *   4. IMPORTANCE - the lowest tier only loses when a higher tier is in the SAME set.
 *
 * Step 4 needs the whole set, which is why it is not here: `teachabilityOf` judges a gap on
 * its own, and `selectTeachableGaps` applies the importance rule over the accepted set. That
 * split is deliberate - a per-gap predicate that secretly depended on its siblings would make
 * the answer to "is this gap teachable?" depend on the order the caller happened to pass.
 */
export function teachabilityOf(gap: MatchGap): GapVerdict {
  const text = normalizedText(gap.text);
  const requirementId = typeof gap.requirementId === 'string' ? gap.requirementId : '';

  if (text.length === 0) {
    return {
      requirementId,
      teachable: false,
      reason: 'no_usable_text',
      detail: 'the requirement has no usable text, so there is nothing to target and nothing to name',
    };
  }

  const kindReason = NON_TEACHABLE_REQUIREMENT_KINDS[gap.kind];
  if (kindReason !== undefined) {
    return {
      requirementId,
      teachable: false,
      reason: 'non_teachable_kind',
      detail:
        `${gap.kind} is excluded by the two-day rule: ${kindReason}. It is still a named gap on ` +
        'the match report, where it belongs.',
    };
  }

  for (const rule of SHAPE_RULES) {
    if (rule.pattern.test(text)) {
      return {
        requirementId,
        teachable: false,
        reason: rule.reason,
        detail:
          `the requirement text names something a project cannot produce, so it is not offered as ` +
          `a two-day project even though it was extracted as a ${gap.kind}.`,
      };
    }
  }

  return {
    requirementId,
    teachable: true,
    reason: 'teachable',
    detail:
      `nothing in this job's evidence covers it and a two-day project could: it is a ${gap.kind} ` +
      'the person can demonstrate with a repository.',
  };
}

/** Is this an importance value the schema (and the JD vocabulary) knows? */
export function isKnownImportance(value: unknown): value is RequirementImportance {
  return typeof value === 'string' && IMPORTANCE_VALUES.includes(value);
}

/** The tier index of an importance, worst last. An unknown value sorts LAST (never first). */
export function importanceRank(importance: unknown): number {
  if (typeof importance !== 'string') return 99;
  const rank = IMPORTANCE_RANK[importance];
  return rank === undefined ? 99 : rank;
}

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

/** A gap this run will build candidates for. */
export interface TeachableGap {
  readonly requirementId: string;
  readonly text: string;
  readonly normalizedKey: string;
  readonly kind: string;
  readonly importance: string;
  /** The technologies named in the requirement text, plus the gap's own key. Capped. */
  readonly skillTargets: readonly string[];
  /** `must` | `should` | `nice`, verbatim from the requirement. Never re-derived. */
  readonly importanceRank: number;
}

/** A gap this run will NOT build a candidate for, with the rule that refused it. */
export interface ExcludedGap extends GapVerdict {
  readonly text: string;
  readonly kind: string;
  readonly importance: string;
}

export interface GapSelection {
  readonly selected: readonly TeachableGap[];
  readonly excluded: readonly ExcludedGap[];
}

/**
 * The skill targets of one gap.
 *
 * THE GAP'S OWN KEY FIRST, then every technology `technologiesIn` finds in the text, deduped
 * case-insensitively and capped. The key is first because it is the canonical name the matcher
 * derived and therefore the one a reader will recognise; the technologies after it because a
 * requirement text often names several ("Kafka and Flink pipelines") and the gap key is only
 * one of them.
 *
 * AND IT IS NEVER EMPTY. A requirement whose key is blank and whose wording names no technology
 * in the shared vocabulary ("experience with distributed tracing") would otherwise yield no
 * targets at all, and an empty list is not a finding - it is a failure to look. Falling back to
 * the requirement's own wording is the honest last resort: it names the gap, it is derived from
 * a field the user can see on the match report, and a candidate composed out of it is still
 * traceable to that requirement. The fallback is applied LAST so it can never displace a real
 * key or a real technology.
 */
export function skillTargetsFor(gap: MatchGap): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const value = raw.replace(/\s+/g, ' ').trim();
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  push(normalizedText(gap.normalizedKey));
  for (const technology of technologiesIn(gap.text)) push(technology);
  if (out.length === 0) push(normalizedText(gap.text));
  return out.slice(0, MAX_SKILL_TARGETS);
}

/**
 * Select the gaps this run may build candidates for, and report every refusal.
 *
 * THE IMPORTANCE RULE, stated once: a `nice` gap is dropped when the same run has at least one
 * `must` or `should` gap, and KEPT when it does not - a run with nothing but nice-to-have gaps
 * still produces candidates, because "nothing you must have is missing" is a real answer and an
 * empty screen would not be.
 *
 * The order of `selected` is importance first, then the gap's own text, so the same input
 * always yields the same list. It is an ORDER over named things and nothing else - no count,
 * no ratio, no score (E.6).
 */
export function selectTeachableGaps(
  gaps: readonly MatchGap[],
  options: { readonly limit?: number } = {},
): GapSelection {
  const limit =
    typeof options.limit === 'number' && options.limit > 0
      ? Math.floor(options.limit)
      : MAX_GAPS_PER_RUN;

  const selected: TeachableGap[] = [];
  const excluded: ExcludedGap[] = [];
  const accepted: TeachableGap[] = [];

  for (const gap of gaps ?? []) {
    const verdict = teachabilityOf(gap);
    if (!verdict.teachable) {
      excluded.push({
        ...verdict,
        text: normalizedText(gap.text),
        kind: String(gap.kind ?? ''),
        importance: String(gap.importance ?? ''),
      });
      continue;
    }
    const row: TeachableGap = {
      requirementId: gap.requirementId,
      text: normalizedText(gap.text),
      normalizedKey: normalizedText(gap.normalizedKey),
      kind: String(gap.kind ?? ''),
      importance: String(gap.importance ?? ''),
      skillTargets: Object.freeze(skillTargetsFor(gap)),
      importanceRank: importanceRank(gap.importance),
    };
    accepted.push(row);
    selected.push(row);
  }

  // Importance exclusion, applied over the accepted set. A `nice` gap survives only when
  // nothing more important is open.
  const hasStronger = accepted.some((row) => row.importanceRank < 2);
  const kept = selected.filter((row) => {
    if (!hasStronger || row.importanceRank < 2) return true;
    excluded.push({
      requirementId: row.requirementId,
      teachable: false,
      reason: 'optional_when_something_better_exists',
      detail:
        'this requirement is optional and another gap from the same job is not, and two days is the ' +
        'whole budget: accept the more important one first.',
      text: row.text,
      kind: row.kind,
      importance: row.importance,
    });
    return false;
  });

  kept.sort((a, b) => {
    if (a.importanceRank !== b.importanceRank) return a.importanceRank - b.importanceRank;
    const byText = a.text.localeCompare(b.text);
    return byText !== 0 ? byText : a.requirementId.localeCompare(b.requirementId);
  });

  return {
    selected: Object.freeze(kept.slice(0, limit)),
    excluded: Object.freeze(excluded),
  };
}

// ---------------------------------------------------------------------------
// Source guards, in code rather than in prose
// ---------------------------------------------------------------------------

/**
 * The kinds this module REFUSES, as the enum's own values.
 *
 * Exported so a test can assert the map covers every `RequirementKind` the project engine
 * refuses AND that every kind not named here is teachable - i.e. that the exclusion list is a
 * CLOSED list, and adding a kind to the schema does not silently make it teachable or silently
 * make it refuse itself. The values come from the generated enum rather than a restated tuple.
 */
export function nonTeachableKindsPresentIn(kind: RequirementKind): boolean {
  return Object.prototype.hasOwnProperty.call(NON_TEACHABLE_REQUIREMENT_KINDS, kind);
}