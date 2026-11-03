// =====================================================================================
// interview/questions.test.ts - THE ANCHOR RULE AND THE FAIL-CLOSED POST-CHECK (T1090).
//
// ACCEPTANCE ITEMS 2 AND 4 ARE PROVED HERE, AND ITEM 4 IS PROVED IN TWO HALVES BECAUSE
// ONE HALF IS NOT ENOUGH:
//
//   ITEM 4 - "no generic question is emitted without a risk/requirement anchor".
//     (a) `assertQuestionIsAnchored` REFUSES an anchorless draft, with a code.
//     (b) `buildQuestions` runs it, so the refusal is on the BUILD path and not only on a
//         function nobody calls. The `MUTATION TARGET` label is on (b), because removing the
//         call is what "emit a question with no anchor" looks like in a diff.
//
//   ITEM 2 - "a modelAnswer naming an ungrounded entity is rejected by the post-check".
//     (a) `checkGroundedAnswer` is ENTITY-LEVEL, not a keyword allowlist: the ungrounded-
//         entity fixture passes a PERMITTED technology in the same sentence, so a check that
//         only looked for "is any known term present" would pass it.
//     (b) `answerQuestions` REGENERATES ONCE and then stores the question with NO answer and
//         the refusal on the record. That is the fail-closed end, and it is the `MUTATION
//         TARGET` for "disable the post-check".
//
// THE NO-PROVIDER PATH IS ASSERTED IN EVERY STAGE, because it is the case this feature is
// designed around (ADR-041 D5): the questions still exist, they are still anchored, and the
// absence of an answer is stated in words rather than papered over.
// =====================================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ANSWER_DROP_REASONS,
  BRIEF_DROP_REASONS,
  InterviewQuestionError,
  MAX_ANSWER_ATTEMPTS,
  QUESTION_CATEGORIES,
  QUESTION_CATEGORY_FOR_KIND,
  QUESTION_REJECTION_REASONS,
  QUESTION_STEM_FOR_KIND,
  answerQuestions,
  assertQuestionIsAnchored,
  buildQuestions,
  checkGroundedAnswer,
  guardRiskBrief,
  notEvaluatedAnswerStage,
  prepareInterview,
  renderAnswerQuestionTable,
  renderGroundedEvidence,
  renderRiskBriefTable,
  setAnswerProposer,
  setRiskBriefProposer,
  type AnswerProposerInput,
  type GroundedClaimText,
  type GroundedRequirementText,
  type ProviderOutcome,
  type QuestionDraft,
} from './questions.js';
import {
  INTERVIEW_RISK_KINDS,
  InterviewRiskError,
  deriveInterviewRisks,
  type RiskClaimRow,
  type RiskChangeRow,
  type RiskRequirementRow,
  type RiskUsageRow,
} from './risks.js';
import { ClaimKind, ClaimProvenance, ClaimStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-03T12:00:00.000Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

const DOCUMENT = {
  basics: { summary: 'Platform engineer with Kubernetes in production.' },
  work: [{ name: 'Globex', highlights: ['Reduced request latency at Globex from 900ms to 120ms'] }],
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
        claimId: 'clm-k8s',
        jsonPath: 'skills[0].name',
        usage: 'verbatim',
        renderedText: 'Ran Kubernetes in production at Globex',
        status: 'user_confirmed',
      },
    ],
  },
};

const USAGES: RiskUsageRow[] = [
  { claimId: 'clm-lat', usage: 'tailored', renderedText: 'Reduced request latency at Globex from 900ms to 120ms' },
  { claimId: 'clm-k8s', usage: 'verbatim', renderedText: 'Ran Kubernetes in production at Globex' },
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
    id: 'clm-k8s',
    kind: ClaimKind.technology,
    statement: 'Ran Kubernetes in production at Globex',
    status: ClaimStatus.user_confirmed,
    provenance: ClaimProvenance.document_import,
    evidenceSourceId: 'src-1',
    confirmedAt: daysAgo(400),
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
    requirementId: 'req-k8s2',
    kind: 'required_skill',
    importance: 'must',
    text: 'Helm chart authoring',
    level: 'direct',
    evidence: [{ claimId: 'clm-k8s' }],
  },
  {
    requirementId: 'req-kafka',
    kind: 'required_skill',
    importance: 'must',
    text: 'Kafka streaming',
    level: 'unsupported',
    evidence: [],
  },
];

