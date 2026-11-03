// =====================================================================================
// career/claimUsage.test.ts - ADR-036 item 6 + 05 sec.2.5 / sec.6: THE PRE-RENDER GATE
// (T1030).
//
// This is the acceptance suite for the control the whole system exists to have. The
// spec's own required coverage, ADR-036 "Added":
//   (e) the pre-render gate blocks an unconfirmed claim.
// 05 sec.2.5: "A pre-render validator refuses to render a revision whose
// ResumeClaimUsage references a claim with status NOT IN (user_confirmed) and usage IN
// (verbatim, tailored). `inferred` claims may exist in the profile and may be surfaced
// as 'suggested', but they cannot enter a rendered or exported artifact."
//
// WHAT IS PROVEN HERE, in order of how much it matters:
//   1. THE GATE IS EXHAUSTIVE over the statuses. Not just `inferred` (the obvious
//      case): `contextual`, `rejected` and `superseded` are each refused too, each with
//      the status visible in the machine-readable violation. A gate that only handled
//      `inferred` would pass every test in the spec's own wording and still let a
//      superseded claim into a PDF.
//   2. THE STATUS IS READ FROM THE DATABASE. `loadGateUsages` joins `careerClaim`; the
//      test proves it by handing the loader a revision whose `x-clearance` block says
//      `user_confirmed` for an `inferred` claim and showing the gate still blocks. That
//      is the "a hand-edited document cannot lie" property, at the layer that decides.
//   3. THE GATE RUNS BEFORE ANY RENDER WORK. `withPreRenderGate` takes the render as a
//      thunk; on a blocked revision the thunk is never entered, asserted on a call log
//      rather than on the absence of an error. This is the same style of ordering proof
//      `render/stage.test.ts` uses for its lstat-before-open guards.
//   4. `omitted` IS ALWAYS ALLOWED, whatever the status. Without this the gate would
//      make the "suggested claims" surface (05 sec.2.5) impossible to implement.
//   5. The refusal is MACHINE-READABLE and carries no claim text: a fixed message per
//      reason, a closed reason set, and violations that name the claim id and status.
//
// The mutation evidence for the gate is in `.planning/progress/T1030-*.md`.
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { ClaimProvenance, ClaimStatus, ResumeUsage } from '@prisma/client';

import {
  GATE_REJECTION_REASONS,
  GATED_USAGES,
  IMPORTED_CLAIM_PROVENANCE,
  IMPORTED_CLAIM_STATUS,
  PreRenderGateError,
  PreRenderGateInputError,
  RENDERABLE_CLAIM_STATUSES,
  assertClaimUsagesRecordable,
  assertPreRenderGate,
  assertRevisionRenderable,
  evaluatePreRenderGate,
  evaluateRevisionPreRenderGate,
  isRenderableClaimStatus,
  listClaimUsages,
  listRevisionClaimUsages,
  loadGateUsages,
  recordClaimUsages,
  withPreRenderGate,
  type GateUsage,
} from './claimUsage.js';
import { ClaimInvariantError, ClaimNotFoundError, claimFingerprint } from './claims.js';
import {
  FakeCareerStore,
  fakeClaimAtStatus,
  fakeInferredClaim,
  seedConfirmedClaim,
  seedRevision,
} from './careerStore.fixtures.js';

const PROFILE = 'profile-1';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A store with one claim at a given status, and one revision using it verbatim. */
function scenario(status: ClaimStatus, usage: ResumeUsage = ResumeUsage.verbatim) {
  const store = new FakeCareerStore();
  const claim = fakeClaimAtStatus(store, status, {
    id: `clm-${status}`,
    statement: `A fact that is ${status}`,
  });
  const revision = seedRevision(store, 'res-1', 1);
  store.addUsage(revision.id, { claimId: claim.id, usage, renderedText: claim.statement });
  return { store, claim, revision };
}

// ---------------------------------------------------------------------------
// ACCEPTANCE: the gate rejects an unconfirmed claim, allows a confirmed one
// ---------------------------------------------------------------------------

