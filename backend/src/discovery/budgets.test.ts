// Budgets tests (T741/T880): mode budgets, caps, policy helpers, live env
// overrides, the CAMOFOX ceiling relationship, and no scheduler/timer.
// No network access: pure constant + env-var assertions only.
//
// T906: FULL_BATCH_BUDGET.maxConcurrent 8 -> 32 (ADR-034 D1.3). T910 (D7):
// FULL_BATCH_PAGES 100 -> 200 and FULL maxUnits derived as
// FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM = 320. The pins below name
// the new evidence-backed values (see ADR-034 amendment D7, T901 section 7.4
// tail bound, and the T910 contract).
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FAST_BUDGET,
  STANDARD_BUDGET,
  DEEP_BUDGET,
  FULL_BATCH_BUDGET,
  FULL_BATCH_PAGES,
  FULL_BATCH_BOARD_HEADROOM,
  FULL_RUN_TTL_MS,
  DEEP_RUN_TTL_MS,
  COMPANY_SCOPE_CAP,
  REGISTRY_SCOPE_CAP,
  MODE_SCOPE_CAPS,
  scopeCapsFor,
  STANDARD_SOURCE_GROUPS,
  modeGroupEnvelope,
  browserTierAllowed,
  aiEvaluationAllowed,
  budgetFor,
  browserConcurrencyFor,
  FULL_CONCURRENCY_CEILING,
  FULL_BUDGET_MS_MIN,
  FULL_BUDGET_MS_MAX,
  type SearchMode,
} from './budgets.js';
import { CAMOFOX_MAX_CONCURRENCY } from '../browser/pool.js';

const MODULE_PATH = path.join(__dirname, 'budgets.ts');

const OVERRIDE_VARS = [
  'SEARCH_FAST_MAX_CONCURRENCY',
  'SEARCH_STANDARD_MAX_CONCURRENCY',
  'SEARCH_DEEP_MAX_CONCURRENCY',
  'SEARCH_FULL_MAX_CONCURRENCY',
  'SEARCH_FAST_BUDGET_MS',
  'SEARCH_STANDARD_BUDGET_MS',
  'SEARCH_DEEP_BUDGET_MS',
  'SEARCH_FULL_BUDGET_MS',
] as const;

afterEach(() => {
  for (const name of OVERRIDE_VARS) {
    delete process.env[name];
  }
});

