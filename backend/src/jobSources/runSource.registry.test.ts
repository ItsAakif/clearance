// Registry-driven runSource contract (T622, ADR-025).
//
// An unknown board type or a missing/invalid required field now throws
// instead of returning a silent `[]`, so a misconfigured board records
// `failed` (via the caller's per-board try/catch) instead of a healthy
// zero. `search` with an empty effective query is an intentional empty and
// still returns `[]` without throwing.
//
// No network access: every adapter fetcher plus search/aggregators is
// mocked; the non-function registry data (SUPPORTED_SCRAPER_PROVIDERS,
// AGGREGATOR_PROVIDERS, predicates) stays real via importOriginal so
// assertProviderConfig is exercised for real.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./adapters/greenhouse.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/greenhouse.js')>();
  return { ...orig, fetchGreenhouse: vi.fn(async () => [{ marker: 'greenhouse' }]) };
});
vi.mock('./adapters/ashby.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/ashby.js')>();
  return { ...orig, fetchAshby: vi.fn(async () => [{ marker: 'ashby' }]) };
});
vi.mock('./adapters/lever.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/lever.js')>();
  return { ...orig, fetchLever: vi.fn(async () => [{ marker: 'lever' }]) };
});
vi.mock('./adapters/workday.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/workday.js')>();
  return { ...orig, fetchWorkday: vi.fn(async () => [{ marker: 'workday' }]) };
});
vi.mock('./adapters/rss.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/rss.js')>();
  return { ...orig, fetchRss: vi.fn(async () => [{ marker: 'rss' }]) };
});
vi.mock('./adapters/json.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/json.js')>();
  return { ...orig, fetchJsonBoard: vi.fn(async () => [{ marker: 'json' }]) };
});
vi.mock('./adapters/smartrecruiters.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/smartrecruiters.js')>();
  return { ...orig, fetchSmartRecruiters: vi.fn(async () => [{ marker: 'smartrecruiters' }]) };
});
vi.mock('./adapters/recruitee.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/recruitee.js')>();
  return { ...orig, fetchRecruitee: vi.fn(async () => [{ marker: 'recruitee' }]) };
});
vi.mock('./adapters/personio.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/personio.js')>();
  return { ...orig, fetchPersonio: vi.fn(async () => [{ marker: 'personio' }]) };
});
vi.mock('./adapters/jobicy.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/jobicy.js')>();
  return { ...orig, fetchJobicy: vi.fn(async () => [{ marker: 'jobicy' }]) };
});
vi.mock('./adapters/hnalgolia.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/hnalgolia.js')>();
  return { ...orig, fetchHNAlgolia: vi.fn(async () => [{ marker: 'hnalgolia' }]) };
});
// Wave 4 (T681): tier-1 group-A adapters.
vi.mock('./adapters/workable.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/workable.js')>();
  return { ...orig, fetchWorkable: vi.fn(async () => [{ marker: 'workable' }]) };
});
vi.mock('./adapters/bamboohr.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/bamboohr.js')>();
  return { ...orig, fetchBambooHR: vi.fn(async () => [{ marker: 'bamboohr' }]) };
});
vi.mock('./adapters/breezyhr.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/breezyhr.js')>();
  return { ...orig, fetchBreezyHR: vi.fn(async () => [{ marker: 'breezyhr' }]) };
});
vi.mock('./adapters/jobvite.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/jobvite.js')>();
  return { ...orig, fetchJobvite: vi.fn(async () => [{ marker: 'jobvite' }]) };
});
// Wave 4 (T682): tier-1 group-B adapters (rippling deferred: no module).
vi.mock('./adapters/teamtailor.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/teamtailor.js')>();
  return { ...orig, fetchTeamtailor: vi.fn(async () => [{ marker: 'teamtailor' }]) };
});
vi.mock('./adapters/pinpoint.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/pinpoint.js')>();
  return { ...orig, fetchPinpoint: vi.fn(async () => [{ marker: 'pinpoint' }]) };
});
vi.mock('./adapters/freshteam.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/freshteam.js')>();
  return { ...orig, fetchFreshteam: vi.fn(async () => [{ marker: 'freshteam' }]) };
});
// Wave 4 (T683): tier-3 career-page adapter.
vi.mock('./adapters/career-page.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/career-page.js')>();
  return { ...orig, fetchCareerPage: vi.fn(async () => [{ marker: 'career-page' }]) };
});
vi.mock('./adapters/scraper.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./adapters/scraper.js')>();
  return { ...orig, fetchViaScraper: vi.fn(async () => [{ marker: 'scraper' }]) };
});
vi.mock('./search.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./search.js')>();
  return { ...orig, searchJobs: vi.fn(async () => [{ marker: 'search' }]) };
});
vi.mock('./aggregators.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./aggregators.js')>();
  return { ...orig, fetchAggregator: vi.fn(async () => [{ marker: 'aggregator' }]) };
});

