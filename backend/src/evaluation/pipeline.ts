// Wave 9 pipeline - the three passes wired together (T782, ADR-027, N5/N10/N18).
//
//   Pass 1: `applyHardFilters` (T780) over EVERYTHING - pure, deterministic.
//   Pass 2: `scoreJobs` (T781 matcher bridge) over the kept set - deterministic.
//   Pass 3: `selectAiSubset` + the EXISTING evaluate path, over at most
//           MAX_AI_EVALUATIONS_PER_RUN jobs - the only pass that may call AI.
//
// MEMORY (STEP 7, very large result sets): pass 1 scans everything, pass 2
// scores only the kept set, pass 3 touches at most the cap. At no point is a
// second copy of full descriptions materialised: `ScoredJob`, the subset,
// the estimate and `EvaluatedJob` all hold REFERENCES to the original
// `RawJob` objects (never `{ ...job }`, never a parallel description
// array). `estimateCost` reads only `.description.length`, never a copy.
//
// NO AUTO-APPLY (N10): there is no `prisma.application.create` - indeed no
// prisma import at all - anywhere under `backend/src/evaluation/`. Proven by
// the source check in `pipeline.test.ts`.
//
// NO second evaluation model (N7): AI results are produced through the
// EXISTING evaluate path. Concretely, the pipeline never persists anything
// itself: the AI seam is the injected `EvaluationOptions.evaluateOne`, and
// the production wiring (orchestrator / T783) passes a function that calls
// the existing `evaluateJob` (`ai/evaluation.ts`) and persists through the
// existing `JobEvaluation` model - exactly like `POST /:id/evaluate` does.
// Unit tests inject fakes, so this module has no DB dependency.
//
// ERROR VOCABULARY: the pipeline reports (never throws for) `llm_key_missing`
// and `rate_limited`, mirroring the preserved `POST /:id/evaluate` contract,
// plus `no_description` (mirrors the route's 50-char usability rule),
// `no_resume` (pass 3 skipped: no resume/profile signal), `no_candidates`
// (pass 3 skipped: nothing cleared `minScore`), `no_evaluator` (ai-subset
// requested but no `evaluateOne` was wired), and `cancelled` (cooperative
// stop during pass 3). No secrets are ever logged: at most one debug line
// per run carries counts and the reason - never prompts, keys, payloads,
// or description text.

import type { RawJob } from '../jobSources/adapters/http.js';
import type { SearchIntent } from '../discovery/searchIntent.js';
import {
  applyHardFilters,
  jobFilterKey,
  type HardFilterContext,
} from './hardFilters.js';
import {
  scoreJobs,
  type MatcherProfile,
  type ScoredJob,
} from './matcher.js';
import {
  AI_EVALUATION_CONCURRENCY,
  MAX_AI_EVALUATIONS_PER_RUN,
  estimateCost,
  selectAiSubset,
  type CostEstimate,
} from './aiSubset.js';

// ---------------------------------------------------------------------------
// Public shapes (exact per the task contract)
// ---------------------------------------------------------------------------

/** `evaluate` mode on the evaluation options. DEFAULT `'deterministic'` (N18). */
export type EvaluateMode = 'off' | 'deterministic' | 'ai-subset';

export interface EvaluatedJob {
  job: RawJob;
  deterministicScore: number;
  aiEvaluationId?: string;
}

