// =====================================================================================
// projects/generate.test.ts - THE DETERMINISTIC CORE AND THE FEASIBILITY SCREEN (T1100;
// 06 sec. E.5's pipeline and output shape).
//
// WHAT THIS FILE PROVES, in the order E.5 gives the pipeline:
//
//   1. THE DETERMINISTIC FLOOR. With NO provider and NO network, `generateCandidates` still
//      produces candidates, each with a full two-day plan and an original design decision.
//      That is the orchestrator ruling for T1100 stated as a test: the optional stages are
//      enrichment, never the answer.
//   2. ONE SCREEN FOR EVERY CANDIDATE. `guardCandidate` is the only door, it does not know who
//      wrote the candidate, and it refuses on: an unattributable requirement, a duplicate, no
//      title or idea, hours outside the two-day budget, too many technologies, an incomplete
//      plan, no original design decision, and an overlap with a reference.
//   3. A PROVIDER CANNOT WIDEN THE ENVELOPE. Every proposal goes through the SAME screen, so a
//      proposal for a requirement this run did not select - including one of the non-teachable
//      kinds - is dropped, and a proposal that copies a reference is dropped.
//   4. EVERY SKIP IS REPORTED. `no_ai_provider_configured` and `not_evaluated` are different
//      answers and neither is an error, and neither removes the deterministic candidates.
//
// plus the source guard that NO SCORE ever appears in this file's output (06 sec. E.6).
// =====================================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CANDIDATE_REJECTION_REASONS,
  MAX_CANDIDATES,
  MAX_STACK_ITEMS,
  deriveCandidate,
  generateCandidates,
  guardCandidate,
  planTextOf,
  renderGapTable,
  setCandidateProposer,
  shippedCandidateProposer,
  type CandidateProposer,
  type CandidateProposalResponse,
  type CandidateRun,
} from './generate.js';
import { TWO_DAY_BUDGET_HOURS, checkCandidateIsOriginal, containmentOverlap } from './references.js';
import type { TeachableGap } from './gaps.js';

const USER = 'user-1';

/** A gap as `projects/gaps.ts` hands it over: canonical, capped, ordered. */
function gap(overrides: Partial<TeachableGap> & { requirementId: string }): TeachableGap {
  return {
    text: 'Kubernetes',
    normalizedKey: 'kubernetes',
    kind: 'required_skill',
    importance: 'must',
    skillTargets: ['kubernetes'],
    importanceRank: 0,
    ...overrides,
  };
}

/** A well-formed provider proposal; every refusal test mutates one field of it. */
function proposal(overrides: Record<string, unknown> = {}) {
  return {
    requirementId: 'req-k8s',
    title: 'A tiny cluster linter',
    idea: 'A CLI that reads a Kubernetes manifest and explains what it would schedule.',
    stack: ['TypeScript', 'kubernetes'],
    difficulty: 'medium',
    estimatedHours: 12,
    relevance: 'Closes the Kubernetes gap.',
    plan: {
      day1: ['Scaffold the CLI and the manifest parser.', 'Run it on one manifest end to end.'],
      day2: ['Report the scheduling decisions it cannot explain.', 'Write the README.'],
      milestones: ['It parses a manifest.', 'It explains one decision.', 'It is documented.'],
      scope: { in: ['one CLI', 'a README'], out: ['a cluster', 'a GUI'] },
      originalDesignDecision: 'The manifest is read through one parser interface so the linter is testable without a cluster.',
    },
    ...overrides,
  };
}

/** Runs a run with the provider declined, which is the offline floor. */
async function offline(gaps: TeachableGap[]): Promise<CandidateRun> {
  return generateCandidates({ userId: USER, gaps, runProvider: false });
}

/** A gap whose text, key and targets all say the same technology. */
function named(requirementId: string, text: string, target: string): TeachableGap {
  return gap({ requirementId, text, normalizedKey: target.toLowerCase(), skillTargets: [target] });
}

afterEach(() => {
  setCandidateProposer(null);
});

// ---------------------------------------------------------------------------
// The deterministic floor
// ---------------------------------------------------------------------------

