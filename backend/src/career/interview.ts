// =====================================================================================
// career/interview.ts - THE CAREER INTERVIEW: answers become CANDIDATE CLAIMS, never a
// resume (T1021; ADR-036 item 2, ADR-041 D5, 06-design sec.E.8 stage 2, sec.E.11 flow 2).
//
// WHAT THIS MODULE IS. Pipeline stage 2. The user answers a short, FIXED questionnaire; a
// provider is asked to turn those answers into atomic claims; every claim that survives
// the deterministic guards is written through `career/claimWriterAI`, which is the ONLY
// path by which model output becomes a `CareerClaim` (ADR-036 item 2). The wizard then
// hands the user to the verification list (`GET /career/claims`), where a HUMAN - not this
// file, not the model - decides anything. Nothing here writes a `Resume` row, and there is
// no code path in this module that can.
//
// THREE PROMISES, AND WHERE EACH ONE IS KEPT:
//
//   1. NO PROVIDER IS AN HONEST REFUSAL, NOT A DEGRADED FEATURE. `leaseInterviewProvider`
//      is the ONE place that decides whether a provider exists, and it throws
//      `interview_provider_required` when none does. The route maps that to 503 and the UI
//      points at the manual path (`POST /career/claims`, T1020/T1054). There is NO
//      deterministic stand-in extractor shipped here: a template questionnaire that
//      pretends to be the AI interview is the fabricating wizard this stage replaces, and
//      it would be worse than an error because it looks like it worked.
//
//   2. A SCHEMA FAILURE IS A HARD FAILURE. The response must parse against
//      `CLAIM_EXTRACT_SCHEMA` (`{ claims: [{ kind, statement, confidence }] }`). Anything
//      else is `interview_schema_invalid` and the request fails. There is ONE provider
//      attempt and NO salvage: E.8's generic "one retry on schema failure" is deliberately
//      NOT applied here, because a retry whose answer the server then accepts is an
//      invitation to talk a model into the shape, and the whole point of the check is that
//      the SERVER decides what a claim is. A retry belongs where the model's freedom is
//      harmless (interview-prep answers); here the output IS the user's career record.
//
//   3. EVERY PRODUCED CLAIM IS `inferred` + `llm_inferred`, AND IT SURVIVES THREE CHECKS.
//      `guardExtractedClaims` runs the contract's deterministic validation on every claim
//      and is FAIL-CLOSED PER CLAIM: a bad claim is DROPPED with a machine-readable reason
//      and the response says what was dropped and why, rather than the whole batch failing
//      or - far worse - the bad claim being stored. The three checks are:
//        (a) `kind` is a `ClaimKind` enum value;
//        (b) the statement is within a length bound (`MIN_STATEMENT_CHARS` /
//            `MAX_STATEMENT_CHARS`) and `confidence` is a finite number in [0,1];
//        (c) NO INVENTED EMPLOYER, DATE, TECHNOLOGY OR NUMBER. The entity check is
//            `tailor/factDelta.ts`'s - the same extractor the tailoring fact-delta guard
//            and `interview/questions.ts`'s grounding post-check use - and the grounding is
//            THE USER'S OWN ANSWER TEXT, nothing else.
//
// THE GROUNDING IS THE ANSWER VALUES AND ONLY THE ANSWER VALUES. Deliberate: the block the
// MODEL reads (`renderAnswerBlock`) carries the field labels too, so it knows which answer
// is which, and the guard's grounding (`answerGrounding`) does not - because a hint reading
// "e.g. Senior Engineer at Acme" would otherwise put "Acme" into the grounding and let a
// claim naming an employer the user never typed through the check. The two are separate
// functions so a future edit cannot quietly merge them.
//
// THE STORE SEAM IS INJECTED (`CareerClaimStore`); no module under `backend/src/career/`
// imports the `prisma` singleton (`career/claimWriterAI.test.ts` asserts it). This module
// imports nothing about HTTP either: the envelope work, the ownership check and the status
// codes all live in `routes/career.ts`.
//
// WHERE THE PROVIDER CALL LIVES, AND WHY IT IS HERE. `career/resumeImport.ts` keeps
// providers out of the career layer because its deterministic half is the PRIMARY path and a
// missing provider must degrade (ADR-041 D5). The interview has no deterministic half: the
// ruling for T1021 is that with no provider it REFUSES, so the module that must be able to
// say "there is no provider" is the module that owns the provider call. It sits behind an
// injectable seam (`setCareerInterviewExtractor`) with a shipped default, exactly the shape
// `match/potential.ts#setContextualProposer` and `interview/questions.ts` already use, so
// an adapter, a test and a live harness can all drive the stage without a network.
// =====================================================================================

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ClaimKind, ClaimProvenance, ClaimStatus } from '@prisma/client';

