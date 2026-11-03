// =====================================================================================
// projects/gaps.test.ts - ACCEPTANCE ITEM 1: only TEACHABLE unsupported requirements are
// selected (06 sec. E.5's first box, "exclude years-of-experience, education, and
// domain-specific credentials"; the exclusion list derived in `projects/gaps.ts`).
//
// THE FOUR MUTATION TARGETS IN THIS FILE, so a reviewer can aim at them:
//   1. "MUTATION TARGET: a `years_experience` or `education` requirement is NEVER selected"
//   2. "MUTATION TARGET: a hard credential is excluded even when the kind says `required_skill`"
//   3. "MUTATION TARGET: the shape check is not skippable by relabelling the requirement kind"
//   4. "MUTATION TARGET: only TEACHABLE gaps reach a candidate"
// plus the source guard that this module cannot reach a provider, a clock, the network or a
// store - because the ruling for T1100 is that gap selection is deterministic offline.
// =====================================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { RequirementImportance, RequirementKind } from '@prisma/client';

import {
  GAP_SELECTION_REASONS,
  MAX_GAPS_PER_RUN,
  MAX_SKILL_TARGETS,
  NON_TEACHABLE_REQUIREMENT_KINDS,
  importanceRank,
  isKnownImportance,
  nonTeachableKindsPresentIn,
  selectTeachableGaps,
  skillTargetsFor,
  teachabilityOf,
  type ExcludedGap,
} from './gaps.js';
import type { MatchGap } from '../match/levels.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');

function gap(overrides: Partial<MatchGap> & { text: string }): MatchGap {
  return {
    requirementId: 'req-1',
    // The degenerate cases below pass a NON-STRING text on purpose, so the derived key has to
    // survive it - otherwise the fixture itself throws and the guard it is there to exercise
    // (`no_usable_text`) never runs.
    normalizedKey: typeof overrides.text === 'string' ? overrides.text.toLowerCase() : '',
    kind: RequirementKind.required_skill,
    importance: RequirementImportance.must,
    ...overrides,
  };
}

function texts(rows: readonly { text: string }[]): string[] {
  return rows.map((row) => row.text);
}

// ---------------------------------------------------------------------------
// The exclusion list, in the open
// ---------------------------------------------------------------------------

