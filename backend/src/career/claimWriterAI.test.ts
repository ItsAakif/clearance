// =====================================================================================
// career/claimWriterAI.test.ts - ADR-036 acceptance, one describe per acceptance item.
//
// (1) the AI writer can PHYSICALLY NOT produce a status other than inferred | contextual
//     - proved BOTH ways: a compile-time type exclusion (`@ts-expect-error`, checked by
//     `npx tsc --noEmit`, not by vitest) AND a runtime guard exercised by CASTING
//     AROUND that type, which is what untyped input (a route body, a JSON model
//     response) actually looks like.
// (2) `user_confirmed` is unreachable without a ClaimVerification row: the AI writer has
//     no status update path at all, and only career/verification.ts can write the audit
//     row. Proven by execution and by source guards.
// (3) re-observing an existing fingerprint does not change status and does not create a
//     duplicate - the write is a NO-OP, asserted on the recorded write log.
// (4) a `rejected` claim cannot be modified by claimWriterAI: an identical re-observation
//     leaves it `rejected` (no resurrection to `inferred`).
// (5) confidence is orthogonal to status: a 0.99-confidence AI claim is still `inferred`.
//
// The source guards at the bottom are the repo's existing convention (cf.
// `evaluation/pipeline.test.ts`, `discovery/hardFilters.test.ts`): the guarantee is
// structural, so it is checked structurally. `readFileSync` over the career directory
// proves that no other module under `backend/src/career/` imports the prisma singleton,
// that no non-test file names a confirming status as a STRING literal, and - since
// T1030 added the first routes over the career layer - that a route can only reach the
// claim layer through the modules that are allowed to touch it.
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ClaimProvenance, ClaimStatus } from '@prisma/client';
import {
  assertAIWritableInput,
  writeInferredClaims,
  type InferredClaimInput,
} from './claimWriterAI.js';
import { ClaimInvariantError, claimFingerprint, type CareerClaimRow } from './claims.js';
import { rejectClaim, confirmClaim } from './verification.js';
import { FakeCareerStore, fakeInferredClaim } from './careerStore.fixtures.js';

const PROFILE = 'profile-1';

function ai(overrides: Partial<InferredClaimInput> = {}): InferredClaimInput {
  return {
    kind: 'achievement',
    statement: 'Cut CI build time by 40%',
    ...overrides,
  };
}

/** The cast a route body / JSON model response would effectively perform. */
function untyped(overrides: Record<string, unknown>): InferredClaimInput {
  return overrides as unknown as InferredClaimInput;
}

