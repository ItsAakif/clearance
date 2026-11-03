// Wave 9 pipeline tests (T782): three passes wired in order, bounded AI,
// estimate-before-AI, partial outcomes, reuse, cancel, and the N10/N7
// source guards (no Application row, no second evaluation model).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  evaluateResults,
  isUsablePipelineDescription,
  type EvaluationOptions,
} from './pipeline.js';
import {
  AI_EVALUATION_CONCURRENCY,
  MAX_AI_EVALUATIONS_PER_RUN,
} from './aiSubset.js';
import { UNSCORED_SCORE } from './matcher.js';
import { jobFilterKey } from './hardFilters.js';
import type { RawJob } from '../jobSources/adapters/http.js';
import { deriveIntent } from '../discovery/searchIntent.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');

const RESUME_TEXT = [
  'Senior frontend engineer with 6 years of React and TypeScript experience.',
  'Built GraphQL APIs with Node.js, Docker deployments, Jest testing.',
].join('\n');
const PROFILE = { skills: ['React', 'TypeScript', 'GraphQL', 'Node.js'] };

const HIGH_JD =
  'Senior Frontend Engineer. React, TypeScript, Node.js, GraphQL, Docker, Jest. ' +
  'Extra senior frontend context to clear every length gate with room to spare.';
const LOW_JD =
  'Data Scientist. Python, machine learning, pandas, SQL, statistics, Spark, TensorFlow. ' +
  'Extra data science context to clear every length gate with room to spare.';

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    title: 'Frontend Engineer',
    company: 'Acme',
    location: 'Berlin',
    description: HIGH_JD,
    ...overrides,
  };
}

function baseOpts(overrides: Partial<EvaluationOptions> = {}): EvaluationOptions {
  return {
    intent: deriveIntent({}),
    now: NOW,
    resumeText: RESUME_TEXT,
    matcherProfile: PROFILE,
    ...overrides,
  };
}

describe('no AI call for off / deterministic / default (spied client)', () => {
  const modes: Array<{ name: string; opts: Partial<EvaluationOptions> }> = [
    { name: 'off', opts: { evaluate: 'off' } },
    { name: 'deterministic', opts: { evaluate: 'deterministic' } },
    { name: 'default (omitted)', opts: {} },
  ];

  it.each(modes.map((m) => [m.name, m.opts] as const))(
    'mode %s performs zero AI calls but still returns passes 1-2',
    async (_name, extra) => {
      const evaluateOne = vi.fn(async () => 'eval-never');
      const jobs = [makeJob({ externalId: 'a' }), makeJob({ externalId: 'b' })];
      const outcome = await evaluateResults(jobs, baseOpts({ ...extra, evaluateOne }));
      expect(evaluateOne).not.toHaveBeenCalled();
      expect(outcome.jobs).toHaveLength(2);
      for (const row of outcome.jobs) {
        expect(row.deterministicScore).toBeGreaterThanOrEqual(0);
        expect(row.aiEvaluationId).toBeUndefined();
      }
      expect(outcome.ai).toEqual({ requested: 0, completed: 0, skipped: 0 });
      expect(outcome.estimate).toEqual({ calls: 0, approxTokens: 0 });
    },
  );
});

