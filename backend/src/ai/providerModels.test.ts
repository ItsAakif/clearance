import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAppSetting } = vi.hoisted(() => ({
  mockAppSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: { appSetting: mockAppSetting } }));

import {
  getProviderModel,
  setProviderModel,
  clearProviderModel,
  getAllProviderModelSettings,
  invalidateProviderModelCache,
  runLlmCompletion,
  LlmModelError,
  DEFAULT_MODELS,
} from './providerModels.js';

describe('providerModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProviderModelCache();
    mockAppSetting.findUnique.mockResolvedValue(null);
  });

  it('returns the DB override even when an env override is supplied', async () => {
    mockAppSetting.findUnique.mockResolvedValue({ key: 'model:groq', value: 'custom-groq' });
    await expect(getProviderModel('groq', { envOverride: 'env-model' })).resolves.toBe('custom-groq');
  });

  it('falls back to env override when no DB row exists', async () => {
    await expect(getProviderModel('groq', { envOverride: 'env-model' })).resolves.toBe('env-model');
  });

  it('falls back to the provider default when nothing is set', async () => {
    await expect(getProviderModel('openai')).resolves.toBe(DEFAULT_MODELS.openai);
  });

  it('trims blank DB/env values and falls through', async () => {
    mockAppSetting.findUnique.mockResolvedValue({ key: 'model:groq', value: '   ' });
    await expect(getProviderModel('groq', { envOverride: '  ' })).resolves.toBe(DEFAULT_MODELS.groq);
  });

  it('normalizes unknown providers to groq', async () => {
    await expect(getProviderModel('anthropic')).resolves.toBe(DEFAULT_MODELS.groq);
  });

  it('caches DB reads within the TTL', async () => {
    await getProviderModel('groq');
    await getProviderModel('groq');
    expect(mockAppSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidateProviderModelCache', async () => {
    await getProviderModel('groq');
    invalidateProviderModelCache('groq');
    await getProviderModel('groq');
    expect(mockAppSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it('setProviderModel upserts model:<provider> and invalidates the cache', async () => {
    await setProviderModel('groq', '  new-model  ');
    expect(mockAppSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'model:groq' },
      create: { key: 'model:groq', value: 'new-model' },
      update: { value: 'new-model' },
    });
    await getProviderModel('groq');
    expect(mockAppSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('clearProviderModel deletes model:<provider>', async () => {
    await clearProviderModel('openai');
    expect(mockAppSetting.deleteMany).toHaveBeenCalledWith({ where: { key: 'model:openai' } });
  });

  it('swallows DB errors and returns the default without caching', async () => {
    mockAppSetting.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(getProviderModel('gemini')).resolves.toBe(DEFAULT_MODELS.gemini);
    await getProviderModel('gemini');
    expect(mockAppSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it('getAllProviderModelSettings returns effective, overrides and defaults', async () => {
    mockAppSetting.findUnique.mockImplementation(async ({ where }: any) =>
      where.key === 'model:groq' ? { key: where.key, value: 'custom-groq' } : null
    );
    const settings = await getAllProviderModelSettings();
    expect(settings.models.groq).toBe('custom-groq');
    expect(settings.overrides).toEqual({ groq: 'custom-groq' });
    expect(settings.defaults).toEqual(DEFAULT_MODELS);
    expect(Object.keys(settings.models).sort()).toEqual(['gemini', 'groq', 'openai', 'openrouter']);
  });

  it('runLlmCompletion wraps errors with provider+model and preserves status/code', async () => {
    const cause = Object.assign(new Error('rate limit exceeded'), { status: 429, code: 'rate_limit_exceeded' });
    try {
      await runLlmCompletion('groq', 'dead-model', async () => { throw cause; });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmModelError);
      const e = error as LlmModelError;
      expect(e.message).toContain('provider=groq');
      expect(e.message).toContain('model=dead-model');
      expect(e.message).toContain('rate limit exceeded');
      expect(e.status).toBe(429);
      expect(e.code).toBe('rate_limit_exceeded');
    }
  });
});
