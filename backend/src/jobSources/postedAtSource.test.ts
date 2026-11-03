// Wave 3 (T662, ADR-028): per-fetcher `postedAtSource` / `postedAtRaw`
// assertions. Every fetcher sets its provenance class at the exact point it
// reads its upstream date field, `postedAtRaw` holds the verbatim upstream
// string, and the null-invariant paths (Tavily/Exa `index-date`, Workday and
// Indeed-synthesised `discovery-at`) carry no date.
//
// Convention note: "null date" in this codebase means `postedAt ===
// undefined` (`RawJob.postedAt?: Date`; same convention as
// `pull-indeed.test.ts`). Assertions use `toBeUndefined()` plus a loose
// `== null` check so the ADR-028 "postedAt stays null" wording is covered
// literally as well.
//
// Existing fetcher tests are NOT edited here: every `postedAt` value they
// assert is preserved (only additive fields were added), so this file is the
// only place the new behaviour is pinned.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const leaseNextKeyMock = vi.fn();
const leaseNextSearchKeyMock = vi.fn();
const hasSearchKeyMock = vi.fn();

vi.mock('../lib/prisma.js', () => ({ default: {} }));

vi.mock('../lib/crypto.js', () => ({ decryptSecret: (s: string) => s }));

vi.mock('../ai/keyManager.js', () => ({
  leaseNextKey: (...args: any[]) => leaseNextKeyMock(...args),
  leaseNextSearchKey: (...args: any[]) => leaseNextSearchKeyMock(...args),
  hasSearchKey: (...args: any[]) => hasSearchKeyMock(...args),
  markKeySuccess: vi.fn(async () => undefined),
  markKeyFailure: vi.fn(async () => undefined),
}));

import {
  fetchGreenhouse,
  fetchAshby,
  fetchLever,
  fetchWorkday,
  fetchRss,
  fetchJsonBoard,
  fetchSmartRecruiters,
  fetchRecruitee,
  fetchPersonio,
  fetchJobicy,
  mapHNThreadComments,
  fetchViaScraper,
} from './index.js';
import { searchJobs } from './search.js';
import { fetchAggregator } from './aggregators.js';
import { fetchUsaJobs } from './aggregators.usajobs.js';
import { fetchFindwork } from './aggregators.findwork.js';
import {
  normalizePullIndeed,
  scrapeBoard,
  resetRapidApiThrottle,
} from './scrapingBackend.js';
import { getProvider } from './providerRegistry.js';
import {
  isIndexDate,
  dateLabel,
  NULL_DATE_SOURCES,
} from '../discovery/provenance.js';

const SAVED_ENV = { ...process.env };

function stubFetch(handler: (url: string) => unknown) {
  return vi.fn(async (url: string) => {
    const r = handler(String(url)) as {
      ok: boolean;
      status: number;
      body: unknown;
    };
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      ok: r.ok,
      status: r.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
}

const ok = (body: unknown) => ({ ok: true, status: 200, body });

beforeEach(() => {
  vi.unstubAllGlobals();
  resetRapidApiThrottle();
  vi.clearAllMocks();
  delete process.env.ADZUNA_APP_ID;
  delete process.env.ADZUNA_APP_KEY;
  delete process.env.USAJOBS_EMAIL;
  delete process.env.USAJOBS_API_KEY;
  delete process.env.FINDWORK_API_KEY;
  leaseNextKeyMock.mockRejectedValue(new Error('no key'));
  hasSearchKeyMock.mockResolvedValue(false);
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  vi.unstubAllGlobals();
});

describe('ATS fetchers (greenhouse / ashby / lever)', () => {
  it('greenhouse updated_at -> source-updated, date kept, raw verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ jobs: [{
        id: 1,
        title: 'Backend Engineer',
        absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
        location: { name: 'Remote' },
        content: '<p>Build APIs.</p>',
        updated_at: '2026-09-01T10:00:00Z',
      }] })),
    );
    const rows = await fetchGreenhouse('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-updated');
    expect(rows[0].postedAtRaw).toBe('2026-09-01T10:00:00Z');
  });

  it('ashby publishedAt -> source-posted', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ jobs: [{
        id: 'a1',
        title: 'Backend Engineer',
        companyName: 'Acme',
        jobUrl: 'https://jobs.ashbyhq.com/acme/a1',
        descriptionPlain: 'Build APIs.',
        publishedAt: '2026-09-02T10:00:00.000Z',
        updatedAt: '2026-09-03T10:00:00.000Z',
      }] })),
    );
    const rows = await fetchAshby('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-02T10:00:00.000Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-02T10:00:00.000Z');
  });

  it('ashby updatedAt-only -> source-updated', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ jobs: [{
        id: 'a2',
        title: 'Designer',
        companyName: 'Acme',
        jobUrl: 'https://jobs.ashbyhq.com/acme/a2',
        descriptionPlain: 'Design things.',
        updatedAt: '2026-09-04T10:00:00.000Z',
      }] })),
    );
    const rows = await fetchAshby('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-04T10:00:00.000Z'));
    expect(rows[0].postedAtSource).toBe('source-updated');
    expect(rows[0].postedAtRaw).toBe('2026-09-04T10:00:00.000Z');
  });

  it('lever createdAt -> source-posted', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok([{
        id: 'l1',
        text: 'Backend Engineer',
        hostedUrl: 'https://jobs.lever.co/acme/l1',
        categories: { location: 'Remote' },
        descriptionPlain: 'Build APIs.',
        createdAt: '2026-09-05T10:00:00Z',
      }])),
    );
    const rows = await fetchLever('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-05T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-05T10:00:00Z');
  });
});