describe('four-mode budgets', () => {
  it('keeps the legacy fast budget and defines the four mode values', () => {
    expect(FAST_BUDGET).toEqual({
      maxUnits: 24,
      maxConcurrent: 4,
      perUnitTimeoutMs: 8000,
      totalBudgetMs: 20000,
      perSourceResultCap: 10,
    });
    expect(STANDARD_BUDGET).toEqual({
      maxUnits: 60,
      maxConcurrent: 6,
      perUnitTimeoutMs: 15000,
      totalBudgetMs: 240000,
      perSourceResultCap: 20,
    });
    expect(DEEP_BUDGET).toEqual({
      maxUnits: 400,
      maxConcurrent: 8,
      perUnitTimeoutMs: 20000,
      totalBudgetMs: 600000,
      perSourceResultCap: 40,
    });
    expect(FULL_BATCH_BUDGET).toEqual({
      // T910 (D7): FULL_BATCH_PAGES 100 -> 200, maxUnits derived as
      // FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM (= 200 + 120 = 320).
      // The naive-doubling value 240 would FAIL the live composition (59
      // boards + 200 pages = 259 > 240); 320 has 61 units of margin (23.5%)
      // and 2x headroom on the observed 59-board fan-out. Pinned so the
      // derived expression cannot silently regress to a literal.
      maxUnits: 320,
      maxConcurrent: 32,
      perUnitTimeoutMs: 20000,
      totalBudgetMs: 180000,
      perSourceResultCap: 40,
    });
  });

  it('deep exceeds fast on every dimension', () => {
    expect(DEEP_BUDGET.maxUnits).toBeGreaterThan(FAST_BUDGET.maxUnits);
    expect(DEEP_BUDGET.maxConcurrent).toBeGreaterThan(FAST_BUDGET.maxConcurrent);
    expect(DEEP_BUDGET.perUnitTimeoutMs).toBeGreaterThan(FAST_BUDGET.perUnitTimeoutMs);
    expect(DEEP_BUDGET.totalBudgetMs).toBeGreaterThan(FAST_BUDGET.totalBudgetMs);
    expect(DEEP_BUDGET.perSourceResultCap).toBeGreaterThan(FAST_BUDGET.perSourceResultCap);
  });

  it('keeps the three single-run wall clocks strictly increasing', () => {
    expect(FAST_BUDGET.totalBudgetMs).toBe(20_000);
    expect(STANDARD_BUDGET.totalBudgetMs).toBe(240_000);
    expect(DEEP_BUDGET.totalBudgetMs).toBe(600_000);
    expect(FAST_BUDGET.totalBudgetMs).toBeLessThan(STANDARD_BUDGET.totalBudgetMs);
    expect(STANDARD_BUDGET.totalBudgetMs).toBeLessThan(DEEP_BUDGET.totalBudgetMs);
  });

  it('exposes bounded Full batch and run-TTL constants', () => {
    // T910 (D7): FULL_BATCH_PAGES 100 -> 200. Pinned: this is the
    // measured batch-size requirement for AC24 (9.7 p/s x the width-32 mean
    // slowest unit 16.2975 s = 158.1 pages; 200 gives margin). See
    // ADR-034 amendment D7 and T901 evidence section 7.4.
    expect(FULL_BATCH_PAGES).toBe(200);
    expect(FULL_BATCH_BUDGET.totalBudgetMs).toBe(180_000);
    expect(FULL_RUN_TTL_MS).toBe(30 * 60 * 1000);
    expect(DEEP_RUN_TTL_MS).toBe(12 * 60 * 1000);
  });

  // T910 (D7): the coupling pin. The drift between FULL_BATCH_PAGES and
  // FULL_BATCH_BUDGET.maxUnits is the defect this task exists to fix; the
  // assertion below makes the relationship machine-checked so a future
  // "simplification" of the literal (e.g. dropping back to 240, the naive
  // doubling) will fail the test. Evidence:
  //   - 59 boards observed live fan-out (spec EDGE CASES 1).
  //   - 16,297.5 ms width-32 mean slowest unit (T901 section 7.4).
  //   - 9.7 p/s AC24 target (sweep-throughput-p0 spec).
  // The naive-doubling value 240 would FAIL `>= FULL_BATCH_PAGES + 59`
  // (240 < 259); 320 keeps 61 units of margin (23.5%).
  it('FULL maxUnits is FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM and covers the 59-board live fan-out', () => {
    expect(FULL_BATCH_BUDGET.maxUnits).toBe(FULL_BATCH_PAGES + FULL_BATCH_BOARD_HEADROOM);
    expect(FULL_BATCH_BUDGET.maxUnits).toBeGreaterThanOrEqual(FULL_BATCH_PAGES + 59);
    // The board headroom is 2x the observed 59-board live fan-out (rounded).
    expect(FULL_BATCH_BOARD_HEADROOM).toBe(120);
  });

  it('freezes the shared budget defaults', () => {
    expect(Object.isFrozen(FAST_BUDGET)).toBe(true);
    expect(Object.isFrozen(STANDARD_BUDGET)).toBe(true);
    expect(Object.isFrozen(DEEP_BUDGET)).toBe(true);
    expect(Object.isFrozen(FULL_BATCH_BUDGET)).toBe(true);
  });
});

describe('budgets are sane', () => {
  it('budget fields are positive finite integers', () => {
    for (const budget of [FAST_BUDGET, STANDARD_BUDGET, DEEP_BUDGET, FULL_BATCH_BUDGET]) {
      for (const field of [
        'maxUnits',
        'maxConcurrent',
        'perUnitTimeoutMs',
        'totalBudgetMs',
        'perSourceResultCap',
      ] as const) {
        expect(Number.isInteger(budget[field])).toBe(true);
        expect(Number.isFinite(budget[field])).toBe(true);
        expect(budget[field]).toBeGreaterThan(0);
      }
    }
  });

  it('legacy scope caps are positive finite integers and equal the fast table', () => {
    for (const cap of [COMPANY_SCOPE_CAP, REGISTRY_SCOPE_CAP]) {
      expect(Number.isInteger(cap)).toBe(true);
      expect(Number.isFinite(cap)).toBe(true);
      expect(cap).toBeGreaterThan(0);
    }
    expect(scopeCapsFor('fast')).toEqual({
      companyCap: COMPANY_SCOPE_CAP,
      registryCap: REGISTRY_SCOPE_CAP,
    });
  });
});