describe('ACCEPTANCE: the gate rejects an unconfirmed claim and allows a confirmed one', () => {
  it('REJECTS an `inferred` claim used verbatim, with a machine-readable reason', async () => {
    const { store, claim, revision } = scenario(ClaimStatus.inferred);

    const verdict = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('CLAIM_NOT_CONFIRMED');
    expect(verdict.violations).toEqual([
      { claimId: claim.id, status: ClaimStatus.inferred, usage: ResumeUsage.verbatim, reason: 'CLAIM_NOT_CONFIRMED' },
    ]);
    // Machine-readable: a client can branch on `code`/`reason` without parsing prose.
    let caught: unknown;
    try {
      await assertRevisionRenderable(revision.id, store.asUsageStore());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PreRenderGateError);
    const gateError = caught as PreRenderGateError;
    expect(gateError.code).toBe('PRE_RENDER_GATE_BLOCKED');
    expect(gateError.reason).toBe('CLAIM_NOT_CONFIRMED');
    expect(gateError.toJSON()).toMatchObject({
      code: 'PRE_RENDER_GATE_BLOCKED',
      reason: 'CLAIM_NOT_CONFIRMED',
      checked: 1,
    });
  });

  it('ALLOWS the same revision once the claim is user_confirmed', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
    const revision = seedRevision(store, 'res-1', 1);
    store.addUsage(revision.id, { claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: claim.statement });

    // Before: blocked. Same usage rows, same document, only the STATUS changed.
    expect((await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore())).allowed).toBe(false);

    // The ONLY way to move a claim to the confirming status, and the audit row it
    // writes are both part of the change - so "confirmed" is never a bare column edit.
    const { confirmClaim } = await import('./verification.js');
    const decision = await confirmClaim({ claimId: claim.id, actorUserId: 'user-1' }, store.asStore());
    expect(decision.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(decision.verification?.action).toBe('confirm');
    expect(decision.verification?.actorUserId).toBe('user-1');

    const after = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
    expect(after.allowed).toBe(true);
    if (!after.allowed) throw new Error('unreachable');
    expect(after.rendered).toBe(1);
    expect(after.checked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EXHAUSTIVENESS: every non-confirmed status, not just `inferred`
// ---------------------------------------------------------------------------

describe('EXHAUSTIVENESS: the gate refuses EVERY status except the confirming one', () => {
  // Every status the enum has, paired with whether the gate must allow it. Written as
  // an exhaustive map on purpose: a status added to the Prisma enum later must show up
  // here as a failing test, not as a silently-renderable claim.
  const EXPECTATION: Record<ClaimStatus, boolean> = {
    [ClaimStatus.inferred]: false,
    [ClaimStatus.contextual]: false,
    [ClaimStatus.user_confirmed]: true,
    [ClaimStatus.rejected]: false,
    [ClaimStatus.superseded]: false,
  };

  it('has an expectation for every status in the enum', () => {
    // The guard against the map above going stale: if a migration adds a status, this
    // fails before any of the per-status tests silently stop covering it.
    expect(Object.keys(EXPECTATION).sort()).toEqual(Object.values(ClaimStatus).sort());
    expect(RENDERABLE_CLAIM_STATUSES).toEqual([ClaimStatus.user_confirmed]);
  });

  for (const [status, allowed] of Object.entries(EXPECTATION) as Array<[ClaimStatus, boolean]>) {
    it(`${allowed ? 'allows' : 'refuses'} a ${status} claim used verbatim`, async () => {
      const { store, claim, revision } = scenario(status);
      const verdict = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
      expect(verdict.allowed).toBe(allowed);
      if (!verdict.allowed) {
        expect(verdict.reason).toBe('CLAIM_NOT_CONFIRMED');
        // The status travels in the violation: a client can render "1 claim is
        // `rejected`" without a second query.
        expect(verdict.violations[0].status).toBe(status);
        expect(verdict.violations[0].claimId).toBe(claim.id);
      }
    });

    it(`${allowed ? 'allows' : 'refuses'} a ${status} claim used tailored`, async () => {
      const { store, revision } = scenario(status, ResumeUsage.tailored);
      const verdict = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
      expect(verdict.allowed).toBe(allowed);
    });

    it(`${allowed ? 'allows' : 'refuses'} a ${status} claim used OMITTED`, async () => {
      // 05 sec.2.5: an inferred claim may be surfaced as a "suggestion". That is only
      // possible if `omitted` usage is allowed at every status - the "suggested" chip in
      // the UI is a claim with `usage: omitted`.
      const { store, revision } = scenario(status, ResumeUsage.omitted);
      const verdict = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
      expect(verdict.allowed).toBe(true);
      if (!verdict.allowed) throw new Error('unreachable');
      expect(verdict.rendered).toBe(0);
    });
  }

  it('refuses a MIXED revision and reports EVERY violation, not just the first', async () => {
    // A user who fixed one claim and re-rendered should learn about all of them in one
    // round trip; a gate that reported only the first would make this a one-claim-per-
    // attempt workflow.
    const store = new FakeCareerStore();
    const inferred = fakeInferredClaim(store, { id: 'clm-a', statement: 'Fact A' });
    const contextual = fakeInferredClaim(store, { id: 'clm-b', statement: 'Fact B', status: ClaimStatus.contextual });
    const confirmed = seedConfirmedClaim(store, { id: 'clm-c', statement: 'Fact C' });
    const revision = seedRevision(store, 'res-1', 1);
    for (const claim of [confirmed, inferred, contextual]) {
      store.addUsage(revision.id, { claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: claim.statement });
    }

    const verdict = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.violations.map((v) => v.claimId)).toEqual(['clm-a', 'clm-b']);
    expect(verdict.violations.map((v) => v.status)).toEqual([ClaimStatus.inferred, ClaimStatus.contextual]);
    expect(verdict.checked).toBe(3);
    expect(verdict.rendered).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// THE STATUS COMES FROM THE DATABASE, NOT THE DOCUMENT
// ---------------------------------------------------------------------------

describe('the status is read from the DATABASE, never from the document', () => {
  it('refuses a claim whose stored x-clearance block LIES about its status', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, { id: 'clm-1', statement: 'Never confirmed' });
    const revision = seedRevision(store, 'res-1', 1);
    store.addUsage(revision.id, { claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: claim.statement });
    // A hand-edited (or maliciously edited) snapshot that claims the confirming status.
    store.setRevisionJson(revision.id, {
      basics: { name: 'Forged' },
      'x-clearance': {
        version: 1,
        claims: [
          {
            claimId: claim.id,
            fingerprint: claim.fingerprint,
            kind: claim.kind,
            status: ClaimStatus.user_confirmed,
            provenance: claim.provenance,
            usage: ResumeUsage.verbatim,
          },
        ],
      },
    });

    // The document says confirmed. The DATABASE says inferred. The gate reads the
    // database, so it blocks - which is the whole reason `loadGateUsages` joins
    // `careerClaim` instead of reading the revision's own JSON.
    const verdict = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.violations[0].status).toBe(ClaimStatus.inferred);
  });

  it('refuses a claim that was confirmed AFTER the revision was written, once rejected', async () => {
    // The audit property 05 sec.6.5 depends on: "this resume used claim X, which was
    // later rejected". The gate re-reads the CURRENT status on every render, so a claim
    // that was fine at authoring time is refused the moment the user rejects it.
    const store = new FakeCareerStore();
    const claim = seedConfirmedClaim(store, { id: 'clm-1', statement: 'Used to be true' });
    const revision = seedRevision(store, 'res-1', 1);
    store.addUsage(revision.id, { claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: claim.statement });
    expect((await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore())).allowed).toBe(true);

    const { rejectClaim } = await import('./verification.js');
    await rejectClaim({ claimId: claim.id, actorUserId: 'user-1', reason: 'never happened' }, store.asStore());

    const after = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
    expect(after.allowed).toBe(false);
    if (!after.allowed) expect(after.violations[0].status).toBe(ClaimStatus.rejected);
  });
});

// ---------------------------------------------------------------------------
// THE GATE RUNS BEFORE ANY RENDER WORK
// ---------------------------------------------------------------------------

describe('ORDERING: the gate runs BEFORE any render work is attempted', () => {
  it('never enters the render thunk on a blocked revision, and the call log is empty', async () => {
    // The ordering claim, asserted as ORDER rather than as "an error was thrown". A
    // render that opens a file, spawns a process, then validates would throw the same
    // error and still fail this system; only an empty call log proves the render was
    // never reached. Same style as the lstat-before-open proof in render/stage.test.ts.
    const { store, revision } = scenario(ClaimStatus.inferred);
    const calls: string[] = [];

    await expect(
      withPreRenderGate(revision.id, store.asUsageStore(), async () => {
        calls.push('render');
        return 'pdf';
      }),
    ).rejects.toBeInstanceOf(PreRenderGateError);

    expect(calls).toEqual([]);
  });

  it('enters the render thunk on an allowed revision, and only then', async () => {
    const store = new FakeCareerStore();
    const claim = seedConfirmedClaim(store, { id: 'clm-1', statement: 'Confirmed' });
    const revision = seedRevision(store, 'res-1', 1);
    store.addUsage(revision.id, { claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: claim.statement });
    const calls: string[] = [];

    const result = await withPreRenderGate(revision.id, store.asUsageStore(), async () => {
      calls.push('render');
      return 'pdf';
    });

    expect(result).toBe('pdf');
    expect(calls).toEqual(['render']);
  });

  it('the gate READS the claim rows before the render thunk is even resolved', async () => {
    // The finer-grained half of the ordering: the claim read happens DURING the gate, so
    // the status a render would rely on is already loaded and cannot change under it.
    const { store, revision } = scenario(ClaimStatus.inferred);
    const order: string[] = [];
    const spy = store.asUsageStore();
    // Wrapped through a cast because Prisma's delegate returns a branded
    // `PrismaPromise`; the fake returns a plain promise and the seam only ever awaits
    // it, so the cast is about the BRAND and not about behaviour.
    const original = spy.careerClaim.findMany as unknown as (args: unknown) => Promise<unknown[]>;
    const tracedStore = {
      ...spy,
      careerClaim: {
        ...spy.careerClaim,
        findMany: async (args: unknown) => {
          order.push('gate:read-claims');
          return original(args);
        },
      },
    } as unknown as typeof spy;

    await expect(
      withPreRenderGate(revision.id, tracedStore, async () => {
        order.push('render');
        return 'pdf';
      }),
    ).rejects.toBeInstanceOf(PreRenderGateError);

    expect(order).toEqual(['gate:read-claims']);
  });
});

// ---------------------------------------------------------------------------
// The pure function: no I/O, no clock, total order
// ---------------------------------------------------------------------------

describe('evaluatePreRenderGate is a PURE function', () => {
  it('gives the same verdict for the same input, in any array order', () => {
    const usages: GateUsage[] = [
      { claimId: 'clm-2', usage: ResumeUsage.verbatim, claimStatus: ClaimStatus.inferred },
      { claimId: 'clm-1', usage: ResumeUsage.tailored, claimStatus: ClaimStatus.contextual },
    ];
    const forward = evaluatePreRenderGate(usages);
    const reversed = evaluatePreRenderGate([...usages].reverse());

    expect(forward).toEqual(reversed);
    if (forward.allowed || reversed.allowed) throw new Error('unreachable');
    // Sorted by claimId, so the REPORTED reason does not depend on the row order the
    // database happened to return.
    expect(forward.violations.map((v) => v.claimId)).toEqual(['clm-1', 'clm-2']);
    expect(reversed.violations.map((v) => v.claimId)).toEqual(['clm-1', 'clm-2']);
  });

  it('allows an empty usage set', () => {
    const verdict = evaluatePreRenderGate([]);
    expect(verdict).toEqual({ allowed: true, checked: 0, rendered: 0 });
    expect(() => assertPreRenderGate(verdict)).not.toThrow();
  });

  it('refuses a usage whose value is outside the enum, rather than guessing', async () => {
    // A smuggled value must never be defaulted to `omitted` (which would let it through)
    // or to `verbatim` (which is a guess about the most dangerous direction).
    const verdict = evaluatePreRenderGate([
      { claimId: 'clm-1', usage: 'SOMETIMES' as never, claimStatus: ClaimStatus.user_confirmed },
    ]);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('USAGE_UNKNOWN');
    expect(verdict.violations[0].usage).toBe('unknown');
    expect(verdict.rendered).toBe(0);
  });

  it('refuses a usage whose claim id resolves to nothing (fails closed)', async () => {
    // Unreachable through the ORM (the FK cascades), reachable through any other writer.
    // A gate that SKIPPED an unresolvable reference would have a hole exactly the size
    // of "a second writer exists".
    const verdict = evaluatePreRenderGate([
      { claimId: 'clm-gone', usage: ResumeUsage.verbatim, claimStatus: null },
    ]);
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('CLAIM_NOT_FOUND');
    expect(verdict.violations[0].status).toBeNull();
  });

  it('a missing claim is only a violation when the usage is rendered', async () => {
    // An `omitted` usage for a deleted claim is harmless: nothing is in the document, so
    // there is nothing to gate. Being strict here would break the delete-a-claim flow
    // (05 sec.6.5 makes deletion SOFT precisely so usage history stays resolvable).
    expect(
      evaluatePreRenderGate([{ claimId: 'clm-gone', usage: ResumeUsage.omitted, claimStatus: null }]).allowed,
    ).toBe(true);
  });

  it('rejects a malformed call rather than throwing a raw TypeError', () => {
    // The module's contract is that a bad call is a `PreRenderGateInputError` with a
    // message, never a `TypeError: Cannot read properties of null` from a property
    // access. Both shapes are covered: a non-array, and a bad ENTRY.
    for (const bad of [null, undefined, 'nope', 42, {}, { usages: [] }]) {
      expect(() => evaluatePreRenderGate(bad as never)).toThrowError(
        /evaluatePreRenderGate needs an array of usages/,
      );
    }
    for (const bad of [[null], ['x'], [42], [[]]]) {
      expect(() => evaluatePreRenderGate(bad as never)).toThrowError(
        /must be an object with \{ claimId, usage, claimStatus \}/,
      );
    }
    for (const bad of [[{}], [{ claimId: '', usage: 'verbatim', claimStatus: 'inferred' }]]) {
      expect(() => evaluatePreRenderGate(bad as never)).toThrowError(/needs a non-empty claimId/);
    }
    // And the error is the typed one, not a subclass of nothing useful.
    let caught: unknown;
    try {
      evaluatePreRenderGate(null as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PreRenderGateInputError);
    expect((caught as { code: string }).code).toBe('pre_render_gate_invalid');
  });
});

// ---------------------------------------------------------------------------
// The error surface: closed, machine-readable, no caller data
// ---------------------------------------------------------------------------

describe('the gate error surface', () => {
  it('has a fixed message per reason and interpolates nothing from the caller', async () => {
    const store = new FakeCareerStore();
    const claim = fakeInferredClaim(store, {
      id: 'clm-secret',
      statement: 'SSN 123-45-6789 and other private text',
    });
    const revision = seedRevision(store, 'res-1', 1);
    store.addUsage(revision.id, { claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: claim.statement });

    let caught: PreRenderGateError | undefined;
    try {
      await assertRevisionRenderable(revision.id, store.asUsageStore());
    } catch (error) {
      caught = error as PreRenderGateError;
    }
    expect(caught).toBeInstanceOf(PreRenderGateError);
    // The MESSAGE carries the reason and nothing else. The claim's statement - which is
    // the user's career content, and here a deliberately alarming string - never appears,
    // so a log aggregator or an error page cannot leak it. Same rule as
    // render/stage.ts's `REASON_TEXT`.
    expect(caught?.message).toBe(
      'PRE_RENDER_GATE_BLOCKED: a claim rendered by this revision is not user-confirmed; an inference is never user-confirmed experience (ADR-036 item 6)',
    );
    expect(caught?.message).not.toContain('SSN');
    expect(caught?.message).not.toContain('clm-secret');
    // The STRUCTURED payload does carry the id, which is what a client needs to link to
    // the claim; it carries no text.
    expect(caught?.violations[0].claimId).toBe('clm-secret');
    expect(JSON.stringify(caught?.toJSON())).not.toContain('SSN');
  });

  it('every reason in the closed set has fixed text and a reachable path', async () => {
    const cases = [
      { usage: 'verbatim' as ResumeUsage, status: ClaimStatus.inferred, reason: 'CLAIM_NOT_CONFIRMED' },
      { usage: 'verbatim' as ResumeUsage, status: null, reason: 'CLAIM_NOT_FOUND' },
      { usage: 'BOGUS' as never, status: ClaimStatus.inferred, reason: 'USAGE_UNKNOWN' },
    ];
    const seen = new Set<string>();
    for (const testCase of cases) {
      const verdict = evaluatePreRenderGate([
        { claimId: 'clm-1', usage: testCase.usage, claimStatus: testCase.status },
      ]);
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) throw new Error('unreachable');
      expect(verdict.reason).toBe(testCase.reason);
      expect(seen.has(verdict.reason)).toBe(false);
      seen.add(verdict.reason);
    }
    // No dead reason in the vocabulary: a reason nothing can produce is documentation
    // pretending to be a control.
    expect([...seen].sort()).toEqual([...GATE_REJECTION_REASONS].sort());
  });
});

// ---------------------------------------------------------------------------
// Recording usage
// ---------------------------------------------------------------------------

describe('recordClaimUsages', () => {
  it('records one row per claim and is idempotent per (revisionId, claimId)', async () => {
    const store = new FakeCareerStore();
    const a = seedConfirmedClaim(store, { id: 'clm-a', statement: 'Fact A' });
    const b = seedConfirmedClaim(store, { id: 'clm-b', statement: 'Fact B' });
    const revision = seedRevision(store, 'res-1', 1);

    const first = await recordClaimUsages(
      revision.id,
      [
        { claimId: a.id, usage: ResumeUsage.verbatim, renderedText: a.statement },
        { claimId: b.id, usage: ResumeUsage.tailored, renderedText: 'Fact B, reworded' },
      ],
      store.asUsageStore(),
    );
    expect(first.created).toBe(2);

    // A re-record must NOT grow the usage set underneath the gate: a revision is an
    // immutable snapshot, so its usage is fixed at authoring time
    // (`@@unique([revisionId, claimId])`).
    const again = await recordClaimUsages(
      revision.id,
      [{ claimId: a.id, usage: ResumeUsage.verbatim, renderedText: a.statement }],
      store.asUsageStore(),
    );
    expect(again).toMatchObject({ created: 0, existing: 1 });
    expect(await listRevisionClaimUsages(revision.id, store.asUsageStore())).toHaveLength(2);
  });

  it('refuses a usage for a claim that does not exist', async () => {
    const store = new FakeCareerStore();
    const revision = seedRevision(store, 'res-1', 1);
    await expect(
      recordClaimUsages(revision.id, [{ claimId: 'nope', usage: ResumeUsage.omitted }], store.asUsageStore()),
    ).rejects.toBeInstanceOf(ClaimNotFoundError);
    expect(store.usagesFor(revision.id)).toHaveLength(0);
  });

  it('refuses a RENDERING usage for a REJECTED claim, and writes nothing at all', async () => {
    // 05 sec.6.4 / ADR-036 item 5: "a rejected claim has no valid usage". The guard is
    // WRITE-time (it is narrower than the gate on purpose - see the module header), and
    // it validates the WHOLE list before the first insert, so a rejected claim in the
    // middle cannot leave a half-recorded revision behind.
    //
    // F1: the refusal is on a RENDERING usage - `verbatim` here, and `tailored` is the
    // other member of `GATED_USAGES`. An `omitted` usage is deliberately NOT refused; the
    // test below it is the other half of the same change.
    const store = new FakeCareerStore();
    const ok = seedConfirmedClaim(store, { id: 'clm-ok', statement: 'Fine' });
    const rejected = fakeInferredClaim(store, {
      id: 'clm-bad',
      statement: 'Never happened',
      status: ClaimStatus.rejected,
    });
    const revision = seedRevision(store, 'res-1', 1);

    for (const usage of [ResumeUsage.verbatim, ResumeUsage.tailored]) {
      store.writes.length = 0;
      await expect(
        recordClaimUsages(
          revision.id,
          [
            { claimId: ok.id, usage, renderedText: ok.statement },
            { claimId: rejected.id, usage, renderedText: rejected.statement },
          ],
          store.asUsageStore(),
        ),
      ).rejects.toBeInstanceOf(ClaimInvariantError);
      expect(store.usagesFor(revision.id), usage).toHaveLength(0);
      expect(store.writes, usage).toEqual([]);
    }
  });

  it('F1: RECORDS an OMITTED usage of a rejected claim - the document\u2019s own account of itself', async () => {
    // The half of F1 that unblocks the product, stated as its own test because the fix is
    // meaningless without it. `project.ts` records EVERY claim it considered and did not
    // place as `omitted`, so refusing those made one rejected statement anywhere in a
    // profile 409 EVERY revision write - `from-profile` and the Studio's autosave both -
    // with no way back except a `reopen`. An `omitted` usage puts nothing on the page, is
    // inert at render time (`evaluatePreRenderGate` returns early for it - the gate's own
    // rule 4), and is exactly 05 sec.2.5's "what did you leave out?".
    const store = new FakeCareerStore();
    const rejected = fakeInferredClaim(store, {
      id: 'clm-bad',
      statement: 'Never happened',
      status: ClaimStatus.rejected,
    });
    const revision = seedRevision(store, 'res-1', 1);

    const result = await recordClaimUsages(
      revision.id,
      [{ claimId: rejected.id, usage: ResumeUsage.omitted, renderedText: null }],
      store.asUsageStore(),
    );
    expect(result.created).toBe(1);
    expect(store.usagesFor(revision.id)).toEqual([
      expect.objectContaining({ claimId: rejected.id, usage: ResumeUsage.omitted, renderedText: null }),
    ]);

    // And the record is INERT: the gate reads the CURRENT status from the database and
    // allows it. This is the asymmetry F1 removed - the writer and the gate now agree.
    const verdict = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
    expect(verdict.allowed).toBe(true);
    expect(verdict.rendered).toBe(0);

    // ...while turning the SAME row into a rendering one is refused, by the writer AND by
    // the gate, so the change is narrow rather than a new hole.
    await expect(
      assertClaimUsagesRecordable(
        [{ claimId: rejected.id, usage: ResumeUsage.verbatim, renderedText: rejected.statement }],
        store.asUsageStore(),
      ),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    store.addUsage(revision.id, {
      claimId: rejected.id,
      usage: ResumeUsage.verbatim,
      renderedText: rejected.statement,
    });
    const blocked = await evaluateRevisionPreRenderGate(revision.id, store.asUsageStore());
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.reason).toBe('CLAIM_NOT_CONFIRMED');
  });

  it('requires the renderedText for a rendered usage', async () => {
    // An audit that records THAT a claim was used, never WHAT was said for it, cannot
    // answer "why does my resume say this?" (05 sec.6.3).
    const store = new FakeCareerStore();
    const claim = seedConfirmedClaim(store, { id: 'clm-1', statement: 'Fact' });
    const revision = seedRevision(store, 'res-1', 1);
    for (const usage of [ResumeUsage.verbatim, ResumeUsage.tailored]) {
      await expect(
        recordClaimUsages(revision.id, [{ claimId: claim.id, usage }], store.asUsageStore()),
      ).rejects.toThrowError(/requires the renderedText/);
    }
    // `omitted` needs none: nothing appears in the document.
    await expect(
      recordClaimUsages(revision.id, [{ claimId: claim.id, usage: ResumeUsage.omitted }], store.asUsageStore()),
    ).resolves.toMatchObject({ created: 1 });
  });

  it('refuses a usage outside the enum instead of storing it', async () => {
    const store = new FakeCareerStore();
    const claim = seedConfirmedClaim(store, { id: 'clm-1', statement: 'Fact' });
    const revision = seedRevision(store, 'res-1', 1);
    await expect(
      recordClaimUsages(
        revision.id,
        [{ claimId: claim.id, usage: 'SOMETIMES' as never }],
        store.asUsageStore(),
      ),
    ).rejects.toThrowError(/usage must be one of verbatim\|tailored\|omitted/);
    expect(store.usagesFor(revision.id)).toHaveLength(0);
  });

  it('F6: refuses a usage naming ANOTHER PROFILE s claim, and writes nothing', async () => {
    // A revision may only record usages for claims in the profile the document was
    // projected from. Without the scope the load is by id alone, so a revision could name
    // another tenant's claim: the gate stays fail-closed (a non-confirmed claim blocks, a
    // confirmed one passes), but the 05 sec.6.5 audit is poisoned with cross-tenant rows
    // and one tenant's document can claim another's content as usage.
    const store = new FakeCareerStore();
    const mine = seedConfirmedClaim(store, { id: 'clm-mine', statement: 'Mine', profileId: 'profile-1' });
    const theirs = seedConfirmedClaim(store, { id: 'clm-theirs', statement: 'Theirs', profileId: 'profile-2' });
    const revision = seedRevision(store, 'res-1', 1);

    // Scoped to profile-1: the other profile's claim does not resolve, and the answer is
    // the SAME `ClaimNotFoundError` as a claim that does not exist, so the refusal is not
    // a cross-tenant oracle.
    await expect(
      recordClaimUsages(
        revision.id,
        [{ claimId: theirs.id, usage: ResumeUsage.verbatim, renderedText: theirs.statement }],
        store.asUsageStore(),
        { profileId: 'profile-1' },
      ),
    ).rejects.toBeInstanceOf(ClaimNotFoundError);
    expect(store.usagesFor(revision.id)).toHaveLength(0);

    // POSITIVE CONTROL: the same store and the same list shape, scoped to the right
    // profile - so the refusal above is the scope and not the list being malformed.
    await expect(
      recordClaimUsages(
        revision.id,
        [{ claimId: mine.id, usage: ResumeUsage.verbatim, renderedText: mine.statement }],
        store.asUsageStore(),
        { profileId: 'profile-1' },
      ),
    ).resolves.toMatchObject({ created: 1 });
  });

  it('N2: two usages for ONE claim collapse to one row - which is why the WRITER refuses them', async () => {
    // This is the mechanism N2 exploited. `@@unique([revisionId, claimId])` plus the
    // `existingIds` skip means the FIRST entry for a claim wins, so a usage list naming
    // one claim twice records a set that depends on ENTRY ORDER rather than on the
    // document. Declare `omitted` first and `verbatim` second and the gate reads
    // `omitted` - which is inert - for a revision that declares and PLACES the text.
    //
    // The fix is not here: `recordClaimUsages` is the right place to keep the `@@unique`
    // contract, and the refusal belongs to `revisions.ts#assertOneUsagePerClaimId`, where
    // the ambiguity is still two DOCUMENT entries rather than one row. This test states
    // the hazard as a fact about the recorder so the refusal is not mistaken for a
    // paranoia that could be removed.
    const store = new FakeCareerStore();
    seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
    const revision = seedRevision(store, 'res-1', 1);
    const result = await recordClaimUsages(
      revision.id,
      [
        { claimId: 'clm-1', usage: ResumeUsage.omitted, renderedText: null },
        { claimId: 'clm-1', usage: ResumeUsage.verbatim, renderedText: 'Cut CI build time by 40%' },
      ],
      store.asUsageStore(),
    );
    expect(result.created).toBe(1);
    expect(result.existing).toBe(1);
    // The FIRST one. The gate will read `omitted` and allow.
    expect(store.usagesFor(revision.id)[0].usage).toBe(ResumeUsage.omitted);
  });

  it('N5: the two usage tuples that collided under the old delimiter-free key are NOT equal', async () => {
    // `assertUsagesMatchDocument` keys on `(claimId, usage, renderedText)`. The attempt-2
    // key was a delimiter-free join, so a claimId could run into the usage and satisfy a
    // DIFFERENT entry's key than the one it named. These are the review's two tuples.
    const oldKey = (claimId: string, usage: string, text: string): string =>
      [claimId, usage, text].join('');
    const newKey = (claimId: string, usage: string, text: string): string =>
      JSON.stringify([claimId, usage, text]);
    expect(oldKey('x', 'omitted', 'verbatim')).toBe(oldKey('xomitted', 'verbatim', ''));
    expect(newKey('x', 'omitted', 'verbatim')).not.toBe(newKey('xomitted', 'verbatim', ''));

    // The property that matters at the call site: with the injective key, a restatement
    // naming a claim that exists but with the wrong usage is refused, not silently
    // matched against some other entry.
    const store = new FakeCareerStore();
    seedConfirmedClaim(store, { id: 'x', statement: 'verbatim', profileId: 'profile-1' });
    seedConfirmedClaim(store, { id: 'xomitted', statement: 'another', profileId: 'profile-1' });
    const revision = seedRevision(store, 'res-1', 1);
    await expect(
      recordClaimUsages(
        revision.id,
        [{ claimId: 'x', usage: ResumeUsage.omitted, renderedText: 'verbatim' }],
        store.asUsageStore(),
      ),
    ).resolves.toMatchObject({ created: 1 });
    // The row says exactly what was asked for. Under a colliding key this entry could
    // have been accepted as a restatement of the OTHER claim.
    expect(store.usagesFor(revision.id)[0]).toMatchObject({
      claimId: 'x',
      usage: ResumeUsage.omitted,
      renderedText: 'verbatim',
    });
  });

  it('assertClaimUsagesRecordable validates WITHOUT writing, which is what the writer needs', async () => {
    // F2. `createRevision` inserts the revision row and only then needs to record the
    // usage, so it has to run every check the recorder runs BEFORE its own insert - or a
    // refused usage leaves an orphan revision with zero usage rows, which by the old gate
    // logic renders anything. This is the function that makes "validate first, insert
    // second" possible without duplicating the rules.
    const store = new FakeCareerStore();
    const claim = seedConfirmedClaim(store, { id: 'clm-ok', statement: 'Fine', profileId: 'profile-1' });
    const rejected = fakeInferredClaim(store, {
      id: 'clm-bad',
      statement: 'Never happened',
      status: ClaimStatus.rejected,
    });
    const revision = seedRevision(store, 'res-1', 1);

    // A good list resolves and returns the rows, writing nothing.
    const resolved = await assertClaimUsagesRecordable(
      [{ claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: claim.statement }],
      store.asUsageStore(),
      { profileId: 'profile-1' },
    );
    expect([...resolved.keys()]).toEqual(['clm-ok']);
    expect(store.writes).toEqual([]);
    expect(store.usagesFor(revision.id)).toHaveLength(0);

    // A bad one throws, and "nothing was written" still holds - including for a bad entry
    // in the MIDDLE of the list, which is the half-recorded-revision case.
    await expect(
      assertClaimUsagesRecordable(
        [
          { claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: claim.statement },
          { claimId: rejected.id, usage: ResumeUsage.verbatim, renderedText: rejected.statement },
        ],
        store.asUsageStore(),
        { profileId: 'profile-1' },
      ),
    ).rejects.toBeInstanceOf(ClaimInvariantError);
    expect(store.writes).toEqual([]);

    // And the same shapes `recordClaimUsages` refuses are refused identically here, so the
    // writer cannot accept something the recorder would later reject.
    await expect(
      assertClaimUsagesRecordable(
        [{ claimId: 'nope', usage: ResumeUsage.omitted }],
        store.asUsageStore(),
        { profileId: 'profile-1' },
      ),
    ).rejects.toThrowError(/career claim not found/);
    await expect(
      assertClaimUsagesRecordable(
        [{ claimId: claim.id, usage: 'SOMETIMES' as never }],
        store.asUsageStore(),
        { profileId: 'profile-1' },
      ),
    ).rejects.toThrowError(/usage must be one of/);
    await expect(
      assertClaimUsagesRecordable(
        [{ claimId: claim.id, usage: ResumeUsage.verbatim }],
        store.asUsageStore(),
        { profileId: 'profile-1' },
      ),
    ).rejects.toThrowError(/requires the renderedText/);
    // A non-array is a programming error, refused the typed way rather than a TypeError.
    await expect(
      assertClaimUsagesRecordable(null as never, store.asUsageStore()),
    ).rejects.toBeInstanceOf(PreRenderGateInputError);
  });
});

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

describe('reading usage', () => {
  it('loadGateUsages returns a TOTAL order and a stable verdict input', async () => {
    const store = new FakeCareerStore();
    const claims = ['clm-c', 'clm-a', 'clm-b'].map((id) =>
      fakeInferredClaim(store, { id, statement: `Fact ${id}` }),
    );
    const revision = seedRevision(store, 'res-1', 1);
    for (const claim of claims) {
      store.addUsage(revision.id, { claimId: claim.id, usage: ResumeUsage.omitted });
    }
    const usages = await loadGateUsages(revision.id, store.asUsageStore());
    expect(usages.map((u) => u.claimId)).toEqual(['clm-a', 'clm-b', 'clm-c']);
  });

  it('listClaimUsages answers "which revisions say this claim?"', async () => {
    // 05 sec.6.5: "this resume used claim X, which was later rejected" is a queryable
    // fact. That query is this function, and it returns REVISION ids in a total order.
    const store = new FakeCareerStore();
    const claim = seedConfirmedClaim(store, { id: 'clm-1', statement: 'Shared fact' });
    const first = seedRevision(store, 'res-1', 1);
    const second = seedRevision(store, 'res-2', 1);
    for (const revision of [second, first]) {
      store.addUsage(revision.id, { claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: claim.statement });
    }
    const rows = await listClaimUsages(claim.id, store.asUsageStore());
    expect(rows.map((row) => row.revisionId)).toEqual([first.id, second.id]);
    expect(rows.every((row) => row.usage === ResumeUsage.verbatim)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The imported status vocabulary (used by the resume layer)
// ---------------------------------------------------------------------------

describe('the imported status vocabulary', () => {
  it('is the inferred status and the document_import provenance, and nothing else', () => {
    // These two constants are the ONLY statuses the resume layer can write, and the
    // whole "a plain JSON Resume import never confirms anything" property rests on
    // them. 05 sec.7.7: "Never auto-confirm imported content."
    expect(IMPORTED_CLAIM_STATUS).toBe(ClaimStatus.inferred);
    expect(IMPORTED_CLAIM_PROVENANCE).toBe(ClaimProvenance.document_import);
    expect(isRenderableClaimStatus(IMPORTED_CLAIM_STATUS)).toBe(false);
  });

  it('names only the two gated usages as render-blocking', () => {
    expect(GATED_USAGES).toEqual([ResumeUsage.verbatim, ResumeUsage.tailored]);
    expect(GATED_USAGES).not.toContain(ResumeUsage.omitted);
  });
});

// ---------------------------------------------------------------------------
// Source guard: the gate reads the claim table, not the document
// ---------------------------------------------------------------------------

describe('source guard: the gate joins the claim table', () => {
  it('loadGateUsages reads `careerClaim` and never the revision snapshot', async () => {
    // A structural check on the single most important line in the module. If someone
    // "optimises" the gate to read the statuses out of `resumeJson.x-clearance` (it
    // would be one query instead of two), this fails.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(path.join(__dirname, 'claimUsage.ts'), 'utf8');
    const fn = source.slice(source.indexOf('export async function loadGateUsages'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('store.careerClaim.findMany');
    expect(body).not.toContain('resumeJson');
    expect(body).not.toContain('X_CLEARANCE');
  });

  it('the fingerprint re-export is the claim layer one, not a second implementation', async () => {
    // A second sha256 layout would dedupe against nothing, and a re-import would fork a
    // duplicate claim row.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const source = readFileSync(path.join(__dirname, 'claimUsage.ts'), 'utf8');
    expect(source).toContain("export { claimFingerprint }");
    // No local sha256 of a statement anywhere in this module.
    expect(source).not.toMatch(/createHash\(/);
    expect(claimFingerprint('achievement', 'Cut CI build time by 40%')).toBe(
      claimFingerprint('achievement', '  CUT   ci build TIME by 40%  '),
    );
  });
});
