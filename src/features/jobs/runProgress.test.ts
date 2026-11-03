// Unit tests for the pure run-progress grouping helper (T800), plus the
// pure Full-sweep speed / ETA / rate-limit-notice helpers (T911).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (ProfileMatch.test.ts).

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupProgress, registryProgressText } from './runProgress';
import {
  appendSweepSample,
  etaText,
  politenessNoticeText,
  rateText,
  sweepRate,
} from './runProgress';
import type {
  ProgressSnapshotLike,
  ProgressUnitLike,
  SweepPoliteness,
  SweepSample,
} from './runProgress';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Pre-wave board: none of the wave-7 additive fields. */
function oldBoard(
  boardId: string,
  type: string,
  status: string,
  resultCount = 0,
): ProgressUnitLike {
  return { boardId, name: boardId, type, status, resultCount };
}

function newBoard(
  boardId: string,
  type: string,
  status: string,
  extra?: Partial<ProgressUnitLike>,
): ProgressUnitLike {
  return { boardId, name: boardId, type, status, resultCount: 0, ...extra };
}

describe('groupProgress - old snapshots without wave-7 fields', () => {
  const snapshot: ProgressSnapshotLike = {
    runId: 'run-old',
    startedAt: '2026-09-21T00:00:00.000Z',
    boards: [
      oldBoard('b1', 'json', 'ok', 3),
      oldBoard('b2', 'json', 'failed'),
      oldBoard('b3', 'search', 'needs_key'),
      oldBoard('b4', 'search', 'pending'),
      oldBoard('b5', 'rss', 'running'),
    ],
    totalListings: 3,
  } as ProgressSnapshotLike;

  it('groups by board type in first-seen order (pre-wave grouping)', () => {
    const { groups } = groupProgress(snapshot);
    assert.deepEqual(
      groups.map((g) => g.group),
      ['json', 'search', 'rss'],
    );
    assert.deepEqual(groups[0], { group: 'json', done: 2, total: 2, skipped: 0, failed: 1 });
    assert.deepEqual(groups[1], { group: 'search', done: 1, total: 2, skipped: 0, failed: 0 });
    assert.deepEqual(groups[2], { group: 'rss', done: 0, total: 1, skipped: 0, failed: 0 });
  });

  it('renders exactly as before: totals match the pre-wave done math', () => {
    // Pre-wave header math (BoardProgressList DONE_STATUSES): ok, failed,
    // needs_key count as done; nothing is skipped; only failed counts fail.
    const { totals } = groupProgress(snapshot);
    assert.deepEqual(totals, { done: 3, total: 5, skipped: 0, failed: 1 });
  });
});

