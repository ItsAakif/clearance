// resume/json/project.test.ts - DB -> Resume JSON, the round trip, and the x-clearance
// block (T1030; ADR-035, ADR-036; 05 sec.1, sec.6, sec.7.7).
//
// WHAT IS PROVEN HERE:
//   1. PROJECTION IS DETERMINISTIC. The same inputs produce byte-identical JSON, in any
//      array order, on any host. `ResumeRevision.jsonHash` is the identity of a
//      snapshot, so this is a correctness property, not a nicety.
//   2. THE x-clearance STATUS COMES FROM THE CLAIM ROW AND NOWHERE ELSE. There is no
//      parameter through which a caller could pass a status, so "a projector that lies"
//      is not a reachable state. Proven by compiling an attempt to write one.
//   3. THE ROUND TRIP: project -> JSON -> validate -> lower -> project is stable, and
//      THE BLOCK SURVIVES IT (the acceptance item).
//   4. A HAND-EDITED IMPORT CANNOT INJECT A CONFIRMED STATUS. A document whose
//      `x-clearance` block claims the confirming status lowers to exactly the same
//      inferred claim as a document with no block at all.
//   5. A LEGACY `modelVersion = 1` RESUME PROJECTS TO AN ALL-INFERRED REVISION. 05
//      sec.7.7, verbatim: "Never auto-confirm imported content."
//   6. A MIGRATION CLAIM IS NEVER SILENTLY CONFIRMED: lowering a document that was
//      produced by an OLDER confirmed claim re-reports the claim as inferred, because
//      the status is decided at write time, not read from the document.
//
// PURE FUNCTIONS THROUGHOUT: `projectResumeJson` and `lowerResumeJson` take data, not a
// store, so the whole of the above is provable with no live database. `loadProjectionInput`
// (the one function that reads) is exercised against the fake store.

import { describe, it, expect } from 'vitest';
import { ClaimProvenance, ClaimStatus, ResumeUsage, type CareerClaim } from '@prisma/client';

import {
  X_CLEARANCE_KEY,
  X_CLEARANCE_VERSION,
  canonicalJsonHash,
  canonicalJsonString,
  lowerResumeJson,
  readClearanceBlock,
  type ResumeJson,
} from './jsonresume.js';
import { validateResumeJson } from './validate.js';
import {
  PROJECTION_GENERATOR,
  ProjectionError,
  assertClearanceMatchesClaims,
  clearanceGatedUsageCount,
  legacyResumeToClaimDrafts,
  projectResumeJson,
  type ProjectionInput,
  type ProjectedClaim,
} from './project.js';
import { IMPORTED_CLAIM_PROVENANCE, IMPORTED_CLAIM_STATUS, GATED_USAGES, evaluatePreRenderGate } from '../../career/claimUsage.js';
import { claimBackedTextAt } from './claimSurface.js';
import { claimFingerprint, type ClaimCreateInput } from '../../career/claims.js';
import { createClaim } from '../../career/claims.js';
import { FakeCareerStore } from '../../career/careerStore.fixtures.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let seq = 0;

/** A claim row at a given status, with a real fingerprint. */
function claim(
  status: ClaimStatus,
  overrides: Partial<CareerClaim> = {},
): CareerClaim {
  seq += 1;
  const kind = overrides.kind ?? 'achievement';
  const statement = overrides.statement ?? `Fact number ${seq}`;
  const createdAt = overrides.createdAt ?? new Date(Date.UTC(2026, 8, 1, 0, 0, seq));
  return {
    id: overrides.id ?? `clm-${String(seq).padStart(3, '0')}`,
    profileId: 'profile-1',
    kind,
    statement,
    fingerprint: overrides.fingerprint ?? claimFingerprint(kind, statement),
    experienceId: null,
    educationId: null,
    projectId: null,
    skillId: null,
    certificationId: null,
    achievementId: null,
    status,
    provenance: overrides.provenance ?? ClaimProvenance.llm_inferred,
    confidence: overrides.confidence ?? 0.7,
    inferenceMethod: overrides.inferenceMethod ?? 'jd_extract',
    producedByModel: null,
    evidenceSourceId: overrides.evidenceSourceId ?? null,
    supersedesClaimId: null,
    confirmedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    jobRelevance: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  } as unknown as CareerClaim;
}

function experienceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exp-1',
    profileId: 'profile-1',
    title: 'Staff Engineer',
    company: 'Acme',
    location: 'Berlin, Germany',
    employmentType: null,
    startDate: '2020-01',
    endDate: '2024-06',
    current: false,
    sortOrder: 0,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
    ...overrides,
  } as never;
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prj-1',
    profileId: 'profile-1',
    name: 'Ledger',
    role: 'Maintainer',
    description: 'A double-entry ledger service.',
    repoUrl: 'https://github.com/acme/ledger',
    liveUrl: null,
    tech: ['typescript', 'postgres'],
    startDate: null,
    endDate: null,
    sortOrder: 0,
    createdAt: new Date(Date.UTC(2026, 0, 2)),
    updatedAt: new Date(Date.UTC(2026, 0, 2)),
    ...overrides,
  } as never;
}

function baseInput(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    profileId: 'profile-1',
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer' },
    ...overrides,
  };
}

/** A realistic input: one work entry with two claims, one of them confirmed. */
function realisticInput(): ProjectionInput {
  // The INFERRED claim is older, so it leads the highlights - the document order is
  // chronological, which is the order a reader expects inside a role.
  const inferred = claim(ClaimStatus.inferred, {
    id: 'clm-inferred',
    statement: 'Migrated 12k accounts to Postgres',
    createdAt: new Date(Date.UTC(2026, 7, 1)),
  });
  const confirmed = claim(ClaimStatus.user_confirmed, {
    id: 'clm-confirmed',
    statement: 'Cut CI build time by 40%',
    createdAt: new Date(Date.UTC(2026, 8, 1)),
  });
  return baseInput({
    work: [
      {
        experience: experienceRow(),
        // Deliberately out of order in the INPUT: the projector must sort, or the
        // document's bytes would depend on which query returned what.
        claims: [{ claim: confirmed }, { claim: inferred }] as ProjectedClaim[],
      },
    ],
    projects: [{ project: projectRow(), claims: [] }],
  });
}