import { loadAndRender } from '../ats/promptLoader.js';
import {
  isRateLimitError,
  leaseNextLlmKey,
  markKeyFailure,
  markKeySuccess,
  type KeyRecord,
} from '../ai/keyManager.js';
import { createLlmClient, getProviderModel, runLlmCompletion } from '../ai/providerModels.js';
import { detectFactDelta, extractFacts, factsOfTexts } from '../tailor/factDelta.js';

import { writeInferredClaims } from './claimWriterAI.js';
import { isClaimKind, normalizeStatement, type CareerClaimStore } from './claims.js';

// ---------------------------------------------------------------------------
// Vocabulary + bounds
// ---------------------------------------------------------------------------

/** The prompt that frames the stage: the SYSTEM message. See the header's E.9 note. */
export const CAREER_INTERVIEW_SCHEMA_VERSION = 'career_interview_v1' as const;
/** The prompt that carries the answers and names the output shape: the USER message. */
export const CLAIM_EXTRACT_SCHEMA_VERSION = 'claim_extract_v1' as const;

/** `InferenceMethod` recorded on every claim this stage writes (05 sec.4). */
export const CAREER_INTERVIEW_INFERENCE_METHOD = 'career_interview';

/**
 * Echoed by the route so a client can prove what the rows carry without the ROUTE naming a
 * status or a provenance (the router's own source guard forbids it - the vocabulary belongs
 * to this directory).
 */
export const CAREER_INTERVIEW_STATUS = ClaimStatus.inferred;
export const CAREER_INTERVIEW_PROVENANCE = ClaimProvenance.llm_inferred;

