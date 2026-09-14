// Unified LLM provider registry — single source of truth for provider metadata.
// Replaces the ~10 duplicated provider→baseURL chains scattered across
// evaluation.ts, resumeGenerator.ts, interviewGenerator.ts, matchEnhancer.ts,
// llmEvaluator.ts, improver.ts, refiner.ts, resume/parser.ts, profile/parser.ts
// and routes/tailor.ts. Import getProviderBaseUrl()/buildOpenAiClient() from
// here instead of adding another inline switch.
//
// Preset data (base URLs, key prefixes, flagship models) follows the provider
// survey in .planning/specs/provider-picker-research.md §7. Model catalogs
// change fast — the UI must always prefer the live /models fetch over these
// presets; presets are a fallback for offline/error cases (and the only
// source for providers without a reliable list endpoint: z.ai, Azure).

import OpenAI from 'openai';

export type ProviderAuthStyle = 'bearer' | 'query' | 'header' | 'none';
export type ProviderProtocol = 'openai' | 'anthropic';
export type ModelsNormalizer = 'openai-list' | 'gemini-list' | 'anthropic-list' | 'ollama-tags';

export interface ProviderModelsEndpoint {
  /** Absolute URL of the provider's list-models endpoint. */
  url: string;
  /** How the API key is attached to the list-models call. */
  auth: ProviderAuthStyle;
  /** Response-shape normalizer (see normalizeModelList). */
  normalizer: ModelsNormalizer;
}

export interface ProviderPreset {
  id: string;
  label: string;
  /**
   * OpenAI-compatible chat-completions base URL. Empty for providers whose
   * endpoint is per-account/deployment (azure-openai: resolved from the
   * stored key label, see CUSTOM_BASE_URL_LABEL_DOC below).
   */
  baseUrl: string;
  /** Key prefix hint only — never a hard validation gate (prefixes change). */
  keyPrefix?: string;
  authStyle: ProviderAuthStyle;
  protocol: ProviderProtocol;
  /** Built-in default model ('' = user must pick one, e.g. Azure deployments). */
  defaultModel: string;
  /** Curated fallback model list (2-5 names from the research survey §7). */
  presetModels: string[];
  /** False when the provider has no reliable list endpoint (z.ai, Azure). */
  fetchModels: boolean;
  modelsEndpoint?: ProviderModelsEndpoint;
  /** Frontend grouping for the "Add provider" dialog. */
  group: 'recommended' | 'local' | 'other';
}

