// =====================================================================================
// routes/project-discovery.test.ts - the HTTP surface of the TWO-DAY PROJECT ENGINE (T1100;
// 06 sec. E.5, sec. E.10's route table).
//
// NOT A DUPLICATE OF THE SERVICE SUITES. `projects/lifecycle.test.ts` proves the decisions and
// the gap selection; this proves what a CLIENT can observe, and four things only the ROUTE can
// be responsible for:
//
//   1. AUTH AND MOUNTING. Every route is behind `requireAuth` - proven through an
//      unauthenticated 401 and by a source guard - and the router is mounted ONCE, on its own
//      prefix, so none of it is reachable through the `/jobs` or `/matches` mounts.
//   2. THE ENVELOPE IS VALIDATED. `.strict()` proven through `score: true` (the exact request a
//      caller reaching for a verdict sends) and through a misspelled member. `complete` and
//      `accept` take an EMPTY body, and that emptiness is the guarantee: there is no member
//      through which a client could name a claim status, a provenance or a `verifiedClaimId`.
//   3. THE STATUS CODES ARE THE HONEST ONES. 201 on a run that creates rows, 200 on an
//      idempotent repeat that creates nothing, 409 for an illegal transition, 404 for a foreign
//      id - never a 403, because this surface names a person's career gaps.
//   4. NOTHING AUTO-CONFIRMS, OVER HTTP. The lifecycle is driven through real requests and the
//      claims table is inspected between them: `complete`'s response carries a null claim and
//      `awaitingYourConfirmation: true`, and only `confirm` returns one.
//
// The prisma singleton is mocked with in-memory tables; `../projects/lifecycle.js` is NOT
// mocked, so this suite exercises the shipped services through real HTTP.
// =====================================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ClaimStatus } from '@prisma/client';

type Row = Record<string, unknown>;

const ROUTE_FILE = path.join(__dirname, 'matches.ts');
const ROUTE_SOURCE = readFileSync(ROUTE_FILE, 'utf8');
const INDEX_FILE = path.join(__dirname, 'index.ts');
const INDEX_SOURCE = readFileSync(INDEX_FILE, 'utf8');
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
    projectOpportunities: [] as Row[],
    projectReferences: [] as Row[],
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
    findMany: vi.fn(async ({ where, orderBy }: { where?: Row; orderBy?: unknown } = {}) => {
      const filtered = rows.filter((r) => matches(r, where));
      if (orderBy === undefined) return filtered;
      // One level of sort key is all this surface uses, and `asc` is all it asks for.
      const [[field, direction]] = Object.entries(orderBy as Row);
      const sign = String(direction).toLowerCase() === 'desc' ? -1 : 1;
      return [...filtered].sort((a, b) => sign * String(a[field] ?? '').localeCompare(String(b[field] ?? '')));
    }),
    create: vi.fn(async ({ data }: { data: Row }) => {
      t.writes.push(`${model}.create`);
      const row = {
        id: `${model}-${rows.length + 1}`,
        createdAt: new Date('2026-10-06T09:00:00.000Z'),
        updatedAt: new Date('2026-10-06T09:00:00.000Z'),
        completedAt: null,
        verifiedClaimId: null,
        retrievedAt: new Date('2026-10-06T09:00:00.000Z'),
        ...data,
      };
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
  });

  const models = {
    job: delegate(t.jobs, 'job'),
    jobRequirement: delegate(t.jobRequirements, 'req'),
    careerProfile: delegate(t.careerProfiles, 'prof'),
    careerClaim: delegate(t.careerClaims, 'clm'),
    claimVerification: delegate(t.claimVerifications, 'ver'),
    matchReport: delegate(t.matchReports, 'mr'),
    potentialMatch: delegate(t.potentialMatches, 'pm'),
    projectOpportunity: delegate(t.projectOpportunities, 'opp'),
    projectReference: delegate(t.projectReferences, 'ref'),
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

import { projectDiscoveryRouter } from './matches.js';

// ---------------------------------------------------------------------------
// The app, mounted exactly as routes/index.ts mounts it
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/project-discovery', projectDiscoveryRouter);
  return app;
}

const app = makeApp();

