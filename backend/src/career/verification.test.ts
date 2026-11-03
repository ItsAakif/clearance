// =====================================================================================
// career/verification.test.ts - the ONLY module that may set claim status (T1011).
//
// Acceptance coverage in this file:
//   item 2 - `user_confirmed` is unreachable without a ClaimVerification row: the
//            confirm path writes EXACTLY ONE audit row with the right action and actor,
//            the status write and the audit row share one transaction (a failed audit
//            write rolls the status back), and the module exports no generic setter.
//   item 4 - a `rejected` claim is refused by every other action until an explicit
//            `reopen`, and a reopen lands on `inferred`, never on `user_confirmed`.
// Plus the transition table itself: every illegal move throws.
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { ClaimProvenance, ClaimStatus, VerificationAction } from '@prisma/client';
import * as verificationModule from './verification.js';
import {
  CLAIM_TRANSITIONS,
  ClaimVerificationError,
  confirmClaim,
  editConfirmClaim,
  listClaimVerifications,
  recordClaimEdit,
  rejectClaim,
  reopenClaim,
  type ClaimDecisionResult,
} from './verification.js';
import { claimFingerprint, type CareerClaimRow } from './claims.js';
import { FakeCareerStore, fakeInferredClaim } from './careerStore.fixtures.js';

const NOW = new Date('2026-09-30T10:00:00.000Z');
const ACTOR = 'user-1';
const PROFILE = 'profile-1';