/** Cap on the answers accepted in one submission. */
export const MAX_INTERVIEW_ANSWERS = 24;
/** Cap on the claims read back from one response. */
export const MAX_INTERVIEW_CLAIMS = 24;
/** Cap on one answer's length. Longer input is refused, never silently truncated. */
export const MAX_INTERVIEW_ANSWER_CHARS = 4_000;
/** The statement-length bound the contract names (06 sec. E.8, stage 2). */
export const MIN_STATEMENT_CHARS = 4;
export const MAX_STATEMENT_CHARS = 400;
/** A session id is `iv1.` + 32 hex characters. */
const SESSION_ID_PATTERN = /^iv1\.[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CareerInterviewErrorCode =
  /** No BYOK key and no env key for ANY LLM provider. The interview cannot run. */
  | 'interview_provider_required'
  /** A key existed and the call failed (network, rate limit, empty completion). */
  | 'interview_provider_unavailable'
  /** The model's output did not validate. Hard failure: nothing is salvaged. */
  | 'interview_schema_invalid'
  /** The submission cannot be acted on as written (no answers, unknown field, bad id). */
  | 'interview_invalid_input';

/** A refusal by the interview stage. `code` is what the route and the client branch on. */
export class CareerInterviewError extends Error {
  readonly code: CareerInterviewErrorCode;

  constructor(code: CareerInterviewErrorCode, message: string) {
    super(message);
    this.name = 'CareerInterviewError';
    this.code = code;
  }
}

/** The refusal the "no provider" case always carries, in the words a person can act on. */
export const PROVIDER_REQUIRED_MESSAGE =
  'the Career Interview needs an AI provider: add a BYOK key in Settings, or add your statements by hand on the Career Evidence page (this interview will not invent them for you)';

/** Why an extractor did not produce a usable response. Closed, so a client can branch. */
export type InterviewExtractionReason =
  | 'ok'
  | 'no_ai_provider_configured'
  | 'provider_unavailable'
  | 'schema_invalid';

// ---------------------------------------------------------------------------
// The questionnaire (deterministic - the server asks, never the model)
// ---------------------------------------------------------------------------

export interface CareerInterviewField {
  /** Stable id. Part of the answer key and of the prompt's rendering. */
  readonly id: string;
  readonly label: string;
  /** One line telling the user what belongs here. Shown above the input. */
  readonly hint: string;
  readonly required: boolean;
}

export interface CareerInterviewStep {
  readonly id: string;
  readonly title: string;
  /** One line of framing for the step. Never a claim about the user. */
  readonly summary: string;
  readonly fields: readonly CareerInterviewField[];
}

/**
 * The FIVE steps of 06 sec. E.11 flow 2, written out.
 *
 * WHY THEY ARE HERE AND NOT ASKED FOR BY A MODEL: a questionnaire the server owns is
 * answerable, translatable and diffable, and one a model writes changes under the user with
 * every provider, leaving nothing to test. It is also what makes "no provider" a clean
 * refusal - the ONLY thing a provider is needed for here is turning these answers into
 * atomic claims, which is exactly what is skipped when there is no key.
 *
 * The steps ask for FACTS THE USER HAS, never for a summary of their life. A model handed
 * "describe yourself" will produce a sentence with an employer in it that nobody typed, so
 * every hint names a shape (a list of things you did, the tools you used) rather than an
 * aspiration. Two fields per step keeps each screen short enough to finish.
 */
export const CAREER_INTERVIEW_STEPS: readonly CareerInterviewStep[] = Object.freeze([
  {
    id: 'roles',
    title: 'Your roles',
    summary:
      'The positions you have held and who you held them with. One line per role, in the order you want them read.',
    fields: [
      {
        id: 'roles',
        label: 'Roles',
        hint: 'e.g. Senior Engineer at Acme, 2021 to now; Engineer at Globex, 2018 to 2021',
        required: true,
      },
      {
        id: 'employers',
        label: 'Employers',
        hint: 'Every organisation you name above, one per line, spelled the way you write it.',
        required: false,
      },
    ],
  },
  {
    id: 'tools',
    title: 'What you work with',
    summary: 'The tools, languages and platforms you actually use day to day.',
    fields: [
      {
        id: 'technologies',
        label: 'Technologies',
        hint: 'e.g. TypeScript, Postgres, Kubernetes. Only what you have used.',
        required: true,
      },
      {
        id: 'skills',
        label: 'Skills',
        hint: 'Things you can do rather than things you have touched: e.g. running an on-call rotation.',
        required: false,
      },
    ],
  },
  {
    id: 'work',
    title: 'What you actually did',
    summary:
      'The work itself. This is the step the rest of your resume is built from, so numbers are worth a lot here.',
    fields: [
      {
        id: 'achievements',
        label: 'Things you did',
        hint: 'One per line, with what changed because of it: e.g. cut the CI build time by 40%.',
        required: true,
      },
      {
        id: 'responsibilities',
        label: 'What you were responsible for',
        hint: 'e.g. owned the ledger reconciliation service end to end',
        required: false,
      },
    ],
  },
  {
    id: 'background',
    title: 'Projects, study and certifications',
    summary: 'Anything with a name a reader could look up.',
    fields: [
      {
        id: 'projects',
        label: 'Projects',
        hint: 'e.g. LedgerKit - a reconciliation library three teams used',
        required: false,
      },
      {
        id: 'education',
        label: 'Education',
        hint: 'e.g. BSc Computer Science, University of London',
        required: false,
      },
      {
        id: 'certifications',
        label: 'Certifications',
        hint: 'e.g. AWS Solutions Architect Associate',
        required: false,
      },
    ],
  },
  {
    id: 'working',
    title: 'How you work',
    summary: 'The last step: how you work, and the one-line version of what you are after.',
    fields: [
      {
        id: 'working_style',
        label: 'How you work',
        hint: 'e.g. prefer small PRs, wrote the runbooks I relied on',
        required: true,
      },
      {
        id: 'summary',
        label: 'One line about you',
        hint: 'How you would describe your work in a sentence. Not a job title.',
        required: false,
      },
    ],
  },
]);

/** The wizard's stepper count, so the UI has one number to render and one to test. */
export const CAREER_INTERVIEW_TOTAL_STEPS = CAREER_INTERVIEW_STEPS.length;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export interface InterviewAnswerInput {
  readonly stepId: string;
  readonly fieldId: string;
  readonly value: string;
}

export interface InterviewAnswer {
  readonly stepId: string;
  readonly fieldId: string;
  readonly value: string;
}

function knownFieldIds(): Map<string, Set<string>> {
  return new Map(
    CAREER_INTERVIEW_STEPS.map((step) => [
      step.id,
      new Set(step.fields.map((field) => field.id)),
    ] as const),
  );
}

/**
 * The submitted answers, in the shape the prompt and the guard both read.
 *
 * VALIDATED HERE RATHER THAN IN `shared/validation.ts`, for two reasons: it keeps the
 * questionnaire and the rules about answering it in ONE module (a new step and its rules
 * cannot drift apart), and it keeps this stage's refusal vocabulary in one place - an
 * unanswerable submission is `interview_invalid_input`, which the route maps to 400.
 *
 * Every rule fails closed:
 * - a `stepId`/`fieldId` that is not in `CAREER_INTERVIEW_STEPS` is REFUSED. An unknown
 *   field is either a typo or an attempt to smuggle text past the questionnaire, and a
 *   guard that only validated what it recognised would pass the second one through;
 * - an answer longer than `MAX_INTERVIEW_ANSWER_CHARS` is refused, never truncated (a
 *   truncated answer would license a claim about half a sentence);
 * - a blank value is DROPPED, so an untouched optional field is not an error;
 * - a REQUIRED field left blank refuses the whole submission, because the model is about
 *   to be asked to extract from it;
 * - more than `MAX_INTERVIEW_ANSWERS` answers is refused.
 *
 * De-duplication is by `stepId.fieldId` with LAST value winning, which is what a form that
 * posts its whole state on every step means.
 */
export function normalizeInterviewAnswers(raw: unknown): InterviewAnswer[] {
  const invalid = (message: string): CareerInterviewError =>
    new CareerInterviewError('interview_invalid_input', message);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('answers must be an array of { stepId, fieldId, value }');
  }
  const list = (raw as { answers?: unknown }).answers;
  if (!Array.isArray(list)) {
    throw invalid('answers must be an array of { stepId, fieldId, value }');
  }
  if (list.length > MAX_INTERVIEW_ANSWERS) {
    throw invalid(`too many answers: at most ${MAX_INTERVIEW_ANSWERS}`);
  }

  const fields = knownFieldIds();
  const byKey = new Map<string, InterviewAnswer>();

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalid('each answer must be an object of { stepId, fieldId, value }');
    }
    const { stepId, fieldId, value } = entry as Record<string, unknown>;
    if (typeof stepId !== 'string' || typeof fieldId !== 'string' || typeof value !== 'string') {
      throw invalid('each answer needs string stepId, fieldId and value members');
    }
    if (!fields.has(stepId)) {
      throw invalid(`unknown interview step: ${stepId}`);
    }
    if (!fields.get(stepId)?.has(fieldId)) {
      throw invalid(`unknown interview field: ${stepId}.${fieldId}`);
    }
    if (value.length > MAX_INTERVIEW_ANSWER_CHARS) {
      throw invalid(
        `answer ${stepId}.${fieldId} is longer than ${MAX_INTERVIEW_ANSWER_CHARS} characters`,
      );
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    byKey.set(`${stepId}.${fieldId}`, { stepId, fieldId, value: trimmed });
  }

  if (byKey.size === 0) {
    throw invalid('answer at least one question before asking for claims');
  }

  const unanswered = CAREER_INTERVIEW_STEPS.flatMap((step) =>
    step.fields
      .filter((field) => field.required)
      .filter((field) => !byKey.has(`${step.id}.${field.id}`))
      .map((field) => `${step.id}.${field.id}`),
  );
  if (unanswered.length > 0) {
    throw invalid(`these required questions are still blank: ${unanswered.join(', ')}`);
  }

  return [...byKey.values()].sort((left, right) =>
    `${left.stepId}.${left.fieldId}`.localeCompare(`${right.stepId}.${right.fieldId}`),
  );
}