// =====================================================================================
// ACCEPTANCE ITEM 1 - the writer cannot produce a status outside inferred | contextual
// =====================================================================================
describe('ACCEPTANCE 1: claimWriterAI cannot produce status != inferred|contextual', () => {
  it('writes inferred + llm_inferred for every claim by default', async () => {
    const store = new FakeCareerStore();
    const result = await writeInferredClaims(
      PROFILE,
      [ai({ statement: 'Cut CI build time by 40%' }), ai({ kind: 'skill', statement: 'TypeScript' })],
      store.asStore(),
    );
    expect(result).toEqual({ created: 2, deduped: 0 });
    for (const row of store.claimsFor(PROFILE)) {
      expect(row.status).toBe(ClaimStatus.inferred);
      expect(row.provenance).toBe(ClaimProvenance.llm_inferred);
    }
  });

  it('accepts the one other legal value, contextual, and nothing else', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai({ status: 'contextual' })], store.asStore());
    expect(store.claimsFor(PROFILE)[0].status).toBe(ClaimStatus.contextual);

    for (const forbidden of ['user_confirmed', 'rejected', 'superseded', 'inference', '']) {
      await expect(
        writeInferredClaims(
          PROFILE,
          [
            ai({ statement: `Claim ${forbidden}` }),
            untyped({ ...ai({ statement: `Claim ${forbidden}` }), status: forbidden }),
          ],
          store.asStore(),
        ),
      ).rejects.toThrow(/status must be one of inferred\|contextual/);
    }
    expect(store.claimsFor(PROFILE)).toHaveLength(1);
  });

  it('RUNTIME GUARD: a status cast past the type throws and writes nothing', async () => {
    // The type says this cannot compile; the cast simulates untyped input arriving from
    // a route body or a model's JSON. The guard is the second line of defence.
    const store = new FakeCareerStore();
    await expect(
      writeInferredClaims(
        PROFILE,
        [untyped({ kind: 'achievement', statement: 'Made up a promotion', status: 'user_confirmed' })],
        store.asStore(),
      ),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    expect(store.claims.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('RUNTIME GUARD: a non-llm provenance cannot be smuggled in either', async () => {
    const store = new FakeCareerStore();
    await expect(
      writeInferredClaims(
        PROFILE,
        [untyped({ kind: 'achievement', statement: 'x', provenance: 'user_entered' })],
        store.asStore(),
      ),
    ).rejects.toThrow(/the AI writer owns "provenance"/);
    await expect(
      writeInferredClaims(
        PROFILE,
        [untyped({ kind: 'achievement', statement: 'x', supersedesClaimId: 'clm-1' })],
        store.asStore(),
      ),
    ).rejects.toThrow(/supersedesClaimId stays unset until a user confirms/);
    expect(store.claims.size).toBe(0);
  });

  it('RUNTIME GUARD: a bad kind or an empty statement is rejected before ANY write', async () => {
    const store = new FakeCareerStore();
    await expect(
      writeInferredClaims(PROFILE, [ai(), untyped({ kind: 'not_a_kind', statement: 'y' })], store.asStore()),
    ).rejects.toThrow(/kind must be a ClaimKind/);
    // All-or-nothing: the first, perfectly valid claim was not written either.
    expect(store.claims.size).toBe(0);
    expect(store.writes).toEqual([]);

    await expect(
      writeInferredClaims(PROFILE, [ai(), untyped({ kind: 'skill', statement: '   ' })], store.asStore()),
    ).rejects.toThrow(/non-empty statement/);
    expect(store.claims.size).toBe(0);
  });

  it('validates a single input directly (for a route that wants to check first)', () => {
    expect(() => assertAIWritableInput(ai(), 0)).not.toThrow();
    expect(() => assertAIWritableInput(untyped({ kind: 'skill', statement: 'Go', status: 'superseded' }), 1)).toThrow(
      ClaimInvariantError,
    );
    expect(() => assertAIWritableInput(null, 0)).toThrow(/must be an object/);
  });

  // ---- TYPE half. Vitest cannot check types; `npx tsc --noEmit` can, and it
  // type-checks this file. If a confirming status ever becomes assignable, the
  // directives below become "unused" and tsc FAILS. That is the regression test.
  it('TYPE: InferredClaimInput cannot carry a confirming status (checked by tsc)', () => {
    const ok: InferredClaimInput = ai();
    // @ts-expect-error user_confirmed is outside AIWritableClaimStatus (ADR-036 item 2)
    const confirmed: InferredClaimInput = { ...ok, status: 'user_confirmed' };
    // @ts-expect-error rejected is outside AIWritableClaimStatus (ADR-036 item 5)
    const rejected: InferredClaimInput = { ...ok, status: 'rejected' };
    // @ts-expect-error superseded is outside AIWritableClaimStatus
    const superseded: InferredClaimInput = { ...ok, status: 'superseded' };
    // @ts-expect-error the writer hard-codes provenance; the input has no such member
    const reLabelled: InferredClaimInput = { ...ok, provenance: 'user_entered' };
    // @ts-expect-error 05 sec.2.4 - supersedesClaimId stays unset until a user confirms
    const superseding: InferredClaimInput = { ...ok, supersedesClaimId: 'clm-1' };
    expect([confirmed.status, rejected.status, superseded.status]).toEqual([
      'user_confirmed',
      'rejected',
      'superseded',
    ]);
    expect(reLabelled).toBeDefined();
    expect(superseding).toBeDefined();
  });

  it('TYPE: a bad kind does not type-check either', () => {
    // @ts-expect-error only the ClaimKind enum values are assignable
    const bad: InferredClaimInput = { kind: 'not_a_kind', statement: 'x' };
    expect(bad.kind).toBe('not_a_kind');
  });
});

// =====================================================================================
// ACCEPTANCE ITEM 2 - user_confirmed is unreachable without a ClaimVerification row
// =====================================================================================
describe('ACCEPTANCE 2: user_confirmed is unreachable without a ClaimVerification row', () => {
  it('the AI writer has no update path: re-running it writes NO audit row', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai()], store.asStore());
    await writeInferredClaims(PROFILE, [ai()], store.asStore());
    expect(store.verifications.size).toBe(0);
    expect(store.writes).toEqual(['claim.create']);
  });

  it('the AI writer can never move a claim to user_confirmed, by any spelling', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, { status: ClaimStatus.inferred });

    for (const attempt of [
      { status: 'user_confirmed' },
      { status: ClaimStatus.user_confirmed },
      { status: 'contextual' },
    ]) {
      // A confirming status is refused outright. `contextual` is a legal AI status, so
      // it is a DEDUPE (the claim already exists) - never an update of the existing row.
      const promise = writeInferredClaims(
        PROFILE,
        [untyped({ kind: claim.kind, statement: claim.statement, ...attempt })],
        store.asStore(),
      );
      if (attempt.status === 'contextual') {
        await expect(promise).resolves.toEqual({ created: 0, deduped: 1 });
      } else {
        await expect(promise).rejects.toBeInstanceOf(ClaimInvariantError);
      }
    }
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.inferred);
    expect(store.verifications.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('the confirm path writes EXACTLY ONE audit row naming the actor (the other half)', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai()], store.asStore());
    const claim = store.claimsFor(PROFILE)[0];
    expect(claim.status).toBe(ClaimStatus.inferred);

    await confirmClaim({ claimId: claim.id, actorUserId: 'user-42' }, store.asStore());

    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.user_confirmed);
    const rows = store.verificationsFor(claim.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('confirm');
    expect(rows[0].actorUserId).toBe('user-42');
  });
});

