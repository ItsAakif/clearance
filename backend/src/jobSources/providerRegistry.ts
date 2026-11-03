// Provider registry - single source of truth for job providers (Wave 1, ADR-025).
//
// This module describes every one of the 14 existing JobSourceConfig types with
// a descriptor that reproduces today's fetcher behaviour exactly. It does NOT
// rewire runSource (that is a later task): importing this module has no
// behaviour change anywhere; the existing fetchers are referenced, never
// rewritten.
//
// Tier rule for existing types (tiers follow ADR-026/ADR-027 priority):
//   tier 1 = dedicated keyless APIs with a stable schema (ATS posting APIs,
//            Jobicy/HN-Algo lia APIs, official aggregator APIs);
//   tier 2 = generic feed/JSON parsers (workday/rss/json, plus jobicy-shaped
//            tolerance) where the schema varies per board;
//   tier 3 = owned HTTP page fetch - unused by existing types, arrives wave 4;
//   tier 4 = BYOK scraping backend (scraper);
//   tier 5 = search backend (search).
//
// `enabledByDefault` means the type is part of the seeded catalog built by
// getDefaultBoards() (boardCatalog.ts): the wave-1 keyless set is seeded;
// lever/workday, the wave-4 adapters, dorking (wave 5), and browser
// (wave 6, tier 4 - never seeded, never auto-enabled) are false.
//
// `dateMapping` records which RawJob date field each fetcher populates and
// where that date comes from. Provenance values: the source record's posted
// date ('source-posted'), the source record's updated date
// ('source-updated'), data derived from a scraped page ('page-derived'),
// 'index-date' for search-engine index signals (never a posted date), or
// 'discovery-at' when the fetcher emits no date at all (workday,
// indeed-synthesised rows).
//
// `sourceIds` ground truth (verified against fetcher return statements):
//   greenhouse -> 'greenhouse'              (index.ts:68)
//   ashby -> 'ashby'                        (index.ts:116)
//   lever -> 'lever'                        (index.ts:143)
//   workday -> 'workday'                    (index.ts:167)
//   rss -> 'rss'                            (index.ts:206)
//   json -> 'json', plus 'jobicy' when the feed URL is a Jobicy URL, which
//           routes to fetchJobicy (index.ts:346 vs 446, routed index.ts:678-681)
//   search -> 'search'                      (search.ts:64,106,141)
//   dorking -> 'dorking'                    (dorking/index.ts: stampRow -
//           every row this module emits; Wave 5, T702, N4 index-date)
//   smartrecruiters -> 'smartrecruiters'    (index.ts:372)
//   recruitee -> 'recruitee'                (index.ts:396)
//   personio -> 'personio'                  (index.ts:420)
//   jobicy -> 'jobicy'                      (index.ts:446)
//   hnalgolia -> 'hnalgolia'                (index.ts:504)
//   scraper -> every SUPPORTED_SCRAPER_PROVIDERS value plus 'scraper' itself:
//           fetchViaScraper passes the scraped row's own source through
//           (index.ts:589-599); Firecrawl rows use the board name
//           (scrapingBackend.ts:152), RapidAPI rows use the board name or the
//           upstream item source (scrapingBackend.ts:371,427,445,464).
//   aggregator -> the aggregator provider id: 'adzuna' (aggregators.ts:137),
//           'usajobs' (aggregators.usajobs.ts:63), 'reed'
//           (aggregators.reed.ts:46), 'findwork' (aggregators.findwork.ts:56).
//   workable -> 'workable'                     (adapters/workable.ts)
//   bamboohr -> 'bamboohr'                     (adapters/bamboohr.ts)
//   breezyhr -> 'breezyhr'                     (adapters/breezyhr.ts)
//   jobvite -> 'jobvite'                       (adapters/jobvite.ts)
//           (Wave 4, T681; endpoint shapes in
//           `.planning/research/ats-adapter-shapes.md` sections 1-4.)
//   teamtailor -> 'teamtailor'                 (adapters/teamtailor.ts)
//   pinpoint -> 'pinpoint'                     (adapters/pinpoint.ts)
//   freshteam -> 'freshteam'                   (adapters/freshteam.ts)
//           (Wave 4, T682; endpoint shapes in
//           `.planning/research/ats-adapter-shapes.md` sections 5, 6, 8.
//           Rippling is deferred (section 7) and has no adapter.)
//   career-page -> 'career-page'               (adapters/career-page.ts)
//           (Wave 4, T683: tier-3 owned HTTP page fetch - JSON-LD first,
//           recognised ATS link second, clean [] otherwise.)
//
// `allSourceIds()` returns the canonical filterable JobListing.source
// vocabulary (the Wave-0 JOB_SOURCE_VALUES set, 17 ids, grown additively by
// Wave 4 and Wave 5: workable/bamboohr/breezyhr/jobvite (T681),
// teamtailor/pinpoint/freshteam (T682), career-page (T683), dorking (T702)).
// The scraper board
// passthrough names above are board names, not canonical filter values, so
// the scraper descriptor contributes only 'scraper' to that helper; the full
// 12-value ground truth stays available via sourceIdsFor('scraper').
//
// TIER RULE (T684, ADR-026/ADR-027 priority): tiers 1/2/3 are ALL reachable
// by a plain HTTP path (keyless board APIs, generic feeds, owned page
// fetch) and NOTHING in this wave may require a browser (N2 - the browser
// tier is wave 6, which does not exist yet). Pinned structurally: no wave-4
// adapter file may import the browser module (asserted source-level in
// providerRegistry.test.ts).
//
// No secrets are logged or embedded here: error messages name config fields
// and provider ids only, never key material.

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
import { adapterTypeFor } from '../registry/providers.js';
import {
  fetchViaScraper,
  SUPPORTED_SCRAPER_PROVIDERS,
} from './adapters/scraper.js';
import type { JobSourceConfig, RawJob } from './index.js';
import { searchJobs } from './search.js';
import { runDorking } from '../dorking/index.js';
import {
  fetchAggregator,
  AGGREGATOR_PROVIDERS,
  isAggregatorProvider,
  isDeprecatedAggregatorProvider,
} from './aggregators.js';