describe('workday (no date)', () => {
  it('rows are discovery-at with a null date and synthesise nothing', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ jobs: [{
        jobId: 'w1',
        title: 'Backend Engineer',
        company: 'Acme',
        location: 'Berlin',
        description: 'Build APIs.',
        url: 'https://acme.workday.com/jobs/w1',
      }] })),
    );
    const rows = await fetchWorkday('https://acme.workday.com/feed', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt == null).toBe(true);
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAtSource).toBe('discovery-at');
    expect(dateLabel(rows[0])).toBe('Found');
  });
});

describe('rss / atom', () => {
  const WWR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>WWR</title>
<item>
<title>Senior Backend Engineer</title>
<link>https://weworkremotely.com/remote-jobs/1</link>
<guid>https://weworkremotely.com/remote-jobs/1</guid>
<pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
<description>Build backend systems.</description>
</item>
</channel></rss>`;

  const ATOM_UPDATED_ONLY = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
<title>StartupCo (Remote) is hiring a Founding Engineer</title>
<link href="https://news.ycombinator.com/item?id=999"/>
<id>999</id>
<updated>2025-09-01T10:00:00Z</updated>
<author><name>hnuser</name></author>
</entry>
</feed>`;

  it('pubDate -> source-posted, date kept, raw verbatim', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: WWR })));
    const rows = await fetchRss('https://weworkremotely.com/remote-jobs.rss', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('Mon, 01 Sep 2026 10:00:00 GMT'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('Mon, 01 Sep 2026 10:00:00 GMT');
    expect(dateLabel(rows[0])).toBe('Posted');
  });

  it('updated-only atom entry -> source-updated', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: ATOM_UPDATED_ONLY })));
    const rows = await fetchRss('https://hnrss.org/hiring', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2025-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-updated');
    expect(rows[0].postedAtRaw).toBe('2025-09-01T10:00:00Z');
    expect(dateLabel(rows[0])).toBe('Updated');
  });
});

describe('json boards (per-key provenance)', () => {
  it('remoteok date -> source-posted', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok([
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
      ])),
    );
    const rows = await fetchJsonBoard('https://remoteok.com/api', 'engineer');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2025-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2025-09-01T10:00:00Z');
  });

  it('remotive publication_date -> source-posted', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({
        'job-count': 1,
        jobs: [{
          id: 1,
          title: 'Senior Backend Engineer',
          company_name: 'RemotiveCo',
          candidate_required_location: 'Worldwide',
          description: 'Build APIs.',
          url: 'https://remotive.com/jobs/1',
          publication_date: '2025-09-01T10:00:00',
        }],
      })),
    );
    const rows = await fetchJsonBoard('https://remotive.com/api/remote-jobs', 'engineer');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toBeInstanceOf(Date);
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2025-09-01T10:00:00');
  });

  it('arbeitnow created_at -> source-posted', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({
        data: [{
          slug: 'senior-backend-engineer-1',
          title: 'Senior Backend Engineer',
          company_name: 'BerlinCo',
          location: 'Berlin, Germany',
          url: 'https://www.arbeitnow.com/jobs/1',
          created_at: '2025-09-01T10:00:00Z',
          description: 'Build APIs.',
        }],
      })),
    );
    const rows = await fetchJsonBoard('https://www.arbeitnow.com/api/job-board-api', 'engineer');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2025-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2025-09-01T10:00:00Z');
  });
});