/**
 * The answers as the PROMPT block: `stepId.fieldId | label`, then the value.
 *
 * This is the ONLY rendering the model sees. `answerGrounding` is what the guard compares
 * against, and it deliberately excludes the labels - see the header.
 */
export function renderAnswerBlock(answers: readonly InterviewAnswer[]): string {
  const labels = new Map<string, string>();
  for (const step of CAREER_INTERVIEW_STEPS) {
    for (const field of step.fields) labels.set(`${step.id}.${field.id}`, field.label);
  }
  return answers
    .map(
      (answer) =>
        `${answer.stepId}.${answer.fieldId} | ${labels.get(`${answer.stepId}.${answer.fieldId}`) ?? ''}\n${answer.value}`,
    )
    .join('\n\n');
}

/**
 * The texts a produced claim's entities must come from: THE USER'S OWN WORDS.
 *
 * The field labels are excluded on purpose. A hint reading "e.g. Senior Engineer at Acme"
 * would otherwise put "Acme" into the grounding, and a claim naming an employer the user
 * never typed would pass the check. The guard's question is "did the USER say this".
 */
export function answerGrounding(answers: readonly InterviewAnswer[]): string[] {
  return answers.map((answer) => answer.value);
}

// ---------------------------------------------------------------------------
// The provider seam
// ---------------------------------------------------------------------------

export interface InterviewProvider {
  readonly provider: string;
  readonly model: string;
}

/**
 * The parsed response. `claims` is REQUIRED, mirroring `CLAIM_EXTRACT_SCHEMA`: an extractor
 * that wants to say "nothing to extract" returns an empty array, and one that has no claims
 * member at all has not answered the question.
 */
