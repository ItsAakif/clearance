// Job source fetchers - zero-token, no-auth public ATS APIs.
// Mirrors career-ops providers/ (Greenhouse, Ashby, Lever, Workday, RSS).
// Only public, unauthenticated sources are used (auth-gated boards are out of scope).

export interface RawJob {
  externalId?: string;
  source: string;
  sourceUrl: string;
  title: string;
  company: string;
  location?: string;
  description: string;
  applyUrl?: string;
  postedAt?: Date;
}

const fetcher = async (url: string): Promise<any> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ClearanceJobBot/1.0 (+https://clearance.app)' },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.json();
};

// ---- Greenhouse (board token based) ----
export async function fetchGreenhouse(board: string, query: string): Promise<RawJob[]> {
  const base = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
  const data = await fetcher(base);
  const jobs: any[] = data.jobs || [];
  return jobs
    .filter((j) => !query || `${j.title} ${j.location?.name || ''}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: String(j.id),
      source: 'greenhouse',
      sourceUrl: j.absolute_url,
      title: j.title,
      company: board,
      location: j.location?.name,
      description: j.content || '',
      applyUrl: j.absolute_url,
      postedAt: j.updated_at ? new Date(j.updated_at) : undefined,
    }));
}

// ---- Ashby ----
export async function fetchAshby(company: string, query: string): Promise<RawJob[]> {
  const base = `https://jobs.ashbyhq.com/api/non-user-graphql?op=JobBoard` ;
  const body = {
    operationName: 'JobBoard',
    query: `query JobBoard { jobBoard { jobs { id title locationName departmentName isListed employmentType } } }`,
    variables: { organizationId: company },
  };
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: any = await res.json();
  const jobs: any[] = data?.data?.jobBoard?.jobs || [];
  return jobs
    .filter((j) => j.isListed !== false)
    .filter((j) => !query || `${j.title} ${j.locationName || ''}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: String(j.id),
      source: 'ashby',
      sourceUrl: `https://jobs.ashbyhq.com/${company}/${j.id}`,
      title: j.title,
      company,
      location: j.locationName,
      description: `${j.title} - ${j.departmentName || ''} (${j.employmentType || ''})`,
      applyUrl: `https://jobs.ashbyhq.com/${company}/${j.id}`,
    }));
}

// ---- Lever (postings API) ----
export async function fetchLever(site: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(`https://api.lever.co/v0/postings/${site}?mode=json`);
  const jobs: any[] = Array.isArray(data) ? data : [];
  return jobs
    .filter((j) => j.hostedUrl)
    .filter((j) => !query || `${j.text} ${j.categories?.location || ''}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: j.id,
      source: 'lever',
      sourceUrl: j.hostedUrl,
      title: j.text,
      company: site,
      location: j.categories?.location,
      description: j.descriptionPlain || '',
      applyUrl: j.hostedUrl,
      postedAt: j.createdAt ? new Date(j.createdAt) : undefined,
    }));
}

// ---- Workday (public RSS/JSON feed, generic) ----
export async function fetchWorkday(rssUrl: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(rssUrl);
  const items: any[] = data?.jobs || [];
  return items
    .filter((j) => !query || `${j.title}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: j.jobId || j.id,
      source: 'workday',
      sourceUrl: j.url || j.applyUrl,
      title: j.title,
      company: j.company || 'Workday',
      location: j.location,
      description: j.description || j.title,
      applyUrl: j.url || j.applyUrl,
    }));
}

// ---- RSS / JSON boards ----
export async function fetchRss(feedUrl: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(feedUrl);
  const items: any[] = data?.items || data?.entries || [];
  return items
    .filter((j) => !query || `${j.title}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: j.guid || j.id || j.link,
      source: 'rss',
      sourceUrl: j.link || j.url,
      title: j.title,
      company: j.author || j.company || 'RSS',
      location: j.location,
      description: j.content || j.summary || j.description || '',
      applyUrl: j.link || j.url,
      postedAt: j.date_published ? new Date(j.date_published) : j.pubDate ? new Date(j.pubDate) : undefined,
    }));
}

// ---- RemoteOK-style public JSON boards (keyless) ----
// e.g. https://remoteok.com/api  and  https://remotive.com/api/remote-jobs
export async function fetchJsonBoard(feedUrl: string, query: string): Promise<RawJob[]> {
  const data: any = await fetcher(feedUrl);
  // RemoteOK wraps the array in an object keyed by "job" sometimes, or returns
  // a bare array; Remotive returns { "job-count": n, "jobs": [...] }.
  let items: any[] = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data?.jobs)) items = data.jobs;
  else if (Array.isArray(data?.data)) items = data.data;
  else if (Array.isArray(data?.items)) items = data.items;

  return items
    .filter((j) => j && (j.title || j.position || j.text)) // RemoteOK index 0 is a legal notice
    .filter((j) => !query || `${(j.title || j.position || '')} ${(j.company || '')}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: String(j.id ?? j.slug ?? j.url ?? `${j.title}-${j.company}`),
      source: 'json',
      sourceUrl: j.url || j.apply_url || j.link,
      title: j.title || j.position || j.text || 'Untitled Role',
      company: j.company || j.company_name || 'Unknown',
      location: j.location || (j.tags ? undefined : undefined) || (Array.isArray(j.location) ? j.location.join(', ') : undefined),
      description: j.description || j.content || '',
      applyUrl: j.url || j.apply_url || j.link,
      postedAt: j.date ? new Date(j.date) : j.pubDate ? new Date(j.pubDate) : undefined,
    }));
}

