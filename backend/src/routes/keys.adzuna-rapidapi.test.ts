import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    aIProviderKey: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

// Real keyManager (lease path) over a mocked prisma client; real crypto.
vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

import keysRouter from './keys.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/keys', keysRouter);
  return app;
}

describe('keys creation validation for adzuna + rapidapi (D8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.ADZUNA_API_KEY;
    delete process.env.RAPIDAPI_API_KEY;
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    // No stored keys, so the creation-time probe lease resolves to null.
    prismaMocks.aIProviderKey.findMany.mockResolvedValue([]);
    prismaMocks.aIProviderKey.create.mockImplementation(async ({ data }: any) => ({
      id: 'new-key-id',
      ...data,
      isActive: true,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a colon-less adzuna key with guidance and no key material in the response', async () => {
    const raw = 'singlekeywithoutcolon';
    const res = await request(makeApp()).post('/keys').send({ provider: 'adzuna', apiKey: raw });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('appId:appKey');
    expect(JSON.stringify(res.body)).not.toContain(raw);
    expect(prismaMocks.aIProviderKey.create).not.toHaveBeenCalled();
  });

  it('rejects an adzuna key with an empty half ("id:" / ":key")', async () => {
    for (const bad of ['only-id-here:', ':only-key-here']) {
      const res = await request(makeApp()).post('/keys').send({ provider: 'adzuna', apiKey: bad });
      expect(res.status).toBe(400);
    }
    expect(prismaMocks.aIProviderKey.create).not.toHaveBeenCalled();
  });

  it('stores a well-formed adzuna "appId:appKey" key as validated', async () => {
    const res = await request(makeApp())
      .post('/keys')
      .send({ provider: 'adzuna', apiKey: 'my-app-id:my-app-key' });
    expect(res.status).toBe(201);
    expect(res.body.provider).toBe('adzuna');
    expect(res.body.lastValidatedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('my-app-id:my-app-key');
  });

  it('stores a rapidapi key as validated when the JSearch probe succeeds', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );
    const res = await request(makeApp())
      .post('/keys')
      .send({ provider: 'rapidapi', apiKey: 'rapidapi-key-123456' });
    expect(res.status).toBe(201);
    expect(res.body.lastValidatedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain('rapidapi-key-123456');
    const probeUrl = seen.find((u) => u.includes('jsearch.p.rapidapi.com'));
    expect(probeUrl).toBeDefined();
    expect(probeUrl).toContain('/search-v2');
  });

  it('stores a rapidapi key WITHOUT the validated stamp when JSearch rejects it (wrong subscription)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    const res = await request(makeApp())
      .post('/keys')
      .send({ provider: 'rapidapi', apiKey: 'rapidapi-key-123456' });
    expect(res.status).toBe(201);
    expect(res.body.lastValidatedAt).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('rapidapi-key-123456');
  });
});
