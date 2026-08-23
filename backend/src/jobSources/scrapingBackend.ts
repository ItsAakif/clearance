// Unified Scraping Backend abstraction.
//
// Replaces the old Python (JobSpy/Playwright) microservice with a Node-only
// design where the USER brings their own scraping backend (BYOK), because our
// product is self-hosted. Three backends are supported:
//
//   1. firecrawl  - self-hosted or cloud Firecrawl (URL + key).
//      Handles: Y Combinator, Wellfound, Instahyre, Sprout, Google search, ATS.
//      CANNOT handle: LinkedIn, Indeed, ZipRecruiter, Bayt, Naukri (aggressive
//      anti-bot - Firecrawl's self-hosted build fails on these; see GitHub
//      issue #2257). Tell users this clearly.
//
//   2. crawl4ai   - self-hosted Crawl4AI (URL + key). Same coverage as
//      Firecrawl for the medium boards; same hard-board limitation.
//
//   3. rapidapi   - RapidAPI marketplace key. This is what covers the HARD
//      boards. A single key unlocks several job APIs:
//        - JSearch      -> LinkedIn, Indeed, ZipRecruiter, Glassdoor, Bayt (one call)
//        - PullAPI LinkedIn  -> LinkedIn (free Basic tier)
//        - PullAPI Indeed   -> Indeed  (free Basic tier)
//      We query JSearch first for max coverage, then fall back to the PullAPI
//      endpoints for any board JSearch didn't surface. Results are deduplicated
//      by apply URL across all sources.
//
// All backends are called from Node over HTTP. No Python in our codebase.

import prisma from '../lib/prisma.js';
import { decryptSecret } from '../lib/crypto.js';
import { leaseNextKey, markKeySuccess, markKeyFailure } from '../ai/keyManager.js';

export interface ScrapedJob {
  externalId?: string;
  source: string;
  sourceUrl?: string;
  title: string;
  company: string;
  location?: string;
  description: string;
  applyUrl?: string;
  postedAt?: Date;
  // Which backend produced this (firecrawl | crawl4ai | rapidapi)
  backend: string;
}

// Boards that third-party APIs (RapidAPI) can scrape but Firecrawl/Crawl4AI
// cannot (aggressive anti-bot). Used to warn users and to route correctly.
export const HARD_BOARDS = ['linkedin', 'indeed', 'ziprecruiter', 'glassdoor', 'bayt', 'naukri'];

// Boards Firecrawl/Crawl4AI handle well (rendered but lightly protected).
export const MEDIUM_BOARDS = [
  'ycombinator', 'wellfound', 'instahyre', 'sprout', 'googlesearch',
];

export interface ScrapeRequest {
  provider: string; // board name: linkedin, indeed, ycombinator, ...
  query: string;
  location?: string;
  resultsWanted?: number;
  userId?: string;
}

// ---------------------------------------------------------------------------
// Backend 1 + 2: Firecrawl / Crawl4AI (generic JSON-mode scrape)
// ---------------------------------------------------------------------------

interface ScrapingKey {
  apiKey: string;
  // For self-hosted Firecrawl/Crawl4AI the base URL is stored in `label`.
  baseUrl?: string;
}

async function getScrapingKey(provider: 'firecrawl' | 'crawl4ai', userId?: string): Promise<ScrapingKey> {
  const key = await leaseNextKey(provider, userId);
  // base URL for self-hosted stored in label (e.g. http://localhost:3002/v2)
  const baseUrl = key.source === 'database'
    ? (await prisma.aIProviderKey.findUnique({ where: { id: key.id } }))?.label || undefined
    : process.env[`${provider.toUpperCase()}_URL`] || undefined;
  return { apiKey: key.apiKey, baseUrl };
}

// Firecrawl/Crawl4AI JSON-mode extraction: ask the model to pull job fields
// from the board's search results page. We point at the board's public search
// URL and let the backend render + extract.
function boardSearchUrl(provider: string, query: string, location?: string): string {
  const q = encodeURIComponent(query);
  const l = encodeURIComponent(location || '');
  switch (provider) {
    case 'ycombinator':
      return `https://www.ycombinator.com/jobs?query=${q}`;
    case 'wellfound':
      return `https://wellfound.com/role/r?q=${q}`;
    case 'instahyre':
      return `https://instahyre.com/jobs/${q}`;
    case 'sprout':
      return `https://sprout.hr/jobs?q=${q}`;
    case 'googlesearch':
      return `https://www.google.com/search?q=${q}+${l}+jobs`;
    default:
      return `https://www.google.com/search?q=${q}+${l}+jobs`;
  }
}

