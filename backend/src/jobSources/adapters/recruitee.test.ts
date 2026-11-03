// Recruitee adapter contract (live-probed 2026-11-01):
// /api/offers/ is JSON; /api/offers.json 302s to the HTML career page.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchRecruitee } from './recruitee.js';

interface StubResult {
  ok: boolean;
  status: number;
  body: unknown;
  contentType?: string;
}

function stubFetch(handler: (url: string) => StubResult) {
  return vi.fn(async (url: string) => {
    const r = handler(String(url));
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      ok: r.ok,
      status: r.status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-type' ? (r.contentType ?? null) : null,
      },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
}

const OFFERS = {
  offers: [
    {
      id: 2796814,
      title: 'Trading Support Operator LATAM',
      location: 'Remote job',
      description: '<p>Love esports.</p>',
      careers_url: 'https://grid.recruitee.com/o/trading-support-operator-latam',
      careers_apply_url: 'https://grid.recruitee.com/o/trading-support-operator-latam/c/new',
      published_at: '2026-10-26 07:58:26 UTC',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchRecruitee', () => {
  it('hits the trailing-slash JSON offers endpoint', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        seen.push(url);
        return { ok: true, status: 200, body: OFFERS, contentType: 'application/json; charset=utf-8' };
      }),
    );
    const rows = await fetchRecruitee('grid', '');
    expect(seen).toEqual(['https://grid.recruitee.com/api/offers/']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: '2796814',
      source: 'recruitee',
      sourceUrl: 'https://grid.recruitee.com/o/trading-support-operator-latam',
      applyUrl: 'https://grid.recruitee.com/o/trading-support-operator-latam/c/new',
      title: 'Trading Support Operator LATAM',
      company: 'grid',
      location: 'Remote job',
    });
    expect(rows[0].description).not.toContain('<p>');
  });

  it('treats an HTML redirect target as a per-board failure, not a crash', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({
        ok: true,
        status: 200,
        body: '<html>career page</html>',
        contentType: 'text/html; charset=utf-8',
      })),
    );
    await expect(fetchRecruitee('grid', '')).rejects.toThrow(/Expected JSON but got text\/html/);
  });

  it('keeps the empty-query match-all rule and the published_at claim', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: true, status: 200, body: OFFERS, contentType: 'application/json' })),
    );
    const rows = await fetchRecruitee('grid', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-10-26 07:58:26 UTC');
    expect(await fetchRecruitee('grid', 'zzzqqq')).toEqual([]);
  });

  it('throws on a non-OK response', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: false, status: 404, body: '{}', contentType: 'application/json' })),
    );
    await expect(fetchRecruitee('bogus', '')).rejects.toThrow('Fetch failed 404');
  });
});
