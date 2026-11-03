// =====================================================================================
// projects/lifecycle.noScore.test.ts - THE NO-SCORE GUARD FOR THE PROJECT ENGINE (T1100;
// 06 sec. E.6).
//
// THE RULE, verbatim: "No universal score, no single number, no letter grade, no 'ATS 87/100'."
// A project engine is an obvious place to break it, and it is worse here than on a resume: a
// candidate's `estimatedHours` and `difficulty` sit one arithmetic operation away from a "fit"
// figure, and a fit figure over a person's gaps is exactly the verdict E.6 exists to forbid.
//
// WHAT IS CHECKED, in three layers, and each layer is a DIFFERENT KIND of evidence:
//
//   1. THE SOURCE. Every file in this directory names no score-shaped word, presents no
//      percentage, and does no arithmetic over the counts it reports. Comments are stripped
//      first, so prose can neither satisfy nor defeat the guard - which is what lets these files
//      DISCUSS the banned words in order to explain that they are absent.
//   2. THE TYPES. The discovery response and the decision response declare no numeric verdict
//      member, so "the client could render it" is structurally impossible rather than unlikely.
//   3. A REAL RESPONSE BODY. A full run is executed against the fake store and the body is
//      inspected: four integers over NAMED things, a three-word `difficulty`, an hour count that
//      is a budget rather than a rating - and no member anywhere that reads as a verdict.
//
// THE NON-VACUITY CASE. "No score" has to mean "a named alternative exists", not "nothing is
// shown". The last test asserts the counts and the gap list are still there and still named.
// =====================================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  acceptOpportunity,
  completeOpportunity,
  confirmOpportunity,
  discoverProjects,
  type ProjectDiscoveryView,
} from './lifecycle.js';
import { FakeProjectStore } from './projectStore.fixtures.js';

const USER = 'user-1';
const NOW = new Date('2026-10-06T12:00:00.000Z');

const DIRECTORY = __dirname;
const SOURCE_FILES = readdirSync(DIRECTORY).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));

/** Comments removed and nothing else. Strings are KEPT: a percentage in a string is layer 2. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SCORE_WORDS: readonly string[] = [
  'score',
  'scoring',
  'rating',
  'grade',
  'percent',
  'percentage',
  'ratio',
  'fitScore',
  'matchScore',
  'overallScore',
];

/**
 * A `{…}%` run: a VALUE with a percentage glued to it.
 *
 * The content has to look like a variable or a member read, which is the shape that puts a
 * number on a screen - `{overlap}%`, `{candidate.ratio}%`. `${Math.round(x * 100)}%` inside a
 * message template is not that shape: it is prose explaining a measured number, and the repo's
 * rule about verdicts is about what a reader is shown, not about the ability to say "100% of the
 * tokens also appear in that repository".
 */
const PRESENTED_PERCENTAGE = /\{\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}\s*%/;