async function scrapeViaFirecrawlLike(
  provider: 'firecrawl' | 'crawl4ai',
  req: ScrapeRequest,
): Promise<ScrapedJob[]> {
  const { apiKey, baseUrl } = await getScrapingKey(provider, req.userId);
  const host = (baseUrl || (provider === 'firecrawl'
    ? 'https://api.firecrawl.dev/v2'
    : 'http://localhost:3002/v2')).replace(/\/$/, '');
  const target = boardSearchUrl(req.provider, req.query, req.location);

  const body = {
    url: target,
    formats: ['json'],
    jsonOptions: {
      schema: {
        type: 'object',
        properties: {
          jobs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                company: { type: 'string' },
                location: { type: 'string' },
                applyUrl: { type: 'string' },
                postedAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  const resp = await fetch(`${host}/scrape`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${provider} scrape failed: ${resp.status}`);
  const data: any = await resp.json();
  const jobs = data?.data?.jobs || [];
  return (jobs as any[]).map((j) => ({
    externalId: String(j.applyUrl || j.title),
    source: req.provider,
    sourceUrl: j.applyUrl,
    title: j.title || 'Untitled Role',
    company: j.company || 'Unknown',
    location: j.location,
    description: '',
    applyUrl: j.applyUrl,
    postedAt: j.postedAt ? new Date(j.postedAt) : undefined,
    backend: provider,
  }));
}

// ---------------------------------------------------------------------------
// Backend 3: RapidAPI (JSearch aggregate + PullAPI LinkedIn/Indeed)
// ---------------------------------------------------------------------------

interface RapidApiKey {
  apiKey: string;
}

async function getRapidApiKey(userId?: string): Promise<RapidApiKey> {
  const key = await leaseNextKey('rapidapi', userId);
  return { apiKey: key.apiKey };
}

const RAPIDAPI_HOSTS = {
  jsearch: 'jsearch.p.rapidapi.com',
  pullLinkedin: 'linkedin-scraper-api6.p.rapidapi.com',
  pullIndeed: 'indeed-scraper-api2.p.rapidapi.com',
  // JSearch alternatives (drop-in, same RapidAPI key) for quota/redundancy:
  pat92Jobs: 'jobs-api12.p.rapidapi.com',          // Pat92 "Jobs API" - LinkedIn/Bing/Xing
  fantasticLinkedin: 'fantastic-jobs-linkedin-job-search-api.p.rapidapi.com',
};

async function rapidGet(host: string, path: string, params: Record<string, string>, apiKey: string): Promise<any> {
  const url = new URL(`https://${host}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host },
  });
  if (!resp.ok) throw new Error(`RapidAPI ${host} failed: ${resp.status}`);
  return resp.json();
}

function normalizeJSearch(item: any): ScrapedJob | null {
  const apply = item.apply_url || item.applyOptions?.[0]?.link || item.job_google_link;
  if (!apply) return null;
  return {
    externalId: String(item.job_id || apply),
    source: (item.source?.toLowerCase?.() || 'rapidapi'),
    sourceUrl: apply,
    title: item.title || 'Untitled Role',
    company: item.company_name || item.employer_name || 'Unknown',
    location: item.location || item.job_city,
    description: item.description || '',
    applyUrl: apply,
    postedAt: item.posted_at ? new Date(item.posted_at) : undefined,
    backend: 'rapidapi',
  };
}

function normalizePull(job: any, board: string): ScrapedJob | null {
  const apply = job.job_url || job.url;
  if (!apply) return null;
  return {
    externalId: String(apply),
    source: board,
    sourceUrl: apply,
    title: job.title || 'Untitled Role',
    company: job.company || 'Unknown',
    location: job.location,
    description: job.description || '',
    applyUrl: apply,
    postedAt: job.posted_date ? new Date(job.posted_date) : undefined,
    backend: 'rapidapi',
  };
}

// Generic normalizer for JSearch alternatives (Pat92/Fantastic) whose schemas
// vary. Pulls the most common field names; returns null if no apply URL.
function normalizeGenericJob(job: any): ScrapedJob | null {
  const apply = job.url || job.apply_url || job.job_url || job.link;
  if (!apply) return null;
  return {
    externalId: String(job.id || apply),
    source: (job.source || 'rapidapi').toLowerCase(),
    sourceUrl: apply,
    title: job.title || 'Untitled Role',
    company: job.company || job.company_name || 'Unknown',
    location: job.location || job.location_name,
    description: job.description || job.snippet || '',
    applyUrl: apply,
    postedAt: job.posted_at || job.date ? new Date(job.posted_at || job.date) : undefined,
    backend: 'rapidapi',
  };
}

async function scrapeViaRapidApi(req: ScrapeRequest): Promise<ScrapedJob[]> {
  const { apiKey } = await getRapidApiKey(req.userId);
  const collected: ScrapedJob[] = [];
  const seen = new Set<string>();

  const push = (j: ScrapedJob | null) => {
    if (!j) return;
    const key = (j.applyUrl || j.externalId || '').toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    collected.push(j);
  };

  const limit = Math.min(req.resultsWanted ?? 25, 50);

  // 1) JSearch aggregates LinkedIn + Indeed + ZipRecruiter + Glassdoor + Bayt in
  //    one call. We filter results to the requested board when possible.
  try {
    const jsearch = await rapidGet(RAPIDAPI_HOSTS.jsearch, '/search', {
      query: req.query,
      page: '1',
      num_pages: '1',
      ...(req.location ? { location: req.location } : {}),
    }, apiKey);
    const items: any[] = jsearch.data || [];
    for (const it of items) {
      const j = normalizeJSearch(it);
      // If a specific board was requested, only keep matches for that board.
      if (req.provider !== 'rapidapi' && req.provider !== 'jsearch') {
        const src = (it.source || '').toLowerCase();
        if (src && src !== req.provider) continue;
      }
      push(j);
    }
  } catch (e) {
    // JSearch may be unavailable on the user's tier; fall through to PullAPI.
    console.warn('[scrapingBackend] JSearch failed, falling back to PullAPI:', (e as Error).message);
  }

  // 1b) Pat92 "Jobs API" alternative to JSearch (same RapidAPI key). Aggregates
  //     LinkedIn/Bing/Xing. Tolerant normalizer since schema varies by plan.
  try {
    const pat = await rapidGet(RAPIDAPI_HOSTS.pat92Jobs, '/v1/getJobData', {
      query: req.query,
      ...(req.location ? { location: req.location } : {}),
    }, apiKey);
    const patItems: any[] = pat.data?.jobs || pat.jobs || pat.data || (Array.isArray(pat) ? pat : []);
    for (const it of patItems) {
      const j = normalizeGenericJob(it);
      if (j) push(j);
    }
  } catch { /* ignore - optional alternative */ }

  // 2) PullAPI LinkedIn / Indeed for boards JSearch may have missed.
  if (req.provider === 'linkedin' || req.provider === 'rapidapi' || req.provider === 'jsearch') {
    try {
      const li = await rapidGet(RAPIDAPI_HOSTS.pullLinkedin, '/linkedin/jobs', {
        keywords: req.query,
        page: '1',
        ...(req.location ? { location: req.location } : {}),
      }, apiKey);
      for (const job of li?.data?.jobs || []) push(normalizePull(job, 'linkedin'));
    } catch { /* ignore */ }
  }
  if (req.provider === 'indeed' || req.provider === 'rapidapi' || req.provider === 'jsearch') {
    try {
      const iv = await rapidGet(RAPIDAPI_HOSTS.pullIndeed, '/indeed/search', {
        query: req.query,
        page: '1',
        ...(req.location ? { location: req.location } : {}),
      }, apiKey);
      for (const job of iv?.data?.jobs || []) push(normalizePull(job, 'indeed'));
    } catch { /* ignore */ }
  }

  return collected.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Scrape a single board using the user's configured scraping backend.
 * Resolution order:
 *   - Hard boards (linkedin/indeed/ziprecruiter/glassdoor/bayt/naukri) -> RapidAPI
 *   - Medium boards (ycombinator/wellfound/...) -> Firecrawl, else Crawl4AI, else RapidAPI
 * If no backend key is configured for the required type, throws a clear error
 * telling the user which key to add in Settings.
 */
export async function scrapeBoard(req: ScrapeRequest): Promise<ScrapedJob[]> {
  const isHard = HARD_BOARDS.includes(req.provider);

  if (isHard) {
    try {
      return await scrapeViaRapidApi(req);
    } catch (e) {
      throw new Error(
        `Hard board "${req.provider}" requires a RapidAPI key (covers LinkedIn/Indeed/ZipRecruiter/Glassdoor/Bayt via JSearch + PullAPI). ` +
        `Add one in Settings. Original error: ${(e as Error).message}`,
      );
    }
  }

  // Medium board: prefer Firecrawl, then Crawl4AI, then RapidAPI as fallback.
  for (const provider of ['firecrawl', 'crawl4ai'] as const) {
    try {
      return await scrapeViaFirecrawlLike(provider, req);
    } catch {
      // try next backend
    }
  }
  // Fallback: if user only has RapidAPI, route medium boards through Google search.
  try {
    return await scrapeViaRapidApi({ ...req, provider: 'googlesearch' });
  } catch (e) {
    throw new Error(
      `No scraping backend configured for "${req.provider}". Add a Firecrawl, Crawl4AI, or RapidAPI key in Settings. ` +
      `Firecrawl/Crawl4AI handle YC/Wellfound/Instahyre/Sprout/Google; RapidAPI also covers LinkedIn/Indeed.`,
    );
  }
}