export interface ClaimExtractResponse {
  readonly schemaVersion?: string;
  readonly claims: ReadonlyArray<{
    readonly kind?: string | null;
    readonly statement?: string | null;
    readonly confidence?: number | null;
  }>;
}

/**
 * THE OUTPUT CONTRACT, as the zod schema every provider response must satisfy (E.8).
 *
 * Deliberately LOOSE about member types (each is `string | number | null | undefined`) and
 * strict about SHAPE: a member that is absent or the wrong TYPE inside a claim is a
 * per-claim drop, because "I could not use this claim" and "this is not the document I
 * asked for" are different mistakes and the contract wants them distinguishable. A
 * `claims` member that is a string, or a top-level array where an object was asked for, IS
 * the second mistake and fails the whole response.
 *
 * `confidence` is typed `number` rather than a loose string so a quoted "high" is a schema
 * failure - a claim whose confidence the server cannot read is a claim whose metadata the
 * server would be inventing, which is the thing being guarded against.
 */
export const CLAIM_EXTRACT_SCHEMA = z.object({
  schemaVersion: z.string().optional(),
  // `claims` is REQUIRED, because the contract's schema says so and because a document
  // without it is not an answer to the question that was asked. An EMPTY array is required
  // and allowed - that is the honest "there is nothing to extract here". A `claims` member
  // that is an object, a string or absent fails the whole response, which is the
  // distinction that keeps "I could not use these claims" (a per-claim drop) apart from
  // "this is not the document I asked for" (a hard failure).
  claims: z.array(
    z.object({
      kind: z.string().optional().nullable(),
      statement: z.string().optional().nullable(),
      confidence: z.number().optional().nullable(),
    }),
  ),
});

export type ClaimExtractOutcome = {
  readonly status: 'applied' | 'skipped';
  readonly reason: InterviewExtractionReason;
  readonly provider: string | null;
  readonly model: string | null;
  readonly response: ClaimExtractResponse | null;
};

export interface CareerInterviewExtractorInput {
  readonly userId: string;
  readonly answers: readonly InterviewAnswer[];
  /** `renderAnswerBlock(answers)`: the labelled block the prompt embeds. */
  readonly answersBlock: string;
}

export type CareerInterviewExtractor = (
  input: CareerInterviewExtractorInput,
) => Promise<ClaimExtractOutcome>;

const PROVIDER_REQUIRED_REASON = 'no_ai_provider_configured';

/**
 * Lease a key, or REFUSE.
 *
 * The one place the stage decides whether a provider exists, and the reason both the start
 * route and the extractor can be honest about it. The probe costs one rotation on a key
 * that is about to be used anyway, and it is the key manager's own lease rather than a
 * table read, so there is no second idea of what a configured provider is
 * (`routes/career.ts#defaultEnricher` does the same probe for the same reason).
 */
async function leaseKeyOrRefuse(userId: string): Promise<KeyRecord> {
  try {
    return await leaseNextLlmKey(userId);
  } catch {
    throw new CareerInterviewError('interview_provider_required', PROVIDER_REQUIRED_MESSAGE);
  }
}

/**
 * The provider and model this interview will use, for the caller to SHOW.
 *
 * A model id is audit data and not a secret (`providerModels.ts` says so), so it is safe in
 * a response; the key behind it never leaves `keyManager`.
 */
