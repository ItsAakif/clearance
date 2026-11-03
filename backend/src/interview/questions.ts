// =====================================================================================
// interview/questions.ts - ANCHORED QUESTIONS AND THE FAIL-CLOSED GROUNDING CHECK
// (T1090; 06-design sec. E.4, E.8 stage 11, E.9).
//
// WHAT THIS MODULE IS. The second half of E.4: risks (from `interview/risks.ts`) become
// questions, and a question's MODEL ANSWER is only ever allowed to say what the question's
// grounded claims say. It holds three things:
//
//   1. THE DETERMINISTIC HALF - a question stem per risk kind, and `buildQuestions`, which
//      refuses a question that carries no anchor. "No generic question is emitted without a
//      risk/requirement anchor" is `assertQuestionIsAnchored`, which THROWS on an unanchored
//      draft rather than filtering it out quietly: an unanchored question is a programming
//      error, and a filter would make it a silent one.
//
//   2. THE POST-CHECK - `checkGroundedAnswer`. A pure function that extracts the ENTITIES of
//      an answer (metrics, dates, technologies, employers) with `tailor/factDelta.ts` - the
//      same vocabulary the tailoring fact-delta guard uses - and compares them with the
//      entities of the question's grounded claims, their evidence sources, and (for a
//      requirement-anchored question) the requirement's own text. ANY entity the grounding
//      does not contain rejects the answer. It is entity-level, not a keyword allowlist: it
//      cannot be satisfied by echoing a permitted word while inventing a company.
//
//   3. THE TWO OPTIONAL PROVIDER STAGES - the risk brief (`interview_risk_v1.jinja`, which
//      may only SHARPEN a risk the server derived) and the model answer
//      (`interview_question_v1.jinja`). Both run behind an injectable seam, both are skipped
//      with a machine-readable reason when no BYOK key is configured (ADR-041 D5), and
//      neither can create a risk or an unanchored question.
//
// WHY THE QUESTIONS ARE WRITTEN HERE AND NOT ASKED FOR BY A MODEL. E.4 says questions come
// with "one or more per risk", and the acceptance item is "no generic question is emitted
// without a risk/requirement anchor". A prompt that ASKED a model to write the questions
// would put the anchor outside the server's reach and make that item unenforceable: the
// server could only check the anchor AFTER reading the model's question, and a question with
// no anchor would then be a question to refuse rather than a shape to never produce. So the
// server writes the stem, deterministically, from the risk it derived, and the model is given
// the privilege E.4 actually gives it: the answer, under a check.
//
// WHY THE ANSWER STAGE IS FAIL-CLOSED AND RETRIES EXACTLY ONCE. E.8's stage-11 row: "entities
// in modelAnswer subset of grounded claims; category enum -> fail-closed regenerate once".
// So: attempt 1, check, and on a refusal attempt 2 WITH THE REFUSED ENTITIES NAMED BACK TO
// THE PROPOSER. A second refusal stores the question WITHOUT an answer and records the
// refusal - the rejection is on the record, the question is not, and the person is never
// shown an answer that names a company they never worked for. TWO ATTEMPTS IS A CONSTANT, NOT
// A BUDGET: a stage that could keep trying would eventually be talked into a false answer,
// and the point of the check is that it does not yield.
//
// WHY A `gap` QUESTION CANNOT CARRY A MODEL ANSWER AT ALL. A gap is a named requirement with
// NOTHING behind it: `groundedClaimIds` is empty by construction, because E.2 spent four
// evidence levels making sure a gap is the absence of evidence. An answer for it could
// therefore only speak about the requirement itself, so any sentence of substance would name
// an entity the grounding does not have and would be refused every time - a provider call spent
// to arrive at a certain refusal. So a question with ZERO GROUNDED CLAIMS is
// `skipped/no_grounded_evidence` and stored with its anchor and its focus, which is the useful
// thing about a gap and the only honest thing to say about one. The test is the CLAIM COUNT and
// not the amount of grounding text: a gap's grounding is non-empty (the requirement's own
// wording), and counting characters would call it answerable.
//
// INJECTION POSTURE (E.9). The risk statements, the requirement text and the claim statements
// all go into the USER message as DATA; the system message is a static string with no
// interpolated content; every response must parse against a zod schema; and no question text
// can select a tool, a URL or a database operation. A job description that says "ignore
// previous instructions" is quoted material in a prompt whose output is then entity-checked
// against the caller's own claims - so the worst a hostile input can do is waste a call.
//
// WHAT THIS MODULE NEVER DOES. It never writes. There is no store seam here: the route
// persists what this returns, exactly as it persists `match/report.ts`'s view. It never names
// a claim status literal, and it never scores anything (E.6).
// =====================================================================================

import { z } from 'zod';
import type { InterviewRiskKind, Severity } from '@prisma/client';

import { loadAndRender } from '../ats/promptLoader.js';
import {
  isRateLimitError,
  leaseNextLlmKey,
  markKeyFailure,
  markKeySuccess,
} from '../ai/keyManager.js';
import { createLlmClient, getProviderModel, runLlmCompletion } from '../ai/providerModels.js';
import {
  detectFactDelta,
  extractFacts,
  factsOfTexts,
  type FactEntity,
} from '../tailor/factDelta.js';
import {
  MAX_GROUNDED_CLAIMS_PER_RISK,
  assertRisksAreAnchored,
  type DerivedRisk,
} from './risks.js';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * `InterviewQuestion.category`, as a CLOSED set. The schema stores a bare `String` column,
 * which means the database will happily hold a fifth value; the set is here so the prompt,
 * the guard and the client all speak about the same four, and so a value outside it is a
 * refused answer rather than a stored category nobody can style.
 */
export const QUESTION_CATEGORIES = Object.freeze([
  'behavioral',
  'technical',
  'situational',
  'general',
] as const);

