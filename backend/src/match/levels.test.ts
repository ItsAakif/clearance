// =====================================================================================
// match/levels.test.ts - the four evidence levels, derived (T1070).
//
// WHAT THIS FILE PINS, AND WHY IT CANNOT BE CHECKED ANYWHERE ELSE. Every rule in E.2 is
// about the ORDER in which a requirement is judged, and order is invisible from the outside:
// a function that reported the same four numbers with the wrong precedence would pass any
// black-box check on the happy path. So these are white-box tests over literals - no store,
// no clock, no model - and each one names the rule it protects.
//
// The acceptance map:
//   1. the Kubernetes fixture yields a CONTEXTUAL PotentialMatch, never a direct match
//   2. Confirm promotes to confirmed via a ClaimVerification row; Reject yields a named gap
//      (the decision half lives in report.test.ts; here we pin the DERIVATION both halves
//      depend on)
//   3. the API response and the UI contain no derived single number (noScore.test.ts, here
//      and in routes/matches.test.ts)
//   4. no potential/contextual item counts as direct before confirmation
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { ClaimKind, ClaimStatus, EvidenceLevel } from '@prisma/client';
import {
  AMBIGUOUS_FORMS,
  EVIDENCE_LEVELS,
  PROPOSED_EVIDENCE_LEVELS,
  claimJoinKeys,
  countsAreWholeNumbers,
  countsForPersistence,
  deriveEvidenceLevels,
  isConfirmedClaim,
  isSpecificSurfaceForm,
  requirementJoinKey,
  type MatchClaimRow,
  type MatchPotentialRow,
  type MatchRequirementRow,
} from './levels.js';

function requirement(overrides: Partial<MatchRequirementRow> = {}): MatchRequirementRow {
  return {
    id: 'req-1',
    kind: 'required_skill',
    importance: 'must',
    text: 'Kubernetes',
    normalizedKey: 'kubernetes',
    ...overrides,
  };
}

function claim(overrides: Partial<MatchClaimRow> = {}): MatchClaimRow {
  return {
    id: 'clm-1',
    statement: 'Ran Kubernetes clusters in production',
    kind: ClaimKind.technology,
    status: ClaimStatus.user_confirmed,
    ...overrides,
  };
}