// ---------------------------------------------------------------------------
// The shape of the projection
// ---------------------------------------------------------------------------

describe('projectResumeJson produces a JSON Resume + an x-clearance block', () => {
  it('emits the JSON Resume sections and a schema-valid block', () => {
    const { document, clearance, canonical } = projectResumeJson(realisticInput());

    expect(document.basics).toEqual({ name: 'Ada Lovelace', label: 'Staff Engineer' });
    expect(document.work).toEqual([
      {
        name: 'Acme',
        position: 'Staff Engineer',
        summary: 'Berlin, Germany',
        startDate: '2020-01',
        endDate: '2024-06',
        highlights: ['Migrated 12k accounts to Postgres', 'Cut CI build time by 40%'],
      },
    ]);
    expect(document.projects?.[0]).toMatchObject({
      name: 'Ledger',
      keywords: ['typescript', 'postgres'],
      url: 'https://github.com/acme/ledger',
    });

    expect(clearance.version).toBe(X_CLEARANCE_VERSION);
    expect(clearance.generatedBy).toBe(PROJECTION_GENERATOR);
    expect(clearance.sourceModelVersion).toBe(2);
    expect(clearance.claimCount).toBe(2);
    expect(clearance.confirmedClaimCount).toBe(1);
    expect(clearance.unconfirmedClaimCount).toBe(1);
    // The whole document validates - block included - so a revision can be stored.
    expect(validateResumeJson(document).errors).toEqual([]);
    expect(canonical).toBe(canonicalJsonString(document));
  });

  it('records where each claim landed, and what text it landed as', () => {
    const { clearance } = projectResumeJson(realisticInput());
    const byId = new Map(clearance.claims.map((entry) => [entry.claimId, entry]));
    expect(byId.get('clm-confirmed')).toMatchObject({
      jsonPath: 'work[0].highlights[1]',
      usage: ResumeUsage.verbatim,
      renderedText: 'Cut CI build time by 40%',
    });
    expect(byId.get('clm-inferred')?.jsonPath).toBe('work[0].highlights[0]');
    // Sorted by claimId, so the array order does not depend on placement order.
    expect(clearance.claims.map((entry) => entry.claimId)).toEqual(['clm-confirmed', 'clm-inferred']);
  });

  it('every text-writing jsonPath is built by the SHARED claim-surface definition', () => {
    // ADR-043 decision 2: the projector and the pre-render belt must agree by
    // construction, not by two lists a human kept in step. This asserts the emitted
    // paths are exactly what `claimSurface.claimBackedTextAt` will look for - so a new
    // verbatim site cannot be added without the belt seeing it, and the drift test in
    // `claimSurface.test.ts` is checking the same surface this module writes.
    const { document, clearance } = projectResumeJson(realisticInput());
    const gated = clearance.claims
      .filter((entry) => GATED_USAGES.includes(entry.usage) && entry.jsonPath !== null)
      .map((entry) => entry.jsonPath as string)
      .sort();
    expect(gated).toEqual(
      claimBackedTextAt(document).map((entry) => entry.path).sort(),
    );
    // Spelled out, so the assertion is about the concrete strings and not only about
    // two functions agreeing with each other.
    expect(gated).toEqual(['work[0].highlights[0]', 'work[0].highlights[1]']);
  });

  it('a claim placed in the MIDDLE of a highlights run takes its POST-filter index', () => {
    // The hazard found in triage. The projector used
    // `.map((entry, i) => place(entry, `work[0].highlights[${i}]`, true)).filter(v => v !== null)`,
    // so `i` was the index BEFORE the filter dropped the claims that render nothing: a
    // later highlight was recorded one slot to the right of where its text actually is,
    // and the read-time belt - which compares the stored text's path against the block
    // entry's path - would refuse a legitimate projection as `DOCUMENT_UNAUDITED`.
    //
    // The projector was wrong, so the projector was fixed. The rule was NOT relaxed.
    const first = claim(ClaimStatus.user_confirmed, { id: 'clm-first', statement: 'First', createdAt: new Date(Date.UTC(2026, 7, 1)) });
    const skipped = claim(ClaimStatus.user_confirmed, { id: 'clm-skipped', statement: 'Considered', createdAt: new Date(Date.UTC(2026, 7, 2)) });
    const last = claim(ClaimStatus.user_confirmed, { id: 'clm-last', statement: 'Last', createdAt: new Date(Date.UTC(2026, 7, 3)) });
    const { document, clearance } = projectResumeJson(
      baseInput({
        work: [
          {
            experience: experienceRow(),
            claims: [
              { claim: first },
              { claim: skipped, usage: ResumeUsage.omitted },
              { claim: last },
            ] as ProjectedClaim[],
          },
        ],
      }),
    );
    expect(document.work?.[0]?.highlights).toEqual(['First', 'Last']);
    const byId = new Map(clearance.claims.map((entry) => [entry.claimId, entry]));
    // The old code recorded this as `work[0].highlights[2]`, a slot that does not exist.
    expect(byId.get('clm-last')?.jsonPath).toBe('work[0].highlights[1]');
    expect(byId.get('clm-skipped')).toMatchObject({ usage: ResumeUsage.omitted, jsonPath: null });
    // And the whole point: the two surfaces still agree.
    expect(claimBackedTextAt(document).map((entry) => entry.path).sort()).toEqual(
      clearance.claims
        .filter((entry) => GATED_USAGES.includes(entry.usage) && entry.jsonPath !== null)
        .map((entry) => entry.jsonPath as string)
        .sort(),
    );
  });

  it('accounts for OMITTED claims too, so the document can answer "what did you leave out?"', () => {
    // 05 sec.2.5: an inferred claim may be surfaced as a "suggestion". A block that
    // listed only what was emitted could not support that surface, and could not answer
    // the question a reviewer asks of a draft.
    const unused = claim(ClaimStatus.inferred, { id: 'clm-unused', statement: 'Knows Rust' });
    const { clearance } = projectResumeJson(baseInput({ otherClaims: [{ claim: unused }] }));
    expect(clearance.claims).toHaveLength(1);
    expect(clearance.claims[0]).toMatchObject({
      claimId: 'clm-unused',
      usage: ResumeUsage.omitted,
      jsonPath: null,
      renderedText: null,
    });
    expect(clearanceGatedUsageCount(clearance)).toBe(0);
  });

  it('supports a `tailored` claim, whose text differs from its statement', () => {
    // 05 sec.6.3: tailoring may re-phrase a CONFIRMED claim's text; the claim is the
    // source of the facts and the usage says the phrasing was changed.
    const confirmed = claim(ClaimStatus.user_confirmed, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
    const { document, clearance } = projectResumeJson(
      baseInput({
        work: [
          {
            experience: experienceRow(),
            claims: [
              { claim: confirmed, usage: ResumeUsage.tailored, renderedText: 'Shrank CI from 30 to 18 minutes' },
            ] as ProjectedClaim[],
          },
        ],
      }),
    );
    expect(document.work?.[0].highlights).toEqual(['Shrank CI from 30 to 18 minutes']);
    expect(clearance.claims[0]).toMatchObject({
      usage: ResumeUsage.tailored,
      renderedText: 'Shrank CI from 30 to 18 minutes',
    });
    // The CLAIM's statement is unchanged in the database - only the phrasing in the
    // document moved. That is the whole distinction between `verbatim` and `tailored`
    // (05 sec.6.3), and it is what the gate reads.
    expect(confirmed.statement).toBe('Cut CI build time by 40%');
  });

  it('omits the end date of a CURRENT role rather than emitting an empty string', () => {
    // JSON Resume's convention for "still there" is an absent endDate. `endDate: ''`
    // renders as "2020 - " in most themes, which is a lie about the timeline.
    const { document } = projectResumeJson(
      baseInput({
        work: [
          {
            experience: experienceRow({ current: true, endDate: '2024-06' }),
            claims: [],
          },
        ],
      }),
    );
    expect(document.work?.[0]).not.toHaveProperty('endDate');
  });

  it('degrades a malformed column to "absent" instead of poisoning the document', () => {
    // `Project.tech` is a Json column with no schema on it. A malformed value must not
    // put a non-string into `keywords`, which would fail validation and lose the WHOLE
    // document over one bad column.
    const { document } = projectResumeJson(
      baseInput({
        projects: [{ project: projectRow({ tech: 'typescript' }), claims: [] }],
      }),
    );
    expect(document.projects?.[0]).not.toHaveProperty('keywords');
    expect(validateResumeJson(document).valid).toBe(true);
  });

  it('refuses a malformed input rather than emitting a document with no name', () => {
    for (const bad of [null, 'x', 42]) {
      expect(() => projectResumeJson(bad as never)).toThrowError(ProjectionError);
    }
    expect(() => projectResumeJson({ profileId: '', basics: { name: 'x' } })).toThrowError(
      /non-empty profileId/,
    );
    expect(() => projectResumeJson({ profileId: 'p' } as never)).toThrowError(/basics is required/);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE: the status is derived from the claim row
// ---------------------------------------------------------------------------

describe('ACCEPTANCE: the x-clearance status is DERIVED from the claim row', () => {
  it('reports every status truthfully, in the block', () => {
    const claims = [
      claim(ClaimStatus.inferred, { id: 'clm-1' }),
      claim(ClaimStatus.contextual, { id: 'clm-2' }),
      claim(ClaimStatus.user_confirmed, { id: 'clm-3' }),
      claim(ClaimStatus.rejected, { id: 'clm-4' }),
      claim(ClaimStatus.superseded, { id: 'clm-5' }),
    ];
    const { clearance } = projectResumeJson(
      baseInput({ otherClaims: claims.map((c) => ({ claim: c, usage: ResumeUsage.omitted })) }),
    );
    expect(clearance.claims.map((entry) => [entry.claimId, entry.status])).toEqual([
      ['clm-1', ClaimStatus.inferred],
      ['clm-2', ClaimStatus.contextual],
      ['clm-3', ClaimStatus.user_confirmed],
      ['clm-4', ClaimStatus.rejected],
      ['clm-5', ClaimStatus.superseded],
    ]);
    expect(clearance.confirmedClaimCount).toBe(1);
    expect(clearance.unconfirmedClaimCount).toBe(4);
  });

  it('a caller CANNOT pass a status: the input type has no such member', () => {
    // The compile-time half. A `status` member on `ProjectedClaim` would let a caller
    // decide what the document says a claim is; there is none, so the only source of a
    // status is the claim row. `npx tsc --noEmit` is what checks the `@ts-expect-error`
    // below - vitest does not, and the runtime half is the next assertion.
    const claimRow = claim(ClaimStatus.inferred, { id: 'clm-1', statement: 'Fact' });
    const forged: ProjectedClaim = {
      claim: claimRow,
      usage: ResumeUsage.verbatim,
      // @ts-expect-error `ProjectedClaim` has no `status`: the block's status is read
      // from the claim row, so a caller cannot assert one.
      status: ClaimStatus.user_confirmed,
    };

    const { clearance } = projectResumeJson(
      baseInput({ work: [{ experience: experienceRow(), claims: [forged] }] }),
    );
    // The runtime half: the field is simply never read, so even a caller who defeated
    // the compiler (a route body, an `as any`) cannot make the document lie.
    expect(clearance.claims[0].status).toBe(ClaimStatus.inferred);
  });

  it('assertClearanceMatchesClaims catches a projector that started lying', () => {
    // The post-condition. `projectResumeJson` cannot produce a mismatch (the status is
    // copied from the row), so this exists to catch a FUTURE edit that derives the
    // status from somewhere else - the failure it would catch is the one that matters.
    const claims = [claim(ClaimStatus.inferred, { id: 'clm-1' })];
    const { clearance } = projectResumeJson(
      baseInput({ otherClaims: [{ claim: claims[0], usage: ResumeUsage.omitted }] }),
    );
    expect(() => assertClearanceMatchesClaims(clearance, claims)).not.toThrow();

    const lying = { ...clearance, claims: [{ ...clearance.claims[0], status: ClaimStatus.user_confirmed }] };
    expect(() => assertClearanceMatchesClaims(lying, claims)).toThrowError(/but the claim row says/);
    expect(() =>
      assertClearanceMatchesClaims(clearance, [claim(ClaimStatus.inferred, { id: 'clm-other' })]),
    ).toThrowError(/not among the projected claims/);
  });

  it('a hand-edited block cannot make a projection lie: the row wins', () => {
    // The document-side half of the same property. Editing a stored revision's block
    // does not change what a re-projection says, because the projection never reads the
    // old document.
    const first = projectResumeJson(realisticInput());
    const forged: ResumeJson = {
      ...first.document,
      [X_CLEARANCE_KEY]: {
        ...first.clearance,
        claims: first.clearance.claims.map((entry) => ({ ...entry, status: ClaimStatus.user_confirmed })),
      },
    };
    const { clearance } = projectResumeJson(realisticInput());
    expect(forged[X_CLEARANCE_KEY]?.claims.every((entry) => entry.status === ClaimStatus.user_confirmed)).toBe(true);
    // ...and the truth is unchanged, because it was never derived from `forged`.
    expect(clearance.claims.find((entry) => entry.claimId === 'clm-inferred')?.status).toBe(
      ClaimStatus.inferred,
    );
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE (defect round, F3): a REJECTED claim is ACCOUNTED FOR, never RENDERED
// ---------------------------------------------------------------------------

describe('ACCEPTANCE (F3): a REJECTED claim is recorded as omitted and placed nowhere', () => {
  /**
   * The state the defect is about: the claim is ATTACHED to an experience and its status is
   * `rejected`. `loadProjectionInput` loads every claim of the profile with no status filter,
   * and `rejectUserClaim` writes only `status` - so attach-then-reject (which T1054's
   * reject-then-attach rule does not cover) is exactly this input, and the projector used to
   * put the statement into `work[0].highlights` as `verbatim` and hand it back to the client
   * from `POST /resumes/:id/project`.
   */
  function attachedRejectedInput(): ProjectionInput {
    const rejected = claim(ClaimStatus.rejected, {
      id: 'clm-rejected',
      statement: 'Never happened',
      experienceId: 'exp-1',
    });
    return baseInput({
      work: [{ experience: experienceRow(), claims: [{ claim: rejected }] as ProjectedClaim[] }],
    });
  }

  it('appears in the block as `omitted` with no jsonPath, and NOT in work[].highlights', () => {
    const { document, clearance } = projectResumeJson(attachedRejectedInput());

    // ACCOUNTED FOR: the claim is still in the document's own list - dropped silently, or
    // removed from the block, would leave 05 sec.2.5's "what did you leave out?"
    // unanswerable, and would make `claimCount` a lie.
    expect(clearance.claims).toHaveLength(1);
    expect(clearance.claims[0]).toMatchObject({
      claimId: 'clm-rejected',
      // The status is still the row's - this fix changes the USAGE, never the status.
      status: ClaimStatus.rejected,
      usage: ResumeUsage.omitted,
      jsonPath: null,
      renderedText: null,
    });
    expect(clearance.claimCount).toBe(1);
    expect(clearance.confirmedClaimCount).toBe(0);
    expect(clearance.unconfirmedClaimCount).toBe(1);

    // NOT RENDERED: the work entry survives, with no `highlights` member at all rather than
    // an empty one, and the rejected statement appears nowhere in the serialised document.
    const work = document.work!;
    expect(work[0]).toMatchObject({ name: 'Acme', position: 'Staff Engineer' });
    expect(work[0].highlights).toBeUndefined();
    const canonical = canonicalJsonString(document);
    expect(canonical).not.toContain('Never happened');
    expect(canonical).not.toContain('highlights');

    // ...and the document is still storable: a revision writer can record this usage, which
    // is the other half of F1.
    expect(validateResumeJson(document).errors).toEqual([]);
  });

  it('an explicit `verbatim` usage cannot override it - the projector decides, not the caller', () => {
    // `ProjectedClaim.usage` is an optional caller hint. A rejected claim is refused as
    // rendered text whichever way it is asked for, because the ruling is "the projector must
    // never place a rejected claim as rendered text" - not "must not place one by default".
    const rejected = claim(ClaimStatus.rejected, {
      id: 'clm-rejected',
      statement: 'Never happened',
      experienceId: 'exp-1',
    });
    const { document, clearance } = projectResumeJson(
      baseInput({
        work: [
          {
            experience: experienceRow(),
            claims: [
              { claim: rejected, usage: ResumeUsage.verbatim, renderedText: 'Never happened' },
            ] as ProjectedClaim[],
          },
        ],
      }),
    );
    expect(clearance.claims[0]).toMatchObject({ usage: ResumeUsage.omitted, jsonPath: null });
    expect(document.work![0].highlights).toBeUndefined();
  });

  it('a `superseded` claim is UNCHANGED - still placed, and refused by the gate instead', () => {
    // Stated rather than assumed, because the tempting version of this fix is "any claim
    // that is not renderable is omitted", which would delete ADR-036 item 6's demonstration
    // of the gate: the projector would never place anything the gate could refuse, so the
    // pre-render gate would have nothing to block and no test could show it working.
    // `superseded` is ADR-036's "replaced by a newer claim" - still part of the profile, and
    // its text is real - so it is placed, and `evaluatePreRenderGate` answers
    // `CLAIM_NOT_CONFIRMED`.
    const superseded = claim(ClaimStatus.superseded, {
      id: 'clm-superseded',
      statement: 'Shipped the old ledger',
      experienceId: 'exp-1',
    });
    const { document, clearance } = projectResumeJson(
      baseInput({
        work: [{ experience: experienceRow(), claims: [{ claim: superseded }] as ProjectedClaim[] }],
      }),
    );
    expect(document.work![0].highlights).toEqual(['Shipped the old ledger']);
    expect(clearance.claims[0]).toMatchObject({
      status: ClaimStatus.superseded,
      usage: ResumeUsage.verbatim,
      jsonPath: 'work[0].highlights[0]',
    });
    // ...and the gate still blocks it, with the machine reason, on the placed text.
    const verdict = evaluatePreRenderGate(
      clearance.claims.map((entry) => ({
        claimId: entry.claimId,
        usage: entry.usage,
        claimStatus: entry.status,
      })),
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe('CLAIM_NOT_CONFIRMED');
      expect(verdict.violations[0].status).toBe(ClaimStatus.superseded);
    }
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE: determinism
// ---------------------------------------------------------------------------

describe('ACCEPTANCE: the projection is DETERMINISTIC (jsonHash is stable)', () => {
  it('repeated projections of the same data are byte-identical', () => {
    const a = projectResumeJson(realisticInput());
    const b = projectResumeJson(realisticInput());
    expect(canonicalJsonString(b.document)).toBe(a.canonical);
    expect(canonicalJsonHash(b.document)).toBe(canonicalJsonHash(a.document));
  });

  it('is independent of the ORDER the claims arrive in', () => {
    const forward = realisticInput();
    const reversed: ProjectionInput = {
      ...forward,
      work: [
        {
          experience: experienceRow(),
          claims: [...(forward.work![0].claims)].reverse() as ProjectedClaim[],
        },
      ],
    };
    // The HIGHLIGHTS order follows the claim's own `createdAt`, not the array order, so
    // two loads of the same profile cannot produce two different documents.
    expect(canonicalJsonString(projectResumeJson(reversed).document)).toBe(
      projectResumeJson(forward).canonical,
    );
  });

  it('is independent of the order ENTITIES arrive in', () => {
    const one = projectRow({ id: 'prj-1', name: 'A', sortOrder: 0 });
    const two = projectRow({ id: 'prj-2', name: 'B', sortOrder: 1 });
    const forward = baseInput({
      projects: [
        { project: one, claims: [] },
        { project: two, claims: [] },
      ],
    });
    const reversed = baseInput({
      projects: [
        { project: two, claims: [] },
        { project: one, claims: [] },
      ],
    });
    // `sortOrder` is the user's explicit ordering, so it wins over arrival order - and
    // ties break on `id`, which is a total order and therefore still deterministic.
    expect(projectResumeJson(reversed).canonical).toBe(projectResumeJson(forward).canonical);
  });

  it('the hash CHANGES when a claim statement changes', () => {
    const before = projectResumeJson(realisticInput());
    const after = projectResumeJson(
      baseInput({
        work: [
          {
            experience: experienceRow(),
            claims: [
              { claim: claim(ClaimStatus.inferred, { id: 'clm-inferred', statement: 'Migrated 12k accounts to MySQL' }) },
              { claim: claim(ClaimStatus.user_confirmed, { id: 'clm-confirmed', statement: 'Cut CI build time by 40%' }) },
            ] as ProjectedClaim[],
          },
        ],
      }),
    );
    expect(canonicalJsonHash(after.document)).not.toBe(canonicalJsonHash(before.document));
  });

  it('the hash CHANGES when only a STATUS changes - the audit depends on that', () => {
    // 05 sec.6.5: "this resume used claim X, which was later rejected" must be
    // derivable from the snapshots. If the block did not carry the status, two
    // documents with identical text would hash identically and the movement would be
    // invisible.
    const before = projectResumeJson(
      baseInput({ otherClaims: [{ claim: claim(ClaimStatus.inferred, { id: 'clm-1', statement: 'Fact' }), usage: ResumeUsage.omitted }] }),
    );
    const after = projectResumeJson(
      baseInput({ otherClaims: [{ claim: claim(ClaimStatus.user_confirmed, { id: 'clm-1', statement: 'Fact' }), usage: ResumeUsage.omitted }] }),
    );
    expect(canonicalJsonString(after.document)).not.toBe(canonicalJsonString(before.document));
    expect(after.clearance.unconfirmedClaimCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE: the round trip, with the block intact
// ---------------------------------------------------------------------------

describe('ACCEPTANCE: project -> JSON -> lower -> project round-trips with the block', () => {
  it('the block SURVIVES the whole cycle and the second document is identical', () => {
    const original = realisticInput();
    const first = projectResumeJson(original);

    // 1. Serialise and validate - the wire format, and the check a route applies before
    //    it will store or render anything.
    const wire = JSON.parse(canonicalJsonString(first.document)) as ResumeJson;
    expect(validateResumeJson(wire).valid).toBe(true);

    // 2. Lower it back. The block comes through as `xClearance`, unchanged.
    const lowered = lowerResumeJson(wire);
    expect(lowered.xClearance).toEqual(first.clearance);
    expect(readClearanceBlock(wire)).toEqual(first.clearance);

    // 3. Re-project from the LOWERED CONTENT, with the claim rows the lower pointed at.
    //    This is what an import-then-reproject cycle actually does, and it is where the
    //    document can drift if the two directions disagree.
    const rebuilt: ProjectedClaim[] = lowered.claims
      .filter((draft) => draft.sourceClaimId !== null)
      .map((draft) => {
        const original_ = original.work![0].claims.find(
          (entry) => entry.claim.id === draft.sourceClaimId,
        )!;
        // The SAME claim row, so the status is the row's - not the draft's, and not the
        // block's. This is the round trip's whole point.
        return { claim: original_.claim, usage: original_.usage ?? ResumeUsage.verbatim };
      });
    const second = projectResumeJson({
      ...original,
      work: [{ experience: original.work![0].experience, claims: rebuilt }],
    });

    // The BLOCK is intact: same version, same generator, same statuses, same paths, same
    // rendered text - and the document hashes identically, so it is the same revision.
    expect(second.clearance).toEqual(first.clearance);
    expect(canonicalJsonString(second.document)).toBe(first.canonical);
    expect(canonicalJsonHash(second.document)).toBe(canonicalJsonHash(first.document));
  });

  it('a hand-edited document cannot inject a confirmed status through the round trip', () => {
    // The acceptance item, stated as an attack. Take a document that claims everything
    // is confirmed, forge the block, lower it, and ask what comes out.
    const first = projectResumeJson(realisticInput());
    const forged: ResumeJson = {
      ...first.document,
      [X_CLEARANCE_KEY]: {
        ...first.clearance,
        claims: first.clearance.claims.map((entry) => ({ ...entry, status: ClaimStatus.user_confirmed })),
      },
    };
    // Also forge a status smuggled onto a highlight object, which a naive importer
    // might read.
    const withSmuggled = JSON.parse(JSON.stringify(forged)) as ResumeJson;
    (withSmuggled.work as unknown as Array<Record<string, unknown>>)[0].status =
      ClaimStatus.user_confirmed;

    const lowered = lowerResumeJson(withSmuggled);
    // NOT ONE claim is confirmed. The import status is a hard-coded constant; the block
    // is carried forward as a RECORD, never as an authority.
    expect(lowered.claims.length).toBeGreaterThan(0);
    for (const draft of lowered.claims) {
      expect(draft.status).toBe(IMPORTED_CLAIM_STATUS);
      expect(draft.provenance).toBe(IMPORTED_CLAIM_PROVENANCE);
    }
    // And the forged block is still visibly forged to a reader - it is preserved so the
    // discrepancy is auditable, not erased.
    expect(lowered.xClearance?.claims.every((entry) => entry.status === ClaimStatus.user_confirmed)).toBe(true);
  });

  it('persisting a lowered document writes ONLY inferred claims, through createClaim', async () => {
    // The end-to-end version of the same property, against the real dedupe point. The
    // store is the fake; the writer is the production one.
    const store = new FakeCareerStore();
    const forged = {
      basics: { name: 'Mallory' },
      work: [
        {
          name: 'Globex',
          position: 'CFO',
          highlights: ['Recovered the M&A portfolio', 'Filed 10-Ks on time'],
        },
      ],
      'x-clearance': {
        version: X_CLEARANCE_VERSION,
        generatedBy: 'forged',
        sourceModelVersion: 2,
        profileId: 'profile-1',
        claimCount: 2,
        confirmedClaimCount: 2,
        unconfirmedClaimCount: 0,
        claims: [
          { claimId: 'clm-a', statement: 'Recovered the M&A portfolio', status: 'user_confirmed', renderedText: 'Recovered the M&A portfolio' },
          { claimId: 'clm-b', statement: 'Filed 10-Ks on time', status: 'user_confirmed', renderedText: 'Filed 10-Ks on time' },
        ],
      },
    };
    const lowered = lowerResumeJson(forged);
    for (const draft of lowered.claims) {
      const input: ClaimCreateInput = {
        profileId: 'profile-1',
        kind: draft.kind,
        statement: draft.statement,
        status: draft.status,
        provenance: draft.provenance,
        inferenceMethod: draft.inferenceMethod,
        evidenceSourceId: null,
      };
      await createClaim(input, store.asStore());
    }

    const rows = store.claimsFor('profile-1');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe(ClaimStatus.inferred);
      expect(row.provenance).toBe(ClaimProvenance.document_import);
    }
    // Not one ClaimVerification row: nothing confirmed anything.
    expect(store.verifications.size).toBe(0);
  });

  it('a document with NO block lowers to exactly the same claims as a forged one', () => {
    const bare = {
      basics: { name: 'Mallory' },
      work: [{ name: 'Globex', position: 'CFO', highlights: ['Recovered the M&A portfolio'] }],
    };
    const withForgedBlock = {
      ...bare,
      'x-clearance': {
        version: X_CLEARANCE_VERSION,
        generatedBy: 'forged',
        sourceModelVersion: 2,
        profileId: 'p',
        claimCount: 1,
        confirmedClaimCount: 1,
        unconfirmedClaimCount: 0,
        claims: [
          { claimId: 'clm-a', statement: 'Recovered the M&A portfolio', status: 'user_confirmed', renderedText: 'Recovered the M&A portfolio' },
        ],
      },
    };
    // The only difference a forged block can make is `sourceClaimId` - identity, which
    // is exactly the field a re-import legitimately uses to reconcile. The STATUS and
    // the PROVENANCE are byte-identical.
    const strip = (lowered: ReturnType<typeof lowerResumeJson>) =>
      lowered.claims.map(({ sourceClaimId: _id, ...rest }) => rest);
    expect(strip(lowerResumeJson(withForgedBlock))).toEqual(strip(lowerResumeJson(bare)));
    // ...and the identity it does grant is recorded, so the discrepancy is auditable.
    expect(lowerResumeJson(withForgedBlock).claims[0].sourceClaimId).toBe('clm-a');
    expect(lowerResumeJson(bare).claims[0].sourceClaimId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What lowering produces
// ---------------------------------------------------------------------------

describe('lowerResumeJson lowers a plain JSON Resume into claim drafts', () => {
  it('turns every highlight, keyword, skill and credential into a claim draft', () => {
    const lowered = lowerResumeJson({
      basics: { name: 'Ada', email: 'ada@example.com', summary: 'Mathematician' },
      work: [
        { name: 'Acme', position: 'Engineer', startDate: '2020-01', endDate: '2022-01', highlights: ['Did a thing', 'Did another'] },
        { name: 'Globex', position: 'Lead', highlights: ['Led a team'] },
      ],
      education: [{ institution: 'Cambridge', studyType: 'BSc', area: 'Maths' }],
      projects: [{ name: 'Ledger', description: 'Double entry', highlights: ['Shipped it'], keywords: ['typescript'] }],
      skills: [{ name: 'TypeScript', level: 'expert', keywords: ['node'] }],
      certificates: [{ name: 'AWS SAA', issuer: 'Amazon' }],
    });

    expect(lowered.basics).toMatchObject({ name: 'Ada', email: 'ada@example.com', summary: 'Mathematician' });
    // `endDate` absent on JSON Resume means "current" - the only signal the format has.
    expect(lowered.work[1].current).toBe(true);
    expect(lowered.work[0].current).toBe(false);
    expect(lowered.claims.map((draft) => [draft.kind, draft.statement])).toEqual([
      ['achievement', 'Did a thing'],
      ['achievement', 'Did another'],
      ['achievement', 'Led a team'],
      ['education', 'BSc in Maths (Cambridge)'],
      ['project', 'Double entry'],
      ['achievement', 'Shipped it'],
      ['technology', 'typescript'],
      ['skill', 'TypeScript'],
      ['technology', 'node'],
      ['certification', 'AWS SAA (Amazon)'],
    ]);
    // Every draft is inferred, with the import constants, and carries where it came from.
    for (const draft of lowered.claims) {
      expect(draft.status).toBe(IMPORTED_CLAIM_STATUS);
      expect(draft.provenance).toBe(IMPORTED_CLAIM_PROVENANCE);
      expect(draft.inferenceMethod).toBe('json_resume_import');
      expect(draft.jsonPath).toMatch(/^\w+\[\d+\]/);
      expect(draft.sourceClaimId).toBeNull();
    }
  });

  it('does NOT make a claim out of a phone number or a job title', () => {
    // Gating contact details would make the invariant meaningless: a phone number is
    // not a career assertion. Only STATEMENTS become claims.
    const lowered = lowerResumeJson({
      basics: { name: 'Ada', phone: '+44 20 7946 0000', email: 'ada@example.com', url: 'https://ada.dev' },
    });
    expect(lowered.claims).toEqual([]);
    expect(lowered.basics.phone).toBe('+44 20 7946 0000');
  });

  it('reports sections the canonical model cannot represent, rather than dropping them', () => {
    const lowered = lowerResumeJson({
      basics: { name: 'Ada' },
      awards: [{ title: 'Fellowship' }],
      publications: [{ name: 'Note G', publisher: 'Memoirs' }],
      languages: [{ language: 'English' }],
      interests: [{ name: 'Poetry' }],
      references: [{ name: 'Babbage' }],
      volunteer: [{ organization: 'Royal Society', position: 'Member' }],
    });
    // Six sections, none of which has an entity in the V2 schema (05 sec.5). Silently
    // dropping a section the user wrote is how a resume loses content without anyone
    // noticing; reporting it lets the caller tell the user.
    expect(lowered.unsupported.map((entry) => entry.section).sort()).toEqual([
      'awards',
      'interests',
      'languages',
      'publications',
      'references',
      'volunteer',
    ]);
    expect(lowered.unsupported.every((entry) => entry.reason === 'no_canonical_entity')).toBe(true);
    expect(lowered.unsupported.every((entry) => entry.entries === 1)).toBe(true);
  });

  it('degrades a hostile or sloppy document to something reviewable, not an exception', () => {
    // Structural validity is `validate.ts`'s job and a route runs it first. Lowering
    // still tolerates junk so a direct caller gets a partial result rather than a throw
    // halfway through, which would leave the caller unable to tell what landed.
    const lowered = lowerResumeJson({
      basics: 'not an object',
      work: ['not an object', { name: 'Acme' }, { name: 'Acme', position: 'Eng', highlights: 'nope' }],
      education: null,
      skills: [{ name: '' }],
    });
    expect(lowered.basics.name).toBe('');
    expect(lowered.work).toHaveLength(1);
    expect(lowered.work[0].highlights).toEqual([]);
    expect(lowered.skills).toEqual([]);
    expect(lowered.claims).toEqual([]);
  });

  it('reconciles with a document we produced, by claim identity', () => {
    // Re-importing our own export must dedupe against the existing claims rather than
    // forking duplicates. `sourceClaimId` is IDENTITY, not status: it is looked up by
    // RENDERED TEXT, which the gate and the evidence browser both surface.
    const first = projectResumeJson(realisticInput());
    const lowered = lowerResumeJson(first.document);
    const byStatement = new Map(lowered.claims.map((draft) => [draft.statement, draft]));
    expect(byStatement.get('Cut CI build time by 40%')?.sourceClaimId).toBe('clm-confirmed');
    expect(byStatement.get('Migrated 12k accounts to Postgres')?.sourceClaimId).toBe('clm-inferred');
    // Identity never confers status.
    expect(byStatement.get('Cut CI build time by 40%')?.status).toBe(IMPORTED_CLAIM_STATUS);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE: a legacy modelVersion 1 resume projects to an all-inferred revision
// ---------------------------------------------------------------------------

describe('ACCEPTANCE: a legacy (modelVersion 1) Resume projects to an ALL-INFERRED revision', () => {
  const LEGACY = {
    id: 'res-legacy',
    modelVersion: 1,
    profileId: null,
    name: 'My Old Resume',
    personalInfo: { fullName: 'Grace Hopper', email: 'grace@example.com', phone: '', location: 'New York' },
    summary: 'Invented the compiler.',
    experience: [
      {
        title: 'Rear Admiral',
        company: 'US Navy',
        startDate: '1944',
        endDate: '1966',
        bullets: ['Designed the COBOL compiler', 'Led a team of 80'],
      },
    ],
    education: [],
    skills: ['COBOL', 'COBOL', 'Fortran'],
  };

  it('every backfill draft is inferred with document_import provenance', () => {
    // 05 sec.7.7, verbatim: "`experience[].bullets` become claims with `status = inferred`,
    // `provenance = document_import` ... Never auto-confirm imported content."
    const drafts = legacyResumeToClaimDrafts(LEGACY);
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.status).toBe(IMPORTED_CLAIM_STATUS);
      expect(draft.provenance).toBe(IMPORTED_CLAIM_PROVENANCE);
      expect(draft.inferenceMethod).toBe('legacy_resume_backfill');
    }
    expect(drafts.map((draft) => [draft.kind, draft.statement])).toEqual([
      ['role', 'Rear Admiral at US Navy'],
      ['achievement', 'Designed the COBOL compiler'],
      ['achievement', 'Led a team of 80'],
      ['skill', 'COBOL'],
      ['skill', 'COBOL'],
      ['skill', 'Fortran'],
      ['soft_skill', 'Invented the compiler.'],
    ]);
  });

  it('the duplicate skill in the legacy row is drafted per entry and dedupes on import', async () => {
    // The legacy builder stored `skills` as a flat string array, so duplicates are
    // common. The drafts are NOT pre-deduplicated - the fingerprint is the claim layer's
    // identity and there is exactly one implementation of it - so `createClaim` dedupes
    // on `(profileId, fingerprint)` and the repeat is a no-op. That is why a backfill can
    // write unconditionally without a dedupe pass of its own.
    const drafts = legacyResumeToClaimDrafts(LEGACY);
    expect(drafts.filter((draft) => draft.statement === 'COBOL')).toHaveLength(2);

    const store = new FakeCareerStore();
    const outcomes: string[] = [];
    for (const draft of drafts) {
      const result = await createClaim(
        {
          profileId: 'profile-1',
          kind: draft.kind,
          statement: draft.statement,
          status: draft.status,
          provenance: draft.provenance,
          inferenceMethod: draft.inferenceMethod,
        },
        store.asStore(),
      );
      outcomes.push(result.outcome);
    }
    // Seven drafts, six distinct statements, six rows, one no-op - and the no-op wrote
    // NOTHING, so the repeat could not have touched the existing row's status.
    expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(6);
    expect(outcomes.filter((outcome) => outcome === 'deduped')).toHaveLength(1);
    expect(store.claimsFor('profile-1')).toHaveLength(6);
    for (const row of store.claimsFor('profile-1')) {
      expect(row.status).toBe(ClaimStatus.inferred);
      expect(row.provenance).toBe(ClaimProvenance.document_import);
    }
  });

  it('the projected revision is ALL-INFERRED, and the gate therefore blocks it', async () => {
    // The full acceptance chain, end to end: legacy row -> drafts -> claims -> a
    // projection -> a revision. Every claim in the block is inferred, and the gate
    // refuses it, which is precisely the "honest state" 05 sec.7.7 asks for.
    const store = new FakeCareerStore();
    const drafts = legacyResumeToClaimDrafts(LEGACY);
    const rows: CareerClaim[] = [];
    for (const draft of drafts) {
      const result = await createClaim(
        {
          profileId: 'profile-1',
          kind: draft.kind,
          statement: draft.statement,
          status: draft.status,
          provenance: draft.provenance,
          inferenceMethod: draft.inferenceMethod,
        },
        store.asStore(),
      );
      // The duplicate `COBOL` skill dedupes; every distinct statement is created.
      if (result.outcome === 'created') rows.push(result.claim);
    }
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.status).toBe(ClaimStatus.inferred);
    }

    const { document, clearance } = projectResumeJson({
      profileId: 'profile-1',
      basics: {
        name: LEGACY.personalInfo.fullName,
        email: LEGACY.personalInfo.email,
        location: { city: LEGACY.personalInfo.location },
        summary: LEGACY.summary,
      },
      sourceModelVersion: 1,
      work: [
        {
          experience: experienceRow({
            id: 'exp-legacy',
            title: LEGACY.experience[0].title,
            company: LEGACY.experience[0].company,
            location: null,
            startDate: LEGACY.experience[0].startDate,
            endDate: LEGACY.experience[0].endDate,
          }),
          claims: rows
            .filter((row) => row.kind === 'achievement')
            .map((row) => ({ claim: row, usage: ResumeUsage.verbatim }) as ProjectedClaim),
        },
      ],
      skills: ['COBOL', 'Fortran'].map((name, index) => ({
        skill: {
          id: `skl-${index}`,
          profileId: 'profile-1',
          name,
          normalized: name.toLowerCase(),
          category: null,
          level: null,
          sortOrder: index,
        } as never,
        claims: rows
          .filter((row) => row.kind === 'skill' && row.statement === name)
          .map((row) => ({ claim: row, usage: ResumeUsage.omitted }) as ProjectedClaim),
      })),
    });

    // sourceModelVersion 1 is RECORDED, so a renderer knows which shape it came from.
    expect(clearance.sourceModelVersion).toBe(1);
    expect(clearance.confirmedClaimCount).toBe(0);
    expect(clearance.unconfirmedClaimCount).toBe(clearance.claimCount);
    for (const entry of clearance.claims) {
      expect(entry.status).toBe(ClaimStatus.inferred);
    }
    expect(validateResumeJson(document).valid).toBe(true);

    // And the gate blocks it, because the usage is `verbatim` on inferred claims.
    const { evaluatePreRenderGate } = await import('../../career/claimUsage.js');
    const verdict = evaluatePreRenderGate(
      clearance.claims.map((entry) => ({
        claimId: entry.claimId,
        usage: entry.usage,
        claimStatus: entry.status,
      })),
    );
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).toBe('CLAIM_NOT_CONFIRMED');
    expect(verdict.violations).toHaveLength(clearanceGatedUsageCount(clearance));
  });
});
