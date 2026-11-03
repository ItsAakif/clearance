// Registry read-surface tests (T643, Wave 2).
//
// The real requireAdmin gate is exercised (not mocked): requireAuth is mocked
// to simulate (a) no session -> 401, (b) a non-admin session -> 403 via the
// real requireAdmin, and (c) an admin session -> 200. Note per ADR-030 the
// production requireAuth always sets isAdmin: true, so case (b) cannot occur
// outside tests; it is asserted here only to pin the gate wiring.
//
// Prisma is mocked. Fixtures are synthetic (example.test hosts, N13).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks, crawlBatchMock } = vi.hoisted(() => ({
  authState: { mode: 'admin' as 'admin' | 'non-admin' | 'none' },
  prismaMocks: {
    company: { count: vi.fn() },
    companyCareerPage: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    jobSourceHealth: {
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
  crawlBatchMock: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (authState.mode === 'none') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = {
      id: 'user-1',
      email: 'test@example.com',
      isAdmin: authState.mode === 'admin',
    };
    next();
  },
}));

// requireAdmin is intentionally NOT mocked - the gate wiring is under test.
vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

// crawlBatch is mocked so the route tests pin the trigger wiring (limit
// handling, summary shape, no JobSourceHealth write) without probing
// providers. All other crawler exports stay real via importOriginal, so
// CRAWL_BATCH_SIZE in tests is the production constant, not a copy.
vi.mock('../registry/crawler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../registry/crawler.js')>();
  return { ...actual, crawlBatch: crawlBatchMock };
});

import registryRouter, {
  REGISTRY_PAGES_DEFAULT_LIMIT,
  REGISTRY_PAGES_MAX_LIMIT,
  REGISTRY_HEALTH_DEFAULT_LIMIT,
  REGISTRY_HEALTH_MAX_LIMIT,
  REGISTRY_FAILURE_STATUSES,
  REGISTRY_SUSPECT_MARKER,
} from './registry.js';
import { CRAWL_BATCH_SIZE } from '../registry/crawler.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', registryRouter);
  return app;
}

function pageRow(overrides: Record<string, any> = {}) {
  return {
    id: 'page-1',
    companyId: 'company-1',
    url: 'https://boards.greenhouse.io/acme.example.test',
    host: 'boards.greenhouse.io',
    provider: 'greenhouse',
    boardToken: 'acme',
    tier: 1,
    isActive: true,
    verifyStatus: 'unverified',
    verifyMethod: null,
    verifiedAt: null,
    lastCheckedAt: null,
    httpStatus: null,
    resultCount: 0,
    failureCount: 0,
    nextCheckAt: null,
    lastError: null,
    createdAt: new Date('2026-09-20T00:00:00Z'),
    updatedAt: new Date('2026-09-20T00:00:00Z'),
    company: { id: 'company-1', slug: 'acme-acme-example-test', name: 'Acme' },
    ...overrides,
  };
}

