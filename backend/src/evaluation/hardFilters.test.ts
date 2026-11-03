// Table-driven tests for Wave 9 Pass 1 hard filters (T780).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HARD_FILTER_REASONS,
  applyHardFilters,
  hardFilter,
  inferSeniorityLevel,
  isRemoteJob,
  jobFilterKey,
} from './hardFilters.js';
import type { HardFilterContext } from './hardFilters.js';
import type { RawJob } from '../jobSources/adapters/http.js';
import { deriveIntent } from '../discovery/searchIntent.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Berlin, Germany',
    description: 'Build APIs with TypeScript and Postgres.',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    externalId: 'gh-123',
    ...overrides,
  };
}

function makeCtx(
  overrides: Partial<HardFilterContext> = {},
  intentOverrides: Record<string, unknown> = {},
): HardFilterContext {
  return {
    intent: deriveIntent({ locations: [], ...intentOverrides }),
    known: { evaluatedJobIds: new Set(), appliedJobIds: new Set() },
    now: NOW,
    ...overrides,
  };
}

describe('hardFilter keep path', () => {
  it('keeps a plain job under a default intent', () => {
    expect(hardFilter(makeJob(), makeCtx())).toEqual({ keep: true });
  });

  it('an empty or missing profile does not crash and does not drop', () => {
    expect(hardFilter(makeJob(), makeCtx()).keep).toBe(true);
    expect(hardFilter(makeJob(), makeCtx({ profile: {} })).keep).toBe(true);
    expect(
      hardFilter(
        makeJob(),
        makeCtx({
          profile: { seniority: 'senior', locationPref: [], remoteOnly: false, topSkills: [] },
        }),
      ).keep,
    ).toBe(true);
  });
});

describe('one case per drop reason (fires + does not fire)', () => {
  const table: Array<{
    name: string;
    job: () => RawJob;
    ctx: () => HardFilterContext;
    reason: string;
    negative: { job: () => RawJob; ctx: () => HardFilterContext };
  }> = [
    {
      name: 'seniority_mismatch',
      job: () => makeJob({ title: 'Senior Staff Engineer' }),
      ctx: () => makeCtx({}, { seniority: 'junior' }),
      reason: HARD_FILTER_REASONS.seniorityMismatch,
      // Downgrade direction is NOT a hard failure.
      negative: {
        job: () => makeJob({ title: 'Junior Developer' }),
        ctx: () => makeCtx({}, { seniority: 'senior' }),
      },
    },
    {
      name: 'excluded',
      job: () => makeJob({ description: 'We need a PHP developer for legacy work.' }),
      ctx: () => makeCtx({}, { query: 'backend -php' }),
      reason: HARD_FILTER_REASONS.excluded,
      negative: {
        job: () => makeJob({ description: 'Build APIs with TypeScript.' }),
        ctx: () => makeCtx({}, { query: 'backend -php' }),
      },
    },
    {
      name: 'location_mismatch (remoteOnly)',
      job: () => makeJob({ title: 'Backend Engineer', location: 'Berlin, Germany' }),
      ctx: () => makeCtx({}, { remote: true }),
      reason: HARD_FILTER_REASONS.locationMismatch,
      negative: {
        job: () => makeJob({ title: 'Backend Engineer', location: 'Remote' }),
        ctx: () => makeCtx({}, { remote: true }),
      },
    },
    {
      name: 'location_mismatch (locations list)',
      job: () => makeJob({ title: 'Backend Engineer', location: 'Paris, France' }),
      ctx: () => makeCtx({}, { locations: ['Berlin'] }),
      reason: HARD_FILTER_REASONS.locationMismatch,
      negative: {
        job: () => makeJob({ title: 'Backend Engineer', location: 'Berlin, Germany' }),
        ctx: () => makeCtx({}, { locations: ['Berlin'] }),
      },
    },
    {
      name: 'already_evaluated',
      job: () => makeJob({ externalId: 'gh-123' }),
      ctx: () => makeCtx({ known: { evaluatedJobIds: new Set(['gh-123']), appliedJobIds: new Set() } }),
      reason: HARD_FILTER_REASONS.alreadyEvaluated,
      negative: {
        job: () => makeJob({ externalId: 'gh-999' }),
        ctx: () => makeCtx({ known: { evaluatedJobIds: new Set(['gh-123']), appliedJobIds: new Set() } }),
      },
    },
    {
      name: 'already_applied',
      job: () => makeJob({ externalId: 'gh-123' }),
      ctx: () => makeCtx({ known: { evaluatedJobIds: new Set(), appliedJobIds: new Set(['gh-123']) } }),
      reason: HARD_FILTER_REASONS.alreadyApplied,
      negative: {
        job: () => makeJob({ externalId: 'gh-999' }),
        ctx: () => makeCtx({ known: { evaluatedJobIds: new Set(), appliedJobIds: new Set(['gh-123']) } }),
      },
    },
    {
      name: 'expired',
      job: () =>
        { const j = makeJob(); (j as unknown as Record<string, unknown>).expiresAt = '2026-09-01T00:00:00.000Z'; return j; },
      ctx: () => makeCtx(),
      reason: HARD_FILTER_REASONS.expired,
      negative: {
        job: () =>
          { const j = makeJob(); (j as unknown as Record<string, unknown>).expiresAt = '2026-10-01T00:00:00.000Z'; return j; },
        ctx: () => makeCtx(),
      },
    },
  ];

  for (const row of table) {
    it(`${row.reason}: fires on a constructed input`, () => {
      expect(hardFilter(row.job(), row.ctx())).toEqual({ keep: false, reason: row.reason });
    });
    it(`${row.reason}: does not fire when it should not`, () => {
      expect(hardFilter(row.negative.job(), row.negative.ctx()).keep).toBe(true);
    });
  }

  it('duplicate: second occurrence in the batch drops, first is kept', () => {
    const a = makeJob();
    const b = makeJob();
    const { kept, dropped } = applyHardFilters([a, b], makeCtx());
    expect(kept).toEqual([a]);
    expect(dropped).toEqual([{ job: b, reason: HARD_FILTER_REASONS.duplicate }]);
  });

  it('duplicate: distinct jobs all keep', () => {
    const jobs = [makeJob({ externalId: 'a' }), makeJob({ externalId: 'b' })];
    const { kept, dropped } = applyHardFilters(jobs, makeCtx());
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });
});

