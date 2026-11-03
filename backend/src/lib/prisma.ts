// Prisma client singleton with idle-pooler resilience.
//
// Hosted Postgres poolers (e.g. Neon/Supavisor/PgBouncer) terminate idle
// connections with FATAL 57P01 ("terminating connection due to
// administrator command"). The server stays up; only the pooled socket dies,
// so the fix is per-query resilience, not restart logic.
//
// Strategy:
// - Keep the pool small (connection_limit default 2) and raise pool_timeout
//   so a cold/restarted pool waits instead of failing fast.
// - Retry exactly once on terminated/closed-connection errors.
// - Log one bounded warning per incident (no stack spam, never DATABASE_URL).
// - Retry the startup connectivity probe with backoff without crashing boot.

import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

// Pool defaults tuned for a serverless pooler in front of Postgres.
export const DB_POOL_DEFAULTS = {
  connection_limit: '2',
  pool_timeout: '20',
  connect_timeout: '10',
} as const;

/**
 * Return the datasource URL with pool params present. Existing params win;
 * missing ones are filled from DB_POOL_DEFAULTS. Never logs the URL.
 */
export function buildPooledDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', DB_POOL_DEFAULTS.connection_limit);
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', DB_POOL_DEFAULTS.pool_timeout);
  }
  if (!url.searchParams.has('connect_timeout')) {
    url.searchParams.set('connect_timeout', DB_POOL_DEFAULTS.connect_timeout);
  }
  return url.toString();
}

function messageOf(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error ?? '');
  const withMessage = error as { message?: unknown };
  return typeof withMessage.message === 'string' ? withMessage.message : String(error);
}

/**
 * True for idle-connection terminations from a hosted pooler:
 * - Postgres FATAL 57P01 / "terminating connection due to administrator command"
 * - Prisma closed-connection failures ("Server has closed the connection")
 * Never inspects or logs any connection string.
 */
export function isTerminatedConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    errorCode?: unknown;
    kind?: unknown;
    name?: unknown;
  };
  if (candidate.code === '57P01' || candidate.code === 'E57P01') return true;
  if (candidate.errorCode === '57P01' || candidate.errorCode === 'E57P01') return true;
  if (candidate.kind === 'Closed') return true;
  const message = messageOf(error);
  return (
    message.includes('57P01') ||
    message.includes('terminating connection due to administrator command') ||
    message.includes('Server has closed the connection') ||
    message.includes('Connection closed') ||
    message.includes('connection closed')
  );
}

/** One bounded warning per incident: no stack, no connection string. */
export function logTransientConnectionWarning(): void {
  console.warn(
    '[prisma] transient idle-connection termination (E57P01/closed connection); retrying once',
  );
}

/**
 * Run a DB operation, retrying exactly once when the pooler terminated the
 * idle connection underneath us. Non-termination errors throw immediately.
 */
export async function withDbRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTerminatedConnectionError(error)) throw error;
    logTransientConnectionWarning();
    return operation();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDatabaseUrl(): string | undefined {
  return buildPooledDatabaseUrl(process.env.DATABASE_URL);
}

function createResilientClient(): PrismaClient {
  const url = resolveDatabaseUrl();
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    ...(url ? { datasources: { db: { url } } } : {}),
  });

  // Per-query retry for every model query through this singleton. Exactly one
  // retry on E57P01/closed-connection, one bounded warning, then rethrow.
  client.$use(async (params, next) => {
    try {
      return await next(params);
    } catch (error) {
      if (!isTerminatedConnectionError(error)) throw error;
      logTransientConnectionWarning();
      return next(params);
    }
  });

  return client;
}

export const prisma: PrismaClient = global.prisma || createResilientClient();

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

/**
 * Startup connectivity probe with backoff. Resolves on first success;
 * rejects after all attempts. Callers must not crash boot on rejection —
 * the server stays up and per-query retry covers later recovery.
 */
export async function connectWithRetry(
  client: Pick<PrismaClient, '$queryRaw'> = prisma as Pick<PrismaClient, '$queryRaw'>,
  attempts = 5,
  baseDelayMs = 500,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await (client.$queryRaw as (query: TemplateStringsArray) => Promise<unknown>)`SELECT 1`;
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), 8000));
      }
    }
  }
  console.warn(
    `[prisma] database unreachable after ${attempts} startup attempt(s); continuing without a live connection`,
  );
  throw lastError;
}

export default prisma;
