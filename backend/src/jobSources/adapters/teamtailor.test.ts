// Teamtailor adapter tests (Wave 4, T682). Fixture-driven with the REAL
// recorded shapes from `.planning/research/ats-adapter-shapes.md`
// section 5.6 (career board): a list item verbatim plus a second row, and
// detail pages with JSON-LD JobPosting blocks. No live calls: fetch is
// stubbed per URL.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchTeamtailor } from './teamtailor.js';

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

// Recorded list shape (research doc 5.6, first item verbatim).
const LIST_HTML = `<html><body>
<ul id="jobs_list_container">
<li><a data-turbo="false" href="https://career.teamtailor.com/jobs/8124573-group-financial-controller">
  <span class="absolute inset-0"></span>
  Group Financial Controller
</a>
<div class="text-md mt-4">
<span>Finance</span><span class="mx-[2px]">&middot;</span><span>Stockholm</span>
<span class="mx-[2px]">&middot;</span><span class="inline-flex items-center gap-x-8">Hybrid</span>
</div></li>
<li><a data-turbo="false" href="https://career.teamtailor.com/jobs/8124600-backend-engineer">
  Backend Engineer
</a>
<div class="text-md mt-4">
<span>Engineering</span><span class="mx-[2px]">&middot;</span><span>Remote</span>
</div></li>
</ul>
</body></html>`;

const detailHtml = (ld: unknown) => `<html><head>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head><body></body></html>`;

// Recorded detail shape (research doc 5.6, trimmed) plus a description.
const DETAIL_LD = {
  '@context': 'http://schema.org/',
  '@type': 'JobPosting',
  title: 'Group Financial Controller',
  datePosted: '2026-07-24T13:57:16+02:00',
  employmentType: 'FULL_TIME',
  description: '<p>Own group finance.</p>',
  identifier: { '@type': 'PropertyValue', name: 'Teamtailor', value: '8124573' },
  hiringOrganization: {
    '@type': 'Organization',
    name: 'Teamtailor',
    sameAs: 'https://career.teamtailor.com',
  },
  jobLocation: {
    '@type': 'Place',
    address: {
      streetAddress: 'A-stgatatan 16',
      addressLocality: 'Stockholm',
      postalCode: '116 21',
      addressCountry: 'SE',
      addressRegion: 'Sweden',
      '@type': 'PostalAddress',
    },
  },
};

const ENGINEER_LD = {
  '@context': 'http://schema.org/',
  '@type': 'JobPosting',
  title: 'Backend Engineer',
  datePosted: '2026-08-02T10:00:00+02:00',
  description: 'Build APIs.',
  identifier: { '@type': 'PropertyValue', name: 'Teamtailor', value: '8124600' },
  hiringOrganization: { '@type': 'Organization', name: 'Teamtailor' },
  jobLocation: {
    '@type': 'Place',
    address: { '@type': 'PostalAddress', addressLocality: 'Remote' },
  },
};

function stubBoard() {
  return stubFetch((url) => {
    if (url === 'https://career.teamtailor.com/jobs') {
      return { ok: true, status: 200, body: LIST_HTML };
    }
    if (url === 'https://career.teamtailor.com/jobs/8124573-group-financial-controller') {
      return { ok: true, status: 200, body: detailHtml(DETAIL_LD) };
    }
    if (url === 'https://career.teamtailor.com/jobs/8124600-backend-engineer') {
      return { ok: true, status: 200, body: detailHtml(ENGINEER_LD) };
    }
    return { ok: false, status: 404, body: 'not found' };
  });
}

describe('fetchTeamtailor', () => {
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
    const rows = await fetchTeamtailor('career', '');
    expect(seen).toEqual([
      'https://career.teamtailor.com/jobs',
      'https://career.teamtailor.com/jobs/8124573-group-financial-controller',
      'https://career.teamtailor.com/jobs/8124600-backend-engineer',
    ]);
    expect(rows).toHaveLength(2);
    const fc = rows.find((r) => r.externalId === '8124573')!;
    expect(fc).toMatchObject({
      source: 'teamtailor',
      sourceUrl: 'https://career.teamtailor.com/jobs/8124573-group-financial-controller',
      title: 'Group Financial Controller',
      company: 'Teamtailor',
      applyUrl: 'https://career.teamtailor.com/jobs/8124573-group-financial-controller',
    });
    expect(fc.location).toContain('Stockholm');
    expect(fc.description).toBe('Own group finance.');
    // N4: postedAt comes only from the JSON-LD datePosted.
    expect(fc.postedAt).toEqual(new Date('2026-07-24T13:57:16+02:00'));
    expect(fc.postedAtSource).toBe('source-posted');
    expect(fc.postedAtRaw).toBe('2026-07-24T13:57:16+02:00');
  });

  it('keeps a list-level row when its detail page fails (per-row isolation)', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        if (url === 'https://career.teamtailor.com/jobs') {
          return { ok: true, status: 200, body: LIST_HTML };
        }
        if (url.endsWith('/jobs/8124600-backend-engineer')) {
          return { ok: true, status: 200, body: detailHtml(ENGINEER_LD) };
        }
        return { ok: false, status: 500, body: 'boom' };
      }),
    );
    const rows = await fetchTeamtailor('career', '');
    expect(rows).toHaveLength(2);
    const kept = rows.find((r) => r.externalId === '8124573')!;
    expect(kept.title).toBe('Group Financial Controller');
    expect(kept.description).toBe('');
    expect(kept.postedAt).toBeUndefined();
    expect(kept.postedAtSource).toBeUndefined();
  });

  it('filters by query tokens across title, meta, and description', async () => {
    vi.stubGlobal('fetch', stubBoard());
    expect(await fetchTeamtailor('career', '')).toHaveLength(2);
    expect((await fetchTeamtailor('career', 'finance')).map((r) => r.externalId)).toEqual([
      '8124573',
    ]);
    expect((await fetchTeamtailor('career', 'backend')).map((r) => r.externalId)).toEqual([
      '8124600',
    ]);
    expect(await fetchTeamtailor('career', 'zzzqqq')).toEqual([]);
  });

  it('returns [] for a page with no job rows, not an error', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: true, status: 200, body: '<html><body><p>0 jobs</p></body></html>' })),
    );
    await expect(fetchTeamtailor('career', '')).resolves.toEqual([]);
  });

  it('throws on a non-OK list response so health records the failure', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'not found' })));
    await expect(fetchTeamtailor('bogus', '')).rejects.toThrow('Fetch failed 404');
  });
});
