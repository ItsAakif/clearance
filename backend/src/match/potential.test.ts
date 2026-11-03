// =====================================================================================
// match/potential.test.ts - the proposal stage (T1070).
//
// WHAT THIS FILE PINS. Five things, three of them the ones the task's rulings name:
//
//   1. ADR-041 D5 - NO PROVIDER IS NOT A FAILURE. `proposeContextualMatches` writes ZERO
//      rows and reports `skipped / no_ai_provider_configured`. It does not fabricate a
//      proposal to fill the gap, which is the failure mode a "helpful" fallback produces.
//   2. THE GUARD IS DETERMINISTIC AND ONE-SIDED. Every link is checked against the caller's
//      own requirement set and claim set, so a model naming an id that does not exist, an
//      unconfirmed claim, a requirement that is already direct, or a level outside
//      {contextual, potential} loses the link - and the loss is reported, not silent.
//   3. `proposedEvidence` COMES FROM THE CLAIM, never from the model. A model that
//      paraphrases "helped with Docker" into "container orchestration experience" has its
//      text discarded and the user's own words stored instead.
//   4. THE MODEL CANNOT WRITE A CLAIM. Proven three ways: by the store seam (`careerClaim`
//      has no write method), by a source grep over `potential.ts`, and by a behavioural test
//      whose fake `careerClaim` delegate has NO write method to call - so "no claim was
//      written" is an observation, not a promise.
//   5. `status = pending` is the only status this module writes, for every accepted link.
// =====================================================================================

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ClaimKind, ClaimStatus, EvidenceLevel } from '@prisma/client';
import {
  MAX_PROPOSAL_CLAIMS,
  MAX_PROPOSAL_REQUIREMENTS,
  defaultContextualProposer,
  proposeContextualMatches,
  renderProposalContext,
  setContextualProposer,
  validateProposal,
  type ContextualProposer,
  type PotentialProposalStore,
} from './potential.js';
import type { MatchClaimRow, MatchRequirementRow } from './levels.js';

// `__dirname` is the convention the repo's other source guards use
// (`career/claimWriterAI.test.ts`), and it is the only spelling that works under both the
// vitest run and the CJS output `tsc` produces - `import.meta` is a syntax error there.
const SOURCE = readFileSync(path.join(__dirname, 'potential.ts'), 'utf8');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function requirement(overrides: Partial<MatchRequirementRow> = {}): MatchRequirementRow {
  return {
    id: 'req-k8s',
    kind: 'required_skill',
    importance: 'must',
    text: 'Kubernetes container orchestration',
    normalizedKey: 'kubernetes container orchestration',
    ...overrides,
  };
}

function claim(overrides: Partial<MatchClaimRow> = {}): MatchClaimRow {
  return {
    id: 'clm-ecs',
    statement: 'Designed and operated a containerised deployment pipeline on ECS with Docker and Terraform',
    kind: ClaimKind.responsibility,
    status: ClaimStatus.user_confirmed,
    ...overrides,
  };
}

interface ProposalRow {
  id: string;
  requirementId: string;
  claimId: string | null;
  level: string;
  proposedEvidence: string;
  rationale: string;
  status: string;
}

/**
 * A store with NO write method on `careerClaim` and NO method on it but `findMany` - the
 * same shape as the real seam. If `potential.ts` ever tried to write a claim, this fake
 * would have no method to call and the suite would fail on the TypeError, not on a reviewer's
 * reading.
 */
function fakeStore(): {
  store: PotentialProposalStore;
  created: Array<Record<string, unknown>>;
  claimWrites: string[];
} {
  const created: Array<Record<string, unknown>> = [];
  const claimWrites: string[] = [];
  let counter = 0;
  const store = {
    potentialMatch: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: `pm-${++counter}`, ...data };
      }),
    },
    careerClaim: {
      findMany: vi.fn(async () => []),
      // Named so a hypothetical writer would have to reach for it explicitly; the real
      // seam does not expose it at all.
      __writeProbe: (name: string) => claimWrites.push(name),
    },
    jobRequirement: {
      findMany: vi.fn(async () => []),
    },
  } as unknown as PotentialProposalStore;
  return { store, created, claimWrites };
}