export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

function isQuestionCategory(value: unknown): value is QuestionCategory {
  return typeof value === 'string' && (QUESTION_CATEGORIES as readonly string[]).includes(value);
}

/** The category each risk kind is asked in. A table, so a kind cannot arrive uncategorised. */
export const QUESTION_CATEGORY_FOR_KIND: Readonly<Record<InterviewRiskKind, QuestionCategory>> =
  Object.freeze({
    new_claim: 'general',
    emphasized_tech: 'technical',
    inferred_claim: 'behavioral',
    rewritten_bullet: 'behavioral',
    overclaim: 'technical',
    gap: 'technical',
    thin_evidence: 'general',
  });

/**
 * The deterministic question stem per kind.
 *
 * EACH STEM ASKS FOR SOMETHING THE GROUNDING CAN SUPPLY - a provenance, a measurement method,
 * an original description - rather than for a story, because a story is where an ungrounded
 * entity arrives. The stem is a PREFIX and the risk's own statement is appended, so the
 * question always quotes the exact rows it was derived from and a reader can match the two.
 */
export const QUESTION_STEM_FOR_KIND: Readonly<Record<InterviewRiskKind, string>> = Object.freeze({
  new_claim: 'Tell me about this in your own words:',
  emphasized_tech: 'Take me through the work behind this:',
  inferred_claim: 'Be specific about this one:',
  rewritten_bullet: 'Describe the original work, not the polished version:',
  overclaim: 'Walk me through how this was measured:',
  gap: 'This job asks for something your evidence does not cover. What is closest to it?',
  thin_evidence: 'Where does this come from, and who else was there?',
});

// ---------------------------------------------------------------------------
// The refusal vocabulary
// ---------------------------------------------------------------------------

/** Every way a question draft is refused. Both are programming errors, so both THROW. */
export const QUESTION_REJECTION_REASONS = Object.freeze([
  /** The draft carries neither a risk anchor nor a requirement anchor. */
  'NO_ANCHOR',
  /** The draft carries a category outside the four. */
  'BAD_CATEGORY',
] as const);

export type QuestionRejectionReason = (typeof QUESTION_REJECTION_REASONS)[number];

export type QuestionRejectionCode = `QUESTION_${QuestionRejectionReason}`;

/** A question was refused. Carries the machine-readable reason; no caller data in the text. */
export class InterviewQuestionError extends Error {
  readonly code: QuestionRejectionCode;
  readonly reason: QuestionRejectionReason;
  /** The offending draft's identifier, for the log. Never persisted. */
  readonly detail: string;

