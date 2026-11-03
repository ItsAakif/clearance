import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({
  default: {
    jobBoard: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { explainScrapability, BOARD_TYPE_VALUES } from './boards.js';
import { SUPPORTED_SCRAPER_PROVIDERS, boardToConfig } from '../jobSources/index.js';
import {
  PROVIDERS,
  SUPPORTED_SCRAPER_PROVIDERS as REGISTRY_SCRAPER_PROVIDERS,
  AGGREGATOR_PROVIDERS as REGISTRY_AGGREGATOR_PROVIDERS,
} from '../jobSources/providerRegistry.js';
import { AGGREGATOR_PROVIDERS } from '../jobSources/aggregators.js';

describe('boards explainScrapability (ADR-011)', () => {
  it('does not list foundit in SUPPORTED_SCRAPER_PROVIDERS', () => {
    expect((SUPPORTED_SCRAPER_PROVIDERS as readonly string[])).not.toContain('foundit');
  });

  it('missing-provider reason does not mention foundit and mentions linkedin', () => {
    const result = explainScrapability({ type: 'scraper' });
    expect(result.scrapable).toBe(false);
    expect(result.reason).not.toContain('foundit');
    expect(result.reason).toContain('linkedin');
  });

  it('explicit foundit provider is rejected as unsupported', () => {
    const result = explainScrapability({ type: 'scraper', scraperProvider: 'foundit' });
    expect(result.scrapable).toBe(false);
    expect(result.reason).toContain('not a supported scraper');
  });
});

describe('boards registry derivation (T623, ADR-025)', () => {
  it('BOARD_TYPE_VALUES enumerates exactly the 24 PROVIDERS types', () => {
    expect([...BOARD_TYPE_VALUES].sort()).toEqual([...PROVIDERS.map((p) => p.type)].sort());
    expect(BOARD_TYPE_VALUES).toHaveLength(24);
  });

  it('registry re-exports equal the canonical provider lists', () => {
    expect([...REGISTRY_SCRAPER_PROVIDERS]).toEqual([...SUPPORTED_SCRAPER_PROVIDERS]);
    expect([...REGISTRY_AGGREGATOR_PROVIDERS]).toEqual([...AGGREGATOR_PROVIDERS]);
  });

  // Table-driven pin of the PRE-refactor explainScrapability outputs
  // (captured before the T623 rewrite). The refactor must reproduce every
  // verdict - scrapable, via, and reason text - exactly.
  const EXPLAIN_CASES: Array<
    [string, Parameters<typeof explainScrapability>[0], ReturnType<typeof explainScrapability>]
  > = [
    ['greenhouse+board', { type: 'greenhouse', boardId: 'anthropic' }, { scrapable: true, via: 'ats', reason: 'Fetched from the public greenhouse API using the company token.' }],
    ['greenhouse-missing', { type: 'greenhouse' }, { scrapable: false, via: 'ats', reason: 'Requires a boardId (company token) for the greenhouse API.' }],
    ['ashby+board', { type: 'ashby', boardId: 'acme' }, { scrapable: true, via: 'ats', reason: 'Fetched from the public ashby API using the company token.' }],
    ['ashby-missing', { type: 'ashby' }, { scrapable: false, via: 'ats', reason: 'Requires a boardId (company token) for the ashby API.' }],
    ['lever+board', { type: 'lever', boardId: 'acme' }, { scrapable: true, via: 'ats', reason: 'Fetched from the public lever API using the company token.' }],
    ['lever-missing', { type: 'lever' }, { scrapable: false, via: 'ats', reason: 'Requires a boardId (company token) for the lever API.' }],
    ['smartrecruiters+board', { type: 'smartrecruiters', boardId: 'acme' }, { scrapable: true, via: 'ats', reason: 'Fetched from the public smartrecruiters API using the company token.' }],
    ['smartrecruiters-missing', { type: 'smartrecruiters' }, { scrapable: false, via: 'ats', reason: 'Requires a boardId (company token) for the smartrecruiters API.' }],
    ['recruitee+board', { type: 'recruitee', boardId: 'acme' }, { scrapable: true, via: 'ats', reason: 'Fetched from the public recruitee API using the company token.' }],
    ['recruitee-missing', { type: 'recruitee' }, { scrapable: false, via: 'ats', reason: 'Requires a boardId (company token) for the recruitee API.' }],
    ['personio+board', { type: 'personio', boardId: 'acme' }, { scrapable: true, via: 'ats', reason: 'Fetched from the public personio API using the company token.' }],
    ['personio-missing', { type: 'personio' }, { scrapable: false, via: 'ats', reason: 'Requires a boardId (company token) for the personio API.' }],
    ['rss+feed', { type: 'rss', feedUrl: 'https://example.com/feed.rss' }, { scrapable: true, via: 'aggregator', reason: 'Fetched from the provided rss feed URL (keyless).' }],
    ['rss-missing', { type: 'rss' }, { scrapable: false, via: 'aggregator', reason: 'Requires a feedUrl.' }],
    ['json+feed', { type: 'json', feedUrl: 'https://example.com/jobs.json' }, { scrapable: true, via: 'aggregator', reason: 'Fetched from the provided json feed URL (keyless).' }],
    ['json-missing', { type: 'json' }, { scrapable: false, via: 'aggregator', reason: 'Requires a feedUrl.' }],
    ['workday+feed', { type: 'workday', feedUrl: 'https://example.com/feed' }, { scrapable: true, via: 'aggregator', reason: 'Fetched from the Workday RSS/JSON feed URL.' }],
    ['workday-missing', { type: 'workday' }, { scrapable: false, via: 'aggregator', reason: 'Requires a feedUrl.' }],
    ['jobicy', { type: 'jobicy' }, { scrapable: true, via: 'aggregator', reason: 'Fetched from Jobicy’s keyless remote-jobs API.' }],
    ['hnalgolia', { type: 'hnalgolia' }, { scrapable: true, via: 'aggregator', reason: 'Fetched from the Hacker News (Algolia) jobs API - keyless.' }],
    ['search+query', { type: 'search', searchQuery: 'engineer' }, { scrapable: true, via: 'search', reason: 'Run as a web search via your Tavily/Exa key (or keyless fallback).' }],
    ['search-missing', { type: 'search' }, { scrapable: false, via: 'search', reason: 'Requires a searchQuery.' }],
    // Wave 5 (T702): dorking shares the search-kind verdicts (query-gated at
    // creation time, run through the existing search backend).
    ['dorking+query', { type: 'dorking', searchQuery: 'engineer' }, { scrapable: true, via: 'search', reason: 'Run as a web search via your Tavily/Exa key (or keyless fallback).' }],
    ['dorking-missing', { type: 'dorking' }, { scrapable: false, via: 'search', reason: 'Requires a searchQuery.' }],
    ['scraper-missing', { type: 'scraper' }, { scrapable: false, via: 'scraper', reason: 'Requires a scraperProvider (one of: linkedin, indeed, glassdoor, ziprecruiter, bayt, naukri, wellfound, instahyre, sprout, googlesearch, ycombinator).' }],
    ['scraper-linkedin', { type: 'scraper', scraperProvider: 'linkedin' }, { scrapable: true, via: 'scraper', reason: 'Scraped via your configured backend for "linkedin". Hard boards (LinkedIn/Indeed/ZipRecruiter/Glassdoor/Bayt) use RapidAPI; medium boards (YC/Wellfound/Instahyre/Sprout/Google) use Firecrawl/Crawl4AI.' }],
    ['scraper-googlesearch', { type: 'scraper', scraperProvider: 'googlesearch' }, { scrapable: true, via: 'scraper', reason: 'Scraped via your configured backend for "googlesearch". Hard boards (LinkedIn/Indeed/ZipRecruiter/Glassdoor/Bayt) use RapidAPI; medium boards (YC/Wellfound/Instahyre/Sprout/Google) use Firecrawl/Crawl4AI.' }],
    ['scraper-bogus', { type: 'scraper', scraperProvider: 'foundit' }, { scrapable: false, via: 'scraper', reason: '"foundit" is not a supported scraper. Supported: linkedin, indeed, glassdoor, ziprecruiter, bayt, naukri, wellfound, instahyre, sprout, googlesearch, ycombinator.' }],
    ['aggregator-missing', { type: 'aggregator' }, { scrapable: false, via: 'aggregator', reason: 'Requires an aggregatorProvider (adzuna, usajobs, reed, findwork).' }],
    ['aggregator-adzuna', { type: 'aggregator', aggregatorProvider: 'adzuna' }, { scrapable: true, via: 'aggregator', reason: 'Fetched from the adzuna API using your BYOK key.' }],
    ['aggregator-usajobs', { type: 'aggregator', aggregatorProvider: 'usajobs' }, { scrapable: true, via: 'aggregator', reason: 'Fetched from the usajobs API using your BYOK key.' }],
    ['aggregator-reed', { type: 'aggregator', aggregatorProvider: 'reed' }, { scrapable: true, via: 'aggregator', reason: 'Fetched from the reed API using your BYOK key.' }],
    ['aggregator-findwork', { type: 'aggregator', aggregatorProvider: 'findwork' }, { scrapable: true, via: 'aggregator', reason: 'Fetched from the findwork API using your BYOK key.' }],
    ['aggregator-careerjet', { type: 'aggregator', aggregatorProvider: 'careerjet' }, { scrapable: false, via: 'aggregator', reason: 'Aggregator "careerjet" is no longer supported. Update or delete this board.' }],
    ['aggregator-jooble', { type: 'aggregator', aggregatorProvider: 'jooble' }, { scrapable: false, via: 'aggregator', reason: 'Aggregator "jooble" is no longer supported. Update or delete this board.' }],
    ['aggregator-bogus', { type: 'aggregator', aggregatorProvider: 'bogus' }, { scrapable: false, via: 'aggregator', reason: 'Unknown aggregator "bogus". Supported: adzuna, usajobs, reed, findwork.' }],
    // Wave 6 (T724): browser is feedUrl-gated at creation time (deepMode is
    // a run flag, not stored config); without the optional engine the tier
    // reports skipped, never failed, so a configured board stays scrapable.
    ['browser+feed', { type: 'browser', feedUrl: 'https://careers.acme.example.test/jobs' }, { scrapable: true, via: 'browser', reason: 'Last-resort rendered-DOM reader (deep mode only, after a cheaper tier failed for the same URL). Needs the optional browser engine; without it the tier reports skipped.' }],
    ['browser-missing', { type: 'browser' }, { scrapable: false, via: 'browser', reason: 'Requires a feedUrl (the company career page URL).' }],
    ['unknown-type', { type: 'bogus' }, { scrapable: false, via: 'unsupported', reason: 'Unknown board type "bogus".' }],
  ];

  it.each(EXPLAIN_CASES)('explainScrapability reproduces the pre-refactor verdict for %s', (_name, input, expected) => {
    expect(explainScrapability(input)).toEqual(expected);
  });

  // T623 step 5: boardToConfig (jobSources/index.ts) keeps its exact output.
  // index.ts itself is untouched by this task; this pins the contract.
  it('boardToConfig maps a fully-populated board row exactly', () => {
    expect(boardToConfig({
      type: 'greenhouse',
      boardId: 'anthropic',
      feedUrl: null,
      searchQuery: null,
      searchSite: null,
      scraperProvider: null,
      scraperLocation: null,
      scraperResults: null,
      scraperUseProxy: null,
      aggregatorProvider: null,
      aggregatorLocation: null,
    })).toEqual({
      type: 'greenhouse',
      board: 'anthropic',
      feedUrl: undefined,
      searchQuery: undefined,
      searchSite: undefined,
      scraperProvider: undefined,
      scraperLocation: undefined,
      scraperResults: undefined,
      scraperUseProxy: false,
      aggregatorProvider: undefined,
      aggregatorLocation: undefined,
    });
  });

  it('boardToConfig normalizes blanks to undefined and keeps explicit scraper fields', () => {
    expect(boardToConfig({
      type: 'scraper',
      boardId: '',
      feedUrl: '',
      searchQuery: 'engineer',
      searchSite: '',
      scraperProvider: 'linkedin',
      scraperLocation: 'Bengaluru',
      scraperResults: 25,
      scraperUseProxy: true,
      aggregatorProvider: '',
      aggregatorLocation: '',
    })).toEqual({
      type: 'scraper',
      board: undefined,
      feedUrl: undefined,
      searchQuery: 'engineer',
      searchSite: undefined,
      scraperProvider: 'linkedin',
      scraperLocation: 'Bengaluru',
      scraperResults: 25,
      scraperUseProxy: true,
      aggregatorProvider: undefined,
      aggregatorLocation: undefined,
    });
  });
});
