import { describe, it, expect } from 'vitest';
import {
  BLOCKED_BASE_BACKOFF_MS,
  BLOCKED_MAX_BACKOFF_MS,
  FRESH_WINDOW_MS,
  STALE_WINDOW_MS,
  blockedBackoffMs,
  classify,
  failureBackoffMs,
  nextCheckAt,
  type RegistryPageState,
} from './staleness.js';
import { isFailureStatus } from './verifyStatus.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-19T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

describe('staleness thresholds', () => {
  it('exports the documented fresh/stale windows and blocked backoff bounds', () => {
    expect(FRESH_WINDOW_MS).toBe(7 * DAY_MS);
    expect(STALE_WINDOW_MS).toBe(30 * DAY_MS);
    expect(BLOCKED_BASE_BACKOFF_MS).toBe(1 * DAY_MS);
    expect(BLOCKED_MAX_BACKOFF_MS).toBe(30 * DAY_MS);
  });
});

describe('failure-status shared backoff curve', () => {
  it('failureBackoffMs and blockedBackoffMs are the same curve', () => {
    for (const failures of [0, 1, 2, 3, 10, 99]) {
      expect(failureBackoffMs(failures)).toBe(blockedBackoffMs(failures));
    }
  });
});

describe('classify under an injected clock', () => {
  it('returns fresh for a recently verified ok page', () => {
    const page: RegistryPageState = {
      verifyStatus: 'ok',
      verifiedAt: daysAgo(1),
      failureCount: 0,
    };
    expect(classify(page, NOW)).toBe('fresh');
  });

  it('returns stale for an aging ok page', () => {
    const page: RegistryPageState = {
      verifyStatus: 'ok',
      verifiedAt: daysAgo(10),
      failureCount: 0,
    };
    expect(classify(page, NOW)).toBe('stale');
  });

  it('returns due for an ok page older than the stale window', () => {
    const page: RegistryPageState = {
      verifyStatus: 'ok',
      verifiedAt: daysAgo(60),
      failureCount: 0,
    };
    expect(classify(page, NOW)).toBe('due');
  });

  it('returns due for a never-checked unverified page', () => {
    expect(
      classify({ verifyStatus: 'unverified', failureCount: 0 }, NOW),
    ).toBe('due');
  });

  it('returns due for each of the four failure statuses (T903 dead-branch repair)', () => {
    // The pre-wave dead-branch sentinel never fired because the crawler
    // never writes that status; the four statuses it DOES write must now
    // classify as 'due' so they are not parked as 'fresh' for 7 days.
    for (const status of ['http_error', 'timeout', 'invalid']) {
      const page: RegistryPageState = {
        verifyStatus: status,
        verifiedAt: null,
        lastCheckedAt: NOW,
        failureCount: 0,
      };
      expect(isFailureStatus(status)).toBe(true);
      expect(classify(page, NOW)).toBe('due');
    }
  });

  it('returns blocked for a blocked page regardless of recency', () => {
    const page: RegistryPageState = {
      verifyStatus: 'blocked',
      verifiedAt: daysAgo(1),
      lastCheckedAt: daysAgo(1),
      failureCount: 3,
    };
    expect(classify(page, NOW)).toBe('blocked');
  });

  it('returns fresh for an ok page (unchanged) and due for unverified (unchanged)', () => {
    expect(
      classify({ verifyStatus: 'ok', verifiedAt: daysAgo(1) }, NOW),
    ).toBe('fresh');
    expect(
      classify({ verifyStatus: 'unverified' }, NOW),
    ).toBe('due');
  });
});

describe('blocked backoff curve', () => {
  it('grows exponentially from the base and caps at the max', () => {
    expect(blockedBackoffMs(0)).toBe(1 * DAY_MS);
    expect(blockedBackoffMs(1)).toBe(2 * DAY_MS);
    expect(blockedBackoffMs(2)).toBe(4 * DAY_MS);
    expect(blockedBackoffMs(10)).toBe(BLOCKED_MAX_BACKOFF_MS);
  });

  it('clamps negative and non-numeric failure counts to the base', () => {
    expect(blockedBackoffMs(-5)).toBe(BLOCKED_BASE_BACKOFF_MS);
    expect(blockedBackoffMs(Number.NaN)).toBe(BLOCKED_BASE_BACKOFF_MS);
  });
});

