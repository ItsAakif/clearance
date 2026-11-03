// career/claimCounts.test.ts - the counter's CLASSIFICATION contract (T1020, fix round 2
// finding F3).
//
// WHY THIS FILE EXISTS, and why it is not a copy of the counter tests in
// `routes/career.test.ts`. Those prove the tally over HTTP - that a `groupBy` result
// reaches the response as the right numbers, on a real route, with a real mock store.
// That is an END-TO-END property and it cannot see the failure mode this file is about.
//
// The failure mode is CLASSIFICATION DRIFT. `UNCONFIRMED_CLAIM_STATUSES` is a positive
// list, chosen over the negated "everything that is not confirmed and not rejected"
// because a negated test is wrong the moment the enum grows. But a positive list rots the
// other way: a status added to `ClaimStatus` and not added here would fall silently into
// "already decided", drop out of the counter, and make the number wrong with NOTHING
// failing. The module docstring cited an exhaustiveness guard in this file for exactly
// that reason, and the file did not exist. It does now.
//
// The guards here are deliberately NOT tautological. `decidedClaimStatuses()` derives the
// decided set, which would make "the three sets partition the enum" true by construction -
// so instead the DECIDED SET IS PINNED BY NAME (`rejected|superseded`). A new enum member
// moves it, and the assertion fails. That is the whole point of the file.

import { describe, it, expect, vi } from 'vitest';
import { ClaimStatus } from '@prisma/client';
import { CLAIM_STATUSES, RENDERABLE_CLAIM_STATUSES } from './claimUsage.js';
import {
  UNCONFIRMED_CLAIM_STATUSES,
  RENDERABLE_COUNT_STATUSES,
  careerClaimCountsFromRows,
  decidedClaimStatuses,
  emptyCareerClaimCounts,
  isUnconfirmedStatus,
  readCareerClaimCounts,
} from './claimCounts.js';

/** Every status the database can hold, straight from the generated enum. */
const ALL_STATUSES: readonly ClaimStatus[] = Object.values(ClaimStatus);

describe('claimCounts - the count map covers every ClaimStatus', () => {
  it('has a numeric key for every status in the enum, and nothing else', () => {
    // A new `ClaimStatus` member must appear in the zeroed counter without anyone
    // remembering to add a field. `emptyCareerClaimCounts` walks `CLAIM_STATUSES`, and
    // this assertion is what notices if that walk and the enum ever stop agreeing.
    const counts = emptyCareerClaimCounts();
    const keys = Object.keys(counts).filter((key) => key !== 'total' && key !== 'unconfirmed');
    expect([...keys].sort()).toEqual([...ALL_STATUSES].sort());
    expect(CLAIM_STATUSES).toEqual(ALL_STATUSES);
  });

  it('reports a finite, non-negative number for every status, never undefined', () => {
    const counts = emptyCareerClaimCounts();
    for (const status of ALL_STATUSES) {
      expect(typeof counts[status], `${status} is not a number`).toBe('number');
      expect(Number.isFinite(counts[status])).toBe(true);
      expect(counts[status]).toBeGreaterThanOrEqual(0);
    }
    expect(counts.total).toBe(0);
    expect(counts.unconfirmed).toBe(0);
  });
});

