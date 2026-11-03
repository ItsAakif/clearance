// tailor/apply.test.ts - THE FOLD, and what it hands to the ONE revision writer (T1080;
// 06 sec.E.3 "Derived-variant semantics" / "Before/after diff UX").
//
// THE THREE PROPERTIES THAT MATTER, IN THE ORDER THEY ARE TESTED:
//   1. THE LEDGER MOVES WITH THE TEXT. A rewrite that changed `work[0].highlights[0]` without
//      moving the `x-clearance` entry that names it would produce a document the pre-render
//      belt refuses (`DOCUMENT_UNAUDITED`, rule 5) - and, worse, one that LOOKS right in a
//      diff view. This is the hard part of tailoring and it is what most of these tests are.
//   2. A REFUSED OPERATION IS RECORDED AND NOT APPLIED, with `accepted: false` and the
//      validator's code in the reason, and the document is byte-identical.
//   3. THE RESULT GOES THROUGH `createRevision`, so a tailored revision is a peer of a
//      Studio autosave: the belt runs, the parent's row is not written to, and the snapshot is
//      immutable. `FakeCareerStore` records every call, so "revision N was not touched" is an
//      observation rather than an inference.

import { describe, it, expect } from 'vitest';
import {
  ClaimKind,
  ClaimStatus,
  ResumeChangeSource,
  type CareerClaim,
  type ResumeRevision,
} from '@prisma/client';

import { applyOperations, applySummary, type ReviewedOperation } from './apply.js';
import { parseOperation, type TailorOperation } from './ops.js';
import { validate, type ValidationContext } from './validate.js';
import { claimFingerprint } from '../career/claims.js';
import { projectResumeJson } from '../resume/json/project.js';
import { canonicalJsonHash, readClearanceBlock, type ResumeJson } from '../resume/json/jsonresume.js';
import {
  assertRevisionRenderableInScope,
  createRevision,
  type ResumeRevisionStore,
} from '../resume/revisions.js';
import {
  FakeCareerStore,
  fakeClaimAtStatus,
  seedRevision,
} from '../career/careerStore.fixtures.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Every entity row in these fixtures carries the same timestamp, so the projector's total order is a function of the id alone. */
const EXP_AT = new Date('2026-09-01T00:00:00.000Z');

const BULLET = 'Cut CI build time by 40% by caching the dependency layer';

function claim(
  id: string,
  statement: string,
  status: ClaimStatus = ClaimStatus.user_confirmed,
  kind: ClaimKind = ClaimKind.achievement,
): CareerClaim {
  return {
    id,
    profileId: 'profile-1',
    kind,
    statement,
    fingerprint: claimFingerprint(kind, statement),
    experienceId: null,
    educationId: null,
    projectId: null,
    skillId: null,
    certificationId: null,
    achievementId: null,
    status,
    provenance: 'document_import',
    confidence: null,
    evidenceSourceId: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  } as unknown as CareerClaim;
}

const CLAIMS = [
  claim('clm-bullet', BULLET),
  claim('clm-omitted', 'Migrated 12k accounts to Postgres'),
  claim('clm-summary', 'A decade of platform work.', ClaimStatus.user_confirmed, 'soft_skill'),
  claim('clm-inferred', 'Ran the platform on Kubernetes', ClaimStatus.inferred),
  // A SECOND confirmed, `omitted` claim. Load-bearing for the one-slot test: "two `include`s
  // at one slot" needs two claims that are each individually legal there, which is exactly the
  // shape that used to validate twice and promote twice. One omitted claim could not express it.
  claim('clm-omitted-2', 'Cut the CI build time by 42% by caching the dependency layer (r2)'),
];