const OPENAI_LIST = 'openai-list' as const;

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyPrefix: 'gsk_',
    authStyle: 'bearer',
    protocol: 'openai',
    defaultModel: 'llama-3.3-70b-versatile',
    presetModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'openai/gpt-oss-120b',
    ],
    fetchModels: true,
    modelsEndpoint: { url: 'https://api.groq.com/openai/v1/models', auth: 'bearer', normalizer: OPENAI_LIST },
    group: 'recommended',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyPrefix: 'sk-',
    authStyle: 'bearer',
    protocol: 'openai',
    defaultModel: 'gpt-4o-mini',
    presetModels: ['gpt-4o-mini', 'gpt-5.4', 'gpt-6-astra'],
    fetchModels: true,
    modelsEndpoint: { url: 'https://api.openai.com/v1/models', auth: 'bearer', normalizer: OPENAI_LIST },
    group: 'recommended',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPrefix: 'sk-or-v1-',
    authStyle: 'bearer',
    protocol: 'openai',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    presetModels: [
      'meta-llama/llama-3.3-70b-instruct',
      'openai/gpt-4o-mini',
      'anthropic/claude-opus-4-6',
      'google/gemini-3.x',
    ],
    fetchModels: true,
    // Public endpoint — no auth required, but sending the key is harmless.
    modelsEndpoint: { url: 'https://openrouter.ai/api/v1/models', auth: 'bearer', normalizer: OPENAI_LIST },
    group: 'recommended',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyPrefix: 'AIza',
    authStyle: 'query',
    protocol: 'openai',
    defaultModel: 'gemini-2.0-flash',
    presetModels: [
      'gemini-2.0-flash',
      'gemini-3.5-flash',
      'gemini-3.1-pro-preview',
      'gemini-3-flash-preview',
      'gemini-3.5-flash-lite',
    ],
    fetchModels: true,
    modelsEndpoint: {
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      auth: 'query',
      normalizer: 'gemini-list',
    },
    group: 'recommended',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyPrefix: 'sk-ant-',
    // x-api-key + anthropic-version headers (NOT Bearer) — see providerModels
    // AnthropicChatClient, which implements the /v1/messages protocol.
    authStyle: 'header',
    protocol: 'anthropic',
    defaultModel: 'claude-sonnet-4-6',
    presetModels: ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-5'],
    fetchModels: true,
    modelsEndpoint: { url: 'https://api.anthropic.com/v1/models', auth: 'header', normalizer: 'anthropic-list' },
    group: 'recommended',
  },
  {
    id: 'zai',
    label: 'Z.ai (Zhipu)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    authStyle: 'bearer',
    protocol: 'openai',
    defaultModel: 'glm-5.2',
    // /paas/v4/models exists but is unreliable (returns coding-only models),
    // so the catalog is hardcoded and fetchModels is false.
    presetModels: ['glm-5.3', 'glm-5.2', 'glm-4.7', 'glm-4.7-flash'],
    fetchModels: false,
    group: 'other',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    authStyle: 'bearer',
    protocol: 'openai',
    defaultModel: 'deepseek-v4-pro',
    presetModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    fetchModels: true,
    modelsEndpoint: { url: 'https://api.deepseek.com/models', auth: 'bearer', normalizer: OPENAI_LIST },
    group: 'other',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    defaultModel: 'mistral-small-latest',
    presetModels: ['mistral-large-latest', 'mistral-medium-2508', 'mistral-small-latest', 'codestral-2501'],
    fetchModels: true,
    modelsEndpoint: { url: 'https://api.mistral.ai/v1/models', auth: 'bearer', normalizer: OPENAI_LIST },
    group: 'other',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    defaultModel: 'deepseek-ai/DeepSeek-V4-Pro',
    presetModels: [
      'deepseek-ai/DeepSeek-V4-Pro',
      'deepseek-ai/DeepSeek-V4-Flash-0731',
      'Qwen/Qwen3.8-2.4T-A95B',
      'moonshotai/Kimi-K3',
    ],
    fetchModels: true,
    modelsEndpoint: { url: 'https://api.together.xyz/v1/models', auth: 'bearer', normalizer: OPENAI_LIST },
    group: 'other',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    authStyle: 'bearer',
    protocol: 'openai',
    defaultModel: 'accounts/fireworks/models/deepseek-v3p1',
    presetModels: [
      'accounts/fireworks/models/deepseek-v3p1',
      'accounts/fireworks/models/glm-5p2',
      'accounts/fireworks/models/llama-v3p1-8b-instruct',
    ],
    fetchModels: true,
    modelsEndpoint: {
      url: 'https://api.fireworks.ai/inference/v1/models',
      auth: 'bearer',
      normalizer: OPENAI_LIST,
    },
    group: 'other',
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    // Per-resource endpoint — resolved per key from the stored label
    // (see CUSTOM_BASE_URL_LABEL_DOC). Models are the user's deployment
    // names, so there is nothing to fetch: manual model input only.
    baseUrl: '',
    authStyle: 'header',
    protocol: 'openai',
    defaultModel: '',
    presetModels: [],
    fetchModels: false,
    group: 'other',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    authStyle: 'none',
    protocol: 'openai',
    defaultModel: 'llama3.3',
    presetModels: ['llama3.3', 'qwen3:8b', 'deepseek-r1', 'gemma4'],
    fetchModels: true,
    modelsEndpoint: { url: 'http://localhost:11434/api/tags', auth: 'none', normalizer: 'ollama-tags' },
    group: 'local',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    authStyle: 'none',
    protocol: 'openai',
    // Whatever is currently loaded — the user must pick from the fetched list.
    defaultModel: '',
    presetModels: [],
    fetchModels: true,
    modelsEndpoint: { url: 'http://localhost:1234/v1/models', auth: 'none', normalizer: OPENAI_LIST },
    group: 'local',
  },
];

