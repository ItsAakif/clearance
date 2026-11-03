// tailor/factDelta.test.ts - THE FABRICATION GUARD, in both directions (T1080; 06 sec.E.3
// rule 3; 05 sec.2).
//
// THE FIXTURE THIS FILE EXISTS FOR IS THE `fabricated metric` ONE. 06 sec.E.3 rule 3 says a
// new number/employer/technology that is in neither the before-state nor a confirmed claim
// "sets `factDelta = true` and BLOCKS the op. This is the 'tailoring may not invent evidence'
// rule, enforced mechanically." So: one test that a legitimate re-wording is CLEAN, and one
// per entity kind that the fabrication is caught, with the kind named.

import { describe, it, expect } from 'vitest';

import {
  detectFactDelta,
  describeFactDelta,
  extractFacts,
  factSet,
  factsOf,
  factsOfTexts,
  technologiesIn,
  unionFacts,
} from './factDelta.js';

// The bullet the live profile carries, and the claim that states it.
const BEFORE = 'Cut CI build time by 40% by caching the dependency layer';
const CLAIM = 'Cut the CI build time by 40% by caching the dependency layer';

/** The allowed set for a rewrite of `BEFORE` grounded in `CLAIM`. */
const allowed = () => unionFacts(extractFacts(BEFORE), factsOfTexts([CLAIM]));

/** The verdict of proposing `after` over `before`, grounded in `claim`. */
function verdictFor(after: string, before = BEFORE, claim = CLAIM) {
  return detectFactDelta(extractFacts(after), unionFacts(extractFacts(before), factsOfTexts([claim])));
}

// ---------------------------------------------------------------------------
// 1. The acceptance fixture: a fabricated metric
// ---------------------------------------------------------------------------

