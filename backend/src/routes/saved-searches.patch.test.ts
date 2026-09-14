import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockUserId, prismaMocks } = vi.hoisted(() => ({
  mockUserId: { value: 'user-1' },
  prismaMocks: {
    savedSearch: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

// Keep job-source side effects out of the PATCH tests.
vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: async () => [] };
});

import savedSearchesRouter from './saved-searches.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', savedSearchesRouter);
  return app;
}

const ownerSearch = { id: 'search-1', userId: 'user-1', name: 'Old', query: 'frontend' };

describe('saved-search PATCH route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId.value = 'user-1';
    prismaMocks.savedSearch.findUnique.mockResolvedValue(ownerSearch);
    prismaMocks.savedSearch.update.mockImplementation(async ({ data }: any) => ({ ...ownerSearch, ...data }));
  });

  it('updates client-editable fields', async () => {
    const res = await request(makeApp()).patch('/search-1').send({
      name: 'New',
      query: 'backend',
      location: 'Remote',
      company: 'Acme',
      boards: ['board-1'],
      minMatchScore: 70,
      remoteOnly: true,
      sortBy: 'newest',
    });
    expect(res.status).toBe(200);
    expect(prismaMocks.savedSearch.update).toHaveBeenCalledWith({
      where: { id: 'search-1' },
      data: {
        name: 'New',
        query: 'backend',
        location: 'Remote',
        company: 'Acme',
        sources: ['board-1'],
        minMatchScore: 70,
        remoteOnly: true,
        sortBy: 'newest',
      },
    });
  });

  it('ignores server-controlled fields (lastRunAt/matchCount)', async () => {
    const res = await request(makeApp()).patch('/search-1').send({
      name: 'New',
      lastRunAt: new Date().toISOString(),
      matchCount: 999,
    });
    expect(res.status).toBe(200);
    const [updateArg] = prismaMocks.savedSearch.update.mock.calls[0];
    expect(updateArg.data).toEqual({ name: 'New' });
    expect(updateArg.data).not.toHaveProperty('lastRunAt');
    expect(updateArg.data).not.toHaveProperty('matchCount');
  });

  it('denies patching another user search', async () => {
    mockUserId.value = 'user-2';
    const res = await request(makeApp()).patch('/search-1').send({ name: 'Hijack' });
    expect(res.status).toBe(403);
    expect(prismaMocks.savedSearch.update).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing search', async () => {
    prismaMocks.savedSearch.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).patch('/missing').send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('rejects invalid input', async () => {
    const res = await request(makeApp()).patch('/search-1').send({ minMatchScore: 500 });
    expect(res.status).toBe(400);
    expect(prismaMocks.savedSearch.update).not.toHaveBeenCalled();
  });
});
