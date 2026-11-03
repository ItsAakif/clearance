// Wave 9 Pass 3 tests (T782): deterministic subset selection, cap
// enforcement, and honest cost-estimate math.
import { describe, it, expect } from 'vitest';
import {
  AI_EVALUATION_CONCURRENCY,
  MAX_AI_EVALUATIONS_PER_RUN,
  estimateCost,
  selectAiSubset,
} from './aiSubset.js';
import type { ScoredJob } from './matcher.js';
import type { RawJob } from '../jobSources/adapters/http.js';

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    title: 'Engineer',
    company: 'Acme',
    location: 'Berlin',
    description: 'A comfortably long job description that clears fifty characters easily.',
    ...overrides,
  };
}

function scoredRow(externalId: string, score: number): ScoredJob {
  return {
    job: makeJob({ externalId }),
    deterministicScore: score,
    scoreMode: 'matched',
    scored: true,
  };
}

function unscoredRow(externalId: string): ScoredJob {
  return {
    job: makeJob({ externalId }),
    deterministicScore: -1,
    scoreMode: 'unscored',
    scored: false,
  };
}

describe('caps are sane named constants', () => {
  it('MAX_AI_EVALUATIONS_PER_RUN is a small positive bound', () => {
    expect(Number.isInteger(MAX_AI_EVALUATIONS_PER_RUN)).toBe(true);
    expect(MAX_AI_EVALUATIONS_PER_RUN).toBeGreaterThan(0);
    expect(MAX_AI_EVALUATIONS_PER_RUN).toBeLessThanOrEqual(10);
  });

  it('AI_EVALUATION_CONCURRENCY is a small positive bound', () => {
    expect(Number.isInteger(AI_EVALUATION_CONCURRENCY)).toBe(true);
    expect(AI_EVALUATION_CONCURRENCY).toBeGreaterThan(0);
    expect(AI_EVALUATION_CONCURRENCY).toBeLessThanOrEqual(MAX_AI_EVALUATIONS_PER_RUN);
  });
});

describe('selectAiSubset ranking', () => {
  it('keeps rows at or above minScore and drops the rest', () => {
    const rows = [scoredRow('a', 90), scoredRow('b', 70), scoredRow('c', 69)];
    const subset = selectAiSubset(rows, { minScore: 70, maxCount: 5 });
    expect(subset.map((r) => r.job.externalId)).toEqual(['a', 'b']);
  });

  it('preserves the pass-2 order (stable subsequence, no re-sort)', () => {
    // Input is already pass-2 ranked: ties broken by postedAt/provenance.
    // The subset must follow that order, not re-sort by score.
    const rows = [scoredRow('first', 80), scoredRow('second', 80), scoredRow('third', 95)];
    const subset = selectAiSubset(rows, { minScore: 0, maxCount: 5 });
    expect(subset.map((r) => r.job.externalId)).toEqual(['first', 'second', 'third']);
  });

  it('is deterministic: repeated runs give the identical subset', () => {
    const rows = [
      scoredRow('a', 88),
      scoredRow('b', 88),
      scoredRow('c', 91),
      scoredRow('d', 12),
      unscoredRow('e'),
    ];
    const first = selectAiSubset(rows, { minScore: 50, maxCount: 3 });
    const second = selectAiSubset(rows, { minScore: 50, maxCount: 3 });
    expect(second.map((r) => r.job.externalId)).toEqual(first.map((r) => r.job.externalId));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('never selects unscored rows, even with a permissive minScore', () => {
    const rows = [unscoredRow('ghost'), scoredRow('real', 10)];
    const subset = selectAiSubset(rows, { minScore: -100, maxCount: 5 });
    expect(subset.map((r) => r.job.externalId)).toEqual(['real']);
  });

  it('returns the input row references (no copies)', () => {
    const rows = [scoredRow('a', 60)];
    const [only] = selectAiSubset(rows, { minScore: 0, maxCount: 5 });
    expect(only).toBe(rows[0]);
    expect(only.job).toBe(rows[0].job);
  });
});

describe('selectAiSubset cap enforcement', () => {
  function many(count: number): ScoredJob[] {
    return Array.from({ length: count }, (_, i) => scoredRow(`job-${i}`, 100 - i));
  }

  it(`never exceeds MAX_AI_EVALUATIONS_PER_RUN however large maxCount is`, () => {
    const subset = selectAiSubset(many(50), { minScore: 0, maxCount: 1000 });
    expect(subset).toHaveLength(MAX_AI_EVALUATIONS_PER_RUN);
  });

  it('honours a maxCount below the cap', () => {
    const subset = selectAiSubset(many(50), { minScore: 0, maxCount: 2 });
    expect(subset).toHaveLength(2);
    expect(subset.map((r) => r.job.externalId)).toEqual(['job-0', 'job-1']);
  });

  it('returns fewer when fewer are eligible', () => {
    const subset = selectAiSubset(many(3), { minScore: 0, maxCount: 50 });
    expect(subset).toHaveLength(3);
  });

  it.each([0, -1, -100])('selects nothing for non-positive maxCount (%d)', (maxCount) => {
    expect(selectAiSubset(many(10), { minScore: 0, maxCount })).toEqual([]);
  });

  it('selects nothing from an empty input', () => {
    expect(selectAiSubset([], { minScore: 0, maxCount: 5 })).toEqual([]);
  });
});

describe('estimateCost math', () => {
  it('calls equals the subset size and tokens follow the documented formula', () => {
    const rows = [scoredRow('a', 90), scoredRow('b', 80)];
    const got = estimateCost(rows);
    expect(got.calls).toBe(2);
    const expected = rows.reduce(
      (sum, r) => sum + 1200 + Math.ceil((r.job.description?.length ?? 0) / 4) + 600,
      0,
    );
    expect(got.approxTokens).toBe(expected);
  });

  it('scales with description length (the only per-job input)', () => {
    const short = scoredRow('short', 90);
    const long: ScoredJob = {
      ...scoredRow('long', 90),
      job: makeJob({ externalId: 'long', description: 'x'.repeat(4000) }),
    };
    expect(estimateCost([long]).approxTokens).toBeGreaterThan(
      estimateCost([short]).approxTokens,
    );
    expect(estimateCost([long]).calls).toBe(1);
  });

  it('is zero for an empty subset', () => {
    expect(estimateCost([])).toEqual({ calls: 0, approxTokens: 0 });
  });

  it('is pure (same input, same output; no mutation)', () => {
    const rows = [scoredRow('a', 90)];
    const before = JSON.stringify(rows);
    const first = estimateCost(rows);
    const second = estimateCost(rows);
    expect(second).toEqual(first);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