describe('factDelta: a NEW METRIC is caught, and a re-wording of the same metric is not', () => {
  it('CLEAN: the same facts in a different phrasing produce NO delta', () => {
    // The half that makes the guard usable. "Cut" -> "Reduced" is the entire job of the
    // tailoring engine; if it were reported as a new fact every proposal would be refused
    // and the user would learn to ignore the guard.
    expect(verdictFor('Reduced the CI build time by 40% by caching the dependency layer')).toBeNull();
  });

  it('BLOCKED: a metric that is in neither the before-state nor the claim', () => {
    // "95%" is the fabrication. Neither the bullet nor the claim says it.
    const delta = verdictFor('Reduced the CI build time by 40% and shipped to 95% of the fleet');
    expect(delta).not.toBeNull();
    expect(delta!.byKind.metric).toEqual(['95%']);
    expect(describeFactDelta(delta!)).toContain('metric:95%');
  });

  it('BLOCKED: a metric present in the CLAIM is allowed, which is the point of grounding', () => {
    // The claim says 40%; the before-state does not. A rewrite to the claim's own wording is
    // permitted BECAUSE the claim says it, and that asymmetry is the whole mechanism.
    expect(allowed().metrics).toEqual(['40%']);
    expect(verdictFor('Cut the CI build time by 40% by caching the dependency layer', 'x', CLAIM)).toBeNull();
  });

  it('the numbers are normalised, so 12,000 and 12000 are the SAME metric', () => {
    // A guard that reported a delta here would be reporting a comma.
    expect(extractFacts('handled 12,000 requests per second').metrics).toEqual(
      extractFacts('handled 12000 requests per second').metrics,
    );
  });

  it('a UNIT is part of the metric, so 12k and 12 are different claims', () => {
    expect(verdictFor('Reduced the CI build time by 40% by caching the dependency layer, handling 12k req/s')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The other three entity kinds
// ---------------------------------------------------------------------------

describe('factDelta: a NEW employer, date or technology is caught', () => {
  it('BLOCKED: an employer that is in neither the before-state nor the claim', () => {
    // "at Globex" is the repository's own employer convention (`"<title> at <company>"` in
    // career/claims.ts and career/resumeImport.ts), so this is the shape the extractor exists
    // to see.
    const delta = verdictFor('Reduced the CI build time by 40% at Globex');
    expect(delta?.byKind.employer).toEqual(['Globex']);
  });

  it('CLEAN: an employer the resume already knows is not a new fact', () => {
    // `knownEmployers` is the caller's (the route's) list of `Experience.company` values. The
    // document ALREADY states this employer, so naming it again is not an invention.
    const allowedWithEmployer = unionFacts(
      extractFacts(BEFORE, ['Acme', 'Globex']),
      factsOfTexts([CLAIM, 'Staff Engineer at Globex'], ['Acme', 'Globex']),
    );
    expect(detectFactDelta(extractFacts('Reduced the CI build time by 40% at Globex', ['Acme', 'Globex']), allowedWithEmployer)).toBeNull();
  });

  it('BLOCKED: a year that neither the before-state nor the claim states', () => {
    const delta = verdictFor('Reduced the CI build time by 40% in 1999');
    expect(delta?.byKind.date).toEqual(['1999']);
  });

  it('BLOCKED: a TECHNOLOGY the matcher tables do not have in the before-state', () => {
    // `technologiesIn` reads the matcher's own synonym tables, so "Kubernetes" is the
    // canonical key whether the text said `k8s`, `Kubernetes` or `K8s orchestration`.
    const delta = verdictFor('Reduced the CI build time by 40% by running the clusters on Kubernetes');
    expect(delta?.byKind.technology).toEqual(['kubernetes']);
  });

  it('the technology keys are the MATCHER vocabulary, not the sentence', () => {
    // The specific false positive this drops: `claimJoinKeys` also returns the whole
    // normalized sentence, which as a "technology" would make every distinct rewrite a new
    // technology. Asserted directly, because the drop is a judgement and a judgement needs a
    // test.
    expect(technologiesIn('Led the Kubernetes migration')).toEqual(['kubernetes']);
    expect(technologiesIn('Wrote the first published algorithm intended for a machine')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The shape of the comparison itself
// ---------------------------------------------------------------------------

describe('factDelta: the comparison is a set comparison over four named vocabularies', () => {
  it('every kind has fixed text, and a clean verdict is `null` rather than an empty delta', () => {
    // `null` is "no delta". A delta object with an empty `introduced` would be a second way
    // to say the same thing, and two ways to say it is how a caller ends up treating an
    // empty delta as permission.
    expect(detectFactDelta(factSet({}), factSet({}))).toBeNull();
    expect(detectFactDelta(extractFacts(BEFORE), extractFacts(BEFORE))).toBeNull();
  });

  it('is symmetric in the sense that matters: the allowed set wins over the after set', () => {
    const delta = detectFactDelta(extractFacts('40% and 12k'), extractFacts('12k'));
    expect(delta?.introduced).toEqual(['metric:40%']);
  });

  it('extractFacts is TOTAL: a non-string, a blank string and a missing value are empty', () => {
    expect(factsOf(extractFacts(undefined))).toEqual([]);
    expect(factsOf(extractFacts(null))).toEqual([]);
    expect(factsOf(extractFacts('   '))).toEqual([]);
    expect(factsOf(extractFacts(42))).toEqual([]);
  });

  it('a year is reported as BOTH a metric and a date, and that is stated rather than clever', () => {
    // A shape test cannot tell a year from a count, and suppressing either reading opens a
    // hole. Two vocabularies for one number is the honest outcome.
    const facts = extractFacts('Shipped it in 2021');
    expect(facts.metrics).toContain('2021');
    expect(facts.dates).toEqual(['2021']);
  });

  it('the sets are sorted and deduplicated, so two orderings of the same facts are equal', () => {
    const one = factsOfTexts(['Kubernetes and Postgres', 'Caching in 2021']);
    const two = factsOfTexts(['Caching in 2021', 'Postgres and Kubernetes']);
    expect(one).toEqual(two);
  });
});