// =====================================================================================
// ACCEPTANCE ITEM 3 - re-observing a fingerprint is an idempotent no-op
// =====================================================================================
describe('ACCEPTANCE 3: re-observation creates no duplicate and changes no status', () => {
  it('counts the second observation as deduped and writes nothing at all', async () => {
    const store = new FakeCareerStore();
    const first = await writeInferredClaims(PROFILE, [ai()], store.asStore());
    expect(first).toEqual({ created: 1, deduped: 0 });
    const writesAfterFirst = [...store.writes];

    const second = await writeInferredClaims(PROFILE, [ai()], store.asStore());
    expect(second).toEqual({ created: 0, deduped: 1 });
    expect(store.claims.size).toBe(1);
    // No claim.create, no claim.update, no verification row: a pure read.
    expect(store.writes).toEqual(writesAfterFirst);
    expect(store.writes.filter((call) => call !== 'claim.findFirst')).toEqual(['claim.create']);
  });

  it('treats a differently-spelled identical statement as the same observation', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai()], store.asStore());
    const again = await writeInferredClaims(
      PROFILE,
      [ai({ statement: '  cut   CI build TIME by 40%  ' })],
      store.asStore(),
    );
    expect(again).toEqual({ created: 0, deduped: 1 });
    expect(store.claims.size).toBe(1);
    // The stored wording is the FIRST observation's, untouched by the second.
    expect(store.claimsFor(PROFILE)[0].statement).toBe('Cut CI build time by 40%');
  });

  it('never downgrades a user_confirmed claim back to inferred', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai()], store.asStore());
    const claim = store.claimsFor(PROFILE)[0];
    await confirmClaim({ claimId: claim.id, actorUserId: 'user-42' }, store.asStore());
    const confirmedAt = store.claims.get(claim.id)?.confirmedAt;
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.user_confirmed);

    // The model re-observes the same fact with a DIFFERENT, higher confidence.
    const rerun = await writeInferredClaims(
      PROFILE,
      [ai({ confidence: 0.99, producedByModel: 'gpt-x', inferenceMethod: 'jd_extract' })],
      store.asStore(),
    );
    expect(rerun).toEqual({ created: 0, deduped: 1 });
    const after = store.claims.get(claim.id) as CareerClaimRow;
    expect(after.status).toBe(ClaimStatus.user_confirmed);
    expect(after.confirmedAt).toEqual(confirmedAt);
    expect(after.producedByModel).toBeNull();
    expect(store.verificationsFor(claim.id)).toHaveLength(1);
  });

  it('re-observation does not even refresh confidence on an inferred claim', async () => {
    // ADR-036 item 4: `confidence` updates are orthogonal to `status`, and a re-run
    // writes NOTHING. Keeping the second observation a pure no-op is the simplest
    // reading that cannot be mistaken for an upgrade.
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai({ confidence: 0.2 })], store.asStore());
    await writeInferredClaims(PROFILE, [ai({ confidence: 0.95 })], store.asStore());
    expect(store.claimsFor(PROFILE)[0].confidence).toBe(0.2);
    expect(store.claimsFor(PROFILE)[0].status).toBe(ClaimStatus.inferred);
  });
});

