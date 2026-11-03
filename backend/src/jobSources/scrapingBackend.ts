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
import { htmlToText } from './htmlText.js';
import type { PostedAtSource } from '../discovery/provenance.js';

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
  // Wave 3 (T662, ADR-028): date provenance, set by each normalizer at the
  // point it reads its upstream date field. `postedAtRaw` is the verbatim
  // upstream string (audit-only). Passed through verbatim by fetchViaScraper.
  postedAtSource?: PostedAtSource;
  postedAtRaw?: string;
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
    // Wave 3 (T662, ADR-028): a date extracted from a scraped page is
    // page-derived (registry `scraper` descriptor).
    postedAtSource: j.postedAt ? ('page-derived' as const) : undefined,
    postedAtRaw: j.postedAt ?? undefined,
    backend: provider,
  }));
}

// ---------------------------------------------------------------------------
// Backend 3: RapidAPI (JSearch aggregate + PullAPI LinkedIn/Indeed)
// ---------------------------------------------------------------------------

interface RapidApiKey {
  apiKey: string;
}

// ---------------------------------------------------------------------------
// RapidAPI throttle state (module-level, per-process).
//
// A single POST /jobs/search fans out to one scrapeBoard() per board, and
// every board used to fire its own JSearch + PullAPI calls - so one
// search produced ~11x 429 then ~13x 404 lines and hammered the quota. Three
// guards calm the storm while preserving per-board catch(()=>[]) isolation:
//   - rapidResponseCache: identical upstream URLs served once per TTL.
//   - rapidInflight: concurrent duplicate upstream calls share one promise.
//   - rapidApiCooldownUntil: after any 429, skip RapidAPI upstreams for N min.
// Fallback console.warn lines are additionally deduped per signature + window
// so the log shows at most one fallback line per board per search.
// ---------------------------------------------------------------------------

/** Skip all RapidAPI upstreams this long after any 429 (rate-limit). */
export const RAPIDAPI_COOLDOWN_MS = 5 * 60 * 1000;
/** Serve identical RapidAPI upstream URLs from memory this long (per search). */
export const RAPIDAPI_RESPONSE_CACHE_TTL_MS = 60 * 1000;
/** Dedupe identical fallback warn lines within this window. */
export const RAPIDAPI_FALLBACK_LOG_WINDOW_MS = 5 * 60 * 1000;

let rapidApiCooldownUntil = 0;
const rapidResponseCache = new Map<string, { at: number; data: unknown }>();
const rapidInflight = new Map<string, Promise<unknown>>();
const fallbackLogLast = new Map<string, number>();
const scrapeInflight = new Map<string, Promise<ScrapedJob[]>>();

/** Terminally-failed RapidAPI hosts (host -> bounded disable reason). */
const rapidHostDisabled = new Map<string, string>();

export type RapidStatusClass = 'terminal' | 'rate_limited' | 'transient';

/**
 * Classify a RapidAPI upstream HTTP status.
 * 403/404 = terminal (key not subscribed to that API - no retry);
 * 429 = rate-limited (global cooldown); everything else = transient.
 */
export function classifyRapidStatus(status: number): RapidStatusClass {
  if (status === 403 || status === 404) return 'terminal';
  if (status === 429) return 'rate_limited';
  return 'transient';
}

/** Test hook: bounded disable reason for a terminally-disabled host, if any. */
export function isRapidHostDisabled(host: string): string | undefined {
  return rapidHostDisabled.get(host);
}

/** Extract a bounded, log-safe reason from an upstream error body. */
function boundedRapidReason(body: string): string {
  let reason = body;
  try {
    const parsed: unknown = JSON.parse(body);
    const msg = (parsed as Record<string, unknown>)?.['message'];
    if (typeof msg === 'string' && msg.trim()) reason = msg;
    else reason = body.slice(0, 200);
  } catch {
    reason = body.slice(0, 200);
  }
  // Strip control chars and cap length; never carries headers or key material
  // because callers only pass the response body here.
  return reason.replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, 300);
}