  constructor(reason: QuestionRejectionReason, detail: string) {
    super(
      `QUESTION_${reason}: ${
        reason === 'NO_ANCHOR'
          ? 'every question must name the risk or the requirement it was derived from'
          : `the category must be one of ${QUESTION_CATEGORIES.join('|')}`
      }`,
    );
    this.name = 'InterviewQuestionError';
    this.code = `QUESTION_${reason}`;
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// The draft: a question BEFORE persistence, carrying its anchor
// ---------------------------------------------------------------------------

/** One grounded claim's text, which is the whole of what an answer may cite. */
export interface GroundedClaimText {
  id: string;
  statement: string;
  /** The claim's evidence-source text, capped. Part of the grounding by E.4's wording. */
  evidenceText: readonly string[];
}

/** A requirement's text, which is the only grounding a `gap` question has. */
export interface GroundedRequirementText {
  requirementId: string;
  text: string;
}

export interface QuestionDraft {
  /** Deterministic prompt id: `<riskKey>#<category>`. Stable across runs for the same input. */
  questionId: string;
  /** The risk this question was derived from. `null` only for a bare requirement anchor. */
  riskKey: string | null;
  kind: InterviewRiskKind | null;
  severity: Severity | null;
  category: QuestionCategory;
  question: string;
  /** `null` when the question is not about one requirement. */
  requirementId: string | null;
  /** The ONLY claims an answer for this question may cite. */
  groundedClaimIds: readonly string[];
  /** The risk's probe, or the provider's sharpened version. Shown under the question. */
  focus: string;
  /**
   * How many GROUNDED CLAIMS the question carries. `0` means no answer can be written: the
   * question is about something the evidence does not cover, so there is nothing to ground one
   * in. Deliberately a CLAIM count rather than a text count - see `buildQuestions`.
   */
  groundingSize: number;
}

/**
 * THE ANCHOR RULE: a draft must carry a risk anchor or a requirement anchor.
 *
 * It THROWS rather than filtering, for the reason in the header: a question with no anchor is
 * a bug in the builder, and a filter would turn that bug into a silently shorter list.
 * `riskKey` OR `requirementId` is enough - a `gap` risk has a requirement and no claims, and
 * that is a properly anchored question, not an unanchored one.
 */
export function assertQuestionIsAnchored(draft: QuestionDraft): QuestionDraft {
  const hasRisk = typeof draft.riskKey === 'string' && draft.riskKey.length > 0;
  const hasRequirement = typeof draft.requirementId === 'string' && draft.requirementId.length > 0;
  if (!hasRisk && !hasRequirement) {
    throw new InterviewQuestionError('NO_ANCHOR', String(draft?.questionId ?? '(none)'));
  }
  if (!isQuestionCategory(draft.category)) {
    throw new InterviewQuestionError('BAD_CATEGORY', String(draft.category));
  }
  return draft;
}

// ---------------------------------------------------------------------------
// The grounding set
// ---------------------------------------------------------------------------

/**
 * The texts an answer for ONE question may draw its entities from.
 *
 * EXACTLY E.4's list and nothing else: the grounded claims' statements, their evidence
 * sources, and - for a question anchored to a requirement - the requirement's own text. The
 * risk's own statement is deliberately NOT in it: the statement is what the SERVER concluded,
 * and letting a model answer echo the server's conclusion would make the check circular.
 */
export function groundingFor(
  groundedClaimIds: readonly string[],
  claims: ReadonlyMap<string, GroundedClaimText>,
  requirementId: string | null,
  requirements: ReadonlyMap<string, GroundedRequirementText>,
): string[] {
  const texts: string[] = [];
  for (const id of groundedClaimIds) {
    const claim = claims.get(id);
    if (!claim) continue;
    texts.push(claim.statement, ...claim.evidenceText);
  }
  if (requirementId !== null) {
    const requirement = requirements.get(requirementId);
    if (requirement) texts.push(requirement.text);
  }
  return texts;
}

/** Employers named anywhere in the grounding, so `extractFacts` recognises each of them. */
function employersIn(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const employer of extractFacts(text).employers) out.add(employer);
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// THE POST-CHECK
// ---------------------------------------------------------------------------

export interface GroundingVerdict {
  readonly grounded: true;
  /** How many entities the answer asserted and the grounding covered. Diagnostics only. */
  readonly checked: number;
}

export interface GroundingRejection {
  readonly grounded: false;
  /** The entities the answer names that the grounding does not. Empty when nothing was named. */
  readonly ungrounded: readonly FactEntity[];
  /**
   * The same entities in words a PROMPT can be shown ("employer Initech"), which is what
   * makes the one regeneration a regeneration rather than a repeat.
   */
  readonly ungroundedNames: readonly string[];
}

export type GroundingResult = GroundingVerdict | GroundingRejection;

/**
 * THE POST-CHECK, AND IT IS THE WHOLE GUARANTEE.
 *
 * An answer is grounded iff `entities(answer)` is a subset of `entities(grounding)`. The
 * extraction is `tailor/factDelta.ts`'s - numbers with units, years, canonical technology keys
 * from the matcher's synonym tables, and organisations - so it is ENTITY-LEVEL, not a keyword
 * allowlist: a sentence that says "Kubernetes" (permitted) and "at Initech" (nowhere in the
 * evidence) is rejected, and no amount of permitted vocabulary gets past it.
 *
 * IT FAILS CLOSED IN BOTH EMPTY DIRECTIONS. With NO GROUNDING it returns a rejection carrying
 * an EMPTY `ungrounded` list, because "no entities found" against nothing means "nothing was
 * checked", and a check that passes because it looked at nothing is not a check. And an EMPTY
 * ANSWER is a rejection too, for the same reason: an answer that says nothing is not an answer
 * that says only grounded things. The caller does not need either case for safety - a question
 * with no grounding never reaches the provider - but the pure function must not be the thing
 * that decides it is fine.
 */
export function checkGroundedAnswer(input: {
  answer: unknown;
  groundedClaimIds: readonly string[];
  claims: ReadonlyMap<string, GroundedClaimText>;
  requirementId: string | null;
  requirements: ReadonlyMap<string, GroundedRequirementText>;
}): GroundingResult {
  const groundingTexts = groundingFor(
    input.groundedClaimIds,
    input.claims,
    input.requirementId,
    input.requirements,
  );
  const answer = typeof input.answer === 'string' ? input.answer.trim() : '';

  if (groundingTexts.length === 0 || answer.length === 0) {
    return { grounded: false, ungrounded: [], ungroundedNames: [] };
  }

  const employers = employersIn(groundingTexts);
  const allowed = factsOfTexts(groundingTexts, employers);
  const asserted = extractFacts(answer, employers);
  const delta = detectFactDelta(asserted, allowed);
  if (delta === null) {
    const checked =
      asserted.metrics.length +
      asserted.dates.length +
      asserted.technologies.length +
      asserted.employers.length;
    return { grounded: true, checked };
  }
  return {
    grounded: false,
    ungrounded: delta.introduced,
    ungroundedNames: [
      ...delta.byKind.metric.map((value) => `number ${value}`),
      ...delta.byKind.date.map((value) => `year ${value}`),
      ...delta.byKind.technology.map((value) => `technology ${value}`),
      ...delta.byKind.employer.map((value) => `employer ${value}`),
    ].sort(),
  };
}

// ---------------------------------------------------------------------------
// The answer stage's report
// ---------------------------------------------------------------------------

export type AnswerReason =
  /** An answer passed the post-check and is stored. */
  | 'ok'
  /** No BYOK key: the question is stored, with no answer (ADR-041 D5). */
  | 'no_ai_provider_configured'
  /** A key existed and the call failed, or the response failed its schema twice. */
  | 'provider_unavailable'
  /** Nothing to ground an answer in - a `gap` question, by construction. */
  | 'no_grounded_evidence'
  /** The answer named an ungrounded entity on BOTH attempts. No answer is stored. */
  | 'ungrounded_entities_after_regeneration'
  /** Reported by a READ, never by a run: this request asked no provider anything. */
  | 'not_evaluated';

/** Every way a proposed answer is discarded BEFORE the post-check even runs. */
export const ANSWER_DROP_REASONS = Object.freeze([
  /** The `questionId` is absent, or is not one of the questions asked in this call. */
  'unknown_question',
  /** The answer is absent, or blank once whitespace is collapsed. */
  'no_answer',
  /** The same question twice in one response; the first wins. */
  'duplicate',
] as const);

export type AnswerDropReason = (typeof ANSWER_DROP_REASONS)[number];

export interface AnswerStageView {
  readonly status: 'answered' | 'skipped' | 'rejected';
  readonly reason: AnswerReason;
  readonly provider: string | null;
  readonly model: string | null;
  /** How many times the provider was asked. `0` when it was never asked. */
  readonly attempts: number;
  /** The entities the LAST refused answer named. Recorded whether or not a retry followed. */
  readonly rejectedEntities: readonly string[];
  /** What the structural guard discarded, with the reason. Never silently dropped. */
  readonly dropped: ReadonlyArray<{ reason: AnswerDropReason; detail: string }>;
}

/** A stage that never ran. `not_evaluated` is what a READ reports, as in `match/report.ts`. */
export function notEvaluatedAnswerStage(): AnswerStageView {
  return {
    status: 'skipped',
    reason: 'not_evaluated',
    provider: null,
    model: null,
    attempts: 0,
    rejectedEntities: [],
    dropped: [],
  };
}

/** The no-provider answer stage: `skipped` with the reason spelled out, not an error. */
export function noProviderAnswerStage(): AnswerStageView {
  return {
    status: 'skipped',
    reason: 'no_ai_provider_configured',
    provider: null,
    model: null,
    attempts: 0,
    rejectedEntities: [],
    dropped: [],
  };
}

/** A provider could not be reached. Shared by the brief stage and the answer stage. */
export function providerUnavailableStage(provider: string | null, model: string | null): AnswerStageView {
  return {
    status: 'skipped',
    reason: 'provider_unavailable',
    provider,
    model,
    attempts: 0,
    rejectedEntities: [],
    dropped: [],
  };
}

// ---------------------------------------------------------------------------
// The prepared question, as the route persists it
// ---------------------------------------------------------------------------

export interface PreparedQuestion {
  /** Deterministic prompt id. Also the stable key the UI can use before persistence. */
  readonly questionId: string;
  readonly riskKey: string | null;
  readonly kind: InterviewRiskKind | null;
  readonly severity: Severity | null;
  readonly category: QuestionCategory;
  readonly question: string;
  readonly requirementId: string | null;
  readonly groundedClaimIds: readonly string[];
  readonly focus: string;
  /** `null` when no answer survived the post-check. NEVER an invented one. */
  readonly modelAnswer: string | null;
  readonly answerStage: AnswerStageView;
}

// ---------------------------------------------------------------------------
// Bounds (E.9)
// ---------------------------------------------------------------------------

/** How many questions one call carries. */
export const MAX_PREPARED_QUESTIONS = 24;
/** How many grounded claims one question's grounding may hold. */
export const MAX_GROUNDING_CLAIMS = MAX_GROUNDED_CLAIMS_PER_RISK;
/** Evidence-source characters folded into ONE claim's grounding. */
export const MAX_GROUNDING_EVIDENCE_CHARS = 2_000;
/** A model answer longer than this is truncated before the check and before persistence. */
export const MAX_MODEL_ANSWER_CHARS = 1_500;
/** How many derived risks the brief stage is asked about in one call. */
export const MAX_BRIEF_RISKS = 20;
/**
 * ONE attempt plus EXACTLY ONE regeneration. A CONSTANT rather than a budget: a stage that
 * could keep retrying is a stage that can be talked into a false answer.
 */
export const MAX_ANSWER_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// THE DETERMINISTIC QUESTION BUILDER
// ---------------------------------------------------------------------------

/**
 * Build the questions for a set of derived risks.
 *
 * PURE, and it needs no provider: the questions exist whether or not one is configured, and
 * the provider's only power over them is the ANSWER plus the brief stage's `focus`. It runs
 * `assertRisksAreAnchored` on its input first, so a caller cannot turn an unanchored risk
 * into a well-formed question and thereby launder it past the invariant.
 *
 * ONE QUESTION PER RISK. A risk already names the specific thing a reader will probe, so a
 * second question would be a generic one wearing the first one's anchor.
 */
export function buildQuestions(
  risks: readonly DerivedRisk[],
  context: {
    claims: ReadonlyMap<string, GroundedClaimText>;
    requirements: ReadonlyMap<string, GroundedRequirementText>;
    /** A `riskKey -> focus` map from the brief stage. Absent keys keep the derived focus. */
    focusByRiskKey?: ReadonlyMap<string, string>;
  },
): readonly PreparedQuestion[] {
  assertRisksAreAnchored(risks);
  const out: PreparedQuestion[] = [];

  for (const risk of risks) {
    if (out.length >= MAX_PREPARED_QUESTIONS) break;
    const category = QUESTION_CATEGORY_FOR_KIND[risk.kind];
    const stem = QUESTION_STEM_FOR_KIND[risk.kind];
    // Only claims that ACTUALLY EXIST are named. A `groundedClaimIds` entry the caller could
    // not resolve is dropped rather than trusted, which makes the grounding SMALLER and so
    // makes the post-check stricter - the fail-closed direction, deliberately.
    const groundedClaimIds = risk.groundedClaimIds.filter((id) => context.claims.has(id));
    const focus = context.focusByRiskKey?.get(risk.key) ?? risk.focus;

    const draft: QuestionDraft = {
      questionId: `${risk.key}#${category}`,
      riskKey: risk.key,
      kind: risk.kind,
      severity: risk.severity,
      category,
      question: `${stem} ${risk.statement}`,
      requirementId: risk.requirementId,
      groundedClaimIds: Object.freeze(groundedClaimIds),
      focus,
      // The answerability test is the GROUNDED CLAIMS, not the amount of text. A `gap` risk
      // carries the requirement's own wording as its only grounding, so a text count would say
      // "answerable" and then refuse every sentence of substance: any answer a person could
      // give to "what have you done with Kafka" names something the requirement does not. Zero
      // grounded CLAIMS is the honest test - see the header.
      groundingSize: groundedClaimIds.length,
    };
    assertQuestionIsAnchored(draft);

    out.push({
      questionId: draft.questionId,
      riskKey: draft.riskKey,
      kind: draft.kind,
      severity: draft.severity,
      category: draft.category,
      question: draft.question,
      requirementId: draft.requirementId,
      groundedClaimIds: draft.groundedClaimIds,
      focus,
      modelAnswer: null,
      // No grounded claim, no answer, and NO provider call. The question and its focus are
      // still the output, and they are the useful part of a gap.
      answerStage:
        groundedClaimIds.length === 0
          ? {
              status: 'skipped',
              reason: 'no_grounded_evidence',
              provider: null,
              model: null,
              attempts: 0,
              rejectedEntities: [],
              dropped: [],
            }
          : notEvaluatedAnswerStage(),
    });
  }

  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// The provider, shared by the two stages
// ---------------------------------------------------------------------------

/** What a proposer returns: either a parsed response, or a machine-readable reason. */
export interface ProviderOutcome<T> {
  status: 'applied' | 'skipped';
  reason: AnswerReason;
  provider: string | null;
  model: string | null;
  responses: T | null;
}

/**
 * One structured call, with E.8's "one retry on schema failure".
 *
 * The system message is STATIC and carries none of the caller's content, so a job description
 * that says "ignore previous instructions" is quoted material in the USER message rather than
 * an instruction in the system message (E.9 mitigation 1). `response_format: json_object` and a
 * zod schema mean an injected instruction that produces prose fails the parse.
 *
 * NO KEY IS NOT AN ERROR: `leaseNextLlmKey` throwing is reported as
 * `no_ai_provider_configured` and the caller keeps everything it had (ADR-041 D5). Nothing in
 * this function invents a fallback answer - there is no fallback answer to invent.
 */
async function askProvider<T>(input: {
  userId: string;
  promptName: string;
  promptVars: Record<string, string>;
  schema: z.ZodType<T>;
  /** The system message. Static; must not interpolate caller content. */
  system: string;
  envOverride: string | undefined;
  maxTokens: number;
}): Promise<ProviderOutcome<T>> {
  let key;
  try {
    key = await leaseNextLlmKey(input.userId);
  } catch {
    return {
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      provider: null,
      model: null,
      responses: null,
    };
  }
  const provider = key.provider;
  let reportedModel: string | null = null;
  try {
    // A `const`, not the outer `let`: the closure below captures it, and a `let` would widen
    // back to `string | null` inside the callback - which is the same shape `match/potential.ts`
    // keeps its resolved model in.
    const model = await getProviderModel(key.provider, { envOverride: input.envOverride });
    reportedModel = model;
    const client = createLlmClient(key);
    const prompt = loadAndRender(input.promptName, input.promptVars);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await runLlmCompletion(provider, model, () =>
        client.chat.completions.create({
          model,
          max_tokens: input.maxTokens,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: prompt },
          ],
        }),
      );
      const content = response.choices[0]?.message?.content ?? '';
      const json = extractJson(content);
      if (json === null) continue;
      try {
        const parsed = input.schema.safeParse(JSON.parse(json));
        if (parsed.success) {
          await markKeySuccess(key).catch(() => {});
          return { status: 'applied', reason: 'ok', provider, model, responses: parsed.data };
        }
      } catch {
        // Unparseable JSON: fall through to the schema retry, then to `provider_unavailable`.
      }
    }
    await markKeyFailure(key, false).catch(() => {});
    return {
      status: 'skipped',
      reason: 'provider_unavailable',
      provider,
      model: reportedModel,
      responses: null,
    };
  } catch (error) {
    await markKeyFailure(key, isRateLimitError(error)).catch(() => {});
    return {
      status: 'skipped',
      reason: 'provider_unavailable',
      provider,
      model: reportedModel,
      responses: null,
    };
  }
}

