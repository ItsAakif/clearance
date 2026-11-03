// Wave 9 Pass 2 tests (T781, ADR-027, N7): the extracted matcher is the ONLY
// scorer, it reproduces the pre-move outputs byte-identically, and the
// pipeline bridge (`scoreJobs`) orders + degrades as specified.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  UNSCORED_SCORE,
  buildResumeData,
  matchResumeToJob,
  scoreJobs,
} from './matcher.js';
import type { ResumeData } from './matcher.js';
import type { RawJob } from '../jobSources/adapters/http.js';
import { MATCHER_FIXTURES } from './matcher.fixtures.js';

const RESUME_TEXT = [
  'Senior frontend engineer with 6 years of React and TypeScript experience.',
  'Built GraphQL APIs with Node.js, Docker deployments, Jest testing.',
].join('\n');
const PROFILE = { skills: ['React', 'TypeScript', 'GraphQL', 'Node.js'] };

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    title: 'Frontend Engineer',
    company: 'Acme',
    location: 'Berlin',
    description: 'React TypeScript role.',
    ...overrides,
  };
}

const HIGH_JD = 'Senior Frontend Engineer. React, TypeScript, Node.js, GraphQL, Docker, Jest.';
const LOW_JD =
  'Data Scientist. Python, machine learning, pandas, SQL, statistics, Spark, TensorFlow.';

describe('extraction equivalence (STEP 2 proof)', () => {
  it.each(MATCHER_FIXTURES.map((f) => [f.name, f] as const))(
    'pre-move output for %s is reproduced byte-identically',
    (_name, fixture) => {
      const actual = matchResumeToJob(fixture.resume, fixture.jobDescription);
      // Byte-identical: same JSON bytes, not just deep-equal.
      expect(JSON.stringify(actual)).toBe(JSON.stringify(fixture.expected));
      expect(actual).toEqual(fixture.expected);
    },
  );

  // Timeout raised from the vitest default (5000ms) to 30s: this test's cost is
  // almost entirely the dynamic `import('../routes/job-match.js')` (whole route
  // graph transpiled + evaluated on first touch), not the assertion. Load
  // sensitivity measured on 2026-09-25: ~3.3s solo on a quiet box, but 16.2s solo
  // on a busier one, and >5s inside a full-suite parallel run - the 5000ms default
  // was hit twice during T892 review (5464ms) and again when the pre-fix timeout
  // was deliberately re-run for this change. 30s is headroom for import cost
  // only: a real hang in that import still fails, just not spuriously.
  it(
    'the route module re-exports the same scorer (single implementation)',
    async () => {
      const route = await import('../routes/job-match.js');
      const fixture = MATCHER_FIXTURES[0];
      expect(JSON.stringify(route.matchResumeToJob(fixture.resume, fixture.jobDescription))).toBe(
        JSON.stringify(fixture.expected),
      );
    },
    30_000,
  );
});