describe('mode-scoped scope caps', () => {
  it('keeps the exact per-mode cap table', () => {
    expect(MODE_SCOPE_CAPS).toEqual({
      fast: { companyCap: 10, registryCap: 50 },
      standard: { companyCap: 10, registryCap: 0 },
      deep: { companyCap: 10, registryCap: 200 },
      full: { companyCap: 10, registryCap: Number.POSITIVE_INFINITY },
    });
    expect(scopeCapsFor('standard').registryCap).toBe(0);
    expect(scopeCapsFor('deep').registryCap).toBe(200);
    expect(scopeCapsFor('full').registryCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('returns a copy so callers cannot mutate the policy table', () => {
    const caps = scopeCapsFor('deep');
    caps.registryCap = 0;
    expect(scopeCapsFor('deep').registryCap).toBe(200);
  });
});

describe('mode policy helpers', () => {
  it('restricts the Standard source-group envelope to Standard', () => {
    expect(STANDARD_SOURCE_GROUPS).toEqual(['ats', 'feeds', 'aggregators']);
    expect(modeGroupEnvelope('standard')).toEqual(['ats', 'feeds', 'aggregators']);
    for (const mode of ['fast', 'deep', 'full'] as const) {
      expect(modeGroupEnvelope(mode)).toBeNull();
    }
  });

  it('allows browser and AI evaluation only for Deep and Full', () => {
    for (const mode of ['fast', 'standard'] as const) {
      expect(browserTierAllowed(mode)).toBe(false);
      expect(aiEvaluationAllowed(mode)).toBe(false);
    }
    for (const mode of ['deep', 'full'] as const) {
      expect(browserTierAllowed(mode)).toBe(true);
      expect(aiEvaluationAllowed(mode)).toBe(true);
    }
  });
});

describe('budgetFor', () => {
  it('routes all four modes to their defaults', () => {
    expect(budgetFor('fast')).toEqual(FAST_BUDGET);
    expect(budgetFor('standard')).toEqual(STANDARD_BUDGET);
    expect(budgetFor('deep')).toEqual(DEEP_BUDGET);
    expect(budgetFor('full')).toEqual(FULL_BATCH_BUDGET);
  });

  it('falls back to fast for an unknown runtime value', () => {
    expect(budgetFor('not-a-mode' as SearchMode)).toEqual(FAST_BUDGET);
  });

  it('returns a fresh object so callers cannot mutate the shared defaults', () => {
    for (const mode of ['fast', 'standard', 'deep', 'full'] as const) {
      const first = budgetFor(mode);
      first.maxUnits = -999;
      expect(budgetFor(mode).maxUnits).toBe(
        mode === 'fast'
          ? FAST_BUDGET.maxUnits
          : mode === 'standard'
            ? STANDARD_BUDGET.maxUnits
            : mode === 'deep'
              ? DEEP_BUDGET.maxUnits
              : FULL_BATCH_BUDGET.maxUnits,
      );
    }
  });
});

describe('env overrides', () => {
  it('pool width and total budget are overridable per mode', () => {
    process.env.SEARCH_FAST_MAX_CONCURRENCY = '6';
    process.env.SEARCH_FAST_BUDGET_MS = '45000';
    process.env.SEARCH_STANDARD_MAX_CONCURRENCY = '7';
    process.env.SEARCH_STANDARD_BUDGET_MS = '300000';
    process.env.SEARCH_DEEP_MAX_CONCURRENCY = '12';
    process.env.SEARCH_DEEP_BUDGET_MS = '900000';
    process.env.SEARCH_FULL_MAX_CONCURRENCY = '10';
    process.env.SEARCH_FULL_BUDGET_MS = '240000';

    expect(budgetFor('fast').maxConcurrent).toBe(6);
    expect(budgetFor('fast').totalBudgetMs).toBe(45000);
    expect(budgetFor('standard').maxConcurrent).toBe(7);
    expect(budgetFor('standard').totalBudgetMs).toBe(300000);
    expect(budgetFor('deep').maxConcurrent).toBe(12);
    expect(budgetFor('deep').totalBudgetMs).toBe(900000);
    expect(budgetFor('full').maxConcurrent).toBe(10);
    expect(budgetFor('full').totalBudgetMs).toBe(240000);
  });

  it('does not leak an override into another mode', () => {
    process.env.SEARCH_STANDARD_MAX_CONCURRENCY = '7';
    process.env.SEARCH_FULL_BUDGET_MS = '240000';
    expect(budgetFor('fast').maxConcurrent).toBe(FAST_BUDGET.maxConcurrent);
    expect(budgetFor('deep').maxConcurrent).toBe(DEEP_BUDGET.maxConcurrent);
    expect(budgetFor('standard').totalBudgetMs).toBe(STANDARD_BUDGET.totalBudgetMs);
    expect(budgetFor('full').maxConcurrent).toBe(FULL_BATCH_BUDGET.maxConcurrent);
  });

  it('invalid override values fall back to the documented defaults', () => {
    for (const bad of ['0', '-3', '2.5x', 'not-a-number', '']) {
      process.env.SEARCH_FAST_MAX_CONCURRENCY = bad;
      process.env.SEARCH_STANDARD_BUDGET_MS = bad;
      process.env.SEARCH_DEEP_MAX_CONCURRENCY = bad;
      process.env.SEARCH_FULL_BUDGET_MS = bad;
      // '' is treated as unset; '2.5x'/'not-a-number' are non-numeric;
      // '0'/'-3' are below 1 - all must fall back.
      expect(budgetFor('fast').maxConcurrent).toBe(FAST_BUDGET.maxConcurrent);
      expect(budgetFor('standard').totalBudgetMs).toBe(STANDARD_BUDGET.totalBudgetMs);
      expect(budgetFor('deep').maxConcurrent).toBe(DEEP_BUDGET.maxConcurrent);
      expect(budgetFor('full').totalBudgetMs).toBe(FULL_BATCH_BUDGET.totalBudgetMs);
    }
  });

  it('non-overridable fields stay fixed even when overrides are set', () => {
    process.env.SEARCH_FAST_MAX_CONCURRENCY = '6';
    process.env.SEARCH_FAST_BUDGET_MS = '45000';
    const fast = budgetFor('fast');
    expect(fast.maxUnits).toBe(FAST_BUDGET.maxUnits);
    expect(fast.perUnitTimeoutMs).toBe(FAST_BUDGET.perUnitTimeoutMs);
    expect(fast.perSourceResultCap).toBe(FAST_BUDGET.perSourceResultCap);

    process.env.SEARCH_STANDARD_MAX_CONCURRENCY = '7';
    process.env.SEARCH_STANDARD_BUDGET_MS = '300000';
    const standard = budgetFor('standard');
    expect(standard.maxUnits).toBe(STANDARD_BUDGET.maxUnits);
    expect(standard.perUnitTimeoutMs).toBe(STANDARD_BUDGET.perUnitTimeoutMs);
    expect(standard.perSourceResultCap).toBe(STANDARD_BUDGET.perSourceResultCap);
  });
});

describe('T906: Full env overrides are clamped to bounded ranges', () => {
  // The Full batch route exposes two self-hoster knobs:
  //   SEARCH_FULL_MAX_CONCURRENCY: clamped to [1, FULL_CONCURRENCY_CEILING=64]
  //   SEARCH_FULL_BUDGET_MS:      clamped to [FULL_BUDGET_MS_MIN=30_000,
  //                                        FULL_BUDGET_MS_MAX=600_000]
  // An unbounded env value is an accidental stampede on third parties
  // (ADR-034 D1.2/D1.5), so the clamp lives in `budgetFor('full')`, not in
  // the route. Invalid values still fall back to the frozen default via
  // `envPositiveInt` (not the clamp).

  it('SEARCH_FULL_MAX_CONCURRENCY: in-range values pass through verbatim', () => {
    process.env.SEARCH_FULL_MAX_CONCURRENCY = '24';
    expect(budgetFor('full').maxConcurrent).toBe(24);
    // The upper edge of the range is honoured exactly (no off-by-one).
    process.env.SEARCH_FULL_MAX_CONCURRENCY = '64';
    expect(budgetFor('full').maxConcurrent).toBe(64);
    // 1 is the floor (defensive minimum).
    process.env.SEARCH_FULL_MAX_CONCURRENCY = '1';
    expect(budgetFor('full').maxConcurrent).toBe(1);
  });

  it('SEARCH_FULL_MAX_CONCURRENCY: above-ceiling values clamp to FULL_CONCURRENCY_CEILING', () => {
    process.env.SEARCH_FULL_MAX_CONCURRENCY = '9999';
    expect(budgetFor('full').maxConcurrent).toBe(64);
    // One above the ceiling still clamps.
    process.env.SEARCH_FULL_MAX_CONCURRENCY = '65';
    expect(budgetFor('full').maxConcurrent).toBe(64);
  });

  it('SEARCH_FULL_MAX_CONCURRENCY: invalid values fall back to the frozen default (32)', () => {
    for (const bad of ['0', '-3', '2.5x', 'not-a-number', '']) {
      process.env.SEARCH_FULL_MAX_CONCURRENCY = bad;
      // '' is treated as unset; '2.5x'/'not-a-number' are non-numeric;
      // '0'/'-3' are below 1 - all must fall back to FULL_BATCH_BUDGET
      // (NOT to the clamp floor of 1).
      expect(budgetFor('full').maxConcurrent).toBe(FULL_BATCH_BUDGET.maxConcurrent);
      expect(budgetFor('full').maxConcurrent).toBe(32);
    }
  });

  it('SEARCH_FULL_BUDGET_MS: in-range values pass through verbatim', () => {
    process.env.SEARCH_FULL_BUDGET_MS = '90000';
    expect(budgetFor('full').totalBudgetMs).toBe(90_000);
    // Both range edges are honoured exactly.
    process.env.SEARCH_FULL_BUDGET_MS = '30000';
    expect(budgetFor('full').totalBudgetMs).toBe(30_000);
    process.env.SEARCH_FULL_BUDGET_MS = '600000';
    expect(budgetFor('full').totalBudgetMs).toBe(600_000);
  });

  it('SEARCH_FULL_BUDGET_MS: out-of-range values clamp to the published bounds', () => {
    process.env.SEARCH_FULL_BUDGET_MS = '29999';
    expect(budgetFor('full').totalBudgetMs).toBe(30_000);
    process.env.SEARCH_FULL_BUDGET_MS = '600001';
    expect(budgetFor('full').totalBudgetMs).toBe(600_000);
    process.env.SEARCH_FULL_BUDGET_MS = '99999999';
    expect(budgetFor('full').totalBudgetMs).toBe(600_000);
  });

  it('SEARCH_FULL_BUDGET_MS: invalid values fall back to the frozen default (180_000)', () => {
    for (const bad of ['0', '-3', '2.5x', 'not-a-number', '']) {
      process.env.SEARCH_FULL_BUDGET_MS = bad;
      expect(budgetFor('full').totalBudgetMs).toBe(FULL_BATCH_BUDGET.totalBudgetMs);
      expect(budgetFor('full').totalBudgetMs).toBe(180_000);
    }
  });

  it('exposes the published clamp constants as frozen values', () => {
    // The constants are part of the contract: a self-hoster reading the
    // module source needs the bounds to match the documented arithmetic.
    expect(FULL_CONCURRENCY_CEILING).toBe(64);
    expect(FULL_BUDGET_MS_MIN).toBe(30_000);
    expect(FULL_BUDGET_MS_MAX).toBe(600_000);
  });
});

describe('CAMOFOX ceiling relationship', () => {
  it('browser parallelism never exceeds CAMOFOX_MAX_CONCURRENCY', () => {
    for (const budget of [FAST_BUDGET, STANDARD_BUDGET, DEEP_BUDGET, FULL_BATCH_BUDGET]) {
      expect(browserConcurrencyFor(budget)).toBe(
        Math.min(budget.maxConcurrent, CAMOFOX_MAX_CONCURRENCY),
      );
      expect(browserConcurrencyFor(budget)).toBeLessThanOrEqual(CAMOFOX_MAX_CONCURRENCY);
    }
    expect(browserConcurrencyFor({ ...DEEP_BUDGET, maxConcurrent: 1000 })).toBe(
      CAMOFOX_MAX_CONCURRENCY,
    );
  });
});

describe('no scheduler or background job', () => {
  it('the module adds no timer, interval, or cron', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    expect(source).not.toMatch(/setInterval/);
    expect(source).not.toMatch(/setTimeout/);
    expect(source).not.toMatch(/cron/i);
  });
});
