// T1101 - the ATS / job-match API responses carry NO derived score (06 sec. E.6).
//
// THE RULE. "No universal score, no single number, no letter grade, no 'ATS 87/100'" - and "the
// deterministic scorer and keyword matcher may still run, but only as INTERNAL signals, never
// rendered as a verdict". This file is the API half of that rule; `src/noDerivedScore.test.ts` is
// the UI half.
//
// WHAT IS ASSERTED, AND WHY EACH THING IS NOT VACUOUS:
//   1. NO VERDICT IN ANY RESPONSE. Every reachable `/ats/*` and `/job-match/*` read is driven with a
//      fully-populated row, so a response that dropped a member because the fixture was empty
//      would fail here rather than pass.
//   2. THE SIGNAL IS STILL COMPUTED AND STILL STORED. This is the half that matters, because
//      "remove the number from the response" is trivially satisfiable by deleting the feature.
//      `scanResumeContent` is asserted to have run, the `ATSReport` row is asserted to carry
//      `overallScore`, `Resume.lastATSScore` is asserted to be written, and `matchScore` is
//      asserted to be persisted. FREEZE B-16/B-17/B-18 exist for exactly this: the signals stay,
//      the presentation goes.
//   3. THE INTERNAL SCORERS STILL RUN AND STILL DRIVE THE HANDLERS. `ats/atsScorer.test.ts` and
//      `evaluation/matcher.test.ts` are untouched and still pin their formulas; this file proves
//      `POST /ats/score-job` still CALLS `scoreResumeAgainstJob` on every request - and that the
//      rule's HITS (which JD terms the resume carries, which resume skills the JD asks for) come
//      back in place of the numbers. A breakdown a caller can act on is a signal; a 0-100 is a
//      verdict, and a 0-100 per factor is the same verdict as the 0-100 average of the three.
//
// WHY A SOURCE GREP IS ALSO HERE. The behavioural assertions above cover the handlers this file
// drives. A future handler that assembles a response by hand could reintroduce a verdict without
// any test noticing, so the last test reads both route modules.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const { rows, calls } = vi.hoisted(() => ({
  rows: {
    resume: {
      id: '123e4567-e89b-12d3-a456-426614174000',
      userId: 'user-1',
      personalInfo: { fullName: 'Ada Lovelace', email: 'ada@example.com' },
      summary: 'Engineer.',
      experience: [{ title: 'Engineer', company: 'Acme', bullets: ['Cut latency 40%'] }],
      education: [{ degree: 'BSc', institution: 'Uni' }],
      skills: ['TypeScript'],
      templateId: null,
    },
    report: {
      id: 'report-1',
      resumeId: 'resume-1',
      // Every verdict-bearing field POPULATED. An empty one would let a projection that dropped a
      // field "for free", and the assertion would then pass for the wrong reason.
      overallScore: 87,
      status: 'excellent',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      categories: [{ category: 'formatting', score: 9, maxScore: 10, issues: [] }],
      keywords: { found: ['TypeScript'], missing: ['Kubernetes'] },
      formatting: { isAtsCompatible: true, issues: [] },
      evaluationJson: null,
      scoredBy: 'rules',
      isPublicScan: false,
      uploadedFileHash: null,
      fileName: 'cv.pdf',
    },
    match: {
      id: 'match-1',
      resumeId: 'resume-1',
      uploadedFileId: null,
      userId: 'user-1',
      jobDescription: 'Kubernetes and Terraform required.',
      jobTitle: 'Platform Engineer',
      matchScore: 68,
      matchedKeywords: ['TypeScript'],
      missingKeywords: ['Kubernetes'],
      suggestions: [],
      detectedRole: 'platform',
      criticalMissing: ['Kubernetes'],
      preferredMissing: ['Terraform'],
      roleSuggestions: [],
      tailoringTips: [],
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
    },
  },
  calls: {
    reportCreate: [] as any[],
    resumeUpdate: [] as any[],
    matchCreate: [] as any[],
    scanned: 0,
    scored: [] as any[],
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({
  default: {
    resume: {
      findUnique: async () => rows.resume,
      findFirst: async () => rows.resume,
      update: async (args: any) => {
        calls.resumeUpdate.push(args);
        return rows.resume;
      },
    },
    aTSReport: {
      create: async (args: any) => {
        calls.reportCreate.push(args);
        return rows.report;
      },
      // The mock HONOURS `select`, exactly as prisma does. A mock that returned the whole row
      // would hand the route a `matchScore`/`overallScore` it never asked for, and a route that
      // had accidentally kept reading the column would pass here while failing in production.
      findMany: async (args: any) => [project(rows.report, args?.select)],
      findUnique: async (args: any) => project(rows.report, args?.select),
    },
    jobMatch: {
      create: async (args: any) => {
        calls.matchCreate.push(args);
        return rows.match;
      },
      findMany: async (args: any) => [project(rows.match, args?.select)],
      findUnique: async (args: any) => project(rows.match, args?.select),
    },
    uploadedFile: { findUnique: async () => null },
  },
}));

