// =====================================================================================
// career/interview.test.ts - THE CAREER INTERVIEW STAGE (T1021).
//
// WHAT THIS FILE PINS, and why each one is a test rather than a sentence in a docstring:
//
//   (1) NO PROVIDER IS AN HONEST REFUSAL. `leaseInterviewProvider` throws
//       `interview_provider_required`, the shipped extractor reports
//       `skipped / no_ai_provider_configured`, and `recordInterviewClaims` REFUSES rather
//       than writing anything. There is no deterministic stand-in extractor: the mutation
//       for "silently degrade into a fake questionnaire" is not a line to delete but the
//       ABSENCE of a fallback, which the zero-writes assertion below pins.
//
//   (2) A SCHEMA-INVALID RESPONSE IS A HARD FAILURE. Two of them - unparseable output, and
//       a JSON document whose shape is not `{claims:[{kind,statement,confidence}]}` - and
//       both write ZERO claims with `interview_schema_invalid`. Nothing is salvaged.
//
//   (3) THE DETERMINISTIC VALIDATION RUNS ON EVERY CLAIM, FAIL-CLOSED PER CLAIM. `kind`
//       enum, statement length, confidence range, and the no-invention check (an employer,
//       year, number or technology the answers do not contain). Each refusal names itself,
//       and the survivors of a mixed batch are still written - which is the property a
//       per-claim guard has and an all-or-nothing filter does not.
//
//   (4) EVERY PRODUCED CLAIM IS `inferred` + `llm_inferred`, WRITTEN THROUGH THE ONE AI
//       WRITER, WITH NO AUDIT ROW AND NO RESUME. Asserted on the fake's write log and on
//       the rows themselves, so "the interview wrote a confirmed claim" is not a matter of
//       trusting this module's docstrings.
//
//   (5) SOURCE GUARDS. The stage names no confirming status, imports neither the status
//       writer nor the prisma singleton, and mentions no `Resume` model at all.
//
// The house rules: `FakeCareerStore` from `careerStore.fixtures.ts` and nothing else - no
// database, no network, no new dependency. The key manager is MOCKED (unlike
// `match/potential.test.ts`, which lets the real one run against a keyless store) because
// the no-provider property here is the headline acceptance item and it must not depend on
// whether the machine running the suite has a key configured. ASCII only.
// =====================================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ClaimKind, ClaimProvenance, ClaimStatus } from '@prisma/client';

const keyMocks = vi.hoisted(() => ({ leaseNextLlmKey: vi.fn(), markKeySuccess: vi.fn(), markKeyFailure: vi.fn() }));

vi.mock('../ai/keyManager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/keyManager.js')>()),
  leaseNextLlmKey: keyMocks.leaseNextLlmKey,
  markKeySuccess: keyMocks.markKeySuccess,
  markKeyFailure: keyMocks.markKeyFailure,
}));

import {
  CAREER_INTERVIEW_INFERENCE_METHOD,
  CAREER_INTERVIEW_PROVENANCE,
  CAREER_INTERVIEW_STEPS,
  CAREER_INTERVIEW_STATUS,
  CAREER_INTERVIEW_TOTAL_STEPS,
  CareerInterviewError,
  MAX_INTERVIEW_ANSWERS,
  MAX_STATEMENT_CHARS,
  createInterviewSessionId,
  guardExtractedClaims,
  isInterviewSessionId,
  leaseInterviewProvider,
  normalizeInterviewAnswers,
  recordInterviewClaims,
  renderAnswerBlock,
  answerGrounding,
  setCareerInterviewExtractor,
  shippedCareerInterviewExtractor,
  writeInterviewClaims,
  type CareerInterviewExtractor,
  type ClaimExtractOutcome,
  type InterviewAnswer,
} from './interview.js';
import { FakeCareerStore } from './careerStore.fixtures.js';

