// Pinpoint adapter tests (Wave 4, T682). Fixture-driven with the REAL
// recorded feed shape from `.planning/research/ats-adapter-shapes.md`
// section 6.6 (workwithus board). No live calls: fetch is stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPinpoint } from './pinpoint.js';

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

// Recorded fixture (research doc 6.6, one posting verbatim, trimmed to
// adapter fields) plus description fields for the mapping test.
const FEED = {
  data: [
    {
      id: '559663',
      title: 'Founding Legal Counsel',
      description: '<p>Lead legal at Pinpoint.</p>',
      key_responsibilities: '<ul><li>Own contracts</li></ul>',
      benefits: '<p>Equity + remote.</p>',
      url: 'https://workwithus.pinpointhq.com/en/postings/ce6c9e5c-a2d3-42b0-a01e-9edeae315b04',
      path: '/en/postings/ce6c9e5c-a2d3-42b0-a01e-9edeae315b04',
      workplace_type: 'remote',
      workplace_type_text: 'Fully remote',
      employment_type: 'full_time',
      employment_type_text: 'Full Time',
      compensation_visible: false,
      deadline_at: null,
      job: {
        id: '562609',
        requisition_id: 'PIN-0407',
        department: { id: '1788', name: 'Operations' },
        division: null,
      },
      location: {
        id: '283',
        city: 'London',
        name: 'Remote',
        postal_code: null,
        province: 'London',
        street_address: null,
      },
    },
  ],
};

describe('fetchPinpoint', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits the subdomain postings.json endpoint and maps the recorded fields', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        seen.push(url);
        return { ok: true, status: 200, body: FEED };
      }),
    );
    const rows = await fetchPinpoint('workwithus', '');
    expect(seen).toEqual(['https://workwithus.pinpointhq.com/postings.json']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: '559663',
      source: 'pinpoint',
      sourceUrl: 'https://workwithus.pinpointhq.com/en/postings/ce6c9e5c-a2d3-42b0-a01e-9edeae315b04',
      title: 'Founding Legal Counsel',
      applyUrl: 'https://workwithus.pinpointhq.com/en/postings/ce6c9e5c-a2d3-42b0-a01e-9edeae315b04',
    });
    expect(rows[0].location).toContain('London');
    expect(rows[0].description).toContain('Lead legal at Pinpoint.');
    expect(rows[0].description).toContain('Own contracts');
    expect(rows[0].description).toContain('Equity + remote.');
    expect(rows[0].description).not.toContain('<p>');
  });

  it('carries no date: postedAt undefined, provenance discovery-at', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: FEED })));
    const rows = await fetchPinpoint('workwithus', '');
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAt == null).toBe(true);
    expect(rows[0].postedAtSource).toBe('discovery-at');
  });

  it('never substitutes deadline_at for postedAt (N4)', async () => {
    const withDeadline = {
      data: [{ ...FEED.data[0], deadline_at: '2026-12-31T23:59:59.000Z' }],
    };
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: withDeadline })));
    const rows = await fetchPinpoint('workwithus', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAtSource).toBe('discovery-at');
  });

  it('filters by query tokens and keeps everything on an empty query', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: FEED })));
    expect(await fetchPinpoint('workwithus', '')).toHaveLength(1);
    expect(await fetchPinpoint('workwithus', 'counsel')).toHaveLength(1);
    expect(await fetchPinpoint('workwithus', 'zzzqqq')).toEqual([]);
  });

  it('returns [] for a valid empty board, not an error', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: { data: [] } })));
    await expect(fetchPinpoint('workwithus', '')).resolves.toEqual([]);
  });

  it('throws on a non-OK response so health records the failure', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'not found' })));
    await expect(fetchPinpoint('bogus', '')).rejects.toThrow('Fetch failed 404');
  });
});
