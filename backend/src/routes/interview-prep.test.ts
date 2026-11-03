// =====================================================================================
// routes/interview-prep.test.ts - THE HTTP SURFACE OF INTERVIEW PREP (T1090).
//
// NOT A DUPLICATE OF THE TWO SERVICE SUITES. Those prove the derivation and the post-check;
// this proves what a CLIENT can observe, and five things only the route can be responsible
// for:
//
//   1. AUTH AND MOUNTING. Both routes are behind `requireAuth`, proven by a real 401 through
//      the real middleware, and by a source guard over the file.
//   2. THE ENVELOPE IS VALIDATED. `.strict()` proven through `score: true` - the exact request
//      a caller reaching for a verdict would send - and through a missing `resumeId`.
//   3. A FOREIGN id IS A 404, NOT A 403, on both routes, and a FOREIGN match report is a 404
//      too: this view quotes a person's career statements, so a probe must not learn that a row
//      exists. That is why the route does NOT use `shared/auth.ts#ensureOwnership`, which would
//      answer 403.
//   4. NO SCORE. The response type has no verdict-shaped member, and this file greps the route
//      for the field names 06 sec. E.6 bans.
//   5. THE PERSISTENCE IS HONEST: the risks carry their anchors into `evidenceRefs`, a refused
//      answer is stored as an EMPTY column and reported as `null`, a second POST REPLACES the
//      first rather than stacking a duplicate list, and a GET re-asserts the anchor invariant
//      on the rows it reads back.
//
// The prisma singleton is mocked with in-memory tables; neither `interview/risks.ts` nor
// `interview/questions.ts` is mocked, so this suite exercises the shipped modules through real
// HTTP. The only seam installed is the answer proposer, exactly as `matches.test.ts` installs
// the contextual proposer.
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
  ResumeChangeOp,
} from '@prisma/client';

import { setAnswerProposer, setRiskBriefProposer } from '../interview/questions.js';
import type { AnswerProposerInput } from '../interview/questions.js';

type Row = Record<string, unknown>;

/** A response question, narrowed so `.answerStage` is not `unknown` at every use site. */
interface QuestionRow extends Row {
  questionId: string;
  kind: string | null;
  riskId: string | null;
  requirementId: string | null;
  category: string;
  question: string;
  modelAnswer: string | null;
  groundedClaimIds: string[];
  answerStage: {
    status: string;
    reason: string;
    attempts: number;
    rejectedEntities: string[];
  };
}

/** A response risk, narrowed the same way. */
interface RiskRow extends Row {
  id: string | null;
  key: string;
  kind: string;
  severity: string;
  statement: string;
  anchors: Array<{ source: string; id: string; detail: string }>;
  requirementId: string | null;
  claimId: string | null;
}

const ROUTE_FILE = path.join(__dirname, 'interview-prep.ts');
const ROUTE_SOURCE = readFileSync(ROUTE_FILE, 'utf8');
const NOW = new Date('2026-10-03T12:00:00.000Z');

/**
 * The route's CODE, with its comments stripped.
 *
 * Same reason as the `risks.test.ts` guard: the module header NAMES the tokens it forbids, so
 * grepping the raw text would fail a well-documented file. A `//` is a comment here only at the
 * start of a line (after whitespace) or on a block-comment continuation line.
 */
const ROUTE_CODE = ROUTE_SOURCE.split('\n')
  .map((line) => (line.search(/^\s*(\/\/|\*)/) === 0 ? line.slice(0, line.search(/\S/)) : line))
  .join('\n');

/** The ungrounded-entity fixture: two entities the evidence holds, one it does not. */
const LEAKAGE_ANSWER =
  'I ran Kubernetes at Globex for years, then joined Initech where I led the same platform team.';

