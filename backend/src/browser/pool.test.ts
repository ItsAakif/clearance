/**
 * Unit tests for the bounded browser worker pool (`./pool.js`).
 *
 * FAKE TASKS ONLY: per T723 step 6 the pool takes tasks, so it is fully
 * testable without CamoFox present. No browser client is imported here
 * (or by the pool itself) — every `run` below is a hand-written fake
 * that records invocations, tracks concurrency, or blocks on a gate.
 */

import { describe, it, expect } from 'vitest';
import {
  CAMOFOX_MAX_CONCURRENCY,
  CAMOFOX_MAX_QUEUE_DEPTH,
  CAMOFOX_MAX_URLS_PER_RUN,
  createBrowserPool,
} from './pool.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for test condition');
    }
    await delay(5);
  }
}

function jobUrl(n: number): string {
  return `https://careers.example.com/jobs/${n}`;
}

describe('pool caps', () => {
  it('exports sane positive-integer caps', () => {
    for (const cap of [CAMOFOX_MAX_CONCURRENCY, CAMOFOX_MAX_URLS_PER_RUN, CAMOFOX_MAX_QUEUE_DEPTH]) {
      expect(Number.isInteger(cap)).toBe(true);
      expect(cap).toBeGreaterThanOrEqual(1);
    }
  });

  it('concurrency never exceeds CAMOFOX_MAX_CONCURRENCY (default pool)', async () => {
    const pool = createBrowserPool();
    let inFlight = 0;
    let maxObserved = 0;
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      url: jobUrl(i),
      run: async (): Promise<number> => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        await delay(15);
        inFlight -= 1;
        return i;
      },
    }));
    const results = await pool.run(tasks);
    expect(results).toHaveLength(12);
    expect(maxObserved).toBeLessThanOrEqual(CAMOFOX_MAX_CONCURRENCY);
    for (const [i, result] of results.entries()) {
      expect(result.url).toBe(jobUrl(i));
      expect(result.ok).toBe(true);
      expect(result.value).toBe(i);
    }
    expect(pool.activeSessions).toBe(0);
  });

  it('parallelism actually happens under an explicit bound', async () => {
    const pool = createBrowserPool({ maxConcurrency: 3 });
    let inFlight = 0;
    let maxObserved = 0;
    const tasks = Array.from({ length: 9 }, (_, i) => ({
      url: jobUrl(i),
      run: async (): Promise<number> => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        await delay(15);
        inFlight -= 1;
        return i;
      },
    }));
    const results = await pool.run(tasks);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxObserved).toBeGreaterThan(1);
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(pool.activeSessions).toBe(0);
  });

  it('URL cap truncates and REPORTS every dropped URL', async () => {
    const pool = createBrowserPool({ maxUrlsPerRun: 3 });
    let executed = 0;
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      url: jobUrl(i),
      run: async (): Promise<number> => {
        executed += 1;
        return i;
      },
    }));
    const results = await pool.run(tasks);
    expect(executed).toBe(3);
    expect(results).toHaveLength(5);
    for (const result of results.slice(0, 3)) {
      expect(result.ok).toBe(true);
    }
    for (const result of results.slice(3)) {
      expect(result.ok).toBe(false);
      expect(result.reason ?? '').toContain('truncated:');
      expect(result.reason ?? '').toContain('CAMOUFOX_MAX_URLS_PER_RUN=3');
    }
    expect(pool.activeSessions).toBe(0);
  });

  it('queue overflow is REPORTED, never silent', async () => {
    const pool = createBrowserPool({ maxUrlsPerRun: 10, maxQueueDepth: 2 });
    let executed = 0;
    const tasks = Array.from({ length: 4 }, (_, i) => ({
      url: jobUrl(i),
      run: async (): Promise<number> => {
        executed += 1;
        return i;
      },
    }));
    const results = await pool.run(tasks);
    expect(executed).toBe(2);
    expect(results).toHaveLength(4);
    for (const result of results.slice(0, 2)) {
      expect(result.ok).toBe(true);
    }
    for (const result of results.slice(2)) {
      expect(result.ok).toBe(false);
      expect(result.reason ?? '').toContain('queue-overflow:');
      expect(result.reason ?? '').toContain('CAMOUFOX_MAX_QUEUE_DEPTH=2');
    }
    expect(pool.activeSessions).toBe(0);
  });
});

