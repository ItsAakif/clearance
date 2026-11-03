// Fast, Standard, Deep, and Full run budgets as named constants
// (T880; ADR-033 decisions 2-4).
//
// This module is the ONE definition of what each wire mode means in resource
// terms. `fast` is the legacy interactive mode and remains the default;
// `standard` is the mainstream sweep, `deep` is the deeper coverage mode, and
// `full` is a client-driven sweep whose work is bounded per batch. The
// orchestrator, the estimate (wave 9), and the UI (wave 10) all read these
// values; no magic numbers belong in routes.
//
// RATIONALE PER FIELD (engineering judgement, not magic numbers):
//   maxUnits ............ total boards/pages attempted per run.
//                         FAST=24: one pass over today's ~24 user boards - the
//                         pre-wave fan-out touched every active board once, so
//                         a fast run keeps that coverage and nothing more.
//                         STANDARD=60: a mainstream and aggregator sweep with
//                         bounded follow-up work.
//                         DEEP=400: covers the wider source set and capped
//                         registry pages.
//                         FULL is the FULL_BATCH_PAGES (page term) +
//                         FULL_BATCH_BOARD_HEADROOM (board term, first batch
//                         only) composition - declared as an expression so the
//                         coupling cannot drift again (the defect D7/T910
//                         exists to fix). The board term does not halve with
//                         the page term, so the cap cannot be doubled by
//                         doubling the page count (T906's naive
//                         120 -> 240 FAILS the live composition: 59 boards +
//                         200 pages = 259 > 240). Derived rationale:
//                           - registry pages -> units is AT MOST 1:1
//                             (orchestrator.ts
//                             addRegistryPages pushes exactly one candidate per
//                             page; unroutable rows short-circuit to
//                             preRecorded, and rows gated out by gateByGroup /
//                             gateByMode `return` before candidates.push, so
//                             neither can reach the cap). The 1:1 case is the
//                             worst case the requirement below assumes.
//                           - required for no truncation on batch 1 (worst
//                             case, 1:1):
//                             maxUnits >= FULL_BATCH_PAGES + 59 = 259.
//                           - chosen: 200 + 120 = 320. Margin: 61 units
//                             (23.5%) above the observed worst case, plus 2x
//                             headroom on the 59-board live fan-out
//                             (FULL_BATCH_BOARD_HEADROOM = 120).
//                           - documented non-defect: in the pathological
//                             all-timeout case 320 exceeds the width-32
//                             capacity `32 x floor(180_000/20_000) = 288`; the
//                             BATCH DEADLINE truncates before maxUnits does -
//                             the pre-existing rewind path. maxUnits remains
//                             the binding bound for the realistic
//                             (fast-unit) case.
//   maxConcurrent ....... pool width for CHEAP tiers (API/feed/HTTP run
//                         in-process and hold no browser session).
//                         FAST=4: interactive latency without hammering
//                         providers. STANDARD=6: more parallel mainstream
//                         coverage. DEEP=8: throughput for coverage and
//                         batch processing.
//                         FULL=32: the Full sweep is a deliberately heavier
//                         operation on shared ATS hosts (ADR-034 D1) and the
//                         per-bucket admission gate (ADR-034 D2, T907) is what
//                         bounds it further; 32 was the smallest frozen default
//                         with a real margin under the corrected batch model
//                         `100 / (100*2.35/P + 1.5)` (24 -> ~2.28 h, a miss;
//                         32 -> ~1.71 h, 15% margin). The env knob
//                         `SEARCH_FULL_MAX_CONCURRENCY` is now LIVE on the
//                         Full route (T906: previously dead because the route
//                         passed the frozen constant) and is CLAMPED to
//                         [1, FULL_CONCURRENCY_CEILING=64] so a self-hoster
//                         cannot turn the sweep into an accidental stampede.
//                         Browser units are a SUBSET of this width and never
//                         exceed CAMOUFOX_MAX_CONCURRENCY - see
//                         `browserConcurrencyFor` below, which makes the
//                         relationship explicit in code (T723 owns the
//                         browser ceiling; this module must not invent a
//                         second one).
//   perUnitTimeoutMs .... a unit that exceeds this is marked failed and the
//                         pool moves on (a slow source never stalls a run).
//                         FAST=8000: snappy interactive feel.
//                         STANDARD=15000: enough time for mainstream sources.
//                         DEEP/FULL=20000: lets slow career pages finish
//                         because the user explicitly opted into waiting.
//   totalBudgetMs ....... wall-clock bound per request (ADR-013: a per-request
//                         bound, not a background job - there is no scheduler,
//                         timer, or queue in this module). Standard and Deep
//                         are single bounded requests; Full is deliberately
//                         bounded per client-driven batch and has no total
//                         run limit.
//                         FAST=20000: sub-second-to-few-seconds interactive
//                         behaviour plus headroom. STANDARD=240000 is the
//                         approximately 3-4 minute mainstream sweep.
//                         DEEP=600000 is the approximately 10 minute coverage
//                         sweep. FULL=180000 is the per-batch bound.
//                         The Full env knob `SEARCH_FULL_BUDGET_MS` is now
//                         LIVE on the route (T906) and is CLAMPED to
//                         [FULL_BUDGET_MS_MIN=30_000, FULL_BUDGET_MS_MAX=600_000].
//                         Width-interaction at the frozen T910 values
//                         (FULL_BATCH_PAGES=200, maxConcurrent=32): a
//                         200-page all-20s batch needs
//                         `ceil(200/32)*20 = 7*20 = 140 s < 180 s`, so the
//                         wall clock still does not fire on this frozen
//                         width. (At the pre-wave width 8 the same batch
//                         needed `ceil(200/8)*20 = 500 s > 180 s` and that
//                         is why the wall clock fired before. The pre-T910
//                         width-8 / 100-page combination needed `260 s`,
//                         which is the same gap class - no new behaviour
//                         class is introduced here; T906's documented rewind
//                         path still owns it.) With maxUnits raised to 320
//                         (= FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM),
//                         the only remaining truncation cause on batch 1 is
//                         the documented 59 boards + 200 pages = 259 < 320
//                         composition, which fits with 61 units of margin
//                         (23.5%). The rewind seam
//                         (`rewindRegistryBeforeUnattempted`, T905) still owns
//                         the cursor: fetched-but-never-launched pages are
//                         returned to the next batch and never silently lost.
//   perSourceResultCap .. rows kept per source before merge/dedupe.
//                         FAST=10: first page is enough interactively.
//                         STANDARD=20: broader mainstream coverage.
//                         DEEP/FULL=40: coverage for the later evaluation
//                         stage and per-batch registry work.
//                         (D7 pins this at 40; raising it is a documented
//                         data-completeness follow-up, not a throughput fix.)
//
// ENV OVERRIDES (self-hoster knobs; defaults stated):
//   SEARCH_FAST_MAX_CONCURRENCY (default 4), SEARCH_DEEP_MAX_CONCURRENCY
//   (default 8), SEARCH_STANDARD_MAX_CONCURRENCY (default 6), SEARCH_FULL_MAX_CONCURRENCY
//   (default 32); SEARCH_FAST_BUDGET_MS (default 20000),
//   SEARCH_DEEP_BUDGET_MS (default 600000), SEARCH_STANDARD_BUDGET_MS
//   (default 240000), SEARCH_FULL_BUDGET_MS (default 180000).
// Full's pool-width and total-budget overrides are CLAMPED to the ranges
// defined by `FULL_CONCURRENCY_CEILING` and `FULL_BUDGET_MS_MIN/MAX` below
// (an unbounded env value is an accidental stampede on third parties,
// ADR-034 D1.2/D1.5). Only pool width and total budget are overridable: a
// self-hoster plausibly retunes parallelism and wall-clock for their
// hardware, but maxUnits, perUnitTimeoutMs and perSourceResultCap are
// product semantics shared by the orchestrator, estimate and UI, so they
// stay fixed. Invalid values (missing, non-numeric, < 1) fall back to the
// default. As of T906, the Full env row is LIVE on the route
// (`routes/jobs.fullscan.ts` calls `budgetFor('full')` per request); it had
// been documented for two waves but was short-circuited by the route
// passing the frozen `FULL_BATCH_BUDGET` constant.
//
// SCOPE CAPS (fixed product guards - deliberately NOT env-overridable):
//   COMPANY_SCOPE_CAP and REGISTRY_SCOPE_CAP are the legacy `fast` caps.
//   MODE_SCOPE_CAPS is the per-mode table consumed by the orchestrator. An
//   intent with no companies does NOT expand to the whole registry; overflow
//   is truncated and reported, never silently searched. Full is the only mode
//   with an unbounded registry cap, and that mode uses its dedicated bounded
//   batch route.