/** Prisma's `select` semantics: keep only the named keys. `undefined` select means the whole row. */
const LONG_JD = 'Kubernetes and Terraform, eight years of platform work, on call for the ingest pipeline.';

/** Prisma's `select` semantics: keep only the named keys. `undefined` select means the whole row. */
function project(row: Record<string, unknown>, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  const kept: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) if (wanted) kept[key] = row[key];
  return kept;
}

// The LLM evaluator is the one outbound call in this tree; there is no key in a test, so it must
// not be reached and must not change the shape of the answer when it is not.
vi.mock('../ats/llmEvaluator.js', () => ({
  hasLlmKey: async () => false,
  evaluateResumeWithLLM: async () => {
    throw new Error('the LLM evaluator must not run without a key');
  },
}));

vi.mock('../ats/matchEnhancer.js', () => ({ enhanceMatchWithLLM: async () => [] }));

vi.mock('../resume/parser.js', () => ({
  parseUploadedResume: async () => ({
    personalInfo: {},
    rawText: 'engineer',
    summary: '',
    experience: [],
    education: [],
    skills: [],
  }),
  extractRawText: async () => 'engineer',
}));

// The scanner and the scorer are instrumented, NOT replaced: `importOriginal` keeps the real
// formula, so the assertions below are about the real modules.
vi.mock('../ats/scanner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ats/scanner.js')>();
  return {
    ...actual,
    scanResumeContent: (resume: unknown) => {
      calls.scanned += 1;
      return actual.scanResumeContent(resume as never);
    },
  };
});

vi.mock('../ats/atsScorer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ats/atsScorer.js')>();
  return {
    ...actual,
    scoreResumeAgainstJob: (input: unknown) => {
      calls.scored.push(input);
      return actual.scoreResumeAgainstJob(input as never);
    },
  };
});

// Static imports, AFTER the `vi.mock` declarations - vitest hoists the mocks above them. This is
// the convention every other route test in `src/routes/` follows (see `resume.legacyExport.test.ts`).
import atsRouter from './ats.js';
import jobMatchRouter from './job-match.js';

/** Members that would be a verdict, grade or percentage if a response carried one. */
const FORBIDDEN_IN_RESPONSE = ['overallScore', 'status', 'matchScore', 'lastATSScore', 'score', 'grade', 'percentage'];

/** Assert on the PARSED body, recursively: a verdict nested inside a list member counts too. */
function assertNoVerdict(body: unknown, where: string): void {
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (FORBIDDEN_IN_RESPONSE.includes(key)) seen.add(key);
        walk(value);
      }
    }
  };
  walk(body);
  expect([where, [...seen]]).toEqual([where, []]);
}

function makeApp(prefix: string, router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use(prefix, router);
  return app;
}

const ats = () => makeApp('/ats', atsRouter);
const jobMatch = () => makeApp('/job-match', jobMatchRouter);

beforeEach(() => {
  calls.reportCreate.length = 0;
  calls.resumeUpdate.length = 0;
  calls.matchCreate.length = 0;
  calls.scanned = 0;
  calls.scored.length = 0;
});

