// =====================================================================================
// projects/references.test.ts - ACCEPTANCE ITEMS 2 AND 3: every reference has a LICENCE and
// an ACTIVITY SNAPSHOT, a no-licence repository is REJECTED, and an overlapping candidate is
// rejected by the anti-copy guard (06 sec. E.5's "GitHub research criteria" table and its
// "Anti-copying rule"; the screen and the guard in `projects/references.ts`).
//
// THE FOUR MUTATION TARGETS IN THIS FILE, so a reviewer can aim at them:
//   1. "MUTATION TARGET: a repository with NO licence is rejected, never recorded"
//   2. "MUTATION TARGET: `referenceRecord` refuses to build a row without a licence or a
//      complete activity snapshot"
//   3. "MUTATION TARGET: the OVERLAP FIXTURE - a candidate built out of a reference's own
//      words is rejected"
//   4. "MUTATION TARGET: the 18-month activity window, the README floor and the two-day
//      budget each refuse on their own"
// plus the source guard that this directory's criteria are a pure function of
// (repository facts, injected clock) - no provider, no store, no ambient clock.
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ACTIVITY_SNAPSHOT_KEYS,
  activityCutoff,
  ALLOWED_LICENCES,
  ANTI_COPY_OVERLAP_MAX,
  assertCandidateIsOriginal,
  checkCandidateIsOriginal,
  containmentOverlap,
  estimateReferenceHours,
  MAX_REFERENCE_AGE_MONTHS,
  MIN_README_CHARS,
  ProjectReferenceError,
  REFERENCE_REJECTION_REASONS,
  referenceOverlapText,
  referenceRecord,
  requiresPaidServiceOrGpu,
  screenReference,
  severityForReferenceHours,
  TWO_DAY_BUDGET_HOURS,
  type ReferenceAcceptance,
  type RepositoryFacts,
} from './references.js';

/**
 * The clock. INJECTED everywhere, which is what makes "within 18 months" a fact about a
 * literal rather than about the day the suite runs.
 */
const NOW = new Date('2026-10-06T12:00:00.000Z');

/** A README long enough to document something, with a usage section. */
const README = [
  '# Queuewright',
  '',
  'Queuewright is a small at-least-once job queue for Node services. It gives you one',
  'primitive: a durable FIFO queue whose workers acknowledge a message only after the',
  'handler returns, and re-queue anything that fails with exponential backoff.',
  '',
  '## Usage',
  '',
  '```',
  'const q = new Queuewright("mailer");',
  'await q.push({ to: "a@example.com" });',
  '```',
  '',
  'Messages carry a stable idempotency key so a redelivery never sends twice.',
].join('\n');

/** A repository that passes every criterion. The baseline every refusal mutates. */
function goodFacts(overrides: Partial<RepositoryFacts> = {}): RepositoryFacts {
  return {
    fullName: 'queuewright/queuewright',
    htmlUrl: 'https://github.com/queuewright/queuewright',
    description: 'A small at-least-once job queue for Node services.',
    stargazersCount: 812,
    forksCount: 41,
    openIssuesCount: 7,
    // Six months before NOW: comfortably inside the window.
    pushedAt: '2026-04-01T00:00:00.000Z',
    archived: false,
    size: 240,
    language: 'TypeScript',
    license: { spdxId: 'mit' },
    topics: ['queue', 'node'],
    readme: README,
    releasesCount: 4,
    ...overrides,
  };
}

/** The screen's two outcomes, narrowed for an assertion. */
function refusal(facts: RepositoryFacts): { reason: string; detail: string } {
  const screen = screenReference(facts, NOW);
  if ('accepted' in screen) {
    throw new Error(`expected a refusal, got an acceptance of ${screen.url}`);
  }
  return { reason: screen.reason, detail: screen.detail };
}

function acceptance(facts: RepositoryFacts): ReferenceAcceptance {
  const screen = screenReference(facts, NOW);
  if (!('accepted' in screen)) {
    throw new Error(`expected an acceptance, got ${screen.reason}: ${screen.detail}`);
  }
  return screen;
}