describe('keyless api fetchers', () => {
  it('jobicy job_posted_at_datetime_utc -> source-posted', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok([{
        id: 7,
        job_title: 'Remote Golang Engineer',
        employer_name: 'JobicyCo',
        job_location: 'Remote',
        job_description: 'Write Go.',
        job_url: 'https://jobicy.com/jobs/7',
        job_posted_at_datetime_utc: '2025-09-01T10:00:00Z',
      }])),
    );
    const rows = await fetchJobicy('golang');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2025-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2025-09-01T10:00:00Z');
  });

  it('smartrecruiters postedDate -> source-posted', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ content: [{
        id: 'sr1',
        name: 'Backend Engineer',
        company: { name: 'Acme' },
        location: { city: 'Berlin' },
        description: 'Build APIs.',
        applyUrl: 'https://acme.smartrecruiters.com/jobs/sr1',
        postedDate: '2026-09-01T10:00:00Z',
      }] })),
    );
    const rows = await fetchSmartRecruiters('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-01T10:00:00Z');
  });

  it('recruitee published_at -> source-posted', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ offers: [{
        id: 9,
        title: 'Backend Engineer',
        location: 'Remote',
        description: 'Build APIs.',
        url: 'https://acme.recruitee.com/o/backend',
        published_at: '2026-09-01T10:00:00Z',
      }] })),
    );
    const rows = await fetchRecruitee('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-01T10:00:00Z');
  });

  it('personio createdAt -> source-posted', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ jobPostings: [{
        id: 3,
        name: 'Backend Engineer',
        officeName: 'Berlin',
        jobDescriptions: [{ value: 'Build APIs.' }],
        applicationUrl: 'https://acme.jobs.personio.de/job/3',
        createdAt: '2026-09-01T10:00:00Z',
      }] })),
    );
    const rows = await fetchPersonio('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-01T10:00:00Z');
  });

  it('hnalgolia comment created_at -> source-posted', () => {
    const rows = mapHNThreadComments(
      { objectID: '999' },
      [{
        id: 111,
        created_at: '2026-09-01T10:00:00.000Z',
        text: '<p>Acme Corp (Remote) is hiring Senior React Engineers</p>',
      }],
      '',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-01T10:00:00.000Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-01T10:00:00.000Z');
  });
});

describe('search tier (index-date null invariant)', () => {
  it('tavily published_date -> index-date with postedAt null via classify', async () => {
    hasSearchKeyMock.mockResolvedValue(true);
    leaseNextSearchKeyMock.mockResolvedValue({ provider: 'tavily', apiKey: 'K' });
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        expect(String(url)).toContain('api.tavily.com');
        return ok({ results: [{
          url: 'https://example.com/jobs/1',
          title: 'Backend Engineer at Acme',
          content: 'Remote role building APIs.',
          published_date: '2026-09-01T10:00:00.000Z',
        }] });
      }),
    );
    const rows = await searchJobs({ query: 'engineer' });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt == null).toBe(true);
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAtSource).toBe('index-date');
    expect(rows[0].postedAtRaw).toBe('2026-09-01T10:00:00.000Z');
    expect(isIndexDate(rows[0])).toBe(true);
    expect(dateLabel(rows[0])).toBe('Found');
  });

  it('exa publishedDate -> index-date with postedAt null via classify', async () => {
    hasSearchKeyMock.mockResolvedValue(true);
    leaseNextSearchKeyMock.mockResolvedValue({ provider: 'exa', apiKey: 'K' });
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        expect(String(url)).toContain('api.exa.ai');
        return ok({ results: [{
          url: 'https://example.com/jobs/2',
          title: 'Backend Engineer at Beta',
          text: 'Remote role building UIs.',
          publishedDate: '2026-09-02T10:00:00.000Z',
        }] });
      }),
    );
    const rows = await searchJobs({ query: 'engineer' });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt == null).toBe(true);
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAtSource).toBe('index-date');
    expect(rows[0].postedAtRaw).toBe('2026-09-02T10:00:00.000Z');
    expect(isIndexDate(rows[0])).toBe(true);
    expect(dateLabel(rows[0])).toBe('Found');
  });

  it('every NULL_DATE_SOURCES class from the search tier carries no date', async () => {
    for (const source of NULL_DATE_SOURCES) {
      expect(source).toBeDefined();
    }
    hasSearchKeyMock.mockResolvedValue(true);
    leaseNextSearchKeyMock.mockResolvedValue({ provider: 'tavily', apiKey: 'K' });
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ results: [{
        url: 'https://example.com/jobs/3',
        title: 'Backend Engineer at Gamma',
        content: 'Build APIs.',
        published_date: '2026-09-03T10:00:00.000Z',
      }] })),
    );
    const rows = await searchJobs({ query: 'engineer' });
    expect(rows[0].postedAt).toBeUndefined();
  });

  it('keyless arbeitnow fallback keeps its board-native created_at as source-posted', async () => {
    hasSearchKeyMock.mockResolvedValue(false);
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({
        data: [{
          id: 5,
          title: 'Senior Backend Engineer',
          company_name: 'BerlinCo',
          location: 'Berlin, Germany',
          url: 'https://www.arbeitnow.com/jobs/5',
          created_at: '2025-09-01T10:00:00Z',
          description: 'Build APIs.',
        }],
      })),
    );
    const rows = await searchJobs({ query: 'engineer' });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2025-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2025-09-01T10:00:00Z');
  });
});

