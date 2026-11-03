// Unit tests for the pure three-mode controls and Full-loop helpers (T888).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (ProfileMatch.test.ts).
//
// Budget mirrors below are read from `backend/src/discovery/budgets.ts`
// (T880) - not from prose. If the backend module moves or changes a mode's
// bound, these tests must move or fail with it.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEEP_TOTAL_BUDGET_MS,
  FAST_TOTAL_BUDGET_MS,
  FULL_BATCH_BUDGET_MS,
  STANDARD_TOTAL_BUDGET_MS,
  UI_MODE_OPTIONS,
  activeRunMode,
  browserTierUnavailable,
  budgetMsForMode,
  buildSearchParams,
  deepTimeBand,
  formatCostEstimate,
  formatDeepTimeWarning,
  fullScanProgressText,
  fullScanShouldContinue,
  isLongMode,
  isRunCancellable,
  isRunTerminal,
  modeLabel,
} from './deepSearch';
import type { FullScanBatch, RunSnapshotLike } from './deepSearch';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readSource(name: string): string {
  return readFileSync(path.join(HERE, name), 'utf8');
}

function unit(status: string, skippedReason?: string) {
  return {
    boardId: status,
    name: status,
    type: 'json',
    status,
    resultCount: 0,
    ...(skippedReason !== undefined ? { skippedReason } : {}),
  };
}

function snapshotOf(
  boards: Array<ReturnType<typeof unit>>,
  extra?: Partial<RunSnapshotLike>,
): RunSnapshotLike {
  return {
    runId: 'run-1',
    startedAt: '2026-09-21T00:00:00.000Z',
    boards,
    totalListings: 0,
    ...extra,
  } as RunSnapshotLike;
}

describe('mode options and budget mirrors track the backend contract', () => {
  it('exposes exactly Standard, Deep and Full in product order', () => {
    assert.deepEqual(UI_MODE_OPTIONS, [
      {
        value: 'standard',
        label: 'Standard Scan',
        description:
          'Mainstream boards and aggregators - about 3-4 minutes',
      },
      {
        value: 'deep',
        label: 'Deep Scan',
        description:
          'Adds search, dorking, scraping and company career pages - about 10 minutes',
      },
      {
        value: 'full',
        label: 'Full Scan',
        description:
          'Every company career page in the registry - can take hours, cancellable',
      },
    ]);
    assert.equal(
      UI_MODE_OPTIONS.some((option) => option.value === 'fast'),
      false,
    );
  });

  it('uses the product label for every wire mode', () => {
    assert.equal(modeLabel('standard'), 'Standard Scan');
    assert.equal(modeLabel('deep'), 'Deep Scan');
    assert.equal(modeLabel('full'), 'Full Scan');
    assert.equal(modeLabel('fast'), 'Fast');
  });

  it('treats every non-fast mode as long', () => {
    assert.equal(isLongMode('fast'), false);
    assert.equal(isLongMode('standard'), true);
    assert.equal(isLongMode('deep'), true);
    assert.equal(isLongMode('full'), true);
  });

  it('mirrors all four backend totalBudgetMs values', () => {
    const backend = readFileSync(
      path.join(HERE, '..', '..', '..', 'backend', 'src', 'discovery', 'budgets.ts'),
      'utf8',
    );
    assert.match(
      backend,
      /export const FAST_BUDGET:[\s\S]*?totalBudgetMs: 20000,/,
    );
    assert.match(
      backend,
      /export const STANDARD_BUDGET:[\s\S]*?totalBudgetMs: 240000,/,
    );
    assert.match(
      backend,
      /export const DEEP_BUDGET:[\s\S]*?totalBudgetMs: 600000,/,
    );
    assert.match(
      backend,
      /export const FULL_BATCH_BUDGET:[\s\S]*?totalBudgetMs: 180000,/,
    );
    assert.equal(FAST_TOTAL_BUDGET_MS, 20_000);
    assert.equal(STANDARD_TOTAL_BUDGET_MS, 240_000);
    assert.equal(DEEP_TOTAL_BUDGET_MS, 600_000);
    assert.equal(FULL_BATCH_BUDGET_MS, 180_000);
    assert.equal(budgetMsForMode('fast'), 20_000);
    assert.equal(budgetMsForMode('standard'), 240_000);
    assert.equal(budgetMsForMode('deep'), 600_000);
    assert.equal(budgetMsForMode('full'), 180_000);
  });
});

