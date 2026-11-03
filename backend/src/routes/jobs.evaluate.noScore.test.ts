// T1101 - THE LAST SCORE SURFACE ON THE WIRE.
//
// `POST /jobs/:id/evaluate` used to answer 201 with `overallScore` (a weighted 1-5) plus a `scores`
// object holding six more per-dimension numbers, and `GET /jobs/evaluations` returned the raw
// `JobEvaluation` rows, which carry every score COLUMN on the model. `reportJson` made it worse: it
// is the evaluator's whole parsed JSON object, so the same seven numbers were on the wire a second
// time one level deeper. `routes/jobs.ts` now projects all of it away (`JobEvaluationWire` /
// `toEvaluationWire`); this file is the guard that keeps it away.
//
// IT MIRRORS `routes/ats.noVerdict.test.ts` deliberately, because that is the file that already
// retired the same class of surface from `/ats/*` and `/job-match/*`. Same discipline, same shape of
// assertion, same "prove the signal is still COMPUTED and still STORED" half - which is what
// FREEZE B-16 requires and what T1101's acceptance ("the internal scorers still function") asks for.
//
// THE THREE ASSERTION FAMILIES, and why all three are here:
//
//   1. THE KEY SET, exactly. A new member cannot appear without the list changing. This is the
//      cheapest possible pin and the one that survives refactors.
//   2. NO NUMBER AT ANY DEPTH, walked recursively. This is what actually closes `reportJson`: a key
//      that is spelled innocuously and holds 4.2 is the same verdict, and a member list is a list
//      somebody forgets to extend.
//   3. NO VERDICT-SHAPED KEY at any depth. The counterpart to (2): if a number ever arrived as a
//      STRING ("4.2 / 5.0"), (2) would pass and (3) would not.
//
// AND THE NON-VACUITY HALF: the fixtures carry a real 75 and real 1-5s in every one of the seven
// places they can appear, so "no number in the body" is a fact about the projection and not an
// accident of an empty fixture.
import { describe, it, expect, assert, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { prismaMocks, evaluateJobMock, checkLivenessMock, createArgs } = vi.hoisted(() => ({
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn(), groupBy: vi.fn() },
    resume: { findUnique: vi.fn() },
    aIProviderKey: { findFirst: vi.fn() },
    careerProfile: { findUnique: vi.fn() },
    jobEvaluation: { create: vi.fn(), findMany: vi.fn() },
  },
  evaluateJobMock: vi.fn(),
  checkLivenessMock: vi.fn(),
  createArgs: [] as Array<Record<string, unknown>>,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

vi.mock('../ai/evaluation.js', () => ({
  evaluateJob: (...args: any[]) => evaluateJobMock(...args),
}));

vi.mock('../jobSources/liveness.js', () => ({
  checkLiveness: (...args: any[]) => checkLivenessMock(...args),
}));

// Health writes must never fail the request; stub them to no-ops.
vi.mock('../jobSources/sourceHealth.js', () => ({
  recordSourceSuccess: vi.fn(),
  recordSourceFailure: vi.fn(),
}));

import jobsRouter from './jobs.js';

/** Comments removed, and nothing else - so a module that only DISCUSSES a name does not fail a grep. */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

const RESUME_ID = '123e4567-e89b-12d3-a456-426614174000';
const LONG_DESCRIPTION = 'Senior backend engineer role. '.repeat(10);

/**
 * The evaluator's own output, with all seven numbers in it.
 *
 * `reportJson` is a verbatim copy of the parsed LLM JSON (see `ai/evaluation.ts`: `reportJson:
 * parsed`), so the same seven numbers appear there a second time. A fixture without them would let
 * the guard pass on absence, which is the failure mode `ats.noVerdict.test.ts` explicitly calls out.
 */
const EVALUATION = {
  roleSummary: 'A senior backend role owning the payments platform.',
  cvMatchScore: 4,
  levelFitScore: 5,
  compFitScore: 3,
  personalizationScore: 4,
  interviewPrepScore: 3,
  legitimacyScore: 2,
  overallScore: 4.2,
  recommendation: 'maybe',
  isScam: true,
  reportJson: {
    roleSummary: 'A senior backend role owning the payments platform.',
    cvMatchScore: 4,
    levelFitScore: 5,
    compFitScore: 3,
    personalizationScore: 4,
    interviewPrepScore: 3,
    legitimacyScore: 2,
    overallScore: 4.2,
    recommendation: 'maybe',
    isScam: true,
    interviewPrepBullets: [
      'STAR+R: describe a production incident you owned end to end.',
      'STAR+R: a time you pushed back on a requirement.',
    ],
    compNotes: 'Band is published; the midpoint is market for the level.',
    redFlags: ['No named interviewer', 'Salary band withheld'],
  },
};

/** The same seven numbers, as `prisma.jobEvaluation.create` returns them (they are STORED). */
const STORED_ROW = {
  id: 'eval-1',
  userId: 'user-1',
  jobListingId: 'listing-1',
  resumeId: RESUME_ID,
  roleSummary: EVALUATION.roleSummary,
  cvMatchScore: EVALUATION.cvMatchScore,
  levelFitScore: EVALUATION.levelFitScore,
  compFitScore: EVALUATION.compFitScore,
  personalizationScore: EVALUATION.personalizationScore,
  interviewPrepScore: EVALUATION.interviewPrepScore,
  legitimacyScore: EVALUATION.legitimacyScore,
  overallScore: EVALUATION.overallScore,
  recommendation: EVALUATION.recommendation,
  isScam: EVALUATION.isScam,
  reportJson: EVALUATION.reportJson,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
};

/** Keys that would be a verdict, grade or percentage wherever they appear. */
const FORBIDDEN_KEYS = [
  'overallScore',
  'scores',
  'status',
  'matchScore',
  'lastATSScore',
  'score',
  'grade',
  'percentage',
  'cvMatch',
  'levelFit',
  'compFit',
  'personalization',
  'interviewPrep',
  'legitimacy',
  'cvMatchScore',
  'levelFitScore',
  'compFitScore',
  'personalizationScore',
  'interviewPrepScore',
  'legitimacyScore',
];

/** Every NUMBER leaf in a subtree, as a dotted path. `[]` means the body is number-free. */
function numberLeaves(node: unknown, path = '$'): string[] {
  if (typeof node === 'number') return [path];
  if (Array.isArray(node)) return node.flatMap((item, at) => numberLeaves(item, `${path}[${at}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
      numberLeaves(value, `${path}.${key}`),
    );
  }
  return [];
}

/** Every verdict-SHAPED KEY in a subtree, at any depth, as a dotted path. */
function verdictKeys(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((item, at) => verdictKeys(item, `${path}[${at}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => [
      ...(FORBIDDEN_KEYS.includes(key) ? [`${path}.${key}`] : []),
      ...verdictKeys(value, `${path}.${key}`),
    ]);
  }
  return [];
}

/** Assert on the PARSED body: no verdict key anywhere, and no number anywhere. */
function assertHonest(body: unknown, where: string): void {
  expect([`${where} numbers`, numberLeaves(body)]).toEqual([`${where} numbers`, []]);
  expect([`${where} verdict keys`, verdictKeys(body)]).toEqual([`${where} verdict keys`, []]);
}

beforeEach(() => {
  vi.clearAllMocks();
  createArgs.length = 0;
  prismaMocks.jobListing.findUnique.mockResolvedValue({
    id: 'listing-1',
    source: 'greenhouse',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: LONG_DESCRIPTION,
    applyUrl: 'https://example.com/jobs/1',
    sourceUrl: 'https://example.com/jobs/1',
    isActive: true,
  });
  prismaMocks.jobListing.update.mockImplementation(async ({ data }: any) => ({ id: 'listing-1', ...data }));
  prismaMocks.resume.findUnique.mockResolvedValue({ id: RESUME_ID, userId: 'user-1', name: 'My Resume' });
  prismaMocks.aIProviderKey.findFirst.mockResolvedValue(null);
  prismaMocks.careerProfile.findUnique.mockResolvedValue(null);
  prismaMocks.jobEvaluation.create.mockImplementation(async ({ data }: any) => {
    createArgs.push(data);
    // The REAL prisma call returns the row it wrote, numbers and all - which is why the
    // projection has to be in the route rather than in the write.
    return { ...STORED_ROW, ...data };
  });
  prismaMocks.jobEvaluation.findMany.mockResolvedValue([
    { ...STORED_ROW, jobListing: { title: 'Backend Engineer', company: 'Acme', applyUrl: 'https://example.com/jobs/1' } },
  ]);
  checkLivenessMock.mockResolvedValue(true);
  evaluateJobMock.mockResolvedValue({ ...EVALUATION });
});

async function evaluate() {
  return request(makeApp())
    .post('/jobs/listing-1/evaluate')
    .send({ resumeId: RESUME_ID, jobDescription: LONG_DESCRIPTION });
}

describe('POST /jobs/:id/evaluate returns no derived number', () => {
  it('the 201 body is exactly the honest member set - no `overallScore`, no `scores`', async () => {
    const res = await evaluate();

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'id',
      'isScam',
      'recommendation',
      'reportJson',
      'roleSummary',
    ]);
  });

  it('the wire TYPE declares no verdict member, so the projection cannot be forgotten', () => {
    // The behavioural tests above cover the handlers they drive. This covers the TYPE, which is what
    // makes the projection structural rather than a promise: a response cannot leak a verdict
    // through a member the type does not declare. Read out of the source rather than re-typed here,
    // so renaming or reordering a member changes this list instead of silently passing.
    const code = codeOnly(readFileSync(path.join(__dirname, 'jobs.ts'), 'utf8'));
    const block = code.match(/export interface JobEvaluationWire \{[\s\S]*?\n\}/);
    assert.ok(block, 'expected JobEvaluationWire to still be declared');

    const members = [...block![0].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\??\s*:/gm)].map((m) => m[1]);
    expect(members.sort()).toEqual(['id', 'isScam', 'recommendation', 'reportJson', 'roleSummary']);
    for (const banned of ['overallScore', 'scores', 'cvMatchScore', 'legitimacyScore']) {
      expect([banned, members.includes(banned)]).toEqual([banned, false]);
    }
    // `overallScore` is in this file only as the comment that says the write is unchanged, and
    // `scores` not at all - so the module mentions the retired name without USING it as a response
    // member. `jobs.ts` still WRITES all seven columns, which the storage test below pins, so this
    // is not a grep that passes because the names are absent from the file.
    expect(code).toMatch(/overallScore: result\.overallScore/);
  });

  it('the qualitative substance survives: the recommendation, the scam flag and the prose', async () => {
    const res = await evaluate();

    // The decision the evaluator made - categorical, not a number the reader must interpret.
    expect(res.body.recommendation).toBe('maybe');
    expect(['apply', 'maybe', 'skip']).toContain(res.body.recommendation);
    // A yes/no fact about the listing.
    expect(res.body.isScam).toBe(true);
    expect(res.body.roleSummary).toBe(EVALUATION.roleSummary);
    // The prose the UI renders: interview-prep prompts and named red flags. These are SENTENCES and
    // are exactly what replaced the six-dimension rubric on screen.
    expect(res.body.reportJson.interviewPrepBullets).toEqual(EVALUATION.reportJson.interviewPrepBullets);
    expect(res.body.reportJson.redFlags).toEqual(EVALUATION.reportJson.redFlags);
    expect(res.body.reportJson.compNotes).toBe(EVALUATION.reportJson.compNotes);
    // The recommendation and the scam flag are still there INSIDE reportJson as well.
    expect(res.body.reportJson.recommendation).toBe('maybe');
    expect(res.body.reportJson.isScam).toBe(true);
  });

  it('there is no number at ANY depth - `reportJson` included', async () => {
    const res = await evaluate();

    // Non-vacuity first: the fixture really does carry 4.2 and five 1-5s, twice over.
    expect(EVALUATION.overallScore).toBe(4.2);
    expect(EVALUATION.reportJson.overallScore).toBe(4.2);
    expect(Object.values(EVALUATION.reportJson).filter((v) => typeof v === 'number').length).toBe(7);

    assertHonest(res.body, 'POST /jobs/:id/evaluate');
    expect(JSON.stringify(res.body)).not.toContain('4.2');
  });

  it('the numbers are still COMPUTED and still STORED on the row (FREEZE B-16)', async () => {
    await evaluate();

    expect(evaluateJobMock).toHaveBeenCalledTimes(1);
    expect(createArgs).toHaveLength(1);
    const written = createArgs[0];
    for (const column of [
      'overallScore',
      'cvMatchScore',
      'levelFitScore',
      'compFitScore',
      'personalizationScore',
      'interviewPrepScore',
      'legitimacyScore',
    ]) {
      expect([column, typeof written[column]]).toEqual([column, 'number']);
    }
    expect(written.overallScore).toBe(4.2);
    // The stored `reportJson` keeps its numbers too - the historical record is not rewritten, and
    // no row is deleted. Only the WIRE changed.
    expect((written.reportJson as any).overallScore).toBe(4.2);
    // The verdict and the fact are stored as well, so nothing about the evaluation was lost.
    expect(written.recommendation).toBe('maybe');
    expect(written.isScam).toBe(true);
  });
});

