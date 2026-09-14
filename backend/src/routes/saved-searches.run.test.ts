import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock runSource but keep the real boardToConfig so config wiring is exercised.
const runSourceMock = vi.fn();
vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

const findUniqueSearchMock = vi.fn();
const findManyBoardsMock = vi.fn();
const upsertMock = vi.fn();
vi.mock('../lib/prisma.js', () => ({
  default: {
    savedSearch: { findUnique: (...args: any[]) => findUniqueSearchMock(...args) },
    jobBoard: { findMany: (...args: any[]) => findManyBoardsMock(...args) },
    jobListing: { upsert: (...args: any[]) => upsertMock(...args) },
  },
}));

import savedSearchesRouter from './saved-searches.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', savedSearchesRouter);
  return app;
}

const sharedJob = {
  source: 'greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  title: 'Senior Frontend Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'Build React apps.',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
};

const otherJob = {
  source: 'jobicy',
  sourceUrl: 'https://jobicy.com/jobs/999',
  title: 'Backend Engineer',
  company: 'Beta',
  location: 'Remote',
  description: 'Build APIs.',
  applyUrl: 'https://jobicy.com/jobs/999',
};

function boardRow(overrides: Record<string, any> = {}) {
  return {
    id: 'board-1',
    type: 'greenhouse',
    boardId: 'acme',
    feedUrl: null,
    searchQuery: null,
    searchSite: null,
    scraperProvider: null,
    scraperLocation: null,
    scraperResults: null,
    scraperUseProxy: false,
    aggregatorProvider: null,
    aggregatorLocation: null,
    ...overrides,
  };
}

describe('saved-search run route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueSearchMock.mockResolvedValue({ id: 'search-1', userId: 'user-1', query: 'frontend', sources: null });
    findManyBoardsMock.mockResolvedValue([
      boardRow({ id: 'board-1', type: 'greenhouse', boardId: 'acme' }),
      boardRow({ id: 'board-2', type: 'aggregator', boardId: null, aggregatorProvider: 'adzuna', aggregatorLocation: 'in:Bengaluru' }),
    ]);
    // Board 1 returns the shared job; board 2 returns the same job (dup) + a distinct one.
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.board === 'acme') return [{ ...sharedJob }];
      return [{ ...sharedJob }, { ...otherJob }];
    });
    upsertMock.mockImplementation(async ({ where, create }: any) => ({
      id: `id-${create.source}-${create.externalId}`,
      source: create.source,
      title: create.title,
      company: create.company,
      location: create.location,
      applyUrl: create.applyUrl,
      sourceUrl: create.sourceUrl,
      postedAt: null,
      isActive: true,
      _where: where,
    }));
  });

  it('(e) passes userId to every boardToConfig so keyed sources resolve BYOK keys', async () => {
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(runSourceMock).toHaveBeenCalledTimes(2);
    for (const call of runSourceMock.mock.calls) {
      expect(call[0]).toMatchObject({ userId: 'user-1', query: 'frontend' });
    }
    // Aggregator board keeps its provider/location alongside the userId.
    const aggCall = runSourceMock.mock.calls.find((c) => c[0].aggregatorProvider === 'adzuna');
    expect(aggCall).toBeTruthy();
    expect(aggCall![0]).toMatchObject({ userId: 'user-1', aggregatorLocation: 'in:Bengaluru' });
  });

  it('(a) dedupes the same job from two boards into one upsert', async () => {
    const res = await request(makeApp()).post('/search-1/run');
    expect(res.status).toBe(200);
    // 3 raw results (1 + 2 with one dup) -> 2 upserts.
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(res.body).toHaveLength(2);
  });

  it('(c) repeated runs upsert the same keys (update, not duplicates)', async () => {
    await request(makeApp()).post('/search-1/run');
    const firstWheres = upsertMock.mock.calls.map((c) => c[0].where);
    expect(firstWheres).toHaveLength(2);
    for (const w of firstWheres) {
      expect(w.source_externalId.externalId).toBeTruthy();
      expect(w.source_externalId.externalId).not.toMatch(/^manual-/);
    }

    vi.clearAllMocks();
    // Re-register defaults cleared by clearAllMocks.
    findUniqueSearchMock.mockResolvedValue({ id: 'search-1', userId: 'user-1', query: 'frontend', sources: null });
    findManyBoardsMock.mockResolvedValue([
      boardRow({ id: 'board-1', type: 'greenhouse', boardId: 'acme' }),
      boardRow({ id: 'board-2', type: 'aggregator', boardId: null, aggregatorProvider: 'adzuna', aggregatorLocation: 'in:Bengaluru' }),
    ]);
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.board === 'acme') return [{ ...sharedJob }];
      return [{ ...sharedJob }, { ...otherJob }];
    });
    upsertMock.mockImplementation(async ({ where, create }: any) => ({
      id: `id-${create.source}-${create.externalId}`,
      source: create.source,
      title: create.title,
      company: create.company,
      location: create.location,
      applyUrl: create.applyUrl,
      sourceUrl: create.sourceUrl,
      postedAt: null,
      isActive: true,
    }));

    await request(makeApp()).post('/search-1/run');
    const secondWheres = upsertMock.mock.calls.map((c) => c[0].where);
    expect(secondWheres).toEqual(firstWheres);
  });
});
