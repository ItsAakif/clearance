// routes/resumes.test.ts - the HTTP surface of the resume derivation layer (T1030).
//
// WHAT IS PROVEN HERE, and WHY IT IS NOT A DUPLICATE OF THE SERVICE SUITES:
//   1. THE GATE IS A ROUTE GUARD AND IT RUNS FIRST. `POST /:id/render` installs
//      `preRenderGuard` as express middleware, so the gate executes before the handler
//      body. The proof is a RENDER PORT that records every call: on a blocked revision
//      the record is EMPTY, so the render was never reached - not "it threw afterwards".
//      That is the same style of ordering evidence `render/stage.test.ts` uses for its
//      lstat-before-open guards, and it is the acceptance item.
//   2. THE REFUSAL IS MACHINE-READABLE over HTTP: 409 with `code` and `reason`, not a
//      generic 500. A client has to be able to tell "confirm these claims" from "your
//      request was malformed", and it can only do that if the two are different codes.
//   3. OWNERSHIP AND 404/403, per the repo convention (cf. `routes/applications.test.ts`):
//      every user-owned route calls `ensureOwnership` before it reads or writes.
//   4. THE IMPORT NEVER CONFIRMS. `POST /career/import/json` with a document whose
//      `x-clearance` block claims every claim is confirmed still writes ONLY inferred
//      rows and NO ClaimVerification row (ADR-036 item 2 / 05 sec.7.7).
//   5. VALIDATION BEFORE ANY WRITE, so a malformed document cannot half-import.
//
// Mocks follow `routes/applications.test.ts` exactly: `vi.hoisted` for shared state,
// `vi.mock` for `requireAuth` and the prisma singleton, then the real router.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockUserId, prismaMocks, resumeRows } = vi.hoisted(() => ({
  mockUserId: { value: 'user-1' },
  // F4: the rows `Resume` inserts actually PUT, so "no orphan row" is an assertion about
  // state rather than about call counts. Emptied in `beforeEach`.
  resumeRows: { rows: [] as Array<Record<string, unknown>> },
  prismaMocks: {
    // F4: the resume + first-revision writes are ONE `$transaction`. The mock runs the
    // callback and ROLLS BACK the row list on a rejection, which is the property the real
    // database gives the route for free and the property the orphan-row test is about.
    $transaction: vi.fn(),
    // T1110: `update` and `careerProfile.create` were added for the upgrade-on-open route
    // (`POST /:id/upgrade`), which promotes a V1 row to `modelVersion: 2` in the same
    // transaction as its first revision, and creates a `CareerProfile` when the user has none.
    resume: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    resumeRevision: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    resumeChange: { create: vi.fn(), findMany: vi.fn() },
    resumeClaimUsage: { create: vi.fn(), findMany: vi.fn() },
    careerClaim: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    careerProfile: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    experience: { findMany: vi.fn() },
    education: { findMany: vi.fn() },
    project: { findMany: vi.fn() },
    skill: { findMany: vi.fn() },
    certification: { findMany: vi.fn() },
    evidenceSource: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    claimVerification: { create: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

import { ClaimStatus, ResumeUsage } from '@prisma/client';
import resumesRouter, { careerRouter, setResumeRenderPort, type RenderResult } from './resumes.js';
import { X_CLEARANCE_KEY, canonicalJsonHash } from '../resume/json/jsonresume.js';
import { ResumeRevisionError } from '../resume/revisions.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// The resume router is mounted at the ROOT, as `routes/applications.test.ts` mounts
// its own (`app.use('/', router)`), so the paths below are exactly the paths the module
// declares. In production `routes/index.ts` mounts it at `/resumes` ALONGSIDE the
// frozen legacy builder router, which is a registration question and not a behaviour
// this suite is about; mounting both routers here keeps the two prefixes disjoint so a
// path typo cannot be mistaken for a routing decision.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', resumesRouter);
  app.use('/career', careerRouter);
  return app;
}

const RESUME = { id: 'res-1', userId: 'user-1', modelVersion: 2, profileId: 'profile-1' };

/**
 * A well-formed Resume JSON document with a valid clearance block.
 *
 * The block's `claims` member is TYPED LOOSELY (`status` is a plain string rather than the
 * `ClaimStatus` enum) on purpose: two of the tests below write a document whose block
 * states a status its row does not hold, which is the whole point of the refresh. With the
 * enum type the fixture's `status` would be narrowed to the literal and the assignment
 * would be a compile error - which would push the fixture towards a cast and away from
 * saying what it means.
 */
function validDocument() {
  return {
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer' },
    work: [{ name: 'Acme', position: 'Staff Engineer', startDate: '2020-01', highlights: ['Cut CI build time by 40%'] }],
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 'test',
      sourceModelVersion: 2,
      profileId: 'profile-1',
      claimCount: 1,
      confirmedClaimCount: 1,
      unconfirmedClaimCount: 0,
      claims: [
        {
          claimId: 'clm-1',
          fingerprint: 'a'.repeat(64),
          kind: 'achievement',
          status: ClaimStatus.user_confirmed as string,
          provenance: 'llm_inferred' as string,
          confidence: 0.9,
          evidenceSourceId: null,
          usage: ResumeUsage.verbatim,
          jsonPath: 'work[0].highlights[0]',
          renderedText: 'Cut CI build time by 40%',
        },
      ],
    },
  };
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clm-1',
    profileId: 'profile-1',
    kind: 'achievement',
    statement: 'Cut CI build time by 40%',
    fingerprint: 'a'.repeat(64),
    status: ClaimStatus.user_confirmed,
    provenance: 'llm_inferred',
    confidence: 0.9,
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

/**
 * The profile's SUMMARY claim (T1080, ADR-043 R-SUMMARY).
 *
 * `kind: 'soft_skill'` and UNATTACHED is the whole selection rule
 * (`loadProjectionInput#isSummaryClaim`), and `id: 'clm-summary'` sorts AFTER `clm-1`
 * because the `x-clearance` block is ordered by `claimId` - so `claims[0]` in the
 * from-profile tests is still the work highlight, and no assertion below had to move.
 */
function summaryClaimRow(overrides: Record<string, unknown> = {}) {
  return claimRow({
    id: 'clm-summary',
    kind: 'soft_skill',
    statement: 'Builds things.',
    ...overrides,
  });
}

function revisionRow(overrides: Record<string, unknown> = {}) {
  // F8: the `jsonHash` is the REAL hash of the document, because the render guard now
  // refuses a revision whose stored bytes no longer hash to what was recorded. A fake
  // `a`.repeat(64) would make every render test fail for the wrong reason, so the fixture
  // computes it - which is also a stronger test, since a mismatch is now detectable here.
  const resumeJson = (overrides.resumeJson ?? validDocument()) as Record<string, unknown>;
  return {
    id: 'rev-1',
    resumeId: 'res-1',
    revisionNumber: 1,
    resumeJson,
    jsonHash: canonicalJsonHash(resumeJson),
    enginePins: {},
    createdBy: 'user',
    createdByUserId: 'user-1',
    reason: null,
    createdAt: new Date('2026-09-30T12:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Set the usage rows the gate will read, plus the claim rows carrying their status.
 *
 * The rows are built from the revision's DOCUMENT (`x-clearance.claims`) by default, so
 * the log always describes the document - which is what the write path now guarantees
 * and what the read-time guard enforces. `extra` adds a row the document does not
 * declare, for the mismatch test.
 */
function usage(
  usages: Array<{ claimId: string; usage: ResumeUsage }>,
  claims: unknown[],
  extra: Array<{ claimId: string; usage: ResumeUsage }> = [],
) {
  prismaMocks.resumeClaimUsage.findMany.mockResolvedValue(
    [...usages, ...extra].map((entry, index) => ({
      id: `usg-${index}`,
      revisionId: 'rev-1',
      claimId: entry.claimId,
      usage: entry.usage,
      renderedText: entry.usage === 'omitted' ? null : 'text',
      createdAt: new Date('2026-09-30T12:00:00.000Z'),
    })),
  );
  prismaMocks.careerClaim.findMany.mockResolvedValue(claims);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUserId.value = 'user-1';
  resumeRows.rows.length = 0;
  // F4: the transaction runs the callback with the same delegates and restores the row list
  // if it throws - the atomicity the route now depends on, expressed as the mock.
  prismaMocks.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
    const snapshot = resumeRows.rows.length;
    try {
      return await run(prismaMocks);
    } catch (error) {
      resumeRows.rows.length = snapshot;
      throw error;
    }
  });
  prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
  prismaMocks.resumeRevision.findFirst.mockResolvedValue(null);
  prismaMocks.resumeRevision.findMany.mockResolvedValue([]);
  prismaMocks.resumeRevision.create.mockImplementation(async ({ data }: any) => revisionRow(data));
  prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([]);
  prismaMocks.careerClaim.findMany.mockResolvedValue([]);
  prismaMocks.careerProfile.findUnique.mockResolvedValue({ id: 'profile-1', userId: 'user-1' });
  prismaMocks.evidenceSource.create.mockImplementation(async ({ data }: any) => ({ id: 'evd-1', ...data }));
  setResumeRenderPort(null);
});

afterEach(() => setResumeRenderPort(null));

// ---------------------------------------------------------------------------
// POST /resumes/from-profile - the V2 data path (T1050's enabler)
// ---------------------------------------------------------------------------
//
// WHAT THIS BLOCK PINS. Before this route there was NO way to create a `modelVersion = 2`
// Resume: the legacy `routes/resume.ts` creates `modelVersion = 1` rows, and every V2 read
// path in the router keys on `modelVersion`/`profileId`. So the Studio had nothing to open.
// The tests below assert the two writes it makes, and - more importantly - that it is NOT a
// shortcut around the invariants: the document goes through the SAME `createRevision` the
// editor's autosave uses, and creating a resume confirms nothing.

/** An experience row the projector will place, with one confirmed claim attached to it. */
function v2Experience(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    profileId: 'profile-1',
    company: 'Acme',
    title: 'Staff Engineer',
    location: 'Berlin, Germany',
    startDate: '2020-01',
    endDate: null,
    current: true,
    description: null,
    sortOrder: 0,
    createdAt: new Date('2026-09-01T09:00:00.000Z'),
    updatedAt: new Date('2026-09-01T09:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Seed a profile with one role carrying one claim, and let the row resolve.
 *
 * The projection needs BOTH the profile row and the claim row to name the SAME profile
 * scope, because `createRevision` resolves every claim the block names against
 * `clearance.profileId` - a block naming a claim outside the scope is refused (404), which
 * would make every test below fail for the wrong reason.
 *
 * **T1080 / ADR-043 R-SUMMARY.** The profile column `summary: 'Builds things.'` now has a
 * CLAIM behind it - `summaryClaimRow()`, an unattached `soft_skill` claim - because
 * `basics.summary` is on the claim rail and a summary string with no claim naming it is
 * `DOCUMENT_UNAUDITED` at write time. Before T1080 this fixture projected a summary the
 * belt could not see; it now projects the shape a V2 profile actually has.
 */
function seedProjectableProfile(
  claim: Record<string, unknown> = claimRow({ status: ClaimStatus.user_confirmed }),
  extraClaims: Record<string, unknown>[] = [summaryClaimRow()],
) {
  // The claim is ATTACHED to the experience (`experienceId`), which is what makes the
  // projector place it as `work[0].highlights[0]` rather than record it as `otherClaims`
  // with `usage: omitted`.
  const attached = { ...claim, experienceId: (claim.experienceId as string | null) ?? 'exp-1' };
  prismaMocks.careerProfile.findUnique.mockResolvedValue({
    id: 'profile-1',
    userId: 'user-1',
    headline: 'Staff Engineer',
    seniority: 'senior',
    summary: 'Builds things.',
  });
  prismaMocks.experience.findMany.mockResolvedValue([v2Experience()]);
  // `loadProjectionInput` destructures all six collections, so an UNSET mock is
  // `undefined` rather than `[]` and the spread throws. A projection of a profile with one
  // role and nothing else is the realistic minimal case, so it is seeded explicitly.
  prismaMocks.education.findMany.mockResolvedValue([]);
  prismaMocks.project.findMany.mockResolvedValue([]);
  prismaMocks.skill.findMany.mockResolvedValue([]);
  prismaMocks.certification.findMany.mockResolvedValue([]);
  prismaMocks.careerClaim.findMany.mockResolvedValue([attached, ...extraClaims]);
  prismaMocks.resumeClaimUsage.create.mockImplementation(async ({ data }: any) => ({ id: 'usg-1', ...data }));
  prismaMocks.resume.create.mockImplementation(async ({ data }: any) => {
    const row = {
      id: 'res-v2',
      name: data.name,
      modelVersion: 2,
      profileId: 'profile-1',
      createdAt: new Date('2026-10-03T10:00:00.000Z'),
    };
    resumeRows.rows.push(row);
    return row;
  });
}

describe('POST /resumes/from-profile', () => {
  it('creates a modelVersion 2 resume plus revision 1 from the profile projection', async () => {
    seedProjectableProfile();

    const res = await request(makeApp()).post('/from-profile').send({});

    expect(res.status).toBe(201);
    // The row is a V2 shape pointing at the profile, so every V2 read path can find it.
    expect(res.body.resume).toMatchObject({ id: 'res-v2', modelVersion: 2, profileId: 'profile-1' });
    expect(prismaMocks.resume.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          modelVersion: 2,
          kind: 'master',
          profileId: 'profile-1',
          // The only legacy column with no default. `{}` rather than a fabricated
          // personalInfo: invented contact details would put text in the document that no
          // claim backs.
          personalInfo: {},
        }),
      }),
    );

    // Revision 1 goes through the SAME writer the editor uses - the write path, not a
    // privileged insert that skips the belt.
    expect(prismaMocks.resumeRevision.create).toHaveBeenCalledTimes(1);
    const written = prismaMocks.resumeRevision.create.mock.calls[0][0].data;
    expect(written).toMatchObject({ resumeId: 'res-v2', revisionNumber: 1, createdBy: 'user' });
    // The projector placed the CONFIRMED claim as a verbatim highlight, and the block says
    // so - which is the only way the gate can later read it.
    expect(written.resumeJson.work[0].highlights).toEqual(['Cut CI build time by 40%']);
    expect(written.resumeJson[X_CLEARANCE_KEY].claims[0]).toMatchObject({
      claimId: 'clm-1',
      status: ClaimStatus.user_confirmed,
      usage: ResumeUsage.verbatim,
      jsonPath: 'work[0].highlights[0]',
    });
    expect(res.body.revision.jsonHash).toMatch(/^[0-9a-f]{64}$/);
    // The document validates against JSON Resume + `x-clearance` before anything is written.
    expect(res.body.validation.valid).toBe(true);
  });

  it('CONFIRMS NOTHING: an unconfirmed claim projects as unconfirmed and the gate reports blocked', async () => {
    // The load-bearing property of the whole career layer, checked at the creation seam:
    // a resume can be created from a profile that has nothing confirmed, and what comes
    // back says BLOCKED with the machine reason rather than silently rendering.
    seedProjectableProfile(claimRow({ status: ClaimStatus.inferred }));
    // The gate reads the usage ROWS, so it needs them present after the write.
    prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([
      {
        id: 'usg-1',
        revisionId: 'rev-1',
        claimId: 'clm-1',
        usage: ResumeUsage.verbatim,
        renderedText: 'Cut CI build time by 40%',
        createdAt: new Date('2026-10-03T10:00:00.000Z'),
      },
    ]);

    const res = await request(makeApp()).post('/from-profile').send({});

    expect(res.status).toBe(201);
    // The document says `inferred` because the CLAIM ROW says `inferred`. A route that
    // passed a status of its own would be caught here.
    const written = prismaMocks.resumeRevision.create.mock.calls[0][0].data;
    expect(written.resumeJson[X_CLEARANCE_KEY].claims[0].status).toBe(ClaimStatus.inferred);
    expect(res.body.gate).toMatchObject({ allowed: false, reason: 'CLAIM_NOT_CONFIRMED' });
    // And the resume row still exists: refusing the CREATE would be a different product
    // (the user could not draft), refusing the RENDER is the invariant.
    expect(prismaMocks.resume.create).toHaveBeenCalledTimes(1);
  });

  it('uses the profile headline when no name is given, and honours an explicit name', async () => {
    seedProjectableProfile();
    await request(makeApp()).post('/from-profile').send({});
    expect(prismaMocks.resume.create.mock.calls[0][0].data.name).toBe('Staff Engineer');

    await request(makeApp()).post('/from-profile').send({ name: '  Backend role  ' });
    expect(prismaMocks.resume.create.mock.calls[1][0].data.name).toBe('Backend role');
  });

  it('copies the ACCOUNT name and contact fields into the document, not the headline', async () => {
    seedProjectableProfile();
    prismaMocks.careerProfile.findUnique.mockResolvedValue({
      id: 'profile-1',
      userId: 'user-1',
      headline: 'Staff Engineer',
      summary: 'Builds things.',
      locationPref: 'London, UK',
      links: { phone: '+44 20 7946 0018', website: 'https://example.org/ada' },
      user: { name: 'Aakif Mudel', email: 'aakif@example.com' },
    });

    await request(makeApp()).post('/from-profile').send({});

    expect(prismaMocks.resume.create.mock.calls[0][0].data.name).toBe('Aakif Mudel');
    const written = prismaMocks.resumeRevision.create.mock.calls[0][0].data;
    expect(written.resumeJson.basics).toMatchObject({
      name: 'Aakif Mudel',
      label: 'Staff Engineer',
      email: 'aakif@example.com',
      phone: '+44 20 7946 0018',
      url: 'https://example.org/ada',
      location: { city: 'London, UK' },
    });
  });

  it('is a 404 with NO writes when the caller has no career profile', async () => {
    // The empty state is the career layer's to fix ("import something"), so the honest
    // answer is "that resource does not exist" - not a 400 that reads as "your body is
    // wrong", and definitely not a created empty resume.
    prismaMocks.careerProfile.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).post('/from-profile').send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Career profile/i);
    expect(prismaMocks.resume.create).not.toHaveBeenCalled();
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('refuses a profileId belonging to another tenant with a 403, and writes nothing', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue({
      id: 'profile-other',
      userId: 'user-2',
      headline: 'Someone else',
      seniority: null,
      summary: null,
    });
    const res = await request(makeApp()).post('/from-profile').send({ profileId: 'profile-other' });
    expect(res.status).toBe(403);
    expect(prismaMocks.resume.create).not.toHaveBeenCalled();
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown body member rather than ignoring it', async () => {
    // `.strict()`, like the import schema: a client that sends `modelVersion: 2` (or
    // `userId`, or a status) must be told, not have it silently dropped. This route has no
    // member through which a status could be written even so.
    seedProjectableProfile();
    const res = await request(makeApp())
      .post('/from-profile')
      .send({ modelVersion: 2, status: 'user_confirmed' });
    expect(res.status).toBe(400);
    expect(prismaMocks.resume.create).not.toHaveBeenCalled();
  });

  it('F4: the resume row and the first revision are ONE transaction', async () => {
    seedProjectableProfile();
    const res = await request(makeApp()).post('/from-profile').send({});
    expect(res.status).toBe(201);
    // Both writes went through the transaction, so a refusal anywhere in the revision write
    // rolls the resume row back with it rather than leaving a `modelVersion: 2` resume with
    // no revision - which the route's own comment above promised would not happen.
    expect(prismaMocks.$transaction).toHaveBeenCalledTimes(1);
    expect(resumeRows.rows).toHaveLength(1);
    expect(resumeRows.rows[0]).toMatchObject({ id: 'res-v2', modelVersion: 2 });
  });

  it('F4: a FAILING first-revision write leaves NO orphan Resume row', async () => {
    // The mutation target. `createRevision` refuses for reasons of its own - the claim-usage
    // belt, the `x-clearance` cross-check, the op log - and each of them used to leave the
    // already-inserted resume behind, one orphan per retry. Here the usage write fails, which
    // is the last thing `createRevision` does after the revision row is in.
    seedProjectableProfile();
    prismaMocks.resumeClaimUsage.create.mockRejectedValue(new Error('connection reset'));

    const res = await request(makeApp()).post('/from-profile').send({});

    expect(res.status).toBeGreaterThanOrEqual(500);
    // The insert DID happen - so the assertion below is about the rollback, not about the
    // route having decided not to create anything.
    expect(prismaMocks.resume.create).toHaveBeenCalledTimes(1);
    expect(resumeRows.rows, 'an orphaned Resume row survived the failed revision write').toEqual([]);
    // Nothing downstream of the failed write either: no usage row, no revision row beyond
    // the one the transaction rolled back with it.
    expect(prismaMocks.resumeClaimUsage.create).toHaveBeenCalledTimes(1);
  });

  it('F1+F3 LIVE SHAPE: a REJECTED attached claim is created as `omitted`, not as text', async () => {
    // The end-to-end shape of the two fixes on this route. The claim is ATTACHED to the
    // experience and rejected - reachable, because `rejectUserClaim` writes only the status
    // and leaves the FK alone. Before: 409 from the write-time belt, plus a rejected
    // statement sitting in the projection preview's `highlights`.
    seedProjectableProfile(claimRow({ status: ClaimStatus.rejected }));

    const res = await request(makeApp()).post('/from-profile').send({});

    expect(res.status).toBe(201);
    const written = prismaMocks.resumeRevision.create.mock.calls[0][0].data;
    // Not placed as rendered text.
    expect(written.resumeJson.work[0].highlights).toBeUndefined();
    expect(JSON.stringify(written.resumeJson)).not.toContain('Cut CI build time by 40%');
    // ...but ACCOUNTED FOR, with the row's own status.
    expect(written.resumeJson[X_CLEARANCE_KEY].claims[0]).toMatchObject({
      claimId: 'clm-1',
      status: ClaimStatus.rejected,
      usage: ResumeUsage.omitted,
      jsonPath: null,
    });
    // The usage row really was written - an `omitted` usage is recordable.
    expect(prismaMocks.resumeClaimUsage.create).toHaveBeenCalledWith({
      data: { revisionId: 'rev-1', claimId: 'clm-1', usage: 'omitted', renderedText: null },
    });
    // And the gate is green, because an omitted usage renders nothing.
    expect(res.body.gate).toMatchObject({ allowed: true, rendered: 0 });
    expect(resumeRows.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// POST /resumes/:id/revisions
// ---------------------------------------------------------------------------

describe('POST /resumes/:id/revisions', () => {
  it('creates revision 1, DERIVES the usage from the document, and reports the gate verdict', async () => {
    // A usage may only name a claim that EXISTS, so the route refuses the request with a
    // 404 if it does not. Seeded here, which is also the realistic case.
    prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow()]);
    prismaMocks.resumeClaimUsage.create.mockImplementation(async ({ data }: any) => ({ id: 'usg-1', ...data }));
    // NOTE: no `usages` in the request. The usage row is written from the document's
    // `x-clearance` block, which is the F1 fix - the client does not get to decide
    // whether the revision is accounted for.
    const res = await request(makeApp())
      .post('/res-1/revisions')
      .send({ document: validDocument() });

    expect(res.status).toBe(201);
    expect(res.body.revisionNumber).toBe(1);
    expect(res.body.jsonHash).toMatch(/^[0-9a-f]{64}$/);
    // The gate verdict is REPORTED, not enforced: a draft that quotes an unconfirmed
    // claim is legal, and is how the user sees what they are being asked to confirm.
    //
    // ACCEPT-AS-NOTE (review sec. 4): `checked: 0` here is an artefact of the MOCK, not
    // of the recorded state. `resumeClaimUsage.findMany` is left returning `[]` by
    // `beforeEach`, so the route reads zero rows even though the row it just wrote
    // exists - the assertion at :226 is what proves the row was written. The verdict this
    // test therefore proves is "the create route REPORTS rather than enforces", which is
    // the property; a seeded `findMany` would make it read as if a confirmed usage had
    // been gated. The gate's own truth table over real rows is in `claimUsage.test.ts`.
    expect(res.body.gate).toEqual({ allowed: true, checked: 0, rendered: 0 });
    expect(prismaMocks.resumeRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resumeId: 'res-1', revisionNumber: 1, createdBy: 'user' }),
      }),
    );
    // The derived row, with the document's own usage and rendered text - not the
    // client's, because the client sent none.
    expect(prismaMocks.resumeClaimUsage.create).toHaveBeenCalledTimes(1);
    expect(prismaMocks.resumeClaimUsage.create).toHaveBeenCalledWith({
      data: { revisionId: 'rev-1', claimId: 'clm-1', usage: 'verbatim', renderedText: 'Cut CI build time by 40%' },
    });
  });

  it('accepts a usage set that RESTATES the document, and ignores it otherwise', async () => {
    // The compatibility half: an existing client that sends the same list still works,
    // and the recorded row is still the document's.
    prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow()]);
    prismaMocks.resumeClaimUsage.create.mockImplementation(async ({ data }: any) => ({ id: 'usg-1', ...data }));
    const res = await request(makeApp())
      .post('/res-1/revisions')
      .send({
        document: validDocument(),
        usages: [{ claimId: 'clm-1', usage: 'verbatim', renderedText: 'Cut CI build time by 40%' }],
      });
    expect(res.status).toBe(201);
    expect(prismaMocks.resumeClaimUsage.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a document naming a claim that does not exist, with a 404, and writes NO revision', async () => {
    // Fail closed: an unresolvable claim reference is a client error naming something that
    // is not there, and nothing is written.
    //
    // F2. This test used to assert `resumeClaimUsage.create` was not called - the WRONG
    // write, since the orphan the review found was a REVISION with no usage. The
    // assertion is now on `resumeRevision.create`, and `careerClaim.findMany` returns
    // nothing so the derived set cannot resolve either.
    prismaMocks.careerClaim.findMany.mockResolvedValue([]);
    const res = await request(makeApp())
      .post('/res-1/revisions')
      .send({ document: validDocument() });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('claim_not_found');
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
    expect(prismaMocks.resumeClaimUsage.create).not.toHaveBeenCalled();
  });

  it('refuses a V2 document with NO x-clearance block, with the reason and no writes', async () => {
    // F1 at the HTTP boundary: the documented bypass, verbatim. A document with
    // `work[].highlights` and no block used to be accepted with an empty usage set, and
    // `POST /render` then produced an artifact. The write now refuses it, so the blocked
    // case is unreachable rather than merely checked later.
    const { [X_CLEARANCE_KEY]: _block, ...noBlock } = validDocument();
    const res = await request(makeApp())
      .post('/res-1/revisions')
      .send({ document: noBlock });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('resume_revision_failed');
    expect(res.body.reason).toBe('CLEARANCE_BLOCK_REQUIRED');
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
    expect(prismaMocks.resumeClaimUsage.create).not.toHaveBeenCalled();
  });

  it('a document whose x-clearance FORGES a confirmed status over an inferred row is ACCEPTED and stored REFRESHED', async () => {
    // THE RULING at the HTTP boundary. `validDocument()`'s block says `user_confirmed`
    // and the row is `inferred`. This used to be a 400
    // (`CLEARANCE_DISAGREES_WITH_CLAIMS`) and it is now a 201 whose STORED block carries
    // the ROW's status.
    //
    // The change of pin is deliberate and it is the whole point of the defect: a 400 here
    // was indistinguishable from the STALE case (the Studio loads the current revision's
    // document, the user edits it, a claim has since been confirmed, autosave 400s), and
    // the cost fell entirely on the honest caller. What the old refusal bought - "the
    // stored block is never a lie" - is what the refresh delivers, by construction rather
    // than by rejection.
    prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow({ status: ClaimStatus.inferred })]);
    prismaMocks.resumeClaimUsage.create.mockImplementation(async ({ data }: any) => ({ id: 'usg-1', ...data }));
    const res = await request(makeApp())
      .post('/res-1/revisions')
      .send({ document: validDocument() });   // the block says user_confirmed
    expect(res.status).toBe(201);
    // The forgery is NEUTRALISED, not honoured: the row that was written carries the row's
    // status, and the response's own copy of the document agrees with it.
    const written = prismaMocks.resumeRevision.create.mock.calls[0][0].data.resumeJson;
    expect(written[X_CLEARANCE_KEY].claims[0]).toMatchObject({ claimId: 'clm-1', status: ClaimStatus.inferred });
    expect(res.body.document[X_CLEARANCE_KEY].claims[0]).toMatchObject({ status: ClaimStatus.inferred });
    expect(written[X_CLEARANCE_KEY]).toMatchObject({ confirmedClaimCount: 0, unconfirmedClaimCount: 1 });
    // The revision is a real one: the usage row was written, so the gate is not vacuous.
    expect(prismaMocks.resumeClaimUsage.create).toHaveBeenCalledTimes(1);
  });

  it('a STALE block - the Studio autosave shape - is accepted and stored refreshed', async () => {
    // THE LIVE DEFECT, at the HTTP boundary. The document is byte-for-byte what the Studio
    // holds after loading the current revision; the row has since been CONFIRMED. Before
    // this round: HTTP 400 and the autosave silently failed on every resume whose claims
    // moved after its revision was written.
    prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow()]);
    prismaMocks.resumeClaimUsage.create.mockImplementation(async ({ data }: any) => ({ id: 'usg-1', ...data }));
    // The document's block says `inferred` (stale, honest); the row says `user_confirmed`.
    const stale = validDocument();
    stale[X_CLEARANCE_KEY].claims[0].status = ClaimStatus.inferred;
    stale[X_CLEARANCE_KEY].confirmedClaimCount = 0;
    stale[X_CLEARANCE_KEY].unconfirmedClaimCount = 1;

    const res = await request(makeApp()).post('/res-1/revisions').send({ document: stale });

    expect(res.status).toBe(201);
    const written = prismaMocks.resumeRevision.create.mock.calls[0][0].data.resumeJson;
    expect(written[X_CLEARANCE_KEY].claims[0]).toMatchObject({ status: ClaimStatus.user_confirmed });
    expect(written[X_CLEARANCE_KEY]).toMatchObject({ confirmedClaimCount: 1, unconfirmedClaimCount: 0 });
    // POSITIVE CONTROL: a document whose block ALREADY agrees stores unchanged. Otherwise
    // "201 + refreshed" would be indistinguishable from "201 + always rewrote the block".
    const agreed = validDocument();
    const second = await request(makeApp()).post('/res-1/revisions').send({ document: agreed });
    expect(second.status).toBe(201);
    const secondWritten = prismaMocks.resumeRevision.create.mock.calls[1][0].data.resumeJson;
    expect(secondWritten).toEqual(agreed);
  });

  it('refuses a block naming a claim that resolves to no row, with a 404 and no writes', async () => {
    // THE RULING's structural half, at the HTTP boundary. A claim id that resolves to
    // nothing is an unaccounted placement, and there is no row value to refresh FROM, so
    // it stays a refusal - 404, the same answer as before this round.
    prismaMocks.careerClaim.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).post('/res-1/revisions').send({ document: validDocument() });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('claim_not_found');
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
    expect(prismaMocks.resumeClaimUsage.create).not.toHaveBeenCalled();
  });

  it('refuses a usage set that disagrees with the document, in BOTH directions', async () => {
    prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow()]);
    // Under-declares: the document says it renders clm-1 verbatim, the caller says nothing.
    const under = await request(makeApp())
      .post('/res-1/revisions')
      .send({ document: validDocument(), usages: [] });
    expect(under.status).toBe(400);
    expect(under.body.reason).toBe('INVALID_INPUT');
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();

    // Over-declares: a claim the document says nothing about. The rows in play are
    // `clm-1` and `clm-2` (the document names only `clm-1`), so the STRUCTURAL half
    // refuses first - `CLEARANCE_DISAGREES_WITH_CLAIMS` - and `assertUsagesMatchDocument`
    // would have refused it as `INVALID_INPUT` immediately afterwards. Either way nothing
    // is written; the reason that answers first is the one the response carries, and this
    // test pins the ORDER as well as the refusal.
    prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow(), claimRow({ id: 'clm-2' })]);
    const over = await request(makeApp())
      .post('/res-1/revisions')
      .send({
        document: validDocument(),
        usages: [
          { claimId: 'clm-1', usage: 'verbatim', renderedText: 'Cut CI build time by 40%' },
          { claimId: 'clm-2', usage: 'verbatim', renderedText: 'x' },
        ],
      });
    expect(over.status).toBe(400);
    expect(over.body.reason).toBe('CLEARANCE_DISAGREES_WITH_CLAIMS');
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('REFUSES a document that fails the schema, with the issues, before any write', async () => {
    const res = await request(makeApp()).post('/res-1/revisions').send({ document: { basics: {} } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('resume_revision_failed');
    expect(res.body.reason).toBe('INVALID_JSON');
    expect(res.body.issues[0]).toMatchObject({ path: '/basics/name' });
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('refuses a request that does not match the envelope schema', async () => {
    const res = await request(makeApp())
      .post('/res-1/revisions')
      .send({ document: validDocument(), unexpected: true });
    expect(res.status).toBe(400);
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('404s an unknown resume and 403s someone else s', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue(null);
    expect((await request(makeApp()).post('/nope/revisions').send({ document: validDocument() })).status).toBe(404);

    prismaMocks.resume.findUnique.mockResolvedValue({ ...RESUME, userId: 'user-2' });
    mockUserId.value = 'user-1';
    expect((await request(makeApp()).post('/res-1/revisions').send({ document: validDocument() })).status).toBe(403);
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /resumes/:id/revisions  and  /:n
// ---------------------------------------------------------------------------

describe('GET /resumes/:id/revisions', () => {
  it('lists revisions oldest first WITHOUT the document, and get-by-number WITH it', async () => {
    prismaMocks.resumeRevision.findMany.mockResolvedValue([
      revisionRow({ id: 'rev-1', revisionNumber: 1 }),
      revisionRow({ id: 'rev-2', revisionNumber: 2 }),
    ]);
    const list = await request(makeApp()).get('/res-1/revisions');
    expect(list.status).toBe(200);
    expect(list.body.map((entry: any) => entry.revisionNumber)).toEqual([1, 2]);
    // The document is the largest member by far and the list is for navigation.
    expect(list.body[0]).not.toHaveProperty('document');
    expect(list.body[0]).toHaveProperty('jsonHash');

    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
    const one = await request(makeApp()).get('/res-1/revisions/1');
    expect(one.status).toBe(200);
    expect(one.body.document).toEqual(validDocument());
    expect(one.body.gate).toBeDefined();
  });

  it('404s a revision that does not exist, and 403s someone else s', async () => {
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(null);
    expect((await request(makeApp()).get('/res-1/revisions/9')).status).toBe(404);

    prismaMocks.resume.findUnique.mockResolvedValue({ ...RESUME, userId: 'user-2' });
    expect((await request(makeApp()).get('/res-1/revisions')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /resumes/:id/diff
// ---------------------------------------------------------------------------

describe('GET /resumes/:id/diff', () => {
  it('defaults to the last two revisions and reports the change log', async () => {
    prismaMocks.resumeRevision.findMany.mockResolvedValue([
      revisionRow({ id: 'rev-1', revisionNumber: 1 }),
      revisionRow({
        id: 'rev-2',
        revisionNumber: 2,
        resumeJson: {
          ...validDocument(),
          work: [{ name: 'Acme', position: 'Staff Engineer', startDate: '2020-01', highlights: ['Shrank CI to 18 min'] }],
        },
      }),
    ]);
    const res = await request(makeApp()).get('/res-1/diff');
    expect(res.status).toBe(200);
    expect(res.body.from.revisionNumber).toBe(1);
    expect(res.body.to.revisionNumber).toBe(2);
    expect(res.body.entries).toContainEqual({
      kind: 'changed',
      jsonPath: 'work[0].highlights[0]',
      before: 'Cut CI build time by 40%',
      after: 'Shrank CI to 18 min',
    });
  });

  it('honours explicit from/to and refuses from > to', async () => {
    prismaMocks.resumeRevision.findMany.mockResolvedValue([
      revisionRow({ id: 'rev-1', revisionNumber: 1 }),
      revisionRow({ id: 'rev-2', revisionNumber: 2 }),
    ]);
    const explicit = await request(makeApp()).get('/res-1/diff?from=1&to=2');
    expect(explicit.status).toBe(200);
    expect(explicit.body.identical).toBe(true);

    expect((await request(makeApp()).get('/res-1/diff?from=2&to=1')).status).toBe(400);
    expect((await request(makeApp()).get('/res-1/diff?from=abc')).status).toBe(400);
    expect((await request(makeApp()).get('/res-1/diff?to=99')).status).toBe(404);
  });

  it('404s a resume with no revisions at all', async () => {
    prismaMocks.resumeRevision.findMany.mockResolvedValue([]);
    expect((await request(makeApp()).get('/res-1/diff')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /resumes/:id/render - THE GATE, AS A ROUTE GUARD
// ---------------------------------------------------------------------------

describe('ORDERING: the gate runs as route middleware, BEFORE any render work', () => {
  it('never reaches the render port on a blocked revision - the call log is empty', async () => {
    // THE acceptance item, at the HTTP layer. A render that opened a file, spawned a
    // process and then validated would return the same 409 and still fail this system;
    // only an EMPTY call log proves the render was never attempted.
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'doc-1', format: args.format, hash: 'h' } satisfies RenderResult;
    });
    usage(
      [{ claimId: 'clm-1', usage: ResumeUsage.verbatim }],
      [claimRow({ status: ClaimStatus.inferred })],
    );
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());

    const res = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });

    expect(res.status).toBe(409);
    expect(renderCalls).toEqual([]);
    // Machine-readable: a client can branch on this without parsing prose.
    expect(res.body.code).toBe('PRE_RENDER_GATE_BLOCKED');
    expect(res.body.reason).toBe('CLAIM_NOT_CONFIRMED');
    expect(res.body.violations).toEqual([
      { claimId: 'clm-1', status: ClaimStatus.inferred, usage: ResumeUsage.verbatim, reason: 'CLAIM_NOT_CONFIRMED' },
    ]);
    expect(res.body.checked).toBe(1);
  });

  it('reaches the render port exactly once on an allowed revision', async () => {
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'doc-1', format: args.format, hash: 'h' } satisfies RenderResult;
    });
    usage([{ claimId: 'clm-1', usage: ResumeUsage.verbatim }], [claimRow()]);
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());

    const res = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });

    expect(res.status).toBe(201);
    expect(renderCalls).toEqual([{ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }]);
    expect(res.body).toEqual({ documentId: 'doc-1', format: 'pdf', hash: 'h' });
  });

  it('reads the status from the DATABASE, not from the stored document', async () => {
    // The stored snapshot claims the confirming status; the claim row does not. The gate
    // reads the row, so it blocks. If anyone "optimised" the gate to read the block (one
    // query instead of two), this test fails.
    setResumeRenderPort(async () => ({ documentId: 'd', format: 'pdf', hash: 'h' }));
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
    const forged = validDocument();
    (forged[X_CLEARANCE_KEY] as any).claims[0].status = ClaimStatus.user_confirmed;
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ resumeJson: forged }));
    usage([{ claimId: 'clm-1', usage: ResumeUsage.verbatim }], [claimRow({ status: ClaimStatus.inferred })]);

    const res = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(res.status).toBe(409);
    expect(prismaMocks.careerClaim.findMany).toHaveBeenCalled();
  });

  it('refuses every non-confirmed status, over HTTP', async () => {
    setResumeRenderPort(async () => ({ documentId: 'd', format: 'pdf', hash: 'h' }));
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
    for (const status of [
      ClaimStatus.inferred,
      ClaimStatus.contextual,
      ClaimStatus.rejected,
      ClaimStatus.superseded,
    ]) {
      usage([{ claimId: 'clm-1', usage: ResumeUsage.verbatim }], [claimRow({ status })]);
      const res = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
      expect(res.status, status).toBe(409);
      expect(res.body.violations[0].status, status).toBe(status);
    }
  });

  it('allows an `omitted` usage at any status, which is what makes suggestions possible', async () => {
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'doc-1', format: 'pdf', hash: 'h' };
    });
    // The DOCUMENT has to say `omitted` too, and to carry no text for it. It used to
    // post a document that placed the claim's text at `work[0].highlights[0]` and
    // declared it `verbatim`, while the log said `omitted` - a document and a log that
    // genuinely disagree. The read-time comparison used to compare `claimId` alone and
    // could not see that; it is a multiset of `(claimId, usage)` now (ADR-043 rule 4),
    // so the fixture describes a real document: "the profile knows this and the resume
    // does not say it".
    const omittedDocument = {
      basics: { name: 'Ada Lovelace' },
      work: [{ name: 'Acme', position: 'Staff Engineer', startDate: '2020-01' }],
      [X_CLEARANCE_KEY]: {
        ...validDocument()[X_CLEARANCE_KEY],
        confirmedClaimCount: 0,
        unconfirmedClaimCount: 1,
        claims: [
          {
            ...validDocument()[X_CLEARANCE_KEY].claims[0],
            usage: ResumeUsage.omitted,
            jsonPath: null,
            renderedText: null,
          },
        ],
      },
    };
    usage([{ claimId: 'clm-1', usage: ResumeUsage.omitted }], [claimRow({ status: ClaimStatus.inferred })]);
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ resumeJson: omittedDocument }));

    const res = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(res.status).toBe(201);
    expect(renderCalls).toHaveLength(1);
  });

  it('uses the CURRENT revision when no revisionId is named', async () => {
    setResumeRenderPort(async () => ({ documentId: 'd', format: 'pdf', hash: 'h' }));
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ id: 'rev-current', revisionNumber: 7 }));
    usage([{ claimId: 'clm-1', usage: ResumeUsage.verbatim }], [claimRow()]);

    const res = await request(makeApp()).post('/res-1/render').send({ format: 'json' });
    expect(res.status).toBe(201);
    // Resolving "current" INSIDE the guard is what makes "render" mean "render what the
    // user last saved" rather than "render whatever a stale id in a query string says".
    expect(prismaMocks.resumeClaimUsage.findMany).toHaveBeenCalledWith({
      where: { revisionId: 'rev-current' },
    });
  });

  it('F3: refuses a revisionId that belongs to ANOTHER resume, and never reaches the port', async () => {
    // The last checkpoint before an artifact exists performed no ownership check on the
    // revision: `requireOwnedResume` proved the caller owns the resume in the PATH, which
    // says nothing about which revision they NAMED. A caller could point the gate at a
    // revision that is not theirs (or that does not exist) and, on zero usage rows, the
    // gate allowed and the port ran.
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'd', format: args.format, hash: 'h' };
    });
    // The foreign revision resolves, and it resolves to a DIFFERENT resume.
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ id: 'rev-other', resumeId: 'res-of-another-user' }));
    usage([{ claimId: 'clm-1', usage: ResumeUsage.verbatim }], [claimRow()]);

    const res = await request(makeApp())
      .post('/res-1/render?revisionId=rev-other')
      .send({ format: 'pdf' });

    expect(res.status).toBe(404);
    expect(renderCalls).toEqual([]);
    // And it is a 404 rather than a 403, so the endpoint cannot be used to discover that
    // the other revision exists.
    expect(res.body.code).toBeUndefined();
  });

  it('F3: refuses a revisionId that resolves to NOTHING, and never reaches the port', async () => {
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'd', format: args.format, hash: 'h' };
    });
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(null);
    // Zero usage rows for the nonexistent id - the shape that used to pass the gate.
    prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .post('/res-1/render?revisionId=rev-that-does-not-exist')
      .send({ format: 'pdf' });

    expect(res.status).toBe(404);
    expect(renderCalls).toEqual([]);
  });

  it('BELT: refuses a revision whose document carries career text and records NO usage', async () => {
    // The bypass, at the HTTP layer, asserted as a 409 and with an empty call log. The
    // document claims nothing about the claims it uses, so the gate has nothing to vouch
    // for - and the check reads the DOCUMENT, so no number of usage rows can make it pass.
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'd', format: args.format, hash: 'h' };
    });
    const unaudited = {
      basics: { name: 'Ada Lovelace' },
      work: [{ name: 'Acme', position: 'Engineer', highlights: ['I led the migration of 400 services'] }],
      [X_CLEARANCE_KEY]: {
        version: 1,
        generatedBy: 'forged',
        sourceModelVersion: 2,
        profileId: 'profile-1',
        claimCount: 0,
        confirmedClaimCount: 0,
        unconfirmedClaimCount: 0,
        claims: [],
      },
    };
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ resumeJson: unaudited }));
    prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('resume_revision_audit_failed');
    expect(res.body.reason).toBe('DOCUMENT_UNAUDITED');
    expect(renderCalls).toEqual([]);
    // POSITIVE CONTROL for the same shape: a document with no career-bearing text and no
    // usage rows is ALLOWED, which is the stated meaning of an empty set.
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(
      revisionRow({ resumeJson: { basics: { name: 'Ada Lovelace' }, [X_CLEARANCE_KEY]: unaudited[X_CLEARANCE_KEY] } }),
    );
    const empty = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(empty.status).toBe(201);
    expect(renderCalls).toHaveLength(1);
  });

  it('ADR-043 N1/N2: the render route refuses work[1] text and a duplicate claimId, never reaching the port', async () => {
    // The two HIGH findings, over HTTP, through the shipped route - the surface the
    // review said both bypasses were reachable on.
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'd', format: args.format, hash: 'h' };
    });

    // N1: the text is at `work[1]`, and `work[0]` is present but empty. The attempt-2
    // walker descended into `work[0]` with `Array.prototype.find` and never saw this.
    const shiftDown = {
      basics: { name: 'Ada Lovelace' },
      work: [
        { name: 'Acme', position: 'Engineer' },
        { name: 'Globex', position: 'Engineer', highlights: ['I led the migration of 400 services'] },
      ],
      [X_CLEARANCE_KEY]: {
        version: 1,
        generatedBy: 'forged',
        sourceModelVersion: 2,
        profileId: 'profile-1',
        claimCount: 0,
        confirmedClaimCount: 0,
        unconfirmedClaimCount: 0,
        claims: [],
      },
    };
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ resumeJson: shiftDown }));
    prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([]);
    const n1 = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(n1.status).toBe(409);
    expect(n1.body.reason).toBe('DOCUMENT_UNAUDITED');
    expect(renderCalls).toEqual([]);

    // N2: one claim named twice in the block, `omitted` first. The document declares a
    // set of 2 and the log holds 1, so the `(claimId, usage)` multiset cannot be equal -
    // where a `claimId`-only comparison saw the same set and allowed.
    const duplicated = {
      basics: { name: 'Ada Lovelace' },
      work: [{ name: 'Acme', position: 'Engineer', highlights: ['Cut CI build time by 40%'] }],
      [X_CLEARANCE_KEY]: {
        ...validDocument()[X_CLEARANCE_KEY],
        claims: [
          { ...validDocument()[X_CLEARANCE_KEY].claims[0], usage: ResumeUsage.omitted, jsonPath: null, renderedText: null },
          { ...validDocument()[X_CLEARANCE_KEY].claims[0], usage: ResumeUsage.verbatim },
        ],
      },
    };
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ resumeJson: duplicated }));
    usage([{ claimId: 'clm-1', usage: ResumeUsage.omitted }], [claimRow()]);
    const n2 = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(n2.status).toBe(409);
    expect(n2.body.reason).toBe('USAGE_SET_MISMATCH');
    expect(renderCalls).toEqual([]);
  });

  it('ADR-043: the render route REJECTS a document whose block names one claimId twice', async () => {
    // The WRITE half of the same rule, over HTTP. The `@@unique([revisionId, claimId])`
    // row means the recorded usage would depend on entry order, so the request is a 400
    // and NOTHING is written - which is the property F2 already established for a bad
    // claim, applied to an ambiguous block.
    prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow()]);
    const duplicated = {
      basics: { name: 'Ada Lovelace' },
      work: [{ name: 'Acme', position: 'Engineer', highlights: ['Cut CI build time by 40%'] }],
      [X_CLEARANCE_KEY]: {
        ...validDocument()[X_CLEARANCE_KEY],
        claims: [
          { ...validDocument()[X_CLEARANCE_KEY].claims[0], usage: ResumeUsage.omitted, jsonPath: null, renderedText: null },
          { ...validDocument()[X_CLEARANCE_KEY].claims[0], usage: ResumeUsage.verbatim },
        ],
      },
    };
    const res = await request(makeApp())
      .post('/res-1/revisions')
      .send({ document: duplicated, createdBy: 'user' });
    expect(res.status).toBe(400);
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('ADR-043 N3: a profile with project tech and ZERO claims renders end to end', async () => {
    // The false positive, over HTTP. `projects[].keywords` (and `project.description`,
    // `work[].summary`) are entity/profile columns with no claim behind them, and the
    // attempt-2 belt listed them - so this document was PERMANENTLY un-renderable. It is
    // the ordinary state of a user who has filled in their profile and confirmed nothing
    // yet.
    //
    // RE-SCOPED BY T1080 (ADR-043 R-SUMMARY): there is NO `basics.summary` here any more.
    // The summary joined the claim rail when R-SUMMARY was closed, so keeping one in this
    // fixture would be asserting the residual instead of the fix. R-ENTITY - the half this
    // test is actually about - is unchanged, and the summary half is asserted in the two
    // tests directly below.
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'd', format: args.format, hash: 'h' };
    });
    const legitimate = {
      basics: { name: 'Ada Lovelace' },
      projects: [{ name: 'Ledger', keywords: ['typescript', 'postgres'] }],
      [X_CLEARANCE_KEY]: {
        version: 1,
        generatedBy: 'clearance/resume-json/project@1',
        sourceModelVersion: 2,
        profileId: 'profile-1',
        claimCount: 0,
        confirmedClaimCount: 0,
        unconfirmedClaimCount: 0,
        claims: [],
      },
    };
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ resumeJson: legitimate }));
    prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([]);
    prismaMocks.careerClaim.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(res.status).toBe(201);
    expect(renderCalls).toHaveLength(1);
  });

  it('R-SUMMARY: a summary backed by a CONFIRMED claim renders, and the belt accounts for it', async () => {
    // The positive half of the closure, over HTTP. `basics.summary` is claim-backed text,
    // the block names that exact path with that exact text, and the render port is reached.
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'd', format: args.format, hash: 'h' };
    });
    const claimed = {
      basics: { name: 'Ada Lovelace', summary: 'A decade of platform work.' },
      [X_CLEARANCE_KEY]: {
        version: 1,
        generatedBy: 'clearance/resume-json/project@1',
        sourceModelVersion: 2,
        profileId: 'profile-1',
        claimCount: 1,
        confirmedClaimCount: 1,
        unconfirmedClaimCount: 0,
        claims: [
          {
            claimId: 'clm-summary',
            fingerprint: 'f'.repeat(64),
            kind: 'soft_skill',
            status: ClaimStatus.user_confirmed,
            provenance: 'document_import',
            confidence: null,
            evidenceSourceId: null,
            usage: ResumeUsage.verbatim,
            jsonPath: 'basics.summary',
            renderedText: 'A decade of platform work.',
          },
        ],
      },
    };
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ resumeJson: claimed }));
    usage(
      [{ claimId: 'clm-summary', usage: ResumeUsage.verbatim }],
      [summaryClaimRow({ statement: 'A decade of platform work.' })],
    );
    // `usage()` gives every usage row a renderedText of `text`; the belt compares it to
    // the document, so the summary row needs the real text.
    prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([
      {
        id: 'usg-0',
        revisionId: 'rev-1',
        claimId: 'clm-summary',
        usage: ResumeUsage.verbatim,
        renderedText: 'A decade of platform work.',
        createdAt: new Date('2026-09-30T12:00:00.000Z'),
      },
    ]);

    const res = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(res.status).toBe(201);
    expect(renderCalls).toHaveLength(1);
  });

  it('R-SUMMARY: a summary with NO claim behind it is refused - the fabrication surface is closed', async () => {
    // The negative half, and the one that makes `reword_summary` shippable: before T1080
    // this document rendered, and a rewrite of that sentence would have been the only
    // crafted prose on the resume the pre-render gate could not see. The belt now refuses
    // it with `DOCUMENT_UNAUDITED` and the port is never reached.
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'd', format: args.format, hash: 'h' };
    });
    const unclaimed = {
      basics: { name: 'Ada Lovelace', summary: 'A decade of platform work.' },
      projects: [{ name: 'Ledger', keywords: ['typescript'] }],
      [X_CLEARANCE_KEY]: {
        version: 1,
        generatedBy: 'clearance/resume-json/project@1',
        sourceModelVersion: 2,
        profileId: 'profile-1',
        claimCount: 0,
        confirmedClaimCount: 0,
        unconfirmedClaimCount: 0,
        claims: [],
      },
    };
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ resumeJson: unclaimed }));
    prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([]);
    prismaMocks.careerClaim.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'resume_revision_audit_failed', reason: 'DOCUMENT_UNAUDITED' });
    expect(renderCalls).toHaveLength(0);
  });

  it('F1/F8: refuses a revision whose usage log does not describe its document, or whose bytes were tampered', async () => {
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async (args) => {
      renderCalls.push(args);
      return { documentId: 'd', format: args.format, hash: 'h' };
    });
    // A phantom row: the document declares `clm-1`, the log also carries `clm-phantom`.
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
    usage(
      [{ claimId: 'clm-1', usage: ResumeUsage.verbatim }],
      [claimRow()],
      [{ claimId: 'clm-phantom', usage: ResumeUsage.verbatim }],
    );
    const mismatch = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.reason).toBe('USAGE_SET_MISMATCH');
    expect(renderCalls).toEqual([]);

    // A tampered row: the bytes no longer hash to the recorded `jsonHash`. `revisionHashMatches`
    // was a tripwire only its own test walked; it is walked here now.
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(
      revisionRow({ resumeJson: validDocument(), jsonHash: 'f'.repeat(64) }),
    );
    usage([{ claimId: 'clm-1', usage: ResumeUsage.verbatim }], [claimRow()]);
    const tampered = await request(makeApp()).post('/res-1/render').send({ format: 'pdf' });
    expect(tampered.status).toBe(409);
    expect(tampered.body.reason).toBe('REVISION_TAMPERED');
    expect(renderCalls).toEqual([]);
  });

  it('404s a resume with no revisions, and 403s someone else s - before the port', async () => {
    const renderCalls: unknown[] = [];
    setResumeRenderPort(async () => {
      renderCalls.push(1);
      return { documentId: 'd', format: 'pdf', hash: 'h' };
    });
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(null);
    expect((await request(makeApp()).post('/res-1/render').send({})).status).toBe(404);

    prismaMocks.resume.findUnique.mockResolvedValue({ ...RESUME, userId: 'user-2' });
    expect((await request(makeApp()).post('/res-1/render').send({})).status).toBe(403);
    expect(renderCalls).toEqual([]);
  });

  it('rejects an unknown format, and refuses to render when no port is installed', async () => {
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
    usage([{ claimId: 'clm-1', usage: ResumeUsage.verbatim }], [claimRow()]);
    // The guard passes, then the format is checked, then the port is resolved. A bad
    // format never reaches a renderer.
    expect((await request(makeApp()).post('/res-1/render').send({ format: 'exe' })).status).toBe(400);
    // T1030 ships the gate, not the renderer: with no port installed a 404 says so
    // plainly rather than pretending to have produced an artifact.
    expect((await request(makeApp()).post('/res-1/render').send({ format: 'pdf' })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /career/import/json
// ---------------------------------------------------------------------------

describe('POST /career/import/json', () => {
  const plainJsonResume = {
    basics: { name: 'Mallory', email: 'mallory@example.com' },
    work: [{ name: 'Globex', position: 'CFO', startDate: '2015-01', highlights: ['Recovered the M&A portfolio', 'Filed 10-Ks on time'] }],
    skills: [{ name: 'TypeScript' }],
  };

  it('lowers a plain JSON Resume into INFERRED claims and an evidence source', async () => {
    // ADR-035 item 4 / 05 sec.7.7: import accepts plain JSON Resume and lowers it into
    // profile/claim rows, all inferred.
    prismaMocks.careerClaim.findFirst.mockResolvedValue(null);
    prismaMocks.careerClaim.create.mockImplementation(async ({ data }: any) => ({ id: 'clm-new', ...data }));

    const res = await request(makeApp())
      .post('/career/import/json')
      .send({ profileId: 'profile-1', document: plainJsonResume });

    expect(res.status).toBe(201);
    // Two work highlights + one skill name = three statements, so three claims.
    // Deliberately NOT counting the employer, the job title or the email: those are
    // profile fields, and gating them would make the invariant meaningless.
    expect(res.body.claims).toEqual({ created: 3, deduped: 0, total: 3 });
    expect(res.body.statusAssigned).toBe(ClaimStatus.inferred);
    expect(res.body.provenanceAssigned).toBe('document_import');
    // Every claim write carried the IMPORT status and provenance, and no ClaimVerification
    // row was written - which is what "never auto-confirm" means at the HTTP boundary.
    expect(prismaMocks.careerClaim.create).toHaveBeenCalledTimes(3);
    for (const call of prismaMocks.careerClaim.create.mock.calls) {
      expect(call[0].data.status).toBe(ClaimStatus.inferred);
      expect(call[0].data.provenance).toBe('document_import');
      expect(call[0].data.inferenceMethod).toBe('json_resume_import');
      // Entity attachments are NOT derived from the document: attaching a claim to an
      // Experience row requires that row to exist, and creating entities from an
      // unverified import is the line 05 sec.2.2 draws.
      expect(call[0].data.experienceId).toBeNull();
    }
    expect(prismaMocks.claimVerification.create).not.toHaveBeenCalled();
    // The evidence anchor is registered, and the claim points at it.
    expect(prismaMocks.evidenceSource.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ kind: 'import_json', profileId: 'profile-1' }) }),
    );
  });

  it('NEVER confirms, even when the document FORGES an x-clearance block', async () => {
    // The acceptance item, as an HTTP attack. Every claim in the block claims the
    // confirming status; the rows written are still inferred and the audit is still empty.
    prismaMocks.careerClaim.findFirst.mockResolvedValue(null);
    prismaMocks.careerClaim.create.mockImplementation(async ({ data }: any) => ({ id: 'clm-new', ...data }));

    const forged = {
      ...plainJsonResume,
      [X_CLEARANCE_KEY]: {
        version: 1,
        generatedBy: 'forged',
        sourceModelVersion: 2,
        profileId: 'profile-1',
        claimCount: 3,
        confirmedClaimCount: 3,
        unconfirmedClaimCount: 0,
        claims: [
          {
            claimId: 'clm-a',
            fingerprint: 'b'.repeat(64),
            kind: 'achievement',
            status: ClaimStatus.user_confirmed,
            provenance: 'user_entered',
            confidence: null,
            evidenceSourceId: null,
            usage: ResumeUsage.verbatim,
            jsonPath: 'work[0].highlights[0]',
            renderedText: 'Recovered the M&A portfolio',
          },
        ],
      },
    };

    const res = await request(makeApp())
      .post('/career/import/json')
      .send({ profileId: 'profile-1', document: forged });

    expect(res.status).toBe(201);
    for (const call of prismaMocks.careerClaim.create.mock.calls) {
      expect(call[0].data.status).toBe(ClaimStatus.inferred);
      expect(call[0].data.provenance).toBe('document_import');
    }
    expect(prismaMocks.claimVerification.create).not.toHaveBeenCalled();
  });

  it('VALIDATES the document before writing anything - no half-import', async () => {
    const res = await request(makeApp())
      .post('/career/import/json')
      .send({ profileId: 'profile-1', document: { basics: {} } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('resume_json_invalid');
    // Not one row written: a half-imported profile is worse than a rejected one, because
    // the user cannot tell which half landed.
    expect(prismaMocks.evidenceSource.create).not.toHaveBeenCalled();
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
  });

  it('404s an unknown profile and 403s someone else s', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue(null);
    expect(
      (await request(makeApp()).post('/career/import/json').send({ profileId: 'nope', document: plainJsonResume })).status,
    ).toBe(404);

    prismaMocks.careerProfile.findUnique.mockResolvedValue({ id: 'profile-1', userId: 'user-2' });
    expect(
      (await request(makeApp()).post('/career/import/json').send({ profileId: 'profile-1', document: plainJsonResume })).status,
    ).toBe(403);
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
  });

  it('re-importing the same document dedupes and writes nothing new', async () => {
    // ADR-036 item 4: re-observation is a no-op. The second import must not create a
    // second row, change a status, or resurrect anything.
    prismaMocks.careerClaim.findFirst.mockResolvedValue(claimRow());
    const res = await request(makeApp())
      .post('/career/import/json')
      .send({ profileId: 'profile-1', document: plainJsonResume });
    expect(res.status).toBe(201);
    expect(res.body.claims.created).toBe(0);
    expect(res.body.claims.deduped).toBe(3);
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
    // The route's prisma surface exposes no status setter a re-import could reach, so
    // there is nowhere to write one even if the dedupe had returned an existing row.
    expect((prismaMocks.careerClaim as Record<string, unknown>).update).toBeUndefined();
  });

  it('rejects a request that does not match the envelope schema', async () => {
    const res = await request(makeApp()).post('/career/import/json').send({ document: plainJsonResume });
    expect(res.status).toBe(400);
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /resumes/:id/project - the preview surface
// ---------------------------------------------------------------------------

describe('POST /resumes/:id/project', () => {
  it('projects the profile without writing a revision, and reports the counts', async () => {
    for (const delegate of ['experience', 'education', 'project', 'skill', 'certification'] as const) {
      prismaMocks[delegate].findMany.mockResolvedValue([]);
    }
    prismaMocks.careerProfile.findUnique.mockResolvedValue({
      id: 'profile-1',
      userId: 'user-1',
      headline: 'Staff Engineer',
      summary: 'Builds things.',
      seniority: null,
    });
    prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow()]);

    const res = await request(makeApp()).post('/res-1/project').send({});
    expect(res.status).toBe(200);
    expect(res.body.document.basics.name).toBe('Staff Engineer');
    expect(res.body.validation.valid).toBe(true);
    // A projection is not a revision, so NOTHING was written.
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
    expect(res.body.gate.allowed).toBe(true);
  });

  it('a LEGACY modelVersion 1 resume previews as an ALL-INFERRED draft, and says it is not persisted', async () => {
    // 05 sec.7.7: the legacy backfill must show the user an unverified draft. The preview
    // does NOT persist the drafts - a preview that wrote claims would be a surprise.
    prismaMocks.resume.findUnique.mockResolvedValue({
      id: 'res-legacy',
      userId: 'user-1',
      modelVersion: 1,
      profileId: null,
      name: 'Old Resume',
      personalInfo: { fullName: 'Grace Hopper', email: 'g@example.com', phone: '', location: 'New York' },
      summary: 'Invented the compiler.',
      experience: [{ title: 'Rear Admiral', company: 'US Navy', bullets: ['Designed the COBOL compiler'] }],
      education: [],
      skills: ['COBOL'],
    });

    const res = await request(makeApp()).post('/res-legacy/project').send({});
    expect(res.status).toBe(200);
    expect(res.body.modelVersion).toBe(1);
    expect(res.body.document.basics.name).toBe('Grace Hopper');
    // Every backfill claim is inferred, and the block says so.
    for (const entry of res.body.document[X_CLEARANCE_KEY].claims) {
      expect(entry.status).toBe(ClaimStatus.inferred);
      expect(entry.provenance).toBe('document_import');
    }
    // F5. The `gate` object is now the REAL verdict from `evaluatePreRenderGate` over the
    // usages the projection placed, and every legacy draft is `usage: omitted` - which the
    // gate returns on BEFORE the status check. So it allows, and `rendered` is 0.
    //
    // The old response hand-wrote `{allowed: false, reason: 'CLAIM_NOT_CONFIRMED',
    // violations: [every draft]}`: a verdict the gate has no branch that can produce, and
    // a `violations` list of entries classified as allowed. A client rendering that as
    // "these are blocking" was told that an `omitted` claim can block.
    expect(res.body.gate).toMatchObject({ allowed: true, rendered: 0 });
    expect(res.body.gate.violations).toBeUndefined();
    // ...and "not renderable yet" is now stated as the FACT it is: the drafts are not
    // rows, so there is no usage log for a gate to read.
    expect(res.body.backfill).toMatchObject({ persisted: false });
    expect(res.body.backfill.claimDrafts).toBeGreaterThan(0);
    expect(res.body.backfill.note).toMatch(/DRAFTS, not rows/);
    // Nothing was written.
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('the V2 projection preview reports the REAL gate verdict, with the unconfirmed count beside it', async () => {
    // F5, other branch. The projection places a confirmed claim verbatim, so the real
    // gate allows it - and `unconfirmed` is reported separately as a hint rather than
    // being the verdict.
    for (const delegate of ['experience', 'education', 'project', 'skill', 'certification'] as const) {
      prismaMocks[delegate].findMany.mockResolvedValue([]);
    }
    prismaMocks.careerProfile.findUnique.mockResolvedValue({
      id: 'profile-1',
      userId: 'user-1',
      headline: 'Staff Engineer',
      summary: 'Builds things.',
      seniority: null,
    });
    prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow()]);

    const res = await request(makeApp()).post('/res-1/project').send({});
    expect(res.status).toBe(200);
    expect(res.body.gate).toMatchObject({ allowed: true, checked: 1, rendered: 0, unconfirmed: 0 });
    expect(res.body.gate.violations).toBeUndefined();

    // The NEGATIVE half, which is what makes the above a verdict rather than a constant:
    // an inferred claim ATTACHED to a work entry (so the projector places it `verbatim`,
    // not `omitted`) at a non-confirmed status, and the real gate refuses it with the
    // claim in `violations`.
    prismaMocks.experience.findMany.mockResolvedValue([
      { id: 'exp-1', company: 'Acme', title: 'Engineer', startDate: '2020-01', endDate: null, current: true, location: null, sortOrder: 0 },
    ]);
    prismaMocks.careerClaim.findMany.mockResolvedValue([
      claimRow({ status: ClaimStatus.inferred, experienceId: 'exp-1' }),
    ]);
    const blocked = await request(makeApp()).post('/res-1/project').send({});
    expect(blocked.body.gate.allowed).toBe(false);
    expect(blocked.body.gate.reason).toBe('CLAIM_NOT_CONFIRMED');
    expect(blocked.body.gate.violations).toHaveLength(1);
    expect(blocked.body.gate.unconfirmed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /resumes/:id/upgrade - UPGRADE-ON-OPEN (T1110)
// ---------------------------------------------------------------------------
//
// WHY THIS BLOCK EXISTS. The frontend cutover made `/app/build/:resumeId` REDIRECT to
// `/app/studio/:resumeId`, and the Studio reads `GET /revisions`. A `modelVersion = 1` row has
// none, so without this route the redirect is a dead end for precisely the resumes that existed
// before the cutover. So this route is what makes the redirect honest - and the tests below pin
// the three properties that make it HONEST rather than convenient:
//
//   1. EVERY BACKFILLED CLAIM IS `inferred`. Not "the response says inferred" - the ROWS. Every
//      `careerClaim.create` call is inspected for its `status` and `provenance`.
//   2. ZERO `ClaimVerification` rows. The confirming write lives only in the user's own decision
//      path, so "the upgrade auto-confirms a claim" is not merely untrue here, it is
//      unrepresentable; this asserts the absence so a future refactor cannot add it silently.
//   3. THE BELT. Revision 1 goes through `createRevision`, which runs the same pre-insert checks
//      as any other revision. A document the belt would refuse leaves NO revision and NO
//      `modelVersion: 2` row.

/** A `modelVersion = 1` `Resume` row, as the frozen legacy builder wrote it. */
function legacyResumeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-legacy',
    userId: 'user-1',
    modelVersion: 1,
    profileId: null,
    name: 'Old Resume',
    personalInfo: {
      fullName: 'Grace Hopper',
      email: 'grace@example.com',
      phone: '',
      location: 'New York',
    },
    summary: 'Invented the compiler.',
    experience: [
      { title: 'Rear Admiral', company: 'US Navy', bullets: ['Designed the COBOL compiler'] },
    ],
    education: [],
    skills: ['COBOL'],
    ...overrides,
  };
}

/**
 * Make the mocks describe a legacy upgrade end to end.
 *
 * `careerClaim.create` records what was actually inserted and `careerClaim.findMany` then
 * returns those rows, which is what makes assertion 1 above a statement about the ROWS rather
 * than about the response body: `loadProjectionInput` reads them back, so a status the route
 * tried to sneak past would show up in the document's `x-clearance` block too.
 */
function seedLegacyUpgrade() {
  prismaMocks.resume.findUnique.mockImplementation(async ({ where, select }: any) =>
    // `requireOwnedResume` selects the five columns it needs; `loadLegacyResume` selects
    // nothing and wants the whole legacy row. One delegate, two shapes.
    select ? { id: 'res-legacy', userId: 'user-1', modelVersion: 1, profileId: null, name: 'Old Resume' } : legacyResumeRow({ id: where.id }),
  );
  prismaMocks.resume.update.mockImplementation(async ({ where, data }: any) => {
    const row = { id: where.id, name: 'Old Resume', modelVersion: data.modelVersion, profileId: data.profileId };
    resumeRows.rows.push(row);
    return row;
  });
  for (const delegate of ['experience', 'education', 'project', 'skill', 'certification'] as const) {
    prismaMocks[delegate].findMany.mockResolvedValue([]);
  }
  prismaMocks.careerProfile.findUnique.mockResolvedValue({
    id: 'profile-1',
    userId: 'user-1',
    headline: null,
    summary: null,
    seniority: null,
  });
  prismaMocks.careerClaim.findFirst.mockResolvedValue(null);
  prismaMocks.evidenceSource.findFirst.mockResolvedValue(null);
  prismaMocks.evidenceSource.create.mockImplementation(async ({ data }: any) => ({ id: 'evd-legacy', ...data }));
  prismaMocks.resumeClaimUsage.create.mockImplementation(async ({ data }: any) => ({ id: 'usg-x', ...data }));
  const inserted: Array<Record<string, unknown>> = [];
  prismaMocks.careerClaim.create.mockImplementation(async ({ data }: any) => {
    const row = {
      id: `clm-${inserted.length + 1}`,
      experienceId: null,
      educationId: null,
      projectId: null,
      skillId: null,
      certificationId: null,
      achievementId: null,
      createdAt: new Date('2026-10-05T09:00:00.000Z'),
      updatedAt: new Date('2026-10-05T09:00:00.000Z'),
      ...data,
    };
    inserted.push(row);
    return row;
  });
  prismaMocks.careerClaim.findMany.mockImplementation(async () => inserted);
  return inserted;
}

describe('POST /resumes/:id/upgrade', () => {
  it('a V1 row gets its FIRST V2 revision, and the document is all-inferred', async () => {
    const inserted = seedLegacyUpgrade();

    const res = await request(makeApp()).post('/res-legacy/upgrade').send({});

    expect(res.status).toBe(201);
    expect(res.body.upgraded).toBe(true);
    // The row is now V2 and attached to the profile, and revision 1 exists.
    expect(res.body.resume).toMatchObject({ id: 'res-legacy', modelVersion: 2, profileId: 'profile-1' });
    expect(res.body.revision.revisionNumber).toBe(1);
    expect(res.body.validation.valid).toBe(true);

    // THE POINT. Every claim the backfill wrote is `inferred` + `document_import` - asserted on
    // the ROWS, not on the echoed body, so a status the route tried to sneak past fails here.
    expect(inserted.length).toBeGreaterThan(0);
    for (const claim of inserted) {
      expect(claim.status).toBe(ClaimStatus.inferred);
      expect(claim.provenance).toBe('document_import');
      expect(claim.inferenceMethod).toBe('legacy_resume_backfill');
    }
    expect(res.body.statusAssigned).toBe(ClaimStatus.inferred);

    // ...and the same is true of the DOCUMENT's own block, which is what the gate and the
    // Studio's client-side guard read.
    const block = res.body.revision.document[X_CLEARANCE_KEY];
    expect(block.claims.length).toBeGreaterThan(0);
    for (const entry of block.claims) {
      expect(entry.status).toBe(ClaimStatus.inferred);
    }
    expect(block.confirmedClaimCount).toBe(0);
    expect(block.unconfirmedClaimCount).toBe(block.claims.length);
  });

  it('writes ZERO ClaimVerification rows - the upgrade confirms nothing, ever', async () => {
    seedLegacyUpgrade();
    await request(makeApp()).post('/res-legacy/upgrade').send({});
    // A confirming status REQUIRES a verification row (ADR-036 item 2), so this is the
    // mechanical proof that no claim in the revision above is confirmed, by any route.
    expect(prismaMocks.claimVerification.create).not.toHaveBeenCalled();
  });

  it('the revision goes through createRevision (the belt), not a direct insert', async () => {
    seedLegacyUpgrade();
    await request(makeApp()).post('/res-legacy/upgrade').send({});
    // `resumeRevision.create` is the ONLY delegate the belt writes through. Asserting it was
    // called proves the write path, and the negative below proves nothing else wrote a revision.
    expect(prismaMocks.resumeRevision.create).toHaveBeenCalledTimes(1);
    const data = prismaMocks.resumeRevision.create.mock.calls[0][0].data;
    expect(data.resumeJson).toBeDefined();
    expect(data.jsonHash).toBe(canonicalJsonHash(data.resumeJson));
  });

  it("the user's OWN content is what lands in basics, not 'Unnamed'", async () => {
    // The profile a V1-era user upgrades into is EMPTY. Projecting from it would replace their
    // name and summary with placeholders, so `basics` comes from the legacy row instead.
    seedLegacyUpgrade();
    const res = await request(makeApp()).post('/res-legacy/upgrade').send({});
    expect(res.body.revision.document.basics.name).toBe('Grace Hopper');
    expect(res.body.revision.document.basics.summary).toBe('Invented the compiler.');
  });

  it('the summary is on the claim rail, so the belt can see it', async () => {
    // ADR-043 R-SUMMARY: a summary string with no claim naming it is `DOCUMENT_UNAUDITED` at
    // write time. The legacy backfill emits the summary as a `soft_skill` draft, which is what
    // keeps this passing - so the route must not filter that draft out.
    const inserted = seedLegacyUpgrade();
    await request(makeApp()).post('/res-legacy/upgrade').send({});
    expect(inserted.some((claim) => claim.kind === 'soft_skill' && claim.statement === 'Invented the compiler.')).toBe(true);
  });

  it('is IDEMPOTENT: a second call writes nothing and returns the current revision', async () => {
    // Re-projecting would replace whatever the user has since edited with a fresh projection of
    // the same legacy row - the backfill silently undoing work. So the second call reports.
    seedLegacyUpgrade();
    await request(makeApp()).post('/res-legacy/upgrade').send({});
    const claimsAfterFirst = prismaMocks.careerClaim.create.mock.calls.length;
    const revisionsAfterFirst = prismaMocks.resumeRevision.create.mock.calls.length;

    // The row is now V2 with a profile, and `getCurrentRevision` resolves.
    prismaMocks.resume.findUnique.mockImplementation(async ({ where, select }: any) =>
      select
        ? { id: 'res-legacy', userId: 'user-1', modelVersion: 2, profileId: 'profile-1', name: 'Old Resume' }
        : legacyResumeRow({ id: where.id }),
    );
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(
      revisionRow({ id: 'rev-legacy-1', resumeId: 'res-legacy', revisionNumber: 1 }),
    );

    const second = await request(makeApp()).post('/res-legacy/upgrade').send({});
    expect(second.status).toBe(200);
    expect(second.body.upgraded).toBe(false);
    expect(second.body.reason).toBe('already_upgraded');
    expect(second.body.claims).toBeNull();
    expect(second.body.revision.id).toBe('rev-legacy-1');
    expect(prismaMocks.careerClaim.create.mock.calls.length).toBe(claimsAfterFirst);
    expect(prismaMocks.resumeRevision.create.mock.calls.length).toBe(revisionsAfterFirst);
  });

  it('creates the CareerProfile when the user has none, so the redirect is never a dead end', async () => {
    // A V1-era user's first upgrade: there is no profile yet. Refusing here would 404 exactly the
    // resumes the cutover redirected, which is the failure this route exists to remove.
    seedLegacyUpgrade();
    // The `byUserId` lookup misses (no profile yet); the route creates one; the projector then
    // reads it back BY ID. Both shapes are exercised here, which is why the mock keys on `where`.
    prismaMocks.careerProfile.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'profile-new'
        ? { id: 'profile-new', userId: 'user-1', headline: null, summary: null, seniority: null }
        : null,
    );
    prismaMocks.careerProfile.create.mockResolvedValue({ id: 'profile-new', userId: 'user-1', headline: null });

    const res = await request(makeApp()).post('/res-legacy/upgrade').send({});
    expect(res.status).toBe(201);
    expect(res.body.resume.profileId).toBe('profile-new');
    expect(prismaMocks.careerProfile.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to backfill into another tenant\'s profile', async () => {
    seedLegacyUpgrade();
    prismaMocks.careerProfile.findUnique.mockResolvedValue({ id: 'profile-x', userId: 'user-2', headline: null });
    const res = await request(makeApp()).post('/res-legacy/upgrade').send({ profileId: 'profile-x' });
    expect(res.status).toBe(403);
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
  });

  it('leaves NO half-upgraded resume when the belt refuses the document', async () => {
    // F4. The `Resume` update and the revision are ONE transaction. If `createRevision` throws,
    // a `modelVersion: 2` row with no revision survives - which is precisely the dead end this
    // route was added to remove, reproduced at its own source.
    seedLegacyUpgrade();
    prismaMocks.resumeRevision.create.mockImplementation(async () => {
      // One of the belt's OWN refusal reasons (`ResumeRevisionError.reason`), thrown from the
      // delegate the belt writes through - so what is under test is the transaction boundary,
      // not a synthetic error.
      throw new ResumeRevisionError(
        'CLEARANCE_DISAGREES_WITH_CLAIMS',
        "the document's x-clearance block and the CareerClaim rows are not the same set of claims",
      );
    });

    const res = await request(makeApp()).post('/res-legacy/upgrade').send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(resumeRows.rows, 'an orphaned modelVersion: 2 resume survived a refused revision').toEqual([]);
  });
});
