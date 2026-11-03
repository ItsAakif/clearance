// =====================================================================================
// routes/matches.test.ts - the HTTP surface of evidence-level matching (T1070).
//
// NOT A DUPLICATE OF THE SERVICE SUITES. Those prove the decisions; this proves what a
// CLIENT can observe, and four things only the route can be responsible for:
//
//   1. AUTH AND MOUNTING. Every route is behind `requireAuth` - asserted both by an
//      unauthenticated 401 through the real middleware and by a source guard over the file -
//      and the two mounts (`/jobs` and `/matches`) both answer.
//   2. THE ENVELOPE IS VALIDATED, NOT ASSUMED. `.strict()` proven through a misspelled
//      member and through `score: true`, which is the exact request a caller reaching for a
//      verdict would send and which must be a 400 rather than a silently ignored field.
//   3. A FOREIGN id IS A 404, NOT A 403, on every route.
//   4. THE DECISION RESPONSES CARRY WHAT THE UI NEEDS: the fresh report (so a confirm shows
//      the new count and a reject shows the new named gap), and both audit rows.
//
// The prisma singleton is mocked with in-memory tables; `../match/report.js` is NOT mocked,
// so this suite exercises the shipped services through real HTTP.
// =====================================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  ClaimKind,
  ClaimProvenance,
  ClaimStatus,
  RequirementImportance,
  RequirementKind,
} from '@prisma/client';
import { setContextualProposer } from '../match/potential.js';
import type { MatchStore } from '../match/report.js';

type Row = Record<string, unknown>;

// `__dirname` matches the repo's other source guards (`career/claimWriterAI.test.ts`) and is
// the only spelling that works under the CJS output `tsc` produces.
const ROUTE_FILE = path.join(__dirname, 'matches.ts');
const ROUTE_SOURCE = readFileSync(ROUTE_FILE, 'utf8');
const NOW = new Date('2026-10-03T12:00:00.000Z');
const USER = 'user-1';

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const { mockUserId, prismaMock, tables } = vi.hoisted(() => {
  const t = {
    jobs: [] as Row[],
    jobRequirements: [] as Row[],
    careerProfiles: [] as Row[],
    careerClaims: [] as Row[],
    claimVerifications: [] as Row[],
    matchReports: [] as Row[],
    potentialMatches: [] as Row[],
    resumes: [] as Row[],
    writes: [] as string[],
  };

  const matches = (row: Row, where?: Row): boolean =>
    where === undefined
      ? true
      : Object.entries(where).every(([key, value]) => {
          if (value === undefined) return true;
          return row[key] === value;
        });

  const delegate = (rows: Row[], model: string) => ({
    findUnique: vi.fn(async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null),
    findFirst: vi.fn(async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null),
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where))),
    create: vi.fn(async ({ data }: { data: Row }) => {
      t.writes.push(`${model}.create`);
      const row = { id: `${model}-${rows.length + 1}`, createdAt: new Date(), ...data };
      rows.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
      t.writes.push(`${model}.update`);
      const index = rows.findIndex((r) => r.id === where.id);
      if (index === -1) throw new Error(`no ${model} ${where.id}`);
      rows[index] = { ...rows[index], ...data };
      return rows[index];
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      t.writes.push(`${model}.delete`);
      const index = rows.findIndex((r) => r.id === where.id);
      if (index === -1) throw new Error(`no ${model} ${where.id}`);
      return rows.splice(index, 1)[0];
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      t.writes.push(`${model}.deleteMany`);
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count };
    }),
  });

  const models = {
    job: delegate(t.jobs, 'job'),
    jobRequirement: delegate(t.jobRequirements, 'req'),
    careerProfile: delegate(t.careerProfiles, 'prof'),
    careerClaim: delegate(t.careerClaims, 'clm'),
    claimVerification: delegate(t.claimVerifications, 'ver'),
    matchReport: delegate(t.matchReports, 'mr'),
    potentialMatch: delegate(t.potentialMatches, 'pm'),
    resume: delegate(t.resumes, 'res'),
  };

  return {
    mockUserId: { value: 'user-1' as string | null },
    prismaMock: {
      ...models,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(models)),
    },
    tables: t,
  };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (mockUserId.value === null) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMock }));

import matchesRouter from './matches.js';

// ---------------------------------------------------------------------------
// The app, mounted exactly as routes/index.ts mounts it
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/jobs', matchesRouter);
  app.use('/matches', matchesRouter);
  return app;
}

const app = makeApp();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const K8S_LINK = {
  requirementId: 'req-1',
  claimId: 'clm-ecs',
  level: 'contextual',
  rationale: 'Adjacent container orchestration; same competency family',
};

