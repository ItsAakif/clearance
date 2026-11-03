// Per-bucket politeness gate (T907; ADR-034 decision 2; spec section 7).
//
// The wider Full-sweep pool (T906: 32-wide) is bound to the per-bucket caps
// in this module. The gate is a pure in-process admission primitive: no
// prisma, no fetch, no timers of its own (the pool owns waiting), and an
// injected `now: () => number` so a test can drive a deterministic clock.
//
// KEY RULE (ADR-034 D2.1, recorded here, not delegated to a different file):
//   - When the row's provider resolves to a JSON adapter
//     (`adapterTypeFor(provider)` is non-null), the bucket key is
//     `provider:<providerId>`. The adapter determines the upstream host 1:1
//     (lever -> api.lever.co, greenhouse -> boards-api.greenhouse.io, ...).
//     We do NOT use `(provider, boardToken)` buckets: one row is one board
//     token, so every such bucket has exactly one entry and a cap of 1 or 8
//     is never reached. The concentration that matters is on the shared API
//     host, which is a function of the provider alone.
//   - The id in the key is the CANONICAL (fully resolved) adapter id, not
//     the raw registry id. `resolveAdapterBucketId` collapses every spelling
//     - registry id ('breezy'), alias target ('breezyhr'), and the four
//     aggregator members ('adzuna'|'usajobs'|'reed'|'findwork' -> 'aggregator')
//     - onto one bucket, because the canonical id is what actually names the
//     shared upstream host. The orchestrator passes the ALREADY-RESOLVED
//     adapter type (`PlannedUnit.providerType` is `config.type`), so the
//     resolver must accept that spelling too; see the function comment.
//   - Otherwise the key is `host:<host>`. When the row's `host` is missing
//     or empty, derive it from `pageUrl`; if neither is usable, use the
//     `fallback` key.
//
// POLICY TABLE (frozen defaults, ADR-034 D2.2; values justified by first-
// party measurement, not modelled):
//   provider:lever             -> { maxConcurrent: 4, minGapMs: 0 }
//                                  // DECISION D1: lever advisory posture.
//                                  // Strict alternative is {1, 1000}.
//   other shared-ATS provider  -> { maxConcurrent: 20, minGapMs: 0 }
//   host:* (tier-3)            -> { maxConcurrent: 2, minGapMs: 0 }
//   browser                    -> { maxConcurrent: 1, minGapMs: 0 }
//   fallback / unknown         -> { maxConcurrent: 4, minGapMs: 0 }
// ONLY the lever row varies between advisory/strict posture; every other
// row is frozen. The handler chooses by editing the table data above.
//
// HARDENING (recorded, not implied):
//   - Every policy value is validated at module load. A policy that
//     silently parses to 0/NaN/Infinity is a SILENT NO-OP politeness
//     (research failure mode 4); module load fails loudly with a clear
//     message naming the offending key/value.
//   - `now` is injected and monotonic for the gate's own logic; the gate
//     never calls `Date.now()` (matches the crawler's injected-clock
//     convention).
//   - Bucket state is in-process and LRU-bounded by `maxTrackedBuckets`
//     (default 4096). The bound is a SOFT TARGET: eviction refuses any
//     bucket with `inFlight !== 0`, `blockedUntilMs > now`, OR a non-zero
//     `deferred` counter, so a bucket that ever had a parking event is
//     retained permanently. Under sustained pressure the table may
//     transiently exceed `maxTracked`; preserving accounting on every
//     active/blocked bucket is more important than bounding the table
//     exactly (decision adjudicated as accepted trade-off; a future task
//     can drop the `deferred` veto and bound the recency splice O(1)-ish).
//     `promoteRecency` is currently O(n) (`indexOf` + `splice` + `unshift`),
//     which is acceptable at 4096 but is a hot-path smell under burst.
//   - `SEARCH_FULL_POLITENESS=off` (route layer) bypasses the gate entirely.
//     The route carries a bounded `politeness` marker on the response
//     so an unprotected sweep is never silent (T908: the marker upgraded from
//     the string `'off'` to the bounded object
//     `{ mode, signals, blocks, deferred, wiringOk }`).
//
// 429/503 BACKOFF (T908; ADR-034 decision 2.4; spec section 7). The gate above
// knows caps and gaps but not SERVER PRESSURE: a wider pool (T906: 32) that
// only respects caps can still become a retry storm against a host that is
// actively asking us to back off. This section adds the in-process 429/503
// backoff, with the parameters taken first-party from StormCrawler 3.7.0
// `HostBackoff` (base 60 s, factor 2, cap 24 h, jitter 0.10, decay 30 min) and
// the rules ADR-034 D2.4 pins on top of them:
//   - only 429 and 503 open a block. 403 NEVER does: it is classified `blocked`
//     for health by T902/T903 (a different, persistent condition) and turning a
//     forbidden page into a 24 h bucket block would take a whole sweep with it.
//     5xx other than 503 never open one either.
//   - `Retry-After` is honoured in BOTH RFC 9110 forms (delta-seconds and
//     HTTP-date). It is parsed HERE, locally: Node's `fetch` exposes the raw
//     header string and does no date parsing, so the gate owns it. Capped at
//     24 h. Unparseable / zero / negative / already-past values are IGNORED and
//     the run falls through to the pressure path (never a shorter block, never
//     a longer one than the ladder allows).
//   - `only-extend`: an existing later `blockedUntilMs` is never shortened, and
//     the existing end is RETURNED so the caller re-asserts it.
//   - `one-event-per-window`: a signal arriving while the block is active is
//     the SAME congestion event and does NOT escalate. Without this rule a
//     single 429 at a shared host escalates to 24 h within milliseconds,
//     because every in-flight unit reports its own failure for the same
//     upstream.
//   - jitter is multiplied ONCE, after the candidate is computed and BEFORE the
//     only-extend comparison, so a jitter draw can never shorten a block that is
//     already on the books.
//   - forgiveness/decay is 30 min measured FROM BLOCK EXPIRY, not from the last
//     event: a blocked bucket is silent by construction, so the silence clock
//     only starts once it may be fetched again.
//   - the min-gap delay and the backoff merge with MAX, never sum (asserted on
//     `nextReadyAt`, which is unchanged by this task - it already returns
//     whichever constraint releases later).
//
// STATE LIFETIME (recorded, not delegated): the backoff state is IN-PROCESS
// only and dies with the process. There is deliberately NO new table (spec
// constraint): a restart re-learns from base 60 s, which is the correct
// behaviour for a rate limiter whose evidence is a live upstream condition and
// whose persistence would be a stale claim about someone else's server.

