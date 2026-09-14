// Job Board configuration routes (per-user). Replaces hardcoded DEFAULT_SOURCES.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { validateInput } from '../shared/validation.js';
import { seedDefaultBoardsForUser } from '../jobSources/defaultBoards.js';
import { SUPPORTED_SCRAPER_PROVIDERS } from '../jobSources/index.js';

const createSchema = z.object({
  type: z.enum([
    'greenhouse', 'ashby', 'lever', 'workday', 'rss', 'json', 'search',
    'smartrecruiters', 'recruitee', 'personio', 'jobicy', 'hnalgolia', 'scraper', 'aggregator',
  ]),
  name: z.string().min(1, 'Name required').max(100),
  boardId: z.string().max(200).optional(),
  feedUrl: z.string().url().optional().or(z.literal('')),
  searchQuery: z.string().max(500).optional(),
  searchSite: z.string().max(200).optional(),
  // scraper-type extras
  scraperProvider: z.string().max(50).optional(),
  scraperLocation: z.string().max(100).optional(),
  scraperResults: z.number().int().min(1).max(100).optional(),
  scraperUseProxy: z.boolean().optional(),
  // aggregator-type extras
  aggregatorProvider: z.string().max(50).optional(),
  aggregatorLocation: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
});
const updateSchema = createSchema.partial();

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    // Lazy-seed defaults for users with no boards yet
    await seedDefaultBoardsForUser(req.user!.id);
    const boards = await prisma.jobBoard.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, include: { sourceHealth: true } });
    res.json(boards);
  } catch (error) {
    handleApiError(error, res);
  }
});