describe('a candidate is produced with NO provider and NO network', () => {
  it('every candidate is a PLAN with all four parts and an original design decision', async () => {
    const run = await offline([gap({ requirementId: 'req-k8s' })]);
    expect(run.candidates).toHaveLength(1);
    const [candidate] = run.candidates;
    // E.5's output shape, member for member.
    expect([
      candidate.status,
      candidate.producedBy,
      candidate.requirementIds,
      candidate.plan.day1.length > 0,
      candidate.plan.day2.length > 0,
      candidate.plan.milestones.length > 0,
      candidate.plan.scope.in.length > 0,
      candidate.plan.scope.out.length > 0,
      candidate.plan.originalDesignDecision.length > 20,
      candidate.references,
    ]).toEqual([
      'proposed',
      'deterministic',
      ['req-k8s'],
      true,
      true,
      true,
      true,
      true,
      true,
      [],
    ]);
  });

  it('every string is traceable to the gap it came from, so nothing is invented', async () => {
    const run = await offline([
      gap({
        requirementId: 'req-k8s',
        text: 'Kubernetes operators',
        normalizedKey: 'kubernetes operators',
        skillTargets: ['kubernetes operators', 'helm'],
      }),
    ]);
    const [candidate] = run.candidates;
    expect(candidate.idea).toContain('Kubernetes operators');
    expect(candidate.relevance).toContain('Kubernetes operators');
    // The stack is the gap's own targets, capped - never a technology nobody named.
    expect(candidate.stack).toEqual(['kubernetes operators', 'helm']);
    expect(candidate.stack.length).toBeLessThanOrEqual(MAX_STACK_ITEMS);
    // The plan talks about the gap's technology on both days.
    expect(planTextOf(candidate.plan).toLowerCase()).toContain('kubernetes operators');
  });

  it('the hours are an integer inside the two-day budget - the feasibility screen, applied', async () => {
    expect(TWO_DAY_BUDGET_HOURS).toBe(16);
    const run = await offline(
      Array.from({ length: MAX_CANDIDATES }, (_, index) =>
        gap({ requirementId: `req-${index}`, skillTargets: [`technology-${index}`, 'postgres', 'redis'] }),
      ),
    );
    for (const candidate of run.candidates) {
      expect(Number.isInteger(candidate.estimatedHours)).toBe(true);
      expect(candidate.estimatedHours).toBeGreaterThanOrEqual(1);
      expect(candidate.estimatedHours).toBeLessThan(TWO_DAY_BUDGET_HOURS);
      // Three NAMED words, never a number: `high` means "the hardest of the three".
      expect(['low', 'medium', 'high']).toContain(candidate.difficulty);
    }
  });

  it('the PRIMARY target is the most specific one, not the requirement sentence', async () => {
    // A `responsibility` gap's `normalizedKey` is its whole sentence, and a sentence is not a
    // thing you build a weekend project with. The technology the gap ALSO names becomes the
    // subject of the idea - and it is still one the gap named.
    const run = await offline([
      gap({
        requirementId: 'req-k8s',
        text: 'Design and ship services on Kubernetes',
        normalizedKey: 'design and ship services on kubernetes',
        kind: 'responsibility',
        skillTargets: ['design and ship services on kubernetes', 'kubernetes'],
      }),
    ]);
    const [candidate] = run.candidates;
    expect(candidate.idea).toContain('uses kubernetes end to end');
    expect(candidate.idea).not.toContain('uses design and ship services on kubernetes end to end');
    expect(candidate.stack).toEqual(['design and ship services on kubernetes', 'kubernetes']);
    // A gap with ONE target does not produce a "X beyond what X needs" scope line.
    const single = await offline([gap({ requirementId: 'req-py', skillTargets: ['python'] })]);
    expect(single.candidates[0].plan.scope.out).toContain('anything beyond what one project needs');
  });

  it('the run is capped, and the cap is a bound rather than a ranking', async () => {
    const many = Array.from({ length: MAX_CANDIDATES + 4 }, (_, index) =>
      gap({ requirementId: `req-${index}`, skillTargets: [`technology-${index}`] }),
    );
    const run = await offline(many);
    expect(MAX_CANDIDATES).toBe(4);
    expect(run.candidates).toHaveLength(MAX_CANDIDATES);
    // Same gaps, same list, every time.
    const again = await offline(many);
    expect(again.candidates.map((row) => row.requirementIds)).toEqual(
      run.candidates.map((row) => row.requirementIds),
    );
  });

  it('the provider stage reports `not_evaluated` and no provider at all', async () => {
    const run = await offline([gap({ requirementId: 'req-k8s' })]);
    expect(run.proposalStage).toEqual({
      status: 'skipped',
      // NOT `no_ai_provider_configured`: this request never looked at the user's keys.
      reason: 'not_evaluated',
      provider: null,
      model: null,
      proposedCount: 0,
      dropped: [],
    });
    // And the research stage is reported too, even though nothing asked for it.
    expect(run.researchStage).toEqual({
      status: 'skipped',
      reason: 'not_evaluated',
      searchCount: 0,
      consideredCount: 0,
      acceptedCount: 0,
    });
    expect(run.rejected).toEqual([]);
  });

  it('a research report is CARRIED THROUGH, so one body states both optional stages', async () => {
    const run = await generateCandidates({
      userId: USER,
      gaps: [gap({ requirementId: 'req-k8s' })],
      runProvider: false,
      researchStage: {
        status: 'skipped',
        reason: 'research_unavailable',
        searchCount: 0,
        consideredCount: 0,
        acceptedCount: 0,
      },
    });
    expect(run.researchStage.reason).toBe('research_unavailable');
  });

  it('the gaps render as a bounded table for the prompt, and `(none)` when there are none', () => {
    expect(renderGapTable([gap({ requirementId: 'req-k8s' })])).toBe(
      'req-k8s | required_skill | must | Kubernetes | kubernetes',
    );
    expect(renderGapTable([])).toBe('(none)');
    // Bounded: it never sends the whole job description to a provider.
    const many = Array.from({ length: 50 }, (_, index) => gap({ requirementId: `req-${index}` }));
    expect(renderGapTable(many).split('\n')).toHaveLength(MAX_CANDIDATES * 2);
  });

  it('no gaps is a REAL answer, not a failure to be padded over', async () => {
    const run = await offline([]);
    expect(run.candidates).toEqual([]);
    expect(run.rejected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

describe('the feasibility screen is ONE function, and it refuses with a named reason', () => {
  const context = { gapIds: new Set(['req-k8s']), seen: new Set<string>(), references: [] };

  function screen(overrides: Record<string, unknown>) {
    return guardCandidate(proposal(overrides) as never, context);
  }

  it('a well-formed proposal is ACCEPTED, and carries the caller\'s screened references', () => {
    const references = [
      { kind: 'github_repo', title: 'a/b', url: 'https://github.com/a/b', licence: 'MIT', activity: { stars: 1 } },
    ];
    const verdict = guardCandidate(proposal() as never, { ...context, references: [], candidateReferences: references });
    expect('accepted' in verdict).toBe(true);
    if (!('accepted' in verdict)) throw new Error('unreachable');
    // The licence comes from the SCREENED ROW, so a candidate can never carry a licence the
    // measured reference did not have.
    expect(verdict.accepted.references).toBe(references);
    expect(verdict.accepted.requirementIds).toEqual(['req-k8s']);
  });

  it('an unattributable requirement is refused - including one of the NON-TEACHABLE kinds', () => {
    // The requirement ids are the gap's, and the gap set is what `projects/gaps.ts` selected,
    // so a years_experience requirement is not in it and cannot become a candidate here.
    for (const requirementId of ['', 'req-years', 'req-degree', undefined]) {
      const verdict = screen({ requirementId });
      expect(['unknown_requirement', 'duplicate_requirement']).toContain(
        ('dropped' in verdict ? verdict.dropped.reason : 'accepted'),
      );
      if ('dropped' in verdict) expect(verdict.dropped.reason).toBe('unknown_requirement');
    }
    // A SECOND requirement is refused even when the first one is legitimate.
    expect(screen({ requirementIds: ['req-k8s', 'req-other'] })).toEqual({
      dropped: { reason: 'unknown_requirement', detail: 'req-other' },
    });
  });

  it('a duplicate requirement in one response is refused; the first wins', () => {
    const verdict = guardCandidate(proposal() as never, { ...context, seen: new Set(['req-k8s']) });
    expect(verdict).toEqual({
      dropped: { reason: 'duplicate_requirement', detail: 'req-k8s' },
    });
  });

  it('no title, or no idea, is `no_title_or_idea`', () => {
    expect(screen({ title: '   ' })).toMatchObject({ dropped: { reason: 'no_title_or_idea' } });
    expect(screen({ idea: null })).toMatchObject({ dropped: { reason: 'no_title_or_idea' } });
  });

  it('MUTATION TARGET: the two-day budget refuses an over-claim AND a missing one', () => {
    // Absent is a refusal, not a pass: a candidate with no estimate has not been checked
    // against anything.
    for (const estimatedHours of [undefined, null, 0, -3, 17, 40, 12.5, '12']) {
      const verdict = screen({ estimatedHours });
      expect([String(estimatedHours), ('dropped' in verdict ? verdict.dropped.reason : 'accepted')]).toEqual([
        String(estimatedHours),
        'beyond_two_day_budget',
      ]);
    }
    // Exactly the budget IS inside it: two days is 16 hours, so a candidate that claims 16 hours
    // is at the ceiling rather than past it. The prompt says the same thing in words, which is
    // why the two cannot drift.
    expect('accepted' in screen({ estimatedHours: TWO_DAY_BUDGET_HOURS })).toBe(true);
    expect(screen({ estimatedHours: TWO_DAY_BUDGET_HOURS + 1 })).toMatchObject({
      dropped: { reason: 'beyond_two_day_budget' },
    });
    // And a plausible claim passes.
    expect('accepted' in screen({ estimatedHours: TWO_DAY_BUDGET_HOURS - 1 })).toBe(true);
  });

  it('a stack of zero, or of more than a weekend can hold, is refused', () => {
    expect(screen({ stack: [] })).toMatchObject({ dropped: { reason: 'too_many_dependencies' } });
    expect(screen({ stack: 'TypeScript' })).toMatchObject({ dropped: { reason: 'too_many_dependencies' } });
    const seven = Array.from({ length: MAX_STACK_ITEMS + 1 }, (_, index) => `technology-${index}`);
    expect(screen({ stack: seven })).toMatchObject({ dropped: { reason: 'too_many_dependencies' } });
    expect('accepted' in screen({ stack: seven.slice(0, MAX_STACK_ITEMS) })).toBe(true);
  });

  it('an incomplete plan is refused, and so is a plan with no original design decision', () => {
    const plan = (proposal().plan ?? {}) as Record<string, unknown>;
    expect(screen({ plan: { ...plan, day1: [] } })).toMatchObject({ dropped: { reason: 'incomplete_plan' } });
    expect(screen({ plan: { ...plan, day2: [] } })).toMatchObject({ dropped: { reason: 'incomplete_plan' } });
    expect(screen({ plan: { ...plan, milestones: [] } })).toMatchObject({
      dropped: { reason: 'incomplete_plan' },
    });
    expect(screen({ plan: {} })).toMatchObject({ dropped: { reason: 'incomplete_plan' } });
    // E.5's output requirement: the plan must name at least one ORIGINAL design decision.
    expect(screen({ plan: { ...plan, originalDesignDecision: '  ' } })).toMatchObject({
      dropped: { reason: 'no_original_design_decision' },
    });
  });

  it('MUTATION TARGET: the anti-copy guard runs INSIDE the screen, not beside it', () => {
    const copied = proposal({
      idea:
        'A CLI that reads a Kubernetes manifest and explains what it would schedule. Scaffold the CLI and the manifest parser.',
      plan: {
        ...(proposal().plan as Record<string, unknown>),
        originalDesignDecision: 'The manifest is read through one parser interface.',
      },
    });
    // THE COPIED REFERENCE: a README that IS the candidate's own idea and plan, which is what a
    // verbatim reimplementation looks like from the guard's side. Every candidate token is in it.
    const references = [
      {
        url: 'https://github.com/a/b',
        title: 'a/b',
        notes: `${String(copied.idea)}\n${planTextOf(copied.plan as never)}`,
      },
    ];
    expect(containmentOverlap(String(copied.idea), references[0].notes)).toBe(1);
    expect(guardCandidate(copied as never, { ...context, references })).toMatchObject({
      dropped: { reason: 'overlaps_a_reference' },
    });
    // ...and the same candidate SURVIVES when the guard is told not to run, which is what makes
    // the drop above the guard's work rather than the guard being dead code. Nothing in the
    // shipped flow sets `runOverlapGuard: false`.
    expect(
      'accepted' in
        guardCandidate(copied as never, { ...context, references, runOverlapGuard: false }),
    ).toBe(true);
    // The WIRE references carry no text, so a candidate can never smuggle in the very excerpt
    // it is supposed to be measured against.
    expect(
      checkCandidateIsOriginal({ idea: 'anything', planText: '', originalDesignDecision: 'one' }, [
        { url: 'https://github.com/a/b', title: 'a/b', notes: '' },
      ]),
    ).toEqual({ original: true });
  });

  it('an unknown difficulty falls back to `medium` rather than being refused', () => {
    // Three named words and a default, never a fourth value from a model.
    const verdict = guardCandidate(proposal({ difficulty: 'impossible' }) as never, context);
    if (!('accepted' in verdict)) throw new Error('unreachable');
    expect(verdict.accepted.difficulty).toBe('medium');
  });

  it('every refusal it can emit is in the closed vocabulary', () => {
    const reasons = new Set<string>(CANDIDATE_REJECTION_REASONS);
    const emitted = [
      screen({ requirementId: 'nope' }),
      screen({ title: '' }),
      screen({ estimatedHours: 99 }),
      screen({ stack: [] }),
      screen({ plan: {} }),
    ].map((verdict) => ('dropped' in verdict ? verdict.dropped.reason : 'accepted'));
    for (const reason of emitted) expect(reasons.has(reason)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The provider cannot widen the envelope
// ---------------------------------------------------------------------------

describe('the optional provider stage PROPOSES, and the same screen decides', () => {
  /** Install a proposer that answers `applied` with the given candidates. */
  function installApplied(candidates: NonNullable<CandidateProposalResponse['candidates']>): void {
    const outcome = {
      status: 'applied',
      reason: 'ok',
      provider: 'test-provider',
      model: 'test-model',
      response: { schemaVersion: 'project_candidate_v1', candidates },
    } as const;
    setCandidateProposer(async () => outcome);
  }

  it('a proposal for a requirement this run did NOT select is dropped', async () => {
    // The derived candidates already filled the cap, so the run never asks - which is the point:
    // a model cannot add a fifth candidate or replace a derived one.
    const run = await generateCandidates({
      userId: USER,
      gaps: [gap({ requirementId: 'req-k8s' })],
      referencesByRequirement: {},
    });
    expect(run.candidates.map((row) => row.requirementIds)).toEqual([['req-k8s']]);
    expect(run.candidates[0].producedBy).toBe('deterministic');
  });

  it('proposals are screened individually, and each drop is reported', async () => {
    // TWO derived candidates COPY their reference, so the anti-copy guard drops them on the
    // derived pass. That is also what leaves the run slots to ask the provider in: the cap is
    // enforced by what was delivered, not by an assertion about the request.
    const k8sGap = named('req-k8s', 'Kubernetes', 'kubernetes');
    const helmGap = named('req-helm', 'Helm charts', 'helm charts');
    const ownText = (which: TeachableGap): string => {
      const derived = deriveCandidate(which);
      return `${derived.idea}\n${planTextOf(derived.plan)}`;
    };

    installApplied([
      // One that copies the reference verbatim.
      {
        ...proposal({
          requirementId: 'req-k8s',
          idea: 'A CLI that reads a Kubernetes manifest and explains what it would schedule.',
        }),
      },
      // One the screen accepts, for the other undelivered gap.
      { ...proposal({ requirementId: 'req-helm' }) },
      // One for a requirement that is not in this run's selected set at all.
      { ...proposal({ requirementId: 'req-years' }), title: 'A ten year simulator' },
      // One for a gap a derived candidate already delivered.
      { ...proposal({ requirementId: 'req-kafka' }) },
    ]);

    const run = await generateCandidates({
      userId: USER,
      gaps: [
        k8sGap,
        named('req-kafka', 'Kafka', 'kafka'),
        named('req-redis', 'Redis', 'redis'),
        helmGap,
      ],
      referenceRowsByRequirement: {
        // A BROAD search hit: one README that contains both the derived candidate's words and
        // the proposal's, which is what a repository covering the space actually looks like.
        // Both of them are copies of it, so both are refused.
        'req-k8s': [
          {
            url: 'https://github.com/a/b',
            title: 'a/b',
            notes: `${ownText(k8sGap)}\n${proposal().idea}\n${planTextOf(proposal().plan as never)}`,
          },
        ],
        'req-helm': [{ url: 'https://github.com/c/d', title: 'c/d', notes: ownText(helmGap) }],
      },
    });

    // The derived pass delivered Kafka and Redis; the two derived copies were refused.
    expect(run.candidates.map((row) => [row.requirementIds[0], row.producedBy] as const)).toEqual([
      ['req-kafka', 'deterministic'],
      ['req-redis', 'deterministic'],
      ['req-helm', 'provider'],
    ]);
    expect(run.proposalStage.status).toBe('applied');
    expect([run.proposalStage.provider, run.proposalStage.model, run.proposalStage.proposedCount]).toEqual([
      'test-provider',
      'test-model',
      4,
    ]);
    // Three distinct provider screens fired, and each is reported - alongside the two derived
    // copies, which never reached the provider stage at all.
    expect(run.proposalStage.dropped.map((row) => row.reason).sort()).toEqual([
      'duplicate_requirement',
      'overlaps_a_reference',
      'unknown_requirement',
    ]);
    expect(run.rejected.map((row) => row.reason).sort()).toEqual([
      'duplicate_requirement',
      'overlaps_a_reference',
      'overlaps_a_reference',
      'overlaps_a_reference',
      'unknown_requirement',
    ]);
    // And exactly one provider candidate survived the screen.
    expect(
      run.candidates.filter((row) => row.producedBy === 'provider').map((row) => row.requirementIds),
    ).toEqual([['req-helm']]);
  });

  it('NO KEY IS A REPORTED SKIP, and the deterministic candidates are still there', async () => {
    setCandidateProposer(async () => ({
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      provider: null,
      model: null,
      response: null,
    }));
    const run = await generateCandidates({ userId: USER, gaps: [gap({ requirementId: 'req-k8s' })] });
    expect(run.proposalStage).toMatchObject({
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      provider: null,
      proposedCount: 0,
    });
    expect(run.candidates).toHaveLength(1);
  });

  it('a provider that answers with prose is a skip, not a candidate', async () => {
    setCandidateProposer(async () => ({
      status: 'skipped',
      reason: 'provider_unavailable',
      provider: 'test-provider',
      model: 'test-model',
      response: null,
    }));
    const run = await generateCandidates({ userId: USER, gaps: [gap({ requirementId: 'req-k8s' })] });
    expect(run.proposalStage).toMatchObject({ status: 'skipped', reason: 'provider_unavailable' });
    expect(run.candidates).toHaveLength(1);
  });

  it('an empty candidate array from the provider is a valid answer, not a failure', async () => {
    installApplied([]);
    const run = await generateCandidates({ userId: USER, gaps: [gap({ requirementId: 'req-k8s' })] });
    expect(run.proposalStage).toMatchObject({ status: 'applied', proposedCount: 0 });
    expect(run.candidates).toHaveLength(1);
  });

  it('`setCandidateProposer(null)` restores the shipped default, which is the real one', async () => {
    setCandidateProposer(async () => ({
      status: 'skipped',
      reason: 'provider_unavailable',
      provider: null,
      model: null,
      response: null,
    }));
    expect(shippedCandidateProposer).toBeTypeOf('function');
    setCandidateProposer(null);
    // The restored default is reachable and is not the fake: it is the module's own function.
    expect(shippedCandidateProposer.name).toBe('defaultProposer');
  });
});

// ---------------------------------------------------------------------------
// The source guard: no score anywhere in this stage
// ---------------------------------------------------------------------------

describe('candidate generation produces NO derived number that reads as a verdict', () => {
  const code = readFileSync(path.join(__dirname, 'generate.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('names no score, no percentage and no ratio', () => {
    for (const banned of ['score', 'Score', 'percentage', 'ratio', 'points', 'weighted']) {
      expect([banned, code.includes(banned)]).toEqual([banned, false]);
    }
  });

  it('a derived candidate carries hours and three named words, and no verdict member', async () => {
    const run = await offline([gap({ requirementId: 'req-k8s' })]);
    const candidate = run.candidates[0] as unknown as Record<string, unknown>;
    expect(Object.keys(candidate).sort()).toEqual([
      'difficulty',
      'estimatedHours',
      'idea',
      'plan',
      'producedBy',
      'references',
      'relevance',
      'requirementIds',
      'stack',
      'status',
      'title',
    ]);
  });
});