/** The before-state: a projection with one placed bullet and one placed summary. */
function fixtureDocument(): ResumeJson {
  return projectResumeJson({
    profileId: 'profile-1',
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer' },
    summaryClaims: [{ claim: CLAIMS[2] as CareerClaim }],
    work: [
      {
        experience: { id: 'exp-0', profileId: 'profile-1', employmentType: null, createdAt: EXP_AT, updatedAt: EXP_AT,
          company: 'Acme',
          title: 'Staff Engineer',
          location: null,
          startDate: '2020-01',
          endDate: null,
          current: true,
          sortOrder: 0,
        },
        claims: [{ claim: CLAIMS[0] as CareerClaim }],
      },
      {
        experience: { id: 'exp-1', profileId: 'profile-1', employmentType: null, createdAt: EXP_AT, updatedAt: EXP_AT,
          company: 'Globex',
          title: 'Engineer',
          location: null,
          startDate: '2018-01',
          endDate: '2019-12',
          current: false,
          sortOrder: 1,
        },
        claims: [],
      },
    ],
    skills: [
      {
        skill: {
          id: 'skl-0',
          profileId: 'profile-1',
          name: 'Postgres',
          level: null,
          category: null,
          normalized: 'postgres',
          sortOrder: 0,
        },
        claims: [],
      },
    ],
    otherClaims: [{ claim: CLAIMS[1] as CareerClaim }, { claim: CLAIMS[3] as CareerClaim }, { claim: CLAIMS[4] as CareerClaim }],
  }).document;
}

function fixtureContext(document: unknown = fixtureDocument()): ValidationContext {
  return {
    document,
    profileId: 'profile-1',
    claims: CLAIMS,
    requiredDictKeys: ['contact', 'summary', 'experience', 'education', 'skills'],
    templateId: 'typst-ats-classic',
    knownEmployers: ['Acme', 'Globex'],
    knownTemplateIds: ['typst-ats-classic'],
  };
}

/** Validate, then hand `apply.ts` the verdict. One place, so the tests read as intent. */
function reviewed(operations: readonly unknown[], ctx = fixtureContext()): ReviewedOperation[] {
  return operations.map((raw) => {
    // The route parses FIRST and refuses the unparseable without a `ReviewedOperation`; this
    // helper mirrors that order so the tests exercise the same two lists.
    const parsedOperation = parseOperation(raw);
    const verdict = validate(raw, ctx);
    if ('code' in verdict) {
      expect('code' in parsedOperation, 'every operation in these tests must parse').toBe(false);
      return { accepted: false as const, rejection: verdict, operation: parsedOperation as TailorOperation };
    }
    return { accepted: true as const, validated: verdict };
  });
}

/**
 * A store seeded with EVERY claim the fixture document's ledger names - at its own status,
 * not all confirmed - plus a revision holding the fixture.
 *
 * "At its own status" is load-bearing: `createRevision` resolves every `claimId` the
 * `x-clearance` block names and refuses one that does not resolve, so a store holding only
 * the confirmed claims would fail the write with `CLAIM_UNRESOLVED` and every test here
 * would be about the wrong thing. `clm-inferred` being at `inferred` is equally load-bearing
 * for the `include`/`add_skill` scope tests: it is the UNCONFIRMED sibling that a correct
 * fold must leave `omitted`, and the reason an unscoped one produced an unrenderable revision.
 */
function storeWithParent(): { store: FakeCareerStore; parent: ResumeRevision } {
  const store = new FakeCareerStore();
  for (const entry of CLAIMS) {
    fakeClaimAtStatus(store, entry.status, entry);
  }
  const document = fixtureDocument();
  const parent = seedRevision(store, 'res-1', 1, { resumeJson: document as never, jsonHash: '' });
  const row = store.revisions.get(parent.id) as ResumeRevision;
  store.setRevisionJson(row.id, row.resumeJson);
  return { store, parent: { ...row, jsonHash: canonicalJsonHash(row.resumeJson) } as ResumeRevision };
}

/** The ledger entry for `claimId` in `document`, or `undefined` if the block names no such claim. */
function ledgerEntryFor(document: unknown, claimId: string) {
  return readClearanceBlock(document)!.claims.find((claim) => claim.claimId === claimId);
}

/** Every `jsonPath` the ledger places text at, in entry order, so a duplicate is visible. */
function renderedPaths(document: unknown): Array<string | null> {
  return readClearanceBlock(document)!.claims.map((claim) => claim.jsonPath);
}

// ---------------------------------------------------------------------------
// 1. The ledger moves with the text
// ---------------------------------------------------------------------------

