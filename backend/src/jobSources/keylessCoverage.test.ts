import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAshby, fetchJsonBoard, fetchRss, parseXmlFeedItems } from './index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const okJson = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('fetchAshby public posting API', () => {
  const payload = {
    jobs: [
      {
        id: 'abc123',
        title: 'Backend Engineer',
        companyName: 'Perplexity',
        location: 'San Francisco, CA',
        secondaryLocations: ['Remote'],
        descriptionPlain: 'Build search APIs at scale.',
        descriptionHtml: '<p>Build search APIs at scale.</p>',
        jobUrl: 'https://jobs.ashbyhq.com/perplexity/abc123',
        applyUrl: 'https://jobs.ashbyhq.com/perplexity/abc123/application',
        publishedAt: '2026-09-01T00:00:00.000Z',
        isListed: true,
      },
      { id: 'hidden', title: 'Secret Role', isListed: false },
    ],
  };

  it('requests the documented host + path and maps the posting-api shape', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url));
      return okJson(payload);
    }));
    const rows = await fetchAshby('perplexity', '');
    expect(seen).toEqual(['https://api.ashbyhq.com/posting-api/job-board/perplexity']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: 'abc123',
      source: 'ashby',
      sourceUrl: 'https://jobs.ashbyhq.com/perplexity/abc123',
      title: 'Backend Engineer',
      company: 'Perplexity',
      location: 'San Francisco, CA',
      description: 'Build search APIs at scale.',
      applyUrl: 'https://jobs.ashbyhq.com/perplexity/abc123/application',
    });
    expect(rows[0].postedAt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
  });

  it('falls back to secondaryLocations when location is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      okJson({ jobs: [{ id: 'r1', title: 'Dev', jobUrl: 'https://u', secondaryLocations: ['Remote', 'Berlin'] }] }),
    ));
    const rows = await fetchAshby('acme', '');
    expect(rows[0].location).toBe('Remote, Berlin');
  });

  it('throws on a non-ok response so health records the failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(fetchAshby('perplexity', '')).rejects.toThrow('Fetch failed 404');
  });
});

const WWR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>WWR</title>
<item>
<title>Senior Backend Engineer</title>
<link>https://weworkremotely.com/remote-jobs/acme-senior-backend</link>
<guid>https://weworkremotely.com/remote-jobs/acme-senior-backend</guid>
<region>Remote</region>
<country>Worldwide</country>
<type>Full-Time</type>
<pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
<description>Build backend systems.</description>
</item>
</channel></rss>`;

describe('WWR region/country mapping', () => {
  it('parseXmlFeedItems joins region/country/state into location', () => {
    const items = parseXmlFeedItems(WWR_XML);
    expect(items).toHaveLength(1);
    expect(items[0].location).toContain('Remote');
    expect(items[0].location).toContain('Worldwide');
    expect(items[0].employmentType).toBe('Full-Time');
  });

  it('fetchRss surfaces the WWR location and pubDate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(WWR_XML, { status: 200 })));
    const rows = await fetchRss('https://weworkremotely.com/remote-jobs.rss', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].location).toContain('Remote');
    expect(rows[0].location).toContain('Worldwide');
    expect(rows[0].postedAt).toEqual(new Date('Mon, 01 Sep 2026 10:00:00 GMT'));
  });
});

describe('fetchJsonBoard Arbeitnow remote flag', () => {
  const board = {
    data: [
      { title: 'Frontend Dev', company: 'ACME', remote: true, url: 'https://x/1', description: 'JS role' },
      { title: 'Backend Dev', company: 'ACME', location: 'Berlin', remote: true, url: 'https://x/2', description: 'Go role' },
      { title: 'Onsite Dev', company: 'ACME', remote: false, url: 'https://x/3', description: 'Java role' },
    ],
  };

  it("maps remote:true to 'Remote' without overriding explicit locations", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson(board)));
    const rows = await fetchJsonBoard('https://www.arbeitnow.com/api/job-board-api', '');
    expect(rows).toHaveLength(3);
    expect(rows[0].location).toBe('Remote');
    expect(rows[1].location).toBe('Berlin');
    expect(rows[2].location).toBeUndefined();
  });
});