describe('no ATS response carries a verdict', () => {
  it('POST /ats/scan/:resumeId returns the found/missing keywords and NOT a number or a grade', async () => {
    const res = await request(ats()).post(`/ats/scan/${rows.resume.id}`).send();

    expect(res.status).toBe(201);
    // The keyword lists are the scanner's own output, so their CONTENT is the scanner's business
    // (ts/scanner.ts owns it). What is asserted here is that they are two lists of strings and
    // that no verdict member sits beside them.
    expect(Object.keys(res.body.keywords).sort()).toEqual(['found', 'missing']);
    expect(Array.isArray(res.body.keywords.found)).toBe(true);
    expect(Array.isArray(res.body.keywords.missing)).toBe(true);
    expect(res.body.id).toBe('report-1');
    // The scanner's own per-category `score`/`maxScore` are stripped too: a `9/10` is the same
    // verdict as an `87/100`, only smaller. The `issues` beside it survive - those are sentences.
    expect(JSON.stringify(res.body)).not.toMatch(/"score"|"maxScore"/);
    assertNoVerdict(res.body, 'POST /ats/scan/:resumeId');
  });

  it('POST /ats/scan-public returns the same honest shape', async () => {
    const res = await request(ats())
      .post('/ats/scan-public')
      .attach('file', Buffer.from('%PDF-1.4 engineer'), { filename: 'cv.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    assertNoVerdict(res.body, 'POST /ats/scan-public');
  });

  it('GET /ats/reports/:id, /ats/resume/:id/reports and /ats/scans all omit it, on a POPULATED row', async () => {
    for (const path of ['/ats/reports/report-1', `/ats/resume/${rows.resume.id}/reports`, '/ats/scans']) {
      const res = await request(ats()).get(path);
      expect([path, res.status]).toEqual([path, 200]);
      // The fixture really does carry an 87 and an "excellent", so this is not passing on absence.
      expect(rows.report.overallScore).toBe(87);
      expect(rows.report.status).toBe('excellent');
      assertNoVerdict(res.body, path);
    }
  });

  it('the scanner still RAN and the verdict is still STORED on the row and on the resume', async () => {
    await request(ats()).post(`/ats/scan/${rows.resume.id}`).send();

    // The signal is computed...
    expect(calls.scanned).toBeGreaterThan(0);
    // ...and persisted, on both columns, for the historical record (T1101: rows are not deleted).
    expect(calls.reportCreate).toHaveLength(1);
    expect(typeof calls.reportCreate[0].data.overallScore).toBe('number');
    expect(typeof calls.reportCreate[0].data.status).toBe('string');
    expect(calls.resumeUpdate).toHaveLength(1);
    expect(typeof calls.resumeUpdate[0].data.lastATSScore).toBe('number');
  });
});

describe('no job-match response carries a match score', () => {
  it('POST /job-match returns named gaps and NOT a percentage', async () => {
    const res = await request(jobMatch())
      .post('/job-match')
      .send({ resumeId: rows.resume.id, jobDescription: LONG_JD });

    expect(res.status).toBe(201);
    // The GAP LISTS are the matcher's own output, so which words land in them is
    // `evaluation/matcher.ts`'s business (C-11: do not touch). What is asserted here is that they
    // are the honest response - names, not a percentage - and that the stored 68 is not beside them.
    for (const member of ['criticalMissing', 'preferredMissing', 'missingKeywords', 'matchedKeywords']) {
      expect([member, Array.isArray(res.body[member])]).toEqual([member, true]);
    }
    expect(rows.match.matchScore).toBe(68);
    assertNoVerdict(res.body, 'POST /job-match');
  });

  it('GET /job-match and GET /job-match/:id omit it, on a POPULATED row', async () => {
    const list = await request(jobMatch()).get('/job-match');
    expect(list.status).toBe(200);
    expect(rows.match.matchScore).toBe(68);
    assertNoVerdict(list.body, 'GET /job-match');

    const one = await request(jobMatch()).get('/job-match/match-1');
    expect(one.status).toBe(200);
    assertNoVerdict(one.body, 'GET /job-match/:id');
  });

  it('the matcher still RAN and `matchScore` is still PERSISTED on the row', async () => {
    await request(jobMatch())
      .post('/job-match')
      .send({ resumeId: rows.resume.id, jobDescription: LONG_JD });

    expect(calls.matchCreate).toHaveLength(1);
    const persisted = calls.matchCreate[0].data.matchScore;
    expect(typeof persisted).toBe('number');
    expect(persisted).toBeGreaterThanOrEqual(0);
    expect(persisted).toBeLessThanOrEqual(100);
  });
});

// CHANGED PIN (cutover review fix 1) - this block previously read
//   "the deterministic scorer is still a served SIGNAL, not a served verdict" and asserted that
//   `POST /ats/score-job` returned the three factors *and* the weighted total, calling the total "the
//   part nothing presents any more". That assertion PINNED A FIELD THE PRODUCT NOW FORBIDS: T1101's
//   acceptance is "no UI OR API RESPONSE exposes a single score/grade/percentage", so shipping
//   `overall` (0-100) plus three 0-100 factors was the violation, and a green test was enforcing it.
//   It was replaced, not deleted: the scorer-must-still-run half is kept and now stands on the
//   `scoreResumeAgainstJob` spy, and the response half is inverted into a member-by-member pin.
describe('the deterministic scorer still RUNS, and its response carries the rule HITS, not its numbers', () => {
  it('POST /ats/score-job runs the scorer and returns the three named factors with NO number', async () => {
    const res = await request(ats())
      .post('/ats/score-job')
      .send({ resumeId: rows.resume.id, jobDescription: 'Kubernetes Terraform platform engineer' });

    expect(res.status).toBe(200);
    // The scorer really ran - the INTERNAL signal is untouched (FREEZE B-17). `calls.scored` spies
    // `scoreResumeAgainstJob`, so this cannot pass if the handler stopped calling it, and it is the
    // half of the old assertion that was always right.
    expect(calls.scored).toHaveLength(1);
    // ...and nothing it produced as a NUMBER crossed the wire.
    assertNoVerdict(res.body, 'POST /ats/score-job');
    expect(res.body.overall).toBeUndefined();

    // The exact member set. `overall`, `weights` and each factor's `score` are GONE; what is left is
    // a `detail` sentence per factor plus the names behind it. Enumerated rather than spot-checked,
    // so putting any member back - including a differently-named one - fails here.
    expect(Object.keys(res.body).sort()).toEqual([
      'keywordMatch',
      'sectionCompleteness',
      'skillsCoverage',
      'weighting',
    ]);
    expect(Object.keys(res.body.keywordMatch).sort()).toEqual(['detail', 'found', 'missing']);
    expect(Object.keys(res.body.skillsCoverage).sort()).toEqual(['detail', 'evidenced', 'notEvidenced']);
    expect(Object.keys(res.body.sectionCompleteness).sort()).toEqual(['detail']);
    for (const factor of ['keywordMatch', 'skillsCoverage', 'sectionCompleteness'] as const) {
      expect(typeof res.body[factor].detail).toBe('string');
      expect(res.body[factor].detail.length).toBeGreaterThan(0);
    }
    expect(typeof res.body.weighting).toBe('string');

    // NON-VACUITY: the hits are THIS fixture's real names, not empty lists and not a constant.
    // The JD asks for four things; the resume body contains exactly one of them.
    expect(res.body.keywordMatch.found).toEqual(['engineer']);
    expect([...res.body.keywordMatch.missing].sort()).toEqual(['kubernetes', 'platform', 'terraform']);
    // The resume lists one skill, `TypeScript`, and the JD never asks for it - the actionable gap.
    expect(res.body.skillsCoverage.evidenced).toEqual([]);
    expect(res.body.skillsCoverage.notEvidenced).toEqual(['TypeScript']);
    // The scorer's own sentence still NAMES the sections it found, so nothing was lost with the number.
    expect(res.body.sectionCompleteness.detail).toMatch(/^sections: .*education.*skills/);
  });
});

describe('no route module can hand-assemble a verdict back', () => {
  /** Every `select: { ... }` block in a source file, by brace matching. */
  function selectBlocks(source: string): string[] {
    const blocks: string[] = [];
    const pattern = /select:\s*\{/g;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      let depth = 0;
      let at = match.index + match[0].length - 1;
      for (; at < source.length; at += 1) {
        if (source[at] === '{') depth += 1;
        else if (source[at] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      blocks.push(source.slice(match.index, at + 1));
    }
    return blocks;
  }

  it('no list route still READS a verdict column - the SELECT lists prove it', () => {
    // The behavioural tests above cover the handlers they drive. This covers a future list route.
    // Reading the column is the thing to forbid, not naming it: the modules still WRITE both
    // columns, which the next test pins, so this is not a grep that passes because the names are
    // absent from the files.
    const codeOnly = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const file of ['ats.ts', 'job-match.ts', 'resume.ts']) {
      const blocks = selectBlocks(codeOnly(readFileSync(path.join(__dirname, file), 'utf8')));
      expect([file, blocks.length]).toEqual([file, expect.any(Number)]);
      for (const block of blocks) {
        expect([file, block]).toEqual([file, expect.not.stringMatching(/overallScore|matchScore|lastATSScore/)]);
      }
    }
  });

  it('the two modules really do still WRITE the columns (so the SELECT grep is not vacuous)', () => {
    const atsCode = readFileSync(path.join(__dirname, 'ats.ts'), 'utf8');
    const matcherCode = readFileSync(path.join(__dirname, 'job-match.ts'), 'utf8');
    expect(atsCode).toMatch(/overallScore:\s*result\.overallScore/);
    expect(atsCode).toMatch(/lastATSScore:\s*result\.overallScore/);
    expect(matcherCode).toMatch(/matchScore:\s*matchResult\.matchScore/);
  });
});

