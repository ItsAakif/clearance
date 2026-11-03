// Politeness gate tests (T907): pure module - no prisma, no network, no
// real timers. Every test uses an injected `now` clock so the assertions
// are deterministic and reproducible.
//
// Coverage map (matches the contract section C, six invariant tests):
//   1. per-bucket in-flight never exceeds the cap;
//   2. anti-millipede: single-bucket cap of 1 with 4 units parked;
//   3. anti-starvation: pending > 0 AND inFlight < width => something admissible;
//   4. minGap: >=1000ms between consecutive launches on the same bucket;
//   5. deferral accounting: bucket cap 1 + deadlined sleep -> parked reported;
//   6. exactly-once: every admission becomes a release; cumulative counters
//      consistent with the launched count.
//
// Plus table-validation tests (0/NaN/Infinity throw at module load via the
// injectable `policies` option), LRU-bounded eviction, and the snapshot
// surface.
//
// Wave 15 (T908) coverage map (contract section C):
//   - pure `blockUntilFor`: first 429 -> ~60 s, no escalation while the block
//     is active, escalation in the next window (~120 s), the 60/120/240 ladder,
//     the 24 h cap, only-extend, jitter-never-shortens, `Retry-After` in both
//     RFC 9110 forms, the 24 h cap on a hint, past/garbage -> pressure path,
//     and 403/500 opening no block at all;
//   - `nextReadyAt` merges the minGap target and the block with MAX, never sum;
//   - gate level: a blocked bucket is not admitted before T and is admitted at
//     T on the injected clock, a second 429 inside the block does not escalate,
//     and the block survives LRU pressure.

import { describe, it, expect } from 'vitest';
import {
  BACKOFF_BASE_SECS,
  BACKOFF_CAP_SECS,
  BACKOFF_DECAY_SECS,
  BACKOFF_FACTOR,
  BACKOFF_JITTER,
  BROWSER_BUCKET_POLICY,
  DEFAULT_BUCKET_POLICY,
  PROVIDER_BUCKET_POLICIES,
  TIER3_HOST_POLICY,
  PolitenessGate,
  blockUntilFor,
  emptyBackoffState,
  isRateLimitStatus,
  politenessKeyFor,
  policyFor,
  type BackoffState,
  type PolitenessKey,
} from './politeness.js';

// ---------------------------------------------------------------------------
// Key derivation (KEY RULE: ADR-034 D2.1)
// ---------------------------------------------------------------------------

