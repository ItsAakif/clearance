// =====================================================================================
// tailor/factDelta.ts - THE GUARD THAT MAKES "TAILORING MAY NOT INVENT EVIDENCE" MECHANICAL
// (T1080; 06-design sec.E.3 rule 3, rule 1 of the non-negotiable list in 05 sec.2).
//
// THE RULE, IN THE SPEC'S OWN TERMS. "Extract entities from `before` and `after` (numbers,
// dates, employers, technologies via the matcher's KNOWN_SKILLS/synonyms) and require
// `entities(after) subset-of entities(before) union entities(confirmed claims)`. A new
// number/employer/technology not present before and not in a confirmed claim sets
// `factDelta = true` and BLOCKS the op. This is the 'tailoring may not invent evidence'
// rule, enforced mechanically."
//
// WHY IT IS A SEPARATE MODULE FROM THE VALIDATOR. Two reasons, and the second is the one
// that matters. First: it is the only part of the tailoring pass that is a COMPARISON
// between two texts, so it is the only part with a fixture worth writing by hand - and the
// fabricated-metric fixture is the acceptance item, not an implementation detail. Second:
// `entities(after) subset-of entities(before) union entities(claims)` is a statement about
// the USER'S CAREER, and the place that decides it must be readable without knowing anything
// about JSON paths, template metadata or revision numbers.
//
// WHAT COUNTS AS AN ENTITY, AND WHY THE FOUR KINDS ARE EXTRACTED DIFFERENTLY.
//   metric      a NUMBER, optionally with a unit/percent. Extracted by shape: a digit run is
//               a metric whatever it is a metric of. This is the kind that catches the
//               canonical fabrication ("12k req/s" into a bullet that never had it).
//   date        a YEAR, a quarter-with-year, or a month-with-year. Extracted by shape and
//               reduced to its YEAR, because "2019" and "2019-2021" assert the same fact and
//               demanding a character-exact date match would make every re-worded bullet a
//               false positive.
//   technology  a CANONICAL KEY from the matcher's own synonym tables. Reached through
//               `match/levels.ts#claimJoinKeys` - the SAME function T1070's join reads - so
//               "K8s", "Kubernetes" and "Kubernetes container orchestration" all resolve to
//               one key and a tailoring pass cannot smuggle a technology in under a spelling
//               the tables do not know. Over-detecting is the fail-closed direction and is
//               deliberate: a key the tables recognise and the before-state lacks is refused
//               even when the sentence is innocuous.
//   employer    an ORGANISATION, detected with the repository's OWN convention. Every place
//               this codebase states an employer writes it as "<title> at <company>" -
//               `career/claims.ts#normalizeStatement`, `career/resumeImport.ts`
//               (`${title} at ${company}`), and the legacy backfill's claim drafts. This
//               extractor applies exactly that shape, plus any employer name the resume
//               already knows, so it does not invent a second idea of what an employer looks
//               like. ITS LIMIT IS STATED, NOT HIDDEN: an organisation introduced without one
//               of those prepositions and absent from the known-employer list is not
//               detected. That bound is why `sourceClaimIds` is not optional - the prose an
//               operation may write is bounded by the claim it names, and this guard is the
//               second, mechanical line under it, not the only one.
//
// DETERMINISM. No clock, no I/O, no module state, no randomness; the same two strings always
// produce the same two entity sets, which is what lets a rejection be reproducible.
// =====================================================================================

import { claimJoinKeys } from '../match/levels.js';
import { normalizedKeyFor } from '../jobs/requirements.js';

/** The four kinds of entity the guard knows. Named so a refusal can say WHICH one is new. */
export type FactKind = 'metric' | 'date' | 'technology' | 'employer';

/** One entity, as a stable string. Two entities are the same fact iff these strings match. */
export type FactEntity = `${FactKind}:${string}`;

export interface FactSet {
  readonly metrics: readonly string[];
  readonly dates: readonly string[];
  readonly technologies: readonly string[];
  readonly employers: readonly string[];
}

/** The entities a text asserts, as a set. Sorted, deduplicated, and therefore comparable. */
export function factSet(parts: {
  metrics?: Iterable<string>;
  dates?: Iterable<string>;
  technologies?: Iterable<string>;
  employers?: Iterable<string>;
}): FactSet {
  const sorted = (values: Iterable<string> | undefined): string[] => [...new Set(values ?? [])].sort();
  return Object.freeze({
    metrics: Object.freeze(sorted(parts.metrics)),
    dates: Object.freeze(sorted(parts.dates)),
    technologies: Object.freeze(sorted(parts.technologies)),
    employers: Object.freeze(sorted(parts.employers)),
  });
}

/** Every entity in a set, in the one order the vocabulary lists them. */
export function factsOf(set: FactSet): FactEntity[] {
  const out: FactEntity[] = [];
  for (const value of set.metrics) out.push(`metric:${value}`);
  for (const value of set.dates) out.push(`date:${value}`);
  for (const value of set.technologies) out.push(`technology:${value}`);
  for (const value of set.employers) out.push(`employer:${value}`);
  return out.sort();
}

