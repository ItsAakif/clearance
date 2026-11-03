// In-process scheduler for the registry sweep cycle.
//
// The scheduler is deliberately tiny: one `setInterval` and one in-memory lock.
// It runs ONE `runSweepCycle` per tick with the tick's wall-clock budget
// (`maxMinutes`), so a tick can never outlive its budget by more than the batch
// already in flight, and the next tick continues from the persisted cursor.
//
// Env (read once, at start):
//   SWEEP_INTERVAL_HOURS    default 0    -> DISABLED (no timer is created)
//   SWEEP_TICK_MAX_MINUTES  default 20   -> the cycle's `maxMinutes`
//   SWEEP_BATCH_BOARDS      default 500  -> the cycle's `batchSize`
//
// Safety properties, all pinned by sweepScheduler.test.ts:
//   - `SWEEP_INTERVAL_HOURS=0` (the default) starts nothing;
//   - only one cycle can be in flight (the lock), so a slow tick cannot stack;
//   - every tick is awaited inside try/catch and logged - a thrown cycle never
//     reaches the process as an unhandled rejection;
//   - `stopSweepScheduler()` clears the timer and is registered for SIGTERM /
//     SIGINT, so graceful shutdown is not held open by an interval;
//   - `NODE_ENV=test` creates no timer (tests call `runSweepSchedulerTick`).
//
// The timer is `unref()`d as well: even a missed `stop` cannot keep the event
// loop alive on its own.

import {
  DEFAULT_CYCLE_BATCH_SIZE,
  DEFAULT_CYCLE_CONCURRENCY,
  DEFAULT_CYCLE_MAX_ROWS_PER_BATCH,
  DEFAULT_CYCLE_PER_BOARD_TIMEOUT_MS,
  type CycleResult,
  type SweepCycleOptions,
} from './sweepCycle.js';

export const SWEEP_INTERVAL_HOURS_ENV = 'SWEEP_INTERVAL_HOURS';
export const SWEEP_TICK_MAX_MINUTES_ENV = 'SWEEP_TICK_MAX_MINUTES';
export const SWEEP_BATCH_BOARDS_ENV = 'SWEEP_BATCH_BOARDS';

export const DEFAULT_SWEEP_INTERVAL_HOURS = 0;
export const DEFAULT_SWEEP_TICK_MAX_MINUTES = 20;
export const DEFAULT_SWEEP_BATCH_BOARDS = DEFAULT_CYCLE_BATCH_SIZE;

/**
 * Hard cap on batches inside one tick. The minute budget is the real stop; this
 * only bounds a pathological "every batch is instant and empty" registry.
 */
export const SWEEP_TICK_MAX_BATCHES = 100;

export interface SweepSchedulerConfig {
  intervalHours: number;
  tickMaxMinutes: number;
  batchBoards: number;
  /** Batch-level knobs; fixed unless a test/operator overrides them. */
  maxRowsPerBatch: number;
  concurrency: number;
  perBoardTimeoutMs: number;
  /** Soft-close a cycle when the tick happens to complete one. */
  closeAfterCycle: boolean;
  /**
   * NODE_ENV seam. Defaults to `process.env.NODE_ENV`; tests pass 'production'
   * to exercise the timer path (the guard exists to keep unit tests timer-free).
   */
  nodeEnv?: string;
}

export interface SweepSchedulerDeps {
  /** Run one cycle. In production this is `runSweepCycle` + `createSweepCycleDeps`. */
  runCycle(options: SweepCycleOptions): Promise<CycleResult>;
  log?(line: string): void;
}

export function readSweepSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SweepSchedulerConfig {
  const num = (name: string, fallback: number, allowZero: boolean): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim().length === 0) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return fallback;
    if (value === 0 && !allowZero) return fallback;
    return value;
  };
  return {
    intervalHours: num(SWEEP_INTERVAL_HOURS_ENV, DEFAULT_SWEEP_INTERVAL_HOURS, true),
    tickMaxMinutes: num(SWEEP_TICK_MAX_MINUTES_ENV, DEFAULT_SWEEP_TICK_MAX_MINUTES, false),
    batchBoards: Math.floor(num(SWEEP_BATCH_BOARDS_ENV, DEFAULT_SWEEP_BATCH_BOARDS, false)),
    maxRowsPerBatch: DEFAULT_CYCLE_MAX_ROWS_PER_BATCH,
    concurrency: DEFAULT_CYCLE_CONCURRENCY,
    perBoardTimeoutMs: DEFAULT_CYCLE_PER_BOARD_TIMEOUT_MS,
    closeAfterCycle: true,
    nodeEnv: env.NODE_ENV,
  };
}