import { env } from '../config/env.js';

/**
 * Structural ceiling for browser-parallelism, owned by the wave-6 browser
 * pool (T723: `CAMOUFOX_MAX_CONCURRENCY` in `backend/src/browser/pool.ts`
 * reads this same `env.CAMOUFOX_MAX_CONCURRENCY`). This module deliberately
 * references the EXISTING cap rather than inventing a second ceiling - and
 * deliberately imports it from config, not from `browser/`, because N2
 * forbids static imports of `backend/src/browser/*` outside the registry
 * lazy path (pinned by `src/browser/tier.test.ts`).
 */
const BROWSER_CONCURRENCY_CEILING: number = env.CAMOUFOX_MAX_CONCURRENCY;

export type SearchMode = 'fast' | 'standard' | 'deep' | 'full';

export interface RunBudget {
  maxUnits: number; // total boards/pages attempted
  maxConcurrent: number; // pool width
  perUnitTimeoutMs: number;
  totalBudgetMs: number; // wall clock
  perSourceResultCap: number;
}

export const FAST_BUDGET: RunBudget = Object.freeze({
  maxUnits: 24,
  maxConcurrent: 4,
  perUnitTimeoutMs: 8000,
  totalBudgetMs: 20000,
  perSourceResultCap: 10,
});