function potential(overrides: Partial<MatchPotentialRow> = {}): MatchPotentialRow {
  return {
    id: 'pm-1',
    requirementId: 'req-1',
    claimId: 'clm-1',
    level: EvidenceLevel.contextual,
    status: 'pending',
    proposedEvidence: 'Operated a containerised pipeline on ECS with Docker and Terraform',
    rationale: 'Adjacent container orchestration; same competency family',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

describe('the join key is the one the analysis derived', () => {
  it('a claim naming the requirement in a synonym spelling joins the canonical key', () => {
    // `k8s` -> `kubernetes` is the shipped synonym table's canonical head, read from the
    // table itself rather than a second opinion invented here.
    expect(claimJoinKeys('Ran K8s in production')).toContain('kubernetes');
    expect(claimJoinKeys('Ran Kubernetes clusters in production')).toContain('kubernetes');
  });

  it('a requirement key is the canonical form of its own text', () => {
    expect(requirementJoinKey('Kubernetes')).toBe('kubernetes');
    expect(requirementJoinKey('K8s')).toBe('kubernetes');
  });

  it('an empty statement joins nothing rather than joining everything', () => {
    expect(claimJoinKeys('')).toEqual([]);
    expect(claimJoinKeys('   ')).toEqual([]);
  });

  it('a word-boundary failure keeps a short key out of the index', () => {
    // `go` is a real requirement key. A claim that only CONTAINS those two letters
    // ("MongoDB") must not join it: that is the substring artefact T1060 documented, and
    // `findLiteralOccurrence` is what stops it.
    expect(claimJoinKeys('Migrated the MongoDB cluster')).not.toContain('go');
    expect(claimJoinKeys('Wrote Go services for payments')).toContain('go');
  });

  it('a claim statement with no recognizable key produces no bucket at all', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [claim({ statement: 'Led the quarterly planning offsite' })],
      potentialMatches: [],
    });
    // The join is on the REQUIREMENT's key against keys the claim's TEXT states, never a
    // guess about what the claim meant.
    expect(derived.requirements[0].level).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// The specificity gate: an ambiguous BARE word is not a technology
// ---------------------------------------------------------------------------

describe('the index refuses ambiguous surface forms, because an over-join inflates `direct`', () => {
  it('"the rest of the migration" is not direct evidence for a REST requirement', () => {
    // A JD bullet "REST" gives a requirement whose normalizedKey is `rest`. The role banks
    // list `rest` as a technology, so before the gate ANY confirmed claim containing the word
    // joined it - and the word boundary rule cannot help, because the whole word is the
    // ambiguity. The over-join is the direction that INFLATES `direct`, so the requirement
    // now falls to `unsupported`: a NAMED GAP the user can see and act on.
    const derived = deriveEvidenceLevels({
      requirements: [requirement({ id: 'req-rest', text: 'REST', normalizedKey: 'rest' })],
      claims: [claim({ statement: 'Owned the rest of the migration to the new billing stack' })],
      potentialMatches: [],
    });

    expect(claimJoinKeys('Owned the rest of the migration to the new billing stack')).not.toContain(
      'rest',
    );
    expect(derived.requirements[0].level).toBe('unsupported');
    expect(derived.requirements[0].evidence).toEqual([]);
    expect(derived.counts.direct).toBe(0);
    expect(derived.gaps).toEqual([
      {
        requirementId: 'req-rest',
        normalizedKey: 'rest',
        text: 'REST',
        kind: 'required_skill',
        importance: 'must',
      },
    ]);
  });

  it('"managed the brand" is not direct evidence for a brand requirement either', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement({ id: 'req-brand', text: 'Brand', normalizedKey: 'brand' })],
      claims: [claim({ statement: 'Managed the brand for three consumer products' })],
      potentialMatches: [],
    });

    expect(derived.requirements[0].level).toBe('unsupported');
    expect(derived.gaps.map((gap) => gap.normalizedKey)).toEqual(['brand']);
  });

  it('the technology still joins from the SAME sentence that contains the bare word', () => {
    // The other direction, and the reason the gate is drawn where it is: this one claim
    // names `api`, `postgresql` and `go` AND contains `rest`. Everything that NAMES a
    // technology must still be `direct` - `postgresql` is the join the live run proved - and
    // only the bare English word is refused. If a fix took `rest` out by banning the token
    // from the sentence, this test fails.
    const statement = 'Built a REST API gateway on PostgreSQL in Go';
    const derived = deriveEvidenceLevels({
      requirements: [
        requirement({ id: 'req-rest', text: 'REST', normalizedKey: 'rest' }),
        requirement({ id: 'req-api', text: 'API development', normalizedKey: 'api' }),
        requirement({ id: 'req-pg', text: 'PostgreSQL', normalizedKey: 'postgresql' }),
      ],
      claims: [claim({ statement })],
      potentialMatches: [],
    });

    const level = (id: string): string | undefined =>
      derived.requirements.find((row) => row.requirementId === id)?.level;
    expect(level('req-api')).toBe('direct');
    expect(level('req-pg')).toBe('direct');
    expect(level('req-rest')).toBe('unsupported');
    expect(claimJoinKeys(statement)).toEqual(expect.arrayContaining(['api', 'postgresql', 'go']));
    expect(claimJoinKeys(statement)).not.toContain('rest');
    expect(derived.counts.direct).toBe(2);
  });

  it('a claim that STATES the term still joins: the gate is on the index, not on the key', () => {
    // The escape hatch that makes the gate affordable, and the reason nothing legitimate is
    // lost. A statement whose whole normalized text IS the requirement's key joins with no
    // vocabulary at all, so a user who confirms the statement "REST" - or "R" - still makes
    // that requirement `direct`. Only the accidental match is gone.
    expect(claimJoinKeys('REST')).toContain('rest');
    expect(claimJoinKeys('R')).toContain('r');
    expect(claimJoinKeys('PostgreSQL')).toContain('postgresql');
  });

  it('the boundary itself: the ambiguous list is closed, and short technology names stay', () => {
    // The judgement, pinned so the next reader can disagree with it in the open.
    expect([...AMBIGUOUS_FORMS].sort()).toEqual(['brand', 'campaigns', 'reporting', 'rest']);
    expect(isSpecificSurfaceForm('rest')).toBe(false);
    expect(isSpecificSurfaceForm('brand')).toBe(false);
    expect(isSpecificSurfaceForm('campaigns')).toBe(false);
    expect(isSpecificSurfaceForm('reporting')).toBe(false);
    // A one-letter form is not a named thing: "worked in R&D" would join an `r` requirement.
    expect(isSpecificSurfaceForm('r')).toBe(false);
    // And nothing else is taken: the technology vocabulary the live run relied on is intact.
    for (const form of ['go', 'api', 'sql', 'aws', 'gcp', 'ml', 'nodejs', 'cicd', 'postgresql']) {
      expect(isSpecificSurfaceForm(form)).toBe(true);
    }
    // A MULTI-WORD phrase is never refused: it names a competency, not a word.
    expect(isSpecificSurfaceForm('data analysis')).toBe(true);
    expect(isSpecificSurfaceForm('system design')).toBe(true);
  });

  it('`go` keeps joining, which is why it is not on the ambiguous list', () => {
    // The deliberate trade, in the test that would break if someone added `go`: the join is
    // real (a Go requirement backed by "Wrote Go services"), whereas an over-join on `go`
    // needs an unusual sentence. Removing it would delete a legitimate join outright.
    expect(claimJoinKeys('Wrote Go services for payments')).toContain('go');
    expect(isSpecificSurfaceForm('go')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. The direct level
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 1: a confirmed claim joins on the key and that is the only direct door', () => {
  it('direct when a CONFIRMED claim states exactly the requirement', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [claim({ statement: 'Kubernetes' })],
      potentialMatches: [],
    });

    expect(derived.requirements[0].level).toBe('direct');
    expect(derived.counts).toEqual({
      direct: 1,
      contextual: 0,
      potential: 0,
      unsupported: 0,
      total: 1,
    });
    expect(derived.requirements[0].evidence).toEqual([
      {
        claimId: 'clm-1',
        statement: 'Kubernetes',
        kind: ClaimKind.technology,
        status: ClaimStatus.user_confirmed,
        via: 'normalized_key_join',
      },
    ]);
    expect(derived.gaps).toEqual([]);
  });

  it('the claim must be CONFIRMED: an inferred claim of the same words is not evidence', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [claim({ status: ClaimStatus.inferred })],
      potentialMatches: [],
    });
    expect(derived.requirements[0].level).toBe('unsupported');
    expect(derived.requirements[0].evidence).toEqual([]);
    expect(derived.gaps.map((gap) => gap.requirementId)).toEqual(['req-1']);
  });

  it('a REJECTED claim of the same words is not evidence either (ADR-036 item 5)', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [claim({ status: ClaimStatus.rejected })],
      potentialMatches: [],
    });
    expect(derived.requirements[0].level).toBe('unsupported');
  });

  it('two confirmed claims that both join are both named', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [claim({ id: 'clm-1' }), claim({ id: 'clm-2', statement: 'k8s since 2019' })],
      potentialMatches: [],
    });
    expect(derived.requirements[0].evidence.map((row) => row.claimId)).toEqual(['clm-1', 'clm-2']);
  });
});