/** An answer that asserts no entity, so it sits inside every grounding by construction. */
const NEUTRAL_ANSWER = 'I did that work for several years and I would be glad to walk through the details.';

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const { mockUserId, prismaMock, tables } = vi.hoisted(() => {
  const t = {
    resumes: [] as Row[],
    revisions: [] as Row[],
    usages: [] as Row[],
    changes: [] as Row[],
    claims: [] as Row[],
    evidence: [] as Row[],
    jobs: [] as Row[],
    requirements: [] as Row[],
    matchReports: [] as Row[],
    potentials: [] as Row[],
    risks: [] as Row[],
    questions: [] as Row[],
    writes: [] as string[],
  };

  const matches = (row: Row, where?: Row): boolean => {
    if (where === undefined) return true;
    return Object.entries(where).every(([key, value]) => {
      if (value === undefined) return true;
      // Any `{ in: [...] }` clause is a membership test against that column, whichever column
      // it is: `id`, `profileId` and `revisionId` are all filtered this way.
      if (value !== null && typeof value === 'object') {
        const clause = value as { in?: string[] };
        return Array.isArray(clause.in) ? clause.in.includes(row[key] as string) : row[key] === value;
      }
      return row[key] === value;
    });
  };

  /**
   * Order a result set by ONE column, honouring `asc`/`desc`.
   *
   * IT HAS TO, because the change-ledger walk depends on the ORDER the chain comes back in, and
   * `getCurrentRevision` depends on the ORDER `findFirst` returns: a mock that ignored
   * `orderBy` would hand both of them insertion order, and every assertion after that point
   * would be testing the mock rather than the route.
   */
  const sorted = (found: Row[], orderBy?: Row): Row[] => {
    if (!orderBy) return found;
    const [column, direction] = Object.entries(orderBy)[0] ?? [];
    if (!column) return found;
    const sign = direction === 'desc' ? -1 : 1;
    return [...found].sort((a, b) => {
      const left = a[column];
      const right = b[column];
      if (left === right) return 0;
      return (left as never) > (right as never) ? sign : -sign;
    });
  };

  const delegate = (rows: Row[], model: string) => {
    let counter = 0;
    const nextId = (): string => `${model}-${(counter += 1)}`;
    return {
      findUnique: vi.fn(async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null),
      findFirst: vi.fn(async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) =>
        sorted(rows.filter((r) => matches(r, where)), orderBy)[0] ?? null,
      ),
      findMany: vi.fn(async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) =>
        sorted(rows.filter((r) => matches(r, where)), orderBy),
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        t.writes.push(`${model}.create`);
        const row = { id: nextId(), createdAt: new Date(), ...data };
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
      deleteMany: vi.fn(async ({ where }: { where?: Row } = {}) => {
        t.writes.push(`${model}.deleteMany`);
        const keep = rows.filter((r) => !matches(r, where));
        const count = rows.length - keep.length;
        rows.length = 0;
        rows.push(...keep);
        return { count };
      }),
    };
  };

  const models = {
    resume: delegate(t.resumes, 'resume'),
    resumeRevision: delegate(t.revisions, 'rev'),
    resumeClaimUsage: delegate(t.usages, 'usage'),
    resumeChange: delegate(t.changes, 'chg'),
    careerClaim: delegate(t.claims, 'clm'),
    evidenceSource: delegate(t.evidence, 'src'),
    job: delegate(t.jobs, 'job'),
    jobRequirement: delegate(t.requirements, 'req'),
    matchReport: delegate(t.matchReports, 'mr'),
    potentialMatch: delegate(t.potentials, 'pm'),
    interviewRisk: {
      ...delegate(t.risks, 'risk'),
      /**
       * THE CASCADE, because the SCHEMA declares it: `InterviewQuestion.riskId` is
       * `onDelete: Cascade`, so deleting a risk takes its questions with it. The mock has to
       * behave like the schema, or the "POST replaces" test would pass for the wrong reason -
       * it would be proving the mock's arithmetic rather than the route's `deleteMany`.
       */
      deleteMany: vi.fn(async ({ where }: { where?: Row } = {}) => {
        t.writes.push('risk.deleteMany');
        const keep = t.risks.filter((r) => !matches(r, where));
        const removedIds = new Set(
          t.risks.filter((r) => !keep.includes(r)).map((row) => row.id as string),
        );
        t.risks.length = 0;
        t.risks.push(...keep);
        const surviving = t.questions.filter((row) => !removedIds.has(row.riskId as string));
        t.questions.length = 0;
        t.questions.push(...surviving);
        return { count: removedIds.size };
      }),
    },
    interviewQuestion: delegate(t.questions, 'q'),
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

import interviewPrepRouter from './interview-prep.js';

// ---------------------------------------------------------------------------
// The app, mounted exactly as routes/index.ts mounts it
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/interview-prep', interviewPrepRouter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOCUMENT = {
  basics: { summary: 'Platform engineer with Kubernetes in production.' },
  work: [{ name: 'Globex', highlights: ['Reduced request latency at Globex from 900ms to 120ms'] }],
  skills: [{ name: 'Ran Kubernetes in production at Globex' }],
  'x-clearance': {
    claims: [
      {
        claimId: 'clm-lat',
        jsonPath: 'work[0].highlights[0]',
        usage: 'tailored',
        renderedText: 'Reduced request latency at Globex from 900ms to 120ms',
        status: 'user_confirmed',
      },
      {
        claimId: 'clm-k8s',
        jsonPath: 'skills[0].name',
        usage: 'verbatim',
        renderedText: 'Ran Kubernetes in production at Globex',
        status: 'user_confirmed',
      },
    ],
  },
};

function seed(): void {
  for (const rows of Object.values(tables)) {
    if (Array.isArray(rows)) rows.length = 0;
  }
  tables.writes.length = 0;

  tables.resumes.push({ id: 'res-1', userId: 'user-1', modelVersion: 2, profileId: 'prof-1' });
  tables.resumes.push({ id: 'res-foreign', userId: 'user-2', modelVersion: 2, profileId: 'prof-2' });
  tables.resumes.push({ id: 'res-legacy', userId: 'user-1', modelVersion: 1, profileId: null });

  tables.revisions.push({
    id: 'rev-1',
    resumeId: 'res-1',
    revisionNumber: 2,
    jsonHash: 'hash-1',
    resumeJson: DOCUMENT,
    createdAt: NOW,
  });
  tables.revisions.push({
    id: 'rev-legacy',
    resumeId: 'res-legacy',
    revisionNumber: 1,
    jsonHash: 'hash-legacy',
    resumeJson: {},
    createdAt: NOW,
  });

  tables.usages.push({
    id: 'usage-1',
    revisionId: 'rev-1',
    claimId: 'clm-lat',
    usage: 'tailored',
    renderedText: 'Reduced request latency at Globex from 900ms to 120ms',
  });
  tables.usages.push({
    id: 'usage-2',
    revisionId: 'rev-1',
    claimId: 'clm-k8s',
    usage: 'verbatim',
    renderedText: 'Ran Kubernetes in production at Globex',
  });

  // The LEAKAGE FIXTURE, on the change ledger: an accepted rewrite whose `after` states a figure
  // its `before` and its source claim never did.
  tables.changes.push({
    id: 'chg-leak',
    revisionId: 'rev-1',
    op: ResumeChangeOp.rewrite_bullet,
    jsonPath: 'work[0].highlights[0]',
    before: 'Cut request latency for the checkout path',
    after: 'Reduced request latency at Globex from 900ms to 120ms',
    accepted: true,
    sourceClaimIds: ['clm-lat'],
    targetRequirementIds: [],
    appliedBy: 'tailoring_engine',
    createdAt: NOW,
  });

  const oldConfirmation = new Date('2024-01-01T00:00:00.000Z');
  tables.claims.push(
    {
      id: 'clm-lat',
      profileId: 'prof-1',
      kind: ClaimKind.achievement,
      statement: 'Cut request latency for the checkout path',
      status: ClaimStatus.user_confirmed,
      provenance: ClaimProvenance.document_import,
      evidenceSourceId: 'src-1',
      confirmedAt: oldConfirmation,
      createdAt: oldConfirmation,
    },
    {
      id: 'clm-k8s',
      profileId: 'prof-1',
      kind: ClaimKind.technology,
      statement: 'Ran Kubernetes in production at Globex',
      status: ClaimStatus.user_confirmed,
      provenance: ClaimProvenance.document_import,
      evidenceSourceId: 'src-1',
      confirmedAt: oldConfirmation,
      createdAt: oldConfirmation,
    },
  );

  tables.evidence.push({
    id: 'src-1',
    profileId: 'prof-1',
    title: 'performance-review.md',
    extractedText: 'Cut request latency for the checkout path from 900ms to 120ms.',
  });

  tables.jobs.push({
    id: 'job-1',
    userId: 'user-1',
    title: 'Staff Platform Engineer',
    company: 'Acme',
    seniority: 'staff',
    sourceKind: 'pasted_text',
    contentHash: 'hash-job',
    rawText: 'jd',
    createdAt: NOW,
  });

  // TWO must-have requirements JOIN onto `clm-k8s`, because both carry the canonical key
  // `kubernetes` and "Ran Kubernetes in production at Globex" states it. That is what makes the
  // first screen `emphasized_tech` rather than an ordinary match, and `match/levels.ts` is what
  // decides it - this fixture only supplies the rows.
  tables.requirements.push(
    {
      id: 'req-k8s',
      jobId: 'job-1',
      kind: RequirementKind.technology,
      importance: RequirementImportance.must,
      text: 'Kubernetes container orchestration',
      normalizedKey: 'kubernetes',
    },
    {
      id: 'req-k8s-upgrades',
      jobId: 'job-1',
      kind: RequirementKind.required_skill,
      importance: RequirementImportance.must,
      text: 'Kubernetes cluster upgrades',
      normalizedKey: 'kubernetes',
    },
    {
      id: 'req-kafka',
      jobId: 'job-1',
      kind: RequirementKind.required_skill,
      importance: RequirementImportance.must,
      text: 'Kafka streaming',
      normalizedKey: 'kafka',
    },
  );

  tables.matchReports.push({
    id: 'mr-1',
    userId: 'user-1',
    jobId: 'job-1',
    profileId: 'prof-1',
    resumeId: 'res-1',
    createdAt: NOW,
  });
}

/** Install a proposer that answers everything with the ungrounded fixture, every attempt. */
function leakingProposer(): AnswerProposerInput[] {
  const calls: AnswerProposerInput[] = [];
  setAnswerProposer(async (input) => {
    calls.push(input);
    return {
      status: 'applied' as const,
      reason: 'ok' as const,
      provider: 'openai',
      model: 'gpt-test',
      responses: {
        schemaVersion: 'interview_question_v1',
        answers: input.questions.map((question) => ({
          questionId: question.questionId,
          modelAnswer: LEAKAGE_ANSWER,
        })),
      },
    };
  });
  return calls;
}

beforeEach(() => {
  seed();
  mockUserId.value = 'user-1';
  setRiskBriefProposer(null);
  setAnswerProposer(null);
});

// ---------------------------------------------------------------------------
// Auth, mounting, envelope
// ---------------------------------------------------------------------------

describe('auth, mounting and the envelope', () => {
  it('both routes are behind requireAuth, by the real middleware and by the source', async () => {
    mockUserId.value = null;
    expect((await request(app).post('/interview-prep').send({ resumeId: 'res-1' })).status).toBe(401);
    expect((await request(app).get('/interview-prep/res-1')).status).toBe(401);
    mockUserId.value = 'user-1';

    expect(ROUTE_CODE.match(/requireAuth, async/g)?.length).toBe(2);
    // No handler is declared without the guard between its path and its body.
    expect(ROUTE_CODE).not.toMatch(/router\.(post|get)\([^)]*\)\s*,\s*async/);
  });

  it('the route carries no verdict-shaped member (06 sec. E.6)', () => {
    for (const banned of ['score', 'percentage', 'matchScore', 'overallScore', 'totalRisk']) {
      expect([banned, ROUTE_CODE.toLowerCase().includes(banned.toLowerCase())]).toEqual([banned, false]);
    }
    // Non-vacuity: the stripper really does remove the header that names them.
    expect(ROUTE_SOURCE).toContain('no `score`');
  });

  it('`score: true` is a 400, not a silently ignored field', async () => {
    expect((await request(app).post('/interview-prep').send({ resumeId: 'res-1', score: true })).status).toBe(400);
  });

  it('a missing resumeId is a 400', async () => {
    expect((await request(app).post('/interview-prep').send({})).status).toBe(400);
  });

  it('an unknown body member is a 400', async () => {
    expect((await request(app).post('/interview-prep').send({ resumeId: 'res-1', vibes: 1 })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /interview-prep
// ---------------------------------------------------------------------------

describe('POST /interview-prep', () => {
  it('derives the risks from the revision, each with its kind, its ids and a severity', async () => {
    const response = await request(app)
      .post('/interview-prep')
      .send({ resumeId: 'res-1', matchReportId: 'mr-1' });

    expect(response.status).toBe(201);
    expect(response.body.revision).toMatchObject({
      id: 'rev-1',
      revisionNumber: 2,
      usageCount: 2,
      changeCount: 1,
    });
    expect(response.body.match).toMatchObject({
      matchReportId: 'mr-1',
      jobId: 'job-1',
      requirementCount: 3,
      gapCount: 1,
    });

    const risks = response.body.risks as RiskRow[];
    const byKind = new Map(risks.map((risk) => [risk.kind, risk]));

    // Two must-haves are `direct` on the claim that sits on the first screen.
    expect(byKind.get('emphasized_tech')).toMatchObject({ severity: 'low', claimId: 'clm-k8s' });
    // Kafka is unsupported and must-have, so it is a named gap with NO grounded claims.
    expect(byKind.get('gap')).toMatchObject({ severity: 'high', requirementId: 'req-kafka' });
    expect(byKind.get('gap')?.anchors.map((anchor) => `${anchor.source}:${anchor.id}`)).toEqual([
      'match_gap:req-kafka',
      'requirement:req-kafka',
    ]);
    // The leakage fixture, caught on BOTH the change ledger and the usage.
    expect(byKind.get('inferred_claim')).toBeDefined();
    const leakageKeys = risks.filter((risk) => risk.kind === 'inferred_claim').map((risk) => risk.key);
    expect(leakageKeys).toEqual(['resume_change:chg-leak', 'resume_claim_usage:clm-lat']);

    // Every risk names at least one row, and every anchor is a complete triple.
    for (const risk of risks) {
      expect([risk.kind, risk.anchors.length > 0]).toEqual([risk.kind, true]);
      for (const anchor of risk.anchors) {
        expect(typeof anchor.source).toBe('string');
        expect(typeof anchor.id).toBe('string');
        expect(typeof anchor.detail).toBe('string');
      }
      expect(typeof risk.key).toBe('string');
      expect(risk.statement.length).toBeGreaterThan(10);
    }

    // Worst-first, and the seven counts add up to the list.
    const rank = (severity: string): number => (severity === 'high' ? 0 : severity === 'medium' ? 1 : 2);
    const ranks = risks.map((risk) => rank(risk.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const counted = Object.values(response.body.riskCounts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(counted).toBe(risks.length);
  });

  it('persists the anchors into evidenceRefs, so a GET can show the same rows', async () => {
    await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    expect(tables.risks.length).toBeGreaterThan(0);
    for (const row of tables.risks) {
      const refs = row.evidenceRefs as Array<{ source: string; id: string; detail: string }>;
      expect(Array.isArray(refs)).toBe(true);
      expect(refs.length).toBeGreaterThan(0);
      // The whole triple round-trips, so the reader gets the machine-readable reason back.
      expect(refs[0].detail).toBeTruthy();
    }
  });

  it('answers nothing without a provider, and says so (ADR-041 D5)', async () => {
    const response = await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });

    expect(response.status).toBe(201);
    // The RISKS are all there: the derivation cannot be skipped.
    const risks = response.body.risks as RiskRow[];
    expect(risks.length).toBeGreaterThan(0);
    // And one anchored question per risk.
    expect((response.body.questions as QuestionRow[]).length).toBe(risks.length);
    // No answer was invented, and every absence is spelled out.
    for (const question of response.body.questions as QuestionRow[]) {
      expect([question.questionId, question.modelAnswer]).toEqual([question.questionId, null]);
      expect(['not_evaluated', 'no_grounded_evidence', 'no_ai_provider_configured']).toContain(
        question.answerStage.reason,
      );
      expect(question.riskId).not.toBeNull();
    }
    expect(response.body.answerStageSummary.answered).toBe(0);
    expect(Object.keys(response.body.answerStageSummary.reasons).length).toBe(risks.length);
    // The column is NOT NULL, so an absent answer is stored as the empty string.
    for (const row of tables.questions) expect(row.modelAnswer).toBe('');
  });

  it('ACCEPTANCE 2 over HTTP: an answer naming an ungrounded entity is refused, retried once, and stored WITHOUT an answer', async () => {
    const calls = leakingProposer();

    const response = await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });

    // Attempt 1 and the ONE regeneration, and nothing more.
    expect(calls).toHaveLength(2);
    expect(calls[0].refusedEntities).toEqual([]);
    expect(calls[1].refusedEntities).toContain('employer Initech');

    const questions = response.body.questions as QuestionRow[];
    const rejected = questions.filter((question) => question.answerStage.status === 'rejected');
    const gaps = questions.filter((question) => question.answerStage.reason === 'no_grounded_evidence');
    expect(rejected.length).toBe(questions.length - gaps.length);
    expect(rejected.length).toBeGreaterThan(0);

    for (const question of rejected) {
      expect([question.questionId, question.modelAnswer]).toEqual([question.questionId, null]);
      expect(question.answerStage.reason).toBe('ungrounded_entities_after_regeneration');
      expect(question.answerStage.attempts).toBe(2);
      // The refusal is ON THE RECORD: it names what was refused, which is the whole point.
      expect(question.answerStage.rejectedEntities).toContain('employer Initech');
    }

    // But the ungrounded sentence itself is nowhere in the response or in storage.
    for (const question of questions) expect(question.modelAnswer ?? '').not.toContain('Initech');
    for (const row of tables.questions) expect(row.modelAnswer).toBe('');
    expect(response.body.answerStageSummary.rejected).toBe(rejected.length);
  });

  it('a clean regeneration STORES the answer, so the retry is a real second chance', async () => {
    let attempt = 0;
    setAnswerProposer(async (input) => {
      attempt += 1;
      return {
        status: 'applied' as const,
        reason: 'ok' as const,
        provider: 'openai',
        model: 'gpt-test',
        responses: {
          answers: input.questions.map((question) => ({
            questionId: question.questionId,
            modelAnswer: attempt === 1 ? LEAKAGE_ANSWER : NEUTRAL_ANSWER,
          })),
        },
      };
    });

    const response = await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    expect(attempt).toBe(2);
    const questions = response.body.questions as QuestionRow[];
    const answerable = questions.filter((question) => question.answerStage.reason !== 'no_grounded_evidence');
    const answered = questions.filter((question) => question.modelAnswer !== null);
    expect(answered).toHaveLength(answerable.length);
    for (const question of answered) expect(question.answerStage.attempts).toBe(2);
    expect(response.body.answerStageSummary.answered).toBe(answered.length);
  });

  it('a gap question is anchored to its requirement and is never sent to the provider', async () => {
    const askedIds: string[] = [];
    setAnswerProposer(async (input) => {
      askedIds.push(...input.questions.map((question) => question.questionId));
      return {
        status: 'skipped' as const,
        reason: 'no_ai_provider_configured' as const,
        provider: null,
        model: null,
        responses: null,
      };
    });

    const response = await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    // The question view carries the REQUIREMENT anchor, not the kind: the kind is on the risk,
    // and duplicating it here would be a second thing to keep in step.
    const gaps = (response.body.questions as QuestionRow[]).filter(
      (question) => question.requirementId === 'req-kafka',
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ requirementId: 'req-kafka', modelAnswer: null });
    expect(gaps[0].groundedClaimIds).toEqual([]);
    expect(gaps[0].answerStage.reason).toBe('no_grounded_evidence');
    expect(askedIds).not.toContain(gaps[0].questionId);
  });

  it('every question carries a risk anchor and one of the four categories', async () => {
    const response = await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    const riskIds = new Set(tables.risks.map((row) => row.id as string));
    const counted = Object.values(response.body.questionCounts as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(counted).toBe((response.body.questions as QuestionRow[]).length);
    for (const question of response.body.questions as QuestionRow[]) {
      expect(riskIds.has(question.riskId as string)).toBe(true);
      expect(['behavioral', 'technical', 'situational', 'general']).toContain(question.category);
      expect(question.question.length).toBeGreaterThan(20);
      expect(question.questionId).toContain('#');
    }
  });

  it('a second POST REPLACES the first, so the same risk is never listed twice', async () => {
    const first = await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    const second = await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    const firstKeys = (first.body.risks as RiskRow[]).map((risk) => risk.key);
    const secondKeys = (second.body.risks as RiskRow[]).map((risk) => risk.key);

    expect(secondKeys).toEqual(firstKeys);
    expect(tables.risks).toHaveLength(firstKeys.length);
    // The questions went with them: `InterviewQuestion.riskId` cascades.
    expect(tables.questions).toHaveLength(secondKeys.length);
    expect(tables.writes).toContain('risk.deleteMany');
  });

  it('a foreign resume is a 404, not a 403: this view quotes a career', async () => {
    expect((await request(app).post('/interview-prep').send({ resumeId: 'res-foreign' })).status).toBe(404);
  });

  it('a legacy (modelVersion 1) resume is a 404: there is no evidence to derive from', async () => {
    expect((await request(app).post('/interview-prep').send({ resumeId: 'res-legacy' })).status).toBe(404);
  });

  it('a foreign match report is a 404', async () => {
    tables.matchReports.push({ id: 'mr-foreign', userId: 'user-2', jobId: 'job-1', profileId: 'prof-1' });
    const response = await request(app)
      .post('/interview-prep')
      .send({ resumeId: 'res-1', matchReportId: 'mr-foreign' });
    expect(response.status).toBe(404);
  });

  it('a job with no match report still yields requirement risks, with nothing invented', async () => {
    const response = await request(app).post('/interview-prep').send({ resumeId: 'res-1', jobId: 'job-1' });
    expect(response.status).toBe(201);
    expect(response.body.match).toMatchObject({ matchReportId: null, jobId: 'job-1' });
    const risks = response.body.risks as RiskRow[];
    // The same levels derive from the job's requirements alone, so the same kinds appear.
    expect(risks.map((risk) => risk.kind)).toContain('emphasized_tech');
    expect(risks.filter((risk) => risk.kind === 'gap')).toHaveLength(1);
  });

  it('a resume with no revision is a 404 rather than a derivation over nothing', async () => {
    tables.revisions.length = 0;
    expect((await request(app).post('/interview-prep').send({ resumeId: 'res-1' })).status).toBe(404);
  });

  it('reads the change ledger DOWN THE ANCESTRY, so a rewrite stays visible after a no-op revision', async () => {
    // The live defect this exists for: `apply.ts` writes a change row per PARSED operation, so a
    // revision whose only operation was declined has an `accepted: false` row and the SAME
    // `jsonHash` as its parent. Reading the current revision's log alone would then report
    // nothing about the rewording still on the page.
    const reworded = await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    const rewriteRisk = (reworded.body.risks as RiskRow[]).find((risk) => risk.kind === 'inferred_claim');
    expect(rewriteRisk).toBeDefined();

    // Revision 2: the SAME document, with one declined operation.
    tables.revisions.push({
      id: 'rev-2',
      resumeId: 'res-1',
      revisionNumber: 3,
      jsonHash: 'hash-1',
      resumeJson: DOCUMENT,
      createdAt: NOW,
    });
    tables.changes.push({
      id: 'chg-declined',
      revisionId: 'rev-2',
      op: ResumeChangeOp.rewrite_bullet,
      jsonPath: 'work[0].highlights[1]',
      before: 'something',
      after: 'something else entirely',
      accepted: false,
      sourceClaimIds: ['clm-lat'],
      targetRequirementIds: [],
      appliedBy: 'tailoring_engine',
      createdAt: NOW,
    });

    const after = await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    const kinds = (after.body.risks as RiskRow[]).map((risk) => risk.kind);
    // The parent's accepted change is STILL read, so the risk survives the no-op revision.
    expect(kinds).toContain('inferred_claim');
    expect(after.body.revision).toMatchObject({ id: 'rev-2', revisionNumber: 3 });
    // `changeCount` is ONE: the declined row belongs to a revision whose document did not move,
    // so it describes edits that are not on the page and is skipped.
    expect(after.body.revision.changeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// GET /interview-prep/:resumeId
// ---------------------------------------------------------------------------

describe('GET /interview-prep/:resumeId', () => {
  it('reads the stored rows back, with the anchors and the two rules', async () => {
    await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    const response = await request(app).get('/interview-prep/res-1');

    expect(response.status).toBe(200);
    expect(response.body.resumeId).toBe('res-1');
    expect(response.body.notes).toContain('Every question names the risk or the requirement it came from');
    expect(response.body.rule).toContain('appears in the evidence the question is grounded in');
    // A READ derived nothing, so it reports `null` rather than zeros it did not compute.
    expect(response.body.revision).toBeNull();
    expect(response.body.match.requirementCount).toBeNull();
    expect(response.body.match.gapCount).toBeNull();
    expect(response.body.briefStage.reason).toBe('not_evaluated');

    const risks = response.body.risks as RiskRow[];
    expect(risks).toHaveLength(tables.risks.length);
    for (const risk of risks) {
      expect(risk.anchors.length).toBeGreaterThan(0);
      expect(risk.anchors[0].detail).toBeTruthy();
      expect(risk.key).toContain(':');
    }
  });

  it('reports the answer stage as not_evaluated, because a read asked no provider anything', async () => {
    await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    const response = await request(app).get('/interview-prep/res-1');
    for (const question of response.body.questions as QuestionRow[]) {
      expect(question.answerStage.reason).toBe('not_evaluated');
      expect(question.modelAnswer).toBeNull();
    }
  });

  it('RE-ASSERTS the anchor invariant on the rows it reads, and refuses an empty one with the code', async () => {
    await request(app).post('/interview-prep').send({ resumeId: 'res-1', matchReportId: 'mr-1' });
    // A row whose `evidenceRefs` was emptied by anything at all is refused, not rendered.
    tables.risks[0].evidenceRefs = [];
    const response = await request(app).get('/interview-prep/res-1');
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('RISK_UNANCHORED_RISK');
    expect(response.body.reason).toBe('UNANCHORED_RISK');
  });

  it('a foreign resume is a 404', async () => {
    expect((await request(app).get('/interview-prep/res-foreign')).status).toBe(404);
  });

  it('a resume with no stored run is an EMPTY list, not an error', async () => {
    const response = await request(app).get('/interview-prep/res-1');
    expect(response.status).toBe(200);
    expect(response.body.risks).toEqual([]);
    expect(response.body.questions).toEqual([]);
    const counted = Object.values(response.body.riskCounts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(counted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Isolation from the manual Q&A bank
// ---------------------------------------------------------------------------

describe('the manual QuestionAnswer bank is not involved', () => {
  it('the route never touches `questionAnswer` in its code', () => {
    expect(ROUTE_CODE).not.toContain('questionAnswer');
    expect(ROUTE_CODE).not.toContain('question-answers');
  });

  it('the aggregator mounts it at its OWN prefix, so neither router shadows the other', () => {
    const aggregator = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    expect(aggregator).toMatch(/router\.use\('\/question-answers', questionAnswersRoutes\)/);
    expect(aggregator).toMatch(/router\.use\('\/interview-prep', interviewPrepRoutes\)/);
  });
});