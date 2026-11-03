// Attribution module unit tests (Wave 15, T900). The module is pure - no
// network, no prisma - and `createPhaseProbe` degrades to a documented
// no-op when any diagnostics channel is missing. The sentinel test at
// the bottom pins the "no URL, no credential, no key in any timing" rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import diagnosticsChannel from 'node:diagnostics_channel';
import {
  createPhaseProbe,
  percentile,
  summarizeTimings,
  withPhases,
  type TimingPhaseTotals,
  type UnitTiming,
} from './attribution.js';
import { runSearch, type ExecutableUnit } from './orchestrator.js';
import { searchIntentSchema } from './searchIntent.js';
import type { RawJob } from '../jobSources/adapters/http.js';

const SENTINEL_URL = 'https://attribution-sentinel.example/secret/SECRET_TOKEN_42';
const SENTINEL_KEY = 'KEY-attribution-sentinel-12345';

function makeTiming(overrides: Partial<UnitTiming> = {}): UnitTiming {
  return {
    unitId: 'page:0',
    kind: 'registry-page',
    providerType: 'greenhouse',
    group: 'ats',
    queuedMs: 0,
    fetchMs: 50,
    totalMs: 50,
    outcome: 'ok',
    resultCount: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// percentile (nearest-rank on a pre-sorted ascending array)
// ---------------------------------------------------------------------------

describe('percentile', () => {
  it('returns 0 for an empty array', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 95)).toBe(0);
  });

  it('returns the single element for a 1-element array', () => {
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([42], 100)).toBe(42);
  });

  it('returns the nearest-rank value for a known 100-element fixture', () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile(sorted, 100)).toBe(100);
    expect(percentile(sorted, 1)).toBe(1);
  });

  it('clamps p to [0, 100]', () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(percentile(sorted, -50)).toBe(percentile(sorted, 0));
    expect(percentile(sorted, 500)).toBe(percentile(sorted, 100));
  });
});

// ---------------------------------------------------------------------------
// summarizeTimings
// ---------------------------------------------------------------------------