// ---- SmartRecruiters (public postings API, keyless) ----
export async function fetchSmartRecruiters(company: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(`https://api.smartrecruiters.com/v1/companies/${company}/postings?limit=100`);
  const jobs: any[] = data?.content || [];
  return jobs
    .filter((j) => !query || `${j.name}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: j.id,
      source: 'smartrecruiters',
      sourceUrl: j.applyUrl || j.references?.landingPage,
      title: j.name || 'Untitled Role',
      company: j.company?.name || company,
      location: j.location?.city || (j.location ? `${j.location.city || ''}` : undefined),
      description: j.description || '',
      applyUrl: j.applyUrl || j.references?.landingPage,
      postedAt: j.postedDate ? new Date(j.postedDate) : undefined,
    }));
}

// ---- Recruitee (public postings API, keyless) ----
export async function fetchRecruitee(company: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(`https://#{company}.recruitee.com/api/offers.json`.replace('#{company}', company));
  const jobs: any[] = data?.offers || [];
  return jobs
    .filter((j) => !query || `${j.title}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: String(j.id),
      source: 'recruitee',
      sourceUrl: j.url,
      title: j.title || 'Untitled Role',
      company: company,
      location: j.location || undefined,
      description: j.description || '',
      applyUrl: j.url,
      postedAt: j.published_at ? new Date(j.published_at) : undefined,
    }));
}

// ---- Personio (public postings API, keyless) ----
export async function fetchPersonio(company: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(`https://${company}.jobs.personio.de/search.json?language=en`);
  const jobs: any[] = data?.jobPostings || [];
  return jobs
    .filter((j) => !query || `${j.name}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: String(j.id),
      source: 'personio',
      sourceUrl: j.applicationUrl || j.url,
      title: j.name || 'Untitled Role',
      company: j.company || company,
      location: j.officeName || undefined,
      description: j.jobDescriptions?.[0]?.value || '',
      applyUrl: j.applicationUrl || j.url,
      postedAt: j.createdAt ? new Date(j.createdAt) : undefined,
    }));
}

// ---- Jobicy (remote, keyless JSON) ----
export async function fetchJobicy(query: string): Promise<RawJob[]> {
  const data = await fetcher('https://jobicy.com/api/remote-jobs?count=50');
  const jobs: any[] = Array.isArray(data) ? data : data?.jobs || [];
  return jobs
    .filter((j) => j && j.job_title)
    .filter((j) => !query || `${j.job_title} ${j.employer_name || ''}`.toLowerCase().includes(query.toLowerCase()))
    .map((j) => ({
      externalId: String(j.id ?? j.slug ?? j.job_url),
      source: 'jobicy',
      sourceUrl: j.job_url || j.url,
      title: j.job_title || 'Untitled Role',
      company: j.employer_name || 'Unknown',
      location: j.job_location || (j.job_is_remote ? 'Remote' : undefined),
      description: j.job_description || '',
      applyUrl: j.job_url || j.url,
      postedAt: j.job_posted_at_datetime_utc ? new Date(j.job_posted_at_datetime_utc) : undefined,
    }));
}

// ---- Hacker News "who is hiring" (keyless Algolia API) ----
// HN's monthly "Ask HN: Who is hiring?" thread is a goldmine of startup/US roles.
// Fetched via the public Algolia HN search API (no key, no rate limit).
export async function fetchHNAlgolia(query: string): Promise<RawJob[]> {
  const q = query || 'who is hiring';
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=job&hitsPerPage=50`;
  const data: any = await fetcher(url);
  const hits: any[] = data?.hits || [];
  return hits
    .filter((h) => h && (h.title || h.story_title))
    .map((h) => ({
      externalId: String(h.objectID),
      source: 'hnalgolia',
      sourceUrl: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title || h.story_title || 'HN Job Post',
      company: extractHNCompany(h.title || h.story_title || ''),
      location: extractHNLocation(h.title || h.story_title || ''),
      description: h.title || h.story_title || '',
      applyUrl: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      postedAt: h.created_at ? new Date(h.created_at) : undefined,
    }));
}

function extractHNCompany(text: string): string {
  // "CompanyName (Remote) is hiring ..." or "CompanyName is hiring ..."
  const m = text.match(/^([^(|\n]+?)\s*(?:\([^)]*\))?\s+is hiring/i);
  return m ? m[1].trim() : 'Hacker News';
}

function extractHNLocation(text: string): string | undefined {
  const m = text.match(/\(([^)]*remote[^)]*)\)/i) || text.match(/\(([^)]*)\)/i);
  return m ? m[1].trim() : undefined;
}

