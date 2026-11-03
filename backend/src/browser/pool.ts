/**
 * Bounded browser worker pool (wave 6, ADR-029 decisions 2-3; N6).
 *
 * This module is where "no 30k browser sessions" is actually enforced.
 * The caps are STRUCTURAL, not advisory: there is exactly one admission
 * path (`run`), workers are bounded by construction, and no code path
 * can bypass a cap.
 *
 * DESIGN NOTES (each traces to the task / spec / ADR):
 *  1. The pool takes opaque tasks (`{ url, run }`), never a browser
 *     client, so it is fully testable with fake tasks and no CamoFox
 *     present. Tasks own their session lifecycle (the client in
 *     `./client.js` always closes its session in a `finally`); the pool
 *     owns the COUNT (`activeSessions`, always decremented in a
 *     `finally`, so it returns to 0 even on cancel/failure).
 *  2. Dedupe runs BEFORE any cap is spent, using the canonical URL
 *     normaliser owned by `jobSources/jobIdentity.ts` (one normaliser,
 *     not two), so the URL cap is spent on DISTINCT pages.
 *  3. Over-cap work is REPORTED, never silent: because `run` must return
 *     exactly `BrowserResult[]`, each truncated/overflowed URL gets its
 *     own result record (`ok: false`) with a stable reason prefix
 *     (`truncated:` / `queue-overflow:`). A caller can therefore see
 *     every dropped URL; nothing disappears.
 *  4. Cancel is cooperative: `cancel()` marks every live run; queued
 *     work never starts, and in-flight tasks settle (their values are
 *     DISCARDED and reported as `cancelled:`, never `failed:`) before
 *     `run` resolves, at which point `activeSessions` is 0. A second
 *     `cancel()` is a no-op (idempotent), and cancelling with no live
 *     run is also a no-op, so the pool stays reusable across runs.
 *  5. Exactly-once execution: the pool NEVER retries. Retry policy
 *     belongs to the classified tier/client layer (the client performs
 *     exactly one transport attempt per call and never retries a
 *     `blocked` outcome); an opaque `() => Promise<T>` task carries no
 *     outcome class, so pool-level retry/backoff could only be blind —
 *     it would re-spend the URL cap, break cancel accounting, and
 *     contradict the client's no-retry invariant. There is therefore no
 *     retry loop here at all (bounded or otherwise): nothing to cap,
 *     nothing endless.
 *  6. This module performs NO logging, so no secret (URL credential or
 *     page content) can leak into logs. Rejection text is additionally
 *     passed through a credential-strip mirroring
 *     `client.redactCredentials` (inlined to keep this module's only
 *     dependencies `config/env.js` + `jobSources/jobIdentity.js`).
 *
 * RESULT CONTRACT (stable `reason` prefixes; `ok` decides success):
 *  - `{ ok: true, value }` ........................ task succeeded
 *  - `{ ok: false, reason: 'failed: ...' }` ....... task threw/rejected
 *  - `{ ok: false, reason: 'cancelled: ...' }` .... cancelled (NOT failed)
 *  - `{ ok: false, reason: 'truncated: ...' }` .... over CAMOUFOX_MAX_URLS_PER_RUN
 *  - `{ ok: false, reason: 'queue-overflow: ...' }` over CAMOUFOX_MAX_QUEUE_DEPTH
 */

import { env } from '../config/env.js';
import { normalizeUrl as canonicalPoolUrl } from '../jobSources/jobIdentity.js';

/**
 * Hard cap on browser sessions in flight at any moment.
 * Env-overridable (`CAMOUFOX_MAX_CONCURRENCY`), default 2 (ADR-029:
 * "default low, e.g. 2"). Read once at import; tests / embedders that
 * need a different bound pass `BrowserPoolOptions` to the factory.
 */
export const CAMOFOX_MAX_CONCURRENCY: number = env.CAMOUFOX_MAX_CONCURRENCY;

/**
 * Hard cap on DISTINCT URLs attempted per `run`. Over-cap URLs are
 * truncated and each gets a `truncated:` result record (never silent).
 * Env-overridable (`CAMOUFOX_MAX_URLS_PER_RUN`), default 20.
 */
export const CAMOFOX_MAX_URLS_PER_RUN: number = env.CAMOUFOX_MAX_URLS_PER_RUN;

/**
 * Hard cap on admitted tasks waiting to start. Over-cap URLs each get
 * a `queue-overflow:` result record (never silent).
 * Env-overridable (`CAMOUFOX_MAX_QUEUE_DEPTH`), default 50.
 */
export const CAMOFOX_MAX_QUEUE_DEPTH: number = env.CAMOUFOX_MAX_QUEUE_DEPTH;

/** One unit of browser work: the page to visit and the thunk that visits it. */
export interface BrowserTask<T> {
  url: string;
  run: () => Promise<T>;
}

/** Per-URL outcome. `ok` decides success; `reason` carries the stable prefix contract above. */
export interface BrowserResult<T> {
  url: string;
  ok: boolean;
  value?: T;
  reason?: string;
}

/** Bounded pool: fan-out with hard caps, cooperative cancel, session accounting. */
export interface BrowserPool {
  run<T>(tasks: BrowserTask<T>[]): Promise<BrowserResult<T>[]>;
  cancel(): void;
  readonly activeSessions: number;
}

/** Optional per-pool overrides. Defaults are the CAMOUFOX_MAX_* constants. */
export interface BrowserPoolOptions {
  maxConcurrency?: number;
  maxUrlsPerRun?: number;
  maxQueueDepth?: number;
}

