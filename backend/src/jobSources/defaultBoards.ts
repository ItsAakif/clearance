// Default job boards seeded per-user on signup (or lazily on first GET /boards).
// Combines curated ATS boards (from career-ops tracked_companies) + search queries.
// Users can edit/delete these at will.
//
// Token/URL catalog lives in ./boardCatalog.ts (prisma-free, importable by
// offline scripts). This module keeps the seeding behaviour + re-exports so
// existing imports keep working.

import prisma from '../lib/prisma.js';
import {
  DEFAULT_AGGREGATOR_BOARDS,
  DEFAULT_ATS_BOARDS,
  DEFAULT_ATS_BOARDS_EXTRA,
  DEFAULT_JSON_BOARDS,
  DEFAULT_SCRAPER_BOARDS,
  getDefaultBoards,
} from './boardCatalog.js';

export {
  DEFAULT_AGGREGATOR_BOARDS,
  DEFAULT_ATS_BOARDS,
  DEFAULT_ATS_BOARDS_EXTRA,
  DEFAULT_JSON_BOARDS,
  DEFAULT_SCRAPER_BOARDS,
  getDefaultBoards,
};

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
