import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockUserId, prismaMocks } = vi.hoisted(() => ({
  mockUserId: { value: 'user-1' },
  prismaMocks: {
    savedSearch: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
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
import { legacyToIntent } from '../discovery/intentPersistence.js';
import { searchIntentSchema } from '../discovery/searchIntent.js';

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
    prismaMocks.savedSearch.create.mockImplementation(async ({ data }: any) => ({ id: 'search-new', ...data }));
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
    // Wave 12 (T843): a legacy filter edit re-derives and stores the intent
    // alongside the legacy columns (intentional change - STEP 2).
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
        intent: legacyToIntent({
          query: 'backend',
          location: 'Remote',
          company: 'Acme',
          sources: ['board-1'],
          remoteOnly: true,
        }),
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

  it('accepts an array location on PATCH (ADR-008)', async () => {
    const res = await request(makeApp()).patch('/search-1').send({ location: ['Remote', 'Berlin'] });
    expect(res.status).toBe(200);
    // Wave 12 (T843): location is a filter field, so the intent is
    // re-derived from the merged legacy values (intentional change - STEP 2).
    expect(prismaMocks.savedSearch.update).toHaveBeenCalledWith({
      where: { id: 'search-1' },
      data: {
        location: '["Remote","Berlin"]',
        intent: legacyToIntent({ query: 'frontend', location: '["Remote","Berlin"]' }),
      },
    });
  });

  it('stores an empty array location as null on PATCH', async () => {
    const res = await request(makeApp()).patch('/search-1').send({ location: [] });
    expect(res.status).toBe(200);
    // Wave 12 (T843): same re-derivation as above (intentional change).
    expect(prismaMocks.savedSearch.update).toHaveBeenCalledWith({
      where: { id: 'search-1' },
      data: {
        location: null,
        intent: legacyToIntent({ query: 'frontend', location: null }),
      },
    });
  });

  it('rejects an oversized array location on PATCH', async () => {
    const res = await request(makeApp()).patch('/search-1').send({ location: ['x'.repeat(81)] });
    expect(res.status).toBe(400);
    expect(prismaMocks.savedSearch.update).not.toHaveBeenCalled();
    const tooMany = await request(makeApp()).patch('/search-1').send({ location: Array(11).fill('Berlin') });
    expect(tooMany.status).toBe(400);
  });
});

describe('saved-search POST route location arrays (T413)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId.value = 'user-1';
    prismaMocks.savedSearch.create.mockImplementation(async ({ data }: any) => ({ id: 'search-new', ...data }));
  });

  it('stores an array location as a JSON string and echoes it', async () => {
    const res = await request(makeApp()).post('/').send({
      name: 'S', query: 'frontend', location: ['Remote', 'Berlin'],
    });
    expect(res.status).toBe(201);
    expect(prismaMocks.savedSearch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ location: '["Remote","Berlin"]' }),
    });
    expect(res.body.location).toBe('["Remote","Berlin"]');
  });

  it('stores a plain string location unchanged', async () => {
    const res = await request(makeApp()).post('/').send({
      name: 'S', query: 'frontend', location: 'Remote',
    });
    expect(res.status).toBe(201);
    expect(prismaMocks.savedSearch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ location: 'Remote' }),
    });
  });

  it('persists minMatchScore, remoteOnly and sortBy on create', async () => {
    const res = await request(makeApp()).post('/').send({
      name: 'S', query: 'frontend', minMatchScore: 70, remoteOnly: true, sortBy: 'newest',
    });
    expect(res.status).toBe(201);
    expect(prismaMocks.savedSearch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ minMatchScore: 70, remoteOnly: true, sortBy: 'newest' }),
    });
  });

  it('rejects an array element over 80 chars or more than 10 entries', async () => {
    const long = await request(makeApp()).post('/').send({
      name: 'S', query: 'frontend', location: ['x'.repeat(81)],
    });
    expect(long.status).toBe(400);
    const many = await request(makeApp()).post('/').send({
      name: 'S', query: 'frontend', location: Array(11).fill('Berlin'),
    });
    expect(many.status).toBe(400);
    expect(prismaMocks.savedSearch.create).not.toHaveBeenCalled();
  });
});

