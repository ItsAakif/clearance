// routes/tailor.v2.test.ts - THE V2 TAILORING SURFACE over HTTP (T1080; 06 sec.E.3).
//
// WHAT THIS SUITE PINS, and none of it is duplicated from the service suites:
//   1. THE PROPOSAL STAGE IS AI-OPTIONAL. With no key leaseable the response is 200 with
//      `proposal.status = 'skipped'`, `reason = 'no_ai_provider_configured'` and NO operations
//      - and `POST /tailor/apply` still works end to end for operations supplied by the caller.
//      That is ADR-041 D5 as a behaviour rather than a promise.
//   2. `POST /tailor` NEVER RETURNS A DOCUMENT. Asserted structurally: the body has no
//      `document`, no `basics`, no `work`, and says so itself.
//   3. APPLY CREATES A NEW REVISION AND THE PARENT IS UNCHANGED. The response carries both
//      revisions' ids and hashes, and the mocked `resumeRevision.create` is called once - a
//      second call would be the only way to mutate revision N, since there is no update path.
//   4. ONE `ResumeChange` ROW PER OPERATION, ACCEPTED OR NOT. The refused one comes back with
//      `accepted: false` and its code in the reason, which is 06 sec.E.3's "suggested,
//      declined".
//   5. THE LEGACY `/tailor` ROUTER IS UNTOUCHED. Its paths are asserted to still exist and to
//      still be the V1 shapes - the acceptance item "the legacy /tailor route is unaffected".
//
// Mocks follow `routes/resumes.test.ts`: `vi.hoisted` state, `vi.mock` for `requireAuth`, the
// prisma singleton and the key manager, then the REAL routers.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockUserId, prismaMocks, leaseMock, revisionRows } = vi.hoisted(() => ({
  mockUserId: { value: 'user-1' },
  leaseMock: vi.fn(),
  revisionRows: { rows: [] as Array<Record<string, unknown>> },
  prismaMocks: {
    resume: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    resumeRevision: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    resumeChange: { create: vi.fn(), findMany: vi.fn() },
    resumeClaimUsage: { create: vi.fn(), findMany: vi.fn() },
    careerClaim: { findMany: vi.fn(), findFirst: vi.fn() },
    experience: { findMany: vi.fn() },
    job: { findFirst: vi.fn() },
    tailoredResume: { create: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));
vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));
vi.mock('../ai/keyManager.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, leaseNextLlmKey: leaseMock, markKeySuccess: vi.fn(), markKeyFailure: vi.fn() };
});

import { ClaimStatus, ResumeChangeSource, ResumeUsage } from '@prisma/client';
import tailorRouter, { tailorV2Router } from './tailor.js';
import { X_CLEARANCE_KEY, canonicalJsonHash } from '../resume/json/jsonresume.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/tailor', tailorRouter);
  app.use('/resumes', tailorV2Router);
  return app;
}

const RESUME = { id: 'res-1', userId: 'user-1', modelVersion: 2, profileId: 'profile-1' };

const BULLET = 'Cut CI build time by 40% by caching the dependency layer';
const INFERRED_BULLET = 'Ran the whole platform on Kubernetes';

/**
 * A claim the user has NOT confirmed.
 *
 * It is in the FIXTURE - both in the document's ledger and as a row - rather than added by the
 * test that needs it, because `createRevision` REFRESHES the block's row-derived members from
 * the rows. A row whose status disagreed with the block would therefore not be refused: the
 * block would simply be stored with the ROW's status, and a test that flipped the row to make
 * the operation refuse would be asserting the refresh rather than the refusal. The row and the
 * ledger entry are the same statement here, so nothing moves at write time and
 * `documentChanged` means what it says.
 */
const INFERRED_CLAIM = {
  id: 'clm-2',
  statement: INFERRED_BULLET,
  status: ClaimStatus.inferred,
};

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clm-1',
    profileId: 'profile-1',
    kind: 'achievement',
    statement: BULLET,
    fingerprint: 'a'.repeat(64),
    status: ClaimStatus.user_confirmed,
    provenance: 'document_import',
    confidence: null,
    evidenceSourceId: null,
    experienceId: null,
    educationId: null,
    projectId: null,
    skillId: null,
    certificationId: null,
    achievementId: null,
    createdAt: new Date('2026-09-30T09:00:00.000Z'),
    updatedAt: new Date('2026-09-30T09:00:00.000Z'),
    ...overrides,
  };
}

