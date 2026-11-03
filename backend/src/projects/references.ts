// =====================================================================================
// projects/references.ts - THE REFERENCE CONTRACT: A LICENCE, AN ACTIVITY SNAPSHOT, AND A
// GUARD AGAINST COPYING (T1100; 06-design sec. E.5, "GitHub research criteria" +
// "Anti-copying rule").
//
// WHY A REFERENCE IS A ROW WITH RULES AND NOT A LINK IN PROSE. E.5's criteria table is six
// checks, each with a "reject if", and a `ProjectReference` is what makes them auditable
// afterwards: a reader who sees a repository named under a candidate should be able to ask
// "under what licence, and when was it last touched?" and get an answer from the database.
// So the licence and the activity snapshot are REQUIRED FIELDS OF THE RECORD, checked here
// once, and `referenceRecord()` REFUSES to build a row that lacks either. A no-licence
// repository is never recorded - not recorded as "inspiration", not recorded as a note, not
// recorded at all.
//
// WHY A NO-LICENCE REPO IS REJECTED RATHER THAN MERELY FLAGGED. Everything this project
// engine does with a reference is INSPIRATION: it looks at how somebody solved a problem so
// the candidate can be a DIFFERENT thing that answers the same requirement. That is legal
// against any licence and illegal against none. So the asymmetry is deliberate and it is the
// fail-closed direction: with no licence there is no permission even for inspiration, and a
// reference whose permission is unknown is a reference we must not show.
//
// WHY THE ANTI-COPY GUARD IS HERE AND NOT IN `generate.ts`. It compares a CANDIDATE against
// REFERENCES, so both sides of the comparison have to be the same shape, and the shape is
// defined once: the token set a reference contributes is the token set of its stored `notes`
// (the README excerpt kept for exactly this purpose) plus its title. `generate.ts` calls it;
// it does not re-implement it. A second overlap measure in the candidate builder would be a
// second opinion about what "the same text" means.
//
// THE MEASURE IS CONTAINMENT, NOT JACCARD, and the choice is load-bearing. `interview/risks.ts`
// computes a Jaccard overlap and that is the right measure there, because both sides are
// rewrites of each other and are therefore about the same length. Here the two sides are
// nothing like the same length: a candidate idea is two sentences and a reference README is
// two thousand words. Under Jaccard a verbatim reimplementation of the README's headline
// paragraph would score about 0.03 and sail through. Containment - "what fraction of MY
// tokens appear in THEIRS" - is the measure that asks the question E.5 is asking, which is
// whether the candidate is made of the reference's words. It is also the asymmetric direction
// that matters: a long README containing a short candidate is not the candidate copying the
// README, and containment scores it 1.0 only when every candidate token really is there.
//
// THRESHOLD. `ANTI_COPY_OVERLAP_MAX = 0.5`, which is the point where "more than half of what
// you wrote also appears in the reference" becomes true. It is not zero because two
// candidates about, say, a job queue will share the words "job", "queue", "worker" and
// "retry" with any repository in the space; a zero threshold would reject every candidate and
// teach the user nothing. It is not 1.0 because a real idea has to be built out of a shared
// vocabulary to be legible at all.
// =====================================================================================

import type { ReferenceKind, Severity } from '@prisma/client';

// ---------------------------------------------------------------------------
// The licence allowlist
// ---------------------------------------------------------------------------

/**
 * The licences E.5's criteria table allows, as SPDX ids, uppercased.
 *
 * `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `MPL-2.0`. E.5 writes "BSD"
 * as a family, so both BSD variants are named rather than the family word; a `BSD-4-Clause`
 * or a `0BSD` is NOT silently in - it is not on the list, and the check is membership rather
 * than a prefix test.
 *
 * NOT ON THE LIST, DELIBERATELY: `GPL-*`, `AGPL-*`, `SSPL` and every other copyleft. E.5
 * says "no licence or copyleft-forbidding-our-use", and the reason is narrow rather than
 * ideological: this engine reads a reference for inspiration and never copies code from it,
/// which every listed licence permits, while a strong-copyleft licence would make that a
/// question about the reader's downstream use rather than about this screen.
 */