// Wave 12 (T843) - intent storage on create/update, rename-only no-rewrite,
// and read-path derivation without write-back.
describe('saved-search intent persistence (T843)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId.value = 'user-1';
    prismaMocks.savedSearch.findUnique.mockResolvedValue(ownerSearch);
    prismaMocks.savedSearch.update.mockImplementation(async ({ data }: any) => ({ ...ownerSearch, ...data }));
    prismaMocks.savedSearch.create.mockImplementation(async ({ data }: any) => ({ id: 'search-new', ...data }));
  });

  it('creating with an intent stores the intent and the derived legacy fields (AC 3)', async () => {
    const intent = searchIntentSchema.parse({ roles: ['backend'], skills: ['react'] });
    const res = await request(makeApp()).post('/').send({ name: 'S', intent });
    expect(res.status).toBe(201);
    expect(prismaMocks.savedSearch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        query: 'backend react',
        location: null,
        company: null,
        sources: null,
        remoteOnly: false,
        intent,
      }),
    });
    expect(res.body.query).toBe('backend react');
    expect(res.body.intent).toEqual(intent);
  });

  it('creating with an intent and no query is accepted (query conditionally optional)', async () => {
    const intent = searchIntentSchema.parse({ roles: ['backend'] });
    const res = await request(makeApp()).post('/').send({ name: 'S', intent });
    expect(res.status).toBe(201);
    expect(res.body.query).toBe('backend');
  });

  it('creating with a legacy payload stores a derived intent and keeps legacy values verbatim (AC 2)', async () => {
    const res = await request(makeApp()).post('/').send({
      name: 'S',
      query: 'Senior Frontend -crypto',
      location: 'Remote',
      company: 'Acme',
      boards: ['board-1'],
    });
    expect(res.status).toBe(201);
    // The caller's string is NOT rewritten through a lossy round trip.
    expect(res.body.query).toBe('Senior Frontend -crypto');
    expect(res.body.location).toBe('Remote');
    expect(res.body.company).toBe('Acme');
    const [createArg] = prismaMocks.savedSearch.create.mock.calls[0];
    expect(createArg.data.intent).toEqual(
      legacyToIntent({
        query: 'Senior Frontend -crypto',
        location: 'Remote',
        company: 'Acme',
        sources: ['board-1'],
        remoteOnly: false,
      }),
    );
  });

  it('creating with neither a query nor a criteria-bearing intent is rejected', async () => {
    const missing = await request(makeApp()).post('/').send({ name: 'S' });
    expect(missing.status).toBe(400);
    const emptyQuery = await request(makeApp()).post('/').send({ name: 'S', query: '' });
    expect(emptyQuery.status).toBe(400);
    const emptyIntent = await request(makeApp()).post('/').send({
      name: 'S',
      intent: searchIntentSchema.parse({}),
    });
    expect(emptyIntent.status).toBe(400);
    expect(prismaMocks.savedSearch.create).not.toHaveBeenCalled();
  });

  it('creating with a legacy payload still rejects a missing query (min-1 preserved)', async () => {
    const res = await request(makeApp()).post('/').send({ name: 'S', location: 'Remote' });
    expect(res.status).toBe(400);
    expect(prismaMocks.savedSearch.create).not.toHaveBeenCalled();
  });

  it('a rename-only update leaves the intent untouched (spec edge case)', async () => {
    const stored = searchIntentSchema.parse({ roles: ['backend'] });
    prismaMocks.savedSearch.findUnique.mockResolvedValue({ ...ownerSearch, intent: stored });
    const res = await request(makeApp()).patch('/search-1').send({ name: 'New' });
    expect(res.status).toBe(200);
    const [updateArg] = prismaMocks.savedSearch.update.mock.calls[0];
    expect(updateArg.data).toEqual({ name: 'New' });
    expect(updateArg.data).not.toHaveProperty('intent');
  });

  it('a modifiers-only update leaves the intent untouched (T840 loss 5)', async () => {
    const stored = searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' });
    prismaMocks.savedSearch.findUnique.mockResolvedValue({
      ...ownerSearch,
      query: 'backend',
      minMatchScore: 10,
      sortBy: 'relevance',
      intent: stored,
    });
    const res = await request(makeApp()).patch('/search-1').send({ minMatchScore: 80 });
    expect(res.status).toBe(200);
    const [updateArg] = prismaMocks.savedSearch.update.mock.calls[0];
    expect(updateArg.data).toEqual({ minMatchScore: 80 });
    expect(updateArg.data).not.toHaveProperty('intent');
  });

  it('updating with an intent merges minMatchScore/sortBy from the existing row (T840 note)', async () => {
    prismaMocks.savedSearch.findUnique.mockResolvedValue({
      ...ownerSearch,
      query: 'old',
      minMatchScore: 80,
      sortBy: 'newest',
      intent: searchIntentSchema.parse({ roles: ['old'] }),
    });
    const intent = searchIntentSchema.parse({ roles: ['backend'] });
    const res = await request(makeApp()).patch('/search-1').send({ intent });
    expect(res.status).toBe(200);
    const [updateArg] = prismaMocks.savedSearch.update.mock.calls[0];
    expect(updateArg.data.query).toBe('backend');
    expect(updateArg.data.intent).toEqual(intent);
    // The intent cannot carry these - the row's values survive.
    expect(updateArg.data.minMatchScore).toBe(80);
    expect(updateArg.data.sortBy).toBe('newest');
  });

  it('an explicit minMatchScore overrides the row merge on an intent update', async () => {
    prismaMocks.savedSearch.findUnique.mockResolvedValue({
      ...ownerSearch,
      query: 'old',
      minMatchScore: 80,
      sortBy: 'newest',
      intent: searchIntentSchema.parse({ roles: ['old'] }),
    });
    const intent = searchIntentSchema.parse({ roles: ['backend'] });
    const res = await request(makeApp()).patch('/search-1').send({ intent, minMatchScore: 55 });
    expect(res.status).toBe(200);
    const [updateArg] = prismaMocks.savedSearch.update.mock.calls[0];
    expect(updateArg.data.minMatchScore).toBe(55);
    expect(updateArg.data.sortBy).toBe('newest');
  });

  it('GET derives a null-intent row on the fly without writing back (AC 5)', async () => {
    const stored = searchIntentSchema.parse({ roles: ['backend'] });
    prismaMocks.savedSearch.findMany.mockResolvedValue([
      { id: 'legacy', userId: 'user-1', name: 'Legacy', query: 'frontend', intent: null },
      { id: 'rich', userId: 'user-1', name: 'Rich', query: 'backend', intent: stored },
    ]);
    const res = await request(makeApp()).get('/');
    expect(res.status).toBe(200);
    const legacy = res.body.find((r: any) => r.id === 'legacy');
    expect(legacy.intent).toEqual(legacyToIntent({ query: 'frontend' }));
    const rich = res.body.find((r: any) => r.id === 'rich');
    expect(rich.intent).toEqual(stored);
    expect(prismaMocks.savedSearch.update).not.toHaveBeenCalled();
  });
});