describe('apply: a rewrite moves the LEDGER entry with the text', () => {
  it('the new text lands at the target AND the entry naming it becomes `tailored`', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        {
          op: 'rewrite_bullet',
          target: 'work[0].highlights[0]',
          before: BULLET,
          after: 'Reduced the CI build time by 40% by caching the dependency layer',
          sourceClaimIds: ['clm-bullet'],
          reason: "mirrors the JD's 'build throughput' requirement",
        },
      ]),
    });
    const document = result.document as ResumeJson;
    expect((document.work as Array<{ highlights: string[] }>)[0].highlights[0]).toBe(
      'Reduced the CI build time by 40% by caching the dependency layer',
    );
    const entry = readClearanceBlock(document)!.claims.find((claim) => claim.claimId === 'clm-bullet');
    // THE WHOLE POINT: `verbatim` -> `tailored`, and the recorded text is the NEW text. A
    // ledger that still said `verbatim` with the old text would fail the belt's rule 5 at write
    // time AND would misreport what the resume says.
    expect(entry).toMatchObject({
      usage: 'tailored',
      jsonPath: 'work[0].highlights[0]',
      renderedText: 'Reduced the CI build time by 40% by caching the dependency layer',
    });
    // The STATUS is copied, never recomputed: this module has no claim rows to read one from,
    // and `createRevision` cross-checks it against the database anyway.
    expect(entry?.status).toBe(ClaimStatus.user_confirmed);
  });

  it('reword_summary does the same at basics.summary', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        {
          op: 'reword_summary',
          target: 'basics.summary',
          before: 'A decade of platform work.',
          after: 'A decade of platform work on data systems.',
          sourceClaimIds: ['clm-summary'],
        },
      ]),
    });
    const document = result.document as ResumeJson;
    expect((document.basics as { summary?: string }).summary).toBe('A decade of platform work on data systems.');
    expect(readClearanceBlock(document)!.claims.find((claim) => claim.claimId === 'clm-summary')).toMatchObject({
      usage: 'tailored',
      jsonPath: 'basics.summary',
    });
  });

  it('an `exclude` turns the removed subtree\'s entries into `omitted` with a null path', () => {
    // Otherwise the ledger keeps claiming a placement the document no longer has - which is
    // the lie `assertRevisionRenderableInScope` steps 4 and 5 exist to catch.
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([{ op: 'exclude', target: 'work[0]' }]),
    });
    const document = result.document as ResumeJson;
    expect(document.work).toHaveLength(1);
    expect((document.work as Array<{ highlights?: string[] }>)[0].highlights).toBeUndefined();
    expect(readClearanceBlock(document)!.claims.find((claim) => claim.claimId === 'clm-bullet')).toMatchObject({
      usage: 'omitted',
      jsonPath: null,
      renderedText: null,
    });
  });

  it('`include` renders an omitted claim at the slot and records the placement', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        {
          op: 'include',
          target: 'work[0].highlights[1]',
          after: 'Migrated 12k accounts to Postgres',
          sourceClaimIds: ['clm-omitted'],
        },
      ]),
    });
    const document = result.document as ResumeJson;
    expect((document.work as Array<{ highlights: string[] }>)[0].highlights).toEqual([
      BULLET,
      'Migrated 12k accounts to Postgres',
    ]);
    expect(ledgerEntryFor(document, 'clm-omitted')).toMatchObject({
      usage: 'verbatim',
      jsonPath: 'work[0].highlights[1]',
      renderedText: 'Migrated 12k accounts to Postgres',
    });
    // THE SIBLING STAYS OMITTED. The fixture already holds a SECOND omitted claim
    // (`clm-inferred`, `otherClaims`), and this operation did not put its text anywhere - so
    // promoting it would make the block assert that two claims render text at one path.
    expect(ledgerEntryFor(document, 'clm-inferred')).toMatchObject({
      usage: 'omitted',
      jsonPath: null,
      renderedText: null,
    });
  });

  it('`add_skill` appends the name and records the claim that backs it', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        { op: 'add_skill', target: 'skills', after: '12k accounts', sourceClaimIds: ['clm-omitted'] },
      ]),
    });
    const document = result.document as ResumeJson;
    expect(document.skills?.map((entry) => entry.name)).toEqual(['Postgres', '12k accounts']);
    expect(ledgerEntryFor(document, 'clm-omitted')).toMatchObject({
      usage: 'verbatim',
      jsonPath: 'skills[1].name',
    });
    // THE SAME SCOPE ON THE SECOND CALL SITE: `add_skill` names one claim, so only that one
    // entry claims `skills[1].name`. `clm-inferred` is not on the page.
    expect(ledgerEntryFor(document, 'clm-inferred')).toMatchObject({
      usage: 'omitted',
      jsonPath: null,
      renderedText: null,
    });
  });

  it('`reorder` permutes and touches nothing else', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([{ op: 'reorder', target: 'work', after: [1, 0] }]),
    });
    const document = result.document as ResumeJson;
    expect((document.work as Array<{ name: string }>).map((entry) => entry.name)).toEqual(['Globex', 'Acme']);
  });

  it('`customize_style` records a change and leaves the document BYTE-IDENTICAL', () => {
    // ADR-044 D3: the template is a render-time choice, so it is not a member of the
    // snapshot. The snapshot's `jsonHash` therefore does NOT move - and `applySummary` reports
    // that as `documentChanged: false` rather than pretending something happened.
    const before = fixtureDocument();
    const result = applyOperations({
      document: before,
      operations: reviewed([
        { op: 'customize_style', target: 'render.templateId', before: 'typst-ats-classic', after: 'typst-ats-classic' },
      ]),
    });
    expect(canonicalJsonHash(result.document)).toBe(canonicalJsonHash(before));
    expect(result.changes).toHaveLength(1);
    expect(applySummary(result, canonicalJsonHash(before), canonicalJsonHash(result.document))).toMatchObject({
      documentChanged: false,
      acceptedCount: 1,
      changeCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// 1b. An include/add_skill promotes ONE claim, never every omitted claim
// ---------------------------------------------------------------------------

describe('apply: `include`/`add_skill` promote ONLY the claim the operation named', () => {
  // THE FIX, STATED AS A PROPERTY. The ledger is an account of itself, so an operation that
  // puts one claim's text on the page may move ONE entry. Promoting every `omitted` entry put
  // them all on ONE path with ONE text, which is (a) a false statement about the document,
  // (b) a DUPLICATE jsonPath that `assertOneUsagePerClaimId` cannot see - it keys on claimId -
  // and (c) fatal to rendering whenever a flipped sibling is not `user_confirmed`, because the
  // flipped entry then carries a GATED usage and the pre-render gate refuses with
  // `CLAIM_NOT_CONFIRMED`. The fixture already had the failing shape; nothing asserted it.

  const OMITTED_SIBLING = { usage: 'omitted', jsonPath: null, renderedText: null };

  it('`include`: the NAMED claim is promoted and the omitted sibling is not (the review fixture)', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        {
          op: 'include',
          target: 'work[0].highlights[1]',
          after: 'Migrated 12k accounts to Postgres',
          sourceClaimIds: ['clm-omitted'],
        },
      ]),
    });
    const document = result.document as ResumeJson;
    expect(ledgerEntryFor(document, 'clm-omitted')).toMatchObject({
      usage: 'verbatim',
      jsonPath: 'work[0].highlights[1]',
    });
    expect(ledgerEntryFor(document, 'clm-inferred')).toMatchObject(OMITTED_SIBLING);
  });

  it('`add_skill`: the NAMED claim is promoted and the omitted sibling is not', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        { op: 'add_skill', target: 'skills', after: '12k accounts', sourceClaimIds: ['clm-omitted'] },
      ]),
    });
    const document = result.document as ResumeJson;
    expect(ledgerEntryFor(document, 'clm-omitted')).toMatchObject({
      usage: 'verbatim',
      jsonPath: 'skills[1].name',
    });
    expect(ledgerEntryFor(document, 'clm-inferred')).toMatchObject(OMITTED_SIBLING);
  });

  it('no jsonPath is claimed TWICE - the collision `assertOneUsagePerClaimId` cannot see', () => {
    // `assertOneUsagePerClaimId` keys on `claimId`, so N distinct claims at one path pass it.
    // This asserts the thing it cannot: the PATH is placed once.
    for (const result of [
      applyOperations({
        document: fixtureDocument(),
        operations: reviewed([
          {
            op: 'include',
            target: 'work[0].highlights[1]',
            after: 'Migrated 12k accounts to Postgres',
            sourceClaimIds: ['clm-omitted'],
          },
        ]),
      }),
      applyOperations({
        document: fixtureDocument(),
        operations: reviewed([
          { op: 'add_skill', target: 'skills', after: '12k accounts', sourceClaimIds: ['clm-omitted'] },
        ]),
      }),
    ]) {
      const placed = renderedPaths(result.document).filter((path): path is string => path !== null);
      expect(placed).toEqual([...new Set(placed)]);
      expect(placed.filter((path) => path === 'work[0].highlights[1]' || path === 'skills[1].name')).toHaveLength(1);
    }
  });

  it('an `include` beside an UNCONFIRMED omitted claim leaves the revision RENDERABLE', async () => {
    // The consequence that made this HIGH: promoting `clm-inferred` gave it a `verbatim`
    // (GATED) usage, so `evaluatePreRenderGate` refused the whole revision with
    // `CLAIM_NOT_CONFIRMED` - an honest `include` bricked the resume. Left `omitted`, the
    // write passes the belt and the gate reads the new revision as renderable.
    const { store, parent } = storeWithParent();
    const result = applyOperations({
      document: parent.resumeJson,
      operations: reviewed([
        {
          op: 'include',
          target: 'work[0].highlights[1]',
          after: 'Migrated 12k accounts to Postgres',
          sourceClaimIds: ['clm-omitted'],
        },
      ]),
    });
    const written = await createRevision(
      { resumeId: 'res-1', document: result.document, createdBy: ResumeChangeSource.tailoring_engine, changes: result.changes },
      store.asRevisionStore() as unknown as ResumeRevisionStore,
    );
    const hashed = { ...written, jsonHash: canonicalJsonHash(written.resumeJson) } as ResumeRevision;
    await expect(assertRevisionRenderableInScope(hashed, store.asUsageStore())).resolves.toMatchObject({
      allowed: true,
    });
    // And the stored revision's own ledger says the same thing the gate just read.
    expect(ledgerEntryFor(written.resumeJson, 'clm-inferred')).toMatchObject(OMITTED_SIBLING);
  });
});