export async function leaseInterviewProvider(userId: string): Promise<InterviewProvider> {
  const key = await leaseKeyOrRefuse(userId);
  const model = await getProviderModel(key.provider, {
    envOverride: process.env.CAREER_INTERVIEW_MODEL,
  });
  return { provider: key.provider, model };
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

function skipped(
  reason: InterviewExtractionReason,
  provider: string | null,
  model: string | null,
): ClaimExtractOutcome {
  return { status: 'skipped', reason, provider, model, response: null };
}

/**
 * The shipped extractor. The SYSTEM message is `career_interview_v1` and interpolates only
 * `max_claims` - a numeric bound, never content - so no answer text can reach the
 * instruction position and be read as an instruction (E.9 mitigation 1). The USER message
 * is `claim_extract_v1`, which carries the answers as DATA and nothing else.
 *
 * ONE ATTEMPT. See promise (2) in the header. No path here writes anything: this function
 * returns, and only `recordInterviewClaims` writes, and only after the guard.
 */
const defaultExtractor: CareerInterviewExtractor = async (input) => {
  let key: KeyRecord;
  try {
    key = await leaseKeyOrRefuse(input.userId);
  } catch (error) {
    if (error instanceof CareerInterviewError) return skipped(PROVIDER_REQUIRED_REASON, null, null);
    throw error;
  }
  const provider = key.provider;

  try {
    const model = await getProviderModel(provider, {
      envOverride: process.env.CAREER_INTERVIEW_MODEL,
    });
    const client = createLlmClient(key);
    const system = loadAndRender(CAREER_INTERVIEW_SCHEMA_VERSION, {});
    const prompt = loadAndRender(CLAIM_EXTRACT_SCHEMA_VERSION, {
      answers: input.answersBlock,
      max_claims: String(MAX_INTERVIEW_CLAIMS),
    });
    const response = await runLlmCompletion(provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 2000,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    );
    const content = response.choices[0]?.message?.content ?? '';
    const json = extractJson(content);
    if (json === null) {
      await markKeyFailure(key, false).catch(() => {});
      return skipped('schema_invalid', provider, model);
    }
    let parsed: z.infer<typeof CLAIM_EXTRACT_SCHEMA>;
    try {
      parsed = CLAIM_EXTRACT_SCHEMA.parse(JSON.parse(json));
    } catch {
      // Unparseable JSON, or a JSON document that is not the shape we asked for. Both are
      // the same failure for this stage: the model did not answer the question, so nothing
      // is stored and nothing is guessed.
      await markKeyFailure(key, false).catch(() => {});
      return skipped('schema_invalid', provider, model);
    }
    await markKeySuccess(key).catch(() => {});
    return { status: 'applied', reason: 'ok', provider, model, response: parsed };
  } catch (error) {
    await markKeyFailure(key, isRateLimitError(error)).catch(() => {});
    return skipped('provider_unavailable', provider, null);
  }
};

// ---------------------------------------------------------------------------
// The deterministic guard
// ---------------------------------------------------------------------------

/** Every way a produced claim is refused. Closed, so a client can branch on it. */
export const INTERVIEW_CLAIM_DROP_REASONS = Object.freeze([
  /** `kind` is absent, or not a `ClaimKind` enum value. */
  'unknown_kind',
  /** `statement` is absent, or blank once whitespace is collapsed. */
  'no_statement',
  /** The statement is shorter than `MIN_STATEMENT_CHARS` - not an atomic assertion. */
  'statement_too_short',
  /** The statement is longer than `MAX_STATEMENT_CHARS`. */
  'statement_too_long',
  /** `confidence` is present and is not a finite number in [0,1]. */
  'invalid_confidence',
  /** The statement names an employer, date, technology or number the answers do not. */
  'invented_entity',
  /** The same (kind, statement) twice in one response. The first wins. */
  'duplicate',
  /** The response carried more claims than `MAX_INTERVIEW_CLAIMS`. */
  'too_many_claims',
] as const);

export type InterviewClaimDropReason = (typeof INTERVIEW_CLAIM_DROP_REASONS)[number];

export interface AcceptedInterviewClaim {
  readonly kind: ClaimKind;
  readonly statement: string;
  readonly confidence: number | null;
}

export interface DroppedInterviewClaim {
  readonly reason: InterviewClaimDropReason;
  /** The offending text, or the member value that failed. Shown to the user as the reason. */
  readonly detail: string;
  /** The entities that were not in the grounding. Empty unless `invented_entity`. */
  readonly invented: readonly string[];
}

export interface GuardedInterviewClaims {
  readonly accepted: AcceptedInterviewClaim[];
  readonly dropped: DroppedInterviewClaim[];
}

/** A confidence in [0,1], `null` when absent, and `'invalid'` when unusable. Never clamped. */
function normalizeConfidence(value: unknown): number | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return 'invalid';
  }
  return value;
}

/**
 * THE GUARD: the contract's deterministic validation, run on EVERY claim of every response.
 *
 * IT FAILS CLOSED, PER CLAIM. One unusable claim does not discard the rest, and one
 * perfectly usable claim does not rescue a fabricated neighbour: each is judged on its own
 * and the refusals are reported beside the survivors. It also fails closed in the empty
 * direction - an EMPTY grounding refuses every claim, because a check that passes because it
 * looked at nothing is not a check.
 *
 * It does NOT fail closed in the "nothing concrete" direction: a statement that asserts no
 * entity at all ("Worked on billing systems") invents nothing, so it is accepted. Refusing
 * it would make the stage useless for the honest half of what people say, and the
 * verification list is where a vague claim is either confirmed or rejected.
 *
 * THE ENTITY VOCABULARY IS NOT INVENTED HERE. `extractFacts`/`detectFactDelta` are
 * `tailor/factDelta.ts`'s, so "names an employer nobody said" means the same thing here as
 * in the tailoring guard and in `interview/questions.ts`'s post-check. Over-detection is the
 * fail-closed direction and it is deliberate: the refusals are shown to the user, who can
 * re-word the answer and run the stage again.
 */