/**
 * Fallback order for automatic key leasing. groq/openai/openrouter/gemini
 * stay first for historical fallback stability, then the rest.
 */
export const LLM_PROVIDER_IDS: string[] = [
  'groq',
  'openai',
  'openrouter',
  'gemini',
  'anthropic',
  'zai',
  'deepseek',
  'mistral',
  'together',
  'fireworks',
  'azure-openai',
  'ollama',
  'lmstudio',
];

const PRESET_MAP: Record<string, ProviderPreset> = Object.fromEntries(
  PROVIDER_PRESETS.map((p) => [p.id, p])
);

export function getProviderPreset(provider: string): ProviderPreset | undefined {
  if (!provider) return undefined;
  return PRESET_MAP[provider.toLowerCase()];
}

// ==================== CUSTOM PROVIDERS ====================

export const CUSTOM_PROVIDER_PREFIX = 'custom:';
const CUSTOM_SLUG_RE = /^[a-z0-9-]{1,40}$/;

export function isCustomProviderId(provider: string): boolean {
  return provider.startsWith(CUSTOM_PROVIDER_PREFIX);
}

/** Validate a full `custom:<slug>` provider id. */
export function isValidCustomProviderId(provider: string): boolean {
  if (!isCustomProviderId(provider)) return false;
  return CUSTOM_SLUG_RE.test(provider.slice(CUSTOM_PROVIDER_PREFIX.length));
}

/** Derive a storage slug from a free-text display name (`My Provider` → `my-provider`). */
export function slugifyCustomProviderName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * CUSTOM BASE-URL STORAGE CONVENTION (CUSTOM_BASE_URL_LABEL_DOC):
 *
 * AIProviderKey has no dedicated base-URL column, so providers whose endpoint
 * is per-account (custom OpenAI-compatible servers, Azure OpenAI resources)
 * persist their base URL inside AIProviderKey.label as compact JSON:
 *
 *   {"baseUrl":"https://my-host:1234/v1"}
 *
 * This fits the 50-char label limit for typical host URLs. getCustomBaseUrl()
 * also accepts a bare `http(s)://…` label for forward compatibility. The
 * display name is derived from the provider id slug (`custom:my-llm` →
 * "My Llm"); the label is reserved for the machine-readable base URL.
 */
export function getCustomBaseUrl(label: string | null | undefined): string | null {
  if (!label) return null;
  const trimmed = label.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const baseUrl = (parsed as { baseUrl?: unknown }).baseUrl;
      if (typeof baseUrl === 'string' && /^https?:\/\//i.test(baseUrl.trim())) {
        return baseUrl.trim();
      }
    }
  } catch {
    // Not JSON — fall through to null.
  }
  return null;
}

/** Serialize a base URL into the AIProviderKey.label convention above. */
export function encodeCustomBaseUrlLabel(baseUrl: string): string {
  return JSON.stringify({ baseUrl: baseUrl.trim() });
}

/** Build an ad-hoc preset for a custom provider (OpenAI-compatible protocol). */
export function buildCustomProvider(slug: string, baseUrl: string): ProviderPreset {
  const cleanBase = baseUrl.trim().replace(/\/+$/, '');
  return {
    id: `${CUSTOM_PROVIDER_PREFIX}${slug}`,
    label: slug,
    baseUrl: cleanBase,
    authStyle: 'bearer',
    protocol: 'openai',
    defaultModel: '',
    presetModels: [],
    fetchModels: true,
    modelsEndpoint: { url: `${cleanBase}/models`, auth: 'bearer', normalizer: OPENAI_LIST },
    group: 'other',
  };
}