// ---------------------------------------------------------------------------
// 2. The Kubernetes worked case (E.2)
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 1 (the E.2 worked case): ECS/Docker/Terraform never becomes Kubernetes', () => {
  // The profile: a containerised pipeline on ECS with Docker and Terraform. No Skill row for
  // Kubernetes, no claim naming it. The JD requires Kubernetes.
  const ecsClaim = claim({
    id: 'clm-ecs',
    statement: 'Designed and operated a containerised deployment pipeline on ECS with Docker and Terraform',
  });
  const k8sRequirement = requirement({
    id: 'req-k8s',
    text: 'Kubernetes container orchestration',
    normalizedKey: 'kubernetes container orchestration',
  });

  it('with no proposal at all the requirement is an UNSUPPORTED NAMED GAP', () => {
    const derived = deriveEvidenceLevels({
      requirements: [k8sRequirement],
      claims: [ecsClaim],
      potentialMatches: [],
    });
    expect(derived.requirements[0].level).toBe('unsupported');
    expect(derived.gaps).toEqual([
      {
        requirementId: 'req-k8s',
        normalizedKey: 'kubernetes container orchestration',
        text: 'Kubernetes container orchestration',
        kind: 'required_skill',
        importance: 'must',
      },
    ]);
  });

  it('a CONTEXTUAL proposal is reported as contextual, and NEVER as direct', () => {
    const derived = deriveEvidenceLevels({
      requirements: [k8sRequirement],
      claims: [ecsClaim],
      potentialMatches: [
        potential({
          id: 'pm-k8s',
          requirementId: 'req-k8s',
          claimId: 'clm-ecs',
          level: EvidenceLevel.contextual,
          proposedEvidence: ecsClaim.statement,
        }),
      ],
    });

    expect(derived.requirements[0].level).toBe('contextual');
    expect(derived.counts.direct).toBe(0);
    expect(derived.counts.contextual).toBe(1);
    // Not a gap either: it is an open question, not an absence.
    expect(derived.gaps).toEqual([]);
    // And nothing is presented as evidence for it, because nothing is.
    expect(derived.requirements[0].evidence).toEqual([]);
    expect(derived.requirements[0].action).toBe('confirm_or_reject');
  });

  it('a POTENTIAL proposal is reported as potential, and never as direct', () => {
    const derived = deriveEvidenceLevels({
      requirements: [k8sRequirement],
      claims: [ecsClaim],
      potentialMatches: [potential({ requirementId: 'req-k8s', level: EvidenceLevel.potential })],
    });
    expect(derived.requirements[0].level).toBe('potential');
    expect(derived.counts.direct).toBe(0);
    expect(derived.requirements[0].action).toBe('confirm_or_reject');
  });
});

