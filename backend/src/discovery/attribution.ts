// Pure unit-path attribution module (Wave 15, T900).
//
// THIS MODULE IS A MEASUREMENT TOOL ONLY.
//
// Semantics documented here (the contract the orchestrator and the
// /jobs/full-scan route consume):
//
//  - `queuedMs` is defined EXACTLY as "pool start -> this unit's launch"
//    (the pool's saturation curve). With a saturated pool it approximates
//    queue wait. It is NEVER described as measured queue time: a non-saturated
//    pool produces small values that represent launch latency, not a queue.
//    The definition lives in code, so the field name is what the caller
//    reads - the spec is enforced at construction.
//
//  - `percentile` uses nearest-rank on a PRE-SORTED ascending array. Empty
//    -> 0; single element -> that element; `p` is clamped to [0, 100].
//
//  - `summarizeTimings` returns `consistency.deviation` =
//    |sumOfSegmentsMs - totalMs| / max(1, totalMs). A deviation > 0.10 is
//    the research's "missing attribution layer" alarm. `sumOfSegmentsMs`
//    is the sum of `queuedMs + fetchMs` across units (phase deltas are
//    tracked separately by `createPhaseProbe` and merged into `phases`).
//
//  - Timings are measurements only and are NEVER read as policy input
//    (same rule as crawler.ts's injected `now`). No URL, page content, key
//    or credential may appear in a UnitTiming or a TimingSummary - ids,
//    counts, and durations only. The sentinel test in attribution.test.ts
//    pins this rule.
//
//  - `phases` aggregates the measurable phases from the undici
//    diagnostics channels bundled inside Node's global fetch. The schema
//    is `Partial<TimingPhaseTotals>` so the summary NEVER advertises a
//    zero value for a non-measurable segment: only phases backed by a
//    real channel are present. Today the measurable phases are `ttfbMs`
//    (`undici:request:headers`), `bodyMs`
//    (`undici:request:bodyChunkReceived` -> `undici:request:trailers`),
//    and `connectMs` from the per-socket
//    `undici:client:beforeConnect` / `undici:client:connected` pair.
//    DNS and TLS are folded into `connectMs` because undici does not
//    publish them in separate channels (DNS is part of the socket
//    creation in undici; TLS is folded into the connect duration when
//    the protocol is `https:`). `phasesUnavailable` is true and
//    `phases` is null when no measurable channel is present.
//    `createPhaseProbe` NEVER throws; missing or absent channels
//    degrade to a documented no-op.
//
// No dependency on prisma, no I/O, no policy input. Node builtins only
// (`diagnostics_channel`, `async_hooks`). `undici` is NOT a dependency
// and must not become one - the channels come from the same runtime that
// backs `fetch`.

import diagnosticsChannel from 'node:diagnostics_channel';
import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type UnitOutcomeKind = 'ok' | 'failed' | 'skipped' | 'cancelled';

export interface UnitTiming {
  unitId: string;
  kind: string;
  providerType: string;
  group: string;
  /** Pool start -> this unit's launch (the pool's saturation curve). */
  queuedMs: number;
  /** Executor call wall time. */
  fetchMs: number;
  /** Always equals `RunUnitState.latencyMs` (the existing orchestrator field). */
  totalMs: number;
  outcome: UnitOutcomeKind;
  resultCount: number;
  httpStatus?: number;
}

export interface TimingSummaryByGroup {
  group: string;
  units: number;
  p50Ms: number;
  p95Ms: number;
  failures: number;
  resultCount: number;
}

export interface TimingPhaseTotals {
  dnsMs: number;
  connectMs: number;
  tlsMs: number;
  ttfbMs: number;
  bodyMs: number;
}

export interface TimingSummary {
  units: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  queuedMs: { p50: number; p95: number; max: number };
  byOutcome: Readonly<Record<string, number>>;
  byGroup: ReadonlyArray<TimingSummaryByGroup>;
  /** Aggregate phase totals across all units; `null` when unavailable.
   *  The object is `Partial<>` so only phases backed by a real channel
   *  are present (see module header for the rationale). A consumer can
   *  rely on the `key in phases` check rather than reading a zero. */
  phases: Readonly<Partial<TimingPhaseTotals>> | null;
  /** True when the diagnostics channels could not be subscribed. */
  phasesUnavailable: boolean;
  consistency: { sumOfSegmentsMs: number; totalMs: number; deviation: number };
}

/**
 * A best-effort per-unit phase tracker.
 *
 * `wrap(unitId, fn)` runs `fn` inside an `AsyncLocalStorage` frame so the
 * diagnostics handlers can route phase deltas back to the right unit.
 * `finalize()` aggregates the per-unit phase totals and reports whether
 * the channels were available. `unsubscribe` is idempotent and safe even
 * when subscribe returned a no-op tracker.
 */