// =====================================================================================
// ACCEPTANCE ITEM 4 - a rejected claim is out of the AI writer's reach
// =====================================================================================
describe('ACCEPTANCE 4: a rejected claim cannot be modified by claimWriterAI', () => {
  it('an identical re-observation leaves it rejected (no resurrection to inferred)', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai()], store.asStore());
    const claim = store.claimsFor(PROFILE)[0];
    await rejectClaim(
      { claimId: claim.id, actorUserId: 'user-42', reason: 'I never did this', now: new Date('2026-09-30T10:00:00Z') },
      store.asStore(),
    );
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.rejected);
    const writesAfterReject = [...store.writes];

    // The model, on its next run, "re-discovers" exactly the same claim.
    const rerun = await writeInferredClaims(PROFILE, [ai({ confidence: 0.99 })], store.asStore());
    expect(rerun).toEqual({ created: 0, deduped: 1 });
    expect(store.writes).toEqual(writesAfterReject);
    const after = store.claims.get(claim.id) as CareerClaimRow;
    expect(after.status).toBe(ClaimStatus.rejected);
    expect(after.rejectedAt).toEqual(new Date('2026-09-30T10:00:00Z'));
    expect(after.rejectedReason).toBe('I never did this');
    expect(after.confidence).not.toBe(0.99);
    expect(store.claims.size).toBe(1);
    expect(store.verificationsFor(claim.id)).toHaveLength(1);
  });

  it('a rejected claim is only recoverable through an explicit user reopen', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai()], store.asStore());
    const claim = store.claimsFor(PROFILE)[0];
    await rejectClaim({ claimId: claim.id, actorUserId: 'user-42' }, store.asStore());

    // Only a user action clears it, and it clears to `inferred`, not to confirmed.
    const { reopenClaim } = await import('./verification.js');
    const reopened = await reopenClaim({ claimId: claim.id, actorUserId: 'user-42' }, store.asStore());
    expect(reopened.claim.status).toBe(ClaimStatus.inferred);
    expect(store.verificationsFor(claim.id).map((row) => row.action)).toEqual(['reject', 'reopen']);

    // And now the AI writer still cannot resurrect it into anything on its own.
    await writeInferredClaims(PROFILE, [ai()], store.asStore());
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.inferred);
  });

  it('the writer cannot attach new metadata to a rejected claim either', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai()], store.asStore());
    const claim = store.claimsFor(PROFILE)[0];
    await rejectClaim({ claimId: claim.id, actorUserId: 'user-42' }, store.asStore());
    const before = { ...(store.claims.get(claim.id) as CareerClaimRow) };

    await writeInferredClaims(
      PROFILE,
      [
        ai({
          evidenceSourceId: 'evd-1',
          producedByModel: 'gpt-x',
          inferenceMethod: 'jd_extract',
          confidence: 0.99,
          experienceId: 'exp-1',
        }),
      ],
      store.asStore(),
    );
    expect(store.claims.get(claim.id)).toEqual(before);
  });
});

// =====================================================================================
// ACCEPTANCE ITEM 5 - confidence is orthogonal to status
// =====================================================================================
describe('ACCEPTANCE 5: a high-confidence AI claim is still inferred', () => {
  it('confidence 0.99 + producedByModel still yields inferred / llm_inferred', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(
      PROFILE,
      [ai({ confidence: 0.99, producedByModel: 'openai/gpt-x', inferenceMethod: 'career_interview' })],
      store.asStore(),
    );
    const claim = store.claimsFor(PROFILE)[0];
    expect(claim.confidence).toBe(0.99);
    expect(claim.status).toBe(ClaimStatus.inferred);
    expect(claim.provenance).toBe(ClaimProvenance.llm_inferred);
    expect(claim.confirmedAt).toBeNull();
    expect(store.verifications.size).toBe(0);
  });

  it('confidence is never written by a user action and never changes a status', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai({ confidence: 0.99 })], store.asStore());
    const claim = store.claimsFor(PROFILE)[0];
    const result = await confirmClaim({ claimId: claim.id, actorUserId: 'user-42' }, store.asStore());
    // The confirm moved status; confidence is untouched, exactly as stored.
    expect(result.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(result.claim.confidence).toBe(0.99);
  });

  it('rejects an out-of-range confidence rather than clamping it', async () => {
    const store = new FakeCareerStore();
    await expect(
      writeInferredClaims(PROFILE, [ai({ confidence: 1.4 })], store.asStore()),
    ).rejects.toThrow(/confidence must be a finite number in \[0,1\]/);
    expect(store.claims.size).toBe(0);
  });
});

