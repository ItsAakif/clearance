// =====================================================================================
// projects/lifecycle.test.ts - ACCEPTANCE ITEM 4 and the two integrations that hang off it
// (T1100; 06 sec. E.5's loop, sec. E.8 stage 12, sec. E.10).
//
// THE CENTRAL CLAIM, and how it is proven:
//
//   "Completion -> `status = completed` + the user confirms -> a `CareerClaim`
//    (`kind: project`, `provenance: user_entered`, `status: user_confirmed`). A completion is
//    NEVER auto-confirmed from a repo existing." (E.5)
//
//   Nothing here is asserted by reading the source. `completeOpportunity` is CALLED, and then
//   the claims table and the audit table are inspected: after a complete there is no claim, no
//   audit row and no `verifiedClaimId`, and the response says `awaitingYourConfirmation: true`.
//   That is the acceptance item as an observable fact, and it is the only way to prove it -
//   a comment saying "this function does not confirm" is a promise, not a property.
//
// WHAT ELSE IS HERE, and why each belongs in this file:
//   - the discovery run END TO END over the fake store, including the offline path (no provider,
//     no network) and the reference write path with a licence and a snapshot on every row;
//   - the three decisions' refusals: a proposed plan cannot be completed, an unaccepted one
//     cannot be completed, and a completed one can only be confirmed ONCE;
//   - a foreign id is a 404 on every decision, because this surface names career gaps.
//
// THE CLAIM IS WRITTEN BY THE REAL CAREER SERVICE. `confirm` calls
// `career/userDecisions.ts#createUserClaim({ confirm: true })`, so the claim row, its status
// change and its `career_claim` audit row are produced by the T1010/T1020 code rather than by
// anything in this directory - which is what makes "nothing auto-confirms" a property of the
// system and not of this file.
// =====================================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaimKind, ClaimProvenance, ClaimStatus } from '@prisma/client';

import { seedConfirmedClaim } from '../career/careerStore.fixtures.js';

import {
  acceptOpportunity,
  completeOpportunity,
  confirmOpportunity,
  discoverProjects,
  isConfirmedProjectClaim,
  opportunityView,
  PROJECT_CONFIRMATION_RULE,
  PROJECT_DISCOVERY_NOTES,
  type ProjectStore,
} from './lifecycle.js';
import { FakeProjectStore } from './projectStore.fixtures.js';
import { ALLOWED_LICENCES } from './references.js';
import { ConflictError, NotFoundError } from '../shared/errors.js';

const USER = 'user-1';
const OTHER = 'user-2';
const NOW = new Date('2026-10-06T12:00:00.000Z');
const PROFILE = 'prof-1';
const JOB = 'job-1';

let store: FakeProjectStore;
let seam: ProjectStore;

beforeEach(() => {
  store = new FakeProjectStore();
  seam = store.asProjectStore();
  store.seed('profiles', { id: PROFILE, userId: USER });
  store.seed('jobs', { id: JOB, userId: USER, title: 'Platform Engineer', rawText: 'Kubernetes' });
});

/** A requirement row, as `deriveEvidenceLevels` reads it. */
function requirement(id: string, text: string, kind = 'required_skill', importance = 'must'): void {
  store.seed('requirements', {
    id,
    jobId: JOB,
    kind,
    importance,
    text,
    normalizedKey: text.toLowerCase(),
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
  });
}

/** A stored opportunity in a chosen state, for a test that is about the decisions. */
function seedOpportunity(overrides: Record<string, unknown> = {}): string {
  const row = store.seed('opportunities', {
    userId: USER,
    profileId: PROFILE,
    jobId: JOB,
    title: 'A two-day kubernetes project',
    idea: 'Build one small thing that uses kubernetes end to end.',
    requirementsAddressed: ['req-k8s'],
    stack: ['kubernetes'],
    difficulty: 'medium',
    estimatedHours: 10,
    relevance: 'Closes the named gap "Kubernetes".',
    plan: {
      day1: ['Scaffold it.'],
      day2: ['Document it.'],
      milestones: ['It runs.'],
      scope: { in: ['one project'], out: ['production'] },
      originalDesignDecision: 'One small interface.',
    },
    status: 'proposed',
    ...overrides,
  });
  return row.id as string;
}