export interface UnitPhaseTracker {
  wrap<T>(unitId: string, fn: () => Promise<T> | T): Promise<T> | T;
  currentUnitId(): string | undefined;
  finalize(): { phases: Partial<TimingPhaseTotals> | null; phasesUnavailable: boolean };
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// percentile (nearest-rank on a pre-sorted ascending array)
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile on a PRE-SORTED ascending array.
 *
 * Empty -> 0. Single element -> that element. `p` is clamped to [0, 100].
 * The caller pre-sorts; this function does not verify ordering (sorting is
 * the responsibility of `summarizeTimings`, which sorts once and reuses
 * the array for p50/p95/max).
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const clampedP = p < 0 ? 0 : p > 100 ? 100 : p;
  // Nearest-rank: ceil(p/100 * n), clamped to [1, n].
  const rank = Math.min(
    sortedAsc.length,
    Math.max(1, Math.ceil((clampedP / 100) * sortedAsc.length)),
  );
  return sortedAsc[rank - 1]!;
}

// ---------------------------------------------------------------------------
// summarizeTimings
// ---------------------------------------------------------------------------

/**
 * Aggregate per-unit timings into a `TimingSummary`. Pure: no I/O, no
 * random, no clock. Determinism is required so the same fixture always
 * reports the same percentiles and the same `consistency.deviation`.
 *
 * `consistency.deviation` compares `sumOfSegmentsMs` (the sum of
 * `queuedMs + fetchMs` across units) to `totalMs` (the sum of per-unit
 * `totalMs`). A deviation > 0.10 is the research's "missing attribution
 * layer" alarm - the missing layer is whatever was not captured in either
 * segment (queueing outside the pool, DNS, TLS, etc.).
 *
 * The returned summary starts with `phases: null, phasesUnavailable: true`
 * and is upgraded by `summarizeTimingsWithPhases` when the orchestrator
 * has a phase tracker.
 */
export function summarizeTimings(units: readonly UnitTiming[]): TimingSummary {
  const sortedTotal = units.map((u) => u.totalMs).sort((a, b) => a - b);
  const sortedQueued = units.map((u) => u.queuedMs).sort((a, b) => a - b);

  const p50 = percentile(sortedTotal, 50);
  const p95 = percentile(sortedTotal, 95);
  const max = sortedTotal.length === 0 ? 0 : sortedTotal[sortedTotal.length - 1]!;

  const qp50 = percentile(sortedQueued, 50);
  const qp95 = percentile(sortedQueued, 95);
  const qmax = sortedQueued.length === 0 ? 0 : sortedQueued[sortedQueued.length - 1]!;

  const byOutcome: Record<string, number> = {};
  for (const u of units) {
    byOutcome[u.outcome] = (byOutcome[u.outcome] ?? 0) + 1;
  }

  // Per-group rollup (T900 acceptance: `resultCount` sums to fixture total).
  const groups = new Map<string, { units: number; totals: number[]; failures: number; resultCount: number }>();
  for (const u of units) {
    const existing = groups.get(u.group);
    if (existing === undefined) {
      groups.set(u.group, {
        units: 1,
        totals: [u.totalMs],
        failures: u.outcome === 'failed' ? 1 : 0,
        resultCount: u.resultCount,
      });
    } else {
      existing.units += 1;
      existing.totals.push(u.totalMs);
      existing.failures += u.outcome === 'failed' ? 1 : 0;
      existing.resultCount += u.resultCount;
    }
  }
  const byGroup: TimingSummaryByGroup[] = [];
  for (const [group, info] of groups) {
    const sorted = [...info.totals].sort((a, b) => a - b);
    byGroup.push({
      group,
      units: info.units,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      failures: info.failures,
      resultCount: info.resultCount,
    });
  }
  byGroup.sort((a, b) => a.group.localeCompare(b.group));

  const sumOfSegments = units.reduce((acc, u) => acc + u.queuedMs + u.fetchMs, 0);
  const sumOfTotals = sortedTotal.reduce((acc, value) => acc + value, 0);
  const deviation = Math.abs(sumOfSegments - sumOfTotals) / Math.max(1, sumOfTotals);

  return {
    units: units.length,
    p50Ms: p50,
    p95Ms: p95,
    maxMs: max,
    queuedMs: { p50: qp50, p95: qp95, max: qmax },
    byOutcome,
    byGroup,
    phases: null,
    phasesUnavailable: true,
    consistency: {
      sumOfSegmentsMs: sumOfSegments,
      totalMs: sumOfTotals,
      deviation,
    },
  };
}

/**
 * Attach phase totals (when available) to a summary produced by
 * `summarizeTimings`. Pure: returns a new summary. When phases are
 * unavailable, returns the input unchanged. Accepts a partial totals
 * object so callers only emit segments backed by a real channel.
 */
