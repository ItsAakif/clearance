// =====================================================================================
// projects/generate.ts - CANDIDATES, THE FEASIBILITY SCREEN, AND THE PLAN (T1100; 06-design
// sec. E.5's pipeline, the output shape, and sec. E.8 stage 12).
//
// THE FLOW THIS MODULE IMPLEMENTS, VERBATIM FROM E.5:
//
//   Job (or JobMatch.gaps)
//     -> gap analysis            (projects/gaps.ts - done)
//     -> skill targets           (projects/gaps.ts - done)
//     -> public research         (projects/research.ts - OPTIONAL, done)
//     -> candidate generation    (this module, deterministic; the provider may PROPOSE)
//     -> feasibility screen      (this module, deterministic)
//     -> plan                    (this module, deterministic)
//     -> user Accept -> complete -> user confirmation -> confirmed claim
//
// WHY GENERATION IS DETERMINISTIC FIRST. The orchestrator ruling for this task is explicit:
// the core runs with NO provider and NO network. That rules out "ask a model to write the
// candidates and validate the answer", because with no model there would be no candidates at
// all and the feature would be a button that does nothing. So `generateCandidates` composes a
// candidate from the gap's OWN words - its requirement text, its kind, its skill targets - and
// the provider's privilege, when one is configured, is to PROPOSE additional candidates,
// which pass exactly the same deterministic screens as the derived ones. A model cannot
// widen the envelope: `guardCandidate` is the only thing that admits a candidate into the
// output, and it does not know who wrote it.
//
// WHAT A DERIVED CANDIDATE IS, HONESTLY. It is a SKELETON: a title, an idea sentence naming
// the gap it closes, a stack taken from the gap's own skill targets, a two-day plan, and the
// original design decision E.5 requires. It is deliberately thin. A thin honest skeleton the
// user edits beats a rich invented one, because everything in it is traceable to a named
// requirement - and the acceptance item is about which requirements are TARGETED, not about
// prose quality.
//
// THE FEASIBILITY SCREEN IS A TWO-DAY BUDGET, and it is arithmetic on integers rather than a
// judgement. `TWO_DAY_BUDGET_HOURS` is 16 (from `references.ts`, so the budget has ONE
// definition in this directory); a candidate claiming more is refused, and so is one claiming
// none. The dependency count is the stack length, capped at `MAX_STACK_ITEMS`: a two-day
// project cannot hold seven technologies, and "add one more thing" is how a weekend becomes a
// month. Neither number is ever combined with anything into a rating - E.6 forbids a single
// derived figure, and a feasibility verdict is a list of named refusals, not a number.
//
// NO SCORE ANYWHERE IN THIS FILE. There is no `score`, no `percentage`, no `ratio`, no
// `points`. The output carries `difficulty` because E.5's own output shape asks for a
// `Severity`, which is one of three NAMED words and not a number - and the file's own test
// greps for the banned names so that stays true.
//
// THE PROVIDER STAGE, WHEN THERE IS ONE, is behind an injectable seam (`setCandidateProposer`,
// the same shape `match/potential.ts` ships as `setContextualProposer`) and it is skipped with
// a machine-readable reason rather than being required. Its proposals are screened by the same
// `guardCandidate`, so the worst a hallucinating proposer can do is lose a slot.
// =====================================================================================

import { z } from 'zod';
import type { Severity } from '@prisma/client';

import { loadAndRender } from '../ats/promptLoader.js';
import { isRateLimitError, leaseNextLlmKey, markKeyFailure, markKeySuccess } from '../ai/keyManager.js';
import { createLlmClient, getProviderModel, runLlmCompletion } from '../ai/providerModels.js';
import { checkCandidateIsOriginal, TWO_DAY_BUDGET_HOURS } from './references.js';
import type { TeachableGap } from './gaps.js';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** The prompt this stage loads, and the schema version every response declares (E.8). */
export const PROJECT_CANDIDATE_SCHEMA_VERSION = 'project_candidate_v1' as const;