// ---------------------------------------------------------------------------
// 4. The invariant: pending never counts as direct
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 4: no pending proposal counts as direct, whatever it claims', () => {
  it('a proposal row whose level says direct is still not direct while pending', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [],
      potentialMatches: [potential({ level: EvidenceLevel.direct })],
    });
    // A row a guard should have refused must not promote a requirement out of the gaps.
    expect(derived.requirements[0].level).toBe('unsupported');
    expect(derived.gaps).toHaveLength(1);
  });

  it('a proposal row whose level says unsupported is not honoured either', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [],
      potentialMatches: [potential({ level: EvidenceLevel.unsupported })],
    });
    expect(derived.requirements[0].level).toBe('unsupported');
  });

  it('a proposal pointing at NOTHING cannot make anything direct', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [],
      potentialMatches: [potential({ claimId: null })],
    });
    expect(derived.requirements[0].level).toBe('contextual');
    expect(derived.counts.direct).toBe(0);
  });

  it('CONFIRMING it is what makes it direct, and the confirmed claim is named', () => {
    // This is the state `report.ts#confirmPotentialMatch` produces: the proposal is
    // `confirmed` and points at the claim it created, which is itself confirmed.
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [
        claim({
          id: 'clm-new',
          statement: 'Kubernetes container orchestration',
          kind: ClaimKind.skill,
        }),
      ],
      potentialMatches: [
        potential({
          requirementId: 'req-1',
          claimId: 'clm-new',
          status: 'confirmed',
          proposedEvidence: 'Kubernetes container orchestration',
        }),
      ],
    });

    expect(derived.requirements[0].level).toBe('direct');
    expect(derived.counts.direct).toBe(1);
    expect(derived.counts.contextual).toBe(0);
    expect(derived.requirements[0].evidence).toEqual([
      {
        claimId: 'clm-new',
        statement: 'Kubernetes container orchestration',
        kind: ClaimKind.skill,
        status: ClaimStatus.user_confirmed,
        via: 'normalized_key_join',
      },
    ]);
    expect(derived.gaps).toEqual([]);
  });

  it('a CONFIRMED proposal whose claim does NOT join is still direct, and names the claim', () => {
    // The user said "I have this" in words of their own. That is the evidence, and it is
    // attributed - the report never says direct without naming the claim that carries it.
    const derived = deriveEvidenceLevels({
      requirements: [k8sRequirementOf()],
      claims: [claim({ id: 'clm-own', statement: 'Ran container platforms at scale for a fintech' })],
      potentialMatches: [
        potential({
          requirementId: 'req-k8s',
          claimId: 'clm-own',
          status: 'confirmed',
        }),
      ],
    });

    expect(derived.requirements[0].level).toBe('direct');
    expect(derived.requirements[0].evidence).toEqual([
      {
        claimId: 'clm-own',
        statement: 'Ran container platforms at scale for a fintech',
        kind: ClaimKind.technology,
        status: ClaimStatus.user_confirmed,
        via: 'confirmed_match',
      },
    ]);
  });

  it('a CONFIRMED proposal whose claim is not confirmed itself cannot be direct', () => {
    // Belt and braces: if the claim behind a confirmed proposal were somehow unconfirmed,
    // `direct` would be asserting something nobody verified.
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [claim({ status: ClaimStatus.inferred })],
      potentialMatches: [potential({ status: 'confirmed' })],
    });
    expect(derived.requirements[0].level).toBe('unsupported');
  });
});