/** The cycle options a scheduler tick uses. Exported so tests can pin them. */
export function sweepTickOptions(config: SweepSchedulerConfig): SweepCycleOptions {
  return {
    batchSize: config.batchBoards,
    maxRowsPerBatch: config.maxRowsPerBatch,
    concurrency: config.concurrency,
    perBoardTimeoutMs: config.perBoardTimeoutMs,
    maxBatches: SWEEP_TICK_MAX_BATCHES,
    maxMinutes: config.tickMaxMinutes,
    closeAfterCycle: config.closeAfterCycle,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let activeDeps: SweepSchedulerDeps | null = null;
let activeConfig: SweepSchedulerConfig | null = null;

const LOG_PREFIX = '[sweep-scheduler]';

function logger(deps: SweepSchedulerDeps | null): (line: string) => void {
  return deps?.log ?? ((line: string) => console.log(line));
}

/** True while a tick (one whole cycle) is in flight. */
export function isSweepSchedulerRunning(): boolean {
  return running;
}

export function isSweepSchedulerStarted(): boolean {
  return timer !== null;
}

/**
 * Run one cycle under the single-flight lock.
 *
 * Returns the cycle result, or `null` when the tick was skipped (another cycle
 * in flight) or failed. NEVER throws: the scheduler runs on a timer, and a
 * rejected timer callback is an unhandled rejection that would take the process
 * down for a transient network/DB problem.
 */
export async function runSweepSchedulerTick(
  deps: SweepSchedulerDeps,
  config: SweepSchedulerConfig = readSweepSchedulerConfig(),
): Promise<CycleResult | null> {
  const log = logger(deps);
  if (running) {
    log(`${LOG_PREFIX} tick skipped: a cycle is already running`);
    return null;
  }
  running = true;
  const startedAt = Date.now();
  try {
    log(
      `${LOG_PREFIX} start boards=${config.batchBoards} budget=${config.tickMaxMinutes}m ` +
        `intervalHours=${config.intervalHours}`,
    );
    const result = await deps.runCycle(sweepTickOptions(config));
    log(
      `${LOG_PREFIX} finish batches=${result.batches} boards=${result.boards} ` +
        `fetched=${result.rowsFetched} persisted=${result.rowsPersisted} ` +
        `closed=${result.closed} completed=${result.completed} ` +
        `elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${LOG_PREFIX} error: ${message}`);
    return null;
  } finally {
    running = false;
  }
}

/**
 * Start the interval. Returns true only when a timer was actually created.
 *
 * Disabled (`intervalHours <= 0`) and `NODE_ENV=test` are both no-ops that log
 * a single line - they never throw, so a deployment with the default env boots
 * exactly as before.
 */
export function startSweepScheduler(
  deps: SweepSchedulerDeps,
  config: SweepSchedulerConfig = readSweepSchedulerConfig(),
): boolean {
  const log = logger(deps);
  stopSweepScheduler();
  activeDeps = deps;
  activeConfig = config;

  if (!Number.isFinite(config.intervalHours) || config.intervalHours <= 0) {
    log(`${LOG_PREFIX} disabled (${SWEEP_INTERVAL_HOURS_ENV}=0)`);
    return false;
  }
  const nodeEnv = config.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === 'test') {
    log(`${LOG_PREFIX} disabled in NODE_ENV=test (no timers in tests)`);
    return false;
  }

  const intervalMs = Math.max(1, Math.round(config.intervalHours * 60 * 60 * 1000));
  timer = setInterval(() => {
    void runSweepSchedulerTick(deps, config);
  }, intervalMs);
  // Do not hold the event loop open just for the sweep.
  timer.unref?.();

  process.on('SIGTERM', stopSweepScheduler);
  process.on('SIGINT', stopSweepScheduler);

  log(`${LOG_PREFIX} started intervalHours=${config.intervalHours} budget=${config.tickMaxMinutes}m`);
  return true;
}

/**
 * Clear the timer and the signal handlers. Idempotent, and safe to call when
 * the scheduler never started (shutdown path).
 */
export function stopSweepScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
    (activeDeps ? logger(activeDeps) : (line: string) => console.log(line))(
      `${LOG_PREFIX} stopped`,
    );
  }
  process.removeListener('SIGTERM', stopSweepScheduler);
  process.removeListener('SIGINT', stopSweepScheduler);
  activeDeps = null;
  activeConfig = null;
}

/**
 * One tick using the deps/config captured by `startSweepScheduler`. Exposed for
 * a manual trigger; returns null when the scheduler is not started.
 */
export async function triggerSweepSchedulerTick(): Promise<CycleResult | null> {
  if (!activeDeps) return null;
  return runSweepSchedulerTick(activeDeps, activeConfig ?? readSweepSchedulerConfig());
}

/** Test-only reset: clears the lock as well as the timer. */
export function resetSweepSchedulerForTests(): void {
  stopSweepScheduler();
  running = false;
}