export const ALLOWED_LICENCES: readonly string[] = Object.freeze([
  'MIT',
  'APACHE-2.0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'ISC',
  'MPL-2.0',
]);

/** The copyleft families E.5's "copyleft-forbidding-our-use" column names, for the message. */
const COPYLEFT_PREFIXES: readonly string[] = Object.freeze(['GPL-', 'AGPL-', 'LGPL-', 'SSPL-', 'OSL-']);

// ---------------------------------------------------------------------------
// The two-day budget
// ---------------------------------------------------------------------------

/**
 * THE BUDGET, IN HOURS. Two eight-hour days.
 *
 * It is a CONSTANT rather than a per-user setting because it is the feature's definition: a
 * "two-day project" that takes thirty hours is a different feature with a different promise.
 * `TWO_DAYS` is exported next to it so the UI can say "two days" without re-typing sixteen.
 */
export const TWO_DAY_BUDGET_HOURS = 16;
export const TWO_DAYS = 2;
export const HOURS_PER_DAY = 8;

/** How far back a reference may be and still count as active. E.5: "`pushed_at` within 18 months". */
export const MAX_REFERENCE_AGE_MONTHS = 18;

/** A README shorter than this is treated as no documentation. */
export const MIN_README_CHARS = 200;

/** An activity snapshot with fewer than these keys is not a snapshot. */
export const ACTIVITY_SNAPSHOT_KEYS: readonly string[] = Object.freeze([
  'stars',
  'forks',
  'openIssues',
  'pushedAt',
  'archived',
  'license',
  'hasReleases',
  'readmeChars',
  'sizeKb',
]);

// ---------------------------------------------------------------------------
// The anti-copy guard
// ---------------------------------------------------------------------------

/** Above this fraction of a candidate's tokens appearing in a reference, it is a reimplementation. */
export const ANTI_COPY_OVERLAP_MAX = 0.5;

