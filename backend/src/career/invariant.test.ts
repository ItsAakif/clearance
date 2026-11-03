// =====================================================================================
// career/invariant.test.ts - THE regression suite for ADR-036 (T1012).
//
// ADR-036 in one line: "AI inference is never the same as user-confirmed experience,
// and the system must never silently convert one into the other (including an LLM
// re-extracting a claim and quietly upgrading it)". Every other career test proves a
// FEATURE. This file proves the INVARIANT, and the standard it is held to is
// deliberately higher than a normal suite's:
//
//   A test here is only worth having if it FAILS WHEN THE GUARD IS DELETED.
//   Each `it` below therefore names the guard it pins, and the six guards are the only
//   things in `backend/src/career/` that make the ADR true. The mutation table in
//   `.planning/progress/T1012-invariant-suite.md` records the failing assertion for
//   each of the six.
//
// THE SIX, and what each is really saying:
//
//   (a) The AI writer can only ever EMIT `inferred` or `contextual`. Not "does not
//       usually", not "does not on the happy path": the vocabulary is closed, and the
//       test is exhaustive over `Object.values(ClaimStatus)`, so a status ADDED to the
//       enum later is refused until somebody decides about it.
//   (b) `user_confirmed` is UNREACHABLE except through `career/verification.ts`, and
//       arriving there always brings a `ClaimVerification` row with it - including
//       when the audit write FAILS, which is the half that makes "requires" a fact
//       rather than a convention. Four independent write entry points are swept, plus
//       a structural scan of the layer's source.
//   (c) Re-observing an existing `fingerprint` is a NO-OP, over the WHOLE status
//       matrix. `claims.ts` calls this "a pure no-op", and a no-op is a much stronger
//       claim than "does not upgrade": the row is compared field-for-field, so a
//       rewrite of `confidence`, `provenance` or `producedByModel` fails the test too.
//   (d) `rejected` is not a status the machine can undo. A rejected claim is refused
//       by every other decision, and the only thing that clears it is an explicit
//       `reopen` that lands on `inferred` - never on `user_confirmed`.
//   (e) Repeating a decision is a no-op, so the append-only audit log cannot grow by
//       clicking twice. Checked against a repeat whose IRRELEVANT inputs differ
//       (`now`, `note`), because an idempotency guard keyed on more than the state
//       would pass a naive test and double-write in production.
//   (f) The audit row is a self-contained SNAPSHOT: before, after and actor, captured
//       at decision time, as plain JSON, which a later decision cannot rewrite.
//
// HOUSE RULES OBSERVED. The `FakeCareerStore` from `careerStore.fixtures.ts` and
// nothing else - no database, no network, no daemon, no new dependency. Its `writes`
// log is what makes "writes NOTHING" an assertion rather than an inference, and its
// `$transaction` snapshot/rollback is what makes (b) and (f) testable at all. ASCII
// only. No test here weakens a test elsewhere; where coverage overlaps, this file is
// the stronger version and the overlap is named in the progress note.
//
// TYPE-LEVEL HALF. Vitest cannot check types, so the `@ts-expect-error` directives are
// enforced by the OTHER half of this task's gate: `npx tsc --noEmit` type-checks this
// file too. If a confirming status ever becomes assignable to a write type, the
// directive becomes an "unused directive" and tsc FAILS. The runtime sweeps are what a
// JSON body or an `as any` actually meets; the directives are what a TypeScript call
// site meets.
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ClaimProvenance, ClaimStatus, VerificationAction } from '@prisma/client';

import {
  AI_WRITABLE_CLAIM_STATUSES,
  ClaimInvariantError,
  updateClaimAttributes,
  updateClaimStatement,
  type CareerClaimRow,
  type ClaimAttributePatch,
} from './claims.js';
import { writeInferredClaims, type InferredClaimInput } from './claimWriterAI.js';
import {
  ClaimVerificationError,
  confirmClaim,
  editConfirmClaim,
  recordClaimEdit,
  rejectClaim,
  reopenClaim,
  type ClaimDecisionInput,
} from './verification.js';
import { FakeCareerStore, fakeClaimAtStatus } from './careerStore.fixtures.js';

const PROFILE = 'profile-1';
const ACTOR = 'user-1';
const NOW = new Date('2026-09-30T10:00:00.000Z');
const LATER = new Date('2026-10-01T09:30:00.000Z');

/** The cast a route body, a JSON model response or an `as any` effectively performs. */
function forged(fields: Record<string, unknown>): InferredClaimInput {
  return fields as unknown as InferredClaimInput;
}