describe('rapidapi scraping backend (jsearch / pullapi / indeed-synth / firecrawl)', () => {
  function rapidKey() {
    leaseNextKeyMock.mockImplementation(async (provider: string) => {
      if (provider === 'rapidapi') {
        return { id: 'rk', apiKey: 'RK', provider, source: 'env', userId: 'u' };
      }
      throw new Error(`no key for ${provider}`);
    });
  }

  it('jsearch job_posted_at_datetime_utc -> source-posted', async () => {
    rapidKey();
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        if (String(url).includes('jsearch.p.rapidapi.com')) {
          return ok({ data: [{
            job_id: 'js1',
            job_title: 'Backend Engineer',
            employer_name: 'Acme',
            job_apply_link: 'https://www.linkedin.com/jobs/view/1',
            job_description: 'Build APIs.',
            job_posted_at_datetime_utc: '2026-09-01T10:00:00.000Z',
            source: 'LinkedIn',
          }] });
        }
        return ok({ data: { jobs: [] } });
      }),
    );
    const rows = await scrapeBoard({ provider: 'linkedin', query: 'engineer' });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-01T10:00:00.000Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-01T10:00:00.000Z');
  });

  it('pullapi linkedin posted_date -> source-posted', async () => {
    rapidKey();
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        if (String(url).includes('jsearch.p.rapidapi.com')) return ok({ data: [] });
        if (String(url).includes('linkedin-scraper-api6.p.rapidapi.com')) {
          return ok({ data: { jobs: [{
            job_url: 'https://www.linkedin.com/jobs/view/123',
            title: 'Engineer',
            company: 'LiCo',
            location: 'Berlin',
            description: 'Build stuff.',
            posted_date: '2026-09-01T10:00:00.000Z',
          }] } });
        }
        return ok({ data: { jobs: [] } });
      }),
    );
    const rows = await scrapeBoard({ provider: 'linkedin', query: 'engineer' });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-01T10:00:00.000Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-01T10:00:00.000Z');
  });

  it('indeed-synthesised rows are discovery-at with a null date', async () => {
    const j = normalizePullIndeed({
      job_key: 'abc123xyz',
      title: 'Backend Engineer',
      company: 'Acme Corp',
      location: 'Berlin, DE',
      snippet: ['a', 'b'],
    });
    expect(j?.postedAt).toBeUndefined();
    expect(j?.postedAtSource).toBe('discovery-at');
    expect(dateLabel(j!)).toBe('Found');
  });

  it('fetchViaScraper passes indeed discovery-at provenance through to RawJob', async () => {
    rapidKey();
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        if (String(url).includes('jsearch.p.rapidapi.com')) return ok({ data: [] });
        if (String(url).includes('indeed-scraper-api2.p.rapidapi.com')) {
          return ok({ data: { jobs: [{
            job_key: 'live-key-1',
            title: 'Frontend Engineer',
            company: 'Beta Inc',
            location: 'Remote',
            snippet: ['great', 'role'],
          }] } });
        }
        return ok({ data: { jobs: [] } });
      }),
    );
    const rows = await fetchViaScraper({
      type: 'scraper',
      query: 'engineer',
      scraperProvider: 'indeed',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAtSource).toBe('discovery-at');
  });

  it('firecrawl page extraction -> page-derived, date kept', async () => {
    leaseNextKeyMock.mockResolvedValue({
      id: 'fk',
      apiKey: 'FK',
      provider: 'firecrawl',
      source: 'env',
      userId: 'u',
    });
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        expect(String(url)).toContain('firecrawl');
        return ok({ data: { jobs: [{
          title: 'Backend Engineer',
          company: 'Acme',
          location: 'Remote',
          applyUrl: 'https://wellfound.com/jobs/1',
          postedAt: '2026-08-01T00:00:00Z',
        }] } });
      }),
    );
    const rows = await scrapeBoard({ provider: 'wellfound', query: 'engineer' });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-08-01T00:00:00Z'));
    expect(rows[0].postedAtSource).toBe('page-derived');
    expect(rows[0].postedAtRaw).toBe('2026-08-01T00:00:00Z');
  });
});