describe('politenessKeyFor (KEY RULE: ADR-034 D2.1)', () => {
  it('returns provider:<id> for a JSON-adapter row (lever)', () => {
    expect(
      politenessKeyFor({
        providerType: 'lever',
        tier: 1,
        provider: 'lever',
        pageUrl: 'https://jobs.lever.co/foo',
      }),
    ).toBe('provider:lever');
  });

  it('returns provider:<id> for a JSON-adapter row (greenhouse)', () => {
    expect(
      politenessKeyFor({
        providerType: 'greenhouse',
        tier: 1,
        provider: 'greenhouse',
        pageUrl: 'https://boards.greenhouse.io/acme',
      }),
    ).toBe('provider:greenhouse');
  });

  it('returns host:<host> for a tier-3 row with a populated host column', () => {
    expect(
      politenessKeyFor({
        providerType: 'career-page',
        tier: 3,
        provider: null,
        host: 'careers.acme.com',
        pageUrl: 'https://careers.acme.com/jobs',
      }),
    ).toBe('host:careers.acme.com');
  });

  it('derives host:<host> from pageUrl when host column is missing', () => {
    expect(
      politenessKeyFor({
        providerType: 'career-page',
        tier: 3,
        provider: null,
        host: null,
        pageUrl: 'https://careers.acme.com/jobs/2',
      }),
    ).toBe('host:careers.acme.com');
  });

  it('falls back to the "fallback" key when neither column nor URL has a host', () => {
    expect(
      politenessKeyFor({
        providerType: 'career-page',
        tier: 3,
        provider: null,
        host: '',
        pageUrl: 'not-a-url',
      }),
    ).toBe('fallback');
  });

  it('never returns (provider, boardToken)-shaped keys', () => {
    // ADR-034 D2.1: (provider, boardToken) buckets would each contain exactly
    // one row, so they bound nothing. The key shape is `provider:<id>` or
    // `host:<host>` or `fallback` - never a tuple.
    const key = politenessKeyFor({
      providerType: 'lever',
      tier: 1,
      provider: 'lever',
      pageUrl: 'https://jobs.lever.co/acme-corp',
    });
    expect(key).not.toMatch(/,/);
    expect(key).not.toContain('acme-corp');
  });

  // T907 D2 (review-T907 D2): aliased adapters must bucket on the RESOLVED
  // canonical provider id, NOT the raw registry id. Registry aliases
  // (`registry/providers.ts:123,126,111-114`): `breezy` -> adapter
  // `breezyhr`, `pinpointhq` -> adapter `pinpoint`, and the four
  // aggregator members (`adzuna`/`usajobs`/`reed`/`findwork`) all resolve
  // to the single `aggregator` adapter. Without the re-resolution, every
  // alias of one upstream would bucket on its own company-page host while
  // the fetch hits the shared upstream API host - exactly the millipede
  // ADR-034 D2.1 is supposed to prevent. The tests below pin one alias per
  // shape and prove (a) the alias does NOT produce a `host:`-keyed bucket
  // and (b) all aliases of one upstream share the same canonical bucket.
  describe('aliased adapters (T907 D2): key resolves to canonical adapter, not raw registry id', () => {
    it('breezy (registry id) resolves to breezyhr (canonical adapter)', () => {
      const key = politenessKeyFor({
        providerType: 'breezyhr',
        tier: 1,
        provider: 'breezy',
        pageUrl: 'https://duolingo.breezy.hr/jobs',
      });
      expect(key).toBe('provider:breezyhr');
      // Specifically NOT host-keyed (the company-page host is unrelated
      // to the shared breezy.hr upstream API host).
      expect(key).not.toMatch(/^host:/);
      expect(key).not.toBe('provider:breezy');
    });

    it('pinpointhq (registry id) resolves to pinpoint (canonical adapter)', () => {
      const key = politenessKeyFor({
        providerType: 'pinpoint',
        tier: 1,
        provider: 'pinpointhq',
        pageUrl: 'https://acme.pinpointhq.com/jobs',
      });
      expect(key).toBe('provider:pinpoint');
      expect(key).not.toMatch(/^host:/);
      expect(key).not.toBe('provider:pinpointhq');
    });

    it('adzuna (registry id) resolves to aggregator (canonical adapter)', () => {
      const key = politenessKeyFor({
        providerType: 'aggregator',
        tier: 1,
        provider: 'adzuna',
        pageUrl: 'https://www.adzuna.com/jobs/land/adzuna',
      });
      expect(key).toBe('provider:aggregator');
      expect(key).not.toMatch(/^host:/);
      expect(key).not.toBe('provider:adzuna');
    });

    it('usajobs / reed / findwork share the same aggregator bucket (canonical, not host-keyed)', () => {
      // Per registry/providers.ts:111-114, all four aggregator members
      // resolve to the single 'aggregator' adapter (a shared RapidAPI
      // gateway). They MUST share one bucket; if any of them fell through
      // to the host branch, an attacker could stampede the gateway via
      // any of the four aliases. The test also confirms the canonical
      // shape is `provider:aggregator`, not `provider:<registry id>`.
      for (const registryId of ['adzuna', 'usajobs', 'reed', 'findwork']) {
        const key = politenessKeyFor({
          providerType: 'aggregator',
          tier: 1,
          provider: registryId,
          pageUrl: `https://example.com/jobs/${registryId}`,
        });
        expect(key, registryId).toBe('provider:aggregator');
      }
    });

    it('policyFor on the canonical breezyhr bucket returns the shared-ATS default (20/0)', () => {
      // Aliases collapse onto the canonical adapter's bucket, so the
      // policy lookup must use the canonical id (not the registry id).
      // The canonical breezyhr row has no custom policy -> falls through
      // to the shared-ATS default `{ maxConcurrent: 20, minGapMs: 0 }`.
      expect(policyFor('provider:breezyhr')).toEqual({ maxConcurrent: 20, minGapMs: 0 });
      expect(policyFor('provider:pinpoint')).toEqual({ maxConcurrent: 20, minGapMs: 0 });
      expect(policyFor('provider:aggregator')).toEqual({ maxConcurrent: 20, minGapMs: 0 });
    });

    // T907 D2 CLOSURE (repair round 1): the tests above pass the REGISTRY
    // provider id, which is the shape the CONTRACT documents - but the
    // orchestrator does NOT pass that shape. `bucketKeyForUnit`
    // (orchestrator.ts:1252-1260) passes `provider: unit.providerType`, and
    // `PlannedUnit.providerType` is `config.type` (the ADAPTER type produced
    // by `configForRegistryRow`), i.e. 'breezyhr' / 'pinpoint' /
    // 'aggregator' - NOT 'breezy' / 'pinpointhq' / 'adzuna'. Those are not
    // `REGISTRY_PROVIDERS` ids, so `adapterTypeFor` returns null and the row
    // fell through to the `host:<company-page-host>` branch: one bucket per
    // COMPANY while the fetch hits the SHARED upstream API host, i.e. no
    // per-upstream bound at all. That is precisely the millipede ADR-034
    // D2.1 exists to prevent, and it made the whole pool inert for every
    // aliased adapter family. The tests below pin the REAL orchestrator
    // input shape so this can never regress silently.
    describe('orchestrator input shape (provider = RESOLVED ADAPTER type)', () => {
      it('keys an already-resolved breezyhr adapter on provider:breezyhr, not the company-page host', () => {
        const key = politenessKeyFor({
          providerType: 'breezyhr',
          tier: 1,
          provider: 'breezyhr', // what bucketKeyForUnit passes
          host: null,
          pageUrl: 'https://careers.acme.example/jobs/0',
        });
        expect(key).toBe('provider:breezyhr');
        expect(key).not.toMatch(/^host:/);
        expect(key).not.toContain('acme');
      });

      it('keys an already-resolved pinpoint adapter on provider:pinpoint', () => {
        const key = politenessKeyFor({
          providerType: 'pinpoint',
          tier: 1,
          provider: 'pinpoint',
          host: null,
          pageUrl: 'https://careers.acme.example/jobs/0',
        });
        expect(key).toBe('provider:pinpoint');
        expect(key).not.toMatch(/^host:/);
      });

      it('keys an already-resolved aggregator adapter on provider:aggregator', () => {
        const key = politenessKeyFor({
          providerType: 'aggregator',
          tier: 1,
          provider: 'aggregator',
          host: null,
          pageUrl: 'https://careers.acme.example/jobs/0',
        });
        expect(key).toBe('provider:aggregator');
        expect(key).not.toMatch(/^host:/);
      });

      it('collapses the registry-id and adapter-id spellings onto ONE bucket (idempotent re-resolution)', () => {
        // The two spellings of the same upstream must never split the
        // bucket - otherwise a mixed batch (a board row, which carries the
        // adapter type, and a registry page, which carries the registry id)
        // would be admitted concurrently against one upstream.
        for (const [registryId, adapterId] of [
          ['breezy', 'breezyhr'],
          ['pinpointhq', 'pinpoint'],
          ['adzuna', 'aggregator'],
          ['usajobs', 'aggregator'],
          ['reed', 'aggregator'],
          ['findwork', 'aggregator'],
        ] as const) {
          const fromRegistryId = politenessKeyFor({
            providerType: adapterId, tier: 1, provider: registryId,
            pageUrl: 'https://careers.a.example/jobs/0',
          });
          const fromAdapterId = politenessKeyFor({
            providerType: adapterId, tier: 1, provider: adapterId,
            pageUrl: 'https://careers.b.example/jobs/0',
          });
          expect(fromRegistryId, registryId).toBe(fromAdapterId);
          expect(fromAdapterId, registryId).toBe(`provider:${adapterId}`);
        }
      });

      it('still keys the tier-3 career-page row on its host (not provider:career-page)', () => {
        // The re-resolution must not capture the HTML/feed adapters: a
        // tier-3 row resolves to `career-page` (kind 'feed'), which must
        // stay on the host branch or one company's outage would throttle
        // every other company page in the sweep.
        expect(
          politenessKeyFor({
            providerType: 'career-page',
            tier: 3,
            provider: 'career-page',
            host: null,
            pageUrl: 'https://careers.acme.com/jobs',
          }),
        ).toBe('host:careers.acme.com');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Policy table
// ---------------------------------------------------------------------------

describe('policyFor', () => {
  it('returns the lever row from PROVIDER_BUCKET_POLICIES', () => {
    expect(PROVIDER_BUCKET_POLICIES.lever).toEqual({ maxConcurrent: 4, minGapMs: 0 });
    expect(policyFor('provider:lever')).toEqual({ maxConcurrent: 4, minGapMs: 0 });
  });

  it('returns the shared-ATS default (20/0) for an unlisted provider', () => {
    expect(policyFor('provider:greenhouse')).toEqual({ maxConcurrent: 20, minGapMs: 0 });
    expect(policyFor('provider:workday')).toEqual({ maxConcurrent: 20, minGapMs: 0 });
  });

  it('returns TIER3_HOST_POLICY for any host:<h> key', () => {
    expect(TIER3_HOST_POLICY).toEqual({ maxConcurrent: 2, minGapMs: 0 });
    expect(policyFor('host:careers.acme.com')).toEqual(TIER3_HOST_POLICY);
    expect(policyFor('host:jobs.example.org')).toEqual(TIER3_HOST_POLICY);
  });

  it('returns BROWSER_BUCKET_POLICY for the browser key', () => {
    expect(BROWSER_BUCKET_POLICY).toEqual({ maxConcurrent: 1, minGapMs: 0 });
    expect(policyFor('browser')).toEqual(BROWSER_BUCKET_POLICY);
  });

  it('returns DEFAULT_BUCKET_POLICY for the fallback key and any unknown key', () => {
    expect(DEFAULT_BUCKET_POLICY).toEqual({ maxConcurrent: 4, minGapMs: 0 });
    expect(policyFor('fallback')).toEqual(DEFAULT_BUCKET_POLICY);
    expect(policyFor('something-else')).toEqual(DEFAULT_BUCKET_POLICY);
  });
});

// ---------------------------------------------------------------------------
// Module-load hardening (0 / NaN / Infinity throw via injectable `policies`)
// ---------------------------------------------------------------------------

describe('module-load hardening rejects bad policy values', () => {
  it('throws when an injected policy has maxConcurrent === 0', () => {
    expect(
      () => new PolitenessGate(() => 0, { policies: { foo: { maxConcurrent: 0, minGapMs: 0 } } }),
    ).toThrow(/PolitenessGate.*foo.*maxConcurrent=0/);
  });

  it('throws when an injected policy has minGapMs < 0', () => {
    expect(
      () => new PolitenessGate(() => 0, { policies: { foo: { maxConcurrent: 2, minGapMs: -1 } } }),
    ).toThrow(/PolitenessGate.*foo.*minGapMs=-1/);
  });

  it('throws when maxConcurrent is NaN', () => {
    expect(
      () =>
        new PolitenessGate(() => 0, { policies: { foo: { maxConcurrent: Number.NaN, minGapMs: 0 } } }),
    ).toThrow(/PolitenessGate.*foo.*maxConcurrent=NaN/);
  });

  it('throws when maxConcurrent is Infinity', () => {
    expect(
      () =>
        new PolitenessGate(() => 0, {
          policies: { foo: { maxConcurrent: Number.POSITIVE_INFINITY, minGapMs: 0 } },
        }),
    ).toThrow(/PolitenessGate.*foo.*maxConcurrent=Infinity/);
  });

  it('throws when minGapMs is a non-integer number', () => {
    expect(
      () => new PolitenessGate(() => 0, { policies: { foo: { maxConcurrent: 2, minGapMs: 1.5 } } }),
    ).toThrow(/PolitenessGate.*foo.*minGapMs=1\.5/);
  });

  it('accepts well-formed policies without throwing', () => {
    expect(
      () =>
        new PolitenessGate(() => 0, { policies: { foo: { maxConcurrent: 3, minGapMs: 500 } } }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// LRU-bounded bucket state
// ---------------------------------------------------------------------------

describe('LRU-bounded bucket state', () => {
  it('throws when maxTrackedBuckets is < 1 or non-finite', () => {
    expect(() => new PolitenessGate(() => 0, { maxTrackedBuckets: 0 })).toThrow(/maxTrackedBuckets/);
    expect(() => new PolitenessGate(() => 0, { maxTrackedBuckets: -1 })).toThrow(/maxTrackedBuckets/);
    expect(() => new PolitenessGate(() => 0, { maxTrackedBuckets: Number.NaN })).toThrow(/maxTrackedBuckets/);
  });

  it('never evicts a non-empty / blocked / ever-deferred bucket', () => {
    const now = 0;
    const clock = (): number => now;
    const gate = new PolitenessGate(clock, { maxTrackedBuckets: 2 });
    // Occupy the first bucket.
    expect(gate.tryAcquire('a')).toBe(true);
    // Make the second bucket non-empty in some way (deferred count > 0).
    gate.noteDeferred('b');
    // Fill the table to capacity with two more buckets.
    expect(gate.tryAcquire('c')).toBe(true);
    expect(gate.tryAcquire('d')).toBe(true);
    // Now force eviction by acquiring a brand-new key.
    expect(gate.tryAcquire('e')).toBe(true);
    const snap = gate.snapshot();
    const keys = snap.map((s) => s.key);
    // 'a' (inFlight=1) and 'b' (deferred) MUST still be present.
    expect(keys).toContain('a');
    expect(keys).toContain('b');
  });
});

// ---------------------------------------------------------------------------
// Section C invariant 1: per-bucket in-flight never exceeds the cap
// ---------------------------------------------------------------------------

describe('invariant: per-bucket cap is never exceeded', () => {
  it('the gate refuses a second admitter when the bucket cap is 1', () => {
    const now = 0;
    const gate = new PolitenessGate(
      () => now,
      { policies: { 'host:caps.acme.com': { maxConcurrent: 1, minGapMs: 0 } } },
    );
    expect(gate.tryAcquire('host:caps.acme.com')).toBe(true);
    expect(gate.tryAcquire('host:caps.acme.com')).toBe(false);
    expect(gate.snapshot().find((s) => s.key === 'host:caps.acme.com')?.inFlight).toBe(1);
    // release -> second admitter succeeds
    gate.release('host:caps.acme.com');
    expect(gate.tryAcquire('host:caps.acme.com')).toBe(true);
  });

  it('tryAcquire returns false on a 4-wide bucket after 4 successful acquires', () => {
    const now = 0;
    const gate = new PolitenessGate(
      () => now,
      { policies: { 'host:wide.example.com': { maxConcurrent: 4, minGapMs: 0 } } },
    );
    for (let i = 0; i < 4; i++) {
      expect(gate.tryAcquire('host:wide.example.com')).toBe(true);
    }
    expect(gate.tryAcquire('host:wide.example.com')).toBe(false);
    gate.release('host:wide.example.com');
    expect(gate.tryAcquire('host:wide.example.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section C invariant 4: minGapMs between consecutive launches (>=1000ms)
// ---------------------------------------------------------------------------

describe('invariant: minGapMs >= 1000ms between consecutive same-bucket launches', () => {
  it('consecutive launches on the same bucket respect minGapMs', () => {
    let now = 0;
    const gate = new PolitenessGate(
      () => now,
      { policies: { 'host:gapped.example.com': { maxConcurrent: 4, minGapMs: 1000 } } },
    );
    expect(gate.tryAcquire('host:gapped.example.com')).toBe(true);
    gate.release('host:gapped.example.com');
    // 999 ms after last launch: still inside minGap.
    now = 999;
    expect(gate.tryAcquire('host:gapped.example.com')).toBe(false);
    // 1000 ms after last launch: admissible again.
    now = 1000;
    expect(gate.tryAcquire('host:gapped.example.com')).toBe(true);
    gate.release('host:gapped.example.com');
  });

  it('gap is computed on the injected clock (not Date.now)', () => {
    let now = 5_000_000;
    const gate = new PolitenessGate(
      () => now,
      { policies: { 'host:gapped2.example.com': { maxConcurrent: 4, minGapMs: 1000 } } },
    );
    expect(gate.tryAcquire('host:gapped2.example.com')).toBe(true);
    gate.release('host:gapped2.example.com');
    now = 5_000_999;
    expect(gate.tryAcquire('host:gapped2.example.com')).toBe(false);
    now = 5_001_000;
    expect(gate.tryAcquire('host:gapped2.example.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Section C invariant 3: anti-starvation
// ---------------------------------------------------------------------------

describe('invariant: anti-starvation (pending > 0 AND inFlight < width => runnable)', () => {
  it('flags a runnable bucket when the gate reports it admissible', () => {
    const now = 0;
    const gate = new PolitenessGate(
      () => now,
      { policies: {
        'host:a.com': { maxConcurrent: 1, minGapMs: 0 },
        'host:b.com': { maxConcurrent: 1, minGapMs: 0 },
      } },
    );
    const runnableKeys: PolitenessKey[] = ['host:a.com', 'host:b.com'];
    for (const key of runnableKeys) {
      expect(gate.tryAcquire(key)).toBe(true);
    }
    // Both keys are now in-flight (cap 1, both consumed).
    for (const key of runnableKeys) {
      expect(gate.tryAcquire(key)).toBe(false);
    }
    // Releasing one frees a slot.
    gate.release('host:a.com');
    expect(gate.tryAcquire('host:a.com')).toBe(true);
  });

  it('nextReadyAt on an unblocked, under-cap bucket returns the current clock', () => {
    const now = 1_000;
    const gate = new PolitenessGate(() => now);
    const t = gate.nextReadyAt('host:idle.example.com');
    expect(t).toBe(1_000);
  });

  it('nextReadyAt on a bucket inside minGap returns lastStart + minGap', () => {
    let now = 0;
    const gate = new PolitenessGate(
      () => now,
      { policies: { 'host:gapnext.example.com': { maxConcurrent: 4, minGapMs: 1000 } } },
    );
    expect(gate.tryAcquire('host:gapnext.example.com')).toBe(true);
    now = 500;
    expect(gate.nextReadyAt('host:gapnext.example.com')).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// Section C invariant 5: deferral accounting + snapshot
// ---------------------------------------------------------------------------

describe('invariant: deferral accounting and snapshot', () => {
  it('noteDeferred increments the cumulative counter on snapshot()', () => {
    const now = 0;
    const gate = new PolitenessGate(() => now);
    gate.noteDeferred('host:deferred.example.com');
    gate.noteDeferred('host:deferred.example.com');
    gate.noteDeferred('host:deferred.example.com');
    const snap = gate.snapshot().find((s) => s.key === 'host:deferred.example.com');
    expect(snap?.deferred).toBe(3);
    expect(snap?.inFlight).toBe(0);
  });

  it('snapshot order is recency-LRU (newest first)', () => {
    let now = 0;
    const gate = new PolitenessGate(() => now);
    gate.noteDeferred('first');
    now = 1;
    gate.noteDeferred('second');
    now = 2;
    gate.noteDeferred('third');
    const keys = gate.snapshot().map((s) => s.key);
    expect(keys[0]).toBe('third');
    expect(keys[1]).toBe('second');
    expect(keys[2]).toBe('first');
  });

  it('inFlight is bounded by cap under repeated tryAcquire/release cycles', () => {
    const now = 0;
    const gate = new PolitenessGate(
      () => now,
      { policies: { 'host:cap1.example.com': { maxConcurrent: 1, minGapMs: 0 } } },
    );
    // 100 acquire/release cycles - inFlight must always read 0 or 1.
    for (let i = 0; i < 100; i++) {
      expect(gate.tryAcquire('host:cap1.example.com')).toBe(true);
      const inFlight = gate.snapshot().find((s) => s.key === 'host:cap1.example.com')?.inFlight;
      expect(inFlight).toBe(1);
      gate.release('host:cap1.example.com');
      const inFlight2 = gate.snapshot().find((s) => s.key === 'host:cap1.example.com')?.inFlight;
      expect(inFlight2).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Section C invariant 6: exactly-once (every acquire has a paired release)
// ---------------------------------------------------------------------------

describe('invariant: exactly-once admission (every acquire has a paired release)', () => {
  it('release is idempotent and never drives inFlight negative', () => {
    const now = 0;
    const gate = new PolitenessGate(() => now);
    expect(gate.tryAcquire('host:once.example.com')).toBe(true);
    gate.release('host:once.example.com');
    gate.release('host:once.example.com'); // extra release - no-op
    const snap = gate.snapshot().find((s) => s.key === 'host:once.example.com');
    expect(snap?.inFlight).toBe(0);
  });

  it('N admissions and N releases leave inFlight at 0 and total deferred as recorded', () => {
    const now = 0;
    const gate = new PolitenessGate(() => now);
    const acquired: PolitenessKey[] = [];
    for (let i = 0; i < 10; i++) {
      const key = `host:cycle${i}.example.com` as PolitenessKey;
      if (gate.tryAcquire(key)) acquired.push(key);
    }
    expect(acquired).toHaveLength(10);
    for (const key of acquired) gate.release(key);
    const snap = gate.snapshot();
    for (const s of snap) {
      expect(s.inFlight).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// T908 - 429/503 backoff. Pure decision function first (no gate, no clock, no
// randomness: the caller supplies the single jitter multiplier), then the gate
// surface that owns state + the clock, then the max-not-sum merge.
// ---------------------------------------------------------------------------

/** Whole-second-aligned epoch so an HTTP-date round trip is exact. */
const T0 = 1_700_000_000_000;
const SEC = 1000;

function stateOf(over: Partial<BackoffState> = {}): BackoffState {
  return { ...emptyBackoffState(), ...over };
}

describe('T908 frozen parameters (StormCrawler 3.7.0 HostBackoff)', () => {
  it('publishes the parameters the contract froze', () => {
    expect(BACKOFF_BASE_SECS).toBe(60);
    expect(BACKOFF_FACTOR).toBe(2);
    expect(BACKOFF_CAP_SECS).toBe(86_400);
    expect(BACKOFF_JITTER).toBe(0.1);
    expect(BACKOFF_DECAY_SECS).toBe(1_800);
  });

  it('isRateLimitStatus admits 429 and 503 and nothing else', () => {
    expect(isRateLimitStatus(429)).toBe(true);
    expect(isRateLimitStatus(503)).toBe(true);
    // 403 is `blocked` for health and must NEVER open a rate-limit block.
    expect(isRateLimitStatus(403)).toBe(false);
    for (const other of [500, 502, 504, 408, 200, 404]) {
      expect(isRateLimitStatus(other), String(other)).toBe(false);
    }
  });
});

describe('T908 blockUntilFor: the pressure ladder', () => {
  it('first 429 blocks for 60 s from now and reports the escalation', () => {
    const d = blockUntilFor(stateOf(), 429, null, T0);
    expect(d.backoffSecs).toBe(60);
    expect(d.blockedUntilMs).toBe(T0 + 60 * SEC);
    expect(d.escalated).toBe(true);
  });

  it('a first 503 behaves identically to a first 429', () => {
    expect(blockUntilFor(stateOf(), 503, null, T0)).toEqual(
      blockUntilFor(stateOf(), 429, null, T0),
    );
  });

  it('jitter moves the candidate within +/-10% and is applied once', () => {
    // The caller owns the draw; the pure function multiplies it exactly once.
    expect(blockUntilFor(stateOf(), 429, null, T0, 0.9).blockedUntilMs).toBe(T0 + 54 * SEC);
    expect(blockUntilFor(stateOf(), 429, null, T0, 1).blockedUntilMs).toBe(T0 + 60 * SEC);
    expect(blockUntilFor(stateOf(), 429, null, T0, 1.1).blockedUntilMs).toBe(T0 + 66 * SEC);
    // A second multiplication would show up as 0.9^2 / 1.1^2.
    expect(blockUntilFor(stateOf(), 429, null, T0, 1.1).blockedUntilMs).not.toBe(
      T0 + Math.round(60 * SEC * 1.1 * 1.1),
    );
  });

  it('a 429 inside the active block does NOT escalate and returns the same end', () => {
    const open = blockUntilFor(stateOf(), 429, null, T0);
    const state = stateOf({ backoffSecs: open.backoffSecs, blockedUntilMs: open.blockedUntilMs });
    for (const at of [T0, T0 + 1, T0 + 30 * SEC, T0 + 59_999]) {
      const d = blockUntilFor(state, 429, null, at);
      expect(d.blockedUntilMs, `at=${at}`).toBe(open.blockedUntilMs);
      expect(d.backoffSecs, `at=${at}`).toBe(60);
      expect(d.escalated, `at=${at}`).toBe(false);
    }
  });

  it('a 429 in the next window escalates to ~120 s, and the ladder runs 60/120/240', () => {
    // Walk the ladder window by window: each new event lands just after the
    // previous block expired and inside the 30 min forgiveness window, so the
    // step doubles every time.
    let state = stateOf();
    const seen: number[] = [];
    for (const step of [60, 120, 240, 480]) {
      const d = blockUntilFor(state, 429, null, state.blockedUntilMs + SEC);
      expect(d.backoffSecs).toBe(step);
      expect(d.blockedUntilMs).toBe(state.blockedUntilMs + SEC + step * SEC);
      expect(d.escalated).toBe(true);
      seen.push(d.backoffSecs);
      state = stateOf({ backoffSecs: d.backoffSecs, blockedUntilMs: d.blockedUntilMs });
    }
    expect(seen).toEqual([60, 120, 240, 480]);
  });

  it('the 30 min forgiveness boundary: exactly 30 min after expiry still escalates, more forgives', () => {
    // Decay is measured FROM BLOCK EXPIRY and the window itself is forgiven:
    // a silence of exactly `BACKOFF_DECAY_SECS` is still inside the window
    // (the bucket went quiet because it was blocked, not because the upstream
    // recovered), so the next 429 is ~120 s. Strictly more than 30 min of
    // silence forgives the bucket back to base 60 s.
    const open = blockUntilFor(stateOf(), 429, null, T0);
    const state = stateOf({ backoffSecs: 60, blockedUntilMs: open.blockedUntilMs });
    const atBoundary = blockUntilFor(state, 429, null, open.blockedUntilMs + BACKOFF_DECAY_SECS * SEC);
    expect(atBoundary.backoffSecs).toBe(120);
    expect(atBoundary.blockedUntilMs).toBe(open.blockedUntilMs + BACKOFF_DECAY_SECS * SEC + 120 * SEC);
    const pastBoundary = blockUntilFor(
      state,
      429,
      null,
      open.blockedUntilMs + BACKOFF_DECAY_SECS * SEC + 1,
    );
    expect(pastBoundary.backoffSecs).toBe(60);
    expect(pastBoundary.blockedUntilMs).toBe(open.blockedUntilMs + BACKOFF_DECAY_SECS * SEC + 1 + 60 * SEC);
  });

  it('decay is measured from BLOCK EXPIRY, never from the last event', () => {
    // A bucket whose last observed event was a full HOUR before its block
    // expired (a `Retry-After: 3600` block) and which has been silent for one
    // minute since it may be fetched again must NOT be forgiven: measuring
    // the silence from `lastEventMs` would read 3661 s > 30 min and reset it
    // to base, i.e. forgive a bucket that has been failing all along.
    const state = stateOf({
      backoffSecs: 3_600,
      blockedUntilMs: T0 + 3_600 * SEC,
      lastEventMs: T0,
    });
    const now = T0 + 3_600 * SEC + 60 * SEC;
    const d = blockUntilFor(state, 429, null, now);
    expect(now - state.lastEventMs).toBeGreaterThan(BACKOFF_DECAY_SECS * SEC);
    expect(now - state.blockedUntilMs).toBeLessThan(BACKOFF_DECAY_SECS * SEC);
    expect(d.backoffSecs).toBe(7_200);
  });

  it('caps the ladder at 24 h and never exceeds it, even with a >1 jitter draw', () => {
    // 12 h -> 24 h, then pinned at the cap.
    let state = stateOf({ backoffSecs: 43_200, blockedUntilMs: T0 });
    const capped = blockUntilFor(state, 429, null, T0 + 5 * SEC);
    expect(capped.backoffSecs).toBe(BACKOFF_CAP_SECS);
    expect(capped.blockedUntilMs).toBe(T0 + 5 * SEC + BACKOFF_CAP_SECS * SEC);
    state = stateOf({ backoffSecs: BACKOFF_CAP_SECS, blockedUntilMs: T0 });
    for (let i = 0; i < 5; i++) {
      const d = blockUntilFor(state, 429, null, T0 + (i + 1) * SEC);
      expect(d.backoffSecs).toBe(BACKOFF_CAP_SECS);
      // The cap is a ceiling on the BLOCK LENGTH, so a 1.1 jitter draw on a
      // 24 h block cannot push the bucket past the documented maximum.
      expect(d.blockedUntilMs - (T0 + (i + 1) * SEC)).toBeLessThanOrEqual(BACKOFF_CAP_SECS * SEC);
    }
  });
});

describe('T908 blockUntilFor: only-extend and jitter-never-shortens', () => {
  it('an existing later end is returned verbatim, never replaced by a fresh candidate', () => {
    // With these parameters the freshly computed candidate is always AFTER
    // `now >= blockedUntilMs`, so the only-extend comparison is a defensive
    // invariant whose observable form is the active block: the function must
    // hand back the end already on the books and must not move it, whether the
    // fresh candidate would be SHORTER (the ladder's 60 s) or LONGER (a
    // `Retry-After: 600` hint) than that end.
    const end = T0 + 60 * SEC;
    const state = stateOf({ backoffSecs: 60, blockedUntilMs: end });
    const shorter = blockUntilFor(state, 429, null, T0);
    expect(shorter.blockedUntilMs).toBe(end);
    const longer = blockUntilFor(state, 429, '600', T0 + 1 * SEC);
    expect(longer.blockedUntilMs).toBe(end);
    for (const d of [shorter, longer]) {
      expect(d.backoffSecs).toBe(60);
      expect(d.escalated).toBe(false);
    }
  });

  it('a 0.9 jitter draw cannot shorten a block that is already on the books', () => {
    // Jitter is applied BEFORE the only-extend comparison, so a negative draw
    // on a live 60 s block returns 60 s. Applying it after the comparison
    // (or forgetting the comparison) would hand back 54 s and cut the wait.
    const end = T0 + 60 * SEC;
    const state = stateOf({ backoffSecs: 60, blockedUntilMs: end });
    expect(blockUntilFor(state, 429, null, T0, 0.9).blockedUntilMs).toBe(end);
    expect(blockUntilFor(state, 429, null, T0, 0.9).blockedUntilMs).not.toBe(T0 + 54 * SEC);
  });

  it('a jittered candidate that is genuinely longer is honoured in full', () => {
    const d = blockUntilFor(stateOf(), 429, null, T0, 1.1);
    expect(d.blockedUntilMs).toBe(T0 + 66 * SEC);
  });
});

describe('T908 blockUntilFor: Retry-After (both RFC 9110 forms)', () => {
  it('honours delta-seconds: Retry-After: 120 -> ~120 s', () => {
    const d = blockUntilFor(stateOf(), 429, '120', T0);
    expect(d.backoffSecs).toBe(120);
    expect(d.blockedUntilMs).toBe(T0 + 120 * SEC);
    expect(d.escalated).toBe(true);
  });

  it('honours an HTTP-date in the future', () => {
    const header = new Date(T0 + 900 * SEC).toUTCString();
    const d = blockUntilFor(stateOf(), 503, header, T0);
    expect(d.backoffSecs).toBe(900);
    expect(d.blockedUntilMs).toBe(T0 + 900 * SEC);
  });

  it('caps a hint beyond 24 h at 24 h', () => {
    const d = blockUntilFor(stateOf(), 429, '999999', T0);
    expect(d.backoffSecs).toBe(BACKOFF_CAP_SECS);
    expect(d.blockedUntilMs).toBe(T0 + BACKOFF_CAP_SECS * SEC);
  });

  it('falls to the pressure path for zero, negative, past, blank and garbage values', () => {
    const past = new Date(T0 - 60 * SEC).toUTCString();
    for (const bad of [
      '0',
      '-5',
      past,
      '',
      '   ',
      'garbage',
      'Wed, 99 Xyz 2015 07:28:00 GMT',
      null,
    ]) {
      const d = blockUntilFor(stateOf(), 429, bad, T0);
      expect(d.backoffSecs, JSON.stringify(bad)).toBe(BACKOFF_BASE_SECS);
      expect(d.blockedUntilMs, JSON.stringify(bad)).toBe(T0 + 60 * SEC);
      expect(d.escalated, JSON.stringify(bad)).toBe(true);
    }
  });

  it('a hint shorter than the ladder step never shortens the pressure block', () => {
    // "come back in 10 s" on a bucket whose own step is 60 s: the header is a
    // floor we honour, never a way to under-wait.
    const d = blockUntilFor(stateOf(), 429, '10', T0);
    expect(d.backoffSecs).toBe(60);
    expect(d.blockedUntilMs).toBe(T0 + 60 * SEC);
  });

  it('honours a hint inside an active window without extending the block', () => {
    const state = stateOf({ backoffSecs: 60, blockedUntilMs: T0 + 600 * SEC });
    const d = blockUntilFor(state, 429, '10', T0 + 5 * SEC);
    expect(d.blockedUntilMs).toBe(T0 + 600 * SEC);
    expect(d.escalated).toBe(false);
  });
});

describe('T908 blockUntilFor: 403 and 500 never open a block', () => {
  it('403 and 500 on a fresh bucket open nothing at all', () => {
    for (const status of [403, 500, 502, 408, 404]) {
      const d = blockUntilFor(stateOf(), status, '120', T0);
      expect(d, String(status)).toEqual({ blockedUntilMs: 0, backoffSecs: 0, escalated: false });
    }
  });

  it('403 and 500 never change an existing block (neither shorten nor extend)', () => {
    const state = stateOf({ backoffSecs: 60, blockedUntilMs: T0 + 60 * SEC });
    for (const status of [403, 500]) {
      const d = blockUntilFor(state, status, '999999', T0 + 10 * SEC);
      expect(d.blockedUntilMs, String(status)).toBe(T0 + 60 * SEC);
      expect(d.backoffSecs, String(status)).toBe(60);
      expect(d.escalated, String(status)).toBe(false);
    }
  });
});

describe('T908 gate: noteBlocked owns the block and admission honours it', () => {
  it('a bucket blocked until T is not admitted before T and is admitted at/after T', () => {
    let now = 0;
    // jitter 0.5 -> factor exactly 1, so the block ends at a known instant.
    const gate = new PolitenessGate(() => now, { jitter: () => 0.5 });
    gate.noteBlocked('host:blocked.example.com', 429, null);
    const snap = gate.snapshot().find((s) => s.key === 'host:blocked.example.com');
    expect(snap?.blockedUntilMs).toBe(60 * SEC);
    expect(snap?.backoffSecs).toBe(60);
    expect(gate.tryAcquire('host:blocked.example.com')).toBe(false);
    now = 59_999;
    expect(gate.tryAcquire('host:blocked.example.com')).toBe(false);
    now = 60 * SEC;
    expect(gate.tryAcquire('host:blocked.example.com')).toBe(true);
    gate.release('host:blocked.example.com');
  });

  it('a second 429 during the block does not escalate', () => {
    let now = 1_000;
    const gate = new PolitenessGate(() => now, { jitter: () => 0.5 });
    gate.noteBlocked('host:absorb.example.com', 429, null);
    const first = gate.backoffStateFor('host:absorb.example.com');
    expect(first).toMatchObject({ backoffSecs: 60, blockedUntilMs: 1_000 + 60 * SEC, eventsInWindow: 1 });
    for (let i = 1; i <= 5; i++) {
      now = 1_000 + i * 1_000;
      gate.noteBlocked('host:absorb.example.com', 429, null);
    }
    const after = gate.backoffStateFor('host:absorb.example.com');
    expect(after.blockedUntilMs).toBe(first.blockedUntilMs);
    expect(after.backoffSecs).toBe(60);
    // Six 429s in one window are ONE congestion event: 60 s, not 60 * 2^6.
    expect(after.eventsInWindow).toBe(6);
  });

  it('a wide in-flight fan-out on one host cannot escalate to 24 h', () => {
    // The exact storm the one-event-per-window rule exists for: 32 in-flight
    // units against one shared host each report their own 429.
    const now = 0;
    const gate = new PolitenessGate(() => now, { jitter: () => 0.5 });
    for (let i = 0; i < 32; i++) gate.noteBlocked('provider:greenhouse', 429, null);
    const s = gate.backoffStateFor('provider:greenhouse');
    expect(s.backoffSecs).toBe(60);
    expect(s.blockedUntilMs).toBe(60 * SEC);
  });

  it('the gate multiplies the injected jitter exactly once, within +/-10%', () => {
    // 0 -> factor 0.9, 0.5 -> 1.0, 1 -> 1.1 (clamped from an out-of-range draw).
    const blockedFor = (jitter: () => number): number => {
      const gate = new PolitenessGate(() => 0, { jitter });
      gate.noteBlocked('k', 429, null);
      return gate.backoffStateFor('k').blockedUntilMs;
    };
    expect(blockedFor(() => 0)).toBe(54 * SEC);
    expect(blockedFor(() => 0.5)).toBe(60 * SEC);
    expect(blockedFor(() => 1)).toBe(66 * SEC);
    // A misbehaving source cannot invert the block.
    expect(blockedFor(() => 5)).toBe(66 * SEC);
    expect(blockedFor(() => -5)).toBe(54 * SEC);
  });

  it('noteBlocked leaves the bucket untouched for 403/500', () => {
    const gate = new PolitenessGate(() => 0, { jitter: () => 0.5 });
    for (const status of [403, 500, 408, 404]) gate.noteBlocked('host:noblock.example.com', status, '120');
    const s = gate.backoffStateFor('host:noblock.example.com');
    expect(s).toEqual({ backoffSecs: 0, blockedUntilMs: 0, lastEventMs: 0, eventsInWindow: 0 });
    expect(gate.snapshot().find((x) => x.key === 'host:noblock.example.com')?.blockedUntilMs).toBe(0);
    // Admission is unaffected: the bucket is immediately usable.
    expect(gate.tryAcquire('host:noblock.example.com')).toBe(true);
  });

  it('backoffStateFor is read-only and does not create buckets', () => {
    const gate = new PolitenessGate(() => 0, { jitter: () => 0.5 });
    expect(gate.backoffStateFor('host:never-seen.example.com')).toEqual(emptyBackoffState());
    expect(gate.snapshot()).toHaveLength(0);
  });

  it('a blocked bucket is retained under LRU pressure', () => {
    const gate = new PolitenessGate(() => 0, { jitter: () => 0.5, maxTrackedBuckets: 1 });
    gate.noteBlocked('host:block.example.com', 429, null);
    gate.noteDeferred('host:other.example.com');
    gate.noteDeferred('host:third.example.com');
    const snap = gate.snapshot();
    expect(snap.some((s) => s.key === 'host:block.example.com')).toBe(true);
    expect(snap.find((s) => s.key === 'host:block.example.com')?.blockedUntilMs).toBe(60 * SEC);
  });

  it('rejects a non-function jitter source at construction', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => new PolitenessGate(() => 0, { jitter: 'nope' as any })).toThrow(/jitter/);
  });

  it('advances to the next step after the block expires and the window turns over', () => {
    let now = 0;
    const gate = new PolitenessGate(() => now, { jitter: () => 0.5 });
    const key = 'host:ladder.example.com';
    const expected = [60, 120, 240];
    for (const step of expected) {
      gate.noteBlocked(key, 503, null);
      const s = gate.backoffStateFor(key);
      expect(s.backoffSecs, `step=${step}`).toBe(step);
      expect(s.blockedUntilMs, `step=${step}`).toBe(now + step * SEC);
      // Let the block expire (plus a millisecond) without a new event.
      now = s.blockedUntilMs + 1;
    }
    // A silence longer than the forgiveness window forgives the bucket to base.
    now += BACKOFF_DECAY_SECS * SEC + 1;
    gate.noteBlocked(key, 503, null);
    expect(gate.backoffStateFor(key).backoffSecs).toBe(60);
  });
});

describe('T908 nextReadyAt: max(minGap, block), never their sum', () => {
  it('a block longer than the gap returns the block end (not gap + block)', () => {
    let now = 0;
    const gate = new PolitenessGate(
      () => now,
      { policies: { 'host:merge.example.com': { maxConcurrent: 4, minGapMs: 1_000 } }, jitter: () => 0.5 },
    );
    expect(gate.tryAcquire('host:merge.example.com')).toBe(true);
    gate.release('host:merge.example.com');
    now = 1_000;
    gate.noteBlocked('host:merge.example.com', 429, null);
    // Block ends at 61_000; the gap from the launch at 0 ends at 1_000.
    expect(gate.nextReadyAt('host:merge.example.com')).toBe(61 * SEC);
    expect(gate.nextReadyAt('host:merge.example.com')).not.toBe(62 * SEC);
  });

  it('a gap longer than the block returns the gap end (not gap + block)', () => {
    let now = 0;
    const gate = new PolitenessGate(
      () => now,
      { policies: { 'host:merge2.example.com': { maxConcurrent: 4, minGapMs: 100_000 } }, jitter: () => 0.5 },
    );
    expect(gate.tryAcquire('host:merge2.example.com')).toBe(true);
    gate.release('host:merge2.example.com');
    now = 100;
    gate.noteBlocked('host:merge2.example.com', 429, null);
    // Block ends at 60_100; the gap from the launch at 0 ends at 100_000.
    expect(gate.nextReadyAt('host:merge2.example.com')).toBe(100_000);
    expect(gate.nextReadyAt('host:merge2.example.com')).not.toBe(160_100);
  });

  it('the merged ready time is exactly max(gap end, block end) in both directions', () => {
    for (const [minGapMs, retryAfter] of [[1_000, null], [100_000, null], [1_000, '300'], [100_000, '300']] as const) {
      let now = 0;
      const key = `host:merge-${minGapMs}-${retryAfter}.example.com`;
      const gate = new PolitenessGate(
        () => now,
        { policies: { [key]: { maxConcurrent: 4, minGapMs } }, jitter: () => 0.5 },
      );
      expect(gate.tryAcquire(key)).toBe(true);
      gate.release(key);
      now = 10;
      gate.noteBlocked(key, 429, retryAfter as string | null);
      const expected = Math.max(minGapMs, now + (retryAfter === null ? 60 : 300) * SEC);
      expect(gate.nextReadyAt(key), `minGap=${minGapMs} retryAfter=${retryAfter}`).toBe(expected);
    }
  });
});