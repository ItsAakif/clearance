// SmartRecruiters adapter URL-construction contract (live-probed 2026-11-01).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchSmartRecruiters,
  smartRecruitersPostingUrl,
} from './smartrecruiters.js';

interface StubResult {
  ok: boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function stubFetch(handler: (url: string) => StubResult) {
  return vi.fn(async (url: string) => {
    const r = handler(String(url));
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) lower[k.toLowerCase()] = v;
    return {
      ok: r.ok,
      status: r.status,
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
}

// Recorded live shape (api.smartrecruiters.com, Hastee board, 2026-11-01).
const LIST = {
  offset: 0,
  limit: 3,
  totalFound: 1,
  content: [
    {
      id: '744000077955015',
      name: 'DevOps Engineer',
      company: { identifier: 'Hastee', name: 'Hastee' },
      releasedDate: '2025-08-25T14:45:23.599Z',
      location: { city: 'Barcelona', region: 'CT', country: 'es', fullLocation: 'Barcelona, CT, Spain' },
      ref: 'https://api.smartrecruiters.com/v1/companies/Hastee/postings/744000077955015',
      visibility: 'PUBLIC',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('smartRecruitersPostingUrl', () => {
  it('builds the public jobs.smartrecruiters.com posting URL', () => {
    expect(smartRecruitersPostingUrl('Hastee', '744000077955015')).toBe(
      'https://jobs.smartrecruiters.com/Hastee/744000077955015',
    );
  });
});

describe('fetchSmartRecruiters', () => {
  it('persists a URL constructed from company + id when the row has no applyUrl', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: LIST })));
    const rows = await fetchSmartRecruiters('Hastee', '');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: '744000077955015',
      source: 'smartrecruiters',
      sourceUrl: 'https://jobs.smartrecruiters.com/Hastee/744000077955015',
      applyUrl: 'https://jobs.smartrecruiters.com/Hastee/744000077955015',
      title: 'DevOps Engineer',
      company: 'Hastee',
      location: 'Barcelona, CT, Spain',
    });
  });

  it('prefers an explicit applyUrl / landingPage when supplied', async () => {
    const withApply = {
      ...LIST,
      content: [{ ...LIST.content[0], applyUrl: 'https://apply.example/x' }],
    };
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: withApply })));
    const rows = await fetchSmartRecruiters('Hastee', '');
    expect(rows[0].sourceUrl).toBe('https://apply.example/x');
  });

  it('falls back to releasedDate and keeps the empty-query match-all rule', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: LIST })));
    const rows = await fetchSmartRecruiters('Hastee', '');
    expect(rows[0].postedAt).toEqual(new Date('2025-08-25T14:45:23.599Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2025-08-25T14:45:23.599Z');
    expect(await fetchSmartRecruiters('Hastee', 'zzzqqq')).toEqual([]);
  });

  it('throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'missing' })));
    await expect(fetchSmartRecruiters('bogus', '')).rejects.toThrow('Fetch failed 404');
  });
});
