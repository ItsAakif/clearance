// tailor/validate.test.ts - THE DETERMINISTIC GATE (T1080; 06 sec.E.3's five rules).
//
// ONE RULE, ONE `describe`, IN THE SPEC'S NUMBERING, so the gap between the contract and the
// implementation is visible by reading this file alone. Each rule's test names the mutation it
// kills - the change that would make the rule stop holding while the suite stayed green.
//
// THE FIXTURE IS A REAL PROJECTION, not a literal document. The acceptance item "a new
// metric/employer/technology sets factDelta and is blocked" is only meaningful if the
// before-state came out of the projector, because the ledger entry that names each claim-backed
// string is what `TARGET_CLAIM_MISMATCH` reads and what `apply.ts` has to keep in step.

import { describe, it, expect } from 'vitest';
import { ClaimKind, ClaimStatus, type CareerClaim } from '@prisma/client';

import {
  claimIsOmitted,
  claimPlacingTarget,
  dictKeyForSection,
  parentTarget,
  sectionOf,
  validate,
  validateOperation,
  type ValidationContext,
} from './validate.js';
import { RESUME_DICT_SECTIONS } from '../render/dict.js';
import { claimFingerprint } from '../career/claims.js';
import { projectResumeJson } from '../resume/json/project.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Every entity row in these fixtures carries the same timestamp, so the projector's total order is a function of the id alone. */
const EXP_AT = new Date('2026-09-01T00:00:00.000Z');

let seq = 0;
function claim(
  statement: string,
  status: ClaimStatus = ClaimStatus.user_confirmed,
  kind: ClaimKind = ClaimKind.achievement,
  id?: string,
): CareerClaim {
  seq += 1;
  return {
    id: id ?? `clm-${seq}`,
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
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)),
  } as unknown as CareerClaim;
}

const BULLET = 'Cut CI build time by 40% by caching the dependency layer';
const SUMMARY = 'A decade of platform work.';

/** The claims the fixture profile holds: one placed bullet, one placed summary, one omitted. */
function fixtureClaims(): CareerClaim[] {
  return [
    claim(BULLET, ClaimStatus.user_confirmed, 'achievement', 'clm-bullet'),
    claim(SUMMARY, ClaimStatus.user_confirmed, 'soft_skill', 'clm-summary'),
    // Considered and not used: this is what `include` exists for.
    claim('Migrated 12k accounts to Postgres', ClaimStatus.user_confirmed, 'achievement', 'clm-omitted'),
    // Never confirmed: the acceptance item.
    claim('Ran the whole platform on Kubernetes', ClaimStatus.inferred, 'achievement', 'clm-inferred'),
    // Rejected: also never usable (ADR-036 item 5).
    claim('Owned the entire roadmap', ClaimStatus.rejected, 'achievement', 'clm-rejected'),
  ];
}

/** A projection built from `fixtureClaims()`, with the bullet at `work[0].highlights[0]`. */
function fixtureDocument(claims = fixtureClaims()) {
  return projectResumeJson({
    profileId: 'profile-1',
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer' },
    summaryClaims: [{ claim: claims[1] as CareerClaim }],
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
        claims: [{ claim: claims[0] as CareerClaim }],
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
    skills: [],
    otherClaims: claims
      .filter((entry) => entry.id !== 'clm-bullet' && entry.id !== 'clm-summary')
      .map((entry) => ({ claim: entry })),
  }).document;
}

function fixtureContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  const claims = (overrides.claims as CareerClaim[] | undefined) ?? fixtureClaims();
  return {
    document: (overrides.document as unknown) ?? fixtureDocument(claims),
    profileId: 'profile-1',
    claims,
    requiredDictKeys: ['contact', 'summary', 'experience', 'education', 'skills'],
    templateId: 'typst-ats-classic',
    knownEmployers: ['Acme', 'Globex'],
    knownTemplateIds: ['typst-ats-classic', 'typst-compact-two-col', 'typst-modern-cards'],
    ...overrides,
  };
}

/** The verdict's code, or `null` when the operation is accepted. */
function codeOf(input: unknown, ctx: ValidationContext): string | null {
  const result = validate(input, ctx);
  return 'code' in result ? result.code : null;
}