import { adapterTypeFor } from '../registry/providers.js';
import { getProvider } from '../jobSources/providerRegistry.js';

/**
 * JSON adapter kinds (ADR-034 D2.1). A row that resolves to one of these
 * `ProviderDescriptor.kind` values hits a SHARED upstream host 1:1 with the
 * provider id (lever -> api.lever.co, greenhouse -> boards-api.greenhouse.io,
 * ...); per-bucket politeness buckets them on the provider id alone. Every
 * other resolved adapter (the `career-page` HTML fetch at tier 3, the
 * `browser` tier 4 path) fetches the row URL directly and buckets on host.
 */
const JSON_ADAPTER_KINDS: ReadonlySet<string> = new Set(['api', 'json', 'aggregator']);

/**
 * True when the row's resolved adapter is a JSON adapter (the row hits a
 * shared upstream API host). The check uses the descriptor's `kind` so a
 * row whose provider is `null` (the tier-3 placeholder that resolves to
 * `career-page`, kind `feed`) is correctly bucketed on host, NOT on
 * `provider:`. `adapterTypeFor(provider)` alone returns `'career-page'`
 * for null providers, which would mis-classify tier-3 rows as JSON
 * adapters - the kind check is the precise discriminator.
 */
function isJsonAdapterKind(adapterType: string): boolean {
  const d = getProvider(adapterType);
  if (d === undefined) return false;
  return JSON_ADAPTER_KINDS.has(d.kind);
}

// ---------------------------------------------------------------------------
// Bucket key + policy table (frozen defaults)
// ---------------------------------------------------------------------------

/** Bucket key: `provider:<id>` for JSON-adapter rows, `host:<host>` otherwise. */
export type PolitenessKey = string;

export interface BucketPolicy {
  maxConcurrent: number;
  minGapMs: number;
}

/** Default policy applied when no other rule matches (e.g. unknown host). */
export const DEFAULT_BUCKET_POLICY: BucketPolicy = { maxConcurrent: 4, minGapMs: 0 };

/**
 * Provider-keyed table. Only the keys below get a custom policy; every other
 * shared-ATS provider bucket falls through to the "shared-ATS" row via
 * `policyFor`. The lever row is the ONLY one whose values differ between
 * the advisory posture (default here, `{maxConcurrent:4, minGapMs:0}`)
 * and the strict alternative (D1: `{maxConcurrent:1, minGapMs:1000}`); a
 * user switching posture edits ONLY this row.
 */
export const PROVIDER_BUCKET_POLICIES: Readonly<Record<string, BucketPolicy>> = Object.freeze({
  // DECISION D1 (spec `.planning/specs/sweep-throughput-p0.md`): lever
  // advisory posture is honoured here. The strict alternative lives in
  // ADR-034 D2.2 as `{maxConcurrent:1, minGapMs:1000}`; a self-hoster
  // choosing the strict posture edits ONLY this row.
  lever: { maxConcurrent: 4, minGapMs: 0 },
});

