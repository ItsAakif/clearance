// Job Board configuration routes (per-user). Replaces hardcoded DEFAULT_SOURCES.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { validateInput } from '../shared/validation.js';
import { seedDefaultBoardsForUser } from '../jobSources/defaultBoards.js';
// Board-type and provider data come from the provider registry (Wave 1,
// ADR-025) - the single source of truth. SUPPORTED_SCRAPER_PROVIDERS and
// AGGREGATOR_PROVIDERS are re-exported by the registry (their canonical
// homes, adapters/scraper.ts and aggregators.ts, keep their exports for
// existing importers); the isDeprecated/is predicates stay imported from
// aggregators.ts.
import {
  PROVIDERS,
  getProvider,
  SUPPORTED_SCRAPER_PROVIDERS,
  AGGREGATOR_PROVIDERS,
} from '../jobSources/providerRegistry.js';
import { isDeprecatedAggregatorProvider, isAggregatorProvider } from '../jobSources/aggregators.js';
import type { JobSourceConfig } from '../jobSources/index.js';

// Board types derived from the registry (PROVIDERS declaration order). The
// tuple cast is narrowing-only: the registry declares all 14 types (pinned
// by providerRegistry.test.ts and boards.validation.test.ts), and the
// JobSourceConfig['type'] union keeps the public schema type exact.
const boardTypeValues = PROVIDERS.map((p) => p.type);
if (boardTypeValues.length === 0) {
  throw new Error('Provider registry must declare at least one board type');
}
export const BOARD_TYPE_VALUES = boardTypeValues as unknown as [
  JobSourceConfig['type'],
  ...JobSourceConfig['type'][],
];

const createSchema = z.object({
  type: z.enum(BOARD_TYPE_VALUES),
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
//
// Registry-driven (Wave 1, ADR-025): the gating knowledge - which config
// field each board family needs, and which backend it scrapes via - comes
// from the provider descriptor's kind/requires, not from a per-type
// if-ladder. The reason sentences are UI copy preserved verbatim from the
// pre-registry version (pinned by boards.validation.test.ts); only their
// selection is descriptor-driven.
export function explainScrapability(input: {
  type: string;
  feedUrl?: string | null;
  boardId?: string | null;
  searchQuery?: string | null;
  scraperProvider?: string | null;
  aggregatorProvider?: string | null;
}): { scrapable: boolean; via: string; reason: string } {
  const descriptor = getProvider(input.type);
  if (!descriptor) {
    return { scrapable: false, via: 'unsupported', reason: `Unknown board type "${input.type}".` };
  }
  switch (descriptor.kind) {
    case 'api': {
      // ATS descriptors require a company token ('board'); the keyless API
      // descriptors (jobicy, hnalgolia) require nothing and always scrape.
      if (descriptor.requires.includes('board')) {
        return input.boardId
          ? { scrapable: true, via: 'ats', reason: `Fetched from the public ${descriptor.type} API using the company token.` }
          : { scrapable: false, via: 'ats', reason: `Requires a boardId (company token) for the ${descriptor.type} API.` };
      }
      // Keyless boards need no config. Their UI sentences are bespoke, so
      // they are preserved per type, with the descriptor's own explain as
      // the fallback for future keyless descriptors.
      const keylessReason: Record<string, string> = {
        jobicy: 'Fetched from Jobicy’s keyless remote-jobs API.',
        hnalgolia: 'Fetched from the Hacker News (Algolia) jobs API - keyless.',
      };
      return {
        scrapable: true,
        via: 'aggregator',
        reason: keylessReason[descriptor.type] ?? descriptor.explain,
      };
    }
    case 'feed':
    case 'json': {
      // Feed/JSON descriptors require a feedUrl.
      if (!input.feedUrl) {
        return { scrapable: false, via: 'aggregator', reason: 'Requires a feedUrl.' };
      }
      if (descriptor.type === 'workday') {
        return { scrapable: true, via: 'aggregator', reason: 'Fetched from the Workday RSS/JSON feed URL.' };
      }
      return { scrapable: true, via: 'aggregator', reason: `Fetched from the provided ${descriptor.type} feed URL (keyless).` };
    }
    case 'search': {
      // Creation-time check: a search board needs a query to ever return
      // rows. (At run time an empty effective query is an intentional empty -
      // see the search descriptor's handler - but a board stored with no
      // query can never match, so the UI flags it here.)
      return input.searchQuery
        ? { scrapable: true, via: 'search', reason: 'Run as a web search via your Tavily/Exa key (or keyless fallback).' }
        : { scrapable: false, via: 'search', reason: 'Requires a searchQuery.' };
    }
    case 'scraper': {
      const { scraperProvider } = input;
      if (!scraperProvider) {
        return { scrapable: false, via: 'scraper', reason: `Requires a scraperProvider (one of: ${SUPPORTED_SCRAPER_PROVIDERS.join(', ')}).` };
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
    case 'aggregator': {
      const provider = input.aggregatorProvider;
      if (!provider) {
        return { scrapable: false, via: 'aggregator', reason: `Requires an aggregatorProvider (${AGGREGATOR_PROVIDERS.join(', ')}).` };
      }
      if (isDeprecatedAggregatorProvider(provider)) {
        return { scrapable: false, via: 'aggregator', reason: `Aggregator "${provider}" is no longer supported. Update or delete this board.` };
      }
      if (!isAggregatorProvider(provider)) {
        return { scrapable: false, via: 'aggregator', reason: `Unknown aggregator "${provider}". Supported: ${AGGREGATOR_PROVIDERS.join(', ')}.` };
      }
      return { scrapable: true, via: 'aggregator', reason: `Fetched from the ${provider} API using your BYOK key.` };
    }
    case 'browser': {
      // Wave 6 (T724, ADR-029): last-resort rendered-DOM reader, deep mode
      // only, ENHANCEMENT ONLY. Creation-time check mirrors the
      // descriptor's stored-config require (feedUrl); deepMode is a run
      // flag supplied by the deep-search caller, not stored board config.
      // Without the optional engine the tier reports skipped-with-reason,
      // never failed - so a configured board is still "scrapable".
      return input.feedUrl
        ? { scrapable: true, via: 'browser', reason: 'Last-resort rendered-DOM reader (deep mode only, after a cheaper tier failed for the same URL). Needs the optional browser engine; without it the tier reports skipped.' }
        : { scrapable: false, via: 'browser', reason: 'Requires a feedUrl (the company career page URL).' };
    }
    default: {
      // Unreachable: kind is a closed union and every case returns. Fails
      // closed so a future kind can never return undefined.
      return { scrapable: false, via: 'unsupported', reason: `Unknown board type "${input.type}".` };
    }
  }
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
    if (type === 'aggregator' && aggregatorProvider && !isAggregatorProvider(aggregatorProvider)) {
      return res.status(400).json({
        error: `Unsupported aggregatorProvider "${aggregatorProvider}". Supported: ${AGGREGATOR_PROVIDERS.join(', ')}.`,
      });
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
    if (
      aggregatorProvider &&
      aggregatorProvider !== board.aggregatorProvider &&
      !isAggregatorProvider(aggregatorProvider)
    ) {
      return res.status(400).json({
        error: `Unsupported aggregatorProvider "${aggregatorProvider}". Supported: ${AGGREGATOR_PROVIDERS.join(', ')}.`,
      });
    }
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
