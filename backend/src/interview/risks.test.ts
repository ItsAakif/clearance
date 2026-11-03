// =====================================================================================
// interview/risks.test.ts - THE DERIVATION TRUTH TABLE, AND THE TWO THINGS THAT MAKE IT ONE
// (T1090).
//
// ACCEPTANCE ITEM 1 - "risks are derived from data (claim usage/gaps), not from free
// generation" - IS PROVED TWICE HERE, AND THE SECOND PROOF IS THE ONE THAT MATTERS:
//
//   1. THE SOURCE GUARD. `risks.ts` is grepped for every way it could reach a provider, a
//      clock or the network. No match means the risk stage cannot produce a risk that came
//      from a model, because there is no path from one to the other.
//   2. THE ANCHOR INVARIANT. `assertRisksAreAnchored` is called on the whole fixture, and
//      separately on a hand-built risk with no anchor, which must be refused with
//      `RISK_UNANCHORED_RISK`. A risk whose anchors were dropped would survive every
//      statement-based test in this file and still be unusable, so the invariant is asserted
//      as its own named test and is the MUTATION TARGET for "let a risk be emitted without a
//      data anchor".
//
// THE SEVEN KINDS EACH GET A FIXTURE. E.4's table is a contract about WHERE each risk is read
// from, so a test that only asserted "some risks came out" would not be testing the contract
// at all. The Kubernetes fixture below is the same worked case 06 sec. E.2 uses, so a reader
// can check the risk against the example they already know.
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ClaimKind,
  ClaimProvenance,
  ClaimStatus,
  InterviewRiskKind,
} from '@prisma/client';

import {
  EMPHASIZED_TECH_MUST_HIGH,
  EMPHASIZED_TECH_MUST_MIN,
  FIRST_SCREEN_TARGET_PATTERNS,
  INTERVIEW_RISK_KINDS,
  InterviewRiskError,
  NEW_CLAIM_CONFIRMATION_WINDOW_DAYS,
  REWRITTEN_BULLET_OVERLAP_HIGH,
  REWRITTEN_BULLET_OVERLAP_MAX,
  RISK_ANCHOR_SOURCES,
  RISK_KIND_FOCUS,
  assertRisksAreAnchored,
  deriveInterviewRisks,
  firstScreenPattern,
  wordOverlap,
  type DerivedRisk,
  type RiskChangeRow,
  type RiskClaimRow,
  type RiskRequirementRow,
  type RiskUsageRow,
} from './risks.js';

const RISKS_FILE = path.join(__dirname, 'risks.ts');
const SOURCE = readFileSync(RISKS_FILE, 'utf8');

/**
 * The source with its COMMENTS stripped.
 *
 * IT HAS TO BE, AND THE REASON IS WORTH THE FOUR LINES. This module's header NAMES the very
 * tokens the guard below forbids - `runLlmCompletion`, `Date.now`, `prisma` - because the header
 * is where it explains that it calls none of them. Grepping the raw text would therefore fail
 * forever against a well-documented module and the guard would have to be weakened into
 * uselessness, or the documentation into silence. A `//` is a comment here only at the start of
 * a line (after whitespace) or on a block-comment continuation line, and a URL's `//` always
 * follows a scheme character, so no executable line loses content.
 */
const CODE = SOURCE.split('\n')
  .map((line) => (line.search(/^\s*(\/\/|\*)/) === 0 ? line.slice(0, line.search(/\S/)) : line))
  .join('\n');