/** Tier-3 host policy: small per-host cap on cold-probed career pages. */
export const TIER3_HOST_POLICY: BucketPolicy = { maxConcurrent: 2, minGapMs: 0 };

/** Browser tier policy: wave-6 browser-pool precedent (1 at a time). */
export const BROWSER_BUCKET_POLICY: BucketPolicy = { maxConcurrent: 1, minGapMs: 0 };

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

export interface PolitenessKeyInput {
  providerType: string;
  tier: number;
  provider?: string | null;
  host?: string | null;
  pageUrl?: string | null;
}

/**
 * Resolve the row's provider to the canonical ADAPTER id that names its
 * bucket, or `null` when the row is not JSON-adapter routed.
 *
 * Two spellings of the same row reach this function and BOTH must resolve to
 * the same canonical id, otherwise one upstream splits into two buckets:
 *
 *   1. A REGISTRY provider id (`'breezy'`, `'pinpointhq'`, `'adzuna'`, ...).
 *      `adapterTypeFor` maps it through the alias table to the adapter
 *      (`'breezyhr'`, `'pinpoint'`, `'aggregator'`); identity ids such as
 *      `'lever'` are a fixed point.
 *   2. An ALREADY-RESOLVED adapter type (`'breezyhr'`, `'pinpoint'`,
 *      `'aggregator'`). This is what the orchestrator actually passes:
 *      `PlannedUnit.providerType` is `config.type` from
 *      `configForRegistryRow`, i.e. the adapter, not the registry id. Those
 *      strings are NOT `REGISTRY_PROVIDERS` ids, so `adapterTypeFor` returns
 *      null for them and the row used to fall through to the host branch.
 *
 * That fall-through was the live D2 defect: an aliased row bucketed on its
 * COMPANY-PAGE host while the fetch hit the SHARED upstream API host, so a
 * batch of `pinpointhq` rows put one bucket per company on a single Pinpoint
 * API - unbounded concurrency on one upstream, the exact millipede ADR-034
 * D2.1 rejects. Falling back to "is this a known adapter type?" accepts the
 * second spelling without changing the first.
 */
function resolveAdapterBucketId(provider: string | null): string | null {
  if (provider === null) return null;
  const fromRegistryId = adapterTypeFor(provider);
  if (fromRegistryId !== null) return fromRegistryId;
  // Already an adapter type (the orchestrator's shape). Accept it only when
  // the adapter registry actually knows it, so an unknown/deferred id still
  // degrades to the host branch rather than minting a bucket that no policy
  // row governs.
  return getProvider(provider) !== undefined ? provider : null;
}

/**
 * Derive the politeness bucket key from the row metadata. The KEY RULE is
 * recorded in the file header and not delegated: the row's resolved
 * adapter kind (not its provider) decides between `provider:<id>` and
 * `host:<host>`, so this function NEVER returns a `(provider, boardToken)`
 * shape (those buckets would each have one row).
 */
export function politenessKeyFor(input: PolitenessKeyInput): PolitenessKey {
  const provider = input.provider ?? null;
  // The KEY RULE is precise: we bucket on `provider:<canonical id>` ONLY
  // when the resolved adapter is a JSON adapter (kind 'api' / 'json' /
  // 'aggregator'). A tier-3 row with `provider: null` resolves to
  // `career-page` (kind 'feed') and is bucketed on its host, not on
  // `provider:` - one row per host is what matters, not one row per
  // provider alias.
  //
  // T907 D2 (review-T907 D2): the bucket must be keyed on the RESOLVED
  // CANONICAL adapter id, which is what names the shared upstream host, and
  // NOT on the raw registry id. Registry ids `breezy`/`pinpointhq` alias to
  // adapters `breezyhr`/`pinpoint`, and the four aggregator members
  // (`adzuna`, `usajobs`, `reed`, `findwork`) all resolve to the single
  // `aggregator` adapter (registry/providers.ts:111-114,123,126). Keying on
  // the raw id splits one upstream into several buckets; keying on the
  // company-page host splits it per company. Both leave the shared upstream
  // unbounded. `resolveAdapterBucketId` collapses every spelling - registry
  // id, alias, or already-resolved adapter type - onto the same canonical
  // bucket, which is the only shape that actually bounds the upstream.
  const adapterType = resolveAdapterBucketId(provider);
  if (adapterType !== null && isJsonAdapterKind(adapterType)) {
    return `provider:${adapterType}`;
  }
  // Tier-3 (owned page) / browser follow-up: bucket on the host.
  const host = (input.host ?? '').trim();
  if (host.length > 0) return `host:${host}`;
  // Derive host from pageUrl when the row's host column is missing.
  const url = (input.pageUrl ?? '').trim();
  const derived = deriveHostFromUrl(url);
  if (derived !== null) return `host:${derived}`;
  return 'fallback';
}

