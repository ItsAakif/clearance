import { describe, it, expect, vi, beforeEach } from 'vitest';

// T410 (ADR-021 decisions 3 and 4): search-type boards honour the user query
// (request query wins, board searchQuery is the fallback, empty in both
// returns [] without hitting the provider), and scraper configs carry the
// location chip through to the scraping backend.
const { searchJobsMock, scrapeBoardMock } = vi.hoisted(() => ({
  searchJobsMock: vi.fn(),
  scrapeBoardMock: vi.fn(),
}));

vi.mock('./search.js', () => ({
  searchJobs: (...args: any[]) => searchJobsMock(...args),
}));

vi.mock('./scrapingBackend.js', () => ({
  scrapeBoard: (...args: any[]) => scrapeBoardMock(...args),
}));

import { runSource, boardToConfig } from './index.js';

describe('runSource search-type board query (T410)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchJobsMock.mockResolvedValue([]);
    scrapeBoardMock.mockResolvedValue([]);
  });

  it('uses the request query when present, not the curated board query', async () => {
    await runSource({
      type: 'search',
      query: 'react engineer',
      searchQuery: 'curated board query',
      searchSite: 'jobs.example.com',
      userId: 'user-1',
    });
    expect(searchJobsMock).toHaveBeenCalledTimes(1);
    expect(searchJobsMock).toHaveBeenCalledWith(
      { query: 'react engineer', site: 'jobs.example.com', maxResults: 10 },
      'user-1',
    );
  });

  it('falls back to the board searchQuery when no request query is present', async () => {
    await runSource({
      type: 'search',
      searchQuery: 'curated board query',
      userId: 'user-1',
    });
    expect(searchJobsMock).toHaveBeenCalledTimes(1);
    expect(searchJobsMock).toHaveBeenCalledWith(
      { query: 'curated board query', site: undefined, maxResults: 10 },
      'user-1',
    );
  });

  it('returns [] without calling the provider when both queries are empty', async () => {
    const result = await runSource({ type: 'search', query: '', userId: 'user-1' });
    expect(result).toEqual([]);
    expect(searchJobsMock).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only request query as absent and uses the fallback', async () => {
    await runSource({
      type: 'search',
      query: '   ',
      searchQuery: 'curated board query',
      userId: 'user-1',
    });
    expect(searchJobsMock).toHaveBeenCalledTimes(1);
    expect(searchJobsMock.mock.calls[0][0]).toMatchObject({ query: 'curated board query' });
  });
});

describe('scraper board location threading (T410)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchJobsMock.mockResolvedValue([]);
    scrapeBoardMock.mockResolvedValue([]);
  });

  it('boardToConfig keeps an explicit scraperLocation', () => {
    const config = boardToConfig({
      type: 'scraper',
      boardId: null,
      feedUrl: null,
      searchQuery: null,
      searchSite: null,
      scraperProvider: 'linkedin',
      scraperLocation: 'in:Bengaluru',
      scraperResults: null,
      scraperUseProxy: null,
      aggregatorProvider: null,
      aggregatorLocation: null,
    });
    expect(config.scraperLocation).toBe('in:Bengaluru');
  });

  it('boardToConfig maps a missing scraperLocation to undefined (route fills the chip)', () => {
    const config = boardToConfig({
      type: 'scraper',
      boardId: null,
      feedUrl: null,
      searchQuery: null,
      searchSite: null,
      scraperProvider: 'linkedin',
      scraperLocation: null,
      scraperResults: null,
      scraperUseProxy: null,
      aggregatorProvider: null,
      aggregatorLocation: null,
    });
    expect(config.scraperLocation).toBeUndefined();
  });

  it('runSource forwards the threaded scraperLocation to the scraping backend', async () => {
    // This is the config shape /jobs/search builds for a scraper board with
    // no explicit location once the first location chip is forwarded.
    await runSource({
      type: 'scraper',
      query: 'engineer',
      scraperProvider: 'linkedin',
      scraperLocation: 'Berlin, Germany',
      scraperResults: 25,
      userId: 'user-1',
    });
    expect(scrapeBoardMock).toHaveBeenCalledTimes(1);
    expect(scrapeBoardMock).toHaveBeenCalledWith({
      provider: 'linkedin',
      query: 'engineer',
      location: 'Berlin, Germany',
      resultsWanted: 25,
      userId: 'user-1',
    });
  });
});