describe('deepTimeBand - duration band derived from the budget, never hardcoded', () => {
  it('derives a 9-to-10-minute band from the default deep budget', () => {
    assert.deepEqual(deepTimeBand(), { lowMinutes: 9, highMinutes: 10 });
    assert.deepEqual(deepTimeBand(DEEP_TOTAL_BUDGET_MS), {
      lowMinutes: 9,
      highMinutes: 10,
    });
  });

  it('is always a range: low is one minute below high, floored at 1', () => {
    assert.deepEqual(deepTimeBand(60_000), { lowMinutes: 1, highMinutes: 1 });
    assert.deepEqual(deepTimeBand(180_000), { lowMinutes: 2, highMinutes: 3 });
  });

  it('falls back to the deep default on garbage input', () => {
    assert.deepEqual(deepTimeBand(NaN), { lowMinutes: 9, highMinutes: 10 });
    assert.deepEqual(deepTimeBand(-5), { lowMinutes: 9, highMinutes: 10 });
  });

  it('the warning is a warning, not a promise', () => {
    const text = formatDeepTimeWarning(deepTimeBand());
    assert.ok(
      text.includes('up to about 10 minutes'),
      'warning must carry the upper bound as "up to about N minutes"',
    );
    assert.ok(
      text.includes('may take a while'),
      'warning must read as a warning, not a promise',
    );
    assert.ok(!/takes \d/.test(text), 'warning must never promise a duration');
  });

  it('DeepSearchPanel derives the band from the helper (no marketing literal)', () => {
    const panel = readSource('DeepSearchPanel.tsx');
    assert.ok(
      panel.includes('deepTimeBand') || panel.includes('formatDeepTimeWarning'),
      'the component must derive the band from the helper',
    );
    assert.ok(
      !/\d+ minutes/.test(panel),
      'the component must not hardcode a duration literal',
    );
  });
});

describe('buildSearchParams - fast mode must not change and must not call AI (N18)', () => {
  it('fast mode yields exactly the legacy params: no mode key, no AI request', () => {
    const params = buildSearchParams({
      q: 'react engineer',
      sources: ['greenhouse'],
      runId: 'run-1',
      mode: 'fast',
    });
    assert.deepEqual(params, {
      q: 'react engineer',
      sources: ['greenhouse'],
      runId: 'run-1',
    });
    assert.ok(!('mode' in params), 'fast must not send a mode key');
    assert.ok(!('evaluate' in params), 'fast must not request an AI pass');
  });

  it('an omitted mode (legacy callers) stays byte-identical and behaves as fast', () => {
    const legacy = {
      q: 'react engineer',
      sources: ['greenhouse'],
      runId: 'run-1',
      postedWithin: 'week' as const,
      location: ['Berlin'],
      company: 'Acme',
    };
    const params = buildSearchParams(legacy);
    assert.equal(JSON.stringify(params), JSON.stringify(legacy));
    assert.ok(!('mode' in params));
    assert.ok(!('evaluate' in params));
  });

  it('standard mode adds only mode: standard', () => {
    const params = buildSearchParams({ q: 'x', mode: 'standard' });
    assert.deepEqual(params, { q: 'x', mode: 'standard' });
    assert.ok(!('evaluate' in params));
  });

  it('deep mode adds only mode: deep - still no AI request field', () => {
    const params = buildSearchParams({
      q: 'react engineer',
      runId: 'run-1',
      location: ['Berlin'],
      company: 'Acme',
      postedWithin: 'week',
      mode: 'deep',
    });
    assert.deepEqual(params, {
      q: 'react engineer',
      runId: 'run-1',
      location: ['Berlin'],
      company: 'Acme',
      postedWithin: 'week',
      mode: 'deep',
    });
    assert.ok(!('evaluate' in params), 'deep must not request AI either (wave 11 owns the gate)');
  });

  it('full mode emits no mode key on the search endpoint', () => {
    const params = buildSearchParams({ q: 'x', mode: 'full' });
    assert.deepEqual(params, { q: 'x' });
    assert.ok(!('mode' in params));
  });

  it('a deep call without intent fields stays valid: no intent keys emitted', () => {
    const params = buildSearchParams({ q: 'react engineer', mode: 'deep' });
    assert.deepEqual(params, { q: 'react engineer', mode: 'deep' });
    for (const key of ['roles', 'skills', 'exclusions', 'companies', 'sourceGroups']) {
      assert.ok(!(key in params), `absent intent must not emit ${key}`);
    }
    assert.ok(!('evaluate' in params));
  });
});