/** Return the table-resolved policy for a bucket key. */
export function policyFor(key: PolitenessKey): BucketPolicy {
  if (key.startsWith('provider:')) {
    const id = key.slice('provider:'.length);
    const explicit = (PROVIDER_BUCKET_POLICIES as Record<string, BucketPolicy | undefined>)[id];
    if (explicit !== undefined) return explicit;
    // Other shared-ATS provider rows share the published default (ADR-034
    // D2.2: measured 26.1 r/s / 20 sockets, zero errors, p99 703 ms at c=64).
    return { maxConcurrent: 20, minGapMs: 0 };
  }
  if (key.startsWith('host:')) {
    return TIER3_HOST_POLICY;
  }
  if (key === 'browser') return BROWSER_BUCKET_POLICY;
  return DEFAULT_BUCKET_POLICY;
}

// ---------------------------------------------------------------------------
// 429/503 backoff (T908; ADR-034 D2.4; spec section 7)
// ---------------------------------------------------------------------------

/**
 * Per-bucket backoff state. `blockedUntilMs` is the seam the admission gate
 * already read in T907 (`tryAcquire` refuses before it, `nextReadyAt` returns
 * it, `snapshot` publishes it); T907 shipped the predicate with no writer and
 * `noteBlocked` below is that writer.
 */
export interface BackoffState {
  /** Current backoff step in whole seconds (0 when the bucket has never been blocked). */
  backoffSecs: number;
  /** Monotonic ms until which the bucket must not be fetched. 0 = not blocked. */
  blockedUntilMs: number;
  /** Monotonic ms of the last observed 429/503 on this bucket (0 = never). */
  lastEventMs: number;
  /** Observed 429/503 signals counted into the CURRENT block window. */
  eventsInWindow: number;
}

/** StormCrawler `HostBackoff` first step, in seconds. */
export const BACKOFF_BASE_SECS = 60;
/** StormCrawler growth factor per window. */
export const BACKOFF_FACTOR = 2;
/** StormCrawler cap, in seconds (24 h). Also caps a honoured `Retry-After`. */
export const BACKOFF_CAP_SECS = 86_400;
/** StormCrawler jitter fraction, applied symmetrically (+/- 10%). */
export const BACKOFF_JITTER = 0.1;
/** StormCrawler decay / forgiveness window, in seconds (30 min) from block EXPIRY. */
export const BACKOFF_DECAY_SECS = 1_800;

/**
 * The ONLY two statuses that open a rate-limit block. 403 is deliberately
 * absent (ADR-034 D2.4): it is `blocked` for health (T902/T903) but a
 * forbidden page is not a request-rate signal, and escalating it would park a
 * whole bucket for 24 h over a permissions problem. 5xx other than 503 are
 * upstream faults, not rate limiting.
 */
export function isRateLimitStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Fresh (never-blocked) backoff state, the only input a first signal needs. */
export function emptyBackoffState(): BackoffState {
  return { backoffSecs: 0, blockedUntilMs: 0, lastEventMs: 0, eventsInWindow: 0 };
}

/**
 * Parse a verbatim `Retry-After` header into whole seconds of wait.
 *
 * RFC 9110 allows exactly two forms and this function accepts exactly those:
 *   - `delta-seconds`: 1*DIGIT only. `0`, a sign, or a fraction is NOT a
 *     delta-seconds value.
 *   - `HTTP-date`: parsed locally with `Date.parse`, which Node implements for
 *     all three legal date spellings. Node's `fetch` does not parse this header
 *     for us - it hands over the raw string - so the parse lives here.
 *
 * Returns `null` for every value that cannot be honoured as a wait: absent,
 * blank, unparseable, zero, negative, or a date that is not in the future
 * (including exactly-now). The caller then falls through to the pressure path,
 * which is always >= 60 s, so a bad header can never shorten a block.
 */
function retryAfterSecsOf(raw: string | null, nowMs: number): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (/^[0-9]+$/.test(text)) {
    const secs = Number(text);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    return secs;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const deltaMs = at - nowMs;
  if (deltaMs <= 0) return null;
  return Math.ceil(deltaMs / 1000);
}

/**
 * The next ladder step, in seconds: `max(base, prev * factor)`, capped, with
 * the forgiveness decay applied FIRST. The silence window runs from BLOCK
 * EXPIRY (`state.blockedUntilMs`), not from the last event, because a bucket
 * that is blocked cannot produce a new event - measuring from the last event
 * would decay a bucket that is still mid-block. A silence strictly longer than
 * `BACKOFF_DECAY_SECS` forgives the bucket back to base.
 */
