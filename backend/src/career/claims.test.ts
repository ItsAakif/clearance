// =====================================================================================
// career/claims.test.ts - fingerprint identity, dedupe, and the "never a status" guard
// (T1011; ADR-036 items 1-4).
//
// Acceptance coverage in this file:
//   item 2 - a `status` written outside `career/verification.ts` is impossible: the
//            patch type has no `status` (compile-time, `@ts-expect-error` below) and
//            `updateClaimAttributes` THROWS at runtime when one is cast in.
//   item 3 - the fingerprint dedupe that makes re-observation idempotent.
//   item 5 - `confidence` is producer metadata and never touches `status`.
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { ClaimProvenance, ClaimStatus } from '@prisma/client';
import {
  AI_WRITABLE_CLAIM_STATUSES,
  ClaimInvariantError,
  ClaimNotFoundError,
  assertAIWritableClaimStatus,
  claimFingerprint,
  createClaim,
  findClaimByFingerprint,
  getClaimById,
  listClaims,
  normalizeStatement,
  requireClaimById,
  updateClaimAttributes,
  updateClaimStatement,
  type AIWritableClaimStatus,
  type ClaimAttributePatch,
  type ClaimCreateInput,
} from './claims.js';
import { FakeCareerStore, fakeInferredClaim } from './careerStore.fixtures.js';

const PROFILE = 'profile-1';

function aiInput(overrides: Partial<ClaimCreateInput> = {}): ClaimCreateInput {
  return {
    profileId: PROFILE,
    kind: 'achievement',
    statement: 'Cut CI build time by 40%',
    provenance: ClaimProvenance.llm_inferred,
    ...overrides,
  };
}

describe('fingerprint identity', () => {
  it('is stable across case, unicode form and whitespace', () => {
    const a = claimFingerprint('achievement', 'Cut CI build time by 40%');
    const b = claimFingerprint('achievement', '  cut   CI build time by 40%  ');
    const c = claimFingerprint('achievement', 'CUT ci BUILD time by 40%');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates kind from statement, so the two can never be confused', () => {
    expect(claimFingerprint('skill', 'a')).not.toBe(claimFingerprint('domain', 'a'));
  });

  it('normalizes NFKC, collapses whitespace and trims - and nothing else', () => {
    expect(normalizeStatement('  Led\n\tthe   TEAM  ')).toBe('led the team');
    // Fullwidth letters fold to ASCII (NFKC); punctuation is deliberately preserved.
    expect(normalizeStatement('Ｔｅａｍ　lead')).toBe('team lead');
    expect(normalizeStatement('Managed a team.')).toBe('managed a team.');
  });

  it('refuses to hash an empty statement', () => {
    expect(() => claimFingerprint('skill', '   ')).toThrow(ClaimInvariantError);
  });
});