/** The first JSON object in a completion, or `null`. Never throws on malformed output. */
function extractJson(text: string): string | null {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.startsWith('{')) {
    const end = trimmed.lastIndexOf('}');
    return end > 0 ? trimmed.slice(0, end + 1) : null;
  }
  const match = /\{[\s\S]*\}/.exec(trimmed);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Stage 1: the risk brief (`interview_risk_v1.jinja`)
// ---------------------------------------------------------------------------

/** The schema version each structured call declares, as E.8 requires. */
export const INTERVIEW_RISK_SCHEMA_VERSION = 'interview_risk_v1' as const;
export const INTERVIEW_QUESTION_SCHEMA_VERSION = 'interview_question_v1' as const;

const briefSchema = z.object({
  schemaVersion: z.string().optional(),
  focuses: z
    .array(
      z.object({
        riskKey: z.string().optional().nullable(),
        focus: z.string().optional().nullable(),
      }),
    )
    .optional(),
});

export type RiskBriefResponses = z.infer<typeof briefSchema>;

export interface RiskBriefInput {
  userId: string;
  risks: readonly DerivedRisk[];
  /** The grounded claim statements, rendered `id | statement`. */
  groundedEvidence: string;
}

export type RiskBriefProposer = (input: RiskBriefInput) => Promise<ProviderOutcome<RiskBriefResponses>>;