describe('ai-subset: cap and concurrency enforced (asserted)', () => {
  it(`never issues more than MAX_AI_EVALUATIONS_PER_RUN calls`, async () => {
    const jobs = Array.from({ length: 12 }, (_, i) =>
      makeJob({ externalId: `job-${i}`, sourceUrl: `https://x/${i}` }),
    );
    const evaluateOne = vi.fn(async (job: RawJob) => `eval-${job.externalId}`);
    const outcome = await evaluateResults(jobs, baseOpts({ evaluate: 'ai-subset', evaluateOne }));
    expect(evaluateOne).toHaveBeenCalledTimes(MAX_AI_EVALUATIONS_PER_RUN);
    expect(outcome.ai.requested).toBe(MAX_AI_EVALUATIONS_PER_RUN);
    expect(outcome.ai.completed).toBe(MAX_AI_EVALUATIONS_PER_RUN);
    expect(outcome.ai.skipped).toBe(0);
    expect(outcome.ai.reason).toBeUndefined();
  });

  it('never exceeds AI_EVALUATION_CONCURRENCY in flight', async () => {
    const jobs = Array.from({ length: 8 }, (_, i) =>
      makeJob({ externalId: `c-${i}`, sourceUrl: `https://y/${i}` }),
    );
    let active = 0;
    let maxActive = 0;
    const evaluateOne = vi.fn(async (job: RawJob) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return `eval-${job.externalId}`;
    });
    await evaluateResults(jobs, baseOpts({ evaluate: 'ai-subset', evaluateOne }));
    expect(evaluateOne).toHaveBeenCalledTimes(MAX_AI_EVALUATIONS_PER_RUN);
    expect(maxActive).toBeLessThanOrEqual(AI_EVALUATION_CONCURRENCY);
    expect(maxActive).toBeGreaterThan(0);
  });

  it('attaches evaluation ids to the pass-2 head only', async () => {
    const jobs = [
      makeJob({ externalId: 'new', postedAt: new Date('2026-09-20T00:00:00Z') }),
      makeJob({ externalId: 'old', postedAt: new Date('2026-09-10T00:00:00Z') }),
    ];
    const evaluateOne = vi.fn(async (job: RawJob) => `eval-${job.externalId}`);
    const outcome = await evaluateResults(
      jobs,
      baseOpts({ evaluate: 'ai-subset', evaluateOne, maxCount: 1 }),
    );
    expect(evaluateOne).toHaveBeenCalledTimes(1);
    expect(outcome.jobs[0].job.externalId).toBe('new');
    expect(outcome.jobs[0].aiEvaluationId).toBe('eval-new');
    expect(outcome.jobs[1].aiEvaluationId).toBeUndefined();
  });

  it('honours minScore: low-scoring jobs never reach the AI pass', async () => {
    const jobs = [makeJob({ externalId: 'high', description: HIGH_JD }), makeJob({ externalId: 'low', description: LOW_JD })];
    const seen: string[] = [];
    const evaluateOne = vi.fn(async (job: RawJob) => {
      seen.push(String(job.externalId));
      return `eval-${job.externalId}`;
    });
    const outcome = await evaluateResults(
      jobs,
      baseOpts({ evaluate: 'ai-subset', evaluateOne, minScore: 50 }),
    );
    expect(seen).toEqual(['high']);
    expect(outcome.ai.requested).toBe(1);
  });
});

describe('already-evaluated jobs reuse their id (no second call)', () => {
  it('attaches the existing id without calling the evaluator', async () => {
    const jobs = [makeJob({ externalId: 'done' }), makeJob({ externalId: 'fresh' })];
    const existing = new Map([[jobFilterKey(jobs[0]), 'eval-existing']]);
    const evaluateOne = vi.fn(async (job: RawJob) => `eval-${job.externalId}`);
    const outcome = await evaluateResults(
      jobs,
      baseOpts({ evaluate: 'ai-subset', evaluateOne, existingEvaluations: existing }),
    );
    expect(evaluateOne).toHaveBeenCalledTimes(1);
    expect(evaluateOne.mock.calls[0][0].externalId).toBe('fresh');
    const byId = new Map(outcome.jobs.map((r) => [r.job.externalId, r]));
    expect(byId.get('done')?.aiEvaluationId).toBe('eval-existing');
    expect(byId.get('fresh')?.aiEvaluationId).toBe('eval-fresh');
    expect(outcome.ai).toMatchObject({ requested: 2, completed: 2, skipped: 0 });
  });

  it('exempts reuse jobs from the already_evaluated pass-1 drop (any id form)', async () => {
    const evaluated = makeJob({ externalId: 'eval-1' });
    const jobs = [evaluated, makeJob({ externalId: 'other' })];
    const outcome = await evaluateResults(
      jobs,
      baseOpts({
        evaluate: 'ai-subset',
        // Stored as the raw external id (not the key form) - exemption holds.
        known: { evaluatedJobIds: new Set(['eval-1']), appliedJobIds: new Set() },
        existingEvaluations: new Map([[jobFilterKey(evaluated), 'eval-reused']]),
        evaluateOne: vi.fn(async () => 'eval-should-never-run-for-eval-1'),
        maxCount: 1,
      }),
    );
    expect(outcome.dropped).toEqual([]);
    expect(outcome.jobs).toHaveLength(2);
    expect(outcome.jobs[0].aiEvaluationId).toBe('eval-reused');
  });

  it('without a reuse entry, known evaluated ids still drop (suppression)', async () => {
    const jobs = [makeJob({ externalId: 'seen' }), makeJob({ externalId: 'new' })];
    const outcome = await evaluateResults(
      jobs,
      baseOpts({
        known: { evaluatedJobIds: new Set(['seen']), appliedJobIds: new Set() },
      }),
    );
    expect(outcome.jobs.map((r) => r.job.externalId)).toEqual(['new']);
    expect(outcome.dropped).toEqual([
      { signature: jobFilterKey(jobs[0]), reason: 'already_evaluated' },
    ]);
  });
});