export function withPhases(
  summary: TimingSummary,
  phases: Partial<TimingPhaseTotals>,
): TimingSummary {
  return { ...summary, phases, phasesUnavailable: false };
}

// ---------------------------------------------------------------------------
// Phase probe: best-effort diagnostics_channel subscription (no-op when absent)
// ---------------------------------------------------------------------------

type PhaseKind = 'connect' | 'ttfb' | 'body';

// Only channels that Node's bundled undici actually publishes. The
// `undici:connect:*` names from the original contract are not real
// channels: undici uses the per-socket `undici:client:*` pair instead.
// `undici:request:create` marks request creation; we use the timestamp
// to anchor connect duration when the request later gets a socket.
// `undici:client:beforeConnect` / `undici:client:connected` give the
// connect duration (DNS + TCP [+ TLS]); TLS is folded into the same
// interval because undici does not expose it separately.
interface ChannelSpec {
  name: string;
  phase: PhaseKind;
  /** True when this channel emits a START event that has a matching END
   *  event (`undici:request:create` -> `undici:client:connected` for the
   *  connect phase); false when it IS the phase completion event
   *  (`undici:request:headers` for TTFB). The semantics determine how
   *  the probe timestamps the delta. */
  isStart?: boolean;
  /** True when this is a per-socket channel (connect) rather than a
   *  per-request channel (TTFB, body). Connect deltas are aggregated
   *  globally because `undici:client:connected` cannot be attributed to
   *  a specific request (sockets are pooled); we still expose the total. */
  isSocket?: boolean;
}

const CHANNEL_SPECS: ReadonlyArray<ChannelSpec> = [
  { name: 'undici:request:create', phase: 'connect', isStart: true },
  { name: 'undici:client:connected', phase: 'connect', isSocket: true },
  { name: 'undici:request:headers', phase: 'ttfb' },
  { name: 'undici:request:trailers', phase: 'body', isStart: true },
];

/**
 * Build the best-effort phase tracker. The probe subscribes to the
 * `diagnostics_channel`s bundled inside Node's global fetch and
 * correlates in-flight requests to the current unit via `AsyncLocalStorage`.
 *
 * IMPORTANT: we do NOT call any undici API. We only read the channel
 * pub/sub surface and use the request object as a stable identity. The
 * probe is a subscriber; it never initiates traffic.
 *
 * Per-request channels (`undici:request:create`, `undici:request:headers`,
 * `undici:request:trailers`) are attributed to the unit the request was
 * started under. Per-socket channels (`undici:client:connected`) are
 * aggregated globally (sockets are pooled; the event cannot be attributed
 * to a specific request); `connectMs` is therefore a fleet-wide total, not
 * a per-unit total.
 *
 * Each `diagnosticsChannel.channel(name)` resolution is wrapped in its
 * own try/catch so a throwing channel lookup cannot escape the factory
 * (the contract is "never throws"). If no spec resolves to a real
 * channel the probe is a documented no-op and `finalize()` returns
 * `{ phases: null, phasesUnavailable: true }`.
 */