describe('layer 1: no module in projects/ names a derived score', () => {
  it('the sweep covers a real tree (a walk that found nothing would pass vacuously)', () => {
    expect(SOURCE_FILES.sort()).toEqual([
      'gaps.ts',
      'generate.ts',
      'lifecycle.ts',
      'projectStore.fixtures.ts',
      'references.ts',
      'research.ts',
    ]);
  });

  for (const file of SOURCE_FILES) {
    it(`${file} names no verdict and presents no percentage`, () => {
      const code = codeOnly(readFileSync(path.join(DIRECTORY, file), 'utf8'));
      const named = SCORE_WORDS.filter((word) =>
        new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`, 'i').test(code),
      );
      expect([file, named]).toEqual([file, []]);
      expect([file, PRESENTED_PERCENTAGE.test(code)]).toEqual([file, false]);
      // The two methods that ROUND a number into display text. An hours estimate is a count of
      // hours, never a display-precision figure.
      expect([file, code.includes('toFixed('), code.includes('toPrecision(')]).toEqual([file, false, false]);
    });
  }
});

describe('layer 2: the response types declare no numeric verdict member', () => {
  const code = codeOnly(readFileSync(path.join(DIRECTORY, 'lifecycle.ts'), 'utf8'));

  /** One `export interface X { … }` block, to the brace that closes it. */
  function interfaceBlock(name: string): string {
    const match = new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`).exec(code);
    expect(match, `expected ${name} to still be declared`).not.toBeNull();
    return match![0];
  }

  /**
   * The TOP-LEVEL members of a block.
   *
   * Brace-aware, because a nested object literal (`readonly counts: { … }`) declares members
   * too, and counting those would make "the shape of the response" a different assertion from
   * "the members of the response".
   */
  function members(block: string): string[] {
    const names: string[] = [];
    let depth = 0;
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      if (depth === 1) {
        const match = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(trimmed);
        if (match) names.push(match[1]);
      }
      depth += opens - closes;
      if (depth < 0) depth = 0;
    }
    return names;
  }

  it('`ProjectDiscoveryView` counts four NAMED things and adds no verdict', () => {
    expect(members(interfaceBlock('ProjectDiscoveryView')).sort()).toEqual([
      'candidates',
      'considered',
      'counts',
      'excludedGaps',
      'jobId',
      'matchReportId',
      'notes',
      'profileId',
      'proposalStage',
      'rejectedCandidates',
      'researchStage',
      'rule',
      'selectedGaps',
    ]);
    // The counts object is four integers over named things, and nothing else.
    const counts = interfaceBlock('ProjectDiscoveryView').match(/readonly counts: \{[\s\S]*?\n {2}\};/);
    expect(counts).not.toBeNull();
    expect(members(counts![0]).sort()).toEqual(['candidates', 'considered', 'excluded', 'selected']);
  });

  it('`ProjectOpportunityView` carries hours and difficulty, and no verdict', () => {
    const names = members(interfaceBlock('ProjectOpportunityView')).sort();
    expect(names).toEqual([
      'awaitingYourConfirmation',
      'completedAt',
      'createdAt',
      'difficulty',
      'estimatedHours',
      'id',
      'idea',
      'jobId',
      'plan',
      'producedBy',
      'profileId',
      'references',
      'relevance',
      'requirementIds',
      'stack',
      'status',
      'title',
      'verifiedClaimId',
    ]);
    // `estimatedHours` is the two-day BUDGET, not a rating of the person, and `difficulty` is
    // one of three named words. Neither is presented as a fit.
    expect(names).toContain('estimatedHours');
    expect(SCORE_WORDS.some((word) => names.includes(word))).toBe(false);
  });

  it('no `interface` in this directory declares a numeric verdict member at any depth', () => {
    const MEMBER_DECLARATION = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/gm;
    const offenders: string[] = [];
    for (const block of code.match(/export interface \w+ \{[\s\S]*?\n\}/g) ?? []) {
      for (const [, name] of block.matchAll(MEMBER_DECLARATION)) {
        if (SCORE_WORDS.includes(name.toLowerCase())) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('layer 3: a real response body carries no verdict either', () => {
  let view: ProjectDiscoveryView;

  beforeEach(async () => {
    const store = new FakeProjectStore();
    const seam = store.asProjectStore();
    store.seed('profiles', { id: 'prof-1', userId: USER });
    store.seed('jobs', { id: 'job-1', userId: USER, rawText: 'Kubernetes Kafka' });
    store.seed('requirements', {
      id: 'req-k8s',
      jobId: 'job-1',
      kind: 'required_skill',
      importance: 'must',
      text: 'Kubernetes',
      normalizedKey: 'kubernetes',
    });
    store.seed('requirements', {
      id: 'req-kafka',
      jobId: 'job-1',
      kind: 'required_skill',
      importance: 'should',
      text: 'Kafka',
      normalizedKey: 'kafka',
    });
    view = await discoverProjects(
      { userId: USER, jobId: 'job-1', runProvider: false, research: false, now: NOW },
      seam,
    );
  });

  it('the body has four integers, three-word difficulties, and a budget in hours', () => {
    expect(view.counts).toEqual({ considered: 2, selected: 2, excluded: 0, candidates: 2 });
    for (const candidate of view.candidates) {
      expect(['low', 'medium', 'high']).toContain(candidate.difficulty);
      expect(Number.isInteger(candidate.estimatedHours)).toBe(true);
      expect(candidate.estimatedHours).toBeGreaterThan(0);
      expect(candidate.estimatedHours).toBeLessThanOrEqual(16);
    }
  });

  it('no member anywhere in the body reads as a verdict', () => {
    const offenders: string[] = [];
    const walk = (value: unknown, at: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${at}[${index}]`));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const flagged = SCORE_WORDS.find((word) => word.toLowerCase() === key.toLowerCase());
        if (flagged !== undefined) offenders.push(`${at}.${key}`);
        walk(entry, `${at}.${key}`);
      }
    };
    walk(view, 'view');
    expect(offenders).toEqual([]);
  });

  it('NON-VACUITY: the gaps are still NAMED, and the notes still state the rule', () => {
    expect(view.considered.map((gap) => gap.text)).toEqual(['Kubernetes', 'Kafka']);
    expect(view.selectedGaps.every((gap) => gap.skillTargets.length > 0)).toBe(true);
    expect(view.notes).toMatch(/named gaps/);
    expect(view.rule).toMatch(/never adds anything to your profile/);
  });

  it('the decision responses are equally verdict-free', async () => {
    const store = new FakeProjectStore();
    const seam = store.asProjectStore();
    const opportunity = store.seed('opportunities', {
      userId: USER,
      profileId: 'prof-1',
      jobId: 'job-1',
      title: 'A two-day kubernetes project',
      idea: 'Build one small thing.',
      requirementsAddressed: ['req-k8s'],
      stack: ['kubernetes'],
      difficulty: 'medium',
      estimatedHours: 10,
      relevance: 'Closes the named gap.',
      plan: { day1: ['a'], day2: ['b'], milestones: ['c'], scope: { in: [], out: [] }, originalDesignDecision: 'd' },
      status: 'proposed',
    });
    const id = opportunity.id as string;

    const accepted = await acceptOpportunity({ userId: USER, opportunityId: id }, seam);
    const completed = await completeOpportunity({ userId: USER, opportunityId: id, now: NOW }, seam);
    const confirmed = await confirmOpportunity({ userId: USER, opportunityId: id, now: NOW }, seam);

    for (const decision of [accepted, completed, confirmed]) {
      expect(Object.keys(decision).sort()).toEqual([
        'changed',
        'claim',
        'claimVerification',
        'notes',
        'opportunity',
        'rule',
      ]);
    }
    // The confirmed claim's status is READ BACK from the career layer, never asserted here.
    expect(confirmed.claim?.status).toBe('user_confirmed');
  });
});