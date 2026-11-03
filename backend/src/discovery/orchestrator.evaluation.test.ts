// T783 wiring tests - the orchestrator calls the wave-9 evaluation pipeline
// per the intent's `evaluate` option and reports the estimate.
//
// Covered here (runSearch level, fakes only - no network, no DB):
// - effectiveEvaluateMode: default 'deterministic'; fast mode downgrades an
//   'ai-subset' request to 'deterministic' (zero AI calls, asserted).
// - a fast search with `evaluate: 'ai-subset'` performs ZERO AI calls and
//   still records a zeroed evaluation summary.
// - a deep search with `evaluate: 'ai-subset'` evaluates at most
//   MAX_AI_EVALUATIONS_PER_RUN, and the estimate is computed and reported
//   BEFORE the first AI call (same-request model: the estimate rides the
//   outcome/snapshot while the pass runs in the same request).
// - with no AI seam wired, 'ai-subset' reports `no_evaluator` with zero
//   calls (evaluation can never silently spend).
// - `evaluate: 'off'` performs zero AI calls.
// - collection results are untouched by the evaluation step.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawJob } from '../jobSources/adapters/http.js';
import type { JobSourceConfig } from '../jobSources/index.js';
import {
  deriveIntent,
  searchIntentSchema,
  type SearchIntent,
} from './searchIntent.js';
import { MAX_AI_EVALUATIONS_PER_RUN } from '../evaluation/aiSubset.js';
import {
  effectiveEvaluateMode,
  resetOrchestratorForTests,
  runSearch,
  type ExecutableUnit,
  type UserBoardRef,
} from './orchestrator.js';
import type { RunBudget } from './budgets.js';

const ROOMY_BUDGET: RunBudget = {
  maxUnits: 50,
  maxConcurrent: 4,
  perUnitTimeoutMs: 2000,
  totalBudgetMs: 15000,
  perSourceResultCap: 20,
};

beforeEach(() => {
  resetOrchestratorForTests();
});

const RESUME_TEXT = [
  'Senior frontend engineer with 6 years of React and TypeScript experience.',
  'Built GraphQL APIs with Node.js, Docker deployments, Jest testing.',
].join('\n');
const MATCHER_PROFILE = { skills: ['React', 'TypeScript', 'GraphQL', 'Node.js'] };

// Every description clears the pipeline's 50-char evaluability gate so the
// AI subset is non-empty whenever scoring produces candidates.
const LONG_DESCRIPTION =
  'Senior Frontend Engineer. React, TypeScript, Node.js, GraphQL, Docker, Jest. ' +
  'Extra senior frontend context to clear every length gate with room to spare.';

function makeJob(source: string, id: string): RawJob {
  return {
    externalId: id,
    source,
    sourceUrl: `https://example.com/${source}/${id}`,
    title: 'Senior Frontend Engineer',
    company: 'Acme',
    location: 'Berlin',
    description: LONG_DESCRIPTION,
  };
}

function board(id: string, type: string): UserBoardRef {
  return {
    boardId: id,
    name: `${type} ${id}`,
    type,
    config: { type, query: '', userId: 'u1' } as JobSourceConfig,
  };
}

function intentOf(overrides: Partial<Record<string, unknown>> = {}): SearchIntent {
  return searchIntentSchema.parse({ mode: 'fast', ...overrides });
}

describe('effectiveEvaluateMode', () => {
  it('defaults to deterministic when the intent carries no evaluate option', () => {
    expect(effectiveEvaluateMode(intentOf())).toBe('deterministic');
    expect(effectiveEvaluateMode(deriveIntent({ q: 'engineer' }))).toBe('deterministic');
  });

  it('passes explicit evaluate values through in deep mode', () => {
    expect(effectiveEvaluateMode(intentOf({ mode: 'deep', evaluate: 'off' }))).toBe('off');
    expect(effectiveEvaluateMode(intentOf({ mode: 'deep', evaluate: 'deterministic' }))).toBe(
      'deterministic',
    );
    expect(effectiveEvaluateMode(intentOf({ mode: 'deep', evaluate: 'ai-subset' }))).toBe(
      'ai-subset',
    );
  });

  it('downgrades ai-subset to deterministic in fast mode (fast never runs AI)', () => {
    expect(effectiveEvaluateMode(intentOf({ mode: 'fast', evaluate: 'ai-subset' }))).toBe(
      'deterministic',
    );
    expect(effectiveEvaluateMode(intentOf({ mode: 'fast', evaluate: 'off' }))).toBe('off');
  });

  it('deriveIntent accepts, defaults, and rejects evaluate values deterministically', () => {
    expect(deriveIntent({ q: 'x', evaluate: 'ai-subset' }).evaluate).toBe('ai-subset');
    expect(deriveIntent({ q: 'x' }).evaluate).toBe('deterministic');
    expect(deriveIntent({ q: 'x', evaluate: 'sometimes' }).evaluate).toBe('deterministic');
  });
});