function nextBackoffSecs(state: BackoffState, nowMs: number): number {
  const prev = Number.isFinite(state.backoffSecs) && state.backoffSecs > 0 ? state.backoffSecs : 0;
  const forgiven = prev > 0 && nowMs - state.blockedUntilMs > BACKOFF_DECAY_SECS * 1000;
  const from = forgiven ? 0 : prev;
  return Math.min(BACKOFF_CAP_SECS, Math.max(BACKOFF_BASE_SECS, from * BACKOFF_FACTOR));
}

/**
 * PURE backoff decision (T908). Given the bucket's current state, an observed
 * status, the verbatim `Retry-After` header, and the current monotonic ms,
 * answer "until when is this bucket blocked, at what step, and did this signal
 * open/extend a block".
 *
 * `jitterFactor` is the caller's symmetric jitter multiplier in `[1 - jitter,
 * 1 + jitter]`. It defaults to exactly 1 so this function stays PURE (no
 * `Math.random`, no clock, no I/O); `PolitenessGate.noteBlocked` is the only
 * caller that draws one, ONCE, and passes it here. The draw is applied AFTER
 * the candidate is computed and BEFORE the only-extend comparison, so jitter can
 * never shorten a block that is already on the books.
 *
 * `escalated` is true ONLY when this call opened or extended a block. It is
 * false for a status that does not trigger (403/500/timeouts) and false for a
 * signal absorbed by the still-active window (one-event-per-window), which is
 * exactly the condition the `blocksOpened` counter needs.
 */
export function blockUntilFor(
  state: BackoffState,
  status: number,
  retryAfter: string | null,
  nowMs: number,
  jitterFactor = 1,
): { blockedUntilMs: number; backoffSecs: number; escalated: boolean } {
  const unchanged = { blockedUntilMs: state.blockedUntilMs, backoffSecs: state.backoffSecs, escalated: false };
  // Rule 1: only 429/503 trigger. 403 (health-`blocked`) and every other
  // status leave the bucket exactly as it was.
  if (!isRateLimitStatus(status)) return unchanged;
  // Rule 2 (one-event-per-window): a signal while the block is ACTIVE is the
  // same congestion event - every in-flight unit at a shared host reports its
  // own failure. Absorb it; the existing end is returned so it is re-asserted.
  if (nowMs < state.blockedUntilMs) return unchanged;
  // Pressure path: the ladder step, or a honoured `Retry-After` when the
  // server named a wait longer than our own step. The header is a FLOOR we
  // honour (merged with MAX, the same way minGap merges with the backoff), and
  // both terms are capped at 24 h.
  const ladder = nextBackoffSecs(state, nowMs);
  const hinted = retryAfterSecsOf(retryAfter, nowMs);
  const secs = Math.min(
    BACKOFF_CAP_SECS,
    hinted === null ? ladder : Math.max(ladder, hinted),
  );
  const factor = Number.isFinite(jitterFactor) && jitterFactor > 0 ? jitterFactor : 1;
  // The cap is a hard ceiling on the BLOCK LENGTH, so a >1 jitter draw on a
  // 24 h block cannot push the bucket past the documented maximum.
  const waitMs = Math.min(
    BACKOFF_CAP_SECS * 1000,
    Math.max(0, Math.round(secs * 1000 * factor)),
  );
  const candidate = nowMs + waitMs;
  // Rule 3 (only-extend): never shorten an existing later end; re-assert it.
  const blockedUntilMs = Math.max(candidate, state.blockedUntilMs);
  return { blockedUntilMs, backoffSecs: secs, escalated: blockedUntilMs > state.blockedUntilMs };
}


export interface PolitenessSnapshot {
  key: string;
  inFlight: number;
  lastStartMs: number;
  blockedUntilMs: number;
  backoffSecs: number;
  deferred: number;
}

interface BucketState {
  key: string;
  inFlight: number;
  /** Monotonic ms of the last successful launch (0 if never launched). */
  lastStartMs: number;
  /** True once at least one successful `tryAcquire` has happened. The
   *  boolean separates "never launched" from "launched exactly at t=0". */
  hasLaunched: boolean;
  /** Monotonic ms until which the bucket is blocked. Written ONLY by
   *  `noteBlocked` (T908) - T907 shipped this seam as a read-only predicate. */
  blockedUntilMs: number;
  /** Current backoff step in seconds (0 when the bucket is not blocked). */
  backoffSecs: number;
  /** Monotonic ms of the last observed 429/503 on this bucket (0 if never). */
  lastEventMs: number;
  /** Observed 429/503 signals counted into the CURRENT block window. */
  eventsInWindow: number;
  /** Cumulative deferrals recorded by `noteDeferred`. */
  deferred: number;
  /** Last access in monotonic ms (LRU eviction clock). */
  lastAccessMs: number;
}

const DEFAULT_MAX_TRACKED_BUCKETS = 4096;