describe('GET /jobs/evaluations returns no derived number', () => {
  it('omits every score column, on a POPULATED row', async () => {
    const res = await request(makeApp()).get('/jobs/evaluations');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // The fixture row really carries the numbers, so this is not passing on absence.
    expect(STORED_ROW.overallScore).toBe(4.2);
    expect(STORED_ROW.cvMatchScore).toBe(4);
    assertHonest(res.body, 'GET /jobs/evaluations');

    // The identifying and qualitative members survive - the list is the same list, minus the verdict.
    expect(res.body[0]).toMatchObject({
      id: 'eval-1',
      userId: 'user-1',
      jobListingId: 'listing-1',
      resumeId: RESUME_ID,
      recommendation: 'maybe',
      isScam: true,
      roleSummary: EVALUATION.roleSummary,
      jobListing: { title: 'Backend Engineer', company: 'Acme' },
    });
    expect(res.body[0].reportJson.redFlags).toEqual(EVALUATION.reportJson.redFlags);
  });

  it('does not even SELECT the score columns off the row', async () => {
    await request(makeApp()).get('/jobs/evaluations');

    const select = prismaMocks.jobEvaluation.findMany.mock.calls[0]![0].select;
    for (const column of ['overallScore', 'cvMatchScore', 'levelFitScore', 'compFitScore', 'personalizationScore', 'interviewPrepScore', 'legitimacyScore']) {
      expect([column, Object.prototype.hasOwnProperty.call(select, column)]).toEqual([column, false]);
    }
    // ...and it still selects the members it does send, so this is not a SELECT of nothing.
    for (const column of ['id', 'recommendation', 'isScam', 'roleSummary', 'reportJson']) {
      expect([column, Object.prototype.hasOwnProperty.call(select, column)]).toEqual([column, true]);
    }
  });
});