const NOW = new Date('2026-10-03T12:00:00.000Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * One revision, four claims, three usages, three changes and three requirements.
 *
 * THE KUBERNETES CASE IS 06 sec. E.2's. `clm-k8s` is confirmed and on the first screen, and it
 * is the `direct` evidence for two must-have requirements, which is `emphasized_tech` waiting
 * to happen. `clm-lat` is the leakage fixture: its claim says "cut request latency" and the
 * tailored wording on the page says "from 900ms to 120ms", which nobody confirmed.
 */
const DOCUMENT = {
  basics: { summary: 'Platform engineer with Kubernetes and Terraform in production.' },
  work: [
    {
      name: 'Globex',
      highlights: [
        'Reduced request latency at Globex from 900ms to 120ms',
        'Owned the nightly batch job for the finance team',
      ],
    },
  ],
  skills: [{ name: 'Ran Kubernetes in production at Globex' }],
  'x-clearance': {
    claims: [
      {
        claimId: 'clm-lat',
        jsonPath: 'work[0].highlights[0]',
        usage: 'tailored',
        renderedText: 'Reduced request latency at Globex from 900ms to 120ms',
        status: 'user_confirmed',
      },
      {
        claimId: 'clm-batch',
        jsonPath: 'work[0].highlights[1]',
        usage: 'verbatim',
        renderedText: 'Owned the nightly batch job for the finance team',
        status: 'user_confirmed',
      },
      {
        claimId: 'clm-k8s',
        jsonPath: 'skills[0].name',
        usage: 'verbatim',
        renderedText: 'Ran Kubernetes in production at Globex',
        status: 'user_confirmed',
      },
      {
        claimId: 'clm-sum',
        jsonPath: 'basics.summary',
        usage: 'verbatim',
        renderedText: 'Platform engineer with Kubernetes and Terraform in production.',
        status: 'user_confirmed',
      },
      // An `omitted` claim: in the profile, NOT on the page. Nothing here may fire for it.
      { claimId: 'clm-old', jsonPath: null, usage: 'omitted', renderedText: null, status: 'user_confirmed' },
    ],
  },
};

const USAGES: RiskUsageRow[] = [
  { claimId: 'clm-lat', usage: 'tailored', renderedText: 'Reduced request latency at Globex from 900ms to 120ms' },
  { claimId: 'clm-batch', usage: 'verbatim', renderedText: 'Owned the nightly batch job for the finance team' },
  { claimId: 'clm-k8s', usage: 'verbatim', renderedText: 'Ran Kubernetes in production at Globex' },
  { claimId: 'clm-sum', usage: 'verbatim', renderedText: 'Platform engineer with Kubernetes and Terraform in production.' },
  { claimId: 'clm-old', usage: 'omitted', renderedText: null },
];

const CLAIMS: RiskClaimRow[] = [
  {
    id: 'clm-lat',
    kind: ClaimKind.achievement,
    statement: 'Cut request latency for the checkout path',
    status: ClaimStatus.user_confirmed,
    provenance: ClaimProvenance.document_import,
    evidenceSourceId: 'src-1',
    confirmedAt: daysAgo(400),
  },
  {
    id: 'clm-batch',
    kind: ClaimKind.responsibility,
    statement: 'Ran the nightly batch job for the finance team',
    status: ClaimStatus.user_confirmed,
    provenance: ClaimProvenance.document_import,
    evidenceSourceId: 'src-1',
    confirmedAt: daysAgo(400),
  },
  {
    id: 'clm-k8s',
    kind: ClaimKind.technology,
    statement: 'Ran Kubernetes in production at Globex',
    status: ClaimStatus.user_confirmed,
    provenance: ClaimProvenance.document_import,
    evidenceSourceId: 'src-1',
    confirmedAt: daysAgo(400),
  },
  {
    id: 'clm-sum',
    kind: ClaimKind.role,
    statement: 'Platform engineer with Kubernetes and Terraform in production',
    status: ClaimStatus.user_confirmed,
    provenance: ClaimProvenance.document_import,
    evidenceSourceId: 'src-1',
    confirmedAt: daysAgo(400),
  },
  {
    id: 'clm-old',
    kind: ClaimKind.certification,
    statement: 'Certified Kubernetes administrator',
    status: ClaimStatus.user_confirmed,
    provenance: ClaimProvenance.user_entered,
    evidenceSourceId: null,
    confirmedAt: daysAgo(90),
  },
];

const CHANGES: RiskChangeRow[] = [
  {
    id: 'chg-leak',
    op: 'rewrite_bullet',
    jsonPath: 'work[0].highlights[0]',
    before: 'Cut request latency for the checkout path',
    after: 'Reduced request latency at Globex from 900ms to 120ms',
    accepted: true,
    sourceClaimIds: ['clm-lat'],
  },
  {
    id: 'chg-reword',
    op: 'rewrite_bullet',
    jsonPath: 'work[0].highlights[1]',
    before: 'Ran the nightly batch job for the finance team',
    after: 'Owned end-to-end reliability of the nightly batch job for the finance team',
    accepted: true,
    sourceClaimIds: ['clm-batch'],
  },
];

const REQUIREMENTS: RiskRequirementRow[] = [
  {
    requirementId: 'req-k8s',
    kind: 'technology',
    importance: 'must',
    text: 'Kubernetes container orchestration',
    level: 'direct',
    evidence: [{ claimId: 'clm-k8s' }],
  },
  {
    requirementId: 'req-tf',
    kind: 'required_skill',
    importance: 'must',
    text: 'Terraform',
    level: 'direct',
    evidence: [{ claimId: 'clm-k8s' }],
  },
  {
    requirementId: 'req-years',
    kind: 'years_experience',
    importance: 'must',
    text: '7+ years of relevant experience',
    level: 'unsupported',
    evidence: [],
  },
  {
    requirementId: 'req-kafka',
    kind: 'preferred_skill',
    importance: 'nice',
    text: 'Kafka streaming',
    level: 'unsupported',
    evidence: [],
  },
];

function derive(overrides: Partial<Parameters<typeof deriveInterviewRisks>[0]> = {}) {
  return deriveInterviewRisks({
    document: DOCUMENT,
    usages: USAGES,
    claims: CLAIMS,
    changes: CHANGES,
    requirements: REQUIREMENTS,
    now: NOW,
    ...overrides,
  });
}

const kindsOf = (result: ReturnType<typeof derive>): InterviewRiskKind[] =>
  result.risks.map((risk) => risk.kind);

const only = <T,>(rows: readonly T[], predicate: (row: T) => boolean): T[] => rows.filter(predicate);

/** A local spelling of the invariant, so the "whole fixture" assertion does not just call it. */
function risksAreAnchored(risks: readonly DerivedRisk[]): boolean {
  return risks.every(
    (risk) =>
      Array.isArray(risk.anchors) &&
      risk.anchors.length > 0 &&
      risk.anchors.every(
        (anchor) =>
          typeof anchor.id === 'string' &&
          anchor.id.length > 0 &&
          RISK_ANCHOR_SOURCES.includes(anchor.source) &&
          typeof anchor.detail === 'string' &&
          anchor.detail.length > 0,
      ),
  );
}

// ---------------------------------------------------------------------------
// Acceptance 1, proof 1: the source guard
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 1 (proof 1): the risk stage cannot reach a provider, a clock or the network', () => {
  it('names no LLM entry point in its CODE', () => {
    for (const forbidden of [
      'runLlmCompletion',
      'leaseNextLlmKey',
      'createLlmClient',
      'getProviderModel',
      'loadAndRender',
      'keyManager',
      'providerModels',
    ]) {
      expect([forbidden, CODE.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it('reads no clock of its own and makes no network call', () => {
    for (const forbidden of ['Date.now', 'new Date(', 'fetch(', 'Math.random']) {
      expect([forbidden, CODE.includes(forbidden)]).toEqual([forbidden, false]);
    }
    // Non-vacuity: the stripper really does remove the header that names all of these.
    expect(SOURCE).toContain('runLlmCompletion');
  });

  it('holds no store seam, so it cannot write a risk the derivation did not produce', () => {
    // `lib/prisma`, not the bare word: the module DOES import enum TYPES from
    // `@prisma/client`, and forbidding that would forbid it from knowing the vocabulary.
    // Forbidding the SINGLETON and every write delegate is the actual control.
    for (const forbidden of ['lib/prisma', 'PrismaClient', '.create(', '.update(', '.upsert(', '$transaction']) {
      expect([forbidden, CODE.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it('imports the tailoring vocabulary rather than re-implementing entity extraction', () => {
    expect(CODE).toMatch(/from '\.\.\/tailor\/factDelta\.js'/);
    expect(CODE).toMatch(/detectFactDelta/);
    expect(CODE).toMatch(/isRenderableClaimStatus/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 1, proof 2: the anchor invariant (MUTATION TARGET)
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 1 (proof 2): every emitted risk names the data it was derived from', () => {
  it('MUTATION TARGET: the whole fixture is anchored', () => {
    const result = derive();
    expect(risksAreAnchored(result.risks)).toBe(true);
    expect(assertRisksAreAnchored(result.risks)).toHaveLength(result.risks.length);
  });

  it('MUTATION TARGET: a risk with no anchor is REFUSED, not emitted', () => {
    const anchorless = {
      kind: 'gap',
      severity: 'high',
      statement: 'This sounds risky.',
      anchors: [],
      key: '',
      groundedClaimIds: [],
      requirementId: null,
      claimId: null,
      focus: RISK_KIND_FOCUS.gap,
    } as DerivedRisk;
    expect(() => assertRisksAreAnchored([anchorless])).toThrow(InterviewRiskError);
    try {
      assertRisksAreAnchored([anchorless]);
    } catch (error) {
      expect((error as InterviewRiskError).code).toBe('RISK_UNANCHORED_RISK');
      expect((error as InterviewRiskError).rejected).toHaveLength(1);
    }
  });

  it('MUTATION TARGET: an anchor with no source, no id or no detail is refused too', () => {
    const broken: DerivedRisk[] = [
      {
        kind: 'gap',
        severity: 'high',
        statement: 'x',
        // @ts-expect-error - deliberately malformed: a source outside the closed vocabulary.
        anchors: [{ source: 'vibes', id: 'v-1', detail: 'felt_risky' }],
        key: 'vibes:v-1',
        groundedClaimIds: [],
        requirementId: null,
        claimId: null,
        focus: RISK_KIND_FOCUS.gap,
      },
    ];
    expect(() => assertRisksAreAnchored(broken)).toThrow(InterviewRiskError);
  });

  it('every anchor names a row in one of the five anchor tables', () => {
    for (const risk of derive().risks) {
      for (const anchor of risk.anchors) {
        expect([risk.kind, RISK_ANCHOR_SOURCES.includes(anchor.source)]).toEqual([
          risk.kind,
          true,
        ]);
        expect(anchor.id.length).toBeGreaterThan(0);
        expect(anchor.detail.length).toBeGreaterThan(0);
      }
    }
  });

  it('every anchor id RESOLVES to a row the fixture actually holds', () => {
    const claimIds = new Set(CLAIMS.map((claim) => claim.id));
    const changeIds = new Set(CHANGES.map((change) => change.id));
    const requirementIds = new Set(REQUIREMENTS.map((requirement) => requirement.requirementId));
    for (const risk of derive().risks) {
      for (const anchor of risk.anchors) {
        const known =
          (anchor.source === 'resume_claim_usage' && claimIds.has(anchor.id)) ||
          (anchor.source === 'career_claim' && claimIds.has(anchor.id)) ||
          (anchor.source === 'resume_change' && changeIds.has(anchor.id)) ||
          ((anchor.source === 'match_gap' || anchor.source === 'requirement') &&
            requirementIds.has(anchor.id));
        expect([risk.kind, anchor.source, anchor.id, known]).toEqual([
          risk.kind,
          anchor.source,
          anchor.id,
          true,
        ]);
      }
    }
  });

  it('every groundedClaimId is a claim the fixture holds', () => {
    const claimIds = new Set(CLAIMS.map((claim) => claim.id));
    for (const risk of derive().risks) {
      for (const id of risk.groundedClaimIds) expect([risk.kind, claimIds.has(id)]).toEqual([risk.kind, true]);
    }
  });

  it('an unusable clock is refused rather than guessed at', () => {
    for (const now of [new Date('nope'), '2026-10-03', null, undefined]) {
      expect(() => derive({ now: now as never })).toThrow(InterviewRiskError);
    }
    try {
      derive({ now: new Date('nope') });
    } catch (error) {
      expect((error as InterviewRiskError).code).toBe('RISK_INVALID_CLOCK');
    }
  });
});

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe('the risk vocabulary is the schema, not a copy of it', () => {
  it('is exactly the seven kinds of 06 sec. E.4, in the schema order', () => {
    expect([...INTERVIEW_RISK_KINDS]).toEqual([
      'new_claim',
      'emphasized_tech',
      'inferred_claim',
      'rewritten_bullet',
      'gap',
      'overclaim',
      'thin_evidence',
    ]);
    expect([...INTERVIEW_RISK_KINDS].sort()).toEqual([...Object.values(InterviewRiskKind)].sort());
  });

  it('gives every kind a deterministic focus, because the no-provider path must still be useful', () => {
    for (const kind of INTERVIEW_RISK_KINDS) {
      expect([kind, RISK_KIND_FOCUS[kind].length > 20]).toEqual([kind, true]);
    }
    // And every derived risk carries the focus of its own kind.
    for (const risk of derive().risks) {
      expect([risk.kind, risk.focus]).toEqual([risk.kind, RISK_KIND_FOCUS[risk.kind]]);
    }
  });

  it('the counts map always has all seven keys', () => {
    const counts = derive({ requirements: [] }).counts;
    expect(Object.keys(counts).sort()).toEqual([...INTERVIEW_RISK_KINDS].sort());
    for (const kind of INTERVIEW_RISK_KINDS) {
      expect(Number.isInteger(counts[kind])).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The seven kinds, one fixture each
// ---------------------------------------------------------------------------

describe('inferred_claim - leakage, which E.4 says "should be impossible"', () => {
  it('ACCEPTANCE 3: a tailored usage whose before-state had no such fact IS flagged', () => {
    const result = derive();
    const leakage = only(result.risks, (risk) => risk.kind === 'inferred_claim');
    expect(leakage.length).toBeGreaterThan(0);

    // The one that names the tailored USAGE - the acceptance fixture.
    const fromUsage = leakage.find((risk) =>
      risk.anchors.some((anchor) => anchor.detail === 'rendered_text_fact_delta'),
    );
    expect(fromUsage).toBeDefined();
    expect(fromUsage?.severity).toBe('high');
    expect(fromUsage?.statement).toContain('900ms');
    expect(fromUsage?.statement).toContain('120ms');
    expect(fromUsage?.anchors.map((anchor) => `${anchor.source}:${anchor.id}`)).toContain(
      'resume_claim_usage:clm-lat',
    );
  });

  it('ACCEPTANCE 3: the same leak is ALSO caught on the change ledger, from a different row', () => {
    const fromChange = only(
      derive().risks,
      (risk) =>
        risk.kind === 'inferred_claim' &&
        risk.anchors.some((anchor) => anchor.detail === 'change_fact_delta'),
    );
    expect(fromChange).toHaveLength(1);
    expect(fromChange[0].anchors.map((anchor) => anchor.id)).toContain('chg-leak');
    expect(fromChange[0].statement).toContain('120ms');
  });

  it('fires on a tailored usage over a claim that is NOT confirmed', () => {
    const claims = CLAIMS.map((claim) =>
      claim.id === 'clm-lat' ? { ...claim, status: ClaimStatus.inferred } : claim,
    );
    const result = derive({ claims });
    const found = only(
      result.risks,
      (risk) =>
        risk.kind === 'inferred_claim' &&
        risk.anchors.some((anchor) => anchor.detail === 'tailored_on_unconfirmed_claim'),
    );
    expect(found).toHaveLength(1);
    expect(found[0].anchors.map((anchor) => anchor.id)).toContain('clm-lat');
  });

  it('does NOT fire for a tailored usage whose wording is already on the page', () => {
    // `clm-batch` is rendered verbatim, so the only usage on a claim that a tailoring pass
    // never touched. Nothing may call it a leak.
    const result = derive({ usages: [USAGES[1]], claims: [CLAIMS[1]], changes: [] });
    expect(kindsOf(result)).not.toContain('inferred_claim');
  });

  it('does NOT fire for a DECLINED change, which never reached the page', () => {
    const result = derive({
      changes: CHANGES.map((change) =>
        change.id === 'chg-leak' ? { ...change, accepted: false } : change,
      ),
    });
    expect(
      only(
        result.risks,
        (risk) =>
          risk.kind === 'inferred_claim' &&
          risk.anchors.some((anchor) => anchor.detail === 'change_fact_delta'),
      ),
    ).toHaveLength(0);
  });
});

describe('emphasized_tech - first screen, direct for >= 2 must-have requirements', () => {
  it('fires at the floor for two must-haves, at LOW severity', () => {
    const found = only(derive().risks, (risk) => risk.kind === 'emphasized_tech');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('low');
    expect(found[0].claimId).toBe('clm-k8s');
    expect(found[0].anchors[0]).toEqual({
      source: 'resume_claim_usage',
      id: 'clm-k8s',
      detail: 'first_screen_placement',
    });
    expect(found[0].anchors.filter((anchor) => anchor.detail === 'direct_must_requirement')).toHaveLength(2);
  });

  it('rises to MEDIUM at three must-haves', () => {
    const requirements = [
      ...REQUIREMENTS,
      {
        requirementId: 'req-helm',
        kind: 'required_skill',
        importance: 'must',
        text: 'Helm charts',
        level: 'direct' as const,
        evidence: [{ claimId: 'clm-k8s' }],
      },
    ];
    const found = only(derive({ requirements }).risks, (risk) => risk.kind === 'emphasized_tech');
    expect(found[0].severity).toBe('medium');
    expect(EMPHASIZED_TECH_MUST_HIGH).toBe(3);
  });

  it('does NOT fire below the floor', () => {
    const requirements = REQUIREMENTS.slice(1);
    expect(only(derive({ requirements }).risks, (risk) => risk.kind === 'emphasized_tech')).toHaveLength(0);
    expect(EMPHASIZED_TECH_MUST_MIN).toBe(2);
  });

  it('does NOT fire for a should-have requirement, because E.2 levels are importance-scoped', () => {
    const requirements = [
      { ...REQUIREMENTS[0], importance: 'should' },
      { ...REQUIREMENTS[1], importance: 'should' },
    ];
    expect(only(derive({ requirements }).risks, (risk) => risk.kind === 'emphasized_tech')).toHaveLength(0);
  });

  it('does NOT fire for a technology that is NOT on the first screen', () => {
    const document = {
      ...DOCUMENT,
      'x-clearance': {
        claims: DOCUMENT['x-clearance'].claims.map((entry) =>
          entry.claimId === 'clm-k8s' ? { ...entry, jsonPath: 'work[0].highlights[9]' } : entry,
        ),
      },
    };
    expect(only(derive({ document }).risks, (risk) => risk.kind === 'emphasized_tech')).toHaveLength(0);
  });

  it('does NOT fire without a match report, rather than inventing a "must"', () => {
    expect(only(derive({ requirements: [] }).risks, (risk) => risk.kind === 'emphasized_tech')).toHaveLength(0);
  });

  it('names the first screen as the summary and the top skills, in the ops.ts path spelling', () => {
    expect([...FIRST_SCREEN_TARGET_PATTERNS]).toEqual(['basics.summary', 'skills.*.name']);
    expect(firstScreenPattern('skills[2].name')).toBe('skills.*.name');
    expect(firstScreenPattern('basics.summary')).toBe('basics.summary');
    expect(firstScreenPattern('work[0].highlights[1]')).toBeNull();
    expect(firstScreenPattern('')).toBeNull();
  });
});

describe('gap - a named requirement with nothing behind it', () => {
  it('fires HIGH for a must-have and names it', () => {
    const found = only(derive().risks, (risk) => risk.kind === 'gap');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('high');
    expect(found[0].requirementId).toBe('req-years');
    expect(found[0].statement).toContain('7+ years of relevant experience');
    expect(found[0].anchors).toEqual([
      { source: 'match_gap', id: 'req-years', detail: 'unsupported_requirement' },
      { source: 'requirement', id: 'req-years', detail: 'requirement_importance' },
    ]);
  });

  it('fires MEDIUM for a should-have, so the column has two severities', () => {
    const requirements = REQUIREMENTS.map((requirement) =>
      requirement.requirementId === 'req-years' ? { ...requirement, importance: 'should' } : requirement,
    );
    expect(only(derive({ requirements }).risks, (risk) => risk.kind === 'gap')[0].severity).toBe('medium');
  });

  it('does NOT fire for a nice-to-have: nobody opens with the bonus', () => {
    const requirements = REQUIREMENTS.filter((requirement) => requirement.requirementId !== 'req-years');
    expect(only(derive({ requirements }).risks, (risk) => risk.kind === 'gap')).toHaveLength(0);
  });

  it('carries NO grounded claims, because a gap is the absence of evidence', () => {
    for (const risk of only(derive().risks, (risk) => risk.kind === 'gap')) {
      expect(risk.groundedClaimIds).toEqual([]);
      expect(risk.claimId).toBeNull();
    }
  });

  it('does NOT fire for a requirement that is `direct`', () => {
    const requirements = REQUIREMENTS.map((requirement) =>
      requirement.requirementId === 'req-years'
        ? { ...requirement, level: 'contextual' as const }
        : requirement,
    );
    expect(only(derive({ requirements }).risks, (risk) => risk.kind === 'gap')).toHaveLength(0);
  });
});

describe('rewritten_bullet - entity-preserving but materially different', () => {
  it('fires when every fact is kept and the wording is not', () => {
    const found = only(derive().risks, (risk) => risk.kind === 'rewritten_bullet');
    expect(found).toHaveLength(1);
    expect(found[0].anchors.map((anchor) => anchor.id)).toContain('chg-reword');
    expect(found[0].anchors.some((anchor) => anchor.detail === 'entity_preserving')).toBe(true);
    expect(found[0].anchors.some((anchor) => anchor.detail === 'material_rewording')).toBe(true);
  });

  it('does NOT fire for a change that introduced an entity - that is `inferred_claim`', () => {
    const changes = CHANGES.filter((change) => change.id === 'chg-leak');
    const kinds = kindsOf(derive({ changes }));
    expect(kinds).not.toContain('rewritten_bullet');
    expect(kinds).toContain('inferred_claim');
  });

  it('does NOT fire when the wording is essentially unchanged', () => {
    const changes = CHANGES.map((change) =>
      change.id === 'chg-reword' ? { ...change, after: change.before } : change,
    );
    expect(only(derive({ changes }).risks, (risk) => risk.kind === 'rewritten_bullet')).toHaveLength(0);
  });

  it('the thresholds are published, because the measure is a judgement call', () => {
    expect(REWRITTEN_BULLET_OVERLAP_MAX).toBeLessThan(1);
    expect(REWRITTEN_BULLET_OVERLAP_HIGH).toBeLessThan(REWRITTEN_BULLET_OVERLAP_MAX);
    expect(REWRITTEN_BULLET_OVERLAP_HIGH).toBeGreaterThan(0);
  });

  it('wordOverlap is symmetric, and 0 for texts with nothing in common', () => {
    expect(wordOverlap('ran the batch job', 'ran the batch job')).toBe(1);
    expect(wordOverlap('ran the batch job', 'architected a payment ledger')).toBe(0);
    const forward = wordOverlap('alpha beta gamma', 'alpha beta delta epsilon');
    const backward = wordOverlap('alpha beta delta epsilon', 'alpha beta gamma');
    expect(forward).toBeCloseTo(backward, 10);
  });
});

describe('overclaim - a metric that exceeds every metric it replaced', () => {
  const overclaimChange: RiskChangeRow = {
    id: 'chg-over',
    op: 'rewrite_bullet',
    jsonPath: 'work[0].highlights[1]',
    before: 'Cut the batch runtime to 400ms',
    after: 'Cut the batch runtime to 900ms',
    accepted: true,
    sourceClaimIds: ['clm-batch'],
  };

  it('fires HIGH and names the figure', () => {
    const found = only(derive({ changes: [overclaimChange] }).risks, (risk) => risk.kind === 'overclaim');
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('high');
    expect(found[0].statement).toContain('900');
    expect(found[0].anchors[0].detail).toBe('metric_exceeds_before');
  });

  it('does NOT fire when the figure went DOWN, which is the good direction', () => {
    const change: RiskChangeRow = { ...overclaimChange, after: 'Cut the batch runtime to 120ms' };
    expect(only(derive({ changes: [change] }).risks, (risk) => risk.kind === 'overclaim')).toHaveLength(0);
  });

  it('does NOT fire when `before` holds no metric: there is nothing to exceed', () => {
    const change: RiskChangeRow = {
      ...overclaimChange,
      before: 'Ran the nightly batch job for the finance team',
      after: 'Ran the nightly batch job for the finance team in 40k steps',
    };
    expect(only(derive({ changes: [change] }).risks, (risk) => risk.kind === 'overclaim')).toHaveLength(0);
  });

  it('tells the metric story ONCE even when the change also reworded the line', () => {
    const change: RiskChangeRow = {
      ...overclaimChange,
      after: 'Owned and cut the nightly batch runtime to 900ms across the finance estate',
    };
    const risks = derive({ changes: [change] }).risks;
    expect(only(risks, (risk) => risk.kind === 'overclaim')).toHaveLength(1);
    expect(only(risks, (risk) => risk.kind === 'rewritten_bullet')).toHaveLength(0);
  });
});

describe('new_claim - a statement the reader has not lived with', () => {
  const recentClaim: RiskClaimRow = {
    id: 'clm-recent',
    kind: ClaimKind.soft_skill,
    statement: 'Mentored three engineers through their first on-call rotation',
    status: ClaimStatus.user_confirmed,
    provenance: ClaimProvenance.document_import,
    evidenceSourceId: 'src-1',
    confirmedAt: daysAgo(5),
  };

  it('fires MEDIUM inside the confirmation window, and not outside it', () => {
    const usages = [...USAGES, { claimId: 'clm-recent', usage: 'verbatim' as const, renderedText: null }];
    const found = only(
      derive({ claims: [...CLAIMS, recentClaim], usages }).risks,
      (risk) => risk.kind === 'new_claim' && risk.claimId === 'clm-recent',
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('medium');
    expect(found[0].anchors.some((anchor) => anchor.detail === 'recently_confirmed')).toBe(true);

    const old = { ...recentClaim, confirmedAt: daysAgo(NEW_CLAIM_CONFIRMATION_WINDOW_DAYS + 1) };
    expect(
      only(
        derive({ claims: [...CLAIMS, old], usages }).risks,
        (risk) => risk.kind === 'new_claim' && risk.claimId === 'clm-recent',
      ),
    ).toHaveLength(0);
  });

  it('fires HIGH for a user_entered statement with no document behind it', () => {
    const claim: RiskClaimRow = {
      ...recentClaim,
      provenance: ClaimProvenance.user_entered,
      evidenceSourceId: null,
    };
    const usages = [...USAGES, { claimId: 'clm-recent', usage: 'verbatim' as const, renderedText: null }];
    const found = only(
      derive({ claims: [...CLAIMS, claim], usages }).risks,
      (risk) => risk.kind === 'new_claim' && risk.claimId === 'clm-recent',
    );
    expect(found[0].severity).toBe('high');
    expect(found[0].anchors.some((anchor) => anchor.detail === 'user_entered_without_evidence_source')).toBe(true);
  });

  it('reports ONE risk per claim at the WORST severity, not two events', () => {
    const claim: RiskClaimRow = { ...recentClaim, provenance: ClaimProvenance.user_entered, evidenceSourceId: null };
    const usages = [...USAGES, { claimId: 'clm-recent', usage: 'verbatim' as const, renderedText: null }];
    const found = only(
      derive({ claims: [...CLAIMS, claim], usages }).risks,
      (risk) => risk.kind === 'new_claim' && risk.claimId === 'clm-recent',
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('high');
    expect(found[0].anchors.length).toBeGreaterThan(1);
  });

  it('does NOT fire for a claim confirmed in the FUTURE: clock skew is not recency', () => {
    const claim: RiskClaimRow = { ...recentClaim, confirmedAt: daysAgo(-3) };
    const usages = [...USAGES, { claimId: 'clm-recent', usage: 'verbatim' as const, renderedText: null }];
    expect(
      only(
        derive({ claims: [...CLAIMS, claim], usages }).risks,
        (risk) => risk.kind === 'new_claim' && risk.claimId === 'clm-recent',
      ),
    ).toHaveLength(0);
  });

  it('does NOT fire for an OMITTED usage, which puts nothing on the page', () => {
    expect(kindsOf(derive({ usages: [USAGES[4]], claims: [CLAIMS[4]], changes: [] }))).not.toContain(
      'new_claim',
    );
  });
});

describe('thin_evidence - confirmed, uncorroborated, and nothing behind it', () => {
  it('fires LOW for a rendered confirmed claim with no source and no neighbour', () => {
    const claims = CLAIMS.map((claim) =>
      claim.id === 'clm-batch'
        ? { ...claim, evidenceSourceId: null, provenance: ClaimProvenance.user_entered }
        : claim,
    );
    const found = only(
      derive({ claims }).risks,
      (risk) => risk.kind === 'thin_evidence' && risk.claimId === 'clm-batch',
    );
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('low');
    expect(found[0].anchors.map((anchor) => anchor.detail)).toEqual(
      expect.arrayContaining(['no_evidence_source', 'no_corroborating_claim']),
    );
  });

  it('does NOT fire when the claim HAS an evidence source', () => {
    // Every rendered claim in the base fixture carries `src-1`, so the base run already
    // proves it; this pins that removing corroboration is what ENABLES the risk.
    expect(only(derive().risks, (risk) => risk.kind === 'thin_evidence')).toHaveLength(0);
    const claims = CLAIMS.map((claim) =>
      claim.id === 'clm-batch' ? { ...claim, evidenceSourceId: null, provenance: ClaimProvenance.user_entered } : claim,
    );
    expect(only(derive({ claims }).risks, (risk) => risk.kind === 'thin_evidence')).toHaveLength(1);
  });

  it('corroboration is SHARED GROUND, and only from CONFIRMED claims', () => {
    // An unconfirmed neighbour mentioning the same employer does not corroborate anything.
    const neighbour: RiskClaimRow = {
      id: 'clm-neighbour',
      kind: ClaimKind.responsibility,
      statement: 'Ran the nightly batch job at Globex',
      status: ClaimStatus.inferred,
      provenance: ClaimProvenance.llm_inferred,
      evidenceSourceId: null,
      confirmedAt: null,
    };
    const claims = [
      ...CLAIMS.map((claim) =>
        claim.id === 'clm-batch'
          ? {
              ...claim,
              statement: 'Ran the nightly batch job at Globex',
              evidenceSourceId: null,
            }
          : claim,
      ),
      neighbour,
    ];
    expect(only(derive({ claims }).risks, (risk) => risk.kind === 'thin_evidence')).toHaveLength(0);

    // The same claim, CONFIRMED, does corroborate it.
    const confirmed = { ...neighbour, status: ClaimStatus.user_confirmed };
    expect(
      only(derive({ claims: [...claims.slice(0, -1), confirmed] }).risks, (risk) => risk.kind === 'thin_evidence'),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ordering and determinism
// ---------------------------------------------------------------------------

describe('the output has a TOTAL order and is deterministic', () => {
  it('is sorted worst-first by severity, then kind, then anchor key', () => {
    const risks = derive().risks;
    const rank = (severity: string): number => (severity === 'high' ? 0 : severity === 'medium' ? 1 : 2);
    const sorted = [...risks].sort((a, b) => {
      const bySeverity = rank(a.severity) - rank(b.severity);
      if (bySeverity !== 0) return bySeverity;
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    expect(risks.map((risk) => `${risk.severity}|${risk.kind}|${risk.key}`)).toEqual(
      sorted.map((risk) => `${risk.severity}|${risk.kind}|${risk.key}`),
    );
  });

  it('produces byte-identical output for the same input', () => {
    expect(JSON.stringify(derive())).toBe(JSON.stringify(derive()));
  });

  it('reports what it was derived from, as counts of rows', () => {
    expect(derive().derivedFrom).toEqual({
      usages: USAGES.length,
      claims: CLAIMS.length,
      changes: CHANGES.length,
      requirements: REQUIREMENTS.length,
    });
  });

  it('an empty revision derives no risks rather than throwing', () => {
    const result = derive({ document: null, usages: [], claims: [], changes: [], requirements: [] });
    expect(result.risks).toEqual([]);
    for (const kind of INTERVIEW_RISK_KINDS) expect(result.counts[kind]).toBe(0);
  });

  it('a usage naming a claim that does not exist is ignored, not fatal', () => {
    const usages = [...USAGES, { claimId: 'clm-ghost', usage: 'verbatim' as const, renderedText: null }];
    expect(JSON.stringify(derive({ usages }).risks)).toBe(JSON.stringify(derive().risks));
    // The unreadable usage is still COUNTED as a row that was read, because it was.
    expect(derive({ usages }).derivedFrom.usages).toBe(USAGES.length + 1);
  });
});

describe('statements are bounded, so a risk stays a sentence', () => {
  it('truncates a statement that quotes a whole document', () => {
    // The statement of a `thin_evidence` risk IS the claim's statement, so a claim carrying a
    // pasted paragraph is how a risk statement would ever grow past the bound.
    const claims = [
      ...CLAIMS,
      {
        id: 'clm-long',
        kind: ClaimKind.responsibility,
        statement: `Owned the release process ${'end to end for every service '.repeat(40)}`,
        status: ClaimStatus.user_confirmed,
        provenance: ClaimProvenance.user_entered,
        evidenceSourceId: null,
        confirmedAt: daysAgo(400),
      } satisfies RiskClaimRow,
    ];
    const usages = [
      ...USAGES,
      { claimId: 'clm-long', usage: 'verbatim' as const, renderedText: null },
    ];
    const found = only(derive({ claims, usages }).risks, (risk) => risk.kind === 'thin_evidence');
    expect(found).toHaveLength(1);
    expect(found[0].statement.length).toBeLessThanOrEqual(400);
    expect(found[0].statement.endsWith('...')).toBe(true);
  });

  it('collapses whitespace so a stored statement is one line', () => {
    for (const risk of derive().risks) {
      expect(risk.statement).toBe(risk.statement.replace(/\s+/g, ' ').trim());
    }
  });
});