describe('official aggregators', () => {
  it('adzuna created -> source-posted', async () => {
    process.env.ADZUNA_APP_ID = 'id';
    process.env.ADZUNA_APP_KEY = 'key';
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ results: [{
        id: 'abc123',
        title: 'Backend Engineer',
        company: { display_name: 'AdzunaCo' },
        location: { display_name: 'New York, US' },
        redirect_url: 'https://www.adzuna.com/jobs/abc123',
        description: 'Build APIs.',
        created: '2025-09-01T10:00:00Z',
      }] })),
    );
    const rows = await fetchAggregator('adzuna', { query: 'engineer' });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2025-09-01T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2025-09-01T10:00:00Z');
  });

  it('usajobs PublicationStartDate -> source-posted', async () => {
    process.env.USAJOBS_EMAIL = 'reader@example.com';
    process.env.USAJOBS_API_KEY = 'abc123';
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ SearchResult: { SearchResultItems: [{
        MatchedObjectDescriptor: {
          MatchedObjectId: '111',
          PositionTitle: 'Nurse',
          OrganizationName: 'VA',
          PositionLocation: [{ LocationName: 'Austin, Texas' }],
          UserArea: { Details: { JobSummary: 'Care summary' } },
          ApplyURI: ['https://apply?a=1'],
          PositionURI: 'https://position/111',
          PublicationStartDate: '2026-09-01T00:00:00Z',
        },
      }] } })),
    );
    const rows = await fetchUsaJobs({ query: 'x' });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toBeInstanceOf(Date);
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-01T00:00:00Z');
  });

  it('findwork date_posted -> source-posted', async () => {
    process.env.FINDWORK_API_KEY = 'token';
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ok({ results: [{
        id: 42,
        role: 'Frontend Engineer',
        company_name: 'Acme',
        location: 'Remote',
        text: 'Build UIs.',
        url: 'https://findwork.dev/jobs/42',
        date_posted: '2026-09-10T00:00:00Z',
      }] })),
    );
    const rows = await fetchFindwork({ query: 'x' });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAt).toEqual(new Date('2026-09-10T00:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].postedAtRaw).toBe('2026-09-10T00:00:00Z');
  });
});

describe('registry date mapping (ADR-028 table)', () => {
  it('declares workday as discovery-at and search as index-date', () => {
    expect(getProvider('workday')?.dateMapping).toEqual([
      { field: 'postedAt', source: 'discovery-at' },
    ]);
    expect(getProvider('search')?.dateMapping).toEqual([
      { field: 'postedAt', source: 'index-date' },
    ]);
  });

  it('declares both ashby branches and both rss branches', () => {
    expect(getProvider('ashby')?.dateMapping).toEqual([
      { field: 'postedAt', source: 'source-posted' },
      { field: 'postedAt', source: 'source-updated' },
    ]);
    expect(getProvider('rss')?.dateMapping).toEqual([
      { field: 'postedAt', source: 'source-posted' },
      { field: 'postedAt', source: 'source-updated' },
    ]);
  });

  it('declares greenhouse as source-updated', () => {
    expect(getProvider('greenhouse')?.dateMapping).toEqual([
      { field: 'postedAt', source: 'source-updated' },
    ]);
  });
});