describe('create: the single dedupe implementation', () => {
  it('creates once and then dedupes the same fingerprint (ADR-036 item 4)', async () => {
    const store = new FakeCareerStore();
    const first = await createClaim(aiInput(), store.asStore());
    expect(first.outcome).toBe('created');

    const again = await createClaim(aiInput(), store.asStore());
    expect(again.outcome).toBe('deduped');
    expect(again.claim.id).toBe(first.claim.id);

    // Same statement, different spelling -> same identity, still one row, still NO write.
    const spelled = await createClaim(aiInput({ statement: '  CUT ci build TIME by 40% ' }), store.asStore());
    expect(spelled.outcome).toBe('deduped');
    expect(store.claims.size).toBe(1);
    expect(store.writes).toEqual(['claim.create']);
  });

  it('treats a different profile as a different identity', async () => {
    const store = new FakeCareerStore();
    await createClaim(aiInput(), store.asStore());
    const other = await createClaim(aiInput({ profileId: 'profile-2' }), store.asStore());
    expect(other.outcome).toBe('created');
    expect(store.claims.size).toBe(2);
  });

  it('defaults to inferred and honours an explicit contextual', async () => {
    const store = new FakeCareerStore();
    const inferred = await createClaim(aiInput(), store.asStore());
    expect(inferred.claim.status).toBe(ClaimStatus.inferred);
    const contextual = await createClaim(
      aiInput({ statement: 'Ran the on-call rotation', status: ClaimStatus.contextual }),
      store.asStore(),
    );
    expect(contextual.claim.status).toBe(ClaimStatus.contextual);
  });

  it('only ever writes an AI-writable status, even when one is cast in', async () => {
    const store = new FakeCareerStore();
    // The cast is on the ARGUMENT, so it stands in for untyped input (a route body or
    // a JSON model response) rather than for a call-site mistake.
    const confirmed = aiInput({ status: 'user_confirmed' } as unknown as Partial<ClaimCreateInput>);
    const rejected = aiInput({ status: 'rejected' } as unknown as Partial<ClaimCreateInput>);
    const superseded = aiInput({ status: 'superseded' } as unknown as Partial<ClaimCreateInput>);
    await expect(createClaim(confirmed, store.asStore())).rejects.toThrow(
      /status must be one of inferred\|contextual/,
    );
    await expect(createClaim(rejected, store.asStore())).rejects.toBeInstanceOf(ClaimInvariantError);
    await expect(createClaim(superseded, store.asStore())).rejects.toBeInstanceOf(ClaimInvariantError);
    expect(store.claims.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('refuses a bad kind, an empty statement, an out-of-range confidence and two entities', async () => {
    const store = new FakeCareerStore();
    await expect(
      createClaim(aiInput({ kind: 'not_a_kind' as ClaimCreateInput['kind'] }), store.asStore()),
    ).rejects.toThrow(/kind must be a ClaimKind/);
    await expect(createClaim(aiInput({ statement: '  ' }), store.asStore())).rejects.toThrow(
      /non-empty statement/,
    );
    await expect(createClaim(aiInput({ confidence: 1.5 }), store.asStore())).rejects.toThrow(
      /confidence must be a finite number in \[0,1\]/,
    );
    await expect(
      createClaim(aiInput({ experienceId: 'exp-1', projectId: 'prj-1' }), store.asStore()),
    ).rejects.toThrow(/at most one entity attachment/);
    expect(store.claims.size).toBe(0);
  });

  it('stores the caller wording but hashes the normalized form', async () => {
    const store = new FakeCareerStore();
    const result = await createClaim(aiInput({ statement: '  Cut CI build time by 40%  ' }), store.asStore());
    expect(result.claim.statement).toBe('Cut CI build time by 40%');
    expect(result.claim.fingerprint).toBe(claimFingerprint('achievement', 'Cut CI build time by 40%'));
  });
});

describe('update: the status write is unreachable (ADR-036 item 3)', () => {
  it('throws, and writes nothing, when a status is smuggled into an attribute patch', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);

    await expect(
      updateClaimAttributes(
        claim.id,
        { status: 'user_confirmed' } as unknown as ClaimAttributePatch,
        store.asStore(),
      ),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    expect(store.writes).toEqual([]);
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.inferred);
  });

  it('refuses the other reserved keys too (derived / identity columns)', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    for (const key of ['status', 'profileId', 'fingerprint', 'kind', 'id'] as const) {
      await expect(
        updateClaimAttributes(claim.id, { [key]: 'x' } as unknown as ClaimAttributePatch, store.asStore()),
      ).rejects.toBeInstanceOf(ClaimInvariantError);
    }
    expect(store.writes).toEqual([]);
  });

  it('updates ordinary attributes and leaves status alone (confidence is metadata)', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, { confidence: 0.2 });
    const updated = await updateClaimAttributes(
      claim.id,
      { confidence: 0.99, evidenceSourceId: 'evd-9' },
      store.asStore(),
    );
    expect(updated.confidence).toBe(0.99);
    expect(updated.evidenceSourceId).toBe('evd-9');
    expect(updated.status).toBe(ClaimStatus.inferred);
    expect(updated.provenance).toBe(ClaimProvenance.llm_inferred);
  });

  it('validates the confidence it is asked to store', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    await expect(
      updateClaimAttributes(claim.id, { confidence: 2 }, store.asStore()),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    expect(store.writes).toEqual([]);
  });
});

describe('updateClaimStatement', () => {
  it('moves the fingerprint with the text and never touches status', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store);
    const updated = await updateClaimStatement(claim.id, '  Cut CI build time by 55%  ', store.asStore());
    expect(updated.statement).toBe('Cut CI build time by 55%');
    expect(updated.fingerprint).toBe(claimFingerprint(claim.kind, 'Cut CI build time by 55%'));
    expect(updated.fingerprint).not.toBe(claim.fingerprint);
    expect(updated.status).toBe(ClaimStatus.inferred);
  });

  it('refuses to re-word a user_confirmed claim: that needs edit_confirm (ADR-036 item 3)', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, { status: ClaimStatus.user_confirmed });
    await expect(
      updateClaimStatement(claim.id, 'Completely different claim', store.asStore()),
    ).rejects.toThrow(/editConfirmClaim/);
    expect(store.writes).toEqual([]);
    expect(store.claims.get(claim.id)?.statement).toBe('Cut CI build time by 40%');
  });

  it('refuses a fingerprint collision with a sibling claim', async () => {
    const store = new FakeCareerStore();
    const first = await createClaim(aiInput(), store.asStore());
    const second = await createClaim(aiInput({ statement: 'Cut CI build time by 90%' }), store.asStore());
    await expect(
      updateClaimStatement(second.claim.id, 'Cut CI build time by 40%', store.asStore()),
    ).rejects.toThrow(/would collide with existing claim/);
    expect(store.claims.get(second.claim.id)?.statement).toBe('Cut CI build time by 90%');
    expect(store.claims.get(first.claim.id)?.id).toBe(first.claim.id);
  });

  it('reports a missing claim as ClaimNotFoundError', async () => {
    const store = new FakeCareerStore();
    await expect(updateClaimStatement('nope', 'Anything', store.asStore())).rejects.toBeInstanceOf(
      ClaimNotFoundError,
    );
  });
});