function deriveRisks() {
  return deriveInterviewRisks({
    document: DOCUMENT,
    usages: USAGES,
    claims: CLAIMS,
    changes: CHANGES,
    requirements: REQUIREMENTS,
    now: NOW,
  }).risks;
}

const CLAIMS_TEXT = new Map<string, GroundedClaimText>([
  [
    'clm-lat',
    { id: 'clm-lat', statement: 'Cut request latency for the checkout path', evidenceText: ['Reduced request latency at Globex from 900ms to 120ms'] },
  ],
  [
    'clm-k8s',
    { id: 'clm-k8s', statement: 'Ran Kubernetes in production at Globex', evidenceText: ['Cluster upgrades during the 2024 migration'] },
  ],
]);

const REQUIREMENTS_TEXT = new Map<string, GroundedRequirementText>([
  ['req-kafka', { requirementId: 'req-kafka', text: 'Kafka streaming' }],
  ['req-k8s', { requirementId: 'req-k8s', text: 'Kubernetes container orchestration' }],
]);

function buildFixture() {
  return buildQuestions(deriveRisks(), {
    claims: CLAIMS_TEXT,
    requirements: REQUIREMENTS_TEXT,
  });
}

// ---------------------------------------------------------------------------
// Acceptance 4(a): the anchor rule
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 4a: a question without an anchor is REFUSED', () => {
  const anchorless: QuestionDraft = {
    questionId: 'no-anchor#general',
    riskKey: null,
    kind: null,
    severity: null,
    category: 'general',
    question: 'Tell me about yourself.',
    requirementId: null,
    groundedClaimIds: [],
    focus: '',
    groundingSize: 0,
  };

  it('MUTATION TARGET: the anchorless draft is refused with a code', () => {
    expect(() => assertQuestionIsAnchored(anchorless)).toThrow(InterviewQuestionError);
    try {
      assertQuestionIsAnchored(anchorless);
    } catch (error) {
      expect((error as InterviewQuestionError).code).toBe('QUESTION_NO_ANCHOR');
      expect((error as InterviewQuestionError).reason).toBe('NO_ANCHOR');
    }
    expect(QUESTION_REJECTION_REASONS).toContain('NO_ANCHOR');
  });

  it('an EMPTY risk key counts as no anchor, not as an anchor named ""', () => {
    expect(() => assertQuestionIsAnchored({ ...anchorless, riskKey: '' })).toThrow(
      InterviewQuestionError,
    );
  });

  it('a REQUIREMENT anchor alone is enough: a gap question is properly anchored', () => {
    expect(
      assertQuestionIsAnchored({ ...anchorless, requirementId: 'req-kafka' }).riskKey,
    ).toBeNull();
  });

  it('a RISK anchor alone is enough', () => {
    expect(
      assertQuestionIsAnchored({ ...anchorless, riskKey: 'resume_change:chg-leak' }).riskKey,
    ).toBe('resume_change:chg-leak');
  });

  it('a category outside the four is refused too', () => {
    // @ts-expect-error - deliberately outside the closed set: the schema stores a bare String.
    expect(() => assertQuestionIsAnchored({ ...anchorless, requirementId: 'req-kafka', category: 'vibes' })).toThrow(
      InterviewQuestionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Acceptance 4(b): the BUILD path runs the anchor rule
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 4b (MUTATION TARGET): the builder runs the anchor rule', () => {
  it('MUTATION TARGET: a risk whose ANCHORS were stripped cannot become a question', () => {
    // A risk that escaped `anchoredRisk` - a hand-built one, or a future kind added with no
    // data source. `buildQuestions` re-checks and THROWS rather than emitting a question.
    const risks = deriveRisks();
    const stripped = risks.map((risk) => ({ ...risk, anchors: [] })) as never;
    expect(() =>
      buildQuestions(stripped, { claims: CLAIMS_TEXT, requirements: REQUIREMENTS_TEXT }),
    ).toThrow(InterviewRiskError);
  });

  it('MUTATION TARGET: a risk with anchors but NO KEY and NO requirement is refused by the anchor rule', () => {
    // The other shape of the same bug: the risk is well formed but has lost the identity that
    // makes a question anchored. Only the requirement anchor is left to fall back on, and the
    // gap risks are the only ones that have one - so stripping both is what has to fail.
    const risks = deriveRisks();
    const stripped = risks.map((risk) => ({ ...risk, key: '', requirementId: null })) as never;
    expect(() =>
      buildQuestions(stripped, { claims: CLAIMS_TEXT, requirements: REQUIREMENTS_TEXT }),
    ).toThrow(InterviewQuestionError);
  });

  it('every question the builder emits carries a risk key AND quotes the rows it came from', () => {
    for (const question of buildFixture()) {
      expect(question.riskKey).not.toBeNull();
      expect(question.requirementId !== null || question.riskKey !== null).toBe(true);
      // The stem is the deterministic prefix for the kind; the rest is the risk's statement,
      // which quotes the anchored rows verbatim.
      expect(QUESTION_STEM_FOR_KIND[question.kind ?? 'gap']).toBe(
        question.question.slice(0, QUESTION_STEM_FOR_KIND[question.kind ?? 'gap'].length),
      );
    }
  });

  it('a question that IS the requirement text is not possible: the kind chooses the stem', () => {
    // The regression this guards: a prompt asked to "write an interview question about
    // Kafka" produces "Tell me about Kafka" with no anchor. There is no such path here.
    for (const question of buildFixture()) {
      expect(QUESTION_CATEGORY_FOR_KIND[question.kind ?? 'gap']).toBe(question.category);
    }
  });

  it('one question per risk, no more and no fewer', () => {
    expect(buildFixture()).toHaveLength(deriveRisks().length);
  });
});

// ---------------------------------------------------------------------------
// The post-check
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 2a: the post-check is ENTITY-LEVEL, not a keyword allowlist', () => {
  const grounded = { claims: CLAIMS_TEXT, requirements: REQUIREMENTS_TEXT };

  it('ACCEPTANCE 2 (fixture): an answer naming an UNGROUNDED EMPLOYER is rejected', () => {
    // `Globex` and `Kubernetes` are BOTH in the evidence. `Initech` is not. A keyword allowlist
    // that only asked "does the answer contain a known term" would pass this sentence, and the
    // sentence deliberately contains two known terms to prove it.
    const verdict = checkGroundedAnswer({
      answer:
        'I ran Kubernetes at Globex for years, then joined Initech where I led the same platform team.',
      groundedClaimIds: ['clm-k8s'],
      ...grounded,
      requirementId: null,
    });
    expect(verdict.grounded).toBe(false);
    if (verdict.grounded) throw new Error('unreachable');
    expect(verdict.ungrounded).toContain('employer:Initech');
    expect(verdict.ungroundedNames).toContain('employer Initech');
  });

  it('rejects an answer naming an UNGROUNDED NUMBER, even with no employer in it', () => {
    const verdict = checkGroundedAnswer({
      answer: 'I cut latency to 12 milliseconds, which nobody has recorded.',
      groundedClaimIds: ['clm-lat'],
      ...grounded,
      requirementId: null,
    });
    expect(verdict.grounded).toBe(false);
    if (verdict.grounded) throw new Error('unreachable');
    expect(verdict.ungrounded).toContain('metric:12');
  });

  it('rejects an answer naming an UNGROUNDED YEAR', () => {
    const verdict = checkGroundedAnswer({
      answer: 'I have run Kubernetes since 2011.',
      groundedClaimIds: ['clm-k8s'],
      ...grounded,
      requirementId: null,
    });
    expect(verdict.grounded).toBe(false);
    if (verdict.grounded) throw new Error('unreachable');
    expect(verdict.ungrounded).toContain('date:2011');
  });

  it('rejects an answer naming an UNGROUNDED TECHNOLOGY', () => {
    const verdict = checkGroundedAnswer({
      answer: 'I run Kubernetes and Kafka together on the same cluster.',
      groundedClaimIds: ['clm-k8s'],
      ...grounded,
      requirementId: null,
    });
    expect(verdict.grounded).toBe(false);
    if (verdict.grounded) throw new Error('unreachable');
    expect(verdict.ungrounded).toContain('technology:kafka');
  });

  it('ACCEPTS an answer that says only what the evidence says', () => {
    const verdict = checkGroundedAnswer({
      answer: 'I ran Kubernetes in production at Globex, and I cut request latency for the checkout path.',
      groundedClaimIds: ['clm-k8s', 'clm-lat'],
      ...grounded,
      requirementId: null,
    });
    expect(verdict.grounded).toBe(true);
  });

  it('ACCEPTS a figure that the EVIDENCE SOURCE states, which is E.4 grounding', () => {
    // `clm-lat`'s evidence source text holds "from 900ms to 120ms", so a model answer may
    // quote those numbers even though the claim statement does not.
    const verdict = checkGroundedAnswer({
      answer: 'It went from 900ms to 120ms.',
      groundedClaimIds: ['clm-lat'],
      ...grounded,
      requirementId: null,
    });
    expect(verdict.grounded).toBe(true);
  });

  it('uses the REQUIREMENT text as grounding for a requirement-anchored question', () => {
    const verdict = checkGroundedAnswer({
      answer: 'This job asks for Kafka streaming, and I have not run Kafka in production.',
      groundedClaimIds: [],
      ...grounded,
      requirementId: 'req-kafka',
    });
    expect(verdict.grounded).toBe(true);
  });

  it('FAILS CLOSED in both empty directions', () => {
    // No grounding: nothing was checked, so nothing may be declared grounded.
    expect(
      checkGroundedAnswer({
        answer: 'I have done plenty.',
        groundedClaimIds: ['clm-missing'],
        claims: CLAIMS_TEXT,
        requirements: REQUIREMENTS_TEXT,
        requirementId: null,
      }).grounded,
    ).toBe(false);
    // No answer.
    expect(
      checkGroundedAnswer({
        answer: '   ',
        groundedClaimIds: ['clm-k8s'],
        ...grounded,
        requirementId: null,
      }).grounded,
    ).toBe(false);
    // A non-string answer is refused, not coerced.
    expect(
      checkGroundedAnswer({
        answer: { text: 'anything' },
        groundedClaimIds: ['clm-k8s'],
        ...grounded,
        requirementId: null,
      }).grounded,
    ).toBe(false);
  });

  it('it shares the TAILORING vocabulary, so the two guards cannot disagree', () => {
    const source = readFileSync(path.join(__dirname, 'questions.ts'), 'utf8');
    expect(source).toMatch(/from '\.\.\/tailor\/factDelta\.js'/);
    expect(source).toMatch(/detectFactDelta/);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 2b: fail-closed, regenerate once
// ---------------------------------------------------------------------------

// The answer that trips the check on EVERY attempt. It names two entities the evidence holds
// and one it does not, so a keyword-level check would wave it through.
const UNGROUNDED_ANSWER =
  'I ran Kubernetes at Globex for years, then joined Initech where I led the same platform team.';

// An answer that asserts no entity at all, so it is inside every grounding by construction. Used
// where the test is about the REGENERATION LOOP rather than about grounding.
const NEUTRAL_ANSWER = 'I did that work for several years and I would be glad to walk through the details.';

describe('ACCEPTANCE 2b (MUTATION TARGET): a refused answer regenerates ONCE, then nothing is stored', () => {
  const CONTEXT = { userId: 'user-1', claims: CLAIMS_TEXT, requirements: REQUIREMENTS_TEXT };

  beforeEach(() => {
    setRiskBriefProposer(null);
    setAnswerProposer(null);
  });

  it('MUTATION TARGET: the UNGROUNDED-ENTITY FIXTURE is rejected, retried, and stored WITHOUT an answer', async () => {
    const calls: AnswerProposerInput[] = [];
    setAnswerProposer(async (input) => {
      calls.push(input);
      return {
        status: 'applied' as const,
        reason: 'ok' as const,
        provider: 'openai',
        model: 'gpt-test',
        responses: {
          schemaVersion: 'interview_question_v1',
          answers: input.questions.map((question) => ({
            questionId: question.questionId,
            modelAnswer: UNGROUNDED_ANSWER,
          })),
        },
      };
    });

    const asked = buildFixture();
    const answered = await answerQuestions(asked, CONTEXT);

    // The provider was asked EXACTLY TWICE: attempt 1, then the one regeneration.
    expect(calls).toHaveLength(MAX_ANSWER_ATTEMPTS);
    expect(MAX_ANSWER_ATTEMPTS).toBe(2);
    // The retry was TOLD what to avoid, which is what "regenerate" means here.
    expect(calls[1].refusedEntities).toContain('employer Initech');
    expect(calls[0].refusedEntities).toEqual([]);

    for (const question of answered) {
      if (question.answerStage.reason === 'no_grounded_evidence') continue;
      // NOTHING is stored, for every asked question - no answer leaked through beside the
      // refused ones.
      expect([question.questionId, question.modelAnswer]).toEqual([question.questionId, null]);
      expect(question.answerStage.status).toBe('rejected');
      expect(question.answerStage.reason).toBe('ungrounded_entities_after_regeneration');
      expect(question.answerStage.attempts).toBe(MAX_ANSWER_ATTEMPTS);
      expect(question.answerStage.rejectedEntities).toContain('employer Initech');
    }
    expect(answered.filter((question) => question.answerStage.status === 'rejected').length).toBe(
      asked.filter((question) => question.answerStage.reason !== 'no_grounded_evidence').length,
    );
  });

  it('a clean second attempt STORES the answer: the regeneration is a real second chance', async () => {
    let attempt = 0;
    setAnswerProposer(async (input) => {
      attempt += 1;
      return {
        status: 'applied' as const,
        reason: 'ok' as const,
        provider: 'openai',
        model: 'gpt-test',
        responses: {
          answers: input.questions.map((question) => ({
            questionId: question.questionId,
            modelAnswer: attempt === 1 ? UNGROUNDED_ANSWER : NEUTRAL_ANSWER,
          })),
        },
      };
    });
    const asked = buildFixture();
    const answerable = asked.filter((question) => question.answerStage.reason !== 'no_grounded_evidence');
    const answered = await answerQuestions(asked, CONTEXT);
    expect(attempt).toBe(2);
    const answeredQuestions = answered.filter((question) => question.modelAnswer !== null);
    expect(answeredQuestions).toHaveLength(answerable.length);
    for (const question of answeredQuestions) expect(question.answerStage.attempts).toBe(2);
    // Nothing mentions Initech anywhere in what is stored.
    expect(JSON.stringify(answered)).not.toContain('Initech');
  });

  it('a question the proposer IGNORES gets the regeneration, then no answer - silence is not a finding', async () => {
    let attempt = 0;
    setAnswerProposer(async (input) => {
      attempt += 1;
      return {
        status: 'applied' as const,
        reason: 'ok' as const,
        provider: 'openai',
        model: 'gpt-test',
        responses: {
          answers:
            attempt === 1
              ? input.questions.slice(0, 1).map((question) => ({
                  questionId: question.questionId,
                  modelAnswer: 'I ran Kubernetes in production at Globex.',
                }))
              : [],
        },
      };
    });
    const answered = await answerQuestions(buildFixture(), CONTEXT);
    expect(attempt).toBe(2);
    expect(answered.every((question) => question.modelAnswer === null)).toBe(true);
    expect(answered.some((question) => question.answerStage.status === 'rejected')).toBe(true);
  });

  it('an answer for a question that was NOT asked is dropped, with a reason', async () => {
    const dropped: string[] = [];
    setAnswerProposer(async (input) => {
      return {
        status: 'applied' as const,
        reason: 'ok' as const,
        provider: 'openai',
        model: 'gpt-test',
        responses: {
          answers: [
            ...input.questions.map((question) => ({
              questionId: question.questionId,
              modelAnswer: 'I ran Kubernetes in production at Globex.',
            })),
            { questionId: 'made-up#general', modelAnswer: 'A different question entirely.' },
          ],
        },
      };
    });
    const answered = await answerQuestions(buildFixture(), CONTEXT);
    for (const question of answered) {
      for (const entry of question.answerStage.dropped) dropped.push(entry.reason);
    }
    expect(dropped).toContain('unknown_question');
    expect(ANSWER_DROP_REASONS).toContain('unknown_question');
  });

  it('a GAP question is never asked, because it has no grounding to answer from', async () => {
    const askedIds: string[] = [];
    setAnswerProposer(async (input) => {
      askedIds.push(...input.questions.map((question) => question.questionId));
      return {
        status: 'skipped' as const,
        reason: 'no_ai_provider_configured' as const,
        provider: null,
        model: null,
        responses: null,
      };
    });
    const asked0 = buildFixture();
    const gap = asked0.filter((question) => question.kind === 'gap');
    const answerable = asked0.filter((question) => question.answerStage.reason !== 'no_grounded_evidence');
    expect(gap.length).toBeGreaterThan(0);
    for (const question of gap) {
      expect(question.answerStage.reason).toBe('no_grounded_evidence');
      expect(question.groundedClaimIds).toEqual([]);
    }
    await answerQuestions(asked0, CONTEXT);
    // No gap question id ever reached the proposer, on ANY attempt.
    for (const question of gap) expect(askedIds).not.toContain(question.questionId);
    expect(new Set(askedIds).size).toBe(answerable.length);
  });
});

// ---------------------------------------------------------------------------
// The no-provider path (ADR-041 D5)
// ---------------------------------------------------------------------------

describe('ADR-041 D5: with no provider the questions still exist, and the gap is stated', () => {
  beforeEach(() => {
    setRiskBriefProposer(null);
    setAnswerProposer(null);
  });

  it('the deterministic path asks nothing and marks every answer not_evaluated', async () => {
    const prepared = await prepareInterview({
      userId: 'user-1',
      risks: deriveRisks(),
      claims: CLAIMS_TEXT,
      requirements: REQUIREMENTS_TEXT,
      runProvider: false,
    });
    expect(prepared.briefStage.reason).toBe('not_evaluated');
    expect(prepared.briefStage.provider).toBeNull();
    expect(prepared.questions.length).toBeGreaterThan(0);
    for (const question of prepared.questions) {
      expect(question.modelAnswer).toBeNull();
      expect(question.answerStage.reason).not.toBe('ok');
      expect(question.riskKey !== null || question.requirementId !== null).toBe(true);
    }
  });

  it('a proposer that reports no_ai_provider_configured leaves the questions, with the reason spelled out', async () => {
    setRiskBriefProposer(async () => ({
      status: 'skipped' as const,
      reason: 'no_ai_provider_configured' as const,
      provider: null,
      model: null,
      responses: null,
    }));
    setAnswerProposer(async () => ({
      status: 'skipped' as const,
      reason: 'no_ai_provider_configured' as const,
      provider: null,
      model: null,
      responses: null,
    }));

    const prepared = await prepareInterview({
      userId: 'user-1',
      risks: deriveRisks(),
      claims: CLAIMS_TEXT,
      requirements: REQUIREMENTS_TEXT,
    });
    expect(prepared.briefStage.reason).toBe('no_ai_provider_configured');
    expect(prepared.questions.length).toBe(deriveRisks().length);
    const answerable = prepared.questions.filter(
      (question) => question.answerStage.reason !== 'no_grounded_evidence',
    );
    expect(answerable.length).toBeGreaterThan(0);
    for (const question of answerable) {
      expect(question.modelAnswer).toBeNull();
      expect(question.answerStage.reason).toBe('no_ai_provider_configured');
      expect(question.answerStage.attempts).toBe(1);
    }
    // And nothing invented an answer anywhere, including for the gaps.
    expect(prepared.questions.every((question) => question.modelAnswer === null)).toBe(true);
  });

  it('a READ reports not_evaluated, because a read asked no provider anything', () => {
    expect(notEvaluatedAnswerStage().reason).toBe('not_evaluated');
    expect(notEvaluatedAnswerStage().status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// The brief stage: it may sharpen a risk, never create one
// ---------------------------------------------------------------------------

describe('the risk brief can sharpen a derived risk and CANNOT create one', () => {
  beforeEach(() => {
    setRiskBriefProposer(null);
    setAnswerProposer(null);
  });

  it('a riskKey the server did not derive is dropped', () => {
    const risks = deriveRisks();
    const guarded = guardRiskBrief(
      { focuses: [{ riskKey: 'a-risk-nobody-derived', focus: 'Be ready to talk about Initech.' }] },
      risks,
      CLAIMS_TEXT,
      REQUIREMENTS_TEXT,
    );
    expect(guarded.focusByRiskKey.size).toBe(0);
    expect(guarded.dropped).toEqual([{ reason: 'unknown_risk', detail: 'a-risk-nobody-derived' }]);
    expect(BRIEF_DROP_REASONS).toContain('unknown_risk');
  });

  it('a sharpening naming an ungrounded entity is dropped by the SAME post-check', () => {
    const risks = deriveRisks();
    const groundedKey = risks.find((risk) => risk.kind === 'emphasized_tech')?.key ?? risks[0].key;
    const leakKey = risks.find((risk) => risk.kind === 'inferred_claim')?.key ?? risks[1].key;
    const guarded = guardRiskBrief(
      {
        focuses: [
          { riskKey: groundedKey, focus: 'Be ready to talk about the Kubernetes work you did at Globex' },
          { riskKey: leakKey, focus: 'Be ready to talk about running this at Initech.' },
        ],
      },
      risks,
      CLAIMS_TEXT,
      REQUIREMENTS_TEXT,
    );
    expect([...guarded.focusByRiskKey.keys()]).toEqual([groundedKey]);
    expect(guarded.dropped).toEqual([{ reason: 'ungrounded_entity', detail: leakKey }]);
  });

  it('an empty or duplicate sharpening is dropped with its own reason', () => {
    const risks = deriveRisks();
    const key = risks[0].key;
    const guarded = guardRiskBrief(
      {
        focuses: [
          { riskKey: key, focus: '   ' },
          { riskKey: key, focus: 'A first, grounded sharpening about Globex.' },
          { riskKey: key, focus: 'A second one, which loses to the first.' },
        ],
      },
      risks,
      CLAIMS_TEXT,
      REQUIREMENTS_TEXT,
    );
    expect(guarded.focusByRiskKey.size).toBe(1);
    expect(guarded.dropped.map((entry) => entry.reason).sort()).toEqual(['duplicate', 'no_focus']);
  });

  it('a sharpening for a GAP risk is dropped: there is nothing to ground it in', () => {
    const risks = deriveRisks();
    const gap = risks.find((risk) => risk.kind === 'gap');
    expect(gap).toBeDefined();
    const guarded = guardRiskBrief(
      { focuses: [{ riskKey: gap?.key ?? '', focus: 'Say what you have done with Kafka at Globex.' }] },
      risks,
      CLAIMS_TEXT,
      REQUIREMENTS_TEXT,
    );
    expect(guarded.focusByRiskKey.has(gap?.key ?? '')).toBe(false);
  });

  it('a dropped sharpening leaves the DERIVED focus in place, so nothing is lost', async () => {
    setRiskBriefProposer(async () => ({
      status: 'applied' as const,
      reason: 'ok' as const,
      provider: 'openai',
      model: 'gpt-test',
      responses: { focuses: [{ riskKey: 'invented-risk', focus: 'Something new.' }] },
    }));
    const prepared = await prepareInterview({
      userId: 'user-1',
      risks: deriveRisks(),
      claims: CLAIMS_TEXT,
      requirements: REQUIREMENTS_TEXT,
    });
    expect(prepared.briefStage.appliedCount).toBe(0);
    expect(prepared.briefStage.dropped[0].reason).toBe('unknown_risk');
    for (const question of prepared.questions) expect(question.focus.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// The prompt renderers
// ---------------------------------------------------------------------------

describe('the prompt renderers send data minimization, not the profile', () => {
  it('the brief table is `key | kind | severity | statement`, worst first', () => {
    const table = renderRiskBriefTable(deriveRisks());
    for (const line of table.split('\n')) {
      const parts = line.split(' | ');
      expect(parts).toHaveLength(4);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[2]).toMatch(/^(high|medium|low)$/);
    }
    expect(table.split('\n')[0].split(' | ')[2]).toBe('high');
  });

  it('the grounded evidence list is `id | statement`, and `(none)` when empty', () => {
    expect(renderGroundedEvidence(['clm-k8s', 'clm-missing'], CLAIMS_TEXT)).toBe(
      'clm-k8s | Ran Kubernetes in production at Globex',
    );
    expect(renderGroundedEvidence([], CLAIMS_TEXT)).toBe('(none)');
  });

  it('the question table is `id | category | anchor | question`', () => {
    const questions = buildFixture().map((question) => ({
      questionId: question.questionId,
      question: question.question,
      category: question.category,
      anchor: question.riskKey ?? question.requirementId ?? '(none)',
    }));
    for (const line of renderAnswerQuestionTable(questions).split('\n')) {
      expect(line.split(' | ')).toHaveLength(4);
    }
  });
});

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

describe('the question vocabulary is closed', () => {
  it('is the four categories the schema documents', () => {
    expect([...QUESTION_CATEGORIES].sort()).toEqual([
      'behavioral',
      'general',
      'situational',
      'technical',
    ]);
  });

  it('gives every risk kind a category and a stem', () => {
    for (const kind of INTERVIEW_RISK_KINDS) {
      expect([kind, QUESTION_CATEGORIES.includes(QUESTION_CATEGORY_FOR_KIND[kind])]).toEqual([
        kind,
        true,
      ]);
      expect([kind, QUESTION_STEM_FOR_KIND[kind].length > 10]).toEqual([kind, true]);
    }
  });
});