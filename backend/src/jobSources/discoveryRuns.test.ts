import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  beginRun,
  finishRun,
  getRun,
  isLikelyMissingKeyError,
  markCancelled,
  markFailed,
  markNeedsKey,
  markOk,
  markRunning,
  resetRunsForTests,
  setRunMode,
  setRunRegistryProgress,
  touchRun,
  MAX_RUNS,
  RUN_TTL_MS,
  type RunSnapshot,
} from './discoveryRuns.js';

const BOARDS = [
  { id: 'board-1', name: 'Board One', type: 'json' },
  { id: 'board-2', name: 'Board Two', type: 'rss' },
];

beforeEach(() => {
  resetRunsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('discoveryRuns registry', () => {
  it('beginRun seeds every board as pending', () => {
    beginRun('run-seed-1', 'user-1', BOARDS);
    const snap = getRun('run-seed-1', 'user-1');
    expect(snap).toBeDefined();
    expect(snap!.runId).toBe('run-seed-1');
    expect(snap!.startedAt).toBeTruthy();
    expect(snap!.finishedAt).toBeUndefined();
    expect(snap!.totalListings).toBe(0);
    expect(snap!.boards).toHaveLength(2);
    for (const b of snap!.boards) {
      expect(b.status).toBe('pending');
      expect(b.resultCount).toBe(0);
    }
    expect(snap!.boards[0]).toMatchObject({ boardId: 'board-1', name: 'Board One', type: 'json' });
  });

  it('markRunning/markOk/markFailed/markNeedsKey transition correctly', () => {
    beginRun('run-trans-1', 'user-1', BOARDS);
    markRunning('run-trans-1', 'board-1');
    expect(getRun('run-trans-1', 'user-1')!.boards[0].status).toBe('running');

    markOk('run-trans-1', 'board-1', 7, 123);
    const ok = getRun('run-trans-1', 'user-1')!.boards[0];
    expect(ok.status).toBe('ok');
    expect(ok.resultCount).toBe(7);
    expect(ok.latencyMs).toBe(123);

    markFailed('run-trans-1', 'board-2', 'Fetch failed 500', 45);
    const failed = getRun('run-trans-1', 'user-1')!.boards[1];
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Fetch failed 500');
    expect(failed.latencyMs).toBe(45);

    markNeedsKey('run-trans-1', 'board-2', 'No search API keys configured.');
    const needsKey = getRun('run-trans-1', 'user-1')!.boards[1];
    expect(needsKey.status).toBe('needs_key');
    expect(needsKey.error).toBe('No search API keys configured.');
  });

  it('finishRun stamps finishedAt/totalListings and converts in-flight boards to failed', () => {
    beginRun('run-finish1', 'user-1', BOARDS);
    markRunning('run-finish1', 'board-1');
    markOk('run-finish1', 'board-2', 3, 10);
    finishRun('run-finish1', 3);
    const snap = getRun('run-finish1', 'user-1')!;
    expect(snap.finishedAt).toBeTruthy();
    expect(snap.totalListings).toBe(3);
    const stuck = snap.boards.find((b) => b.boardId === 'board-1')!;
    expect(stuck.status).toBe('failed');
    expect(stuck.error).toBe('run ended before this board reported');
    const done = snap.boards.find((b) => b.boardId === 'board-2')!;
    expect(done.status).toBe('ok');
  });

  it('getRun returns undefined for unknown ids and other users', () => {
    beginRun('run-owner-1', 'user-1', BOARDS);
    expect(getRun('no-such-run', 'user-1')).toBeUndefined();
    expect(getRun('run-owner-1', 'user-2')).toBeUndefined();
    expect(getRun('run-owner-1', 'user-1')).toBeDefined();
  });

  it('getRun returns a deep copy that cannot mutate registry state', () => {
    beginRun('run-copy-11', 'user-1', BOARDS);
    const snap = getRun('run-copy-11', 'user-1')!;
    snap.boards[0].status = 'ok';
    snap.boards.push({ boardId: 'evil', name: 'evil', type: 'x', status: 'ok', resultCount: 99 });
    const fresh = getRun('run-copy-11', 'user-1')!;
    expect(fresh.boards).toHaveLength(2);
    expect(fresh.boards[0].status).toBe('pending');
  });

  it('evicts the oldest run once the 50-run cap is exceeded', () => {
    for (let i = 0; i < MAX_RUNS + 1; i++) {
      beginRun(`run-cap-${String(i).padStart(3, '0')}-x`, 'user-1', BOARDS);
    }
    expect(getRun('run-cap-000-x', 'user-1')).toBeUndefined();
    expect(getRun(`run-cap-${String(MAX_RUNS).padStart(3, '0')}-x`, 'user-1')).toBeDefined();
  });

  it('TTL expiry removes a stale run', async () => {
    beginRun('run-ttl-111', 'user-1', BOARDS, 20);
    expect(getRun('run-ttl-111', 'user-1')).toBeDefined();
    await new Promise((r) => setTimeout(r, 40));
    expect(getRun('run-ttl-111', 'user-1')).toBeUndefined();
  });

  it('production default TTL is 5 minutes', () => {
    expect(RUN_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('isLikelyMissingKeyError matches real BYOK shapes and rejects generic failures', () => {
    expect(isLikelyMissingKeyError('Findwork requires an API key. Set FINDWORK_API_KEY.')).toBe(true);
    expect(
      isLikelyMissingKeyError('Hard board "linkedin" requires a RapidAPI key (covers LinkedIn).'),
    ).toBe(true);
    expect(isLikelyMissingKeyError('No search API keys configured. Add an Exa or Tavily key in Settings (BYOK).')).toBe(
      true,
    );
    expect(
      isLikelyMissingKeyError('No scraping backend configured for "linkedin". Add a Firecrawl key in Settings.'),
    ).toBe(true);
    expect(isLikelyMissingKeyError('No Reed API keys configured. Add a key in Settings.')).toBe(true);
    expect(isLikelyMissingKeyError('Fetch failed 500')).toBe(false);
    expect(isLikelyMissingKeyError('timeout of 30000ms exceeded')).toBe(false);
  });

  it('unknown run ids are no-ops for the mark/finish helpers', () => {
    expect(() => {
      markRunning('missing-run', 'board-1');
      markOk('missing-run', 'board-1', 1, 1);
      markFailed('missing-run', 'board-1', 'boom', 1);
      markNeedsKey('missing-run', 'board-1', 'boom');
      markCancelled('missing-run');
      finishRun('missing-run', 0);
    }).not.toThrow();
  });
});

describe('discoveryRuns resolved-mode writer', () => {
  it('stores a resolved mode without changing beginRun or legacy snapshot behavior', () => {
    beginRun('run-mode-1', 'user-1', BOARDS);
    expect(getRun('run-mode-1', 'user-1')?.mode).toBeUndefined();

    setRunMode('run-mode-1', 'deep');
    const returned = getRun('run-mode-1', 'user-1');
    expect(returned?.mode).toBe('deep');
    returned!.mode = 'mutated-by-caller';
    expect(getRun('run-mode-1', 'user-1')?.mode).toBe('deep');
  });

  it('is a silent no-op for unknown and expired runs', () => {
    expect(() => setRunMode('missing-mode-run', 'full')).not.toThrow();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    beginRun('run-mode-expired', 'user-1', BOARDS, 10);
    setRunMode('run-mode-expired', 'standard');
    expect(getRun('run-mode-expired', 'user-1')?.mode).toBe('standard');
    vi.advanceTimersByTime(11);
    expect(getRun('run-mode-expired', 'user-1')).toBeUndefined();
    expect(() => setRunMode('run-mode-expired', 'deep')).not.toThrow();
  });
});

describe('discoveryRuns wave-7 snapshot extension (T743)', () => {
  beforeEach(() => {
    resetRunsForTests();
  });

  it('a snapshot written before the change still reads correctly (all new fields optional)', () => {
    // A pre-change literal carries none of the wave-7 fields and must still
    // satisfy the RunSnapshot type (compile-time proof via tsc) ...
    const legacy: RunSnapshot = {
      runId: 'run-legacy-1',
      startedAt: new Date(0).toISOString(),
      boards: [{ boardId: 'board-1', name: 'Board One', type: 'json', status: 'ok', resultCount: 4 }],
      totalListings: 4,
    };
    expect(legacy.mode).toBeUndefined();
    expect(legacy.cancelled).toBeUndefined();
    expect(legacy.intent).toBeUndefined();
    expect(legacy.cursor).toBeUndefined();
    expect(legacy.registryProcessed).toBeUndefined();
    expect(legacy.registryTotal).toBeUndefined();
    expect(legacy.boards[0].tier).toBeUndefined();
    expect(legacy.boards[0].group).toBeUndefined();
    expect(legacy.boards[0].truncated).toBeUndefined();
    expect(legacy.boards[0].skippedReason).toBeUndefined();
    expect(legacy.boards[0].unitKind).toBeUndefined();
    // ... and a run seeded the old way (plain seeds, no extras) reads back
    // with every new field absent.
    beginRun('run-legacy-2', 'user-1', BOARDS);
    const snap = getRun('run-legacy-2', 'user-1')!;
    expect(snap.mode).toBeUndefined();
    expect(snap.cancelled).toBeUndefined();
    expect(snap.intent).toBeUndefined();
    for (const b of snap.boards) {
      expect(b.tier).toBeUndefined();
      expect(b.group).toBeUndefined();
      expect(b.truncated).toBeUndefined();
      expect(b.skippedReason).toBeUndefined();
      expect(b.unitKind).toBeUndefined();
    }
  });

  it('beginRun seed carries the additive per-unit fields', () => {
    beginRun('run-seed-ext-1', 'user-1', [
      { id: 'board-1', name: 'Board One', type: 'json', tier: 1, group: 'ats', unitKind: 'board' },
      { id: 'board-2', name: 'Board Two', type: 'rss' },
    ]);
    const snap = getRun('run-seed-ext-1', 'user-1')!;
    expect(snap.boards[0]).toMatchObject({ tier: 1, group: 'ats', unitKind: 'board' });
    expect(snap.boards[1].tier).toBeUndefined();
    expect(snap.boards[1].group).toBeUndefined();
    expect(snap.boards[1].unitKind).toBeUndefined();
  });

  it('markCancelled flags the run and releases in-flight boards as cancelled, never failed', () => {
    beginRun('run-cancel-1', 'user-1', BOARDS);
    markRunning('run-cancel-1', 'board-1');
    markOk('run-cancel-1', 'board-2', 3, 10);
    markCancelled('run-cancel-1');
    const snap = getRun('run-cancel-1', 'user-1')!;
    expect(snap.cancelled).toBe(true);
    expect(snap.finishedAt).toBeTruthy();
    expect(snap.boards.find((b) => b.boardId === 'board-1')!.status).toBe('cancelled');
    expect(snap.boards.find((b) => b.boardId === 'board-2')!.status).toBe('ok');
  });

  it('markCancelled is idempotent and a no-op for finished runs', () => {
    beginRun('run-cancel-2', 'user-1', BOARDS);
    markCancelled('run-cancel-2');
    const first = getRun('run-cancel-2', 'user-1')!;
    markCancelled('run-cancel-2');
    const second = getRun('run-cancel-2', 'user-1')!;
    expect(second).toEqual(first);

    beginRun('run-cancel-3', 'user-1', BOARDS);
    finishRun('run-cancel-3', 0);
    const finished = getRun('run-cancel-3', 'user-1')!;
    markCancelled('run-cancel-3');
    // Finished snapshot unchanged: no cancelled flag, same finishedAt.
    expect(getRun('run-cancel-3', 'user-1')).toEqual(finished);
    expect(getRun('run-cancel-3', 'user-1')!.cancelled).toBeUndefined();
  });

  it('finishRun leaves a cancelled unit as cancelled, NOT failed', () => {
    beginRun('run-cancel-4', 'user-1', BOARDS);
    markRunning('run-cancel-4', 'board-1');
    markOk('run-cancel-4', 'board-2', 2, 5);
    markCancelled('run-cancel-4');
    finishRun('run-cancel-4', 2);
    const snap = getRun('run-cancel-4', 'user-1')!;
    expect(snap.boards.find((b) => b.boardId === 'board-1')!.status).toBe('cancelled');
    expect(snap.boards.find((b) => b.boardId === 'board-1')!.error).toBeUndefined();
    expect(snap.boards.find((b) => b.boardId === 'board-2')!.status).toBe('ok');
    // The run-level flag survives the late finishRun.
    expect(snap.cancelled).toBe(true);
  });

  it('in-memory bounds are unchanged (ADR-013)', () => {
    expect(MAX_RUNS).toBe(50);
    expect(RUN_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe('discoveryRuns Full-scan snapshot extension (T883)', () => {
  it('stores cursor and registry counters on a live run and returns primitive copies', () => {
    beginRun('run-progress-1', 'user-1', BOARDS);
    const progress = { cursor: 'clx_abc', processed: 12, total: 80 };
    setRunRegistryProgress('run-progress-1', progress);

    progress.cursor = 'clx_mutated';
    progress.processed = 999;
    const snap = getRun('run-progress-1', 'user-1')!;
    expect(snap).toMatchObject({
      cursor: 'clx_abc',
      registryProcessed: 12,
      registryTotal: 80,
    });

    snap.cursor = 'clx_read_mutated';
    snap.registryProcessed = 999;
    expect(getRun('run-progress-1', 'user-1')).toMatchObject({
      cursor: 'clx_abc',
      registryProcessed: 12,
      registryTotal: 80,
    });
  });

  it('setRunRegistryProgress is a silent no-op for an unknown run', () => {
    expect(() =>
      setRunRegistryProgress('missing-progress-run', {
        cursor: null,
        processed: 1,
        total: 2,
      }),
    ).not.toThrow();
  });

  it('touchRun refreshes a live run beyond its original expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    beginRun('run-touch-1', 'user-1', BOARDS, 1_000);

    vi.advanceTimersByTime(900);
    touchRun('run-touch-1', 5_000);
    vi.advanceTimersByTime(200);
    expect(getRun('run-touch-1', 'user-1')).toBeDefined();

    vi.advanceTimersByTime(4_900);
    expect(getRun('run-touch-1', 'user-1')).toBeUndefined();
  });

  it('touchRun is a no-op for unknown and expired runs', () => {
    expect(() => touchRun('missing-touch-run', 1_000)).not.toThrow();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    beginRun('run-touch-expired', 'user-1', BOARDS, 10);
    vi.advanceTimersByTime(11);
    expect(getRun('run-touch-expired', 'user-1')).toBeUndefined();
    expect(() => touchRun('run-touch-expired', 1_000)).not.toThrow();
    expect(getRun('run-touch-expired', 'user-1')).toBeUndefined();
  });
});
