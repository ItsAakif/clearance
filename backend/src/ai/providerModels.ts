// Per-provider LLM model resolution.
// Precedence: DB AppSetting `model:<provider>` -> legacy env override -> provider default.
// Model IDs are NOT secrets: logging them is fine. Never log API keys.
import prisma from '../lib/prisma.js';
import {
  LLM_PROVIDER_IDS,
  buildOpenAiClient,
  getProviderBaseUrl,
  getProviderPreset,
  isCustomProviderId,
} from './providerRegistry.js';

export const LLM_MODEL_PROVIDERS: readonly string[] = LLM_PROVIDER_IDS;
export type LlmModelProvider = string;

// Registry-driven defaults (groq/openai/openrouter/gemini values unchanged
// for back-compat). Providers without a knowable default (azure-openai,
// lmstudio, custom) resolve to '' — callers must ensure a model override is
// set for those before leasing.
export const DEFAULT_MODELS: Record<string, string> = Object.fromEntries(
  LLM_PROVIDER_IDS.map((id) => [id, getProviderPreset(id)?.defaultModel ?? ''])
);

export const MODEL_SETTING_PREFIX = 'model:';

export interface ModelResolutionOptions {
  /** Value of a legacy per-feature env override, e.g. process.env.ATS_MODEL. */
  envOverride?: string | undefined;
  /** Optional feature-specific fallback used before the provider default. */
  fallback?: string | undefined;
}

const CACHE_TTL_MS = 5000;
const dbModelCache = new Map<string, { value: string | null; expiresAt: number }>();

function normalizeProvider(provider: string): LlmModelProvider {
  const normalized = provider.toLowerCase();
  if (isCustomProviderId(normalized)) return normalized;
  return (LLM_MODEL_PROVIDERS as readonly string[]).includes(normalized) ? normalized : 'groq';
}

async function readDbModel(provider: LlmModelProvider): Promise<string | null> {
  const now = Date.now();
  const cached = dbModelCache.get(provider);
  if (cached && cached.expiresAt > now) return cached.value;
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: `${MODEL_SETTING_PREFIX}${provider}` },
    });
    const value = row?.value?.trim() || null;
    dbModelCache.set(provider, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch (error) {
    // Table missing / DB down: fall through to env/default without caching.
    console.warn(
      `[providerModels] Failed to read ${MODEL_SETTING_PREFIX}${provider}; using fallback.`,
      (error as Error).message
    );
    return null;
  }
}

/**
 * Resolve the model for a leased key's provider.
 * Order: DB `model:<provider>` -> options.envOverride -> options.fallback -> DEFAULT_MODELS.
 */
export async function getProviderModel(
  provider: string,
  options: ModelResolutionOptions = {}
): Promise<string> {
  const normalized = normalizeProvider(provider);
  const dbModel = await readDbModel(normalized);
  if (dbModel) return dbModel;

  const envModel = options.envOverride?.trim();
  if (envModel) return envModel;

  const explicitFallback = options.fallback?.trim();
  if (explicitFallback) return explicitFallback;

  return DEFAULT_MODELS[normalized] ?? '';
}

export async function setProviderModel(provider: string, model: string): Promise<void> {
  const normalized = normalizeProvider(provider);
  const value = model.trim();
  if (!value) {
    await clearProviderModel(normalized);
    return;
  }
  await prisma.appSetting.upsert({
    where: { key: `${MODEL_SETTING_PREFIX}${normalized}` },
    create: { key: `${MODEL_SETTING_PREFIX}${normalized}`, value },
    update: { value },
  });
  dbModelCache.delete(normalized);
}

export async function clearProviderModel(provider: string): Promise<void> {
  const normalized = normalizeProvider(provider);
  await prisma.appSetting.deleteMany({
    where: { key: `${MODEL_SETTING_PREFIX}${normalized}` },
  });
  dbModelCache.delete(normalized);
}

export async function getAllProviderModelSettings(): Promise<{
  models: Record<LlmModelProvider, string>;
  overrides: Partial<Record<LlmModelProvider, string>>;
  defaults: Record<LlmModelProvider, string>;
}> {
  const models = {} as Record<LlmModelProvider, string>;
  const overrides: Partial<Record<LlmModelProvider, string>> = {};
  for (const provider of LLM_MODEL_PROVIDERS) {
    const dbModel = await readDbModel(provider);
    if (dbModel) overrides[provider] = dbModel;
    models[provider] = dbModel || DEFAULT_MODELS[provider];
  }
  return { models, overrides, defaults: { ...DEFAULT_MODELS } };
}