const defaultRiskBriefProposer: RiskBriefProposer = (input) =>
  askProvider<RiskBriefResponses>({
    userId: input.userId,
    promptName: INTERVIEW_RISK_SCHEMA_VERSION,
    promptVars: {
      risks: renderRiskBriefTable(input.risks),
      grounded_claims: input.groundedEvidence,
      max_risks: String(MAX_BRIEF_RISKS),
    },
    schema: briefSchema,
    system: 'You are an interview-prep reviewer. Reply with one JSON object.',
    envOverride: process.env.INTERVIEW_RISK_BRIEF_MODEL,
    maxTokens: 2000,
  });

let riskBriefProposer: RiskBriefProposer = defaultRiskBriefProposer;

/** Install a different brief stage (an adapter, a test). `null` restores the shipped default. */
export function setRiskBriefProposer(next: RiskBriefProposer | null): void {
  riskBriefProposer = next ?? defaultRiskBriefProposer;
}

/** Re-exported so a test or an adapter can reach the shipped default directly. */
export const shippedRiskBriefProposer = defaultRiskBriefProposer;

/** Severity, worst first. The brief stage's table is ordered so `high` rows come first. */
function severityRank(severity: Severity): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2;
}

/** The brief stage's table: `key | kind | severity | statement`, worst risk first. */
export function renderRiskBriefTable(risks: readonly DerivedRisk[]): string {
  const lines = [...risks]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, MAX_BRIEF_RISKS)
    .map((risk) => `${risk.key} | ${risk.kind} | ${risk.severity} | ${risk.statement}`);
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