export class PolitenessGate {
  private readonly now: () => number;
  private readonly maxTracked: number;
  private readonly buckets = new Map<string, BucketState>();
  /** Access-order stack; the front is the most recently touched key. */
  private readonly recency: string[] = [];
  /** Optional injected per-key overrides (test escape hatch). */
  private readonly injectedPolicies: Readonly<Record<string, BucketPolicy>>;
  /** T908: the jitter source. `Math.random` in production; tests inject a
   *  constant so the block length is exact and reproducible. */
  private readonly jitterSource: () => number;

  constructor(
    now: () => number,
    opts?: {
      policies?: Readonly<Record<string, BucketPolicy>>;
      maxTrackedBuckets?: number;
      /** Uniform [0,1) source for the +/-10% block jitter. Defaults to
       *  `Math.random`. Only `noteBlocked` draws from it, exactly once. */
      jitter?: () => number;
    },
  ) {
    if (typeof now !== 'function') {
      throw new Error('PolitenessGate: now must be a function');
    }
    this.now = now;
    if (opts?.jitter !== undefined && typeof opts.jitter !== 'function') {
      throw new Error('PolitenessGate: jitter must be a function returning a number in [0,1)');
    }
    this.jitterSource = opts?.jitter ?? Math.random;
    this.maxTracked = opts?.maxTrackedBuckets ?? DEFAULT_MAX_TRACKED_BUCKETS;
    if (!Number.isFinite(this.maxTracked) || this.maxTracked < 1) {
      throw new Error(
        `PolitenessGate: maxTrackedBuckets must be a finite integer >= 1 (got ${this.maxTracked})`,
      );
    }
    // Module-load hardening: validate every provided policy value. A policy
    // that silently parses to 0/NaN/Infinity is a SILENT NO-OP politeness
    // (research failure mode 4) and must fail loudly instead.
    if (opts?.policies !== undefined) {
      validatePolicies(opts.policies);
      this.injectedPolicies = opts.policies;
    } else {
      this.injectedPolicies = {};
    }
  }

  /**
   * Resolve the bucket's policy: an injected per-key override (test escape
   * hatch) takes precedence over the published `policyFor` table.
   */
  private policyForBucket(key: PolitenessKey): BucketPolicy {
    const injected = (this.injectedPolicies as Record<string, BucketPolicy | undefined>)[key];
    if (injected !== undefined) return injected;
    return policyFor(key);
  }

  /**
   * Try to admit a unit on the gate. Returns `false` when:
   *   - the bucket is at `maxConcurrent` (in-flight cap),
   *   - the bucket is inside `minGapMs` since its last launch,
   *   - the bucket is inside a 429/503 backoff block written by `noteBlocked`
   *     (T908; the writer, not this predicate).
   * Side effect on success: increments `inFlight` and stamps `lastStartMs`.
   * The caller MUST pair success with `release(key)` in a `finally`.
   */
  tryAcquire(key: PolitenessKey): boolean {
    const t = this.now();
    const bucket = this.touch(key, t);
    const policy = this.policyForBucket(key);
    if (bucket.inFlight >= policy.maxConcurrent) return false;
    if (t < bucket.blockedUntilMs) return false;
    // `hasLaunched` distinguishes "never launched" (true sentinel: 0)
    // from "launched exactly at t=0" (a valid monotonic value).
    if (policy.minGapMs > 0 && bucket.hasLaunched && t - bucket.lastStartMs < policy.minGapMs) {
      return false;
    }
    bucket.inFlight += 1;
    bucket.lastStartMs = t;
    bucket.hasLaunched = true;
    return true;
  }

  /**
   * Pair with `tryAcquire`. Decrements the bucket's `inFlight` count and
   * may free a slot for the next admitter. Idempotent: calling `release`
   * twice with no intervening acquire is a no-op (extra releases cannot
   * drive `inFlight` negative).
   */
  release(key: PolitenessKey): void {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return;
    if (bucket.inFlight > 0) bucket.inFlight -= 1;
    bucket.lastAccessMs = this.now();
  }

