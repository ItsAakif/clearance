// Unified provider key manager (BYOK)
// Supports the 13 registry LLM providers (+ `custom:<slug>` ids) and search (tavily/exa).
// Keys come from the database (AIProviderKey, per-user or system) with env fallback.
// Per security.md: keys are encrypted at rest (lib/crypto.ts); never log plaintext.

import prisma from '../lib/prisma.js';
import { decryptSecret } from '../lib/crypto.js';
import { LLM_PROVIDER_IDS, CUSTOM_PROVIDER_PREFIX } from './providerRegistry.js';

const RATE_LIMIT_COOLDOWN_MS = 60 * 1000;

export type ProviderKind = 'llm' | 'search';
export type KeySource = 'database' | 'env';

export interface KeyRecord {
  id: string;
  apiKey: string; // decrypted
  provider: string;
  source: KeySource;
  userId: string | null;
  /** Stored AIProviderKey.label (carries custom/azure base URLs as JSON — see registry). */
  label?: string | null;
}

// Single source of truth lives in providerRegistry.ts (LLM_PROVIDER_IDS keeps
// groq/openai/openrouter/gemini first for fallback stability).
const LLM_PROVIDERS: readonly string[] = LLM_PROVIDER_IDS;
const SEARCH_PROVIDERS = ['tavily', 'exa'];
// Scraping backends (BYOK). firecrawl/crawl4ai are self-hostable; rapidapi
// covers the hard anti-bot boards (LinkedIn/Indeed/ZipRecruiter/Glassdoor/Bayt).
const SCRAPING_PROVIDERS = ['firecrawl', 'crawl4ai', 'rapidapi'];

let rotationIndex = 0;
let lock: Promise<void> = Promise.resolve();

async function withLock<T>(callback: () => Promise<T>): Promise<T> {
  const previous = lock;
  let release!: () => void;
  lock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await callback();
  } finally {
    release();
  }
}

function getEnvKeys(provider: string): KeyRecord[] {
  const values: string[] = [];
  const upper = provider.toUpperCase();

  if (process.env[`${upper}_API_KEY`]) {
    values.push(process.env[`${upper}_API_KEY`]!);
  }
  // Support GROQ_API_KEY_1..20 style rotation
  for (let index = 1; index <= 20; index += 1) {
    const candidate = process.env[`${upper}_API_KEY_${index}`];
    if (candidate) values.push(candidate);
  }
  // Tavily alias
  if (provider === 'tavily' && process.env.TAVILY_API_KEY) {
    values.push(process.env.TAVILY_API_KEY);
  }
  // Exa alias
  if (provider === 'exa' && process.env.EXA_API_KEY) {
    values.push(process.env.EXA_API_KEY);
  }

  return values.map((apiKey, index) => ({
    id: `env-${provider}-${index}`,
    apiKey,
    provider,
    source: 'env' as const,
    userId: null,
    label: null,
  }));
}

async function getDatabaseKeys(provider: string, userId?: string): Promise<KeyRecord[]> {
  const where: Record<string, unknown> = {
    provider,
    isActive: true,
    OR: [{ rateLimitedUntil: null }, { rateLimitedUntil: { lte: new Date() } }],
  };
  if (userId) {
    where.OR = [{ userId }, { userId: null }];
  }

  const keys = await prisma.aIProviderKey.findMany({
    where,
    orderBy: [{ lastUsedAt: 'asc' }, { createdAt: 'asc' }],
  });

  return keys.map((key) => ({
    id: key.id,
    apiKey: decryptSecret(key.apiKey),
    provider: key.provider,
    source: 'database' as const,
    userId: key.userId,
    label: key.label,
  }));
}

/**
 * Lease the next available key for a provider, optionally scoped to a user.
 * Database keys take precedence; env keys are used only as fallback.
 */