// ==================== BASE URL RESOLUTION ====================

const OPENAI_FALLBACK_BASE_URL = 'https://api.openai.com/v1';

/**
 * Resolve the chat-completions base URL for a provider.
 * @param customBaseUrl required for `custom:*` ids and azure-openai
 * (per-resource endpoints); falls back to '' when unknown.
 */
export function getProviderBaseUrl(provider: string, customBaseUrl?: string): string {
  if (isCustomProviderId(provider)) return (customBaseUrl ?? '').trim();
  const preset = getProviderPreset(provider);
  if (preset) {
    if (preset.baseUrl) return preset.baseUrl;
    // azure-openai: endpoint comes from the stored key label.
    return (customBaseUrl ?? '').trim();
  }
  // Unknown provider — preserve the historical default chain behavior.
  return OPENAI_FALLBACK_BASE_URL;
}

/** Resolve the base URL for a leased key (provider + stored label). */
export function resolveKeyBaseUrl(provider: string, label?: string | null): string {
  if (isCustomProviderId(provider) || provider.toLowerCase() === 'azure-openai') {
    return getProviderBaseUrl(provider, getCustomBaseUrl(label) ?? '');
  }
  return getProviderBaseUrl(provider);
}

/** Build an OpenAI SDK client for an OpenAI-protocol provider. */
export function buildOpenAiClient(
  provider: string,
  apiKey: string,
  label?: string | null
): OpenAI {
  const preset = getProviderPreset(provider);
  const baseURL = resolveKeyBaseUrl(provider, label);
  // Azure uses an `api-key` header instead of Bearer; the OpenAI SDK sends
  // Authorization: Bearer regardless, so attach the header via defaultHeaders
  // (harmless extra Authorization header, correct api-key header).
  if (preset?.authStyle === 'header' && preset.protocol === 'openai') {
    return new OpenAI({ apiKey, baseURL, defaultHeaders: { 'api-key': apiKey } });
  }
  return new OpenAI({ apiKey, baseURL });
}

// ==================== MODEL LIST NORMALIZERS ====================

/**
 * Normalize a provider's list-models payload to string[].
 * - openai-list: { data: [{ id }] } (also accepts a bare array; Together
 *   returns a legacy bare-array shape).
 * - gemini-list: { models: [{ name: "models/gemini-…" }] } — strips the
 *   `models/` prefix.
 * - anthropic-list: { data: [{ id }] } (cursor-paginated upstream; the proxy
 *   returns the first page merged with presets client-side).
 * - ollama-tags: { models: [{ name }] } (`name` includes the tag).
 */
export function normalizeModelList(normalizer: ModelsNormalizer, payload: unknown): string[] {
  const ids: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) ids.push(value.trim());
  };

  if (normalizer === 'gemini-list') {
    const models = (payload as { models?: Array<{ name?: unknown }> } | null)?.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        if (typeof m?.name === 'string') push(m.name.replace(/^models\//, ''));
      }
    }
  } else if (normalizer === 'ollama-tags') {
    const models = (payload as { models?: Array<{ name?: unknown; model?: unknown }> } | null)?.models;
    if (Array.isArray(models)) {
      for (const m of models) {
        push(m?.name);
        if (typeof m?.name !== 'string') push(m?.model);
      }
    }
  } else {
    // openai-list / anthropic-list: { data: [{ id }] } or bare [{ id }].
    const data = Array.isArray(payload)
      ? payload
      : (payload as { data?: unknown } | null)?.data;
    if (Array.isArray(data)) {
      for (const m of data) push((m as { id?: unknown } | null)?.id);
    }
  }

  return [...new Set(ids)].slice(0, 200);
}
