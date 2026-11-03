// Prisma-free catalog of default job boards.
// Importable by offline scripts (e.g. scripts/probe-boards.ts) without
// constructing PrismaClient. defaultBoards.ts re-exports everything here.

import { DEFAULT_SEARCH_QUERIES, searchQueryToBoard } from './searchQueries.js';

// Curated ATS company boards (greenhouse/ashby/lever) - adapted from career-ops tracked_companies.
// Probe-verified 2026-09-18 (backend/scripts/probe-boards.ts): every token below
// returned 2xx with a non-error job count; dead tokens were replaced, not guessed.
export const DEFAULT_ATS_BOARDS = [
  // ---- Greenhouse ----
  { type: 'greenhouse' as const, name: 'Anthropic (Greenhouse)', boardId: 'anthropic' },
  { type: 'greenhouse' as const, name: 'Stripe (Greenhouse)', boardId: 'stripe' },
  { type: 'greenhouse' as const, name: 'Datadog (Greenhouse)', boardId: 'datadog' },
  { type: 'greenhouse' as const, name: 'Figma (Greenhouse)', boardId: 'figma' },
  { type: 'greenhouse' as const, name: 'Scale AI (Greenhouse)', boardId: 'scaleai' },

  // ---- Ashby ----
  { type: 'ashby' as const, name: 'OpenAI (Ashby)', boardId: 'openai' },
  { type: 'ashby' as const, name: 'Notion (Ashby)', boardId: 'notion' },
  { type: 'ashby' as const, name: 'Ramp (Ashby)', boardId: 'ramp' },
  { type: 'ashby' as const, name: 'Perplexity (Ashby)', boardId: 'perplexity' },
  { type: 'ashby' as const, name: 'Cursor (Ashby)', boardId: 'cursor' },
  { type: 'ashby' as const, name: 'ElevenLabs (Ashby)', boardId: 'elevenlabs' },
  { type: 'ashby' as const, name: 'Replit (Ashby)', boardId: 'replit' },
  { type: 'ashby' as const, name: 'Vercel (Ashby)', boardId: 'vercel' },
  { type: 'ashby' as const, name: 'Linear (Ashby)', boardId: 'linear' },
  { type: 'ashby' as const, name: 'Runway (Ashby)', boardId: 'runway' },
  { type: 'ashby' as const, name: 'Supabase (Ashby)', boardId: 'supabase' },
  { type: 'ashby' as const, name: 'Tavus (Ashby)', boardId: 'tavus' },

  // NOTE (probe 2026-09-18): Ramp resolved to a single Ashby board. Both the old
  // greenhouse:ramp and lever:ramp tokens 404, so both were removed; ashby:ramp
  // (200, 147 jobs) is the only Ramp entry.
];

// Public, keyless JSON/RSS aggregator boards (no Tavily needed). Verified live.
export const DEFAULT_JSON_BOARDS = [
  { type: 'json' as const, name: 'RemoteOK', feedUrl: 'https://remoteok.com/api' },
  { type: 'json' as const, name: 'Remotive', feedUrl: 'https://remotive.com/api/remote-jobs' },
  { type: 'rss' as const, name: 'We Work Remotely', feedUrl: 'https://weworkremotely.com/remote-jobs.rss' },
  { type: 'json' as const, name: 'Arbeitnow (EU)', feedUrl: 'https://www.arbeitnow.com/api/job-board-api' },
  { type: 'jobicy' as const, name: 'Jobicy (Remote)', feedUrl: 'https://jobicy.com/api/remote-jobs?count=50' },
  { type: 'rss' as const, name: 'Hacker News - Who is Hiring', feedUrl: 'https://hnrss.org/jobs' },
  { type: 'hnalgolia' as const, name: 'Hacker News - Ask HN Jobs (Algolia)' },
];

// Additional keyless ATS boards (company token based, public postings APIs).
export const DEFAULT_ATS_BOARDS_EXTRA = [
  { type: 'smartrecruiters' as const, name: 'Visa (SmartRecruiters)', boardId: 'visa' },
  { type: 'recruitee' as const, name: 'Typeform (Recruitee)', boardId: 'typeform' },
  { type: 'personio' as const, name: 'Personio (Personio)', boardId: 'personio' },
];

