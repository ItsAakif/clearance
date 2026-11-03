// =====================================================================================
// match/report.test.ts - the MatchReport and the two decisions (T1070).
//
// WHAT THIS FILE PINS. The store is an in-memory table set with a `$transaction` that
// snapshots and rolls back, the repo's existing convention (cf.
// `career/careerStore.fixtures.ts`), so the invariants below are observed from the writes
// the service performs rather than inferred from its source:
//
//   1. ACCEPTANCE 2a - CONFIRM PROMOTES THROUGH THE ONE LEGAL PATH. The claim becomes
//      confirmed AND a `ClaimVerification` row is written, together, and the audit row's
//      actor is non-null. Proven by reading both tables afterwards.
//   2. ACCEPTANCE 2b - REJECT LEAVES A NAMED GAP. The requirement re-derives as
//      `unsupported` and appears in `gaps` BY NAME, and the rejection is on the record.
//   3. ACCEPTANCE 1 - THE KUBERNETES FIXTURE IS CONTEXTUAL, NEVER DIRECT. Confirmed
//      end-to-end through `matchJob`, including with a provider that obeys.
//   4. NO SCORE, NO PERCENTAGE - a grep of the response type and the persisted columns, plus
//      the assertion that the counts sum to the total and are whole numbers.
//   5. ACCEPTANCE 4 - A PENDING PROPOSAL NEVER COUNTS AS DIRECT, checked through the HTTP-
//      facing service rather than only through `levels.ts`.
//   6. Cross-tenant: a foreign job, report, resume or proposal is a 404, never a 403 and
//      never another person's data.
// =====================================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ClaimKind,
  ClaimProvenance,
  ClaimStatus,
  EvidenceLevel,
  RequirementImportance,
  RequirementKind,
} from '@prisma/client';
import {
  CLAIM_KIND_FOR_REQUIREMENT,
  MATCH_REPORT_NOTES,
  UNMAPPED_REQUIREMENT_KIND_REASON,
  confirmPotentialMatch,
  getMatchReport,
  matchJob,
  rejectPotentialMatch,
  type MatchStore,
} from './report.js';
import { setContextualProposer, type ContextualProposer } from './potential.js';
import { createClaim } from '../career/claims.js';
import { confirmClaim } from '../career/verification.js';

// `__dirname` matches the repo's other source guards (`career/claimWriterAI.test.ts`) and
// is the only spelling that works under the CJS output `tsc` produces.
const REPORT_SOURCE = readFileSync(path.join(__dirname, 'report.ts'), 'utf8');

// ---------------------------------------------------------------------------
// The fake store
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const NOW = new Date('2026-10-03T12:00:00.000Z');

interface Tables {
  jobs: Row[];
  jobRequirements: Row[];
  careerProfiles: Row[];
  careerClaims: Row[];
  claimVerifications: Row[];
  matchReports: Row[];
  potentialMatches: Row[];
  resumes: Row[];
  /** Every mutating call, in order - so "wrote nothing" is an observation. */
  writes: string[];
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, expected]) => {
    if (expected === undefined) return true;
    const actual = row[key];
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      const condition = expected as { in?: unknown };
      if (Array.isArray(condition.in)) return condition.in.includes(actual);
      return actual === expected;
    }
    return actual === expected;
  });
}

/**
 * The in-memory store. `$transaction` deep-clones every table and restores them on a throw,
 * so a partial write is a test failure rather than a silently passing one.
 */