// ---------------------------------------------------------------------------
// 1c. An `include` carries the CLAIM'S WORDS, and ONE slot takes ONE operation
// ---------------------------------------------------------------------------

describe("apply: an `include` writes the claim's own statement, and one slot takes one operation", () => {
  // THE TWO INVARIANTS, AS ONE BLOCK, because they are the same sentence from both sides:
  // whatever `after` said, the text on the page is a CONFIRMED CLAIM'S statement; and one
  // `jsonPath` names one text for one claim. The first is what makes `include` safe while being
  // exempt from the fact-delta pass; the second is what stops a batch from making the ledger
  // assert that two claims render text at one path.

  const SLOT = 'work[0].highlights[1]';
  const FIRST = 'Migrated 12k accounts to Postgres';
  const SECOND = 'Cut the CI build time by 42% by caching the dependency layer (r2)';
  const ABUSIVE = 'Cut CI build time by 95% and led the migration at Globex';
  const STILL_OMITTED = { usage: 'omitted', jsonPath: null, renderedText: null };

  const highlights = (document: unknown): string[] =>
    ((document as ResumeJson).work as Array<{ highlights: string[] }>)[0].highlights;

  it('a text-bearing `include` renders the claim\'s statement and records it at the path', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        { op: 'include', target: SLOT, after: FIRST, sourceClaimIds: ['clm-omitted'] },
      ]),
    });
    expect(highlights(result.document)[1]).toBe(FIRST);
    expect(ledgerEntryFor(result.document, 'clm-omitted')).toMatchObject({
      usage: 'verbatim',
      jsonPath: SLOT,
      renderedText: FIRST,
    });
  });

  it('a NO-TEXT `include` renders the claim\'s OWN statement - the purely structural form', () => {
    // No `after` at all: nothing of the caller's reaches the page, so the structural form
    // cannot carry prose even in principle. Same operation, same result.
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([{ op: 'include', target: SLOT, sourceClaimIds: ['clm-omitted'] }]),
    });
    expect(result.changes.map((change) => change.accepted)).toEqual([true]);
    expect(highlights(result.document)[1]).toBe(FIRST);
    expect(ledgerEntryFor(result.document, 'clm-omitted')).toMatchObject({
      usage: 'verbatim',
      jsonPath: SLOT,
      renderedText: FIRST,
    });
    expect(result.changes[0].after).toBe(FIRST);
  });

  it('an `include` carrying DIFFERENT prose is REFUSED, recorded, and writes nothing', () => {
    // The HIGH finding, driven end to end. Confirmed claim, currently `omitted`, empty slot,
    // array parent - and the text is the candidate's, not the claim's.
    const before = fixtureDocument();
    const result = applyOperations({
      document: before,
      operations: reviewed([
        { op: 'include', target: SLOT, after: ABUSIVE, sourceClaimIds: ['clm-omitted'] },
      ]),
    });
    expect(canonicalJsonHash(result.document)).toBe(canonicalJsonHash(before));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({ op: 'include', jsonPath: SLOT, accepted: false, after: null });
    expect(String(result.changes[0].reason)).toContain('CLAIM_TEXT_MISMATCH');
    expect(applySummary(result, 'a', 'b')).toMatchObject({ acceptedCount: 0, declinedCount: 1 });
  });

  it('THE TEXT IS READ FROM THE CLAIM ROW, so even an unvalidated op cannot write prose', () => {
    // Defence in depth, and the reason `apply.ts` does not read `op.after` here: the caller of
    // `applyOperations` is trusted to have VALIDATED, and this module is trusted not to write
    // the caller's bytes at a claim-backed path regardless. A hand-built accepted operation -
    // the shape `validate.ts` refuses - still renders the claim's statement.
    const parsed = parseOperation({
      op: 'include',
      target: SLOT,
      after: ABUSIVE,
      sourceClaimIds: ['clm-omitted'],
    }) as TailorOperation;
    const result = applyOperations({
      document: fixtureDocument(),
      operations: [
        {
          accepted: true,
          validated: { operation: parsed, groundingClaims: [CLAIMS[1] as CareerClaim], factChecked: false },
        },
      ],
    });
    expect(highlights(result.document)[1]).toBe(FIRST);
    expect(JSON.stringify(result.document)).not.toContain('95%');
    expect(ledgerEntryFor(result.document, 'clm-omitted')).toMatchObject({ renderedText: FIRST });
  });

  it('TWO `include`s at ONE slot: the second is REFUSED, and only one claim claims the path', async () => {
    // BOTH OPERATIONS ARE LEGAL IN ISOLATION: each names a confirmed claim that is currently
    // `omitted`, and each addresses a slot that is empty in the PARENT. Nothing about the first
    // operation is visible to the validation of the second, which is why the check belongs to
    // the fold and is asked of the ACCUMULATING document.
    const { store, parent } = storeWithParent();
    const result = applyOperations({
      document: parent.resumeJson,
      operations: reviewed([
        { op: 'include', target: SLOT, after: FIRST, sourceClaimIds: ['clm-omitted'] },
        { op: 'include', target: SLOT, after: SECOND, sourceClaimIds: ['clm-omitted-2'] },
      ]),
    });
    expect(result.changes.map((change) => change.accepted)).toEqual([true, false]);
    expect(String(result.changes[1].reason)).toContain('TARGET_ALREADY_FILLED');
    // The declined row shows what the refused operation wanted, and what was already there -
    // the honest history, read from the document as it stood before that operation.
    expect(result.changes[1].before).toBe(FIRST);
    // The slot holds the FIRST claim's statement; the second claim is still `omitted`.
    expect(highlights(result.document)[1]).toBe(FIRST);
    expect(JSON.stringify(result.document)).not.toContain('42%');
    expect(ledgerEntryFor(result.document, 'clm-omitted')).toMatchObject({ usage: 'verbatim', jsonPath: SLOT });
    expect(ledgerEntryFor(result.document, 'clm-omitted-2')).toMatchObject(STILL_OMITTED);
    const placed = renderedPaths(result.document).filter((path): path is string => path !== null);
    expect(placed.filter((path) => path === SLOT)).toHaveLength(1);
    expect(placed).toEqual([...new Set(placed)]);
    // And the result is a revision the belt and the gate accept, which is the point: the
    // collision cannot survive to a write, because the fold refuses it before there is one.
    const written = await createRevision(
      {
        resumeId: 'res-1',
        document: result.document,
        createdBy: ResumeChangeSource.tailoring_engine,
        changes: result.changes,
      },
      store.asRevisionStore() as unknown as ResumeRevisionStore,
    );
    const hashed = { ...written, jsonHash: canonicalJsonHash(written.resumeJson) } as ResumeRevision;
    await expect(assertRevisionRenderableInScope(hashed, store.asUsageStore())).resolves.toMatchObject({
      allowed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. A refused operation is recorded, not applied
// ---------------------------------------------------------------------------

describe('apply: a REFUSED operation is recorded with accepted:false and no document effect', () => {
  it('the change row carries the validator code, and the document is unchanged', () => {
    const before = fixtureDocument();
    const result = applyOperations({
      document: before,
      operations: reviewed([
        {
          op: 'rewrite_bullet',
          target: 'work[0].highlights[0]',
          before: BULLET,
          after: 'Cut the CI build time by 40% and scaled to 12000 accounts',
          sourceClaimIds: ['clm-bullet'],
        },
      ]),
    });
    expect(canonicalJsonHash(result.document)).toBe(canonicalJsonHash(before));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      op: 'rewrite_bullet',
      jsonPath: 'work[0].highlights[0]',
      before: BULLET,
      after: null,
      accepted: false,
    });
    expect(String(result.changes[0].reason)).toContain('FACT_DELTA');
  });

  it('a declined row still shows the text the engine wanted to replace', () => {
    // "suggested, declined" only means something if the reviewer can see what was proposed.
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        {
          op: 'rewrite_bullet',
          target: 'work[0].highlights[0]',
          before: BULLET,
          after: 'Reduced the CI build time by 40% and scaled to 12000 accounts',
          sourceClaimIds: ['clm-bullet'],
        },
      ]),
    });
    expect(result.changes[0].before).toBe(BULLET);
  });

  it('an accepted and a refused operation in one batch produce ONE row each, in order', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        { op: 'reorder', target: 'work', after: [1, 0] },
        {
          op: 'rewrite_bullet',
          target: 'work[0].highlights[0]',
          after: 'Cut it by 99%',
          sourceClaimIds: ['clm-inferred'],
        },
      ]),
    });
    expect(result.changes.map((change) => change.accepted)).toEqual([true, false]);
    expect((result.document as ResumeJson).work).toHaveLength(2);
  });

  it('`before` of each row is read from the document BEFORE THAT OP - a history, not a snapshot', () => {
    const result = applyOperations({
      document: fixtureDocument(),
      operations: reviewed([
        { op: 'rewrite_bullet', target: 'work[0].highlights[0]', after: 'Reduced the CI build time by 40%', sourceClaimIds: ['clm-bullet'] },
        { op: 'reword_summary', target: 'basics.summary', after: 'A decade of platform work on data.', sourceClaimIds: ['clm-summary'] },
      ]),
    });
    // The second row's `before` is the FIRST row's `after` value's sibling - the summary - and
    // the first row's `before` is what the revision actually held.
    expect(result.changes[0].before).toBe(BULLET);
    expect(result.changes[1].before).toBe('A decade of platform work.');
  });
});