const HERE = __dirname;
const SOURCE = readFileSync(path.join(HERE, 'interview.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const PROFILE = 'profile-1';
const USER = 'user-1';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A complete, plausible set of answers. The grounding every guard test is measured against. */
function answerBody(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'roles.roles': 'Senior Engineer at Acme from 2021, Engineer at Globex from 2018',
    'roles.employers': 'Acme\nGlobex',
    'tools.technologies': 'TypeScript, Postgres, Kubernetes',
    'tools.skills': 'running an on-call rotation',
    'work.achievements': 'Cut the CI build time by 40% by caching the dependency layer',
    'work.responsibilities': 'Owned the ledger reconciliation service end to end',
    'working.working_style': 'I prefer small PRs and I wrote the runbooks',
    ...overrides,
  };
}

/** The answers as the POST body shape the route accepts. */
function body(overrides: Record<string, string> = {}): unknown {
  return {
    answers: Object.entries(answerBody(overrides)).map(([key, value]) => {
      const [stepId, fieldId] = key.split('.');
      return { stepId, fieldId, value };
    }),
  };
}

function answersFrom(overrides: Record<string, string> = {}): InterviewAnswer[] {
  return normalizeInterviewAnswers(body(overrides));
}

/** An extractor that answers with a fixed response - the shipped seam, driven deterministically. */
function extractorReturning(response: unknown): CareerInterviewExtractor {
  return vi.fn(async () => ({
    status: 'applied' as const,
    reason: 'ok' as const,
    provider: 'test-provider',
    model: 'test-model',
    response: response as ClaimExtractOutcome['response'],
  }));
}

/** The claim a legitimate model returns from the fixture answers. */
function groundedClaim(overrides: Record<string, unknown> = {}) {
  return {
    kind: ClaimKind.achievement,
    statement: 'Cut the CI build time by 40% by caching the dependency layer',
    confidence: 0.8,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setCareerInterviewExtractor(null);
  // The default for every test in this file unless it says otherwise: NO provider.
  keyMocks.leaseNextLlmKey.mockRejectedValue(new Error('No LLM API keys configured.'));
});

afterEach(() => setCareerInterviewExtractor(null));

// ---------------------------------------------------------------------------
// The questionnaire
// ---------------------------------------------------------------------------

describe('the questionnaire is the server\'s, and it is a fixed five steps', () => {
  it('is five steps, every field addressed uniquely, and every step reachable by id', () => {
    expect(CAREER_INTERVIEW_TOTAL_STEPS).toBe(5);
    expect(CAREER_INTERVIEW_STEPS).toHaveLength(5);
    const seen = new Set<string>();
    for (const step of CAREER_INTERVIEW_STEPS) {
      expect(step.fields.length, step.id).toBeGreaterThan(0);
      for (const field of step.fields) {
        const key = `${step.id}.${field.id}`;
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
        // A label and a hint are what make the screen usable; a field with neither would be
        // an input a user cannot answer.
        expect(field.label.length, key).toBeGreaterThan(0);
        expect(field.hint.length, key).toBeGreaterThan(0);
      }
    }
    // Every step asks at least one question, and at least one of them is REQUIRED, so the
    // stage is never extracting from a questionnaire the user answered with nothing.
    const required = CAREER_INTERVIEW_STEPS.flatMap((step) => step.fields).filter((field) => field.required);
    expect(required.length).toBeGreaterThan(0);
    // ...and the OPTIONAL steps are optional on purpose: not everyone has a project to
    // name, and a step nobody can answer is a step the questionnaire makes up.
    for (const step of CAREER_INTERVIEW_STEPS) {
      expect(step.fields.length, step.id).toBeGreaterThan(0);
    }
  });

  it('accepts a submission that leaves an entire optional step blank', () => {
    // The `background` step is all-optional on purpose, so a submission without it must be
    // valid rather than an error - the model is simply asked to work with less.
    const answers = normalizeInterviewAnswers({
      answers: [
        { stepId: 'roles', fieldId: 'roles', value: 'Senior Engineer at Acme' },
        { stepId: 'tools', fieldId: 'technologies', value: 'TypeScript' },
        { stepId: 'work', fieldId: 'achievements', value: 'Cut the CI build time by 40%' },
        { stepId: 'working', fieldId: 'working_style', value: 'Small PRs' },
      ],
    });
    expect(answers).toHaveLength(4);
  });

  it('renders the answers for the model with their labels, and grounds the guard WITHOUT them', () => {
    const answers = answersFrom();
    const block = renderAnswerBlock(answers);
    expect(block).toContain('roles.roles | Roles');
    expect(block).toContain('Cut the CI build time by 40%');
    // The GUOUNDING is the user's own words. If it carried the hints, the "e.g. Senior
    // Engineer at Acme" and "e.g. TypeScript, Postgres, Kubernetes" examples would license
    // an employer and a technology the user never typed - which is the whole check.
    const grounding = answerGrounding(answers).join('\n');
    expect(grounding).not.toContain('|');
    expect(grounding).not.toContain('e.g.');
    expect(grounding).toContain('Acme');
  });
});

// ---------------------------------------------------------------------------
// The answers: validation, fail-closed
// ---------------------------------------------------------------------------

describe('the answers are validated before any provider is asked', () => {
  it('accepts a complete submission, trimmed, sorted, and blank optionals dropped', () => {
    const answers = normalizeInterviewAnswers({
      answers: [
        { stepId: 'work', fieldId: 'achievements', value: '  Cut the CI build time by 40%  ' },
        { stepId: 'roles', fieldId: 'roles', value: 'Senior Engineer at Acme' },
        { stepId: 'tools', fieldId: 'technologies', value: 'TypeScript' },
        { stepId: 'working', fieldId: 'working_style', value: 'Small PRs' },
        { stepId: 'roles', fieldId: 'employers', value: '   ' },
      ],
    });
    expect(answers.map((answer) => `${answer.stepId}.${answer.fieldId}`)).toEqual([
      'roles.roles',
      'tools.technologies',
      'work.achievements',
      'working.working_style',
    ]);
    expect(answers[0].value).toBe('Senior Engineer at Acme');
  });

  it('the last value for a field wins, which is what a form posting its whole state means', () => {
    const base = Object.entries(answerBody()).map(([key, value]) => {
      const [stepId, fieldId] = key.split('.');
      return { stepId, fieldId, value };
    });
    const answers = normalizeInterviewAnswers({
      answers: [
        ...base,
        { stepId: 'work', fieldId: 'achievements', value: 'first answer' },
        { stepId: 'work', fieldId: 'achievements', value: 'second answer' },
      ],
    });
    expect(answers.filter((answer) => answer.fieldId === 'achievements')).toHaveLength(1);
    expect(answers.find((answer) => answer.fieldId === 'achievements')?.value).toBe('second answer');
  });

  it('refuses an unknown step or field rather than ignoring what it does not recognise', () => {
    for (const bad of [
      { stepId: 'secrets', fieldId: 'roles', value: 'I was promoted to Staff' },
      { stepId: 'roles', fieldId: 'salary', value: '900000' },
    ]) {
      expect(() =>
        normalizeInterviewAnswers({ answers: [{ ...bad, stepId: bad.stepId, fieldId: bad.fieldId }] }),
      ).toThrow(/unknown interview (step|field)/);
    }
  });

  it('refuses a body with no answers, a missing member, and an over-long answer', () => {
    expect(() => normalizeInterviewAnswers({})).toThrow(/answers must be an array/);
    expect(() => normalizeInterviewAnswers({ answers: [] })).toThrow(/answer at least one question/);
    expect(() => normalizeInterviewAnswers({ answers: [{ stepId: 'roles' }] })).toThrow(
      /string stepId, fieldId and value/,
    );
    expect(() =>
      normalizeInterviewAnswers({
        answers: [{ stepId: 'roles', fieldId: 'roles', value: 'x'.repeat(5_000) }],
      }),
    ).toThrow(/longer than 4000 characters/);
    const many = Array.from({ length: MAX_INTERVIEW_ANSWERS + 1 }, () => ({
      stepId: 'roles',
      fieldId: 'roles',
      value: 'Senior Engineer at Acme',
    }));
    expect(() => normalizeInterviewAnswers({ answers: many })).toThrow(/too many answers/);
  });

  it('names every required question still blank, rather than extracting from nothing', () => {
    expect(() => normalizeInterviewAnswers(body({ 'work.achievements': '   ' }))).toThrow(
      /required questions are still blank: work\.achievements/,
    );
    // The refusal is an `interview_invalid_input`, which the route maps to 400 - not a 500
    // and not a silent empty extraction.
    try {
      normalizeInterviewAnswers(body({ 'work.achievements': '' }));
      expect.unreachable('this should have thrown');
    } catch (error) {
      expect((error as CareerInterviewError).code).toBe('interview_invalid_input');
    }
  });
});

// ---------------------------------------------------------------------------
// (1) No provider is an honest refusal
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 1: no provider is an honest refusal, not a degraded interview', () => {
  it('leaseInterviewProvider throws interview_provider_required and names the manual path', async () => {
    await expect(leaseInterviewProvider(USER)).rejects.toMatchObject({
      code: 'interview_provider_required',
    });
    await expect(leaseInterviewProvider(USER)).rejects.toThrow(/add your statements by hand/);
  });

  it('the shipped extractor reports skipped / no_ai_provider_configured and asks nothing of a model', async () => {
    const outcome = await shippedCareerInterviewExtractor({
      userId: USER,
      answers: answersFrom(),
      answersBlock: 'unused',
    });
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toBe('no_ai_provider_configured');
    expect(outcome.response).toBeNull();
  });

  it('recordInterviewClaims REFUSES on the no-provider reason and writes ZERO claims', async () => {
    setCareerInterviewExtractor(
      vi.fn(async () => ({
        status: 'skipped' as const,
        reason: 'no_ai_provider_configured' as const,
        provider: null,
        model: null,
        response: null,
      })),
    );
    const store = new FakeCareerStore();
    await expect(
      recordInterviewClaims({ profileId: PROFILE, userId: USER, answers: answersFrom() }, store.asStore()),
    ).rejects.toMatchObject({ code: 'interview_provider_required' });
    // NOTHING. Not a claim, not a stub, not a "here is a starting point" row.
    expect(store.claims.size).toBe(0);
    expect(store.writes).toEqual([]);
    expect(store.verifications.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (2) A schema-invalid response is a hard failure
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 2: a schema-invalid response is a hard failure', () => {
  it('refuses with interview_schema_invalid and writes nothing', async () => {
    setCareerInterviewExtractor(
      vi.fn(async () => ({
        status: 'skipped' as const,
        reason: 'schema_invalid' as const,
        provider: 'test-provider',
        model: 'test-model',
        response: null,
      })),
    );
    const store = new FakeCareerStore();
    await expect(
      recordInterviewClaims({ profileId: PROFILE, userId: USER, answers: answersFrom() }, store.asStore()),
    ).rejects.toMatchObject({ code: 'interview_schema_invalid' });
    expect(store.claims.size).toBe(0);
    expect(store.writes).toEqual([]);
  });

  it('refuses the same way when an UNREACHABLE provider is the reason, and never guesses', async () => {
    setCareerInterviewExtractor(
      vi.fn(async () => ({
        status: 'skipped' as const,
        reason: 'provider_unavailable' as const,
        provider: 'test-provider',
        model: 'test-model',
        response: null,
      })),
    );
    const store = new FakeCareerStore();
    await expect(
      recordInterviewClaims({ profileId: PROFILE, userId: USER, answers: answersFrom() }, store.asStore()),
    ).rejects.toMatchObject({ code: 'interview_provider_unavailable' });
    expect(store.claims.size).toBe(0);
  });

  it('the refusal vocabulary is closed: a reason with no refusal of its own is still a refusal', async () => {
    // `refusalFor`'s `default` arm is the one thing that could accidentally become a
    // SUCCESSFUL empty run. Exercised through the seam with a reason the stage does not
    // otherwise produce, and asserted to fail rather than write.
    setCareerInterviewExtractor(
      vi.fn(async () => ({
        status: 'skipped' as const,
        reason: 'schema_invalid' as const,
        provider: null,
        model: null,
        response: null,
      })),
    );
    const store = new FakeCareerStore();
    await expect(
      recordInterviewClaims({ profileId: PROFILE, userId: USER, answers: answersFrom() }, store.asStore()),
    ).rejects.toBeInstanceOf(CareerInterviewError);
    expect(store.claims.size).toBe(0);
  });

  it('a response whose claims member is NOT an array is refused, not coerced', async () => {
    // This is the "salvage" shape a permissive implementation would accept: `claims` as a
    // string, so a loop over it produces nothing and the stage reports success with zero
    // claims. The guard refuses it here, and the refusal is reported as a DROP, not a batch.
    const guard = guardExtractedClaims({ claims: 'not an array' as never }, ['Acme']);
    expect(guard.accepted).toEqual([]);
    expect(guard.dropped).toEqual([]);
  });

  it('a null response is not a successful empty interview', async () => {
    expect(guardExtractedClaims(null, ['Acme'])).toEqual({ accepted: [], dropped: [] });
  });
});

// ---------------------------------------------------------------------------
// (3) The deterministic validation, per claim, fail-closed
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 3: every claim is checked, and a bad one is DROPPED with its reason', () => {
  const GROUNDING = answerGrounding(answersFrom());

  it('accepts a claim the answers support', () => {
    const guard = guardExtractedClaims({ claims: [groundedClaim()] }, GROUNDING);
    expect(guard.dropped).toEqual([]);
    expect(guard.accepted).toEqual([
      {
        kind: ClaimKind.achievement,
        statement: 'Cut the CI build time by 40% by caching the dependency layer',
        confidence: 0.8,
      },
    ]);
  });

  it('refuses a kind outside the ClaimKind enum', () => {
    for (const kind of ['resume_summary', 'Senior Engineer', '', null, undefined, 42]) {
      const guard = guardExtractedClaims({ claims: [groundedClaim({ kind })] }, GROUNDING);
      expect(guard.accepted, String(kind)).toEqual([]);
      expect(guard.dropped.map((row) => row.reason), String(kind)).toEqual(['unknown_kind']);
    }
  });

  it('refuses an empty statement, a too-short one and a too-long one', () => {
    const blank = guardExtractedClaims({ claims: [groundedClaim({ statement: '   ' })] }, GROUNDING);
    expect(blank.dropped[0].reason).toBe('no_statement');

    const tiny = guardExtractedClaims({ claims: [groundedClaim({ statement: 'ok' })] }, GROUNDING);
    expect(tiny.dropped[0].reason).toBe('statement_too_short');

    const huge = guardExtractedClaims(
      { claims: [groundedClaim({ statement: 'Owned the ledger. '.repeat(60) })] },
      GROUNDING,
    );
    expect(huge.dropped[0].reason).toBe('statement_too_long');
    expect(huge.accepted).toEqual([]);
  });

  it('refuses an out-of-range confidence rather than clamping it', () => {
    for (const confidence of [1.4, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const guard = guardExtractedClaims({ claims: [groundedClaim({ confidence })] }, GROUNDING);
      expect(guard.accepted, String(confidence)).toEqual([]);
      expect(guard.dropped[0].reason).toBe('invalid_confidence');
    }
    // Absent confidence is simply absent: metadata, not a claim's worth.
    const absent = guardExtractedClaims({ claims: [groundedClaim({ confidence: null })] }, GROUNDING);
    expect(absent.accepted[0].confidence).toBeNull();
  });

  // THE FABRICATION CASE. Each of these names something the answers do not, and each must
  // be DROPPED with `invented_entity` and the entity named, so the user is told what was
  // refused rather than finding it silently missing.
  it('DROPS a claim naming an employer the answers never mention', () => {
    const guard = guardExtractedClaims(
      { claims: [groundedClaim({ statement: 'Led the payments migration at Initech' })] },
      GROUNDING,
    );
    expect(guard.accepted).toEqual([]);
    expect(guard.dropped[0].reason).toBe('invented_entity');
    expect(guard.dropped[0].invented.some((entity) => entity.startsWith('employer:'))).toBe(true);
  });

  it('DROPS a claim naming a year the answers never mention', () => {
    const guard = guardExtractedClaims(
      { claims: [groundedClaim({ statement: 'Ran the on-call rotation from 2015' })] },
      GROUNDING,
    );
    expect(guard.accepted).toEqual([]);
    expect(guard.dropped[0].reason).toBe('invented_entity');
    expect(guard.dropped[0].invented).toContain('date:2015');
  });

  it('DROPS a claim naming a technology the answers never mention', () => {
    const guard = guardExtractedClaims(
      { claims: [{ kind: ClaimKind.skill, statement: 'Ran the service on Kafka', confidence: 0.9 }] },
      GROUNDING,
    );
    expect(guard.accepted).toEqual([]);
    expect(guard.dropped[0].reason).toBe('invented_entity');
  });

  it('DROPS a claim whose NUMBER is not the number the user gave', () => {
    const guard = guardExtractedClaims(
      { claims: [groundedClaim({ statement: 'Cut the CI build time by 55% by caching the layer' })] },
      GROUNDING,
    );
    expect(guard.accepted).toEqual([]);
    expect(guard.dropped[0].reason).toBe('invented_entity');
    expect(guard.dropped[0].invented).toContain('metric:55%');
  });

  it('KEEPS the same figure the user gave, however it is re-worded', () => {
    // The false-positive guard on the guard: a check that refused every re-wording would
    // train the user to distrust it, and would drop the honest majority of claims.
    const guard = guardExtractedClaims(
      { claims: [groundedClaim({ statement: 'Reduced the CI build time by 40%' })] },
      GROUNDING,
    );
    expect(guard.dropped).toEqual([]);
    expect(guard.accepted).toHaveLength(1);
  });

  it('keeps a VAGUE claim: it asserts no entity, so it invents nothing', () => {
    const guard = guardExtractedClaims(
      { claims: [{ kind: ClaimKind.responsibility, statement: 'Worked on billing systems' }] },
      GROUNDING,
    );
    expect(guard.accepted).toHaveLength(1);
  });

  it('an EMPTY grounding refuses every claim, rather than waving them all through', () => {
    const guard = guardExtractedClaims({ claims: [groundedClaim()] }, []);
    expect(guard.accepted).toEqual([]);
    expect(guard.dropped[0].reason).toBe('invented_entity');
  });

  it('drops a duplicate (kind, statement) pair and keeps the first', () => {
    const guard = guardExtractedClaims(
      { claims: [groundedClaim(), groundedClaim({ confidence: 0.1 })] },
      GROUNDING,
    );
    expect(guard.accepted).toHaveLength(1);
    expect(guard.dropped[0].reason).toBe('duplicate');
  });

  it('reads only MAX_INTERVIEW_CLAIMS and says so', () => {
    const claims = Array.from({ length: 30 }, (_, index) =>
      groundedClaim({ statement: `A distinct supported statement number ${'x'.repeat(index)}` }),
    );
    const guard = guardExtractedClaims({ claims }, GROUNDING);
    expect(guard.dropped.map((row) => row.reason)).toContain('too_many_claims');
    expect(guard.accepted.length).toBeLessThanOrEqual(24);
  });

  it('A MIXED BATCH: the good claims land, the fabricated one is dropped with its reason', async () => {
    setCareerInterviewExtractor(
      extractorReturning({
        schemaVersion: 'claim_extract_v1',
        claims: [
          { kind: 'role', statement: 'Senior Engineer at Acme', confidence: 0.9 },
          { kind: 'achievement', statement: 'Led the payments migration at Initech', confidence: 0.9 },
          { kind: 'technology', statement: 'Kubernetes', confidence: 0.7 },
          { kind: 'made_up_kind', statement: 'Something entirely supported', confidence: 0.7 },
          { kind: 'achievement', statement: 'Cut the CI build time by 40% by caching the dependency layer', confidence: 0.8 },
        ],
      }),
    );
    const store = new FakeCareerStore();
    const result = await recordInterviewClaims(
      { profileId: PROFILE, userId: USER, answers: answersFrom() },
      store.asStore(),
    );

    expect(result.extracted).toBe(5);
    expect(result.accepted).toBe(3);
    expect(result.created).toBe(3);
    // The refusals are REPORTED, with their reasons and the entities that were not there.
    expect(result.dropped.map((row) => row.reason).sort()).toEqual(['invented_entity', 'unknown_kind']);
    const fabricated = result.dropped.find((row) => row.reason === 'invented_entity');
    expect(fabricated?.detail).toContain('Led the payments migration at Initech');
    expect(fabricated?.invented.length).toBeGreaterThan(0);
    // ...and the fabricated sentence is not anywhere in the store.
    const stored = store.claimsFor(PROFILE).map((row) => row.statement);
    expect(stored.some((statement) => statement.includes('Initech'))).toBe(false);
    expect(stored).toHaveLength(3);
  });

  it('a claim naming an employer the user DID supply is kept, however it is phrased', () => {
    const guard = guardExtractedClaims(
      { claims: [{ kind: ClaimKind.role, statement: 'Engineer at Globex', confidence: 0.8 }] },
      GROUNDING,
    );
    expect(guard.dropped).toEqual([]);
    expect(guard.accepted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (4) Every claim is inferred + llm_inferred, through the one writer, with no audit row
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 4: every produced claim is inferred / llm_inferred and nothing else', () => {
  it('the stage writes inferred + llm_inferred with the interview method and NO audit row', async () => {
    setCareerInterviewExtractor(
      extractorReturning({
        schemaVersion: 'claim_extract_v1',
        claims: [
          { kind: 'role', statement: 'Senior Engineer at Acme', confidence: 0.9 },
          { kind: 'technology', statement: 'Kubernetes', confidence: 0.7 },
        ],
      }),
    );
    const store = new FakeCareerStore();
    const result = await recordInterviewClaims(
      { profileId: PROFILE, userId: USER, answers: answersFrom() },
      store.asStore(),
    );

    expect(result.created).toBe(2);
    const rows = store.claimsFor(PROFILE);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe(ClaimStatus.inferred);
      expect(row.provenance).toBe(ClaimProvenance.llm_inferred);
      expect(row.inferenceMethod).toBe(CAREER_INTERVIEW_INFERENCE_METHOD);
      expect(row.producedByModel).toBe('test-provider');
      expect(row.confirmedAt).toBeNull();
      expect(row.rejectedAt).toBeNull();
    }
    // NOT ONE status write and NOT ONE audit row: the stage has no confirming path at all.
    // `FakeCareerStore.writes` records MUTATING calls only; the two `findFirst` dedupe reads
    // land in `store.reads`, which is what makes "no update, no audit row" an assertion.
    expect(store.writes).toEqual(['claim.create', 'claim.create']);
    expect(store.reads.filter((call) => call.startsWith('claim.findFirst'))).toHaveLength(2);
    expect(store.verifications.size).toBe(0);
    expect(result.provider).toBe('test-provider');
    expect(result.model).toBe('test-model');
  });

  it('the constants the route echoes ARE the two AI statuses, in this directory', () => {
    expect(CAREER_INTERVIEW_STATUS).toBe(ClaimStatus.inferred);
    expect(CAREER_INTERVIEW_PROVENANCE).toBe(ClaimProvenance.llm_inferred);
  });

  it('re-running the interview DEDUPES: no duplicate row, no status change, no resurrection', async () => {
    setCareerInterviewExtractor(
      extractorReturning({
        claims: [groundedClaim({ confidence: 0.2 })],
      }),
    );
    const store = new FakeCareerStore();
    await recordInterviewClaims(
      { profileId: PROFILE, userId: USER, answers: answersFrom() },
      store.asStore(),
    );
    const writesAfterFirst = [...store.writes];
    const again = await recordInterviewClaims(
      { profileId: PROFILE, userId: USER, answers: answersFrom() },
      store.asStore(),
    );
    expect(again.created).toBe(0);
    expect(again.deduped).toBe(1);
    expect(store.claims.size).toBe(1);
    // A pure read: not even the confidence was rewritten. ADR-036 item 4.
    expect(store.writes).toEqual(writesAfterFirst);
    // The SECOND observation's higher confidence is NOT written: a re-run is a pure read.
    expect(store.claimsFor(PROFILE)[0].confidence).toBe(0.2);
  });

  it('an EMPTY claims array is a successful, honest, zero-claim run', async () => {
    setCareerInterviewExtractor(extractorReturning({ schemaVersion: 'claim_extract_v1', claims: [] }));
    const store = new FakeCareerStore();
    const result = await recordInterviewClaims(
      { profileId: PROFILE, userId: USER, answers: answersFrom() },
      store.asStore(),
    );
    expect(result).toMatchObject({ extracted: 0, accepted: 0, created: 0, deduped: 0, dropped: [] });
    expect(store.claims.size).toBe(0);
  });

  it('writeInterviewClaims accepts nothing that could carry a status or a provenance', async () => {
    // The write takes `{kind, statement, confidence}` and nothing else, so a caller cannot
    // smuggle a confirming status past the writer's own guard - there is no member to put
    // it in. Asserted at the type level by `npx tsc --noEmit` over this file.
    const store = new FakeCareerStore();
    const written = await writeInterviewClaims(
      { profileId: PROFILE, provider: null, claims: [{ kind: ClaimKind.skill, statement: 'TypeScript', confidence: null }] },
      store.asStore(),
    );
    expect(written).toEqual({ created: 1, deduped: 0 });
    expect(store.claimsFor(PROFILE)[0].status).toBe(ClaimStatus.inferred);
    expect(store.claimsFor(PROFILE)[0].provenance).toBe(ClaimProvenance.llm_inferred);
  });
});

// ---------------------------------------------------------------------------
// The session id
// ---------------------------------------------------------------------------

describe('the session id is opaque, well-shaped, and grants nothing', () => {
  it('has one shape, does not repeat, and anything else is not one', () => {
    const first = createInterviewSessionId();
    const second = createInterviewSessionId();
    expect(first).toMatch(/^iv1\.[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
    for (const bad of ['', 'iv1.', 'iv1.zzz', '../iv1.0000000000000000000000000000000', null, 42]) {
      expect(isInterviewSessionId(bad), String(bad)).toBe(false);
    }
    expect(isInterviewSessionId(first)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source guards: the invariants are structural, so they are checked structurally
// ---------------------------------------------------------------------------

describe('source guards (the guarantee cannot be retyped away)', () => {
  it('names NO confirming or terminal status, in code', () => {
    for (const forbidden of ['user_confirmed', 'rejected', 'superseded']) {
      expect(SOURCE, `interview.ts -> ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('assigns no claim status at all: the only ClaimStatus reference is the inferred constant', () => {
    const statuses = [...SOURCE.matchAll(/ClaimStatus\.([a-z_]+)/g)].map((match) => match[1]);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) expect(['inferred', 'contextual']).toContain(status);
  });

  it('the object handed to the AI writer carries NO status and NO provenance member', () => {
    // The write payload, sliced out of the source. `InferredClaimInput` has no provenance
    // member and only accepts inferred|contextual, so the two things this slice must not
    // contain are exactly the two ways a caller could relabel a model's sentence.
    const start = SOURCE.indexOf('export async function writeInterviewClaims');
    expect(start).toBeGreaterThan(-1);
    const payload = SOURCE.slice(start, SOURCE.indexOf('\n}', start));
    expect(payload).toContain('writeInferredClaims(');
    expect(payload).not.toMatch(/\bstatus\b\s*:/);
    expect(payload).not.toMatch(/\bprovenance\b/);
    expect(payload).not.toContain('supersedesClaimId');
  });

  it('mentions no Resume model, and reaches the AI writer only through it', () => {
    expect(SOURCE).not.toContain('Resume');
    expect(SOURCE).toContain("from './claimWriterAI.js'");
  });

  it('does not import the prisma singleton, and never the status writer', () => {
    expect(SOURCE).not.toMatch(/from '\.\.\/lib\/prisma/);
    expect(SOURCE).not.toContain("from './verification.js'");
  });

  it('the questions are asked by the server: no model is asked to write a question', () => {
    // The refusal and the guard are the only two places a claim can be shaped, and the
    // questionnaire is a frozen constant - so a provider cannot change what is asked.
    expect(CAREER_INTERVIEW_STEPS.every((step) => typeof step.title === 'string')).toBe(true);
    expect(Object.isFrozen(CAREER_INTERVIEW_STEPS)).toBe(true);
  });
});