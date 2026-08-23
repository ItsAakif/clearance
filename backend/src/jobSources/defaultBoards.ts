// Default job boards seeded per-user on signup (or lazily on first GET /boards).
// Combines curated ATS boards (from career-ops tracked_companies) + search queries.
// Users can edit/delete these at will.

import prisma from '../lib/prisma.js';
import { DEFAULT_SEARCH_QUERIES, searchQueryToBoard } from './searchQueries.js';

// Curated ATS company boards (greenhouse/ashby/lever) - adapted from career-ops tracked_companies.
export const DEFAULT_ATS_BOARDS = [
  // ---- Greenhouse ----
  { type: 'greenhouse' as const, name: 'OpenAI (Greenhouse)', boardId: 'openai' },
  { type: 'greenhouse' as const, name: 'Anthropic (Greenhouse)', boardId: 'anthropic' },
  { type: 'greenhouse' as const, name: 'Stripe (Greenhouse)', boardId: 'stripe' },
  { type: 'greenhouse' as const, name: 'Datadog (Greenhouse)', boardId: 'datadog' },
  { type: 'greenhouse' as const, name: 'Figma (Greenhouse)', boardId: 'figma' },
  { type: 'greenhouse' as const, name: 'Notion (Greenhouse)', boardId: 'notion' },
  { type: 'greenhouse' as const, name: 'Ramp (Greenhouse)', boardId: 'ramp' },

  // ---- Ashby ----
  { type: 'ashby' as const, name: 'Perplexity (Ashby)', boardId: 'perplexity' },
  { type: 'ashby' as const, name: 'Cursor / Anysphere (Ashby)', boardId: 'anysphere' },
  { type: 'ashby' as const, name: 'ElevenLabs (Ashby)', boardId: 'elevenlabs' },
  { type: 'ashby' as const, name: 'Replit (Ashby)', boardId: 'replit' },
  { type: 'ashby' as const, name: 'Vercel (Ashby)', boardId: 'vercel' },
  { type: 'ashby' as const, name: 'Linear (Ashby)', boardId: 'linear' },
  { type: 'ashby' as const, name: 'Runway (Ashby)', boardId: 'runway' },
  { type: 'ashby' as const, name: 'Supabase (Ashby)', boardId: 'supabase' },

  // ---- Lever ----
  { type: 'lever' as const, name: 'Scale AI (Lever)', boardId: 'scale-ai' },
  { type: 'lever' as const, name: 'Ramp (Lever alt)', boardId: 'ramp' },
  { type: 'lever' as const, name: 'Tavus (Lever)', boardId: 'tavus' },
];

// Public, keyless JSON/RSS aggregator boards (no Tavily needed). Verified live.
export const DEFAULT_JSON_BOARDS = [
  { type: 'json' as const, name: 'RemoteOK', feedUrl: 'https://remoteok.com/api' },
  { type: 'json' as const, name: 'Remotive', feedUrl: 'https://remotive.com/api/remote-jobs' },
  { type: 'rss' as const, name: 'We Work Remotely', feedUrl: 'https://weworkremotely.com/remote-jobs.rss' },
  { type: 'json' as const, name: 'Arbeitnow (EU)', feedUrl: 'https://www.arbeitnow.com/api/job-board-api' },
  { type: 'json' as const, name: 'Jobicy (Remote)', feedUrl: 'https://jobicy.com/api/remote-jobs?count=50' },
  { type: 'rss' as const, name: 'Hacker News - Who is Hiring', feedUrl: 'https://hnrss.org/hiring' },
  { type: 'hnalgolia' as const, name: 'Hacker News - Ask HN Jobs (Algolia)' },
];

// Additional keyless ATS boards (company token based, public postings APIs).
export const DEFAULT_ATS_BOARDS_EXTRA = [
  { type: 'smartrecruiters' as const, name: 'Visa (SmartRecruiters)', boardId: 'visa' },
  { type: 'recruitee' as const, name: 'Typeform (Recruitee)', boardId: 'typeform' },
  { type: 'personio' as const, name: 'Personio (Personio)', boardId: 'personio' },
];

// Official job-aggregator APIs (BYOK, see aggregators.ts). Stable, free tiers,
// no anti-bot work. User supplies their own key (quota stays on them).
//   adzuna    - global, 2,500 req/mo free (requires APP_ID + APP_KEY)
//   careerjet - 90+ countries, free affiliate ID (needs attribution link)
//   jooble    - global, free API key via partner portal
export const DEFAULT_AGGREGATOR_BOARDS = [
  { type: 'aggregator' as const, name: 'Adzuna (Global)', aggregatorProvider: 'adzuna', aggregatorLocation: 'us' },
  { type: 'aggregator' as const, name: 'Careerjet (Global)', aggregatorProvider: 'careerjet', aggregatorLocation: '' },
  { type: 'aggregator' as const, name: 'Jooble (Global)', aggregatorProvider: 'jooble', aggregatorLocation: '' },
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
  { type: 'scraper' as const, name: 'Google Jobs', scraperProvider: 'google' },
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

/**
 * Seed default boards for a user if they have none yet.
 * Idempotent: only seeds when the user has 0 boards.
 */
export async function seedDefaultBoardsForUser(userId: string): Promise<void> {
  const count = await prisma.jobBoard.count({ where: { userId } });
  if (count > 0) return;

  const boards: Array<{
    userId: string;
    type: string;
    name: string;
    boardId: string | null;
    feedUrl: string | null;
    searchQuery: string | null;
    searchSite: string | null;
    scraperProvider: string | null;
    scraperLocation: string | null;
    scraperResults: number | null;
    scraperUseProxy: boolean;
    aggregatorProvider: string | null;
    aggregatorLocation: string | null;
    isActive: boolean;
  }> = getDefaultBoards().map((b) => {
    const board = b as Record<string, unknown>;
    return {
      userId,
      type: b.type,
      name: b.name,
      boardId: (board.boardId as string | undefined) ?? null,
      feedUrl: (board.feedUrl as string | undefined) ?? null,
      searchQuery: (board.searchQuery as string | undefined) ?? null,
      searchSite: (board.searchSite as string | undefined) ?? null,
      scraperProvider: (board.scraperProvider as string | undefined) ?? null,
      scraperLocation: (board.scraperLocation as string | undefined) ?? null,
      scraperResults: (board.scraperResults as number | undefined) ?? null,
      scraperUseProxy: (board.scraperUseProxy as boolean | undefined) ?? false,
      aggregatorProvider: (board.aggregatorProvider as string | undefined) ?? null,
      aggregatorLocation: (board.aggregatorLocation as string | undefined) ?? null,
      isActive: (board.isActive as boolean | undefined) ?? true,
    };
  });

  await prisma.jobBoard.createMany({ data: boards });
}