/** The union of any number of sets. What "before-state union confirmed claims" means. */
export function unionFacts(...sets: readonly FactSet[]): FactSet {
  return factSet({
    metrics: sets.flatMap((entry) => entry.metrics),
    dates: sets.flatMap((entry) => entry.dates),
    technologies: sets.flatMap((entry) => entry.technologies),
    employers: sets.flatMap((entry) => entry.employers),
  });
}

export const EMPTY_FACT_SET: FactSet = factSet({});

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * A metric is a digit run, with the separators removed and a trailing `%` kept.
 *
 * The normalisation matters and is why `12,000` and `12000` are the SAME metric rather than
 * two: a re-worded bullet that says "12,000 requests per second" for a before-state that said
 * "12000" has introduced no fact, and a guard that reported a delta would train users to
 * ignore the guard. A `k`/`m`/`bn`/`x`/`ms`/`s` suffix is kept as part of the value, because
 * "12k" and "12" are different claims.
 */
const METRIC_PATTERN = /(\d[\d,]*(?:\.\d+)?)\s*(%|k|m|bn|x|ms|s)?(?![A-Za-z])/gi;

/** Years, quarters and month-year, all reduced to the year. */
const DATE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bQ[1-4][-' ]?(?:19|20)\d{2}\b/g,
  /\b(?:19|20)\d{2}\b/g,
]);

/**
 * THE EMPLOYER SHAPE, which is this repository's own: an organisation name introduced by a
 * preposition that introduces an organisation, or an employer the resume already knows.
 *
 * `for` and `with` are in the set because "built for Acme" and "worked with Globex" are how
 * people write, and the alternative - dropping them - would leave the most natural phrasings
 * unchecked. The false-positive cost is a capitalised word after one of these words
 * ("for Scale"), which fails CLOSED and is visible in the rejection's `detail`.
 */
const EMPLOYER_INTRODUCERS = 'at|with|for|from|joined|join|during|across';
const EMPLOYER_NAME = '[A-Z][A-Za-z0-9&.\'-]*(?:\\s+(?:and|of|the|de)?\\s*[A-Z][A-Za-z0-9&.\'-]*)*';
// The optional article matters: "worked at the Naval Ordnance Laboratory" is the same
// assertion as "worked at Naval Ordnance Laboratory", and without `the` in the pattern the
// multi-word form would be invisible while the single-word one was caught.
const EMPLOYER_PATTERN = new RegExp(
  `\\b(?:${EMPLOYER_INTRODUCERS})\\s+(?:(?:the|a|an)\\s+)?(${EMPLOYER_NAME})`,
  'g',
);

function employersIn(text: string, known: readonly string[]): string[] {
  const out: string[] = [];
  EMPLOYER_PATTERN.lastIndex = 0;
  for (let match = EMPLOYER_PATTERN.exec(text); match !== null; match = EMPLOYER_PATTERN.exec(text)) {
    // A single capitalised word is the weakest signal, so it is kept only when the resume
    // already knows that employer, or when the introducer is the unambiguous one. Multi-word
    // names ("Naval Ordnance Laboratory", "Eckert-Mauchly") are always kept.
    const captured = (match[1] ?? '').trim();
    const introducer = match[0].slice(0, match[0].indexOf(captured)).trim();
    const multiWord = captured.includes(' ');
    if (multiWord || introducer === 'at' || introducer === 'joined' || introducer === 'join') {
      out.push(captured);
    }
  }
  // An employer the RESUME already knows is an entity wherever it appears, however it is
  // phrased: "Globex" at the start of a clause is the same organisation as "at Globex".
  for (const name of known) {
    const needle = name.trim();
    if (needle.length === 0) continue;
    if (new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i').test(text)) out.push(needle);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The CANONICAL TECHNOLOGY KEYS a text contains, from the matcher's own tables.
 *
 * `claimJoinKeys` is T1070's join input and it is read here rather than reimplemented, so
 * the tailoring pass and the evidence-level report agree on what "mentions Kubernetes" means.
 *
 * ONE KEY IS DROPPED, AND IT IS THE WHOLE POINT OF DROPPING IT. `claimJoinKeys` also returns
 * `normalizedKeyFor(the whole sentence)`, because that key trivially occurs in the sentence it
 * came from - it is the join's door for a requirement whose key IS a phrase. As a TECHNOLOGY
 * entity it is poison: every distinct sentence produces a distinct key, so a one-word rewording
 * would report a "new technology" and every single rewrite would be blocked. The vocabulary
 * keys - the synonym families and the role banks, which is what "the matcher's
 * `KNOWN_SKILLS`/synonyms" means in E.3 rule 3 - are all that is left.
 *
 * IT IS DROPPED ONLY FOR A MULTI-WORD TEXT, which is the case that needs dropping. For a
 * single canonical term - the text IS "Kubernetes" - the whole-sentence key and the vocabulary
 * key are the same string, and dropping it would make `add_skill` with a one-word name
 * undetectable. So the filter is on the word count, not on the key.
 */
export function technologiesIn(text: string): string[] {
  const keys = claimJoinKeys(text);
  if (text.trim().split(/\s+/).length <= 1) return keys;
  const wholeSentence = normalizedKeyFor(text);
  return keys.filter((key) => key !== wholeSentence);
}

function metricsIn(text: string): string[] {
  const out: string[] = [];
  METRIC_PATTERN.lastIndex = 0;
  for (let match = METRIC_PATTERN.exec(text); match !== null; match = METRIC_PATTERN.exec(text)) {
    const number = (match[1] ?? '').replace(/,/g, '');
    const unit = (match[2] ?? '').toLowerCase();
    out.push(`${number}${unit}`);
  }
  return out;
}

function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const pattern of DATE_PATTERNS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const year = /\b((?:19|20)\d{2})\b/.exec(match[0]);
      if (year?.[1]) out.push(year[1]);
    }
  }
  return out;
}

