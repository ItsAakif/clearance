// Contract tests for the wave-10 progress list (T802).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests, so NO
// `.test.tsx`). `describe`/`it` come from vitest; assertions use
// `node:assert/strict`, matching the existing frontend test style
// (runProgress.test.ts, ProfileMatch.test.ts).
//
// Strategy: the rendering behaviour that needs a DOM cannot be asserted here,
// so this file pins the component's contract two ways:
//  1. source-text assertions over `BoardProgressList.tsx` - it reuses the pure
//     `groupProgress` helper (no duplicated grouping logic), handles the new
//     `cancelled` status, renders skipped-with-reason distinctly from failed,
//     surfaces truncation, shows group/tier only when present, and degrades an
//     unrecognised status to its raw text;
//  2. behavioural assertions THROUGH the `groupProgress` helper (the function
//     the component calls) proving an old-shaped snapshot aggregates exactly
//     as the pre-wave header math did.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupProgress } from './runProgress';
import type { ProgressSnapshotLike } from './runProgress';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readSource(relativePath: string): string {
  return readFileSync(path.join(HERE, relativePath), 'utf8');
}

describe('BoardProgressList - reuses the pure helper, no duplicated grouping', () => {
  const text = readSource('BoardProgressList.tsx');

  it('imports groupProgress from runProgress', () => {
    assert.ok(
      text.includes('@/features/jobs/runProgress') ||
        text.includes('./runProgress'),
      'component must import groupProgress from runProgress',
    );
    assert.ok(text.includes('groupProgress(snapshot)'), 'component must call groupProgress(snapshot)');
  });

  it('keeps no local done-grouping vocabulary', () => {
    assert.ok(!text.includes('DONE_STATUSES'), 'done math must come from the helper, not a local list');
  });

  it('keeps no hand-listed group or source names', () => {
    const forbidden = [
      'greenhouse', 'ashby', 'lever', 'smartrecruiters', 'recruitee',
      'personio', 'jobicy', 'workable', 'bamboohr',
      'breezyhr', 'jobvite', 'teamtailor', 'pinpoint', 'freshteam',
      'workday', "'ats'", "'feeds'", "'aggregators'", "'search'", "'dorking'",
      "'scraper'", "'browser'",
    ];
    for (const literal of forbidden) {
      assert.ok(!text.includes(literal), `component must not contain ${literal}`);
    }
  });
});

describe('BoardProgressList - tier/group/skipped/truncation rendering', () => {
  const text = readSource('BoardProgressList.tsx');

  it('keeps the existing board-level header sentence', () => {
    assert.ok(text.includes('boards done'), 'header must keep the "N of M boards done" sentence');
  });

  it('adds a group-aware header segment alongside the board counts', () => {
    assert.ok(text.includes('skipped'), 'header must surface the skipped count');
    assert.ok(text.includes('g.done'), 'header must render per-group done/total');
  });

  it('renders skipped-with-reason distinctly from failed', () => {
    assert.ok(text.includes('skippedReason'), 'component must read skippedReason');
    assert.ok(text.includes('skipped —'), 'skipped row must show its reason');
    assert.ok(text.includes('text-ink-3'), 'skipped styling must not reuse the destructive failed style');
  });

  it('renders cancelled as cancelled, never as failed', () => {
    assert.ok(text.includes("'cancelled'"), 'component must handle the cancelled status');
    // The failed branch must not claim cancelled units: the failed/needs_key
    // branch matches only those two statuses.
    assert.ok(
      text.includes("board.status === 'failed' || board.status === 'needs_key'"),
      'failed branch must match failed/needs_key only',
    );
  });

  it('surfaces truncation when present', () => {
    assert.ok(text.includes('truncated'), 'component must read truncated');
    assert.ok(text.includes('results capped'), 'truncated units must say results are capped');
  });

  it('shows group/tier only when present (old rows unchanged)', () => {
    assert.ok(text.includes('board.group'), 'component must render the group when present');
    assert.ok(text.includes('board.tier'), 'component must render the tier when present');
    assert.ok(
      text.includes('board.tier !== undefined'),
      'tier must be guarded so old rows render unchanged',
    );
  });

  it('degrades an unrecognised status gracefully (raw text, never blank)', () => {
    assert.ok(text.includes('default:'), 'StatusIcon must have a default branch');
    assert.ok(text.includes('{board.status}'), 'an unknown status must render its raw text');
  });
});

describe('BoardProgressList - backward compatibility through the helper', () => {
  it('an old-shaped snapshot aggregates exactly as the pre-wave header math', () => {
    // Pre-wave BoardProgressList math: ok, failed, needs_key count as done;
    // nothing is skipped; only failed counts fail.
    const snapshot = {
      runId: 'run-old',
      startedAt: '2026-09-21T00:00:00.000Z',
      boards: [
        { boardId: 'b1', name: 'b1', type: 'json', status: 'ok', resultCount: 3 },
        { boardId: 'b2', name: 'b2', type: 'json', status: 'failed' },
        { boardId: 'b3', name: 'b3', type: 'search', status: 'needs_key' },
        { boardId: 'b4', name: 'b4', type: 'search', status: 'pending' },
        { boardId: 'b5', name: 'b5', type: 'rss', status: 'running' },
      ],
      totalListings: 3,
    } as ProgressSnapshotLike;
    assert.deepEqual(groupProgress(snapshot).totals, { done: 3, total: 5, skipped: 0, failed: 1 });
  });

  it('the extended header segment stays hidden without wave-7 fields', () => {
    const text = readSource('BoardProgressList.tsx');
    assert.ok(
      text.includes('hasExtendedFields'),
      'group-aware rendering must be gated on the new fields being present',
    );
    assert.ok(
      text.includes('skippedReason !== undefined') || text.includes('skippedReason'),
      'the gate must inspect the additive fields',
    );
  });
});

describe('jobs.ts snapshot types - additive wave-7/wave-9 fields (T802 step 1)', () => {
  const text = readSource('../../services/api/jobs.ts');

  it('BoardRunStatus gains cancelled additively, keeping every prior status', () => {
    for (const status of ['pending', 'running', 'ok', 'failed', 'needs_key', 'cancelled']) {
      assert.ok(text.includes(`'${status}'`), `BoardRunStatus must include '${status}'`);
    }
  });

  it('BoardRunState gains the wave-7 per-unit fields as optional', () => {
    for (const field of ['tier?', 'group?', 'truncated?', 'skippedReason?', 'unitKind?']) {
      assert.ok(text.includes(field), `BoardRunState must gain optional ${field}`);
    }
  });

  it('RunSnapshot gains the wave-7 run fields plus the wave-9 evaluation summary', () => {
    for (const field of ['mode?', 'cancelled?', 'intent?', 'evaluation?']) {
      assert.ok(text.includes(field), `RunSnapshot must gain optional ${field}`);
    }
    assert.ok(text.includes('RunEvaluationSummary'), 'the evaluation summary type must exist');
  });

  it('the search response gains the wave-7 cancelled/partial flags additively', () => {
    assert.ok(text.includes('cancelled?: boolean'), 'search items must gain optional cancelled');
    assert.ok(text.includes('partial?: boolean'), 'search items must gain optional partial');
  });
});