function k8sRequirementOf(): MatchRequirementRow {
  return requirement({
    id: 'req-k8s',
    text: 'Kubernetes container orchestration',
    normalizedKey: 'kubernetes container orchestration',
  });
}

// ---------------------------------------------------------------------------
// The rejected case: a named gap, forever
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 2 (the derivation half): a REJECTED proposal lands in the gaps by name', () => {
  it('rejected is unsupported, and the gap carries the requirement text', () => {
    const derived = deriveEvidenceLevels({
      requirements: [k8sRequirementOf()],
      claims: [claim({ id: 'clm-ecs', statement: 'ECS with Docker and Terraform' })],
      potentialMatches: [
        potential({ requirementId: 'req-k8s', status: 'rejected', claimId: 'clm-ecs' }),
      ],
    });

    expect(derived.requirements[0].level).toBe('unsupported');
    expect(derived.requirements[0].action).toBe('none');
    expect(derived.gaps).toEqual([
      {
        requirementId: 'req-k8s',
        normalizedKey: 'kubernetes container orchestration',
        text: 'Kubernetes container orchestration',
        kind: 'required_skill',
        importance: 'must',
      },
    ]);
    // The proposal is still VISIBLE on the row: the rejection is on the record, not erased.
    expect(derived.requirements[0].potentialMatch).toMatchObject({ id: 'pm-1', status: 'rejected' });
  });
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('precedence: direct beats a pending proposal', () => {
  it('a confirmed claim wins over a pending proposal for the same requirement', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [claim()],
      potentialMatches: [potential({ level: EvidenceLevel.potential })],
    });
    expect(derived.requirements[0].level).toBe('direct');
    // The stale proposal is still reported, so the UI can show it was superseded.
    expect(derived.requirements[0].potentialMatch?.status).toBe('pending');
  });

  it('the NEWEST proposal for a requirement wins, so a re-run does not stack them', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement()],
      claims: [],
      potentialMatches: [
        potential({ id: 'pm-a', level: EvidenceLevel.contextual }),
        potential({ id: 'pm-b', level: EvidenceLevel.potential }),
      ],
    });
    expect(derived.requirements[0].level).toBe('potential');
    expect(derived.requirements[0].potentialMatch?.id).toBe('pm-b');
  });
});

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