describe('the exclusion list is derived from the requirement and stated', () => {
  it('names a reason for EVERY kind it refuses, and says why in words', () => {
    // A reason without an explanation is a refusal the user cannot argue with, which is the
    // thing this list exists to avoid.
    for (const [kind, detail] of Object.entries(NON_TEACHABLE_REQUIREMENT_KINDS)) {
      expect([kind, detail.length > 40]).toEqual([kind, true]);
      // ASCII only: these strings are rendered by a client that does not promise a font.
      expect([kind, /^[\x20-\x7e]+$/.test(detail)]).toEqual([kind, true]);
    }
  });

  it('refuses years_experience, education and screening_criterion, and nothing else by kind', () => {
    for (const kind of [RequirementKind.years_experience, RequirementKind.education, RequirementKind.screening_criterion]) {
      expect([kind, nonTeachableKindsPresentIn(kind)]).toEqual([kind, true]);
    }
    for (const kind of [
      RequirementKind.required_skill,
      RequirementKind.preferred_skill,
      RequirementKind.technology,
      RequirementKind.domain,
      RequirementKind.soft_skill,
      RequirementKind.responsibility,
      RequirementKind.terminology,
    ]) {
      expect([kind, nonTeachableKindsPresentIn(kind)]).toEqual([kind, false]);
    }
  });

  it('every reason it can emit is in the closed vocabulary', () => {
    // An unknown reason would render as nothing in the UI, which is the failure mode E.11's
    // "named, never silently dropped" rule exists to prevent.
    const reasons = new Set<string>(GAP_SELECTION_REASONS);
    const verdicts = [
      teachabilityOf(gap({ text: '   ' })),
      teachabilityOf(gap({ text: 'Kubernetes', kind: RequirementKind.years_experience })),
      teachabilityOf(gap({ text: 'AWS certified architect' })),
      teachabilityOf(gap({ text: 'must be based in Berlin' })),
      teachabilityOf(gap({ text: 'a degree in computer science' })),
      teachabilityOf(gap({ text: 'Kubernetes' })),
    ];
    for (const verdict of verdicts) expect(reasons.has(verdict.reason)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE ITEM 1 - the exclusion cases
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 1 (MUTATION TARGET 1): a `years_experience` or `education` gap is NEVER selected', () => {
  const selection = selectTeachableGaps([
    gap({
      requirementId: 'req-years',
      text: '7+ years of distributed systems',
      normalizedKey: '7 years of distributed systems',
      kind: RequirementKind.years_experience,
      importance: RequirementImportance.must,
    }),
    gap({
      requirementId: 'req-degree',
      text: "Bachelor's degree in computer science",
      normalizedKey: 'bachelors degree in computer science',
      kind: RequirementKind.education,
      importance: RequirementImportance.must,
    }),
    gap({
      requirementId: 'req-screening',
      text: 'Are you authorised to work in the UK?',
      normalizedKey: 'authorised to work in the uk',
      kind: RequirementKind.screening_criterion,
      importance: RequirementImportance.must,
    }),
    gap({ requirementId: 'req-k8s', text: 'Kubernetes', normalizedKey: 'kubernetes' }),
  ]);

  it('selects only the Kubernetes gap', () => {
    expect(selection.selected.map((row) => row.requirementId)).toEqual(['req-k8s']);
    expect(texts(selection.selected)).toEqual(['Kubernetes']);
  });

  it('reports every refusal WITH its reason, never silently', () => {
    expect(selection.excluded).toHaveLength(3);
    expect(
      selection.excluded.map((row) => [row.requirementId, row.reason] as const).sort(),
    ).toEqual([
      ['req-degree', 'non_teachable_kind'],
      ['req-screening', 'non_teachable_kind'],
      ['req-years', 'non_teachable_kind'],
    ] as const);
    for (const row of selection.excluded) {
      expect([row.requirementId, row.detail.length > 40]).toEqual([row.requirementId, true]);
    }
  });

  it('the refusal names the KIND, so the user can see why their gap was skipped', () => {
    const years = selection.excluded.find((row) => row.requirementId === 'req-years');
    expect(years?.detail).toMatch(/years_experience/);
    expect(years?.detail).toMatch(/two days|two-day/);
  });

  it('teachabilityOf refuses each of them on its own, with no siblings involved', () => {
    // The importance rule lives in `selectTeachableGaps`, NOT in `teachabilityOf`: a per-gap
    // predicate that depended on its siblings would make "is this gap teachable?" depend on
    // the order the caller happened to pass.
    for (const kind of [RequirementKind.years_experience, RequirementKind.education, RequirementKind.screening_criterion]) {
      const verdict = teachabilityOf(gap({ text: 'something', kind }));
      expect([kind, verdict.teachable, verdict.reason]).toEqual([kind, false, 'non_teachable_kind']);
    }
    expect(teachabilityOf(gap({ text: 'Kubernetes' })).teachable).toBe(true);
  });
});

describe('ACCEPTANCE 1 (MUTATION TARGET 2): a hard credential is excluded however it was LABELLED', () => {
  const credentialShapes: ReadonlyArray<[string, string]> = [
    ['AWS Certified Solutions Architect', 'hard_credential'],
    ['Must hold a security clearance', 'hard_credential'],
    ['Practising license holder', 'hard_credential'],
    ['Registered to practise as a nurse', 'hard_credential'],
    ['Must be based in London', 'location_or_authorisation'],
    ['Applicants must have the right to work', 'location_or_authorisation'],
    ['Relocation to Berlin is expected', 'location_or_authorisation'],
    ['Master of Science in statistics', 'degree'],
    ['PhD in machine learning', 'degree'],
    ['MBA preferred', 'degree'],
  ];

  it('refuses every one of them, each as a `required_skill`', () => {
    for (const [text, reason] of credentialShapes) {
      const verdict = teachabilityOf(gap({ text, kind: RequirementKind.required_skill }));
      expect([text, verdict.teachable, verdict.reason]).toEqual([text, false, reason]);
    }
  });

  it('MUTATION TARGET: the shape check is NOT skippable by relabelling the kind', () => {
    // Every excluded credential, relabelled as `technology`, `preferred_skill`, `domain` and
    // `responsibility` - the four kinds a JD-extractor might plausibly assign. If the shape
    // rules were removed, every one of these would become a candidate.
    for (const [text] of credentialShapes) {
      for (const kind of [
        RequirementKind.technology,
        RequirementKind.preferred_skill,
        RequirementKind.domain,
        RequirementKind.responsibility,
      ]) {
        expect([text, kind, teachabilityOf(gap({ text, kind })).teachable]).toEqual([text, kind, false]);
      }
    }
  });

  it('MUTATION TARGET: only TEACHABLE gaps reach a candidate', () => {
    // THE END-TO-END STATEMENT OF ACCEPTANCE ITEM 1, over the whole excluded vocabulary: no
    // requirement whose `kind` E.5 names, and no requirement whose TEXT names a credential, a
    // place or a degree, appears in `selected` - whatever the importance is.
    const allKinds = Object.values(RequirementKind);
    const hard: MatchGap[] = [];
    for (const kind of allKinds) {
      for (const [text] of credentialShapes) {
        for (const importance of Object.values(RequirementImportance)) {
          hard.push(gap({ text, kind, importance, requirementId: `${kind}-${text}-${importance}` }));
        }
      }
    }
    hard.push(gap({ text: 'Kubernetes', kind: RequirementKind.technology }));
    const selection = selectTeachableGaps(hard);
    expect(selection.selected.map((row) => row.text)).toEqual(['Kubernetes']);
    // And every refusal carries a reason from the closed set.
    const reasons = new Set<string>(GAP_SELECTION_REASONS);
    expect(selection.excluded.every((row: ExcludedGap) => reasons.has(row.reason))).toBe(true);
  });

  it('does NOT refuse an ordinary technology because its name contains a short banned word', () => {
    // The substring trap. `C#` is not a credential, `Java` is not a degree, and `Reloaded` is
    // not a right to work - the patterns are anchored on whole words for exactly this reason.
    for (const text of ['C#', 'Java', 'JavaScript', 'Rust', 'Reloaded', 'Basis', 'Node.js']) {
      const verdict = teachabilityOf(gap({ text, kind: RequirementKind.technology }));
      expect([text, verdict.teachable]).toEqual([text, true]);
    }
  });
});

// ---------------------------------------------------------------------------
// Ordering, importance and the skill targets
// ---------------------------------------------------------------------------

describe('the selection ORDER is importance, then text, and it is not a weight', () => {
  it('orders must before should, and is stable', () => {
    // The optional gap is REFUSED here, which is the rule the next test pins: two days is the
    // whole budget and something more important is open. The order assertion therefore uses two
    // surviving tiers, and the third test proves an optional gap still sorts last when it is the
    // only thing on offer.
    const selection = selectTeachableGaps([
      gap({ requirementId: 'r-nice', text: 'Terraform', importance: RequirementImportance.nice }),
      gap({ requirementId: 'r-must', text: 'Kubernetes', importance: RequirementImportance.must }),
      gap({ requirementId: 'r-should', text: 'Kafka', importance: RequirementImportance.should }),
    ]);
    expect(selection.selected.map((row) => row.text)).toEqual(['Kubernetes', 'Kafka']);
    // Same input, same output: run it again and compare.
    const again = selectTeachableGaps([
      gap({ requirementId: 'r-nice', text: 'Terraform', importance: RequirementImportance.nice }),
      gap({ requirementId: 'r-must', text: 'Kubernetes', importance: RequirementImportance.must }),
      gap({ requirementId: 'r-should', text: 'Kafka', importance: RequirementImportance.should }),
    ]);
    expect(again.selected.map((row) => row.text)).toEqual(selection.selected.map((row) => row.text));
  });

  it('sorts an optional gap LAST when nothing more important is open, so the order is still total', () => {
    const onlyOptional = selectTeachableGaps([
      gap({ requirementId: 'r-nice', text: 'Terraform', importance: RequirementImportance.nice }),
      gap({ requirementId: 'r-nice2', text: 'Argo', importance: RequirementImportance.nice }),
    ]);
    expect(onlyOptional.selected.map((row) => row.text)).toEqual(['Argo', 'Terraform']);
  });

  it('drops a `nice` gap when something more important is open, and KEEPS it when none is', () => {
    const withStronger = selectTeachableGaps([
      gap({ requirementId: 'r-must', text: 'Kubernetes', importance: RequirementImportance.must }),
      gap({ requirementId: 'r-nice', text: 'Terraform', importance: RequirementImportance.nice }),
    ]);
    expect(texts(withStronger.selected)).toEqual(['Kubernetes']);
    expect(
      withStronger.excluded.find((row) => row.requirementId === 'r-nice')?.reason,
    ).toBe('optional_when_something_better_exists');

    const onlyNice = selectTeachableGaps([
      gap({ requirementId: 'r-nice', text: 'Terraform', importance: RequirementImportance.nice }),
    ]);
    expect(texts(onlyNice.selected)).toEqual(['Terraform']);
    expect(onlyNice.excluded).toHaveLength(0);
  });

  it('ranks an unknown importance LAST and never first', () => {
    expect(importanceRank('must')).toBeLessThan(importanceRank('should'));
    expect(importanceRank('nice')).toBe(2);
    // A JD writes "optional"; the schema writes "nice". Same tier.
    expect(importanceRank('optional')).toBe(importanceRank('nice'));
    // Anything the schema does not have sorts after every real tier rather than defaulting to
    // `must` - defaulting to the top would let a malformed row outrank a real must-have.
    expect(importanceRank('whatever')).toBeGreaterThan(importanceRank('nice'));
    expect(importanceRank(undefined)).toBeGreaterThan(importanceRank('nice'));
  });

  it('knows the three importance values the schema declares, and nothing else', () => {
    expect(isKnownImportance('must')).toBe(true);
    expect(isKnownImportance('should')).toBe(true);
    expect(isKnownImportance('nice')).toBe(true);
    expect(isKnownImportance('optional')).toBe(false);
    expect(isKnownImportance(7)).toBe(false);
  });

  it('caps the list, and the cap is a BOUND rather than a quality judgement', () => {
    const many = Array.from({ length: MAX_GAPS_PER_RUN + 5 }, (_, index) =>
      gap({
        requirementId: `req-${index}`,
        text: `technology-${index}`,
        importance: RequirementImportance.must,
      }),
    );
    const selection = selectTeachableGaps(many);
    expect(selection.selected).toHaveLength(MAX_GAPS_PER_RUN);
    // An explicit, SMALLER limit is honoured, which is what the route's own budget uses.
    expect(selectTeachableGaps(many, { limit: 2 }).selected).toHaveLength(2);
  });
});

describe('the skill targets come from the matcher vocabulary, not a second extractor', () => {
  it('leads with the gap key and then adds the technologies the text names', () => {
    const targets = skillTargetsFor(
      gap({
        text: 'Kafka and Flink pipelines',
        normalizedKey: 'stream processing',
        kind: RequirementKind.technology,
      }),
    );
    expect(targets[0]).toBe('stream processing');
    expect(targets.length).toBeGreaterThan(1);
    // `technologiesIn` is `tailor/factDelta.ts`'s - the SAME table the tailoring guard and the
    // interview grounding check read.
    expect(targets).toContain('kafka');
  });

  it('de-duplicates case-insensitively and caps the list', () => {
    const targets = skillTargetsFor(
      gap({ text: 'Kubernetes kubernetes KUBERNETES Postgres Redis Kafka', normalizedKey: 'Kubernetes' }),
    );
    const lowered = targets.map((value) => value.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
    expect(targets).toHaveLength(Math.min(MAX_SKILL_TARGETS, targets.length));
    expect(targets.length).toBeLessThanOrEqual(MAX_SKILL_TARGETS);
  });

  it('falls back to the requirement text when nothing else names a technology', () => {
    // Never empty: a gap with no targets cannot be turned into a candidate at all, and an
    // empty list would look like "we found nothing" rather than "the wording is unusual".
    const targets = skillTargetsFor(gap({ text: 'experience with distributed tracing', normalizedKey: '' }));
    expect(targets).toEqual(['experience with distributed tracing']);
  });
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

describe('degenerate gaps are refused rather than crashing the run', () => {
  it('a blank or whitespace text is `no_usable_text`', () => {
    for (const text of ['', '   ', '\n\t']) {
      const verdict = teachabilityOf(gap({ text }));
      expect([JSON.stringify(text), verdict.teachable, verdict.reason]).toEqual([
        JSON.stringify(text),
        false,
        'no_usable_text',
      ]);
    }
  });

  it('a non-string text is refused, not read as a key', () => {
    const verdict = teachabilityOf(gap({ text: undefined as unknown as string }));
    expect(verdict.teachable).toBe(false);
    expect(verdict.reason).toBe('no_usable_text');
  });

  it('an empty gap list yields two empty lists, not an error', () => {
    expect(selectTeachableGaps([])).toEqual({ selected: [], excluded: [] });
    // And a null-ish input, which is what a route body can produce.
    expect(selectTeachableGaps(undefined as unknown as MatchGap[]).selected).toEqual([]);
  });

  it('collapses whitespace in the stored text and the normalized key', () => {
    const selection = selectTeachableGaps([
      gap({ text: '  Kubernetes \n  orchestration  ', normalizedKey: '  kubernetes orchestration ' }),
    ]);
    expect(selection.selected[0].text).toBe('Kubernetes orchestration');
    expect(selection.selected[0].normalizedKey).toBe('kubernetes orchestration');
  });
});

// ---------------------------------------------------------------------------
// The source guard: this stage is deterministic and OFFLINE
// ---------------------------------------------------------------------------

describe('gap selection cannot reach a provider, a clock, the network or a store', () => {
  const SOURCE = readFileSync(path.join(__dirname, 'gaps.ts'), 'utf8');

  /** Comments stripped first: the header NAMES these tokens in order to explain it calls none. */
  const code = SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

  it('names no provider, network, clock, randomness or store', () => {
    for (const banned of [
      'runLlmCompletion',
      'leaseNextLlmKey',
      'createLlmClient',
      'getProviderModel',
      'loadAndRender',
      'keyManager',
      'providerModels',
      'Date.now',
      'new Date',
      'fetch',
      'Math.random',
      'lib/prisma',
      'PrismaClient',
      '$transaction',
      '.create(',
      '.update(',
      '.upsert(',
    ]) {
      expect([banned, code.includes(banned)]).toEqual([banned, false]);
    }
  });

  it('reads NOW only from its arguments, so "within 18 months" elsewhere is testable', () => {
    // This module takes no clock at all: gap selection has no time-dependent rule. The
    // activity window lives in `references.ts`, which takes `now` as a parameter.
    expect(code).not.toMatch(/\bnow\b\s*[:=]/);
  });
});