function warnOncePerWindow(signature: string, message: string): void {
  const now = Date.now();
  const last = fallbackLogLast.get(signature) ?? 0;
  if (now - last < RAPIDAPI_FALLBACK_LOG_WINDOW_MS) return;
  fallbackLogLast.set(signature, now);
  console.warn(message);
}

/** Clears RapidAPI throttle state (cooldown, caches, in-flight, host-disable). For tests. */
export function resetRapidApiThrottle(): void {
  rapidApiCooldownUntil = 0;
  rapidResponseCache.clear();
  rapidInflight.clear();
  fallbackLogLast.clear();
  scrapeInflight.clear();
  rapidHostDisabled.clear();
}

/** Test hook: is the 429 cooldown currently active? */
export function isRapidApiCoolingDown(): boolean {
  return Date.now() < rapidApiCooldownUntil;
}

async function getRapidApiKey(userId?: string): Promise<RapidApiKey> {
  const key = await leaseNextKey('rapidapi', userId);
  return { apiKey: key.apiKey };
}

export const RAPIDAPI_HOSTS = {
  // Fork-host guidance (ADR-016): confirm the X-RapidAPI-Host shown in the
  // listing's Code Snippet/Playground. Canonical JSearch is
  // jsearch.p.rapidapi.com (current path /search-v2). A different *jsearch*
  // host (sibling jsearch-mega or a third-party fork) needs that host and
  // that host's paths - a mismatch yields 403 (not subscribed) or 404
  // (endpoint does not exist for that host/version), surfaced via ADR-010.
  jsearch: 'jsearch.p.rapidapi.com',
  pullLinkedin: 'linkedin-scraper-api6.p.rapidapi.com',
  pullIndeed: 'indeed-scraper-api2.p.rapidapi.com',
  // Pat92 legacy Jobs API listing removed (ADR-017); no live replacement wired
  // pending a keyed probe. Do not re-add without a 200 probe (see T322).
  // Verified-but-unavailable third-party host kept for reference (ADR-010).
  // Currently no call site uses it.
  fantasticLinkedin: 'fantastic-jobs-linkedin-job-search-api.p.rapidapi.com',
} as const;

// Canonical upstream paths per RapidAPI host. scrapeViaRapidApi must read
// paths from here (no inline literals) so upstream drift is testable.
export const RAPIDAPI_PATHS = {
  jsearch: '/search-v2',
  pullLinkedin: '/linkedin/jobs',
  pullIndeed: '/indeed/search',
} as const;

