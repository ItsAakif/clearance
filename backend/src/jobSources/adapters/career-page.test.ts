// Tier-3 career-page adapter tests (Wave 4, T683). Fixture-driven; no
// live calls (global fetch is stubbed per URL). Covers the six required
// cases: JSON-LD extraction, ATS-link delegation, clean-empty, per-page
// cap with recorded truncation, relative-date-only discovery-at, and
// bounded errors (non-OK / non-HTML / PDF) plus the shared bounded-fetch
// behaviour (body size, redirects, timeout).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchCareerPage,
  MAX_CAREER_PAGE_POSTINGS,
  CAREER_PAGE_SOURCE_ID,
} from './career-page.js';
import { fetchTextBounded } from './http.js';
import { extractAts } from '../../registry/atsUrl.js';

interface StubResponse {
  ok: boolean;
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function stubFetch(handler: (url: string) => StubResponse) {
  return vi.fn(async (url: string) => {
    const r = handler(String(url));
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) lower[k.toLowerCase()] = v;
    return {
      ok: r.ok,
      status: r.status,
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
    };
  });
}

const html = (body: string, contentType = 'text/html; charset=utf-8'): StubResponse => ({
  ok: true,
  status: 200,
  body,
  headers: { 'content-type': contentType },
});

const JSON_LD_PAGE = `<html><head>
<script type="application/ld+json">${JSON.stringify({
  '@type': 'JobPosting',
  title: 'Senior Backend Engineer',
  datePosted: '2026-08-14',
  hiringOrganization: { '@type': 'Organization', name: 'Acme Corp' },
  jobLocation: {
    '@type': 'Place',
    address: { '@type': 'PostalAddress', addressLocality: 'Berlin', addressCountry: 'DE' },
  },
  url: 'https://careers.acme.example.test/jobs/123',
  description: '<p>Build <b>APIs</b>.</p>',
})}</script>
<script type="application/ld+json">{"@type":"JobPosting", broken json</script>
<script type="application/ld+json">${JSON.stringify([
  {
    '@type': 'JobPosting',
    title: 'Frontend Engineer',
    datePosted: '2026-09-01T10:00:00.000Z',
    hiringOrganization: 'Acme Corp',
    jobLocation: [{ address: { addressLocality: 'Remote' } }],
    url: '/jobs/124',
    description: 'Ship UI.',
  },
  {
    '@type': 'JobPosting',
    title: 'Support Specialist',
    hiringOrganization: { '@type': 'Organization', name: 'Acme Corp' },
    jobLocation: { address: { addressLocality: 'Austin', addressRegion: 'TX' } },
    description: 'Posted 2 days ago. Help customers.',
  },
])}</script>
</head><body><h1>Careers</h1></body></html>`;

const GREENHOUSE_BOARD = JSON.stringify({
  jobs: [
    {
      id: 999,
      title: 'Greenhouse Engineer',
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/999',
      location: { name: 'Remote' },
      content: 'Greenhouse content.',
      updated_at: '2026-07-20T00:00:00Z',
    },
  ],
});

describe('fetchCareerPage JSON-LD primary mechanism', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses JobPosting blocks with source-posted dates and skips broken blocks', async () => {
    vi.stubGlobal('fetch', stubFetch(() => html(JSON_LD_PAGE)));
    const rows = await fetchCareerPage('https://careers.acme.example.test/', '');
    expect(rows).toHaveLength(3);
    const senior = rows.find((r) => r.title === 'Senior Backend Engineer')!;
    expect(senior).toMatchObject({
      source: CAREER_PAGE_SOURCE_ID,
      sourceUrl: 'https://careers.acme.example.test/jobs/123',
      company: 'Acme Corp',
      location: 'Berlin, DE',
      description: 'Build APIs.',
      applyUrl: 'https://careers.acme.example.test/jobs/123',
      postedAtSource: 'source-posted',
      postedAtRaw: '2026-08-14',
    });
    expect(senior.postedAt).toEqual(new Date('2026-08-14'));
    const frontend = rows.find((r) => r.title === 'Frontend Engineer')!;
    expect(frontend.sourceUrl).toBe('/jobs/124');
    expect(frontend.applyUrl).toBe('https://careers.acme.example.test/jobs/124');
    expect(frontend.postedAtSource).toBe('source-posted');
  });

  it('a posting with only relative-date text is discovery-at with a null postedAt', async () => {
    vi.stubGlobal('fetch', stubFetch(() => html(JSON_LD_PAGE)));
    const rows = await fetchCareerPage('https://careers.acme.example.test/', '');
    const support = rows.find((r) => r.title === 'Support Specialist')!;
    // The description's "2 days ago" is never parsed into a date (N4).
    expect(support.postedAt).toBeUndefined();
    expect(support.postedAtSource).toBe('discovery-at');
    expect(support.sourceUrl).toBe('https://careers.acme.example.test/');
  });

  it('JSON-LD wins over an ATS link on the same page (primary first)', async () => {
    const seen: string[] = [];
    const spy = stubFetch((url) => {
      if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true') {
        return { ok: true, status: 200, body: GREENHOUSE_BOARD };
      }
      return html(
        JSON_LD_PAGE.replace(
          '</body>',
          '<a href="https://boards.greenhouse.io/acme">Greenhouse board</a></body>',
        ),
      );
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return spy(String(url));
      }),
    );
    const rows = await fetchCareerPage('https://careers.acme.example.test/', '');
    expect(rows).toHaveLength(3);
    expect(rows[0].source).toBe(CAREER_PAGE_SOURCE_ID);
    expect(seen).not.toContain('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
  });

  it('filters rows by query tokens across title and description', async () => {
    vi.stubGlobal('fetch', stubFetch(() => html(JSON_LD_PAGE)));
    expect(await fetchCareerPage('https://careers.acme.example.test/', '')).toHaveLength(3);
    expect(
      (await fetchCareerPage('https://careers.acme.example.test/', 'frontend')).map((r) => r.title),
    ).toEqual(['Frontend Engineer']);
    expect(await fetchCareerPage('https://careers.acme.example.test/', 'zzzqqq')).toEqual([]);
  });
});

