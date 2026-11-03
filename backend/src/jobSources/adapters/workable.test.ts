// Workable adapter tests (Wave 4 T681; endpoint corrected 2026-11-01).
// Fixture-driven against the live widget shape
// (`apply.workable.com/api/v1/widget/accounts/{slug}?details=true`).
// No live calls: fetch is stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchWorkable,
  WORKABLE_ENDPOINT,
  WORKABLE_MAX_CONCURRENCY,
} from './workable.js';

interface StubResult {
  ok: boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function stubFetch(handler: (url: string, call: number) => StubResult) {
  let call = 0;
  return vi.fn(async (url: string) => {
    const r = handler(String(url), call);
    call += 1;
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

// Recorded live shape (apply.workable.com widget API, 2026-11-01).
const BOARD = {
  name: 'Berry Street',
  description: '<p>Berry Street</p>',
  jobs: [
    {
      title: 'Head of Finance',
      shortcode: '4782C90943',
      employment_type: 'Full-time',
      url: 'https://apply.workable.com/j/4782C90943',
      shortlink: 'https://apply.workable.com/j/4782C90943',
      application_url: 'https://apply.workable.com/j/4782C90943/apply',
      published_on: '2026-09-22',
      created_at: '2026-08-05',
      country: 'United States',
      city: 'New York',
      state: 'New York',
      locations: [{ country: 'United States', countryCode: 'US', city: 'New York', region: 'New York', hidden: false }],
      description: '<p>Own the finance function.</p>',
    },
  ],
};

describe('fetchWorkable', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hits the live widget endpoint for the subdomain token and maps its fields', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        seen.push(url);
        return { ok: true, status: 200, body: BOARD };
      }),
    );
    const rows = await fetchWorkable('berry-street', '');
    expect(seen).toEqual([`${WORKABLE_ENDPOINT}/berry-street?details=true`]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: '4782C90943',
      source: 'workable',
      sourceUrl: 'https://apply.workable.com/j/4782C90943',
      title: 'Head of Finance',
      company: 'Berry Street',
      location: 'New York, New York, United States',
      applyUrl: 'https://apply.workable.com/j/4782C90943/apply',
    });
    expect(rows[0].description).toContain('Own the finance function.');
    expect(rows[0].description).not.toContain('<p>');
  });

  it('sets postedAt from created_at only (source-posted, raw verbatim)', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: BOARD })));
    const rows = await fetchWorkable('berry-street', '');
    expect(rows[0].postedAt).toEqual(new Date('2026-08-05'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-08-05');
  });

  it('never substitutes published_on for postedAt (N4)', async () => {
    const noCreated = {
      ...BOARD,
      jobs: [{ ...BOARD.jobs[0], created_at: undefined, published_on: '2026-09-22' }],
    };
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: noCreated })));
    const rows = await fetchWorkable('berry-street', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAtSource).toBeUndefined();
    expect(rows[0].postedAtRaw).toBeUndefined();
  });

  it('filters by query tokens and keeps everything on an empty query', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: BOARD })));
    expect(await fetchWorkable('berry-street', '')).toHaveLength(1);
    expect(await fetchWorkable('berry-street', 'finance')).toHaveLength(1);
    expect(await fetchWorkable('berry-street', 'zzzqqq')).toEqual([]);
  });

  it('returns [] for a valid empty board, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: true, status: 200, body: { ...BOARD, jobs: [] } })),
    );
    await expect(fetchWorkable('berry-street', '')).resolves.toEqual([]);
  });

  it('throws on a non-OK response so health records the failure', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'not found' })));
    await expect(fetchWorkable('bogus', '')).rejects.toThrow('Fetch failed 404');
  });

  it('honours Retry-After once on 429 and never spins', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch((url, call) => {
        seen.push(url);
        if (call === 0) {
          return { ok: false, status: 429, body: 'slow down', headers: { 'retry-after': '0' } };
        }
        return { ok: true, status: 200, body: BOARD };
      }),
    );
    const rows = await fetchWorkable('berry-street', '');
    expect(rows).toHaveLength(1);
    expect(seen).toHaveLength(2);
  });

  it('throws 429 immediately when Retry-After is absent (no spin)', async () => {
    const fetchMock = stubFetch(() => ({ ok: false, status: 429, body: 'slow down' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWorkable('berry-street', '')).rejects.toThrow('Fetch failed 429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps provider-level concurrency at WORKABLE_MAX_CONCURRENCY', async () => {
    const gates: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active -= 1;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(BOARD),
          json: async () => BOARD,
        };
      }),
    );

    const run = Promise.all([
      fetchWorkable('a', ''),
      fetchWorkable('b', ''),
      fetchWorkable('c', ''),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(maxActive).toBe(WORKABLE_MAX_CONCURRENCY);
    while (gates.length > 0) {
      gates.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await run;
    expect(maxActive).toBe(WORKABLE_MAX_CONCURRENCY);
  });
});