export function guardExtractedClaims(
  response: ClaimExtractResponse | null,
  grounding: readonly string[],
): GuardedInterviewClaims {
  const accepted: AcceptedInterviewClaim[] = [];
  const dropped: DroppedInterviewClaim[] = [];
  if (response === null || !Array.isArray(response.claims)) return { accepted, dropped };

  const texts = grounding.filter((text) => typeof text === 'string' && text.trim().length > 0);
  // Employers the ANSWERS name, so an organisation the user typed anywhere is recognised as
  // theirs wherever the model puts it - the same trick `interview/questions.ts` plays with
  // its grounded claims.
  const employers = [...new Set(texts.flatMap((text) => extractFacts(text).employers))].sort();
  const allowed = factsOfTexts(texts, employers);
  const seen = new Set<string>();

  const claims = response.claims.slice(0, MAX_INTERVIEW_CLAIMS);
  if (response.claims.length > MAX_INTERVIEW_CLAIMS) {
    dropped.push({
      reason: 'too_many_claims',
      detail: `${response.claims.length} claims returned; at most ${MAX_INTERVIEW_CLAIMS} are read`,
      invented: [],
    });
  }

  for (const [index, raw] of claims.entries()) {
    const label = `claim[${index}]`;
    if (raw === null || typeof raw !== 'object') {
      dropped.push({ reason: 'no_statement', detail: `${label}: not an object`, invented: [] });
      continue;
    }
    if (!isClaimKind(raw.kind)) {
      dropped.push({
        reason: 'unknown_kind',
        detail: `${label}: ${JSON.stringify(raw.kind ?? null)}`,
        invented: [],
      });
      continue;
    }
    const statement =
      typeof raw.statement === 'string' ? raw.statement.replace(/\s+/g, ' ').trim() : '';
    if (statement.length === 0) {
      dropped.push({ reason: 'no_statement', detail: `${label}: ${raw.kind}`, invented: [] });
      continue;
    }
    if (statement.length < MIN_STATEMENT_CHARS) {
      dropped.push({ reason: 'statement_too_short', detail: `${label}: ${statement}`, invented: [] });
      continue;
    }
    if (statement.length > MAX_STATEMENT_CHARS) {
      dropped.push({
        reason: 'statement_too_long',
        detail: `${label}: ${statement.slice(0, 80)}...`,
        invented: [],
      });
      continue;
    }
    const confidence = normalizeConfidence(raw.confidence);
    if (confidence === 'invalid') {
      dropped.push({
        reason: 'invalid_confidence',
        detail: `${label}: ${JSON.stringify(raw.confidence ?? null)}`,
        invented: [],
      });
      continue;
    }
    if (texts.length === 0) {
      dropped.push({
        reason: 'invented_entity',
        detail: `${label}: no answers to ground it in`,
        invented: [],
      });
      continue;
    }
    const delta = detectFactDelta(extractFacts(statement, employers), allowed);
    if (delta !== null) {
      dropped.push({
        reason: 'invented_entity',
        detail: `${label}: ${statement}`,
        invented: delta.introduced,
      });
      continue;
    }
    const identity = `${raw.kind}|${normalizeStatement(statement)}`;
    if (seen.has(identity)) {
      dropped.push({ reason: 'duplicate', detail: `${label}: ${statement}`, invented: [] });
      continue;
    }
    seen.add(identity);
    accepted.push({ kind: raw.kind, statement, confidence });
  }

  return { accepted, dropped };
}

// ---------------------------------------------------------------------------
// The write - the ONLY bridge from a model's claims to a claim row
// ---------------------------------------------------------------------------

/**
 * Write accepted interview claims.
 *
 * The ONLY bridge from `writeInferredClaims` to this surface, and deliberately the only one.
 * `career/claimWriterAI.test.ts` forbids a route from importing the AI writer or the status
 * writer, because a route holding either could write or confirm a claim straight out of an
 * HTTP body. Going through here keeps `status = inferred` and `provenance = llm_inferred`
 * hard-coded in the career layer, where ADR-036 item 2 puts them.
 *
 * NO `status` AND NO `provenance` APPEAR IN THE INPUT: the writer's defaults ARE the
 * interview's, and `InferredClaimInput` has no provenance member to smuggle one through. An
 * identical claim the profile already holds DEDUPES on `(profileId, fingerprint)` and is
 * left completely alone - so re-running the interview cannot duplicate a claim, change its
 * status, or resurrect one the user rejected (ADR-036 items 4-5).
 */