describe('the counts are four integers and a total', () => {
  it('the buckets partition the requirements: they sum to the total, with no remainder', () => {
    const derived = deriveEvidenceLevels({
      requirements: [
        requirement({ id: 'r1', normalizedKey: 'kubernetes' }),
        requirement({ id: 'r2', normalizedKey: 'terraform' }),
        requirement({ id: 'r3', normalizedKey: 'go' }),
        requirement({ id: 'r4', normalizedKey: 'kafka' }),
      ],
      claims: [claim({ statement: 'Kubernetes' }), claim({ id: 'c2', statement: 'Terraform' })],
      potentialMatches: [potential({ id: 'p3', requirementId: 'r3' })],
    });

    const { counts } = derived;
    expect(counts.direct + counts.contextual + counts.potential + counts.unsupported).toBe(
      counts.total,
    );
    expect(counts).toMatchObject({ direct: 2, contextual: 1, potential: 0, unsupported: 1, total: 4 });
    expect(countsAreWholeNumbers(counts)).toBe(true);
  });

  it('an empty requirement set is all zeros, not a division by zero', () => {
    const derived = deriveEvidenceLevels({ requirements: [], claims: [], potentialMatches: [] });
    expect(derived.counts).toEqual({
      direct: 0,
      contextual: 0,
      potential: 0,
      unsupported: 0,
      total: 0,
    });
    expect(derived.requirements).toEqual([]);
    expect(derived.gaps).toEqual([]);
  });

  it('the persisted columns are the SAME numbers as the counts, not a rescaling', () => {
    const counts = { direct: 7, contextual: 3, potential: 2, unsupported: 4, total: 16 };
    const columns = countsForPersistence(counts);
    // E.6's worked example, verbatim. If anything here divided by 16, this fails.
    expect(columns).toEqual({
      directCount: 7,
      contextualCount: 3,
      potentialCount: 2,
      unsupportedCount: 4,
      totalRequirements: 16,
    });
  });

  it('a fractional count is reported as not-whole, which is how a weighting bug would show', () => {
    expect(
      countsAreWholeNumbers({ direct: 7.5, contextual: 3, potential: 2, unsupported: 4, total: 16 }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe('the four buckets are the schema vocabulary, spelled once', () => {
  it('exactly the four EvidenceLevel members, in report order', () => {
    expect([...EVIDENCE_LEVELS]).toEqual([
      EvidenceLevel.direct,
      EvidenceLevel.contextual,
      EvidenceLevel.potential,
      EvidenceLevel.unsupported,
    ]);
  });

  it('exactly two of them are PROPOSALS, and neither is direct', () => {
    expect([...PROPOSED_EVIDENCE_LEVELS]).toEqual(['contextual', 'potential']);
    expect(PROPOSED_EVIDENCE_LEVELS).not.toContain(EvidenceLevel.direct);
  });

  it('every level the derivation can emit is one of the four', () => {
    const derived = deriveEvidenceLevels({
      requirements: [requirement(), requirement({ id: 'r2', normalizedKey: 'kafka' })],
      claims: [claim()],
      potentialMatches: [],
    });
    for (const row of derived.requirements) {
      expect(EVIDENCE_LEVELS).toContain(row.level);
    }
  });
});

// ---------------------------------------------------------------------------
// The confirmed predicate
// ---------------------------------------------------------------------------

describe('isConfirmedClaim answers with the career layer, not with a local opinion', () => {
  it('confirms only the status the career layer says is renderable', () => {
    expect(isConfirmedClaim(claim({ status: ClaimStatus.user_confirmed }))).toBe(true);
    for (const status of [
      ClaimStatus.inferred,
      ClaimStatus.contextual,
      ClaimStatus.rejected,
      ClaimStatus.superseded,
    ]) {
      expect(isConfirmedClaim(claim({ status }))).toBe(false);
    }
  });

  it('a status this build has never heard of is not confirmed (fail closed)', () => {
    const forged = claim({ status: 'approved_by_a_boss' as ClaimStatus });
    expect(isConfirmedClaim(forged)).toBe(false);
  });
});