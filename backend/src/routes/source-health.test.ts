import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock runSource but keep the real boardToConfig so config wiring is exercised.
const runSourceMock = vi.fn();
vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

const requireAuthMock = vi.fn((req: any, _res: any, next: any) => {
  req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
  next();
});
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => requireAuthMock(req, res, next),
}));

vi.mock('../jobSources/defaultBoards.js', () => ({
  seedDefaultBoardsForUser: vi.fn(async () => undefined),
}));

const findManyBoardsMock = vi.fn();
const findUniqueBoardMock = vi.fn();
const upsertHealthMock = vi.fn();
const upsertListingMock = vi.fn();
const findUniqueSearchMock = vi.fn();
const findUniqueAlertMock = vi.fn();
const updateAlertMock = vi.fn();
vi.mock('../lib/prisma.js', () => ({
  default: {
    jobBoard: {
      findMany: (...args: any[]) => findManyBoardsMock(...args),
      findUnique: (...args: any[]) => findUniqueBoardMock(...args),
    },
    jobSourceHealth: { upsert: (...args: any[]) => upsertHealthMock(...args) },
    jobListing: { upsert: (...args: any[]) => upsertListingMock(...args) },
    savedSearch: { findUnique: (...args: any[]) => findUniqueSearchMock(...args) },
    jobAlert: {
      findUnique: (...args: any[]) => findUniqueAlertMock(...args),
      update: (...args: any[]) => updateAlertMock(...args),
    },
  },
}));

import jobsRouter from './jobs.js';
import boardsRouter from './boards.js';
import savedSearchesRouter from './saved-searches.js';
import jobAlertsRouter from './job-alerts.js';

function makeApp(router: any, mount = '/') {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  return app;
}

const baseJob = {
  source: 'greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  title: 'Senior Frontend Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'Build React apps.',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
};

function boardRow(overrides: Record<string, any> = {}) {
  return {
    id: 'board-1',
    userId: 'user-1',
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
    isActive: true,
    ...overrides,
  };
}

describe('source-health wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
      next();
    });
    findManyBoardsMock.mockResolvedValue([boardRow()]);
    findUniqueBoardMock.mockResolvedValue(boardRow());
    upsertHealthMock.mockResolvedValue({});
    upsertListingMock.mockImplementation(async ({ create }: any) => ({
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
    findUniqueSearchMock.mockResolvedValue({ id: 'search-1', userId: 'user-1', query: 'frontend', sources: null });
    findUniqueAlertMock.mockResolvedValue({ id: 'alert-1', userId: 'user-1', query: 'frontend', sources: null, savedSearchId: null });
    updateAlertMock.mockResolvedValue({});
    runSourceMock.mockResolvedValue([{ ...baseJob }, { ...baseJob, sourceUrl: 'https://boards.greenhouse.io/acme/jobs/124', applyUrl: 'https://boards.greenhouse.io/acme/jobs/124' }]);
  });

  it('successful scan records a healthy row with count + latency', async () => {
    const res = await request(makeApp(jobsRouter)).get('/scan?query=frontend');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    const args = upsertHealthMock.mock.calls[0][0];
    expect(args.where).toEqual({ jobBoardId: 'board-1' });
    expect(args.create.status).toBe('healthy');
    expect(args.create.consecutiveFailures).toBe(0);
    expect(args.create.lastResultCount).toBe(2);
    expect(typeof args.create.lastLatencyMs).toBe('number');
    expect(args.create.lastLatencyMs).toBeGreaterThanOrEqual(0);
    expect(args.update.status).toBe('healthy');
  });

  it('failed source records a failed row with incremented consecutiveFailures and sanitized error, returning []', async () => {
    const longError = new Error(`boom ${'x'.repeat(3000)}`);
    runSourceMock.mockRejectedValueOnce(longError);
    const res = await request(makeApp(jobsRouter)).get('/scan?query=frontend');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    const args = upsertHealthMock.mock.calls[0][0];
    expect(args.create.status).toBe('failed');
    expect(args.update.status).toBe('failed');
    expect(args.update.consecutiveFailures).toEqual({ increment: 1 });
    const storedError: string = args.create.lastError;
    expect(storedError).toContain('boom');
    expect(storedError.length).toBeLessThanOrEqual(2000);
  });

  it('a health-write rejection never fails the scan', async () => {
    upsertHealthMock.mockRejectedValueOnce(new Error('db down'));
    const res = await request(makeApp(jobsRouter)).get('/scan?query=frontend');
    // sourceHealth.ts swallows the write error, so the request still succeeds.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('saved-search run records health per board', async () => {
    const res = await request(makeApp(savedSearchesRouter)).post('/search-1/run');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    expect(upsertHealthMock.mock.calls[0][0].create.status).toBe('healthy');
    expect(upsertHealthMock.mock.calls[0][0].where).toEqual({ jobBoardId: 'board-1' });
  });

  it('job-alert run records health per board', async () => {
    findUniqueAlertMock.mockResolvedValue({
      id: 'alert-1', userId: 'user-1', query: 'frontend',
      sources: ['board-1'], savedSearchId: null,
    });
    const res = await request(makeApp(jobAlertsRouter)).post('/alert-1/run');
    expect(res.status).toBe(200);
    expect(upsertHealthMock).toHaveBeenCalledTimes(1);
    expect(upsertHealthMock.mock.calls[0][0].create.status).toBe('healthy');
  });

  it('GET /boards includes sourceHealth', async () => {
    findManyBoardsMock.mockResolvedValue([{ ...boardRow(), sourceHealth: { status: 'healthy', consecutiveFailures: 0 } }]);
    const res = await request(makeApp(boardsRouter)).get('/');
    expect(res.status).toBe(200);
    expect(findManyBoardsMock).toHaveBeenCalledWith(
      expect.objectContaining({ include: { sourceHealth: true } }),
    );
    expect(res.body[0].sourceHealth).toMatchObject({ status: 'healthy' });
  });

  it('GET /boards/:id/health returns 401 when unauthenticated', async () => {
    requireAuthMock.mockImplementationOnce((_req: any, res: any, _next: any) => {
      res.status(401).json({ error: 'Authentication required' });
    });
    const res = await request(makeApp(boardsRouter)).get('/board-1/health');
    expect(res.status).toBe(401);
  });

  it('GET /boards/:id/health returns 404 for a missing board', async () => {
    findUniqueBoardMock.mockResolvedValueOnce(null);
    const res = await request(makeApp(boardsRouter)).get('/missing/health');
    expect(res.status).toBe(404);
  });

  it('GET /boards/:id/health returns 403 for a board owned by someone else', async () => {
    findUniqueBoardMock.mockResolvedValueOnce(boardRow({ userId: 'user-2', sourceHealth: null }));
    const res = await request(makeApp(boardsRouter)).get('/board-1/health');
    expect(res.status).toBe(403);
  });

  it('GET /boards/:id/health returns the health row for the owner', async () => {
    findUniqueBoardMock.mockResolvedValueOnce(
      boardRow({ sourceHealth: { status: 'healthy', consecutiveFailures: 0, lastResultCount: 5 } }),
    );
    const res = await request(makeApp(boardsRouter)).get('/board-1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'healthy', lastResultCount: 5 });
  });

  it('GET /boards/:id/health returns a default when no health row exists', async () => {
    findUniqueBoardMock.mockResolvedValueOnce(boardRow({ sourceHealth: null }));
    const res = await request(makeApp(boardsRouter)).get('/board-1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'unknown', consecutiveFailures: 0, lastResultCount: 0 });
  });
});
