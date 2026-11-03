// Wave 9 Pass 3 - AI subset selection + cost estimate (T782, ADR-027, N5/N18).
//
// The cap that makes N5 true: AI runs only on a bounded, deterministically
// selected subset - never per job for all discoveries.
//
// This module is PURE: no I/O, no DB, no ORM, no model client, no clock.
// The only import is a TYPE (erased at compile time). Selection is
// deterministic: same input yields the same subset, because the input is
// already in pass-2 order (`scoreJobs` output: score DESC, postedAt DESC,
// provenance DESC) and this function preserves that order - it filters and
// truncates, it never re-sorts.
//
// NO second scorer lives here (N7): the scores consumed are the pass-2
// `deterministicScore` values from the existing matcher bridge.

import type { ScoredJob } from './matcher.js';

// ---------------------------------------------------------------------------
// Caps (named constants per the task contract)
// ---------------------------------------------------------------------------

/**
 * Hard per-run ceiling on AI evaluations. `selectAiSubset` never returns
 * more than this many jobs however large `maxCount` is, and the pipeline
 * never issues more AI calls than the subset size - so a run can never
 * become a per-job LLM sweep over all discoveries (N5).
 *
 * Value 5: large enough to cover the genuinely promising head of a result
 * set, small enough that per-run LLM spend stays bounded and reviewable.
 */
export const MAX_AI_EVALUATIONS_PER_RUN = 5;

/**
 * Upper bound on concurrent in-flight AI evaluations within one run, so a
 * run cannot open MAX calls at once and trip provider rate limits. Matches
 * the existing batch-normalize/auto-normalize concurrency of 2.
 */
export const AI_EVALUATION_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// Subset selection
// ---------------------------------------------------------------------------

export interface AiSubsetOptions {
  minScore: number;
  maxCount: number;
}

/**
 * Deterministically select the AI-candidate subset from pass-2 output.
 *
 * - Drops every unscored row (`scored: false`, the no-resume fallback):
 *   a sentinel of -1 must never qualify for AI, whatever `minScore` is.
 * - Keeps rows with `deterministicScore >= minScore`, preserving the
 *   pass-2 order (the input order IS the ranking - no re-sort, hence the
 *   output is a stable subsequence of the input).
 * - Takes at most `maxCount`, additionally hard-capped by
 *   `MAX_AI_EVALUATIONS_PER_RUN`. A non-positive `maxCount` selects nothing.
 */
export function selectAiSubset(scored: ScoredJob[], opts: AiSubsetOptions): ScoredJob[] {
  const limit = Math.max(
    0,
    Math.min(Math.floor(opts.maxCount), MAX_AI_EVALUATIONS_PER_RUN),
  );
  if (limit === 0) return [];
  const eligible = scored.filter(
    (row) => row.scored === true && row.deterministicScore >= opts.minScore,
  );
  return eligible.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Cost estimate
// ---------------------------------------------------------------------------

export interface CostEstimate {
  calls: number;
  approxTokens: number;
}

/**
 * Rough per-call prompt overhead in tokens. Covers the rubric system prompt
 * (~450 tokens), the serialised resume JSON plus optional career-profile
 * section (~500 tokens), and headroom for comp/company research context when
 * Tavily is enabled. A deliberately conservative round number, NOT a
 * measurement - real prompts vary with resume length, profile size, and
 * whether research context is attached.
 */
const AI_EVAL_BASE_PROMPT_TOKENS = 1200;

/**
 * Rough per-call response budget in tokens. The existing evaluate path caps
 * the completion at `max_tokens: 1500` and expects a six-dimension JSON
 * report; 600 is a typical observed report size, NOT a guarantee - a
 * verbose report may use more (up to the 1500 cap) and a terse one less.
 */
const AI_EVAL_RESPONSE_TOKENS = 600;

/**
 * Forecast the LLM cost of evaluating `subset` - number of calls plus an
 * approximate token total - BEFORE any call is made, so the caller (and,
 * via the run snapshot, the user) can see the spend up front.
 *
 * HONEST-PRECISION NOTICE: `approxTokens` is a heuristic, not a
 * measurement. Per job it charges
 * `AI_EVAL_BASE_PROMPT_TOKENS + ceil(description.length / 4) +
 * AI_EVAL_RESPONSE_TOKENS`, using the "1 token ~= 4 characters" rule of
 * thumb for the description slice. It does NOT account for the model or
 * provider in use (different tokenizers split text differently), the exact
 * resume/profile payload, attached research context, retries, or rate-limit
 * backoff. Treat it as an order-of-magnitude budget guard (is this run
 * about to spend ~5 calls / ~tens of thousands of tokens?), never as a
 * billing-precise or metered count. `calls` is exact: one LLM evaluation
 * call per subset job.
 */
export function estimateCost(subset: ScoredJob[]): CostEstimate {
  let approxTokens = 0;
  for (const row of subset) {
    const descriptionLength = row.job.description?.length ?? 0;
    approxTokens +=
      AI_EVAL_BASE_PROMPT_TOKENS +
      Math.ceil(descriptionLength / 4) +
      AI_EVAL_RESPONSE_TOKENS;
  }
  return { calls: subset.length, approxTokens };
}
