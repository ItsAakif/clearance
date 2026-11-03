// Freshteam adapter tests (Wave 4, T682). Fixture-driven with the REAL
// recorded shapes from `.planning/research/ats-adapter-shapes.md`
// section 8.6 (integralresources board): a list anchor verbatim plus a
// second row, and detail pages with JSON-LD JobPosting blocks. No live
// calls: fetch is stubbed per URL.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchFreshteam } from './freshteam.js';

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

// Recorded list shape (research doc 8.6, first anchor verbatim).
const LIST_HTML = `<html><body>
<a href="/jobs/8SJM1YVoaMj-/call-center-agent-fundraiser-work-from-home-remote" class="heading" data-portal-title="callcenteragent-fundraiser-workfromhome(remote)" data-portal-location="Washington, United States of America" data-portal-job-type="4" data-portal-remote-location="remote">
  <div class="job-title"> Call Center Agent-Fundraiser-Work From Home (Remote)</div>
  <div class="job-location">Washington, United States of America</div>
</a>
<a href="/jobs/9ABC2XDefGh-/sales-representative" class="heading" data-portal-title="sales-representative" data-portal-location="New York, United States of America" data-portal-job-type="1" data-portal-remote-location="">
  <div class="job-title">Sales Representative</div>
  <div class="job-location">New York, United States of America</div>
</a>
</body></html>`;

const detailHtml = (ld: unknown) => `<html><head>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head><body></body></html>`;

// Recorded detail shape (research doc 8.6, trimmed) plus a description.
const DETAIL_LD = {
  '@type': 'JobPosting',
  title: ' Call Center Agent-Fundraiser-Work From Home (Remote)',
  datePosted: '2026-03-07 02:25:31 UTC',
  employmentType: 'PART_TIME',
  description: '<p>Raise funds by phone.</p>',
  identifier: null,
  hiringOrganization: { '@type': 'Organization', name: 'Integral Resources, Inc.' },
  jobLocation: {
    '@type': 'Place',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '1155 15th St, NW, Suite 750',
      addressRegion: 'Washington',
      postalCode: '20005',
      addressLocality: 'District of Columbia',
      addressCountry: 'United States of America',
    },
  },
};

const SALES_LD = {
  '@type': 'JobPosting',
  title: 'Sales Representative',
  datePosted: '2026-04-01 09:00:00 UTC',
  employmentType: 'FULL_TIME',
  description: 'Sell things.',
  hiringOrganization: { '@type': 'Organization', name: 'Integral Resources, Inc.' },
  jobLocation: {
    '@type': 'Place',
    address: { '@type': 'PostalAddress', addressLocality: 'New York' },
  },
};

function stubBoard() {
  return stubFetch((url) => {
    if (url === 'https://integralresources.freshteam.com/jobs') {
      return { ok: true, status: 200, body: LIST_HTML };
    }
    if (url === 'https://integralresources.freshteam.com/jobs/8SJM1YVoaMj-/call-center-agent-fundraiser-work-from-home-remote') {
      return { ok: true, status: 200, body: detailHtml(DETAIL_LD) };
    }
    if (url === 'https://integralresources.freshteam.com/jobs/9ABC2XDefGh-/sales-representative') {
      return { ok: true, status: 200, body: detailHtml(SALES_LD) };
    }
    return { ok: false, status: 404, body: 'not found' };
  });
}

describe('fetchFreshteam', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses list rows and enriches them from the JSON-LD detail pages', async () => {
    const seen: string[] = [];
    const spy = stubBoard();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return spy(String(url));
      }),
    );
    const rows = await fetchFreshteam('integralresources', '');
    expect(seen).toEqual([
      'https://integralresources.freshteam.com/jobs',
      'https://integralresources.freshteam.com/jobs/8SJM1YVoaMj-/call-center-agent-fundraiser-work-from-home-remote',
      'https://integralresources.freshteam.com/jobs/9ABC2XDefGh-/sales-representative',
    ]);
    expect(rows).toHaveLength(2);
    const cc = rows.find((r) => r.externalId === '8SJM1YVoaMj-')!;
    expect(cc).toMatchObject({
      source: 'freshteam',
      sourceUrl: 'https://integralresources.freshteam.com/jobs/8SJM1YVoaMj-/call-center-agent-fundraiser-work-from-home-remote',
      title: 'Call Center Agent-Fundraiser-Work From Home (Remote)',
      company: 'Integral Resources, Inc.',
      applyUrl: 'https://integralresources.freshteam.com/jobs/8SJM1YVoaMj-/call-center-agent-fundraiser-work-from-home-remote',
    });
    expect(cc.location).toContain('Washington');
    expect(cc.description).toBe('Raise funds by phone.');
    // N4: postedAt comes only from the JSON-LD datePosted.
    expect(cc.postedAt).toEqual(new Date('2026-03-07 02:25:31 UTC'));
    expect(cc.postedAtSource).toBe('source-posted');
    expect(cc.postedAtRaw).toBe('2026-03-07 02:25:31 UTC');
  });

  it('keeps a list-level row when its detail page fails (per-row isolation)', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        if (url === 'https://integralresources.freshteam.com/jobs') {
          return { ok: true, status: 200, body: LIST_HTML };
        }
        if (url.endsWith('/jobs/9ABC2XDefGh-/sales-representative')) {
          return { ok: true, status: 200, body: detailHtml(SALES_LD) };
        }
        return { ok: false, status: 500, body: 'boom' };
      }),
    );
    const rows = await fetchFreshteam('integralresources', '');
    expect(rows).toHaveLength(2);
    const kept = rows.find((r) => r.externalId === '8SJM1YVoaMj-')!;
    expect(kept.title).toBe('Call Center Agent-Fundraiser-Work From Home (Remote)');
    expect(kept.location).toBe('Washington, United States of America');
    expect(kept.description).toBe('');
    expect(kept.postedAt).toBeUndefined();
    expect(kept.postedAtSource).toBeUndefined();
  });

  it('filters by query tokens across title and description', async () => {
    vi.stubGlobal('fetch', stubBoard());
    expect(await fetchFreshteam('integralresources', '')).toHaveLength(2);
    expect((await fetchFreshteam('integralresources', 'fundraiser')).map((r) => r.externalId)).toEqual([
      '8SJM1YVoaMj-',
    ]);
    expect((await fetchFreshteam('integralresources', 'sales')).map((r) => r.externalId)).toEqual([
      '9ABC2XDefGh-',
    ]);
    expect(await fetchFreshteam('integralresources', 'zzzqqq')).toEqual([]);
  });

  it('returns [] for a page with no job rows, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: true, status: 200, body: '<html><body><p>No openings</p></body></html>' })),
    );
    await expect(fetchFreshteam('integralresources', '')).resolves.toEqual([]);
  });

  it('throws on a non-OK list response so health records the failure', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'not found' })));
    await expect(fetchFreshteam('bogus', '')).rejects.toThrow('Fetch failed 404');
  });
});
