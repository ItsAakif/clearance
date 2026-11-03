import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  DEDUPE_FUZZY_ENABLED,
  canonicalUrlKey,
  companyTitleLocationKey,
  contentKey,
  dedupeJobs,
  groupCanonicalKey,
  hasCorroboration,
  loosenUrl,
  providerKey,
  titlesFuzzilySimilar,
} from './dedupe.js';
import type { RawJob } from '../jobSources/adapters/http.js';

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

describe('tier keys', () => {
  it('T1 strips tracking params before comparing urls', () => {
    const a = makeJob({
      applyUrl: 'https://example.com/j?utm_medium=x&gclid=1',
    });
    const b = makeJob({ applyUrl: 'https://example.com/j' });
    expect(canonicalUrlKey(a)).toBe(canonicalUrlKey(b));
  });

  it('T2 requires both provider and external id', () => {
    expect(providerKey(makeJob({ externalId: 'gh-1' }))).toBe(
      'greenhouse||gh-1',
    );
    expect(providerKey(makeJob({ externalId: undefined }))).toBe('');
    expect(providerKey(makeJob({ source: '', externalId: 'gh-1' }))).toBe('');
  });

  it('T3 loosenUrl is scheme- and www-insensitive where T1 is not', () => {
    const a = makeJob({ applyUrl: 'https://www.example.com/jobs/1' });
    const b = makeJob({ applyUrl: 'http://example.com/jobs/1' });
    expect(canonicalUrlKey(a)).not.toBe(canonicalUrlKey(b));
    expect(loosenUrl(a.applyUrl)).toBe(loosenUrl(b.applyUrl));
  });

  it('T4 excludes location but requires title and company', () => {
    const a = makeJob({ location: 'Remote' });
    const b = makeJob({ location: 'Onsite' });
    expect(contentKey(a)).toBe(contentKey(b));
    expect(contentKey(makeJob({ title: '' }))).toBe('');
    expect(contentKey(makeJob({ company: '' }))).toBe('');
  });

  it('T5 anchor requires company, title AND location', () => {
    expect(companyTitleLocationKey(makeJob())).toBeTruthy();
    expect(companyTitleLocationKey(makeJob({ location: '' }))).toBe('');
    expect(companyTitleLocationKey(makeJob({ location: undefined }))).toBe('');
  });

  it('corroboration needs description, host, or id - never anchor alone', () => {
    const a = makeJob({
      description: 'Alpha',
      sourceUrl: 'https://a.example.com/x',
      applyUrl: 'https://a.example.com/x',
      externalId: 'id-a',
    });
    const b = makeJob({
      description: 'Beta',
      sourceUrl: 'https://b.example.com/y',
      applyUrl: 'https://b.example.com/y',
      externalId: 'id-b',
    });
    expect(hasCorroboration(a, b)).toBe(false);
    expect(hasCorroboration(a, { ...b, description: 'Alpha' })).toBe(true);
    expect(
      hasCorroboration(a, { ...b, sourceUrl: 'https://a.example.com/other' }),
    ).toBe(true);
    expect(hasCorroboration(a, { ...b, externalId: 'id-a' })).toBe(true);
  });

  it('T6 requires same company (title similarity alone never merges)', () => {
    const a = makeJob({ title: 'Senior Frontend Engineer' });
    const b = makeJob({
      title: 'Senior Frontend Engineer II',
      company: 'Other Corp',
    });
    expect(titlesFuzzilySimilar(a, b)).toBe(false);
    expect(
      titlesFuzzilySimilar(a, { ...b, company: 'Acme' }),
    ).toBe(true);
    expect(titlesFuzzilySimilar(a, makeJob({ title: 'Janitor' }))).toBe(false);
  });
});

