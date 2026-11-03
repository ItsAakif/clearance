// Unit tests for the pure mode scope and confirmation helpers (T821/T888).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (deepSearch.test.ts).
//
// Cap/TTL mirrors below are read from `backend/src/discovery/budgets.ts`
// (T880) and `backend/src/jobSources/discoveryRuns.ts` (T743) - not from
// prose. If those backend modules move or drift, these tests move or fail.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPANY_SCOPE_CAP,
  DEEP_RUN_TTL_MS,
  FULL_RUN_TTL_MS,
  MODE_SCOPE_CAPS,
  RUN_TTL_MS,
  buildScopeSummary,
  confirmationFor,
  confirmationTimeBand,
  initialRunState,
  reduceRunState,
} from './deepSearchScope';
import type { RunState } from './deepSearchScope';
import {
  DEEP_TOTAL_BUDGET_MS,
  FAST_TOTAL_BUDGET_MS,
  STANDARD_TOTAL_BUDGET_MS,
  deepTimeBand,
} from './deepSearch';
import { resolveSourceGroups } from './sourceGroups';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readSource(name: string): string {
  return readFileSync(path.join(HERE, name), 'utf8');
}

function companies(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Company ${i + 1}`);
}

function runningState(
  rowCount: number,
  unitIds: string[] = ['board-a', 'board-b'],
): RunState {
  return {
    status: 'running',
    rows: Array.from({ length: rowCount }, (_, i) => ({ id: `job-${i + 1}` })),
    units: unitIds.map((id) => ({ id, status: 'pending' as const })),
  };
}

describe('scope and TTL mirrors track the backend contract', () => {
  it('mirrors every finite mode cap and leaves Full unbounded', () => {
    const backend = readFileSync(
      path.join(HERE, '..', '..', '..', 'backend', 'src', 'discovery', 'budgets.ts'),
      'utf8',
    );
    assert.match(
      backend,
      /fast:\s*Object\.freeze\(\{\s*companyCap:\s*10,\s*registryCap:\s*50\s*\}\)/,
    );
    assert.match(
      backend,
      /standard:\s*Object\.freeze\(\{\s*companyCap:\s*10,\s*registryCap:\s*0\s*\}\)/,
    );
    assert.match(
      backend,
      /deep:\s*Object\.freeze\(\{\s*companyCap:\s*10,\s*registryCap:\s*200\s*\}\)/,
    );
    assert.match(
      backend,
      /full:\s*Object\.freeze\(\{\s*companyCap:\s*10,\s*registryCap:\s*Number\.POSITIVE_INFINITY\s*\}\)/,
    );
    assert.deepEqual(MODE_SCOPE_CAPS, {
      fast: { companyCap: 10, registryCap: 50 },
      standard: { companyCap: 10, registryCap: 0 },
      deep: { companyCap: 10, registryCap: 200 },
      full: { companyCap: 10, registryCap: Number.POSITIVE_INFINITY },
    });
    assert.equal(COMPANY_SCOPE_CAP, 10);
    assert.equal(MODE_SCOPE_CAPS.fast.companyCap, COMPANY_SCOPE_CAP);
  });

  it('mirrors legacy, Deep and Full run TTLs from their backend owners', () => {
    const budgets = readFileSync(
      path.join(HERE, '..', '..', '..', 'backend', 'src', 'discovery', 'budgets.ts'),
      'utf8',
    );
    const discoveryRuns = readFileSync(
      path.join(
        HERE,
        '..',
        '..',
        '..',
        'backend',
        'src',
        'jobSources',
        'discoveryRuns.ts',
      ),
      'utf8',
    );
    assert.match(budgets, /DEEP_RUN_TTL_MS = 12 \* 60 \* 1000/);
    assert.match(budgets, /FULL_RUN_TTL_MS = 30 \* 60 \* 1000/);
    assert.match(discoveryRuns, /RUN_TTL_MS = 5 \* 60 \* 1000/);
    assert.equal(RUN_TTL_MS, 5 * 60 * 1000);
    assert.equal(DEEP_RUN_TTL_MS, 12 * 60 * 1000);
    assert.equal(FULL_RUN_TTL_MS, 30 * 60 * 1000);
  });
});

describe('buildScopeSummary - the honest post-cap count', () => {
  it('applies the cap: companyCount is the post-cap count, truncated flags overflow', () => {
    const summary = buildScopeSummary(
      { companies: companies(12), mode: 'deep' },
      ['ats'],
    );
    assert.equal(summary.companyCap, COMPANY_SCOPE_CAP);
    assert.equal(summary.companyCount, COMPANY_SCOPE_CAP);
    assert.equal(summary.truncated, true);
  });

  it('returns each mode-specific registry cap and label', () => {
    const fast = buildScopeSummary({ mode: 'fast' }, []);
    const standard = buildScopeSummary({ mode: 'standard' }, []);
    const deep = buildScopeSummary({ mode: 'deep' }, []);
    const full = buildScopeSummary({ mode: 'full' }, []);
    assert.deepEqual(
      { cap: fast.registryCap, mode: fast.registryMode },
      { cap: 50, mode: 'capped' },
    );
    assert.deepEqual(
      { cap: standard.registryCap, mode: standard.registryMode },
      { cap: 0, mode: 'off' },
    );
    assert.deepEqual(
      { cap: deep.registryCap, mode: deep.registryMode },
      { cap: 200, mode: 'capped' },
    );
    assert.deepEqual(
      { cap: full.registryCap, mode: full.registryMode },
      { cap: Number.POSITIVE_INFINITY, mode: 'all' },
    );
  });

  it('is not truncated at or under the cap', () => {
    const atCap = buildScopeSummary({ companies: companies(10) }, []);
    assert.equal(atCap.companyCount, 10);
    assert.equal(atCap.truncated, false);
    const under = buildScopeSummary({ companies: companies(3) }, []);
    assert.equal(under.companyCount, 3);
    assert.equal(under.truncated, false);
    const empty = buildScopeSummary({ companies: [] }, []);
    assert.equal(empty.companyCount, 0);
    assert.equal(empty.truncated, false);
  });

  it('dedupes and deterministically orders groups', () => {
    const first = buildScopeSummary({}, ['search', 'ats', 'search', 'feeds']);
    assert.deepEqual(first.groups, ['ats', 'feeds', 'search']);
    const second = buildScopeSummary({}, ['feeds', 'search', 'ats']);
    assert.deepEqual(second.groups, first.groups);
  });

  it('takes groups from the generated contract, never a local array', () => {
    const contract = resolveSourceGroups();
    assert.ok(contract.groups.length > 0, 'contract must resolve groups');
    const summary = buildScopeSummary({}, [...contract.groups]);
    assert.deepEqual(summary.groups, [...new Set(contract.groups)].sort());
    const module = readSource('deepSearchScope.ts');
    for (const literal of [
      "'ats'",
      "'feeds'",
      "'aggregators'",
      "'dorking'",
      "'scraper'",
      "'browser'",
    ]) {
      assert.ok(
        !module.includes(literal),
        `module must hold no group vocabulary (${literal} found)`,
      );
    }
  });

  it('resolves all known modes and defaults omitted/unknown values to fast', () => {
    assert.equal(buildScopeSummary({}, []).mode, 'fast');
    assert.equal(buildScopeSummary(undefined, undefined).mode, 'fast');
    assert.equal(buildScopeSummary({ mode: 'turbo' }, []).mode, 'fast');
    assert.equal(buildScopeSummary({ mode: 'standard' }, []).mode, 'standard');
    assert.equal(buildScopeSummary({ mode: 'deep' }, []).mode, 'deep');
    assert.equal(buildScopeSummary({ mode: 'full' }, []).mode, 'full');
  });
});

describe('confirmationFor - each mode exposes its honest gate', () => {
  const scope = buildScopeSummary(
    { companies: companies(3), mode: 'deep' },
    ['ats'],
  );

  it('fast yields no confirmation, no estimate and no warning (N18)', () => {
    const gate = confirmationFor('fast', scope, null, true);
    assert.equal(gate.requiresConfirmation, false);
    assert.equal(gate.estimate, null);
    assert.deepEqual(gate.warnings, []);
  });

  it('fast never surfaces an estimate even when one is passed', () => {
    const gate = confirmationFor(
      'fast',
      scope,
      { calls: 5, approxTokens: 9000 },
      false,
    );
    assert.equal(gate.estimate, null);
    assert.deepEqual(gate.warnings, []);
  });

  it('standard confirms with a 3-to-4-minute band and AI-off warning', () => {
    const gate = confirmationFor(
      'standard',
      scope,
      { calls: 5, approxTokens: 9000 },
      true,
    );
    assert.equal(gate.mode, 'standard');
    assert.equal(gate.requiresConfirmation, true);
    assert.equal(gate.estimate, null);
    assert.deepEqual(
      gate.timeBand,
      confirmationTimeBand(STANDARD_TOTAL_BUDGET_MS),
    );
    assert.deepEqual(gate.timeBand, { minMs: 180_000, maxMs: 240_000 });
    assert.deepEqual(gate.warnings, [
      'AI evaluation is off in this mode.',
    ]);
  });

  it('deep confirms with a 9-to-10-minute band derived from the budget', () => {
    const gate = confirmationFor('deep', scope, null, true);
    assert.equal(gate.requiresConfirmation, true);
    assert.equal(gate.estimate, null);
    assert.deepEqual(gate.timeBand, confirmationTimeBand(DEEP_TOTAL_BUDGET_MS));
    assert.deepEqual(gate.timeBand, { minMs: 540_000, maxMs: 600_000 });
    assert.ok(
      gate.timeBand.minMs < gate.timeBand.maxMs,
      'the band must be a range, not a single number',
    );
  });

  it('full confirms with the unbounded marker and honest long-run warning', () => {
    const estimate = { calls: 5, approxTokens: 12345 };
    const gate = confirmationFor('full', scope, estimate, true);
    assert.equal(gate.requiresConfirmation, true);
    assert.deepEqual(gate.timeBand, { minMs: 0, maxMs: 0 });
    assert.deepEqual(gate.estimate, estimate);
    assert.ok(
      gate.warnings.some((warning) => warning.includes('take hours')),
      'Full must say the scan can take hours',
    );
    assert.ok(
      gate.warnings.some((warning) => warning.includes('cancel')),
      'Full must say it is cancellable',
    );
    assert.ok(
      gate.warnings.some((warning) => warning.includes('results') && warning.includes('kept')),
      'Full must say partial results are kept',
    );
  });

  it('derives bounded bands from budget constants - nothing hardcoded', () => {
    const band = deepTimeBand(DEEP_TOTAL_BUDGET_MS);
    assert.deepEqual(confirmationTimeBand(), {
      minMs: band.lowMinutes * 60_000,
      maxMs: DEEP_TOTAL_BUDGET_MS,
    });
    assert.notEqual(FAST_TOTAL_BUDGET_MS, DEEP_TOTAL_BUDGET_MS);
    assert.notEqual(STANDARD_TOTAL_BUDGET_MS, DEEP_TOTAL_BUDGET_MS);
    const module = readSource('deepSearchScope.ts');
    assert.ok(
      module.includes('STANDARD_TOTAL_BUDGET_MS'),
      'module must read the standard budget constant',
    );
    assert.ok(
      module.includes('DEEP_TOTAL_BUDGET_MS'),
      'module must read the deep budget constant',
    );
    assert.ok(
      module.includes('deepTimeBand'),
      'module must derive the band via the shared helper',
    );
    assert.ok(
      !module.includes('240_000') &&
        !module.includes('600_000') &&
        !module.includes('120_000'),
      'module must not hardcode a bounded mode duration',
    );
  });

  it('deep carries the estimate when one was produced, labelled as an estimate', () => {
    const gate = confirmationFor(
      'deep',
      scope,
      { calls: 5, approxTokens: 12345 },
      true,
    );
    assert.deepEqual(gate.estimate, { calls: 5, approxTokens: 12345 });
    assert.equal(gate.warnings.length, 1);
    assert.ok(
      gate.warnings[0].includes('estimate'),
      'the warning must be honest that the figure is an estimate',
    );
    assert.ok(
      gate.warnings[0].includes('not a measured count'),
      'the warning must disclaim measurement precision (T782)',
    );
  });

  it('an unavailable browser tier warns without blocking (N2)', () => {
    const gate = confirmationFor(
      'deep',
      scope,
      { calls: 2, approxTokens: 4000 },
      false,
    );
    assert.equal(
      gate.requiresConfirmation,
      true,
      'the warning is informational, never a block',
    );
    assert.ok(
      gate.warnings.some((warning) => warning.includes('unavailable')),
      'must warn that the tier is unavailable',
    );
    assert.ok(
      gate.warnings.some((warning) => warning.includes('proceeds anyway')),
      'must say the run proceeds anyway (the tier is never mandatory)',
    );
  });

  it('no browser warning when the tier is available', () => {
    const gate = confirmationFor('deep', scope, null, true);
    assert.ok(
      gate.warnings.every((warning) => !warning.includes('Browser tier')),
    );
  });

  it('an unknown mode degrades to the unchanged fast contract', () => {
    const gate = confirmationFor(
      'turbo',
      scope,
      { calls: 5, approxTokens: 9000 },
      false,
    );
    assert.equal(gate.mode, 'fast');
    assert.equal(gate.requiresConfirmation, false);
    assert.equal(gate.estimate, null);
    assert.deepEqual(gate.warnings, []);
  });
});

describe('reduceRunState - N16: rows survive cancel', () => {
  it('keeps every collected row on cancel', () => {
    const before = runningState(3);
    const after = reduceRunState(before, { type: 'cancelled' });
    assert.equal(after.status, 'cancelled');
    assert.equal(after.rows.length, 3);
    assert.deepEqual(after.rows, before.rows);
  });

  it('cancelled is distinct from failed', () => {
    const cancelled = reduceRunState(runningState(2), { type: 'cancelled' });
    const failed = reduceRunState(runningState(2), { type: 'failed' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(failed.status, 'failed');
    assert.notEqual(cancelled.status, failed.status);
  });

  it('marks pending units cancelled on cancel, keeps rows', () => {
    const after = reduceRunState(runningState(1), { type: 'cancelled' });
    assert.ok(
      after.units.every((unit) => unit.status === 'cancelled'),
      'units stopped by cancel are cancelled',
    );
    assert.equal(after.rows.length, 1);
  });

  it('boundary rule: rows received win over cancel (ok even when cancelled)', () => {
    const cancelled = runningState(1);
    const afterCancel = reduceRunState(cancelled, { type: 'cancelled' });
    const late = reduceRunState(afterCancel, {
      type: 'unit-ok',
      unitId: 'board-a',
      rows: [{ id: 'job-late' }],
    });
    assert.equal(
      late.units.find((unit) => unit.id === 'board-a')?.status,
      'ok',
    );
    assert.equal(late.rows.length, 2);
    assert.equal(late.status, 'cancelled');
  });

  it('boundary rule: settling without a result after cancel is cancelled, never failed', () => {
    const afterCancel = reduceRunState(runningState(0), { type: 'cancelled' });
    const late = reduceRunState(afterCancel, {
      type: 'unit-failed',
      unitId: 'board-a',
    });
    assert.equal(
      late.units.find((unit) => unit.id === 'board-a')?.status,
      'cancelled',
    );
    assert.ok(
      late.units.every((unit) => unit.status !== 'failed'),
      'no unit on a cancelled run may read failed',
    );
  });

  it('a unit failing mid-run (no cancel) is still failed', () => {
    const after = reduceRunState(runningState(0), {
      type: 'unit-failed',
      unitId: 'board-a',
    });
    assert.equal(
      after.units.find((unit) => unit.id === 'board-a')?.status,
      'failed',
    );
    assert.equal(after.status, 'running');
  });

  it('run-gone keeps the received rows and does not leave the state running', () => {
    const after = reduceRunState(runningState(4), { type: 'run-gone' });
    assert.equal(after.rows.length, 4);
    assert.equal(after.status, 'expired');
    assert.notEqual(after.status, 'running');
  });

  it('cancel after completion is a no-op: the completed set stands', () => {
    const completed = reduceRunState(runningState(2), { type: 'completed' });
    assert.equal(completed.status, 'completed');
    const afterCancel = reduceRunState(completed, { type: 'cancelled' });
    assert.equal(afterCancel.status, 'completed');
    assert.equal(afterCancel.rows.length, 2);
    const afterGone = reduceRunState(completed, { type: 'run-gone' });
    assert.equal(afterGone.status, 'completed');
  });

  it('an unrecognised event degrades to the previous state', () => {
    const before = runningState(2);
    const after = reduceRunState(
      before,
      { type: 'bogus-event' } as unknown as Parameters<typeof reduceRunState>[1],
    );
    assert.ok(after === before, 'unknown events return the previous state');
  });

  it('a malformed state degrades to the initial state, never undefined fields', () => {
    const after = reduceRunState(
      undefined as unknown as RunState,
      { type: 'cancelled' },
    );
    assert.deepEqual(after, initialRunState());
  });
});

describe('deepSearchScope stays pure (ADR-031 decision 3)', () => {
  it('imports no component, no React, no jsdom-only surface', () => {
    const module = readSource('deepSearchScope.ts');
    assert.ok(!module.includes('from \'react\''), 'no React import');
    assert.ok(!module.includes('.tsx'), 'no component import');
    assert.ok(!module.includes('document.'), 'no DOM access');
    assert.ok(!module.includes('fetch('), 'no network access');
  });
});