describe('claimCounts - the three-way classification is EXHAUSTIVE (the F3 guard)', () => {
  it('every status is renderable, awaiting a decision, or ALREADY DECIDED - and the decided set is exactly rejected|superseded', () => {
    // The load-bearing assertion. A new `ClaimStatus` member that nobody classified lands
    // in `decidedClaimStatuses()` by elimination, and this pinned expectation fails - so
    // "a new status silently stopped counting as unconfirmed" can never reach a build
    // green.
    expect([...decidedClaimStatuses()].sort()).toEqual([ClaimStatus.rejected, ClaimStatus.superseded].sort());
  });

  it('the renderable and awaiting-a-decision sets do not overlap', () => {
    // The pre-render belt treats `RENDERABLE_CLAIM_STATUSES` as the safe set, so a status
    // in both would be counted as "work to do" while a render treats it as done. The two
    // answers have to be exclusive.
    for (const status of RENDERABLE_CLAIM_STATUSES) {
      expect(UNCONFIRMED_CLAIM_STATUSES).not.toContain(status);
    }
  });

  it('pins the awaiting-a-decision set to inferred|contextual, by name', () => {
    // Spelled out rather than derived, so editing the constant without agreeing about the
    // rule is a visible test change.
    expect([...UNCONFIRMED_CLAIM_STATUSES].sort()).toEqual(
      [ClaimStatus.inferred, ClaimStatus.contextual].sort(),
    );
  });

  it('re-exports the BELT renderable set rather than restating it', () => {
    // If this ever stops being the same array of statuses the pre-render gate accepts, the
    // counter and the gate are answering different questions about the same claim.
    expect([...RENDERABLE_COUNT_STATUSES]).toEqual([ClaimStatus.user_confirmed]);
  });

  it('isUnconfirmedStatus agrees with the list for every status', () => {
    for (const status of ALL_STATUSES) {
      expect(isUnconfirmedStatus(status), status).toBe(
        UNCONFIRMED_CLAIM_STATUSES.includes(status),
      );
    }
  });
});

describe('claimCounts - a status this build does not know fails CLOSED, not open', () => {
  it('an unrecognised status lands in total and in NO other field', () => {
    // The two directions of "unknown" have opposite safe answers, and this pins both:
    //  - a KNOWN status the counter has not been told about must not be invented;
    //  - an UNKNOWN status must not become work-to-do, because "treat it as unconfirmed"
    //    would inflate the number the user is working towards with rows nobody can act on.
    const counts = careerClaimCountsFromRows([
      { status: ClaimStatus.inferred, _count: { _all: 3 } },
      { status: 'from_the_future' as ClaimStatus, _count: { _all: 5 } },
    ]);
    expect(counts.inferred).toBe(3);
    expect(counts.unconfirmed).toBe(3);
    // Counted, so `total` stays the honest number of rows on the wire - but invisible to
    // the counter, and reported in no status field.
    expect(counts.total).toBe(8);
    expect(Object.values(counts).filter((value) => value === 5)).toEqual([]);
  });

  it('skips a malformed row instead of throwing', () => {
    const counts = careerClaimCountsFromRows([
      null as never,
      { status: ClaimStatus.rejected, _count: { _all: 2 } },
      { status: ClaimStatus.inferred, _count: {} as never },
    ]);
    expect(counts.rejected).toBe(2);
    expect(counts.inferred).toBe(0);
    expect(counts.total).toBe(2);
  });
});

describe('readCareerClaimCounts - the store seam', () => {
  it('asks for one grouped query over the profile and tallies the result', async () => {
    // The store is a narrow fake, not Prisma: this is the query's SHAPE (grouped by
    // status, scoped to the profile, counted in one round trip), which is what keeps the
    // counter O(1) queries instead of one per status.
    const groupBy = vi.fn(async (_args: unknown) => [
      { status: ClaimStatus.inferred, _count: { _all: 7 } },
      { status: ClaimStatus.user_confirmed, _count: { _all: 3 } },
    ]);
    const counts = await readCareerClaimCounts('profile-1', {
      careerClaim: { groupBy: groupBy as never },
    });

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy.mock.calls[0]?.[0]).toMatchObject({
      by: ['status'],
      where: { profileId: 'profile-1' },
      _count: { _all: true },
    });
    expect(counts.inferred).toBe(7);
    expect(counts.user_confirmed).toBe(3);
    expect(counts.unconfirmed).toBe(7);
    expect(counts.total).toBe(10);
  });

  it('refuses an empty profileId rather than counting the whole table', async () => {
    const groupBy = vi.fn(async (_args: unknown) => []);
    await expect(
      readCareerClaimCounts('', { careerClaim: { groupBy: groupBy as never } }),
    ).rejects.toThrow(/non-empty profileId/);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