// Re-exported so route layers source this data through the registry module
// (Wave 1, T623). The canonical homes keep their own exports for existing
// importers: adapters/scraper.ts (via jobSources/index.ts) and aggregators.ts.
export { SUPPORTED_SCRAPER_PROVIDERS, AGGREGATOR_PROVIDERS };

export interface ProviderDescriptor {
  type: string;
  sourceIds: readonly string[];
  kind: 'api' | 'feed' | 'json' | 'search' | 'scraper' | 'aggregator' | 'browser';
  auth: 'keyless' | { byok: string };
  tier: 1 | 2 | 3 | 4 | 5;
  requires: readonly ('board' | 'feedUrl' | 'searchQuery' | 'scraperProvider' | 'aggregatorProvider' | 'deepMode')[];
  explain: string;
  handler: (config: JobSourceConfig) => Promise<RawJob[]>;
  enabledByDefault?: boolean;
  dateMapping?: readonly { field: string; source: 'source-posted' | 'source-updated' | 'page-derived' | 'discovery-at' | 'index-date' | 'unknown' }[];
}

export class UnknownSourceTypeError extends Error {
  constructor(type: string) {
    super(`Unknown job source type "${type}"`);
    this.name = 'UnknownSourceTypeError';
  }
}

export class SourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceConfigError';
  }
}