/**
 * A provider that answers with these links.
 *
 * Typed as `ContextualProposer` rather than as a bare mock so the fixture is held to the
 * module's own contract: a test that returned a shape the seam rejects would otherwise pass
 * the runtime assertions and fail `tsc`, or worse, drift from what the real proposer returns.
 */
function appliedProposer(links: ProposalLink[]): Mock<ContextualProposer> {
  return vi.fn(async () => ({
    status: 'applied',
    reason: 'ok',
    provider: 'openai',
    model: 'gpt-test',
    response: { schemaVersion: 'match_contextual_v1', links },
  }));
}

/** One link as a provider may write it: every member optional and nullable (the zod shape). */
interface ProposalLink {
  requirementId?: string | null;
  claimId?: string | null;
  level?: string | null;
  proposedEvidence?: string | null;
  rationale?: string | null;
}

const K8S_LINK = {
  requirementId: 'req-k8s',
  claimId: 'clm-ecs',
  level: 'contextual',
  proposedEvidence: 'IGNORED: a model-supplied paraphrase',
  rationale: 'Adjacent container orchestration; same competency family',
};

const BASE_INPUT = {
  userId: 'user-1',
  matchReportId: 'mr-1',
  requirements: [requirement()],
  claims: [claim()],
  directRequirementIds: [] as string[],
};

beforeEach(() => {
  setContextualProposer(null);
});

// ---------------------------------------------------------------------------
// ADR-041 D5: no provider
// ---------------------------------------------------------------------------

