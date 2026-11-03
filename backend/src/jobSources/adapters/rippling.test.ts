// Rippling adapter contract (live-probed 2026-11-01):
// GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRippling, RIPPLING_ENDPOINT } from './rippling.js';

function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }) {
  return vi.fn(async (url: string) => {
    const r = handler(String(url));
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      ok: r.ok,
      status: r.status,
      headers: { get: () => null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
}

// Recorded live shape (api.rippling.com, element board, 2026-11-01).
const JOBS = [
  {
    uuid: '3cfe4358-dcf7-4e16-924c-fa53d0023b49',
    name: 'FDE',
    department: { id: 'Engineering', label: 'Engineering' },
    url: 'https://ats.rippling.com/element/jobs/3cfe4358-dcf7-4e16-924c-fa53d0023b49',
    workLocation: { label: 'München, Deutschland', id: 'München, Deutschland' },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRippling', () => {
  it('hits the public ATS board endpoint for the slug and maps the live row', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        seen.push(url);
        return { ok: true, status: 200, body: JOBS };
      }),
    );
    const rows = await fetchRippling('element', '');
    expect(seen).toEqual([`${RIPPLING_ENDPOINT}/element/jobs`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: '3cfe4358-dcf7-4e16-924c-fa53d0023b49',
      source: 'rippling',
      sourceUrl: 'https://ats.rippling.com/element/jobs/3cfe4358-dcf7-4e16-924c-fa53d0023b49',
      title: 'FDE',
      company: 'element',
      location: 'München, Deutschland',
    });
  });

  it('keeps the empty-query match-all rule and filters on tokens', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: JOBS })));
    expect(await fetchRippling('element', '')).toHaveLength(1);
    expect(await fetchRippling('element', 'FDE')).toHaveLength(1);
    expect(await fetchRippling('element', 'zzzqqq')).toEqual([]);
  });

  it('returns [] for an empty board', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: [] })));
    await expect(fetchRippling('element', '')).resolves.toEqual([]);
  });

  it('throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'missing' })));
    await expect(fetchRippling('bogus', '')).rejects.toThrow('Fetch failed 404');
  });
});