// ---------------------------------------------------------------------------
// ACCEPTANCE 2 - the licence
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 2 (MUTATION TARGET 1): a repository with NO licence is rejected, never recorded', () => {
  it('MUTATION TARGET: no licence file at all is `no_licence`, and it is refused FIRST', () => {
    // First, deliberately: a repository with no licence that is ALSO stale must be reported as
    // the no-licence it is, because that is the refusal a reader has to act on.
    expect(refusal(goodFacts({ license: null, pushedAt: '2019-01-01T00:00:00.000Z' }))).toEqual({
      reason: 'no_licence',
      detail: expect.stringContaining('no permission'),
    });
    expect(refusal(goodFacts({ license: undefined })).reason).toBe('no_licence');
    // An empty or non-string SPDX id is the same state, not a licence.
    expect(refusal(goodFacts({ license: { spdxId: '' } })).reason).toBe('no_licence');
    expect(refusal(goodFacts({ license: { spdxId: null } })).reason).toBe('no_licence');
    expect(refusal(goodFacts({ license: 'MIT' as never })).reason).toBe('no_licence');
  });

  it('names the copyleft families E.5 excludes, and every non-allowlisted licence', () => {
    for (const licence of ['GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'SSPL-1.0', 'OSL-3.0']) {
      const result = refusal(goodFacts({ license: { spdxId: licence } }));
      expect([licence, result.reason, result.detail]).toEqual([licence, 'licence_not_allowed', expect.stringContaining('copyleft')]);
    }
    // A real licence that is simply not on the list is refused too, and says which ones are.
    const unknown = refusal(goodFacts({ license: { spdxId: 'unlicense' } }));
    expect(unknown.reason).toBe('licence_not_allowed');
    expect(unknown.detail).toContain('MIT');
  });

  it('the allowlist is exactly E.5\'s set, permissive licences only', () => {
    expect([...ALLOWED_LICENCES].sort()).toEqual([
      'APACHE-2.0',
      'BSD-2-CLAUSE',
      'BSD-3-CLAUSE',
      'ISC',
      'MIT',
      'MPL-2.0',
    ]);
    // No copyleft id, and no bare family word: `BSD` was split into its two clauses.
    for (const licence of ALLOWED_LICENCES) {
      expect([licence, /^(GPL|AGPL|LGPL|SSPL|OSL|BSD$)/.test(licence)]).toEqual([licence, false]);
    }
  });

  it('MUTATION TARGET: `referenceRecord` refuses to build a row without a licence it may draw on', () => {
    const accepted = acceptance(goodFacts());
    // The write path throws rather than returning a row, so a caller cannot record one by
    // ignoring a return value.
    expect(() => referenceRecord({ ...accepted, licence: '' })).toThrowError(ProjectReferenceError);
    try {
      referenceRecord({ ...accepted, licence: '' });
    } catch (error) {
      expect([(error as ProjectReferenceError).reason, (error as ProjectReferenceError).referenceUrl]).toEqual([
        'no_licence',
        accepted.url,
      ]);
    }
    expect(() => referenceRecord({ ...accepted, licence: 'GPL-3.0' })).toThrowError(
      ProjectReferenceError,
    );
    // And the licence it DOES build is normalised, so `mit` and `MIT` cannot be two licences.
    expect(referenceRecord({ ...accepted, licence: ' mit ' }).licence).toBe('MIT');
  });

  it('MUTATION TARGET: a reference is never recorded without a COMPLETE activity snapshot', () => {
    const accepted = acceptance(goodFacts());
    for (const key of ACTIVITY_SNAPSHOT_KEYS) {
      const activity = { ...accepted.activity } as Record<string, unknown>;
      delete activity[key];
      expect([key, () => referenceRecord({ ...accepted, activity: activity as never }) as unknown]).toEqual([
        key,
        expect.any(Function),
      ]);
      expect(() => referenceRecord({ ...accepted, activity: activity as never })).toThrowError(
        ProjectReferenceError,
      );
    }
    // Every key the criteria table asks for is in the inventory - otherwise "complete" would be
    // a shorter list than the record.
    for (const key of ['stars', 'forks', 'pushedAt', 'archived', 'license', 'hasReleases']) {
      expect(ACTIVITY_SNAPSHOT_KEYS).toContain(key);
    }
    // The snapshot carries the values the screen measured, not a guess made later.
    const row = referenceRecord(accepted);
    expect([
      row.activity.stars,
      row.activity.pushedAt,
      row.activity.archived,
      row.activity.hasReleases,
      row.activity.readmeChars,
    ]).toEqual([812, '2026-04-01T00:00:00.000Z', false, true, README.trim().length]);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 2 - the other five criteria
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 2 (MUTATION TARGET 4): each criterion refuses on its own', () => {
  it('the activity window is 18 months, measured from the INJECTED clock', () => {
    expect(MAX_REFERENCE_AGE_MONTHS).toBe(18);
    // Six months inside: accepted.
    expect('accepted' in screenReference(goodFacts({ pushedAt: '2026-04-01T00:00:00.000Z' }), NOW)).toBe(true);
    // Nineteen months before NOW: refused.
    expect(refusal(goodFacts({ pushedAt: '2025-03-01T00:00:00.000Z' })).reason).toBe('stale_activity');
    // The boundary is the cutoff itself, and it is INCLUSIVE: a push exactly at the cutoff is
    // still inside the window. The cutoff is read from the module rather than recomputed here,
    // because a second spelling of "18 months" would drift from the one the screen uses.
    const cutoff = activityCutoff(NOW);
    // ...and it really is 18 months back: 18 x 30.44 days, and no more than a day either way.
    const daysBack = (NOW.getTime() - cutoff.getTime()) / (1000 * 60 * 60 * 24);
    expect([daysBack > 18 * 30, daysBack < 18 * 31]).toEqual([true, true]);
    expect(refusal(goodFacts({ pushedAt: new Date(cutoff.getTime() - 1).toISOString() })).reason).toBe(
      'stale_activity',
    );
    expect('accepted' in screenReference(goodFacts({ pushedAt: cutoff.toISOString() }), NOW)).toBe(true);
    // No date at all is a refusal, not a pass: there is no evidence it is maintained.
    expect(refusal(goodFacts({ pushedAt: null })).reason).toBe('stale_activity');
    expect(refusal(goodFacts({ pushedAt: 'not a date' })).reason).toBe('stale_activity');
  });

  it('no releases AND no documented usage is a refusal; either one is enough', () => {
    expect(refusal(goodFacts({ releasesCount: 0, readme: README.replace('## Usage', '## Notes') })).reason).toBe(
      'no_releases_or_documented_usage',
    );
    // A release alone carries it.
    const noUsage = README.replace('## Usage', '## Notes');
    expect('accepted' in screenReference(goodFacts({ releasesCount: 1, readme: noUsage }), NOW)).toBe(true);
    // Usage documentation alone carries it.
    expect('accepted' in screenReference(goodFacts({ releasesCount: 0, readme: README }), NOW)).toBe(true);
  });

  it('the README floor is a floor, not a smell test', () => {
    expect(refusal(goodFacts({ readme: 'short' })).detail).toContain(String(MIN_README_CHARS));
    // A README with no usage section AND no releases still fails on the documentation floor
    // once it is long enough, which is why the usage check runs first.
    const long = `${'documentation '.repeat(30)}\n## Notes\n`;
    expect(refusal(goodFacts({ readme: long, releasesCount: 0 })).reason).toBe(
      'no_releases_or_documented_usage',
    );
  });

  it('difficulty is a deterministic function of the public facts, against the two-day budget', () => {
    // A 240KB repo is a weekend read; a 50MB one is a platform.
    expect(estimateReferenceHours(goodFacts())).toBe(1);
    expect(estimateReferenceHours(goodFacts({ size: 20_000 }))).toBe(40);
    expect(refusal(goodFacts({ size: 9_000 })).reason).toBe('beyond_two_day_budget');
    // The three named terms, each of which can be argued with on its own: +4 for a large
    // open-issue count, +4 for neither a release nor a topic.
    expect(estimateReferenceHours(goodFacts({ size: 0, openIssuesCount: 500 }))).toBe(4);
    expect(estimateReferenceHours(goodFacts({ size: 0, openIssuesCount: 0, topics: [], releasesCount: 0 }))).toBe(4);
    expect(estimateReferenceHours(goodFacts({ size: 0, openIssuesCount: 500, topics: [], releasesCount: 0 }))).toBe(8);
    // Three NAMED words, never a number: `high` means "past the budget".
    expect(severityForReferenceHours(TWO_DAY_BUDGET_HOURS)).toBe('medium');
    expect(severityForReferenceHours(TWO_DAY_BUDGET_HOURS + 1)).toBe('high');
    expect(severityForReferenceHours(2)).toBe('low');
  });

  it('a README that needs money or special hardware is refused, on token sets', () => {
    for (const readme of [
      `${README}\n\nRequires a paid subscription for the hosted tier.`,
      `${README}\n\nRuns on a single NVIDIA GPU.`,
      `${README}\n\nSet a license key before starting.`,
    ]) {
      expect(refusal(goodFacts({ readme })).reason).toBe('requires_paid_service_or_gpu');
    }
    // The substring traps, which is why the single-word phrases are matched as tokens. Each of
    // these CONTAINS a banned word without BEING one.
    for (const readme of [
      `${README}\n\nRepaid invoices are not required.`,
      `${README}\n\nCapitalised throughput, in-memory queue.`,
      `${README}\n\nIt runs on a gpu-less container runtime.`,
    ]) {
      expect(requiresPaidServiceOrGpu(readme)).toBe(false);
    }
    // The MULTI-WORD phrases are matched on the text itself, deliberately: "license key" and
    // "api key" are two words, and a token-set lookup would need a sequence walk to see them.
    // The cost of that choice is stated in `references.ts` - a README that says it needs NO api
    // key is refused - and it is the right way round for this criterion, because a reference
    // that cannot be run without a key is a bad inspiration even when it says "no key needed".
    expect(requiresPaidServiceOrGpu(`${README}\n\nSet your API key first.`)).toBe(true);
    expect(requiresPaidServiceOrGpu('')).toBe(false);
    expect(requiresPaidServiceOrGpu(undefined)).toBe(false);
  });

  it('a search hit that is not a repository is refused before anything else', () => {
    expect(refusal(goodFacts({ htmlUrl: '' })).reason).toBe('not_a_repository');
    expect(refusal(goodFacts({ fullName: null })).reason).toBe('not_a_repository');
  });

  it('every refusal it can emit is in the closed vocabulary', () => {
    const reasons = new Set<string>(REFERENCE_REJECTION_REASONS);
    const emitted = [
      refusal(goodFacts({ license: null })).reason,
      refusal(goodFacts({ license: { spdxId: 'GPL-3.0' } })).reason,
      refusal(goodFacts({ pushedAt: '2019-01-01T00:00:00.000Z' })).reason,
      refusal(goodFacts({ releasesCount: 0, readme: 'tiny' })).reason,
      refusal(goodFacts({ size: 9_000 })).reason,
      refusal(goodFacts({ readme: `${README}\n\nNeeds a paid plan.` })).reason,
      refusal(goodFacts({ htmlUrl: '' })).reason,
    ];
    for (const reason of emitted) expect(reasons.has(reason)).toBe(true);
    // And every refusal says WHY in prose, because the UI renders this string to the user.
    for (const detail of [
      refusal(goodFacts({ license: null })).detail,
      refusal(goodFacts({ pushedAt: '2019-01-01T00:00:00.000Z' })).detail,
    ]) {
      expect(detail.length).toBeGreaterThan(40);
      expect(/^[\x20-\x7e]+$/.test(detail)).toBe(true);
    }
  });

  it('the stored excerpt is an EXCERPT: enough to measure, not enough to copy a project from', () => {
    const long = `${README}\n\n${'filler sentence about the queue. '.repeat(200)}`;
    const row = referenceRecord(acceptance(goodFacts({ readme: long })));
    expect(row.notes.length).toBeLessThan(long.length);
    expect(row.notes.length).toBeLessThanOrEqual(1_200);
    expect(row.notes).toContain('Queuewright');
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 3 - the anti-copy guard, and the OVERLAP FIXTURE
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 3 (MUTATION TARGET 3): the OVERLAP FIXTURE - a reimplementation is rejected', () => {
  /** The reference, as it is stored: the excerpt plus its title. */
  const stored = referenceRecord(acceptance(goodFacts()));
  const reference = {
    url: stored.url,
    title: stored.title,
    notes: stored.notes,
  };

  /**
   * THE FIXTURE, and it is one sentence rather than a paraphrase on purpose.
   *
   * It is lifted from the reference README's own headline paragraph, so every token of the
   * candidate's text really is in the reference: the containment measure must read 1.0 and the
   * guard must refuse. A paraphrase would prove nothing, because a paraphrase is exactly what a
   * legitimate candidate is.
   */
  const REIMPLEMENTATION = [
    'Queuewright is a small at-least-once job queue for Node services.',
    'It gives you one primitive: a durable FIFO queue whose workers acknowledge a message only',
    'after the handler returns, and re-queue anything that fails with exponential backoff.',
    'Messages carry a stable idempotency key so a redelivery never sends twice.',
  ].join(' ');

  /**
   * The near miss, and it is NOT a paraphrase either: it is a genuinely different project in
   * the same space, sharing only the vocabulary anyone building in that space would share
   * ("queue", "worker", "retry"). It must SURVIVE, because a threshold of zero would reject
   * every candidate and teach the user that this screen never finds anything wrong.
   */
  const ORIGINAL_PROJECT = [
    'Build one small thing that uses Kafka end to end, so this job\'s "event streaming"',
    'requirement has something real behind it instead of a claim with no repository.',
    'Scaffold the project and write down what Kafka has to do before any code.',
    'Add the failure cases: what happens when a consumer group rebalances mid-batch.',
    'Everything sits behind one small interface so the rest can be tested without a broker.',
  ].join(' ');

  it('the measure is CONTAINMENT, so a short candidate inside a long README still scores 1.0', () => {
    // The asymmetry is the point: the candidate is 4 sentences and the README is longer, so a
    // Jaccard overlap would call this 0.2 and wave it through.
    expect(containmentOverlap(REIMPLEMENTATION, referenceOverlapText(reference))).toBe(1);
    expect(containmentOverlap(REIMPLEMENTATION, referenceOverlapText(reference))).toBeGreaterThan(
      ANTI_COPY_OVERLAP_MAX,
    );
    // The reverse direction is the other question and is answered differently: a long README
    // containing a short candidate is not the candidate copying the README.
    expect(containmentOverlap(referenceOverlapText(reference), REIMPLEMENTATION)).toBeLessThan(1);
  });

  it('MUTATION TARGET: the reimplementation is REFUSED, naming the reference it overlaps', () => {
    // The plan and the design decision are written in the reference's own vocabulary too, so
    // the measured number is exactly 1.0 rather than "somewhere above the threshold" - a
    // fixture that only just fails would not pin the rule.
    const verdict = checkCandidateIsOriginal(
      {
        idea: REIMPLEMENTATION,
        planText: 'Queuewright is a small at-least-once job queue for Node services.',
        originalDesignDecision:
          'Messages carry a stable idempotency key so a redelivery never sends twice.',
      },
      [reference],
    );
    expect(verdict.original).toBe(false);
    if (verdict.original) throw new Error('unreachable');
    expect([verdict.reason, verdict.referenceUrl, verdict.overlap]).toEqual([
      'overlaps_a_reference',
      stored.url,
      1,
    ]);
    // The message names the number and the threshold, because "it overlapped" is not
    // actionable and the number is.
    expect(verdict.detail).toContain('100%');
    expect(verdict.detail).toContain(`${Math.round(ANTI_COPY_OVERLAP_MAX * 100)}%`);
    expect(verdict.detail).toContain('inspiration');
  });

  it('the throwing form throws the typed error, so a caller cannot ignore the verdict', () => {
    const candidate = {
      idea: REIMPLEMENTATION,
      planText: 'Queuewright is a small at-least-once job queue for Node services.',
      originalDesignDecision:
        'Messages carry a stable idempotency key so a redelivery never sends twice.',
    };
    expect(() => assertCandidateIsOriginal(candidate, [reference])).toThrowError(
      ProjectReferenceError,
    );
    try {
      assertCandidateIsOriginal(candidate, [reference]);
    } catch (error) {
      expect([(error as ProjectReferenceError).code, (error as ProjectReferenceError).overlap]).toEqual([
        'project_reference',
        1,
      ]);
    }
  });

  it('an ORIGINAL project in the same space SURVIVES', () => {
    const verdict = checkCandidateIsOriginal(
      { idea: ORIGINAL_PROJECT, planText: 'Then document it.', originalDesignDecision: 'One interface.' },
      [reference],
    );
    expect(verdict).toEqual({ original: true });
    // ...and its overlap is measured and low, not merely unmeasured.
    expect(containmentOverlap(ORIGINAL_PROJECT, referenceOverlapText(reference))).toBeLessThan(
      ANTI_COPY_OVERLAP_MAX,
    );
  });

  it('a candidate with NO original design decision is refused before any text is compared', () => {
    // E.5's output requirement ("the plan must name at least one ORIGINAL design decision")
    // is part of the anti-copying rule: a plan assembled out of references has not been
    // designed, and there is nothing to compare.
    const verdict = checkCandidateIsOriginal(
      { idea: ORIGINAL_PROJECT, planText: '', originalDesignDecision: '   ' },
      [reference],
    );
    expect(verdict.original).toBe(false);
    if (verdict.original) throw new Error('unreachable');
    expect([verdict.reason, verdict.referenceUrl, verdict.overlap]).toEqual([
      'no_original_design_decision',
      null,
      null,
    ]);
  });

  it('NO references means the guard has nothing to compare, and that is not a refusal', () => {
    // The offline path: with no network there are no references, and the candidate is still
    // produced. The guard is about copying, not about having looked.
    expect(
      checkCandidateIsOriginal(
        { idea: ORIGINAL_PROJECT, planText: '', originalDesignDecision: 'One interface.' },
        [],
      ),
    ).toEqual({ original: true });
  });

  it('"nothing was compared" is 0, never a pass by accident', () => {
    expect(containmentOverlap('', referenceOverlapText(reference))).toBe(0);
    expect(containmentOverlap(REIMPLEMENTATION, '')).toBe(0);
    expect(containmentOverlap(undefined, undefined)).toBe(0);
    // Case and punctuation are irrelevant: "Queuewright." and "queuewright" are one token.
    expect(containmentOverlap('Queuewright is nice', 'queuewright is nice')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The source guard: the criteria are a pure function of (facts, clock)
// ---------------------------------------------------------------------------

describe('the reference criteria cannot reach a provider, a store or an ambient clock', () => {
  const code = (() => {
    const source = readFileSync(path.join(__dirname, 'references.ts'), 'utf8');
    return source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  })();

  it('names no provider, no network, no randomness and no store', () => {
    for (const banned of [
      'runLlmCompletion',
      'leaseNextLlmKey',
      'createLlmClient',
      'keyManager',
      'Date.now',
      'fetch',
      'Math.random',
      'lib/prisma',
      'PrismaClient',
      '$transaction',
    ]) {
      expect([banned, code.includes(banned)]).toEqual([banned, false]);
    }
  });

  it('takes `now` as an argument rather than reading a clock', () => {
    // `new Date(x)` appears - it has to, to build a cutoff - but never `new Date()`, which is
    // the only spelling that reads an ambient clock. Both time-sensitive functions take `now`.
    expect(code).not.toMatch(/new Date\(\s*\)/);
    expect(code).not.toContain('Date.now');
    expect(code).toMatch(/now: Date/);
  });
});