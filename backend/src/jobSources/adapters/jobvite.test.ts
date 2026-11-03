// Jobvite adapter tests (Wave 4, T681). Fixture-driven with the REAL
// recorded shapes from `.planning/research/ats-adapter-shapes.md`
// section 4.6 (groups360 board): a list row verbatim plus a second row
// under a category header, and detail pages with JSON-LD JobPosting
// blocks. No live calls: fetch is stubbed per URL.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJobvite } from './jobvite.js';

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

// Recorded list shape (research doc 4.6, first row verbatim).
const LIST_HTML = `<html><body>
<h3 class="h2">Product</h3>
<table class="jv-job-list"><tbody><tr>
  <td class="jv-job-list-name"><a href="/groups360/job/oDsxAfwW">Sr. Program Manager</a></td>
  <td class="jv-job-list-location">Hybrid Remote<span>,</span> Brentwood, Tennessee</td>
</tr></tbody></table>
<h3 class="h2">Engineering</h3>
<table class="jv-job-list"><tbody><tr>
  <td class="jv-job-list-name"><a href="/groups360/job/aB12Cd34">Backend Engineer</a></td>
  <td class="jv-job-list-location">Remote</td>
</tr></tbody></table>
</body></html>`;

const detailHtml = (ld: unknown) => `<html><head>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head><body><a href="/groups360/job/oDsxAfwW/apply">Apply</a></body></html>`;

// Recorded detail shape (research doc 4.6, trimmed) plus a description.
const DETAIL_LD = {
  '@context': 'http://schema.org/',
  '@type': 'JobPosting',
  title: 'Sr. Program Manager',
  datePosted: '2026-07-23',
  employmentType: 'Full-Time - Insperity',
  description: '<p>Lead programs across teams.</p>',
  hiringOrganization: 'Groups360',
  jobLocation: {
    '@type': 'Place',
    address: {
      '@type': 'PostalAddress',
      addressLocality: 'Brentwood',
      addressRegion: 'Tennessee',
      addressCountry: 'United States',
    },
  },
};

const ENGINEER_LD = {
  '@context': 'http://schema.org/',
  '@type': 'JobPosting',
  title: 'Backend Engineer',
  datePosted: '2026-08-01',
  description: 'Build APIs.',
  hiringOrganization: { '@type': 'Organization', name: 'Groups360' },
  jobLocation: {
    '@type': 'Place',
    address: { '@type': 'PostalAddress', addressLocality: 'Remote' },
  },
};

function stubBoard() {
  return stubFetch((url) => {
    if (url === 'https://jobs.jobvite.com/groups360/jobs') {
      return { ok: true, status: 200, body: LIST_HTML };
    }
    if (url === 'https://jobs.jobvite.com/groups360/job/oDsxAfwW') {
      return { ok: true, status: 200, body: detailHtml(DETAIL_LD) };
    }
    if (url === 'https://jobs.jobvite.com/groups360/job/aB12Cd34') {
      return { ok: true, status: 200, body: detailHtml(ENGINEER_LD) };
    }
    return { ok: false, status: 404, body: 'not found' };
  });
}

describe('fetchJobvite', () => {
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
    const rows = await fetchJobvite('groups360', '');
    expect(seen).toEqual([
      'https://jobs.jobvite.com/groups360/jobs',
      'https://jobs.jobvite.com/groups360/job/oDsxAfwW',
      'https://jobs.jobvite.com/groups360/job/aB12Cd34',
    ]);
    expect(rows).toHaveLength(2);
    const pm = rows.find((r) => r.externalId === 'oDsxAfwW')!;
    expect(pm).toMatchObject({
      source: 'jobvite',
      sourceUrl: 'https://jobs.jobvite.com/groups360/job/oDsxAfwW',
      title: 'Sr. Program Manager',
      company: 'Groups360',
      location: 'Brentwood, Tennessee, United States',
      applyUrl: 'https://jobs.jobvite.com/groups360/job/oDsxAfwW',
    });
    expect(pm.description).toBe('Lead programs across teams.');
    // N4: postedAt comes only from the JSON-LD datePosted.
    expect(pm.postedAt).toEqual(new Date('2026-07-23'));
    expect(pm.postedAtSource).toBe('source-posted');
    expect(pm.postedAtRaw).toBe('2026-07-23');
  });

  it('keeps a list-level row when its detail page fails (per-row isolation)', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        if (url === 'https://jobs.jobvite.com/groups360/jobs') {
          return { ok: true, status: 200, body: LIST_HTML };
        }
        if (url.endsWith('/job/aB12Cd34')) {
          return { ok: true, status: 200, body: detailHtml(ENGINEER_LD) };
        }
        return { ok: false, status: 500, body: 'boom' };
      }),
    );
    const rows = await fetchJobvite('groups360', '');
    expect(rows).toHaveLength(2);
    const kept = rows.find((r) => r.externalId === 'oDsxAfwW')!;
    expect(kept.title).toBe('Sr. Program Manager');
    expect(kept.location).toBe('Hybrid Remote, Brentwood, Tennessee');
    expect(kept.description).toBe('');
    expect(kept.postedAt).toBeUndefined();
    expect(kept.postedAtSource).toBeUndefined();
  });

  it('filters by query tokens across title, department, and description', async () => {
    vi.stubGlobal('fetch', stubBoard());
    expect(await fetchJobvite('groups360', '')).toHaveLength(2);
    // Department header token ("Product") matches the first row only.
    expect((await fetchJobvite('groups360', 'product')).map((r) => r.externalId)).toEqual([
      'oDsxAfwW',
    ]);
    // Description token ("programs") matches via the enriched description.
    expect((await fetchJobvite('groups360', 'programs')).map((r) => r.externalId)).toEqual([
      'oDsxAfwW',
    ]);
    expect(await fetchJobvite('groups360', 'zzzqqq')).toEqual([]);
  });

  it('returns [] for a page with no job rows, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: true, status: 200, body: '<html><body><p>No openings</p></body></html>' })),
    );
    await expect(fetchJobvite('groups360', '')).resolves.toEqual([]);
  });

  it('throws on a non-OK list response so health records the failure', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'not found' })));
    await expect(fetchJobvite('bogus', '')).rejects.toThrow('Fetch failed 404');
  });
});
