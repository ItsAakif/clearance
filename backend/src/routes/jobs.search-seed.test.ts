import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { prismaMocks, runSourceMock, seedMock, healthMocks } = vi.hoisted(() => ({
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { upsert: vi.fn(), update: vi.fn() },
  },
  runSourceMock: vi.fn(),
  seedMock: vi.fn(),
  healthMocks: { recordSourceSuccess: vi.fn(), recordSourceFailure: vi.fn() },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

vi.mock('../jobSources/defaultBoards.js', () => ({
  seedDefaultBoardsForUser: (...args: any[]) => seedMock(...args),
}));

// Keep the real boardToConfig so config wiring is exercised; stub only runSource
// so no board network is ever hit.
vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

vi.mock('../jobSources/sourceHealth.js', () => ({
  recordSourceSuccess: (...args: any[]) => healthMocks.recordSourceSuccess(...args),
  recordSourceFailure: (...args: any[]) => healthMocks.recordSourceFailure(...args),
}));

import jobsRouter from './jobs.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

function boardRow(overrides: Record<string, any> = {}) {
  return {
    id: 'board-1',
    type: 'json',
    boardId: null,
    feedUrl: 'https://remotive.com/api/remote-jobs',
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

const rawJob = {
  externalId: 'remotive-1',
  source: 'json',
  sourceUrl: 'https://remotive.com/jobs/1',
  title: 'Senior Backend Engineer',
  company: 'RemotiveCo',
  location: 'Worldwide',
  description: 'Build APIs.',
  applyUrl: 'https://remotive.com/jobs/1',
};

describe('jobs search lazy-seeds defaults and isolates failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  it('seeds defaults on /search when the user has zero boards (no more [])', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([]);
    runSourceMock.mockResolvedValue([]);
    const res = await request(makeApp()).get('/jobs/search?q=engineer');
    expect(res.status).toBe(200);
    expect(seedMock).toHaveBeenCalledWith('user-1');
    expect(res.body).toEqual([]);
  });

  it('seeds defaults on /scan too', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([]);
    const res = await request(makeApp()).get('/jobs/scan?query=engineer');
    expect(res.status).toBe(200);
    expect(seedMock).toHaveBeenCalledWith('user-1');
  });

  it('returns >0 mocked listings when boards exist', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow({ id: 'board-1' }),
      boardRow({ id: 'board-2', type: 'jobicy', feedUrl: null }),
    ]);
    runSourceMock.mockImplementation(async (config: any) =>
      config.type === 'jobicy'
        ? [{ ...rawJob, externalId: 'jobicy-1', source: 'jobicy', title: 'Remote Golang Engineer', sourceUrl: 'https://jobicy.com/jobs/7', applyUrl: 'https://jobicy.com/jobs/7' }]
        : [{ ...rawJob }],
    );
    const res = await request(makeApp()).get('/jobs/search?q=engineer');
    expect(res.status).toBe(200);
    expect(seedMock).toHaveBeenCalledWith('user-1');
    expect(res.body).toHaveLength(2);
    expect(healthMocks.recordSourceSuccess).toHaveBeenCalledTimes(2);
  });

  it('a failing board records health and returns the surviving rows (no crash)', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow({ id: 'board-rss', type: 'rss', feedUrl: 'https://weworkremotely.com/remote-jobs.rss' }),
      boardRow({ id: 'board-json' }),
    ]);
    runSourceMock.mockImplementation(async (config: any) => {
      if (config.type === 'rss') throw new Error('Fetch failed 500');
      return [{ ...rawJob }];
    });
    const res = await request(makeApp()).get('/jobs/search?q=engineer');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(healthMocks.recordSourceFailure).toHaveBeenCalledTimes(1);
    expect(healthMocks.recordSourceFailure.mock.calls[0][0]).toBe('board-rss');
    expect(healthMocks.recordSourceSuccess).toHaveBeenCalledTimes(1);
  });

  it('D4: forwards the location chip to aggregator boards with no explicit location', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow({ id: 'board-default', type: 'aggregator', feedUrl: null, aggregatorProvider: 'adzuna', aggregatorLocation: 'us' }),
      boardRow({ id: 'board-explicit', type: 'aggregator', feedUrl: null, aggregatorProvider: 'adzuna', aggregatorLocation: 'in:Bengaluru' }),
      boardRow({ id: 'board-blank', type: 'aggregator', feedUrl: null, aggregatorProvider: 'reed', aggregatorLocation: '' }),
    ]);
    runSourceMock.mockResolvedValue([]);
    const res = await request(makeApp()).get('/jobs/search?q=engineer&location=Bengaluru');
    expect(res.status).toBe(200);
    expect(runSourceMock).toHaveBeenCalledTimes(3);
    const locations = runSourceMock.mock.calls.map((c) => c[0].aggregatorLocation);
    // Seeded 'us' default and blank boards get the chip; explicit boards keep governing.
    expect(locations).toEqual(['Bengaluru', 'in:Bengaluru', 'Bengaluru']);
  });

  it('D4: keeps the board location when no location chip is passed', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([
      boardRow({ id: 'board-default', type: 'aggregator', feedUrl: null, aggregatorProvider: 'adzuna', aggregatorLocation: 'us' }),
    ]);
    runSourceMock.mockResolvedValue([]);
    const res = await request(makeApp()).get('/jobs/search?q=engineer');
    expect(res.status).toBe(200);
    expect(runSourceMock.mock.calls[0][0]).toMatchObject({ aggregatorLocation: 'us' });
  });
});