/** Test helper / manual cache bust. */
export function invalidateProviderModelCache(provider?: string): void {
  if (provider) dbModelCache.delete(normalizeProvider(provider));
  else dbModelCache.clear();
}

export class LlmModelError extends Error {
  readonly provider: string;
  readonly model: string;
  status?: number;
  code?: string;

  constructor(provider: string, model: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`LLM call failed (provider=${provider}, model=${model}): ${causeMessage}`);
    this.name = 'LlmModelError';
    this.provider = provider;
    this.model = model;
    const c = cause as { status?: unknown; code?: unknown };
    if (typeof c?.status === 'number') this.status = c.status;
    if (typeof c?.code === 'string') this.code = c.code;
  }
}

/**
 * Run an OpenAI completion and annotate any failure with provider + model so an
 * invalid model string is obvious. Copies status/code so isRateLimitError works.
 */
export async function runLlmCompletion<T>(
  provider: string,
  model: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new LlmModelError(provider, model, error);
  }
}

// ==================== ANTHROPIC EXECUTION PATH ====================
// Anthropic is the only registry provider that is NOT OpenAI-compatible
// (own /v1/messages protocol, x-api-key + anthropic-version headers).
// Everything else goes through the OpenAI SDK via buildOpenAiClient().

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatCreateParams {
  model: string;
  messages: LlmChatMessage[];
  max_tokens?: number;
  temperature?: number;
  /** Accepted for OpenAI parity; ignored by the Anthropic path. */
  response_format?: { type: string };
}

export interface LlmChatResult {
  choices: Array<{ message: { content: string | null } }>;
}

/**
 * Structural chat client shared by the OpenAI SDK instance and the Anthropic
 * shim below, so the ~10 call sites can construct one client via
 * createLlmClient() without caring about the protocol.
 */
export interface LlmChatClient {
  chat: {
    completions: {
      create(params: LlmChatCreateParams): Promise<LlmChatResult>;
    };
  };
}

const ANTHROPIC_VERSION = '2023-06-01';

/** Thin /v1/messages fetch — no new npm dependency. */
export class AnthropicChatClient implements LlmChatClient {
  chat = {
    completions: {
      create: async (params: LlmChatCreateParams): Promise<LlmChatResult> => {
        const baseUrl = getProviderBaseUrl('anthropic').replace(/\/+$/, '');
        const systemParts = params.messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content);
        const messages = params.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content }));
        const body: Record<string, unknown> = {
          model: params.model,
          max_tokens: params.max_tokens ?? 1024,
          messages,
        };
        if (systemParts.length > 0) body.system = systemParts.join('\n\n');
        if (typeof params.temperature === 'number') body.temperature = params.temperature;

        const res = await fetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw Object.assign(new Error(`Anthropic error ${res.status}: ${text.slice(0, 300)}`), {
            status: res.status,
          });
        }
        const data = (await res.json()) as {
          content?: Array<{ type?: string; text?: string }>;
        };
        const text = (data.content ?? [])
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('');
        return { choices: [{ message: { content: text } }] };
      },
    },
  };

  constructor(private readonly apiKey: string) {}
}

export interface LlmKeyLike {
  provider: string;
  apiKey: string;
  label?: string | null;
}

/**
 * Build the chat client for a leased key, branching on the registry protocol:
 * Anthropic-protocol providers get the thin /v1/messages shim, everything
 * else gets the OpenAI SDK pointed at the registry base URL (Azure's
 * `api-key` header handled inside buildOpenAiClient).
 */
export function createLlmClient(key: LlmKeyLike): LlmChatClient {
  const normalized = key.provider.toLowerCase();
  const preset = isCustomProviderId(normalized) ? undefined : getProviderPreset(normalized);
  if (preset?.protocol === 'anthropic') {
    return new AnthropicChatClient(key.apiKey);
  }
  return buildOpenAiClient(key.provider, key.apiKey, key.label ?? undefined) as unknown as LlmChatClient;
}