import { fetchGreenhouse } from './adapters/greenhouse.js';
import { fetchAshby } from './adapters/ashby.js';
import { fetchLever } from './adapters/lever.js';
import { fetchWorkday } from './adapters/workday.js';
import { fetchRss } from './adapters/rss.js';
import { fetchJsonBoard } from './adapters/json.js';
import { fetchSmartRecruiters } from './adapters/smartrecruiters.js';
import { fetchRecruitee } from './adapters/recruitee.js';
import { fetchPersonio } from './adapters/personio.js';
import { fetchJobicy } from './adapters/jobicy.js';
import { fetchHNAlgolia } from './adapters/hnalgolia.js';
import { fetchWorkable } from './adapters/workable.js';
import { fetchBambooHR } from './adapters/bamboohr.js';
import { fetchBreezyHR } from './adapters/breezyhr.js';
import { fetchJobvite } from './adapters/jobvite.js';
import { fetchTeamtailor } from './adapters/teamtailor.js';
import { fetchPinpoint } from './adapters/pinpoint.js';
import { fetchFreshteam } from './adapters/freshteam.js';
import { fetchCareerPage } from './adapters/career-page.js';
import { fetchViaScraper } from './adapters/scraper.js';
import { searchJobs } from './search.js';
import { fetchAggregator } from './aggregators.js';
import { runSource, type JobSourceConfig } from './index.js';
import {
  UnknownSourceTypeError,
  SourceConfigError,
} from './providerRegistry.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runSource throws on unknown or misconfigured boards (T622)', () => {
  it("runSource({type:'nope'}) throws UnknownSourceTypeError, never []", async () => {
    await expect(runSource({ type: 'nope' } as unknown as JobSourceConfig)).rejects.toThrowError(
      UnknownSourceTypeError,
    );
    await expect(runSource({ type: 'nope' } as unknown as JobSourceConfig)).rejects.toThrow(
      /Unknown job source type "nope"/,
    );
  });

  it("runSource({type:'greenhouse'}) with no board throws SourceConfigError naming the field", async () => {
    await expect(runSource({ type: 'greenhouse' })).rejects.toThrowError(SourceConfigError);
    await expect(runSource({ type: 'greenhouse' })).rejects.toThrow(/"greenhouse".*"board"/);
    expect(vi.mocked(fetchGreenhouse)).not.toHaveBeenCalled();
  });

  it('missing feedUrl throws SourceConfigError naming feedUrl', async () => {
    await expect(runSource({ type: 'rss' })).rejects.toThrow(/"rss".*"feedUrl"/);
    await expect(runSource({ type: 'workday' })).rejects.toThrow(/"workday".*"feedUrl"/);
    await expect(runSource({ type: 'json' })).rejects.toThrow(/"json".*"feedUrl"/);
    expect(vi.mocked(fetchRss)).not.toHaveBeenCalled();
  });

  it('missing aggregatorProvider throws SourceConfigError naming the field', async () => {
    await expect(runSource({ type: 'aggregator' } as JobSourceConfig)).rejects.toThrowError(
      SourceConfigError,
    );
    await expect(runSource({ type: 'aggregator' } as JobSourceConfig)).rejects.toThrow(
      /"aggregator".*"aggregatorProvider"/,
    );
    expect(vi.mocked(fetchAggregator)).not.toHaveBeenCalled();
  });

  it('a retired provider type throws SourceConfigError naming the provider, not UnknownSourceTypeError', async () => {
    // Retired ids from T101 / ADR-006 (DEPRECATED_AGGREGATOR_PROVIDERS).
    for (const retired of ['careerjet', 'jooble']) {
      const err = await runSource({ type: retired } as unknown as JobSourceConfig).catch((e) => e);
      expect(err).toBeInstanceOf(SourceConfigError);
      expect(err).not.toBeInstanceOf(UnknownSourceTypeError);
      expect(String(err.message)).toMatch(/no longer supported/);
      expect(String(err.message)).toContain(retired);
    }
  });

  it('a retired aggregatorProvider throws SourceConfigError naming the provider', async () => {
    await expect(
      runSource({ type: 'aggregator', aggregatorProvider: 'careerjet' }),
    ).rejects.toThrow(/no longer supported/);
    await expect(
      runSource({ type: 'aggregator', aggregatorProvider: 'careerjet' }),
    ).rejects.toThrow(/careerjet/);
  });

  it('an unknown scraperProvider throws SourceConfigError', async () => {
    await expect(
      runSource({ type: 'scraper', scraperProvider: 'bogus' }),
    ).rejects.toThrowError(SourceConfigError);
    await expect(
      runSource({ type: 'scraper', scraperProvider: 'bogus' }),
    ).rejects.toThrow(/Unsupported scraperProvider "bogus"/);
    expect(vi.mocked(fetchViaScraper)).not.toHaveBeenCalled();
  });

  it('an unknown aggregatorProvider throws SourceConfigError', async () => {
    await expect(
      runSource({ type: 'aggregator', aggregatorProvider: 'bogus' }),
    ).rejects.toThrowError(SourceConfigError);
    await expect(
      runSource({ type: 'aggregator', aggregatorProvider: 'bogus' }),
    ).rejects.toThrow(/Unknown aggregator "bogus"/);
  });

  it("runSource({type:'search', query:''}) returns [] and does NOT throw", async () => {
    const result = await runSource({ type: 'search', query: '' });
    expect(result).toEqual([]);
    expect(vi.mocked(searchJobs)).not.toHaveBeenCalled();
  });
});