describe('fetchCareerPage ATS-link secondary mechanism', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('routes a greenhouse link through extractAts to fetchGreenhouse', async () => {
    // The delegation is deterministic pattern matching: the link the
    // adapter follows is recognised by the ONE host table.
    expect(extractAts('https://boards.greenhouse.io/acme')).toEqual({
      provider: 'greenhouse',
      boardToken: 'acme',
    });
    const seen: string[] = [];
    const spy = stubFetch((url) => {
      if (url === 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true') {
        return { ok: true, status: 200, body: GREENHOUSE_BOARD };
      }
      return html(
        '<html><body><a href="https://boards.greenhouse.io/acme">See open roles</a></body></html>',
      );
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return spy(String(url));
      }),
    );
    const rows = await fetchCareerPage('https://careers.acme.example.test/', '');
    expect(seen).toContain('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'greenhouse', title: 'Greenhouse Engineer' });
  });

  it('a rippling link (no keyless adapter) is not a route and yields []', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() =>
        html('<html><body><a href="https://acme.rippling.com/jobs">Jobs</a></body></html>'),
      ),
    );
    await expect(fetchCareerPage('https://careers.acme.example.test/', '')).resolves.toEqual([]);
  });

  it('a page with neither JSON-LD nor a known ATS link returns [] without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() =>
        html(
          '<html><body><h1>Join us</h1><p>Email jobs@acme.example.test to apply.</p></body></html>',
        ),
      ),
    );
    await expect(fetchCareerPage('https://careers.acme.example.test/', '')).resolves.toEqual([]);
  });
});

describe('fetchCareerPage per-page cap', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('caps at MAX_CAREER_PAGE_POSTINGS and records the truncation', async () => {
    const blocks = Array.from(
      { length: MAX_CAREER_PAGE_POSTINGS + 5 },
      (_, i) =>
        `<script type="application/ld+json">${JSON.stringify({
          '@type': 'JobPosting',
          title: `Role ${i}`,
          hiringOrganization: 'Acme Corp',
        })}</script>`,
    ).join('\n');
    vi.stubGlobal('fetch', stubFetch(() => html(`<html><head>${blocks}</head><body></body></html>`)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = await fetchCareerPage('https://careers.acme.example.test/', '');
    expect(rows).toHaveLength(MAX_CAREER_PAGE_POSTINGS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/truncated/);
    expect(String(warn.mock.calls[0][0])).toContain(String(MAX_CAREER_PAGE_POSTINGS));
  });
});

describe('fetchCareerPage bounded errors', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a non-OK response is a bounded actionable error', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 404, body: 'not found' })));
    await expect(fetchCareerPage('https://careers.acme.example.test/', '')).rejects.toThrow(
      'Fetch failed 404',
    );
  });

  it('a non-HTML content type is a bounded actionable error', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => html('{"jobs":[]}', 'application/json')),
    );
    await expect(fetchCareerPage('https://careers.acme.example.test/', '')).rejects.toThrow(
      /expected an HTML career page/,
    );
  });

  it('a PDF is reported unsupported rather than saved', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => html('%PDF-1.4', 'application/pdf')),
    );
    await expect(fetchCareerPage('https://careers.acme.example.test/jobs.pdf', '')).rejects.toThrow(
      /Unsupported content type \(PDF\)/,
    );
  });
});

describe('fetchTextBounded (shared tier-3 bounds)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects a body larger than the bound', async () => {
    vi.stubGlobal('fetch', stubFetch(() => html('x'.repeat(200))));
    await expect(
      fetchTextBounded('https://careers.acme.example.test/', { maxBytes: 100 }),
    ).rejects.toThrow(/exceeds 100 bytes/);
  });

  it('follows a bounded redirect chain and reports the final URL', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        if (url === 'https://careers.acme.example.test/') {
          return {
            ok: false,
            status: 301,
            body: '',
            headers: { location: '/jobs' },
          };
        }
        return html(JSON_LD_PAGE);
      }),
    );
    const page = await fetchTextBounded('https://careers.acme.example.test/');
    expect(page.finalUrl).toBe('https://careers.acme.example.test/jobs');
    expect(page.text).toContain('Senior Backend Engineer');
  });

  it('throws past the redirect bound instead of chasing', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => ({
        ok: false,
        status: 302,
        body: '',
        headers: { location: `${url}/next` },
      })),
    );
    await expect(
      fetchTextBounded('https://careers.acme.example.test/', { maxRedirects: 2 }),
    ).rejects.toThrow(/Too many redirects \(>2\)/);
  });

  it('times out explicitly instead of hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('The operation was aborted')),
            );
          }),
      ),
    );
    await expect(
      fetchTextBounded('https://careers.acme.example.test/', { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/);
  });
});