describe('estimate available before the AI pass', () => {
  it('fires onEstimate before the first AI call with the true call count', async () => {
    const jobs = Array.from({ length: 6 }, (_, i) =>
      makeJob({ externalId: `e-${i}`, sourceUrl: `https://z/${i}` }),
    );
    const existing = new Map([[jobFilterKey(jobs[0]), 'eval-old']]);
    const evaluateOne = vi.fn(async (job: RawJob) => `eval-${job.externalId}`);
    let callsAtEstimate = -1;
    const seen: { calls: number; approxTokens: number } = { calls: -1, approxTokens: -1 };
    const onEstimate = vi.fn((estimate: { calls: number; approxTokens: number }) => {
      callsAtEstimate = evaluateOne.mock.calls.length;
      seen.calls = estimate.calls;
      seen.approxTokens = estimate.approxTokens;
    });
    const outcome = await evaluateResults(
      jobs,
      baseOpts({ evaluate: 'ai-subset', evaluateOne, existingEvaluations: existing, onEstimate }),
    );
    expect(onEstimate).toHaveBeenCalledTimes(1);
    expect(callsAtEstimate).toBe(0);
    // Subset is 5 (cap), one reused => 4 billable calls, all made.
    expect(seen.calls).toBe(4);
    expect(evaluateOne).toHaveBeenCalledTimes(4);
    expect(outcome.estimate).toEqual(seen);
    expect(outcome.estimate.calls).toBe(4);
    expect(outcome.estimate.approxTokens).toBeGreaterThan(0);
  });
});

