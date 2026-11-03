// Pure registry staleness policy (ADR-026 decisions 3 + 4).
//
// ADR-026 defines the verifyStatus vocabulary, the meaning of `blocked`
// ("stop probing this for a while", not "dead"), and delegates the
// fresh/stale/recheck thresholds plus the backoff curve to this module. It
// specifies no numeric schedule, so the schedule below is defined here as
// named exported constants shared by wave 8 and the tests: verified-ok
// pages stay `fresh` for 7 days, go `stale` until 30 days, then are `due`;
// failure pages (and `blocked`) back off exponentially from 1 day capped at
// 30 days. `now` is always injected - this module never reads the clock.
//
// NO PRISMA, NO ROUTES, NO I/O.
//
// CLASSIFY vs NEXT-CHECK-AT ASYMMETRY (T903):
//   `classify` DESCRIBES state. A failure page is `due` - the next probe
//   is owed. A `blocked` page is `blocked` - that state is independent of
//   the work-queue.
//   `nextCheckAt` produces the SCHEDULE TARGET. For both `blocked` and
//   failure statuses it returns now + the growing backoff curve, so a
//   permanently dead page cannot hot-loop the admin crawlBatch queue
//   (which selects on `nextCheckAt <= now` and would otherwise pick it up
//   on every call). The shared curve is exposed as `failureBackoffMs`
//   (the same function as `blockedBackoffMs`) so the asymmetry is visible
//   in callers and tests.

export const FRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const BLOCKED_BASE_BACKOFF_MS = 1 * 24 * 60 * 60 * 1000;
export const BLOCKED_MAX_BACKOFF_MS = 30 * 24 * 60 * 60 * 1000;

// Re-export the canonical VerifyStatus type + helpers so consumers that
// imported them from this module still work. The single definition lives
// in ./verifyStatus.ts (T903).
export {
  REGISTRY_FAILURE_STATUSES,
  type RegistryFailureStatus,
  type VerifyStatus,
  isFailureStatus,
  isSuccessStatus,
  isVerifyStatus,
} from './verifyStatus.js';

import { isFailureStatus } from './verifyStatus.js';

export type PageFreshness = 'fresh' | 'stale' | 'due' | 'blocked';

/**
 * Minimal registry-page state the policy reads. Mirrors the
 * CompanyCareerPage verification fields without importing Prisma.
 */
export interface RegistryPageState {
  verifyStatus: string;
  verifiedAt?: Date | null;
  lastCheckedAt?: Date | null;
  failureCount?: number | null;
}

function timeOrUndefined(value: Date | null | undefined): number | undefined {
  if (value instanceof Date) {
    const t = value.getTime();
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

function failureCountOf(page: RegistryPageState): number {
  const n = page.failureCount;
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/**
 * Backoff delay for a `blocked` page: BASE * 2^failures capped at MAX.
 * Pure function of the failure count; exported so wave 8 and tests share it.
 */
export function blockedBackoffMs(failureCount: number): number {
  const failures =
    typeof failureCount === 'number' && !Number.isNaN(failureCount)
      ? Math.max(0, Math.floor(failureCount))
      : 0;
  const grown = BLOCKED_BASE_BACKOFF_MS * 2 ** failures;
  return Math.min(grown, BLOCKED_MAX_BACKOFF_MS);
}

/**
 * Failure-status backoff curve: same exponential schedule as
 * `blockedBackoffMs`, by deliberate choice. Documented in the module
 * header; tests pin it as a single curve (`blockedBackoffMs` == `failureBackoffMs`).
 * Exposed under its own name so the asymmetry between `classify` (failure
 * is `due`) and `nextCheckAt` (failure uses the growing backoff) is visible
 * in call sites.
 */
export const failureBackoffMs = blockedBackoffMs;

/**
 * Classify a page under the injected `now`:
 * - `blocked` status -> 'blocked' (own backoff curve, never probed directly).
 * - failure status (blocked/http_error/timeout/invalid) -> 'due' (the next
 *   probe is owed; the schedule lives in `nextCheckAt`).
 * - never checked (no usable verifiedAt/lastCheckedAt) -> 'due'.
 * - otherwise by age of verifiedAt (falling back to lastCheckedAt):
 *   within FRESH_WINDOW -> 'fresh', within STALE_WINDOW -> 'stale', else 'due'.
 * Future timestamps clamp to age 0 ('fresh'). Unknown status strings follow
 * the age ladder. Never reads the clock.
 */
export function classify(page: RegistryPageState, now: Date): PageFreshness {
  if (page.verifyStatus === 'blocked') return 'blocked';
  if (isFailureStatus(page.verifyStatus)) return 'due';
  const reference =
    timeOrUndefined(page.verifiedAt) ?? timeOrUndefined(page.lastCheckedAt);
  if (reference === undefined) return 'due';
  const ageMs = Math.max(0, now.getTime() - reference);
  if (ageMs <= FRESH_WINDOW_MS) return 'fresh';
  if (ageMs <= STALE_WINDOW_MS) return 'stale';
  return 'due';
}

/**
 * When this page should next be checked, under the injected `now`:
 * - `blocked` OR failure status -> last probe (lastCheckedAt, else
 *   verifiedAt, else now) plus the backoff curve (shared by design - see
 *   module header), never earlier than now + the backoff curve, so the
 *   target is always in the future and grows with consecutive failures.
 *   The curve lives in `failureBackoffMs` (alias of `blockedBackoffMs`).
 * - `fresh` -> the moment it leaves the fresh window (anchor + FRESH_WINDOW).
 * - `stale` | `due` -> now (check on demand; wave 8 consumes this target).
 * Never reads the clock.
 */
export function nextCheckAt(page: RegistryPageState, now: Date): Date {
  const nowMs = now.getTime();
  if (
    page.verifyStatus === 'blocked' ||
    isFailureStatus(page.verifyStatus)
  ) {
    const anchor =
      timeOrUndefined(page.lastCheckedAt) ??
      timeOrUndefined(page.verifiedAt) ??
      nowMs;
    const backoff = failureBackoffMs(failureCountOf(page));
    return new Date(Math.max(anchor + backoff, nowMs + backoff));
  }
  if (classify(page, now) === 'fresh') {
    const anchor =
      timeOrUndefined(page.verifiedAt) ??
      timeOrUndefined(page.lastCheckedAt) ??
      nowMs;
    return new Date(anchor + FRESH_WINDOW_MS);
  }
  return new Date(nowMs);
}