import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchRss, fetchJsonBoard, runSource } from './index.js';

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>We Work Remotely</title>
<item>
<title><![CDATA[Senior Backend Engineer]]></title>
<link>https://weworkremotely.com/remote-jobs/123</link>
<guid>https://weworkremotely.com/remote-jobs/123</guid>
<description><![CDATA[<p>Build APIs.</p>]]></description>
<pubDate>Mon, 01 Sep 2025 10:00:00 GMT</pubDate>
<author>Acme Corp</author>
</item>
<item>
<title>Junior Designer</title>
<link>https://weworkremotely.com/remote-jobs/124</link>
<description>Design things.</description>
<pubDate>Tue, 02 Sep 2025 10:00:00 GMT</pubDate>
</item>
</channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
<title>StartupCo (Remote) is hiring a Founding Engineer</title>
<link href="https://news.ycombinator.com/item?id=999"/>
<id>999</id>
<updated>2025-09-01T10:00:00Z</updated>
<author><name>hnuser</name></author>
</entry>
</feed>`;

const REMOTIVE_JSON = {
  'job-count': 2,
  jobs: [
    {
      id: 1,
      title: 'Senior Backend Engineer',
      company_name: 'RemotiveCo',
      candidate_required_location: 'Worldwide',
      description: 'Build APIs.',
      url: 'https://remotive.com/jobs/1',
      publication_date: '2025-09-01T10:00:00',
    },
    {
      id: 2,
      title: 'Remote Frontend Engineer',
      company_name: 'FrontCo',
      description: 'Build UIs.',
      url: 'https://remotive.com/jobs/2',
      publication_date: '2025-09-02T10:00:00',
    },
  ],
};

const JOBICY_JSON = [
  {
    id: 7,
    job_title: 'Remote Golang Engineer',
    employer_name: 'JobicyCo',
    job_location: 'Remote',
    job_description: 'Write Go.',
    job_url: 'https://jobicy.com/jobs/7',
    job_posted_at_datetime_utc: '2025-09-01T10:00:00Z',
  },
];

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

describe('empty listings fixes', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetchRss parses real RSS XML (WWR shape) instead of requiring JSON', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: RSS_XML })));
    const jobs = await fetchRss('https://weworkremotely.com/remote-jobs.rss', 'engineer');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: 'rss',
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      sourceUrl: 'https://weworkremotely.com/remote-jobs/123',
    });
  });

  it('fetchRss parses Atom entries with href links (hnrss shape)', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: ATOM_XML })));
    const jobs = await fetchRss('https://hnrss.org/hiring', '');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      source: 'rss',
      applyUrl: 'https://news.ycombinator.com/item?id=999',
    });
    expect(jobs[0].title).toContain('Founding Engineer');
  });

  it('fetchRss still accepts JSON bodies', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({
        ok: true,
        status: 200,
        body: { items: [{ guid: 'g1', title: 'Engineer', link: 'https://x/1' }] },
      })),
    );
    const jobs = await fetchRss('https://example.com/feed.json', '');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe('rss');
  });

  it('fetchRss throws on HTTP failure so the caller records health (no silent [])', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 500, body: 'boom' })));
    await expect(fetchRss('https://weworkremotely.com/remote-jobs.rss', '')).rejects.toThrow(/500/);
  });

  it('fetchJsonBoard maps Remotive shape (company_name, required location, publication_date)', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: REMOTIVE_JSON })));
    const jobs = await fetchJsonBoard('https://remotive.com/api/remote-jobs', 'engineer');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      source: 'json',
      company: 'RemotiveCo',
      location: 'Worldwide',
    });
    expect(jobs[0].postedAt).toBeInstanceOf(Date);
    // Missing candidate_required_location defaults to Remote so location-chip filters keep the row.
    expect(jobs[1].location).toBe('Remote');
  });

  it('fetchJsonBoard keeps Jobicy-shaped rows on stale json-typed boards', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: JOBICY_JSON })));
    const jobs = await fetchJsonBoard('https://jobicy.com/api/remote-jobs?count=50', 'golang');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Remote Golang Engineer',
      company: 'JobicyCo',
      location: 'Remote',
    });
  });

  it('runSource routes type jobicy to fetchJobicy (job_title rows kept)', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) =>
        url.includes('jobicy.com')
          ? { ok: true, status: 200, body: JOBICY_JSON }
          : { ok: false, status: 404, body: '' },
      ),
    );
    const jobs = await runSource({ type: 'jobicy', query: 'golang' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source: 'jobicy', title: 'Remote Golang Engineer' });
  });

  it('runSource routes stale json-typed Jobicy feedUrls to fetchJobicy', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) =>
        url.includes('jobicy.com')
          ? { ok: true, status: 200, body: JOBICY_JSON }
          : { ok: false, status: 404, body: '' },
      ),
    );
    const jobs = await runSource({
      type: 'json',
      feedUrl: 'https://jobicy.com/api/remote-jobs?count=50',
      query: 'golang',
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe('jobicy');
  });

  it('fetchJsonBoard maps RemoteOK bare-array rows (position/company, legal notice filtered)', async () => {
    const REMOTEOK_BARE_ARRAY: unknown[] = [
      'Legal notice: scraping is prohibited; use the API responsibly.',
      {
        id: 101,
        slug: 'backend-engineer-101',
        position: 'Backend Engineer',
        company: 'RemoteCo',
        location: 'Worldwide',
        url: 'https://remoteok.com/remote-jobs/101',
        date: '2025-09-01T10:00:00Z',
      },
      {
        id: 102,
        slug: 'frontend-engineer-102',
        position: 'Frontend Engineer',
        company: 'FrontCo',
        url: 'https://remoteok.com/remote-jobs/102',
        date: '2025-09-02T10:00:00Z',
      },
    ];
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: REMOTEOK_BARE_ARRAY })));
    const jobs = await fetchJsonBoard('https://remoteok.com/api', 'engineer');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      source: 'json',
      title: 'Backend Engineer',
      company: 'RemoteCo',
      location: 'Worldwide',
    });
    // Missing location on a known-remote feed defaults to Remote.
    expect(jobs[1].location).toBe('Remote');
  });

  it('fetchJsonBoard maps Arbeitnow {data} rows (title/company_name)', async () => {
    const ARBEITNOW_JSON = {
      data: [
        {
          slug: 'senior-backend-engineer-1',
          title: 'Senior Backend Engineer',
          company_name: 'BerlinCo',
          location: 'Berlin, Germany',
          url: 'https://www.arbeitnow.com/jobs/1',
          created_at: '2025-09-01T10:00:00Z',
          description: 'Build APIs.',
        },
      ],
    };
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: ARBEITNOW_JSON })));
    const jobs = await fetchJsonBoard('https://www.arbeitnow.com/api/job-board-api', 'engineer');
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0]).toMatchObject({
      source: 'json',
      title: 'Senior Backend Engineer',
      company: 'BerlinCo',
      location: 'Berlin, Germany',
    });
    expect(jobs[0].title).toBeDefined();
    expect(jobs[0].company).toBeDefined();
    expect(jobs[0].location).toBeDefined();
  });
});