// ---- Unified scraping backend (Firecrawl / Crawl4AI / RapidAPI) ----
// All scraping now runs in Node via jobSources/scrapingBackend.ts, with the
// user's own backend keys (BYOK) stored in the AIProviderKey table.
// The user brings their own backend key (BYOK) in Settings:
//   - Firecrawl / Crawl4AI (self-hostable): YC, Wellfound, Instahyre, Sprout, Google
//   - RapidAPI (JSearch + PullAPI): LinkedIn, Indeed, ZipRecruiter, Glassdoor, Bayt
// LinkedIn/Indeed etc. are NOT scrapeable by Firecrawl/Crawl4AI (aggressive anti-bot);
// they require a RapidAPI key. See scrapingBackend.ts for details.

// Boards the user can configure as `scraper` type. `scraperProvider` names the
// board; the backend is resolved automatically (hard boards -> RapidAPI).
export const SUPPORTED_SCRAPER_PROVIDERS = [
  'linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'bayt', 'naukri', // hard -> RapidAPI
  'wellfound', 'instahyre', 'sprout', 'googlesearch', 'ycombinator',  // medium -> Firecrawl/Crawl4AI
] as const;

export async function fetchViaScraper(config: JobSourceConfig): Promise<RawJob[]> {
  // Routed to the unified, Node-only scraping backend (Firecrawl / Crawl4AI /
  // RapidAPI). Replaces the old Python JobSpy/Playwright microservice.
  const { scrapeBoard } = await import('./scrapingBackend.js');
  const jobs = await scrapeBoard({
    provider: config.scraperProvider || 'googlesearch',
    query: config.query || config.searchQuery || '',
    location: config.scraperLocation,
    resultsWanted: config.scraperResults ?? 25,
    userId: config.userId,
  });
  return jobs.map((j) => ({
    externalId: String(j.externalId || j.applyUrl || `${j.title}-${j.company}`),
    source: j.source,
    sourceUrl: j.sourceUrl || j.applyUrl || '',
    title: j.title,
    company: j.company,
    location: j.location,
    description: j.description,
    applyUrl: j.applyUrl,
    postedAt: j.postedAt,
  }));
}

import { searchJobs } from './search.js';
import { fetchAggregator } from './aggregators.js';

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
  type: 'greenhouse' | 'ashby' | 'lever' | 'workday' | 'rss' | 'json' | 'search' | 'smartrecruiters' | 'recruitee' | 'personio' | 'jobicy' | 'hnalgolia' | 'scraper' | 'aggregator';
  query?: string;
  // For rss/workday/json, provide the feed url
  feedUrl?: string;
  board?: string;
  // For search type
  searchQuery?: string;
  searchSite?: string;
  userId?: string;
  // For scraper type (Node unified backend: Firecrawl/Crawl4AI/RapidAPI, BYOK)
  scraperProvider?: string;
  scraperLocation?: string;
  scraperResults?: number;
  scraperUseProxy?: boolean;
  // For aggregator type (Adzuna/Careerjet/Jooble, BYOK)
  aggregatorProvider?: string;
  aggregatorLocation?: string;
}

// Run a single configured source. Requires explicit board/feedUrl.
export async function runSource(config: JobSourceConfig): Promise<RawJob[]> {
  const query = config.query || '';
  switch (config.type) {
    case 'greenhouse':
      if (!config.board) return [];
      return fetchGreenhouse(config.board, query);
    case 'ashby':
      if (!config.board) return [];
      return fetchAshby(config.board, query);
    case 'lever':
      if (!config.board) return [];
      return fetchLever(config.board, query);
    case 'workday':
      if (!config.feedUrl) return [];
      return fetchWorkday(config.feedUrl, query);
    case 'rss':
      if (!config.feedUrl) return [];
      return fetchRss(config.feedUrl, query);
    case 'json':
      if (!config.feedUrl) return [];
      return fetchJsonBoard(config.feedUrl, query);
    case 'smartrecruiters':
      if (!config.board) return [];
      return fetchSmartRecruiters(config.board, query);
    case 'recruitee':
      if (!config.board) return [];
      return fetchRecruitee(config.board, query);
    case 'personio':
      if (!config.board) return [];
      return fetchPersonio(config.board, query);
    case 'jobicy':
      return fetchJobicy(query);
    case 'hnalgolia':
      return fetchHNAlgolia(query);
    case 'scraper':
      return fetchViaScraper(config);
    case 'aggregator':
      if (!config.aggregatorProvider) return [];
      return fetchAggregator(
        config.aggregatorProvider as 'adzuna' | 'careerjet' | 'jooble',
        {
          query: config.query || config.searchQuery || '',
          location: config.aggregatorLocation,
          resultsWanted: config.scraperResults ?? 20,
          userId: config.userId,
        }
      );
    case 'search':
      if (!config.searchQuery) return [];
      return searchJobs(
        { query: config.searchQuery, site: config.searchSite, maxResults: 10 },
        config.userId
      );
    default:
      return [];
  }
}