function seed() {
  tables.jobs.length = 0;
  tables.jobRequirements.length = 0;
  tables.careerProfiles.length = 0;
  tables.careerClaims.length = 0;
  tables.claimVerifications.length = 0;
  tables.matchReports.length = 0;
  tables.potentialMatches.length = 0;
  tables.projectOpportunities.length = 0;
  tables.projectReferences.length = 0;
  tables.writes.length = 0;
  mockUserId.value = 'user-1';

  tables.careerProfiles.push({ id: 'prof-1', userId: USER });
  tables.jobs.push({ id: 'job-1', userId: USER, title: 'Platform Engineer', rawText: 'Kubernetes Kafka' });
  tables.jobRequirements.push(
    {
      id: 'req-k8s',
      jobId: 'job-1',
      kind: 'required_skill',
      importance: 'must',
      text: 'Kubernetes',
      normalizedKey: 'kubernetes',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    },
    {
      id: 'req-years',
      jobId: 'job-1',
      kind: 'years_experience',
      importance: 'must',
      text: '7+ years of distributed systems',
      normalizedKey: '7 years of distributed systems',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    },
  );
}

beforeEach(seed);

// ---------------------------------------------------------------------------
// 1. Auth and mounting
// ---------------------------------------------------------------------------

describe('every route is behind requireAuth, and the router is mounted once', () => {
  const paths = [
    ['POST', '/'],
    ['POST', '/:id/accept'],
    ['POST', '/:id/complete'],
    ['POST', '/:id/confirm'],
  ];

  for (const [method, routePath] of paths) {
    it(`${method} ${routePath} answers 401 without a session`, async () => {
      mockUserId.value = null;
      // `.post` directly rather than a computed `[method]`: every entry in `paths` is a POST, and a
      // `[` at the start of a continuation line is a `no-unexpected-multiline` hazard. `method`
      // still carries the verb for the test NAME below, which stays accurate.
      const response = await request(app)
        .post(`/project-discovery${routePath.replace('/:id/', '/opp-1/')}`)
        .send({});
      expect([routePath, response.status]).toEqual([routePath, 401]);
    });

    it(`${method} ${routePath} declares requireAuth in the source`, () => {
      // The 401 above proves the middleware runs; this proves it is the AUTH middleware and not
      // a handler that happens to 401.
      expect(ROUTE_SOURCE).toContain(`projectDiscoveryRouter.${method.toLowerCase()}('${routePath}', requireAuth`);
    });
  }

  it('the router is mounted ONCE, on its own prefix, and nowhere else', () => {
    expect([...INDEX_SOURCE.matchAll(/router\.use\('([^']+)', ([A-Za-z]+)\)/g)].filter(
      (match) => match[2] === 'projectDiscoveryRouter',
    ).map((match) => match[1])).toEqual(['/project-discovery']);
    // Deliberately NOT mounted at `/jobs` or `/matches`: both prefixes carry a one-segment
    // catch-all, and this router would add nothing at either.
    expect(INDEX_SOURCE).not.toMatch(/router\.use\('\/jobs', projectDiscoveryRouter\)/);
    expect(INDEX_SOURCE).not.toMatch(/router\.use\('\/matches', projectDiscoveryRouter\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. The envelope
// ---------------------------------------------------------------------------

describe('the envelope is validated, not assumed', () => {
  it('a caller reaching for a verdict gets a 400, not a silently ignored field', async () => {
    const response = await request(app)
      .post('/project-discovery')
      .send({ jobId: 'job-1', score: true });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/score/);
  });

  it('a misspelled member is a 400 too', async () => {
    const response = await request(app).post('/project-discovery').send({ jobIdb: 'job-1' });
    expect(response.status).toBe(400);
  });

  it('naming neither a job nor a report is a 400, and names what is missing', async () => {
    const response = await request(app).post('/project-discovery').send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/matchReportId or a jobId/);
  });

  it('`accept` and `complete` take an EMPTY body, which is the guarantee', async () => {
    // There is no member through which a client could name a claim status, a provenance, a
    // claim kind or a `verifiedClaimId` - so `complete` has nothing it could write besides
    // `completedAt`. A member here is a 400, not a new capability.
    const forOpportunity = async (suffix: string, body: Row): Promise<number> =>
      (await request(app).post(`/project-discovery/opp-1/${suffix}`).send(body)).status;
    for (const suffix of ['accept', 'complete']) {
      expect([suffix, await forOpportunity(suffix, {})]).toEqual([suffix, 404]);
      expect([suffix, await forOpportunity(suffix, { verifiedClaimId: 'clm-1' })]).toEqual([suffix, 400]);
      expect([suffix, await forOpportunity(suffix, { status: 'user_confirmed' })]).toEqual([suffix, 400]);
    }
  });

  it('`confirm` takes only the user\'s own words, never a state', async () => {
    const response = await request(app)
      .post('/project-discovery/opp-1/confirm')
      .send({ statement: 'Built it', status: 'user_confirmed', claimKind: 'project' });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. The whole lifecycle, over HTTP
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 4 over HTTP: accept -> complete -> confirm, and nothing before the confirm', () => {
  async function discover(): Promise<Record<string, unknown>> {
    const response = await request(app)
      .post('/project-discovery')
      .send({ jobId: 'job-1', research: false, runProvider: false });
    expect(response.status).toBe(201);
    return response.body;
  }

  it('discovery is a 201 that names the gaps it selected and the ones it refused', async () => {
    const body = await discover();
    expect(body.counts).toEqual({ considered: 2, selected: 1, excluded: 1, candidates: 1 });
    expect((body.candidates as Row[]).map((row) => (row.requirementIds as string[])[0])).toEqual(['req-k8s']);
    // The non-teachable requirement is reported as refused, with the reason - never silently
    // dropped and never turned into a candidate.
    expect((body.excludedGaps as Row[]).map((row) => [row.requirementId, row.reason])).toEqual([
      ['req-years', 'non_teachable_kind'],
    ]);
    expect(body.notes).toMatch(/named gaps/);
    expect(body.rule).toMatch(/never adds anything to your profile/);
    // Both optional stages reported their skip, because both were declined.
    expect(body.researchStage).toMatchObject({ status: 'skipped', reason: 'not_requested' });
    expect(body.proposalStage).toMatchObject({ status: 'skipped', reason: 'not_evaluated' });
    // Nothing was written about the user by the run.
    expect(tables.careerClaims).toEqual([]);
    expect(tables.claimVerifications).toEqual([]);
  });

  it('accept -> complete -> confirm, with the claims table inspected between every step', async () => {
    const discovered = await discover();
    const id = (discovered.candidates as Row[])[0].id as string;

    // --- accept ---------------------------------------------------------
    const accepted = await request(app).post(`/project-discovery/${id}/accept`).send({});
    expect([accepted.status, accepted.body.changed, accepted.body.opportunity.status]).toEqual([
      200,
      true,
      'accepted',
    ]);
    expect(accepted.body.claim).toBeNull();

    // --- complete: THE route that must not write a claim -----------------
    const completed = await request(app).post(`/project-discovery/${id}/complete`).send({});
    expect([
      completed.status,
      completed.body.changed,
      completed.body.opportunity.status,
      completed.body.opportunity.awaitingYourConfirmation,
      completed.body.opportunity.verifiedClaimId,
      completed.body.claim,
      completed.body.claimVerification,
    ]).toEqual([200, true, 'completed', true, null, null, null]);
    // Proven by the TABLE, not by the response shape.
    expect(tables.careerClaims).toEqual([]);
    expect(tables.claimVerifications).toEqual([]);

    // --- an idempotent repeat creates nothing ----------------------------
    const again = await request(app).post(`/project-discovery/${id}/complete`).send({});
    expect([again.status, again.body.changed]).toEqual([200, false]);
    expect(tables.careerClaims).toEqual([]);

    // --- confirm: the ONLY writer of a claim -----------------------------
    const confirmed = await request(app)
      .post(`/project-discovery/${id}/confirm`)
      .send({ statement: 'Built a Kubernetes manifest linter' });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.claim).toMatchObject({
      kind: 'project',
      statement: 'Built a Kubernetes manifest linter',
      status: ClaimStatus.user_confirmed,
    });
    expect(confirmed.body.claimVerification).toMatchObject({
      action: 'confirm',
      targetType: 'career_claim',
    });
    expect(confirmed.body.opportunity.verifiedClaimId).toBe(confirmed.body.claim.id);
    expect(confirmed.body.opportunity.awaitingYourConfirmation).toBe(false);

    // One claim, one `career_claim` audit row, and the opportunity's own audit row.
    expect(tables.careerClaims).toHaveLength(1);
    expect(tables.careerClaims[0].provenance).toBe('user_entered');
    expect(
      tables.claimVerifications.map((row) => row.targetType).sort(),
    ).toEqual(['career_claim', 'job_requirement_match']);

    // A second confirm is a 200 that creates nothing.
    const repeat = await request(app).post(`/project-discovery/${id}/confirm`).send({});
    expect([repeat.status, repeat.body.changed]).toEqual([200, false]);
    expect(tables.careerClaims).toHaveLength(1);
    expect(tables.claimVerifications).toHaveLength(2);
  });

  it('an illegal transition is a 409 that names the state', async () => {
    const discovered = await discover();
    const id = (discovered.candidates as Row[])[0].id as string;

    // Completing a plan the user never accepted.
    const early = await request(app).post(`/project-discovery/${id}/complete`).send({});
    expect([early.status, early.body.error]).toEqual([409, expect.stringContaining('proposed')]);
    expect(tables.careerClaims).toEqual([]);

    // Confirming a plan that was never completed.
    const premature = await request(app).post(`/project-discovery/${id}/confirm`).send({});
    expect([premature.status, premature.body.error]).toEqual([409, expect.stringContaining('not complete')]);
    expect(tables.careerClaims).toEqual([]);
    expect(tables.claimVerifications).toEqual([]);
  });

  it('a foreign id is a 404 on every decision, never a 403', async () => {
    for (const suffix of ['accept', 'complete', 'confirm']) {
      const response = await request(app)
        .post(`/project-discovery/opportunity-does-not-exist/${suffix}`)
        .send({});
      expect([suffix, response.status]).toEqual([suffix, 404]);
    }
    // ...and a job owned by somebody else is a 404 as well.
    tables.jobs.push({ id: 'job-2', userId: 'someone-else', rawText: 'Kubernetes' });
    const response = await request(app).post('/project-discovery').send({ jobId: 'job-2' });
    expect(response.status).toBe(404);
    expect(tables.projectOpportunities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The route file's own vocabulary
// ---------------------------------------------------------------------------

describe('the project section of the route file names no verdict', () => {
  it('the four routes and their schemas are declared, and the section carries no score', () => {
    const section = ROUTE_SOURCE.slice(ROUTE_SOURCE.indexOf('T1100 - THE TWO-DAY PROJECT ENGINE'));
    // Comments stripped: this section DISCUSSES the bans, so prose cannot be what passes.
    const code = section
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const banned of ['score', 'percentage', 'ratio', 'matchScore', 'overallScore']) {
      expect([banned, code.includes(banned)]).toEqual([banned, false]);
    }
    for (const schema of ['discoverySchema', 'lifecycleSchema', 'projectConfirmSchema']) {
      expect(section).toContain(schema);
    }
    // The lifecycle body really is empty: no member exists to carry a state.
    expect(section).toContain('const lifecycleSchema = z.object({}).strict();');
  });

  it('the response body of a real run carries no verdict member', async () => {
    seed();
    const response = await request(app)
      .post('/project-discovery')
      .send({ jobId: 'job-1', research: false, runProvider: false });
    expect(response.status).toBe(201);
    const offenders: string[] = [];
    const walk = (value: unknown, at: string): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, `${at}[${index}]`));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const key of Object.keys(value as Row)) {
        if (['score', 'rating', 'grade', 'percentage', 'ratio', 'ratings'].includes(key.toLowerCase())) {
          offenders.push(`${at}.${key}`);
        }
        walk((value as Row)[key], `${at}.${key}`);
      }
    };
    walk(response.body, 'body');
    expect(offenders).toEqual([]);
    // NON-VACUITY: the four named counts are still there.
    expect(response.body.counts).toEqual({ considered: 2, selected: 1, excluded: 1, candidates: 1 });
  });
});