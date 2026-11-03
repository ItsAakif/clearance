// Scraper adapter - moved verbatim from `jobSources/index.ts` (Wave 1,
// T621). `JobSourceConfig` is imported as a type only (erased at runtime),
// so there is no runtime cycle back into `index.ts`.

import type { JobSourceConfig, RawJob } from '../index.js';

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
  const { scrapeBoard } = await import('../scrapingBackend.js');
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
    // Wave 3 (T662, ADR-028): provenance passes through untouched from the
    // scraping backend normalizers below.
    postedAtSource: j.postedAtSource,
    postedAtRaw: j.postedAtRaw,
  }));
}