describe('read', () => {
  it('reads by id, by fingerprint and by list filter', async () => {
    const store = new FakeCareerStore();
    const a = await createClaim(aiInput(), store.asStore());
    const b = await createClaim(
      aiInput({ kind: 'skill', statement: 'TypeScript' }),
      store.asStore(),
    );

    expect((await getClaimById(a.claim.id, store.asStore()))?.id).toBe(a.claim.id);
    expect(await getClaimById('missing', store.asStore())).toBeNull();
    await expect(requireClaimById('missing', store.asStore())).rejects.toBeInstanceOf(ClaimNotFoundError);

    const byFingerprint = await findClaimByFingerprint(
      PROFILE,
      'skill',
      'typescript',
      store.asStore(),
    );
    expect(byFingerprint?.id).toBe(b.claim.id);

    const all = await listClaims({ profileId: PROFILE }, store.asStore());
    expect(all).toHaveLength(2);
    const skills = await listClaims({ profileId: PROFILE, kind: 'skill' }, store.asStore());
    expect(skills.map((row) => row.id)).toEqual([b.claim.id]);
    const confirmed = await listClaims(
      { profileId: PROFILE, statuses: [ClaimStatus.user_confirmed, ClaimStatus.rejected] },
      store.asStore(),
    );
    expect(confirmed).toEqual([]);
  });

  it('caps the page size and validates its arguments', async () => {
    const store = new FakeCareerStore();
    await createClaim(aiInput(), store.asStore());
    expect(await listClaims({ profileId: PROFILE, limit: 10_000 }, store.asStore())).toHaveLength(1);
    await expect(
      listClaims({ profileId: '' }, store.asStore()),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    await expect(
      listClaims({ profileId: PROFILE, kind: 'nope' as 'skill' }, store.asStore()),
    ).rejects.toThrow(/kind must be a ClaimKind/);
  });
});

describe('the AI-writable status vocabulary itself', () => {
  it('is exactly {inferred, contextual} and the guard rejects everything else', () => {
    expect([...AI_WRITABLE_CLAIM_STATUSES]).toEqual(['inferred', 'contextual']);
    expect(assertAIWritableClaimStatus('inferred', 'ctx')).toBe('inferred');
    expect(assertAIWritableClaimStatus('contextual', 'ctx')).toBe('contextual');
    for (const forbidden of ['user_confirmed', 'rejected', 'superseded', '', null, undefined, 3, {}]) {
      expect(() => assertAIWritableClaimStatus(forbidden, 'ctx')).toThrow(ClaimInvariantError);
    }
  });
});

// =====================================================================================
// TYPE-LEVEL half of the guard. Vitest cannot check types, so these cases are proved by
// the OTHER half of the T1011 gate: `npx tsc --noEmit` type-checks this file too. If a
// `status` member ever reappears on a write type, the `@ts-expect-error` below becomes
// an "unused directive" and tsc FAILS. That is the regression test for acceptance item
// 1 and item 2 (type half); the runtime half is in the describe blocks above.
// =====================================================================================
describe('type-level: a status member cannot reappear on a write type', () => {
  it('ClaimCreateInput.status only admits inferred | contextual', () => {
    const inferred: ClaimCreateInput = {
      profileId: PROFILE,
      kind: 'skill',
      statement: 'TypeScript',
      provenance: ClaimProvenance.llm_inferred,
      status: 'inferred',
    };
    const contextual: ClaimCreateInput = { ...inferred, status: 'contextual' };
    // @ts-expect-error `user_confirmed` is not an AIWritableClaimStatus (ADR-036)
    const confirmed: ClaimCreateInput = { ...inferred, status: 'user_confirmed' };
    // @ts-expect-error `rejected` is not an AIWritableClaimStatus (ADR-036 item 5)
    const rejected: ClaimCreateInput = { ...inferred, status: 'rejected' };
    expect([inferred.status, contextual.status, confirmed.status, rejected.status]).toEqual([
      'inferred',
      'contextual',
      'user_confirmed',
      'rejected',
    ]);
  });

  it('AIWritableClaimStatus is a two-member union', () => {
    // @ts-expect-error the confirming status is outside the union
    const confirmed: AIWritableClaimStatus = 'user_confirmed';
    // @ts-expect-error the terminal status is outside the union
    const rejected: AIWritableClaimStatus = 'rejected';
    expect([confirmed, rejected]).toEqual(['user_confirmed', 'rejected']);
  });

  it('ClaimAttributePatch has no status member at all', () => {
    const patch: ClaimAttributePatch = {
      // @ts-expect-error status is owned exclusively by career/verification.ts
      status: 'user_confirmed',
    };
    expect(patch).toEqual({ status: 'user_confirmed' });
  });
});