describe('ADR-041 D5: no provider configured still yields a truthful result', () => {
  it('the shipped default reports skipped / no_ai_provider_configured', async () => {
    // No key manager stub: the real `leaseNextLlmKey` runs against a store with no keys
    // configured, which is the same call the live no-provider path makes.
    const outcome = await defaultContextualProposer({
      requirements: [requirement()],
      claims: [claim()],
      userId: 'user-with-no-keys',
    });
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toBe('no_ai_provider_configured');
    expect(outcome.response).toBeNull();
  });

  it('ZERO rows are written on the no-provider path, and none are invented', async () => {
    setContextualProposer(
      vi.fn(async () => ({
        status: 'skipped' as const,
        reason: 'no_ai_provider_configured' as const,
        provider: null,
        model: null,
        response: null,
      })),
    );
    const { store, created } = fakeStore();
    const result = await proposeContextualMatches(BASE_INPUT, store);

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no_ai_provider_configured');
    expect(result.created).toEqual([]);
    expect(created).toHaveLength(0);
    expect(store.potentialMatch.create).not.toHaveBeenCalled();
  });

  it('nothing is proposed when there is nothing confirmed to anchor a hypothesis on', async () => {
    const proposer = appliedProposer([K8S_LINK]);
    setContextualProposer(proposer);
    const { store, created } = fakeStore();

    const result = await proposeContextualMatches(
      { ...BASE_INPUT, claims: [claim({ status: ClaimStatus.inferred })] },
      store,
    );

    expect(result.reason).toBe('no_confirmed_claims');
    expect(created).toHaveLength(0);
    // The provider was not even asked: there was nothing to ask about.
    expect(proposer).not.toHaveBeenCalled();
  });

  it('nothing is proposed when every requirement is already direct', async () => {
    const proposer = appliedProposer([K8S_LINK]);
    setContextualProposer(proposer);
    const { store, created } = fakeStore();

    const result = await proposeContextualMatches(
      { ...BASE_INPUT, directRequirementIds: ['req-k8s'] },
      store,
    );

    expect(result.reason).toBe('no_requirements_to_propose');
    expect(created).toHaveLength(0);
    expect(proposer).not.toHaveBeenCalled();
  });

  it('a provider that fails is reported as skipped, not retried into a guess', async () => {
    setContextualProposer(
      vi.fn(async () => ({
        status: 'skipped' as const,
        reason: 'provider_unavailable' as const,
        provider: 'anthropic',
        model: 'claude-x',
        response: null,
      })),
    );
    const { store, created } = fakeStore();
    const result = await proposeContextualMatches(BASE_INPUT, store);

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('provider_unavailable');
    expect(result.provider).toBe('anthropic');
    expect(created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

describe('the deterministic guard is one-sided: only a valid link survives', () => {
  const context = {
    requirements: new Map([['req-k8s', requirement()]]),
    claims: new Map([['clm-ecs', claim()]]),
    directRequirementIds: new Set<string>(),
    seen: new Set<string>(),
  };

  function verdict(link: Record<string, unknown>) {
    return validateProposal(link, context);
  }

  it('a well-formed link is accepted', () => {
    expect(verdict(K8S_LINK)).toMatchObject({
      accepted: {
        requirementId: 'req-k8s',
        claimId: 'clm-ecs',
        level: 'contextual',
      },
    });
  });

  it('proposedEvidence is the CLAIM text, and the model wording is discarded', () => {
    const accepted = verdict(K8S_LINK);
    expect('accepted' in accepted && accepted.accepted.proposedEvidence).toBe(
      'Designed and operated a containerised deployment pipeline on ECS with Docker and Terraform',
    );
    // The model's own words appear nowhere in what would be written.
    expect(JSON.stringify(verdict(K8S_LINK))).not.toContain('IGNORED');
  });

  it('a claimId that does not exist loses the link', () => {
    expect(verdict({ ...K8S_LINK, claimId: 'clm-invented' })).toMatchObject({
      dropped: { reason: 'unknown_claim' },
    });
  });

  it('an UNCONFIRMED claimId loses the link - this is the guard E.8 names', () => {
    const unconfirmed = new Map([['clm-inferred', claim({ id: 'clm-inferred', status: ClaimStatus.inferred })]]);
    expect(
      validateProposal({ ...K8S_LINK, claimId: 'clm-inferred' }, { ...context, claims: unconfirmed }),
    ).toMatchObject({ dropped: { reason: 'unconfirmed_claim' } });
  });

  it('a REJECTED claimId loses the link (a rejection is never laundered into a proposal)', () => {
    const rejected = new Map([['clm-x', claim({ id: 'clm-x', status: ClaimStatus.rejected })]]);
    expect(
      validateProposal({ ...K8S_LINK, claimId: 'clm-x' }, { ...context, claims: rejected }),
    ).toMatchObject({ dropped: { reason: 'unconfirmed_claim' } });
  });

  it('a missing claimId loses the link rather than proposing an unanchored idea', () => {
    expect(verdict({ ...K8S_LINK, claimId: null })).toMatchObject({
      dropped: { reason: 'no_claim_id' },
    });
  });

  it('a requirementId that is not this job loses the link', () => {
    expect(verdict({ ...K8S_LINK, requirementId: 'req-somewhere-else' })).toMatchObject({
      dropped: { reason: 'unknown_requirement' },
    });
  });

  it('a requirementId that is ALREADY DIRECT loses the link', () => {
    expect(
      validateProposal(K8S_LINK, { ...context, directRequirementIds: new Set(['req-k8s']) }),
    ).toMatchObject({ dropped: { reason: 'already_direct' } });
  });

  it('a level outside {contextual, potential} loses the link', () => {
    const levels: unknown[] = ['direct', 'unsupported', 'CONFIRMED', '', null, undefined, 7];
    for (const level of levels) {
      expect(verdict({ ...K8S_LINK, level })).toMatchObject({ dropped: { reason: 'bad_level' } });
    }
  });

  it('a level in a different case or with surrounding space is coerced, not dropped', () => {
    expect(verdict({ ...K8S_LINK, level: ' Contextual ' })).toMatchObject({
      accepted: { level: 'contextual' },
    });
  });

  it('no rationale loses the link: an unauditable suggestion cannot be refused', () => {
    const rationales: unknown[] = [null, undefined, '', '   '];
    for (const rationale of rationales) {
      expect(verdict({ ...K8S_LINK, rationale })).toMatchObject({
        dropped: { reason: 'no_rationale' },
      });
    }
  });

  it('an over-long rationale is truncated rather than rejected', () => {
    const accepted = verdict({ ...K8S_LINK, rationale: 'x'.repeat(900) });
    expect('accepted' in accepted && accepted.accepted.rationale.length).toBe(400);
  });

  it('a missing requirementId loses the link', () => {
    expect(verdict({ ...K8S_LINK, requirementId: '' })).toMatchObject({
      dropped: { reason: 'no_requirement_id' },
    });
  });

  it('the duplicate guard collapses a repeated link', async () => {
    // Driven through the real loop rather than by hand-seeding `seen`, because the loop's
    // own bookkeeping is exactly what a repeated link depends on.
    setContextualProposer(appliedProposer([K8S_LINK, K8S_LINK]));
    const { store, created } = fakeStore();
    const result = await proposeContextualMatches(BASE_INPUT, store);

    expect(created).toHaveLength(1);
    expect(result.dropped).toEqual([
      { reason: 'duplicate', detail: 'req-k8s|clm-ecs|contextual' },
    ]);
  });

  it('an already-pending identical link is a duplicate, so a re-run cannot stack rows', async () => {
    setContextualProposer(appliedProposer([K8S_LINK]));
    const { store, created } = fakeStore();
    const result = await proposeContextualMatches(
      { ...BASE_INPUT, existingPending: [{ requirementId: 'req-k8s', claimId: 'clm-ecs', level: EvidenceLevel.contextual }] },
      store,
    );
    expect(result.created).toEqual([]);
    expect(result.dropped).toEqual([
      { reason: 'duplicate', detail: 'req-k8s|clm-ecs|contextual' },
    ]);
    expect(created).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// What is written
// ---------------------------------------------------------------------------

describe('every written row is a pending PotentialMatch, and nothing else', () => {
  it('an accepted link produces exactly one pending row', async () => {
    setContextualProposer(appliedProposer([K8S_LINK]));
    const { store, created } = fakeStore();
    const result = await proposeContextualMatches(BASE_INPUT, store);

    expect(result.status).toBe('applied');
    expect(result.created).toHaveLength(1);
    expect(created).toEqual([
      {
        matchReportId: 'mr-1',
        requirementId: 'req-k8s',
        claimId: 'clm-ecs',
        level: 'contextual',
        proposedEvidence:
          'Designed and operated a containerised deployment pipeline on ECS with Docker and Terraform',
        rationale: 'Adjacent container orchestration; same competency family',
        status: 'pending',
      },
    ]);
  });

  it('a response with no links is applied and writes nothing', async () => {
    setContextualProposer(appliedProposer([]));
    const { store, created } = fakeStore();
    const result = await proposeContextualMatches(BASE_INPUT, store);

    // An empty answer is a valid, useful answer - not a failure and not a reason to retry.
    expect(result.status).toBe('applied');
    expect(result.reason).toBe('ok');
    expect(result.created).toEqual([]);
    expect(created).toHaveLength(0);
  });

  it('a mixed response keeps the valid link and REPORTS each refused one', async () => {
    setContextualProposer(
      appliedProposer([
        { ...K8S_LINK, claimId: 'clm-invented' },
        K8S_LINK,
        { ...K8S_LINK, level: 'direct' },
        { ...K8S_LINK, requirementId: 'req-other' },
      ]),
    );
    const { store, created } = fakeStore();
    const result = await proposeContextualMatches(BASE_INPUT, store);

    expect(result.created).toHaveLength(1);
    expect(result.dropped).toEqual([
      { reason: 'unknown_claim', detail: 'clm-invented' },
      { reason: 'bad_level', detail: 'direct' },
      { reason: 'unknown_requirement', detail: 'req-other' },
    ]);
  });

  it('every row this module writes has status pending', async () => {
    setContextualProposer(
      appliedProposer([
        K8S_LINK,
        { ...K8S_LINK, level: 'potential' },
      ]),
    );
    const { store, created } = fakeStore();
    await proposeContextualMatches(BASE_INPUT, store);

    expect(created.length).toBeGreaterThan(0);
    for (const row of created) {
      expect(row.status).toBe('pending');
    }
  });

  it('the caller cannot choose the status: the module passes it, not the caller', async () => {
    // A model that also volunteers a status. `ProposalLink` has no `status` member and the
    // row is written with `status: 'pending'` on this module's side, so the suggestion is
    // ignored twice over.
    setContextualProposer(
      appliedProposer([{ ...K8S_LINK, ...({ status: 'confirmed' } as Record<string, string>) }]),
    );
    const { store, created } = fakeStore();
    await proposeContextualMatches(BASE_INPUT, store);

    // The model said "confirmed". The written row still says "pending", because `status`
    // is set here and nowhere else.
    expect(created[0].status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// The invariant: this module cannot write a claim
// ---------------------------------------------------------------------------

describe('the proposal stage cannot write a CareerClaim', () => {
  it('the store seam exposes no write method on careerClaim at all', () => {
    // Structural, and therefore stronger than a reviewer's reading: the type has no
    // `create`, so `store.careerClaim.create(...)` does not compile in `potential.ts`.
    expect(SOURCE).toContain("careerClaim: Pick<PrismaClient['careerClaim'], 'findMany'>");
  });

  it('the source contains no claim write of any kind', () => {
    // Comments are stripped before the scan, so the guard cannot be satisfied - or defeated
    // - by prose: it reads the CODE, which is what the seam and the runtime test cover.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      /careerClaim\.(create|update|upsert|delete|deleteMany|createMany|updateMany)/,
      /\bcreateClaim\b/,
      /\bcreateUserClaim\b/,
      /\bwriteInferredClaims\b/,
      /status:\s*(ClaimStatus\.|'user_confirmed')/,
    ]) {
      expect(code, forbidden.source).not.toMatch(forbidden);
    }
  });

  it('no claim is written at runtime, even on the happy path', async () => {
    setContextualProposer(appliedProposer([K8S_LINK]));
    const { store, claimWrites, created } = fakeStore();
    await proposeContextualMatches(BASE_INPUT, store);

    expect(claimWrites).toEqual([]);
    // The only thing created, in the whole stage, is a pending potential match.
    expect(Object.keys(created[0])).toEqual([
      'matchReportId',
      'requirementId',
      'claimId',
      'level',
      'proposedEvidence',
      'rationale',
      'status',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Data minimization (E.9)
// ---------------------------------------------------------------------------

describe('the prompt carries the minimum, bounded', () => {
  it('renders id, kind, importance and text per requirement, and nothing more', () => {
    const rendered = renderProposalContext([requirement()], [claim()]);
    expect(rendered.requirements).toBe('req-k8s | required_skill | must | Kubernetes container orchestration');
    expect(rendered.confirmedClaims).toBe(
      'clm-ecs | responsibility | Designed and operated a containerised deployment pipeline on ECS with Docker and Terraform',
    );
  });

  it('an empty list renders as (none), not as a blank that reads as nothing to do', () => {
    const rendered = renderProposalContext([], []);
    expect(rendered.requirements).toBe('(none)');
    expect(rendered.confirmedClaims).toBe('(none)');
  });

  it('the lists are capped', () => {
    const many = Array.from({ length: MAX_PROPOSAL_REQUIREMENTS + 25 }, (_, index) =>
      requirement({ id: `req-${index}`, text: `Requirement ${index}` }),
    );
    const claims = Array.from({ length: MAX_PROPOSAL_CLAIMS + 25 }, (_, index) =>
      claim({ id: `clm-${index}`, statement: `Claim ${index}` }),
    );
    const rendered = renderProposalContext(many, claims);
    expect(rendered.requirements.split('\n')).toHaveLength(MAX_PROPOSAL_REQUIREMENTS);
    expect(rendered.confirmedClaims.split('\n')).toHaveLength(MAX_PROPOSAL_CLAIMS);
  });

  it('more open requirements than the cap are truncated, not all sent', async () => {
    const proposer = appliedProposer([]);
    setContextualProposer(proposer);
    const { store } = fakeStore();
    const many = Array.from({ length: MAX_PROPOSAL_REQUIREMENTS + 10 }, (_, index) =>
      requirement({ id: `req-${index}` }),
    );
    await proposeContextualMatches({ ...BASE_INPUT, requirements: many }, store);

    const sent = proposer.mock.calls[0][0].requirements as MatchRequirementRow[];
    expect(sent).toHaveLength(MAX_PROPOSAL_REQUIREMENTS);
  });
});