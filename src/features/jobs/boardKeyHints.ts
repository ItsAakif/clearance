// Per-board API-key hints for the jobs UI.
//
// Frontend mirror of the backend key-routing constants. Backend source of
// truth:
//   - HARD_BOARDS in backend/src/jobSources/scrapingBackend.ts
//   - SUPPORTED_SCRAPER_PROVIDERS in backend/src/jobSources/index.ts
//   - AGGREGATOR_PROVIDERS in backend/src/jobSources/aggregators.ts
// Kept as data here (not imported from backend) so vite never bundles
// backend-only modules (prisma, keyManager). Values must match backend.

// Boards that third-party APIs (RapidAPI) can scrape but Firecrawl/Crawl4AI
// cannot (aggressive anti-bot). A missing key for these always means RapidAPI.
export const HARD_BOARDS = [
  'linkedin',
  'indeed',
  'ziprecruiter',
  'glassdoor',
  'bayt',
  'naukri',
] as const;

// Boards Firecrawl/Crawl4AI handle well; RapidAPI is a fallback for them.
export const MEDIUM_BOARDS = [
  'ycombinator',
  'wellfound',
  'instahyre',
  'sprout',
  'googlesearch',
] as const;

// Every `scraperProvider` value the backend accepts.
export const SUPPORTED_SCRAPER_PROVIDERS = [
  ...HARD_BOARDS,
  ...MEDIUM_BOARDS,
] as const;

function isHardScraperProvider(provider: string | null | undefined): boolean {
  const p = (provider ?? '').trim().toLowerCase();
  return !!p && (HARD_BOARDS as readonly string[]).includes(p);
}

// Hard scraperProvider -> RapidAPI only; any other scraper board ->
// Firecrawl, Crawl4AI, or RapidAPI (mirrors scrapeBoardInner resolution).
export function getScraperKeyHint(scraperProvider?: string | null): string {
  if (isHardScraperProvider(scraperProvider)) {
    return 'needs RapidAPI key in Settings';
  }
  return 'needs Firecrawl, Crawl4AI, or RapidAPI key in Settings';
}

// Aggregator boards name their own provider key (Adzuna/USAJobs/Reed/Findwork).
export function getAggregatorKeyHint(
  aggregatorProvider?: string | null,
  fallbackName?: string,
): string {
  const raw =
    (aggregatorProvider ?? '').trim() ||
    (fallbackName ?? '').split(/[\s(]/)[0]?.trim() ||
    '';
  const name = raw
    ? raw.charAt(0).toUpperCase() + raw.slice(1)
    : 'provider';
  return `needs ${name} key in Settings`;
}

// Mirror of backend isLikelyMissingKeyError
// (backend/src/jobSources/discoveryRuns.ts): distinguishes "no key
// configured" failures from real fetch failures so the UI only shows a key
// hint when the error actually names a missing key.
export function isLikelyMissingKeyError(message: string | null | undefined): boolean {
  if (!message) return false;
  return (
    /requires an? .*key/i.test(message) ||
    /no .*api keys? configured/i.test(message) ||
    /add .*in settings/i.test(message) ||
    /no scraping backend configured/i.test(message)
  );
}

export interface KeyHintBoard {
  type: string;
  name: string;
  scraperProvider?: string | null;
  aggregatorProvider?: string | null;
  error?: string | null;
}

// Specific key hint for a board whose error is a missing-key failure.
// Returns undefined when the error is not key-related (real failures keep
// their generic/failed rendering). BoardRow props are unchanged: progress
// snapshots carry no provider fields, so the scraper provider is read from
// the quoted board name in the backend error (e.g. Hard board "linkedin"
// requires a RapidAPI key...) with a name fallback against
// SUPPORTED_SCRAPER_PROVIDERS; aggregator providers lead their own errors
// (e.g. "Adzuna requires APP_ID and APP_KEY...").
export function getBoardKeyHint(board: KeyHintBoard): string | undefined {
  const error = board.error ?? '';
  if (!isLikelyMissingKeyError(error)) return undefined;
  if (board.type === 'scraper') {
    const quoted = error.match(/"([^"]+)"/)?.[1];
    const fromName = (SUPPORTED_SCRAPER_PROVIDERS as readonly string[]).includes(
      board.name.trim().toLowerCase(),
    )
      ? board.name.trim().toLowerCase()
      : undefined;
    return getScraperKeyHint(board.scraperProvider ?? quoted ?? fromName);
  }
  if (board.type === 'aggregator') {
    const leading = error.match(/^([A-Za-z]+)\s+requires/i)?.[1];
    return getAggregatorKeyHint(board.aggregatorProvider ?? leading, board.name);
  }
  return 'needs an API key in Settings';
}