/**
 * Every entity a text asserts.
 *
 * `knownEmployers` is supplied by the caller rather than guessed here: the guard's job is to
 * compare two sets, and the set of employers the user has is a fact the DATABASE holds. A
 * caller that passes an empty list still gets every employer this extractor can recognise by
 * shape; it only loses the "known employer mentioned in an unusual position" case.
 */
export function extractFacts(text: unknown, knownEmployers: readonly string[] = []): FactSet {
  if (typeof text !== 'string' || text.trim().length === 0) return EMPTY_FACT_SET;
  return factSet({
    // A YEAR APPEARS IN BOTH LISTS, DELIBERATELY. `metricsIn` is a shape test - a digit run is
    // a number whatever it is a number of - so "2021" is a metric AND a date. Suppressing the
    // metric would open a hole ("served 2000 accounts" is not a year), and suppressing the
    // date would open another; the cost is that a rejection about a year names it twice, in
    // two vocabularies, which is honest rather than clever.
    metrics: metricsIn(text),
    dates: datesIn(text),
    technologies: technologiesIn(text),
    employers: employersIn(text, knownEmployers),
  });
}

/**
 * The entities of a set of TEXTS, as one set.
 *
 * This is how the "union entities(confirmed claims)" half is computed: a claim is a
 * sentence, and the facts it grounds are the entities of that sentence. Nothing here re-parses
 * the claim row's `kind`, so a claim of any kind grounds its own text and nothing more.
 */
export function factsOfTexts(
  texts: readonly unknown[],
  knownEmployers: readonly string[] = [],
): FactSet {
  return unionFacts(...texts.map((text) => extractFacts(text, knownEmployers)));
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export interface FactDelta {
  /** Always `true` on a delta; the shape exists so a caller can branch without a boolean. */
  readonly factDelta: true;
  /** The entities `after` asserts that the allowed set does not. Never empty. */
  readonly introduced: readonly FactEntity[];
  /** The same facts, grouped by kind, for a message a person can read. */
  readonly byKind: Readonly<Record<FactKind, readonly string[]>>;
}

const EMPTY_BY_KIND: Readonly<Record<FactKind, readonly string[]>> = Object.freeze({
  metric: Object.freeze([]),
  date: Object.freeze([]),
  technology: Object.freeze([]),
  employer: Object.freeze([]),
});

/**
 * Does `after` introduce a fact `allowed` does not already contain?
 *
 * `allowed` is `entities(before) union entities(confirmed claims)` and is the caller's
 * composition, not this function's: `validate.ts` builds it, because only it knows which
 * claims an operation named. `null` means "no delta", and a caller MUST NOT read an absent
 * delta as permission - the operation is refused either way, which is why this returns a
 * delta object rather than a boolean and the refusal is raised by the caller.
 */
export function detectFactDelta(after: FactSet, allowed: FactSet): FactDelta | null {
  const introduced: FactEntity[] = [];
  const byKind: Record<FactKind, string[]> = { metric: [], date: [], technology: [], employer: [] };
  for (const [kind, plural] of [
    ['metric', 'metrics'],
    ['date', 'dates'],
    ['technology', 'technologies'],
    ['employer', 'employers'],
  ] as const) {
    const have = new Set(allowed[plural]);
    for (const value of after[plural]) {
      if (have.has(value)) continue;
      introduced.push(`${kind}:${value}`);
      byKind[kind].push(value);
    }
  }
  if (introduced.length === 0) return null;
  return {
    factDelta: true,
    introduced: Object.freeze(introduced.sort()),
    byKind: Object.freeze({
      metric: Object.freeze(byKind.metric.sort()),
      date: Object.freeze(byKind.date.sort()),
      technology: Object.freeze(byKind.technology.sort()),
      employer: Object.freeze(byKind.employer.sort()),
    }),
  };
}

/** A one-line, caller-data-free summary of what is new. The refusal's `detail`. */
export function describeFactDelta(delta: FactDelta): string {
  return delta.introduced.join(', ');
}

/** The empty `byKind` value, exported so a caller can build a delta-shaped object. */
export { EMPTY_BY_KIND };