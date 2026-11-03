// Job source fetchers - zero-token, no-auth public ATS APIs.
// Mirrors career-ops providers/ (Greenhouse, Ashby, Lever, Workday, RSS).
// Only public, unauthenticated sources are used (auth-gated boards are out of scope).
//
// Wave 1 (T621): the fetcher bodies moved verbatim into
// `jobSources/adapters/` (one module per provider family). This module keeps
// the exact same public surface - every previously exported name is
// re-exported below.
// Wave 1 (T622, ADR-025): `runSource` is registry-driven. An unknown board
// type or a missing required field now throws instead of returning a silent
// `[]`, so a misconfigured board records `failed` (via the caller's
// per-board try/catch) instead of a healthy zero.

export type { RawJob } from './adapters/http.js';
export { matchHaystack } from './adapters/http.js';
export { fetchGreenhouseDetail, fetchGreenhouse } from './adapters/greenhouse.js';
export { fetchAshby } from './adapters/ashby.js';
export { fetchLever } from './adapters/lever.js';
export { fetchWorkday } from './adapters/workday.js';
export { fetchRss, parseXmlFeedItems } from './adapters/rss.js';
export { fetchJsonBoard } from './adapters/json.js';
export { fetchSmartRecruiters } from './adapters/smartrecruiters.js';
export { fetchRecruitee } from './adapters/recruitee.js';
export { fetchPersonio } from './adapters/personio.js';
export { fetchJobicy } from './adapters/jobicy.js';
export { mapHNThreadComments, fetchHNAlgolia } from './adapters/hnalgolia.js';
// Wave 4 (T681): tier-1 group-A adapters (Workable, BambooHR, BreezyHR,
// Jobvite). Re-exported here so runSource reaches them through their
// registry descriptors, like every existing fetcher above.
export { fetchWorkable } from './adapters/workable.js';
export { fetchBambooHR } from './adapters/bamboohr.js';
export { fetchBreezyHR } from './adapters/breezyhr.js';
export { fetchJobvite } from './adapters/jobvite.js';
// Wave 4 (T682): tier-1 group-B adapters (Teamtailor, Pinpoint,
// Freshteam). Rippling is deferred (no adapter).
export { fetchTeamtailor } from './adapters/teamtailor.js';
export { fetchPinpoint } from './adapters/pinpoint.js';
export { fetchFreshteam } from './adapters/freshteam.js';
// Wave 4 (T683): tier-3 career-page adapter (JSON-LD first, recognised
// ATS link second). Re-exported here so runSource reaches it through its
// registry descriptor, like every existing fetcher above.
export { fetchCareerPage } from './adapters/career-page.js';
export { SUPPORTED_SCRAPER_PROVIDERS, fetchViaScraper } from './adapters/scraper.js';

import {
  getProvider,
  assertProviderConfig,
  UnknownSourceTypeError,
  SourceConfigError,
} from './providerRegistry.js';
import { DEPRECATED_AGGREGATOR_PROVIDERS } from './aggregators.js';
import type { RawJob } from './adapters/http.js';

// Retired provider ids (Wave 1, ADR-006; see
// `.planning/tasks/T101-aggregator-registry-retire-careerjet-jooble.md` and
// `DEPRECATED_AGGREGATOR_PROVIDERS` in `jobSources/aggregators.ts`).
// Careerjet/Jooble were removed from the runtime because their keys need
// partner/publisher approval. A stored row whose `type` is one of these must
// throw a `SourceConfigError` naming the retired provider - not a generic
// unknown-type error - so the failure reads sensibly in source health.
const RETIRED_SOURCE_TYPES: readonly string[] = DEPRECATED_AGGREGATOR_PROVIDERS;

/**
 * Map a stored JobBoard row into a JobSourceConfig for runSource().
 * Centralizes scraper-field wiring so routes stay thin.
 */
export function boardToConfig(b: {
  type: string;
  boardId?: string | null;
  feedUrl?: string | null;
  searchQuery?: string | null;
  searchSite?: string | null;
  scraperProvider?: string | null;
  scraperLocation?: string | null;
  scraperResults?: number | null;
  scraperUseProxy?: boolean | null;
  aggregatorProvider?: string | null;
  aggregatorLocation?: string | null;
}): JobSourceConfig {
  return {
    type: b.type as JobSourceConfig['type'],
    board: b.boardId || undefined,
    feedUrl: b.feedUrl || undefined,
    searchQuery: b.searchQuery || undefined,
    searchSite: b.searchSite || undefined,
    scraperProvider: b.scraperProvider || undefined,
    scraperLocation: b.scraperLocation || undefined,
    scraperResults: b.scraperResults ?? undefined,
    scraperUseProxy: b.scraperUseProxy ?? false,
    aggregatorProvider: b.aggregatorProvider || undefined,
    aggregatorLocation: b.aggregatorLocation || undefined,
  };
}

export interface JobSourceConfig {
  type: 'greenhouse' | 'ashby' | 'lever' | 'workday' | 'rss' | 'json' | 'search' | 'smartrecruiters' | 'recruitee' | 'personio' | 'jobicy' | 'hnalgolia' | 'scraper' | 'aggregator' | 'workable' | 'bamboohr' | 'breezyhr' | 'jobvite' | 'teamtailor' | 'pinpoint' | 'freshteam' | 'career-page' | 'dorking' | 'browser';
  query?: string;
  // For rss/workday/json, provide the feed url
  feedUrl?: string;
  board?: string;
  // For search type
  searchQuery?: string;
  searchSite?: string;
  userId?: string;
  // Run mode flag (Wave 6, T724): deep-mode-only descriptors (today: only
  // `browser`) require an explicit `deepMode: true`. It is a run-mode flag,
  // not board config - no JobBoard column backs it, so boardToConfig never
  // sets it; the deep-search caller (wave 7 orchestrator) supplies it.
  deepMode?: boolean;
  // For scraper type (Node unified backend: Firecrawl/Crawl4AI/RapidAPI, BYOK)
  scraperProvider?: string;
  scraperLocation?: string;
  scraperResults?: number;
  scraperUseProxy?: boolean;
  // For aggregator type (Adzuna/USAJobs/Reed/Findwork, BYOK)
  aggregatorProvider?: string;
  aggregatorLocation?: string;
}

// Run a single configured source. Registry-driven (ADR-025): an unknown
// `type` throws UnknownSourceTypeError, a missing/invalid required field
// throws SourceConfigError, and a retired provider id throws
// SourceConfigError naming the retired provider. `search` with an empty
// effective query is an intentional empty and still returns [] without
// throwing (enforced inside the search descriptor's handler).
export async function runSource(config: JobSourceConfig): Promise<RawJob[]> {
  const d = getProvider(config.type);
  if (!d) {
    if ((RETIRED_SOURCE_TYPES as readonly string[]).includes(config.type)) {
      throw new SourceConfigError(
        `Job source "${config.type}" is no longer supported. Update or delete this board in Settings.`,
      );
    }
    throw new UnknownSourceTypeError(config.type);
  }
  assertProviderConfig(d, config);
  return d.handler(config);
}