// Explain, for any board config, whether Clearance can actually scrape it and why.
// This lets the UI tell a user up-front whether a board they add will work.
function explainScrapability(input: {
  type: string;
  feedUrl?: string | null;
  boardId?: string | null;
  searchQuery?: string | null;
  scraperProvider?: string | null;
  aggregatorProvider?: string | null;
}): { scrapable: boolean; via: string; reason: string } {
  const { type, feedUrl, boardId, searchQuery, scraperProvider } = input;

  const ats = ['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'recruitee', 'personio'];
  if (ats.includes(type)) {
    return boardId
      ? { scrapable: true, via: 'ats', reason: `Fetched from the public ${type} API using the company token.` }
      : { scrapable: false, via: 'ats', reason: `Requires a boardId (company token) for the ${type} API.` };
  }
  if (type === 'rss' || type === 'json') {
    return feedUrl
      ? { scrapable: true, via: 'aggregator', reason: `Fetched from the provided ${type} feed URL (keyless).` }
      : { scrapable: false, via: 'aggregator', reason: 'Requires a feedUrl.' };
  }
  if (type === 'workday') {
    return feedUrl
      ? { scrapable: true, via: 'aggregator', reason: 'Fetched from the Workday RSS/JSON feed URL.' }
      : { scrapable: false, via: 'aggregator', reason: 'Requires a feedUrl.' };
  }
  if (type === 'jobicy') {
    return { scrapable: true, via: 'aggregator', reason: 'Fetched from Jobicy’s keyless remote-jobs API.' };
  }
  if (type === 'hnalgolia') {
    return { scrapable: true, via: 'aggregator', reason: 'Fetched from the Hacker News (Algolia) jobs API - keyless.' };
  }
  if (type === 'search') {
    return searchQuery
      ? { scrapable: true, via: 'search', reason: 'Run as a web search via your Tavily/Exa key (or keyless fallback).' }
      : { scrapable: false, via: 'search', reason: 'Requires a searchQuery.' };
  }
  if (type === 'scraper') {
    if (!scraperProvider) {
      return { scrapable: false, via: 'scraper', reason: 'Requires a scraperProvider (e.g. indeed, naukri, foundit).' };
    }
    if ((SUPPORTED_SCRAPER_PROVIDERS as readonly string[]).includes(scraperProvider)) {
      return {
        scrapable: true,
        via: 'scraper',
        reason: `Scraped via your configured backend for "${scraperProvider}". Hard boards (LinkedIn/Indeed/ZipRecruiter/Glassdoor/Bayt) use RapidAPI; medium boards (YC/Wellfound/Instahyre/Sprout/Google) use Firecrawl/Crawl4AI.`,
      };
    }
    return {
      scrapable: false,
      via: 'scraper',
      reason: `"${scraperProvider}" is not a supported scraper. Supported: ${SUPPORTED_SCRAPER_PROVIDERS.join(', ')}.`,
    };
  }
  if (type === 'aggregator') {
    return scraperProvider || (input as { aggregatorProvider?: string | null }).aggregatorProvider
      ? { scrapable: true, via: 'aggregator', reason: 'Fetched from the aggregator API (Adzuna/Careerjet/Jooble) using your BYOK key.' }
      : { scrapable: false, via: 'aggregator', reason: 'Requires an aggregatorProvider (adzuna, careerjet, or jooble).' };
  }
  return { scrapable: false, via: 'unsupported', reason: `Unknown board type "${type}".` };
}

// Validate (without saving) whether a board config will scrape.
router.post('/validate', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(createSchema, req.body);
    res.json(explainScrapability(body));
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      type, name, boardId, feedUrl, searchQuery, searchSite,
      scraperProvider, scraperLocation, scraperResults, scraperUseProxy,
      aggregatorProvider, aggregatorLocation, isActive,
    } = validateInput(createSchema, req.body);
    if ((type === 'rss' || type === 'workday' || type === 'json') && !feedUrl) {
      return res.status(400).json({ error: 'feedUrl is required for rss/workday/json boards' });
    }
    if ((type === 'greenhouse' || type === 'ashby' || type === 'lever' || type === 'smartrecruiters' || type === 'recruitee' || type === 'personio') && !boardId) {
      return res.status(400).json({ error: 'boardId (company token) is required for ATS boards' });
    }
    if (type === 'search' && !searchQuery) {
      return res.status(400).json({ error: 'searchQuery is required for search boards' });
    }
    if (type === 'scraper' && !scraperProvider) {
      return res.status(400).json({ error: 'scraperProvider is required for scraper boards' });
    }
    if (type === 'scraper' && scraperProvider && !(SUPPORTED_SCRAPER_PROVIDERS as readonly string[]).includes(scraperProvider)) {
      return res.status(400).json({
        error: `Unsupported scraperProvider "${scraperProvider}". Supported: ${SUPPORTED_SCRAPER_PROVIDERS.join(', ')}.`,
      });
    }
    if (type === 'aggregator' && !aggregatorProvider) {
      return res.status(400).json({ error: 'aggregatorProvider is required for aggregator boards' });
    }
    const board = await prisma.jobBoard.create({
      data: {
        userId: req.user!.id,
        boardId: boardId || null,
        feedUrl: feedUrl || null,
        searchQuery: searchQuery || null,
        searchSite: searchSite || null,
        scraperProvider: scraperProvider || null,
        scraperLocation: scraperLocation || null,
        scraperResults: scraperResults ?? null,
        scraperUseProxy: scraperUseProxy ?? false,
        aggregatorProvider: aggregatorProvider || null,
        aggregatorLocation: aggregatorLocation || null,
        name,
        type,
        isActive: isActive ?? true,
      },
    });
    res.status(201).json(board);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.get('/:id/health', requireAuth, async (req: Request, res: Response) => {
  try {
    const board = await prisma.jobBoard.findUnique({
      where: { id: req.params.id },
      include: { sourceHealth: true },
    });
    if (!board) throw new NotFoundError('Job Board');
    if (board.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    res.json(board.sourceHealth ?? { status: 'unknown', consecutiveFailures: 0, lastResultCount: 0 });
  } catch (error) {
    handleApiError(error, res);
  }
});

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const {
      type, name, boardId, feedUrl, searchQuery, searchSite,
      scraperProvider, scraperLocation, scraperResults, scraperUseProxy,
      aggregatorProvider, aggregatorLocation, isActive,
    } = validateInput(updateSchema, req.body);
    const board = await prisma.jobBoard.findUnique({ where: { id: req.params.id } });
    if (!board) throw new NotFoundError('Job Board');
    if (board.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    const updated = await prisma.jobBoard.update({
      where: { id: board.id },
      data: {
        ...(type ? { type } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(boardId !== undefined ? { boardId: boardId || null } : {}),
        ...(feedUrl !== undefined ? { feedUrl: feedUrl || null } : {}),
        ...(searchQuery !== undefined ? { searchQuery: searchQuery || null } : {}),
        ...(searchSite !== undefined ? { searchSite: searchSite || null } : {}),
        ...(scraperProvider !== undefined ? { scraperProvider: scraperProvider || null } : {}),
        ...(scraperLocation !== undefined ? { scraperLocation: scraperLocation || null } : {}),
        ...(scraperResults !== undefined ? { scraperResults } : {}),
        ...(scraperUseProxy !== undefined ? { scraperUseProxy } : {}),
        ...(aggregatorProvider !== undefined ? { aggregatorProvider: aggregatorProvider || null } : {}),
        ...(aggregatorLocation !== undefined ? { aggregatorLocation: aggregatorLocation || null } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });
    res.json(updated);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const board = await prisma.jobBoard.findUnique({ where: { id: req.params.id } });
    if (!board) throw new NotFoundError('Job Board');
    if (board.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    await prisma.jobBoard.delete({ where: { id: board.id } });
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