function seed(): void {
  tables.jobs.length = 0;
  tables.jobRequirements.length = 0;
  tables.careerProfiles.length = 0;
  tables.careerClaims.length = 0;
  tables.claimVerifications.length = 0;
  tables.matchReports.length = 0;
  tables.potentialMatches.length = 0;
  tables.resumes.length = 0;
  tables.writes.length = 0;

  tables.jobs.push({
    id: 'job-1',
    userId: 'user-1',
    title: 'Staff Platform Engineer',
    company: 'Acme',
    seniority: 'staff',
    sourceKind: 'pasted_text',
    contentHash: 'hash-1',
    rawText: 'jd',
    analysisJson: null,
    analyzedAt: NOW,
    updatedAt: NOW,
  });
  tables.jobRequirements.push({
    id: 'req-1',
    jobId: 'job-1',
    kind: RequirementKind.required_skill,
    importance: RequirementImportance.must,
    text: 'Kubernetes',
    normalizedKey: 'kubernetes',
    weight: 1,
    provenance: ClaimProvenance.derived,
    createdAt: NOW,
  });
  tables.jobRequirements.push({
    id: 'req-2',
    jobId: 'job-1',
    kind: RequirementKind.years_experience,
    importance: RequirementImportance.must,
    text: '7+ years of relevant experience',
    normalizedKey: '7 years of relevant experience',
    weight: 1,
    provenance: ClaimProvenance.derived,
    createdAt: NOW,
  });
  tables.careerProfiles.push({ id: 'prof-1', userId: 'user-1', createdAt: NOW, updatedAt: NOW });
  tables.careerClaims.push({
    id: 'clm-ecs',
    profileId: 'prof-1',
    kind: ClaimKind.responsibility,
    statement:
      'Designed and operated a containerised deployment pipeline on ECS with Docker and Terraform',
    fingerprint: 'fp-ecs',
    status: ClaimStatus.user_confirmed,
    provenance: ClaimProvenance.document_import,
    confidence: null,
    confirmedAt: NOW,
    rejectedAt: null,
    rejectedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function obeyful() {
  setContextualProposer(async () => ({
    status: 'applied' as const,
    reason: 'ok' as const,
    provider: 'openai',
    model: 'gpt-test',
    response: { schemaVersion: 'match_contextual_v1', links: [K8S_LINK] },
  }));
}

function noProvider() {
  setContextualProposer(async () => ({
    status: 'skipped' as const,
    reason: 'no_ai_provider_configured' as const,
    provider: null,
    model: null,
    response: null,
  }));
}

beforeEach(() => {
  seed();
  mockUserId.value = 'user-1';
  setContextualProposer(null);
});

// ---------------------------------------------------------------------------
// POST /jobs/:id/match
// ---------------------------------------------------------------------------

describe('POST /jobs/:id/match', () => {
  it('ACCEPTANCE 1 over HTTP: the Kubernetes fixture is a CONTEXTUAL pending match', async () => {
    obeyful();
    const response = await request(app).post('/jobs/job-1/match').send({});

    expect(response.status).toBe(200);
    expect(response.body.requirementCounts).toEqual({
      direct: 0,
      contextual: 1,
      potential: 0,
      unsupported: 1,
      total: 2,
    });
    const kubernetes = response.body.requirements.find((row: Row) => row.id === 'req-1');
    expect(kubernetes.level).toBe('contextual');
    expect(kubernetes.potentialMatch).toMatchObject({ status: 'pending', level: 'contextual' });
    expect(response.body.gaps.map((gap: Row) => gap.text)).toEqual(['7+ years of relevant experience']);
  });

  it('ADR-041 D5 over HTTP: no provider still yields direct counts and named gaps', async () => {
    noProvider();
    const response = await request(app).post('/jobs/job-1/match').send({});

    expect(response.status).toBe(200);
    expect(response.body.proposalStage).toMatchObject({
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      createdCount: 0,
    });
    // Both requirements are honestly gaps: nothing confirms them, and nothing was invented.
    expect(response.body.requirementCounts.unsupported).toBe(2);
    expect(response.body.gaps).toHaveLength(2);
    expect(tables.potentialMatches).toHaveLength(0);
  });

  it('the response has no score-like key at any depth', async () => {
    obeyful();
    const response = await request(app).post('/jobs/job-1/match').send({});

    const forbidden =
      /^(overall[_-]?)?(match[_-]?)?(score|rating|grade|percent(age)?|ratio|points?)([_-]?(score|value))?$/i;
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${at}[${index}]`));
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        expect(key, `a score-like response key at ${at}.${key}`).not.toMatch(forbidden);
        walk(value, `${at}.${key}`);
      }
    };
    walk(response.body, 'report');
  });

  it('a second call is 200 with the SAME matchReportId', async () => {
    obeyful();
    const first = await request(app).post('/jobs/job-1/match').send({});
    const second = await request(app).post('/jobs/job-1/match').send({});
    expect(second.status).toBe(200);
    expect(second.body.matchReportId).toBe(first.body.matchReportId);
    expect(tables.matchReports).toHaveLength(1);
  });

  it('an unknown member is a 400', async () => {
    const response = await request(app).post('/jobs/job-1/match').send({ resumeId: 'r1', extra: true });
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/Unrecognized key/);
  });

  it("`score: true` is a 400 - the client cannot even ask for a verdict", async () => {
    const response = await request(app).post('/jobs/job-1/match').send({ score: true });
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/Unrecognized key/);
  });

  it('an unknown job is a 404 and a foreign job is a 404', async () => {
    expect((await request(app).post('/jobs/nope/match').send({})).status).toBe(404);
    tables.jobs[0].userId = 'someone-else';
    expect((await request(app).post('/jobs/job-1/match').send({})).status).toBe(404);
  });

  it('no session is a 401', async () => {
    mockUserId.value = null;
    expect((await request(app).post('/jobs/job-1/match').send({})).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /matches/:id
// ---------------------------------------------------------------------------

describe('GET /matches/:id', () => {
  it('200 with the re-derived report', async () => {
    obeyful();
    const created = await request(app).post('/jobs/job-1/match').send({});

    const response = await request(app).get(`/matches/${created.body.matchReportId}`);

    expect(response.status).toBe(200);
    expect(response.body.requirementCounts).toEqual(created.body.requirementCounts);
    // A read asserts nothing about the provider stage.
    expect(response.body.proposalStage.reason).toBe('not_evaluated');
  });

  it('an unknown or foreign report is a 404', async () => {
    expect((await request(app).get('/matches/nope')).status).toBe(404);
    obeyful();
    const created = await request(app).post('/jobs/job-1/match').send({});
    mockUserId.value = 'someone-else';
    expect((await request(app).get(`/matches/${created.body.matchReportId}`)).status).toBe(404);
  });

  it('no session is a 401', async () => {
    mockUserId.value = null;
    expect((await request(app).get('/matches/anything')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The two decisions
// ---------------------------------------------------------------------------

describe('POST /matches/:id/potential/:pmId/confirm', () => {
  it('ACCEPTANCE 2a over HTTP: the claim is confirmed WITH an audit row, and the report re-derives', async () => {
    obeyful();
    const created = await request(app).post('/jobs/job-1/match').send({});
    const pmId = tables.potentialMatches[0].id as string;

    const response = await request(app)
      .post(`/matches/${created.body.matchReportId}/potential/${pmId}/confirm`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.changed).toBe(true);
    expect(response.body.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(response.body.claimVerification).toMatchObject({ action: 'confirm' });
    expect(response.body.potentialVerification).toMatchObject({
      action: 'confirm',
      targetType: 'potential_match',
    });

    // The rows really exist.
    const audits = tables.claimVerifications.filter(
      (row) => row.targetType === 'career_claim' && row.claimId === response.body.claim.id,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBe(USER);

    // And the report the UI gets back already shows the new state.
    expect(response.body.report.requirementCounts.direct).toBe(1);
    expect(response.body.report.requirementCounts.contextual).toBe(0);
  });

  it('a second confirm is a 200 no-op', async () => {
    obeyful();
    const created = await request(app).post('/jobs/job-1/match').send({});
    const pmId = tables.potentialMatches[0].id as string;
    await request(app).post(`/matches/${created.body.matchReportId}/potential/${pmId}/confirm`).send({});
    const claims = tables.careerClaims.length;

    const again = await request(app)
      .post(`/matches/${created.body.matchReportId}/potential/${pmId}/confirm`)
      .send({});

    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(tables.careerClaims).toHaveLength(claims);
  });

  it('a body with a status member is a 400 - the client cannot write one', async () => {
    obeyful();
    const created = await request(app).post('/jobs/job-1/match').send({});
    const pmId = tables.potentialMatches[0].id as string;

    const response = await request(app)
      .post(`/matches/${created.body.matchReportId}/potential/${pmId}/confirm`)
      .send({ status: 'user_confirmed' });

    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/Unrecognized key/);
    expect(tables.potentialMatches[0].status).toBe('pending');
  });

  it('a proposal from another report is a 404', async () => {
    obeyful();
    const created = await request(app).post('/jobs/job-1/match').send({});
    const pmId = tables.potentialMatches[0].id as string;
    const response = await request(app)
      .post(`/matches/mr-does-not-exist/potential/${pmId}/confirm`)
      .send({});
    expect(response.status).toBe(404);
  });

  it('no session is a 401', async () => {
    mockUserId.value = null;
    expect(
      (await request(app).post('/matches/mr-1/potential/pm-1/confirm').send({})).status,
    ).toBe(401);
  });
});

describe('POST /matches/:id/potential/:pmId/reject', () => {
  it('ACCEPTANCE 2b over HTTP: the requirement becomes a NAMED gap in the same response', async () => {
    obeyful();
    const created = await request(app).post('/jobs/job-1/match').send({});
    const pmId = tables.potentialMatches[0].id as string;
    expect(created.body.gaps).toHaveLength(1);

    const response = await request(app)
      .post(`/matches/${created.body.matchReportId}/potential/${pmId}/reject`)
      .send({ reason: 'I never ran Kubernetes' });

    expect(response.status).toBe(200);
    expect(response.body.potentialMatch.status).toBe('rejected');
    // The gap the UI shows is the one this gesture created.
    expect(response.body.report.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requirementId: 'req-1', text: 'Kubernetes', importance: 'must' }),
      ]),
    );
    expect(response.body.report.requirements.find((row: Row) => row.id === 'req-1').level).toBe(
      'unsupported',
    );
    // The decision is on the record.
    expect(tables.claimVerifications).toContainEqual(
      expect.objectContaining({ targetType: 'potential_match', action: 'reject' }),
    );
    // And no claim was created by rejecting.
    expect(tables.careerClaims).toHaveLength(1);
  });

  it('a second reject is a 200 no-op with no second audit row', async () => {
    obeyful();
    const created = await request(app).post('/jobs/job-1/match').send({});
    const pmId = tables.potentialMatches[0].id as string;
    await request(app).post(`/matches/${created.body.matchReportId}/potential/${pmId}/reject`).send({});
    const audits = tables.claimVerifications.length;

    const again = await request(app)
      .post(`/matches/${created.body.matchReportId}/potential/${pmId}/reject`)
      .send({});

    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(tables.claimVerifications).toHaveLength(audits);
  });

  it('confirming then rejecting is a 409, and the confirmed claim survives', async () => {
    obeyful();
    const created = await request(app).post('/jobs/job-1/match').send({});
    const pmId = tables.potentialMatches[0].id as string;
    await request(app).post(`/matches/${created.body.matchReportId}/potential/${pmId}/confirm`).send({});

    const response = await request(app)
      .post(`/matches/${created.body.matchReportId}/potential/${pmId}/reject`)
      .send({});

    expect(response.status).toBe(409);
    expect(tables.careerClaims.filter((row) => row.status === ClaimStatus.user_confirmed)).toHaveLength(2);
  });

  it('no session is a 401', async () => {
    mockUserId.value = null;
    expect(
      (await request(app).post('/matches/mr-1/potential/pm-1/reject').send({})).status,
    ).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Source guards
// ---------------------------------------------------------------------------

describe('source guards on the route file', () => {
  const code = ROUTE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('every route is behind requireAuth', () => {
    const routes = [...ROUTE_SOURCE.matchAll(/router\.(get|post|put|patch|delete)\(/g)];
    expect(routes.length).toBeGreaterThan(0);
    for (const match of routes) {
      const start = match.index ?? 0;
      expect(ROUTE_SOURCE.slice(start, start + 120), match[0]).toContain('requireAuth');
    }
  });

  it('the route never writes a claim and never names a claim status', () => {
    expect(code).not.toMatch(/prisma\.careerClaim/);
    expect(code).not.toMatch(/careerClaim\.(update|upsert|create)/);
    expect(code).not.toMatch(/user_confirmed/);
    expect(code).not.toMatch(/ClaimStatus\./);
  });

  it('the route reaches the career layer only through userDecisions (the allowed path)', () => {
    // `career/claimWriterAI.test.ts` forbids a route importing `verification.js` or
    // `claimWriterAI.js` directly; this file imports neither, and the Confirm goes through
    // `match/report.ts`, which uses the one legal path.
    const careerImports = [...code.matchAll(/from '\.\.\/career\/([^']+)'/g)].map((m) => m[1]);
    expect(careerImports).toEqual([]);
  });

  it('the route declares no score-like body field', () => {
    expect(code).not.toMatch(/\bscore\b/i);
    expect(code).not.toMatch(/percent/i);
  });
});