describe('buildSearchParams - wave-11 intent fields ride additively (T823)', () => {
  it('intent fields copy through when supplied, with mode: deep and no AI field', () => {
    const params = buildSearchParams({
      q: 'react engineer',
      runId: 'run-1',
      mode: 'deep',
      roles: ['backend'],
      skills: ['react', 'go'],
      exclusions: ['java'],
      companies: ['Acme'],
      sourceGroups: ['keyless'],
    });
    assert.deepEqual(params, {
      q: 'react engineer',
      runId: 'run-1',
      mode: 'deep',
      roles: ['backend'],
      skills: ['react', 'go'],
      exclusions: ['java'],
      companies: ['Acme'],
      sourceGroups: ['keyless'],
    });
    assert.ok(!('evaluate' in params), 'intent must never request an AI pass (N18)');
  });

  it('fast mode with intent fields still sends no mode key and no AI field', () => {
    const params = buildSearchParams({
      q: 'react engineer',
      mode: 'fast',
      roles: ['backend'],
    });
    assert.deepEqual(params, { q: 'react engineer', roles: ['backend'] });
    assert.ok(!('mode' in params), 'fast must not send a mode key even with intent');
    assert.ok(!('evaluate' in params));
  });
});

describe('Full-scan batch state - continue only with a live cursor', () => {
  const active: FullScanBatch = {
    runId: 'run-full',
    hasMore: true,
    nextCursor: 'cursor-2',
    processed: 100,
    total: 69660,
    persisted: 850,
    cancelled: false,
  };

  it('continues only for a non-cancelled batch with more work and a cursor', () => {
    assert.equal(fullScanShouldContinue(active), true);
  });

  it('stops for undefined, cancelled, complete or cursor-less batches', () => {
    assert.equal(fullScanShouldContinue(undefined), false);
    assert.equal(
      fullScanShouldContinue({ ...active, cancelled: true }),
      false,
    );
    assert.equal(fullScanShouldContinue({ ...active, hasMore: false }), false);
    assert.equal(
      fullScanShouldContinue({ ...active, nextCursor: null }),
      false,
    );
  });

  it('renders honest aggregate progress for each terminal state', () => {
    assert.equal(
      fullScanProgressText(active),
      'Scanning registry: 100 of 69660 career pages',
    );
    assert.equal(
      fullScanProgressText({ ...active, cancelled: true }),
      'Cancelled - 100 of 69660 scanned',
    );
    assert.equal(
      fullScanProgressText({
        ...active,
        hasMore: false,
        nextCursor: null,
        processed: 500,
      }),
      'Registry scan complete: 500 career pages',
    );
  });
});

describe('Full-scan loop cancel state - retained boards are not loop liveness', () => {
  const firstBatchBoardsTerminal = snapshotOf([unit('ok')]);

  it('stays cancellable while the page-owned loop is active', () => {
    assert.equal(isRunTerminal(firstBatchBoardsTerminal), true);
    assert.equal(
      isRunCancellable({
        mode: 'full',
        fullScanLoopActive: true,
        snapshot: firstBatchBoardsTerminal,
      }),
      true,
    );
    // Before the first batch response, the page already owns a live run id
    // and the same loop-active state must keep cancel reachable.
    assert.equal(
      isRunCancellable({
        mode: 'full',
        fullScanLoopActive: true,
        snapshot: undefined,
      }),
      true,
    );
  });

  it('keeps cancel enabled when the selected mode changes to Standard mid-Full-loop', () => {
    const selectedMode = 'standard' as const;
    const activeMode = activeRunMode(selectedMode, true);

    assert.equal(activeMode, 'full');
    assert.equal(isRunTerminal(firstBatchBoardsTerminal), true);
    assert.equal(
      isRunCancellable({
        mode: activeMode,
        fullScanLoopActive: true,
        snapshot: firstBatchBoardsTerminal,
      }),
      true,
    );
  });

  it('is not cancellable once the page-owned loop is done', () => {
    for (const snapshot of [firstBatchBoardsTerminal, undefined]) {
      assert.equal(
        isRunCancellable({
          mode: 'full',
          fullScanLoopActive: false,
          snapshot,
        }),
        false,
      );
    }
  });

  it('is not cancellable once cancellation is observed', () => {
    assert.equal(
      isRunCancellable({
        mode: 'full',
        fullScanLoopActive: true,
        snapshot: snapshotOf([unit('ok')], { cancelled: true }),
      }),
      false,
    );
  });

  it('keeps Fast, Standard and Deep byte-identical to isRunTerminal', () => {
    for (const mode of ['fast', 'standard', 'deep'] as const) {
      for (const fullScanLoopActive of [false, true]) {
        for (const snapshot of [
          undefined,
          firstBatchBoardsTerminal,
          snapshotOf([unit('running')]),
          snapshotOf([unit('ok')], { cancelled: true }),
        ]) {
          assert.equal(
            isRunCancellable({ mode, fullScanLoopActive, snapshot }),
            !isRunTerminal(snapshot),
            `${mode} cancelability must not depend on Full loop state`,
          );
        }
      }
    }
  });
});