/** A valid document with one claim-backed bullet, hashed the way the writer would. */
function document() {
  return {
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer' },
    work: [
      {
        name: 'Acme',
        position: 'Staff Engineer',
        startDate: '2020-01',
        highlights: [BULLET, INFERRED_BULLET],
      },
      { name: 'Globex', position: 'Engineer', startDate: '2018-01', endDate: '2019-12' },
    ],
    skills: [{ name: 'Postgres' }],
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 'clearance/resume-json/project@1',
      sourceModelVersion: 2,
      profileId: 'profile-1',
      claimCount: 2,
      confirmedClaimCount: 1,
      unconfirmedClaimCount: 1,
      claims: [
        {
          claimId: 'clm-1',
          fingerprint: 'a'.repeat(64),
          kind: 'achievement',
          status: ClaimStatus.user_confirmed,
          provenance: 'document_import',
          confidence: null,
          evidenceSourceId: null,
          usage: ResumeUsage.verbatim,
          jsonPath: 'work[0].highlights[0]',
          renderedText: BULLET,
        },
        {
          claimId: INFERRED_CLAIM.id,
          fingerprint: 'b'.repeat(64),
          kind: 'achievement',
          status: INFERRED_CLAIM.status,
          provenance: 'llm_inferred',
          confidence: 0.6,
          evidenceSourceId: null,
          usage: ResumeUsage.verbatim,
          jsonPath: 'work[0].highlights[1]',
          renderedText: INFERRED_BULLET,
        },
      ],
    },
  };
}

