import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks } = vi.hoisted(() => ({
  authState: { enabled: true },
  prismaMocks: {
    aIProviderKey: { findFirst: vi.fn() },
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

// Passthrough decryption so stored-key resolution is testable without secrets.
vi.mock('../lib/crypto.js', () => ({
  decryptSecret: (s: string) => `dec:${s}`,
  encryptSecret: (s: string) => s,
  maskKey: (s: string) => `…${s.slice(-4)}`,
}));

import providersRouter from './providers.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', providersRouter);
  return app;
}

const fetchMock = vi.fn();

describe('providers route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.enabled = true;
    prismaMocks.aIProviderKey.findFirst.mockResolvedValue(null);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires authentication', async () => {
    authState.enabled = false;
    expect((await request(makeApp()).get('/')).status).toBe(401);
    expect((await request(makeApp()).post('/groq/models').send({})).status).toBe(401);
  });

  it('GET returns the 13 presets without secrets', async () => {
    const res = await request(makeApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(13);
    const ids = res.body.map((p: any) => p.id).sort();
    expect(ids).toContain('anthropic');
    expect(ids).toContain('azure-openai');
    expect(ids).toContain('ollama');
    for (const p of res.body) {
      expect(Object.keys(p).sort()).toEqual(
        ['authStyle', 'baseUrl', 'defaultModel', 'fetchModels', 'group', 'id', 'keyPrefix', 'label', 'presetModels', 'protocol']
      );
      expect(JSON.stringify(p)).not.toMatch(/apiKey|decrypt|secret/i);
    }
  });

  it('POST with an unknown provider returns 404', async () => {
    const res = await request(makeApp()).post('/skynet/models').send({});
    expect(res.status).toBe(404);
  });

  it('POST with a malformed custom id returns 400', async () => {
    const res = await request(makeApp()).post('/custom:Bad_Slug!/models').send({});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST requires a key when the provider needs auth', async () => {
    const res = await request(makeApp()).post('/groq/models').send({});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST proxies openai-list with a body key (Bearer)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'llama-x' }, { id: 'llama-y' }] }),
    });
    const res = await request(makeApp()).post('/groq/models').send({ apiKey: 'gsk-test' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ['llama-x', 'llama-y'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/models');
    expect(init.headers.Authorization).toBe('Bearer gsk-test');
  });

  it('POST resolves the stored key server-side and never returns it', async () => {
    prismaMocks.aIProviderKey.findFirst.mockResolvedValue({
      apiKey: 'enc-stored',
      label: null,
      provider: 'openai',
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'gpt-x' }] }) });
    const res = await request(makeApp()).post('/openai/models').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ['gpt-x'] });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer dec:enc-stored');
    expect(JSON.stringify(res.body)).not.toContain('dec:enc-stored');
  });

  it('POST attaches gemini keys via ?key= and strips the models/ prefix', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'models/gemini-2.0-flash' }] }),
    });
    const res = await request(makeApp()).post('/gemini/models').send({ apiKey: 'AIza-test' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ['gemini-2.0-flash'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('key=AIza-test');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('POST normalizes ollama tags without any key', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.3:latest' }] }),
    });
    const res = await request(makeApp()).post('/ollama/models').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ['llama3.3:latest'] });
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
  });

  it('POST sends anthropic x-api-key + version headers', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'claude-x' }] }) });
    const res = await request(makeApp()).post('/anthropic/models').send({ apiKey: 'sk-ant-test' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ['claude-x'] });
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('POST answers zai/azure from presets without fetching', async () => {
    const zai = await request(makeApp()).post('/zai/models').send({});
    expect(zai.status).toBe(200);
    expect(zai.body.models).toContain('glm-5.2');
    const azure = await request(makeApp()).post('/azure-openai/models').send({});
    expect(azure.status).toBe(200);
    expect(azure.body).toEqual({ models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST maps provider failures to 502 without key material', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const res = await request(makeApp()).post('/groq/models').send({ apiKey: 'gsk-secret-xyz' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('groq');
    expect(JSON.stringify(res.body)).not.toContain('gsk-secret-xyz');
  });

  it('POST maps network errors to 502', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    const res = await request(makeApp()).post('/deepseek/models').send({ apiKey: 'sk-x' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('deepseek');
  });

  it('POST custom provider without a stored base URL returns 400', async () => {
    const res = await request(makeApp()).post('/custom:my-llm/models').send({ apiKey: 'k' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST custom provider uses the stored label base URL', async () => {
    prismaMocks.aIProviderKey.findFirst.mockResolvedValue({
      apiKey: 'enc-custom',
      label: '{"baseUrl":"https://my-host:1234/v1"}',
      provider: 'custom:my-llm',
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'm1' }] }) });
    const res = await request(makeApp()).post('/custom:my-llm/models').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ models: ['m1'] });
    expect(fetchMock.mock.calls[0][0]).toBe('https://my-host:1234/v1/models');
  });
});