describe('isRunTerminal - cancel stays reachable for the whole run', () => {
  it('an absent snapshot is not terminal (early run, no snapshot yet)', () => {
    assert.equal(isRunTerminal(undefined), false);
  });

  it('a live run is not terminal', () => {
    assert.equal(
      isRunTerminal(snapshotOf([unit('running'), unit('pending'), unit('ok')])),
      false,
    );
  });

  it('a cancelled run is terminal', () => {
    assert.equal(
      isRunTerminal(snapshotOf([unit('running')], { cancelled: true })),
      true,
    );
  });

  it('ok / failed / cancelled / needs_key units are all terminal', () => {
    for (const status of ['ok', 'failed', 'needs_key', 'cancelled']) {
      assert.equal(
        isRunTerminal(snapshotOf([unit(status)])),
        true,
        `${status} must be terminal`,
      );
    }
  });

  it('one live unit keeps the whole run non-terminal', () => {
    assert.equal(
      isRunTerminal(snapshotOf([unit('ok'), unit('failed'), unit('running')])),
      false,
    );
  });
});

describe('browserTierUnavailable - the optional tier reports itself', () => {
  it('is false without a snapshot or without boards', () => {
    assert.equal(browserTierUnavailable(undefined), false);
    assert.equal(browserTierUnavailable(snapshotOf([])), false);
  });

  it('detects the backend skipped-brand wording', () => {
    assert.equal(
      browserTierUnavailable(
        snapshotOf([unit('ok'), unit('pending', 'browser tier unavailable')]),
      ),
      true,
    );
    assert.equal(
      browserTierUnavailable(snapshotOf([unit('pending', 'browser tier skipped')])),
      true,
    );
  });

  it('ignores unrelated skip reasons', () => {
    assert.equal(
      browserTierUnavailable(
        snapshotOf([unit('pending', 'group disabled: dorking')]),
      ),
      false,
    );
    assert.equal(
      browserTierUnavailable(snapshotOf([unit('ok'), unit('failed')])),
      false,
    );
  });
});

describe('formatCostEstimate - an estimate, never a measured count', () => {
  it('labels a real estimate as an estimate', () => {
    const text = formatCostEstimate({ calls: 5, approxTokens: 12345 });
    assert.ok(text.includes('Estimated'), 'must be labelled an estimate');
    assert.ok(text.includes('5'), 'must carry the call count');
    assert.ok(text.includes('12345'), 'must carry the token figure');
    assert.ok(
      text.includes('not a measured count'),
      'must disclaim measurement precision',
    );
  });

  it('reports a zero estimate as no AI planned, not as a missing figure', () => {
    const text = formatCostEstimate({ calls: 0, approxTokens: 0 });
    assert.ok(text.includes('Estimated'), 'a zero estimate is still an estimate');
    assert.ok(text.includes('no AI calls'), 'zero calls must read as none planned');
  });

  it('reports a missing estimate as unavailable, never as zero', () => {
    const text = formatCostEstimate(undefined);
    assert.ok(text.includes('unavailable'), 'missing estimate must say unavailable');
    assert.ok(!text.includes('none'), 'missing estimate must not read as zero');
  });
});