/** A discovery run with every optional stage declined: the offline floor. */
function discover(overrides: Partial<Parameters<typeof discoverProjects>[0]> = {}) {
  return discoverProjects({ userId: USER, jobId: JOB, runProvider: false, research: false, now: NOW, ...overrides }, seam);
}

// ---------------------------------------------------------------------------
// The loop: accept -> complete -> confirm
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 4 (MUTATION TARGET 4): nothing auto-confirms', () => {
  it('MUTATION TARGET: `complete` writes NOTHING to the career layer', async () => {
    const id = seedOpportunity({ status: 'accepted' });
    // The before-state, as a fact rather than an assumption.
    expect(store.claimsFor(PROFILE)).toEqual([]);
    expect(store.verifications.size).toBe(0);

    const decision = await completeOpportunity({ userId: USER, opportunityId: id, now: NOW }, seam);

    // THE ASSERTION. Byte-for-byte: still no claim, still no audit row.
    expect(store.claimsFor(PROFILE)).toEqual([]);
    expect(store.verifications.size).toBe(0);
    // The opportunity moved and NOTHING else did.
    expect(decision.changed).toBe(true);
    expect(decision.claim).toBeNull();
    expect(decision.claimVerification).toBeNull();
    expect(decision.opportunity.status).toBe('completed');
    expect(decision.opportunity.completedAt).toBe(NOW.toISOString());
    expect(decision.opportunity.verifiedClaimId).toBeNull();
    // ...and it SAYS that it is waiting for the user, rather than leaving the client to infer
    // it from a missing claim.
    expect(decision.opportunity.awaitingYourConfirmation).toBe(true);
    // No claim write happened: the only writes the run made are the opportunity's own.
    expect(store.writes).toEqual(['opportunity.update']);
    expect(decision.rule).toBe(PROJECT_CONFIRMATION_RULE);
  });

  it('MUTATION TARGET: only `confirm` writes the claim, and it writes it WITH its audit row', async () => {
    const id = seedOpportunity({ status: 'accepted' });
    await completeOpportunity({ userId: USER, opportunityId: id, now: NOW }, seam);

    const decision = await confirmOpportunity({ userId: USER, opportunityId: id, now: NOW }, seam);

    // The claim, created by the career layer's own service.
    const claims = store.claimsFor(PROFILE);
    expect(claims).toHaveLength(1);
    const [claim] = claims;
    expect(claim.kind).toBe('project');
    expect(claim.provenance).toBe(ClaimProvenance.user_entered);
    expect(claim.status).toBe(ClaimStatus.user_confirmed);
    // The statement is the opportunity's OWN title unless the user reworded it, so the claim is
    // traceable to the plan they accepted.
    expect(claim.statement).toBe('Built and documented A two-day kubernetes project');
    expect(claim.confirmedAt).not.toBeNull();
    // Read back through the CAREER LAYER's predicate: this file spells no confirming literal.
    expect(isConfirmedProjectClaim(claim.status)).toBe(true);

    // The `career_claim` audit row the verification service wrote, inseparably from the status.
    const claimAudit = [...store.verifications.values()].filter(
      (row) => row.targetType === 'career_claim',
    );
    expect(claimAudit).toHaveLength(1);
    expect([
      claimAudit[0].targetType,
      claimAudit[0].action,
      claimAudit[0].actorUserId,
      claimAudit[0].userId,
    ]).toEqual(['career_claim', 'confirm', USER, USER]);

    // The OPPORTUNITY's own audit row, so the decision about the project is auditable
    // separately from the statement it produced. It carries the claim id too, so it is found
    // by its `targetType` rather than by the absence of one.
    const opportunityAudit = [...store.verifications.values()].filter(
      (row) => row.targetType === 'job_requirement_match',
    );
    expect(opportunityAudit).toHaveLength(1);
    expect([opportunityAudit[0].targetId, opportunityAudit[0].action]).toEqual([id, 'confirm']);

    // Both are reported back, so a client can SHOW the decision rather than assert it.
    expect(decision.changed).toBe(true);
    expect(decision.claim).toEqual({
      id: claim.id,
      kind: 'project',
      statement: claim.statement,
      status: ClaimStatus.user_confirmed,
    });
    expect(decision.claimVerification).toMatchObject({
      action: 'confirm',
      targetType: 'career_claim',
      targetId: claim.id,
    });
    expect(decision.opportunity.verifiedClaimId).toBe(claim.id);
    expect(decision.opportunity.awaitingYourConfirmation).toBe(false);
  });

  it('the user may word the statement themselves, and BOTH the claim and the audit note follow', async () => {
    const id = seedOpportunity({ status: 'completed', completedAt: NOW });
    const decision = await confirmOpportunity(
      {
        userId: USER,
        opportunityId: id,
        statement: 'Built a manifest linter for Kubernetes operators, with tests',
        note: 'Repository is public.',
        now: NOW,
      },
      seam,
    );
    expect(decision.claim?.statement).toBe(
      'Built a manifest linter for Kubernetes operators, with tests',
    );
    expect(store.claimsFor(PROFILE)[0].provenance).toBe(ClaimProvenance.user_entered);
    const audit = [...store.verifications.values()].find((row) => row.claimId === decision.claim?.id);
    expect(audit?.note).toBe('Repository is public.');
  });

  it('a SECOND confirm is an idempotent no-op: one project, one claim, two audit rows at most', async () => {
    const id = seedOpportunity({ status: 'completed', completedAt: NOW });
    const first = await confirmOpportunity({ userId: USER, opportunityId: id, now: NOW }, seam);
    const second = await confirmOpportunity({ userId: USER, opportunityId: id, now: NOW }, seam);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.claim?.id).toBe(first.claim?.id);
    expect(store.claimsFor(PROFILE)).toHaveLength(1);
    // No third audit row: the two the first call wrote are still the only ones.
    expect(store.verifications.size).toBe(2);
  });

  it('a `proposed` plan cannot be completed, and an `accepted` one cannot be confirmed early', async () => {
    const proposed = seedOpportunity({ status: 'proposed' });
    await expect(completeOpportunity({ userId: USER, opportunityId: proposed }, seam)).rejects.toBeInstanceOf(
      ConflictError,
    );
    // ...and no claim was written by the refusal either.
    expect(store.claimsFor(PROFILE)).toEqual([]);

    const accepted = seedOpportunity({ status: 'accepted' });
    await expect(confirmOpportunity({ userId: USER, opportunityId: accepted }, seam)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(store.claimsFor(PROFILE)).toEqual([]);
    expect(store.verifications.size).toBe(0);
  });

  it('accept and complete are idempotent, and neither rewrites the completion timestamp', async () => {
    const id = seedOpportunity({ status: 'proposed' });
    const accepted = await acceptOpportunity({ userId: USER, opportunityId: id }, seam);
    const acceptedAgain = await acceptOpportunity({ userId: USER, opportunityId: id }, seam);
    expect([accepted.changed, acceptedAgain.changed]).toEqual([true, false]);
    expect(acceptedAgain.opportunity.status).toBe('accepted');

    const first = await completeOpportunity({ userId: USER, opportunityId: id, now: NOW }, seam);
    const later = new Date('2026-10-09T12:00:00.000Z');
    const second = await completeOpportunity({ userId: USER, opportunityId: id, now: later }, seam);
    expect([first.changed, second.changed]).toEqual([true, false]);
    // The first completion is the fact about WHEN; a second press must not move it.
    expect(second.opportunity.completedAt).toBe(NOW.toISOString());
  });

  it('an accepted or completed opportunity cannot be accepted again with a new status', async () => {
    const id = seedOpportunity({ status: 'completed', completedAt: NOW });
    await expect(acceptOpportunity({ userId: USER, opportunityId: id }, seam)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('a foreign id is a 404 on every decision, not a 403', async () => {
    const id = seedOpportunity({ status: 'completed', completedAt: NOW });
    for (const run of [
      acceptOpportunity({ userId: OTHER, opportunityId: id }, seam),
      completeOpportunity({ userId: OTHER, opportunityId: id }, seam),
      confirmOpportunity({ userId: OTHER, opportunityId: id }, seam),
      opportunityView(OTHER, id, seam),
    ]) {
      await expect(run).rejects.toBeInstanceOf(NotFoundError);
    }
    // ...and a missing id and a blank id are refusals, not a crash.
    await expect(acceptOpportunity({ userId: USER, opportunityId: 'nope' }, seam)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(acceptOpportunity({ userId: USER, opportunityId: '' }, seam)).rejects.toThrowError(
      /opportunityId is required/,
    );
    // Nobody else's claim was written by any of those probes.
    expect(store.claimsFor(PROFILE)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The discovery run
// ---------------------------------------------------------------------------

describe('the discovery run works with NO provider and NO network', () => {
  it('ACCEPTANCE 1: only teachable gaps become candidates, and every refusal is reported', async () => {
    requirement('req-k8s', 'Kubernetes');
    requirement('req-kafka', 'Kafka');
    requirement('req-years', '7+ years of distributed systems', 'years_experience');
    requirement('req-degree', 'a degree in computer science', 'education');
    requirement('req-cred', 'AWS Certified Solutions Architect');

    const view = await discover();

    expect(view.counts).toEqual({ considered: 5, selected: 2, excluded: 3, candidates: 2 });
    expect(view.selectedGaps.map((row) => row.requirementId).sort()).toEqual(['req-k8s', 'req-kafka']);
    expect(view.candidates.map((row) => row.requirementIds[0]).sort()).toEqual(['req-k8s', 'req-kafka']);
    // Nothing non-teachable reached storage.
    for (const id of ['req-years', 'req-degree', 'req-cred']) {
      expect(view.candidates.some((row) => row.requirementIds.includes(id))).toBe(false);
    }
    expect(view.excludedGaps.map((row) => [row.requirementId, row.reason] as const).sort()).toEqual([
      ['req-cred', 'hard_credential'],
      ['req-degree', 'non_teachable_kind'],
      ['req-years', 'non_teachable_kind'],
    ] as const);
    // Every stored candidate is `proposed` with a stored id, and the body says the rule.
    for (const candidate of view.candidates) {
      expect([candidate.id.length > 0, candidate.status, candidate.awaitingYourConfirmation]).toEqual([
        true,
        'proposed',
        false,
      ]);
      expect(candidate.estimatedHours).toBeLessThanOrEqual(16);
      expect(candidate.plan.originalDesignDecision.length).toBeGreaterThan(0);
    }
    expect([view.notes, view.rule]).toEqual([PROJECT_DISCOVERY_NOTES, PROJECT_CONFIRMATION_RULE]);
  });

  it('ACCEPTANCE 2: a stored reference ALWAYS has a licence and an activity snapshot', async () => {
    requirement('req-k8s', 'Kubernetes');
    const fake = fakeGithub([searchItem({})]);
    const view = await discover({ research: true, fetchImpl: fake });
    expect([view.researchStage.reason, fake.calls.length]).toEqual(['ok', 2]);
    // The search, then the one README the pre-gate decided was worth fetching.
    expect(fake.calls[1]).toBe('https://api.github.com/repos/queuewright/queuewright/readme');
    expect(view.researchStage.status).toBe('applied');
    expect(view.researchStage.consideredCount).toBe(1);
    expect(view.researchStage.acceptedCount).toBe(1);
    expect(view.researchStage.rejectedReferences).toEqual([]);
    const stored = store.referencesFor(view.candidates[0].id);
    expect(stored).toHaveLength(1);
    expect(ALLOWED_LICENCES).toContain(stored[0].licence);
    expect(stored[0].activity).toMatchObject({
      stars: 120,
      pushedAt: '2026-06-01T00:00:00.000Z',
      archived: false,
      hasReleases: true,
    });
    // The candidate the UI renders carries the same two facts.
    expect(view.candidates[0].references[0]).toMatchObject({ licence: 'MIT' });
  });

  it('ACCEPTANCE 2: a NO-LICENCE repository is never recorded, and the candidate still exists', async () => {
    requirement('req-k8s', 'Kubernetes');
    const view = await discover({
      research: true,
      fetchImpl: fakeGithub([searchItem({ license: null })]),
    });
    expect(store.references.size).toBe(0);
    expect(view.researchStage.rejectedReferences.map((row) => row.reason)).toEqual(['no_licence']);
    expect(view.candidates).toHaveLength(1);
    expect(view.candidates[0].references).toEqual([]);
  });

  it('research is OPTIONAL in both directions, and each skip says which one it is', async () => {
    requirement('req-k8s', 'Kubernetes');
    // Declined by the caller.
    const declined = await discover({ research: false });
    expect([declined.researchStage.status, declined.researchStage.reason, declined.researchStage.searchCount]).toEqual([
      'skipped',
      'not_requested',
      0,
    ]);
    // Asked for, and unreachable.
    const unavailable = await discover({ research: true });
    expect([
      unavailable.researchStage.status,
      unavailable.researchStage.reason,
      unavailable.researchStage.searchCount,
    ]).toEqual(['skipped', 'research_unavailable', 0]);
    // In every case the candidates are the SAME deterministic ones: enrichment is not the answer.
    expect(unavailable.candidates.map((row) => row.requirementIds)).toEqual(
      declined.candidates.map((row) => row.requirementIds),
    );
    expect(unavailable.proposalStage).toMatchObject({ status: 'skipped', reason: 'not_evaluated' });
  });

  it('a run with nothing teachable is a real answer, with the exclusions attached', async () => {
    requirement('req-years', '7+ years of distributed systems', 'years_experience');
    const view = await discover();
    expect(view.counts).toEqual({ considered: 1, selected: 0, excluded: 1, candidates: 0 });
    expect(view.candidates).toEqual([]);
    expect(store.allOpportunities()).toEqual([]);
    expect(view.excludedGaps[0].reason).toBe('non_teachable_kind');
  });

  it('a requirement already covered by a confirmed claim is NOT a gap, so it is never proposed', async () => {
    requirement('req-k8s', 'Kubernetes');
    seedConfirmedClaim(store, {
      id: 'clm-1',
      profileId: PROFILE,
      kind: ClaimKind.technology,
      statement: 'Ran Kubernetes in production',
      status: ClaimStatus.user_confirmed,
    });
    const view = await discover();
    expect(view.counts.considered).toBe(0);
    expect(view.candidates).toEqual([]);
  });

  it('the gaps are RE-DERIVED through `match/levels.ts`, not read from the stored snapshot', async () => {
    // The report's `gaps` column is a snapshot of the last match write. A gap the user closed
    // since then must not produce a plan, so this run derives rather than reading it.
    requirement('req-k8s', 'Kubernetes');
    store.matchReports.set('mr-1', {
      id: 'mr-1',
      userId: USER,
      jobId: JOB,
      profileId: PROFILE,
      createdAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    store.potentialMatches.set('pm-1', {
      id: 'pm-1',
      matchReportId: 'mr-1',
      requirementId: 'req-k8s',
      claimId: null,
      level: 'contextual',
      status: 'pending',
      proposedEvidence: 'You ran ECS',
      rationale: 'adjacent',
      createdAt: new Date('2026-10-02T00:00:00.000Z'),
    });

    const run = () =>
      discoverProjects({ userId: USER, matchReportId: 'mr-1', runProvider: false, research: false, now: NOW }, seam);

    // A PENDING proposal makes the requirement `contextual`, so it is NOT a gap: the match
    // report already offers the user a Confirm/Reject for it, and a second offer - a project
    // plan - would be the engine competing with its own suggestion.
    const pending = await run();
    expect(pending.counts).toEqual({ considered: 0, selected: 0, excluded: 0, candidates: 0 });

    // A REJECTED proposal is a decision, and its consequence is that the requirement is a named
    // gap again - which is exactly when a project plan is the right offer.
    store.potentialMatches.set('pm-1', {
      ...store.potentialMatches.get('pm-1')!,
      status: 'rejected',
    });
    const rejected = await run();
    expect(rejected.counts).toEqual({ considered: 1, selected: 1, excluded: 0, candidates: 1 });

    // ...and a CONFIRMED proposal carries a confirmed claim, so the requirement is `direct`.
    seedConfirmedClaim(store, {
      id: 'clm-2',
      profileId: PROFILE,
      kind: ClaimKind.technology,
      statement: 'Ran Kubernetes in production',
      status: ClaimStatus.user_confirmed,
    });
    store.potentialMatches.set('pm-1', {
      ...store.potentialMatches.get('pm-1')!,
      status: 'confirmed',
      claimId: 'clm-2',
    });
    const closed = await run();
    expect(closed.counts).toEqual({ considered: 0, selected: 0, excluded: 0, candidates: 0 });
  });

  it('a repeat POST STACKS rather than replacing, and both rows are readable', async () => {
    requirement('req-k8s', 'Kubernetes');
    const first = await discover();
    const second = await discover();
    expect(store.allOpportunities()).toHaveLength(2);
    expect(second.candidates[0].id).not.toBe(first.candidates[0].id);
    const read = await opportunityView(USER, first.candidates[0].id, seam);
    expect(read.id).toBe(first.candidates[0].id);
    expect(read.status).toBe('proposed');
  });

  it('a foreign or missing job is a 404, and a request naming neither is a 400', async () => {
    await expect(discoverProjects({ userId: OTHER, jobId: JOB }, seam)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(discoverProjects({ userId: USER, jobId: 'nope' }, seam)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(discoverProjects({ userId: USER }, seam)).rejects.toThrowError(
      /matchReportId or a jobId/,
    );
  });

  it('the profile is created on demand, because `ProjectOpportunity.profileId` is not nullable', async () => {
    const bare = new FakeProjectStore();
    bare.seed('jobs', { id: JOB, userId: USER });
    bare.seed('requirements', {
      id: 'req-k8s',
      jobId: JOB,
      kind: 'required_skill',
      importance: 'must',
      text: 'Kubernetes',
      normalizedKey: 'kubernetes',
    });
    const view = await discoverProjects(
      { userId: USER, jobId: JOB, runProvider: false, research: false, now: NOW },
      bare.asProjectStore(),
    );
    expect(view.profileId.length).toBeGreaterThan(0);
    expect(bare.profiles.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The GitHub search seam, as a fake
// ---------------------------------------------------------------------------

/** One `search/repositories` hit, shaped the way the provider actually returns it. */
function searchItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: 'queuewright/queuewright',
    html_url: 'https://github.com/queuewright/queuewright',
    description: 'A small at-least-once job queue.',
    stargazers_count: 120,
    forks_count: 9,
    open_issues_count: 3,
    pushed_at: '2026-06-01T00:00:00.000Z',
    archived: false,
    size: 180,
    language: 'TypeScript',
    topics: ['queue'],
    license: { spdx_id: 'mit' },
    releases_count: 3,
    ...overrides,
  };
}

/** The README the fake provider serves, as markdown. */
const README = [
  '# Queuewright',
  '',
  'A small at-least-once job queue for Node services, with idempotent workers and',
  'exponential backoff on failure. It is deliberately tiny: one queue, one worker,',
  'one acknowledgement protocol.',
  '',
  '## Usage',
  '',
  'const q = new Queuewright("mailer");',
  'await q.push({ to: "a@example.com" });',
].join('\n');

/**
 * A fake `fetch` for the research stage.
 *
 * It is INJECTED (`DiscoverProjectsInput.fetchImpl`), never ambient, which is what lets the
 * criteria be exercised against real provider-shaped JSON with no network in the test run. It
 * answers BOTH endpoints the stage uses: the search, and the per-repository README.
 */
function fakeGithub(items: ReadonlyArray<Record<string, unknown>>, readme: string | null = README) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/readme')) {
      if (readme === null) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        // The JSON shape, base64 - the shape a provider that ignores the raw media type sends.
        json: async () => ({ content: Buffer.from(readme, 'utf8').toString('base64'), encoding: 'base64' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ total_count: items.length, items }),
    };
  };
  return Object.assign(fetchImpl, { calls });
}