describe('jobs search location/company validation (T411 / ADR-021 decision 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow({ id: 'board-1' })]);
    runSourceMock.mockResolvedValue([]);
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
  });

  function engineerJob(overrides: Record<string, any> = {}) {
    return {
      source: 'json',
      title: 'Backend Engineer',
      company: 'Acme Corp',
      location: 'Berlin',
      description: 'Build backend APIs.',
      ...overrides,
    };
  }

  function jobUrl(n: number) {
    return `https://example.com/jobs/${n}`;
  }

  it('rejects an over-long location (81 chars) with 400', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', location: 'x'.repeat(81) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Location too long/);
    expect(runSourceMock).not.toHaveBeenCalled();
  });

  it('rejects 11 locations with 400', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', location: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Too many locations/);
    expect(runSourceMock).not.toHaveBeenCalled();
  });

  it('rejects a company longer than 100 chars with 400', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', company: 'y'.repeat(101) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Company name too long/);
    expect(runSourceMock).not.toHaveBeenCalled();
  });

  it('a valid 3-chip location + company filters exactly as before', async () => {
    runSourceMock.mockResolvedValue([
      engineerJob({ title: 'Backend Engineer', company: 'Acme Corp', location: 'Berlin', sourceUrl: jobUrl(1), applyUrl: jobUrl(1) }),
      engineerJob({ title: 'Frontend Engineer', company: 'Acme Corp', location: 'Remote', sourceUrl: jobUrl(2), applyUrl: jobUrl(2) }),
      engineerJob({ title: 'Backend Engineer', company: 'OtherCo', location: 'Berlin', sourceUrl: jobUrl(3), applyUrl: jobUrl(3) }),
      engineerJob({ title: 'Backend Engineer', company: 'Acme Corp', location: 'Paris', sourceUrl: jobUrl(4), applyUrl: jobUrl(4) }),
    ]);
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', location: ['Berlin', 'Remote', 'Boston'], company: 'acme' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((j: any) => j.location).sort()).toEqual(['Berlin', 'Remote']);
    for (const row of res.body) {
      expect(row.company).toBe('Acme Corp');
    }
  });

  it('still parses the JSON-array-literal location form', async () => {
    runSourceMock.mockResolvedValue([
      engineerJob({ title: 'Backend Engineer', company: 'Acme Corp', location: 'Berlin', sourceUrl: jobUrl(1), applyUrl: jobUrl(1) }),
      engineerJob({ title: 'Frontend Engineer', company: 'Acme Corp', location: 'Remote', sourceUrl: jobUrl(2), applyUrl: jobUrl(2) }),
      engineerJob({ title: 'Backend Engineer', company: 'Acme Corp', location: 'Paris', sourceUrl: jobUrl(3), applyUrl: jobUrl(3) }),
    ]);
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', location: JSON.stringify(['Berlin', 'Remote']) });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((j: any) => j.location).sort()).toEqual(['Berlin', 'Remote']);
  });

  it('a blank location means no filtering (edge)', async () => {
    runSourceMock.mockResolvedValue([
      engineerJob({ title: 'Backend Engineer', company: 'Acme Corp', location: 'Berlin', sourceUrl: jobUrl(1), applyUrl: jobUrl(1) }),
      engineerJob({ title: 'Frontend Engineer', company: 'Acme Corp', location: 'Paris', sourceUrl: jobUrl(2), applyUrl: jobUrl(2) }),
    ]);
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', location: '   ' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  it('accepts boundary values (80-char location, 10 locations, 100-char company)', async () => {
    runSourceMock.mockResolvedValue([]);
    const ten = Array.from({ length: 10 }, (_, i) => `City${i}`);
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', location: [...ten.slice(0, 9), 'z'.repeat(80)], company: 'y'.repeat(100) });
    expect(res.status).toBe(200);
  });
});