export interface EvaluationOutcome {
  jobs: EvaluatedJob[];
  dropped: Array<{ signature: string; reason: string }>;
  ai: { requested: number; completed: number; skipped: number; reason?: string };
  estimate: { calls: number; approxTokens: number };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EvaluationOptions {
  /**
   * Evaluation depth. DEFAULT `'deterministic'`.
   * - `'off'` / `'deterministic'`: passes 1-2 run, NO AI call at all.
   *   (Within the pipeline the two behave identically by design - passes 1
   *   and 2 always run per N18; the mode exists so the orchestrator/snapshot
   *   can distinguish "evaluation disabled" from "deterministic-only".)
   * - `'ai-subset'`: explicit opt-in - pass 3 runs on the capped subset.
   *   Never implicit: the pipeline never upgrades modes by itself.
   */
  evaluate?: EvaluateMode;
  /** Intent driving pass-1 filters (exclusions, locations, seniority...). */
  intent: SearchIntent;
  /** Optional profile slice for pass 1 (seniority/location/remote). */
  profile?: HardFilterContext['profile'];
  /** Known ids for pass-1 drops. Defaults to two empty sets. */
  known?: {
    evaluatedJobIds: ReadonlySet<string>;
    appliedJobIds: ReadonlySet<string>;
  };
  /** Clock for pass-1 expiry checks. Defaults to `new Date()`. */
  now?: Date;
  /** Resume text for pass-2 scoring. Absent/blank => unscored fallback. */
  resumeText?: string;
  /** Skill/summary profile for pass-2 scoring. */
  matcherProfile?: MatcherProfile;
  /** Minimum pass-2 score for AI candidacy. Default 0. */
  minScore?: number;
  /**
   * Desired AI head-count before the hard cap. Defaults to
   * `MAX_AI_EVALUATIONS_PER_RUN`; always additionally capped by it.
   */
  maxCount?: number;
  /**
   * Already-persisted evaluations, keyed by `jobFilterKey(job)`:
   * `evaluationId` from the existing `JobEvaluation` rows. A listed job is
   * REUSED (id attached, no second AI call) and is exempted from pass 1's
   * `already_evaluated` drop so it can be surfaced. Callers that want
   * suppression instead simply omit the entry (the pass-1 drop then stands).
   */
  existingEvaluations?: ReadonlyMap<string, string>;
  /**
   * THE AI seam: run one evaluation for a subset job, resolve its persisted
   * evaluation id. Production passes a thin wrapper over the EXISTING path
   * (`evaluateJob` + `JobEvaluation` create, as `POST /:id/evaluate` does);
   * tests inject fakes. The pipeline itself persists nothing (N7).
   * A rejection is classified (missing-key / rate-limit / unknown) - see
   * `classifyAiError`. Must not log secrets; must not create Applications.
   */
  evaluateOne?: (job: RawJob, scored: ScoredJob) => Promise<string>;
  /**
   * Optional zero-token LLM-key probe, checked AFTER the estimate is
   * reported but BEFORE the first AI call. `false` => the whole AI pass is
   * skipped with reason `llm_key_missing` (passes 1-2 intact, zero calls).
   */
  probeLlmKey?: () => boolean | Promise<boolean>;
  /** Cooperative cancel: checked before starting each new AI call. */
  isCancelled?: () => boolean;
  /**
   * Receives the cost estimate BEFORE the AI pass runs (before the key
   * probe, before the first call) - the hook the run snapshot (and, in wave
   * 11, the user) observes the forecast through. Also always present as
   * `outcome.estimate`. Invoked exactly once per `evaluateResults` call.
   */
  onEstimate?: (estimate: CostEstimate) => void;
}

// ---------------------------------------------------------------------------
// Error classification (mirrors the preserved route vocabulary)
// ---------------------------------------------------------------------------

const MISSING_KEY_RE = /no .*api keys? configured|add a key in settings|requires? a .*key/i;

function isRateLimitLike(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return typeof error === 'string' && /\b429\b|rate.?limit|quota|too many requests/i.test(error);
  }
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  if (candidate.status === 429) return true;
  if (candidate.code === 'rate_limit_exceeded') return true;
  const message = typeof candidate.message === 'string' ? candidate.message : String(candidate.message ?? '');
  return /rate.?limit|quota|too many requests|\b429\b/i.test(message);
}

type AiErrorKind = 'llm_key_missing' | 'rate_limited' | 'unknown';

function classifyAiError(error: unknown): AiErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (MISSING_KEY_RE.test(message)) return 'llm_key_missing';
  if (isRateLimitLike(error)) return 'rate_limited';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Mirrors the route's usability rule (`jobs.ts:isUsableEvaluateDescription`,
 * itself mirroring `evaluateJobSchema`'s 50-char minimum): a description
 * shorter than 50 chars cannot be evaluated and is dropped with
 * `no_description` - in every mode, before pass 2, so pass 2 never scores
 * rows that could never reach pass 3.
 */
export function isUsablePipelineDescription(description: unknown): boolean {
  return typeof description === 'string' && description.length >= 50;
}