describe('pool cancel', () => {
  it('cancel() stops queued work, drains in-flight, zeroes activeSessions, is idempotent', async () => {
    const pool = createBrowserPool({ maxConcurrency: 2, maxUrlsPerRun: 10, maxQueueDepth: 10 });
    let started = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tasks = Array.from({ length: 6 }, (_, i) => ({
      url: jobUrl(i),
      run: async (): Promise<string> => {
        started += 1;
        if (started <= 2) {
          await gate;
          return 'in-flight';
        }
        return 'queued';
      },
    }));
    const pending = pool.run(tasks);
    await waitFor(() => pool.activeSessions === 2);
    expect(started).toBe(2);

    pool.cancel();
    pool.cancel(); // idempotent: second cancel is a no-op, must not throw
    releaseGate();

    const results = await pending;
    // No new task started after cancel.
    expect(started).toBe(2);
    expect(pool.activeSessions).toBe(0);
    expect(results).toHaveLength(6);
  });

  it('a cancelled task reports cancelled, NOT failed', async () => {
    const pool = createBrowserPool({ maxConcurrency: 2, maxUrlsPerRun: 10, maxQueueDepth: 10 });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const tasks = Array.from({ length: 4 }, (_, i) => ({
      url: jobUrl(i),
      run: async (): Promise<string> => {
        await gate;
        return 'late';
      },
    }));
    const pending = pool.run(tasks);
    await waitFor(() => pool.activeSessions === 2);
    pool.cancel();
    releaseGate();
    const results = await pending;
    expect(results).toHaveLength(4);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.reason ?? '').toContain('cancelled');
      expect(result.reason ?? '').not.toContain('failed');
    }
    expect(pool.activeSessions).toBe(0);
  });

  it('cancel() with no live run is a no-op and the pool stays reusable', async () => {
    const pool = createBrowserPool();
    pool.cancel(); // no live run: must not throw, must not poison the next run
    const results = await pool.run([
      { url: jobUrl(1), run: async () => 'a' },
      { url: jobUrl(2), run: async () => 'b' },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(pool.activeSessions).toBe(0);
  });
});

describe('pool dedupe and failures', () => {
  it('duplicate URLs collapse before the pool sees them', async () => {
    const pool = createBrowserPool();
    let executed = 0;
    const tasks = [
      { url: 'https://careers.example.com/jobs/1', run: async () => 'x' },
      // Same canonical page: tracking param, fragment, trailing slash.
      { url: 'https://careers.example.com/jobs/1?utm_source=alert', run: async () => 'x' },
      { url: 'https://careers.example.com/jobs/1#details', run: async () => 'x' },
      { url: 'https://careers.example.com/jobs/1/', run: async () => 'x' },
      { url: 'https://careers.example.com/jobs/2', run: async () => 'y' },
    ].map((task) => ({
      url: task.url,
      run: async (): Promise<string> => {
        executed += 1;
        return task.run();
      },
    }));
    const results = await pool.run(tasks);
    expect(executed).toBe(2);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(pool.activeSessions).toBe(0);
  });

  it('a throwing task reports failed (not cancelled) and the pool drains', async () => {
    const pool = createBrowserPool();
    const results = await pool.run([
      {
        url: jobUrl(1),
        run: async (): Promise<string> => {
          throw new Error('boom https://user:pass@careers.example.com/ must not leak');
        },
      },
      { url: jobUrl(2), run: async () => 'fine' },
    ]);
    expect(results).toHaveLength(2);
    const [failed, succeeded] = results;
    expect(failed.ok).toBe(false);
    expect(failed.reason ?? '').toContain('failed:');
    expect(failed.reason ?? '').toContain('boom');
    // Credentials in the rejection text are stripped before reporting.
    expect(failed.reason ?? '').not.toContain('user:pass@');
    expect(failed.reason ?? '').not.toContain('cancelled');
    expect(succeeded.ok).toBe(true);
    expect(pool.activeSessions).toBe(0);
  });

  it('an empty run resolves to an empty result set', async () => {
    const pool = createBrowserPool();
    expect(await pool.run([])).toEqual([]);
    expect(pool.activeSessions).toBe(0);
  });
});
