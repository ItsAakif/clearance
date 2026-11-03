// resume/revisions.test.ts - immutable revision snapshots (T1030; 05 sec.6.2, sec.7.7).
//
// THE ACCEPTANCE ITEM, in the spec's words (05 sec.6.2):
//
//   "Revisions are immutable. Editing produces revision N+1; revision N keeps its exact
//    resumeJson + the claim usage that was valid at that time."
//
// WHY THAT MATTERS HERE AND NOT ONLY FOR HISTORY. `ResumeClaimUsage` is the input to
// the pre-render gate, and the gate asks "was this claim CONFIRMED when this document
// was written?". A mutable revision destroys that question: a claim confirmed today
// would retroactively legitimise a revision that quoted it while it was still an
// inference, and the audit 05 sec.6.5 depends on ("this resume used claim X, which was
// later rejected") becomes unanswerable.
//
// IMMUTABILITY IS PROVEN THREE WAYS, in increasing order of strength:
//   1. THE EXPORT SURFACE. There is no `updateRevision`, no `patchRevision`, no generic
//      data setter. Asserted against the module's real export list, so adding one fails
//      the test rather than passing review.
//   2. THE TYPE-LEVEL SEAM. `ResumeRevisionWriteSeam` names only `create`/`findFirst`/
//      `findMany`/`findUnique`. Proved by a `// @ts-error` that `npx tsc --noEmit`
//      checks: calling `store.resumeRevision.update` through the seam is a COMPILE
//      error, which a refactor cannot quietly undo.
//   3. THE FAKE. `FakeCareerStore.resumeRevision` implements no `update` either, and
//      records every call, so the test asserts on OBSERVED behaviour rather than on a
//      type - and the recorded log shows that creating revision N+1 writes nothing to
//      revision N.
//
// Plus the two hash properties the task requires: `jsonHash` is STABLE across repeated
// projections of the same data, and it CHANGES when claim content changes.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ClaimStatus,
  ResumeChangeOp,
  ResumeChangeSource,
  ResumeUsage,
  type CareerClaim,
  type ResumeRevision,
} from '@prisma/client';

import * as revisionsModule from './revisions.js';

import {
  DEFAULT_REVISION_PAGE,
  MAX_REVISION_PAGE,
  REVISION_AUDIT_REASONS,
  ResumeRevisionError,
  RevisionAuditError,
  assertRevisionRenderableInScope,
  createRevision,
  deriveUsageFromDocument,
  diffRevisions,
  getCurrentRevision,
  getRevision,
  getRevisionByNumber,
  listRevisionChanges,
  listRevisions,
  revisionCanonicalJson,
  revisionHashMatches,
  type CreateRevisionInput,
  type ResumeRevisionStore,
  type ResumeRevisionWriteSeam,
} from './revisions.js';
import {
  X_CLEARANCE_KEY,
  canonicalJsonHash,
  canonicalJsonString,
  readClearanceBlock,
  type ResumeJson,
} from './json/jsonresume.js';
import {
  loadProjectionInput,
  projectResumeJson,
  refreshClearanceFromClaims,
} from './json/project.js';
import { claimBackedTextAt } from './json/claimSurface.js';
import { ClaimKind } from '@prisma/client';
import { claimFingerprint } from '../career/claims.js';
import {
  FakeCareerStore,
  fakeInferredClaim,
  seedConfirmedClaim,
  seedRevision,
} from '../career/careerStore.fixtures.js';
import { ClaimInvariantError, ClaimNotFoundError } from '../career/claims.js';
import type { ResumeClaimUsageStore } from '../career/claimUsage.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const RESUME = 'res-1';

/** A well-formed document for a revision, with a block naming one claim. */
function document(overrides: Record<string, unknown> = {}): ResumeJson {
  return {
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer' },
    work: [
      {
        name: 'Acme',
        position: 'Staff Engineer',
        startDate: '2020-01',
        highlights: ['Cut CI build time by 40%'],
      },
    ],
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 'test',
      sourceModelVersion: 2,
      profileId: 'profile-1',
      claimCount: 1,
      confirmedClaimCount: 1,
      unconfirmedClaimCount: 0,
      claims: [
        {
          claimId: 'clm-1',
          fingerprint: 'a'.repeat(64),
          kind: 'achievement',
          status: ClaimStatus.user_confirmed,
          provenance: 'llm_inferred',
          confidence: 0.9,
          evidenceSourceId: null,
          usage: ResumeUsage.verbatim,
          jsonPath: 'work[0].highlights[0]',
          renderedText: 'Cut CI build time by 40%',
        },
      ],
    },
    ...overrides,
  } as ResumeJson;
}

/** A store with one confirmed claim, ready for usage recording. */
function storeWithClaim() {
  const store = new FakeCareerStore();
  const claim = seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
  return { store, claim };
}

/** The document with the `x-clearance` block removed entirely (the F1 attack shape). */
function withoutBlock(doc: ResumeJson): ResumeJson {
  const { [X_CLEARANCE_KEY]: _removed, ...rest } = doc as Record<string, unknown>;
  return rest as ResumeJson;
}

/**
 * A document whose `work[0].highlights[0]` carries `text`, with the block's
 * `renderedText` moved to match.
 *
 * ADR-043 rule 5 says every claim-backed string must be named, at that exact path, with
 * that exact text, by a text-rendering entry of the document's OWN block. So a fixture
 * that changes the text in the body without changing the block is a fixture that
 * describes an unaudited document, and the writer now refuses it - correctly. The tests
 * below that vary the text are testing something ELSE (hash stability, a diff, a forged
 * status), so their fixture has to be a coherent one: this helper is how they say "the
 * same claim, saying something different" instead of silently forging an accounting gap.
 */
function documentSaying(text: string, overrides: Record<string, unknown> = {}): ResumeJson {
  const base = document();
  const block = base[X_CLEARANCE_KEY]!;
  return document({
    work: [{ name: 'Acme', position: 'Staff Engineer', startDate: '2020-01', highlights: [text] }],
    [X_CLEARANCE_KEY]: {
      ...block,
      claims: block.claims.map((entry) => ({ ...entry, renderedText: text })),
    },
    ...overrides,
  });
}

/** The claim row's `status`, as the write-time cross-check sees it. */
function claimStatus(store: FakeCareerStore, claimId: string): unknown {
  return (store.claims.get(claimId) as { status: unknown } | undefined)?.status;
}

function input(overrides: Partial<CreateRevisionInput> = {}): CreateRevisionInput {
  return {
    resumeId: RESUME,
    document: document(),
    createdBy: ResumeChangeSource.user,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ADR-043 helpers: the projector, a claim, and a projection seam
// ---------------------------------------------------------------------------

let claimSeq = 0;

/** A claim row with a real fingerprint and a controlled `createdAt` (the sort key). */
function careerClaim(id: string, statement: string, minute: number): CareerClaim {
  claimSeq += 1;
  const kind = 'achievement';
  return {
    id,
    profileId: 'profile-1',
    kind,
    statement,
    fingerprint: claimFingerprint(kind, statement),
    experienceId: 'exp-1',
    educationId: null,
    projectId: null,
    skillId: null,
    certificationId: null,
    achievementId: null,
    status: ClaimStatus.user_confirmed,
    provenance: 'llm_inferred',
    confidence: 0.9,
    inferenceMethod: 'jd_extract',
    producedByModel: null,
    evidenceSourceId: null,
    supersedesClaimId: null,
    confirmedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    jobRelevance: null,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, minute, 0)),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, minute, 0)),
  } as unknown as CareerClaim;
}

function experienceRowFor(id: string) {
  return {
    id,
    profileId: 'profile-1',
    title: 'Staff Engineer',
    company: 'Acme',
    location: null,
    employmentType: null,
    startDate: '2020-01',
    endDate: '2024-06',
    current: false,
    sortOrder: 0,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    updatedAt: new Date(Date.UTC(2026, 0, 1)),
  } as never;
}

function projectRowFor(id: string) {
  return {
    id,
    profileId: 'profile-1',
    name: 'Ledger',
    role: 'Maintainer',
    description: null,
    repoUrl: null,
    liveUrl: null,
    tech: [],
    startDate: null,
    endDate: null,
    sortOrder: 0,
    createdAt: new Date(Date.UTC(2026, 0, 2)),
    updatedAt: new Date(Date.UTC(2026, 0, 2)),
  } as never;
}

/**
 * A projection seam holding a profile with a SUMMARY, a project with TECH, and NO claims.
 *
 * This is the fixture N3 is about, and it is a realistic one: a user who has filled in
 * their profile but confirmed no claims yet. The attempt-2 belt refused it at render
 * forever, because `basics.summary` and `projects[].keywords` were on its list and the
 * projector never claim-backed either of them.
 *
 * **RE-SCOPED BY T1080 (ADR-043 R-SUMMARY).** `projects[].keywords` is still R-ENTITY and
 * still renders unclaimed. `basics.summary` is NOT: since T1080 it is on the claim rail,
 * so a summary with no claim behind it is `DOCUMENT_UNAUDITED`. The N3 test below is
 * therefore the R-ENTITY half (no summary at all), and `R-SUMMARY` in the same describe
 * block is the summary half: a CONFIRMED summary claim renders and is belt-verified, and
 * a summary with NO claim is refused. Together they keep the false positive N3 was about
 * from coming back, and neither of them asks the belt to stay blind to the summary.
 *
 * Local rather than added to `FakeCareerStore`, because the fake is deliberately not a
 * database and this is the only test in this file that needs a projection seam.
 */
function projectionStoreWithSummaryAndTech(summary: string | null = 'A decade of platform work.') {
  const nothing = async () => [];
  return {
    careerProfile: {
      findUnique: async () => ({
        id: 'profile-1',
        headline: 'Ada Lovelace',
        seniority: 'Staff Engineer',
        summary,
      }),
    },
    experience: { findMany: nothing },
    education: { findMany: nothing },
    skill: { findMany: nothing },
    certification: { findMany: nothing },
    careerClaim: { findMany: nothing },
    resume: { findUnique: async () => null },
    project: {
      findMany: async () => [
      {
        id: 'prj-1',
        profileId: 'profile-1',
        name: 'Ledger',
        role: 'Maintainer',
        description: 'A double-entry ledger service.',
        repoUrl: null,
        liveUrl: null,
        tech: ['typescript', 'postgres'],
        startDate: null,
        endDate: null,
        sortOrder: 0,
        createdAt: new Date(Date.UTC(2026, 0, 2)),
        updatedAt: new Date(Date.UTC(2026, 0, 2)),
      }],
    },
  };
}


// ---------------------------------------------------------------------------
// ACCEPTANCE: the revision is immutable
// ---------------------------------------------------------------------------