describe('registry auth gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.mode = 'admin';
    prismaMocks.company.count.mockResolvedValue(0);
    prismaMocks.companyCareerPage.count.mockResolvedValue(0);
    prismaMocks.companyCareerPage.groupBy.mockResolvedValue([]);
    prismaMocks.companyCareerPage.findMany.mockResolvedValue([]);
  });

  it('GET /stats returns 401 without a session', async () => {
    authState.mode = 'none';
    const res = await request(makeApp()).get('/stats');
    expect(res.status).toBe(401);
    expect(prismaMocks.company.count).not.toHaveBeenCalled();
  });

  it('GET /pages returns 401 without a session', async () => {
    authState.mode = 'none';
    const res = await request(makeApp()).get('/pages');
    expect(res.status).toBe(401);
    expect(prismaMocks.companyCareerPage.findMany).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin session (gate wiring; unreachable under ADR-030)', async () => {
    authState.mode = 'non-admin';
    expect((await request(makeApp()).get('/stats')).status).toBe(403);
    expect((await request(makeApp()).get('/pages')).status).toBe(403);
    expect(prismaMocks.company.count).not.toHaveBeenCalled();
    expect(prismaMocks.companyCareerPage.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /registry/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.mode = 'admin';
  });

  it('returns aggregate counts from a small synthetic fixture via count/groupBy', async () => {
    prismaMocks.company.count.mockResolvedValue(2);
    prismaMocks.companyCareerPage.count.mockResolvedValue(3);
    prismaMocks.companyCareerPage.groupBy.mockImplementation(async (args: any) => {
      if (args.by[0] === 'provider') {
        return [
          { provider: 'greenhouse', _count: { _all: 2 } },
          { provider: null, _count: { _all: 1 } },
        ];
      }
      if (args.by[0] === 'tier') {
        return [
          { tier: 1, _count: { _all: 2 } },
          { tier: 3, _count: { _all: 1 } },
        ];
      }
      return [
        { verifyStatus: 'ok', _count: { _all: 1 } },
        { verifyStatus: 'unverified', _count: { _all: 2 } },
      ];
    });

    const res = await request(makeApp()).get('/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      companies: 2,
      pages: 3,
      byProvider: { greenhouse: 2, unknown: 1 },
      byTier: { 1: 2, 3: 1 },
      byVerifyStatus: { ok: 1, unverified: 2 },
    });
    // Counts are aggregate queries, never row fetches.
    expect(prismaMocks.company.count).toHaveBeenCalledTimes(1);
    expect(prismaMocks.companyCareerPage.count).toHaveBeenCalledTimes(1);
    expect(prismaMocks.companyCareerPage.groupBy).toHaveBeenCalledTimes(3);
    expect(prismaMocks.companyCareerPage.findMany).not.toHaveBeenCalled();
  });

  it('returns empty aggregates on an empty registry', async () => {
    prismaMocks.company.count.mockResolvedValue(0);
    prismaMocks.companyCareerPage.count.mockResolvedValue(0);
    prismaMocks.companyCareerPage.groupBy.mockResolvedValue([]);

    const res = await request(makeApp()).get('/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      companies: 0,
      pages: 0,
      byProvider: {},
      byTier: {},
      byVerifyStatus: {},
    });
  });
});