  /**
   * The earliest monotonic ms at which the bucket is admissible. A bucket
   * that is currently over-cap returns the current clock (no deterministic
   * wait without an estimate of in-flight work duration); a bucket that is
   * blocked (backoff or minGap) returns the concrete moment its constraint
   * releases. The pool scheduler re-checks after a deadline-bounded sleep
   * so this can never busy-loop.
   *
   * T908 (ADR-034 D2.4): when a bucket is BOTH inside its `minGap` and inside
   * a 429/503 block, the two delays merge with MAX, never their sum - the
   * bucket is admissible when the LAST constraint releases, and adding a gap
   * to a 60 s backoff would invent wait time nobody asked for.
   */
  nextReadyAt(key: PolitenessKey): number {
    const t = this.now();
    const bucket = this.buckets.get(key);
    const policy = this.policyForBucket(key);
    if (bucket !== undefined) {
      if (bucket.inFlight >= policy.maxConcurrent) {
        // The pool owns the in-flight duration estimate (kill tokens,
        // per-unit timeouts). Returning `t` is the honest answer when no
        // concrete event is on the books; the scheduler will wake again.
        return t;
      }
      // T908 (ADR-034 D2.4): the backoff block and the minGap are
      // INDEPENDENT constraints, so the bucket is admissible when the LAST of
      // them releases - MAX, never their sum. Pre-T908 this returned the
      // block end as soon as a block was active, which UNDER-reported the
      // ready time whenever the minGap outlived the block (a 1000 ms gap and
      // a 600 ms block: the honest answer is 1000 ms, not 600 ms).
      let ready = t;
      if (t < bucket.blockedUntilMs) ready = bucket.blockedUntilMs;
      // `hasLaunched` distinguishes "never launched" (true sentinel: 0) from
      // "launched exactly at t=0" (a valid monotonic value).
      if (policy.minGapMs > 0 && bucket.hasLaunched) {
        const gapEnd = bucket.lastStartMs + policy.minGapMs;
        if (gapEnd > ready) ready = gapEnd;
      }
      return ready;
    }
    return t;
  }

  /**
   * Mark the bucket as having been deferred (i.e. the pool asked to admit
   * it, the gate said no, and the unit is parked). Cumulative only - never
   * decremented; surfaced on `snapshot()` so an operator can see the
   * traffic shape without instrumenting every park site.
   */
  noteDeferred(key: PolitenessKey): void {
    const t = this.now();
    const bucket = this.touch(key, t);
    bucket.deferred += 1;
  }

  /**
   * T908: the WRITER for `blockedUntilMs` / `backoffSecs` (T907 shipped the
   * two fields as a read-only predicate - review-T907 F-N4 recorded that they
   * had no writer and scoped the writer to this task).
   *
   * Call this with the OBSERVED http status of a failed unit and the verbatim
   * `Retry-After` header. Only 429/503 do anything (see `isRateLimitStatus`);
   * 403, 500, timeouts and every non-HTTP throw leave the bucket untouched.
   * The decision itself is the pure `blockUntilFor`; this method owns the
   * state, the clock, and the single jitter draw.
   *
   * The key MUST be the same key admission uses (`politenessKeyFor`): a
   * mismatch means either "one tenant's 429 blocks the whole host" or "the
   * block lands on an empty queue".
   */
  noteBlocked(key: PolitenessKey, status: number, retryAfter: string | null): void {
    const t = this.now();
    const bucket = this.touch(key, t);
    // The jitter draw happens HERE, exactly once per call, and is handed to
    // the pure function (which applies it before the only-extend comparison).
    const decision = blockUntilFor(this.backoffStateOf(bucket), status, retryAfter, t, this.jitterFactor());
    if (isRateLimitStatus(status)) {
      // `lastEventMs` records the most recent observed signal even when the
      // window absorbed it: it is the honest "when did the upstream last say
      // 429" stamp, used for observability (and available to a future decay
      // rule that measures from the event instead of from expiry).
      bucket.lastEventMs = t;
    }
    if (decision.escalated) {
      // A NEW window opened: the step counter restarts at 1 for this window.
      // Events absorbed by an active window increment it instead, so it reads
      // "signals observed during the current block", not "blocks opened".
      bucket.eventsInWindow = 1;
    } else if (isRateLimitStatus(status)) {
      bucket.eventsInWindow += 1;
    }
    bucket.backoffSecs = decision.backoffSecs;
    bucket.blockedUntilMs = decision.blockedUntilMs;
  }