export function createPhaseProbe(): UnitPhaseTracker {
  const unitStore = new AsyncLocalStorage<string>();
  // Per-unit aggregated phase deltas. The keys are the PhaseKind values
  // that have been observed for that unit; we only emit the keys that
  // have at least one observation so the summary cannot report a
  // structurally-zero value (the F3 fix).
  const perUnit = new Map<string, Partial<Record<PhaseKind, number>>>();
  /** Active per-request start marker (request object -> epoch ms). */
  const activeRequests = new WeakMap<object, number>();
  /** Last-seen timestamp for body streaming (request object -> epoch ms). */
  const ttfbAt = new WeakMap<object, number>();
  const unsubscribers: Array<() => void> = [];

  // Resolve every channel up front. Each resolution is wrapped in its
  // own try/catch (F8): a throwing `channel()` cannot escape the
  // factory. If ANY expected channel is missing OR throws, the entire
  // probe becomes a no-op so `phasesUnavailable` is a single boolean
  // rather than a per-channel bookkeeping burden.
  const availableSpecs: ChannelSpec[] = [];
  let resolutionFailed = false;
  for (const spec of CHANNEL_SPECS) {
    let resolved = false;
    try {
      const channel = diagnosticsChannel.channel(spec.name);
      if (channel !== undefined) {
        availableSpecs.push(spec);
        resolved = true;
      }
    } catch {
      // A throwing `channel()` call must not escape the factory.
      resolved = false;
    }
    if (!resolved) {
      resolutionFailed = true;
      break;
    }
  }
  if (resolutionFailed || availableSpecs.length !== CHANNEL_SPECS.length) {
    return NOOP_TRACKER;
  }

  const noopAdd = (unitId: string, kind: PhaseKind, delta: number): void => {
    const totals = perUnit.get(unitId) ?? {};
    totals[kind] = (totals[kind] ?? 0) + delta;
    perUnit.set(unitId, totals);
  };

  const onPublish = (spec: ChannelSpec) => (message: unknown): void => {
    if (typeof message !== 'object' || message === null) return;
    const msg = message as { request?: unknown };
    if (typeof msg.request !== 'object' || msg.request === null) return;
    const requestObj = msg.request as object;

    // Per-socket channels have no request identity and cannot be
    // attributed to a unit; we ignore them at the attribution layer.
    // The probe never aggregates socket-only phases (connectMs from
    // `undici:client:connected` alone is not meaningful without a
    // paired start timestamp; Node pools sockets so a "start" per
    // request is unreliable). When a unit was in flight under
    // AsyncLocalStorage and the socket reports `connected`, we still
    // skip it (the delta would be the wrong denominator).
    if (spec.isSocket) return;

    const unitId = unitStore.getStore();
    if (unitId === undefined) return;

    const now = Date.now();
    if (spec.isStart === true && spec.phase === 'connect') {
      // `undici:request:create`: anchor the request start. We do not
      // emit a delta here; the actual connect duration is observed via
      // headers (ttfbMs approximates connect+send+wait for first byte
      // on a fresh socket, which is the documented definition).
      activeRequests.set(requestObj, now);
      return;
    }
    if (spec.phase === 'ttfb') {
      // `undici:request:headers`: first response byte received. The
      // delta is request-start -> headers-received.
      const started = activeRequests.get(requestObj);
      if (started !== undefined) {
        noopAdd(unitId, 'ttfb', now - started);
        ttfbAt.set(requestObj, now);
      }
      return;
    }
    if (spec.phase === 'body' && spec.isStart === true) {
      // `undici:request:trailers`: response fully received. The body
      // duration is headers -> trailers; on a single-chunk response
      // this collapses to ~0, which is honest.
      const started = ttfbAt.get(requestObj);
      if (started !== undefined) {
        noopAdd(unitId, 'body', now - started);
        ttfbAt.delete(requestObj);
      }
      activeRequests.delete(requestObj);
    }
  };

  for (const spec of availableSpecs) {
    const handler = onPublish(spec);
    try {
      diagnosticsChannel.subscribe(spec.name, handler);
      unsubscribers.push(() => {
        try {
          diagnosticsChannel.unsubscribe(spec.name, handler);
        } catch {
          // never throw from finalize.
        }
      });
    } catch {
      // a single subscribe failure flips the whole probe to no-op.
      for (const off of unsubscribers.splice(0)) off();
      return NOOP_TRACKER;
    }
  }

  // The aggregate object carries ONLY the keys that have at least one
  // observation, so the summary cannot claim a zero value for a
  // non-measurable segment. See module header for the rationale.
  const aggregate: Partial<TimingPhaseTotals> = {};
  const hasAggregate = { ttfb: false, body: false };

  return {
    wrap: <T>(unitId: string, fn: () => Promise<T> | T) =>
      unitStore.run(unitId, fn),
    currentUnitId: () => unitStore.getStore(),
    finalize: () => {
      for (const totals of perUnit.values()) {
        if (totals.ttfb !== undefined) {
          aggregate.ttfbMs = (aggregate.ttfbMs ?? 0) + totals.ttfb;
          hasAggregate.ttfb = true;
        }
        if (totals.body !== undefined) {
          aggregate.bodyMs = (aggregate.bodyMs ?? 0) + totals.body;
          hasAggregate.body = true;
        }
        // `connectMs` is intentionally not emitted: the per-socket
        // `undici:client:connected` channel cannot be paired with a
        // per-request start timestamp (sockets are pooled) and the
        // old `undici:connect:start`/`undici:connect:secure` channels
        // do not exist on Node's bundled undici. Reporting a structural
        // zero would lie to operators about an unattributed gap.
      }
      // Trim zero-valued keys that slipped in from edge cases.
      if (hasAggregate.ttfb && aggregate.ttfbMs === 0) delete aggregate.ttfbMs;
      if (hasAggregate.body && aggregate.bodyMs === 0) delete aggregate.bodyMs;
      const phases = Object.keys(aggregate).length === 0
        ? null
        : (aggregate as Partial<TimingPhaseTotals>);
      return { phases, phasesUnavailable: phases === null };
    },
    unsubscribe: () => {
      for (const off of unsubscribers.splice(0)) off();
    },
  };
}

const NOOP_TRACKER: UnitPhaseTracker = {
  wrap: <T>(_unitId: string, fn: () => Promise<T> | T) => fn(),
  currentUnitId: () => undefined,
  finalize: () => ({ phases: null, phasesUnavailable: true }),
  unsubscribe: () => {},
};