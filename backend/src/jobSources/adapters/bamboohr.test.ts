// BambooHR adapter tests (Wave 4, T681). Fixture-driven with the REAL
// recorded list shape from `.planning/research/ats-adapter-shapes.md`
// section 2.6 (hmd board). No live calls: fetch is stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchBambooHR } from './bamboohr.js';

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

// Recorded fixture (research doc 2.6, one item verbatim).
const LIST = {
  meta: { totalCount: 18 },
  result: [
    {
      id: '57',
      jobOpeningName: 'Roadside Assistant',
      departmentId: '18578',
      departmentLabel: 'Shop',
      employmentStatusLabel: 'Full-Time',
      employmentType: null,
      location: { city: 'San Andres Cholula', state: 'Puebla' },
      atsLocation: { country: null, state: null, province: null, city: null },
      isRemote: null,
      locationType: '0',
    },
  ],
};

describe('fetchBambooHR', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits the subdomain careers endpoint and maps the recorded fields', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        seen.push(url);
        return { ok: true, status: 200, body: LIST };
      }),
    );
    const rows = await fetchBambooHR('hmd', '');
    expect(seen).toEqual(['https://hmd.bamboohr.com/careers/list']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: '57',
      source: 'bamboohr',
      sourceUrl: 'https://hmd.bamboohr.com/careers/57',
      title: 'Roadside Assistant',
      location: 'San Andres Cholula, Puebla',
      applyUrl: 'https://hmd.bamboohr.com/careers/57',
    });
  });

  it('carries no date: postedAt undefined, provenance discovery-at', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: LIST })));
    const rows = await fetchBambooHR('hmd', '');
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAt == null).toBe(true);
    expect(rows[0].postedAtSource).toBe('discovery-at');
  });

  it('falls back to atsLocation when location is empty', async () => {
    const fallback = {
      result: [{
        id: '58',
        jobOpeningName: 'Remote Engineer',
        location: { city: '', state: '' },
        atsLocation: { city: 'Austin', state: 'Texas', country: 'United States' },
      }],
    };
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: fallback })));
    const rows = await fetchBambooHR('hmd', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].location).toBe('Austin, Texas, United States');
  });

  it('filters by query tokens and keeps everything on an empty query', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: LIST })));
    expect(await fetchBambooHR('hmd', '')).toHaveLength(1);
    expect(await fetchBambooHR('hmd', 'roadside')).toHaveLength(1);
    expect(await fetchBambooHR('hmd', 'zzzqqq')).toEqual([]);
  });

  it('returns [] for a valid empty board, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: true, status: 200, body: { meta: { totalCount: 0 }, result: [] } })),
    );
    await expect(fetchBambooHR('hmd', '')).resolves.toEqual([]);
  });

  it('throws on a non-OK response so health records the failure', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'not found' })));
    await expect(fetchBambooHR('bogus', '')).rejects.toThrow('Fetch failed 404');
  });
});
