// resume/json/claimSurface.test.ts - the ONE definition of where claim text lives
// (T1030; ADR-043 decision 2).
//
// WHY THIS IS A SUITE OF ITS OWN. The pre-render belt's domain and the projector's
// emission sites used to be two hand-maintained lists. They disagreed in both directions:
// the belt's list was a superset (six of its eight members are never written by the
// projector, so a legitimate profile with a summary could never render - N3) and the
// belt's walker used `Array.prototype.find` on every `*` step, so it only ever saw element
// zero of an array (N1). One definition consumed twice is the fix, and a definition that
// nothing checks is just a smaller version of the same bug.
//
// WHAT IS PROVEN HERE:
//   1. THE DRIFT TEST. `claimBackedTextAt(projected fixture)` and the fixture's own
//      declared gated `jsonPath`s are EQUAL, IN BOTH DIRECTIONS, for a projection with
//      gated claims at `work[0]`, `work[1]` and `projects[0]`. This is the test that
//      fails if a new text-writing `place()` site is added without a template, or if a
//      template is added without an emission site.
//   2. EVERY ELEMENT, NOT THE FIRST. The `work[1]` case is the one the attempt-2
//      `find`-on-`*` walker could not see, and it is the exact bypass the review reported.
//   3. EMPTY AND BLANK STRINGS ARE NOT CLAIM TEXT, and the paths are exact.
//   4. `pathFromTemplate` builds what the projector records, and rejects a wildcard it
//      was not given an index for.

import { describe, it, expect } from 'vitest';
import { ClaimProvenance, ClaimStatus, type CareerClaim } from '@prisma/client';

import {
  CLAIM_BACKED_TEXT_PATHS,
  claimBackedTextAt,
  pathFromTemplate,
} from './claimSurface.js';
import { readClearanceBlock, X_CLEARANCE_KEY, type ResumeJson } from './jsonresume.js';
import { GATED_USAGES } from '../../career/claimUsage.js';
import { claimFingerprint } from '../../career/claims.js';
import { projectResumeJson, type ProjectedClaim } from './project.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let seq = 0;

function claim(overrides: Partial<CareerClaim> = {}): CareerClaim {
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
    status: overrides.status ?? ClaimStatus.user_confirmed,
    provenance: overrides.provenance ?? ClaimProvenance.llm_inferred,
    confidence: overrides.confidence ?? 0.7,
    inferenceMethod: 'jd_extract',
    producedByModel: null,
    evidenceSourceId: null,
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
    location: null,
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
    description: null,
    repoUrl: null,
    liveUrl: null,
    tech: [],
    startDate: null,
    endDate: null,
    sortOrder: 0,
    createdAt: new Date(Date.UTC(2026, 0, 2)),
    updatedAt: new Date(Date.UTC(2026, 0, 2)),
    ...overrides,
  } as never;
}

/**
 * A projection with gated claims at `work[0]`, `work[1]`, `projects[0]` AND
 * `basics.summary` - one claim per array element at the FIRST index, so a
 * `find`-on-`*` walker would see them all and a `some`-over-element-0 walker would see only
 * `work[0]` and `projects[0]`.
 *
 * THE SUMMARY CLAIM IS HERE SINCE T1080 (ADR-043 R-SUMMARY). It is a `soft_skill` claim
 * supplied through `ProjectionInput.summaryClaims`, and the projector places it at
 * `basics.summary` as a rendered usage. Without it in this fixture the third template
 * would have no emission site in the drift test, so "a template with no emission site"
 * - the direction-2 half of the invariant - would go untested.
 */
function fixtureWithGatedClaimsEverywhere(): ResumeJson {
  return projectResumeJson({
    profileId: 'profile-1',
    // The profile COLUMN as well as the claim, deliberately: the claim wins, and the
    // assertion below is that the block names `basics.summary` - i.e. that the rail and
    // the projector agree on WHICH text is there.
    basics: { name: 'Ada Lovelace', summary: 'A decade of platform work.' },
    summaryClaims: [
      {
        claim: claim({
          id: 'clm-s0',
          kind: 'soft_skill',
          statement: 'A decade of platform work.',
        }),
      } as ProjectedClaim,
    ],
    work: [
      {
        experience: experienceRow({ id: 'exp-0', sortOrder: 0 }),
        claims: [
          { claim: claim({ id: 'clm-w0', statement: 'Cut CI build time by 40%' }) } as ProjectedClaim,
        ],
      },
      {
        experience: experienceRow({ id: 'exp-1', sortOrder: 1 }),
        claims: [
          { claim: claim({ id: 'clm-w1', statement: 'Migrated 12k accounts to Postgres' }) } as ProjectedClaim,
        ],
      },
    ],
    projects: [
      {
        project: projectRow(),
        claims: [
          { claim: claim({ id: 'clm-p0', statement: 'Wrote the double-entry core' }) } as ProjectedClaim,
        ],
      },
    ],
  }).document as ResumeJson;
}