function toPositiveInt(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const floored = Math.floor(raw);
  return floored >= 1 ? floored : fallback;
}

/** Strip `user:pass@` credentials and bound length so reasons carry no secret. */
function sanitiseReason(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
  return raw.replace(/:\/\/[^/\s@]+@/g, '://***@').slice(0, 500);
}

/** Create a pool. The pool is reusable across sequential runs. */
export function createBrowserPool(options: BrowserPoolOptions = {}): BrowserPool {
  // Resolved ONCE per pool: every admission and every worker below reads
  // these locals, so no code path can bypass a cap.
  const maxConcurrency = toPositiveInt(options.maxConcurrency, CAMOFOX_MAX_CONCURRENCY);
  const maxUrlsPerRun = toPositiveInt(options.maxUrlsPerRun, CAMOFOX_MAX_URLS_PER_RUN);
  const maxQueueDepth = toPositiveInt(options.maxQueueDepth, CAMOFOX_MAX_QUEUE_DEPTH);

  let active = 0;
  const liveRuns = new Set<{ cancelled: boolean }>();

  const pool: BrowserPool = {
    get activeSessions(): number {
      return active;
    },

    cancel(): void {
      // Idempotent: setting an already-true flag is a no-op, and with
      // no live run the loop body never executes (also a no-op).
      for (const state of liveRuns) {
        state.cancelled = true;
      }
    },

    async run<T>(tasks: BrowserTask<T>[]): Promise<BrowserResult<T>[]> {
      const state = { cancelled: false };
      liveRuns.add(state);
      try {
        // STEP 1 — dedupe by canonical URL BEFORE entering the pool, in
        // first-seen order, so caps are spent on DISTINCT pages.
        const seen = new Set<string>();
        const distinct: BrowserTask<T>[] = [];
        for (const task of tasks ?? []) {
          if (!task || typeof task.url !== 'string' || typeof task.run !== 'function') {
            continue;
          }
          const key = canonicalPoolUrl(task.url);
          if (seen.has(key)) continue;
          seen.add(key);
          distinct.push(task);
        }

        // STEP 2 — URL cap: truncate, and REPORT every dropped URL.
        const dropped: BrowserResult<T>[] = [];
        let admitted = distinct;
        if (distinct.length > maxUrlsPerRun) {
          admitted = distinct.slice(0, maxUrlsPerRun);
          for (const task of distinct.slice(maxUrlsPerRun)) {
            dropped.push({
              url: task.url,
              ok: false,
              reason: `truncated: exceeds CAMOUFOX_MAX_URLS_PER_RUN=${maxUrlsPerRun}`,
            });
          }
        }

        // STEP 3 — queue-depth cap: overflow is likewise REPORTED.
        let queued = admitted;
        if (admitted.length > maxQueueDepth) {
          queued = admitted.slice(0, maxQueueDepth);
          for (const task of admitted.slice(maxQueueDepth)) {
            dropped.push({
              url: task.url,
              ok: false,
              reason: `queue-overflow: exceeds CAMOUFOX_MAX_QUEUE_DEPTH=${maxQueueDepth}`,
            });
          }
        }

        // STEP 4 — bounded fan-out with cooperative cancel. At most
        // `maxConcurrency` workers exist, each holding at most one task,
        // so in-flight sessions can never exceed the cap. Index claiming
        // is synchronous (no await between read and increment), so every
        // index is claimed exactly once.
        const outcomes: Array<BrowserResult<T> | undefined> = new Array(queued.length);
        let next = 0;
        async function worker(): Promise<void> {
          for (;;) {
            if (state.cancelled) return;
            const index = next;
            next += 1;
            if (index >= queued.length) return;
            const task = queued[index];
            if (state.cancelled) {
              outcomes[index] = {
                url: task.url,
                ok: false,
                reason: 'cancelled: run cancelled before this task started',
              };
              continue;
            }
            active += 1;
            try {
              const value = await task.run();
              outcomes[index] = state.cancelled
                ? {
                    url: task.url,
                    ok: false,
                    reason:
                      'cancelled: run cancelled while this task was in flight; partial result discarded',
                  }
                : { url: task.url, ok: true, value };
            } catch (err) {
              outcomes[index] = state.cancelled
                ? {
                    url: task.url,
                    ok: false,
                    reason:
                      'cancelled: run cancelled while this task was in flight; partial result discarded',
                  }
                : { url: task.url, ok: false, reason: `failed: ${sanitiseReason(err)}` };
            } finally {
              // Sessions are owned by tasks (the client closes its own in
              // a `finally`); the pool guarantees the COUNT always drains.
              active -= 1;
            }
          }
        }
        const workerCount = Math.min(maxConcurrency, queued.length);
        const workers: Array<Promise<void>> = [];
        for (let w = 0; w < workerCount; w += 1) {
          workers.push(worker());
        }
        await Promise.all(workers);

        // Indices never claimed (cancel arrived before a worker reached
        // them) are reported as cancelled — never left holes, never silent.
        const executed: BrowserResult<T>[] = new Array(queued.length);
        for (let i = 0; i < queued.length; i += 1) {
          executed[i] =
            outcomes[i] ??
            {
              url: queued[i].url,
              ok: false,
              reason: 'cancelled: run cancelled before this task started',
            };
        }
        return [...executed, ...dropped];
      } finally {
        liveRuns.delete(state);
      }
    },
  };

  return pool;
}
