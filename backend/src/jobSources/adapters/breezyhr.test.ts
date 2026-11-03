// BreezyHR adapter tests (Wave 4, T681). Fixture-driven with the REAL
// recorded feed shape from `.planning/research/ats-adapter-shapes.md`
// section 3.6 (duolingo board). No live calls: fetch is stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchBreezyHR } from './breezyhr.js';

function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }) {
  return vi.fn(async (url: string) => {
    const r = handler(String(url));
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      ok: r.ok,
      status: r.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
}

// Recorded fixture (research doc 3.6, one item verbatim, trimmed).
const FEED = [
  {
    id: '4ab15c2e5b05',
    friendly_id: '4ab15c2e5b05-country-marketing-manager-nigeria-contractor',
    name: 'Country Marketing Manager, Nigeria (Contractor)',
    url: 'https://duolingo.breezy.hr/p/4ab15c2e5b05-country-marketing-manager-nigeria-contractor',
    published_date: '2026-05-28T13:00:55.828Z',
    type: { id: 'contract', name: 'Contract' },
    department: 'Marketing',
    salary: '',
    company: { name: 'Duolingo', logo_url: null, friendly_id: 'duolingo', isMultipleLocationsEnabled: true },
    location: {
      country: { name: 'Nigeria', id: 'NG' },
      primary: true,
      is_remote: true,
      remote_details: { value: 'remote-location', label: 'Fully remote, within chosen location(s)' },
      name: 'Nigeria',
      id: '881b94a7e80e',
    },
  },
];

describe('fetchBreezyHR', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits the portal-slug json endpoint and maps the recorded fields', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        seen.push(url);
        return { ok: true, status: 200, body: FEED };
      }),
    );
    const rows = await fetchBreezyHR('duolingo', '');
    expect(seen).toEqual(['https://duolingo.breezy.hr/json']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: '4ab15c2e5b05',
      source: 'breezyhr',
      sourceUrl: 'https://duolingo.breezy.hr/p/4ab15c2e5b05-country-marketing-manager-nigeria-contractor',
      title: 'Country Marketing Manager, Nigeria (Contractor)',
      company: 'Duolingo',
      location: 'Nigeria',
      applyUrl: 'https://duolingo.breezy.hr/p/4ab15c2e5b05-country-marketing-manager-nigeria-contractor',
    });
  });

  it('sets postedAt from published_date only (source-posted, raw verbatim)', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: FEED })));
    const rows = await fetchBreezyHR('duolingo', '');
    expect(rows[0].postedAt).toEqual(new Date('2026-05-28T13:00:55.828Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-05-28T13:00:55.828Z');
  });

  it('joins multi-location names without duplicating the country', async () => {
    const multi = [{
      ...FEED[0],
      locations: [{ name: 'Lagos' }, { name: 'Abuja' }],
    }];
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: multi })));
    const rows = await fetchBreezyHR('duolingo', '');
    expect(rows[0].location).toBe('Lagos, Abuja, Nigeria');
  });

  it('filters by query tokens and keeps everything on an empty query', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: FEED })));
    expect(await fetchBreezyHR('duolingo', '')).toHaveLength(1);
    expect(await fetchBreezyHR('duolingo', 'marketing')).toHaveLength(1);
    expect(await fetchBreezyHR('duolingo', 'zzzqqq')).toEqual([]);
  });

  it('returns [] for a valid empty board, not an error', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: [] })));
    await expect(fetchBreezyHR('d', '')).resolves.toEqual([]);
  });

  it('throws on a non-OK response so health records the failure', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'not found' })));
    await expect(fetchBreezyHR('bogus', '')).rejects.toThrow('Fetch failed 404');
  });
});
