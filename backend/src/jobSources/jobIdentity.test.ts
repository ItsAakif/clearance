import { describe, it, expect } from 'vitest';
import {
  dedupeJobs,
  withDeterministicExternalId,
  jobExternalId,
  canonicalizeJobIdentity,
} from './jobIdentity.js';
import type { RawJob } from './index.js';

function makeJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    title: 'Senior Frontend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Build React apps with TypeScript.',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    ...overrides,
  };
}

describe('jobIdentity', () => {
  it('(a) dedupes the same job discovered from two boards to one listing', () => {
    const fromBoardA = makeJob({ source: 'greenhouse', externalId: 'gh-123' });
    // Same posting seen via a second board (different source id, tracking params).
    const fromBoardB = makeJob({
      source: 'ashby',
      externalId: 'ashby-456',
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123?utm_source=newsletter',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/123?utm_source=newsletter',
    });

    const deduped = dedupeJobs([fromBoardA, fromBoardB]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].externalId).toBeTruthy();
  });

  it('(b) keeps different jobs separate', () => {
    const jobA = makeJob({ applyUrl: 'https://example.com/jobs/a', sourceUrl: 'https://example.com/jobs/a' });
    const jobB = makeJob({
      title: 'Backend Engineer',
      applyUrl: 'https://example.com/jobs/b',
      sourceUrl: 'https://example.com/jobs/b',
    });

    const deduped = dedupeJobs([jobA, jobB]);
    expect(deduped).toHaveLength(2);
  });

  it('(c) repeated scans produce stable ids so upserts update instead of duplicating', () => {
    // Jobs without any source id (the old `manual-${Date.now()}-${random}` case).
    const scanOne = [makeJob({ externalId: undefined }), makeJob({ externalId: undefined, title: 'Other Role', applyUrl: 'https://example.com/other', sourceUrl: 'https://example.com/other' })];
    const scanTwo = [makeJob({ externalId: undefined }), makeJob({ externalId: undefined, title: 'Other Role', applyUrl: 'https://example.com/other', sourceUrl: 'https://example.com/other' })];

    const first = dedupeJobs(scanOne);
    const second = dedupeJobs(scanTwo);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    // Same deterministic upsert key on every scan -> update path, not duplicates.
    expect(second.map((j) => j.externalId).sort()).toEqual(first.map((j) => j.externalId).sort());
    for (const j of [...first, ...second]) {
      expect(j.externalId).not.toMatch(/^manual-/);
    }
    // Pure function: identical input, identical id.
    expect(withDeterministicExternalId(makeJob()).externalId).toBe(jobExternalId(makeJob()));
  });

  it('strips tracking params before comparing urls', () => {
    const a = makeJob({ applyUrl: 'https://example.com/j?utm_medium=x&gclid=1', sourceUrl: 'https://example.com/j' });
    const b = makeJob({ applyUrl: 'https://example.com/j', sourceUrl: 'https://example.com/j' });
    expect(canonicalizeJobIdentity(a)).toBe(canonicalizeJobIdentity(b));
    expect(dedupeJobs([a, b])).toHaveLength(1);
  });
});