/** `Severity`, as a CLOSED set. The schema stores an enum, so a value outside it is refused. */
const SEVERITIES: readonly Severity[] = Object.freeze(['low', 'medium', 'high']);

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

/** How many candidates one run may carry, derived or proposed. E.5 says "2-4"; the cap is 4. */
export const MAX_CANDIDATES = 4;

/** The floor E.5 implies. A run that produced one candidate has not offered a choice. */
export const MIN_CANDIDATES = 2;

/** The most technologies a two-day project may hold. */
export const MAX_STACK_ITEMS = 5;

/** The most references one candidate may carry. Inspiration, not a bibliography. */
export const MAX_REFERENCES_PER_CANDIDATE = 3;

/** How many proposals the provider may return, and how many attempts it gets. */
export const MAX_PROPOSALS = 4;
export const LLM_SCHEMA_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// The candidate
// ---------------------------------------------------------------------------

/** The two-day plan, exactly as E.5's output shape spells it. */
export interface ProjectPlan {
  readonly day1: readonly string[];
  readonly day2: readonly string[];
  readonly milestones: readonly string[];
  readonly scope: { readonly in: readonly string[]; readonly out: readonly string[] };
  /**
   * E.5's output requirement: "the plan must name at least one ORIGINAL design decision". The
   * anti-copy guard REFUSES a candidate whose `originalDesignDecision` is empty, so this is
   * load-bearing rather than decorative.
   */
  readonly originalDesignDecision: string;
}

/** One reference, as E.5's `references[]` spells it: kind + licence + activity, never copied text. */
export interface CandidateReference {
  readonly kind: string;
  readonly title: string;
  readonly url: string;
  readonly licence: string;
  readonly activity: Record<string, unknown>;
}

/** One candidate mini-project. `status` is `proposed` on creation, always. */
export interface ProjectCandidate {
  readonly title: string;
  readonly idea: string;
  /** `JobRequirement.id`s this closes. Never empty: an unattributable candidate is refused. */
  readonly requirementIds: readonly string[];
  readonly stack: readonly string[];
  readonly difficulty: Severity;
  readonly estimatedHours: number;
  readonly relevance: string;
  readonly plan: ProjectPlan;
  readonly references: readonly CandidateReference[];
  readonly status: 'proposed';
  /** Which stage produced it. Shown in the UI so "derived" is never read as "generated". */
  readonly producedBy: 'deterministic' | 'provider';
}