  /**
   * Current backoff state for a bucket, as a defensive copy. Read-only: an
   * untracked bucket reads as `emptyBackoffState()` and is NOT created, so
   * probing a key cannot grow the LRU table.
   *
   * This is what the orchestrator reads around `noteBlocked` to count
   * `blocksOpened` truthfully (a call that OPENED or EXTENDED a block, versus
   * one absorbed by the active window) without trusting a duplicated decision.
   */
  backoffStateFor(key: PolitenessKey): BackoffState {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) return emptyBackoffState();
    return this.backoffStateOf(bucket);
  }

  /** Snapshot every tracked bucket. Output order is recency-LRU (newest first). */
  snapshot(): readonly PolitenessSnapshot[] {
    const out: PolitenessSnapshot[] = [];
    for (const key of this.recency) {
      const b = this.buckets.get(key);
      if (b === undefined) continue;
      out.push({
        key: b.key,
        inFlight: b.inFlight,
        lastStartMs: b.lastStartMs,
        blockedUntilMs: b.blockedUntilMs,
        backoffSecs: b.backoffSecs,
        deferred: b.deferred,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Copy the backoff-relevant fields out of a tracked bucket. */
  private backoffStateOf(bucket: BucketState): BackoffState {
    return {
      backoffSecs: bucket.backoffSecs,
      blockedUntilMs: bucket.blockedUntilMs,
      lastEventMs: bucket.lastEventMs,
      eventsInWindow: bucket.eventsInWindow,
    };
  }

  /**
   * One symmetric jitter multiplier in `[1 - BACKOFF_JITTER, 1 + BACKOFF_JITTER]`
   * from a uniform [0,1) sample. A sample outside [0,1) (a misbehaving injected
   * source) is clamped rather than trusted, so the multiplier can never invert
   * the block.
   */
  private jitterFactor(): number {
    const raw = this.jitterSource();
    const sample = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
    return 1 + (sample * 2 - 1) * BACKOFF_JITTER;
  }

  /**
   * Touch a bucket (LRU). If the bucket is not tracked and the table is
   * at capacity, evict the LEAST-recently-used bucket that is safe to evict
   * (inFlight === 0 AND not blocked AND deferred === 0). A non-empty,
   * blocked, or ever-deferred bucket is never evicted - eviction under
   * load would lose live accounting. When no safe candidate exists and
   * the table is full, the new bucket is created anyway (capacity is a
   * soft target; preserving live buckets is more important than bounding
   * the table exactly at `maxTrackedBuckets`).
   */
  private touch(key: PolitenessKey, t: number): BucketState {
    const existing = this.buckets.get(key);
    if (existing !== undefined) {
      existing.lastAccessMs = t;
      this.promoteRecency(key);
      return existing;
    }
    if (this.buckets.size >= this.maxTracked) {
      this.evictOneSafe();
    }
    const bucket: BucketState = {
      key,
      inFlight: 0,
      lastStartMs: 0,
      hasLaunched: false,
      blockedUntilMs: 0,
      backoffSecs: 0,
      lastEventMs: 0,
      eventsInWindow: 0,
      deferred: 0,
      lastAccessMs: t,
    };
    this.buckets.set(key, bucket);
    this.recency.unshift(key);
    return bucket;
  }

  private promoteRecency(key: PolitenessKey): void {
    const idx = this.recency.indexOf(key);
    if (idx > 0) {
      this.recency.splice(idx, 1);
      this.recency.unshift(key);
    }
  }

  private evictOneSafe(): void {
    const t = this.now();
    for (let i = this.recency.length - 1; i >= 0; i--) {
      const key = this.recency[i];
      if (key === undefined) continue;
      const b = this.buckets.get(key);
      if (b === undefined) continue;
      if (b.inFlight !== 0) continue;
      if (b.blockedUntilMs > t) continue;
      if (b.deferred !== 0) continue;
      this.buckets.delete(key);
      this.recency.splice(i, 1);
      return;
    }
    // No safe candidate: do NOT drop a live bucket. The capacity is a soft
    // target (4096 default); preserving non-empty / blocked / ever-
    // deferred buckets is more important than bounding the table exactly.
    // The caller will still create the new bucket above; the table may
    // transiently exceed `maxTracked` under sustained pressure rather
    // than lose accounting.
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a stable host from a URL. Returns `null` for malformed input so
 * the caller can fall through to the `fallback` key. The host is lowercased
 * (hostnames are case-insensitive); the URL itself is treated as untrusted
 * text and bounded - never reaches `lastError` or any persisted field.
 */
function deriveHostFromUrl(raw: string): string | null {
  if (raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.trim().toLowerCase();
  if (host.length === 0) return null;
  return host;
}

/**
 * Validate a policy table. Module-load hardening throws on any value that
 * is not a finite positive integer for `maxConcurrent` (>= 1) or a finite
 * non-negative integer for `minGapMs` (>= 0). The thrown error names the
 * offending key and value so the failure is debuggable at startup.
 */
function validatePolicies(policies: Readonly<Record<string, BucketPolicy>>): void {
  for (const [key, policy] of Object.entries(policies)) {
    if (policy === null || typeof policy !== 'object') {
      throw new Error(`PolitenessGate: policy "${key}" must be an object`);
    }
    const mc = policy.maxConcurrent;
    if (typeof mc !== 'number' || !Number.isFinite(mc) || !Number.isInteger(mc) || mc < 1) {
      throw new Error(
        `PolitenessGate: policy "${key}" has invalid maxConcurrent=${String(mc)} ` +
          `(must be a finite integer >= 1)`,
      );
    }
    const mg = policy.minGapMs;
    if (typeof mg !== 'number' || !Number.isFinite(mg) || !Number.isInteger(mg) || mg < 0) {
      throw new Error(
        `PolitenessGate: policy "${key}" has invalid minGapMs=${String(mg)} ` +
          `(must be a finite integer >= 0)`,
      );
    }
  }
}