describe('GET /registry/pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.mode = 'admin';
    prismaMocks.companyCareerPage.count.mockResolvedValue(0);
    prismaMocks.companyCareerPage.findMany.mockResolvedValue([]);
  });

  it('uses the documented default limit and deterministic ordering', async () => {
    const res = await request(makeApp()).get('/pages');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pages: [], total: 0, limit: REGISTRY_PAGES_DEFAULT_LIMIT, offset: 0 });
    expect(REGISTRY_PAGES_DEFAULT_LIMIT).toBe(50);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
        orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
        take: 50,
        skip: 0,
      }),
    );
  });

  it('clamps an over-large limit to the documented maximum', async () => {
    const res = await request(makeApp()).get('/pages?limit=10000');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(REGISTRY_PAGES_MAX_LIMIT);
    expect(REGISTRY_PAGES_MAX_LIMIT).toBe(200);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it('honours explicit limit + offset and returns the total', async () => {
    prismaMocks.companyCareerPage.count.mockResolvedValue(7);
    prismaMocks.companyCareerPage.findMany.mockResolvedValue([pageRow(), pageRow({ id: 'page-2' })]);

    const res = await request(makeApp()).get('/pages?limit=2&offset=5');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(7);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(5);
    expect(res.body.pages).toHaveLength(2);
    // The crawler/admin view fields are present; no secrets leak.
    expect(res.body.pages[0]).toMatchObject({
      url: 'https://boards.greenhouse.io/acme.example.test',
      provider: 'greenhouse',
      tier: 1,
      verifyStatus: 'unverified',
    });
    expect(res.body.pages[0].company).toEqual({
      id: 'company-1',
      slug: 'acme-acme-example-test',
      name: 'Acme',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/apiKey|secret|password/i);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2, skip: 5 }),
    );
    expect(prismaMocks.companyCareerPage.count).toHaveBeenCalledWith({ where: {} });
  });

  it('filters by provider', async () => {
    const res = await request(makeApp()).get('/pages?provider=lever');

    expect(res.status).toBe(200);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: 'lever' } }),
    );
    expect(prismaMocks.companyCareerPage.count).toHaveBeenCalledWith({
      where: { provider: 'lever' },
    });
  });

  it("maps provider=unknown to a null provider", async () => {
    const res = await request(makeApp()).get('/pages?provider=unknown');

    expect(res.status).toBe(200);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provider: null } }),
    );
  });

  it('filters by tier', async () => {
    const res = await request(makeApp()).get('/pages?tier=3');

    expect(res.status).toBe(200);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tier: 3 } }),
    );
  });

  it('rejects an invalid tier', async () => {
    const res = await request(makeApp()).get('/pages?tier=banana');

    expect(res.status).toBe(400);
    expect(prismaMocks.companyCareerPage.findMany).not.toHaveBeenCalled();
  });

  it('filters by verifyStatus', async () => {
    const res = await request(makeApp()).get('/pages?verifyStatus=ok');

    expect(res.status).toBe(200);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { verifyStatus: 'ok' } }),
    );
  });

  it('filters by isActive true and false', async () => {
    await request(makeApp()).get('/pages?isActive=true');
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );

    await request(makeApp()).get('/pages?isActive=false');
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: false } }),
    );
  });

  it('rejects an invalid isActive', async () => {
    const res = await request(makeApp()).get('/pages?isActive=yes');

    expect(res.status).toBe(400);
    expect(prismaMocks.companyCareerPage.findMany).not.toHaveBeenCalled();
  });

  it('combines filters with pagination', async () => {
    const res = await request(makeApp()).get(
      '/pages?provider=greenhouse&tier=1&verifyStatus=unverified&isActive=true&limit=10&offset=20',
    );

    expect(res.status).toBe(200);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider: 'greenhouse',
          tier: 1,
          verifyStatus: 'unverified',
          isActive: true,
        },
        take: 10,
        skip: 20,
        orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('rejects invalid limit and offset', async () => {
    expect((await request(makeApp()).get('/pages?limit=0')).status).toBe(400);
    expect((await request(makeApp()).get('/pages?limit=abc')).status).toBe(400);
    expect((await request(makeApp()).get('/pages?offset=-1')).status).toBe(400);
    expect(prismaMocks.companyCareerPage.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /registry/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.mode = 'admin';
    prismaMocks.companyCareerPage.count.mockImplementation(async (args: any) =>
      args?.where?.isActive === false ? 1 : 5,
    );
    prismaMocks.companyCareerPage.groupBy.mockImplementation(async (args: any) => {
      if (args.by[0] === 'provider') {
        return [
          { provider: 'greenhouse', _count: { _all: 4 } },
          { provider: null, _count: { _all: 2 } },
        ];
      }
      if (args.by[0] === 'tier') {
        return [
          { tier: 1, _count: { _all: 4 } },
          { tier: 3, _count: { _all: 2 } },
        ];
      }
      return [
        { verifyStatus: 'ok', _count: { _all: 3 } },
        { verifyStatus: 'blocked', _count: { _all: 1 } },
        { verifyStatus: 'unverified', _count: { _all: 2 } },
      ];
    });
    prismaMocks.companyCareerPage.findMany.mockResolvedValue([]);
  });

  function findManyCallMatching(predicate: (args: any) => boolean) {
    const calls = prismaMocks.companyCareerPage.findMany.mock.calls.map((call) => call[0]);
    const match = calls.find(predicate);
    expect(match).toBeDefined();
    return match;
  }

  it('returns aggregates matching a seeded fixture via count/groupBy', async () => {
    const res = await request(makeApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.byProvider).toEqual({ greenhouse: 4, unknown: 2 });
    expect(res.body.byTier).toEqual({ 1: 4, 3: 2 });
    expect(res.body.byVerifyStatus).toEqual({ ok: 3, blocked: 1, unverified: 2 });
    expect(res.body.active).toBe(5);
    expect(res.body.inactive).toBe(1);
    expect(res.body.due).toEqual([]);
    expect(res.body.recentFailures).toEqual([]);
    expect(res.body.suspects).toEqual([]);
    expect(res.body.dueLimit).toBe(REGISTRY_HEALTH_DEFAULT_LIMIT);
    expect(res.body.failuresLimit).toBe(REGISTRY_HEALTH_DEFAULT_LIMIT);
    expect(res.body.suspectsLimit).toBe(REGISTRY_HEALTH_DEFAULT_LIMIT);
    expect(REGISTRY_HEALTH_DEFAULT_LIMIT).toBe(20);
    // Counts are aggregate queries, never row fetches: 3 groupBys for the
    // breakdowns, 2 counts for active/inactive, and exactly 3 bounded
    // findMany calls for the lists.
    expect(prismaMocks.companyCareerPage.groupBy).toHaveBeenCalledTimes(3);
    expect(prismaMocks.companyCareerPage.count).toHaveBeenCalledTimes(2);
    expect(prismaMocks.companyCareerPage.count).toHaveBeenCalledWith({
      where: { isActive: true },
    });
    expect(prismaMocks.companyCareerPage.count).toHaveBeenCalledWith({
      where: { isActive: false },
    });
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(res.body)).not.toMatch(/apiKey|secret|password/i);
  });

  it('due pages are ordered by due time (nulls first) and bounded', async () => {
    const oldest = pageRow({ id: 'page-old', nextCheckAt: null });
    const middle = pageRow({
      id: 'page-mid',
      nextCheckAt: new Date('2026-09-18T00:00:00Z'),
    });
    const newest = pageRow({
      id: 'page-new',
      nextCheckAt: new Date('2026-09-20T00:00:00Z'),
    });
    prismaMocks.companyCareerPage.findMany.mockImplementation(async (args: any) => {
      if (args.orderBy?.[0]?.nextCheckAt) return [oldest, middle, newest];
      return [];
    });

    const res = await request(makeApp()).get('/health?dueLimit=2');

    expect(res.status).toBe(200);
    expect(res.body.due.map((p: any) => p.id)).toEqual(['page-old', 'page-mid', 'page-new']);
    expect(res.body.dueLimit).toBe(2);
    const dueArgs = findManyCallMatching((args) => args.orderBy?.[0]?.nextCheckAt !== undefined);
    expect(dueArgs.take).toBe(2);
    expect(dueArgs.orderBy).toEqual([{ nextCheckAt: 'asc' }, { id: 'asc' }]);
    expect(dueArgs.where).toMatchObject({ isActive: true });
    // The due list carries the company view fields, like /pages.
    expect(res.body.due[0].company).toEqual({
      id: 'company-1',
      slug: 'acme-acme-example-test',
      name: 'Acme',
    });
  });

  it('recent failures are newest-first, carry messages, and are bounded', async () => {
    const older = pageRow({
      id: 'page-fail-old',
      verifyStatus: 'blocked',
      lastCheckedAt: new Date('2026-09-18T00:00:00Z'),
      lastError: 'access denied by provider',
    });
    const newer = pageRow({
      id: 'page-fail-new',
      verifyStatus: 'http_error',
      lastCheckedAt: new Date('2026-09-20T00:00:00Z'),
      lastError: 'fetch failed 500',
    });
    prismaMocks.companyCareerPage.findMany.mockImplementation(async (args: any) => {
      if (args.where?.verifyStatus) return [newer, older];
      return [];
    });

    const res = await request(makeApp()).get('/health?failuresLimit=2');

    expect(res.status).toBe(200);
    expect(res.body.recentFailures.map((p: any) => p.id)).toEqual([
      'page-fail-new',
      'page-fail-old',
    ]);
    expect(res.body.recentFailures[0].lastError).toBe('fetch failed 500');
    expect(res.body.failuresLimit).toBe(2);
    expect(REGISTRY_FAILURE_STATUSES).toEqual(['blocked', 'http_error', 'timeout', 'invalid']);
    const failuresArgs = findManyCallMatching((args) => args.where?.verifyStatus !== undefined);
    expect(failuresArgs.where).toEqual({ verifyStatus: { in: REGISTRY_FAILURE_STATUSES } });
    expect(failuresArgs.take).toBe(2);
    expect(failuresArgs.orderBy[0]).toEqual({ lastCheckedAt: { sort: 'desc', nulls: 'last' } });
  });

  it('suspects come from the crawler SUSPECT audit marker and are bounded', async () => {
    const suspect = pageRow({
      id: 'page-suspect',
      verifyStatus: 'ok',
      lastCheckedAt: new Date('2026-09-20T00:00:00Z'),
      lastError: 'SUSPECT resultCount drop 200 -> 1',
    });
    prismaMocks.companyCareerPage.findMany.mockImplementation(async (args: any) => {
      if (args.where?.lastError) return [suspect];
      return [];
    });

    const res = await request(makeApp()).get('/health?suspectsLimit=5');

    expect(res.status).toBe(200);
    expect(res.body.suspects).toHaveLength(1);
    expect(res.body.suspects[0].id).toBe('page-suspect');
    expect(res.body.suspectsLimit).toBe(5);
    const suspectsArgs = findManyCallMatching((args) => args.where?.lastError !== undefined);
    expect(suspectsArgs.where).toEqual({ lastError: { contains: REGISTRY_SUSPECT_MARKER } });
    expect(suspectsArgs.take).toBe(5);
    expect(suspectsArgs.orderBy[0]).toEqual({ lastCheckedAt: { sort: 'desc', nulls: 'last' } });
  });

  it('clamps over-large list limits to the documented maximum', async () => {
    const res = await request(makeApp()).get(
      '/health?dueLimit=9999&failuresLimit=9999&suspectsLimit=9999',
    );

    expect(res.status).toBe(200);
    expect(REGISTRY_HEALTH_MAX_LIMIT).toBe(100);
    expect(res.body.dueLimit).toBe(REGISTRY_HEALTH_MAX_LIMIT);
    expect(res.body.failuresLimit).toBe(REGISTRY_HEALTH_MAX_LIMIT);
    expect(res.body.suspectsLimit).toBe(REGISTRY_HEALTH_MAX_LIMIT);
    for (const call of prismaMocks.companyCareerPage.findMany.mock.calls) {
      expect(call[0].take).toBe(REGISTRY_HEALTH_MAX_LIMIT);
    }
  });

  it('rejects invalid list limits without querying', async () => {
    expect((await request(makeApp()).get('/health?dueLimit=0')).status).toBe(400);
    expect((await request(makeApp()).get('/health?failuresLimit=abc')).status).toBe(400);
    expect((await request(makeApp()).get('/health?suspectsLimit=-1')).status).toBe(400);
    expect(prismaMocks.companyCareerPage.findMany).not.toHaveBeenCalled();
    expect(prismaMocks.companyCareerPage.count).not.toHaveBeenCalled();
  });

  it('GET /health returns 401 without a session', async () => {
    authState.mode = 'none';
    const res = await request(makeApp()).get('/health');
    expect(res.status).toBe(401);
    expect(prismaMocks.companyCareerPage.groupBy).not.toHaveBeenCalled();
  });

  it('GET /health returns 403 for a non-admin session (gate wiring; unreachable under ADR-030)', async () => {
    authState.mode = 'non-admin';
    const res = await request(makeApp()).get('/health');
    expect(res.status).toBe(403);
    expect(prismaMocks.companyCareerPage.groupBy).not.toHaveBeenCalled();
  });
});