export async function writeInterviewClaims(
  args: {
    profileId: string;
    provider: string | null;
    claims: readonly AcceptedInterviewClaim[];
  },
  store: CareerClaimStore,
): Promise<{ created: number; deduped: number }> {
  return writeInferredClaims(
    args.profileId,
    args.claims.map((claim) => ({
      kind: claim.kind,
      statement: claim.statement,
      confidence: claim.confidence,
      inferenceMethod: CAREER_INTERVIEW_INFERENCE_METHOD,
      producedByModel: args.provider,
    })),
    store,
  );
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export interface RecordInterviewClaimsInput {
  readonly profileId: string;
  readonly userId: string;
  /** Already validated by `normalizeInterviewAnswers`. */
  readonly answers: readonly InterviewAnswer[];
}

export interface RecordInterviewClaimsResult {
  readonly provider: string | null;
  readonly model: string | null;
  /** How many claims the response carried. */
  readonly extracted: number;
  /** How many survived the guard. */
  readonly accepted: number;
  readonly created: number;
  readonly deduped: number;
  /** What the guard refused, with the reason. Never silently discarded. */
  readonly dropped: DroppedInterviewClaim[];
}

/** Map a non-`ok` extraction reason onto the refusal it is. Closed, so nothing is guessed. */
function refusalFor(reason: InterviewExtractionReason): CareerInterviewError {
  switch (reason) {
    case PROVIDER_REQUIRED_REASON:
      return new CareerInterviewError('interview_provider_required', PROVIDER_REQUIRED_MESSAGE);
    case 'provider_unavailable':
      return new CareerInterviewError(
        'interview_provider_unavailable',
        'the AI provider could not be reached, so nothing was written: your answers are still here, try again in a moment, or add the statements by hand',
      );
    default:
      return new CareerInterviewError(
        'interview_schema_invalid',
        'the provider answered in a shape this stage will not guess at, so nothing was written: no claims were created and nothing was invented',
      );
  }
}

/**
 * THE STAGE: call the provider -> guard every claim -> write the survivors.
 *
 * NOTHING IS WRITTEN BEFORE THE GUARD, and nothing is written at all on any refusal, so a
 * schema-invalid response, an unreachable provider and a missing provider are three ways
 * for this request to produce ZERO claims - never three ways to produce something.
 */
export async function recordInterviewClaims(
  input: RecordInterviewClaimsInput,
  store: CareerClaimStore,
): Promise<RecordInterviewClaimsResult> {
  const answers = input.answers;
  const outcome = await extractor({
    userId: input.userId,
    answers,
    answersBlock: renderAnswerBlock(answers),
  });

  if (outcome.status !== 'applied' || outcome.response === null) {
    throw refusalFor(outcome.reason);
  }

  const extracted = outcome.response.claims.length;
  const guarded = guardExtractedClaims(outcome.response, answerGrounding(answers));
  const written = await writeInterviewClaims(
    { profileId: input.profileId, provider: outcome.provider, claims: guarded.accepted },
    store,
  );

  return {
    provider: outcome.provider,
    model: outcome.model,
    extracted,
    accepted: guarded.accepted.length,
    created: written.created,
    deduped: written.deduped,
    dropped: guarded.dropped,
  };
}

let extractor: CareerInterviewExtractor = defaultExtractor;

/**
 * Install a different extractor (an adapter, a test, a live harness). `null` restores the
 * shipped default, so there is no configuration in which the stage is silently absent.
 */
export function setCareerInterviewExtractor(next: CareerInterviewExtractor | null): void {
  extractor = next ?? defaultExtractor;
}

/** Re-exported so a test or an adapter can reach the shipped default directly. */
export const shippedCareerInterviewExtractor = defaultExtractor;

// ---------------------------------------------------------------------------
// The session id
// ---------------------------------------------------------------------------

/**
 * A fresh opaque session id: `iv1.` + 32 hex characters.
 *
 * IT CARRIES NO AUTHORITY, and this docstring says so because a reader must not mistake it
 * for a capability. There is no `CareerInterviewSession` table (this task may not add one)
 * and nothing needs one: the answers route resolves the caller's profile through the
 * router's own `resolveCallerProfile`, and the extractor leases the CALLER's key on that
 * request, so what a caller may write is decided by `requireAuth` plus profile ownership
 * exactly as on every other career write. Forging or replaying an id therefore changes
 * nothing. The id exists so the wizard can name the run it is about to submit and so two
 * runs are distinguishable in a log.
 */
export function createInterviewSessionId(): string {
  return `iv1.${randomBytes(16).toString('hex')}`;
}

/** Whether a path parameter has the shape `createInterviewSessionId` produces. */
export function isInterviewSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}