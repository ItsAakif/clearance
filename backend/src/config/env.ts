import { z } from 'zod';

import { RENDER_LIMITS, RENDER_QUOTA } from '../render/sandbox.js';

/**
 * A policy 10.2 quota knob: TUNABLE lower, never higher.
 *
 * The ceiling is the POLICY DEFAULT, not a typed-in number, so "never higher" is a
 * comparison against the constant the policy module owns. A raise therefore needs a
 * measured reason AND an edit to the policy module - never an operator typo, and never a
 * second copy of the default to drift.
 *
 * `httpCeiling` is the one deliberate exception: the HTTP per-user render budget is not a
 * containment property like concurrency or queue depth (the broker still enforces those),
 * and a Studio page spends several renders on mount plus document/template arrivals. Its
 * ceiling is therefore the compose budget, not the in-process default, while the default
 * itself stays at the policy value.
 */
const tunableLower = (fallback: number, httpCeiling = fallback) =>
  z.coerce
    .number()
    .int()
    .positive()
    .default(fallback)
    .refine((value) => value <= httpCeiling, {
      message: `TUNABLE lower, never higher: the policy default is ${fallback}`,
    });

/**
 * An optional path-like value, where an EMPTY STRING means "not configured".
 *
 * The distinction matters because the environment cannot express "absent" reliably: a
 * `.env` line of `RENDER_BROKER_SOCKET=` and a compose `VAR: ${UNSET:-}` both arrive as
 * `''`, and both mean exactly what an unset variable means. Every reader of these keys
 * (`brokerClient.brokerEndpointFromEnv`, `storage.ts`'s `envValue`) already treats `''` as
 * absent - they check `length > 0` - so a schema that rejected `''` would contradict the
 * code it configures and fail a boot over a variable the caller has not set.
 */