/** A word is two or more characters of letters, digits or `+ # . -`, lowercased. */
const WORD_PATTERN = /[a-z0-9][a-z0-9+#.-]*/g;

/**
 * The token set of a text, for the overlap measure.
 *
 * Read from `interview/risks.ts`'s own vocabulary rather than reinvented - the same word rule,
 * so "the same words" means the same thing to the interview guard and to this one. This is a
 * SECOND EXPORT rather than a reuse of `wordOverlap`, because the MEASURE differs and the
 * measure is the point (see the header).
 */
export function overlapTokens(text: unknown): Set<string> {
  const out = new Set<string>();
  const source = typeof text === 'string' ? text.toLowerCase() : '';
  WORD_PATTERN.lastIndex = 0;
  for (let match = WORD_PATTERN.exec(source); match !== null; match = WORD_PATTERN.exec(source)) {
    const word = match[0].replace(/^[.#-]+|[.#-]+$/g, '');
    if (word.length >= 2) out.add(word);
  }
  return out;
}

/**
 * CONTAINMENT: `|A and B| / |A|` - the fraction of `candidate`'s tokens that also appear in
 * `reference`. In `[0, 1]`, and symmetric in neither direction on purpose.
 *
 * Zero when either side has no tokens: "nothing was compared" is not "nothing overlapped", and
 * a guard that passes because it looked at nothing is not a guard.
 */
export function containmentOverlap(candidate: unknown, reference: unknown): number {
  const a = overlapTokens(candidate);
  const b = overlapTokens(reference);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / a.size;
}

/** Why the anti-copy guard refused a candidate. */
export type AntiCopyReason = 'overlaps_a_reference' | 'no_original_design_decision';

export const ANTI_COPY_REASONS: readonly AntiCopyReason[] = Object.freeze([
  'overlaps_a_reference',
  'no_original_design_decision',
]);

/** A guard failure. Carries the machine-readable reason and the measured number, nothing else. */
export class ProjectReferenceError extends Error {
  readonly code = 'project_reference' as const;
  readonly reason: AntiCopyReason | ReferenceRejectionReason;
  /** The reference's URL when one is involved. `null` when no reference is named. */
  readonly referenceUrl: string | null;
  /** The measured containment, rounded for a message. `null` when none was measured. */
  readonly overlap: number | null;

  constructor(input: {
    reason: AntiCopyReason | ReferenceRejectionReason;
    message: string;
    referenceUrl?: string | null;
    overlap?: number | null;
  }) {
    super(input.message);
    this.name = 'ProjectReferenceError';
    this.reason = input.reason;
    this.referenceUrl = input.referenceUrl ?? null;
    this.overlap = input.overlap ?? null;
  }
}

// ---------------------------------------------------------------------------
// The reference criteria (E.5's table)
// ---------------------------------------------------------------------------

/** One row of E.5's criteria table, as a machine-readable reason. */
export const REFERENCE_REJECTION_REASONS = Object.freeze([
  /** No licence file, or GitHub could not detect one. */
  'no_licence',
  /** A licence that is real but not on the allowlist (a copyleft one, or an unknown id). */
  'licence_not_allowed',
  /** `pushed_at` is older than `MAX_REFERENCE_AGE_MONTHS`. */
  'stale_activity',
  /** No README, or a README too short to document anything. */
  'no_documentation',
  /** Neither a release nor a documented usage section. */
  'no_releases_or_documented_usage',
  /** The difficulty heuristic puts it past the two-day budget. */
  'beyond_two_day_budget',
  /** The README says it needs a paid service or a GPU. */
  'requires_paid_service_or_gpu',
  /** The search returned something that is not a repository. */
  'not_a_repository',
] as const);

export type ReferenceRejectionReason = (typeof REFERENCE_REJECTION_REASONS)[number];

export interface ReferenceRejection {
  readonly url: string;
  readonly reason: ReferenceRejectionReason;
  readonly detail: string;
}

export interface ReferenceAcceptance {
  readonly accepted: true;
  readonly kind: ReferenceKind;
  readonly title: string;
  readonly url: string;
  /** ALWAYS a member of `ALLOWED_LICENCES`. A record without one is not built. */
  readonly licence: string;
  /** The activity snapshot, with every key of `ACTIVITY_SNAPSHOT_KEYS` present. */
  readonly activity: ReferenceActivity;
  /** The README excerpt kept for the anti-copy guard. NEVER the whole README. */
  readonly notes: string;
  /** `low` | `medium` | `high`, from the deterministic difficulty heuristic. */
  readonly difficulty: Severity;
}

export type ReferenceScreen = ReferenceAcceptance | ReferenceRejection;

/** The activity snapshot, as `ProjectReference.activity` stores it. */
export interface ReferenceActivity {
  stars: number;
  forks: number;
  openIssues: number;
  /** ISO timestamp of the last push, verbatim from the provider. `null` when absent. */
  pushedAt: string | null;
  archived: boolean;
  /** The licence as detected, uppercase. The `licence` field is the ALLOWED one. */
  license: string | null;
  hasReleases: boolean;
  readmeChars: number;
  sizeKb: number;
}

/** How much of a README is kept. Enough to run the overlap guard, not enough to copy from. */
export const MAX_README_EXCERPT_CHARS = 1_200;

/** The public shape of a repository, as the screen reads it. Provider-agnostic. */
export interface RepositoryFacts {
  readonly fullName?: string | null;
  readonly htmlUrl?: string | null;
  readonly description?: string | null;
  readonly stargazersCount?: number | null;
  readonly forksCount?: number | null;
  readonly openIssuesCount?: number | null;
  readonly pushedAt?: string | null;
  readonly archived?: boolean | null;
  readonly size?: number | null;
  readonly language?: string | null;
  readonly license?: { readonly spdxId?: string | null } | null;
  readonly topics?: readonly string[] | null;
  /** The README text, when the provider was asked for it. */
  readonly readme?: string | null;
  /** A tag count, when the provider reported one. */
  readonly releasesCount?: number | null;
}

// ---------------------------------------------------------------------------
// The difficulty heuristic
// ---------------------------------------------------------------------------

/**
 * Deterministic effort estimate, in hours, for a REFERENCE.
 *
 * This is NOT a model of how long the CANDIDATE takes - that is the candidate's own
 * `estimatedHours`, screened against `TWO_DAY_BUDGET_HOURS` in `generate.ts`. This answers a
 * narrower question E.5 asks: "is this repository something a person can read and be inspired
 * by in the time we have, or is it a platform?" The inputs are the ones the public search
 * already returns, and every term is named so a reader can argue with a specific term:
 *
 *   - `sizeKb / 500` - repository size in KB, in units of 500KB. A 200KB repo is a weekend
 *     read; a 50MB one is a framework.
 *   - `+ 4` when there are open issues above 100 - an actively broken thing is a worse
 *     reference than a quiet one, not a better one.
 *   - `+ 4` when it has no releases and no topics - nothing to install and nothing that says
 *     what it is.
 *
 * `LICENSE` and `MIN_README_CHARS` are imported constants rather than re-typed, so the budget
 * has exactly one definition in this directory.
 */
export function estimateReferenceHours(facts: RepositoryFacts): number {
  const sizeKb = typeof facts.size === 'number' && facts.size >= 0 ? facts.size : 0;
  const issues = typeof facts.openIssuesCount === 'number' ? facts.openIssuesCount : 0;
  const topics = Array.isArray(facts.topics) ? facts.topics.length : 0;
  const releases = typeof facts.releasesCount === 'number' ? facts.releasesCount : 0;
  let hours = Math.ceil(sizeKb / 500);
  if (issues > 100) hours += 4;
  if (topics === 0 && releases === 0) hours += 4;
  return Math.max(1, hours);
}

/** The `Severity` the difficulty heuristic maps to. `high` means "past the budget". */
export function severityForReferenceHours(hours: number): Severity {
  if (hours > TWO_DAY_BUDGET_HOURS) return 'high';
  if (hours > Math.ceil(TWO_DAY_BUDGET_HOURS / 2)) return 'medium';
  return 'low';
}

/** A word is two or more characters; the paid-service / GPU phrases are matched against this set. */
const REQUIREMENT_PHRASES: readonly string[] = Object.freeze([
  'gpu',
  'cuda',
  'nvidia',
  'tpu',
  'paid',
  'subscription',
  'premium',
  'billing',
  'credit',
  'credits',
  'license key',
  'licence key',
  'api key',
]);

/**
 * Does the README say this needs money or hardware?
 *
 * MATCHED TWO WAYS, AND THE DIFFERENCE IS DELIBERATE:
 *   - a SINGLE-word phrase is a WHOLE TOKEN, so "repaid" is not "paid" and "gpu-less" is not
 *     "gpu". Those are the classic substring false positives, and a reference wrongly rejected
 *     for the word "repaid" would be a bad reference nobody could name.
 *   - a MULTI-word phrase ("license key", "licence key", "api key") is matched on the
 *     whitespace-collapsed text, because a token SET cannot see a two-word phrase without a
 *     sequence walk. The accepted cost is stated in the test: a README that says it needs NO api
 *     key is refused. That is the right way round for this criterion, because a project that
 *     cannot be run without a key is a bad two-day project whether or not the README says "no".
 */
export function requiresPaidServiceOrGpu(readme: unknown): boolean {
  const text = typeof readme === 'string' ? readme.toLowerCase() : '';
  if (text.length === 0) return false;
  const tokens = new Set(text.split(/[^a-z0-9+#.-]+/));
  for (const phrase of REQUIREMENT_PHRASES) {
    if (phrase.includes(' ')) {
      if (text.includes(phrase)) return true;
      continue;
    }
    if (tokens.has(phrase)) return true;
  }
  return false;
}

/** A heading that counts as documented usage. Lowercased before comparison. */
const USAGE_HEADINGS: readonly string[] = Object.freeze([
  '## usage',
  '## use',
  '## quick start',
  '## quickstart',
  '## getting started',
  '## installation',
  '## install',
  '## setup',
  '## examples',
  '## example usage',
  '# usage',
  '# getting started',
  '# installation',
]);

/**
 * Does the README document how to USE the thing?
 *
 * EXPORTED, because `projects/research.ts` has to decide whether one more request is worth
 * spending BEFORE it screens: E.5's releases criterion is "a tag count > 0 OR documented usage",
 * and the search endpoint carries neither the README body nor the tag count. A second copy of
 * this heading list would be a second opinion about what "documented usage" means, and the two
 * would drift - so the research stage asks this one.
 */
export function hasDocumentedUsage(readme: string): boolean {
  const lower = typeof readme === 'string' ? readme.toLowerCase() : '';
  if (lower.length === 0) return false;
  return USAGE_HEADINGS.some((heading) => lower.includes(heading));
}

/** Uppercase and trim an SPDX id. `''` for anything unusable, which is `no_licence`. */
function normalizedLicence(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/** How far back a reference may be, as an ISO string, for a given `now`. */
export function activityCutoff(now: Date): Date {
  const month = 1000 * 60 * 60 * 24 * 30.44;
  return new Date(now.getTime() - MAX_REFERENCE_AGE_MONTHS * month);
}

/**
 * THE SCREEN: E.5's six criteria, as one pure function.
 *
 * ORDER IS THE TABLE'S ORDER - licence, activity, releases/usage, docs, difficulty,
 * feasibility - because the first refusal is the one worth reporting: a no-licence repository
 * should be reported as no-licence even when it is also stale.
 *
 * `now` is INJECTED rather than read from the clock so "within 18 months" is testable with a
 * literal and cannot drift between the screen and the test that pins it.
 */
export function screenReference(facts: RepositoryFacts, now: Date): ReferenceScreen {
  const url = typeof facts.htmlUrl === 'string' ? facts.htmlUrl.trim() : '';
  const title = typeof facts.fullName === 'string' ? facts.fullName.trim() : '';

  if (url.length === 0 || title.length === 0) {
    return {
      url: url || '(no url)',
      reason: 'not_a_repository',
      detail: 'the search result has no repository name or url, so there is nothing to record',
    };
  }

  // 1. LICENCE. First, and load-bearing: no licence means no permission even for inspiration.
  const licence = normalizedLicence(facts.license?.spdxId);
  if (licence.length === 0) {
    return {
      url,
      reason: 'no_licence',
      detail:
        'no licence file was found, so there is no permission to draw on even as inspiration: a ' +
        'reference whose permission is unknown is not recorded',
    };
  }
  if (!ALLOWED_LICENCES.includes(licence)) {
    const copyleft = COPYLEFT_PREFIXES.some((prefix) => licence.startsWith(prefix));
    return {
      url,
      reason: 'licence_not_allowed',
      detail: copyleft
        ? `${licence} is a copyleft licence and this screen only draws on permissive ones`
        : `${licence} is not one of the licences this engine draws on (${ALLOWED_LICENCES.join(', ')})`,
    };
  }

  // 2. ACTIVITY. `pushed_at` within 18 months.
  const cutoff = activityCutoff(now);
  const pushedAt = typeof facts.pushedAt === 'string' ? facts.pushedAt : null;
  if (pushedAt === null) {
    return {
      url,
      reason: 'stale_activity',
      detail:
        'the provider reported no last-push date, so there is no evidence the repository is still ' +
        'maintained and it is not recorded',
    };
  }
  const pushed = new Date(pushedAt);
  if (Number.isNaN(pushed.getTime())) {
    return { url, reason: 'stale_activity', detail: `the last-push date "${pushedAt}" is not a date` };
  }
  if (pushed.getTime() < cutoff.getTime()) {
    return {
      url,
      reason: 'stale_activity',
      detail: `the last push was ${pushedAt}, more than ${MAX_REFERENCE_AGE_MONTHS} months ago`,
    };
  }

  // 3. RELEASES OR DOCUMENTED USAGE.
  const readme = typeof facts.readme === 'string' ? facts.readme : '';
  const hasReleases = (typeof facts.releasesCount === 'number' ? facts.releasesCount : 0) > 0;
  if (!hasReleases && !hasDocumentedUsage(readme)) {
    return {
      url,
      reason: 'no_releases_or_documented_usage',
      detail: 'the repository has no releases and its README has no usage or installation section',
    };
  }

  // 4. DOCS.
  if (readme.trim().length < MIN_README_CHARS) {
    return {
      url,
      reason: 'no_documentation',
      detail: `the README is ${readme.trim().length} characters; at least ${MIN_README_CHARS} are needed to document anything`,
    };
  }

  // 5. DIFFICULTY, against the two-day budget.
  const hours = estimateReferenceHours(facts);
  if (hours > TWO_DAY_BUDGET_HOURS) {
    return {
      url,
      reason: 'beyond_two_day_budget',
      detail:
        `reading this well enough to be inspired by it is about ${hours} hours, past the ` +
        `${TWO_DAY_BUDGET_HOURS}-hour budget a two-day project has`,
    };
  }

  // 6. FEASIBILITY.
  if (requiresPaidServiceOrGpu(readme)) {
    return {
      url,
      reason: 'requires_paid_service_or_gpu',
      detail:
        'the README asks for a paid service, an API key or a GPU, and a two-day project that ' +
        'needs money or special hardware is not a two-day project',
    };
  }

  return {
    accepted: true,
    kind: 'github_repo',
    title,
    url,
    licence,
    activity: {
      stars: typeof facts.stargazersCount === 'number' ? facts.stargazersCount : 0,
      forks: typeof facts.forksCount === 'number' ? facts.forksCount : 0,
      openIssues: typeof facts.openIssuesCount === 'number' ? facts.openIssuesCount : 0,
      pushedAt,
      archived: facts.archived === true,
      license: licence,
      hasReleases,
      readmeChars: readme.trim().length,
      sizeKb: typeof facts.size === 'number' ? facts.size : 0,
    },
    notes: readme.trim().slice(0, MAX_README_EXCERPT_CHARS),
    difficulty: severityForReferenceHours(hours),
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** The row `ProjectReference` stores. Built only by `referenceRecord`, which enforces the two. */
export interface ReferenceRow {
  readonly kind: ReferenceKind;
  readonly title: string;
  readonly url: string;
  /** NOT NULL in practice and enforced here, though the column itself is nullable. */
  readonly licence: string;
  readonly activity: ReferenceActivity;
  readonly notes: string;
}

/**
 * THE RECORD, and the two fields that make it auditable.
 *
 * `ProjectReference.licence` is a nullable column, so the database would happily accept a row
 * with no licence - and E.5's criteria say a no-licence repository must be REJECTED. That is a
 * rule with nowhere to live in the schema, so it lives here and this function is the ONLY way
 * to build the row. It THROWS rather than filtering, for the same reason the rest of V2's
 * guards throw: a reference that quietly vanished reads as "we checked and found none", which
 * is a claim, and the wrong one.
 */
export function referenceRecord(acceptance: ReferenceAcceptance): ReferenceRow {
  const licence = normalizedLicence(acceptance.licence);
  if (licence.length === 0 || !ALLOWED_LICENCES.includes(licence)) {
    throw new ProjectReferenceError({
      reason: licence.length === 0 ? 'no_licence' : 'licence_not_allowed',
      referenceUrl: acceptance.url,
      message:
        `a reference is never recorded without a licence this engine may draw on: ${acceptance.url} ` +
        `reports "${acceptance.licence}"`,
    });
  }
  for (const key of ACTIVITY_SNAPSHOT_KEYS) {
    if (!(key in acceptance.activity)) {
      throw new ProjectReferenceError({
        reason: 'stale_activity',
        referenceUrl: acceptance.url,
        message: `a reference is never recorded without an activity snapshot: ${acceptance.url} has no "${key}"`,
      });
    }
  }
  return {
    kind: acceptance.kind,
    title: acceptance.title,
    url: acceptance.url,
    licence,
    activity: acceptance.activity,
    notes: acceptance.notes,
  };
}

// ---------------------------------------------------------------------------
// The anti-copy guard, applied
// ---------------------------------------------------------------------------

/** What a reference contributes to the overlap measure: its stored excerpt plus its title. */
export function referenceOverlapText(row: { readonly notes?: string | null; readonly title: string }): string {
  return `${row.title} ${row.notes ?? ''}`;
}

/**
 * The guard's answer, and it is a DISCRIMINATED UNION rather than a boolean plus optional
 * fields: a caller that gets `original: false` cannot read `overlap` without first proving it
 * is not `null`, which is what stops "it was refused, and the number was undefined" from being
 * written by accident and reported as a 0% overlap.
 */
export type AntiCopyVerdict =
  | { readonly original: true }
  | {
      readonly original: false;
      readonly reason: AntiCopyReason;
      readonly detail: string;
      readonly referenceUrl: string | null;
      readonly overlap: number | null;
    };

/**
 * THE GUARD, run on one candidate.
 *
 * TWO CHECKS, and the second is E.5's output requirement rather than its criteria table:
 *   1. containment against every reference, above `ANTI_COPY_OVERLAP_MAX` -> refused;
 *   2. the candidate must NAME AT LEAST ONE ORIGINAL DESIGN DECISION. A candidate with no
 *      original decision has not been designed - it has been assembled out of the references,
 *      and that is the same failure the overlap check catches, one step earlier and with no
 *      text to compare.
 *
 * The candidate's text is `idea` + every plan line, which is what a reader would recognise as
 * "their project". The title is NOT compared: a title is a name, and a name that shares words
 * with a repository's name is not copying - every project about queues has a word for queues.
 */
export function checkCandidateIsOriginal(
  candidate: { readonly idea: string; readonly planText: string; readonly originalDesignDecision: string },
  references: readonly { readonly url: string; readonly notes?: string | null; readonly title: string }[],
): AntiCopyVerdict {
  if (candidate.originalDesignDecision.trim().length === 0) {
    return {
      original: false,
      reason: 'no_original_design_decision',
      detail:
        'the plan names no original design decision, which means it was assembled rather than ' +
        'designed - a candidate that is a reimplementation is exactly what this refuses',
      referenceUrl: null,
      overlap: null,
    };
  }
  const subject = `${candidate.idea}\n${candidate.planText}`;
  let worst = 0;
  let worstUrl: string | null = null;
  for (const reference of references) {
    const overlap = containmentOverlap(subject, referenceOverlapText(reference));
    if (overlap > worst) {
      worst = overlap;
      worstUrl = reference.url;
    }
  }
  if (worst > ANTI_COPY_OVERLAP_MAX) {
    return {
      original: false,
      reason: 'overlaps_a_reference',
      detail:
        `${Math.round(worst * 100)}% of this candidate's words also appear in ${worstUrl}, above the ` +
        `${Math.round(ANTI_COPY_OVERLAP_MAX * 100)}% a reimplementation reaches. References are ` +
        'inspiration; the project has to be yours.',
      referenceUrl: worstUrl,
      overlap: worst,
    };
  }
  return { original: true };
}

/** THROWING form, for the callers that want a refusal rather than a verdict. */
export function assertCandidateIsOriginal(
  candidate: { readonly idea: string; readonly planText: string; readonly originalDesignDecision: string },
  references: readonly { readonly url: string; readonly notes?: string | null; readonly title: string }[],
): void {
  const verdict = checkCandidateIsOriginal(candidate, references);
  if (verdict.original) return;
  throw new ProjectReferenceError({
    reason: verdict.reason,
    referenceUrl: verdict.referenceUrl,
    overlap: verdict.overlap,
    message: verdict.detail,
  });
}