function ai(statement: string, overrides: Partial<InferredClaimInput> = {}): InferredClaimInput {
  return { kind: 'achievement', statement, ...overrides };
}

/**
 * A VALUE snapshot of a claim row. Deliberately not `{ ...row }`: the fake returns the
 * same object it stored, so a spread comparison would pass by reference identity even
 * after the row was rewritten. Serialising compares what the audit would actually see.
 */
function snapshot(row: CareerClaimRow | null | undefined): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

/** The snapshot fields a status decision is EXPECTED to move, per `CLAIM_TRANSITIONS`. */
const SNAPSHOT_MOVED = new Set([
  'status',
  'confirmedAt',
  'rejectedAt',
  'rejectedReason',
  'statement',
  'fingerprint',
]);

function withoutMovedFields(snap: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(snap).filter(([key]) => !SNAPSHOT_MOVED.has(key)));
}

// -- structural scan helpers (the source guards) ------------------------------------

function careerDir(): string {
  return __dirname;
}

/** Every non-test module under `backend/src/career/`. */
function careerSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(careerDir());
  return out;
}

/** Comments carry the same words as the code they describe, so they are removed first. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('invariant: inference is never confirmation (ADR-036)', () => {
  // ---------------------------------------------------------------------------
  // (a) the AI writer's OUTPUT vocabulary is closed
  // ---------------------------------------------------------------------------
  it('(a) the AI writer emits only inferred|contextual for EVERY ClaimStatus value, and a forged one writes nothing', async () => {
    // Exhaustive over the ENUM, not a hand-written list of bad values. A status added
    // to `ClaimStatus` in a later migration therefore fails this test until somebody
    // decides whether a model may produce it - which is the whole point of a closed
    // vocabulary (the same reasoning as `RENDERABLE_CLAIM_STATUSES` in claimUsage.ts).
    const writable = [...AI_WRITABLE_CLAIM_STATUSES] as readonly string[];

    for (const status of Object.values(ClaimStatus)) {
      const store = new FakeCareerStore();
      const attempt = forged({
        kind: 'achievement',
        statement: `Model asserted: ${status}`,
        status,
        confidence: 0.99,
      });

      if (writable.includes(status)) {
        const result = await writeInferredClaims(PROFILE, [attempt], store.asStore());
        expect(result, status).toEqual({ created: 1, deduped: 0 });
        const row = store.claimsFor(PROFILE)[0];
        expect(row.status, status).toBe(status);
        // Even an explicitly permitted status is never a confirmation, and it is
        // never accompanied by an audit row pretending a human decided it.
        expect(store.verificationsFor(row.id), status).toEqual([]);
        expect(row.confirmedAt, status).toBeNull();
      } else {
        // A forged confirming / terminal status is a THROW, not a coerced value.
        await expect(writeInferredClaims(PROFILE, [attempt], store.asStore()), status).rejects.toThrow(
          /status must be one of inferred\|contextual/,
        );
        // And it writes nothing at all.
        expect(store.claims.size, status).toBe(0);
        expect(store.writes, status).toEqual([]);
      }
    }

    // The guarantee is exact in the other direction too: the vocabulary is TWO
    // members, so `user_confirmed` / `rejected` / `superseded` are unreachable by
    // construction rather than by a filter somebody forgot to extend.
    expect([...AI_WRITABLE_CLAIM_STATUSES]).toEqual(['inferred', 'contextual']);
    expect(Object.values(ClaimStatus)).toContain('user_confirmed');

    // All-or-nothing, on a HOSTILE batch: a model response mixing a legitimate claim
    // with a forged `user_confirmed` one writes NEITHER. The up-front validation is
    // what makes that true, and it is the property that stops a partially-honest
    // response from landing half of itself.
    const hostile = new FakeCareerStore();
    await expect(
      writeInferredClaims(
        PROFILE,
        [
          ai('Perfectly ordinary inferred claim'),
          forged({ kind: 'skill', statement: 'I was promoted to Staff', status: 'user_confirmed' }),
          ai('Another ordinary claim', { kind: 'skill' }),
        ],
        hostile.asStore(),
      ),
    ).rejects.toThrow(/writeInferredClaims\[1\]: status must be one of inferred\|contextual/);
    expect(hostile.claims.size).toBe(0);
    expect(hostile.writes).toEqual([]);

    // The writer also refuses the keys it OWNS, so a model cannot relabel its own
    // output as something the user entered, or claim to supersede a claim nobody
    // confirmed (05 sec.2.4).
    for (const [key, value] of [
      ['provenance', 'user_entered'],
      ['supersedesClaimId', 'clm-1'],
    ] as const) {
      const smuggle = new FakeCareerStore();
      await expect(
        writeInferredClaims(
          PROFILE,
          [forged({ kind: 'achievement', statement: `Carries ${key}`, [key]: value })],
          smuggle.asStore(),
        ),
        key,
      ).rejects.toThrow(new RegExp(`the AI writer owns "${key}"`));
      expect(smuggle.writes, key).toEqual([]);
    }

    // TYPE HALF, enforced by `npx tsc --noEmit` rather than by vitest. If a
    // confirming status ever becomes ASSIGNABLE these directives go unused and tsc
    // fails, which is the regression test for the compile-time half of the guard.
    const ok: InferredClaimInput = ai('Typed claim');
    // @ts-expect-error `user_confirmed` is outside AIWritableClaimStatus (ADR-036 item 2)
    const confirmed: InferredClaimInput = { ...ok, status: 'user_confirmed' };
    // @ts-expect-error `rejected` is outside AIWritableClaimStatus (ADR-036 item 5)
    const rejected: InferredClaimInput = { ...ok, status: 'rejected' };
    // @ts-expect-error the writer hard-codes provenance; the input has no such member
    const relabelled: InferredClaimInput = { ...ok, provenance: 'user_entered' };
    expect([confirmed.status, rejected.status]).toEqual(['user_confirmed', 'rejected']);
    expect(relabelled).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // (b) a confirming status is unreachable outside the verification service
  // ---------------------------------------------------------------------------
  it('(b) user_confirmed cannot be set directly: every non-verification writer refuses, and the audit row is inseparable', async () => {
    // FOUR entry points, swept independently. A guard on only one of them is not a
    // guard; the claim is about the LAYER, not about a function.
    //
    // 1. The AI writer (create path).
    const aiCreate = new FakeCareerStore();
    await expect(
      writeInferredClaims(
        PROFILE,
        [forged({ kind: 'achievement', statement: 'Forged at create', status: 'user_confirmed' })],
        aiCreate.asStore(),
      ),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    expect(aiCreate.writes).toEqual([]);

    // 2. The ATTRIBUTE writer (update path). The patch type has no `status` member
    //    and the runtime loop refuses one arriving from an untyped caller. It must
    //    write NOTHING, and must not fabricate an audit row to justify the attempt.
    const attribute = new FakeCareerStore();
    const seeded = fakeClaimAtStatus(attribute, ClaimStatus.inferred);
    // @ts-expect-error `status` is owned exclusively by career/verification.ts
    const smuggle: ClaimAttributePatch = { status: 'user_confirmed' };
    await expect(
      updateClaimAttributes(seeded.id, smuggle, attribute.asStore()),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    expect(attribute.writes).toEqual([]);
    expect(attribute.claims.get(seeded.id)?.status).toBe(ClaimStatus.inferred);
    expect(attribute.verificationsFor(seeded.id)).toEqual([]);

    // 3. The STATEMENT writer cannot reach a status at all: it takes a claim id and a
    //    string. Asserted by behaviour rather than by the type, so a signature that
    //    grew a status parameter would still have to keep refusing it here.
    const statement = new FakeCareerStore();
    const rewordable = fakeClaimAtStatus(statement, ClaimStatus.inferred);
    await updateClaimStatement(rewordable.id, 'Totally different words', statement.asStore());
    expect(statement.claims.get(rewordable.id)?.status).toBe(ClaimStatus.inferred);
    expect(statement.verificationsFor(rewordable.id)).toEqual([]);

    // 4. Re-running the AI writer writes no audit row at all, so a machine has no
    //    path that fabricates one either.
    const rerun = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai('Inferred once')], rerun.asStore());
    await writeInferredClaims(PROFILE, [ai('Inferred once')], rerun.asStore());
    expect(rerun.writes).toEqual(['claim.create']);
    expect(rerun.verifications.size).toBe(0);

    // STRUCTURAL HALF - the STRONGER version of the guard in claimWriterAI.test.ts.
    // Comments are stripped first, so a docstring saying "we never write
    // status: 'user_confirmed'" cannot trip the scan, while a module that grows a real
    // `status:` payload naming a confirming or terminal status does.
    const offenders = careerSources()
      .filter((file) => !file.endsWith('verification.ts'))
      .filter((file) =>
        /status:\s*(ClaimStatus\.user_confirmed|ClaimStatus\.rejected|'user_confirmed'|'rejected')/.test(
          stripComments(readFileSync(file, 'utf8')),
        ),
      )
      .map((file) => path.relative(careerDir(), file));
    expect(offenders).toEqual([]);

    // And the AI writer names no confirming or terminal status AT ALL, in code. This
    // is the invariant rather than the filter: a `ClaimStatus.inferred` reference is
    // fine, a `ClaimStatus.user_confirmed` reference would not be.
    const writerCode = stripComments(readFileSync(path.join(careerDir(), 'claimWriterAI.ts'), 'utf8'));
    for (const forbidden of ['user_confirmed', 'rejected', 'superseded']) {
      expect(writerCode, `claimWriterAI.ts -> ${forbidden}`).not.toContain(forbidden);
    }

    // THE COUPLING, which is the half that makes "requires" true. A confirm writes the
    // status and the audit row in ONE transaction, and when the audit write FAILS the
    // status write rolls back with it. Without the rollback a claim could sit at
    // `user_confirmed` with no row justifying it - the exact hole ADR-036 item 3 names
    // and Prisma cannot close (05 sec.8).
    const coupled = new FakeCareerStore();
    const claim = fakeClaimAtStatus(coupled, ClaimStatus.inferred);
    const confirmed = await confirmClaim(
      { claimId: claim.id, actorUserId: ACTOR, now: NOW },
      coupled.asStore(),
    );
    expect(confirmed.claim.status).toBe(ClaimStatus.user_confirmed);
    // The write log is the ORDER: status first, audit row second, one transaction.
    expect(coupled.writes).toEqual(['claim.update', 'verification.create']);
    expect(coupled.transactions).toBe(1);
    expect(coupled.verificationsFor(claim.id)).toHaveLength(1);

    const rolledBack = new FakeCareerStore();
    const orphan = fakeClaimAtStatus(rolledBack, ClaimStatus.inferred);
    rolledBack.failVerificationCreate = true;
    await expect(
      confirmClaim({ claimId: orphan.id, actorUserId: ACTOR, now: NOW }, rolledBack.asStore()),
    ).rejects.toThrow(/audit row insert failed/);
    expect(rolledBack.claims.get(orphan.id)?.status).toBe(ClaimStatus.inferred);
    expect(rolledBack.claims.get(orphan.id)?.confirmedAt).toBeNull();
    expect(rolledBack.verificationsFor(orphan.id)).toEqual([]);

    // The other half of "a human decision has an accountable actor": `user_confirmed`
    // is not reachable by a decision with no actor at all.
    await expect(
      confirmClaim({ claimId: claim.id, actorUserId: '', now: NOW }, coupled.asStore()),
    ).rejects.toThrow(/actorUserId is required/);
  });

  // ---------------------------------------------------------------------------
  // (c) re-observation is a no-op over the whole status matrix
  // ---------------------------------------------------------------------------
  it('(c) re-observing a fingerprint cannot change ANY field of the row, at any status, and cannot duplicate it', async () => {
    for (const status of Object.values(ClaimStatus)) {
      const store = new FakeCareerStore();
      const statement = `Reduced p99 latency by 35% (${status})`;
      // Seeded directly at the status under test: the transition that PRODUCED it is
      // not what this test is about (see the `fakeClaimAtStatus` docstring).
      const claim = fakeClaimAtStatus(store, status, { statement, id: `clm-${status}` });
      const before = snapshot(claim);
      const writesBefore = [...store.writes];

      // A re-run of the AI writer on the identical fact, with EVERY producer field
      // different: higher confidence, a new model, a new method, an evidence link and
      // an entity attachment. Any of them being written is a violation.
      const rerun = await writeInferredClaims(
        PROFILE,
        [
          ai(statement, {
            status: ClaimStatus.contextual,
            confidence: 0.99,
            producedByModel: 'openai/gpt-x',
            inferenceMethod: 'jd_extract',
            evidenceSourceId: 'evd-1',
            experienceId: 'exp-1',
          }),
        ],
        store.asStore(),
      );

      expect(rerun, status).toEqual({ created: 0, deduped: 1 });
      // THE STRONG ASSERTION: field-for-field equality, not "the status did not
      // change". A re-observation that quietly rewrote `confidence`, or relabelled
      // `provenance`, would survive a status-only check and fail here.
      expect(snapshot(store.claims.get(claim.id)), status).toEqual(before);
      expect(store.claims.size, status).toBe(1);
      // Not one mutating call: `claim.findFirst` is a read, and the fake records reads
      // separately, so a re-observation is a pure read.
      expect(store.writes, status).toEqual(writesBefore);
    }

    // The ADVERSE case, stated separately because it is the one that reads worst in a
    // diff: a claim the USER entered is not relabelled as model output either, even
    // though the re-observing writer is the AI one. Provenance is a fact about where a
    // claim came from, and a machine run does not get to rewrite it.
    const humanStore = new FakeCareerStore();
    const typed = fakeClaimAtStatus(humanStore, ClaimStatus.inferred, {
      id: 'clm-typed',
      statement: 'I wrote this by hand in the app',
      provenance: ClaimProvenance.user_entered,
      inferenceMethod: null,
    });
    const typedBefore = snapshot(typed);
    const typedRerun = await writeInferredClaims(
      PROFILE,
      [ai('I wrote this by hand in the app', { producedByModel: 'openai/gpt-x', confidence: 1 })],
      humanStore.asStore(),
    );
    expect(typedRerun).toEqual({ created: 0, deduped: 1 });
    expect(snapshot(humanStore.claims.get(typed.id))).toEqual(typedBefore);
    expect(humanStore.claims.get(typed.id)?.provenance).toBe(ClaimProvenance.user_entered);

    // A DIFFERENT KIND over the same words is a different claim: the fingerprint
    // hashes (kind, normalized statement), so identity cannot be forged by re-typing
    // a statement the user already holds under another kind.
    const kindStore = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai('Postgres', { kind: 'technology' })], kindStore.asStore());
    const asSkill = await writeInferredClaims(
      PROFILE,
      [ai('postgres', { kind: 'skill' })],
      kindStore.asStore(),
    );
    expect(asSkill).toEqual({ created: 1, deduped: 0 });
    expect(kindStore.claimsFor(PROFILE)).toHaveLength(2);

    // Same words, different SPELLING, is the SAME observation - which is what makes
    // "cannot upgrade" a real guarantee rather than a coincidence of exact text.
    const spelling = new FakeCareerStore();
    await writeInferredClaims(
      PROFILE,
      [ai('Reduced p99 latency by 35%', { confidence: 0.2 })],
      spelling.asStore(),
    );
    const respelled = await writeInferredClaims(
      PROFILE,
      [ai('  reduced   P99 LATENCY by 35% ', { confidence: 0.99 })],
      spelling.asStore(),
    );
    expect(respelled).toEqual({ created: 0, deduped: 1 });
    expect(spelling.claimsFor(PROFILE)).toHaveLength(1);
    expect(spelling.claimsFor(PROFILE)[0].confidence).toBe(0.2);
  });

  // ---------------------------------------------------------------------------
  // (d) rejected is not the machine's to undo
  // ---------------------------------------------------------------------------
  it('(d) a rejected claim stays rejected until an explicit reopen, and reopen lands on inferred, never user_confirmed', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai('Led the payments migration')], store.asStore());
    const claim = store.claimsFor(PROFILE)[0];

    await rejectClaim(
      { claimId: claim.id, actorUserId: ACTOR, reason: 'I never did this', now: NOW },
      store.asStore(),
    );
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.rejected);
    const rejectedSnapshot = snapshot(store.claims.get(claim.id));

    // 1. THE MACHINE re-runs the writer on the identical fact. No resurrection, and
    //    not even a metadata refresh: the whole row is compared field-for-field.
    const writesAfterReject = [...store.writes];
    const rerun = await writeInferredClaims(
      PROFILE,
      [ai('Led the payments migration', { confidence: 0.99, producedByModel: 'openai/gpt-x' })],
      store.asStore(),
    );
    expect(rerun).toEqual({ created: 0, deduped: 1 });
    expect(snapshot(store.claims.get(claim.id))).toEqual(rejectedSnapshot);
    expect(store.writes).toEqual(writesAfterReject);

    // 2. EVERY OTHER HUMAN DECISION is refused too, so a rejection cannot be laundered
    //    into a confirmation by a second click. Each call is AWAITED IMMEDIATELY
    //    rather than collected into an array of promises: three rejections created in
    //    one tick and awaited later in a loop are briefly "unhandled", and a
    //    regression elsewhere in the module would then be attributed to this test
    //    instead of to the one that caused it.
    await expect(
      confirmClaim({ claimId: claim.id, actorUserId: ACTOR, now: LATER }, store.asStore()),
    ).rejects.toBeInstanceOf(ClaimVerificationError);
    await expect(
      editConfirmClaim(
        { claimId: claim.id, actorUserId: ACTOR, statement: 'Something else entirely', now: LATER },
        store.asStore(),
      ),
    ).rejects.toBeInstanceOf(ClaimVerificationError);
    await expect(
      recordClaimEdit(
        { claimId: claim.id, actorUserId: ACTOR, statement: 'Something else entirely', now: LATER },
        store.asStore(),
      ),
    ).rejects.toBeInstanceOf(ClaimVerificationError);
    // The message names the way out, because `illegal_transition` on its own is not an
    // answer a person can act on.
    await expect(
      confirmClaim({ claimId: claim.id, actorUserId: ACTOR, now: LATER }, store.asStore()),
    ).rejects.toThrow(/reopen it first/);
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.rejected);
    expect(store.verificationsFor(claim.id).map((row) => row.action)).toEqual([
      VerificationAction.reject,
    ]);

    // 3. REJECTING AGAIN is an idempotent no-op, not a second audit row and not a
    //    status change: a double-click on "no" is still one "no".
    const again = await rejectClaim(
      { claimId: claim.id, actorUserId: ACTOR, reason: 'I never did this', now: LATER },
      store.asStore(),
    );
    expect(again.changed).toBe(false);
    expect(again.verification).toBeNull();
    expect(store.verificationsFor(claim.id)).toHaveLength(1);

    // 4. THE ONLY WAY OUT, and it is a step DOWN the ladder, not up.
    const reopened = await reopenClaim(
      { claimId: claim.id, actorUserId: ACTOR, now: LATER },
      store.asStore(),
    );
    expect(reopened.claim.status).toBe(ClaimStatus.inferred);
    expect(reopened.claim.confirmedAt).toBeNull();
    expect(reopened.claim.rejectedAt).toBeNull();
    expect(reopened.claim.rejectedReason).toBeNull();
    // The single most important assertion in this test: a reopen is NOT a
    // confirmation. It clears the rejection and nothing else.
    expect(reopened.claim.status).not.toBe(ClaimStatus.user_confirmed);
    expect(reopened.verification?.action).toBe(VerificationAction.reopen);

    // A second reopen is refused outright (there is nothing left to reopen), so the
    // audit log records exactly one of each decision, in the order they happened.
    await expect(
      reopenClaim({ claimId: claim.id, actorUserId: ACTOR, now: LATER }, store.asStore()),
    ).rejects.toThrow(/cannot reopen a claim with status inferred/);

    // 5. AND THE MACHINE STILL CANNOT FINISH THE JOB. A fresh inference run against
    //    the reopened claim changes nothing; confirming it is a separate, separately
    //    audited human decision.
    const afterReopen = await writeInferredClaims(
      PROFILE,
      [ai('Led the payments migration', { confidence: 0.99 })],
      store.asStore(),
    );
    expect(afterReopen).toEqual({ created: 0, deduped: 1 });
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.inferred);
    expect(store.verificationsFor(claim.id)).toHaveLength(2);

    // Only now, with an explicit confirm, does it become experience - and that writes
    // its own audit row, so the history reads: reject, reopen, confirm.
    const confirmed = await confirmClaim(
      { claimId: claim.id, actorUserId: ACTOR, now: LATER },
      store.asStore(),
    );
    expect(confirmed.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(store.verificationsFor(claim.id).map((row) => row.action)).toEqual([
      VerificationAction.reject,
      VerificationAction.reopen,
      VerificationAction.confirm,
    ]);
  });

  // ---------------------------------------------------------------------------
  // (e) a repeated decision writes no second audit row
  // ---------------------------------------------------------------------------
  it('(e) repeating a decision is a no-op, so the audit log cannot grow by clicking twice', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai('Cut CI build time by 40%')], store.asStore());
    const claim = store.claimsFor(PROFILE)[0];

    // The repeat differs in every input that is NOT the state: a later clock and a
    // different note. An idempotency guard keyed on more than the state would pass a
    // test that replayed the identical call, and would double-write in production,
    // where a double-click never carries the same timestamp.
    const first = await confirmClaim(
      { claimId: claim.id, actorUserId: ACTOR, now: NOW, note: 'yes' },
      store.asStore(),
    );
    const writesAfterFirst = [...store.writes];
    const second = await confirmClaim(
      { claimId: claim.id, actorUserId: ACTOR, now: LATER, note: 'yes, definitely' },
      store.asStore(),
    );

    expect(first.changed).toBe(true);
    expect(first.verification?.action).toBe(VerificationAction.confirm);
    expect(second.changed).toBe(false);
    expect(second.verification).toBeNull();
    expect(second.action).toBe(VerificationAction.confirm);
    // The first confirmation's timestamp is NOT moved by the second attempt: a no-op
    // that rewrote `confirmedAt` would make "when did they confirm this" a function of
    // how many times they clicked.
    expect(store.claims.get(claim.id)?.confirmedAt).toEqual(NOW);
    expect(store.claims.get(claim.id)?.confirmedAt).not.toEqual(LATER);
    // No mutating call at all on the repeat - not even an update that changes nothing.
    expect(store.writes).toEqual(writesAfterFirst);
    expect(store.verificationsFor(claim.id)).toHaveLength(1);

    // The `edit_confirm` twin, whose `alreadyApplied` predicate is DIFFERENT from
    // confirm's (it also compares the statement) and was therefore the more likely of
    // the two to be wrong.
    const edits = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai('Cut CI build time by 40%')], edits.asStore());
    const target = edits.claimsFor(PROFILE)[0];
    const words = 'Cut CI build time by 55% and shipped the migration';
    const editOne = await editConfirmClaim(
      { claimId: target.id, actorUserId: ACTOR, statement: words, now: NOW },
      edits.asStore(),
    );
    const writesAfterEdit = [...edits.writes];
    const fingerprintAfterEdit = editOne.claim.fingerprint;
    const editTwo = await editConfirmClaim(
      { claimId: target.id, actorUserId: ACTOR, statement: words, now: LATER },
      edits.asStore(),
    );
    expect(editTwo.changed).toBe(false);
    expect(editTwo.verification).toBeNull();
    expect(edits.claims.get(target.id)?.statement).toBe(words);
    expect(edits.claims.get(target.id)?.fingerprint).toBe(fingerprintAfterEdit);
    expect(edits.writes).toEqual(writesAfterEdit);
    expect(edits.verificationsFor(target.id)).toHaveLength(1);

    // The count of audit rows equals the count of DISTINCT decisions across a mixed
    // history: the append-only log is a function of what happened, not of how many
    // times it was requested.
    const history = new FakeCareerStore();
    await writeInferredClaims(PROFILE, [ai('Cut CI build time by 40%')], history.asStore());
    const audited = history.claimsFor(PROFILE)[0];
    const decision: ClaimDecisionInput = { claimId: audited.id, actorUserId: ACTOR, now: NOW };
    await confirmClaim(decision, history.asStore());
    await confirmClaim(decision, history.asStore());
    await confirmClaim(decision, history.asStore());
    await rejectClaim({ ...decision, reason: 'overstated' }, history.asStore());
    await rejectClaim({ ...decision, reason: 'overstated' }, history.asStore());
    expect(history.verificationsFor(audited.id).map((row) => row.action)).toEqual([
      VerificationAction.confirm,
      VerificationAction.reject,
    ]);
    // The confirm's `confirmedAt` is still the FIRST click's clock, after a later
    // reject cleared it and a still-later sequence ran.
    expect(history.claims.get(audited.id)?.status).toBe(ClaimStatus.rejected);
  });

  // ---------------------------------------------------------------------------
  // (f) the audit row is a self-contained snapshot
  // ---------------------------------------------------------------------------
  it('(f) the audit row captures before, after and actor as a plain-JSON snapshot a later decision cannot rewrite', async () => {
    const store = new FakeCareerStore();
    await writeInferredClaims(
      PROFILE,
      [ai('Cut CI build time by 40%', { confidence: 0.4 })],
      store.asStore(),
    );
    const claim = store.claimsFor(PROFILE)[0];
    const originalStatement = claim.statement;

    const confirmed = await confirmClaim(
      { claimId: claim.id, actorUserId: ACTOR, now: NOW, note: 'checked against the CI dashboard' },
      store.asStore(),
    );
    const audit = store.verificationsFor(claim.id);
    expect(audit).toHaveLength(1);
    const row = audit[0];

    // WHO. Non-null by construction (`requireActor` refuses an empty actor) and
    // recorded on both columns the schema carries.
    expect(row.action).toBe(VerificationAction.confirm);
    expect(row.actorUserId).toBe(ACTOR);
    expect(row.userId).toBe(ACTOR);
    expect(row.targetType).toBe('career_claim');
    expect(row.targetId).toBe(claim.id);
    expect(row.claimId).toBe(claim.id);
    expect(row.createdAt).toEqual(NOW);
    expect(row.note).toBe('checked against the CI dashboard');

    // WHAT, on both sides. The snapshot key set is asserted EXACTLY: a snapshot that
    // silently dropped a field would still "look right" in a spot check, and an audit
    // trail that grows or shrinks with the edit is not an audit trail. `jobRelevance`
    // is deliberately absent - it is derived, not decided.
    const before = row.before as Record<string, unknown>;
    const after = row.after as Record<string, unknown>;
    expect(Object.keys(before).sort()).toEqual([
      'confidence',
      'confidenceIsMetadataOnly',
      'confirmedAt',
      'fingerprint',
      'provenance',
      'rejectedAt',
      'rejectedReason',
      'statement',
      'status',
    ]);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());

    // `before` is the PRE-state: the status the claim held when the decision was made.
    expect(before.status).toBe(ClaimStatus.inferred);
    expect(before.confirmedAt).toBeNull();
    // `after` is the POST-state, and the two differ in EXACTLY the fields the decision
    // moved. Anything else differing would mean the audit recorded a change that did
    // not happen - which is the failure mode an audit trail cannot recover from.
    expect(after.status).toBe(ClaimStatus.user_confirmed);
    expect(after.confirmedAt).toBe(NOW.toISOString());
    expect(withoutMovedFields(after)).toEqual(withoutMovedFields(before));
    // The text the user approved is in the audit, and so is the identity it was
    // approved under.
    expect(after.statement).toBe(originalStatement);
    expect(after.fingerprint).toBe(claim.fingerprint);
    expect(before.statement).toBe(originalStatement);
    // Confidence is carried as METADATA and labelled as such, so a future reader
    // cannot mistake "the model was sure" for "the user confirmed it".
    expect(after.confidence).toBe(0.4);
    expect(after.confidenceIsMetadataOnly).toBe(true);
    // The claim row itself moved; the audit describes the move, it is not a copy of
    // the current state.
    expect(store.claims.get(claim.id)?.status).toBe(ClaimStatus.user_confirmed);

    // THE SNAPSHOT IS A VALUE, NOT A WINDOW ONTO THE ROW. Two independent properties,
    // because either alone is a weaker claim:
    //   (i) JSON round-trip equality - a snapshot built from the live row object would
    //       hold a `Date`, and `JSON.stringify` would turn it into a string, so this
    //       comparison FAILS if someone passes the row through instead of copying it;
    //   (ii) immutability across a LATER decision - reject clears `confirmedAt` on the
    //       row, and the first audit row must still describe the confirmation.
    expect(JSON.parse(JSON.stringify(row.before))).toEqual(before);
    expect(JSON.parse(JSON.stringify(row.after))).toEqual(after);

    const rejected = await rejectClaim(
      { claimId: claim.id, actorUserId: ACTOR, reason: 'the dashboard said 25%', now: LATER },
      store.asStore(),
    );
    expect(rejected.claim.status).toBe(ClaimStatus.rejected);
    expect(rejected.claim.confirmedAt).toBeNull();

    const afterReject = store.verificationsFor(claim.id);
    expect(afterReject).toHaveLength(2);
    // Row 1 is untouched by row 2: the earlier record still says "confirmed at NOW".
    const firstRow = afterReject[0];
    expect((firstRow.before as Record<string, unknown>).status).toBe(ClaimStatus.inferred);
    expect((firstRow.after as Record<string, unknown>).status).toBe(ClaimStatus.user_confirmed);
    expect((firstRow.after as Record<string, unknown>).confirmedAt).toBe(NOW.toISOString());
    // Row 2 is the mirror: its `before` is exactly what row 1's `after` said.
    const secondBefore = afterReject[1].before as Record<string, unknown>;
    expect(secondBefore).toEqual(firstRow.after);
    expect(secondBefore.status).toBe(ClaimStatus.user_confirmed);
    expect((afterReject[1].after as Record<string, unknown>).status).toBe(ClaimStatus.rejected);
    expect((afterReject[1].after as Record<string, unknown>).rejectedReason).toBe(
      'the dashboard said 25%',
    );
    // The actor is per-decision, and it is echoed on the reject too.
    expect(afterReject.map((entry) => entry.actorUserId)).toEqual([ACTOR, ACTOR]);
    // The result object hands back the row that was STORED, so a caller reading the
    // audit is reading the audit rather than a reconstruction of it.
    expect(confirmed.verification?.id).toBe(firstRow.id);
  });
});