// ---------------------------------------------------------------------------
// RULE 1 - the target resolves
// ---------------------------------------------------------------------------

describe('RULE 1: the target resolves to an existing node in the revision', () => {
  it('accepts a target that resolves', () => {
    const verdict = validate(
      { op: 'rewrite_bullet', target: 'work[0].highlights[0]', after: 'Reduced the CI build time by 40%', sourceClaimIds: ['clm-bullet'] },
      fixtureContext(),
    );
    expect('code' in verdict).toBe(false);
  });

  it('refuses a target that does NOT resolve - KILLS a validator that skips the lookup', () => {
    expect(
      codeOf(
        { op: 'rewrite_bullet', target: 'work[0].highlights[7]', after: 'new text', sourceClaimIds: ['clm-bullet'] },
        fixtureContext(),
      ),
    ).toBe('TARGET_UNRESOLVED');
    expect(
      codeOf(
        { op: 'reword_summary', target: 'basics.name', after: 'new text', sourceClaimIds: ['clm-summary'] },
        fixtureContext(),
      ),
    ).toBe('TARGET_NOT_APPLICABLE');
  });

  it('allows a whole ARRAY to be absent for the two ops that legitimately address one', () => {
    // A resume with no projects has no `projects` array, and `add_skill` is how a skills list
    // starts. Any other op aimed at an absent array is a resolution failure.
    const ctx = fixtureContext();
    expect(codeOf({ op: 'reorder', target: 'projects', after: [] }, ctx)).toBeNull();
    expect(
      codeOf(
        { op: 'add_skill', target: 'skills', after: 'Kubernetes', sourceClaimIds: ['clm-inferred'] },
        ctx,
      ),
    ).toBe('SOURCE_CLAIM_NOT_CONFIRMED');
  });

  it('reports the paragraph a path names, for `include` and `exclude`', () => {
    expect(parentTarget('work[0].highlights[2]')).toBe('work[0].highlights');
    expect(parentTarget('basics.summary')).toBe('basics');
    expect(parentTarget('work')).toBe('');
    expect(sectionOf('work[0].highlights[2]')).toBe('work');
    expect(sectionOf('basics.summary')).toBe('basics');
  });

  it('the document-member to dictionary-section relation is COMPLETE', () => {
    // Rule 4 compares against `requiredDictKeys`, which is the DICTIONARY's vocabulary. A
    // member missing from this relation is a section whose removal is never checked - so the
    // relation is asserted complete in BOTH directions against `RESUME_DICT_SECTIONS`.
    expect(dictKeyForSection('work')).toBe('experience');
    expect(dictKeyForSection('basics')).toBe('contact');
    expect(dictKeyForSection('summary')).toBe('summary');
    expect(dictKeyForSection('certificates')).toBe('certifications');
    const rendered = new Set(
      ['basics', 'summary', 'work', 'projects', 'education', 'skills', 'certificates']
        .map((member) => dictKeyForSection(member))
        .filter((key): key is string => key !== null),
    );
    expect([...rendered].sort()).toEqual([...RESUME_DICT_SECTIONS].sort());
  });

  it('answers "who placed this text" from the DOCUMENT, never from the op', () => {
    expect(claimPlacingTarget(fixtureDocument(), 'work[0].highlights[0]')).toBe('clm-bullet');
    expect(claimPlacingTarget(fixtureDocument(), 'basics.summary')).toBe('clm-summary');
    expect(claimPlacingTarget(fixtureDocument(), 'work[1].highlights[0]')).toBeNull();
    expect(claimIsOmitted(fixtureDocument(), 'clm-omitted')).toBe(true);
    expect(claimIsOmitted(fixtureDocument(), 'clm-bullet')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RULE 2 - text ops require a non-empty set of CONFIRMED source claims
// ---------------------------------------------------------------------------

describe('RULE 2: a text-changing op needs a non-empty set of CONFIRMED source claims', () => {
  it('refuses a text op with NO sourceClaimIds - THE ACCEPTANCE ITEM', () => {
    expect(
      codeOf({ op: 'rewrite_bullet', target: 'work[0].highlights[0]', after: 'Reduced it' }, fixtureContext()),
    ).toBe('SOURCE_CLAIMS_REQUIRED');
    expect(
      codeOf({ op: 'reword_summary', target: 'basics.summary', after: 'Ten years of it.' }, fixtureContext()),
    ).toBe('SOURCE_CLAIMS_REQUIRED');
    expect(
      codeOf(
        { op: 'retitle', target: 'work[0].position', after: 'Principal Engineer', sourceClaimIds: [] },
        fixtureContext(),
      ),
    ).toBe('SOURCE_CLAIMS_REQUIRED');
  });

  it('refuses a claim that does not exist in the profile - a guessed id', () => {
    expect(
      codeOf(
        {
          op: 'rewrite_bullet',
          target: 'work[0].highlights[0]',
          after: 'Reduced the CI build time by 40%',
          sourceClaimIds: ['clm-does-not-exist'],
        },
        fixtureContext(),
      ),
    ).toBe('SOURCE_CLAIM_NOT_FOUND');
  });

  it('refuses an INFERRED claim, and refuses a REJECTED one - ADR-036 item 5', () => {
    for (const id of ['clm-inferred', 'clm-rejected']) {
      expect(
        codeOf(
          {
            op: 'rewrite_bullet',
            target: 'work[0].highlights[0]',
            after: 'Reduced the CI build time by 40%',
            sourceClaimIds: [id],
          },
          fixtureContext(),
        ),
        `${id} must not ground new wording`,
      ).toBe('SOURCE_CLAIM_NOT_CONFIRMED');
    }
  });

  it('refuses a rewrite that names a DIFFERENT confirmed claim than the one that placed the text', () => {
    // The hole rule 2's literal wording leaves open, and the one that matters. Without this,
    // any confirmed claim could be cited for any bullet, and the ledger would then attribute
    // the new wording to a claim that never said it.
    expect(
      codeOf(
        {
          op: 'rewrite_bullet',
          target: 'work[0].highlights[0]',
          after: 'Reduced the CI build time by 40%',
          sourceClaimIds: ['clm-summary'],
        },
        fixtureContext(),
      ),
    ).toBe('TARGET_CLAIM_MISMATCH');
  });

  it('a STRUCTURAL op needs no grounding, but may not name an unconfirmed one', () => {
    // `exclude` moves no text, so requiring a claim for it would make the op vocabulary
    // unusable; but recording "this exclusion is justified by <a rejected claim>" would put a
    // rejected claim into an audit trail as if it were evidence.
    expect(codeOf({ op: 'exclude', target: 'work[1]' }, fixtureContext())).toBeNull();
    expect(codeOf({ op: 'exclude', target: 'work[1]', sourceClaimIds: ['clm-bullet'] }, fixtureContext())).toBeNull();
    expect(codeOf({ op: 'exclude', target: 'work[1]', sourceClaimIds: ['clm-rejected'] }, fixtureContext())).toBe(
      'SOURCE_CLAIM_NOT_CONFIRMED',
    );
  });
});

// ---------------------------------------------------------------------------
// RULE 3 - the fact-preservation check
// ---------------------------------------------------------------------------

describe('RULE 3: entities(after) subset-of entities(before) union entities(confirmed claims)', () => {
  const op = (after: string) => ({
    op: 'rewrite_bullet',
    target: 'work[0].highlights[0]',
    after,
    sourceClaimIds: ['clm-bullet'],
    reason: "mirrors the JD's 'high-throughput' requirement",
  });

  it('CLEAN: the same facts, re-worded', () => {
    expect(codeOf(op('Reduced the CI build time by 40% by caching the dependency layer'), fixtureContext())).toBeNull();
  });

  it('BLOCKED: a fabricated METRIC - THE ACCEPTANCE FIXTURE', () => {
    expect(codeOf(op('Cut the CI build time by 40% and scaled to 12000 accounts'), fixtureContext())).toBe('FACT_DELTA');
  });

  it('BLOCKED: a fabricated EMPLOYER', () => {
    expect(codeOf(op('Cut the CI build time by 40% while at Initech'), fixtureContext())).toBe('FACT_DELTA');
  });

  it('BLOCKED: a fabricated TECHNOLOGY', () => {
    expect(codeOf(op('Cut the CI build time by 40% by moving the clusters to kubernetes'), fixtureContext())).toBe(
      'FACT_DELTA',
    );
  });

  it('BLOCKED: a fabricated DATE', () => {
    expect(codeOf(op('Cut the CI build time by 40% back in 1999'), fixtureContext())).toBe('FACT_DELTA');
  });

  it('the guard reads the DOCUMENT when `before` is omitted, so it cannot be dodged', () => {
    // A client that leaves `before` out must not thereby escape the check. Asserted because
    // "the validator trusts `before`" is the most tempting one-line optimisation here.
    expect(codeOf({ ...op('Cut the CI build time by 40% and scaled to 12000 accounts'), before: undefined }, fixtureContext())).toBe(
      'FACT_DELTA',
    );
    // And a `before` that disagrees with the document is refused outright.
    expect(codeOf({ ...op('Reduced the CI build time by 40%'), before: 'Something else entirely' }, fixtureContext())).toBe(
      'BEFORE_MISMATCH',
    );
  });

  it('a confirmed claim\'s facts are allowed even when the BEFORE does not state them', () => {
    const claims = fixtureClaims();
    const bullet = {
      ...(claims[0] as CareerClaim),
      statement: 'Cut the CI build time by 40% by caching the dependency layer at Initech',
    } as CareerClaim;
    const ctx = fixtureContext({ claims: [bullet, ...claims.slice(1)] });
    expect(codeOf(op('Reduced the CI build time by 40% at Initech'), ctx)).toBeNull();
  });

  it('the detail NAMES the facts, so a refusal says what to look at', () => {
    const result = validateOperation(op('Cut the CI build time by 40% and scaled to 12000 accounts'), fixtureContext());
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.rejection.detail).toContain('metric:12000');
  });
});

// ---------------------------------------------------------------------------
// RULE 4 - remove_skill / exclude must not empty a required section
// ---------------------------------------------------------------------------

describe("RULE 4: a removal must not empty a section the chosen template REQUIRES", () => {
  it('refuses removing the ONLY entry of a required section', () => {
    // `requiredDictKeys` is a SECTION vocabulary - it names no individual skill - so the
    // question it can answer is "would this leave a required section empty", and that is what
    // is asked.
    const document = projectResumeJson({
      profileId: 'profile-1',
      basics: { name: 'Ada' },
      work: [
        {
          experience: { id: 'exp-0', profileId: 'profile-1', employmentType: null, createdAt: EXP_AT, updatedAt: EXP_AT,
          company: 'Acme',
            title: 'Engineer',
            location: null,
            startDate: '2020-01',
            endDate: null,
            current: true,
            sortOrder: 0,
          },
          claims: [{ claim: fixtureClaims()[0] as CareerClaim }],
        },
      ],
    }).document;
    expect(codeOf({ op: 'exclude', target: 'work[0]' }, fixtureContext({ document }))).toBe(
      'SECTION_REQUIRED_BY_TEMPLATE',
    );
  });

  it('permits removing an entry from a section with more than one, and a section that is not required', () => {
    expect(codeOf({ op: 'exclude', target: 'work[1]' }, fixtureContext())).toBeNull();
    const ctx = fixtureContext({ requiredDictKeys: ['contact'] });
    expect(codeOf({ op: 'exclude', target: 'work[0]' }, ctx)).toBeNull();
  });

  it('remove_skill is the same rule, addressed at skills[i]', () => {
    const claims = fixtureClaims();
    const withSkills = {
      ...(fixtureDocument(claims) as Record<string, unknown>),
      skills: [{ name: 'Kubernetes' }],
    };
    expect(codeOf({ op: 'remove_skill', target: 'skills[0]' }, fixtureContext({ document: withSkills }))).toBe(
      'SECTION_REQUIRED_BY_TEMPLATE',
    );
    expect(
      codeOf({ op: 'remove_skill', target: 'skills[1]' }, fixtureContext({ document: withSkills })),
    ).toBe('TARGET_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// RULE 5 - reorder is a permutation
// ---------------------------------------------------------------------------

describe('RULE 5: a reorder permutes existing entries and does nothing else', () => {
  it('accepts a permutation', () => {
    expect(codeOf({ op: 'reorder', target: 'work', after: [1, 0] }, fixtureContext())).toBeNull();
  });

  it('refuses a permutation that ADDS, DROPS or DUPLICATES an entry', () => {
    // Each of these would either invent content or lose content while claiming to be a
    // reordering.
    expect(codeOf({ op: 'reorder', target: 'work', after: [0, 1, 2] }, fixtureContext())).toBe('REORDER_NOT_A_PERMUTATION');
    expect(codeOf({ op: 'reorder', target: 'work', after: [0] }, fixtureContext())).toBe('REORDER_NOT_A_PERMUTATION');
    expect(codeOf({ op: 'reorder', target: 'work', after: [0, 0] }, fixtureContext())).toBe('REORDER_NOT_A_PERMUTATION');
    expect(codeOf({ op: 'reorder', target: 'work', after: [0, -1] }, fixtureContext())).toBe('REORDER_NOT_A_PERMUTATION');
    expect(codeOf({ op: 'reorder', target: 'work', after: ['1', '0'] }, fixtureContext())).toBe('REORDER_NOT_A_PERMUTATION');
  });

  it('refuses a reorder aimed at something that is not a section', () => {
    expect(codeOf({ op: 'reorder', target: 'basics.summary', after: [] }, fixtureContext())).toBe(
      'TARGET_NOT_APPLICABLE',
    );
  });
});

// ---------------------------------------------------------------------------
// THE REMAINING OPS - include, add_skill, customize_style
// ---------------------------------------------------------------------------

describe('the remaining operations are validated, not merely accepted', () => {
  it('include puts a confirmed claim at an EMPTY claim-backed slot, and only that', () => {
    const ok = codeOf(
      { op: 'include', target: 'work[0].highlights[1]', after: 'Migrated 12k accounts to Postgres', sourceClaimIds: ['clm-omitted'] },
      fixtureContext(),
    );
    expect(ok).toBeNull();
    // An occupied slot.
    expect(
      codeOf(
        { op: 'include', target: 'work[0].highlights[0]', after: 'Migrated 12k accounts to Postgres', sourceClaimIds: ['clm-omitted'] },
        fixtureContext(),
      ),
    ).toBe('TARGET_NOT_FOUND');
    // A claim that is already rendered.
    expect(
      codeOf(
        { op: 'include', target: 'work[0].highlights[1]', after: BULLET, sourceClaimIds: ['clm-bullet'] },
        fixtureContext(),
      ),
    ).toBe('CLAIM_ALREADY_RENDERED');
    // A parent that is not an array - creating a SECTION is not this engine's job.
    expect(
      codeOf(
        { op: 'include', target: 'projects[0].highlights[0]', after: 'Migrated 12k accounts to Postgres', sourceClaimIds: ['clm-omitted'] },
        fixtureContext(),
      ),
    ).toBe('TARGET_NOT_APPLICABLE');
  });

  it('add_skill appends a NAME, and refuses one the document already has', () => {
    const withSkills = { ...(fixtureDocument() as Record<string, unknown>), skills: [{ name: 'Kubernetes' }] };
    expect(
      codeOf({ op: 'add_skill', target: 'skills', after: 'Kubernetes', sourceClaimIds: ['clm-omitted'] }, fixtureContext({ document: withSkills })),
    ).toBe('TARGET_NOT_FOUND');
    expect(
      codeOf({ op: 'add_skill', target: 'skills', after: '  ', sourceClaimIds: ['clm-omitted'] }, fixtureContext()),
    ).toBe('OP_MALFORMED');
    // And a name that is a NEW technology is a fact delta like any other.
    expect(
      codeOf({ op: 'add_skill', target: 'skills', after: 'Kubernetes', sourceClaimIds: ['clm-omitted'] }, fixtureContext()),
    ).toBe('FACT_DELTA');
  });

  it('customize_style records a RENDER-TIME choice and never touches the document', () => {
    expect(codeOf({ op: 'customize_style', target: 'render.templateId', before: 'typst-ats-classic', after: 'typst-modern-cards' }, fixtureContext())).toBeNull();
    // An id the registry cannot resolve is refused WHEN the caller supplied the registry.
    expect(
      codeOf({ op: 'customize_style', target: 'render.templateId', after: 'not-a-template' }, fixtureContext()),
    ).toBe('TEMPLATE_UNKNOWN');
    // Without the registry the op is recorded rather than refused - the ROUTE is the
    // enforcement point, because the registry is I/O-backed and this module is not.
    const withoutRegistry = fixtureContext();
    expect(codeOf({ op: 'customize_style', target: 'render.templateId', after: 'not-a-template' }, { ...withoutRegistry, knownTemplateIds: undefined })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RULE 6 - `include` writes the CLAIM'S OWN WORDS, or none at all
// ---------------------------------------------------------------------------

describe("RULE 6: an `include` may not carry prose the named claim did not say", () => {
  // THE DEFECT THIS BLOCK EXISTS FOR. `include` is STRUCTURAL, so rule 3 (the fact-delta
  // pass) never ran on it - on the strength of a comment claiming a structural op "cannot put
  // a word on the page that was not already there". That is true of `exclude`/`remove_skill`/
  // `reorder` and FALSE of `include`, whose `after` is free text. So an `include` naming ANY
  // confirmed, currently-`omitted` claim could carry arbitrary prose, and `apply.ts` would
  // render it as that claim's verified text: `rewrite_bullet` with the guard switched off,
  // reached through the op that was supposed to be the safe one.
  const STATEMENT = 'Migrated 12k accounts to Postgres'; // clm-omitted's statement, verbatim
  const SLOT = 'work[0].highlights[1]';
  const ABUSIVE = 'Cut CI build time by 95% and led the migration at Globex';

  const include = (after?: unknown) =>
    codeOf({ op: 'include', target: SLOT, after, sourceClaimIds: ['clm-omitted'] }, fixtureContext());

  it('ACCEPTED when `after` IS the named claim\'s statement', () => {
    expect(include(STATEMENT)).toBeNull();
  });

  it('REFUSED when `after` is DIFFERENT prose - THE ACCEPTANCE FIXTURE, with the code', () => {
    // The claim is confirmed, currently `omitted`, the slot is empty and the parent is an
    // array: every OTHER `include` rule is satisfied. Only the text is new.
    expect(include(ABUSIVE)).toBe('CLAIM_TEXT_MISMATCH');
    const result = validateOperation(
      { op: 'include', target: SLOT, after: ABUSIVE, sourceClaimIds: ['clm-omitted'] },
      fixtureContext(),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      // Machine-readable, and the detail names the claim whose words were required - not the
      // prose, which is caller data and is never echoed into a fixed string.
      expect(result.rejection.reason).toBe(
        'an include may only carry the statement of the claim it names, never wording of its own',
      );
      expect(result.rejection.detail).toContain('clm-omitted');
    }
  });

  it('the TEXT reason comes first when the op is wrong in two ways - and the other still fires', () => {
    // Order is part of the contract: prose naming an already-rendered claim reports the prose,
    // because the text is the thing that would have been written. The rendered-claim rule is
    // NOT replaced by the text rule - it is what refuses the op once the text is honest.
    expect(
      codeOf(
        { op: 'include', target: SLOT, after: ABUSIVE, sourceClaimIds: ['clm-summary'] },
        fixtureContext(),
      ),
    ).toBe('CLAIM_TEXT_MISMATCH');
    expect(
      codeOf(
        { op: 'include', target: SLOT, after: SUMMARY, sourceClaimIds: ['clm-summary'] },
        fixtureContext(),
      ),
    ).toBe('CLAIM_ALREADY_RENDERED');
  });

  it('ACCEPTED with NO `after`: the purely structural include', () => {
    // The text comes from the claim row, not from the request (`apply.ts`), so omitting it
    // expresses the SAME operation as echoing it back and adds no new capability.
    expect(include(undefined)).toBeNull();
    expect(codeOf({ op: 'include', target: SLOT, sourceClaimIds: ['clm-omitted'] }, fixtureContext())).toBeNull();
    expect(include(null)).toBeNull();
    expect(include('   ')).toBeNull();
    // And it reports the claim that grounded it, so the fold can write that claim's words.
    const verdict = validate(
      { op: 'include', target: SLOT, sourceClaimIds: ['clm-omitted'] },
      fixtureContext(),
    );
    if (!('code' in verdict)) {
      expect(verdict.groundingClaims.map((claim) => claim.id)).toEqual(['clm-omitted']);
      expect(verdict.factChecked).toBe(false);
    }
  });

  it('normalises the way the CAREER layer does, so a re-spelling is not a different claim', () => {
    // `normalizeStatement` is what `claimFingerprint` hashes, so these are the same claim by
    // the definition the database's `@@unique([profileId, fingerprint])` already enforces.
    // Case and interior whitespace cannot change a fact; a different SENTENCE is refused.
    expect(include(`  ${STATEMENT.toUpperCase()}  `)).toBeNull();
    expect(include('migrated 12k accounts  to postgres')).toBeNull();
    expect(include(`${STATEMENT}.`)).toBe('CLAIM_TEXT_MISMATCH');
    expect(include(`${STATEMENT} and cut the migration short`)).toBe('CLAIM_TEXT_MISMATCH');
  });

  it('a non-string `after` is still OP_MALFORMED - "no text" is not "any value"', () => {
    expect(include(42)).toBe('OP_MALFORMED');
    expect(include({ text: STATEMENT })).toBe('OP_MALFORMED');
    expect(include([STATEMENT])).toBe('OP_MALFORMED');
  });

  it('the shape rules are unchanged: the mismatch is checked AFTER slot, parent and count', () => {
    // Order is part of the contract (the header lists it): an op wrong in two ways gets the
    // reason for the earlier one. Occupied slot, then one-claim requirement, then the text.
    expect(
      codeOf(
        { op: 'include', target: 'work[0].highlights[0]', after: ABUSIVE, sourceClaimIds: ['clm-omitted'] },
        fixtureContext(),
      ),
    ).toBe('TARGET_NOT_FOUND');
    expect(codeOf({ op: 'include', target: SLOT, after: ABUSIVE }, fixtureContext())).toBe('SOURCE_CLAIMS_REQUIRED');
    expect(
      codeOf(
        { op: 'include', target: SLOT, after: ABUSIVE, sourceClaimIds: ['clm-omitted', 'clm-summary'] },
        fixtureContext(),
      ),
    ).toBe('SOURCE_CLAIMS_REQUIRED');
    expect(
      codeOf(
        { op: 'include', target: SLOT, after: ABUSIVE, sourceClaimIds: ['clm-does-not-exist'] },
        fixtureContext(),
      ),
    ).toBe('SOURCE_CLAIM_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// THE VALIDATOR IS A FUNCTION OF ITS INPUTS
// ---------------------------------------------------------------------------

describe('validation is deterministic and total', () => {
  it('the same operation and context always give the same verdict', () => {
    const ctx = fixtureContext();
    const input = {
      op: 'rewrite_bullet',
      target: 'work[0].highlights[0]',
      after: 'Reduced the CI build time by 40%',
      sourceClaimIds: ['clm-bullet'],
    };
    expect(validate(input, ctx)).toEqual(validate(input, ctx));
  });

  it('a malformed input is a REFUSAL, never a throw', () => {
    for (const input of [null, undefined, 42, 'x', [], {}]) {
      expect(codeOf(input, fixtureContext())).not.toBeNull();
    }
  });

  it('an accepted text op reports which claims grounded it', () => {
    const verdict = validate(
      { op: 'rewrite_bullet', target: 'work[0].highlights[0]', after: 'Reduced the CI build time by 40%', sourceClaimIds: ['clm-bullet'] },
      fixtureContext(),
    );
    expect('code' in verdict).toBe(false);
    if (!('code' in verdict)) {
      expect(verdict.groundingClaims.map((claim) => claim.id)).toEqual(['clm-bullet']);
      expect(verdict.factChecked).toBe(true);
    }
  });

  it('NO SCORE, EVER: the verdict carries an operation or a code and nothing in between', () => {
    // E.6 forbids a single number on a match, and a "how good is this rewrite" score on an
    // operation would be that number one layer down. Asserted structurally: the accepted shape
    // has exactly these members.
    const verdict = validate({ op: 'reorder', target: 'work', after: [1, 0] }, fixtureContext());
    if (!('code' in verdict)) {
      expect(Object.keys(verdict).sort()).toEqual(['factChecked', 'groundingClaims', 'operation']);
    }
  });
});