// =====================================================================================
// Structure of the write itself
// =====================================================================================
describe('writeInferredClaims contract', () => {
  it('counts created vs deduped across a mixed batch', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai({ statement: 'A' })], store.asStore());
    const result = await writeInferredClaims(
      PROFILE,
      [
        ai({ statement: 'A' }),
        ai({ statement: 'B' }),
        ai({ kind: 'skill', statement: 'C' }),
        ai({ statement: 'B' }),
      ],
      store.asStore(),
    );
    expect(result).toEqual({ created: 2, deduped: 2 });
    expect(store.claims.size).toBe(3);
  });

  it('handles an empty batch and validates profileId', async () => {
    const store = new FakeCareerStore();
    expect(await writeInferredClaims(PROFILE, [], store.asStore())).toEqual({ created: 0, deduped: 0 });
    await expect(
      writeInferredClaims('', [ai()], store.asStore()),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    await expect(
      writeInferredClaims(PROFILE, 'nope' as unknown as InferredClaimInput[], store.asStore()),
    ).rejects.toThrow(/claims must be an array/);
  });

  it('hashes (kind + normalized statement), so kind is part of the identity', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai({ kind: 'skill', statement: 'Postgres' })], store.asStore());
    const again = await writeInferredClaims(
      PROFILE,
      [ai({ kind: 'technology', statement: 'Postgres' })],
      store.asStore(),
    );
    expect(again).toEqual({ created: 1, deduped: 0 });
    expect(store.claimsFor(PROFILE)[0].fingerprint).toBe(claimFingerprint('skill', 'Postgres'));
  });
});

// =====================================================================================
// SOURCE GUARDS - the invariant is structural, so it is checked structurally
// =====================================================================================
const HERE = __dirname;
const SRC = path.resolve(HERE, '..');
const CAREER_DIR = HERE;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('source guards (no machine path to a confirming status exists)', () => {
  it('no module under backend/src/career imports the prisma singleton', () => {
    for (const file of walk(CAREER_DIR)) {
      const source = readFileSync(file, 'utf8');
      expect(source, path.basename(file)).not.toMatch(/from '\.\.\/lib\/prisma/);
    }
  });

  it('nothing OUTSIDE backend/src/career mentions a confirming status at all', () => {
    // The career layer owns the claim status vocabulary. Any other module needing to
    // name `user_confirmed` (a pre-render gate, a report) has to import it from here
    // rather than hard-code it - so this guard fails the moment a second writer grows.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.startsWith(CAREER_DIR)) continue;
      const source = readFileSync(file, 'utf8');
      if (/ClaimStatus\.|user_confirmed/.test(source)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  it('only career/verification.ts WRITES a confirming status', () => {
    // `claims.ts` may READ `ClaimStatus.user_confirmed` (it refuses to re-word a
    // confirmed claim); it may never appear in a write payload. A write looks like
    // `status: ClaimStatus.user_confirmed` or `status: 'user_confirmed'`.
    const writers = walk(CAREER_DIR)
      .filter((file) => !file.endsWith('verification.ts'))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return (
          /status:\s*ClaimStatus\.user_confirmed/.test(source) ||
          /status:\s*'user_confirmed'/.test(source) ||
          /status:\s*"user_confirmed"/.test(source)
        );
      })
      .map((file) => path.relative(CAREER_DIR, file));
    expect(writers).toEqual([]);
  });

  it('the AI writer names only the two AI statuses, and evidence names none', () => {
    const aiStatuses = [
      ...readFileSync(path.join(CAREER_DIR, 'claimWriterAI.ts'), 'utf8').matchAll(/ClaimStatus\.([a-z_]+)/g),
    ].map((match) => match[1]);
    expect(aiStatuses.length).toBeGreaterThan(0);
    for (const status of aiStatuses) {
      expect(['inferred', 'contextual'], `claimWriterAI -> ${status}`).toContain(status);
    }

    // evidence.ts never touches a claim status at all: an evidence source is where a
    // claim came FROM, never what the claim is.
    const evidenceStatuses = [
      ...readFileSync(path.join(CAREER_DIR, 'evidence.ts'), 'utf8').matchAll(/ClaimStatus\.[a-z_]+/g),
    ];
    expect(evidenceStatuses).toEqual([]);
  });

  it('a route can only reach the career layer through the modules allowed to touch it', () => {
    // T1030 added the first route over the career layer (`routes/resumes.ts`), so the
    // old "no route references the career layer" guard is replaced rather than deleted.
    // The invariant it was standing in for is STRICTER now, not looser: a route may
    // import the claim layer, but ONLY the modules that are allowed to touch it. In
    // particular it may never import `claimWriterAI` (the only AI write path) or
    // `verification` (the only status writer) - a route that could call either could
    // write a claim or confirm one from an HTTP body, which is precisely what ADR-036
    // item 2 forbids.
    const routesDir = path.join(SRC, 'routes');
    const forbidden = new Set(['claimWriterAI.js', 'verification.js']);
    const offenders: string[] = [];
    for (const file of walk(routesDir)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from '\.\.\/career\/([^']+)'/g)) {
        if (forbidden.has(match[1])) offenders.push(`${path.relative(SRC, file)} -> ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