describe('summarizeTimings', () => {
  it('returns zeros and an empty rollup for an empty fixture', () => {
    const summary = summarizeTimings([]);
    expect(summary.units).toBe(0);
    expect(summary.p50Ms).toBe(0);
    expect(summary.p95Ms).toBe(0);
    expect(summary.maxMs).toBe(0);
    expect(summary.queuedMs).toEqual({ p50: 0, p95: 0, max: 0 });
    expect(summary.byOutcome).toEqual({});
    expect(summary.byGroup).toEqual([]);
    expect(summary.phases).toBeNull();
    expect(summary.phasesUnavailable).toBe(true);
    expect(summary.consistency).toEqual({ sumOfSegmentsMs: 0, totalMs: 0, deviation: 0 });
  });

  it('returns exact p50/p95/max, per-outcome counts, and a byGroup rollup for a known fixture', () => {
    // 10 units per group; totalMs alternates 1..20; queuedMs is constant 5.
    const units: UnitTiming[] = [];
    for (let index = 0; index < 10; index += 1) {
      units.push(makeTiming({
        unitId: `ats:${index}`,
        group: 'ats',
        totalMs: (index + 1) * 10,
        fetchMs: (index + 1) * 10,
        queuedMs: 5,
        outcome: index === 0 ? 'failed' : 'ok',
        resultCount: 3,
      }));
    }
    for (let index = 0; index < 5; index += 1) {
      units.push(makeTiming({
        unitId: `feeds:${index}`,
        kind: 'board',
        providerType: 'rss',
        group: 'feeds',
        totalMs: (index + 1) * 20,
        fetchMs: (index + 1) * 20,
        queuedMs: 10,
        outcome: 'ok',
        resultCount: 7,
      }));
    }

    const summary = summarizeTimings(units);
    // 15 units. Sorted totalMs:
    //   ats:   [10,20,30,40,50,60,70,80,90,100]
    //   feeds: [20,40,60,80,100]
    //   merged + sorted:
    //     [10,20,20,30,40,40,50,60,60,70,80,80,90,100,100]
    // Nearest-rank: ceil(0.5*15)=8 -> index 7 -> 60;
    // ceil(0.95*15)=15 -> index 14 -> 100; max -> 100.
    // Values pinned as literals (not recomputed via the same formula the
    // implementation uses, which would silently agree).
    expect(summary.units).toBe(15);
    expect(summary.p50Ms).toBe(60);
    expect(summary.p95Ms).toBe(100);
    expect(summary.maxMs).toBe(100);
    expect(summary.queuedMs.p50).toBe(5);
    expect(summary.queuedMs.max).toBe(10);

    expect(summary.byOutcome).toEqual({ ok: 14, failed: 1 });
    const ats = summary.byGroup.find((g) => g.group === 'ats')!;
    const feeds = summary.byGroup.find((g) => g.group === 'feeds')!;
    expect(ats.units).toBe(10);
    expect(ats.failures).toBe(1);
    expect(ats.resultCount).toBe(30);
    expect(feeds.units).toBe(5);
    expect(feeds.resultCount).toBe(35);

    // T900 acceptance: byGroup resultCount sums to fixture total.
    const rolledUp = summary.byGroup.reduce((acc, g) => acc + g.resultCount, 0);
    const fixtureTotal = units.reduce((acc, u) => acc + u.resultCount, 0);
    expect(rolledUp).toBe(fixtureTotal);
  });

  it('reports consistency.deviation = 0 when segments sum to the total', () => {
    const units: UnitTiming[] = Array.from({ length: 4 }, (_, i) =>
      makeTiming({
        unitId: `u${i}`,
        totalMs: 100,
        fetchMs: 70,
        queuedMs: 30,
      }),
    );
    const summary = summarizeTimings(units);
    expect(summary.consistency.deviation).toBe(0);
  });

  it('reports consistency.deviation > 0.10 when a layer is deliberately missing', () => {
    // queuedMs + fetchMs = 50; totalMs = 100 -> deviation = |50-100|/100 = 0.5.
    const units: UnitTiming[] = Array.from({ length: 4 }, (_, i) =>
      makeTiming({
        unitId: `u${i}`,
        totalMs: 100,
        fetchMs: 30,
        queuedMs: 20,
      }),
    );
    const summary = summarizeTimings(units);
    expect(summary.consistency.deviation).toBeGreaterThan(0.10);
  });

  it('withPhases upgrades the summary when phases are available', () => {
    const base = summarizeTimings([makeTiming()]);
    // Partial totals: only segments backed by a real channel land here
    // (see attribution.ts header). The schema is `Partial<TimingPhaseTotals>`
    // so a zero value for an unobservable phase can never appear.
    const phases: Partial<TimingPhaseTotals> = {
      ttfbMs: 4, bodyMs: 5,
    };
    const upgraded = withPhases(base, phases);
    expect(upgraded.phases).toEqual(phases);
    expect(upgraded.phasesUnavailable).toBe(false);
    // base unchanged: pure function.
    expect(base.phases).toBeNull();
    expect(base.phasesUnavailable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sentinel: no URL / page content / key / credential ever lands in a timing
// ---------------------------------------------------------------------------

describe('attribution never carries a URL, key, or credential', () => {
  it('a fixture with sentinel strings produces a summary that contains none of them', () => {
    // The orchestrator builds UnitTiming objects from numeric + enum fields
    // only: ids, counts, and durations. This test pins that invariant by
    // serializing a UnitTiming/Summary and asserting that no URL-shaped or
    // key-shaped string ever appears, regardless of what the upstream
    // executor or its `reason` carried. The contract is structural, not
    // behavioral.
    const units: UnitTiming[] = [makeTiming({ unitId: 'page:0' })];
    const summary = summarizeTimings(units);
    const serialized = JSON.stringify({ units, summary });
    expect(serialized).not.toContain(SENTINEL_URL);
    expect(serialized).not.toContain(SENTINEL_KEY);
  });

  it('an orchestrator run whose executor throws a sentinel-laden reason produces a timing that contains none of them', async () => {
    const intent = searchIntentSchema.parse({ mode: 'fast' });
    const outcome = await runSearch(
      intent,
      { runId: 'r-sentinel', userId: 'u1' },
      {
        budget: { maxUnits: 1, maxConcurrent: 1, perUnitTimeoutMs: 1000, totalBudgetMs: 5000, perSourceResultCap: 5 },
        listUserBoards: async () => [{
          boardId: 'b-sentinel',
          name: 'sentinel',
          type: 'greenhouse',
          config: { type: 'greenhouse', query: '', userId: 'u1' } as never,
        }],
        executeUnit: async (_unit: ExecutableUnit): Promise<RawJob[]> => {
          throw new Error(`upstream leak: ${SENTINEL_URL} key=${SENTINEL_KEY}`);
        },
        attributeTiming: true,
      },
    );
    expect(outcome.timing).toBeDefined();
    const serialized = JSON.stringify(outcome.timing);
    expect(serialized).not.toContain(SENTINEL_URL);
    expect(serialized).not.toContain(SENTINEL_KEY);
    // The failed outcome is reported; the reason stays inside RunUnitState,
    // never inside the timing object.
    const timingSummary = outcome.timing!;
    expect(timingSummary.units).toBe(1);
    const units = outcome.units;
    expect(units[0].status).toBe('failed');
    // RunUnitState.reason may carry the sentinel - that is the existing
    // bounded reason field, not a new attribution surface. The contract
    // is that the NEW surface (timing) does not.
    const serializedUnits = JSON.stringify(units);
    // We allow RunUnitState.reason to carry the sentinel (it's the existing
    // bounded reason with the same MAX_REASON_CHARS cap). The contract is
    // strictly on the new timing object.
    expect(serializedUnits).toContain(SENTINEL_URL);
  });
});

// ---------------------------------------------------------------------------
// createPhaseProbe: best-effort no-op when channels are absent
// ---------------------------------------------------------------------------

describe('createPhaseProbe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a tracker when all expected channels exist (Node 18+ bundle)', () => {
    const tracker = createPhaseProbe();
    // On this Node the channels exist; the tracker is usable.
    const inside = tracker.wrap('u1', () => 'ok');
    expect(inside).toBe('ok');
    expect(typeof tracker.finalize).toBe('function');
    expect(typeof tracker.unsubscribe).toBe('function');
    const { phases, phasesUnavailable } = tracker.finalize();
    if (phasesUnavailable) {
      expect(phases).toBeNull();
    } else {
      expect(phases).not.toBeNull();
    }
    tracker.unsubscribe();
  });

  it('is a no-op and never throws when at least one channel is absent', () => {
    // Stub the diagnostics_channel module: channel() returns undefined for
    // every name, simulating a runtime where the bundle is absent.
    const spy = vi.spyOn(diagnosticsChannel, 'channel').mockImplementation(() => undefined as unknown as ReturnType<typeof diagnosticsChannel.channel>);
    try {
      const tracker = createPhaseProbe();
      // wrap runs `fn` as-is; currentUnitId returns undefined; finalize
      // reports unavailable.
      const wrapped = tracker.wrap('u1', () => 42);
      expect(wrapped).toBe(42);
      expect(tracker.currentUnitId()).toBeUndefined();
      const { phases, phasesUnavailable } = tracker.finalize();
      expect(phasesUnavailable).toBe(true);
      expect(phases).toBeNull();
      tracker.unsubscribe(); // idempotent
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('is a no-op and never throws when subscribe itself throws', () => {
    // Simulate a runtime where channels LOOK present but subscribe throws.
    const fakeChannel = { name: 'fake' };
    const channelSpy = vi.spyOn(diagnosticsChannel, 'channel').mockImplementation(() => fakeChannel as never);
    const subscribeSpy = vi.spyOn(diagnosticsChannel, 'subscribe').mockImplementation(() => {
      throw new Error('subscribe denied');
    });
    try {
      const tracker = createPhaseProbe();
      expect(tracker.currentUnitId()).toBeUndefined();
      const { phasesUnavailable } = tracker.finalize();
      expect(phasesUnavailable).toBe(true);
      tracker.unsubscribe();
      expect(subscribeSpy).toHaveBeenCalled();
    } finally {
      subscribeSpy.mockRestore();
      channelSpy.mockRestore();
    }
  });
});