describe('dedupeJobs tiers', () => {
  it('T1: one listing via THREE sources dedupes to ONE row with 3 sources', () => {
    const jobs = [
      makeJob({ source: 'greenhouse', externalId: 'gh-123' }),
      makeJob({
        source: 'ashby',
        externalId: 'ashby-456',
        sourceUrl:
          'https://boards.greenhouse.io/acme/jobs/123?utm_source=newsletter',
        applyUrl:
          'https://boards.greenhouse.io/acme/jobs/123?utm_source=newsletter',
      }),
      makeJob({
        source: 'lever',
        externalId: 'lever-789',
        sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123#apply',
        applyUrl: 'https://boards.greenhouse.io/acme/jobs/123#apply',
      }),
    ];
    const deduped = dedupeJobs(jobs);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].sources).toHaveLength(3);
    expect(deduped[0].sources?.map((s) => s.source).sort()).toEqual(
      ['ashby', 'greenhouse', 'lever'],
    );
    expect(deduped[0].canonicalKey).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('T2: same provider + external id merges despite different urls', () => {
    const a = makeJob({
      source: 'ashby',
      externalId: 'ashby-456',
      sourceUrl: 'https://ashby.example.com/jobs/one',
      applyUrl: 'https://ashby.example.com/jobs/one',
      title: 'Role One',
    });
    const b = makeJob({
      source: 'ashby',
      externalId: 'ashby-456',
      sourceUrl: 'https://ashby.example.com/jobs/two',
      applyUrl: 'https://ashby.example.com/jobs/two',
      title: 'Role Two Renamed',
      company: 'Acme Changed',
      description: 'Totally different description here.',
    });
    expect(dedupeJobs([a, b])).toHaveLength(1);
  });

  it('T3: scheme/www variants merge where T1 keys differ', () => {
    const a = makeJob({
      sourceUrl: 'https://www.example.com/jobs/1',
      applyUrl: 'https://www.example.com/jobs/1',
      title: 'Role Alpha',
      company: 'Acme',
      description: 'Description alpha.',
    });
    const b = makeJob({
      sourceUrl: 'http://example.com/jobs/1',
      applyUrl: 'http://example.com/jobs/1',
      title: 'Role Beta',
      company: 'Beta Corp',
      description: 'Description beta, unrelated.',
    });
    expect(canonicalUrlKey(a)).not.toBe(canonicalUrlKey(b));
    const deduped = dedupeJobs([a, b]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].sources).toHaveLength(2);
  });

  it('T4: a row with no URL groups only via content match', () => {
    const withUrl = makeJob();
    const withoutUrl = makeJob({ sourceUrl: '', applyUrl: '' });
    expect(canonicalUrlKey(withoutUrl)).toBe('');
    expect(dedupeJobs([withUrl, withoutUrl])).toHaveLength(1);

    const differentContent = makeJob({
      sourceUrl: '',
      applyUrl: '',
      description: 'An entirely unrelated description.',
    });
    expect(dedupeJobs([withUrl, differentContent])).toHaveLength(2);
  });

  it('T5: company+title+location + corroborating host merges (T4 cannot fire)', () => {
    const a = makeJob({
      sourceUrl: 'https://a.example.com/jobs/1',
      applyUrl: 'https://a.example.com/jobs/1',
      description: 'First description of the role.',
      externalId: 'id-a',
    });
    const b = makeJob({
      source: 'lever',
      externalId: 'id-b',
      sourceUrl: 'https://a.example.com/openings/2',
      applyUrl: 'https://a.example.com/openings/2',
      description: 'Second, differently-worded description.',
    });
    // Same company/title/location and same host, but different paths (no
    // T1/T3), ids (no T2), and descriptions (no T4): only T5 can merge.
    expect(contentKey(a)).not.toBe(contentKey(b));
    expect(canonicalUrlKey(a)).not.toBe(canonicalUrlKey(b));
    expect(dedupeJobs([a, b])).toHaveLength(1);
  });

  it('T5 must NOT fire on company+title+location alone', () => {
    const a = makeJob({
      sourceUrl: 'https://a.example.com/jobs/1',
      applyUrl: 'https://a.example.com/jobs/1',
      description: 'First description.',
      externalId: 'id-a',
    });
    const b = makeJob({
      source: 'lever',
      externalId: 'id-b',
      sourceUrl: 'https://b.example.com/openings/2',
      applyUrl: 'https://b.example.com/openings/2',
      description: 'Second, unrelated description.',
    });
    expect(companyTitleLocationKey(a)).toBe(companyTitleLocationKey(b));
    expect(hasCorroboration(a, b)).toBe(false);
    expect(dedupeJobs([a, b])).toHaveLength(2);
  });

  it('N12: identical titles at DIFFERENT companies never merge', () => {
    const a = makeJob({ company: 'Acme' });
    const b = makeJob({
      company: 'Globex',
      source: 'lever',
      sourceUrl: 'https://lever.example.com/gx/9',
      applyUrl: 'https://lever.example.com/gx/9',
      description: 'Build React apps with TypeScript.',
    });
    expect(a.title).toBe(b.title);
    expect(dedupeJobs([a, b])).toHaveLength(2);
  });

  it('same title + same company but DIFFERENT location do not merge', () => {
    const a = makeJob({
      location: 'Remote',
      sourceUrl: 'https://a.example.com/jobs/1',
      applyUrl: 'https://a.example.com/jobs/1',
      description: 'Description one.',
      externalId: 'id-a',
    });
    const b = makeJob({
      location: 'New York, NY',
      source: 'lever',
      externalId: 'id-b',
      sourceUrl: 'https://b.example.com/openings/2',
      applyUrl: 'https://b.example.com/openings/2',
      description: 'Description two, different.',
    });
    expect(dedupeJobs([a, b])).toHaveLength(2);
  });

  it('T6 is OFF by default and opt-in via enableFuzzy', () => {
    expect(DEDUPE_FUZZY_ENABLED).toBe(false);
    const a = makeJob({
      title: 'Senior Frontend Engineer',
      sourceUrl: 'https://a.example.com/jobs/1',
      applyUrl: 'https://a.example.com/jobs/1',
      description: 'Description one.',
      location: 'Remote',
      externalId: 'id-a',
    });
    const b = makeJob({
      title: 'Senior Frontend Engineer II',
      source: 'lever',
      externalId: 'id-b',
      sourceUrl: 'https://b.example.com/openings/2',
      applyUrl: 'https://b.example.com/openings/2',
      description: 'Description two, different.',
      location: 'Austin, TX',
    });
    // No tier except fuzzy can fire: urls, ids, content, and T5 all differ.
    expect(dedupeJobs([a, b])).toHaveLength(2);
    const fuzzy = dedupeJobs([a, b], { enableFuzzy: true });
    expect(fuzzy).toHaveLength(1);
    expect(fuzzy[0].sources).toHaveLength(2);
  });

  it('empty input returns empty output', () => {
    expect(dedupeJobs([])).toEqual([]);
  });
});

