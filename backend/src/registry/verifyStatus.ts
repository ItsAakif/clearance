// Canonical registry `verifyStatus` vocabulary (T903).
//
// Why exactly these eight:
//   The schema comment on CompanyCareerPage.verifyStatus already enumerates
//   seven states: unverified | ok | empty | blocked | http_error | timeout
//   | invalid. T903 deliberately adds `skipped` and deliberately drops the
//   older ADR-026 sentinel `'failed'` - because `'failed'` is NOT a state,
//   it is the union of the four failure kinds. Storing it as a literal would
//   either duplicate information already on the row (failureCount) or invite
//   drift between the sentinel and the real status. The canonical vocab
//   therefore separates STATE (this module) from FAILURE (`isFailureStatus`)
//   so the stale-since-failure regression cannot reappear.
//
// ORDER: VERIFY_STATUSES is the iterable over the full vocabulary, in the
// order the schema comment reads them (with `skipped` appended). The
// failure-status tuple is its own constant, ordered the same way the
// crawler writes them and the routes consume them; REGISTRY_FAILURE_STATUSES
// is VALUE-AND-ORDER FROZEN - registry.test.ts asserts it bit-for-bit.
//
// No Prisma, no routes, no I/O. Pure types + helpers.

export type VerifyStatus =
  | 'unverified'
  | 'ok'
  | 'empty'
  | 'blocked'
  | 'http_error'
  | 'timeout'
  | 'invalid'
  | 'skipped';

export const VERIFY_STATUSES: readonly VerifyStatus[] = [
  'unverified',
  'ok',
  'empty',
  'blocked',
  'http_error',
  'timeout',
  'invalid',
  'skipped',
] as const;

/**
 * VerifyStatus values the crawler writes on a transport failure. VALUE AND
 * ORDER FROZEN: `'blocked', 'http_error', 'timeout', 'invalid'`. The order
 * matches the way the schema comment lists them; registry.test.ts asserts
 * the exact array, so any change here must update that test in lockstep.
 */
export const REGISTRY_FAILURE_STATUSES = [
  'blocked',
  'http_error',
  'timeout',
  'invalid',
] as const;

export type RegistryFailureStatus = (typeof REGISTRY_FAILURE_STATUSES)[number];

const FAILURE_SET: ReadonlySet<string> = new Set(REGISTRY_FAILURE_STATUSES);

const VERIFY_STATUS_SET: ReadonlySet<string> = new Set(VERIFY_STATUSES);

const SUCCESS_VALUES: ReadonlySet<string> = new Set<VerifyStatus>(['ok', 'empty']);

/**
 * True iff the given value is one of the four failure statuses the crawler
 * actually writes. Used by staleness.classify to decide whether to park a
 * page as `due` (failure -> eligible for the next probe) under the failure
 * backoff curve (rather than `blocked`, which has its own curve and which
 * `listDue` ignores - otherwise a permanently dead page would hot-loop the
 * admin crawlBatch queue).
 */
export function isFailureStatus(s: string): s is RegistryFailureStatus {
  return FAILURE_SET.has(s);
}

/** True iff the value is a verified-success state ('ok' or 'empty'). */
export function isSuccessStatus(s: string): boolean {
  return SUCCESS_VALUES.has(s);
}

/** True iff the value is one of the eight canonical VerifyStatus values. */
export function isVerifyStatus(s: string): s is VerifyStatus {
  return VERIFY_STATUS_SET.has(s);
}