describe('fast search performs zero AI calls', () => {
  it("an 'ai-subset' request in fast mode is evaluated deterministically (spy stays silent)", async () => {
    const evaluateOne = vi.fn(async (job: RawJob) => `eval-${job.externalId}`);
    const outcome = await runSearch(
      intentOf({ mode: 'fast', evaluate: 'ai-subset' }),
      { runId: 'r-fast', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [board('b1', 'greenhouse')],
        executeUnit: async () => [makeJob('greenhouse', 'g1'), makeJob('greenhouse', 'g2')],
        evaluation: { resumeText: RESUME_TEXT, matcherProfile: MATCHER_PROFILE, evaluateOne },
      },
    );
    expect(evaluateOne).not.toHaveBeenCalled();
    expect(outcome.jobs).toHaveLength(2);
    expect(outcome.evaluation).toEqual({
      requested: 0,
      completed: 0,
      skipped: 0,
      estimate: { calls: 0, approxTokens: 0 },
    });
  });

  it("evaluate 'off' performs zero AI calls", async () => {
    const evaluateOne = vi.fn(async () => 'eval-never');
    const outcome = await runSearch(
      intentOf({ mode: 'deep', evaluate: 'off' }),
      { runId: 'r-off', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [board('b1', 'greenhouse')],
        executeUnit: async () => [makeJob('greenhouse', 'g1')],
        evaluation: { resumeText: RESUME_TEXT, evaluateOne },
      },
    );
    expect(evaluateOne).not.toHaveBeenCalled();
    expect(outcome.evaluation?.estimate).toEqual({ calls: 0, approxTokens: 0 });
  });
});

describe('deep search with ai-subset: cap and estimate-before-AI', () => {
  function deepDeps(evaluateOne: (job: RawJob) => Promise<string>, onEstimate?: (e: { calls: number; approxTokens: number }) => void) {
    return {
      budget: ROOMY_BUDGET,
      listUserBoards: async () => [board('b1', 'greenhouse'), board('b2', 'rss')],
      executeUnit: async (unit: ExecutableUnit) =>
        Array.from({ length: 6 }, (_, i) => makeJob(unit.providerType, `${unit.unitId}-job-${i}`)),
      evaluation: {
        resumeText: RESUME_TEXT,
        matcherProfile: MATCHER_PROFILE,
        evaluateOne: async (job: RawJob) => evaluateOne(job),
        ...(onEstimate ? { onEstimate } : {}),
      },
    };
  }

  it('evaluates at most MAX_AI_EVALUATIONS_PER_RUN end to end (intent -> runSearch -> pipeline)', async () => {
    const evaluateOne = vi.fn(async (job: RawJob) => `eval-${job.externalId}`);
    const outcome = await runSearch(
      intentOf({ mode: 'deep', evaluate: 'ai-subset' }),
      { runId: 'r-deep', userId: 'u1' },
      deepDeps(evaluateOne),
    );
    // 12 collected jobs, all describable and scored: the cap rules.
    expect(outcome.jobs).toHaveLength(12);
    expect(evaluateOne).toHaveBeenCalledTimes(MAX_AI_EVALUATIONS_PER_RUN);
    expect(outcome.evaluation).toMatchObject({
      requested: MAX_AI_EVALUATIONS_PER_RUN,
      completed: MAX_AI_EVALUATIONS_PER_RUN,
      skipped: 0,
    });
    expect(outcome.evaluation?.reason).toBeUndefined();
    expect(outcome.evaluation?.estimate.calls).toBe(MAX_AI_EVALUATIONS_PER_RUN);
    expect(outcome.evaluation?.estimate.approxTokens).toBeGreaterThan(0);
  });

  it('the estimate is reported BEFORE the first AI call (same-request model)', async () => {
    const evaluateOne = vi.fn(async (job: RawJob) => `eval-${job.externalId}`);
    let callsAtEstimate = -1;
    let seenCalls = -1;
    const outcome = await runSearch(
      intentOf({ mode: 'deep', evaluate: 'ai-subset' }),
      { runId: 'r-est', userId: 'u1' },
      deepDeps(evaluateOne, (estimate) => {
        callsAtEstimate = evaluateOne.mock.calls.length;
        seenCalls = estimate.calls;
      }),
    );
    expect(callsAtEstimate).toBe(0);
    expect(seenCalls).toBe(evaluateOne.mock.calls.length);
    expect(outcome.evaluation?.estimate.calls).toBe(seenCalls);
  });
});

describe('no AI seam wired: ai-subset is reported, never silently spent', () => {
  it('reports no_evaluator with zero calls when deep + ai-subset has no evaluateOne', async () => {
    const outcome = await runSearch(
      intentOf({ mode: 'deep', evaluate: 'ai-subset' }),
      { runId: 'r-noseam', userId: 'u1' },
      {
        budget: ROOMY_BUDGET,
        listUserBoards: async () => [board('b1', 'greenhouse')],
        executeUnit: async () => [makeJob('greenhouse', 'g1')],
        evaluation: { resumeText: RESUME_TEXT },
      },
    );
    expect(outcome.evaluation).toMatchObject({ reason: 'no_evaluator' });
    expect(outcome.evaluation?.requested).toBeGreaterThan(0);
    expect(outcome.evaluation?.completed).toBe(0);
    // Collection still stands: the run is useful without AI.
    expect(outcome.jobs).toHaveLength(1);
  });
});
