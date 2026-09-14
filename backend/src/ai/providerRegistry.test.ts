import { describe, it, expect } from 'vitest';
import {
  PROVIDER_PRESETS,
  LLM_PROVIDER_IDS,
  getProviderPreset,
  getProviderBaseUrl,
  resolveKeyBaseUrl,
  buildCustomProvider,
  getCustomBaseUrl,
  encodeCustomBaseUrlLabel,
  isCustomProviderId,
  isValidCustomProviderId,
  slugifyCustomProviderName,
  normalizeModelList,
} from './providerRegistry.js';

describe('providerRegistry', () => {
  it('exposes exactly the 13 expected providers', () => {
    expect(PROVIDER_PRESETS).toHaveLength(13);
    expect(LLM_PROVIDER_IDS).toHaveLength(13);
    expect(new Set(LLM_PROVIDER_IDS).size).toBe(13);
    for (const id of LLM_PROVIDER_IDS) {
      expect(getProviderPreset(id)?.id, id).toBe(id);
    }
  });

  it('keeps groq/openai/openrouter/gemini first for fallback stability', () => {
    expect(LLM_PROVIDER_IDS.slice(0, 4)).toEqual(['groq', 'openai', 'openrouter', 'gemini']);
  });

  it('resolves base URLs for every provider', () => {
    expect(getProviderBaseUrl('groq')).toBe('https://api.groq.com/openai/v1');
    expect(getProviderBaseUrl('openai')).toBe('https://api.openai.com/v1');
    expect(getProviderBaseUrl('openrouter')).toBe('https://openrouter.ai/api/v1');
    expect(getProviderBaseUrl('gemini')).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(getProviderBaseUrl('anthropic')).toBe('https://api.anthropic.com/v1');
    expect(getProviderBaseUrl('zai')).toBe('https://api.z.ai/api/paas/v4');
    expect(getProviderBaseUrl('deepseek')).toBe('https://api.deepseek.com');
    expect(getProviderBaseUrl('mistral')).toBe('https://api.mistral.ai/v1');
    expect(getProviderBaseUrl('together')).toBe('https://api.together.xyz/v1');
    expect(getProviderBaseUrl('fireworks')).toBe('https://api.fireworks.ai/inference/v1');
    expect(getProviderBaseUrl('ollama')).toBe('http://localhost:11434/v1');
    expect(getProviderBaseUrl('lmstudio')).toBe('http://localhost:1234/v1');
  });

  it('resolves protocols (only anthropic is non-OpenAI)', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.protocol, p.id).toBe(p.id === 'anthropic' ? 'anthropic' : 'openai');
    }
  });

  it('has non-empty defaults except azure-openai/lmstudio (user deployments/loaded models)', () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.id === 'azure-openai' || p.id === 'lmstudio') {
        expect(p.defaultModel, p.id).toBe('');
      } else {
        expect(p.defaultModel.length, p.id).toBeGreaterThan(0);
      }
      expect(p.presetModels.length, p.id).toBeLessThanOrEqual(5);
    }
    expect(getProviderPreset('groq')?.defaultModel).toBe('llama-3.3-70b-versatile');
    expect(getProviderPreset('openai')?.defaultModel).toBe('gpt-4o-mini');
    expect(getProviderPreset('gemini')?.defaultModel).toBe('gemini-2.0-flash');
  });

  it('marks zai/azure as fetchModels:false with no endpoint, others fetchable', () => {
    expect(getProviderPreset('zai')?.fetchModels).toBe(false);
    expect(getProviderPreset('azure-openai')?.fetchModels).toBe(false);
    expect(getProviderPreset('zai')?.modelsEndpoint).toBeUndefined();
    for (const p of PROVIDER_PRESETS) {
      if (p.fetchModels) expect(p.modelsEndpoint?.url, p.id).toMatch(/^https?:\/\//);
    }
  });

  it('falls back to the OpenAI base URL for unknown providers', () => {
    expect(getProviderBaseUrl('skynet')).toBe('https://api.openai.com/v1');
  });

  it('resolves custom + azure base URLs from the stored label', () => {
    const label = encodeCustomBaseUrlLabel('https://my-host:1234/v1');
    expect(getProviderBaseUrl('custom:my-llm', 'https://my-host:1234/v1')).toBe('https://my-host:1234/v1');
    expect(resolveKeyBaseUrl('custom:my-llm', label)).toBe('https://my-host:1234/v1');
    expect(resolveKeyBaseUrl('azure-openai', label)).toBe('https://my-host:1234/v1');
    expect(resolveKeyBaseUrl('groq', label)).toBe('https://api.groq.com/openai/v1');
  });

  it('validates custom provider ids and slugs', () => {
    expect(isCustomProviderId('custom:my-llm')).toBe(true);
    expect(isCustomProviderId('groq')).toBe(false);
    expect(isValidCustomProviderId('custom:my-llm-123')).toBe(true);
    expect(isValidCustomProviderId('custom:Bad_Slug!')).toBe(false);
    expect(isValidCustomProviderId('custom:')).toBe(false);
    expect(isValidCustomProviderId('groq')).toBe(false);
    expect(slugifyCustomProviderName('My LLM Server!')).toBe('my-llm-server');
  });

  it('parses the label base-URL convention (JSON or bare URL)', () => {
    expect(getCustomBaseUrl('{"baseUrl":"https://h:1234/v1"}')).toBe('https://h:1234/v1');
    expect(getCustomBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(getCustomBaseUrl('My Display Name')).toBeNull();
    expect(getCustomBaseUrl(null)).toBeNull();
    expect(getCustomBaseUrl('{"baseUrl":"not a url"}')).toBeNull();
  });

  it('builds ad-hoc custom presets', () => {
    const p = buildCustomProvider('my-llm', 'https://h:1234/v1/');
    expect(p.id).toBe('custom:my-llm');
    expect(p.baseUrl).toBe('https://h:1234/v1');
    expect(p.protocol).toBe('openai');
    expect(p.modelsEndpoint?.url).toBe('https://h:1234/v1/models');
  });

  it('normalizes openai-list payloads (incl. bare arrays)', () => {
    expect(normalizeModelList('openai-list', { data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] })).toEqual([
      'a',
      'b',
    ]);
    expect(normalizeModelList('openai-list', [{ id: 'x' }])).toEqual(['x']);
    expect(normalizeModelList('anthropic-list', { data: [{ id: 'claude-x' }] })).toEqual(['claude-x']);
  });

  it('strips the models/ prefix for gemini-list', () => {
    expect(
      normalizeModelList('gemini-list', { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'gemini-x' }] })
    ).toEqual(['gemini-2.0-flash', 'gemini-x']);
  });

  it('reads tag names for ollama-tags', () => {
    expect(
      normalizeModelList('ollama-tags', { models: [{ name: 'llama3.3:latest' }, { name: 'qwen3:8b' }] })
    ).toEqual(['llama3.3:latest', 'qwen3:8b']);
  });

  it('returns [] for garbage payloads', () => {
    expect(normalizeModelList('openai-list', null)).toEqual([]);
    expect(normalizeModelList('gemini-list', {})).toEqual([]);
    expect(normalizeModelList('ollama-tags', { models: 'nope' })).toEqual([]);
  });
});