export interface RiskBriefStageView {
  readonly status: 'applied' | 'skipped';
  readonly reason: AnswerReason;
  readonly provider: string | null;
  readonly model: string | null;
  /** How many derived risks a sharpening was ACCEPTED for. */
  readonly appliedCount: number;
  /** What the guard refused, with the reason. Never silently discarded. */
  readonly dropped: ReadonlyArray<{ reason: string; detail: string }>;
}

/** Every way a sharpening is discarded. Closed, for the same reason the op codes are. */
export const BRIEF_DROP_REASONS = Object.freeze([
  /** `riskKey` is absent, blank, or not a risk the server derived. It cannot CREATE one. */
  'unknown_risk',
  /** The focus is absent, or blank after whitespace is collapsed. */
  'no_focus',
  /** The same risk twice in one response; the first wins. */
  'duplicate',
  /** The focus names an entity the risk's own grounding does not contain. */
  'ungrounded_entity',
] as const);

export type BriefDropReason = (typeof BRIEF_DROP_REASONS)[number];

export interface RiskBriefGuardResult {
  focusByRiskKey: Map<string, string>;
  dropped: Array<{ reason: BriefDropReason; detail: string }>;
}

/**
 * The brief stage's deterministic guard.
 *
 * IT CANNOT CREATE A RISK, AND THAT IS THE POINT OF THE WHOLE STAGE. The allowed keys are
 * exactly the ones the server derived, so a `riskKey` outside them is dropped: the sharpest
 * possible answer to "where did this leak come from" would otherwise be "here is a risk you
 * did not have", which is the risk stage guessing - the one thing ruling 1 forbids.
 *
 * `ungrounded_entity` runs the SAME post-check on the prose that surrounds the answers, which
 * is why it is cheap to justify: a sharpened focus that names a company nobody mentioned is as
 * much a fabrication as an answer that does, and it would be stored next to the question.
 */
export function guardRiskBrief(
  responses: RiskBriefResponses | null,
  risks: readonly DerivedRisk[],
  claims: ReadonlyMap<string, GroundedClaimText>,
  requirements: ReadonlyMap<string, GroundedRequirementText>,
): RiskBriefGuardResult {
  const focusByRiskKey = new Map<string, string>();
  const dropped: Array<{ reason: BriefDropReason; detail: string }> = [];
  if (responses === null) return { focusByRiskKey, dropped };

  const riskByKey = new Map(risks.map((risk) => [risk.key, risk] as const));
  for (const row of responses.focuses ?? []) {
    const riskKey = typeof row.riskKey === 'string' ? row.riskKey.trim() : '';
    const risk = riskByKey.get(riskKey);
    if (riskKey.length === 0 || !risk) {
      dropped.push({
        reason: 'unknown_risk',
        detail: riskKey.length === 0 ? '(missing)' : riskKey,
      });
      continue;
    }
    const focus = typeof row.focus === 'string' ? row.focus.replace(/\s+/g, ' ').trim() : '';
    if (focus.length === 0) {
      dropped.push({ reason: 'no_focus', detail: riskKey });
      continue;
    }
    if (focusByRiskKey.has(riskKey)) {
      dropped.push({ reason: 'duplicate', detail: riskKey });
      continue;
    }
    const verdict = checkGroundedAnswer({
      answer: focus,
      groundedClaimIds: risk.groundedClaimIds.filter((id) => claims.has(id)),
      claims,
      requirementId: risk.requirementId,
      requirements,
    });
    if (!verdict.grounded) {
      dropped.push({ reason: 'ungrounded_entity', detail: riskKey });
      continue;
    }
    focusByRiskKey.set(riskKey, focus.slice(0, MAX_MODEL_ANSWER_CHARS));
  }

  return { focusByRiskKey, dropped };
}

// ---------------------------------------------------------------------------
// Stage 2: the model answer (`interview_question_v1.jinja`)
// ---------------------------------------------------------------------------

const answerSchema = z.object({
  schemaVersion: z.string().optional(),
  answers: z
    .array(
      z.object({
        questionId: z.string().optional().nullable(),
        modelAnswer: z.string().optional().nullable(),
      }),
    )
    .optional(),
});

export type AnswerResponses = z.infer<typeof answerSchema>;

export interface AnswerPromptQuestion {
  questionId: string;
  question: string;
  category: QuestionCategory;
  /** The risk or requirement this question is anchored to, for the prompt's context column. */
  anchor: string;
}

export interface AnswerProposerInput {
  userId: string;
  questions: readonly AnswerPromptQuestion[];
  /** The grounded claim statements, rendered `id | statement`. */
  groundedEvidence: string;
  /**
   * The entities the previous attempt named and was refused for. EMPTY on attempt 1 and
   * rendered back to the proposer on attempt 2, which is the whole mechanism of "regenerate
   * once": the retry is TOLD what to avoid rather than merely repeated.
   */
  refusedEntities: readonly string[];
}

export type AnswerProposer = (input: AnswerProposerInput) => Promise<ProviderOutcome<AnswerResponses>>;

