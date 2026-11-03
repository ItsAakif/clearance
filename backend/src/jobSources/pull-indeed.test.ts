import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/prisma.js', () => ({ default: {} }));

vi.mock('../lib/crypto.js', () => ({ decryptSecret: (s: string) => s }));

vi.mock('../ai/keyManager.js', () => ({
  leaseNextKey: vi.fn(async () => ({
    id: 'rapidapi-key-1',
    apiKey: 'SECRET-KEY-VALUE',
    provider: 'rapidapi',
    source: 'database',
    userId: 'user-1',
  })),
  markKeySuccess: vi.fn(async () => undefined),
  markKeyFailure: vi.fn(async () => undefined),
}));

import { normalizePullIndeed, scrapeBoard, resetRapidApiThrottle } from './scrapingBackend.js';

describe('normalizePullIndeed (ADR-018)', () => {
  it('synthesizes viewjob URL from job_key with snippet description', () => {
    const row = {
      job_key: 'abc123xyz',
      title: 'Backend Engineer',
      company: 'Acme Corp',
      location: 'Berlin, DE',
      snippet: ['a', 'b'],
    };
    const j = normalizePullIndeed(row);
    expect(j).not.toBeNull();
    expect(j?.applyUrl).toBe('https://www.indeed.com/viewjob?jk=abc123xyz');
    expect(j?.sourceUrl).toBe('https://www.indeed.com/viewjob?jk=abc123xyz');
    expect(j?.externalId).toBe('indeed:abc123xyz');
    expect(j?.source).toBe('indeed');
    expect(j?.backend).toBe('rapidapi');
    expect(j?.description).toContain('a');
    expect(j?.description).toContain('b');
    expect(j?.title).toBe('Backend Engineer');
    expect(j?.company).toBe('Acme Corp');
    expect(j?.postedAt).toBeUndefined();
  });

  it('supports jobKey camelCase and encodes special chars', () => {
    const j = normalizePullIndeed({ jobKey: 'a b&c', title: 'T', company: 'C' });
    expect(j?.applyUrl).toBe('https://www.indeed.com/viewjob?jk=a%20b%26c');
    expect(j?.externalId).toBe('indeed:a b&c');
  });

  it('prefers a real URL when present', () => {
    const j = normalizePullIndeed({
      job_key: 'k1',
      job_url: 'https://www.indeed.com/page-1',
      title: 'T',
      company: 'C',
      description: '<p>Real desc</p>',
    });
    expect(j?.applyUrl).toBe('https://www.indeed.com/page-1');
    expect(j?.externalId).toBe('indeed:k1');
    expect(j?.description).toContain('Real desc');
  });

  it('returns null when neither URL nor job_key is present', () => {
    expect(normalizePullIndeed({ title: 'T', company: 'C' })).toBeNull();
  });

  it('passes a string snippet through', () => {
    const j = normalizePullIndeed({ job_key: 'k2', snippet: 'solo line' });
    expect(j?.description).toContain('solo line');
  });
});

describe('PullAPI Indeed call site uses normalizePullIndeed', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resetRapidApiThrottle();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('indeed board maps job_key rows via synthesized URL', async () => {
    const indeedRow = {
      job_key: 'live-key-1',
      title: 'Frontend Engineer',
      company: 'Beta Inc',
      location: 'Remote',
      snippet: ['great', 'role'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('indeed-scraper-api2.p.rapidapi.com')) {
          return { ok: true, status: 200, json: async () => ({ data: { jobs: [indeedRow] } }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      })
    );
    const jobs = await scrapeBoard({ provider: 'indeed', query: 'engineer' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].applyUrl).toBe('https://www.indeed.com/viewjob?jk=live-key-1');
    expect(jobs[0].source).toBe('indeed');
  });

  it('LinkedIn behaviour unchanged (job_url passthrough)', async () => {
    const liRow = {
      job_url: 'https://www.linkedin.com/jobs/view/123',
      title: 'Engineer',
      company: 'LiCo',
      location: 'Berlin',
      description: 'Build stuff.',
      posted_date: '2026-09-01T10:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('linkedin-scraper-api6.p.rapidapi.com')) {
          return { ok: true, status: 200, json: async () => ({ data: { jobs: [liRow] } }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      })
    );
    const jobs = await scrapeBoard({ provider: 'linkedin', query: 'engineer' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].applyUrl).toBe('https://www.linkedin.com/jobs/view/123');
    expect(jobs[0].source).toBe('linkedin');
  });
});