export const PIPELINE_DROP_REASONS = {
  noDescription: 'no_description',
  noResume: 'no_resume',
  noCandidates: 'no_candidates',
  noEvaluator: 'no_evaluator',
  llmKeyMissing: 'llm_key_missing',
  rateLimited: 'rate_limited',
  cancelled: 'cancelled',
} as const;

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function evaluateResults(
  jobs: RawJob[],
  opts: EvaluationOptions,
): Promise<EvaluationOutcome> {
  const mode: EvaluateMode = opts.evaluate ?? 'deterministic';
  const now = opts.now ?? new Date();
  const known = opts.known ?? {
    evaluatedJobIds: new Set<string>(),
    appliedJobIds: new Set<string>(),
  };
  const existing = opts.existingEvaluations;

  // Pass 1 - hard filters over EVERYTHING. Jobs with a reused evaluation
  // are exempted from the `already_evaluated` drop (see options doc). The
  // exemption is computed per job (by `jobFilterKey`) BEFORE filtering, so
  // it holds whatever id form the caller stored in `known` (raw external
  // id, url, or key form) and `kept` preserves the input order.
  const reuseKeys = existing && existing.size > 0 ? new Set(existing.keys()) : null;
  const exempt = new Set<RawJob>();
  if (reuseKeys) {
    for (const job of jobs) {
      if (reuseKeys.has(jobFilterKey(job))) exempt.add(job);
    }
  }
  const rest = reuseKeys ? jobs.filter((job) => !exempt.has(job)) : jobs;
  const pass1 = applyHardFilters(rest, {
    intent: opts.intent,
    profile: opts.profile,
    known,
    now,
  });
  const pass1Reason = new Map<RawJob, string>();
  for (const { job, reason } of pass1.dropped) pass1Reason.set(job, reason);
  const dropped: Array<{ signature: string; reason: string }> = [];
  const kept1: RawJob[] = [];
  for (const job of jobs) {
    if (exempt.has(job)) {
      kept1.push(job);
      continue;
    }
    const reason = pass1Reason.get(job);
    if (reason === undefined) kept1.push(job);
    else dropped.push({ signature: jobFilterKey(job), reason });
  }

  // Evaluability gate: empty descriptions can never be evaluated.
  const describable: RawJob[] = [];
  for (const job of kept1) {
    if (!isUsablePipelineDescription(job.description)) {
      dropped.push({ signature: jobFilterKey(job), reason: PIPELINE_DROP_REASONS.noDescription });
    } else {
      describable.push(job);
    }
  }

  // Pass 2 - deterministic match over the kept set (input order => ranked).
  const scored = scoreJobs(describable, {
    resumeText: opts.resumeText,
    profile: opts.matcherProfile,
  });
  const outJobs: EvaluatedJob[] = scored.map((row) => ({
    job: row.job,
    deterministicScore: row.deterministicScore,
  }));

  const idle: EvaluationOutcome = {
    jobs: outJobs,
    dropped,
    ai: { requested: 0, completed: 0, skipped: 0 },
    estimate: { calls: 0, approxTokens: 0 },
  };

  // 'off' / 'deterministic': NO AI call at all (asserted with a spied client).
  if (mode !== 'ai-subset') {
    opts.onEstimate?.(idle.estimate);
    return idle;
  }

  // Pass 3 - deterministic subset, then the EXISTING evaluate path.
  const subset = selectAiSubset(scored, {
    minScore: opts.minScore ?? 0,
    maxCount: opts.maxCount ?? MAX_AI_EVALUATIONS_PER_RUN,
  });

  // Partition subset into reuse (no call) vs fresh (one call each).
  const reused = new Map<number, string>();
  if (existing && existing.size > 0) {
    for (const [index, row] of subset.entries()) {
      const id = existing.get(jobFilterKey(row.job));
      if (id) reused.set(index, id);
    }
  }
  const toCall = subset
    .map((row, index) => ({ row, index }))
    .filter(({ index }) => !reused.has(index));

  // The estimate forecasts BILLABLE calls (subset minus reuse) and is
  // reported BEFORE the key probe and before any AI call.
  const estimate = estimateCost(toCall.map(({ row }) => row));
  opts.onEstimate?.(estimate);

  const attachReuse = (): number => {
    let count = 0;
    for (const [index, id] of reused) {
      outJobs[findOutIndex(outJobs, subset[index].job)].aiEvaluationId = id;
      count += 1;
    }
    return count;
  };

  if (subset.length === 0) {
    const allUnscored =
      describable.length > 0 && scored.every((row) => row.scored === false);
    return {
      jobs: outJobs,
      dropped,
      ai: {
        requested: 0,
        completed: 0,
        skipped: 0,
        reason: allUnscored
          ? PIPELINE_DROP_REASONS.noResume
          : PIPELINE_DROP_REASONS.noCandidates,
      },
      estimate,
    };
  }

  const reusedCount = attachReuse();

  if (!opts.evaluateOne) {
    return {
      jobs: outJobs,
      dropped,
      ai: {
        requested: subset.length,
        completed: reusedCount,
        skipped: subset.length - reusedCount,
        reason: PIPELINE_DROP_REASONS.noEvaluator,
      },
      estimate,
    };
  }

  if (opts.probeLlmKey) {
    let hasKey = false;
    try {
      hasKey = await opts.probeLlmKey();
    } catch {
      hasKey = false;
    }
    if (!hasKey) {
      return {
        jobs: outJobs,
        dropped,
        ai: {
          requested: subset.length,
          completed: reusedCount,
          skipped: subset.length - reusedCount,
          reason: PIPELINE_DROP_REASONS.llmKeyMissing,
        },
        estimate,
      };
    }
  }

  // Bounded worker pool over the fresh calls. Order of `outJobs` never
  // changes (pass-2 ranking); results attach by index. No NEW call starts
  // once a stop is hit (rate-limit / missing-key / cancel); in-flight calls
  // settle and their completed evaluations are kept. (Plain boolean flags
  // rather than a narrowed union, so closure writes stay type-sound.)
  let completed = reusedCount;
  let rateLimitedHit = false;
  let keyMissingHit = false;
  let cancelledHit = opts.isCancelled?.() === true;
  const shouldStop = (): boolean =>
    rateLimitedHit || keyMissingHit || cancelledHit || opts.isCancelled?.() === true;
  let next = 0;
  const limit = Math.max(1, AI_EVALUATION_CONCURRENCY);

  async function worker(): Promise<void> {
    while (!shouldStop()) {
      if (opts.isCancelled?.() === true) {
        cancelledHit = true;
        return;
      }
      const cursor = next;
      next += 1;
      const item = toCall[cursor];
      if (!item) return;
      try {
        const id = await opts.evaluateOne!(item.row.job, item.row);
        outJobs[findOutIndex(outJobs, item.row.job)].aiEvaluationId = id;
        completed += 1;
      } catch (error) {
        const kind = classifyAiError(error);
        if (kind === 'rate_limited') {
          rateLimitedHit = true;
        } else if (kind === 'llm_key_missing') {
          keyMissingHit = true;
        }
        // 'unknown' per-item failures are skipped in isolation (the job
        // keeps its deterministic score); the rest of the subset proceeds.
      }
      if (opts.isCancelled?.() === true) {
        cancelledHit = true;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, toCall.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const reason = rateLimitedHit
    ? PIPELINE_DROP_REASONS.rateLimited
    : keyMissingHit
      ? PIPELINE_DROP_REASONS.llmKeyMissing
      : cancelledHit || opts.isCancelled?.() === true
        ? PIPELINE_DROP_REASONS.cancelled
        : undefined;

  // Secrets hygiene: counts + reason only - never prompts, keys, payloads.
  if (reason) {
    console.debug(
      `[evaluation] AI pass stopped early (reason=${reason}, requested=${subset.length}, completed=${completed}).`,
    );
  }

  return {
    jobs: outJobs,
    dropped,
    ai: {
      requested: subset.length,
      completed,
      skipped: subset.length - completed,
      ...(reason ? { reason } : {}),
    },
    estimate,
  };
}

/** Locate a subset job's row in pass-2-ranked output (identity by reference). */
function findOutIndex(outJobs: EvaluatedJob[], job: RawJob): number {
  const index = outJobs.findIndex((row) => row.job === job);
  if (index === -1) throw new Error('Pipeline invariant broken: subset job missing from output.');
  return index;
}
