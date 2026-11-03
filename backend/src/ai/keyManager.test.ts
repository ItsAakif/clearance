import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    aIProviderKey: { findMany: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

// Passthrough decryption so leased key values are observable.
vi.mock('../lib/crypto.js', () => ({ decryptSecret: (s: string) => s }));

import { isLlmProvider, leaseNextLlmKey, leaseNextKey } from './keyManager.js';
import { LLM_PROVIDER_IDS } from './providerRegistry.js';

describe('keyManager extended LLM provider set', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.aIProviderKey.findMany.mockResolvedValue([]);
    prismaMocks.aIProviderKey.update.mockResolvedValue({});
  });

  it('recognizes all 13 registry providers as LLM providers', () => {
    expect(LLM_PROVIDER_IDS).toHaveLength(13);
    for (const id of LLM_PROVIDER_IDS) {
      expect(isLlmProvider(id)).toBe(true);
    }
    // groq/openai/openrouter/gemini stay first for fallback stability.
    expect(LLM_PROVIDER_IDS.slice(0, 4)).toEqual(['groq', 'openai', 'openrouter', 'gemini']);
  });

  it('treats any custom:<slug> id as an LLM provider', () => {
    expect(isLlmProvider('custom:my-llm')).toBe(true);
    expect(isLlmProvider('custom:LOCALHOST-1'.toLowerCase())).toBe(true);
  });

  it('rejects non-LLM and unknown providers', () => {
    for (const p of ['tavily', 'exa', 'adzuna', 'skynet', '']) {
      expect(isLlmProvider(p)).toBe(false);
    }
  });

  it('leaseNextLlmKey honors a custom:<slug> preferred provider', async () => {
    prismaMocks.aIProviderKey.findMany.mockImplementation(async ({ where }: any) =>
      where.provider === 'custom:my-llm'
        ? [{ id: 'k1', apiKey: 'secret', provider: 'custom:my-llm', userId: 'u1', label: '{"baseUrl":"https://h:1234/v1"}' }]
        : []
    );
    const key = await leaseNextLlmKey('u1', 'custom:my-llm');
    expect(key.provider).toBe('custom:my-llm');
    expect(key.apiKey).toBe('secret');
  });

  it('leaseNextKey falls back to env keys when the DB is empty', async () => {
    process.env.ZAI_API_KEY = 'zai-env-key';
    try {
      const key = await leaseNextKey('zai');
      expect(key.source).toBe('env');
      expect(key.apiKey).toBe('zai-env-key');
    } finally {
      delete process.env.ZAI_API_KEY;
    }
  });

  it('D2: user-scoped leases AND the rate-limit filter with the user scope (no overwrite)', async () => {
    delete process.env.RAPIDAPI_API_KEY;
    await leaseNextKey('rapidapi', 'user-1').catch(() => {});
    expect(prismaMocks.aIProviderKey.findMany).toHaveBeenCalledTimes(1);
    const where = prismaMocks.aIProviderKey.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.provider).toBe('rapidapi');
    expect(where.isActive).toBe(true);
    // Both conditions must be present as a conjunction - the old code assigned
    // where.OR twice, dropping the rate-limit clause for user leases.
    expect(Array.isArray(where.AND)).toBe(true);
    const flat = JSON.stringify(where);
    expect(flat).toContain('rateLimitedUntil');
    expect(flat).toContain('user-1');
    expect(where.OR).toBeUndefined();
  });

  it('D2: unscoped leases still filter out rate-limited keys', async () => {
    delete process.env.RAPIDAPI_API_KEY;
    await leaseNextKey('rapidapi').catch(() => {});
    const where = prismaMocks.aIProviderKey.findMany.mock.calls[0][0].where as Record<string, unknown>;
    const flat = JSON.stringify(where);
    expect(flat).toContain('rateLimitedUntil');
    expect(flat).not.toContain('user-1');
  });
});
