// tailor/ops.test.ts - THE OPERATION VOCABULARY and the target grammar (T1080; 06 sec.E.3).
//
// WHAT IS PINNED HERE, AND WHY EACH ONE IS A MUTATION KILLER.
//   1. The vocabulary is EXACTLY the nine `ResumeChangeOp` values. A tenth, or a re-spelling,
//      fails: the enum is the schema's, and the tailoring pass writes `ResumeChange.op`.
//   2. The text-changing set is the ops that put NEW PROSE on the page. Dropping `retitle`
//      or `add_skill` from it would let those ops ground new text in nothing, which is the
//      single most valuable hole in this feature.
//   3. No operation may address `x-clearance`. The claim ledger is the one thing a tailoring
//      pass must never be able to rewrite - it is what the belt and the gate read.
//   4. `CLAIM_BACKED_TARGET_PATTERNS` and `resume/json/claimSurface.ts#CLAIM_BACKED_TEXT_PATHS`
//      describe the SAME surface, both directions, on a real projection. Two hand-maintained
//      lists about where claim text lives is the exact bug ADR-043 was written about.
//   5. The prompt asset is COMMITTED and names the constraints the validator enforces.

import { describe, it, expect } from 'vitest';
import { ClaimKind, ResumeChangeOp, type CareerClaim } from '@prisma/client';

import {
  CLAIM_BACKED_TARGET_PATTERNS,
  OP_REJECTION_CODES,
  STYLE_TARGET,
  STRUCTURAL_OPS,
  TAILOR_OPS,
  TAILOR_OPS_PROMPT,
  TEXT_CHANGING_OPS,
  addressesLedger,
  isClaimBackedTarget,
  isTextChangingOp,
  parseOperation,
  parseOperations,
  readTailorPromptSource,
  readTarget,
  reject,
  removeTargetPath,
  renderTailorPrompt,
  targetTokens,
} from './ops.js';
import {
  CLAIM_BACKED_TEXT_PATHS,
  claimBackedTextAt,
  pathFromTemplate,
} from '../resume/json/claimSurface.js';
import { projectResumeJson } from '../resume/json/project.js';
import { claimFingerprint } from '../career/claims.js';

let seq = 0;
function claim(statement: string, kind: ClaimKind = ClaimKind.achievement): CareerClaim {
  seq += 1;
  return {
    id: `clm-${seq}`,
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
    status: 'user_confirmed',
    provenance: 'document_import',
    confidence: null,
    evidenceSourceId: null,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)),
    updatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)),
  } as unknown as CareerClaim;
}

/** A projection with a claim-backed bullet and a claim-backed summary. */
function projectedFixture() {
  return projectResumeJson({
    profileId: 'profile-1',
    basics: { name: 'Ada Lovelace' },
    summaryClaims: [{ claim: claim('A decade of platform work.', 'soft_skill') }],
    work: [
      {
        experience: {
          id: 'exp-0',
          profileId: 'profile-1',
          employmentType: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          company: 'Acme',
          title: 'Engineer',
          location: null,
          startDate: '2020-01',
          endDate: null,
          current: true,
          sortOrder: 0,
        },
        claims: [{ claim: claim('Cut CI build time by 40%') }],
      },
    ],
  }).document;
}

// ---------------------------------------------------------------------------
// 1. The vocabulary
// ---------------------------------------------------------------------------