/** Mainstream source sweep: ATS, feeds, and aggregators. */
export const STANDARD_BUDGET: RunBudget = Object.freeze({
  maxUnits: 60,
  maxConcurrent: 6,
  perUnitTimeoutMs: 15000,
  totalBudgetMs: 240000,
  perSourceResultCap: 20,
});

/** Deeper source coverage, including the capped registry scope. */
export const DEEP_BUDGET: RunBudget = Object.freeze({
  maxUnits: 400,
  maxConcurrent: 8,
  perUnitTimeoutMs: 20000,
  totalBudgetMs: 600000,
  perSourceResultCap: 40,
});

/**
 * Maximum registry pages considered in one Full-scan request. 200 pages is
 * the measured batch-size requirement for AC24 (9.7 p/s x the width-32 mean
 * slowest unit 16.2975 s = 158.1 pages; 200 gives margin). See ADR-034
 * amendment (D7) and T901 evidence section 7.4.
 */
export const FULL_BATCH_PAGES = 200;

/**
 * Board-fan-out headroom reserved on the first Full batch. The first batch
 * carries the user's boards PLUS the page batch; the boards are the term
 * that does NOT scale with `FULL_BATCH_PAGES`. The observed live fan-out is
 * 59 boards (spec EDGE CASES 1: "59 boards + 100 pages = 159 units"); 120 is
 * 2x that, rounded, so the constant survives a user with twice as many
 * boards without re-tuning. See ADR-034 amendment (D7) and T910.
 */
export const FULL_BATCH_BOARD_HEADROOM = 120;

/**
 * Per-batch budget for the client-driven Full registry sweep.
 *
 * Why 32 and not 24: `throughput(P) = 100 / (100 * 2.35 / P + 1.5)` puts 24 at
 * ~2.28 h (a miss) and 32 at ~1.71 h, so 32 is the smallest frozen default with a
 * real margin (ADR-034 D1.3). `maxConcurrent` here is a per-request pool WIDTH,
 * NOT a rate limit - the per-bucket admission gate (ADR-034 D2, T907) is what
 * bounds it further, so this number is admissible. T901 later measured the
 * batch as TAIL-bound, not queue-bound; T910 (D7) supersedes the batch-size
 * term: `FULL_BATCH_PAGES` 100 -> 200, `maxUnits` derived as
 * `FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM` = 320. `maxUnits` is
 * deliberately NOT env-overridable (it is coupled to `FULL_BATCH_PAGES`, not
 * a hardware knob). The non-batch fields below stay as they stand here.
 */
