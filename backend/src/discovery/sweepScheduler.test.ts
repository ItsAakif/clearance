// Scheduler contract (discovery/sweepScheduler.ts).
//
// The scheduler is a timer plus a lock, so every test drives it directly:
// either the exported tick with fake deps, or fake timers for start/stop.
// Pins:
//   - SWEEP_INTERVAL_HOURS=0 (the default) starts nothing;
//   - NODE_ENV=test creates no timer;
//   - one cycle at a time (the in-memory lock);
//   - stop clears the timer and no further ticks fire;
//   - a throwing cycle is logged, never rethrown.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_SWEEP_BATCH_BOARDS,
  DEFAULT_SWEEP_INTERVAL_HOURS,
  DEFAULT_SWEEP_TICK_MAX_MINUTES,
  SWEEP_TICK_MAX_BATCHES,
  isSweepSchedulerRunning,
  isSweepSchedulerStarted,
  readSweepSchedulerConfig,
  resetSweepSchedulerForTests,
  runSweepSchedulerTick,
  startSweepScheduler,
  stopSweepScheduler,
  sweepTickOptions,
  type SweepSchedulerConfig,
  type SweepSchedulerDeps,
} from './sweepScheduler.js';
import type { CycleResult, SweepCycleOptions } from './sweepCycle.js';

function cycleResult(over: Partial<CycleResult> = {}): CycleResult {
  return {
    batches: 1,
    boards: 2,
    ok: 1,
    failed: 1,
    rowsFetched: 3,
    rowsPersisted: 2,
    deactivated: 0,
    backedOff: 0,
    closed: 0,
    elapsedMs: 5,
    completed: false,
    ...over,
  };
}

function baseConfig(over: Partial<SweepSchedulerConfig> = {}): SweepSchedulerConfig {
  return {
    intervalHours: 1,
    tickMaxMinutes: 20,
    batchBoards: 500,
    maxRowsPerBatch: 5000,
    concurrency: 8,
    perBoardTimeoutMs: 20_000,
    closeAfterCycle: true,
    nodeEnv: 'production',
    ...over,
  };
}

function deps(runCycle: (options: SweepCycleOptions) => Promise<CycleResult>) {
  const log: string[] = [];
  const d: SweepSchedulerDeps = {
    runCycle,
    log: (line) => log.push(line),
  };
  return { deps: d, log };
}

beforeEach(() => {
  resetSweepSchedulerForTests();
});

afterEach(() => {
  resetSweepSchedulerForTests();
  vi.useRealTimers();
});