describe('nextCheckAt under an injected clock', () => {
  it('targets the end of the fresh window for a fresh page', () => {
    const verifiedAt = daysAgo(1);
    const page: RegistryPageState = {
      verifyStatus: 'ok',
      verifiedAt,
      failureCount: 0,
    };
    expect(nextCheckAt(page, NOW).getTime()).toBe(
      verifiedAt.getTime() + FRESH_WINDOW_MS,
    );
  });

  it('targets now for stale and due pages', () => {
    const stale: RegistryPageState = {
      verifyStatus: 'ok',
      verifiedAt: daysAgo(10),
      failureCount: 0,
    };
    const due: RegistryPageState = {
      verifyStatus: 'unverified',
      failureCount: 0,
    };
    expect(nextCheckAt(stale, NOW).getTime()).toBe(NOW.getTime());
    expect(nextCheckAt(due, NOW).getTime()).toBe(NOW.getTime());
  });

  it('places a blocked page further out than a stale page', () => {
    const stale: RegistryPageState = {
      verifyStatus: 'ok',
      verifiedAt: daysAgo(10),
      lastCheckedAt: daysAgo(10),
      failureCount: 0,
    };
    const blocked: RegistryPageState = {
      verifyStatus: 'blocked',
      verifiedAt: daysAgo(10),
      lastCheckedAt: daysAgo(1),
      failureCount: 1,
    };
    expect(nextCheckAt(blocked, NOW).getTime()).toBeGreaterThan(
      nextCheckAt(stale, NOW).getTime(),
    );
  });

  it('pushes a blocked page further out as failures grow, up to the cap', () => {
    const at = (failures: number) =>
      nextCheckAt(
        {
          verifyStatus: 'blocked',
          lastCheckedAt: daysAgo(1),
          failureCount: failures,
        },
        NOW,
      ).getTime();
    expect(at(1)).toBeGreaterThan(at(0));
    expect(at(3)).toBeGreaterThan(at(1));
    expect(at(10)).toBe(NOW.getTime() + BLOCKED_MAX_BACKOFF_MS);
  });

  it('keeps a long-overdue blocked page in the future', () => {
    const page: RegistryPageState = {
      verifyStatus: 'blocked',
      lastCheckedAt: daysAgo(60),
      failureCount: 0,
    };
    expect(nextCheckAt(page, NOW).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('failure-status backoff (T903 dead-branch repair)', () => {
  // Regression cases the contract pins:
  //   { verifyStatus:'http_error', verifiedAt:null, lastCheckedAt:NOW }
  //     -> classify = 'due', nextCheckAt ~= NOW + 1 day
  //   failureCount: 3 -> about 8 days
  //   failureCount: 99 -> capped at 30 days

  it('classifies a just-failed page as due (not fresh)', () => {
    const page: RegistryPageState = {
      verifyStatus: 'http_error',
      verifiedAt: null,
      lastCheckedAt: NOW,
      failureCount: 0,
    };
    expect(classify(page, NOW)).toBe('due');
  });

  it('targets roughly NOW + 1 day for a fresh failure with zero prior failures', () => {
    const page: RegistryPageState = {
      verifyStatus: 'http_error',
      verifiedAt: null,
      lastCheckedAt: NOW,
      failureCount: 0,
    };
    const target = nextCheckAt(page, NOW).getTime();
    expect(target).toBeGreaterThanOrEqual(NOW.getTime() + 23 * 60 * 60 * 1000);
    expect(target).toBeLessThanOrEqual(NOW.getTime() + 25 * 60 * 60 * 1000);
  });

  it('targets roughly NOW + 8 days for failureCount = 3', () => {
    const page: RegistryPageState = {
      verifyStatus: 'http_error',
      verifiedAt: null,
      lastCheckedAt: NOW,
      failureCount: 3,
    };
    const target = nextCheckAt(page, NOW).getTime();
    expect(target).toBeGreaterThanOrEqual(NOW.getTime() + 7 * DAY_MS);
    expect(target).toBeLessThanOrEqual(NOW.getTime() + 9 * DAY_MS);
  });

  it('caps the failure target at NOW + 30 days even for failureCount = 99', () => {
    const page: RegistryPageState = {
      verifyStatus: 'http_error',
      verifiedAt: null,
      lastCheckedAt: NOW,
      failureCount: 99,
    };
    const target = nextCheckAt(page, NOW).getTime();
    expect(target).toBe(NOW.getTime() + BLOCKED_MAX_BACKOFF_MS);
  });

  it('never returns a target earlier than now + backoff, even with a stale anchor', () => {
    // lastCheckedAt long ago - the "never earlier than now + backoff" guard
    // must keep the result in the future under the failure branch too.
    const page: RegistryPageState = {
      verifyStatus: 'timeout',
      verifiedAt: null,
      lastCheckedAt: daysAgo(60),
      failureCount: 0,
    };
    const target = nextCheckAt(page, NOW).getTime();
    expect(target).toBeGreaterThanOrEqual(NOW.getTime() + DAY_MS);
  });

  it('treats all four failure statuses with the same schedule', () => {
    const at = (status: 'http_error' | 'timeout' | 'invalid') =>
      nextCheckAt(
        {
          verifyStatus: status,
          verifiedAt: null,
          lastCheckedAt: NOW,
          failureCount: 0,
        },
        NOW,
      ).getTime();
    expect(at('http_error')).toBe(at('timeout'));
    expect(at('timeout')).toBe(at('invalid'));
  });
});