function snapshotOf(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

async function confirmed(store: FakeCareerStore, claim: CareerClaimRow): Promise<ClaimDecisionResult> {
  return confirmClaim({ claimId: claim.id, actorUserId: ACTOR, now: NOW }, store.asStore());
}

describe('the transition table is the whole legal surface', () => {
  it('has exactly the five VerificationActions and nothing else', () => {
    expect(Object.keys(CLAIM_TRANSITIONS).sort()).toEqual(
      ['confirm', 'edit', 'edit_confirm', 'reject', 'reopen'].sort(),
    );
  });

  it('reaches user_confirmed only through confirm / edit_confirm, from unconfirmed states', () => {
    const intoConfirmed = Object.entries(CLAIM_TRANSITIONS).filter(
      ([, transition]) => transition.to === ClaimStatus.user_confirmed,
    );
    expect(intoConfirmed.map(([action]) => action).sort()).toEqual(['confirm', 'edit_confirm']);
    for (const [, transition] of intoConfirmed) {
      expect([...transition.from].sort()).toEqual(['contextual', 'inferred']);
    }
  });

  it('reaches rejected only through reject, and leaves it only through reopen -> inferred', () => {
    const intoRejected = Object.entries(CLAIM_TRANSITIONS).filter(
      ([, transition]) => transition.to === ClaimStatus.rejected,
    );
    expect(intoRejected.map(([action]) => action)).toEqual(['reject']);
    const outOfRejected = Object.entries(CLAIM_TRANSITIONS).filter(([, transition]) =>
      transition.from.includes(ClaimStatus.rejected),
    );
    expect(outOfRejected.map(([action]) => action)).toEqual(['reopen']);
    expect(CLAIM_TRANSITIONS.reopen.to).toBe(ClaimStatus.inferred);
    expect(CLAIM_TRANSITIONS.edit.to).toBeNull();
  });

  it('exports no generic status setter - only the five decisions and one read', () => {
    expect(Object.keys(verificationModule).sort()).toEqual(
      [
        'CLAIM_TRANSITIONS',
        'ClaimVerificationError',
        'DEFAULT_VERIFICATION_PAGE',
        'MAX_VERIFICATION_PAGE',
        'confirmClaim',
        'editConfirmClaim',
        'listClaimVerifications',
        'recordClaimEdit',
        'rejectClaim',
        'reopenClaim',
      ].sort(),
    );
  });
});

describe('confirm: user_confirmed requires an audit row (ADR-036 item 3)', () => {
  it('writes EXACTLY ONE ClaimVerification with action=confirm, actorUserId and target', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);

    const result = await confirmed(store, claim);

    expect(result.changed).toBe(true);
    expect(result.action).toBe(VerificationAction.confirm);
    expect(result.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(result.claim.confirmedAt).toEqual(NOW);

    const rows = store.verificationsFor(claim.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(VerificationAction.confirm);
    expect(rows[0].actorUserId).toBe(ACTOR);
    expect(rows[0].userId).toBe(ACTOR);
    expect(rows[0].targetId).toBe(claim.id);
    expect(rows[0].targetType).toBe('career_claim');
    expect(rows[0].claimId).toBe(claim.id);
    expect(store.writes).toEqual(['claim.update', 'verification.create']);
    expect(store.transactions).toBe(1);
  });

  it('records before/after so the audit explains the status change', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, { confidence: 0.4 });
    const result = await confirmed(store, claim);

    const before = snapshotOf(result.verification?.before);
    const after = snapshotOf(result.verification?.after);
    expect(before.status).toBe(ClaimStatus.inferred);
    expect(before.confirmedAt).toBeNull();
    expect(after.status).toBe(ClaimStatus.user_confirmed);
    expect(after.confirmedAt).toBe(NOW.toISOString());
    expect(after.fingerprint).toBe(claim.fingerprint);
    // confidence is recorded as metadata and is explicitly labelled as such
    expect(after.confidence).toBe(0.4);
    expect(after.confidenceIsMetadataOnly).toBe(true);
  });

  it('rolls the status back when the audit row cannot be written', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    store.failVerificationCreate = true;

    await expect(confirmed(store, claim)).rejects.toThrow(/audit row insert failed/);

    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.inferred);
    expect(store.claims.get(claim.id)?.confirmedAt).toBeNull();
    expect(store.verificationsFor(claim.id)).toHaveLength(0);
  });

  it('is idempotent: a second confirm writes no second audit row', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    const first = await confirmed(store, claim);
    const writesAfterFirst = [...store.writes];

    const second = await confirmed(store, claim);
    expect(second.changed).toBe(false);
    expect(second.verification).toBeNull();
    expect(second.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(store.verificationsFor(claim.id)).toHaveLength(1);
    expect(store.writes).toEqual(writesAfterFirst);
    expect(first.claim.confirmedAt).toEqual(NOW);
  });

  it('refuses an unknown claim and a missing actor', async () => {
    const store = new FakeCareerStore();
    await expect(
      confirmClaim({ claimId: 'nope', actorUserId: ACTOR, now: NOW }, store.asStore()),
    ).rejects.toBeInstanceOf(ClaimVerificationError);
    const claim = fakeInferredClaim(store);
    await expect(
      confirmClaim({ claimId: claim.id, actorUserId: '', now: NOW }, store.asStore()),
    ).rejects.toThrow(/actorUserId is required/);
    await expect(
      confirmClaim(
        { claimId: claim.id, actorUserId: undefined as unknown as string, now: NOW },
        store.asStore(),
      ),
    ).rejects.toThrow(/actorUserId is required/);
  });

  it('refuses to confirm a superseded claim - superseded is not a confirming state', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, { status: ClaimStatus.superseded });
    await expect(confirmed(store, claim)).rejects.toThrow(
      /cannot confirm a claim with status superseded/,
    );
    expect(store.writes).toEqual([]);
  });

  it('confirms a contextual claim too (inferred | contextual are the only sources)', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, { status: ClaimStatus.contextual });
    const result = await confirmed(store, claim);
    expect(result.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(result.verification?.action).toBe(VerificationAction.confirm);
  });
});