describe('POST /registry/crawl', () => {
  const crawlOutcomes = [
    { pageId: 'page-1', status: 'ok', resultCount: 12, latencyMs: 40 },
    {
      pageId: 'page-2',
      status: 'empty',
      resultCount: 0,
      latencyMs: 35,
      observedProvider: 'lever',
      observedBoardToken: 'acme',
    },
    { pageId: 'page-3', status: 'skipped', resultCount: 0, latencyMs: 2, error: 'no engine' },
  ];

  function jobSourceHealthWrites() {
    return Object.values(prismaMocks.jobSourceHealth);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    authState.mode = 'admin';
    crawlBatchMock.mockResolvedValue(crawlOutcomes);
  });

  it('runs a bounded batch and returns the run-style summary', async () => {
    const res = await request(makeApp()).post('/crawl').send({ limit: 5 });

    expect(res.status).toBe(200);
    expect(crawlBatchMock).toHaveBeenCalledTimes(1);
    expect(crawlBatchMock).toHaveBeenCalledWith(5, { now: expect.any(Date) });
    expect(res.body.requestedLimit).toBe(5);
    expect(res.body.limit).toBe(5);
    expect(res.body.attempted).toBe(3);
    expect(res.body.byStatus).toEqual({ ok: 1, empty: 1, skipped: 1 });
    expect(res.body.latencyMs).toEqual(expect.any(Number));
    expect(res.body.providerCorrections).toEqual([
      { pageId: 'page-2', observedProvider: 'lever', observedBoardToken: 'acme' },
    ]);
    expect(res.body.skipped).toEqual([{ pageId: 'page-3', reason: 'no engine' }]);
    expect(JSON.stringify(res.body)).not.toMatch(/apiKey|secret|password/i);
  });

  it('defaults to CRAWL_BATCH_SIZE when no limit is given', async () => {
    const res = await request(makeApp()).post('/crawl').send({});

    expect(res.status).toBe(200);
    expect(CRAWL_BATCH_SIZE).toBe(20);
    expect(crawlBatchMock).toHaveBeenCalledWith(CRAWL_BATCH_SIZE, { now: expect.any(Date) });
    expect(res.body.requestedLimit).toBe(CRAWL_BATCH_SIZE);
    expect(res.body.limit).toBe(CRAWL_BATCH_SIZE);
  });

  it('CLAMPS an over-cap limit to CRAWL_BATCH_SIZE (documented policy)', async () => {
    const overCap = CRAWL_BATCH_SIZE + 1000;
    const res = await request(makeApp()).post('/crawl').send({ limit: overCap });

    expect(res.status).toBe(200);
    // Chosen behaviour is CLAMP, not reject: the crawler is still called,
    // but with the capped limit, and the response echoes both values.
    expect(crawlBatchMock).toHaveBeenCalledWith(CRAWL_BATCH_SIZE, { now: expect.any(Date) });
    expect(res.body.requestedLimit).toBe(overCap);
    expect(res.body.limit).toBe(CRAWL_BATCH_SIZE);
    expect(res.body.attempted).toBe(3);
  });

  it('rejects invalid limits without crawling', async () => {
    for (const limit of [0, -1, 1.5, 'banana']) {
      const res = await request(makeApp()).post('/crawl').send({ limit });
      expect(res.status).toBe(400);
    }
    expect(crawlBatchMock).not.toHaveBeenCalled();
  });

  it('performs no JobSourceHealth write from the crawl path', async () => {
    const res = await request(makeApp()).post('/crawl').send({ limit: 3 });

    expect(res.status).toBe(200);
    expect(crawlBatchMock).toHaveBeenCalledTimes(1);
    for (const spy of jobSourceHealthWrites()) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('POST /crawl returns 401 without a session', async () => {
    authState.mode = 'none';
    const res = await request(makeApp()).post('/crawl').send({ limit: 3 });
    expect(res.status).toBe(401);
    expect(crawlBatchMock).not.toHaveBeenCalled();
  });

  it('POST /crawl returns 403 for a non-admin session (gate wiring; unreachable under ADR-030)', async () => {
    authState.mode = 'non-admin';
    const res = await request(makeApp()).post('/crawl').send({ limit: 3 });
    expect(res.status).toBe(403);
    expect(crawlBatchMock).not.toHaveBeenCalled();
  });
});