const optionalPath = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.length === 0 ? undefined : value));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3001'),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().optional(),
  // Catalogue snapshot feed published by the daily workflow. Empty means
  // "use the default"; the sync route validates the scheme again (https in
  // production, loopback http in development only).
  CATALOGUE_FEED_URL: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === ''
        ? 'https://github.com/ItsAakif/clearance/releases/latest/download/catalogue.jsonl.gz'
        : value.trim(),
    )
    .pipe(z.string().url()),
  CLEARANCE_ACCESS_PASSWORD: z.string().default('CHANGEME'),
  KEY_ENCRYPTION_SECRET: z.string().optional(),
  EMAIL_FROM: z.string().email().default('noreply@clearance.app'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Browser tier (wave 6, ADR-029): last-resort, deep-mode-only, optional.
  // The tier stays unavailable until CAMOUFOX_ENABLED is "true" (or a
  // remote endpoint is configured); the slim image ships without the
  // automation library. Spelling follows the T720 probe (camoufox-js).
  CAMOUFOX_ENABLED: z.string().default('false'),
  CAMOUFOX_WS_ENDPOINT: z.string().url().optional(),
  CAMOUFOX_NAV_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Browser pool bounds (wave 6, ADR-029 decisions 2-3; N6): structural
  // caps enforced by backend/src/browser/pool.ts. A self-hoster lowers
  // them here; documented defaults live in .env.example.
  CAMOUFOX_MAX_CONCURRENCY: z.coerce.number().int().positive().default(2),
  CAMOUFOX_MAX_URLS_PER_RUN: z.coerce.number().int().positive().default(20),
  CAMOUFOX_MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(50),
  // Wave 15 (T900) - unit-path attribution. Default OFF: the existing
  // /jobs/full-scan response stays byte-stable unless an operator explicitly
  // opts into measurement. The parser is LENIENT: a missing value resolves
  // to 'off' AND any non-'on' value also resolves to 'off' without
  // throwing. The default `'off'` plus transform keeps startup safe under
  // operator typos (e.g. SEARCH_ATTRIBUTION=true or "On" or "ON ").
  SEARCH_ATTRIBUTION: z
    .union([z.enum(['on', 'off']), z.string()])
    .default('off')
    .transform((value) => (value === 'on' ? 'on' : 'off')),
  // Wave 15 (T904) - per-page verification write-back on the Full scan. A
  // Full sweep IS a verification; this switch exists so an operator can run
  // a sweep that does not touch CompanyCareerPage verification columns.
  // Default ON; the parser is LENIENT (matches the SEARCH_ATTRIBUTION
  // pattern) so any missing/invalid value resolves to 'on' without throwing
  // at startup. `off` short-circuits the write-back path entirely: no store
  // call, no `verification` key on the response.
  SEARCH_FULL_VERIFY_WRITEBACK: z
    .union([z.enum(['on', 'off']), z.string()])
    .default('on')
    .transform((value) => (value === 'on' ? 'on' : 'off')),
  // Wave 15 (T907) - per-bucket admission gate on the Full sweep. The
  // gate bounds the pool (T906: width 32) per upstream host so a batch
  // clustered on one provider cannot stampede that provider's API. Default
  // ON; the parser is LENIENT so a missing/invalid value resolves to 'on'
  // without throwing at startup. ONLY an explicit `'off'` disables the
  // gate - a typo or any non-`'off'` value (including `true`, `On`, `ON`,
  // empty string, garbage) keeps the gate ON, so an operator who fat-fingers
  // the env still has per-upstream politeness. `off` bypasses the gate
  // entirely and the response carries a bounded `politeness: 'off'` marker
  // so an unprotected sweep is never silent.
  SEARCH_FULL_POLITENESS: z
    .union([z.enum(['on', 'off']), z.string()])
    .default('on')
    .transform((value) => (value === 'off' ? 'off' : 'on')),
  // ---- Render tier (T1043; policy 10.2 O2, 9.1 F1) ----------------------
  // One schema, as policy 10.2 mandates ("All four knobs are declared in the one zod env
  // schema with documented defaults"). The first four are the policy's concurrency and
  // queueing defaults, each `tunableLower`: an operator may tighten a self-hosted
  // deployment and may NOT raise a cap, because the caps are containment properties and a
  // raised one silently weakens a policy MANDATE.
  //
  // The fifth is the RENDER/TRANSPORT BUDGET, and the ceiling is `RENDER_LIMITS.wallClockMs`
  // - the same number `sandbox.ts` encodes. What the knob bounds is the budget the PORT
  // ENFORCES on a render request (and, through it, the broker transport budget derived in
  // `render/env.ts`). It is NOT an override of the compile plan: `sandbox.ts` hard-pins
  // `plan.timeoutMs` to the policy constant, `buildCompileArgs` takes no timeout option, and
  // `sandbox.ts` is untouched by this task, so a deployment cannot buy a longer compile than
  // the policy's kill path is written for - the ceiling here and the pin there are the same
  // number reached two ways, and a raise needs a policy edit rather than a typo. The
  // contract's phrase "the plan's budget" means the budget the port enforces (T1040 sec. 13
  // ruling 17). `.env.example` documents all TEN keys.
  RENDER_MAX_CONCURRENCY: tunableLower(RENDER_QUOTA.concurrentPerHost),
  RENDER_MAX_CONCURRENCY_PER_USER: tunableLower(RENDER_QUOTA.concurrentPerUser),
  RENDER_QUEUE_DEPTH: tunableLower(RENDER_QUOTA.queueDepth),
  RENDER_PER_USER_PER_MINUTE: tunableLower(RENDER_QUOTA.rendersPerMinutePerUser, 60),
  RENDER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(RENDER_LIMITS.wallClockMs)
    .refine((value) => value <= RENDER_LIMITS.wallClockMs, {
      message: `TUNABLE lower, never higher: the policy wall-clock budget is ${RENDER_LIMITS.wallClockMs} ms`,
    }),
  // Storage (ADR-044 D2). `fs` is the only implemented kind; `s3` is a fail-closed seam, so
  // the schema accepts the string and `createArtifactStore` throws `STORAGE_UNAVAILABLE`
  // for it rather than this schema inventing a validation the store owns.
  RENDER_STORAGE_KIND: z.enum(['fs', 's3']).default('fs'),
  // Broker transport (ADR-044 D1) and the storage root. All optional because the render tier
  // is flag-gated: with `V2_TYPST_RENDER` off nothing reads them, and requiring them would
  // make a default deployment fail on configuration it never uses. `RENDER_BROKER_TOKEN` is
  // a BOOT requirement of the BROKER process itself, not of this schema.
  //
  // `optionalPath` rather than `z.string().min(1).optional()`: an operator who writes
  // `RENDER_BROKER_SOCKET=` in a `.env` (a commented-out line they uncommented, a compose
  // `VAR: ${UNSET:-}` that expands to nothing) gets an EMPTY STRING, not an absent value -
  // and `min(1)` would fail the BOOT of an API that does not even read the variable, with a
  // message about a render setting. The reader (`brokerClient.brokerEndpointFromEnv` and
  // `storage.ts`'s `envValue`) already treats an empty string as "not configured", so
  // mapping it to `undefined` here makes the schema agree with the code instead of
  // contradicting it.
  //
  // NO SPOOL KEY HERE. The contract named `RENDER_BROKER_SPOOL_DIR`; the broker process
  // reads `RENDER_BROKER_SPOOL_ROOT` (T1031's shipped, tested key). The backend never reads
  // a spool path - the broker owns its private `/out` spool and the backend never
  // materialises `/out` - so the contract's spelling was DEAD CONFIG and is REMOVED from
  // this schema, from `.env.example` and from the test that asserted it (T1040 sec. 13
  // ruling 16: one key, one owner). A declared-but-unread key makes a contract look
  // load-bearing when it does nothing.
  RENDER_STORAGE_ROOT: optionalPath,
  RENDER_BROKER_SOCKET: optionalPath,
  RENDER_BROKER_URL: optionalPath,
  RENDER_BROKER_TOKEN: optionalPath,
});

