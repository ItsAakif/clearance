import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createInsightsRouter } from './insights.js';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    session: { findUnique: vi.fn() },
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

const insightsMock = vi.hoisted(() => ({
  getCatalogueInsights: vi.fn(),
}));

vi.mock('../search/insights.js', () => ({
  getCatalogueInsights: insightsMock.getCatalogueInsights,
}));

vi.mock('../middleware/auth.js', async () => {
  const actual = await vi.importActual<any>('../middleware/auth.js');
  return {
    ...actual,
    requireAuth: (req: any, res: any, next: any) => {
      const token = req.cookies?.clearance_session;
      if (!token) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      req.user = { id: 'user-1', email: 'test@example.com', isAdmin: true };
      next();
    },
  };
});

function makeApp(client: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    // parse cookie header minimally
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/clearance_session=([^;]+)/);
    if (match) req.cookies = { clearance_session: match[1] };
    else req.cookies = {};
    next();
  });
  app.use('/', createInsightsRouter(client));
  return app;
}

describe('insights catalogue route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 unauthenticated', async () => {
    const client = { $queryRaw: vi.fn() };
    const res = await request(makeApp(client)).get('/catalogue');
    expect(res.status).toBe(401);
  });

  it('returns 200 + shape authenticated with stubbed client', async () => {
    const insights = {
      totalOpen: 1812,
      postedLast30: 52,
      topSkills: [],
      workMode: [{ mode: 'remote', count: 248 }],
      seniority: [{ level: 'lead', count: 724 }],
      salaryByRegion: [{ region: 'us', currency: 'USD', median: 180000, count: 207 }],
      topCompanies: [],
      workModeStated: 310,
      seniorityStated: 1004,
      updatedAt: new Date().toISOString(),
    };
    const client = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    insightsMock.getCatalogueInsights.mockResolvedValue(insights);

    const res = await request(makeApp(client))
      .get('/catalogue')
      .set('Cookie', 'clearance_session=token');

    expect(res.status).toBe(200);
    expect(res.body.totalOpen).toBe(1812);
    expect(res.body.salaryByRegion[0].currency).toBe('USD');
    expect(res.body.workModeStated).toBe(310);
    expect(res.body.seniorityStated).toBe(1004);
  });
});