describe('seniority rule follows ADR-009 / seniority.ts', () => {
  it('over-senior drops only when the intent states a level', () => {
    const job = makeJob({ title: 'Principal Engineer' });
    expect(hardFilter(job, makeCtx()).keep).toBe(true);
    expect(hardFilter(job, makeCtx({}, { seniority: 'mid' }))).toEqual({
      keep: false,
      reason: HARD_FILTER_REASONS.seniorityMismatch,
    });
  });

  it('unknown job level never drops, even with an intent level', () => {
    const job = makeJob({ title: 'Backend Engineer', description: 'Build APIs.' });
    expect(inferSeniorityLevel(job.title, job.description)).toBe('unknown');
    expect(hardFilter(job, makeCtx({}, { seniority: 'junior' })).keep).toBe(true);
  });

  it('management-axis titles resolve to lead (existing precedence)', () => {
    expect(inferSeniorityLevel('Associate Product Manager')).toBe('lead');
    expect(inferSeniorityLevel('Staff Software Engineer')).toBe('staff');
  });
});

describe('already-applied is evaluation-only, nothing is deleted', () => {
  it('the input array still holds the job and no store is touched', () => {
    const job = makeJob({ externalId: 'gh-123' });
    const jobs = [job];
    const ctx = makeCtx({ known: { evaluatedJobIds: new Set(), appliedJobIds: new Set(['gh-123']) } });
    const { kept, dropped } = applyHardFilters(jobs, ctx);
    expect(kept).toHaveLength(0);
    expect(dropped).toEqual([{ job, reason: HARD_FILTER_REASONS.alreadyApplied }]);
    // NOT deleted: the caller's array is untouched (same length, same ref).
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toBe(job);
  });
});

describe('expiry uses the injected now', () => {
  it('the same job keeps with an earlier now and drops with a later now', () => {
    const job = makeJob();
    (job as unknown as Record<string, unknown>).expiresAt = '2026-09-21T12:00:00.000Z';
    const earlier = makeCtx({ now: new Date('2026-09-20T00:00:00.000Z') });
    const later = makeCtx({ now: new Date('2026-09-22T00:00:00.000Z') });
    expect(hardFilter(job, earlier).keep).toBe(true);
    expect(hardFilter(job, later)).toEqual({ keep: false, reason: HARD_FILTER_REASONS.expired });
  });
});

describe('remote jobs bypass the locations list', () => {
  it('a remote posting keeps even when locations are required', () => {
    const job = makeJob({ title: 'Backend Engineer', location: 'Remote' });
    expect(isRemoteJob(job)).toBe(true);
    expect(hardFilter(job, makeCtx({}, { locations: ['Berlin'] })).keep).toBe(true);
  });
});

describe('determinism', () => {
  it('same input produces the same output across calls, kept in input order', () => {
    const jobs = [
      makeJob({ externalId: 'keep-1', title: 'Backend Engineer' }),
      makeJob({ externalId: 'drop-1', title: 'Senior Staff Engineer' }),
      makeJob({ externalId: 'keep-2', title: 'Junior Developer' }),
      makeJob({ externalId: 'keep-1', title: 'Backend Engineer' }),
    ];
    const ctx = makeCtx({}, { seniority: 'mid' });
    const first = applyHardFilters(jobs, ctx);
    const second = applyHardFilters(jobs, ctx);
    expect(second).toEqual(first);
    expect(first.kept.map((j) => j.externalId)).toEqual(['keep-1', 'keep-2']);
    expect(first.dropped.map((d) => d.reason)).toEqual([
      HARD_FILTER_REASONS.seniorityMismatch,
      HARD_FILTER_REASONS.duplicate,
    ]);
  });

  it('jobFilterKey is stable for the same job', () => {
    expect(jobFilterKey(makeJob())).toBe(jobFilterKey(makeJob()));
  });
});

describe('purity (no clock read, no Prisma, no LLM)', () => {
  const source = readFileSync(path.join(__dirname, 'hardFilters.ts'), 'utf8');

  it('reads no clock', () => {
    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/new\s+Date\(\)/);
  });

  it('imports no Prisma, no store, no route, no LLM client', () => {
    expect(source).not.toMatch(/prisma/i);
    expect(source).not.toMatch(/openai/i);
    expect(source).not.toMatch(/anthropic/i);
    // The only cross-module imports allowed are `import type` (erased at
    // compile time): no runtime dependency on any route, store, or AI code.
    const runtimeImports = source
      .split('\n')
      .filter((line) => /^\s*import\s+(?!type\b)/.test(line));
    expect(runtimeImports).toEqual([]);
  });

  it('creates no Application row', () => {
    expect(source).not.toMatch(/application\s*\.\s*create/i);
    expect(source).not.toMatch(/Application/);
  });
});