const defaultAnswerProposer: AnswerProposer = (input) =>
  askProvider<AnswerResponses>({
    userId: input.userId,
    promptName: INTERVIEW_QUESTION_SCHEMA_VERSION,
    promptVars: {
      questions: renderAnswerQuestionTable(input.questions),
      grounded_claims: input.groundedEvidence,
      previously_refused_entities:
        input.refusedEntities.length > 0 ? input.refusedEntities.join(', ') : '(none)',
      max_questions: String(MAX_PREPARED_QUESTIONS),
    },
    schema: answerSchema,
    system: 'You are an interview answer coach. Reply with one JSON object.',
    envOverride: process.env.INTERVIEW_ANSWER_MODEL,
    maxTokens: 3000,
  });

let answerProposer: AnswerProposer = defaultAnswerProposer;

/** Install a different answer proposer (an adapter, a test). `null` restores the default. */
export function setAnswerProposer(next: AnswerProposer | null): void {
  answerProposer = next ?? defaultAnswerProposer;
}

/** Re-exported so a test or an adapter can reach the shipped default directly. */
export const shippedAnswerProposer = defaultAnswerProposer;

/** The questions as a prompt table: `id | category | anchor | question`. */
export function renderAnswerQuestionTable(questions: readonly AnswerPromptQuestion[]): string {
  const lines = questions
    .slice(0, MAX_PREPARED_QUESTIONS)
    .map((row) => `${row.questionId} | ${row.category} | ${row.anchor} | ${row.question}`);
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

/** The grounded evidence as a prompt list: `id | statement`. Never the whole profile. */
export function renderGroundedEvidence(
  claimIds: readonly string[],
  claims: ReadonlyMap<string, GroundedClaimText>,
): string {
  const lines = [...new Set(claimIds)]
    .filter((id) => claims.has(id))
    .slice(0, MAX_GROUNDING_CLAIMS)
    .map((id) => `${id} | ${claims.get(id)?.statement ?? ''}`);
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

/**
 * Answer the questions, applying the post-check and regenerating at most ONCE.
 *
 * THE ORDER IS THE CONTRACT:
 *   1. only questions that HAVE GROUNDING are asked. A `gap` question was already
 *      `skipped/no_grounded_evidence` by `buildQuestions` and is never sent, so a provider call
 *      can never be spent on an answer that could only be refused;
 *   2. each returned answer passes the STRUCTURAL guard first (known id, non-empty text, no
 *      duplicates), so the post-check is never asked about an answer that was not ours;
 *   3. each surviving answer passes `checkGroundedAnswer`;
 *   4. every question whose answer was REFUSED goes back ONCE, with the refused entities named
 *      back to the proposer. A refusal is not repaired, it is re-asked;
 *   5. a second refusal stores the question with NO answer and records the refusal.
 *
 * "A QUESTION THE PROPOSER IGNORED" IS TREATED AS A REFUSAL, NOT A SUCCESS. A proposer that
 * answers two of four questions has not answered four questions, and storing three with a
 * blank would report silence as an absence of findings. The ignored question gets the one
 * regeneration and, if it is ignored again, is stored with no answer and the
 * `ungrounded_entities_after_regeneration` reason - which is the honest description of what
 * happened even though nothing ungrounded was actually named.
 *
 * IT RETURNS THE QUESTIONS, NOT A SIDE TABLE: a caller cannot pair an answer with the wrong
 * question, and each question's `answerStage` travels with it wherever it is persisted.
 */
export async function answerQuestions(
  questions: readonly PreparedQuestion[],
  context: {
    userId: string;
    claims: ReadonlyMap<string, GroundedClaimText>;
    requirements: ReadonlyMap<string, GroundedRequirementText>;
  },
): Promise<PreparedQuestion[]> {
  const answerable = questions.filter(
    (question) => question.answerStage.reason !== 'no_grounded_evidence',
  );
  if (answerable.length === 0) return [...questions];

  const claimIds = [...new Set(answerable.flatMap((question) => [...question.groundedClaimIds]))];
  const groundedEvidence = renderGroundedEvidence(claimIds, context.claims);
  const byQuestionId = new Map(answerable.map((question) => [question.questionId, question]));
  const promptById = new Map<string, AnswerPromptQuestion>(
    answerable.map((question) => [
      question.questionId,
      {
        questionId: question.questionId,
        question: question.question,
        category: question.category,
        anchor: question.riskKey ?? question.requirementId ?? '(none)',
      },
    ]),
  );

  /** What ends up stored, per question id. */
  const resolved = new Map<string, PreparedQuestion>();
  /** Still unanswered after the current attempt. */
  let pending: string[] = answerable.map((question) => question.questionId);
  /** The refused entities of the current attempt, handed back on the next one. */
  let refusedEntities: string[] = [];
  /** Each question's LAST refusal, so the stored report says what was wrong with it. */
  const lastRejection = new Map<string, string[]>();
  const dropped: Array<{ reason: AnswerDropReason; detail: string }> = [];
  let provenance: { provider: string | null; model: string | null } = {
    provider: null,
    model: null,
  };
  let unreachableStage: AnswerStageView | null = null;

  for (let attempt = 1; attempt <= MAX_ANSWER_ATTEMPTS && pending.length > 0; attempt += 1) {
    const asked = pending
      .map((id) => promptById.get(id))
      .filter((row): row is AnswerPromptQuestion => row !== undefined);
    if (asked.length === 0) break;

    const outcome = await answerProposer({
      userId: context.userId,
      questions: asked,
      groundedEvidence,
      refusedEntities,
    });
    provenance = { provider: outcome.provider, model: outcome.model };

    if (outcome.status !== 'applied' || outcome.responses === null) {
      // NO PROVIDER, A FAILED CALL, OR TWO SCHEMA FAILURES. `pending` is NOT cleared here: the
      // loop's tail applies `unreachableStage` to whatever is still pending, which is how a
      // skipped stage reaches the questions at all. Clearing it would leave every one of them
      // on `not_evaluated` - a state that says "nobody asked" when somebody did ask and got
      // nothing back.
      unreachableStage = {
        status: 'skipped',
        reason: outcome.reason === 'ok' ? 'provider_unavailable' : outcome.reason,
        provider: outcome.provider,
        model: outcome.model,
        attempts: attempt,
        rejectedEntities: [],
        dropped: [],
      };
      break;
    }

    const returned = new Map<string, string>();
    for (const row of outcome.responses.answers ?? []) {
      const questionId = typeof row.questionId === 'string' ? row.questionId.trim() : '';
      if (questionId.length === 0 || !promptById.has(questionId)) {
        dropped.push({ reason: 'unknown_question', detail: questionId || '(missing)' });
        continue;
      }
      if (returned.has(questionId)) {
        dropped.push({ reason: 'duplicate', detail: questionId });
        continue;
      }
      const text =
        typeof row.modelAnswer === 'string' ? row.modelAnswer.replace(/\s+/g, ' ').trim() : '';
      if (text.length === 0) {
        dropped.push({ reason: 'no_answer', detail: questionId });
        continue;
      }
      returned.set(questionId, text);
    }

    const stillPending: string[] = [];
    for (const questionId of pending) {
      const question = byQuestionId.get(questionId);
      if (!question) continue;
      const text = returned.get(questionId);
      if (text === undefined) {
        lastRejection.set(questionId, []);
        stillPending.push(questionId);
        continue;
      }
      const verdict = checkGroundedAnswer({
        answer: text,
        groundedClaimIds: question.groundedClaimIds,
        claims: context.claims,
        requirementId: question.requirementId,
        requirements: context.requirements,
      });
      if (!verdict.grounded) {
        lastRejection.set(questionId, [...verdict.ungroundedNames]);
        stillPending.push(questionId);
        continue;
      }
      resolved.set(questionId, {
        ...question,
        modelAnswer: text.slice(0, MAX_MODEL_ANSWER_CHARS),
        answerStage: {
          status: 'answered',
          reason: 'ok',
          provider: outcome.provider,
          model: outcome.model,
          attempts: attempt,
          rejectedEntities: [],
          dropped: [],
        },
      });
    }

    refusedEntities = [
      ...new Set(stillPending.flatMap((id) => lastRejection.get(id) ?? [])),
    ].sort();
    pending = stillPending;
  }

  // Whatever is still pending has now been refused (or ignored) TWICE. It is stored with NO
  // answer and the refusal on the record: the fail-closed end of E.8 stage 11.
  for (const questionId of pending) {
    const question = byQuestionId.get(questionId);
    if (!question) continue;
    const skipped = unreachableStage;
    resolved.set(questionId, {
      ...question,
      modelAnswer: null,
      answerStage: skipped ?? {
        status: 'rejected',
        reason: 'ungrounded_entities_after_regeneration',
        provider: provenance.provider,
        model: provenance.model,
        attempts: MAX_ANSWER_ATTEMPTS,
        rejectedEntities: Object.freeze(lastRejection.get(questionId) ?? []),
        dropped: Object.freeze(dropped),
      },
    });
  }

  return questions.map((question) => resolved.get(question.questionId) ?? question);
}

// ---------------------------------------------------------------------------
// The orchestration the route calls
// ---------------------------------------------------------------------------

export interface PrepareInput {
  userId: string;
  risks: readonly DerivedRisk[];
  claims: ReadonlyMap<string, GroundedClaimText>;
  requirements: ReadonlyMap<string, GroundedRequirementText>;
  /**
   * `false` runs the DETERMINISTIC-ONLY path: the questions are built, no provider is asked,
   * and every answer stays `not_evaluated`. This is the same code path the no-key case takes,
   * exposed so a test - or an operator running locally - can prove it without a key.
   */
  runProvider?: boolean;
}

export interface PreparedInterview {
  questions: readonly PreparedQuestion[];
  briefStage: RiskBriefStageView;
}

/**
 * RISKS -> QUESTIONS -> ANSWERS, in that order, with each stage's report returned.
 *
 * THE BRIEF STAGE RUNS FIRST BECAUSE THE QUESTIONS CARRY THE FOCUS. A sharpened focus is what
 * the person reads under the question, so building the questions first and sharpening after
 * would leave the stored question pointing at prose nobody sees.
 *
 * WITH NO PROVIDER BOTH STAGES SKIP AND NOTHING IS LOST: the questions are already built and
 * anchored, the risks are already derived and anchored, and the answer stage says why there is
 * no answer instead of inventing one.
 */
export async function prepareInterview(input: PrepareInput): Promise<PreparedInterview> {
  const risks = assertRisksAreAnchored(input.risks);
  const claimIds = [...new Set(risks.flatMap((risk) => risk.groundedClaimIds))].filter((id) =>
    input.claims.has(id),
  );

  if (input.runProvider === false || risks.length === 0) {
    return {
      questions: buildQuestions(risks, { claims: input.claims, requirements: input.requirements }),
      briefStage: {
        status: 'skipped',
        reason: 'not_evaluated',
        provider: null,
        model: null,
        appliedCount: 0,
        dropped: [],
      },
    };
  }

  const outcome = await riskBriefProposer({
    userId: input.userId,
    risks,
    groundedEvidence: renderGroundedEvidence(claimIds, input.claims),
  });
  const guarded = guardRiskBrief(outcome.responses, risks, input.claims, input.requirements);
  const briefStage: RiskBriefStageView = {
    status: outcome.status,
    reason: outcome.reason,
    provider: outcome.provider,
    model: outcome.model,
    appliedCount: guarded.focusByRiskKey.size,
    dropped: Object.freeze(guarded.dropped),
  };

  const questions = buildQuestions(risks, {
    claims: input.claims,
    requirements: input.requirements,
    focusByRiskKey: guarded.focusByRiskKey,
  });
  const answered = await answerQuestions(questions, {
    userId: input.userId,
    claims: input.claims,
    requirements: input.requirements,
  });

  return { questions: answered, briefStage };
}