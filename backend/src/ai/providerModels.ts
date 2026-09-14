// Per-provider LLM model resolution.
// Precedence: DB AppSetting `model:<provider>` -> legacy env override -> provider default.
// Model IDs are NOT secrets: logging them is fine. Never log API keys.
import prisma from '../lib/prisma.js';

export const LLM_MODEL_PROVIDERS = ['groq', 'openai', 'openrouter', 'gemini'] as const;
export type LlmModelProvider = (typeof LLM_MODEL_PROVIDERS)[number];

// Live-model defaults. Groq value is verified from the in-repo comment at
// `ats/llmEvaluator.ts:131-133` (the old `llama-3.1-70b-versatile` was
// decommissioned by Groq and returns HTTP 400). The other providers are
// best-effort defaults and are meant to be overridden from Settings.
export const DEFAULT_MODELS: Record<LlmModelProvider, string> = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini',
  openrouter: 'meta-llama/llama-3.3-70b-instruct',
  gemini: 'gemini-2.0-flash',
};

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
  return (LLM_MODEL_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as LlmModelProvider)
    : 'groq';
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

  return DEFAULT_MODELS[normalized];
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