describe('edit_confirm: the user rewrote it and confirmed it in one gesture', () => {
  it('moves statement + fingerprint, sets user_confirmed, records action=edit_confirm', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    const nextStatement = 'Cut CI build time by 55% and shipped the migration';

    const result = await editConfirmClaim(
      { claimId: claim.id, actorUserId: ACTOR, statement: nextStatement, now: NOW },
      store.asStore(),
    );

    expect(result.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(result.claim.statement).toBe(nextStatement);
    expect(result.claim.fingerprint).toBe(claimFingerprint(claim.kind, nextStatement));
    const rows = store.verificationsFor(claim.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe(VerificationAction.edit_confirm);
    expect(rows[0].actorUserId).toBe(ACTOR);
    expect(snapshotOf(rows[0].before).statement).toBe(claim.statement);
    expect(snapshotOf(rows[0].after).statement).toBe(nextStatement);
  });

  it('refuses to edit_confirm onto a sibling claim fingerprint', async () => {
    const siblingStatement = 'Ran the on-call rotation for the payments platform';
    const store = new FakeCareerStore();
    const sibling = fakeInferredClaim(store, {
      id: 'clm-b',
      statement: siblingStatement,
      fingerprint: claimFingerprint('achievement', siblingStatement),
    });
    const claim = fakeInferredClaim(store, {
      id: 'clm-a',
      fingerprint: claimFingerprint('achievement', 'Cut CI build time by 40%'),
    });
    expect(store.claims.size).toBe(2);
    expect(sibling.fingerprint).not.toBe(claim.fingerprint);

    await expect(
      editConfirmClaim(
        {
          claimId: claim.id,
          actorUserId: ACTOR,
          statement: sibling.statement,
          now: NOW,
        },
        store.asStore(),
      ),
    ).rejects.toThrow(/would collide with existing claim/);
    expect(store.writes).toEqual([]);
  });

  it('refuses an empty replacement statement', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    await expect(
      editConfirmClaim(
        { claimId: claim.id, actorUserId: ACTOR, statement: '   ', now: NOW },
        store.asStore(),
      ),
    ).rejects.toBeInstanceOf(ClaimVerificationError);
  });
});

describe('reject and reopen (ADR-036 item 5)', () => {
  it('rejects an inferred claim and records the reason', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    const result = await rejectClaim(
      { claimId: claim.id, actorUserId: ACTOR, reason: 'not my job', now: NOW },
      store.asStore(),
    );
    expect(result.claim.status).toBe(ClaimStatus.rejected);
    expect(result.claim.rejectedAt).toEqual(NOW);
    expect(result.claim.rejectedReason).toBe('not my job');
    expect(store.verificationsFor(claim.id)).toHaveLength(1);
    expect(store.verificationsFor(claim.id)[0].action).toBe(VerificationAction.reject);
  });

  it('rejects a CONFIRMED claim, clearing confirmedAt but keeping it in the audit', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    await confirmed(store, claim);

    const result = await rejectClaim(
      { claimId: claim.id, actorUserId: ACTOR, reason: 'wrong team', now: NOW },
      store.asStore(),
    );
    expect(result.claim.status).toBe(ClaimStatus.rejected);
    expect(result.claim.confirmedAt).toBeNull();
    const rows = store.verificationsFor(claim.id);
    expect(rows).toHaveLength(2);
    const last = rows[1];
    expect(last.action).toBe(VerificationAction.reject);
    expect(snapshotOf(last.before).status).toBe(ClaimStatus.user_confirmed);
    expect(snapshotOf(last.before).confirmedAt).toBe(NOW.toISOString());
    expect(snapshotOf(last.after).status).toBe(ClaimStatus.rejected);
  });

  it('is idempotent: rejecting twice writes no second audit row', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    await rejectClaim({ claimId: claim.id, actorUserId: ACTOR, now: NOW }, store.asStore());
    const again = await rejectClaim(
      { claimId: claim.id, actorUserId: ACTOR, now: NOW },
      store.asStore(),
    );
    expect(again.changed).toBe(false);
    expect(store.verificationsFor(claim.id)).toHaveLength(1);
  });

  it('refuses to confirm a rejected claim until it is reopened', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    await rejectClaim({ claimId: claim.id, actorUserId: ACTOR, now: NOW }, store.asStore());

    await expect(confirmed(store, claim)).rejects.toThrow(/reopen it first/);
    await expect(
      editConfirmClaim(
        { claimId: claim.id, actorUserId: ACTOR, statement: 'Something else', now: NOW },
        store.asStore(),
      ),
    ).rejects.toThrow(/reopen it first/);
    await expect(
      recordClaimEdit(
        { claimId: claim.id, actorUserId: ACTOR, statement: 'Something else', now: NOW },
        store.asStore(),
      ),
    ).rejects.toThrow(/reopen it first/);
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.rejected);
    expect(store.verificationsFor(claim.id)).toHaveLength(1);
  });

  it('reopens to inferred - NOT to user_confirmed (a reopen is not a confirmation)', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    await rejectClaim({ claimId: claim.id, actorUserId: ACTOR, now: NOW }, store.asStore());

    const reopened = await reopenClaim(
      { claimId: claim.id, actorUserId: ACTOR, now: NOW },
      store.asStore(),
    );
    expect(reopened.claim.status).toBe(ClaimStatus.inferred);
    expect(reopened.claim.rejectedAt).toBeNull();
    expect(reopened.claim.rejectedReason).toBeNull();
    expect(reopened.verification?.action).toBe(VerificationAction.reopen);

    // The user must now confirm explicitly: that is the second, separate decision.
    const confirmedAfterReopen = await confirmed(store, claim);
    expect(confirmedAfterReopen.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(store.verificationsFor(claim.id).map((row) => row.action)).toEqual([
      'reject',
      'reopen',
      'confirm',
    ]);
  });

  it('refuses to reopen a claim that is not rejected', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    await expect(
      reopenClaim({ claimId: claim.id, actorUserId: ACTOR, now: NOW }, store.asStore()),
    ).rejects.toThrow(/cannot reopen a claim with status inferred/);
    expect(store.writes).toEqual([]);
  });
});