const parsed = envSchema.safeParse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  CLIENT_URL: process.env.CLIENT_URL,
  API_URL: process.env.API_URL,
  CATALOGUE_FEED_URL: process.env.CATALOGUE_FEED_URL,
  CLEARANCE_ACCESS_PASSWORD: process.env.CLEARANCE_ACCESS_PASSWORD,
  KEY_ENCRYPTION_SECRET: process.env.KEY_ENCRYPTION_SECRET,
  EMAIL_FROM: process.env.EMAIL_FROM,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  CAMOUFOX_ENABLED: process.env.CAMOUFOX_ENABLED,
  CAMOUFOX_WS_ENDPOINT: process.env.CAMOUFOX_WS_ENDPOINT,
  CAMOUFOX_NAV_TIMEOUT_MS: process.env.CAMOUFOX_NAV_TIMEOUT_MS,
  CAMOUFOX_MAX_CONCURRENCY: process.env.CAMOUFOX_MAX_CONCURRENCY,
  CAMOUFOX_MAX_URLS_PER_RUN: process.env.CAMOUFOX_MAX_URLS_PER_RUN,
  CAMOUFOX_MAX_QUEUE_DEPTH: process.env.CAMOUFOX_MAX_QUEUE_DEPTH,
  SEARCH_ATTRIBUTION: process.env.SEARCH_ATTRIBUTION,
  SEARCH_FULL_VERIFY_WRITEBACK: process.env.SEARCH_FULL_VERIFY_WRITEBACK,
  SEARCH_FULL_POLITENESS: process.env.SEARCH_FULL_POLITENESS,
  RENDER_MAX_CONCURRENCY: process.env.RENDER_MAX_CONCURRENCY,
  RENDER_MAX_CONCURRENCY_PER_USER: process.env.RENDER_MAX_CONCURRENCY_PER_USER,
  RENDER_QUEUE_DEPTH: process.env.RENDER_QUEUE_DEPTH,
  RENDER_PER_USER_PER_MINUTE: process.env.RENDER_PER_USER_PER_MINUTE,
  RENDER_TIMEOUT_MS: process.env.RENDER_TIMEOUT_MS,
  RENDER_STORAGE_KIND: process.env.RENDER_STORAGE_KIND,
  RENDER_STORAGE_ROOT: process.env.RENDER_STORAGE_ROOT,
  RENDER_BROKER_SOCKET: process.env.RENDER_BROKER_SOCKET,
  RENDER_BROKER_URL: process.env.RENDER_BROKER_URL,
  RENDER_BROKER_TOKEN: process.env.RENDER_BROKER_TOKEN,
});

if (!parsed.success) {
  const formatted = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${formatted}`);
}

export const env = parsed.data;

export function assertRequiredRuntimeConfig(): void {
  if (env.CLEARANCE_ACCESS_PASSWORD === 'CHANGEME') {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'CLEARANCE_ACCESS_PASSWORD is still the default value. Set a strong secret before starting in production.'
      );
    }
    console.warn('[WARN] CLEARANCE_ACCESS_PASSWORD is still the default value. Set a strong secret.');
  }
}

export function getBaseUrl(): string {
  return env.API_URL || `http://localhost:${env.PORT}`;
}

export function hasSmtpConfig(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.EMAIL_FROM);
}
