// =====================================================================================
// career/claimCounts.ts - who owns the claim-count shape and the "still to confirm" rule
// (T1020).
//
// WHY THIS IS A CAREER-LAYER MODULE AND NOT ROUTE GLUE. The claim status vocabulary
// belongs to this directory, and `career/claimWriterAI.test.ts` enforces that with a
// source guard: nothing outside `backend/src/career/` may name a confirming status, so a
// second writer cannot grow unnoticed. A route that tallies statuses, or that answers
// "how much is left for me to confirm", would have to spell that vocabulary - which is
// precisely the thing the guard exists to prevent. So the counting rule lives HERE, where
// the vocabulary is already owned, and `routes/career.ts` reads the result without ever
// naming a status.
//
// The counter is DERIVED, never stored. Nothing in the schema holds it, so it cannot
// drift from the rows it describes, and a claim whose status was changed by any path at
// all is counted by this rule immediately - including a path a future task adds.
//
// The DB seam is INJECTED, like every other module in this directory: no module under
// `backend/src/career/` imports the `prisma` singleton.
// =====================================================================================

import { ClaimStatus } from '@prisma/client';
import { CLAIM_STATUSES, RENDERABLE_CLAIM_STATUSES } from './claimUsage.js';

/**
 * Counts for every status, plus `total` and `unconfirmed`.
 *
 * `Record<ClaimStatus, number>` rather than five hand-written fields: the shape is
 * derived from the enum, so a status added to the schema is counted by construction
 * instead of being a field somebody has to remember to add. Every key is always present
 * and always a number, so a client reads `counts.<status>` without a `?? 0` and an
 * absent key can never be mistaken for a missing count.
 */
export type CareerClaimCounts = Record<ClaimStatus, number> & {
  total: number;
  /**
   * Claims AWAITING THE USER'S DECISION: `inferred + contextual`.
   *
   * The definition is the acceptance criterion for the counter, and it is a POSITIVE
   * list for a reason. The obvious alternative - "everything that is not confirmed and
   * not rejected" - is a negated test over the enum: a status added later would silently
   * appear in the counter as work to do, and a brand-new terminal status would too. A
   * positive list fails closed in the other direction, and the exhaustiveness guard in
   * `claimCounts.test.ts` ("every status is renderable, awaiting a decision, or already
   * decided, and the decided set is exactly rejected|superseded") is what stops it going
   * stale instead of quietly wrong.
   *
   * `rejected` is excluded because the user has ALREADY decided about that claim -
   * counting it would make the number go UP as a result of acting on it, and a counter
   * that rises when you act is not a counter anyone can act on. `superseded` is excluded
   * because it is not the live text any more. Both are reported in their own fields, so
   * no status is hidden by the exclusion. (The tally itself is proved over HTTP by
   * `routes/career.test.ts`; this module's contract is proved here.)
   */
  unconfirmed: number;
};

/** The statuses a claim is in while the user still owns a decision about it. */
export const UNCONFIRMED_CLAIM_STATUSES: readonly ClaimStatus[] = [
  ClaimStatus.inferred,
  ClaimStatus.contextual,
];

/** A zeroed counter of the full shape. Never a partial one. */
export function emptyCareerClaimCounts(): CareerClaimCounts {
  const counts = { total: 0, unconfirmed: 0 } as CareerClaimCounts;
  for (const status of CLAIM_STATUSES) counts[status] = 0;
  return counts;
}

/**
 * One tally row. Accepts both Prisma `groupBy` shapes (`_count: { _all }`) and a plain
 * `{ count }`, so a caller - or a test - does not have to know which one it got, and a
 * shape change in Prisma cannot silently produce zeros.
 */
export type CareerClaimCountRow =
  | { status: ClaimStatus; _count: { _all: number } }
  | { status: ClaimStatus; count: number };

function rowCount(row: CareerClaimCountRow): number {
  const value =
    typeof (row as { count?: unknown }).count === 'number'
      ? (row as { count: number }).count
      : (row as { _count?: { _all?: number } })._count?._all;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Tally count rows into the counter shape. Unknown statuses (a database written by a
 * NEWER build than this one) land in `total` and nowhere else: not in the counter, and
 * not silently dropped either, so `total` stays the honest number of rows on the wire.
 */
export function careerClaimCountsFromRows(
  rows: readonly CareerClaimCountRow[] | null | undefined,
): CareerClaimCounts {
  const counts = emptyCareerClaimCounts();
  for (const row of rows ?? []) {
    if (row === null || typeof row !== 'object') continue;
    const n = rowCount(row);
    if (row.status in counts) counts[row.status] += n;
    counts.total += n;
  }
  counts.unconfirmed = UNCONFIRMED_CLAIM_STATUSES.reduce(
    (sum, status) => sum + (counts[status] ?? 0),
    0,
  );
  return counts;
}

/** Whether a claim in this status still owes the user a decision. */
export function isUnconfirmedStatus(status: ClaimStatus): boolean {
  return UNCONFIRMED_CLAIM_STATUSES.includes(status);
}

/**
 * The narrowest seam this module needs: the aggregate the count query runs through.
 * `PrismaClient` is assignable to it, and so is a fake.
 */
export interface CareerClaimCountStore {
  careerClaim: {
    groupBy(args: unknown): Promise<unknown>;
  };
}

/** Read the whole profile's counts in one grouped query, not one query per status. */
export async function readCareerClaimCounts(
  profileId: string,
  store: CareerClaimCountStore,
): Promise<CareerClaimCounts> {
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new Error('readCareerClaimCounts needs a non-empty profileId');
  }
  const rows = (await store.careerClaim.groupBy({
    by: ['status'],
    where: { profileId },
    _count: { _all: true },
  })) as CareerClaimCountRow[];
  return careerClaimCountsFromRows(rows);
}

/**
 * The statuses whose claims may enter a rendered resume - re-exported from the belt's own
 * `RENDERABLE_CLAIM_STATUSES` rather than restated, so the counter and the pre-render gate
 * can never disagree about which status is the safe one.
 *
 * It exists for ONE consumer: `claimCounts.test.ts`, which uses it to assert the three-way
 * classification (renderable / awaiting a decision / already decided) is EXHAUSTIVE. That
 * exhaustiveness is what makes `UNCONFIRMED_CLAIM_STATUSES` a safe positive list rather
 * than a list that quietly rots: a status added to the enum and forgotten here would
 * silently fall into "already decided", drop out of the counter, and make the number
 * wrong with nothing failing.
 */
export const RENDERABLE_COUNT_STATUSES = RENDERABLE_CLAIM_STATUSES;

/**
 * The statuses that are neither renderable nor awaiting a decision, i.e. the ones the
 * counter deliberately EXCLUDES from `unconfirmed`.
 *
 * DERIVED, not declared, so this cannot itself go stale; pinned BY NAME in
 * `claimCounts.test.ts`, so the derivation cannot quietly change either. A new enum member
 * lands here automatically - which is the point: the test is what turns "a new status was
 * silently unclassified" into a red build.
 */
export function decidedClaimStatuses(): ClaimStatus[] {
  return CLAIM_STATUSES.filter(
    (status) =>
      !RENDERABLE_CLAIM_STATUSES.includes(status) &&
      !UNCONFIRMED_CLAIM_STATUSES.includes(status),
  );
}
