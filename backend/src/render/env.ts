// The render runtime configuration - what the render path reads from the environment, and
// the one per-user limiter that backs policy 10.2's last row.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md 10.2 O2 (the four
//                 quota knobs: TUNABLE lower, never higher) and 9.1 F1 (the wall budget)
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 7
//                 ("Env (OI-5, 10.2)") and sec. 13 ruling 12 (admission before the tree)
//                 .planning/decisions/ADR-044-*.md D1 (the transport keys)
// Task:         T1043
//
// WHY THE VALUES LIVE IN `config/env.ts` AND THE KEYS LIVE HERE. The policy mandates ONE
// zod schema ("All four knobs are declared in the one zod env schema
// (`backend/src/config/env.ts:3-63`) with documented defaults"), so the schema, the
// defaults and the boot refusal live in that one file. This module owns the KEY NAMES -
// derived from the modules that already own them (`brokerClient.ts`'s `BROKER_ENV_KEYS`,
// `storage.ts`'s `STORAGE_ENV_KEYS`, `sandbox.ts`'s `RENDER_QUOTA` / `RENDER_LIMITS`) so
// there is one spelling per key and a typo cannot create a second, unread variable. It
// also owns the derived BUDGET, because that is where the policy comparison the acceptance
// item names has to be made structural rather than documented.
//
// THE BUDGET, AND WHY IT IS TWO NUMBERS. `RENDER_TIMEOUT_MS` is the budget T1043 may
// LOWER, never raise (a raise is refused at boot, in the schema). It bounds the RENDER
// REQUEST budget the port ENFORCES - and, through it, the broker transport budget. It is
// NOT an override of the compile plan, and the contract's phrase "the plan's budget" means
// exactly that (T1040 sec. 13 ruling 17). The compile plan's own `timeoutMs` is NOT this
// module's to set and is left exactly as `sandbox.ts` pins it: `sandbox.ts` is the policy
// encoding, is on the do-not-touch list, `buildCompileArgs` takes no limits argument, and its
// `assertPolicyInvariants` pins `plan.timeoutMs` to `RENDER_LIMITS.wallClockMs` while
// `stage.ts` refuses looser limits. So the split is:
//
//   budgetMs        - the render budget this deployment runs, `<= RENDER_LIMITS.wallClockMs`.
//                     This is the number an operator lowers, and it is asserted against the
//                     policy constant here so a future edit cannot make it exceed the policy.
//   clientTimeoutMs - the BROKER TRANSPORT budget: `budgetMs` plus the policy kill grace
//                     plus a margin for staging and `/out` extraction.
//
// The ceiling is the SAME number in both places and neither is derived from the other:
// `RENDER_LIMITS.wallClockMs` bounds this knob from above, and `sandbox.ts` pins the plan to
// it from below, so the knob can never exceed the container's own wall clock no matter which
// one a future edit relaxes. The ceiling is also checked at boot, by the schema.
//
// The second exists because the two are genuinely different clocks. Policy 9.1 allows a job
// to run the 10 s wall, then 2 s of TERM grace, then a KILL, and then the broker still has
// to extract and validate `/out`; a client timeout of exactly `budgetMs` would abort a job
// that is inside its own policy, and would report a transport failure for a successful
// compile. The margin is the same one `brokerClient.ts`'s own `CLIENT_DEFAULT_TIMEOUT_MS`
// uses, so with the default configuration the two agree by construction.
//
// NOTHING HERE THROWS AT IMPORT TIME. Every read is lazy and every assertion is an
// explicit call from the boot path, which is what keeps this module importable from a test
// and from `storage.test.ts`'s grep gate whether or not a broker is configured.

import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

import { BROKER_ENV_KEYS, brokerEndpointFromEnv, type BrokerEndpoint } from './brokerClient.js';
import { RENDER_LIMITS, RENDER_QUOTA } from './sandbox.js';
import { STORAGE_ENV_KEYS } from './storage.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// The key names - one spelling per key
// ---------------------------------------------------------------------------