describe('bridge: pass-2 scores reuse the existing matcher', () => {
  it('deterministicScore equals matchResumeToJob output for the same inputs', () => {
    const jobs = [makeJob({ description: HIGH_JD }), makeJob({ description: LOW_JD })];
    const resume: ResumeData = buildResumeData(RESUME_TEXT, PROFILE);
    const scored = scoreJobs(jobs, { resumeText: RESUME_TEXT, profile: PROFILE });
    expect(scored).toHaveLength(2);
    for (const row of scored) {
      expect(row.scoreMode).toBe('matched');
      expect(row.scored).toBe(true);
      expect(row.deterministicScore).toBe(
        matchResumeToJob(resume, row.job.description ?? '').matchScore,
      );
      expect(row.deterministicScore).toBeGreaterThanOrEqual(0);
      expect(row.deterministicScore).toBeLessThanOrEqual(100);
    }
  });

  it('profile-only input (no resumeText) still scores via the same scorer', () => {
    const jobs = [makeJob({ description: HIGH_JD })];
    const [row] = scoreJobs(jobs, { profile: PROFILE });
    expect(row.scored).toBe(true);
    expect(row.deterministicScore).toBe(
      matchResumeToJob(buildResumeData(undefined, PROFILE), HIGH_JD).matchScore,
    );
  });

  it('orders score DESC, then postedAt DESC, then provenanceRank DESC', () => {
    const jobs = [
      makeJob({ externalId: 'low', description: LOW_JD, postedAt: new Date('2026-09-20T00:00:00Z') }),
      makeJob({
        externalId: 'tie-old',
        description: HIGH_JD,
        postedAt: new Date('2026-09-10T00:00:00Z'),
        postedAtSource: 'source-posted',
      }),
      makeJob({
        externalId: 'tie-new',
        description: HIGH_JD,
        postedAt: new Date('2026-09-18T00:00:00Z'),
        postedAtSource: 'source-posted',
      }),
      makeJob({
        externalId: 'tie-nodate-strong-prov',
        description: HIGH_JD,
        postedAtSource: 'source-posted',
      }),
      makeJob({
        externalId: 'tie-nodate-weak-prov',
        description: HIGH_JD,
        postedAtSource: 'unknown',
      }),
    ];
    const opts = { resumeText: RESUME_TEXT, profile: PROFILE };
    const order = scoreJobs(jobs, opts).map((r) => r.job.externalId);
    // Highest score first; the four HIGH_JD ties break by postedAt, then
    // provenance (dated rows outrank undated; source-posted outranks unknown).
    expect(order[0]).toBe('tie-new');
    expect(order[1]).toBe('tie-old');
    expect(order.slice(2, 4)).toEqual(['tie-nodate-strong-prov', 'tie-nodate-weak-prov']);
    expect(order[4]).toBe('low');
  });

  it('is deterministic: repeated runs give the same order', () => {
    const jobs = [
      makeJob({ externalId: 'a', description: HIGH_JD }),
      makeJob({ externalId: 'b', description: HIGH_JD }),
      makeJob({ externalId: 'c', description: LOW_JD }),
    ];
    const opts = { resumeText: RESUME_TEXT, profile: PROFILE };
    const first = scoreJobs(jobs, opts).map((r) => r.job.externalId);
    const second = scoreJobs(jobs, opts).map((r) => r.job.externalId);
    expect(second).toEqual(first);
  });

  it('empty input scores to an empty output', () => {
    expect(scoreJobs([], { resumeText: RESUME_TEXT })).toEqual([]);
  });
});

describe('bridge: no-resume / no-profile fallback (never an invented 0)', () => {
  const cases: Array<{ name: string; opts: Parameters<typeof scoreJobs>[1] }> = [
    { name: 'no opts content', opts: {} },
    { name: 'blank resumeText', opts: { resumeText: '   ' } },
    { name: 'empty profile', opts: { profile: {} } },
    { name: 'blank profile fields', opts: { profile: { skills: ['  '], summary: ' ' } } },
  ];

  it.each(cases.map((c) => [c.name, c.opts] as const))('marks rows unscored: %s', (_n, opts) => {
    const jobs = [makeJob({ externalId: 'a' }), makeJob({ externalId: 'b' })];
    const rows = scoreJobs(jobs, opts);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.scored).toBe(false);
      expect(row.scoreMode).toBe('unscored');
      // Sentinel outside 0..100: never mistaken for a genuine match score.
      expect(row.deterministicScore).toBe(UNSCORED_SCORE);
    }
    // Input order preserved: no fake ranking without a real score.
    expect(rows.map((r) => r.job.externalId)).toEqual(['a', 'b']);
  });
});

describe('no second scorer (STEP 5 guard)', () => {
  function allSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        allSourceFiles(full, out);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('exactly ONE matchScore computation exists under backend/src', () => {
    const srcRoot = path.resolve(__dirname, '..');
    const hits: string[] = [];
    for (const file of allSourceFiles(srcRoot)) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('matchScore = Math.round')) hits.push(path.relative(srcRoot, file));
    }
    // The single computation lives in the extracted module; the route only
    // re-exports it (declaration, not computation).
    expect(hits).toEqual([path.join('evaluation', 'matcher.ts')]);
  });
});
