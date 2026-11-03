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

import { scrapeBoard, extractJSearchItems, resetRapidApiThrottle } from './scrapingBackend.js';

function failAll(status = 403) {
  return vi.fn(async () => ({ ok: false, status, json: async () => ({}) }));
}

function okWith(body: unknown) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
}

describe('scrapeViaRapidApi failure visibility (D1)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resetRapidApiThrottle();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws an aggregated error (no key material) when every upstream errors', async () => {
    vi.stubGlobal('fetch', failAll(403));
    const err = await scrapeBoard({ provider: 'linkedin', query: 'engineer' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/RapidAPI all upstreams failed/);
    expect(String(err.message)).toContain('JSearch');
    expect(String(err.message)).toContain('PullAPI LinkedIn');
    // Statuses are named, but the key itself must never appear.
    expect(String(err.message)).toContain('403');
    expect(String(err.message)).not.toContain('SECRET-KEY-VALUE');
  });

  it('throws for non-linkedin hard boards too (JSearch + PullAPI both failing)', async () => {
    vi.stubGlobal('fetch', failAll(401));
    await expect(scrapeBoard({ provider: 'ziprecruiter', query: 'engineer' })).rejects.toThrow(
      /RapidAPI all upstreams failed/
    );
  });

  it('does NOT throw when one upstream succeeds with rows (fallback still works)', async () => {
    const liJob = { job_url: 'https://example.com/li/1', title: 'Engineer', company: 'LiCo' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('linkedin-scraper-api6.p.rapidapi.com')) {
          return { ok: true, status: 200, json: async () => ({ data: { jobs: [liJob] } }) };
        }
        return { ok: false, status: 403, json: async () => ({}) };
      })
    );
    const jobs = await scrapeBoard({ provider: 'linkedin', query: 'engineer' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: 'Engineer', backend: 'rapidapi' });
  });

  it('returns [] without throwing when upstreams succeed with zero rows (genuine "no jobs")', async () => {
    vi.stubGlobal('fetch', okWith({ data: [] }));
    const jobs = await scrapeBoard({ provider: 'linkedin', query: 'engineer' });
    expect(jobs).toEqual([]);
  });

  it('normalizes documented /search-v2 rows (job_title/employer_name/job_apply_link/job_description/job_id)', async () => {
    const jsearchRow = {
      job_id: 'abc123',
      job_title: 'Senior Backend Engineer',
      employer_name: 'Acme Corp',
      job_description: '<p>Build <b>things</b> at scale.</p>',
      job_apply_link: 'https://example.com/apply/abc123',
      job_posted_at_datetime_utc: '2026-09-01T10:00:00.000Z',
      job_city: 'Berlin',
      job_country: 'DE',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('jsearch.p.rapidapi.com')) {
          return { ok: true, status: 200, json: async () => ({ data: [jsearchRow] }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      })
    );
    const jobs = await scrapeBoard({ provider: 'linkedin', query: 'engineer' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      applyUrl: 'https://example.com/apply/abc123',
      backend: 'rapidapi',
    });
    expect(jobs[0].description).toContain('Build things');
    expect(jobs[0].externalId).toBe('abc123');
  });

  it('falls back to apply_options[0].apply_link when job_apply_link is absent', async () => {
    const jsearchRow = {
      job_id: 'opt-1',
      job_title: 'Frontend Engineer',
      employer_name: 'Beta Inc',
      job_description: 'Ship UI.',
      apply_options: [{ apply_link: 'https://example.com/apply/opt-1' }],
      job_posted_at_datetime_utc: '2026-09-02T10:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('jsearch.p.rapidapi.com')) {
          return { ok: true, status: 200, json: async () => ({ data: [jsearchRow] }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      })
    );
    const jobs = await scrapeBoard({ provider: 'linkedin', query: 'engineer' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].applyUrl).toBe('https://example.com/apply/opt-1');
    expect(jobs[0].title).toBe('Frontend Engineer');
  });
});

describe('JSearch v2 live-shape tolerance (items-is-not-iterable fix)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resetRapidApiThrottle();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const liveRow = {
    job_id: 'live-1',
    job_title: 'Platform Engineer',
    employer_name: 'Example Corp',
    job_description: 'Run infra.',
    job_apply_link: 'https://example.com/apply/live-1',
    job_posted_at_datetime_utc: '2026-09-10T10:00:00.000Z',
  };

  async function scrapeWithJsearchBody(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('jsearch.p.rapidapi.com')) {
          return { ok: true, status: 200, json: async () => body };
        }
        return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
      })
    );
    return scrapeBoard({ provider: 'rapidapi', query: 'engineer' });
  }

  it('extractJSearchItems: documented { data: [] } shape', () => {
    expect(extractJSearchItems({ data: [liveRow] })).toEqual([liveRow]);
  });

  it('extractJSearchItems: bare array response', () => {
    expect(extractJSearchItems([liveRow])).toEqual([liveRow]);
  });

  it('extractJSearchItems: cursor/object envelope { data: { jobs, cursor } }', () => {
    expect(
      extractJSearchItems({ data: { jobs: [liveRow], cursor: 'mock-cursor-abc' } })
    ).toEqual([liveRow]);
  });

  it('extractJSearchItems: nested { data: { data: [] } } envelope', () => {
    expect(extractJSearchItems({ data: { data: [liveRow] } })).toEqual([liveRow]);
  });

  it('extractJSearchItems: non-array garbage never throws (null/primitive/unknown object)', () => {
    expect(extractJSearchItems(null)).toEqual([]);
    expect(extractJSearchItems(undefined)).toEqual([]);
    expect(extractJSearchItems('oops')).toEqual([]);
    expect(extractJSearchItems(42)).toEqual([]);
    expect(extractJSearchItems({})).toEqual([]);
    expect(extractJSearchItems({ data: { cursor: 'mock-cursor', count: 0 } })).toEqual([]);
  });

  it('scrapeBoard normalizes a bare-array live body (no crash, no fallback break)', async () => {
    const jobs = await scrapeWithJsearchBody([liveRow]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Platform Engineer',
      company: 'Example Corp',
      applyUrl: 'https://example.com/apply/live-1',
      backend: 'rapidapi',
    });
  });

  it('scrapeBoard normalizes a cursor envelope live body { data: { jobs, cursor } }', async () => {
    const jobs = await scrapeWithJsearchBody({
      status: 'OK',
      request_id: 'mock-request-id',
      data: { jobs: [liveRow], cursor: 'mock-cursor-abc' },
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Platform Engineer',
      applyUrl: 'https://example.com/apply/live-1',
    });
  });

  it('scrapeBoard normalizes a nested { data: { data: [] } } live body', async () => {
    const jobs = await scrapeWithJsearchBody({ data: { data: [liveRow] } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].externalId).toBe('live-1');
  });

  it('scrapeBoard returns [] (not a crash) when live data object carries no rows', async () => {
    // Object envelope with no job array: JSearch counts as succeeded with zero
    // rows, so this is genuine "no jobs" - must not throw "items is not iterable".
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { cursor: 'mock-cursor', count: 0 } }),
      }))
    );
    const jobs = await scrapeBoard({ provider: 'rapidapi', query: 'engineer' });
    expect(jobs).toEqual([]);
  });
});