describe('runSource routes all 22 valid types to their descriptor handler (T622)', () => {
  it('board-token ATS types call their fetcher with (board, query)', async () => {
    const cases = [
      { config: { type: 'greenhouse', board: 'acme', query: 'eng' }, mock: fetchGreenhouse, marker: 'greenhouse' },
      { config: { type: 'ashby', board: 'acme', query: 'eng' }, mock: fetchAshby, marker: 'ashby' },
      { config: { type: 'lever', board: 'acme', query: 'eng' }, mock: fetchLever, marker: 'lever' },
      { config: { type: 'smartrecruiters', board: 'acme', query: 'eng' }, mock: fetchSmartRecruiters, marker: 'smartrecruiters' },
      { config: { type: 'recruitee', board: 'acme', query: 'eng' }, mock: fetchRecruitee, marker: 'recruitee' },
      { config: { type: 'personio', board: 'acme', query: 'eng' }, mock: fetchPersonio, marker: 'personio' },
      // Wave 4 (T681): group-A adapters take the research doc's boardToken
      // in `board` and receive (board, query) like every ATS fetcher.
      { config: { type: 'workable', board: 'acme', query: 'eng' }, mock: fetchWorkable, marker: 'workable' },
      { config: { type: 'bamboohr', board: 'acme', query: 'eng' }, mock: fetchBambooHR, marker: 'bamboohr' },
      { config: { type: 'breezyhr', board: 'acme', query: 'eng' }, mock: fetchBreezyHR, marker: 'breezyhr' },
      { config: { type: 'jobvite', board: 'acme', query: 'eng' }, mock: fetchJobvite, marker: 'jobvite' },
      // Wave 4 (T682): group-B adapters take the research doc's subdomain
      // in `board` and receive (board, query) like every ATS fetcher.
      { config: { type: 'teamtailor', board: 'acme', query: 'eng' }, mock: fetchTeamtailor, marker: 'teamtailor' },
      { config: { type: 'pinpoint', board: 'acme', query: 'eng' }, mock: fetchPinpoint, marker: 'pinpoint' },
      { config: { type: 'freshteam', board: 'acme', query: 'eng' }, mock: fetchFreshteam, marker: 'freshteam' },
    ] as const;
    for (const c of cases) {
      const result = await runSource({ ...c.config } as JobSourceConfig);
      expect(vi.mocked(c.mock)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(c.mock)).toHaveBeenCalledWith('acme', 'eng');
      expect(result).toEqual([{ marker: c.marker }]);
      vi.clearAllMocks();
    }
  });

  it('feedUrl types call their fetcher with (feedUrl, query)', async () => {
    const feedUrl = 'https://example.com/feed';
    expect(await runSource({ type: 'workday', feedUrl, query: 'eng' })).toEqual([
      { marker: 'workday' },
    ]);
    expect(vi.mocked(fetchWorkday)).toHaveBeenCalledWith(feedUrl, 'eng');
    expect(await runSource({ type: 'rss', feedUrl, query: 'eng' })).toEqual([{ marker: 'rss' }]);
    expect(vi.mocked(fetchRss)).toHaveBeenCalledWith(feedUrl, 'eng');
    expect(await runSource({ type: 'json', feedUrl, query: 'eng' })).toEqual([{ marker: 'json' }]);
    expect(vi.mocked(fetchJsonBoard)).toHaveBeenCalledWith(feedUrl, 'eng');
  });

  // Wave 4 (T683): the tier-3 career-page board takes its page URL in
  // `feedUrl` and routes to `fetchCareerPage` with (feedUrl, query); a
  // missing page URL throws SourceConfigError instead of returning [].
  it('career-page boards call fetchCareerPage with (feedUrl, query)', async () => {
    const feedUrl = 'https://careers.acme.example.test/';
    expect(await runSource({ type: 'career-page', feedUrl, query: 'eng' })).toEqual([
      { marker: 'career-page' },
    ]);
    expect(vi.mocked(fetchCareerPage)).toHaveBeenCalledWith(feedUrl, 'eng');
  });

  it("runSource({type:'career-page'}) with no feedUrl throws SourceConfigError", async () => {
    await expect(runSource({ type: 'career-page' })).rejects.toThrowError(SourceConfigError);
    await expect(runSource({ type: 'career-page' })).rejects.toThrow(/"career-page".*"feedUrl"/);
    expect(vi.mocked(fetchCareerPage)).not.toHaveBeenCalled();
  });

  // Wave 4 (T684, STEP 6): a new type with missing required config throws
  // SourceConfigError (T622 semantics), never []. Asserted here at the
  // runSource level for a group-A and a group-B type (every new type is
  // covered at the assertProviderConfig level in providerRegistry.test.ts).
  it("runSource({type:'workable'}) with no board throws SourceConfigError", async () => {
    await expect(runSource({ type: 'workable' })).rejects.toThrowError(SourceConfigError);
    await expect(runSource({ type: 'workable' })).rejects.toThrow(/"workable".*"board"/);
    expect(vi.mocked(fetchWorkable)).not.toHaveBeenCalled();
  });

  it("runSource({type:'freshteam'}) with no board throws SourceConfigError", async () => {
    await expect(runSource({ type: 'freshteam' })).rejects.toThrowError(SourceConfigError);
    await expect(runSource({ type: 'freshteam' })).rejects.toThrow(/"freshteam".*"board"/);
    expect(vi.mocked(fetchFreshteam)).not.toHaveBeenCalled();
  });

  it('json boards pointing at Jobicy route to fetchJobicy (descriptor data, not a runSource special case)', async () => {
    const result = await runSource({
      type: 'json',
      feedUrl: 'https://jobicy.com/api/remote-jobs?count=50',
      query: 'golang',
    });
    expect(result).toEqual([{ marker: 'jobicy' }]);
    expect(vi.mocked(fetchJobicy)).toHaveBeenCalledWith('golang');
    expect(vi.mocked(fetchJsonBoard)).not.toHaveBeenCalled();
  });

  it('jobicy/hnalgolia call their fetcher with (query)', async () => {
    expect(await runSource({ type: 'jobicy', query: 'remote' })).toEqual([{ marker: 'jobicy' }]);
    expect(vi.mocked(fetchJobicy)).toHaveBeenCalledWith('remote');
    expect(await runSource({ type: 'hnalgolia', query: 'who is hiring' })).toEqual([
      { marker: 'hnalgolia' },
    ]);
    expect(vi.mocked(fetchHNAlgolia)).toHaveBeenCalledWith('who is hiring');
  });

  it('search with a query calls searchJobs with the effective query', async () => {
    const result = await runSource({
      type: 'search',
      query: 'react engineer',
      searchSite: 'jobs.example.com',
      userId: 'user-1',
    });
    expect(result).toEqual([{ marker: 'search' }]);
    expect(vi.mocked(searchJobs)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(searchJobs)).toHaveBeenCalledWith(
      { query: 'react engineer', site: 'jobs.example.com', maxResults: 10 },
      'user-1',
    );
  });

  it('scraper forwards the whole config to fetchViaScraper', async () => {
    const config: JobSourceConfig = {
      type: 'scraper',
      query: 'engineer',
      scraperProvider: 'linkedin',
      scraperLocation: 'Berlin, Germany',
      scraperResults: 25,
      userId: 'user-1',
    };
    const result = await runSource(config);
    expect(result).toEqual([{ marker: 'scraper' }]);
    expect(vi.mocked(fetchViaScraper)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchViaScraper)).toHaveBeenCalledWith(config);
  });

  it('aggregator calls fetchAggregator with (provider, {query, location, resultsWanted, userId})', async () => {
    const result = await runSource({
      type: 'aggregator',
      query: 'engineer',
      aggregatorProvider: 'adzuna',
      aggregatorLocation: 'London',
      scraperResults: 25,
      userId: 'user-1',
    });
    expect(result).toEqual([{ marker: 'aggregator' }]);
    expect(vi.mocked(fetchAggregator)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchAggregator)).toHaveBeenCalledWith('adzuna', {
      query: 'engineer',
      location: 'London',
      resultsWanted: 25,
      userId: 'user-1',
    });
  });
});