describe('partial outcomes: missing key and rate limit keep passes 1-2', () => {
  it('probe false => llm_key_missing, zero calls, passes 1-2 intact', async () => {
    const applied = makeJob({ externalId: 'applied-1' });
    const jobs = [applied, makeJob({ externalId: 'open-1' }), makeJob({ externalId: 'open-2' })];
    const evaluateOne = vi.fn(async () => 'eval-never');
    const outcome = await evaluateResults(
      jobs,
      baseOpts({
        evaluate: 'ai-subset',
        evaluateOne,
        probeLlmKey: () => false,
        known: { evaluatedJobIds: new Set(), appliedJobIds: new Set(['applied-1']) },
      }),
    );
    expect(evaluateOne).not.toHaveBeenCalled();
    expect(outcome.ai.reason).toBe('llm_key_missing');
    expect(outcome.ai.requested).toBe(2);
    expect(outcome.ai.completed).toBe(0);
    expect(outcome.ai.skipped).toBe(2);
    expect(outcome.jobs).toHaveLength(2);
    expect(outcome.dropped).toEqual([
      { signature: jobFilterKey(applied), reason: 'already_applied' },
    ]);
    // The estimate still exists (the snapshot reports what was skipped).
    expect(outcome.estimate.calls).toBe(2);
  });

  it('missing-key error mid-pass => llm_key_missing with passes intact', async () => {
    const jobs = [makeJob({ externalId: 'k1' }), makeJob({ externalId: 'k2' })];
    const evaluateOne = vi.fn(async () => {
      throw new Error('No LLM API keys configured.');
    });
    const outcome = await evaluateResults(jobs, baseOpts({ evaluate: 'ai-subset', evaluateOne }));
    expect(outcome.ai.reason).toBe('llm_key_missing');
    expect(outcome.jobs).toHaveLength(2);
    expect(outcome.ai.completed).toBe(0);
    expect(outcome.ai.skipped).toBe(outcome.ai.requested);
  });

  it('rate limit mid-pass => remaining stop, completed kept, rate_limited reported', async () => {
    const jobs = Array.from({ length: 4 }, (_, i) =>
      makeJob({ externalId: `r-${i}`, sourceUrl: `https://r/${i}` }),
    );
    let invocations = 0;
    const evaluateOne = vi.fn(async (job: RawJob) => {
      invocations += 1;
      if (invocations === 1) return `eval-${job.externalId}`;
      const error = new Error('provider rate limit exceeded, retry later') as Error & { status: number };
      error.status = 429;
      throw error;
    });
    const outcome = await evaluateResults(jobs, baseOpts({ evaluate: 'ai-subset', evaluateOne }));
    expect(outcome.ai.reason).toBe('rate_limited');
    expect(outcome.ai.completed).toBe(1);
    expect(outcome.ai.requested).toBe(4);
    expect(outcome.ai.skipped).toBe(3);
    expect(outcome.jobs).toHaveLength(4);
    const completedRows = outcome.jobs.filter((r) => r.aiEvaluationId !== undefined);
    expect(completedRows).toHaveLength(1);
  });

  it('ai-subset without an evaluator reports no_evaluator (never throws)', async () => {
    const jobs = [makeJob({ externalId: 'solo' })];
    const outcome = await evaluateResults(jobs, baseOpts({ evaluate: 'ai-subset' }));
    expect(outcome.ai.reason).toBe('no_evaluator');
    expect(outcome.ai).toMatchObject({ requested: 1, completed: 0, skipped: 1 });
    expect(outcome.jobs).toHaveLength(1);
  });
});

describe('cancel during pass 3 keeps completed work and returns', () => {
  it('cancelled from the start => zero calls, reuse still attached', async () => {
    const jobs = [makeJob({ externalId: 'c1' }), makeJob({ externalId: 'c2' })];
    const evaluateOne = vi.fn(async () => 'eval-never');
    const outcome = await evaluateResults(
      jobs,
      baseOpts({
        evaluate: 'ai-subset',
        evaluateOne,
        isCancelled: () => true,
        existingEvaluations: new Map([[jobFilterKey(jobs[0]), 'eval-kept']]),
      }),
    );
    expect(evaluateOne).not.toHaveBeenCalled();
    expect(outcome.ai.reason).toBe('cancelled');
    expect(outcome.jobs).toHaveLength(2);
    expect(outcome.jobs.find((r) => r.job.externalId === 'c1')?.aiEvaluationId).toBe('eval-kept');
  });

  it('cancel mid-pass => no new call starts, completed kept', async () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ externalId: `m-${i}`, sourceUrl: `https://m/${i}` }),
    );
    let cancelled = false;
    const evaluateOne = vi.fn(async (job: RawJob) => {
      cancelled = true; // cancel flips the moment the first call starts
      return `eval-${job.externalId}`;
    });
    const outcome = await evaluateResults(
      jobs,
      baseOpts({ evaluate: 'ai-subset', evaluateOne, isCancelled: () => cancelled }),
    );
    expect(outcome.ai.reason).toBe('cancelled');
    expect(evaluateOne.mock.calls.length).toBeLessThanOrEqual(AI_EVALUATION_CONCURRENCY);
    expect(outcome.ai.completed).toBe(evaluateOne.mock.calls.length);
    expect(outcome.jobs).toHaveLength(5);
  });
});