// ---------------------------------------------------------------------------
// 3. Through the ONE revision writer
// ---------------------------------------------------------------------------

describe('apply -> createRevision: a tailored revision is a PEER of a Studio autosave', () => {
  it('applies to a NEW revision N+1, and the parent row is NOT written to', async () => {
    const { store, parent } = storeWithParent();
    const revisionStore = store.asRevisionStore() as unknown as ResumeRevisionStore;
    const result = applyOperations({
      document: parent.resumeJson,
      operations: reviewed([
        {
          op: 'rewrite_bullet',
          target: 'work[0].highlights[0]',
          before: BULLET,
          after: 'Reduced the CI build time by 40% by caching the dependency layer',
          sourceClaimIds: ['clm-bullet'],
        },
      ]),
    });
    const written = await createRevision(
      {
        resumeId: 'res-1',
        document: result.document,
        createdBy: ResumeChangeSource.tailoring_engine,
        changes: result.changes,
      },
      revisionStore,
    );

    expect(written.revisionNumber).toBe(2);
    expect(written.jsonHash).not.toBe(parent.jsonHash);
    // THE IMMUTABILITY HALF: the parent's STORED BYTES are untouched, and they still hash to
    // the digest the parent was read with. `createRevision` has no update path at all -
    // `ResumeRevisionWriteSeam` does not expose one - so this is OBSERVED, not inferred from
    // the source. (The fake stores the fixture's own `jsonHash` string; the digest computed
    // here is from `parent`, which was hashed on the way out.)
    const parentAfter = store.revisions.get(parent.id) as ResumeRevision;
    expect(canonicalJsonHash(parentAfter.resumeJson)).toBe(parent.jsonHash);
    expect(parentAfter.resumeJson).toEqual(parent.resumeJson);
    // And there are exactly TWO revisions: N was not replaced by N+1, it was left next to it.
    expect(store.revisionsFor('res-1').map((row) => row.revisionNumber)).toEqual([1, 2]);
  });

  it('the tailored revision passes the PRE-RENDER BELT, and the gate reads it as renderable', async () => {
    const { store, parent } = storeWithParent();
    const revisionStore = store.asRevisionStore() as unknown as ResumeRevisionStore;
    const result = applyOperations({
      document: parent.resumeJson,
      operations: reviewed([
        {
          op: 'rewrite_bullet',
          target: 'work[0].highlights[0]',
          before: BULLET,
          after: 'Reduced the CI build time by 40% by caching the dependency layer',
          sourceClaimIds: ['clm-bullet'],
        },
      ]),
    });
    const written = await createRevision(
      { resumeId: 'res-1', document: result.document, createdBy: ResumeChangeSource.tailoring_engine, changes: result.changes },
      revisionStore,
    );
    const hashed = { ...written, jsonHash: canonicalJsonHash(written.resumeJson) } as ResumeRevision;
    // This is the load-bearing assertion for ruling 1's prerequisite: the tailored document
    // is belt-verified exactly as a projected one is, so the summary the tailoring pass may
    // rewrite is one the gate can account for.
    await expect(
      assertRevisionRenderableInScope(hashed, store.asUsageStore()),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('ONE ResumeChange row per operation, with the reason, the requirement ids and the claims', async () => {
    const { store, parent } = storeWithParent();
    const result = applyOperations({
      document: parent.resumeJson,
      operations: reviewed([
        {
          op: 'rewrite_bullet',
          target: 'work[0].highlights[0]',
          before: BULLET,
          after: 'Reduced the CI build time by 40% by caching the dependency layer',
          reason: "mirrors the JD's 'build throughput' requirement",
          targetRequirementIds: ['req-1'],
          sourceClaimIds: ['clm-bullet'],
        },
      ]),
    });
    await createRevision(
      { resumeId: 'res-1', document: result.document, createdBy: ResumeChangeSource.tailoring_engine, changes: result.changes },
      store.asRevisionStore() as unknown as ResumeRevisionStore,
    );
    const written = [...store.changes.values()];
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      op: 'rewrite_bullet',
      jsonPath: 'work[0].highlights[0]',
      reason: "mirrors the JD's 'build throughput' requirement",
      targetRequirementIds: ['req-1'],
      sourceClaimIds: ['clm-bullet'],
      appliedBy: ResumeChangeSource.tailoring_engine,
      accepted: true,
    });
  });

  it('the apply path is PURE: the caller\'s document is never mutated', () => {
    const document = fixtureDocument();
    const hashBefore = canonicalJsonHash(document);
    applyOperations({
      document,
      operations: reviewed([
        { op: 'reorder', target: 'work', after: [1, 0] },
        { op: 'exclude', target: 'work[1]' },
      ]),
    });
    expect(canonicalJsonHash(document)).toBe(hashBefore);
  });

  it('an empty operation list produces an identical document and NO change rows', () => {
    // The caller may accept nothing; the revision it creates must then be the same content.
    const document = fixtureDocument();
    const result = applyOperations({ document, operations: [] });
    expect(canonicalJsonHash(result.document)).toBe(canonicalJsonHash(document));
    expect(result.changes).toEqual([]);
  });
});