// Official job-aggregator APIs (BYOK, see aggregators.ts). Stable, free tiers, no anti-bot
// work, and a self-serve key the user obtains in minutes:
//   adzuna    - global, appId:appKey, free tier (quota contested: 1,000-2,500 req/mo)
//   usajobs   - US federal, "email:apiKey", fully free, no paid tier
//   reed      - UK, single key via Basic auth, 100 results/request
//   findwork  - dev/design (HN/RemoteOK/WWR/Dribbble), single token
// careerjet and jooble were retired (.planning/decisions/ADR-006) because their keys need
// publisher/partner approval. Existing user boards for them are deactivated, never deleted.
export const DEFAULT_AGGREGATOR_BOARDS = [
  { type: 'aggregator' as const, name: 'Adzuna (Global)', aggregatorProvider: 'adzuna', aggregatorLocation: 'us' },
  { type: 'aggregator' as const, name: 'USAJobs (US Federal)', aggregatorProvider: 'usajobs', aggregatorLocation: '' },
  { type: 'aggregator' as const, name: 'Reed (UK)', aggregatorProvider: 'reed', aggregatorLocation: '' },
  { type: 'aggregator' as const, name: 'Findwork (Dev & Design)', aggregatorProvider: 'findwork', aggregatorLocation: '' },
];

// Boards that require a user-supplied scraping backend (BYOK, see scrapingBackend.ts).
// Hard boards (aggressive anti-bot) are covered by RapidAPI (JSearch + PullAPI):
//   linkedin, indeed, glassdoor, ziprecruiter, bayt, naukri.
// A user adding ONLY a Firecrawl/Crawl4AI key will NOT get these - they need RapidAPI.
// Medium boards (rendered but lightly protected) work with Firecrawl/Crawl4AI:
//   wellfound, instahyre, sprout, googlesearch, ycombinator.
export const DEFAULT_SCRAPER_BOARDS = [
  { type: 'scraper' as const, name: 'LinkedIn', scraperProvider: 'linkedin' },
  { type: 'scraper' as const, name: 'Indeed', scraperProvider: 'indeed' },
  { type: 'scraper' as const, name: 'Glassdoor', scraperProvider: 'glassdoor' },
  { type: 'scraper' as const, name: 'Google Jobs', scraperProvider: 'googlesearch' },
  { type: 'scraper' as const, name: 'ZipRecruiter', scraperProvider: 'ziprecruiter' },
  { type: 'scraper' as const, name: 'Bayt (Middle East)', scraperProvider: 'bayt' },
  { type: 'scraper' as const, name: 'Naukri (India)', scraperProvider: 'naukri' },
  { type: 'scraper' as const, name: 'Wellfound (AngelList)', scraperProvider: 'wellfound' },
  { type: 'scraper' as const, name: 'Instahyre (India)', scraperProvider: 'instahyre' },
  { type: 'scraper' as const, name: 'Sprout (India)', scraperProvider: 'sprout' },
  { type: 'scraper' as const, name: 'Google Search (role + board)', scraperProvider: 'googlesearch' },
  { type: 'scraper' as const, name: 'Y Combinator Jobs', scraperProvider: 'ycombinator' },
];

// Build full default board list = ATS boards + JSON/RSS aggregators + scraper
// boards + official aggregator APIs + enabled search queries.
export function getDefaultBoards() {
  const aggregators = [...DEFAULT_JSON_BOARDS];
  const atsExtra = [...DEFAULT_ATS_BOARDS_EXTRA];
  const scrapers = [...DEFAULT_SCRAPER_BOARDS];
  const apiAggregators = [...DEFAULT_AGGREGATOR_BOARDS];
  const search = DEFAULT_SEARCH_QUERIES.filter((q) => q.enabled).map(searchQueryToBoard);
  return [...DEFAULT_ATS_BOARDS, ...atsExtra, ...aggregators, ...scrapers, ...apiAggregators, ...search];
}