describe('edge cases from the wave spec', () => {
  it('empty description => dropped with no_description, never evaluated', async () => {
    const empty = makeJob({ externalId: 'empty', description: '' });
    const fine = makeJob({ externalId: 'fine' });
    const evaluateOne = vi.fn(async (job: RawJob) => `eval-${job.externalId}`);
    const outcome = await evaluateResults(
      [empty, fine],
      baseOpts({ evaluate: 'ai-subset', evaluateOne }),
    );
    expect(outcome.jobs.map((r) => r.job.externalId)).toEqual(['fine']);
    expect(outcome.dropped).toEqual([
      { signature: jobFilterKey(empty), reason: 'no_description' },
    ]);
    expect(evaluateOne).toHaveBeenCalledTimes(1);
    expect(isUsablePipelineDescription('')).toBe(false);
    expect(isUsablePipelineDescription('x'.repeat(49))).toBe(false);
    expect(isUsablePipelineDescription('x'.repeat(50))).toBe(true);
  });

  it('no resume and no profile => pass 3 skipped with no_resume (never an invented score)', async () => {
    const jobs = [makeJob({ externalId: 'u1' }), makeJob({ externalId: 'u2' })];
    const evaluateOne = vi.fn(async () => 'eval-never');
    const outcome = await evaluateResults(jobs, {
      intent: deriveIntent({}),
      now: NOW,
      evaluate: 'ai-subset',
      evaluateOne,
    });
    expect(evaluateOne).not.toHaveBeenCalled();
    expect(outcome.ai.reason).toBe('no_resume');
    expect(outcome.jobs).toHaveLength(2);
    for (const row of outcome.jobs) {
      expect(row.deterministicScore).toBe(UNSCORED_SCORE);
      expect(row.aiEvaluationId).toBeUndefined();
    }
  });

  it('nothing clears minScore => no_candidates, zero calls', async () => {
    const jobs = [makeJob({ externalId: 'low-only', description: LOW_JD })];
    const evaluateOne = vi.fn(async () => 'eval-never');
    const outcome = await evaluateResults(
      jobs,
      baseOpts({ evaluate: 'ai-subset', evaluateOne, minScore: 101 }),
    );
    expect(evaluateOne).not.toHaveBeenCalled();
    expect(outcome.ai.reason).toBe('no_candidates');
    expect(outcome.estimate).toEqual({ calls: 0, approxTokens: 0 });
  });

  it('outcome rows carry no application-shaped payload', async () => {
    const jobs = [makeJob({ externalId: 'clean' })];
    const outcome = await evaluateResults(
      jobs,
      baseOpts({ evaluate: 'ai-subset', evaluateOne: async () => 'eval-1' }),
    );
    for (const row of outcome.jobs) {
      expect(Object.keys(row).sort()).toEqual(['aiEvaluationId', 'deterministicScore', 'job']);
    }
  });
});

describe('N10 + N7 source guards (no auto-apply, no second evaluation model)', () => {
  function evaluationSources(): Array<{ file: string; code: string }> {
    const dir = path.resolve(__dirname);
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
      .map((entry) => ({
        file: entry,
        code: readFileSync(path.join(dir, entry), 'utf8'),
      }));
  }

  function stripComments(code: string): string {
    return code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
  }

  it('no prisma.application.create anywhere under backend/src/evaluation/', () => {
    for (const { file, code } of evaluationSources()) {
      const bare = stripComments(code);
      expect(bare, `${file} must not create Applications`).not.toMatch(/application\s*\.\s*create/i);
      expect(bare, `${file} must not touch the Application model`).not.toMatch(/prisma\.application/i);
    }
  });

  it('no second evaluation model or evaluation persistence in the pipeline', () => {
    for (const { file, code } of evaluationSources()) {
      const bare = stripComments(code);
      expect(bare, `${file} must not persist evaluations itself`).not.toMatch(/jobEvaluation\s*\.\s*create/i);
      expect(bare, `${file} must not declare a model`).not.toMatch(/^\s*model\s+\w+/m);
      expect(bare, `${file} must not import prisma`).not.toMatch(/lib\/prisma\.js/i);
    }
  });
});