export const FULL_BATCH_BUDGET: RunBudget = Object.freeze({
  maxUnits: FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM,
  maxConcurrent: 32,
  perUnitTimeoutMs: 20000,
  totalBudgetMs: 180000,
  perSourceResultCap: 40,
});

/**
 * Upper bound for the Full `SEARCH_FULL_MAX_CONCURRENCY` env override. The
 * Full sweep is a deliberately heavier operation on shared ATS hosts (ADR-034
 * D1, D2); an unbounded env value is an accidental stampede on third parties,
 * so we clamp it here and not in the route. 64 is roughly twice the documented
 * pool and well above the keep-alive ceiling for any single shared ATS host
 * (`boards-api.greenhouse.io` measured 26.1 r/s with 20 sockets, zero errors).
 */
export const FULL_CONCURRENCY_CEILING = 64;

/** Lower bound for the Full `SEARCH_FULL_BUDGET_MS` env override. Below 30 s
 * a FULL_BATCH_PAGES (200-page) all-20 s batch cannot finish even at the
 * width ceiling (`ceil(200/64)*20 = 80 s > 30 s`); any smaller bound is
 * silently equivalent to `cancel`. */
export const FULL_BUDGET_MS_MIN = 30_000;

/** Upper bound for the Full `SEARCH_FULL_BUDGET_MS` env override. Ten minutes
 * keeps a single request from holding the route indefinitely - the route is
 * per-batch bounded by design (no scheduler, no background continuation). */
export const FULL_BUDGET_MS_MAX = 600_000;

/** Full run snapshots are refreshed after each batch for 30 minutes. */
export const FULL_RUN_TTL_MS = 30 * 60 * 1000;

/** Deep run snapshots remain available for 12 minutes. */
export const DEEP_RUN_TTL_MS = 12 * 60 * 1000;

/** Max company names expanded per query (legacy/fast fixed guard). */
export const COMPANY_SCOPE_CAP: number = 10;

/** Max registry pages resolved per run (legacy/fast fixed guard). */
export const REGISTRY_SCOPE_CAP: number = 50;

export interface ModeScopeCaps {
  companyCap: number;
  registryCap: number;
}

/**
 * Scope limits are part of the mode contract, not process-wide knobs. The
 * outer and inner objects are frozen so an accidental consumer mutation cannot
 * turn a bounded mode into a different mode's scope. Full is the sole
 * unbounded registry mode; its company cap is retained as a harmless
 * placeholder because Full does not resolve named-company scopes.
 */
export const MODE_SCOPE_CAPS: Readonly<Record<SearchMode, ModeScopeCaps>> = Object.freeze({
  fast: Object.freeze({ companyCap: 10, registryCap: 50 }),
  standard: Object.freeze({ companyCap: 10, registryCap: 0 }),
  deep: Object.freeze({ companyCap: 10, registryCap: 200 }),
  full: Object.freeze({ companyCap: 10, registryCap: Number.POSITIVE_INFINITY }),
});

/** Return the mode's scope caps without exposing the table's nested objects. */
export function scopeCapsFor(mode: SearchMode): ModeScopeCaps {
  return { ...(MODE_SCOPE_CAPS[mode] ?? MODE_SCOPE_CAPS.fast) };
}

/** Standard is the only mode with a source-group envelope. */
export const STANDARD_SOURCE_GROUPS = ['ats', 'feeds', 'aggregators'] as const;

export function modeGroupEnvelope(mode: SearchMode): readonly string[] | null {
  return mode === 'standard' ? STANDARD_SOURCE_GROUPS : null;
}

/** Tier-4 browser follow-ups are opt-in and limited to Deep/Full. */
export function browserTierAllowed(mode: SearchMode): boolean {
  return mode === 'deep' || mode === 'full';
}