/** The plan rendered as the text the anti-copy guard compares. */
export function planTextOf(plan: ProjectPlan): string {
  return [
    ...plan.day1,
    ...plan.day2,
    ...plan.milestones,
    plan.originalDesignDecision,
    ...plan.scope.in,
    ...plan.scope.out,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

/** Every way a candidate is refused. Named, never silently dropped. */
export const CANDIDATE_REJECTION_REASONS = Object.freeze([
  /** `requirementId` absent, or not one of the gaps this run selected. */
  'unknown_requirement',
  /** The same `requirementId` twice in one response; the first wins. */
  'duplicate_requirement',
  /** No title, or an empty idea. */
  'no_title_or_idea',
  /** No hours, negative hours, or more than the two-day budget. */
  'beyond_two_day_budget',
  /** More technologies than a two-day project can hold. */
  'too_many_dependencies',
  /** No usable plan lines, or no milestone. */
  'incomplete_plan',
  /** No original design decision (E.5's output requirement). */
  'no_original_design_decision',
  /** The overlap guard found a reimplementation. */
  'overlaps_a_reference',
] as const);

export type CandidateRejectionReason = (typeof CANDIDATE_REJECTION_REASONS)[number];

export interface CandidateRejection {
  readonly reason: CandidateRejectionReason;
  /** Which requirement the refused candidate claimed. `null` when it named none. */
  readonly detail: string;
}

/** The outcome of one run. */
export interface CandidateRun {
  readonly candidates: readonly ProjectCandidate[];
  /** Every refusal, with the screen that fired. Never silently discarded. */
  readonly rejected: readonly CandidateRejection[];
  /** What the optional provider stage did. Reported either way. */
  readonly proposalStage: CandidateProposalStage;
  /** What the optional research stage did. Reported either way (E.5's `public research` box). */
  readonly researchStage: CandidateResearchStage;
}

/** Mirrors `match/report.ts`'s `ProposalStageView`, for the same reason and the same reasons. */
export interface CandidateProposalStage {
  readonly status: 'applied' | 'skipped';
  /**
   * `ok` | `no_ai_provider_configured` | `provider_unavailable` | `not_evaluated`.
   * `not_evaluated` is what a caller passes `runProvider: false` and gets back, and it is
   * deliberately NOT `no_ai_provider_configured`: this request did not check the user's keys.
   */
  readonly reason: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly proposedCount: number;
  readonly dropped: readonly CandidateRejection[];
}

export interface CandidateResearchStage {
  readonly status: 'applied' | 'skipped';
  readonly reason: string;
  readonly searchCount: number;
  readonly consideredCount: number;
  readonly acceptedCount: number;
}

// ---------------------------------------------------------------------------
// Deriving a candidate from a gap (deterministic)
// ---------------------------------------------------------------------------

function cleanList(values: unknown, cap: number): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const line = value.replace(/\s+/g, ' ').trim();
    if (line.length === 0) continue;
    out.push(line.slice(0, 200));
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * ONE candidate, derived from ONE gap, with no provider in sight.
 *
 * Every string here is composed from the gap's OWN fields: `text`, `kind`, `skillTargets`. That
 * is the whole reason the derived candidate is safe to store without a human reading it first -
 * there is nothing in it that is not traceable to a requirement the user can go and look at.
 * The SKILL TARGETS decide the stack (capped), the first two targets decide the two milestone
 * lines, and the plan shape is fixed by the two-day budget rather than by taste.
 */
export function deriveCandidate(gap: TeachableGap): ProjectCandidate {
  const targets = gap.skillTargets.length > 0 ? [...gap.skillTargets] : [gap.text];
  // THE MOST SPECIFIC TARGET IS THE PRIMARY ONE, not the first.
  //
  // `skillTargetsFor` leads with the gap's own `normalizedKey`, which for a `responsibility` or a
  // `domain` requirement is the requirement's WHOLE SENTENCE ("design and ship services on
  // kubernetes"). A sentence is not a thing you build a weekend project with, and a candidate
  // whose idea says "uses design and ship services on kubernetes end to end" reads as a machine
  // filling a template. The SHORTEST named target is the technology the requirement is really
  // about, and it is still one the gap itself named - nothing is invented here.
  //
  // The `stack` keeps the gap's own ORDER, because that is the matcher's order and re-sorting a
  // list of technologies would be a second opinion about it.
  const bySpecificity = [...targets].sort((a, b) => a.length - b.length);
  const primary = bySpecificity[0];
  const secondary = bySpecificity[1] ?? bySpecificity[0];
  const stack = targets.slice(0, MAX_STACK_ITEMS);
  // A difficulty that is derived from the IMPORTANCE of the gap and the NUMBER of targets, both
  // of which the user can see, and never from a model. Three named words, not a number.
  const difficulty: Severity =
    gap.importanceRank === 0 && stack.length >= 3
      ? 'high'
      : gap.importanceRank === 0
        ? 'medium'
        : 'low';

  return {
    title: `A two-day ${primary} project`,
    idea:
      `Build one small thing that uses ${primary} end to end, so the job's "${gap.text}" ` +
      `requirement has something real behind it instead of a claim with no repository. The ` +
      `project is deliberately narrow: it demonstrates the ${gap.kind} rather than teaching it.`,
    requirementIds: [gap.requirementId],
    stack,
    difficulty,
    // Derived from the STACK and the difficulty, never asserted: a stack of one is a weekend,
    // a stack of five is most of it. Two days is the promise, so the number is below it.
    estimatedHours: Math.min(TWO_DAY_BUDGET_HOURS - 2, 6 + stack.length * 2),
    relevance:
      `Closes the named gap "${gap.text}" of this job. Your confirmed evidence does not cover ` +
      `it, and this is the smallest thing that would.`,
    plan: {
      day1: [
        `Scaffold the project and write down what ${primary} has to do before any code.`,
        `Build the smallest path that exercises ${primary} once, end to end.`,
      ],
      day2: [
        `Add the failure cases: what happens when ${primary} is slow, unavailable or wrong.`,
        'Write the README: what it is, how to run it, and what it deliberately does not do.',
      ],
      milestones: [
        `${primary} runs once from a clean checkout.`,
        `The failure cases are covered by something a reader can run.`,
        'The README explains the project without the author present.',
      ],
      scope: {
        in: [`one project that exercises ${primary}`, 'a README that explains it', 'a runnable check'],
        out: [
          'production deployment',
          'authentication',
          secondary === primary
            ? 'anything beyond what one project needs'
            : `${secondary} beyond what ${primary} needs`,
        ],
      },
      // E.5 requires the plan to name an ORIGINAL design decision. Derived from the gap so it
      // is specific to this requirement rather than a sentence that would fit any project, and
      // never a sentence copied from a reference.
      originalDesignDecision:
        `Everything about ${primary} sits behind one small interface, so the rest of the project ` +
        `can be exercised without it and the design can be tested independently of the tool.`,
    },
    references: [],
    status: 'proposed',
    producedBy: 'deterministic',
  };
}

// ---------------------------------------------------------------------------
// The feasibility screen (the one gate, for every candidate)
// ---------------------------------------------------------------------------

/**
 * THE SCREEN. One function, applied to derived and proposed candidates alike.
 *
 * ORDER IS THE ORDER OF THE FAILURES a reader would care about: which requirement it closes
 * (an unattributable candidate is the worst thing this module could emit), then whether it is
 * a thing at all, then the two-day budget, then the dependency cap, then the plan, then E.5's
 * original-design-decision requirement. `references` is what the OVERLAP guard compares
 * against, so it is a parameter and not part of the candidate - a candidate cannot smuggle in
 * the very references it is supposed to be measured against.
 */
export function guardCandidate(
  draft: {
    readonly title: unknown;
    readonly idea: unknown;
    readonly requirementId: unknown;
    readonly requirementIds?: unknown;
    readonly stack: unknown;
    readonly difficulty: unknown;
    readonly estimatedHours: unknown;
    readonly relevance: unknown;
    readonly plan: unknown;
  },
  context: {
    /** `requirementId`s this run selected. A proposal outside them is refused. */
    readonly gapIds: ReadonlySet<string>;
    readonly seen: ReadonlySet<string>;
    /** The accepted references so far, for the overlap guard: the SHAPE the guard compares. */
    readonly references: readonly { readonly url: string; readonly notes?: string | null; readonly title: string }[];
    /**
     * The same references as the wire shape (`kind` + `licence` + `activity`), which is what
     * the ACCEPTED candidate carries. A separate parameter rather than a re-derivation from the
     * guard's shape, so a candidate can never carry a licence the measured reference did not
     * have - the two are filled from the same screened row by `projects/lifecycle.ts`.
     */
    readonly candidateReferences?: readonly CandidateReference[];
    /** Set to `true` to skip the overlap guard (only when there are no references anyway). */
    readonly runOverlapGuard?: boolean;
  },
): { accepted: ProjectCandidate; producedBy: ProjectCandidate['producedBy'] } | { dropped: CandidateRejection } {
  const rawIds = Array.isArray(draft.requirementIds) ? draft.requirementIds : [draft.requirementId];
  const ids = rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  const first = ids[0] ?? '';
  if (ids.length === 0 || !context.gapIds.has(first)) {
    return {
      dropped: {
        reason: 'unknown_requirement',
        detail: first.length > 0 ? first : '(no requirementId)',
      },
    };
  }
  for (const id of ids) {
    if (!context.gapIds.has(id)) {
      return { dropped: { reason: 'unknown_requirement', detail: id } };
    }
  }
  const fingerprint = ids.join('|');
  if (context.seen.has(fingerprint)) {
    return { dropped: { reason: 'duplicate_requirement', detail: fingerprint } };
  }

  const title = typeof draft.title === 'string' ? draft.title.replace(/\s+/g, ' ').trim() : '';
  const idea = typeof draft.idea === 'string' ? draft.idea.replace(/\s+/g, ' ').trim() : '';
  if (title.length === 0 || idea.length === 0) {
    return { dropped: { reason: 'no_title_or_idea', detail: first } };
  }

  // THE TWO-DAY BUDGET. A number that is absent is a refusal, not a pass: a candidate with no
  // estimate has not been checked against anything.
  const hours = draft.estimatedHours;
  if (
    typeof hours !== 'number' ||
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > TWO_DAY_BUDGET_HOURS
  ) {
    return { dropped: { reason: 'beyond_two_day_budget', detail: `${first}: ${String(hours)}` } };
  }

  const stack = cleanList(draft.stack, MAX_STACK_ITEMS + 1);
  if (stack.length === 0 || stack.length > MAX_STACK_ITEMS) {
    return { dropped: { reason: 'too_many_dependencies', detail: `${first}: ${stack.length}` } };
  }

  const planDraft = (draft.plan ?? {}) as Record<string, unknown>;
  const day1 = cleanList(planDraft.day1, 4);
  const day2 = cleanList(planDraft.day2, 4);
  const milestones = cleanList(planDraft.milestones, 4);
  const scopeDraft = (planDraft.scope ?? {}) as Record<string, unknown>;
  const scopeIn = cleanList(scopeDraft.in, 4);
  const scopeOut = cleanList(scopeDraft.out, 4);
  const originalDesignDecision =
    typeof planDraft.originalDesignDecision === 'string'
      ? planDraft.originalDesignDecision.replace(/\s+/g, ' ').trim().slice(0, 400)
      : '';
  if (day1.length === 0 || day2.length === 0 || milestones.length === 0) {
    return { dropped: { reason: 'incomplete_plan', detail: first } };
  }
  if (originalDesignDecision.length === 0) {
    return { dropped: { reason: 'no_original_design_decision', detail: first } };
  }

  const plan: ProjectPlan = {
    day1,
    day2,
    milestones,
    scope: { in: scopeIn, out: scopeOut },
    originalDesignDecision,
  };

  const references = [...context.references];
  if (context.runOverlapGuard !== false && references.length > 0) {
    const verdict = checkCandidateIsOriginal(
      { idea, planText: planTextOf(plan), originalDesignDecision },
      references,
    );
    if (!verdict.original) {
      return {
        dropped: {
          reason: verdict.reason === 'overlaps_a_reference' ? 'overlaps_a_reference' : 'no_original_design_decision',
          detail: verdict.referenceUrl ?? verdict.detail.slice(0, 160),
        },
      };
    }
  }

  const relevance =
    typeof draft.relevance === 'string' ? draft.relevance.replace(/\s+/g, ' ').trim() : '';
  return {
    accepted: {
      title: title.slice(0, 200),
      idea: idea.slice(0, 1_000),
      requirementIds: ids,
      stack,
      difficulty: isSeverity(draft.difficulty) ? draft.difficulty : 'medium',
      estimatedHours: hours,
      // Never empty: a candidate with no stated relevance is a candidate the user cannot judge.
      relevance:
        relevance.length > 0
          ? relevance.slice(0, 500)
          : 'Closes a named gap from the match report that your confirmed evidence does not cover.',
      plan,
      // The wire shape comes from the caller's screened rows, not from the guard's comparison
      // shape: `references` above is `{url, title, notes}` and has no licence or snapshot in
      // it, because the guard does not need one.
      references: context.candidateReferences ?? [],
      status: 'proposed',
      producedBy: 'provider',
    },
    producedBy: 'provider',
  };
}

// ---------------------------------------------------------------------------
// The optional provider stage
// ---------------------------------------------------------------------------

const proposalSchema = z.object({
  schemaVersion: z.string().optional(),
  candidates: z
    .array(
      z.object({
        requirementId: z.string().optional().nullable(),
        title: z.string().optional().nullable(),
        idea: z.string().optional().nullable(),
        stack: z.array(z.string()).optional().nullable(),
        difficulty: z.string().optional().nullable(),
        estimatedHours: z.number().optional().nullable(),
        relevance: z.string().optional().nullable(),
        plan: z
          .object({
            day1: z.array(z.string()).optional().nullable(),
            day2: z.array(z.string()).optional().nullable(),
            milestones: z.array(z.string()).optional().nullable(),
            scope: z
              .object({
                in: z.array(z.string()).optional().nullable(),
                out: z.array(z.string()).optional().nullable(),
              })
              .optional()
              .nullable(),
            originalDesignDecision: z.string().optional().nullable(),
          })
          .optional()
          .nullable(),
      }),
    )
    .optional(),
});

export type CandidateProposalResponse = z.infer<typeof proposalSchema>;

export interface CandidateProposerInput {
  readonly userId: string;
  /** The gaps, rendered `requirementId | kind | importance | text | targets`. */
  readonly gaps: string;
}

export type CandidateProposerOutcome =
  | { readonly status: 'applied'; readonly reason: 'ok'; readonly provider: string; readonly model: string; readonly response: CandidateProposalResponse }
  | {
      readonly status: 'skipped';
      readonly reason: 'no_ai_provider_configured' | 'provider_unavailable';
      readonly provider: string | null;
      readonly model: string | null;
      readonly response: null;
    };

export type CandidateProposer = (input: CandidateProposerInput) => Promise<CandidateProposerOutcome>;

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

/**
 * One structured call, with E.8's "one retry on schema failure" and ADR-041 D5's
 * "no key is not an error".
 *
 * NO KEY IS REPORTED, NOT THROWN, and NOT IMPLED: the derived candidates already exist by the
 * time this runs, so the stage has no work of its own that cannot wait. The system message is
 * STATIC and carries none of the caller's content, so a job description that says "ignore
 * previous instructions" is quoted material in the USER message rather than an instruction
 * (E.9 mitigation 1), and `response_format: json_object` plus the zod schema mean an injected
 * instruction that produces prose fails the parse.
 */
const defaultProposer: CandidateProposer = async (input) => {
  let key;
  try {
    key = await leaseNextLlmKey(input.userId);
  } catch {
    return {
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      provider: null,
      model: null,
      response: null,
    };
  }
  const provider = key.provider;
  let model: string | null = null;
  try {
    const resolved = await getProviderModel(provider, {
      envOverride: process.env.PROJECT_CANDIDATE_MODEL,
    });
    model = resolved;
    const client = createLlmClient(key);
    const prompt = loadAndRender(PROJECT_CANDIDATE_SCHEMA_VERSION, {
      gaps: input.gaps,
      budget_hours: String(TWO_DAY_BUDGET_HOURS),
      max_candidates: String(MAX_PROPOSALS),
      max_stack_items: String(MAX_STACK_ITEMS),
    });
    for (let attempt = 1; attempt <= LLM_SCHEMA_ATTEMPTS; attempt += 1) {
      const response = await runLlmCompletion(provider, resolved, () =>
        client.chat.completions.create({
          model: resolved,
          max_tokens: 3000,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You propose two-day portfolio projects. Reply with one JSON object.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      );
      const content = response.choices[0]?.message?.content ?? '';
      const json = extractJson(content);
      if (json === null) continue;
      try {
        const parsed = proposalSchema.safeParse(JSON.parse(json));
        if (parsed.success) {
          await markKeySuccess(key).catch(() => {});
          return { status: 'applied', reason: 'ok', provider, model: resolved, response: parsed.data };
        }
      } catch {
        // Unparseable JSON: fall through to the schema retry, then `provider_unavailable`.
      }
    }
    await markKeyFailure(key, false).catch(() => {});
    return { status: 'skipped', reason: 'provider_unavailable', provider, model, response: null };
  } catch (error) {
    await markKeyFailure(key, isRateLimitError(error)).catch(() => {});
    return { status: 'skipped', reason: 'provider_unavailable', provider, model, response: null };
  }
};

let proposer: CandidateProposer = defaultProposer;

/** Install a different proposal stage (an adapter, a test). `null` restores the shipped default. */
export function setCandidateProposer(next: CandidateProposer | null): void {
  proposer = next ?? defaultProposer;
}

/** Re-exported so a test or an adapter can reach the shipped default directly. */
export const shippedCandidateProposer = defaultProposer;

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

export interface GenerateInput {
  readonly userId: string;
  readonly gaps: readonly TeachableGap[];
  /** `false` runs the DETERMINISTIC-ONLY path. This is the no-key case, exposed for a test. */
  readonly runProvider?: boolean;
  /** Accepted references, keyed by the requirement they were found for. */
  readonly referencesByRequirement?: Readonly<Record<string, CandidateReference[]>>;
  /** Extra reference text for the overlap guard, keyed by the same requirement. */
  readonly referenceRowsByRequirement?: Readonly<
    Record<string, { readonly url: string; readonly title: string; readonly notes?: string | null }[]>
  >;
  /** What the research stage did. Carried through so one report states both optional stages. */
  readonly researchStage?: CandidateResearchStage;
}

/** `requirementId | kind | importance | text | targets`, bounded. Never the whole job. */
export function renderGapTable(gaps: readonly TeachableGap[]): string {
  const lines = gaps
    .slice(0, MAX_CANDIDATES * 2)
    .map((gap) => `${gap.requirementId} | ${gap.kind} | ${gap.importance} | ${gap.text} | ${gap.skillTargets.join(', ')}`);
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

function referencesFor(
  requirementId: string,
  input: GenerateInput,
): {
  candidates: CandidateReference[];
  rows: { url: string; title: string; notes?: string | null }[];
} {
  const candidates = (input.referencesByRequirement?.[requirementId] ?? []).slice(
    0,
    MAX_REFERENCES_PER_CANDIDATE,
  );
  const rows = (input.referenceRowsByRequirement?.[requirementId] ?? []).slice(
    0,
    MAX_REFERENCES_PER_CANDIDATE,
  );
  return { candidates, rows };
}

/**
 * GAPS -> CANDIDATES, and the report of everything the run refused.
 *
 * THE ORDER, and why it is this order:
 *   1. DERIVE one candidate per selected gap. No provider, no network. This is the floor.
 *   2. PROPOSE, if a provider is configured and the caller did not decline. Every proposal goes
 *      through the SAME `guardCandidate`, so a model cannot widen the envelope.
 *   3. CAP at `MAX_CANDIDATES` in importance order (the gaps are already ordered that way), so
 *      the run is the same list every time rather than the first N to arrive.
 *
 * WHY THE DERIVED CANDIDATES GO IN EVEN WHEN THE PROVIDER ANSWERED. They are the answer to a
 * different question from the proposals: they are what "these gaps, handled deterministically"
 * looks like. Dropping them because a model also spoke would make the model's presence change
 * which projects exist, which is the wrong direction for every other optional stage in V2.
 */
export async function generateCandidates(input: GenerateInput): Promise<CandidateRun> {
  const gaps = input.gaps ?? [];
  const candidates: ProjectCandidate[] = [];
  const rejected: CandidateRejection[] = [];
  const seen = new Set<string>();
  let proposalStage: CandidateProposalStage = {
    status: 'skipped',
    reason: 'not_evaluated',
    provider: null,
    model: null,
    proposedCount: 0,
    dropped: [],
  };

  // ---- 1. derive ----------------------------------------------------------
  for (const gap of gaps) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const { candidates: refs, rows } = referencesFor(gap.requirementId, input);
    const derived = deriveCandidate(gap);
    const planText = planTextOf(derived.plan);
    // GATED ON THE ROWS, NOT ON THE WIRE REFERENCES. `rows` is what the guard actually
    // measures, so a caller that supplied the excerpt but not the wire shape still gets the
    // guard rather than a silent pass - and the shipped caller fills both from the same
    // screened rows, so the two can never disagree about what was consulted.
    if (rows.length > 0) {
      const verdict = checkCandidateIsOriginal(
        {
          idea: derived.idea,
          planText,
          originalDesignDecision: derived.plan.originalDesignDecision,
        },
        rows,
      );
      if (!verdict.original) {
        rejected.push({
          reason: verdict.reason === 'overlaps_a_reference' ? 'overlaps_a_reference' : 'no_original_design_decision',
          detail: `${gap.requirementId}: ${verdict.referenceUrl ?? verdict.reason}`,
        });
        continue;
      }
    }
    seen.add(gap.requirementId);
    candidates.push({ ...derived, references: refs });
  }

  // ---- 2. propose ---------------------------------------------------------
  if (input.runProvider !== false && candidates.length < MAX_CANDIDATES && gaps.length > 0) {
    const outcome = await proposer({ userId: input.userId, gaps: renderGapTable(gaps) });
    proposalStage = {
      status: outcome.status,
      reason: outcome.reason,
      provider: outcome.provider,
      model: outcome.model,
      proposedCount: outcome.status === 'applied' ? (outcome.response.candidates ?? []).length : 0,
      dropped: [],
    };
    if (outcome.status === 'applied') {
      const dropped: CandidateRejection[] = [];
      const gapIds = new Set(gaps.map((gap) => gap.requirementId));
      for (const row of (outcome.response.candidates ?? []).slice(0, MAX_PROPOSALS)) {
        if (candidates.length >= MAX_CANDIDATES) break;
        const requirementId = typeof row.requirementId === 'string' ? row.requirementId.trim() : '';
        const { candidates: refs, rows } = referencesFor(requirementId, input);
        const verdict = guardCandidate(
          {
            title: row.title,
            idea: row.idea,
            requirementId,
            stack: row.stack ?? [],
            difficulty: row.difficulty,
            estimatedHours: row.estimatedHours ?? null,
            relevance: row.relevance,
            plan: row.plan ?? {},
          },
          { gapIds, seen, references: rows, candidateReferences: refs },
        );
        if ('dropped' in verdict) {
          dropped.push(verdict.dropped);
          rejected.push(verdict.dropped);
          continue;
        }
        seen.add(requirementId);
        candidates.push({ ...verdict.accepted, references: refs });
      }
      proposalStage = { ...proposalStage, dropped };
    }
  }

  return {
    candidates: Object.freeze(candidates.slice(0, MAX_CANDIDATES)),
    rejected: Object.freeze(rejected),
    proposalStage,
    researchStage:
      input.researchStage ?? { status: 'skipped', reason: 'not_evaluated', searchCount: 0, consideredCount: 0, acceptedCount: 0 },
  };
}