async function rapidGet(host: string, path: string, params: Record<string, string>, apiKey: string): Promise<any> {
  // Guard order: 429 cooldown first, then per-host terminal disable. Both
  // throw without a request; cooldown is global, disable is per host.
  if (Date.now() < rapidApiCooldownUntil) {
    throw new Error(`RapidAPI ${host} skipped: rate-limited (429) cooldown active`);
  }
  const disabledReason = rapidHostDisabled.get(host);
  if (disabledReason !== undefined) {
    throw new Error(`RapidAPI ${host} disabled: ${disabledReason}`);
  }
  const url = new URL(`https://${host}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Response cache + in-flight dedupe: identical upstream URLs (same query +
  // location across boards of one search) are fetched ONCE per TTL window.
  // This caps JSearch to one call per search (not one per board) and likewise
  // caps each PullAPI fallback to once per search. Failures are never cached.
  // Error strings carry host + status only - never key material.
  const cacheKey = url.toString();
  const cached = rapidResponseCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RAPIDAPI_RESPONSE_CACHE_TTL_MS) {
    return cached.data;
  }
  const inflight = rapidInflight.get(cacheKey);
  if (inflight) return inflight;
  const pending = (async () => {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': host },
    });
    if (!resp.ok) {
      const kind = classifyRapidStatus(resp.status);
      const rawBody = typeof (resp as any).text === 'function'
        ? await (resp as any).text().catch(() => '')
        : '';
      const reason = rawBody ? boundedRapidReason(String(rawBody)) : '';
      const withReason = (base: string) => (reason ? `${base} (${reason})` : base);
      if (kind === 'terminal') {
        const disableReason = reason || `HTTP ${resp.status}`;
        rapidHostDisabled.set(host, disableReason);
        warnOncePerWindow(
          `rapidapi-terminal:${host}`,
          `[scrapingBackend] RapidAPI host ${host} disabled: ${disableReason}`,
        );
        throw new Error(withReason(`RapidAPI ${host} failed: ${resp.status}`));
      }
      if (kind === 'rate_limited') {
        if (Date.now() >= rapidApiCooldownUntil) {
          rapidApiCooldownUntil = Date.now() + RAPIDAPI_COOLDOWN_MS;
          warnOncePerWindow(
            'rapidapi-429-cooldown',
            `[scrapingBackend] RapidAPI rate-limited (429); skipping RapidAPI boards for ${RAPIDAPI_COOLDOWN_MS / 60000} minutes.`,
          );
        }
        throw new Error(withReason(`RapidAPI ${host} failed: ${resp.status}`));
      }
      throw new Error(withReason(`RapidAPI ${host} failed: ${resp.status}`));
    }
    const data = await resp.json();
    rapidResponseCache.set(cacheKey, { at: Date.now(), data });
    return data;
  })();
  rapidInflight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    if (rapidInflight.get(cacheKey) === pending) rapidInflight.delete(cacheKey);
  }
}

function normalizeJSearch(item: any): ScrapedJob | null {
  // Guard: envelope extractors guarantee objects, but be tolerant of null /
  // primitives so a malformed row can never throw inside the loop.
  if (!item || typeof item !== 'object') return null;
  // Documented /search-v2 shape (ADR-016): job_title, job_description,
  // job_apply_link (+ apply_options fallback), employer_name, job_id.
  // Legacy fallbacks kept so older fixtures/rows still normalize.
  const apply = item.job_apply_link || item.apply_options?.[0]?.apply_link || item.apply_url || item.applyOptions?.[0]?.link || item.job_google_link;
  if (!apply) return null;
  const cityStateCountry = [item.job_city, item.job_state, item.job_country].filter(Boolean).join(', ');
  // Wave 3 (T662, ADR-028): JSearch `job_posted_at_datetime_utc` is an
  // explicit posted claim -> `source-posted`.
  const postedRaw = item.job_posted_at_datetime_utc ?? item.posted_at;
  return {
    externalId: String(item.job_id || apply),
    source: (item.source?.toLowerCase?.() || 'rapidapi'),
    sourceUrl: apply,
    title: item.job_title || item.title || 'Untitled Role',
    company: item.employer_name || item.company_name || 'Unknown',
    location: item.job_location || cityStateCountry || item.location,
    description: htmlToText(item.job_description || item.description || ''),
    applyUrl: apply,
    postedAt: postedRaw ? new Date(postedRaw) : undefined,
    postedAtSource: postedRaw ? ('source-posted' as const) : undefined,
    postedAtRaw: postedRaw ?? undefined,
    backend: 'rapidapi',
  };
}

/**
 * Extract job rows from a JSearch /search-v2 response envelope.
 *
 * Documented shape (ADR-016) is `{ data: [...] }`, but live v2 responses
 * have been observed with `data` as a non-array (object envelope with cursor
 * pagination, e.g. `{ data: { jobs: [...], cursor: ... } }` or nested
 * `{ data: { data: [...] } }`). Iterating such an object with `for..of`
 * throws "items is not iterable", which broke the JSearch -> PullAPI fallback
 * and emptied results. This extractor tolerates:
 *   - a bare array (top-level rows)
 *   - `{ data: [...] }` (documented)
 *   - `{ data: { data|jobs|results|items: [...] } }` (object/cursor envelopes)
 *   - `{ jobs|results|items: [...] }` (top-level alternates)
 * Anything else (null, primitives, unknown objects) yields [] - never throws.
 */
export function extractJSearchItems(jsearch: unknown): unknown[] {
  if (!jsearch) return [];
  if (Array.isArray(jsearch)) return jsearch;
  if (typeof jsearch !== 'object') return [];
  const root = jsearch as Record<string, unknown>;
  if (Array.isArray(root['data'])) return root['data'] as unknown[];
  const data = root['data'];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    for (const key of ['data', 'jobs', 'results', 'items']) {
      if (Array.isArray(nested[key])) return nested[key] as unknown[];
    }
    return [];
  }
  for (const key of ['jobs', 'results', 'items']) {
    if (Array.isArray(root[key])) return root[key] as unknown[];
  }
  return [];
}

export function normalizePullIndeed(job: any): ScrapedJob | null {
  if (!job || typeof job !== 'object') return null;
  const jobKey = job.job_key || job.jobKey;
  const apply = job.job_url || job.url ||
    (jobKey ? `https://www.indeed.com/viewjob?jk=${encodeURIComponent(String(jobKey))}` : undefined);
  if (!apply) return null;
  const snippet = Array.isArray(job.snippet) ? job.snippet.join('\n') : (job.snippet || '');
  return {
    externalId: jobKey ? `indeed:${jobKey}` : String(apply),
    source: 'indeed',
    sourceUrl: apply,
    title: job.title || 'Untitled Role',
    company: job.company || 'Unknown',
    location: job.location,
    description: htmlToText(job.description || snippet || ''),
    applyUrl: apply,
    // Wave 3 (T662, ADR-028): Indeed-synthesised rows carry no upstream date
    // (verified: `postedAt` was already unconditionally undefined here) ->
    // `discovery-at` with a null date.
    postedAt: undefined,
    postedAtSource: 'discovery-at',
    backend: 'rapidapi',
  };
}

function normalizePull(job: any, board: string): ScrapedJob | null {
  if (!job || typeof job !== 'object') return null;
  const apply = job.job_url || job.url;
  if (!apply) return null;
  return {
    externalId: String(apply),
    source: board,
    sourceUrl: apply,
    title: job.title || 'Untitled Role',
    company: job.company || 'Unknown',
    location: job.location,
    description: htmlToText(job.description || ''),
    applyUrl: apply,
    postedAt: job.posted_date ? new Date(job.posted_date) : undefined,
    // Wave 3 (T662, ADR-028): PullAPI `posted_date` is an explicit posted
    // claim -> `source-posted`.
    postedAtSource: job.posted_date ? ('source-posted' as const) : undefined,
    postedAtRaw: job.posted_date ?? undefined,
    backend: 'rapidapi',
  };
}

// Generic normalizer for JSearch alternatives (Pat92/Fantastic) whose schemas
// vary. Pulls the most common field names; returns null if no apply URL.
function normalizeGenericJob(job: any): ScrapedJob | null {
  const apply = job.url || job.apply_url || job.job_url || job.link;
  if (!apply) return null;
  // Wave 3 (T662, ADR-028): `posted_at`/`date` are posted-shaped claims ->
  // `source-posted`. (Currently no call sites; kept consistent so a future
  // caller cannot emit a dateless-claim row.)
  const postedRaw = job.posted_at || job.date;
  return {
    externalId: String(job.id || apply),
    source: (job.source || 'rapidapi').toLowerCase(),
    sourceUrl: apply,
    title: job.title || 'Untitled Role',
    company: job.company || job.company_name || 'Unknown',
    location: job.location || job.location_name,
    description: htmlToText(job.description || job.snippet || ''),
    applyUrl: apply,
    postedAt: postedRaw ? new Date(postedRaw) : undefined,
    postedAtSource: postedRaw ? ('source-posted' as const) : undefined,
    postedAtRaw: postedRaw ?? undefined,
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

  // D1: track per-upstream outcomes. A single upstream succeeding (even with
  // zero rows) means "no jobs"; EVERY attempted upstream throwing means the
  // key/subscription is broken and must surface via health, not as healthy/0.
  // Error strings carry host + status only - never key material.
  let attempted = 0;
  let succeeded = 0;
  const failures: string[] = [];

  // 1) JSearch aggregates LinkedIn + Indeed + ZipRecruiter + Glassdoor + Bayt in
  //    one call. We filter results to the requested board when possible.
  attempted += 1;
  try {
    const jsearch = await rapidGet(RAPIDAPI_HOSTS.jsearch, RAPIDAPI_PATHS.jsearch, {
      // /search-v2 surface (ADR-016): no `page` or standalone `location`;
      // location is folded into the free-form query. No cursor pagination
      // (each page is a credit; free tier is ~200/mo).
      query: req.location ? `${req.query} in ${req.location}` : req.query,
      num_pages: '1',
      date_posted: 'month',
    }, apiKey);
    succeeded += 1;
    for (const it of extractJSearchItems(jsearch)) {
      const j = normalizeJSearch(it);
      // If a specific board was requested, only keep matches for that board.
      if (req.provider !== 'rapidapi' && req.provider !== 'jsearch') {
        const rawSrc: unknown = (it as Record<string, unknown> | null | undefined)?.['source'];
        const src = typeof rawSrc === 'string' ? rawSrc.toLowerCase() : '';
        if (src && src !== req.provider) continue;
      }
      push(j);
    }
  } catch (e) {
    // JSearch may be unavailable on the user's tier; fall through to PullAPI.
    // Logged at most once per board per window so one search cannot spam N lines.
    failures.push(`JSearch: ${(e as Error).message}`);
    warnOncePerWindow(
      `jsearch-fallback:${req.provider}`,
      `[scrapingBackend] JSearch failed, falling back to PullAPI: ${(e as Error).message}`,
    );
  }

  // PullAPI LinkedIn / Indeed for boards JSearch may have missed.
  if (req.provider === 'linkedin' || req.provider === 'rapidapi' || req.provider === 'jsearch') {
    attempted += 1;
    try {
      const li = await rapidGet(RAPIDAPI_HOSTS.pullLinkedin, RAPIDAPI_PATHS.pullLinkedin, {
        keywords: req.query,
        page: '1',
        ...(req.location ? { location: req.location } : {}),
      }, apiKey);
      succeeded += 1;
      const liJobs: unknown[] = Array.isArray((li as any)?.data?.jobs) ? (li as any).data.jobs : [];
      for (const job of liJobs) push(normalizePull(job, 'linkedin'));
    } catch (e) {
      failures.push(`PullAPI LinkedIn: ${(e as Error).message}`);
    }
  }
  if (req.provider === 'indeed' || req.provider === 'rapidapi' || req.provider === 'jsearch') {
    attempted += 1;
    try {
      const iv = await rapidGet(RAPIDAPI_HOSTS.pullIndeed, RAPIDAPI_PATHS.pullIndeed, {
        query: req.query,
        page: '1',
        ...(req.location ? { location: req.location } : {}),
      }, apiKey);
      succeeded += 1;
      const ivJobs: unknown[] = Array.isArray((iv as any)?.data?.jobs) ? (iv as any).data.jobs : [];
      for (const job of ivJobs) push(normalizePullIndeed(job));
    } catch (e) {
      failures.push(`PullAPI Indeed: ${(e as Error).message}`);
    }
  }

  if (collected.length === 0 && attempted > 0 && succeeded === 0) {
    throw new Error(`RapidAPI all upstreams failed (${failures.join('; ')})`);
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
 *
 * Concurrent duplicate scrapes (same board + query + location, as fanned out
 * by one search across boards) share a single in-flight promise instead of
 * firing duplicate upstream calls.
 */
export async function scrapeBoard(req: ScrapeRequest): Promise<ScrapedJob[]> {
  const key = `${req.provider}|${req.query}|${req.location ?? ''}|${req.resultsWanted ?? ''}`;
  const existing = scrapeInflight.get(key);
  if (existing) return existing;
  const pending = scrapeBoardInner(req);
  scrapeInflight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (scrapeInflight.get(key) === pending) scrapeInflight.delete(key);
  }
}

async function scrapeBoardInner(req: ScrapeRequest): Promise<ScrapedJob[]> {
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