/** AI subset evaluation is limited to Deep/Full. */
export function aiEvaluationAllowed(mode: SearchMode): boolean {
  return mode === 'deep' || mode === 'full';
}

/**
 * Browser-parallelism allowed under a run budget. The orchestrator's pool
 * width (`maxConcurrent`) covers cheap tiers; browser units are a subset
 * that can never exceed the browser pool's own structural ceiling
 * (`BROWSER_CONCURRENCY_CEILING`, i.e. the T723 `CAMOUFOX_MAX_CONCURRENCY`
 * cap). This function - not prose - is where the two ceilings meet.
 */
export function browserConcurrencyFor(budget: RunBudget): number {
  return Math.min(budget.maxConcurrent, BROWSER_CONCURRENCY_CEILING);
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  return floored >= 1 ? floored : fallback;
}

/**
 * Bounded integer clamp. Used by `budgetFor('full')` to cap the env-driven
 * pool width and total-budget overrides at the published
 * `FULL_CONCURRENCY_CEILING` / `FULL_BUDGET_MS_MIN/MAX` ranges so a
 * self-hoster cannot accidentally turn the Full sweep into a stampede on
 * third-party hosts (ADR-034 D1.2/D1.5). The inputs are already
 * `envPositiveInt`-filtered integers, so plain `Math.min`/`Math.max` are
 * safe; `Math.floor` defends against an unexpected fractional value.
 */
function clamp(value: number, min: number, max: number): number {
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

/**
 * Budget for a mode, shared by the orchestrator and the UI. Reads the
 * documented env overrides live (per request, no import-time freeze) and
 * returns a fresh object on every call so callers cannot mutate the shared
 * budget defaults. Unknown modes fall back to fast.
 */
export function budgetFor(mode: SearchMode): RunBudget {
  switch (mode) {
    case 'standard':
      return {
        ...STANDARD_BUDGET,
        maxConcurrent: envPositiveInt('SEARCH_STANDARD_MAX_CONCURRENCY', STANDARD_BUDGET.maxConcurrent),
        totalBudgetMs: envPositiveInt('SEARCH_STANDARD_BUDGET_MS', STANDARD_BUDGET.totalBudgetMs),
      };
    case 'deep':
      return {
        ...DEEP_BUDGET,
        maxConcurrent: envPositiveInt('SEARCH_DEEP_MAX_CONCURRENCY', DEEP_BUDGET.maxConcurrent),
        totalBudgetMs: envPositiveInt('SEARCH_DEEP_BUDGET_MS', DEEP_BUDGET.totalBudgetMs),
      };
    case 'full':
      // Clamp the env override to the bounded range declared above. An
      // unbounded env value is an accidental stampede on third parties
      // (ADR-034 D1.2/D1.5); `envPositiveInt` still falls back to the
      // frozen default when the env value is missing / non-numeric / < 1.
      // `maxUnits` is deliberately NOT env-overridable here: it is coupled
      // to `FULL_BATCH_PAGES` (T910 / D7, `FULL_BATCH_PAGES +
      // FULL_BATCH_BOARD_HEADROOM`), not a hardware knob. A self-hoster who
      // wants a different cap must change the constants, not pass an env.
      return {
        ...FULL_BATCH_BUDGET,
        maxConcurrent: clamp(
          envPositiveInt('SEARCH_FULL_MAX_CONCURRENCY', FULL_BATCH_BUDGET.maxConcurrent),
          1,
          FULL_CONCURRENCY_CEILING,
        ),
        totalBudgetMs: clamp(
          envPositiveInt('SEARCH_FULL_BUDGET_MS', FULL_BATCH_BUDGET.totalBudgetMs),
          FULL_BUDGET_MS_MIN,
          FULL_BUDGET_MS_MAX,
        ),
      };
    case 'fast':
    default:
      return {
        ...FAST_BUDGET,
        maxConcurrent: envPositiveInt('SEARCH_FAST_MAX_CONCURRENCY', FAST_BUDGET.maxConcurrent),
        totalBudgetMs: envPositiveInt('SEARCH_FAST_BUDGET_MS', FAST_BUDGET.totalBudgetMs),
      };
  }
}
