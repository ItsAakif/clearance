import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks } = vi.hoisted(() => ({
  authState: { enabled: true },
  prismaMocks: {
    appSetting: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  },
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

import settingsRouter from './settings.js';
import { invalidateProviderModelCache } from '../ai/providerModels.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', settingsRouter);
  return app;
}

describe('settings models route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.enabled = true;
    invalidateProviderModelCache();
    prismaMocks.appSetting.findUnique.mockResolvedValue(null);
    prismaMocks.appSetting.upsert.mockResolvedValue({});
    prismaMocks.appSetting.deleteMany.mockResolvedValue({ count: 0 });
  });

  it('GET returns effective models, overrides and defaults (contract shape)', async () => {
    const res = await request(makeApp()).get('/models');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['defaults', 'models', 'overrides']);
    expect(Object.keys(res.body.models).sort()).toEqual([
      'anthropic', 'azure-openai', 'deepseek', 'fireworks', 'gemini', 'groq',
      'lmstudio', 'mistral', 'ollama', 'openai', 'openrouter', 'together', 'zai',
    ]);
    expect(Object.keys(res.body.defaults).sort()).toEqual([
      'anthropic', 'azure-openai', 'deepseek', 'fireworks', 'gemini', 'groq',
      'lmstudio', 'mistral', 'ollama', 'openai', 'openrouter', 'together', 'zai',
    ]);
    expect(res.body.models.groq).toBe('llama-3.3-70b-versatile');
  });

  it('GET reflects a stored override', async () => {
    prismaMocks.appSetting.findUnique.mockImplementation(async ({ where }: any) =>
      where.key === 'model:groq' ? { key: where.key, value: 'custom' } : null
    );
    const res = await request(makeApp()).get('/models');
    expect(res.body.models.groq).toBe('custom');
    expect(res.body.overrides).toEqual({ groq: 'custom' });
  });

  it('PUT persists a valid model', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { groq: 'llama-3.3-70b-versatile' } });
    expect(res.status).toBe(200);
    expect(prismaMocks.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'model:groq' },
      create: { key: 'model:groq', value: 'llama-3.3-70b-versatile' },
      update: { value: 'llama-3.3-70b-versatile' },
    });
  });

  it('PUT with an empty string clears the override', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { groq: '' } });
    expect(res.status).toBe(200);
    expect(prismaMocks.appSetting.deleteMany).toHaveBeenCalledWith({ where: { key: 'model:groq' } });
    expect(prismaMocks.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('rejects model IDs with spaces', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { groq: 'bad model' } });
    expect(res.status).toBe(400);
    expect(prismaMocks.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('rejects model IDs longer than 200 chars', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { openai: 'a'.repeat(201) } });
    expect(res.status).toBe(400);
  });

  it('rejects unknown providers', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { skynet: 'claude-3' } });
    expect(res.status).toBe(400);
  });

  it('accepts registry providers (e.g. anthropic)', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { anthropic: 'claude-sonnet-4-6' } });
    expect(res.status).toBe(200);
  });

  it('rejects an empty models object', async () => {
    const res = await request(makeApp()).put('/models').send({ models: {} });
    expect(res.status).toBe(400);
  });

  it('rejects unknown top-level fields', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { groq: 'x' }, evil: true });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    authState.enabled = false;
    expect((await request(makeApp()).get('/models')).status).toBe(401);
    expect((await request(makeApp()).put('/models').send({ models: { groq: 'x' } })).status).toBe(401);
  });
});