describe('edit: recorded, never confirmed (05 sec.4)', () => {
  it('re-words an unconfirmed claim, records action=edit and leaves status alone', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    const result = await recordClaimEdit(
      { claimId: claim.id, actorUserId: ACTOR, statement: 'Cut CI build time by 45%', now: NOW },
      store.asStore(),
    );
    expect(result.claim.statement).toBe('Cut CI build time by 45%');
    expect(result.claim.status).toBe(ClaimStatus.inferred);
    expect(result.claim.confirmedAt).toBeNull();
    expect(result.verification?.action).toBe(VerificationAction.edit);
    expect(store.verificationsFor(claim.id)).toHaveLength(1);
  });

  it('is a no-op when the text is unchanged', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    const result = await recordClaimEdit(
      { claimId: claim.id, actorUserId: ACTOR, statement: claim.statement, now: NOW },
      store.asStore(),
    );
    expect(result.changed).toBe(false);
    expect(store.verificationsFor(claim.id)).toHaveLength(0);
  });
});

describe('the audit trail is readable', () => {
  it('lists a claim history newest first', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    await recordClaimEdit(
      {
        claimId: claim.id,
        actorUserId: ACTOR,
        statement: 'Cut CI build time by 45%',
        now: new Date('2026-09-30T09:00:00.000Z'),
      },
      store.asStore(),
    );
    await confirmed(store, claim);
    const history = await listClaimVerifications({ claimId: claim.id }, store.asStore());
    expect(history.map((row) => row.action)).toEqual(['confirm', 'edit']);
    expect(
      await listClaimVerifications({ claimId: 'clm-none' }, store.asStore()),
    ).toEqual([]);
    await expect(listClaimVerifications({ claimId: '' }, store.asStore())).rejects.toBeInstanceOf(
      ClaimVerificationError,
    );
  });
});

describe('confidence stays metadata through every decision (acceptance item 5)', () => {
  it('a 0.99-confidence claim is still inferred until a human confirms it', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, { confidence: 0.99, provenance: ClaimProvenance.llm_inferred });
    expect(claim.status).toBe(ClaimStatus.inferred);

    const rejected = await rejectClaim(
      { claimId: claim.id, actorUserId: ACTOR, reason: 'overstated', now: NOW },
      store.asStore(),
    );
    // Even the rejection is not a judgement about confidence - it is a human decision.
    expect(rejected.claim.confidence).toBe(0.99);
    expect(rejected.claim.status).toBe(ClaimStatus.rejected);
    expect(snapshotOf(rejected.verification?.after).confidence).toBe(0.99);
  });
});