const requestQuery = (c: JobSourceConfig): string => c.query || '';

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    type: 'greenhouse',
    sourceIds: ['greenhouse'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Greenhouse boards API using the company board token (keyless).',
    handler: (c) => fetchGreenhouse(c.board!, requestQuery(c)),
    enabledByDefault: true,
    dateMapping: [{ field: 'postedAt', source: 'source-updated' }],
  },
  {
    type: 'ashby',
    sourceIds: ['ashby'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Ashby posting API using the company board token (keyless).',
    handler: (c) => fetchAshby(c.board!, requestQuery(c)),
    enabledByDefault: true,
    // Wave 3 (T662, ADR-028): `publishedAt` -> `source-posted`; an
    // `updatedAt`-only row -> `source-updated` (adapters/ashby.ts).
    dateMapping: [
      { field: 'postedAt', source: 'source-posted' },
      { field: 'postedAt', source: 'source-updated' },
    ],
  },
  {
    type: 'lever',
    sourceIds: ['lever'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Lever postings API using the company site token (keyless).',
    handler: (c) => fetchLever(c.board!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'workday',
    sourceIds: ['workday'],
    kind: 'feed',
    auth: 'keyless',
    tier: 2,
    requires: ['feedUrl'],
    explain: 'Fetched from the Workday RSS/JSON feed URL (keyless).',
    handler: (c) => fetchWorkday(c.feedUrl!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'discovery-at' }],
  },
  {
    type: 'rss',
    sourceIds: ['rss'],
    kind: 'feed',
    auth: 'keyless',
    tier: 2,
    requires: ['feedUrl'],
    explain: 'Fetched from the provided RSS/Atom feed URL (keyless).',
    handler: (c) => fetchRss(c.feedUrl!, requestQuery(c)),
    enabledByDefault: true,
    // Wave 3 (T662, ADR-028): `pubDate`/`published`/`date` ->
    // `source-posted`; an `updated`-only item -> `source-updated`
    // (adapters/rss.ts tracks the originating tag in `date_tag`).
    dateMapping: [
      { field: 'postedAt', source: 'source-posted' },
      { field: 'postedAt', source: 'source-updated' },
    ],
  },
  {
    type: 'json',
    sourceIds: ['json', 'jobicy'],
    kind: 'json',
    auth: 'keyless',
    tier: 2,
    requires: ['feedUrl'],
    explain: 'Fetched from the provided JSON feed URL (keyless); a Jobicy feed URL routes to the Jobicy parser instead.',
    handler: (c) => (/jobicy\.com/i.test(c.feedUrl || '')
      ? fetchJobicy(requestQuery(c))
      : fetchJsonBoard(c.feedUrl!, requestQuery(c))),
    enabledByDefault: true,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'search',
    sourceIds: ['search'],
    kind: 'search',
    // Primary search-key provider; Exa is also accepted and a keyless
    // fallback exists, so a missing key is never a misconfiguration.
    auth: { byok: 'tavily' },
    tier: 5,
    // Empty effective query is an INTENTIONAL empty (runSource returns []),
    // not a misconfiguration - so no required fields here.
    requires: [],
    explain: 'Run as a web search via your Tavily/Exa key (or the keyless fallback).',
    handler: (c) => {
      const effectiveQuery = (c.query || '').trim() || (c.searchQuery || '').trim();
      if (!effectiveQuery) return Promise.resolve([]);
      return searchJobs(
        { query: effectiveQuery, site: c.searchSite, maxResults: 10 },
        c.userId,
      );
    },
    enabledByDefault: true,
    // Wave 3 (T662, ADR-028): the keyed providers (Tavily `published_date`,
    // Exa `publishedDate`) emit search-engine index signals, never posted
    // dates - both are classified `index-date` with a null `postedAt`
    // (search.ts). The keyless Arbeitnow fallback reads a board-native
    // `created_at` and keeps it as `source-posted`; it is the documented
    // exception to this tier-level mapping.
    dateMapping: [{ field: 'postedAt', source: 'index-date' }],
  },
  {
    type: 'smartrecruiters',
    sourceIds: ['smartrecruiters'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public SmartRecruiters postings API using the company token (keyless).',
    handler: (c) => fetchSmartRecruiters(c.board!, requestQuery(c)),
    enabledByDefault: true,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'recruitee',
    sourceIds: ['recruitee'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Recruitee offers API using the company token (keyless).',
    handler: (c) => fetchRecruitee(c.board!, requestQuery(c)),
    enabledByDefault: true,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'personio',
    sourceIds: ['personio'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Personio postings API using the company subdomain (keyless).',
    handler: (c) => fetchPersonio(c.board!, requestQuery(c)),
    enabledByDefault: true,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'jobicy',
    sourceIds: ['jobicy'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: [],
    explain: "Fetched from Jobicy's keyless remote-jobs API.",
    handler: (c) => fetchJobicy(requestQuery(c)),
    enabledByDefault: true,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'hnalgolia',
    sourceIds: ['hnalgolia'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: [],
    explain: 'Fetched from the Hacker News (Algolia) jobs API (keyless).',
    handler: (c) => fetchHNAlgolia(requestQuery(c)),
    enabledByDefault: true,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'scraper',
    sourceIds: [...SUPPORTED_SCRAPER_PROVIDERS, 'scraper'],
    kind: 'scraper',
    // Preferred backend for medium boards; Crawl4AI and RapidAPI are also
    // accepted (hard boards REQUIRE RapidAPI) - see scrapingBackend.ts.
    auth: { byok: 'firecrawl' },
    tier: 4,
    // No required fields: a missing scraperProvider defaults to
    // 'googlesearch' inside fetchViaScraper (index.ts). Unknown values throw
    // below. Creation-time requiredness stays in routes/boards.ts.
    requires: [],
    explain: 'Scraped via your configured backend (Firecrawl/Crawl4AI for YC/Wellfound/Instahyre/Sprout/Google; RapidAPI for LinkedIn/Indeed/ZipRecruiter/Glassdoor/Bayt).',
    handler: (c) => fetchViaScraper(c),
    enabledByDefault: true,
    dateMapping: [{ field: 'postedAt', source: 'page-derived' }],
  },
  {
    type: 'aggregator',
    sourceIds: [...AGGREGATOR_PROVIDERS],
    kind: 'aggregator',
    // Key provider follows the board's aggregatorProvider
    // (adzuna/usajobs/reed/findwork); adzuna is the default-seeded global one.
    auth: { byok: 'adzuna' },
    tier: 1,
    requires: ['aggregatorProvider'],
    explain: 'Fetched from an official aggregator API (Adzuna/USAJobs/Reed/Findwork) using your BYOK key.',
    handler: (c) => fetchAggregator(
      c.aggregatorProvider!,
      {
        query: c.query || c.searchQuery || '',
        location: c.aggregatorLocation,
        resultsWanted: c.scraperResults ?? 20,
        userId: c.userId,
      },
    ),
    enabledByDefault: true,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  // Wave 4 (T681, ADR-025): tier-1 group-A adapters. Endpoints, auth,
  // requiredConfig, and dateMapping are recorded in
  // `.planning/research/ats-adapter-shapes.md` sections 1-4; each
  // descriptor's `board` is the research doc's boardToken (company id /
  // subdomain / portal slug / site slug). Appended after the Wave-1
  // descriptors so every pre-existing source id keeps its position in
  // allSourceIds(). None is in the seeded catalog, so enabledByDefault
  // is false (same rule as lever/workday).
  {
    type: 'workable',
    sourceIds: ['workable'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Workable board API using the company id from the jobs.workable.com URL (keyless).',
    handler: (c) => fetchWorkable(c.board!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'bamboohr',
    sourceIds: ['bamboohr'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public BambooHR careers feed using the company subdomain (keyless).',
    handler: (c) => fetchBambooHR(c.board!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'discovery-at' }],
  },
  {
    type: 'breezyhr',
    sourceIds: ['breezyhr'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public BreezyHR portal feed using the portal slug (keyless).',
    handler: (c) => fetchBreezyHR(c.board!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'jobvite',
    sourceIds: ['jobvite'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Jobvite careers site using the site slug, with per-job details from the page JSON-LD (keyless).',
    handler: (c) => fetchJobvite(c.board!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  // Wave 4 (T682, ADR-025): tier-1 group-B adapters. Endpoints, auth,
  // requiredConfig, and dateMapping are recorded in
  // `.planning/research/ats-adapter-shapes.md` sections 5-8; each
  // descriptor's `board` is the research doc's subdomain (teamtailor
  // subdomain / pinpoint subdomain / freshteam domain). Rippling is
  // DEFERRED (research doc section 7: no keyless endpoint verified) and
  // gets NO descriptor. Appended after the group-A descriptors so every
  // pre-existing source id keeps its position in allSourceIds(). None is
  // in the seeded catalog, so enabledByDefault is false (same rule as
  // lever/workday).
  {
    type: 'teamtailor',
    sourceIds: ['teamtailor'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Teamtailor careers site using the company subdomain, with per-job details from the page JSON-LD (keyless).',
    handler: (c) => fetchTeamtailor(c.board!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  {
    type: 'pinpoint',
    sourceIds: ['pinpoint'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Pinpoint postings feed using the company subdomain (keyless).',
    handler: (c) => fetchPinpoint(c.board!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'discovery-at' }],
  },
  {
    type: 'freshteam',
    sourceIds: ['freshteam'],
    kind: 'api',
    auth: 'keyless',
    tier: 1,
    requires: ['board'],
    explain: 'Fetched from the public Freshteam careers site using the company domain, with per-job details from the page JSON-LD (keyless).',
    handler: (c) => fetchFreshteam(c.board!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'source-posted' }],
  },
  // Wave 4 (T683, ADR-025): tier-3 career-page adapter. Reads a company's
  // OWN career page over plain HTTP (adapters/career-page.ts): JSON-LD
  // JobPosting blocks first, a recognised ATS link (via `extractAts`, the
  // ONE host table) second, clean [] when neither exists. Never uses a
  // browser (that is wave 6). Appended after the tier-1 descriptors so
  // every pre-existing source id keeps its position in allSourceIds().
  // Not in the seeded catalog, so enabledByDefault is false (same rule as
  // lever/workday). The page URL arrives in `feedUrl` (same field the
  // other page/URL-fetching descriptors use).
  {
    type: 'career-page',
    sourceIds: ['career-page'],
    kind: 'feed',
    auth: 'keyless',
    tier: 3,
    requires: ['feedUrl'],
    explain: 'Fetched from the company career page URL over plain HTTP: JSON-LD JobPosting blocks first, a recognised ATS link second (keyless).',
    handler: (c) => fetchCareerPage(c.feedUrl!, requestQuery(c)),
    enabledByDefault: false,
    dateMapping: [
      { field: 'postedAt', source: 'source-posted' },
      { field: 'postedAt', source: 'discovery-at' },
    ],
  },
  // Wave 5 (T702, ADR-025): template-driven dorking. A configured board
  // type like `scraper` - never a replacement for other boards (N3; the
  // guarantee is documented in `dorking/index.ts` and enforced by wave 7's
  // orchestrator). Runs T701's expanded queries through the EXISTING
  // `searchJobs` backend (no new client/key/provider); every row it emits
  // carries `source: 'dorking'` stamped `index-date` with a null `postedAt`
  // (N4, ADR-028). Appended after the wave-4 descriptors so every
  // pre-existing source id keeps its position in allSourceIds() (N1).
  // Not in the seeded catalog, so enabledByDefault is false (same rule as
  // lever/workday and the wave-4 adapters). The board query arrives in
  // `query` with `searchQuery` as fallback (same rule the `search`
  // descriptor uses); an empty intent still expands the generic families,
  // so no field is required.
  {
    type: 'dorking',
    sourceIds: ['dorking'],
    kind: 'search',
    // Same backend as `search` (Tavily/Exa key or the keyless fallback).
    auth: { byok: 'tavily' },
    tier: 5,
    requires: [],
    explain: 'Template-driven dork queries run through the existing search backend (your Tavily/Exa key or the keyless fallback); every row is labelled index-found, never posted.',
    handler: (c) => runDorking(
      { query: (c.query || c.searchQuery || '').trim() },
      { userId: c.userId },
    ),
    enabledByDefault: false,
    dateMapping: [{ field: 'postedAt', source: 'index-date' }],
  },
  // Wave 6 (T724, ADR-029): tier-4 browser adapter. Reads a company's OWN
  // career page from the RENDERED DOM (`browser/tier.ts`): JSON-LD
  // JobPosting blocks first (the ONE shared implementation in
  // `adapters/jobPostingHtml.ts`), a recognised ATS link second, clean []
  // otherwise. ENHANCEMENT ONLY (ADR-029 decision 4): this tier contributes
  // rows, it never gates them - it is reachable only in deep mode and only
  // after a cheaper tier failed for the same URL (wave 7 enforces the
  // routing; this descriptor declares the capability via `tier: 4` plus the
  // `deepMode` require). `enabledByDefault: false`: never seeded, never
  // auto-enabled. The page URL arrives in `feedUrl` (same field the other
  // page/URL-fetching descriptors use).
  //
  // N2 PROOF BY CONSTRUCTION: the handler imports the browser module
  // LAZILY (dynamic `import()`), so importing this registry - and booting
  // the app - can never fail when the automation library/engine is absent.
  // No other module outside `backend/src/browser/*` may statically import
  // that tree (asserted source-level in `browser/tier.test.ts`).
  {
    type: 'browser',
    sourceIds: ['browser'],
    kind: 'browser',
    // No BYOK key: the tier needs the automation engine (full image /
    // sidecar), not an API key. Absent engine reports skipped-with-reason.
    auth: 'keyless',
    tier: 4,
    requires: ['feedUrl', 'deepMode'],
    explain: 'ENHANCEMENT ONLY (ADR-029): last-resort rendered-DOM reader for a company career page your cheaper tiers could not read (JSON-LD first, recognised ATS link second). Deep mode only, after a cheaper tier failed for the same URL; needs the optional browser engine, otherwise skipped.',
    handler: (c) => import('../browser/tier.js').then((m) => m.fetchViaBrowser(c.feedUrl!, requestQuery(c))),
    enabledByDefault: false,
    dateMapping: [
      { field: 'postedAt', source: 'source-posted' },
      { field: 'postedAt', source: 'discovery-at' },
    ],
  },
];

export function getProvider(type: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.type === type);
}

export function sourceIdsFor(type: string): readonly string[] {
  return getProvider(type)?.sourceIds ?? [];
}

export function allSourceIds(): readonly string[] {
  // Canonical filterable vocabulary (Wave-0 JOB_SOURCE_VALUES, 17 ids, grown
  // additively by Wave 4: workable, bamboohr, breezyhr, jobvite (T681) plus
  // teamtailor, pinpoint, freshteam (T682) plus career-page (T683)) in
  // Wave-0 display order. Membership derives from PROVIDERS - there is no
  // second hand-maintained list. The order rule is likewise derived, not
  // hardcoded:
  //  - descriptors iterate in declaration order;
  //  - an id that is also another descriptor's own type (today: 'jobicy',
  //    which 'json' boards can additionally emit) resolves at its owner's
  //    position instead of its first-seen position;
  //  - the synthetic query/provider-routed kinds ('search', 'scraper',
  //    'browser') sort last; they are not feed/API sources.
  // The scraper descriptor additionally lists board passthrough names
  // (SUPPORTED_SCRAPER_PROVIDERS values) which are board names rather than
  // canonical filter values, so it contributes only 'scraper' here.
  const ownedTypes = new Set(PROVIDERS.map((p) => p.type));
  const isTrailingKind = (d: ProviderDescriptor): boolean =>
    d.kind === 'search' || d.kind === 'scraper' || d.kind === 'browser';
  const idsFor = (d: ProviderDescriptor): readonly string[] =>
    d.type === 'scraper' ? ['scraper'] : d.sourceIds;
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  // Pass 1: every id at its owner's position, in descriptor declaration
  // order (ids owned by another descriptor resolve in pass 2).
  for (const d of PROVIDERS) {
    if (isTrailingKind(d)) continue;
    for (const id of idsFor(d)) {
      if (id === d.type || !ownedTypes.has(id)) push(id);
    }
  }
  // Pass 2: leftovers owned by another descriptor (today this is a no-op -
  // 'jobicy' is emitted by its own descriptor in pass 1; the pass keeps the
  // function total if a future multi-emit descriptor ever precedes its
  // owner).
  for (const d of PROVIDERS) {
    if (isTrailingKind(d)) continue;
    for (const id of idsFor(d)) push(id);
  }
  // Pass 3: synthetic query/provider-routed sources last, in declaration order.
  for (const d of PROVIDERS) {
    if (!isTrailingKind(d)) continue;
    for (const id of idsFor(d)) push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry-driven tier routing (T684, wave-4 spec DESIGN - Registry routing).
//
// A `CompanyCareerPage` row names its adapter in `provider` and supplies the
// adapter config in `boardToken`; a row with `provider: null` is a tier-3
// page served by `fetchCareerPage` from the row URL. The mapping below is
// DATA derived from `registry/providers.ts` (adapterTypeFor) plus this
// module's own descriptors (getProvider + requires) - NOT a per-provider
// if-ladder and NOT a second list: the loop walks the descriptor's own
// `requires` vocabulary and binds each required field to the row field that
// carries it ('board' <- boardToken, 'feedUrl' <- row URL,
// 'aggregatorProvider' <- provider). A row whose provider has no adapter
// yet (deferred providers such as rippling, or a genuinely unknown id)
// throws UnknownSourceTypeError; a row missing its required config throws
// SourceConfigError via assertProviderConfig (T622 semantics), never [].
// ---------------------------------------------------------------------------

/** Minimal `CompanyCareerPage` row shape the tier router consumes. */
export interface RegistryCareerPageRow {
  provider: string | null;
  boardToken: string | null;
  url: string;
}

export function configForRegistryRow(
  row: RegistryCareerPageRow,
  query = '',
  userId?: string,
): JobSourceConfig {
  const adapterType = adapterTypeFor(row.provider);
  if (adapterType === null) {
    throw new UnknownSourceTypeError(String(row.provider ?? 'null'));
  }
  const d = getProvider(adapterType);
  if (!d) {
    throw new UnknownSourceTypeError(adapterType);
  }
  const config = {
    type: d.type as JobSourceConfig['type'],
    query,
    userId,
  } as JobSourceConfig;
  for (const field of d.requires) {
    if (field === 'board') config.board = row.boardToken ?? undefined;
    else if (field === 'feedUrl') config.feedUrl = row.url;
    else if (field === 'aggregatorProvider') config.aggregatorProvider = row.provider ?? undefined;
    // 'searchQuery'/'scraperProvider'/'deepMode' have no registry-row
    // source: left unset so assertProviderConfig throws if a routed
    // descriptor ever requires them (no silent misconfiguration).
  }
  assertProviderConfig(d, config);
  return config;
}

function readRequiredField(
  c: JobSourceConfig,
  field: 'board' | 'feedUrl' | 'searchQuery' | 'scraperProvider' | 'aggregatorProvider' | 'deepMode',
): string | undefined {
  switch (field) {
    case 'board':
      return c.board;
    case 'feedUrl':
      return c.feedUrl;
    case 'searchQuery':
      // Request query wins with board query as fallback (same rule runSource
      // uses); only enforced for future types that require it - search itself
      // requires nothing because an empty effective query is intentional.
      return c.query || c.searchQuery;
    case 'scraperProvider':
      return c.scraperProvider;
    case 'aggregatorProvider':
      return c.aggregatorProvider;
    case 'deepMode':
      // Run mode, not board config (set by the deep-search caller, owned by
      // wave 7's orchestrator): only an explicit `deepMode: true` satisfies
      // a deep-mode-only descriptor such as `browser`.
      return c.deepMode === true ? 'deep' : undefined;
  }
}

function missingFieldMessage(
  d: ProviderDescriptor,
  field: 'board' | 'feedUrl' | 'searchQuery' | 'scraperProvider' | 'aggregatorProvider' | 'deepMode',
): string {
  switch (field) {
    case 'board':
      return `Job source "${d.type}" is missing "board" (company token). Set boardId on the board in Settings.`;
    case 'feedUrl':
      return `Job source "${d.type}" is missing "feedUrl". Set a feed URL on the board in Settings.`;
    case 'searchQuery':
      return `Job source "${d.type}" is missing "searchQuery". Set a search query on the board in Settings.`;
    case 'scraperProvider':
      return `Job source "scraper" is missing "scraperProvider". Supported: ${SUPPORTED_SCRAPER_PROVIDERS.join(', ')}.`;
    case 'aggregatorProvider':
      return `Job source "aggregator" is missing "aggregatorProvider". Supported: ${AGGREGATOR_PROVIDERS.join(', ')}.`;
    case 'deepMode':
      return `Job source "${d.type}" runs in deep mode only (ENHANCEMENT ONLY, ADR-029). Rerun as a deep search after a cheaper tier failed for the same URL.`;
  }
}

export function assertProviderConfig(d: ProviderDescriptor, c: JobSourceConfig): void {
  for (const field of d.requires) {
    const value = readRequiredField(c, field);
    if (!value || value.trim().length === 0) {
      throw new SourceConfigError(missingFieldMessage(d, field));
    }
  }
  // Unknown scraper boards must fail loudly (matches the 400 in
  // routes/boards.ts); a missing value is fine and defaults downstream.
  if (d.type === 'scraper' && c.scraperProvider) {
    if (!(SUPPORTED_SCRAPER_PROVIDERS as readonly string[]).includes(c.scraperProvider)) {
      throw new SourceConfigError(
        `Unsupported scraperProvider "${c.scraperProvider}". Supported: ${SUPPORTED_SCRAPER_PROVIDERS.join(', ')}.`,
      );
    }
  }
  // Unknown or retired aggregators must fail loudly (matches the 400s and
  // the fetchAggregator guards in routes/boards.ts and aggregators.ts).
  if (d.type === 'aggregator' && c.aggregatorProvider) {
    if (isDeprecatedAggregatorProvider(c.aggregatorProvider)) {
      throw new SourceConfigError(
        `Aggregator "${c.aggregatorProvider}" is no longer supported. Update or delete this board in Settings.`,
      );
    }
    if (!isAggregatorProvider(c.aggregatorProvider)) {
      throw new SourceConfigError(
        `Unknown aggregator "${c.aggregatorProvider}". Supported: ${AGGREGATOR_PROVIDERS.join(', ')}.`,
      );
    }
  }
}