describe('groupProgress - new snapshots with wave-7 fields', () => {
  it('groups by group, counting skipped and failed separately', () => {
    const snapshot: ProgressSnapshotLike = {
      boards: [
        newBoard('b1', 'greenhouse', 'ok', { tier: 1, group: 'g-ats' }),
        newBoard('b2', 'ashby', 'ok', { tier: 1, group: 'g-ats', truncated: true }),
        newBoard('b3', 'search', 'failed', { tier: 5, group: 'g-search' }),
        newBoard('b4', 'rss', 'ok', {
          tier: 2,
          group: 'g-feeds',
          skippedReason: 'group disabled: g-feeds',
        }),
        newBoard('b5', 'browser', 'cancelled', {
          tier: 4,
          group: 'g-browser',
          skippedReason: 'tier unavailable',
        }),
      ],
      totalListings: 7,
    };
    const { groups, totals } = groupProgress(snapshot);
    assert.deepEqual(
      groups.map((g) => g.group),
      ['g-ats', 'g-search', 'g-feeds', 'g-browser'],
    );
    assert.deepEqual(groups[0], { group: 'g-ats', done: 2, total: 2, skipped: 0, failed: 0 });
    assert.deepEqual(groups[1], { group: 'g-search', done: 1, total: 1, skipped: 0, failed: 1 });
    assert.deepEqual(groups[2], { group: 'g-feeds', done: 1, total: 1, skipped: 1, failed: 0 });
    assert.deepEqual(groups[3], { group: 'g-browser', done: 1, total: 1, skipped: 1, failed: 0 });
    assert.deepEqual(totals, { done: 5, total: 5, skipped: 2, failed: 1 });
  });

  it('never reports a skipped-with-reason unit as failed', () => {
    const snapshot: ProgressSnapshotLike = {
      boards: [
        newBoard('b1', 'rss', 'failed', { group: 'g-one', skippedReason: 'group disabled' }),
      ],
      totalListings: 0,
    };
    const { groups, totals } = groupProgress(snapshot);
    assert.deepEqual(groups, [{ group: 'g-one', done: 1, total: 1, skipped: 1, failed: 0 }]);
    assert.deepEqual(totals, { done: 1, total: 1, skipped: 1, failed: 0 });
  });

  it('treats cancelled as done (never failed, never skipped)', () => {
    const snapshot: ProgressSnapshotLike = {
      boards: [newBoard('b1', 'rss', 'cancelled', { group: 'g-one' })],
      totalListings: 0,
    };
    assert.deepEqual(groupProgress(snapshot).totals, {
      done: 1,
      total: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('tolerates truncation without changing the counts', () => {
    const snapshot: ProgressSnapshotLike = {
      boards: [newBoard('b1', 'rss', 'ok', { group: 'g-one', truncated: true })],
      totalListings: 4,
    };
    assert.deepEqual(groupProgress(snapshot).totals, {
      done: 1,
      total: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it('falls back to type for boards without a group', () => {
    const snapshot: ProgressSnapshotLike = {
      boards: [
        newBoard('b1', 'rss', 'ok', { group: 'g-one' }),
        newBoard('b2', 'json', 'ok'),
      ],
      totalListings: 1,
    };
    const { groups } = groupProgress(snapshot);
    assert.deepEqual(
      groups.map((g) => g.group),
      ['g-one', 'json'],
    );
  });
});

describe('registryProgressText - additive Full-scan aggregate progress', () => {
  it('formats the processed and total registry counts honestly', () => {
    assert.equal(
      registryProgressText({
        boards: [],
        registryProcessed: 400,
        registryTotal: 69_660,
      }),
      'Registry: 400 of 69,660 career pages',
    );
  });

  it('shows a real zero total after the scan starts', () => {
    assert.equal(
      registryProgressText({
        boards: [],
        registryProcessed: 0,
        registryTotal: 0,
      }),
      'Registry: 0 of 0 career pages',
    );
  });

  it('treats a missing processed count as zero without inventing a total', () => {
    assert.equal(
      registryProgressText({ boards: [], registryTotal: 25 }),
      'Registry: 0 of 25 career pages',
    );
    assert.equal(registryProgressText({ boards: [] }), undefined);
    assert.equal(registryProgressText(undefined), undefined);
  });

  it('rejects malformed totals and negative counters', () => {
    assert.equal(
      registryProgressText({ boards: [], registryTotal: Number.NaN }),
      undefined,
    );
    assert.equal(
      registryProgressText({
        boards: [],
        registryProcessed: -1,
        registryTotal: 10,
      }),
      'Registry: 0 of 10 career pages',
    );
  });
});

describe('groupProgress - degenerate input', () => {
  it('returns zero totals for an empty board list', () => {
    assert.deepEqual(groupProgress({ boards: [], totalListings: 0 }), {
      groups: [],
      totals: { done: 0, total: 0, skipped: 0, failed: 0 },
    });
  });

  it('accepts the frontend RunSnapshot shape (no wave-7 fields required)', () => {
    const snapshot: ProgressSnapshotLike = {
      runId: 'run-1',
      startedAt: '2026-09-21T00:00:00.000Z',
      boards: [{ boardId: 'b1', name: 'One', type: 'json', status: 'ok', resultCount: 2 }],
      totalListings: 2,
    };
    const { totals } = groupProgress(snapshot);
    assert.equal(totals.done, 1);
    assert.equal(totals.total, 1);
  });
});

describe('runProgress - no local group vocabulary (snapshot data owns it)', () => {
  it('helper keeps no hand-listed group or source names', () => {
    const text = readFileSync(path.join(HERE, 'runProgress.ts'), 'utf8');
    const forbidden = [
      'greenhouse', 'ashby', 'lever', 'smartrecruiters', 'recruitee',
      'personio', 'jobicy', 'hnalgolia', 'workable', 'bamboohr',
      'breezyhr', 'jobvite', 'teamtailor', 'pinpoint', 'freshteam',
      'workday', 'rss', 'json', 'career-page', 'adzuna', 'usajobs',
      'reed', 'findwork', 'dorking', 'scraper', 'browser',
      "'ats'", "'feeds'", "'aggregators'", "'search'", "'dorking'",
      "'scraper'", "'browser'",
    ];
    for (const literal of forbidden) {
      assert.ok(!text.includes(literal), `helper must not contain ${literal}`);
    }
  });
});

// ==================== Full-sweep speed / ETA / rate-limit notice (T911) ==========
// Every rule in the spec's ACCEPTANCE list, one behaviour per case: the sample
// buffer, the rate window and its null cases, the ETA formats, the speed
// format, and the fixed evaluation order of the rate-limit notice.

function at(processed: number, epochMs: number): SweepSample {
  return { processed, at: epochMs };
}

function politeness(over: Partial<SweepPoliteness> = {}): SweepPoliteness {
  return { mode: 'on', signals: 0, blocks: 0, deferred: 0, wiringOk: true, ...over };
}

describe('appendSweepSample - append and cap at the newest 10 (pure)', () => {
  it('appends to an empty buffer without touching the input', () => {
    const input: SweepSample[] = [];
    const next = appendSweepSample(input, 200, 1_000);
    assert.deepEqual(next, [at(200, 1_000)]);
    assert.deepEqual(input, [], 'the caller-owned array must never be mutated');
  });

  it('appends cumulatively in arrival order', () => {
    const first = appendSweepSample([], 200, 1_000);
    const second = appendSweepSample(first, 400, 6_000);
    assert.deepEqual(second, [at(200, 1_000), at(400, 6_000)]);
    assert.deepEqual(first, [at(200, 1_000)], 'the earlier buffer stays unchanged');
  });

  it('keeps only the newest 10 samples once the cap is reached', () => {
    let samples: SweepSample[] = [];
    for (let i = 0; i < 12; i += 1) samples = appendSweepSample(samples, (i + 1) * 200, i * 6_000);
    assert.equal(samples.length, 10);
    assert.deepEqual(samples[0], at(600, 12_000), 'the two oldest samples are dropped');
    assert.deepEqual(samples[9], at(2_400, 66_000), 'the newest sample is kept');
  });
});

describe('sweepRate - pages/s across the newest eligible 5 s window', () => {
  it('is null below two samples (warm-up)', () => {
    assert.equal(sweepRate([]), null);
    assert.equal(sweepRate([at(200, 0)]), null);
  });

  it('is null while the newest gap is under 5 s', () => {
    assert.equal(sweepRate([at(200, 0), at(400, 4_999)]), null);
  });

  it('accepts a gap of exactly 5 s as the first measurable window', () => {
    assert.equal(sweepRate([at(200, 0), at(400, 5_000)]), 40);
  });

  it('measures delta pages over delta seconds', () => {
    assert.equal(sweepRate([at(200, 0), at(1_200, 10_000)]), 100);
  });

  it('uses the NEWEST eligible older sample, not the oldest one', () => {
    const samples = [at(0, 0), at(200, 5_000), at(400, 10_000)];
    // newest=10 s / 400 vs the 5 s older / 200 sample -> 200 pages / 5 s.
    assert.equal(sweepRate(samples), 40);
  });

  it('is null when the window processed nothing (zero delta)', () => {
    assert.equal(sweepRate([at(400, 0), at(400, 6_000)]), null);
  });

  it('is null when the cumulative counter did not advance (negative delta)', () => {
    assert.equal(sweepRate([at(400, 0), at(200, 6_000)]), null);
  });

  it('is null with many samples but no window reaching 5 s', () => {
    const samples = [at(100, 0), at(200, 2_000), at(300, 4_000)];
    assert.equal(sweepRate(samples), null);
  });
});

describe('rateText - one decimal, explicit unit', () => {
  it('formats the rate the way the progress line shows it', () => {
    assert.equal(rateText(7.06), '7.1 pages/s');
    assert.equal(rateText(7), '7.0 pages/s');
    assert.equal(rateText(0.04), '0.0 pages/s');
  });
});

describe('etaText - honest finish estimate, never an invented one', () => {
  it('is null without a usable rate', () => {
    assert.equal(etaText(0, 1_000, null), null);
    assert.equal(etaText(0, 1_000, 0), null);
    assert.equal(etaText(0, 1_000, -5), null);
  });

  it('is null until the total is known', () => {
    assert.equal(etaText(0, 0, 10), null);
  });

  it('is null once the sweep has nothing left to do', () => {
    assert.equal(etaText(1_000, 1_000, 10), null);
    assert.equal(etaText(1_200, 1_000, 10), null);
  });

  it('says "under a minute" below 60 s of work', () => {
    assert.equal(etaText(0, 500, 10), 'under a minute');
  });

  it('uses the minute format below one hour', () => {
    assert.equal(etaText(0, 900, 1), 'about 15 m left');
  });

  it('uses the hour + minute format from one hour up', () => {
    assert.equal(etaText(0, 2 * 3_600 + 1_200, 1), 'about 2 h 20 m left');
  });

  it('carries a rounded 60 minutes into the hour count', () => {
    // 7199 s -> floor 1 h, round(3599 / 60) = 60 -> normalised to 2 h 0 m.
    assert.equal(etaText(0, 7_199, 1), 'about 2 h 0 m left');
  });
});

describe('politenessNoticeText - fixed evaluation order on the latest batch', () => {
  it('says nothing when the marker is absent (older response shape)', () => {
    assert.equal(politenessNoticeText(undefined), null);
  });

  it('says nothing when the limiter is off, whatever the counts say', () => {
    assert.equal(
      politenessNoticeText(politeness({ mode: 'off', signals: 4, blocks: 2, deferred: 9 })),
      null,
    );
  });

  it('reports a wiring anomaly before the counts, even with a clean batch', () => {
    assert.equal(
      politenessNoticeText(politeness({ wiringOk: false })),
      'Rate-limit backoff is not engaging - wiring check failed (SEARCH_FULL_POLITENESS)',
    );
  });

  it('keeps the mode check ahead of the wiring check', () => {
    assert.equal(
      politenessNoticeText(politeness({ mode: 'off', wiringOk: false })),
      null,
    );
  });

  it('says nothing for a clean batch (all three counts zero)', () => {
    assert.equal(politenessNoticeText(politeness()), null);
  });

  it('renders the exact counts of a throttled batch', () => {
    assert.equal(
      politenessNoticeText(politeness({ signals: 3, blocks: 1, deferred: 7 })),
      'Rate limited by a job board - cooling down (3 responses, 1 cool-downs, 7 pages deferred this batch)',
    );
  });

  it('reports deferrals on their own (signals and blocks still zero)', () => {
    assert.equal(
      politenessNoticeText(politeness({ deferred: 12 })),
      'Rate limited by a job board - cooling down (0 responses, 0 cool-downs, 12 pages deferred this batch)',
    );
  });
});