/** The parent's stored row, with a REAL jsonHash so the belt never trips over tampering. */
function parentRevision() {
  const resumeJson = document();
  return {
    id: 'rev-1',
    resumeId: 'res-1',
    revisionNumber: 1,
    resumeJson,
    jsonHash: canonicalJsonHash(resumeJson),
    enginePins: {},
    createdBy: ResumeChangeSource.user,
    createdByUserId: 'user-1',
    reason: 'projected from the career profile',
    createdAt: new Date('2026-10-03T10:00:00.000Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUserId.value = 'user-1';
  revisionRows.rows.length = 0;
  prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
  prismaMocks.resumeRevision.findFirst.mockResolvedValue(parentRevision());
  prismaMocks.resumeRevision.create.mockImplementation(async ({ data }: any) => ({
    ...data,
    id: 'rev-2',
    revisionNumber: 2,
    jsonHash: canonicalJsonHash(data.resumeJson),
    createdAt: new Date('2026-10-03T11:00:00.000Z'),
  }));
  prismaMocks.resumeChange.create.mockImplementation(async ({ data }: any) => ({ id: 'chg-1', ...data }));
  prismaMocks.resumeChange.findMany.mockResolvedValue([]);
  prismaMocks.resumeClaimUsage.create.mockImplementation(async ({ data }: any) => ({ id: 'usg-1', ...data }));
  prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([]);
  prismaMocks.careerClaim.findMany.mockResolvedValue([
    claimRow(),
    // `provenance` and `confidence` are the ROW's, and they have to match what the
    // document's own ledger says for this claim. `createRevision` REFRESHES the block's
    // row-derived members from the rows before storing them, so a fixture whose row
    // disagrees with its block about provenance is a fixture whose document CHANGES at
    // write time - and the "the declined operation did not move the document" assertion
    // below would then be testing the refresh rather than the decline.
    claimRow({
      id: INFERRED_CLAIM.id,
      statement: INFERRED_CLAIM.statement,
      status: INFERRED_CLAIM.status,
      provenance: 'llm_inferred',
      confidence: 0.6,
    }),
  ]);
  prismaMocks.tailoredResume.findMany.mockResolvedValue([]);
  prismaMocks.experience.findMany.mockResolvedValue([{ company: 'Acme' }, { company: 'Globex' }]);
  prismaMocks.job.findFirst.mockResolvedValue({ id: 'job-1', rawText: 'A backend role.' });
  // NO PROVIDER: the proposal stage must degrade, not fail (ADR-041 D5).
  leaseMock.mockRejectedValue(new Error('No groq API keys configured.'));
});

// ---------------------------------------------------------------------------
// 1. The proposal stage is AI-OPTIONAL and never returns a document
// ---------------------------------------------------------------------------

describe('POST /resumes/:id/tailor: the proposal stage is AI-OPTIONAL and returns OPS ONLY', () => {
  it('reports `skipped` / `no_ai_provider_configured` and NO operations, with a 200', async () => {
    const res = await request(makeApp()).post('/resumes/res-1/tailor').send({});
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ status: 'skipped', reason: 'no_ai_provider_configured' });
    expect(res.body.operations).toEqual([]);
    expect(res.body.baseRevision).toMatchObject({ id: 'rev-1', revisionNumber: 1 });
  });

  it('the response contains NO resume document, and says so', async () => {
    // "The tailoring request never returns a whole rewritten document" (06 sec.E.3). Asserted
    // structurally rather than by reading the route: the body has no document member, and no
    // top-level key that would hold one.
    const res = await request(makeApp()).post('/resumes/res-1/tailor').send({});
    expect(res.body.operationsContainDocument).toBe(false);
    for (const forbidden of ['document', 'basics', 'work', 'skills', 'x-clearance']) {
      expect(res.body, `the proposal response must not carry ${forbidden}`).not.toHaveProperty(forbidden);
    }
  });

  it('a leased key that then FAILS also degrades to `skipped` with a reason, and leaks no message', async () => {
    leaseMock.mockResolvedValue({ id: 'k', apiKey: 'sk-secret', provider: 'groq', source: 'env', userId: null, label: null });
    // The provider seam is what a key implies; making the model lookup throw is the cheapest
    // way to reach the catch without a real network call.
    const groq = await import('../ai/providerModels.js');
    const spy = vi.spyOn(groq, 'getProviderModel').mockRejectedValue(new Error('secret-adjacent detail'));
    const res = await request(makeApp()).post('/resumes/res-1/tailor').send({});
    expect(res.status).toBe(200);
    expect(res.body.proposal.status).toBe('failed');
    expect(res.body.proposal.reason).toMatch(/^proposal_failed:/);
    expect(JSON.stringify(res.body)).not.toContain('secret-adjacent');
    spy.mockRestore();
  });

  it('404s an unknown resume and 403s another tenant\'s', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue(null);
    expect((await request(makeApp()).post('/resumes/nope/tailor').send({})).status).toBe(404);
    prismaMocks.resume.findUnique.mockResolvedValue({ ...RESUME, userId: 'user-2' });
    expect((await request(makeApp()).post('/resumes/res-1/tailor').send({})).status).toBe(403);
  });

  it('404s a LEGACY (modelVersion 1) resume: there is no profile to tailor from', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue({ ...RESUME, modelVersion: 1, profileId: null });
    expect((await request(makeApp()).post('/resumes/res-1/tailor').send({})).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 2. Apply: a new revision, one change row per op, parent untouched
// ---------------------------------------------------------------------------

describe('POST /resumes/:id/tailor/apply: accepted operations become a NEW REVISION', () => {
  const groundedRewrite = {
    op: 'rewrite_bullet',
    target: 'work[0].highlights[0]',
    before: BULLET,
    after: 'Reduced the CI build time by 40% by caching the dependency layer',
    reason: "mirrors the JD's 'build throughput' requirement",
    targetRequirementIds: ['req-1'],
    sourceClaimIds: ['clm-1'],
  };

  it('writes revision N+1, records the op, and leaves the PARENT hash alone', async () => {
    const res = await request(makeApp())
      .post('/resumes/res-1/tailor/apply')
      .send({ operations: [groundedRewrite], baseRevisionId: 'rev-1' });

    expect(res.status).toBe(201);
    expect(res.body.parent).toMatchObject({ id: 'rev-1', revisionNumber: 1 });
    expect(res.body.revision).toMatchObject({ id: 'rev-2', revisionNumber: 2, createdBy: 'tailoring_engine' });
    expect(res.body.revision.jsonHash).not.toBe(res.body.parent.jsonHash);
    expect(res.body.summary).toMatchObject({ acceptedCount: 1, declinedCount: 0, changeCount: 1 });

    // EXACTLY ONE revision write. There is no update path in this repository, so a second
    // `resumeRevision.create` would be the only way revision 1 could change.
    expect(prismaMocks.resumeRevision.create).toHaveBeenCalledTimes(1);
    const written = prismaMocks.resumeRevision.create.mock.calls[0][0].data;
    expect(written.revisionNumber).toBe(2);
    expect(written.createdBy).toBe(ResumeChangeSource.tailoring_engine);
    expect(written.resumeJson.work[0].highlights[0]).toBe(
      'Reduced the CI build time by 40% by caching the dependency layer',
    );
    // The ledger moved with the text - or the write would have been refused by the belt.
    expect(written.resumeJson[X_CLEARANCE_KEY].claims[0]).toMatchObject({
      claimId: 'clm-1',
      usage: 'tailored',
      jsonPath: 'work[0].highlights[0]',
      renderedText: 'Reduced the CI build time by 40% by caching the dependency layer',
    });
    expect(prismaMocks.resumeChange.create).toHaveBeenCalledTimes(1);
    expect(prismaMocks.resumeChange.create.mock.calls[0][0].data).toMatchObject({
      op: 'rewrite_bullet',
      jsonPath: 'work[0].highlights[0]',
      accepted: true,
      appliedBy: ResumeChangeSource.tailoring_engine,
      sourceClaimIds: ['clm-1'],
      targetRequirementIds: ['req-1'],
    });
  });

  it('AN UNCONFIRMED source claim is REFUSED with its code, and the document does not move', async () => {
    // The op rewrites the bullet the UNCONFIRMED claim placed, and names it as its own source.
    // The claim exists and is in the profile - so `SOURCE_CLAIM_NOT_FOUND` cannot be the
    // answer - and it is `inferred`, so it can never ground new wording (ADR-036 item 5).
    const res = await request(makeApp())
      .post('/resumes/res-1/tailor/apply')
      .send({
        operations: [
          {
            op: 'rewrite_bullet',
            target: 'work[0].highlights[1]',
            before: INFERRED_BULLET,
            after: 'Ran the whole platform on Kubernetes clusters',
            sourceClaimIds: [INFERRED_CLAIM.id],
          },
        ],
      });

    // The revision is still created - the operation is RECORDED, not applied, and 06 sec.E.3
    // wants the declined proposal visible. Its document is byte-identical to the parent's.
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ acceptedCount: 0, declinedCount: 1, documentChanged: false });
    const written = prismaMocks.resumeRevision.create.mock.calls[0][0].data;
    expect(written.resumeJson.work[0].highlights[1]).toBe(INFERRED_BULLET);
    expect(prismaMocks.resumeChange.create.mock.calls[0][0].data.accepted).toBe(false);
    expect(String(prismaMocks.resumeChange.create.mock.calls[0][0].data.reason)).toContain(
      'SOURCE_CLAIM_NOT_CONFIRMED',
    );
  });

  it('A NEW METRIC is BLOCKED by the fact-delta guard, with its code and the facts named', async () => {
    const res = await request(makeApp())
      .post('/resumes/res-1/tailor/apply')
      .send({
        operations: [{ ...groundedRewrite, after: 'Cut the CI build time by 40% and scaled to 12000 accounts' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ acceptedCount: 0, declinedCount: 1 });
    const change = prismaMocks.resumeChange.create.mock.calls[0][0].data;
    expect(String(change.reason)).toContain('FACT_DELTA');
    expect(String(change.reason)).toContain('metric:12000');
  });

  it('A MISSING sourceClaimId is refused with its own code', async () => {
    await request(makeApp())
      .post('/resumes/res-1/tailor/apply')
      .send({ operations: [{ ...groundedRewrite, sourceClaimIds: ['clm-nope'] }] });
    expect(String(prismaMocks.resumeChange.create.mock.calls[0][0].data.reason)).toContain(
      'SOURCE_CLAIM_NOT_FOUND',
    );
  });

  it('an operation that is not an operation at all gets NO change row and is reported instead', async () => {
    // `ResumeChange.op` is a non-null enum, so recording a declined `rewrite_bullet` for an
    // input that was not one would put a lie in the audit log to satisfy a column.
    const res = await request(makeApp())
      .post('/resumes/res-1/tailor/apply')
      .send({ operations: [{ op: 'make_it_better', target: 'work[0]' }, groundedRewrite] });
    expect(res.status).toBe(201);
    expect(res.body.unparsable).toHaveLength(1);
    expect(res.body.unparsable[0].rejection.code).toBe('OP_UNKNOWN');
    expect(prismaMocks.resumeChange.create).toHaveBeenCalledTimes(1);
  });

  it('a STALE baseRevisionId is a 409 with the current revision, and writes nothing', async () => {
    const res = await request(makeApp())
      .post('/resumes/res-1/tailor/apply')
      .send({ operations: [groundedRewrite], baseRevisionId: 'rev-0' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('tailor_base_revision_stale');
    expect(res.body.baseRevision.id).toBe('rev-1');
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('refuses to empty a section the template REQUIRES, and records the refusal', async () => {
    // `typst-ats-classic` requires `experience`; the fixture's `work` has TWO entries, so the
    // first is fine and the pair is what makes `exclude` meaningful. Emptying it needs the
    // document to hold one.
    const single = document();
    single.work = [single.work[0]];
    const singleRevision = { ...parentRevision(), resumeJson: single, jsonHash: canonicalJsonHash(single) };
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(singleRevision);

    const res = await request(makeApp())
      .post('/resumes/res-1/tailor/apply')
      .send({ operations: [{ op: 'exclude', target: 'work[0]' }] });
    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ acceptedCount: 0, declinedCount: 1 });
    expect(String(prismaMocks.resumeChange.create.mock.calls[0][0].data.reason)).toContain(
      'SECTION_REQUIRED_BY_TEMPLATE',
    );
  });

  it('404s a resume with no revisions and 403s another tenant\'s - before any write', async () => {
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(null);
    expect((await request(makeApp()).post('/resumes/res-1/tailor/apply').send({ operations: [] })).status).toBe(404);
    prismaMocks.resume.findUnique.mockResolvedValue({ ...RESUME, userId: 'user-2' });
    expect(
      (await request(makeApp()).post('/resumes/res-1/tailor/apply').send({ operations: [] })).status,
    ).toBe(403);
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown body member rather than ignoring it', async () => {
    expect(
      (await request(makeApp()).post('/resumes/res-1/tailor/apply').send({ operations: [], nope: 1 })).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 3. The change log the diff view reads
// ---------------------------------------------------------------------------

describe('GET /resumes/:id/tailor/changes: the diff view shows before/after/reason/SOURCE CLAIMS', () => {
  it('resolves the claim STATEMENTS, not just their ids', async () => {
    prismaMocks.resumeChange.findMany.mockResolvedValue([
      {
        id: 'chg-1',
        revisionId: 'rev-2',
        op: 'rewrite_bullet',
        jsonPath: 'work[0].highlights[0]',
        before: BULLET,
        after: 'Reduced the CI build time by 40% by caching the dependency layer',
        reason: "mirrors the JD's 'build throughput' requirement",
        targetRequirementIds: ['req-1'],
        sourceClaimIds: ['clm-1'],
        appliedBy: ResumeChangeSource.tailoring_engine,
        accepted: true,
        createdAt: new Date('2026-10-03T11:00:00.000Z'),
      },
    ]);
    const res = await request(makeApp()).get('/resumes/res-1/tailor/changes');
    expect(res.status).toBe(200);
    expect(res.body.changes[0]).toMatchObject({
      op: 'rewrite_bullet',
      jsonPath: 'work[0].highlights[0]',
      before: BULLET,
      reason: "mirrors the JD's 'build throughput' requirement",
      accepted: true,
      sourceClaimIds: ['clm-1'],
    });
    // THE PART THAT MAKES IT REVIEWABLE: the statement, so a person can check it.
    expect(res.body.changes[0].sourceClaims[0]).toMatchObject({
      id: 'clm-1',
      status: ClaimStatus.user_confirmed,
      statement: BULLET,
    });
  });

  it('returns the DECLINED rows too, so "suggested, declined" stays visible', async () => {
    prismaMocks.resumeChange.findMany.mockResolvedValue([
      {
        id: 'chg-1',
        revisionId: 'rev-2',
        op: 'rewrite_bullet',
        jsonPath: 'work[0].highlights[0]',
        before: BULLET,
        after: null,
        reason: 'FACT_DELTA: the proposed wording introduces a fact',
        targetRequirementIds: [],
        sourceClaimIds: [],
        appliedBy: ResumeChangeSource.tailoring_engine,
        accepted: false,
        createdAt: new Date('2026-10-03T11:00:00.000Z'),
      },
    ]);
    const res = await request(makeApp()).get('/resumes/res-1/tailor/changes');
    expect(res.body.changes[0]).toMatchObject({ accepted: false, after: null });
    expect(res.body.changes[0].reason).toContain('FACT_DELTA');
  });

  it('accepts `?revision=N` and 404s an unknown one', async () => {
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(null);
    expect((await request(makeApp()).get('/resumes/res-1/tailor/changes?revision=9')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 4. The frozen V1 surface is untouched
// ---------------------------------------------------------------------------

// T1110 REWROTE the first two cases of this block. They pinned the V1 whole-document tailor's
// LIVE behaviour - `POST /tailor` reaching the V1 envelope schema, `GET /tailor` listing
// `TailoredResume` rows - which is exactly what FREEZE A-39 retires. `routes/tailor.retired.test.ts`
// now owns the 410 contract for all four paths; what stays HERE is what is still true of this file:
// the two routers are still separate objects with disjoint paths, and retiring the V1 half did not
// touch the V2 surface this whole file exists to test.
describe('the LEGACY /tailor router is retired; the V2 one is untouched', () => {
  it('all four published V1 paths are gone and answer 410 with the successor', async () => {
    // Duplicated from `tailor.retired.test.ts` ON PURPOSE, and only for the two paths this file's
    // own mock graph can reach: this file proves the V2 router still works in the SAME module, so
    // it must also prove the module's other router is a deprecation rather than a survivor.
    for (const [method, path] of [
      ['post', '/tailor'],
      ['get', '/tailor'],
      ['post', '/tailor/pipeline'],
      ['get', '/tailor/anything/export'],
    ] as const) {
      const res = await request(makeApp())[method](path).send({});
      expect([path, res.status]).toEqual([path, 410]);
      expect([path, res.body.code]).toEqual([path, 'legacy_whole_document_tailor_retired']);
    }
    // No lease, on any of them: a retirement that still cost a provider key would not be one.
    expect(leaseMock).not.toHaveBeenCalled();
  });

  it('the two routers have DISJOINT paths, which is why no flag is needed', () => {
    // Structural, so it cannot rot: the V1 router's paths all start with `/` or `/:id/`, and
    // the V2 router's are all `/:id/tailor*`.
    const v1 = (tailorRouter as unknown as { stack: Array<{ route?: { path: string } }> }).stack
      .map((layer) => layer.route?.path)
      .filter((path): path is string => typeof path === 'string');
    const v2 = (tailorV2Router as unknown as { stack: Array<{ route?: { path: string } }> }).stack
      .map((layer) => layer.route?.path)
      .filter((path): path is string => typeof path === 'string');
    // The V1 side is still a REGISTERED router - four declarations, four deprecations - rather
    // than a router that vanished, which is what makes "410 rather than 404" a contract.
    expect(v1.length).toBe(4);
    expect(v2.length).toBeGreaterThan(0);
    for (const path of v2) expect(v1).not.toContain(path);
    expect(v2.every((path) => path.includes('/tailor'))).toBe(true);
  });
});