describe('config', () => {
  it('defaults to disabled with a 20-minute tick and 500-board batches', () => {
    const config = readSweepSchedulerConfig({} as NodeJS.ProcessEnv);
    expect(config.intervalHours).toBe(DEFAULT_SWEEP_INTERVAL_HOURS);
    expect(config.intervalHours).toBe(0);
    expect(config.tickMaxMinutes).toBe(DEFAULT_SWEEP_TICK_MAX_MINUTES);
    expect(config.tickMaxMinutes).toBe(20);
    expect(config.batchBoards).toBe(DEFAULT_SWEEP_BATCH_BOARDS);
    expect(config.batchBoards).toBe(500);
  });

  it('reads the three operator env vars and ignores junk', () => {
    const config = readSweepSchedulerConfig({
      SWEEP_INTERVAL_HOURS: '6',
      SWEEP_TICK_MAX_MINUTES: '35',
      SWEEP_BATCH_BOARDS: '250',
      NODE_ENV: 'production',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.intervalHours).toBe(6);
    expect(config.tickMaxMinutes).toBe(35);
    expect(config.batchBoards).toBe(250);

    const junk = readSweepSchedulerConfig({
      SWEEP_INTERVAL_HOURS: 'soon',
      SWEEP_TICK_MAX_MINUTES: '-3',
      SWEEP_BATCH_BOARDS: '',
    } as unknown as NodeJS.ProcessEnv);
    expect(junk.intervalHours).toBe(0);
    expect(junk.tickMaxMinutes).toBe(20);
    expect(junk.batchBoards).toBe(500);
  });

  it('maps a tick onto one cycle with the tick budget', () => {
    const options = sweepTickOptions(baseConfig({ tickMaxMinutes: 12, batchBoards: 40 }));
    expect(options.maxMinutes).toBe(12);
    expect(options.batchSize).toBe(40);
    expect(options.maxBatches).toBe(SWEEP_TICK_MAX_BATCHES);
    expect(options.closeAfterCycle).toBe(true);
  });
});

describe('startSweepScheduler', () => {
  it('is disabled by default (SWEEP_INTERVAL_HOURS=0) and creates no timer', () => {
    vi.useFakeTimers();
    const { deps: d, log } = deps(async () => cycleResult());
    const started = startSweepScheduler(d, baseConfig({ intervalHours: 0 }));

    expect(started).toBe(false);
    expect(isSweepSchedulerStarted()).toBe(false);
    expect(log.some((line) => line.includes('disabled'))).toBe(true);

    vi.advanceTimersByTime(3 * 60 * 60 * 1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('creates no timer under NODE_ENV=test', () => {
    vi.useFakeTimers();
    const { deps: d, log } = deps(async () => cycleResult());
    const started = startSweepScheduler(d, baseConfig({ intervalHours: 1, nodeEnv: 'test' }));

    expect(started).toBe(false);
    expect(isSweepSchedulerStarted()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(log.some((line) => line.includes('NODE_ENV=test'))).toBe(true);
  });

  it('ticks on the interval and stop() clears the timer', async () => {
    vi.useFakeTimers();
    const runCycle = vi.fn(async (_options: SweepCycleOptions) => cycleResult());
    const { deps: d, log } = deps(runCycle);

    expect(startSweepScheduler(d, baseConfig({ intervalHours: 1 }))).toBe(true);
    expect(isSweepSchedulerStarted()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runCycle).toHaveBeenCalledTimes(1);
    const options = runCycle.mock.calls[0][0];
    expect(options.maxMinutes).toBe(20);
    expect(options.batchSize).toBe(500);

    stopSweepScheduler();
    expect(isSweepSchedulerStarted()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(log.some((line) => line.includes('stopped'))).toBe(true);
  });

  it('logs start and finish for each tick', async () => {
    const runCycle = vi.fn(async (_options: SweepCycleOptions) => cycleResult({ completed: true, closed: 3 }));
    const { deps: d, log } = deps(runCycle);

    await runSweepSchedulerTick(d, baseConfig());
    expect(log[0]).toContain('[sweep-scheduler] start');
    expect(log.some((line) => line.includes('finish'))).toBe(true);
    expect(log.some((line) => line.includes('closed=3'))).toBe(true);
    expect(log.some((line) => line.includes('completed=true'))).toBe(true);
  });
});

describe('single-flight lock', () => {
  it('skips a second tick while a cycle is in flight', async () => {
    let release: (() => void) | null = null;
    const runCycle = vi.fn(async (_options: SweepCycleOptions): Promise<CycleResult> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return cycleResult();
    });
    const { deps: d, log } = deps(runCycle);

    const first = runSweepSchedulerTick(d, baseConfig());
    // Let the first tick reach the awaited cycle before starting the second.
    await Promise.resolve();
    expect(isSweepSchedulerRunning()).toBe(true);

    const second = await runSweepSchedulerTick(d, baseConfig());
    expect(second).toBeNull();
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(log.some((line) => line.includes('tick skipped'))).toBe(true);

    (release as unknown as () => void)();
    const firstResult = await first;
    expect(firstResult).not.toBeNull();
    expect(isSweepSchedulerRunning()).toBe(false);

    // The lock is released: the next tick runs normally.
    runCycle.mockImplementation(async () => cycleResult());
    await runSweepSchedulerTick(d, baseConfig());
    expect(runCycle).toHaveBeenCalledTimes(2);
  });
});

describe('error isolation', () => {
  it('a throwing cycle is logged and never rethrown', async () => {
    const runCycle = vi.fn(async (_options: SweepCycleOptions): Promise<CycleResult> => {
      throw new Error('registry unavailable');
    });
    const { deps: d, log } = deps(runCycle);

    await expect(runSweepSchedulerTick(d, baseConfig())).resolves.toBeNull();
    expect(log.some((line) => line.includes('error: registry unavailable'))).toBe(true);
    expect(isSweepSchedulerRunning()).toBe(false);

    // The scheduler keeps working after a failed tick.
    runCycle.mockImplementationOnce(async () => cycleResult());
    const next = await runSweepSchedulerTick(d, baseConfig());
    expect(next).not.toBeNull();
  });

  it('a throwing tick from the timer does not become an unhandled rejection', async () => {
    vi.useFakeTimers();
    const runCycle = vi.fn(async (_options: SweepCycleOptions): Promise<CycleResult> => {
      throw new Error('boom');
    });
    const { deps: d } = deps(runCycle);

    startSweepScheduler(d, baseConfig({ intervalHours: 1 }));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runCycle).toHaveBeenCalledTimes(1);
    // Still armed for the next interval.
    expect(isSweepSchedulerStarted()).toBe(true);
  });
});