export async function leaseNextKey(provider: string, userId?: string): Promise<KeyRecord> {
  return withLock(async () => {
    const databaseKeys = await getDatabaseKeys(provider, userId);
    const fallbackKeys = databaseKeys.length === 0 ? getEnvKeys(provider) : [];
    const keys = [...databaseKeys, ...fallbackKeys];

    if (keys.length === 0) {
      throw new Error(
        `No ${provider} API keys configured. Add a key in Settings (BYOK) or set ${provider.toUpperCase()}_API_KEY.`
      );
    }

    const key = keys[rotationIndex % keys.length];
    rotationIndex = (rotationIndex + 1) % keys.length;

    if (key.source === 'database') {
      await prisma.aIProviderKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date() },
      });
    }

    return key;
  });
}

export async function markKeySuccess(key: KeyRecord): Promise<void> {
  if (key.source !== 'database') return;
  await prisma.aIProviderKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date(), failureCount: 0, rateLimitedUntil: null },
  });
}

export async function markKeyFailure(key: KeyRecord, isRateLimited: boolean): Promise<void> {
  if (key.source !== 'database') return;
  await prisma.aIProviderKey.update({
    where: { id: key.id },
    data: {
      lastUsedAt: new Date(),
      failureCount: { increment: 1 },
      rateLimitedUntil: isRateLimited ? new Date(Date.now() + RATE_LIMIT_COOLDOWN_MS) : undefined,
    },
  });
}

export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: number; message?: string; code?: string };
  const message = candidate.message?.toLowerCase() || '';
  return (
    candidate.status === 429 ||
    candidate.code === 'rate_limit_exceeded' ||
    message.includes('rate limit') ||
    message.includes('quota') ||
    message.includes('too many requests')
  );
}

// ---- LLM convenience helpers ----

export function isLlmProvider(provider: string): boolean {
  const normalized = provider.toLowerCase();
  // Any `custom:<slug>` id is an OpenAI-compatible LLM provider.
  if (normalized.startsWith(CUSTOM_PROVIDER_PREFIX)) return true;
  return (LLM_PROVIDERS as readonly string[]).includes(normalized);
}

export async function leaseNextLlmKey(userId?: string, preferred?: string): Promise<KeyRecord> {
  const providers = preferred && isLlmProvider(preferred) ? [preferred] : LLM_PROVIDERS;
  let lastError: Error | null = null;
  for (const provider of providers) {
    try {
      return await leaseNextKey(provider, userId);
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw lastError || new Error('No LLM API keys configured.');
}

export async function leaseNextSearchKey(userId?: string): Promise<KeyRecord> {
  // Prefer Exa (free tier) then fall back to Tavily (BYOK). Both are search
  // providers; whichever has a configured key wins.
  for (const provider of SEARCH_PROVIDERS) {
    try {
      return await leaseNextKey(provider, userId);
    } catch {
      // try next search provider
    }
  }
  throw new Error('No search API keys configured. Add an Exa or Tavily key in Settings (BYOK).');
}

/**
 * Lease the next available key for a scraping backend (firecrawl/crawl4ai/rapidapi).
 * Reuses the same AIProviderKey table; scraping backends store host URL in `label`.
 */
export async function leaseNextScrapingKey(provider: string, userId?: string): Promise<KeyRecord> {
  if (!SCRAPING_PROVIDERS.includes(provider.toLowerCase())) {
    throw new Error(`Unknown scraping provider: ${provider}`);
  }
  return leaseNextKey(provider, userId);
}

/**
 * Whether any Tavily search key is configured (env or DB). Used to decide
 * whether to use the keyless DuckDuckGo fallback for job discovery.
 */
export async function hasSearchKey(userId?: string): Promise<boolean> {
  try {
    for (const provider of SEARCH_PROVIDERS) {
      const keys = await getDatabaseKeys(provider, userId);
      if (keys.length > 0) return true;
      if (getEnvKeys(provider).length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---- Backwards-compatible Groq aliases (used by resumeGenerator.ts) ----

export const leaseNextGroqKey = (userId?: string) => leaseNextKey('groq', userId);
export const markGroqKeySuccess = markKeySuccess;
export const markGroqKeyFailure = markKeyFailure;
export const isGroqRateLimitError = isRateLimitError;