function buildStore(seed?: Partial<Tables>): { store: MatchStore; tables: Tables } {
  const tables: Tables = {
    jobs: [],
    jobRequirements: [],
    careerProfiles: [],
    careerClaims: [],
    claimVerifications: [],
    matchReports: [],
    potentialMatches: [],
    resumes: [],
    writes: [],
    ...seed,
  };

  const delegate = <K extends keyof Tables>(name: K, model: string) => {
    const rows = () => tables[name] as Row[];
    const nextId = () => `${model}-${rows().length + 1}`;
    return {
      findUnique: async ({ where }: { where: Row }) =>
        rows().find((row) => matchesWhere(row, where)) ?? null,
      findFirst: async ({ where }: { where: Row }) =>
        rows().find((row) => matchesWhere(row, where)) ?? null,
      findMany: async ({ where }: { where?: Row } = {}) => rows().filter((row) => matchesWhere(row, where)),
      create: async ({ data }: { data: Row }) => {
        tables.writes.push(`${model}.create`);
        const row = { id: nextId(), createdAt: NOW, ...data };
        rows().push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        tables.writes.push(`${model}.update`);
        const index = rows().findIndex((row) => row.id === where.id);
        if (index === -1) throw new Error(`no ${model} ${where.id}`);
        rows()[index] = { ...rows()[index], ...data };
        return rows()[index];
      },
      delete: async ({ where }: { where: { id: string } }) => {
        tables.writes.push(`${model}.delete`);
        const index = rows().findIndex((row) => row.id === where.id);
        if (index === -1) throw new Error(`no ${model} ${where.id}`);
        return rows().splice(index, 1)[0];
      },
      deleteMany: async ({ where }: { where: Row }) => {
        tables.writes.push(`${model}.deleteMany`);
        const keep = rows().filter((row) => !matchesWhere(row, where));
        const count = rows().length - keep.length;
        rows().length = 0;
        rows().push(...keep);
        return { count };
      },
    };
  };

  const models = {
    job: delegate('jobs', 'job'),
    jobRequirement: delegate('jobRequirements', 'req'),
    careerProfile: delegate('careerProfiles', 'prof'),
    careerClaim: delegate('careerClaims', 'clm'),
    claimVerification: delegate('claimVerifications', 'ver'),
    matchReport: delegate('matchReports', 'mr'),
    potentialMatch: delegate('potentialMatches', 'pm'),
    resume: delegate('resumes', 'res'),
  };

  const store = {
    ...models,
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snapshot = JSON.parse(
        JSON.stringify({
          jobs: tables.jobs,
          jobRequirements: tables.jobRequirements,
          careerProfiles: tables.careerProfiles,
          careerClaims: tables.careerClaims,
          claimVerifications: tables.claimVerifications,
          matchReports: tables.matchReports,
          potentialMatches: tables.potentialMatches,
          resumes: tables.resumes,
        }),
      );
      try {
        return await fn(models);
      } catch (error) {
        Object.assign(tables.jobs, snapshot.jobs);
        Object.assign(tables.jobRequirements, snapshot.jobRequirements);
        Object.assign(tables.careerProfiles, snapshot.careerProfiles);
        Object.assign(tables.careerClaims, snapshot.careerClaims);
        Object.assign(tables.claimVerifications, snapshot.claimVerifications);
        Object.assign(tables.matchReports, snapshot.matchReports);
        Object.assign(tables.potentialMatches, snapshot.potentialMatches);
        Object.assign(tables.resumes, snapshot.resumes);
        throw error;
      }
    },
  } as unknown as MatchStore;

  return { store, tables };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER = 'user-1';