/**
 * The four policy 10.2 quota keys, plus the wall budget, plus the storage and transport
 * keys this path reads. The first four carry `RENDER_QUOTA`'s policy defaults and the
 * fifth carries `RENDER_LIMITS.wallClockMs`, so an operator's "raise the limit" edit meets
 * a `max()` in the schema whose number is the policy constant rather than a typed-in
 * duplicate of it.
 *
 * THERE IS NO SPOOL KEY HERE, AND THAT IS THE POINT (T1040 sec. 13 ruling 16). The contract
 * named `RENDER_BROKER_SPOOL_DIR`; the BROKER process reads `RENDER_BROKER_SPOOL_ROOT`
 * (`broker/index.ts`'s `BROKER_ENV_KEYS.spoolRoot`, and the key `docker-compose.yml` sets on
 * the `render-broker` service). The backend-side spelling was DEAD CONFIG - declared in the
 * zod schema, documented in `.env.example`, named in a constant, asserted by a test, and
 * read by NOTHING, because the broker owns its private `/out` spool and the backend never
 * materialises `/out` (see `typst.ts`'s header). A key that is declared, documented and
 * asserted but read by nobody is worse than an absent one: it makes the contract sound
 * load-bearing when it does nothing, and a deployment that set it on the broker would
 * silently get the default spool root. One key, one owner: `RENDER_BROKER_SPOOL_ROOT` is the
 * broker's, it ships in T1031, and it is tested there. This list is the API side only.
 */
export const RENDER_ENV_KEYS = Object.freeze({
  maxConcurrency: 'RENDER_MAX_CONCURRENCY',
  maxConcurrencyPerUser: 'RENDER_MAX_CONCURRENCY_PER_USER',
  queueDepth: 'RENDER_QUEUE_DEPTH',
  perUserPerMinute: 'RENDER_PER_USER_PER_MINUTE',
  timeoutMs: 'RENDER_TIMEOUT_MS',
  storageKind: STORAGE_ENV_KEYS[0],
  storageRoot: STORAGE_ENV_KEYS[1],
  brokerSocket: BROKER_ENV_KEYS.socket,
  brokerUrl: BROKER_ENV_KEYS.url,
  brokerToken: BROKER_ENV_KEYS.token,
} as const);

/** Every key the render path may read, for `.env.example` and for the schema's own audit. */
export const RENDER_ENV_KEY_LIST: readonly string[] = Object.freeze(Object.values(RENDER_ENV_KEYS));

/** The policy defaults, from the policy module, not typed in again. */
export const RENDER_DEFAULTS = Object.freeze({
  maxConcurrency: RENDER_QUOTA.concurrentPerHost,
  maxConcurrencyPerUser: RENDER_QUOTA.concurrentPerUser,
  queueDepth: RENDER_QUOTA.queueDepth,
  perUserPerMinute: RENDER_QUOTA.rendersPerMinutePerUser,
  timeoutMs: RENDER_LIMITS.wallClockMs,
} as const);

/**
 * The margin the broker TRANSPORT budget adds on top of the render budget, for staging and
 * `/out` extraction. The same margin `brokerClient.ts` uses for
 * `CLIENT_DEFAULT_TIMEOUT_MS`, so the default configuration produces the same number by two
 * independent routes.
 */
export const RENDER_TRANSPORT_MARGIN_MS = 5_000;

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

export interface RenderBudget {
  /**
   * The render budget the PORT ENFORCES for one job. Never above
   * `RENDER_LIMITS.wallClockMs`, which is also the value `sandbox.ts` pins into the compile
   * plan - the same ceiling from both sides, never one derived from the other.
   */
  readonly budgetMs: number;
  /** The broker transport budget: `budgetMs` + the policy kill grace + the margin. */
  readonly clientTimeoutMs: number;
  /** The policy kill grace the transport budget has to leave room for. */
  readonly killGraceMs: number;
}