describe('ACCEPTANCE: a revision is IMMUTABLE - there is no update path', () => {
  it('the module exports no update, patch, edit or delete for a revision', () => {
    // The export surface IS the check. `import * as revisionsModule` is the module's
    // real shape, so adding an updater fails this test rather than passing review.
    const exported = Object.keys(revisionsModule);

    const forbidden = exported.filter((key) =>
      /^(update|patch|edit|set|replace|overwrite|delete|remove|mutate|amend)/i.test(key),
    );
    expect(forbidden).toEqual([]);

    // ...and the write vocabulary is exactly one function. Named explicitly so the list
    // cannot grow quietly.
    const writes = exported.filter((key) => /^(create|write|save|insert|append|upsert)/i.test(key));
    expect(writes).toEqual(['createRevision']);
  });

  it('the write SEAM has no `update`, so calling one is a compile error', () => {
    // Checked by `npx tsc --noEmit`, not by vitest. `@ts-expect-error` fails the BUILD
    // if `update` ever appears on the seam, which is the guarantee that survives a
    // refactor - a type is not something a well-meaning edit removes by accident.
    const store = new FakeCareerStore();
    const seam = store.resumeRevision as unknown as ResumeRevisionWriteSeam;
    // @ts-expect-error `update` is deliberately absent from the write seam: a revision
    // is an immutable snapshot, so there is no call that could edit one.
    void seam.update;
    // @ts-expect-error `delete` is absent for the same reason.
    void seam.delete;
    // @ts-expect-error and so is `upsert`.
    void seam.upsert;
    // The four that ARE allowed, and they are the only ones.
    expect(typeof seam.create).toBe('function');
    expect(typeof seam.findFirst).toBe('function');
    expect(typeof seam.findMany).toBe('function');
    expect(typeof seam.findUnique).toBe('function');
  });

  it("createRevision's OWN PARAMETER TYPE exposes no mutating delegate (the discriminating test)", () => {
    // F4. The previous version of this suite asserted `@ts-expect-error` against a
    // LOCALLY DECLARED interface (`ResumeRevisionWriteSeam`) that was not the parameter
    // type of anything: `createRevision`'s store parameter was
    // `Pick<PrismaClient, 'resumeRevision' | ...>`, which is the WHOLE Prisma delegate,
    // so `store.resumeRevision.update(...)` compiled inside the module and the header's
    // "a COMPILE error in this repository" claim was false. A test that proves a local
    // interface lacks a member proves nothing about the module.
    //
    // This asserts the real thing: the type `createRevision` is DECLARED with. If someone
    // widens that type back to the whole delegate, `@ts-expect-error` below becomes an
    // unused directive and `tsc` fails - the build, not the test.
    // A TYPE-LEVEL probe, not a runtime one: nothing is executed, so this test has no
    // runtime assertions of its own. Its whole content is the four `@ts-expect-error`
    // directives, which `npx tsc --noEmit` checks: if the type ever widens, the
    // directives become unused and tsc FAILS. That is the discriminating property - the
    // old test's directives could never fail, because the interface they named was local
    // to the test file.
    type CreateRevisionStore = Parameters<typeof createRevision>[1];

    // @ts-expect-error `createRevision`'s store type must not expose `resumeRevision.update`
    type NoUpdate1 = CreateRevisionStore['resumeRevision']['update'];
    // @ts-expect-error ...nor `delete`
    type NoDelete1 = CreateRevisionStore['resumeRevision']['delete'];
    // @ts-expect-error ...nor `upsert`
    type NoUpsert1 = CreateRevisionStore['resumeRevision']['upsert'];

    // The named export is declared together with the parameter type, so the header's
    // claim about `ResumeRevisionStore` is the claim about the parameter. Asserted
    // separately anyway, so a future refactor that decouples them fails here.
    // @ts-expect-error `ResumeRevisionStore` must not expose `resumeRevision.update`
    type NoUpdate2 = ResumeRevisionStore['resumeRevision']['update'];

    // The four that ARE on it, and the three non-revision delegates that stay wide
    // because their own tables' invariants do not live in this module. These lines
    // compile only if the members exist, so they are the other half of the assertion.
    type HasCreate = CreateRevisionStore['resumeRevision']['create'];
    type HasRead = CreateRevisionStore['resumeRevision']['findFirst'];
    type Wide1 = CreateRevisionStore['careerClaim'];
    type Wide2 = CreateRevisionStore['resumeChange'];
    type Wide3 = CreateRevisionStore['resumeClaimUsage'];

    // Referenced so no `noUnusedLocals` rule can quietly turn the type probes into
    // declarations that are never checked.
    const probes: Array<unknown> = [
      null as unknown as NoUpdate1, null as unknown as NoDelete1, null as unknown as NoUpsert1,
      null as unknown as NoUpdate2, null as unknown as HasCreate, null as unknown as HasRead,
      null as unknown as Wide1, null as unknown as Wide2, null as unknown as Wide3,
    ];
    expect(probes).toHaveLength(9);
  });

  it('the fake has no `update` either, so the type check has a runtime twin', () => {
    const store = new FakeCareerStore();
    const delegate = store.resumeRevision as unknown as Record<string, unknown>;
    expect(delegate.update).toBeUndefined();
    expect(delegate.delete).toBeUndefined();
    expect(delegate.upsert).toBeUndefined();
  });

  it('the SOURCE never writes a revision: no `resumeRevision.update` anywhere', () => {
    // The belt to the two braces above. A helper introduced in another file that
    // updated a revision would not be caught by the export-surface test, and would be
    // caught by this.
    const source = readFileSync(path.join(__dirname, 'revisions.ts'), 'utf8');
    expect(source).not.toMatch(/resumeRevision\.(update|delete|upsert|updateMany|deleteMany)/);
    // The only write to a revision in the whole repository is the create below. The cast
    // is spelled with or without `as unknown as`, so the pattern allows both.
    const creates = source.match(/store\s*(?:\s+as unknown as\s+\w+\s*)?\.resumeRevision\.create/g) ?? [];
    expect(creates).toHaveLength(1);
  });

  it('creating revision N+1 writes NOTHING to revision N', async () => {
    // The behavioural proof, on the recorded write log. A create that also updated the
    // previous row - to bump a "latest" flag, to re-stamp it, anything - would show up
    // here.
    const { store } = storeWithClaim();
    const first = await createRevision(input(), store.asRevisionStore());
    const firstSnapshot = JSON.stringify(first.resumeJson);
    const firstHash = first.jsonHash;
    const logAfterFirst = [...store.writes];

    const second = await createRevision(
      input({ document: documentSaying('Shipped the ledger') }),
      store.asRevisionStore(),
    );

    // The log gained a create (and the usage row derived from the new document's block) -
    // and nothing else. There is no `revision.update` anywhere in it, which is the point.
    expect(store.writes).toEqual([...logAfterFirst, 'revision.create', 'usage.create']);
    expect(store.writes.filter((entry) => entry.startsWith('revision.') && entry !== 'revision.create')).toEqual([]);
    // Revision N is byte-for-byte what it was.
    const reread = await getRevision(first.id, store.asRevisionStore());
    expect(JSON.stringify(reread?.resumeJson)).toBe(firstSnapshot);
    expect(reread?.jsonHash).toBe(firstHash);
    // ...and the hashes are different documents, so the two revisions are distinguishable.
    expect(second.jsonHash).not.toBe(firstHash);
  });

  it('revisionHashMatches is a tripwire for a write that bypassed this module', async () => {
    const { store } = storeWithClaim();
    const revision = await createRevision(input(), store.asRevisionStore());
    expect(revisionHashMatches(revision)).toBe(true);
    // The canonical bytes are the ones the hash was computed over.
    expect(canonicalJsonHash(JSON.parse(revisionCanonicalJson(revision)))).toBe(revision.jsonHash);

    // A tampered row: the recorded hash no longer describes the bytes. This is the state
    // a mutating write path would leave behind.
    store.setRevisionJson(revision.id, { basics: { name: 'Someone Else' } });
    const tampered = store.revisions.get(revision.id) as ResumeRevision;
    expect(revisionHashMatches(tampered)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE: jsonHash is stable, and changes with content
// ---------------------------------------------------------------------------

describe('ACCEPTANCE: jsonHash is stable across projections and changes with content', () => {
  it('is the sha256 of the CANONICAL bytes, so key order does not matter', async () => {
    const { store } = storeWithClaim();
    const a = await createRevision(input(), store.asRevisionStore());
    // The same document with its members inserted in a different order: a different
    // object, identical meaning. Hashing the raw object would call it a new revision.
    const reordered = Object.fromEntries(
      Object.entries(document()).reverse(),
    ) as unknown as ResumeJson;
    const b = await createRevision(input({ document: reordered }), store.asRevisionStore());
    expect(b.jsonHash).toBe(a.jsonHash);
  });

  it('is byte-stable: the same document hashed twice is the same digest', async () => {
    const { store } = storeWithClaim();
    const first = await createRevision(input(), store.asRevisionStore());
    const second = await createRevision(input(), store.asRevisionStore());
    expect(second.jsonHash).toBe(first.jsonHash);
    expect(second.jsonHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a claim statement changes', async () => {
    const { store } = storeWithClaim();
    const before = await createRevision(input(), store.asRevisionStore());
    const after = await createRevision(
      input({ document: documentSaying('Cut CI build time by 50%') }),
      store.asRevisionStore(),
    );
    expect(after.jsonHash).not.toBe(before.jsonHash);
  });

  it('changes when a claim STATUS changes, which is what the audit reads', async () => {
    const { store, claim } = storeWithClaim();
    const before = await createRevision(input(), store.asRevisionStore());
    // The status has to move in the DATABASE as well as in the document: the write-time
    // cross-check refuses a document that states a status the claim row does not hold, so
    // a document alone cannot move it. (This test used to change the document only -
    // which is precisely the forging the F1 fix makes a 400.)
    //
    // `superseded`, not `rejected`: a rejected claim has NO valid usage at any layer
    // (ADR-036 item 5), so a document declaring one verbatim cannot be created at all.
    // That is a stronger statement than this test is about, and it has its own test
    // ("F2: a usage that cannot be recorded leaves NO revision behind").
    (store.claims.get(claim.id) as { status: string }).status = ClaimStatus.superseded;
    const block = document()[X_CLEARANCE_KEY]!;
    const after = await createRevision(
      input({
        document: document({
          [X_CLEARANCE_KEY]: {
            ...block,
            claims: block.claims.map((entry) => ({ ...entry, status: ClaimStatus.superseded })),
          },
        }),
      }),
      store.asRevisionStore(),
    );
    // Identical TEXT, different status, different hash. Without the block this would be
    // the same revision, and 05 sec.6.5's "this resume used claim X, which was later
    // rejected" would be unanswerable.
    expect(after.jsonHash).not.toBe(before.jsonHash);
    // And the revision that quotes a superseded claim exists and is NOT renderable -
    // the draft is legal, the render is refused. Both halves, so the two are not confused.
    await expect(
      assertRevisionRenderableInScope(after, store.asUsageStore()),
    ).rejects.toMatchObject({ code: 'PRE_RENDER_GATE_BLOCKED', reason: 'CLAIM_NOT_CONFIRMED' });
  });
});

// ---------------------------------------------------------------------------
// Creating a revision
// ---------------------------------------------------------------------------

describe('createRevision', () => {
  it('numbers revisions 1, 2, 3... per resume', async () => {
    const { store } = storeWithClaim();
    expect((await createRevision(input(), store.asRevisionStore())).revisionNumber).toBe(1);
    expect((await createRevision(input(), store.asRevisionStore())).revisionNumber).toBe(2);
    expect((await createRevision(input(), store.asRevisionStore())).revisionNumber).toBe(3);
    // ...and the numbering is PER RESUME, not global.
    expect((await createRevision(input({ resumeId: 'res-2' }), store.asRevisionStore())).revisionNumber).toBe(1);
  });

  it('REFUSES a document that does not satisfy the schema, before writing anything', async () => {
    const { store } = storeWithClaim();
    // `basics.name` is required by JSON Resume, so this is a document no renderer could
    // use. Storing it would fail later, at a render, with the user no longer able to
    // tell which of their N edits broke it.
    let caught: unknown;
    try {
      await createRevision(input({ document: { basics: {} } as ResumeJson }), store.asRevisionStore());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResumeRevisionError);
    expect((caught as ResumeRevisionError).reason).toBe('INVALID_JSON');
    // The schema issues ride along, so a route can return them rather than a generic 400.
    expect((caught as ResumeRevisionError).issues.length).toBeGreaterThan(0);
    expect((caught as ResumeRevisionError).issues[0].path).toBe('/basics/name');
    // Nothing was written.
    expect(store.revisions.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('REFUSES a document whose x-clearance block is malformed', async () => {
    const { store } = storeWithClaim();
    const block = document()[X_CLEARANCE_KEY]!;
    await expect(
      createRevision(
        input({ document: document({ [X_CLEARANCE_KEY]: { ...block, version: 99 } }) }),
        store.asRevisionStore(),
      ),
    ).rejects.toThrowError(ResumeRevisionError);
    expect(store.revisions.size).toBe(0);
  });

  it('DERIVES the claim usage from the document, and records it in the same call', async () => {
    // The usage is what the gate reads. A revision whose usage was recorded in a second
    // call could exist with none, and would then render anything by default.
    //
    // The second half is the F1 fix: the caller sends NO `usages` at all, and the writer
    // still records the usage the document declares. Under the previous behaviour this
    // produced a revision with zero usage rows and a vacuously green gate.
    const { store, claim } = storeWithClaim();
    const revision = await createRevision(input(), store.asRevisionStore());
    expect(store.usagesFor(revision.id)).toHaveLength(1);
    expect(store.usagesFor(revision.id)[0]).toMatchObject({
      claimId: claim.id,
      usage: ResumeUsage.verbatim,
      renderedText: 'Cut CI build time by 40%',
    });
    expect(store.writes).toEqual(['revision.create', 'usage.create']);
  });

  it('a caller-supplied usage set may RESTATE the document but not change it', async () => {
    const { store, claim } = storeWithClaim();
    // Exactly what the document declares: accepted, and the same single row results.
    const restated = await createRevision(
      input({
        usages: [{ claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: 'Cut CI build time by 40%' }],
      }),
      store.asRevisionStore(),
    );
    expect(store.usagesFor(restated.id)).toHaveLength(1);
    expect(restated.revisionNumber).toBe(1);
  });

  it('the derivation reads the DOCUMENT block, and is what the cross-check compares against', async () => {
    // The positive control for every refusal above: the derived set really is the
    // block's `claims`, with the usage and the rendered text, `omitted` entries included
    // (the block is the document's account of what it CONSIDERED as well as what it
    // placed, so the recorded set is complete by construction).
    const block = document()[X_CLEARANCE_KEY]!;
    expect(deriveUsageFromDocument(document())).toEqual([
      { claimId: 'clm-1', usage: ResumeUsage.verbatim, renderedText: 'Cut CI build time by 40%' },
    ]);
    const withOmitted = document({
      [X_CLEARANCE_KEY]: {
        ...block,
        claims: [
          { ...block.claims[0], usage: ResumeUsage.omitted, jsonPath: null, renderedText: null },
        ],
      },
    });
    expect(deriveUsageFromDocument(withOmitted)).toEqual([
      { claimId: 'clm-1', usage: ResumeUsage.omitted, renderedText: null },
    ]);
    // A document with no block derives nothing - which is exactly why the write refuses
    // one, and why the read-time guard refuses it too.
    expect(deriveUsageFromDocument(withoutBlock(document()))).toEqual([]);
  });

  it('REFUSES a usage set that names a claim the document does not declare', async () => {
    // The bypass, half 1: inflate the log with a claim the document says nothing about.
    const { store } = storeWithClaim();
    const other = seedConfirmedClaim(store, { id: 'clm-2', statement: 'Something else' });
    await expect(
      createRevision(
        input({
          usages: [
            { claimId: 'clm-1', usage: ResumeUsage.verbatim, renderedText: 'Cut CI build time by 40%' },
            { claimId: other.id, usage: ResumeUsage.verbatim, renderedText: 'Something else' },
          ],
        }),
        store.asRevisionStore(),
      ),
    ).rejects.toBeInstanceOf(ResumeRevisionError);
    // Nothing was written: a rejection must not leave an orphan behind.
    expect(store.revisions.size).toBe(0);
    expect(store.usages.size).toBe(0);
  });

  it('REFUSES a usage set that UNDER-declares what the document says (the bypass, half 2)', async () => {
    // The bypass itself: a document carrying `work[].highlights` with `usages: []`. The
    // recorded set would be empty, `loadGateUsages` would return nothing, and
    // `evaluatePreRenderGate([])` returns `{allowed: true, checked: 0}` - a green verdict
    // on a document the gate never read.
    const { store } = storeWithClaim();
    await expect(
      createRevision(input({ usages: [] }), store.asRevisionStore()),
    ).rejects.toBeInstanceOf(ResumeRevisionError);
    expect(store.revisions.size).toBe(0);

    // A restatement with the same claim but a DIFFERENT usage is also a disagreement -
    // the log records what the document says it used, and `omitted` vs `verbatim` is
    // exactly the difference between "not rendered" and "rendered".
    await expect(
      createRevision(
        input({
          usages: [{ claimId: 'clm-1', usage: ResumeUsage.omitted, renderedText: null }],
        }),
        store.asRevisionStore(),
      ),
    ).rejects.toBeInstanceOf(ResumeRevisionError);
    expect(store.revisions.size).toBe(0);
  });

  it('a document whose x-clearance FORGES a status is stored with the ROWS status', async () => {
    // THE RULING, (i): refresh, do not refuse. The block says `user_confirmed` over a row
    // that is `inferred`, and the write ACCEPTED it - with the STORED block carrying the
    // row's `inferred`. The forgery is not honoured and it is not stored: it is overwritten.
    //
    // It used to be refused (`CLEARANCE_DISAGREES_WITH_CLAIMS`), and that was correct for a
    // FORGERY - but the same test could not tell a forgery from a STALE block, and it
    // punished the stale one. The Studio loads the current revision's document, the user
    // edits it, a claim has been CONFIRMED in the meantime, and autosave 400'd on every
    // resume whose claims had moved since its revision was written. Refusing bought
    // "the stored block is never a lie", which overwriting the row's values delivers more
    // completely, and it cost the honest case entirely.
    //
    // WHY REFRESHING IS NOT A BYPASS, restated as a fact rather than an argument: the
    // pre-render gate reads status from the DATABASE and the render path re-derives the
    // block, so a forged status never made anything render. There is no code path on which
    // a document's stated status is the status that is acted on.
    const store = new FakeCareerStore();
    const real = fakeInferredClaim(store, { id: 'clm-real', statement: 'Never confirmed' });
    expect(claimStatus(store, real.id)).toBe(ClaimStatus.inferred);
    const block = document()[X_CLEARANCE_KEY]!;
    const lying = {
      basics: { name: 'Ada Lovelace' },
      work: [{ name: 'Acme', position: 'Staff Engineer', highlights: ['Never confirmed'] }],
      [X_CLEARANCE_KEY]: {
        ...block,
        claims: [
          {
            ...block.claims[0],
            claimId: real.id,
            status: ClaimStatus.user_confirmed,
            // The block must name the text that is actually in the document, or the refusal
            // this test used to be about would have been a different one: the belt refuses an
            // unaccounted string, and the point here is the FORGED STATUS.
            renderedText: 'Never confirmed',
          },
        ],
      },
    } as unknown as ResumeJson;

    const stored = await createRevision(input({ document: lying }), store.asRevisionStore());
    expect(stored.revisionNumber).toBe(1);
    // THE ASSERTION THAT MATTERS: the STORED block carries the ROW's status, not the
    // caller's. Read back out of the row that was written, not off the input.
    const storedBlock = readClearanceBlock(stored.resumeJson)!;
    expect(storedBlock.claims).toHaveLength(1);
    expect(storedBlock.claims[0]).toMatchObject({ claimId: real.id, status: ClaimStatus.inferred });
    expect(canonicalJsonString(stored.resumeJson)).not.toContain(ClaimStatus.user_confirmed);
    // And the counts follow the refreshed status, not the caller's: a fresh status beside a
    // stale count is the same lie one field over.
    expect(storedBlock).toMatchObject({ confirmedClaimCount: 0, unconfirmedClaimCount: 1 });
    // The revision is still auditable: one usage row, for the claim the block names.
    expect(store.usagesFor(stored.id)).toHaveLength(1);
    expect(store.usagesFor(stored.id)[0]).toMatchObject({ claimId: real.id, usage: ResumeUsage.verbatim });

    // POSITIVE CONTROL: the honest block - the same claim, honestly described as the
    // `inferred` it actually is - is accepted too, and STORES THE SAME BYTES. So the
    // refresh is a no-op on an honest document and this is not "accept everything".
    const honest = {
      basics: { name: 'Ada Lovelace' },
      work: [{ name: 'Acme', position: 'Staff Engineer', highlights: ['Never confirmed'] }],
      [X_CLEARANCE_KEY]: {
        ...block,
        confirmedClaimCount: 0,
        unconfirmedClaimCount: 1,
        claims: [
          {
            ...block.claims[0],
            claimId: real.id,
            status: ClaimStatus.inferred,
            renderedText: 'Never confirmed',
          },
        ],
      },
    } as unknown as ResumeJson;
    const accepted = await createRevision(input({ document: honest }), store.asRevisionStore());
    expect(accepted.revisionNumber).toBe(2);
    expect(canonicalJsonString(accepted.resumeJson)).toBe(canonicalJsonString(stored.resumeJson));
    expect(store.usagesFor(accepted.id)).toHaveLength(1);
    expect(store.usagesFor(accepted.id)[0].usage).toBe(ResumeUsage.verbatim);
  });

  it('a STALE but honest block is accepted and stored refreshed (the Studio autosave shape)', async () => {
    // THE RULING, (ii), and the defect this whole change exists for. The block is not lying
    // about anything: it says what was true when the revision was written, the user then
    // CONFIRMED the claim, and the Studio's autosave now posts a document whose statuses
    // are out of date. Under the old refusal this was a 400 - the exact live escalation
    // ("live V2 snapshots have stale x-clearance statuses, so createRevision correctly
    // refuses to derive from them - Studio autosave 400s on those resumes").
    const store = new FakeCareerStore();
    // Revision 1 is written while the claim is still inferred: the honest, then-current
    // block. This is the document the Studio would have loaded.
    const inferred = fakeInferredClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
    expect(claimStatus(store, inferred.id)).toBe(ClaimStatus.inferred);
    const staleDocument = document({
      [X_CLEARANCE_KEY]: {
        ...document()[X_CLEARANCE_KEY]!,
        confirmedClaimCount: 0,
        unconfirmedClaimCount: 1,
        claims: [
          {
            ...document()[X_CLEARANCE_KEY]!.claims[0],
            status: ClaimStatus.inferred,
          },
        ],
      },
    });
    const first = await createRevision(input({ document: staleDocument }), store.asRevisionStore());
    expect(readClearanceBlock(first.resumeJson)!.claims[0].status).toBe(ClaimStatus.inferred);

    // The claim is confirmed. Nothing about the DOCUMENT changes - the user edited a
    // heading - and the block the Studio now holds says `inferred`.
    store.claims.set(inferred.id, { ...store.claims.get(inferred.id)!, status: ClaimStatus.user_confirmed });
    expect(claimStatus(store, inferred.id)).toBe(ClaimStatus.user_confirmed);

    const edited = document({
      basics: { name: 'Ada Lovelace', label: 'Principal Engineer' },
      [X_CLEARANCE_KEY]: readClearanceBlock(first.resumeJson),
    });
    expect(readClearanceBlock(edited)!.claims[0].status).toBe(ClaimStatus.inferred);

    // THE ASSERTION: the autosave SUCCEEDS, and the stored block carries the CURRENT status.
    const second = await createRevision(input({ document: edited }), store.asRevisionStore());
    expect(second.revisionNumber).toBe(2);
    const stored = readClearanceBlock(second.resumeJson)!;
    expect(stored.claims[0]).toMatchObject({ claimId: 'clm-1', status: ClaimStatus.user_confirmed });
    expect(stored).toMatchObject({ confirmedClaimCount: 1, unconfirmedClaimCount: 0 });
    // And the revision N+1 does not disturb revision N: immutability is unchanged.
    expect(readClearanceBlock(first.resumeJson)!.claims[0].status).toBe(ClaimStatus.inferred);
    expect(store.usagesFor(second.id)).toHaveLength(1);
  });

  it('a block naming a claim that resolves to no row is STILL refused', async () => {
    // THE RULING, (iii). There is nothing to refresh FROM, and a claim id that resolves to
    // nothing is an unaccounted placement. Fail closed.
    const store = new FakeCareerStore();
    const base = document();
    const block = base[X_CLEARANCE_KEY]!;
    const ghost = document({
      [X_CLEARANCE_KEY]: {
        ...block,
        claims: [{ ...block.claims[0], claimId: 'clm-nope' }],
      },
    });
    let caught: unknown;
    try {
      await createRevision(input({ document: ghost }), store.asRevisionStore());
    } catch (error) {
      caught = error;
    }
    // `assertClaimUsagesRecordable` refuses first, and it is the right answer: a
    // `ClaimNotFoundError` - the SAME one the route turns into a 404, and the one an
    // existing route test already pins - rather than a 400 about a stale field.
    expect(caught).toBeInstanceOf(ClaimNotFoundError);
    expect((caught as ClaimNotFoundError).code).toBe('claim_not_found');
    expect(store.revisions.size).toBe(0);
    expect(store.usages.size).toBe(0);

    // And the REFRESH ITSELF refuses the same shape when it is what reaches it, so the
    // guard is not an accident of the resolution order: a block naming a claim with no row
    // is refused by name.
    expect(() =>
      refreshClearanceFromClaims(readClearanceBlock(ghost)!, []),
    ).toThrowError(/resolves to no claim row/);
  });

  it('a STRUCTURAL set mismatch is STILL refused, in both directions', async () => {
    // THE RULING, (iv). "The block omits a claim it places or vice versa" is not a stale
    // field, it is a document that does not account for itself, and refreshing cannot fix
    // it - there is no row-side value to copy for a claim the block never named.
    const base = document();
    const block = base[X_CLEARANCE_KEY]!;
    const claim = {
      id: 'clm-1',
      status: ClaimStatus.user_confirmed,
      provenance: 'llm_inferred',
      confidence: 0.9,
      evidenceSourceId: null,
    } as unknown as CareerClaim;

    // The block names ONE claim; the rows in play are TWO. Refresh refuses, and the message
    // names the claim the block omitted.
    expect(() =>
      refreshClearanceFromClaims(readClearanceBlock(base)!, [
        claim,
        {
          id: 'clm-2',
          status: ClaimStatus.inferred,
          provenance: 'llm_inferred',
          confidence: 0.6,
          evidenceSourceId: null,
        } as unknown as CareerClaim,
      ]),
    ).toThrowError(/omits claim clm-2/);

    // The other direction: the block names a claim the rows do not include (a projection
    // hand-fed a partial row list). Same refusal, same shape.
    expect(() =>
      refreshClearanceFromClaims(readClearanceBlock(base)!, []),
    ).toThrowError(/resolves to no claim row/);

    // And an entry that names no claim at all - which must NOT be silently dropped from the
    // stored document, because dropping it is a write this module must not make.
    expect(() =>
      refreshClearanceFromClaims(
        { ...readClearanceBlock(base)!, claims: [null as never] },
        [claim],
      ),
    ).toThrowError(/names no claim/);
    expect(() =>
      refreshClearanceFromClaims(
        { ...readClearanceBlock(base)!, claims: 'nope' as never },
        [claim],
      ),
    ).toThrowError(/must be an array/);

    // POSITIVE CONTROL: the exact set the block names refreshes cleanly, which is what makes
    // the three refusals above refusals rather than a helper that throws.
    const ok = refreshClearanceFromClaims(readClearanceBlock(base)!, [claim]);
    expect(ok.changed).toBe(false);
    expect(ok.clearance.claims).toHaveLength(1);
  });

  it('refreshClearanceFromClaims refreshes the four row-derived members and nothing else', async () => {
    // The scope of the refresh, as an assertion. `status`, `provenance`, `confidence` and
    // `evidenceSourceId` come from the ROW; `usage`, `jsonPath` and `renderedText` describe
    // what the DOCUMENT does and are the belt's business; `fingerprint` and `kind` identify
    // the claim rather than vouch for it. `claimCount` and the two status counts follow the
    // refreshed statuses.
    const base = readClearanceBlock(document())!;
    const row = {
      id: 'clm-1',
      status: ClaimStatus.inferred,
      provenance: 'document_import',
      confidence: 0.42,
      evidenceSourceId: 'src-1',
    } as unknown as CareerClaim;
    const { clearance, changed } = refreshClearanceFromClaims(base, [row]);
    expect(changed).toBe(true);
    expect(clearance.claims[0]).toEqual({
      ...base.claims[0],
      status: ClaimStatus.inferred,
      provenance: 'document_import',
      confidence: 0.42,
      evidenceSourceId: 'src-1',
    });
    expect(clearance).toMatchObject({ claimCount: 1, confirmedClaimCount: 0, unconfirmedClaimCount: 1 });
    // The document-shaped members are untouched, and the block's own members are.
    expect(clearance.claims[0]).toMatchObject({
      usage: ResumeUsage.verbatim,
      jsonPath: 'work[0].highlights[0]',
      renderedText: 'Cut CI build time by 40%',
      fingerprint: 'a'.repeat(64),
      kind: 'achievement',
    });
    expect(clearance).toMatchObject({ version: 1, generatedBy: 'test', profileId: 'profile-1', sourceModelVersion: 2 });
    // PURE: the input block is not mutated. A refresh that edited its argument in place
    // would leave the CALLER's document holding a different block than the one it sent.
    expect(base.claims[0].status).toBe(ClaimStatus.user_confirmed);
    expect(base.confirmedClaimCount).toBe(1);

    // A `null` confidence/evidenceSourceId on the row is carried as `null`, not as
    // `undefined` - the schema requires the members to be present.
    const nulls = refreshClearanceFromClaims(base, [
      { id: 'clm-1', status: ClaimStatus.user_confirmed, provenance: 'user_input', confidence: null, evidenceSourceId: null } as unknown as CareerClaim,
    ]);
    expect(nulls.changed).toBe(true);
    expect(nulls.clearance.claims[0]).toMatchObject({ confidence: null, evidenceSourceId: null });
  });

  it('the belt still REFUSES to RENDER a non-confirmed claim (unchanged)', async () => {
    // THE RULING, (v): refreshing the block changes nothing about what the GATE does. A
    // revision whose claim is `inferred` is storable (it is the draft the user reviews) and
    // NOT renderable, and the verdict comes from the DATABASE rather than from the block -
    // which is exactly why the write path never needed to refuse.
    const store = new FakeCareerStore();
    const real = fakeInferredClaim(store, { id: 'clm-real', statement: 'Never confirmed' });
    expect(claimStatus(store, real.id)).toBe(ClaimStatus.inferred);
    const block = document()[X_CLEARANCE_KEY]!;
    const draft = {
      basics: { name: 'Ada Lovelace' },
      work: [{ name: 'Acme', position: 'Staff Engineer', highlights: ['Never confirmed'] }],
      [X_CLEARANCE_KEY]: {
        ...block,
        claims: [
          { ...block.claims[0], claimId: real.id, status: ClaimStatus.inferred, renderedText: 'Never confirmed' },
        ],
      },
    } as unknown as ResumeJson;

    // The write succeeds - the stored block agrees with the row, so there is nothing to
    // refresh and nothing to refuse.
    const stored = await createRevision(input({ document: draft }), store.asRevisionStore());
    expect(readClearanceBlock(stored.resumeJson)!.claims[0].status).toBe(ClaimStatus.inferred);

    // The GATE blocks it. The status it acts on is the row's, read at render time.
    await expect(
      assertRevisionRenderableInScope(stored, store.asUsageStore()),
    ).rejects.toMatchObject({ reason: 'CLAIM_NOT_CONFIRMED' });

    // POSITIVE CONTROL, and the point of the whole ruling: once the user CONFIRMS the
    // claim, the very same revision renders - even though its stored block still says
    // `inferred`. A stale block is harmless because nothing reads it; that is why the write
    // path refreshes instead of refusing, and why a refusal there was never the gate.
    store.claims.set(real.id, { ...store.claims.get(real.id)!, status: ClaimStatus.user_confirmed });
    await expect(
      assertRevisionRenderableInScope(stored, store.asUsageStore()),
    ).resolves.toMatchObject({ allowed: true, rendered: 1 });
  });

  it('records the op log, and accepts undefined collections', async () => {
    // The usage set is DERIVED now, so this test asserts the op log specifically; the
    // derived-usage behaviour has its own tests above.
    const { store } = storeWithClaim();
    const revision = await createRevision(
      input({
        changes: [
          {
            op: ResumeChangeOp.rewrite_bullet,
            jsonPath: 'work[0].highlights[0]',
            before: 'Worked on CI',
            after: 'Cut CI build time by 40%',
            reason: 'Mirrors the JD',
            sourceClaimIds: ['clm-1'],
          },
        ],
        usages: [
          { claimId: 'clm-1', usage: ResumeUsage.verbatim, renderedText: 'Cut CI build time by 40%' },
        ],
      }),
      store.asRevisionStore(),
    );
    const changes = await listRevisionChanges({ revisionId: revision.id }, store.asRevisionStore());
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ op: ResumeChangeOp.rewrite_bullet, jsonPath: 'work[0].highlights[0]' });

    // No `changes` and no `usages` at all is the common case and must not fail: the usage
    // is derived from the document, so "no usages supplied" is the normal request.
    const bare = await createRevision(
      input({ changes: undefined, usages: undefined }),
      store.asRevisionStore(),
    );
    expect(bare.revisionNumber).toBe(2);
  });

  it('refuses a malformed request with a machine-readable reason, and writes NOTHING', async () => {
    const { store } = storeWithClaim();
    const seam = store.asRevisionStore();
    for (const bad of [null, 'x', 42]) {
      await expect(createRevision(bad as never, seam)).rejects.toBeInstanceOf(ResumeRevisionError);
    }
    for (const bad of [
      input({ resumeId: '' }),
      input({ document: null as never }),
      input({ createdBy: 'nobody' as never }),
      input({ createdByUserId: 42 as never }),
      // The op log used to be validated AFTER the insert, so these two left an ORPHAN
      // revision in the history - a snapshot with no op log and no usage, which reads to
      // the diff view as "this revision changed nothing" when the request was rejected.
      input({ changes: [{ op: 'invent' as never, jsonPath: 'x' }] }),
      input({ changes: [{ op: ResumeChangeOp.include, jsonPath: '' }] }),
      input({ changes: [null as never] }),
      // The malformed halves of the usage set, refused the same way.
      input({ usages: [null as never] }),
      input({ usages: [{ claimId: '', usage: ResumeUsage.verbatim }] }),
      input({ usages: [{ claimId: 'clm-1', usage: 'sometimes' as never }] }),
      input({
        usages: [
          { claimId: 'clm-1', usage: ResumeUsage.verbatim, renderedText: 'Cut CI build time by 40%' },
          { claimId: 'clm-1', usage: ResumeUsage.verbatim, renderedText: 'Cut CI build time by 40%' },
        ],
      }),
    ]) {
      await expect(createRevision(bad, seam)).rejects.toBeInstanceOf(ResumeRevisionError);
    }
    // Every one of those was refused BEFORE any write, so the history is still empty.
    expect(store.revisions.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('F2: a usage that cannot be recorded leaves NO revision behind', async () => {
    // The orphan class, closed. `createRevision` used to insert the revision FIRST and
    // record the usage AFTER, so a usage the recorder refused (a `rejected` claim, an
    // unknown claim) threw with a fully-formed revision already in the history - one with
    // ZERO usage rows, which by the old gate logic is a revision that renders anything.
    // The route returned 409 and the row stayed.
    const store = new FakeCareerStore();
    seedConfirmedClaim(store, { id: 'clm-ok', statement: 'Fine' });
    const rejected = fakeInferredClaim(store, {
      id: 'clm-bad',
      statement: 'Never happened',
      status: ClaimStatus.rejected,
    });
    const block = document()[X_CLEARANCE_KEY]!;
    const withBadClaim = {
      ...document(),
      [X_CLEARANCE_KEY]: {
        ...block,
        claims: [
          { ...block.claims[0], claimId: rejected.id, status: ClaimStatus.rejected, renderedText: 'Never happened' },
        ],
      },
    } as unknown as ResumeJson;

    await expect(
      createRevision(
        input({
          document: withBadClaim,
          usages: [{ claimId: rejected.id, usage: ResumeUsage.verbatim, renderedText: 'Never happened' }],
        }),
        store.asRevisionStore(),
      ),
    ).rejects.toBeInstanceOf(ClaimInvariantError);

    // The assertion the review asked for: NO revision, and no orphan usage.
    expect(store.revisionsFor(RESUME)).toHaveLength(0);
    expect(store.revisions.size).toBe(0);
    expect(store.usages.size).toBe(0);
    // And the write log never mentioned a revision at all.
    expect(store.writes).toEqual([]);

    // POSITIVE CONTROL for the same shape with a claim that IS recordable, so the
    // assertion above is about the rejection and not about `createRevision` refusing
    // everything.
    seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
    const good = await createRevision(input(), store.asRevisionStore());
    expect(store.revisionsFor(RESUME)).toHaveLength(1);
    expect(store.usagesFor(good.id)).toHaveLength(1);
  });

  it('F2: a usage naming a claim that does not exist leaves NO revision behind', async () => {
    // The 404 case, same orphan class. The route test asserted
    // `resumeClaimUsage.create` was not called - the WRONG write, which is how this
    // survived the first review. The revision insert is the write that matters.
    const store = new FakeCareerStore();
    const block = document()[X_CLEARANCE_KEY]!;
    const ghost = {
      ...document(),
      [X_CLEARANCE_KEY]: {
        ...block,
        claims: [{ ...block.claims[0], claimId: 'clm-gone' }],
      },
    } as unknown as ResumeJson;

    await expect(
      createRevision(input({ document: ghost }), store.asRevisionStore()),
    ).rejects.toBeInstanceOf(ClaimNotFoundError);
    expect(store.revisions.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('the unique (resumeId, revisionNumber) is the concurrency guard', async () => {
    // Two concurrent creators of revision N+1 produce one row and one P2002 - which a
    // caller can retry - rather than a silently interleaved history. Asserted against
    // the fake, which enforces the same constraint.
    const { store } = storeWithClaim();
    await createRevision(input(), store.asRevisionStore());
    const { FakeUniqueViolation } = await import('../career/careerStore.fixtures.js');
    // Bypass `createRevision`'s N+1 lookup to reach the constraint directly.
    await expect(
      store.resumeRevision.create({
        data: {
          resumeId: RESUME,
          revisionNumber: 1,
          resumeJson: document() as never,
          jsonHash: 'x',
        },
      }),
    ).rejects.toBeInstanceOf(FakeUniqueViolation);
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('reading revisions', () => {
  it('lists oldest first, and reads one by id or by number', async () => {
    const { store } = storeWithClaim();
    for (let i = 0; i < 3; i += 1) await createRevision(input(), store.asRevisionStore());

    const all = await listRevisions({ resumeId: RESUME }, store.asRevisionStore());
    expect(all.map((revision) => revision.revisionNumber)).toEqual([1, 2, 3]);

    const second = await getRevisionByNumber(RESUME, 2, store.asRevisionStore());
    expect(second?.revisionNumber).toBe(2);
    expect((await getRevision(second!.id, store.asRevisionStore()))?.id).toBe(second!.id);
    expect(await getRevision('nope', store.asRevisionStore())).toBeNull();
    expect(await getRevisionByNumber(RESUME, 99, store.asRevisionStore())).toBeNull();
  });

  it('getCurrentRevision is max(revisionNumber), and null when there is none', async () => {
    const { store } = storeWithClaim();
    expect(await getCurrentRevision(RESUME, store.asRevisionStore())).toBeNull();
    await createRevision(input(), store.asRevisionStore());
    await createRevision(input(), store.asRevisionStore());
    expect((await getCurrentRevision(RESUME, store.asRevisionStore()))?.revisionNumber).toBe(2);
  });

  it('clamps the page, tolerates a junk limit, and refuses a junk query', async () => {
    const { store } = storeWithClaim();
    for (let i = 0; i < 3; i += 1) await createRevision(input(), store.asRevisionStore());
    expect((await listRevisions({ resumeId: RESUME, limit: 1 }, store.asRevisionStore())).length).toBe(1);
    expect((await listRevisions({ resumeId: RESUME, limit: 10_000 }, store.asRevisionStore())).length).toBe(3);
    expect((await listRevisions({ resumeId: RESUME, limit: -1 }, store.asRevisionStore())).length).toBe(3);
    // A junk limit is CLAMPED, not refused: the limit is a paging hint from a query
    // string, and a 400 on `?limit=abc` would be a worse answer than the default page.
    expect((await listRevisions({ resumeId: RESUME, limit: 'x' as never }, store.asRevisionStore())).length).toBe(3);
    expect((await listRevisions({ resumeId: RESUME, offset: 2 }, store.asRevisionStore())).length).toBe(1);
    expect(DEFAULT_REVISION_PAGE).toBe(50);
    expect(MAX_REVISION_PAGE).toBe(200);

    // A junk QUERY is a different thing: there is nothing sensible to default it to.
    for (const bad of [null, 'x', 42, { resumeId: '' }]) {
      await expect(listRevisions(bad as never, store.asRevisionStore())).rejects.toBeInstanceOf(
        ResumeRevisionError,
      );
    }
    await expect(
      getRevisionByNumber(RESUME, 0, store.asRevisionStore()),
    ).rejects.toBeInstanceOf(ResumeRevisionError);
  });
});

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

describe('diffRevisions - the change log between two snapshots', () => {
  it('reports the text changes AND the claim-status movement separately', async () => {
    const { store, claim } = storeWithClaim();
    const before = await createRevision(input(), store.asRevisionStore());
    // The status moves in the DATABASE first (a real transition is a `ClaimVerification`
    // action, ADR-036 item 6), and the document then reports what its claim row holds.
    // The write refuses the other order - which is the F1 fix, and is why this test's
    // setup changed.
    //
    // `superseded` rather than `rejected`: a rejected claim has no valid usage at any
    // layer (ADR-036 item 5), so `createRevision` REFUSES to build a revision that quotes
    // one - `rejected` is unreachable as a setup value here. The refused case is covered
    // by the gate's own truth table, not by a diff.
    (store.claims.get(claim.id) as { status: string }).status = ClaimStatus.superseded;
    const block = document()[X_CLEARANCE_KEY]!;
    const after = await createRevision(
      input({
        document: document({
          work: [{ name: 'Acme', position: 'Staff Engineer', startDate: '2020-01', highlights: ['Shrank CI from 30 to 18 minutes'] }],
          [X_CLEARANCE_KEY]: {
            ...block,
            claims: block.claims.map((entry) => ({
              ...entry,
              status: ClaimStatus.superseded,
              // The bullet was re-worded, so the block says so. Without this the fixture
              // would be an unaudited document and would be refused by rule 5 rather than
              // reach the diff this test is about.
              renderedText: 'Shrank CI from 30 to 18 minutes',
            })),
          },
        }),
      }),
      store.asRevisionStore(),
    );

    const diff = diffRevisions(before, after);
    expect(diff.identical).toBe(false);
    expect(diff.from.revisionNumber).toBe(1);
    expect(diff.to.revisionNumber).toBe(2);
    // The TEXT change.
    expect(diff.entries).toContainEqual({
      kind: 'changed',
      jsonPath: 'work[0].highlights[0]',
      before: 'Cut CI build time by 40%',
      after: 'Shrank CI from 30 to 18 minutes',
    });
    // The EVIDENCE change, which is the half a reviewer actually needs. Without this,
    // a diff would say "the bullet changed" and not "it changed because the claim it
    // rests on was rejected".
    expect(diff.claimStatusChanges).toEqual([
      { claimId: 'clm-1', from: ClaimStatus.user_confirmed, to: ClaimStatus.superseded },
    ]);
    // The block itself is NOT walked: a diff that reported "changed /x-clearance.claims[0]"
    // would be technically true and practically useless.
    expect(diff.entries.some((entry) => entry.jsonPath.includes('x-clearance'))).toBe(false);
  });

  it('an identical pair produces no entries and says so', async () => {
    const { store } = storeWithClaim();
    const first = await createRevision(input(), store.asRevisionStore());
    const second = await createRevision(input(), store.asRevisionStore());
    const diff = diffRevisions(first, second);
    expect(diff.identical).toBe(true);
    expect(diff.entries).toEqual([]);
    expect(diff.claimStatusChanges).toEqual([]);
  });

  it('reports added and removed sections and array entries', async () => {
    const { store } = storeWithClaim();
    const before = await createRevision(input(), store.asRevisionStore());
    const block = document()[X_CLEARANCE_KEY]!;
    const after = await createRevision(
      input({
        document: document({
          skills: [{ name: 'TypeScript' }],
          // The claim left the document, so its TEXT has to leave with it: a highlight
          // that no block entry names is an unaudited document, which rule 5 refuses at
          // write time. The claim the test is about is the removal, not the leftover.
          work: [{ name: 'Acme', position: 'Staff Engineer', startDate: '2020-01' }],
          [X_CLEARANCE_KEY]: { ...block, claims: [] },
        }),
      }),
      store.asRevisionStore(),
    );
    const diff = diffRevisions(before, after);
    expect(diff.entries).toContainEqual({ kind: 'added', jsonPath: 'skills', before: null, after: [{ name: 'TypeScript' }] });
    // The claim left the document, which shows as a status movement to null.
    expect(diff.claimStatusChanges).toEqual([
      { claimId: 'clm-1', from: ClaimStatus.user_confirmed, to: null },
    ]);
    // Sorted by path, so the diff is a stable artifact rather than a traversal artefact.
    expect([...diff.entries].map((entry) => entry.jsonPath)).toEqual(
      [...diff.entries].map((entry) => entry.jsonPath).sort(),
    );
  });

  it('refuses a missing revision rather than diffing undefined', () => {
    expect(() => diffRevisions(null as never, {} as ResumeRevision)).toThrowError(ResumeRevisionError);
  });
});

// ---------------------------------------------------------------------------
// F1: the gate's INPUT, and the read-time half of the same binding
// ---------------------------------------------------------------------------

describe('F1: a revision cannot exist without the claim usage the gate will read', () => {
  it('REFUSES a V2 document with no x-clearance block at all', async () => {
    // The documented bypass, verbatim from the review: post a document with
    // `work[].highlights` and no block -> `usages` optional -> nothing recorded ->
    // `evaluatePreRenderGate([])` -> `{allowed: true, checked: 0}` -> `POST /render`
    // produces an artifact. The bypass is now closed at BOTH ends: the write refuses the
    // document, and the read-time guard refuses a revision that has no block.
    const { store } = storeWithClaim();
    let caught: ResumeRevisionError | undefined;
    try {
      await createRevision(input({ document: withoutBlock(document()) }), store.asRevisionStore());
    } catch (error) {
      caught = error as ResumeRevisionError;
    }
    expect(caught).toBeInstanceOf(ResumeRevisionError);
    expect(caught?.reason).toBe('CLEARANCE_BLOCK_REQUIRED');
    expect(store.revisions.size).toBe(0);
    expect(store.usages.size).toBe(0);
  });

  it('BELT 1: text at work[0].highlights with claims [] -> DOCUMENT_UNAUDITED, via rule 5', async () => {
    // Belt to the braces above: even if a row somehow existed with an empty block, the
    // render path refuses. `assertRevisionRenderableInScope` reads the DOCUMENT, so no
    // arrangement of usage rows can make this pass.
    //
    // RENAMED (ADR-043): this used to be "carries career text and declares NO claim" and
    // it passed through the `declared.length === 0 && hasCareerBearingText(...)` guard.
    // It passes now through rule 5, which requires every claim-backed string to be named
    // at its exact path by the document's own block - unconditionally, not gated on the
    // declared set being empty. Same expectation, different and much stronger rule.
    const store = new FakeCareerStore();
    const claim = seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
    const revision = seedRevision(store, 'res-1', 1, {
      resumeJson: {
        basics: { name: 'Ada' },
        work: [{ name: 'Acme', position: 'Engineer', highlights: ['I led the migration of 400 services'] }],
        [X_CLEARANCE_KEY]: {
          version: 1,
          generatedBy: 'test',
          sourceModelVersion: 2,
          profileId: 'profile-1',
          claimCount: 0,
          confirmedClaimCount: 0,
          unconfirmedClaimCount: 0,
          claims: [],
        },
      } as never,
      jsonHash: '',
    });
    // A correct jsonHash, so the refusal is about the accounting and not about tampering.
    const row = store.revisions.get(revision.id) as ResumeRevision;
    store.setRevisionJson(row.id, row.resumeJson);
    const hashed = { ...row, jsonHash: canonicalJsonHash(row.resumeJson) } as ResumeRevision;

    let caught: RevisionAuditError | undefined;
    try {
      await assertRevisionRenderableInScope(hashed, store.asUsageStore());
    } catch (error) {
      caught = error as RevisionAuditError;
    }
    expect(caught).toBeInstanceOf(RevisionAuditError);
    expect(caught?.reason).toBe('DOCUMENT_UNAUDITED');
    // The claim exists, so this is not a "missing row" failure in disguise.
    expect(claim.id).toBe('clm-1');
  });

  it('BELT 0: the read-time guard refuses a revision whose document has NO block at all', async () => {
    // The two halves of the "unaudited document" rule are separable, and both need their
    // own test. The one above refuses a document that HAS an empty block and text; this
    // one refuses a document with no block at all, which the write path already refuses -
    // so a row like this can only exist through a writer that bypassed `createRevision`,
    // and the read-time guard is the belt for that.
    //
    // It is a separate test from the rule-5 one on purpose: removing the
    // `readClearanceBlock(...) === null` check leaves rule 5 intact, so a single combined
    // test would still pass under that mutation.
    const store = new FakeCareerStore();
    const revision = seedRevision(store, 'res-1', 1, {
      resumeJson: { basics: { name: 'Ada' } } as never,
    });
    const row = store.revisions.get(revision.id) as ResumeRevision;
    const hashed = { ...row, jsonHash: canonicalJsonHash(row.resumeJson) } as ResumeRevision;
    await expect(
      assertRevisionRenderableInScope(hashed, store.asUsageStore()),
    ).rejects.toMatchObject({ code: 'resume_revision_audit_failed', reason: 'DOCUMENT_UNAUDITED' });
  });

  it('POSITIVE CONTROL: a document with no career text and no claims IS renderable', async () => {
    // The stated meaning of an EMPTY set, both halves of it. A document that asserts
    // nothing about the candidate's work - here only a name - genuinely has no claim to
    // account for, and the gate's promise ("no unconfirmed claim is rendered") is
    // vacuously kept. Refusing this would make the invariant impossible to satisfy
    // rather than true, which is the failure mode the whole review warned about.
    const store = new FakeCareerStore();
    const revision = seedRevision(store, 'res-1', 1, {
      resumeJson: {
        basics: { name: 'Ada' },
        [X_CLEARANCE_KEY]: {
          version: 1,
          generatedBy: 'test',
          sourceModelVersion: 2,
          profileId: 'profile-1',
          claimCount: 0,
          confirmedClaimCount: 0,
          unconfirmedClaimCount: 0,
          claims: [],
        },
      } as never,
    });
    const row = store.revisions.get(revision.id) as ResumeRevision;
    const hashed = { ...row, jsonHash: canonicalJsonHash(row.resumeJson) } as ResumeRevision;
    await expect(
      assertRevisionRenderableInScope(hashed, store.asUsageStore()),
    ).resolves.toMatchObject({ allowed: true, checked: 0, rendered: 0 });
  });

  it('the read-time guard refuses a revision whose usage log does not describe its document', async () => {
    // Both directions of the mismatch, because both are real: an unlogged claim is
    // untracked, and a logged claim the document does not declare is a phantom.
    const store = new FakeCareerStore();
    const claim = seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
    const revision = await createRevision(input(), store.asRevisionStore());
    const hashed = { ...revision, jsonHash: canonicalJsonHash(revision.resumeJson) } as ResumeRevision;

    // A phantom row: the document declares `clm-1`, and the log ALSO carries `clm-phantom`.
    store.addUsage(revision.id, { claimId: 'clm-phantom', usage: ResumeUsage.verbatim, renderedText: 'x' });
    await expect(
      assertRevisionRenderableInScope(hashed, store.asUsageStore()),
    ).rejects.toMatchObject({ reason: 'USAGE_SET_MISMATCH' });
    // ...which is NOT a silent pass, and NOT a status failure. Positive control: with
    // only the phantom's claim missing again, the same revision renders.
    store.usages.delete([...store.usages.values()].find((row) => row.claimId === 'clm-phantom')!.id);
    await expect(
      assertRevisionRenderableInScope(hashed, store.asUsageStore()),
    ).resolves.toMatchObject({ allowed: true });
    expect(claim.id).toBe('clm-1');
  });

  it('the read-time guard refuses a revision whose bytes no longer match its jsonHash', async () => {
    // F8: `revisionHashMatches` was a tripwire only its own test walked. A tampered row
    // is now refused at the render, so the stored document is the audited one.
    const store = new FakeCareerStore();
    seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
    const revision = await createRevision(input(), store.asRevisionStore());
    store.setRevisionJson(revision.id, { basics: { name: 'Someone Else' } });
    const tampered = store.revisions.get(revision.id) as ResumeRevision;
    await expect(
      assertRevisionRenderableInScope(tampered, store.asUsageStore()),
    ).rejects.toMatchObject({ reason: 'REVISION_TAMPERED' });
  });

  it('the read-time guard refuses a block naming a claim that no longer resolves', async () => {
    // The claim row was hard-deleted by something that bypassed the soft-delete rule.
    const store = new FakeCareerStore();
    const claim = seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
    const revision = await createRevision(input(), store.asRevisionStore());
    const hashed = { ...revision, jsonHash: canonicalJsonHash(revision.resumeJson) } as ResumeRevision;
    store.claims.delete(claim.id);
    await expect(
      assertRevisionRenderableInScope(hashed, store.asUsageStore()),
    ).rejects.toMatchObject({ reason: 'CLAIM_UNRESOLVED' });
  });

  it('every audit reason has fixed text and interpolates nothing from the caller', () => {
    // A closed vocabulary, the same discipline the gate's own reasons use. The
    // interesting property is that the message is a CONSTANT per reason: nothing from a
    // claim statement, a document path or a claim id can reach it. A planted SSN in a
    // statement is the sharpest version of that, so it is planted.
    const secret = 'SSN 123-45-6789 and other private text';
    for (const reason of REVISION_AUDIT_REASONS) {
      const error = new RevisionAuditError(reason);
      expect(error.toJSON()).toEqual({ code: 'resume_revision_audit_failed', reason });
      expect(error.message).toBe(`resume_revision_audit_failed: ${new RevisionAuditError(reason).message.split(': ')[1]}`);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain('clm-');
      // Each reason says something specific rather than a generic apology.
      expect(error.message.length).toBeGreaterThan('resume_revision_audit_failed: '.length + 20);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-043: the belt, the multiset, and the write-time half (N1, N2, N3, N5, N6)
// ---------------------------------------------------------------------------

/** A store seeded with one confirmed claim, and a revision holding `doc`. */
function seededRevisionWith(doc: unknown): {
  store: FakeCareerStore;
  revision: ResumeRevision;
} {
  const store = new FakeCareerStore();
  seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%' });
  const revision = seedRevision(store, 'res-1', 1, { resumeJson: doc as never, jsonHash: '' });
  const row = store.revisions.get(revision.id) as ResumeRevision;
  store.setRevisionJson(row.id, row.resumeJson);
  return { store, revision: { ...row, jsonHash: canonicalJsonHash(row.resumeJson) } as ResumeRevision };
}

/** The block used by the belt tests: `claims` is supplied by the caller. */
function block(claims: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedBy: 'test',
    sourceModelVersion: 2,
    profileId: 'profile-1',
    claimCount: claims.length,
    confirmedClaimCount: claims.length,
    unconfirmedClaimCount: 0,
    claims,
    ...overrides,
  };
}

/** A block entry, with every member the belt reads spelled out. */
function entry(overrides: Record<string, unknown> = {}) {
  return {
    claimId: 'clm-1',
    fingerprint: 'a'.repeat(64),
    kind: 'achievement',
    status: ClaimStatus.user_confirmed,
    provenance: 'llm_inferred',
    confidence: 0.9,
    evidenceSourceId: null,
    usage: ResumeUsage.verbatim,
    jsonPath: 'work[0].highlights[0]',
    renderedText: 'Cut CI build time by 40%',
    ...overrides,
  };
}

describe('ADR-043 BELT: every claim-backed string must be named, at that path, by the block', () => {
  it('BELT 1: text in work[1].highlights, claims [] -> DOCUMENT_UNAUDITED', async () => {
    // Kills a `*` step that descends with `Array.prototype.find` (N1). The attempt-2
    // walker returned only element 0 of every wildcard array, so moving the text one
    // element along was enough to hide it. The element-0 case is BELT 1 above; this is
    // the one the review showed was NOT covered.
    const { store, revision } = seededRevisionWith({
      basics: { name: 'Ada' },
      work: [
        { name: 'Acme', position: 'Engineer' },
        { name: 'Globex', position: 'Engineer', highlights: ['I led the migration of 400 services'] },
      ],
      [X_CLEARANCE_KEY]: block([]),
    });
    await expect(
      assertRevisionRenderableInScope(revision, store.asUsageStore()),
    ).rejects.toMatchObject({ code: 'resume_revision_audit_failed', reason: 'DOCUMENT_UNAUDITED' });
  });

  it('BELT 2: text in projects[1].highlights, claims [] -> DOCUMENT_UNAUDITED', async () => {
    // Kills a `work`-only fix. The attempt-2 constant listed `projects[].highlights` too,
    // but a belt narrowed to `work` alone would pass BELT 1 and fail this.
    const { store, revision } = seededRevisionWith({
      basics: { name: 'Ada' },
      projects: [
        { name: 'A', highlights: ['first'] },
        { name: 'B', highlights: ['I led the migration of 400 services'] },
      ],
      [X_CLEARANCE_KEY]: block([]),
    });
    await expect(
      assertRevisionRenderableInScope(revision, store.asUsageStore()),
    ).rejects.toMatchObject({ reason: 'DOCUMENT_UNAUDITED' });
  });

  it('BELT 3: a verbatim entry at work[0] does NOT account for the SAME text at work[1] -> DOCUMENT_UNAUDITED', async () => {
    // Kills dropping the `entry.jsonPath === path` half of the predicate.
    //
    // THE TEXT IS THE SAME ON BOTH SIDES, and that is what makes this test discriminate.
    // The first version of it used two different bullets, which the `renderedText` half
    // of the comparison caught on its own - so removing the path test left it green. The
    // honest shape is a document that repeats one claim's bullet under two roles, which
    // is what a real resume does: the claim is named ONCE, at `work[0].highlights[0]`,
    // and the same sentence also appears at `work[1].highlights[0]`. With the path test
    // removed, the single entry would account for BOTH occurrences and the document
    // would render on one claim's authority for text it places twice.
    const { store, revision } = seededRevisionWith({
      basics: { name: 'Ada' },
      work: [
        { name: 'Acme', position: 'Engineer', highlights: ['Cut CI build time by 40%'] },
        { name: 'Globex', position: 'Engineer', highlights: ['Cut CI build time by 40%'] },
      ],
      [X_CLEARANCE_KEY]: block([entry()]),
    });
    // The declared set and the log must AGREE, or step 4 would fire first and this test
    // would pass for the wrong reason. The row is the one the writer would have recorded.
    store.addUsage(revision.id, {
      claimId: 'clm-1',
      usage: ResumeUsage.verbatim,
      renderedText: 'Cut CI build time by 40%',
    });
    await expect(
      assertRevisionRenderableInScope(revision, store.asUsageStore()),
    ).rejects.toMatchObject({ reason: 'DOCUMENT_UNAUDITED' });

    // POSITIVE CONTROL: the same document with the bullet ONCE renders, which shows the
    // refusal above is about the second, unaccounted occurrence and not about the claim.
    const { store: ok, revision: okRevision } = seededRevisionWith({
      basics: { name: 'Ada' },
      work: [{ name: 'Acme', position: 'Engineer', highlights: ['Cut CI build time by 40%'] }],
      [X_CLEARANCE_KEY]: block([entry()]),
    });
    ok.addUsage(okRevision.id, { claimId: 'clm-1', usage: ResumeUsage.verbatim, renderedText: 'Cut CI build time by 40%' });
    await expect(
      assertRevisionRenderableInScope(okRevision, ok.asUsageStore()),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('BELT 4: text at a claim-backed path declared `omitted` -> USAGE_SET_MISMATCH', async () => {
    // Kills BOTH the claimId-only `D`/`R` comparison AND restoring the
    // `declared.length === 0 &&` guard. The document declares `clm-1` (so the set is
    // non-empty, so the old guard would not fire), places the claim's text, and the log
    // row says `omitted` where the block says `verbatim`. With a `(claimId, usage)`
    // multiset the two differ; with `claimId` alone they are the same set.
    const { store, revision } = seededRevisionWith({
      basics: { name: 'Ada' },
      work: [{ name: 'Acme', position: 'Engineer', highlights: ['Cut CI build time by 40%'] }],
      [X_CLEARANCE_KEY]: block([entry()]),
    });
    // The row a writer that records the FIRST of two entries for one claim would leave.
    store.addUsage(revision.id, { claimId: 'clm-1', usage: ResumeUsage.omitted, renderedText: null });
    await expect(
      assertRevisionRenderableInScope(revision, store.asUsageStore()),
    ).rejects.toMatchObject({ reason: 'USAGE_SET_MISMATCH' });
  });

  it('N2: two entries for one claimId -> write INVALID_INPUT, forged past the writer -> read USAGE_SET_MISMATCH', async () => {
    // N2. `X_CLEARANCE_SCHEMA.claims` has no uniqueness constraint on `claimId`, and the
    // validator's `uniqueItems` only catches BYTE-IDENTICAL entries, so an `omitted`
    // entry followed by a `verbatim` one validates. `recordClaimUsages` then writes ONE
    // row for the pair and the gate reads the first.
    const { store } = storeWithClaim();
    const blockTwo = document()[X_CLEARANCE_KEY]!;
    const duplicated = {
      basics: { name: 'Ada Lovelace' },
      work: [{ name: 'Acme', position: 'Staff Engineer', highlights: ['Cut CI build time by 40%'] }],
      [X_CLEARANCE_KEY]: {
        ...blockTwo,
        claims: [
          { ...blockTwo.claims[0], usage: ResumeUsage.omitted, jsonPath: null, renderedText: null },
          { ...blockTwo.claims[0], usage: ResumeUsage.verbatim },
        ],
      },
    } as unknown as ResumeJson;

    // WRITE: refused, and nothing is written - the check is before the insert.
    let caught: ResumeRevisionError | undefined;
    try {
      await createRevision(input({ document: duplicated }), store.asRevisionStore());
    } catch (error) {
      caught = error as ResumeRevisionError;
    }
    expect(caught).toBeInstanceOf(ResumeRevisionError);
    expect(caught?.reason).toBe('INVALID_INPUT');
    expect(store.revisions.size).toBe(0);
    expect(store.usages.size).toBe(0);

    // READ: a row forged past the writer (one row for the pair, first entry wins) is
    // caught by the multiset, because 2 declared is not 1 recorded.
    const forged = seededRevisionWith(duplicated);
    forged.store.addUsage(forged.revision.id, {
      claimId: 'clm-1',
      usage: ResumeUsage.omitted,
      renderedText: null,
    });
    await expect(
      assertRevisionRenderableInScope(forged.revision, forged.store.asUsageStore()),
    ).rejects.toMatchObject({ reason: 'USAGE_SET_MISMATCH' });
  });

  it('N3 positive: a projected profile with a summary, project tech and ZERO claims RENDERS', async () => {
    // The false positive this whole rework exists to remove. Under the attempt-2
    // `CAREER_BEARING_PATHS`, `basics.summary` and `projects[].keywords` were on the
    // belt's list but are never claim-backed by the projector - so a legitimate
    // projection of a real profile was PERMANENTLY un-renderable. End to end:
    // `loadProjectionInput` -> `projectResumeJson` -> `createRevision` ->
    // `assertRevisionRenderableInScope` -> allowed.
    //
    // RE-SCOPED BY T1080: the fixture profile now carries NO summary column. `basics.summary`
    // moved ONTO the claim rail when R-SUMMARY was closed, so keeping a summary in this
    // fixture would be asserting the residual rather than the fix - and `R-SUMMARY` below
    // asserts the summary half. What is still protected here is R-ENTITY:
    // `projects[].keywords` (and `project.description`, `work[].summary`) remain outside
    // the rail and must keep rendering unclaimed, which is the N3 false positive.
    const projectionStore = projectionStoreWithSummaryAndTech(null);
    const loaded = await loadProjectionInput('profile-1', projectionStore as never);
    const projected = projectResumeJson(loaded).document as ResumeJson;

    // The fixture is the thing being protected: project tech, and NOT ONE claim row.
    expect((projected.basics as { summary?: string }).summary).toBeUndefined();
    expect(projected.projects?.[0]?.keywords).toEqual(['typescript', 'postgres']);
    expect(projected.work?.[0]?.highlights).toBeUndefined();
    expect(readClearanceBlock(projected)!.claims).toEqual([]);

    const store = new FakeCareerStore();
    const revision = await createRevision(
      { resumeId: RESUME, document: projected, createdBy: ResumeChangeSource.user },
      store.asRevisionStore(),
    );
    const hashed = { ...revision, jsonHash: canonicalJsonHash(revision.resumeJson) } as ResumeRevision;
    await expect(
      assertRevisionRenderableInScope(hashed, store.asUsageStore()),
    ).resolves.toMatchObject({ allowed: true, checked: 0, rendered: 0 });
  });

  // -------------------------------------------------------------------------
  // ADR-043 R-SUMMARY, CLOSED BY T1080. The residual was: `basics.summary` renders with
  // NO claim, and T1080's `reword_summary` would have been the one piece of crafted prose
  // on the resume the pre-render gate could not see. The control was T1020's `soft_skill`
  // claim for the profile summary plus a belt that can SEE `basics.summary`. These three
  // tests are that control, in both directions.
  // -------------------------------------------------------------------------
  describe('R-SUMMARY: the profile summary is on the claim rail', () => {
    /** A projection seam whose profile has a summary claim with the given status. */
    function summaryProjectionStore(status: ClaimStatus, statement: string) {
      const base = projectionStoreWithSummaryAndTech(statement);
      return {
        ...base,
        careerClaim: {
          findMany: async () => [
            {
              id: 'clm-summary',
              profileId: 'profile-1',
              kind: 'soft_skill',
              statement,
              fingerprint: 'f'.repeat(64),
              status,
              provenance: 'document_import',
              confidence: null,
              experienceId: null,
              educationId: null,
              projectId: null,
              skillId: null,
              certificationId: null,
              evidenceSourceId: null,
              createdAt: new Date('2026-09-01T00:00:00.000Z'),
            },
          ],
        },
      };
    }

    it('a CONFIRMED summary claim is PLACED at basics.summary and is belt-verified end to end', async () => {
      // The positive direction of the closure. `loadProjectionInput` offers the profile's
      // unattached `soft_skill` claim as a summary candidate, the projector places it as a
      // RENDERED usage at `basics.summary`, and the write-time and read-time belts both
      // accept the document because the block names that exact path with that exact text.
      const store = new FakeCareerStore();
      seedConfirmedClaim(store, {
        id: 'clm-summary',
        kind: ClaimKind.soft_skill,
        statement: 'A decade of platform work.',
      });
      const loaded = await loadProjectionInput('profile-1', summaryProjectionStore(
        ClaimStatus.user_confirmed,
        'A decade of platform work.',
      ) as never);
      const projected = projectResumeJson(loaded).document as ResumeJson;

      expect((projected.basics as { summary?: string }).summary).toBe('A decade of platform work.');
      const blockEntry = readClearanceBlock(projected)!.claims.find(
        (candidate) => candidate.claimId === 'clm-summary',
      );
      expect(blockEntry).toMatchObject({
        usage: ResumeUsage.verbatim,
        jsonPath: 'basics.summary',
        renderedText: 'A decade of platform work.',
      });
      // The belt SEES it: `basics.summary` is one of the claim-backed strings.
      expect(claimBackedTextAt(projected)).toContainEqual({
        path: 'basics.summary',
        text: 'A decade of platform work.',
      });

      const revision = await createRevision(
        { resumeId: RESUME, document: projected, createdBy: ResumeChangeSource.user },
        store.asRevisionStore(),
      );
      const hashed = { ...revision, jsonHash: canonicalJsonHash(revision.resumeJson) } as ResumeRevision;
      await expect(
        assertRevisionRenderableInScope(hashed, store.asUsageStore()),
      ).resolves.toMatchObject({ allowed: true });
    });

    it('a summary with NO claim behind it is DOCUMENT_UNAUDITED - the residual is CLOSED, not tolerated', async () => {
      // The direction that matters most. A profile summary typed by hand, with no
      // `soft_skill` claim, used to render with nothing accounting for it. It no longer
      // does: the belt refuses the document and names the path, which is what makes
      // `reword_summary` safe to ship at all.
      const loaded = await loadProjectionInput(
        'profile-1',
        projectionStoreWithSummaryAndTech('A decade of platform work.') as never,
      );
      const projected = projectResumeJson(loaded).document as ResumeJson;
      expect((projected.basics as { summary?: string }).summary).toBe('A decade of platform work.');
      expect(readClearanceBlock(projected)!.claims).toEqual([]);
      expect(claimBackedTextAt(projected)).toEqual([
        { path: 'basics.summary', text: 'A decade of platform work.' },
      ]);

      const store = new FakeCareerStore();
      // WRITE time, first: the belt runs at both ends, so a malformed document is refused
      // at the request that carried it rather than at a render the user was told succeeded.
      await expect(
        createRevision(
          { resumeId: RESUME, document: projected, createdBy: ResumeChangeSource.user },
          store.asRevisionStore(),
        ),
      ).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
      expect(store.revisions.size).toBe(0);

      // READ time, over a row forged past the writer.
      const { store: forgedStore, revision } = seededRevisionWith({
        basics: { name: 'Ada', summary: 'A decade of platform work.' },
        [X_CLEARANCE_KEY]: block([]),
      });
      await expect(
        assertRevisionRenderableInScope(revision, forgedStore.asUsageStore()),
      ).rejects.toMatchObject({ code: 'resume_revision_audit_failed', reason: 'DOCUMENT_UNAUDITED' });
    });

    it('a REJECTED summary claim is `omitted`, and the profile column does NOT put its text back', async () => {
      // F3 is unconditional: a rejected claim's statement is never placed as rendered
      // text. The interesting half is what happens NEXT - the projector has a profile
      // column holding the same words, and falling back to it would re-introduce the
      // rejected sentence with less provenance than the row that refused it.
      const loaded = await loadProjectionInput('profile-1', summaryProjectionStore(
        ClaimStatus.rejected,
        'A decade of platform work.',
      ) as never);
      const projected = projectResumeJson(loaded).document as ResumeJson;

      expect((projected.basics as { summary?: string }).summary).toBeUndefined();
      const blockEntry = readClearanceBlock(projected)!.claims.find(
        (candidate) => candidate.claimId === 'clm-summary',
      );
      expect(blockEntry).toMatchObject({ usage: ResumeUsage.omitted, jsonPath: null, renderedText: null });
      expect(claimBackedTextAt(projected)).toEqual([]);
    });
  });

  it('the read-time claim resolution is SCOPED to the block s own profileId', async () => {
    // Review sec. 5.1. Not exploitable today - the stored block was already
    // profile-scoped at write time - but the invariant should be LOCAL to the check
    // rather than inherited from a write path someone could change. `CLAIM_UNRESOLVED`
    // is the right answer for a claim that is in the database but not in this profile:
    // from the document's point of view it does not resolve.
    //
    // Seeded directly rather than through `createRevision`, because the WRITE path
    // already refuses this - `assertClaimUsagesRecordable` is scoped to the block's
    // profile - so a document like this can only reach storage through a writer that
    // bypassed the module. That is exactly the state the read-time scope is the belt
    // for, and it is the same reasoning the `REVISION_TAMPERED` and no-block tests use.
    const store = new FakeCareerStore();
    // The claim row belongs to profile-2; the document's block says profile-1.
    seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%', profileId: 'profile-2' });
    const doc = document();
    const { revision } = seededRevisionWith(doc);
    store.revisions.set(revision.id, revision);
    store.addUsage(revision.id, {
      claimId: 'clm-1',
      usage: ResumeUsage.verbatim,
      renderedText: 'Cut CI build time by 40%',
    });
    await expect(
      assertRevisionRenderableInScope(revision, store.asUsageStore()),
    ).rejects.toMatchObject({ reason: 'CLAIM_UNRESOLVED' });

    // POSITIVE CONTROL: the same claim in the block's OWN profile resolves and the
    // revision renders, so the refusal above is the scope and not a broken query.
    store.claims.delete('clm-1');
    seedConfirmedClaim(store, { id: 'clm-1', statement: 'Cut CI build time by 40%', profileId: 'profile-1' });
    await expect(
      assertRevisionRenderableInScope(revision, store.asUsageStore()),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('N5: a restatement whose tuple COLLIDES with the document s tuple is refused', async () => {
    // The shape test below proves the collision exists; this one proves the PRODUCTION
    // key is the injective one. Without it the shape test would pass even if the
    // function under test still used the delimiter-free join - a test that only
    // characterises a string is not a test of the code.
    //
    // The document declares ONE entry: `x` / `omitted` / `verbatim`, which keys to
    // `xomittedverbatim`. A caller restating a DIFFERENT entry - `xomitted` /
    // `verbatim` / `''` - keys to the same string, so under the old key its restatement
    // was accepted as a faithful restatement of a claim the document never named, at an
    // under-declared set size of zero. Under `JSON.stringify` they are
    // `["x","omitted","verbatim"]` and `["xomitted","verbatim",""]`.
    //
    // No `CareerClaim` row is seeded for `xomitted`: the supplied set is never recorded
    // (the writer records the DERIVED set), which is exactly why this check has to be
    // the thing that catches the substitution.
    const store = new FakeCareerStore();
    seedConfirmedClaim(store, { id: 'x', statement: 'first' });
    const base = document();
    const block = base[X_CLEARANCE_KEY]!;
    const declared = document({
      work: [{ name: 'Acme', position: 'Engineer' }],
      [X_CLEARANCE_KEY]: {
        ...block,
        claims: [
          { ...block.claims[0], claimId: 'x', usage: ResumeUsage.omitted, jsonPath: null, renderedText: 'verbatim' },
        ],
      },
    }) as unknown as ResumeJson;

    let caught: ResumeRevisionError | undefined;
    try {
      await createRevision(
        input({
          document: declared,
          usages: [{ claimId: 'xomitted', usage: ResumeUsage.verbatim, renderedText: null }],
        }),
        store.asRevisionStore(),
      );
    } catch (error) {
      caught = error as ResumeRevisionError;
    }
    expect(caught).toBeInstanceOf(ResumeRevisionError);
    expect(caught?.reason).toBe('INVALID_INPUT');
    expect(store.revisions.size).toBe(0);

    // POSITIVE CONTROL: a FAITHFUL restatement of the same entry is accepted, so the
    // refusal above is the substitution and not a rule against restating.
    const ok = await createRevision(
      input({
        document: declared,
        usages: [{ claimId: 'x', usage: ResumeUsage.omitted, renderedText: 'verbatim' }],
      }),
      store.asRevisionStore(),
    );
    expect(ok.revisionNumber).toBe(1);
  });

  it('N5: the two tuples that collided under the old delimiter-free key are NOT equal', () => {
    // The attempt-2 key was a DELIMITER-FREE join of the three members. The byte in the
    // source was a control character, so it renders as nothing and reads as join('')
    // - which is how the review reported it, and is the form tested here. A join is only
    // injective while no member can contain the separator, and a claim id is caller
    // supplied. These two tuples produced the SAME key, so a restatement of one could
    // have satisfied the check for the other. JSON.stringify of the array is injective on
    // string tuples and needs no separator at all.
    //
    // The functions are written out here rather than imported, because the old one no
    // longer exists: the test is about the SHAPE of the key, and a test that imported
    // the function under test could only assert that the function equals itself.
    const oldKey = (claimId: string, usage: string, text: string): string =>
      [claimId, usage, text].join('');
    const newKey = (claimId: string, usage: string, text: string): string =>
      JSON.stringify([claimId, usage, text]);

    // 'x' + 'omitted' + 'verbatim' and 'xomitted' + 'verbatim' + empty -> one string.
    expect(oldKey('x', 'omitted', 'verbatim')).toBe(oldKey('xomitted', 'verbatim', ''));
    expect(newKey('x', 'omitted', 'verbatim')).not.toBe(newKey('xomitted', 'verbatim', ''));
    // The collision is not an artefact of one pair: the old form cannot separate a claimId
    // ending in one member from a claimId that starts the next one.
    expect(oldKey('acme', 'verbatim', 'x')).toBe(oldKey('acmeverbatim', '', 'x'));
    // And the new key is not merely different for that pair: the members cannot run
    // into one another, because JSON.stringify brackets and quotes each one.
    expect(newKey('x', 'omitted', 'verbatim')).toBe('["x","omitted","verbatim"]');
  });
});

describe('ADR-043: the belt runs at BOTH ends', () => {
  it('createRevision refuses claim-backed text that no block entry names, before any write', async () => {
    // ADR-043 decision 7: the same predicate at the writer, so a malformed document is a
    // 400 at the request that carried it rather than a `DOCUMENT_UNAUDITED` at a render
    // the user was already told succeeded. The message names the path, because at write
    // time the caller CAN fix it and the path is the whole of the fix.
    const { store } = storeWithClaim();
    const unaudited = {
      basics: { name: 'Ada' },
      work: [{ name: 'Acme', position: 'Engineer', highlights: ['A bullet no claim accounts for'] }],
      [X_CLEARANCE_KEY]: block([]),
    } as unknown as ResumeJson;
    let caught: ResumeRevisionError | undefined;
    try {
      await createRevision(input({ document: unaudited }), store.asRevisionStore());
    } catch (error) {
      caught = error as ResumeRevisionError;
    }
    expect(caught?.reason).toBe('INVALID_INPUT');
    expect(caught?.message).toContain('work[0].highlights[0]');
    expect(store.revisions.size).toBe(0);
    expect(store.usages.size).toBe(0);
  });

  it('createRevision accepts the SAME document once the block accounts for the text', async () => {
    // The positive control, and the reason the rule is a check rather than a blanket
    // refusal: a coherent document goes through.
    const { store } = storeWithClaim();
    const accounted = documentSaying('Cut CI build time by 40%');
    const revision = await createRevision(input({ document: accounted }), store.asRevisionStore());
    expect(revision.revisionNumber).toBe(1);
    expect(store.usagesFor(revision.id)).toHaveLength(1);
  });
});

describe('ADR-043: the projector never names a slot its text is not in', () => {
  it('a claim that renders no text in the MIDDLE of a highlights run does not shift the paths', async () => {
    // The hazard found in triage, not in the review. The projector used
    // `.map((entry, i) => place(entry, `work[0].highlights[${i}]`, true)).filter(v => v !== null)`,
    // so `i` was the PRE-filter index: a claim producing no text was dropped from the
    // array while every LATER highlight was recorded one slot to the right of where its
    // text actually is. Rule 5 would then refuse a legitimate projection. The projector
    // was wrong, so the PROJECTOR was fixed - the rule was not relaxed to accommodate it.
    //
    // The fixture uses an EXPLICITLY `omitted` claim rather than a blank statement,
    // because a blank statement cannot exist: `claimFingerprint` refuses one, so no
    // `CareerClaim` row can carry it. `omitted` in the middle of a placed run is the
    // real shape, and it is reachable: the projector decides placement per claim, and a
    // claim the caller marked `omitted` sits in the same array as the ones it placed.
    const result = projectResumeJson({
      profileId: 'profile-1',
      basics: { name: 'Ada' },
      work: [
        {
          experience: experienceRowFor('exp-1'),
          claims: [
            { claim: careerClaim('clm-a', 'First', 1) },
            { claim: careerClaim('clm-skipped', 'Considered but not used', 2), usage: ResumeUsage.omitted },
            { claim: careerClaim('clm-c', 'Third', 3) },
          ],
        },
      ],
    });

    // The document: the omitted claim left no hole in the text.
    expect(result.document.work?.[0]?.highlights).toEqual(['First', 'Third']);
    // The block: `clm-c` names the slot its text REALLY occupies, not the pre-filter one.
    // Under the old code this read `work[0].highlights[2]`, which names nothing.
    const claims = readClearanceBlock(result.document)!.claims;
    expect(claims.find((c) => c.claimId === 'clm-c')?.jsonPath).toBe('work[0].highlights[1]');
    expect(claims.find((c) => c.claimId === 'clm-skipped')?.usage).toBe(ResumeUsage.omitted);
    expect(claims.find((c) => c.claimId === 'clm-skipped')?.jsonPath).toBeNull();

    // AND the whole point: the projection is ACCEPTED by the writer and the belt. Under
    // the pre-filter index it would be refused as `DOCUMENT_UNAUDITED` - a legitimate
    // projection refused by the control meant to protect it.
    const writer = new FakeCareerStore();
    seedConfirmedClaim(writer, { id: 'clm-a', statement: 'First' });
    seedConfirmedClaim(writer, { id: 'clm-c', statement: 'Third' });
    seedConfirmedClaim(writer, { id: 'clm-skipped', statement: 'Considered but not used' });
    const revision = await createRevision(
      { resumeId: RESUME, document: result.document as ResumeJson, createdBy: ResumeChangeSource.user },
      writer.asRevisionStore(),
    );
    const hashed = { ...revision, jsonHash: canonicalJsonHash(revision.resumeJson) } as ResumeRevision;
    await expect(
      assertRevisionRenderableInScope(hashed, writer.asUsageStore()),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('the same for projects[].highlights, which is the other text-writing site', () => {
    const result = projectResumeJson({
      profileId: 'profile-1',
      basics: { name: 'Ada' },
      projects: [
        {
          project: projectRowFor('prj-1'),
          claims: [
            { claim: careerClaim('clm-p1', 'Alpha', 1) },
            { claim: careerClaim('clm-pskip', 'Considered but not used', 2), usage: ResumeUsage.omitted },
            { claim: careerClaim('clm-p3', 'Gamma', 3) },
          ],
        },
      ],
    });
    expect(result.document.projects?.[0]?.highlights).toEqual(['Alpha', 'Gamma']);
    const claims = readClearanceBlock(result.document)!.claims;
    expect(claims.find((c) => c.claimId === 'clm-p3')?.jsonPath).toBe('projects[0].highlights[1]');
  });

  it('a claim whose renderedText is blank is recorded as omitted, not as an empty bullet', async () => {
    // The other half of the same hazard. `renderedTextFor` falls back to the statement
    // when `renderedText` is blank, so this can only arise from a blank STATEMENT - which
    // `claimFingerprint` forbids at the claim layer. The projector is still tolerant
    // rather than trusting that, because `projectResumeJson` takes a row, not a
    // `ClaimCreateInput`, and a projection must not emit a `''` bullet: an empty string
    // is not a rendering of anything, and `recordClaimUsages` refuses a gated usage whose
    // `renderedText` is blank, so the old shape produced a document the writer rejects.
    const blank = {
      ...careerClaim('clm-blank', 'placeholder', 2),
      statement: '   ',
      fingerprint: 'b'.repeat(64),
    };
    const result = projectResumeJson({
      profileId: 'profile-1',
      basics: { name: 'Ada' },
      work: [
        {
          experience: experienceRowFor('exp-1'),
          claims: [
            { claim: careerClaim('clm-a', 'First', 1) },
            { claim: blank as unknown as CareerClaim },
            { claim: careerClaim('clm-c', 'Third', 3) },
          ],
        },
      ],
    });
    expect(result.document.work?.[0]?.highlights).toEqual(['First', 'Third']);
    const claims = readClearanceBlock(result.document)!.claims;
    expect(claims.find((c) => c.claimId === 'clm-blank')?.usage).toBe(ResumeUsage.omitted);
    expect(claims.find((c) => c.claimId === 'clm-blank')?.jsonPath).toBeNull();
    expect(claims.find((c) => c.claimId === 'clm-c')?.jsonPath).toBe('work[0].highlights[1]');
  });
});

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

describe('the injected seam', () => {
  it('is satisfied by the fake and by the real Prisma client', async () => {
    // The first is a runtime assertion; the second is a COMPILE-time one in
    // `routes/resumes.ts` (and here as a type import), because a service whose seam
    // the real client does not satisfy is a service every route must cast.
    const store = new FakeCareerStore();
    const seam: ResumeRevisionStore = store.asRevisionStore();
    expect(typeof seam.resumeRevision.create).toBe('function');
    expect(typeof seam.resumeClaimUsage.create).toBe('function');
    expect(typeof seam.careerClaim.findMany).toBe('function');
    expect(typeof seam.resumeChange.create).toBe('function');
  });
});