// ---------------------------------------------------------------------------
// 1. THE DRIFT TEST
// ---------------------------------------------------------------------------

describe('CLAIM-BACKED SURFACE: the belt and the projector agree, BOTH directions', () => {
  it('every claim-backed path is declared by the block, and every declared path has text', () => {
    const document = fixtureWithGatedClaimsEverywhere();
    const block = readClearanceBlock(document)!;

    // The projector DECLARED paths: the gated (`verbatim`/`tailored`) entries with a path.
    const declared = block.claims
      .filter((entry) => GATED_USAGES.includes(entry.usage) && entry.jsonPath !== null)
      .map((entry) => entry.jsonPath as string)
      .sort();
    // The belt SEES paths: every non-empty string the document puts on the claim rail.
    const seen = claimBackedTextAt(document).map((entry) => entry.path).sort();

    // DIRECTION 1: nothing the belt sees is unaccounted for.
    expect(seen).toEqual(declared);
    // DIRECTION 2: nothing the block declares is missing from the document. Without this
    // half, a template with no emission site - or a `place()` call that records a path it
    // never wrote - would pass, and the belt would be watching a surface nothing uses.
    expect(declared).toEqual(seen);

    // And the specific shapes the ADR names, so a future reordering of the projector that
    // still produced a set-equal pair would be caught here. `basics.summary` joined the
    // list in T1080 (ADR-043 R-SUMMARY): the projector places the profile's summary CLAIM
    // there, so the belt has to see it or a summary rewrite would be the one piece of
    // crafted prose the pre-render gate cannot account for.
    expect(seen).toEqual([
      'basics.summary',
      'projects[0].highlights[0]',
      'work[0].highlights[0]',
      'work[1].highlights[0]',
    ]);
  });

  it('the text the belt reads is the text the block says it rendered', () => {
    const document = fixtureWithGatedClaimsEverywhere();
    const block = readClearanceBlock(document)!;
    for (const { path, text } of claimBackedTextAt(document)) {
      const entry = block.claims.find((candidate) => candidate.jsonPath === path);
      expect(entry, `no block entry names ${path}`).toBeDefined();
      expect((entry!.renderedText ?? '').trim()).toBe(text);
    }
  });

  it('a block entry that names a path the document does not have IS caught (the other direction)', () => {
    // The converse of the drift test, stated as a fact about the two functions rather
    // than about a projection: if the projector's `jsonPath` is wrong, `claimBackedTextAt`
    // reports paths the block does not name, and rule 5 refuses. Asserting the DETECTION
    // is what makes the equality above a real invariant rather than a coincidence of one
    // fixture.
    const document = fixtureWithGatedClaimsEverywhere();
    const block = readClearanceBlock(document)!;
    const shiftedBlock = {
      ...block,
      claims: block.claims.map((entry) =>
        entry.jsonPath === 'work[1].highlights[0]' ? { ...entry, jsonPath: 'work[9].highlights[0]' } : entry,
      ),
    };
    const shifted = { ...document, [X_CLEARANCE_KEY]: shiftedBlock } as unknown as ResumeJson;

    const seen = claimBackedTextAt(shifted).map((entry) => entry.path).sort();
    const declared = shiftedBlock.claims
      .filter((entry) => GATED_USAGES.includes(entry.usage) && entry.jsonPath !== null)
      .map((entry) => entry.jsonPath as string)
      .sort();
    // The block now claims a slot that does not exist and the document has a string
    // nobody names - the exact mismatch rule 5 refuses.
    expect(declared).toContain('work[9].highlights[0]');
    expect(seen).not.toContain('work[9].highlights[0]');
    expect(seen).not.toEqual(declared);
  });
});