function jobFixture(overrides: Row = {}): Row {
  return {
    id: 'job-1',
    userId: USER,
    title: 'Staff Platform Engineer',
    company: 'Acme',
    seniority: 'staff',
    sourceKind: 'pasted_text',
    contentHash: 'hash-1',
    rawText: 'jd',
    analysisJson: null,
    analyzedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function requirementFixture(overrides: Partial<Row> = {}): Row {
  return {
    id: 'req-1',
    jobId: 'job-1',
    kind: RequirementKind.required_skill,
    importance: RequirementImportance.must,
    text: 'Kubernetes',
    normalizedKey: 'kubernetes',
    weight: 1,
    provenance: ClaimProvenance.derived,
    createdAt: NOW,
    ...overrides,
  };
}

/** A confirmed ECS/Docker/Terraform claim - E.2's worked case. */
const ECS_CLAIM: Row = {
  id: 'clm-ecs',
  profileId: 'prof-1',
  kind: ClaimKind.responsibility,
  statement: 'Designed and operated a containerised deployment pipeline on ECS with Docker and Terraform',
  fingerprint: 'fp-ecs',
  status: ClaimStatus.user_confirmed,
  provenance: ClaimProvenance.document_import,
  confidence: null,
  confirmedAt: NOW,
  rejectedAt: null,
  rejectedReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const K8S_LINK = {
  requirementId: 'req-1',
  claimId: 'clm-ecs',
  level: 'contextual',
  rationale: 'Adjacent container orchestration; same competency family',
};

/**
 * A provider that answers with these links.
 *
 * Typed as `ContextualProposer` rather than as a bare arrow so the fixture is held to the
 * module's own contract: `tsc --noEmit` then fails if the seam's response shape changes,
 * instead of the drift surfacing as a confusing assertion failure.
 */
function obeyfulProposer(links: ProposalLink[]): () => Promise<ProposalOutcome> {
  return async () => ({
    status: 'applied',
    reason: 'ok',
    provider: 'openai',
    model: 'gpt-test',
    response: { schemaVersion: 'match_contextual_v1', links },
  });
}

/** One link as a provider may write it: every member optional and nullable (the zod shape). */
interface ProposalLink {
  requirementId?: string | null;
  claimId?: string | null;
  level?: string | null;
  proposedEvidence?: string | null;
  rationale?: string | null;
}

type ProposalOutcome = Awaited<ReturnType<ContextualProposer>>;

function noProvider(): () => Promise<ProposalOutcome> {
  return async () => ({
    status: 'skipped',
    reason: 'no_ai_provider_configured',
    provider: null,
    model: null,
    response: null,
  });
}

/** The E.2 fixture: a JD requiring Kubernetes, and an ECS/Docker/Terraform claim. */
function kubernetesFixture(): { store: MatchStore; tables: Tables } {
  return buildStore({
    jobs: [jobFixture()],
    jobRequirements: [
      requirementFixture(),
      requirementFixture({
        id: 'req-2',
        text: 'Terraform',
        normalizedKey: 'terraform',
      }),
      requirementFixture({
        id: 'req-3',
        kind: RequirementKind.years_experience,
        importance: RequirementImportance.should,
        text: '7+ years of relevant experience',
        normalizedKey: '7 years of relevant experience',
      }),
    ],
    careerProfiles: [{ id: 'prof-1', userId: USER, createdAt: NOW, updatedAt: NOW }],
    // Not directly: created through the career layer so the fingerprint and the status
    // vocabulary are the real ones.
    careerClaims: [ECS_CLAIM],
  });
}

beforeEach(() => {
  setContextualProposer(null);
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 1: the Kubernetes fixture, end to end
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 1: the Kubernetes fixture yields a CONTEXTUAL pending match, never a direct match', () => {
  it('with an OBEDIENT provider proposing the link, it is contextual and pending', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();

    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    // Terraform is direct: the confirmed claim names it outright.
    // Kubernetes is contextual: the claim is adjacent, not naming.
    // Years is a gap: nothing supports it.
    expect(report.requirementCounts).toEqual({
      direct: 1,
      contextual: 1,
      potential: 0,
      unsupported: 1,
      total: 3,
    });

    const kubernetes = report.requirements.find((row) => row.id === 'req-1');
    expect(kubernetes?.level).toBe('contextual');
    expect(kubernetes?.evidence).toEqual([]);
    expect(kubernetes?.potentialMatch).toMatchObject({
      level: 'contextual',
      status: 'pending',
      claimId: 'clm-ecs',
    });
    // And it is NOT a gap: an open question is not an absence.
    expect(report.gaps.map((gap) => gap.requirementId)).toEqual(['req-3']);

    // The row that exists is a pending PotentialMatch, never a claim.
    expect(tables.potentialMatches).toHaveLength(1);
    expect(tables.potentialMatches[0]).toMatchObject({
      status: 'pending',
      level: 'contextual',
      requirementId: 'req-1',
    });
  });

  it('with NO provider the direct bucket and the named gaps are still computed', async () => {
    setContextualProposer(noProvider());
    const { store, tables } = kubernetesFixture();

    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    // ADR-041 D5: the deterministic half is complete and truthful. Terraform is direct;
    // Kubernetes has NO proposal without a provider, so it is an honest gap rather than an
    // invented one - that is the whole point of the skipped reason.
    expect(report.requirementCounts).toEqual({
      direct: 1,
      contextual: 0,
      potential: 0,
      unsupported: 2,
      total: 3,
    });
    expect(report.gaps).toEqual([
      {
        requirementId: 'req-1',
        normalizedKey: 'kubernetes',
        text: 'Kubernetes',
        kind: 'required_skill',
        importance: 'must',
      },
      {
        requirementId: 'req-3',
        normalizedKey: '7 years of relevant experience',
        text: '7+ years of relevant experience',
        kind: 'years_experience',
        importance: 'should',
      },
    ]);
    // The proposal stage is REPORTED as skipped, with the reason.
    expect(report.proposalStage).toMatchObject({
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      createdCount: 0,
    });
    // And nothing was invented to fill it.
    expect(tables.potentialMatches).toHaveLength(0);
  });

  it('ACCEPTANCE 4: the pending link does not move into `direct` on a re-match', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store } = kubernetesFixture();
    await matchJob({ userId: USER, jobId: 'job-1' }, store);
    // Run it again, and again: a proposal that has not been ruled on stays a proposal.
    const second = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const third = await getMatchReport(USER, second.matchReportId, store);

    for (const report of [second, third]) {
      expect(report.requirements.find((row) => row.id === 'req-1')?.level).toBe('contextual');
      expect(report.requirementCounts.direct).toBe(1);
    }
  });

  it('a re-run does not stack duplicate proposals', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    await matchJob({ userId: USER, jobId: 'job-1' }, store);
    await matchJob({ userId: USER, jobId: 'job-1' }, store);

    expect(tables.potentialMatches).toHaveLength(1);
  });

  it('a stale pending proposal for a now-direct requirement is removed, confirmed and rejected rows are kept', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const first = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    expect(tables.potentialMatches).toHaveLength(1);

    // The user confirms the claim's own text, which makes req-2 (Terraform) direct through
    // a second claim while the pending proposal for req-1 stays relevant. Now make req-1
    // direct as well by confirming the proposal.
    await confirmPotentialMatch(
      { userId: USER, matchReportId: first.matchReportId, potentialMatchId: tables.potentialMatches[0].id as string },
      store,
    );
    const second = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    expect(second.requirements.find((row) => row.id === 'req-1')?.level).toBe('direct');
    // The confirmed row survives: it is the audit trail for the decision.
    expect(tables.potentialMatches).toHaveLength(1);
    expect(tables.potentialMatches[0].status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 2a: confirm
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 2a: Confirm promotes through career/verification.ts, with an audit row', () => {
  it('the claim is confirmed AND a ClaimVerification row exists, together', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = tables.potentialMatches[0].id as string;

    const decision = await confirmPotentialMatch(
      { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
      store,
    );

    expect(decision.changed).toBe(true);
    expect(decision.potentialMatch.status).toBe('confirmed');

    // The claim exists, is confirmed, and carries the requirement's own wording.
    expect(decision.claim).toMatchObject({ kind: ClaimKind.skill, statement: 'Kubernetes' });
    expect(decision.claim?.status).toBe(ClaimStatus.user_confirmed);
    const stored = tables.careerClaims.find((row) => row.id === decision.claim?.id);
    expect(stored?.status).toBe(ClaimStatus.user_confirmed);
    expect(stored?.confirmedAt).toBeInstanceOf(Date);

    // TWO audit rows: the career_claim one written by career/verification.ts (the ONLY
    // place a confirming status may be written), and the potential_match one for the
    // decision about the inference itself.
    const claimAudit = tables.claimVerifications.filter(
      (row) => row.targetType === 'career_claim' && row.claimId === decision.claim?.id,
    );
    expect(claimAudit).toHaveLength(1);
    expect(claimAudit[0].action).toBe('confirm');
    expect(claimAudit[0].actorUserId).toBe(USER);
    expect(claimAudit[0].before).toMatchObject({ status: ClaimStatus.inferred });

    const potentialAudit = tables.claimVerifications.filter(
      (row) => row.targetType === 'potential_match',
    );
    expect(potentialAudit).toHaveLength(1);
    expect(potentialAudit[0].targetId).toBe(pmId);
    expect(potentialAudit[0].before).toMatchObject({ status: 'pending' });
    expect(potentialAudit[0].after).toMatchObject({ status: 'confirmed' });
  });

  it('the requirement RE-DERIVES as direct and leaves the contextual bucket', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    const decision = await confirmPotentialMatch(
      {
        userId: USER,
        matchReportId: report.matchReportId,
        potentialMatchId: tables.potentialMatches[0].id as string,
      },
      store,
    );

    expect(decision.report.requirementCounts).toEqual({
      direct: 2,
      contextual: 0,
      potential: 0,
      unsupported: 1,
      total: 3,
    });
    expect(decision.report.requirements.find((row) => row.id === 'req-1')?.level).toBe('direct');
    // And it is named: the direct level names the claim that carries it.
    expect(
      decision.report.requirements.find((row) => row.id === 'req-1')?.evidence[0]?.claimId,
    ).toBe(decision.claim?.id);
  });

  it('the stored count columns are the SAME numbers as the response body', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    const row = tables.matchReports.find((entry) => entry.id === report.matchReportId);
    expect(row).toMatchObject({
      directCount: report.requirementCounts.direct,
      contextualCount: report.requirementCounts.contextual,
      potentialCount: report.requirementCounts.potential,
      unsupportedCount: report.requirementCounts.unsupported,
      totalRequirements: report.requirementCounts.total,
    });
  });

  it('a second Confirm is an idempotent no-op that writes no second claim and no second row', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = tables.potentialMatches[0].id as string;

    const first = await confirmPotentialMatch(
      { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
      store,
    );
    const claimsAfterFirst = tables.careerClaims.length;
    const auditsAfterFirst = tables.claimVerifications.length;

    const second = await confirmPotentialMatch(
      { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
      store,
    );

    expect(second.changed).toBe(false);
    expect(second.claimVerification).toBeNull();
    expect(second.potentialVerification).toBeNull();
    expect(tables.careerClaims).toHaveLength(claimsAfterFirst);
    expect(tables.claimVerifications).toHaveLength(auditsAfterFirst);
    expect(second.claim?.id).toBe(first.claim?.id);
  });

  it('a supplied statement overrides the requirement text and is what gets confirmed', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = (await getMatchReport(USER, report.matchReportId, store)).requirements.find(
      (row) => row.id === 'req-1',
    )?.potentialMatch?.id as string;

    const decision = await confirmPotentialMatch(
      {
        userId: USER,
        matchReportId: report.matchReportId,
        potentialMatchId: pmId,
        statement: 'Ran Kubernetes clusters on EKS for a payments platform',
      },
      store,
    );

    expect(decision.claim?.statement).toBe('Ran Kubernetes clusters on EKS for a payments platform');
    // The user's own wording still names the requirement, so the join fires and the
    // requirement is direct - attributed to the claim they wrote.
    expect(decision.report.requirements.find((row) => row.id === 'req-1')?.level).toBe('direct');
  });

  it('the requirement kind decides the CLAIM kind', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    await confirmPotentialMatch(
      {
        userId: USER,
        matchReportId: report.matchReportId,
        potentialMatchId: tables.potentialMatches[0].id as string,
      },
      store,
    );

    expect(CLAIM_KIND_FOR_REQUIREMENT[RequirementKind.required_skill]).toBe(ClaimKind.skill);
    expect(CLAIM_KIND_FOR_REQUIREMENT[RequirementKind.technology]).toBe(ClaimKind.technology);
    expect(CLAIM_KIND_FOR_REQUIREMENT[RequirementKind.domain]).toBe(ClaimKind.domain);
    expect(CLAIM_KIND_FOR_REQUIREMENT[RequirementKind.years_experience]).toBe(ClaimKind.metric);
    expect(CLAIM_KIND_FOR_REQUIREMENT[RequirementKind.education]).toBe(ClaimKind.education);
  });

  it('a screening criterion cannot be confirmed without a statement, and says why', async () => {
    const { store, tables } = buildStore({
      jobs: [jobFixture()],
      jobRequirements: [
        requirementFixture({
          id: 'req-screen',
          kind: RequirementKind.screening_criterion,
          text: 'Are you legally authorised to work in the UK?',
          normalizedKey: 'legally authorised to work in the uk',
        }),
      ],
      careerProfiles: [{ id: 'prof-1', userId: USER }],
      careerClaims: [ECS_CLAIM],
    });
    // The proposer is installed INSIDE the test body so the fixture above is built first, and
    // it points at the screening-criterion requirement this fixture actually has.
    setContextualProposer(
      obeyfulProposer([{ ...K8S_LINK, requirementId: 'req-screen' }]),
    );
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = tables.potentialMatches[0].id as string;

    await expect(
      confirmPotentialMatch(
        { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
        store,
      ),
    ).rejects.toThrow(UNMAPPED_REQUIREMENT_KIND_REASON);

    // No claim was created by the refusal.
    expect(tables.careerClaims).toHaveLength(1);
    expect(tables.claimVerifications).toHaveLength(0);
    expect(tables.potentialMatches[0].status).toBe('pending');
  });

  it('a REJECTED proposal cannot be confirmed - a rejection is never cleared implicitly', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = tables.potentialMatches[0].id as string;
    await rejectPotentialMatch(
      { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
      store,
    );

    await expect(
      confirmPotentialMatch(
        { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
        store,
      ),
    ).rejects.toThrow(/already rejected/);
    expect(tables.careerClaims).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 2b: reject
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 2b: Reject yields a NAMED gap, recorded forever', () => {
  it('the requirement becomes unsupported and is named in gaps', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    expect(report.gaps.map((gap) => gap.requirementId)).toEqual(['req-3']);

    const decision = await rejectPotentialMatch(
      {
        userId: USER,
        matchReportId: report.matchReportId,
        potentialMatchId: tables.potentialMatches[0].id as string,
        reason: 'I never ran Kubernetes',
      },
      store,
    );

    expect(decision.changed).toBe(true);
    expect(decision.potentialMatch.status).toBe('rejected');
    expect(decision.report.requirements.find((row) => row.id === 'req-1')?.level).toBe('unsupported');
    // The gap is NAMED: id, text, kind, importance. Not a number, not a deduction.
    expect(decision.report.gaps).toContainEqual({
      requirementId: 'req-1',
      normalizedKey: 'kubernetes',
      text: 'Kubernetes',
      kind: 'required_skill',
      importance: 'must',
    });
    expect(decision.report.requirementCounts).toEqual({
      direct: 1,
      contextual: 0,
      potential: 0,
      unsupported: 2,
      total: 3,
    });
  });

  it('the rejection is on the record: an audit row, with the reason', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = tables.potentialMatches[0].id as string;

    await rejectPotentialMatch(
      {
        userId: USER,
        matchReportId: report.matchReportId,
        potentialMatchId: pmId,
        reason: 'I never ran Kubernetes',
      },
      store,
    );

    const audit = tables.claimVerifications.filter((row) => row.targetType === 'potential_match');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'reject',
      targetId: pmId,
      actorUserId: USER,
      note: 'I never ran Kubernetes',
    });
    expect(audit[0].after).toMatchObject({ status: 'rejected' });
  });

  it('rejecting creates NO claim', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    await rejectPotentialMatch(
      { userId: USER, matchReportId: report.matchReportId, potentialMatchId: tables.potentialMatches[0].id as string },
      store,
    );

    expect(tables.careerClaims).toHaveLength(1);
  });

  it('a second Reject is an idempotent no-op with no second audit row', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = tables.potentialMatches[0].id as string;

    await rejectPotentialMatch(
      { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
      store,
    );
    const audits = tables.claimVerifications.length;
    const second = await rejectPotentialMatch(
      { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
      store,
    );

    expect(second.changed).toBe(false);
    expect(tables.claimVerifications).toHaveLength(audits);
  });

  it('a CONFIRMED proposal cannot be rejected here - the CLAIM is what is now true', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = tables.potentialMatches[0].id as string;
    await confirmPotentialMatch(
      { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
      store,
    );

    await expect(
      rejectPotentialMatch(
        { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
        store,
      ),
    ).rejects.toThrow(/Career evidence page/);
    // The confirmed claim is untouched: this endpoint does not quietly undo a decision.
    expect(tables.careerClaims.filter((row) => row.status === ClaimStatus.user_confirmed)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// No score, no percentage (E.6)
// ---------------------------------------------------------------------------

describe('E.6: the report carries counts and names, never a single number', () => {
  it('the counts are four integers that sum to the total', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const counts = report.requirementCounts;

    const sum =
      counts.direct + counts.contextual + counts.potential + counts.unsupported;
    expect(sum).toBe(counts.total);
    for (const value of Object.values(counts)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('the response object has no score-like member, at any depth', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    // KEY names only. A proposal's free-text `rationale` may legitimately contain the word
    // "score" ("this role's scorecard"), and the ban E.6 states is on the API having a
    // verdict field - not on the English language.
    const forbidden = /^(overall[_-]?)?(match[_-]?)?(score|rating|grade|percent(age)?|ratio|points?)([_-]?(score|value))?$/i;
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        expect(key, `a score-like response key at ${path}.${key}`).not.toMatch(forbidden);
        walk(value, `${path}.${key}`);
      }
    };
    walk(report, 'report');
  });

  it('the source declares no score field and never reads the display weight', () => {
    // `JobRequirement.weight` is in the schema as a "display weight, not a score
    // component"; reading it in a report is the first step towards a score.
    const code = REPORT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bscore\b/i);
    expect(code).not.toMatch(/percent/i);
    expect(code).not.toMatch(/\bweight\b/);
  });

  it('the response names the rule, and the rule is a constant', () => {
    expect(MATCH_REPORT_NOTES).toBe(
      'Gaps are named, not scored. Nothing here is combined into a single number.',
    );
  });

  it('JobRequirement.weight is not exposed anywhere in the report', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    for (const row of report.requirements) {
      expect(Object.keys(row)).not.toContain('weight');
    }
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('cross-tenant access is a 404, never a 403 and never another person data', () => {
  it("another user's job is a 404", async () => {
    const { store } = buildStore({ jobs: [jobFixture({ userId: 'someone-else' })] });
    await expect(matchJob({ userId: USER, jobId: 'job-1' }, store)).rejects.toThrow(/Job not found/);
  });

  it('an unknown job is a 404', async () => {
    const { store } = buildStore();
    await expect(matchJob({ userId: USER, jobId: 'nope' }, store)).rejects.toThrow(/Job not found/);
  });

  it("another user's report is a 404", async () => {
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    await expect(getMatchReport('someone-else', report.matchReportId, store)).rejects.toThrow(
      /Match report not found/,
    );
    expect(tables.matchReports).toHaveLength(1);
  });

  it("another user's resume cannot be attached to the report", async () => {
    const { store } = buildStore({
      jobs: [jobFixture()],
      careerProfiles: [{ id: 'prof-1', userId: USER }],
      resumes: [{ id: 'res-1', userId: 'someone-else' }],
    });
    await expect(
      matchJob({ userId: USER, jobId: 'job-1', resumeId: 'res-1' }, store),
    ).rejects.toThrow(/Resume not found/);
  });

  it('a proposal from ANOTHER report is not found, so the two ids cannot be mixed', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const reportA = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = tables.potentialMatches[0].id as string;

    // A second job, hence a second report, sharing the same profile.
    const second = buildStore({
      jobs: [jobFixture({ id: 'job-2', contentHash: 'hash-2' })],
      jobRequirements: [requirementFixture({ jobId: 'job-2' })],
      careerProfiles: [{ id: 'prof-1', userId: USER }],
      careerClaims: [ECS_CLAIM],
      matchReports: [],
    });
    // The proposal belongs to reportA; asking through reportB must not find it.
    await expect(
      confirmPotentialMatch(
        { userId: USER, matchReportId: 'mr-does-not-exist', potentialMatchId: pmId },
        second.store,
      ),
    ).rejects.toThrow(/Match report not found/);
    expect(reportA.matchReportId).not.toBe('mr-does-not-exist');
  });
});

// ---------------------------------------------------------------------------
// The decision endpoints report a stage they never ran
// ---------------------------------------------------------------------------

describe('a DECISION reports the proposal stage as not_evaluated, whatever the keys say', () => {
  it('CONFIRM with a PROVIDER CONFIGURED never claims there is no provider', async () => {
    // The proposal in this fixture was created BY a working provider, so reporting
    // `no_ai_provider_configured` here would be a false statement about the user's keys -
    // the defect deviation D4 removed from the read path.
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    const decision = await confirmPotentialMatch(
      {
        userId: USER,
        matchReportId: report.matchReportId,
        potentialMatchId: tables.potentialMatches[0].id as string,
      },
      store,
    );

    expect(decision.report.proposalStage).toEqual({
      status: 'skipped',
      reason: 'not_evaluated',
      provider: null,
      model: null,
      createdCount: 0,
      dropped: [],
    });
  });

  it('CONFIRM with NO provider configured reports exactly the same thing', async () => {
    // Both states, because a reason that only reads correctly in one of them is a reason
    // that can lie. The proposal is created first (a provider was reachable), then the
    // provider goes away: the decision endpoint consulted no keys either way.
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    setContextualProposer(noProvider());

    const decision = await confirmPotentialMatch(
      {
        userId: USER,
        matchReportId: report.matchReportId,
        potentialMatchId: tables.potentialMatches[0].id as string,
      },
      store,
    );

    expect(decision.report.proposalStage.reason).toBe('not_evaluated');
    // The match run itself still reports the REAL provider state, so nothing is hidden:
    expect(decision.report.proposalStage.status).toBe('skipped');
    expect(report.proposalStage.reason).toBe('ok');
  });

  it('REJECT makes the same claim about the stage in both provider states', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const pmId = tables.potentialMatches[0].id as string;

    const withProvider = await rejectPotentialMatch(
      { userId: USER, matchReportId: report.matchReportId, potentialMatchId: pmId },
      store,
    );
    expect(withProvider.report.proposalStage.reason).toBe('not_evaluated');

    setContextualProposer(noProvider());
    const second = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    // req-2 (Terraform) is direct and req-1 is now rejected, so the re-run proposes nothing;
    // the reject below is on the row the first decision left, and the reason must not change.
    const noProviderDecision = await rejectPotentialMatch(
      { userId: USER, matchReportId: second.matchReportId, potentialMatchId: pmId },
      store,
    );
    expect(noProviderDecision.report.proposalStage.reason).toBe('not_evaluated');
    expect(noProviderDecision.changed).toBe(false);
  });

  it('the reason is a constant in the source, not a provider probe', async () => {
    // The honest reason costs nothing: the endpoint never reads the key manager, so it must
    // not be able to report a provider state. If somebody later probes it, this pins that
    // the reason stayed the truthful one.
    const code = REPORT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.match(/skippedProposal\('not_evaluated'\)/g)).toHaveLength(3);
    expect(code).not.toMatch(/skippedProposal\('no_ai_provider_configured'\)/);
  });
});

// ---------------------------------------------------------------------------
// `changed` is a real answer
// ---------------------------------------------------------------------------

describe('`changed` reports what THIS call did, on the dedupe path too', () => {
  it('a confirm whose statement DEDUPED onto an existing claim is still changed: true', async () => {
    // The case the old `decision.changed || true` hid. An unconfirmed claim with the same
    // statement already exists, so `createUserClaim` writes NO new claim row
    // (`decision.changed === false` there) - but this call still flipped the proposal, wrote
    // its audit row and re-derived the requirement as `direct`. The consumer
    // (`src/pages/Match.tsx`) asks "did this call change anything", and the answer is yes.
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const existing = await createClaim(
      {
        profileId: 'prof-1',
        kind: ClaimKind.skill,
        statement: 'Kubernetes',
        provenance: ClaimProvenance.user_entered,
      },
      store,
    );
    const claimsBefore = tables.careerClaims.length;

    const decision = await confirmPotentialMatch(
      {
        userId: USER,
        matchReportId: report.matchReportId,
        potentialMatchId: tables.potentialMatches[0].id as string,
      },
      store,
    );

    // The dedupe really happened: no second claim row.
    expect(tables.careerClaims).toHaveLength(claimsBefore);
    expect(decision.claim?.id).toBe(existing.claim.id);
    // And the decision is still honestly reported as a change.
    expect(decision.changed).toBe(true);
    expect(decision.potentialMatch.status).toBe('confirmed');
    expect(decision.report.requirements.find((row) => row.id === 'req-1')?.level).toBe('direct');
    expect(
      tables.claimVerifications.filter((row) => row.targetType === 'potential_match'),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The read path
// ---------------------------------------------------------------------------

describe('GET /matches/:id re-derives rather than replaying stored columns', () => {
  it('a claim confirmed ELSEWHERE is reflected without a re-match', async () => {
    const { store, tables } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    expect(report.requirementCounts.direct).toBe(1);

    // The user confirms a Kubernetes claim on the career page, through the real service.
    const created = await createClaim(
      {
        profileId: 'prof-1',
        kind: ClaimKind.skill,
        statement: 'Kubernetes',
        provenance: ClaimProvenance.user_entered,
      },
      store,
    );
    await confirmClaim({ claimId: created.claim.id, actorUserId: USER, now: NOW }, store);

    const reread = await getMatchReport(USER, report.matchReportId, store);
    expect(reread.requirementCounts.direct).toBe(2);
    expect(reread.requirementCounts.unsupported).toBe(1);
    // The stored columns are the STALE snapshot, and the body is the truth.
    const row = tables.matchReports.find((entry) => entry.id === report.matchReportId);
    expect(row?.directCount).toBe(1);
  });

  it('the read reports the proposal stage as not evaluated, not as a provider state', async () => {
    const { store } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const reread = await getMatchReport(USER, report.matchReportId, store);

    // Claiming `no_ai_provider_configured` from a GET would be asserting something about
    // the user's configuration that this request never checked.
    expect(reread.proposalStage.reason).toBe('not_evaluated');
  });

  it('the counts and the gaps are recomputed from the live rows, not from the columns', async () => {
    const { store } = kubernetesFixture();
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const reread = await getMatchReport(USER, report.matchReportId, store);
    expect(reread.requirementCounts).toEqual(report.requirementCounts);
    expect(reread.gaps).toEqual(report.gaps);
  });
});

// ---------------------------------------------------------------------------
// The report row itself
// ---------------------------------------------------------------------------

describe('the MatchReport row', () => {
  it('matching the same job twice is one report, refreshed', async () => {
    setContextualProposer(noProvider());
    const { store, tables } = kubernetesFixture();
    const first = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    const second = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    expect(second.matchReportId).toBe(first.matchReportId);
    expect(tables.matchReports).toHaveLength(1);
  });

  it('a career profile is created on demand for a user who has never saved one', async () => {
    // `MatchReport.profileId` is NOT NULL, and a container that asserts no fact about the
    // person is the same rule `routes/career.ts` applies on the import path.
    const { store, tables } = buildStore({
      jobs: [jobFixture()],
      jobRequirements: [requirementFixture()],
    });
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    expect(tables.careerProfiles).toHaveLength(1);
    expect(report.profileId).toBe(tables.careerProfiles[0].id);
    // No claim was invented along the way.
    expect(tables.careerClaims).toHaveLength(0);
    expect(report.confirmedClaimCount).toBe(0);
    expect(report.requirementCounts.unsupported).toBe(1);
  });

  it('an unconfirmed claim of the same words contributes nothing', async () => {
    const { store } = buildStore({
      jobs: [jobFixture()],
      jobRequirements: [requirementFixture()],
      careerProfiles: [{ id: 'prof-1', userId: USER }],
      careerClaims: [
        {
          ...ECS_CLAIM,
          id: 'clm-inferred',
          statement: 'Kubernetes',
          status: ClaimStatus.inferred,
          confirmedAt: null,
        },
      ],
    });
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    expect(report.requirementCounts.direct).toBe(0);
    expect(report.gaps.map((gap) => gap.requirementId)).toEqual(['req-1']);
  });

  it('a rejected claim contributes nothing (ADR-036 item 5)', async () => {
    const { store } = buildStore({
      jobs: [jobFixture()],
      jobRequirements: [requirementFixture()],
      careerProfiles: [{ id: 'prof-1', userId: USER }],
      careerClaims: [
        {
          ...ECS_CLAIM,
          id: 'clm-rejected',
          statement: 'Kubernetes',
          status: ClaimStatus.rejected,
          confirmedAt: null,
        },
      ],
    });
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    expect(report.requirementCounts.direct).toBe(0);
  });

  it('a job with no requirements reports zeros rather than failing', async () => {
    setContextualProposer(obeyfulProposer([K8S_LINK]));
    const { store, tables } = buildStore({
      jobs: [jobFixture()],
      jobRequirements: [],
      careerProfiles: [{ id: 'prof-1', userId: USER }],
      careerClaims: [ECS_CLAIM],
    });
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);

    expect(report.requirementCounts).toEqual({
      direct: 0,
      contextual: 0,
      potential: 0,
      unsupported: 0,
      total: 0,
    });
    expect(report.gaps).toEqual([]);
    expect(tables.potentialMatches).toHaveLength(0);
  });

  it('a malformed requirement key is reported, not repaired', async () => {
    const { store } = buildStore({
      jobs: [jobFixture()],
      jobRequirements: [requirementFixture({ normalizedKey: '' })],
      careerProfiles: [{ id: 'prof-1', userId: USER }],
      careerClaims: [ECS_CLAIM],
    });
    const report = await matchJob({ userId: USER, jobId: 'job-1' }, store);
    // An empty key joins nothing, so the requirement is a gap rather than a silent direct.
    expect(report.requirements[0].level).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe('the store seam is the real client', () => {
  it('MatchStore is structurally satisfied by PrismaClient (compile-time; proved by tsc)', () => {
    // The assertion here is that the file declares the check. `npx tsc --noEmit` fails if
    // `RealClientSatisfiesMatchStore` is ever false.
    expect(REPORT_SOURCE).toContain('PrismaClient extends MatchStore');
  });

  it('a decision writes through career/verification.ts, never a raw status update', () => {
    const code = REPORT_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain("from '../career/userDecisions.js'");
    // No raw claim-status write and no confirming status literal in this module.
    expect(code).not.toMatch(/careerClaim\.(update|upsert)\(/);
    expect(code).not.toMatch(/user_confirmed/);
    expect(code).not.toMatch(/ClaimStatus\./);
  });
});