describe('canonicalKey + field precedence', () => {
  it('canonicalKey is stable across re-runs and input order', () => {
    const jobs = [
      makeJob({ source: 'greenhouse', externalId: 'gh-123' }),
      makeJob({ source: 'ashby', externalId: 'ashby-456' }),
      makeJob({ source: 'lever', externalId: 'lever-789' }),
    ];
    const first = dedupeJobs(jobs)[0].canonicalKey;
    const reversed = dedupeJobs([...jobs].reverse())[0].canonicalKey;
    expect(first).toBeTruthy();
    expect(reversed).toBe(first);
    expect(groupCanonicalKey(jobs)).toBe(first);
  });

  it('canonicalKey prefers the T1 identity when present', () => {
    const jobs = [
      makeJob({ source: 'greenhouse', externalId: 'gh-123' }),
      makeJob({ source: 'ashby', externalId: 'ashby-456' }),
    ];
    const expected =
      'sha256-' +
      createHash('sha256')
        .update(`url:${canonicalUrlKey(jobs[0])}`, 'utf8')
        .digest('hex');
    expect(dedupeJobs(jobs)[0].canonicalKey).toBe(expected);
  });

  it('field precedence: longest description wins (not first-wins)', () => {
    const short = makeJob({ description: 'Short.' });
    const long = makeJob({
      source: 'ashby',
      description: 'A much longer, more informative description of the role.',
    });
    const [merged] = dedupeJobs([short, long]);
    expect(merged.description).toBe(long.description);
    // And symmetrically when the order flips.
    const [mergedFlipped] = dedupeJobs([long, short]);
    expect(mergedFlipped.description).toBe(long.description);
  });

  it('field precedence: date triple stays together from the dated row', () => {
    const postedAt = new Date('2026-09-10T12:00:00.000Z');
    const undated = makeJob({ postedAt: undefined });
    const dated = makeJob({
      source: 'ashby',
      postedAt,
      postedAtSource: 'source-posted',
      postedAtRaw: '2026-09-10',
    });
    const [merged] = dedupeJobs([undated, dated]);
    expect(merged.postedAt).toEqual(postedAt);
    expect(merged.postedAtSource).toBe('source-posted');
    expect(merged.postedAtRaw).toBe('2026-09-10');
  });

  it('source union keeps every url even when the survivor carries one', () => {
    const a = makeJob({
      sourceUrl: 'https://a.example.com/jobs/1',
      applyUrl: 'https://a.example.com/jobs/1',
    });
    const b = makeJob({
      source: 'lever',
      sourceUrl: 'https://b.example.com/openings/2',
      applyUrl: 'https://b.example.com/openings/2',
    });
    const [merged] = dedupeJobs([a, b]);
    const urls = (merged.sources ?? []).flatMap((s) => [
      s.sourceUrl,
      s.applyUrl,
    ]);
    expect(urls).toContain('https://a.example.com/jobs/1');
    expect(urls).toContain('https://b.example.com/openings/2');
  });
});