/**
 * The budget for this deployment.
 *
 * The invariant is ASSERTED, not documented: `budgetMs > RENDER_LIMITS.wallClockMs` is a
 * programming error, not a configuration outcome (the schema already refuses a higher
 * value at boot), and a caller that passed one anyway would be raising a policy constant
 * from outside the policy module. The refusal is a plain `RangeError` because it is not a
 * user-facing outcome: nothing renders, and no response is ever produced.
 */
export function resolveRenderBudget(timeoutMs: number = env.RENDER_TIMEOUT_MS): RenderBudget {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('RENDER_TIMEOUT_MS: the render budget must be a positive number of milliseconds');
  }
  if (timeoutMs > RENDER_LIMITS.wallClockMs) {
    throw new RangeError(
      `RENDER_TIMEOUT_MS: the render budget must not exceed the policy wall clock of ${RENDER_LIMITS.wallClockMs} ms`,
    );
  }
  return Object.freeze({
    budgetMs: timeoutMs,
    clientTimeoutMs: timeoutMs + RENDER_LIMITS.killGraceMs + RENDER_TRANSPORT_MARGIN_MS,
    killGraceMs: RENDER_LIMITS.killGraceMs,
  });
}

// ---------------------------------------------------------------------------
// The broker endpoint
// ---------------------------------------------------------------------------

/**
 * The broker endpoint, or `null` when the transport is not configured.
 *
 * Delegated to `brokerClient.ts`'s own reader rather than re-implemented: the client
 * already decides that a token is required and that a socket beats a URL, and two readers
 * would be two answers to "is the broker configured" - one of which could hand a URL to a
 * caller that only honours a socket. `null` is the honest "not configured", and the port
 * turns it into `render_broker_unavailable` (503) rather than into a crash.
 */
export function brokerEndpoint(): BrokerEndpoint | null {
  return brokerEndpointFromEnv(process.env);
}

// ---------------------------------------------------------------------------
// The per-user limiter (policy 10.2, last row)
// ---------------------------------------------------------------------------

/**
 * The render rate limiter, keyed on the AUTHENTICATED user.
 *
 * Policy 10.2 names the mechanism and the model explicitly: "per-user renders per minute |
 * 10 | a dedicated `express-rate-limit` limiter keyed on `req.user?.id`, copying
 * `fullScanLimiter` (`backend/src/app.ts:69-76`)". So this is the same library, the same
 * key expression and the same two options as that limiter, with the window and maximum
 * from the policy knob.
 *
 * The key is the user id, NOT the IP, and the fallback is not decorative: `app.ts` mounts
 * its limiter behind an auth preflight so `req.user` is populated, and this limiter is
 * mounted the same way, so the production key is the user. The `req.ip` fallback is for
 * direct use of the exported limiter (a unit test, or a future mount that has not run
 * auth), exactly as `fullScanLimiter` documents.
 *
 * `RENDER_BUSY` is NOT what this limiter produces: `express-rate-limit` answers its own
 * `message`, so a caller sees a 429 that did not come from the broker's admission queue.
 * The message therefore names the same thing the broker's does - the renderer is busy -
 * and the code in the body is the policy's `RENDER_BUSY`, so a client has ONE code for
 * "the renderer is at capacity" whether it hit the HTTP limiter or the broker's queue.
 */
export function createRenderLimiter(perMinute: number = env.RENDER_PER_USER_PER_MINUTE) {
  if (!Number.isInteger(perMinute) || perMinute <= 0) {
    throw new RangeError('RENDER_PER_USER_PER_MINUTE: the render rate must be a positive integer');
  }
  return rateLimit({
    windowMs: 60_000,
    max: perMinute,
    keyGenerator: (req: Request) => (req as { user?: { id?: string } }).user?.id ?? req.ip ?? 'unknown',
    message: { error: 'The renderer is busy. Try again in a moment.', code: 'RENDER_BUSY' },
    standardHeaders: true,
    legacyHeaders: false,
  });
}
