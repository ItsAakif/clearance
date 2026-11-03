import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks, runSourceMock } = vi.hoisted(() => ({
  authState: { enabled: true },
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { upsert: vi.fn(), groupBy: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  runSourceMock: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.enabled) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

// Keep the real boardToConfig so config wiring is exercised; stub only runSource
// so no board network is ever hit.
vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

// Health writes must never fail the request; stub them to no-ops.
vi.mock('../jobSources/sourceHealth.js', () => ({
  recordSourceSuccess: vi.fn(),
  recordSourceFailure: vi.fn(),
}));

import jobsRouter from './jobs.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

const remoteJob = {
  source: 'greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  title: 'Frontend Engineer',
  company: 'Acme',
  location: 'Remote - US',
  description: 'Build React apps.',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
};

const berlinJob = {
  source: 'greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/2',
  title: 'Backend Engineer',
  company: 'Beta',
  location: 'Berlin, Germany',
  description: 'Build APIs.',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/2',
};

const parisJob = {
  source: 'greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/3',
  title: 'Designer',
  company: 'Gamma',
  location: 'Paris, France',
  description: 'Design systems.',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/3',
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

describe('jobs location filter and locations endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.enabled = true;
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
    runSourceMock.mockResolvedValue([{ ...remoteJob }, { ...berlinJob }, { ...parisJob }]);
    prismaMocks.jobListing.upsert.mockImplementation(async ({ create }: any) => ({
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
    prismaMocks.jobListing.groupBy.mockResolvedValue([]);
    prismaMocks.jobListing.findUnique.mockResolvedValue(null);
  });

  it('returns 401 on /jobs/search and /jobs/locations when auth rejects', async () => {
    authState.enabled = false;
    expect((await request(makeApp()).get('/jobs/search?q=en')).status).toBe(401);
    expect((await request(makeApp()).get('/jobs/locations')).status).toBe(401);
  });

  it('comma-joined and repeated location params return the same filtered set', async () => {
    const comma = await request(makeApp()).get('/jobs/search?q=en&location=Remote,Berlin');
    const repeated = await request(makeApp()).get('/jobs/search?q=en&location=Remote&location=Berlin');
    expect(comma.status).toBe(200);
    expect(repeated.status).toBe(200);
    const commaIds = comma.body.map((j: any) => j.id);
    const repeatedIds = repeated.body.map((j: any) => j.id);
    expect(commaIds).toEqual(repeatedIds);
    expect(commaIds).toHaveLength(2);
    // Paris is in neither place, so it is excluded.
    const companies = comma.body.map((j: any) => j.company).sort();
    expect(companies).toEqual(['Acme', 'Beta']);
  });

  it('applies no location filter when location is absent (query post-filter still drops zero-score rows)', async () => {
    const res = await request(makeApp()).get('/jobs/search?q=en');
    expect(res.status).toBe(200);
    // No location filter runs, but the ADR-021 server-side query post-filter
    // drops the Designer row: the token 'en' appears in neither its title,
    // company, location, nor description.
    expect(res.body).toHaveLength(2);
    expect(res.body.map((j: any) => j.company).sort()).toEqual(['Acme', 'Beta']);
  });

  it('keeps substring matches (Remote vs Remote - US)', async () => {
    const res = await request(makeApp()).get('/jobs/search?q=en&location=Remote');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].location).toBe('Remote - US');
  });

  it('decodes a JSON-array location value the same as repeated params', async () => {
    const json = await request(makeApp()).get('/jobs/search?q=en&location=["Remote","Berlin"]');
    const repeated = await request(makeApp()).get('/jobs/search?q=en&location=Remote&location=Berlin');
    expect(json.status).toBe(200);
    expect(json.body.map((j: any) => j.id)).toEqual(repeated.body.map((j: any) => j.id));
  });

  it('/locations 400s on limit=0 and limit=999, defaults take to 20', async () => {
    expect((await request(makeApp()).get('/jobs/locations?limit=0')).status).toBe(400);
    expect((await request(makeApp()).get('/jobs/locations?limit=999')).status).toBe(400);
    expect(prismaMocks.jobListing.groupBy).not.toHaveBeenCalled();

    prismaMocks.jobListing.groupBy.mockResolvedValue([]);
    const res = await request(makeApp()).get('/jobs/locations');
    expect(res.status).toBe(200);
    expect(prismaMocks.jobListing.groupBy).toHaveBeenCalledTimes(1);
    expect(prismaMocks.jobListing.groupBy.mock.calls[0][0]).toMatchObject({ take: 20 });
  });

  it('/locations filters by q case-insensitively and orders count desc, value asc', async () => {
    prismaMocks.jobListing.groupBy.mockResolvedValue([
      { location: 'b-city', _count: { _all: 2 } },
      { location: 'a-city', _count: { _all: 2 } },
      { location: 'z-city', _count: { _all: 9 } },
    ]);
    const res = await request(makeApp()).get('/jobs/locations?q=ber');
    expect(res.status).toBe(200);
    expect(prismaMocks.jobListing.groupBy.mock.calls[0][0].where).toEqual({
      location: { contains: 'ber', mode: 'insensitive' },
    });
    expect(res.body).toEqual({
      locations: [
        { value: 'z-city', count: 9 },
        { value: 'a-city', count: 2 },
        { value: 'b-city', count: 2 },
      ],
    });
  });

  it('/locations drops null and blank values instead of returning empty strings', async () => {
    prismaMocks.jobListing.groupBy.mockResolvedValue([
      { location: null, _count: { _all: 3 } },
      { location: '   ', _count: { _all: 1 } },
    ]);
    const res = await request(makeApp()).get('/jobs/locations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locations: [] });
  });

  it('/locations is not shadowed by /:id', async () => {
    prismaMocks.jobListing.groupBy.mockResolvedValue([
      { location: 'Berlin', _count: { _all: 1 } },
    ]);
    const res = await request(makeApp()).get('/jobs/locations');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ locations: [{ value: 'Berlin', count: 1 }] });
    expect(prismaMocks.jobListing.findUnique).not.toHaveBeenCalled();
  });
});