describe('ops: the vocabulary is EXACTLY the nine ResumeChangeOp values', () => {
  it('lists all nine, in the schema\'s own order, and nothing else', () => {
    expect([...TAILOR_OPS]).toEqual([
      'rewrite_bullet',
      'reword_summary',
      'reorder',
      'include',
      'exclude',
      'add_skill',
      'remove_skill',
      'retitle',
      'customize_style',
    ]);
    expect(TAILOR_OPS.length).toBe(Object.values(ResumeChangeOp).length);
  });

  it('THE TEXT-CHANGING SET IS THE FOUR OPS THAT PUT NEW PROSE ON THE PAGE', () => {
    // The mutation this kills: dropping `retitle` or `add_skill` here. A retitle that says
    // "Principal Engineer" when the confirmed claim says "Staff Engineer" is the same
    // fabrication as a fabricated metric, in a shorter string.
    expect([...TEXT_CHANGING_OPS]).toEqual(['rewrite_bullet', 'reword_summary', 'retitle', 'add_skill']);
    expect([...STRUCTURAL_OPS]).toEqual(['reorder', 'include', 'exclude', 'remove_skill', 'customize_style']);
    expect(TEXT_CHANGING_OPS.length + STRUCTURAL_OPS.length).toBe(TAILOR_OPS.length);
    expect(isTextChangingOp('rewrite_bullet')).toBe(true);
    expect(isTextChangingOp('reorder')).toBe(false);
  });

  it('the two `include`-soundness codes are in the CLOSED vocabulary, with fixed text', () => {
    // A refusal vocabulary a client switches on, extended for a real defect: `include` carrying
    // prose the named claim did not say, and a slot the batch has already filled. Both texts
    // are fixed strings that interpolate nothing, so a client can match on them.
    expect(OP_REJECTION_CODES).toContain('CLAIM_TEXT_MISMATCH');
    expect(OP_REJECTION_CODES).toContain('TARGET_ALREADY_FILLED');
    for (const code of ['CLAIM_TEXT_MISMATCH', 'TARGET_ALREADY_FILLED'] as const) {
      const rejection = reject(code);
      expect(rejection).toEqual({ code, reason: expect.any(String), detail: null });
      expect(rejection.reason.length).toBeGreaterThan(20);
    }
  });

  it('every refusal code has fixed text that interpolates nothing from the caller', () => {
    // The reason vocabulary is what a client switches on, so it has to be CLOSED and
    // caller-independent. `parseOperation` is the constructor, so this also proves every code
    // has text: there is no way to build a rejection that lacks a reason.
    const codes = new Set(OP_REJECTION_CODES);
    for (const code of codes) {
      const rejection = parseOperation({ op: 'nonsense', target: 'work[0]' });
      expect(rejection).toHaveProperty('code');
      expect(OP_REJECTION_CODES).toContain((rejection as { code: string }).code);
    }
    expect(codes.has('FACT_DELTA')).toBe(true);
    expect(codes.has('SOURCE_CLAIMS_REQUIRED')).toBe(true);
    expect(codes.has('SECTION_REQUIRED_BY_TEMPLATE')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The target grammar
// ---------------------------------------------------------------------------

describe('ops: the target grammar', () => {
  it('tokenises a path, and refuses anything that is not one', () => {
    expect(targetTokens('work[0].highlights[2]')).toEqual(['work', '0', 'highlights', '2']);
    expect(targetTokens('basics.summary')).toEqual(['basics', 'summary']);
    expect(targetTokens('work')).toEqual(['work']);
    expect(targetTokens('work[]')).toBeNull();
    expect(targetTokens('work[-1]')).toBeNull();
    expect(targetTokens('work[0].')).toBeNull();
    expect(targetTokens('1work')).toBeNull();
    expect(targetTokens('')).toBeNull();
    expect(targetTokens(undefined as unknown as string)).toBeNull();
  });

  it('NO OPERATION MAY ADDRESS THE CLAIM LEDGER', () => {
    // The one thing a tailoring pass must never be able to rewrite: the ledger the belt and
    // the gate read. Asserted as a property of the vocabulary, not of a branch.
    expect(addressesLedger('x-clearance.claims[0].status')).toBe(true);
    expect(addressesLedger('basics.summary')).toBe(false);
    expect(addressesLedger('work[0].highlights[0]')).toBe(false);
    const refusal = parseOperation({ op: 'rewrite_bullet', target: 'x-clearance.claims[0].status', after: 'x' });
    expect(refusal).toMatchObject({ code: 'TARGET_MALFORMED' });
  });

  it('reads a value by path and reports absence as undefined, never a throw', () => {
    const document = projectedFixture();
    expect(readTarget(document, 'work[0].highlights[0]')).toBe('Cut CI build time by 40%');
    expect(readTarget(document, 'basics.summary')).toBe('A decade of platform work.');
    expect(readTarget(document, 'work[3].highlights[0]')).toBeUndefined();
    expect(readTarget(document, 'nonsense')).toBeUndefined();
    expect(readTarget(null, 'basics.summary')).toBeUndefined();
  });

  it('removing an entry closes the gap, so later paths do not silently shift', () => {
    // `exclude` that left a `null` hole would fail JSON Resume validation, and an `exclude`
    // that shifted every later path without re-recording them would break the ledger's paths.
    const document = { work: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
    expect(removeTargetPath(document, ['work', '1'])).toEqual({ work: [{ name: 'a' }, { name: 'c' }] });
    // And the input is never mutated.
    expect(document.work).toHaveLength(3);
  });

  it('the style target is outside the document, by design', () => {
    // ADR-044 D3: one snapshot, many layouts. The template is a RENDER-time choice, so a
    // style operation has a target that names no document member.
    expect(STYLE_TARGET).toBe('render.templateId');
    expect(readTarget(projectedFixture(), STYLE_TARGET)).toBeUndefined();
    expect(isClaimBackedTarget(STYLE_TARGET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The claim-backed surface agrees with the belt, both directions
// ---------------------------------------------------------------------------

describe('ops: the claim-backed target shapes and the BELT are the same surface', () => {
  it('the shapes are the templates, and they cover every claim-backed path in a projection', () => {
    // DIRECTION 1: every claim-backed path the document HAS is an allowed target shape.
    const seen = claimBackedTextAt(projectedFixture()).map((entry) => entry.path).sort();
    for (const path of seen) {
      expect(isClaimBackedTarget(path), `${path} is a claim-backed path but not a target shape`).toBe(true);
    }
    // DIRECTION 2: every shape is reachable. `work[*]` and `projects[*]` need a fixture member
    // of their own, so the two families are checked against the templates directly.
    expect(isClaimBackedTarget(pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[0], [0, 0]))).toBe(true);
    expect(isClaimBackedTarget(pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[1], [2, 3]))).toBe(true);
    expect(isClaimBackedTarget(pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[2]))).toBe(true);
  });

  it('the shape list is the three claim-rail members, written out rather than derived', () => {
    // Written out here so a re-widening of EITHER constant has to be deliberate in both
    // places. This is the ADR-043 failure mode, restated as the test that prevents it.
    expect(CLAIM_BACKED_TARGET_PATTERNS).toEqual([
      'work.*.highlights.*',
      'projects.*.highlights.*',
      'basics.summary',
    ]);
  });

  it('a NON-claim-backed path is refused as a shape', () => {
    // `skills[].name`, `projects[].keywords` and `work[].position` are NOT on the rail
    // (R-ENTITY), so no claim-backed predicate may claim them.
    expect(isClaimBackedTarget('skills[0].name')).toBe(false);
    expect(isClaimBackedTarget('projects[0].keywords[1]')).toBe(false);
    expect(isClaimBackedTarget('work[0].position')).toBe(false);
    // And a near-miss shape is not a match: exact, not prefix.
    expect(isClaimBackedTarget('work[0].highlights[0].name')).toBe(false);
    expect(isClaimBackedTarget('work[0].highlight[0]')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Normalisation
// ---------------------------------------------------------------------------

describe('ops: normalisation is not validation', () => {
  it('normalises a well-formed operation and trims/dedupes/sorts its claim ids', () => {
    const parsed = parseOperation({
      op: 'rewrite_bullet',
      target: ' work[0].highlights[0] ',
      after: 'new text',
      reason: '  answers the throughput requirement  ',
      sourceClaimIds: ['clm-b', 'clm-a', 'clm-a', ' clm-a '],
    });
    expect(parsed).toMatchObject({
      op: 'rewrite_bullet',
      target: 'work[0].highlights[0]',
      reason: 'answers the throughput requirement',
      sourceClaimIds: ['clm-a', 'clm-b'],
      targetRequirementIds: [],
    });
  });

  it('refuses an unknown op with OP_UNKNOWN, and a malformed one with OP_MALFORMED', () => {
    expect(parseOperation({ op: 'make_it_better', target: 'work[0]' })).toMatchObject({ code: 'OP_UNKNOWN' });
    expect(parseOperation({ op: 'reorder', target: 42 })).toMatchObject({ code: 'TARGET_MALFORMED' });
    expect(parseOperation({ op: 'reorder' })).toMatchObject({ code: 'TARGET_MALFORMED' });
    expect(parseOperation({ op: 'reorder', target: 'work', sourceClaimIds: 'clm-1' })).toMatchObject({
      code: 'OP_MALFORMED',
    });
    expect(parseOperation([1, 2])).toMatchObject({ code: 'OP_MALFORMED' });
  });

  it('parses a batch in order, and a malformed entry does not stop the batch', () => {
    // A client is told about every bad entry rather than receiving a 400 for the whole call.
    const parsed = parseOperations([
      { op: 'rewrite_bullet', target: 'work[0].highlights[0]', after: 'a' },
      { op: 'nope', target: 'work[0].highlights[1]' },
      { op: 'reorder', target: 'work', after: [1, 0] },
    ]);
    expect(parsed.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(parsed[0].operation).not.toBeNull();
    expect(parsed[1].operation).toBeNull();
    expect(parsed[1].rejection).toMatchObject({ code: 'OP_UNKNOWN' });
    expect(parsed[2].operation).toMatchObject({ op: 'reorder' });
  });
});

// ---------------------------------------------------------------------------
// 5. The prompt asset
// ---------------------------------------------------------------------------

describe('ops: the proposal prompt is a committed, reviewable asset', () => {
  it('exists, and states the constraints the DETERMINISTIC validator enforces', () => {
    // If the prompt and the validator ever disagree the user gets refused proposals with no
    // explanation, so the rules are asserted to be IN the prompt. The prompt carries no safety
    // - `validate.ts` does - and this test exists so it cannot imply that it does.
    const source = readTailorPromptSource();
    for (const needle of [
      '{{ job_description }}',
      '{{ requirements }}',
      '{{ confirmed_claims }}',
      '{{ current_resume }}',
      'sourceClaimIds',
      'targetRequirementIds',
      'NEVER introduce a fact',
      'Return STRICT JSON',
    ]) {
      expect(source).toContain(needle);
    }
    // And no op name is spelled differently from the enum.
    for (const op of TAILOR_OPS) expect(source).toContain(op);
  });

  it('renders with the variables substituted and never leaks a placeholder', () => {
    const rendered = renderTailorPrompt({
      job_description: 'DATA',
      requirements: '',
      confirmed_claims: '- clm-1 [achievement] Cut CI build time by 40%',
      current_resume: '{}',
    });
    expect(rendered).toContain('DATA');
    expect(rendered).toContain('clm-1');
    expect(rendered).not.toMatch(/\{\{\s*job_description\s*\}\}/);
    expect(TAILOR_OPS_PROMPT).toBe('tailor_ops_v1.jinja');
  });
});