// ---------------------------------------------------------------------------
// 2. EVERY ELEMENT, NOT THE FIRST (N1)
// ---------------------------------------------------------------------------

describe('BELT: every array element is walked, not just the first', () => {
  it('sees text at work[1] with work[0] present but empty', () => {
    // The attempt-2 walker descended into `work[0]` with `Array.prototype.find` and
    // stopped. This is the shape that slipped past it.
    const document = {
      basics: { name: 'Ada' },
      work: [
        { name: 'Acme', position: 'Engineer' },
        { name: 'Globex', position: 'Engineer', highlights: ['I led the migration of 400 services'] },
      ],
    };
    expect(claimBackedTextAt(document)).toEqual([
      { path: 'work[1].highlights[0]', text: 'I led the migration of 400 services' },
    ]);
  });

  it('sees text at the THIRD element of a highlights array, not just the first', () => {
    const document = {
      basics: { name: 'Ada' },
      work: [{ name: 'Acme', position: 'Engineer', highlights: ['a', 'b', 'c', 'd'] }],
    };
    expect(claimBackedTextAt(document).map((entry) => entry.path)).toEqual([
      'work[0].highlights[0]',
      'work[0].highlights[1]',
      'work[0].highlights[2]',
      'work[0].highlights[3]',
    ]);
  });

  it('sees projects[1] as readily as projects[0]', () => {
    // A `work`-only fix would pass the `work[1]` test above; this one does not.
    const document = {
      basics: { name: 'Ada' },
      projects: [
        { name: 'A', highlights: ['first'] },
        { name: 'B', highlights: ['second'] },
      ],
    };
    expect(claimBackedTextAt(document)).toEqual([
      { path: 'projects[0].highlights[0]', text: 'first' },
      { path: 'projects[1].highlights[0]', text: 'second' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. WHAT COUNTS AS CLAIM TEXT
// ---------------------------------------------------------------------------

describe('BELT: what counts as claim-backed text', () => {
  it('an empty or blank string is not text a renderer can attribute to a claim', () => {
    expect(
      claimBackedTextAt({
        basics: { name: 'Ada' },
        work: [{ name: 'Acme', position: 'Engineer', highlights: ['', '   ', '\t\n'] }],
      }),
    ).toEqual([]);
  });

  it('the text is TRIMMED, which is the form x-clearance.renderedText stores', () => {
    expect(
      claimBackedTextAt({
        basics: { name: 'Ada' },
        work: [{ name: 'Acme', position: 'Engineer', highlights: ['  Cut CI build time by 40%  '] }],
      }),
    ).toEqual([{ path: 'work[0].highlights[0]', text: 'Cut CI build time by 40%' }]);
  });

  it('the surface is the CLAIM RAIL - a claim-backed summary is seen, entity columns are not', () => {
    // N3. `projects[].keywords`, `project.description`, `work[].summary` and `skills[].name`
    // are entity and profile columns: the projector copies them from the row, there is NO
    // claim to compare them against, and a belt that included them would refuse every
    // legitimate projection that carries one - a permanent false positive in a control about
    // UNACCOUNTED CLAIMS. They are a named residual (ADR-043 R-ENTITY) with an owner, not
    // something a private list may imply is covered.
    //
    // `basics.summary` IS on the rail as of T1080, and the first assertion is the reason:
    // it is the one profile column a CLAIM can now back (T1020 emits a `soft_skill` claim
    // for the parsed summary), and `reword_summary` is precisely the op that would
    // otherwise write prose the gate could not see.
    const document = {
      basics: { name: 'Ada', summary: 'A decade of platform work.' },
      work: [{ name: 'Acme', position: 'Engineer', summary: 'Berlin, Germany' }],
      projects: [{ name: 'Ledger', description: 'A double-entry ledger.', keywords: ['typescript'] }],
      volunteer: [{ name: 'Mentor', highlights: ['Ran a bootcamp'] }],
      education: [{ institution: 'MIT', courses: ['Compilers'] }],
      skills: [{ name: 'Go', keywords: ['concurrency'] }],
    };
    expect(claimBackedTextAt(document)).toEqual([
      { path: 'basics.summary', text: 'A decade of platform work.' },
    ]);
  });

  it('R-SUMMARY: a summary with NO claim behind it is still CLAIM-BACKED TEXT, and is therefore unaccounted', () => {
    // The price ADR-043 named when it accepted R-SUMMARY, stated as a fact about the
    // walker rather than about a projection: the belt does not know whether a claim
    // exists, only that `basics.summary` is a place a claim-backed string lives. A
    // document carrying one with no `x-clearance` entry at that path is what rule 5
    // refuses as `DOCUMENT_UNAUDITED`, and that is the state a hand-typed profile summary
    // with no `soft_skill` claim produces.
    expect(claimBackedTextAt({ basics: { name: 'Ada', summary: 'A decade of platform work.' } })).toEqual([
      { path: 'basics.summary', text: 'A decade of platform work.' },
    ]);
    // And the negative control: no summary, nothing on the rail from `basics`.
    expect(claimBackedTextAt({ basics: { name: 'Ada', label: 'Engineer' } })).toEqual([]);
  });

  it('a missing, null or wrongly-typed member yields nothing rather than throwing', () => {
    // The walk is TOLERANT about shape on purpose: this is not a second schema
    // validator with a different opinion, and `createRevision` already validated the
    // document. A belt that threw here would turn a malformed document into a 500.
    expect(claimBackedTextAt(null)).toEqual([]);
    expect(claimBackedTextAt('a string')).toEqual([]);
    expect(claimBackedTextAt({})).toEqual([]);
    expect(claimBackedTextAt({ work: 'not an array' })).toEqual([]);
    expect(claimBackedTextAt({ work: [null, 7, 'x'] })).toEqual([]);
    expect(claimBackedTextAt({ work: [{ highlights: 'not an array' }] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. pathFromTemplate
// ---------------------------------------------------------------------------

describe('pathFromTemplate: the one function that builds a claim jsonPath', () => {
  it('builds the two concrete paths the projector records', () => {
    expect(pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[0], [1, 2])).toBe('work[1].highlights[2]');
    expect(pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[1], [0, 0])).toBe('projects[0].highlights[0]');
  });

  it('is a pure function of the template and the indices, in wildcard order', () => {
    expect(pathFromTemplate(['work', '*', 'highlights', '*'], [3, 0])).toBe('work[3].highlights[0]');
    // The order matters: the FIRST wildcard is the outer array.
    expect(pathFromTemplate(['projects', '*', 'highlights', '*'], [1, 0])).not.toBe(
      pathFromTemplate(['projects', '*', 'highlights', '*'], [0, 1]),
    );
  });

  it('copies a concrete template through unchanged, with no indices needed', () => {
    expect(pathFromTemplate(['basics', 'summary'])).toBe('basics.summary');
  });

  it('refuses a wildcard it was not given an index for, rather than inventing one', () => {
    // Silently emitting `work[undefined]` would be an address that names nothing, and a
    // block entry pointing at it would fail the belt's own comparison later - with a far
    // less obvious message than the caller getting wrong at the call site.
    expect(() => pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[0], [0])).toThrowError(RangeError);
    expect(() => pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[0], [-1, 0])).toThrowError(RangeError);
  });

  it('the shared constant is the two highlight templates PLUS `basics.summary`', () => {
    // Written out here rather than imported from the projector: this is the assertion
    // that the CONSTANT has not been re-widened behind the projector's back (N3's fix
    // depended on exactly that, and the previous list was a superset of what the
    // projector writes). The third member is T1080's deliberate widening for ADR-043
    // R-SUMMARY, and the drift test above is what proves it has an emission site.
    expect(CLAIM_BACKED_TEXT_PATHS).toEqual([
      ['work', '*', 'highlights', '*'],
      ['projects', '*', 'highlights', '*'],
      ['basics', 'summary'],
    ]);
  });

  it('APPENDS the summary rather than prepending it, because the projector indexes the first two', () => {
    // `project.ts` reaches the highlight templates by INDEX (`CLAIM_BACKED_TEXT_PATHS[0]`
    // is `work[].highlights`). Inserting a template in the middle would silently
    // re-point those aliases at the wrong member, and the drift test would then compare
    // two different documents and still pass - the exact failure mode the single shared
    // definition exists to prevent.
    expect(pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[0], [1, 2])).toBe('work[1].highlights[2]');
    expect(pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[1], [0, 0])).toBe('projects[0].highlights[0]');
    expect(pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[2])).toBe('basics.summary');
  });
});
