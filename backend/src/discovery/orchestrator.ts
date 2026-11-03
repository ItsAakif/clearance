// Search orchestrator - bounded, ordered, cancellable fan-out (Wave 7,
// T742/T882; ADR-027 decisions 4/5/6; ADR-033 decisions 2-5; master-spec N2
// and N18/N19-style ordering).
//
// Replaces unbounded `Promise.all` fan-out with:
//   - mode-scoped company and registry caps, with every exclusion reported;
//   - a bounded Full-mode registry batch behind an injected keyset seam;
//   - tier/priority ordering DERIVED from registry descriptor data;
//   - a bounded pool (maxConcurrent / maxUnits / per-unit timeout /
//     wall-clock budget / per-source result cap);
//   - cooperative cancel scoped to (runId, userId);
//   - tier-4 (browser) routing gated on deep/full + a cheaper-tier failure.
//
// ORDER DERIVATION (T742 STEP 2 - recorded here, not a second table):
// `orderRankFor` maps a PROVIDERS descriptor's own `(tier, kind)` to a rank:
//   tier 1 keyless API (kind 'api') ............ rank tier*10 = 10
//   tier 2 feed/json (kind 'feed'/'json') ...... rank tier*10 = 20
//   tier 3 owned page (kind 'feed', tier 3) .... rank tier*10 = 30
//   aggregators (kind 'aggregator', tier 1) .... rank 40 (after plain HTTP:
//     an aggregator API call is metered/BYOK while tiers 1-3 are keyless
//     plain HTTP, so budget is spent on the free paths first)
//   search backend + dorking (kind 'search') ... rank 50 (query families run
//     once the owned sources have been attempted)
//   scraper BYOK (kind 'scraper', tier 4) ...... rank 60 (metered scraping
//     after the search backend)
//   browser (kind 'browser', tier 4) ........... rank 70, last resort, and
//     additionally gated to deep/full follow-ups only (STEP 5).
// The first three bands fall out of `tier * 10` directly; the remaining
// bands key off `kind` because descriptor tiers alone do not separate them
// (aggregators are tier 1, the search backend is tier 5, the scraper is tier
// 4 - plain tier order would interleave them against the ADR-027 priority).
// A new provider is ordered by its own descriptor fields automatically; the
// rank test walks every PROVIDERS entry to pin this.
//
// REGISTRY SCOPING (T742 STEP 4, extended by T882/ADR-033):
// - Named-company intent resolves against Company/CompanyCareerPage only.
//   Standard reports that its registry scope is disabled and performs no
//   lookup; Deep uses the mode-scoped name/page caps and reports overflow.
// - Full never resolves names. It alone resolves one bounded, cursor-based
//   registry batch through `resolveRegistryPageBatch`; with no seam it keeps
//   the boards and records `registry sweep unavailable`.
// - No other mode has a list-all-pages path, so whole-registry expansion
//   remains structurally impossible outside Full's explicit batch seam.
// - A name matching nothing contributes a 'no registry match' skipped entry;
//   zero matches overall is an empty registry scope with a reason, not an
//   error. A registry with zero rows records 'registry empty' and the run
//   proceeds with the user's own boards.
// - CONTINUATION REWIND (T882/D1 + T891 attempt-3 repair): a Full batch can be
//   truncated by EITHER maxUnits (dropped before scheduling) or the wall clock
//   (never scheduled). `rewindRegistryBeforeUnattempted` is the single seam
//   both feed: the pool reports the first unit it never launched, and the
//   cursor is rewound to the predecessor page's opaque cursor
//   (`previousPage?.cursor ?? previousPage?.id`) immediately before the
//   first fetched page that was never launched (the incoming cursor when
//   it was the first page). The `?? previousPage?.id` fallback exists for
//   fixtures that construct page refs without a cursor (review
//   adjudication 4); the prod Full reader always supplies `cursor`. `hasMore` is forced true so the client never sees "done" over an
//   unattempted page. Cancellation never rewinds - terminal/cancelled runs keep
//   null cursors (N16).
//
// TIER-4 ROUTING (T742 STEP 5, ADR-029/033, N2):
// - Considered ONLY in Deep/Full AND only for a page URL
//   whose cheaper-tier unit FAILED, AND only when 'browser' is in
//   `intent.sourceGroups` (the tier is opt-in: it is not in the intent
//   defaults, so it is never swept by default).
// - Every other case records a skipped-with-reason entry (never a failure).
// - Execution goes through the injected `executeUnit` (production: runSource
//   -> the registry 'browser' descriptor -> LAZY dynamic import, T724), so
//   this module has NO static import of `browser/*` and an absent tier can
//   never break the run. The skipped brand is detected by duck-typing
//   (`skipped === true` / `BrowserTierSkippedError` name), never by import.
//
// CANCEL (T742 STEP 6/7, T820 retention):
// - `cancelRun(runId, userId)` flips a flag scoped to that run and user and
//   aborts the run's controller (in-flight units observe the signal). It is
//   idempotent: repeating it returns true while the run is live.
// - Unknown runId, user mismatch, or an already-finished run (entry removed
//   in `finally`) is a documented no-op returning false.
// - On cancel no new unit starts; a unit settling with an error after cancel
//   is reported `cancelled`, NOT `failed`; the rows collected so far are
//   returned (wave 11 keeps them).
// - RESULT RETENTION (T820, wave-11 DESIGN "Result retention", N16): a
//   cancelled run RESOLVES with the partial set plus `cancelled: true` -
//   never a rejection, never an empty rewrite of what was collected. The
//   `cancelled` boolean on the outcome is the source of truth the route
//   threads into the response, so retention does NOT depend on the run
//   snapshot still existing (RUN_TTL_MS can expire a deep run's snapshot
//   mid-flight; ADR-013 keeps no run state in the DB).
// - NO ROLLBACK (T820, N16): cancel never deletes or un-writes anything.
//   This module performs no persistence at all, and there is deliberately
//   no delete/rollback path on any listing model anywhere in it - search
//   the module in review; it must not exist. Persisted listings are owned
//   by the route's `upsertDiscoveredJobs` backstop and stay queryable after
//   a cancel.
// - BOUNDARY RULE (T820, deterministic): rows received win over cancel -
//   a unit whose executor resolved with rows is recorded `ok` even if the
//   cancel flag landed first (see `executeOne`); an error settling after
//   cancel is recorded `cancelled`, never `failed`. Which side wins is
//   defined by where the result is recorded relative to the cancel-flag
//   check in `executeOne`, so simultaneous completion has exactly one
//   outcome and no test can flake on it.
// - RELEASE (T820, wave-6 T723 hook): cancel aborts the run controller
//   whose signal is handed to every in-flight unit. Session-owning
//   executors (the browser client) observe the signal and release their
//   session in a `finally` on settle; the pool's session accounting
//   returns to 0 the same way. The cancel drain below still bounds the
//   wait by the per-unit timeout (T741 backstop), so an executor that
//   ignores the signal delays resolution by at most that timeout and can
//   never hang the promise - a cancel that leaves an `await` pending is
//   the failure mode this design guards against.
//
// SOURCE-GROUP TOGGLES (T742 STEP 8, ADR-033): a group absent from
// `intent.sourceGroups` is never scheduled and is recorded as
// skipped-with-reason, never as a failure. Standard additionally applies its
// mode envelope, with one explicit reason for every excluded group.
//
// N3 OBLIGATION (T742 STEP 9, wave 5): dorking boards schedule as ordinary
// units. There is deliberately NO exclusive/suppression logic anywhere in
// this module - search for it in review; it must not exist.
//
// WHAT THIS MODULE DOES NOT DO (ADR-013/027): no SSE, no streaming
// transports, no queue, no worker process, no scheduler, no interval
// polling, no route wiring
// (T744 ports the routes). Per-unit timeouts and the budget grace period use
// one-shot setTimeout races only. This module performs no logging, so no
// secret (key, URL credential, page content) can leak into logs; failure
// reasons are length-bounded summaries.
//
// EVALUATION WIRING (T783, wave 9, ADR-027):
// `runSearch` calls `evaluateResults` (evaluation/pipeline.ts) as its FINAL
// step, per the intent's `evaluate` option, over the collected jobs. The
// full end-to-end order mirrors the master-spec pipeline diagram:
//   scope -> collect -> dedupe -> filter/order -> persist -> evaluate.
// Dedupe/filter/order/persist live in the route layer (routes/jobs.ts); the
// route writes the returned summary into the run snapshot AFTER its own
// upsert (discoveryRuns.setRunEvaluation), so JobEvaluation rows created by
// the production AI seam always attach to STORED rows.
//   - Effective mode: `intent.evaluate ?? 'deterministic'`, downgraded to
//     'deterministic' whenever the mode disallows AI (Fast and Standard);
//     Deep and Full preserve an explicit 'ai-subset' request.
//   - The AI seam (`evaluateOne`, key probe, resume/profile context) arrives
//     ONLY through injected `OrchestratorDeps.evaluation`. With no seam
//     wired, an 'ai-subset' request reports `no_evaluator` with zero calls -
//     evaluation can never silently spend.
//   - The cost estimate is computed and reported (via `onEstimate` and the
//     returned summary) BEFORE the first AI call - the pipeline guarantees
//     that ordering. SAME-REQUEST MODEL: the current request shape cannot
//     pause between the estimate and the pass, so the estimate is returned in
//     the outcome/snapshot and the pass runs within the same request; wave 11
//     owns the confirm gate.
//   - Cancel is honoured cooperatively during pass 3 (no new AI call starts).
//   - No auto-apply (N10): nothing here creates an Application row. No
//     scheduler or background evaluation job (ADR-013): everything above runs
//     inside the requesting call.

import prisma from '../lib/prisma.js';
import {
  boardToConfig,
  runSource,
  type JobSourceConfig,
} from '../jobSources/index.js';
import {
  configForRegistryRow,
  getProvider,
  type ProviderDescriptor,
} from '../jobSources/providerRegistry.js';
import type { RawJob } from '../jobSources/adapters/http.js';
import {
  FULL_BATCH_PAGES,
  aiEvaluationAllowed,
  browserTierAllowed,
  budgetFor,
  modeGroupEnvelope,
  scopeCapsFor,
  type RunBudget,
} from './budgets.js';
import {
  SOURCE_GROUP_ORDER,
  SOURCE_ID_TO_GROUP,
  intentToQuery,
  type SearchIntent,
  type SourceGroup,
} from './searchIntent.js';
import {
  evaluateResults,
  type EvaluateMode,
} from '../evaluation/pipeline.js';
import type { CostEstimate } from '../evaluation/aiSubset.js';
import type {
  MatcherProfile,
  ScoredJob,
} from '../evaluation/matcher.js';
import {
  summarizeTimings,
  type TimingSummary,
  type UnitPhaseTracker,
  type UnitTiming,
} from './attribution.js';
import { classifyTransportFailure, httpStatusOf, retryAfterOf, type TransportFailureKind } from '../jobSources/httpStatus.js';
import {
  PolitenessGate,
  isRateLimitStatus,
  politenessKeyFor,
  type PolitenessKey,
} from './politeness.js';

// ---------------------------------------------------------------------------
// Public contract (exact exports per T742 STEP 1)
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  runId: string;
  userId: string;
  signal?: AbortSignal;
}

export type RunUnitStatus = 'ok' | 'failed' | 'cancelled' | 'skipped';

export interface RunUnitState {
  unitId: string;
  kind: 'board' | 'registry-page' | 'browser-followup';
  providerType: string;
  tier: number;
  group: string;
  status: RunUnitStatus;
  resultCount: number;
  latencyMs: number;
  reason?: string;
  /**
   * Wave 15 (T904) additive optional. The count of rows BEFORE the
   * `perSourceResultCap` slice - the honest yield for an `ok` unit. Without
   * it the verification write-back would store the post-cap value and the
   * crawler's own SUSPECT-drop rule would misfire on every sweep of a board
   * with more than the cap. Recorded on every terminal `ok` outcome; absent
   * for failed/cancelled/skipped.
   */
  rawResultCount?: number;
  /**
   * Wave 15 (T904) additive optional. The HTTP status observed by the last
   * probe; null on a successful probe that did not observe an exact code
   * (T902). Populated for terminal ok/failed outcomes when the probe
   * surfaces a status; absent otherwise.
   */
  httpStatus?: number;
  /**
   * Wave 15 (T904) additive optional. Canonical failure kind, from T902's
   * `classifyTransportFailure` on the error/timeout branches, and from the
   * unroutable-row path in `addRegistryPages` (`SourceConfigError` /
   * `UnknownSourceTypeError` -> `'invalid'`). Populated only for terminal
   * `failed` outcomes; absent otherwise. The write-back maps this onto the
   * 8-value `verifyStatus` vocabulary (defaulting to `'http_error'`).
   */
  failureKind?: 'blocked' | 'http_error' | 'timeout' | 'invalid' | 'not_modified';
}

export interface RunOutcome {
  jobs: RawJob[];
  cancelled: boolean;
  truncated: boolean;
  skipped: Array<{ unitId: string; reason: string }>;
  units: RunUnitState[];
  /** Full-scan batch continuation state. Omitted for every non-Full mode. */
  hasMore?: boolean;
  nextCursor?: string | null;
  /** Registry pages resolved in this Full batch and the active-page total. */
  registry?: { processed: number; total: number };
  /**
   * Wave 9 (T783) additive evaluation summary, attached by the final
   * `evaluateResults` step. OPTIONAL so outcomes produced before this wave
   * (and callers that never read it) still type-check. Absent only when the
   * evaluation step itself threw unexpectedly (never part of the pipeline's
   * reported vocabulary); every pipeline outcome - including deterministic
   * fast runs and `no_evaluator`/`no_resume` partials - is recorded here.
   */
  evaluation?: RunEvaluationSummary;
  /**
   * Wave 15 (T900) additive unit-path attribution summary. Populated only
   * when the caller passes `attributeTiming: true` (the /jobs/full-scan
   * route reads `env.SEARCH_ATTRIBUTION === 'on'` and threads the flag).
   * Measurements only - never read as policy input. Off by default, so
   * pre-wave callers see no change.
   */
  timing?: TimingSummary;
  /**
   * Wave 15 (T908) additive optional. Units whose OBSERVED `httpStatus` was
   * 429 or 503 - the raw signal count, BEFORE any bucket-level collapsing.
   * A 403, a 500, a timeout and a pre-fetch config error are NOT signals (403
   * is `blocked` for health, which is a different condition and never opens a
   * rate-limit block). Absent when no signal was observed.
   */
  rateLimitSignals?: number;
  /**
   * Wave 15 (T908) additive optional. `noteBlocked` calls that actually OPENED
   * or EXTENDED a block. Bounded above by `rateLimitSignals` (a unit can open
   * at most one block, and a signal absorbed by an already-active window opens
   * none), which is the invariant the wiring assert rests on.
   */
  blocksOpened?: number;
}

/**
 * Wave 9 (T783) additive evaluation summary. Mirrors the snapshot
 * `evaluation` field (jobSources/discoveryRuns.ts) field-for-field:
 * pipeline `ai` counts plus the pre-pass cost `estimate`. Counts and the
 * reason only - never prompts, keys, payloads, or description text.
 */
export interface RunEvaluationSummary {
  requested: number;
  completed: number;
  skipped: number;
  reason?: string;
  estimate: { calls: number; approxTokens: number };
}

/**
 * Wave 9 (T783) evaluation context, injected per call. Everything is
 * OPTIONAL: with none wired, passes 1-2 still run deterministically and the
 * AI pass reports `no_evaluator` with zero calls. The production AI seam
 * (an `evaluateOne` over the EXISTING evaluate path + `JobEvaluation`,
 * exactly like `POST /:id/evaluate`) is supplied by the route layer
 * post-persistence in wave 11; this module persists nothing itself.
 */
export interface OrchestratorEvaluationDeps {
  /** Resume text for pass-2 scoring. Absent/blank => unscored fallback. */
  resumeText?: string;
  /** Skill/summary profile for pass-2 scoring. */
  matcherProfile?: MatcherProfile;
  /** Minimum pass-2 score for AI candidacy. Default 0. */
  minScore?: number;
  /** Desired AI head-count before the hard cap. Defaults to the cap. */
  maxCount?: number;
  /** Already-persisted evaluations keyed by filter key (reuse, no recall). */
  existingEvaluations?: ReadonlyMap<string, string>;
  /** THE AI seam: run one evaluation, resolve its persisted evaluation id. */
  evaluateOne?: (job: RawJob, scored: ScoredJob) => Promise<string>;
  /** Zero-token LLM-key probe, checked after the estimate, before AI calls. */
  probeLlmKey?: () => boolean | Promise<boolean>;
  /** Receives the cost estimate BEFORE the AI pass runs. */
  onEstimate?: (estimate: CostEstimate) => void;
}

// ---------------------------------------------------------------------------
// Dependency injection (fake adapters in tests, prisma/runSource in prod)
// ---------------------------------------------------------------------------

/** Minimal `CompanyCareerPage` row shape the orchestrator consumes. */
export interface RegistryPageRef {
  /**
   * Stable registry key for keyset continuation. The Full reader always
   * supplies it; it remains optional for the legacy named-company seam, whose
   * callers do not need a continuation cursor.
   */
  id?: string;
  companyName: string;
  url: string;
  provider: string | null;
  boardToken: string | null;
  /**
   * Wave 15 (T905) additive. The immutable page tier. Surfaced so the
   * orchestrator's rewind seam can reason about the cursor encoding without
   * parsing it: `rewindRegistryBeforeUnattempted` only stores the predecessor
   * page's opaque `cursor` string verbatim.
   */
  tier?: number;
  /**
   * Wave 15 (T905) additive. Opaque per-page keyset cursor produced by the
   * registry reader. The orchestrator stores and compares this string
   * verbatim - it never parses the encoding. Required on Full pages (the
   * reader supplies it); optional on legacy named-company pages.
   */
  cursor?: string;
}

export interface CompanyScopeResolution {
  /** Intent-typed names that matched a registry company (same spelling). */
  matchedNames: readonly string[];
  /** Active career pages of the matched companies, in resolution order. */
  pages: readonly RegistryPageRef[];
  /** True when the registry holds zero companies (fresh install). */
  registryEmpty: boolean;
}

export interface UserBoardRef {
  boardId: string;
  name: string;
  type: string;
  config: JobSourceConfig;
}

/** One schedulable fetch: a board, a registry page, or a browser follow-up. */
export interface ExecutableUnit {
  unitId: string;
  kind: 'board' | 'registry-page' | 'browser-followup';
  providerType: string;
  config: JobSourceConfig;
  tier: number;
  group: string;
  /** Company page URL for registry-page units and browser follow-ups. */
  pageUrl?: string;
}

export interface OrchestratorDeps {
  /** Budget override (tests use small budgets; default is budgetFor(mode)). */
  budget?: RunBudget;
  /** Bounded grace after budget exhaustion (default BUDGET_GRACE_MS). */
  graceMs?: number;
  listUserBoards?: (userId: string) => Promise<UserBoardRef[]>;
  resolveCompanies?: (names: readonly string[]) => Promise<CompanyScopeResolution>;
  /** Full-mode keyset batch seam; absent means the sweep is unavailable. */
  resolveRegistryPageBatch?: (
    afterId: string | null,
    limit: number,
  ) => Promise<{
    pages: RegistryPageRef[];
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
  }>;
  /** Opaque Full-mode registry cursor supplied by the calling route. */
  afterCursor?: string | null;
  executeUnit?: (unit: ExecutableUnit, signal: AbortSignal) => Promise<RawJob[]>;
  /** Wave 9 (T783) evaluation context (all optional; see the interface). */
  evaluation?: OrchestratorEvaluationDeps;
  /**
   * Wave 15 (T900) attribution flag. When true the orchestrator records a
   * `UnitTiming` per unit (queuedMs + fetchMs + totalMs + outcome) into a
   * parallel array and attaches a `TimingSummary` to `RunOutcome.timing`.
   * Off by default; the route reads `env.SEARCH_ATTRIBUTION === 'on'`.
   */
  attributeTiming?: boolean;
  /**
   * Wave 15 (T900) optional best-effort phase tracker. Wired by tests;
   * production does not supply one unless explicit attribution is wanted.
   * `createPhaseProbe()` in `attribution.ts` is the documented factory.
   */
  phaseTracker?: UnitPhaseTracker;
  /**
   * Wave 15 (T907) optional in-process per-bucket admission gate. When
   * supplied, `executePool` becomes an admission scheduler: a unit whose
   * bucket is at its cap, inside its `minGap`, or blocked is parked and
   * never enters the in-flight set / never consumes a global slot. The
   * `SEARCH_FULL_POLITENESS=off` switch (route layer) bypasses the gate;
   * with the switch off the orchestrator MUST receive `politenessGate ===
   * undefined` so the pool behaves exactly as pre-wave.
   */
  politenessGate?: PolitenessGate;
  /**
   * Wave 15 (T907) injected monotonic clock used by the admission
   * scheduler. Required when `politenessGate` is supplied (the gate's
   * own `now` injection is the source of truth for scheduling; the
   * pool reuses it so the wait computations are deterministic). When
   * absent, the pool uses `Date.now` (pre-wave behaviour). A test that
   * passes both `politenessGate` and a stubbed `now` is hermetic.
   */
  poolNow?: () => number;
}

/**
 * Effective evaluation mode for a run (T783, wave 9, N18).
 *
 * The intent's `evaluate` option rules, defaulting to `'deterministic'` -
 * EXCEPT fast and standard mode, where an `'ai-subset'` request is downgraded
 * to `'deterministic'`: those modes perform zero AI calls whatever was
 * requested. Deep and Full preserve the request. Pure (no I/O, no clock).
 */
export function effectiveEvaluateMode(intent: SearchIntent): EvaluateMode {
  const requested: EvaluateMode = intent.evaluate ?? 'deterministic';
  if (!aiEvaluationAllowed(intent.mode) && requested === 'ai-subset') return 'deterministic';
  return requested;
}

/** Bounded grace period for in-flight units after the wall-clock budget
 * stops scheduling. Named so tests can reason about it; overridable via
 * deps.graceMs for fast hermetic tests. */
export const BUDGET_GRACE_MS = 2000;

/** Length bound on failure/skip reasons (mirrors discoveryRuns' 500-char
 * bound; outcome reasons stay summaries, never page content or secrets). */
const MAX_REASON_CHARS = 300;

// ---------------------------------------------------------------------------
// Ordering + grouping derived from registry descriptor data (STEP 2)
// ---------------------------------------------------------------------------

/**
 * Rank for scheduling, derived from the descriptor's own `(tier, kind)`
 * (see module header for the recorded rule). Lower runs first. Unknown
 * board types (no descriptor) sort last at 999 so a misconfigured board
 * fails loudly in its unit without disturbing the tier order.
 */
export function orderRankFor(d: ProviderDescriptor): number {
  if (d.kind === 'browser') return 70;
  if (d.kind === 'scraper') return 60;
  if (d.kind === 'search') return 50;
  if (d.kind === 'aggregator') return 40;
  return d.tier * 10;
}

/**
 * Source groups a provider type serves, derived from its descriptor's own
 * `sourceIds` through SOURCE_ID_TO_GROUP (searchIntent's mapping), with a
 * kind fallback for descriptors whose source ids are board names rather
 * than group vocabulary (today only the scraper passthrough names - the
 * 'scraper' id itself still resolves through the mapping).
 */
export function groupsForProviderType(type: string): SourceGroup[] {
  const d = getProvider(type);
  if (!d) return [];
  const groups = new Set<SourceGroup>();
  for (const id of d.sourceIds) {
    const g = SOURCE_ID_TO_GROUP[id];
    if (g) groups.add(g);
  }
  if (groups.size > 0) return [...groups];
  switch (d.kind) {
    case 'api':
      return ['ats'];
    case 'feed':
    case 'json':
      return ['feeds'];
    case 'search':
      return type === 'dorking' ? ['dorking'] : ['search'];
    case 'scraper':
      return ['scraper'];
    case 'aggregator':
      return ['aggregators'];
    case 'browser':
      return ['browser'];
  }
}

// ---------------------------------------------------------------------------
// Default production deps (prisma scope + runSource execution)
// ---------------------------------------------------------------------------

async function defaultListUserBoards(userId: string): Promise<UserBoardRef[]> {
  const rows = await prisma.jobBoard.findMany({
    where: { userId, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((b) => ({
    boardId: b.id,
    name: b.name,
    type: b.type,
    config: {
      ...boardToConfig({
        type: b.type,
        boardId: b.boardId,
        feedUrl: b.feedUrl,
        searchQuery: b.searchQuery,
        searchSite: b.searchSite,
        scraperProvider: b.scraperProvider,
        scraperLocation: b.scraperLocation,
        scraperResults: b.scraperResults,
        scraperUseProxy: b.scraperUseProxy,
        aggregatorProvider: b.aggregatorProvider,
        aggregatorLocation: b.aggregatorLocation,
      }),
      userId,
    },
  }));
}

async function defaultResolveCompanies(
  names: readonly string[],
): Promise<CompanyScopeResolution> {
  const total = await prisma.company.count();
  if (total === 0) return { matchedNames: [], pages: [], registryEmpty: true };
  // Bounded fan-out by construction: at most COMPANY_SCOPE_CAP lookups (the
  // caller slices first). Case-insensitive match; the intent-typed name is
  // reported as matched so per-name 'no registry match' reasons line up.
  const matchedNames: string[] = [];
  const pages: RegistryPageRef[] = [];
  for (const name of names) {
    const company = await prisma.company.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
      include: {
        careerPages: { where: { isActive: true }, orderBy: { updatedAt: 'desc' } },
      },
    });
    if (!company) continue;
    matchedNames.push(name);
    for (const p of company.careerPages) {
      pages.push({
        id: p.id,
        companyName: company.name,
        url: p.url,
        provider: p.provider,
        boardToken: p.boardToken,
      });
    }
  }
  return { matchedNames, pages, registryEmpty: false };
}

class AbortError extends Error {
  constructor() {
    super('unit aborted');
    this.name = 'AbortError';
  }
}

function defaultExecuteUnit(unit: ExecutableUnit, signal: AbortSignal): Promise<RawJob[]> {
  if (signal.aborted) return Promise.reject(new AbortError());
  const work = runSource(unit.config);
  return new Promise<RawJob[]>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (rows) => {
        signal.removeEventListener('abort', onAbort);
        resolve(rows);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Cancel registry (STEP 6/7): live runs keyed by runId, checked per unit
// ---------------------------------------------------------------------------

interface LiveRun {
  userId: string;
  cancelled: boolean;
  controller: AbortController;
}

const liveRuns = new Map<string, LiveRun>();

/**
 * Mark a run cancelled. Scoped to (runId, userId): a user can only cancel
 * their own run, and only the named run is affected. Idempotent while the
 * run is live (repeating returns true). Unknown runId, user mismatch, or an
 * already-finished run is a documented no-op returning false.
 */
export function cancelRun(runId: string, userId: string): boolean {
  const entry = liveRuns.get(runId);
  if (!entry || entry.userId !== userId) return false;
  entry.cancelled = true;
  entry.controller.abort();
  return true;
}

/** Test-only reset for the live-run registry. */
export function resetOrchestratorForTests(): void {
  liveRuns.clear();
}

// ---------------------------------------------------------------------------
// Planning (scoping + ordering + maxUnits, all REPORTED)
// ---------------------------------------------------------------------------

interface PlannedUnit extends ExecutableUnit {
  rank: number;
}

interface Plan {
  ordered: PlannedUnit[];
  /** Units recorded without executing (config errors surface as failed). */
  preRecorded: RunUnitState[];
  skipped: Array<{ unitId: string; reason: string }>;
  truncated: boolean;
  /** Registry page units (cheap tier), for tier-4 follow-up decisions. */
  pageUnits: PlannedUnit[];
  /**
   * Full-mode batch metadata plus the internal stable-id seam used to rewind
   * it. Only the four public fields are copied onto `RunOutcome`; `pages`,
   * `pageByUnit`, and `afterCursor` stay inside the plan.
   */
  registry?: {
    processed: number;
    total: number;
    hasMore: boolean;
    nextCursor: string | null;
    /** Fetched pages in keyset order (including accounted plan exclusions). */
    pages: readonly RegistryPageRef[];
    /** Internal page-to-unit map; never exposed in RunOutcome/RunUnitState. */
    pageByUnit: ReadonlyMap<PlannedUnit, RegistryPageRef>;
    /** Cursor supplied to this fetch, retained when its first page is omitted. */
    afterCursor: string | null;
  };
}

type BuildPlanDeps = Required<
  Pick<OrchestratorDeps, 'listUserBoards' | 'resolveCompanies'>
> &
  Pick<OrchestratorDeps, 'resolveRegistryPageBatch' | 'afterCursor'>;

function boundReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.slice(0, MAX_REASON_CHARS);
}

/** N2-safe skipped-brand detection (duck-typed: no `browser/*` import). */
function skippedReasonOf(err: unknown): string | null {
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>;
    if (rec.skipped === true) {
      return typeof rec.reason === 'string' && rec.reason.length > 0
        ? rec.reason.slice(0, MAX_REASON_CHARS)
        : 'browser tier skipped';
    }
    if (rec.name === 'BrowserTierSkippedError') {
      return typeof rec.reason === 'string' && rec.reason.length > 0
        ? rec.reason.slice(0, MAX_REASON_CHARS)
        : 'browser tier unavailable';
    }
  }
  return null;
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<string, unknown>).name === 'AbortError'
  );
}

/**
 * Rewind a Full batch to the last fetched page before the first page that was
 * never scheduled. This is the one continuation-repair seam: both maxUnits and
 * wall-clock truncation feed it the same stable registry-page ordering, and a
 * first omitted page preserves the incoming keyset cursor.
 *
 * Wave 15 (T905) - the rewound cursor is the PREDECESSOR page's opaque
 * `cursor` (an encoded `(tier, id)` pair). The orchestrator never parses the
 * cursor encoding; only the registry reader does. `registry.afterCursor` is
 * the fallback (and stays so when the first omitted page is the first fetched
 * page).
 */
function rewindRegistryBeforeUnattempted(
  registry: NonNullable<Plan['registry']>,
  firstUnattempted: PlannedUnit | undefined,
): void {
  if (firstUnattempted === undefined) return;
  const page = registry.pageByUnit.get(firstUnattempted);
  const pageIndex = page === undefined ? -1 : registry.pages.indexOf(page);
  const previousPage = pageIndex > 0 ? registry.pages[pageIndex - 1] : undefined;
  registry.hasMore = true;
  // T905: prefer the predecessor's opaque `cursor` over its raw `id`. If the
  // predecessor lacks a cursor (legacy named-company reader path), fall back
  // to its id only as a final resort - the prod Full reader always supplies
  // both, so this branch is unreachable in Full mode today and exists only
  // for type-safety completeness on the shared interface.
  registry.nextCursor =
    previousPage?.cursor ?? previousPage?.id ?? registry.afterCursor;
}

async function buildPlan(
  intent: SearchIntent,
  userId: string,
  deps: BuildPlanDeps,
  budget: RunBudget,
): Promise<Plan> {
  const skipped: Array<{ unitId: string; reason: string }> = [];
  const preRecorded: RunUnitState[] = [];
  let truncated = false;
  const enabled = new Set<string>(intent.sourceGroups);
  const envelope = modeGroupEnvelope(intent.mode);
  const envelopeGroups = envelope === null ? null : new Set(envelope);

  // Every absent intent group is reported as before. Standard additionally
  // has a mode envelope: each excluded group gets one explicit mode-level
  // skip, and units in that group are never scheduled or duplicated below.
  for (const g of SOURCE_GROUP_ORDER) {
    if (envelopeGroups !== null && !envelopeGroups.has(g)) {
      skipped.push({
        unitId: `group:${g}`,
        reason: `mode ${intent.mode} excludes group: ${g}`,
      });
    } else if (!enabled.has(g)) {
      skipped.push({ unitId: `group:${g}`, reason: `group disabled: ${g}` });
    }
  }

  const query = intentToQuery(intent) || intent.query || '';
  const candidates: PlannedUnit[] = [];
  const pageUnits: PlannedUnit[] = [];
  // Full page ids stay on this internal map. They are deliberately not copied
  // into RunUnitState or any response, so the public unit ids remain bounded
  // page:<index> values while cursor correction can use the database key.
  const registryPageByUnit = new Map<PlannedUnit, RegistryPageRef>();

  const gateByGroup = (unitId: string, type: string): SourceGroup[] | null => {
    const groups = groupsForProviderType(type);
    const enabledGroups = groups.filter((g) => enabled.has(g));
    const schedulableGroups = enabledGroups.filter(
      (g) => envelopeGroups === null || envelopeGroups.has(g),
    );
    if (groups.length > 0 && schedulableGroups.length === 0) {
      // A mode-envelope rejection is already reported once at group level.
      // Preserve the existing unit-level reason only for an ordinary toggled-off
      // group, so Standard never duplicates its four explicit mode skips.
      const excludedByMode = enabledGroups.some(
        (g) => envelopeGroups !== null && !envelopeGroups.has(g),
      );
      if (!excludedByMode) {
        skipped.push({
          unitId,
          reason: `group disabled: ${groups.join(',')}`,
        });
      }
      return null;
    }
    return groups;
  };

  const gateByMode = (unitId: string, type: string): boolean => {
    const d = getProvider(type);
    if (d && d.requires.includes('deepMode') && !browserTierAllowed(intent.mode)) {
      skipped.push({ unitId, reason: 'deep mode only' });
      return false;
    }
    return true;
  };

  const addRegistryPages = (pages: readonly RegistryPageRef[]): void => {
    pages.forEach((page, index) => {
      const unitId = `page:${index}`;
      let config: JobSourceConfig;
      try {
        config = {
          ...configForRegistryRow(
            { provider: page.provider, boardToken: page.boardToken, url: page.url },
            query,
            userId,
          ),
          query,
          userId,
        };
      } catch (err) {
        // Unroutable registry row (deferred/unknown provider): reported as a
        // failed unit, the run continues (mirrors runSource-throws behaviour).
        // T904: classify the thrown error into the canonical failure kind so
        // the write-back can map it onto the 8-value verifyStatus vocabulary
        // (defaulting to `'invalid'`). Pre-recorded status stays `failed`.
        //
        // T908: this path CANNOT open a 429/503 block, and that is a property
        // of the row, not an omission. It is PRE-FETCH: `configForRegistryRow`
        // throws `SourceConfigError` / `UnknownSourceTypeError` (registry
        // provider classes, never an `HttpStatusError`), so no upstream was
        // contacted and `httpStatusOf(err)` is `undefined` - there is no
        // observed rate-limit status to react to. There is also no planned
        // unit yet, hence no `PlannedUnit` to derive a bucket key from. The
        // signal and block counters are therefore untouched here; the unit
        // still lands in `units` with `failureKind: 'invalid'` for the write
        // -back. Inventing a block for a configuration error would park a
        // whole bucket for 24 h over a row we never fetched.
        const failureKind: TransportFailureKind =
          classifyTransportFailure(err) ?? 'invalid';
        preRecorded.push({
          unitId,
          kind: 'registry-page',
          providerType: page.provider ?? 'unknown',
          tier: 0,
          group: 'unknown',
          status: 'failed',
          resultCount: 0,
          latencyMs: 0,
          reason: boundReason(err),
          failureKind,
        });
        return;
      }
      const adapterType = config.type;
      const groups = gateByGroup(unitId, adapterType);
      if (!groups) return;
      if (!gateByMode(unitId, adapterType)) return;
      const d = getProvider(adapterType);
      const unit: PlannedUnit = {
        unitId,
        kind: 'registry-page',
        providerType: adapterType,
        config,
        tier: d ? d.tier : 0,
        group: groups[0] ?? 'unknown',
        pageUrl: page.url,
        rank: d ? orderRankFor(d) : 999,
      };
      candidates.push(unit);
      pageUnits.push(unit);
      registryPageByUnit.set(unit, page);
    });
  };

  // Personal scope: the user's own boards (today's behaviour, preserved).
  // N3: every board becomes exactly one unit; dorking gets no special case.
  const boards = await deps.listUserBoards(userId);
  for (const b of boards) {
    const unitId = `board:${b.boardId}`;
    const d = getProvider(b.type);
    const groups = gateByGroup(unitId, b.type);
    if (!groups) continue;
    if (!gateByMode(unitId, b.type)) continue;
    const config: JobSourceConfig = { ...b.config, query, userId };
    if (b.type === 'browser') config.deepMode = true;
    const tier = d ? d.tier : 0;
    candidates.push({
      unitId,
      kind: 'board',
      providerType: b.type,
      config,
      tier,
      group: groups[0] ?? 'unknown',
      rank: d ? orderRankFor(d) : 999,
    });
  }

  const caps = scopeCapsFor(intent.mode);
  let registry: Plan['registry'];
  let registryPages: readonly RegistryPageRef[] = [];

  if (intent.mode === 'full') {
    // Full never resolves named companies. Its only registry path is the
    // injected keyset batch seam, bounded by FULL_BATCH_PAGES.
    if (deps.resolveRegistryPageBatch) {
      const batch = await deps.resolveRegistryPageBatch(
        deps.afterCursor ?? null,
        FULL_BATCH_PAGES,
      );
      registryPages = batch.pages;
      addRegistryPages(batch.pages);
      registry = {
        processed: batch.pages.length,
        total: batch.total,
        hasMore: batch.hasMore,
        nextCursor: batch.nextCursor,
        pages: batch.pages,
        pageByUnit: registryPageByUnit,
        afterCursor: deps.afterCursor ?? null,
      };
    } else {
      skipped.push({ unitId: 'scope:registry', reason: 'registry sweep unavailable' });
    }
  } else if (intent.companies.length > 0) {
    // Named-company scope: Fast and Deep resolve only the mode-scoped company
    // cap. Standard reports its disabled registry scope without any lookup.
    const cappedNames = intent.companies.slice(0, caps.companyCap);
    if (intent.companies.length > caps.companyCap) {
      skipped.push({
        unitId: 'scope:companies',
        reason: `truncated: showing ${caps.companyCap} of ${intent.companies.length} companies`,
      });
    }

    if (caps.registryCap === 0) {
      skipped.push({
        unitId: 'scope:registry',
        reason: 'registry scope disabled: standard mode',
      });
    } else {
      const resolution = await deps.resolveCompanies(cappedNames);
      if (resolution.registryEmpty) {
        skipped.push({ unitId: 'scope:registry', reason: 'registry empty' });
      } else {
        const matched = new Set(resolution.matchedNames);
        for (const name of cappedNames) {
          if (!matched.has(name)) {
            skipped.push({ unitId: `scope:company:${name}`, reason: 'no registry match' });
          }
        }
      }
      const pages = resolution.pages.slice(0, caps.registryCap);
      if (Number.isFinite(caps.registryCap) && resolution.pages.length > caps.registryCap) {
        skipped.push({
          unitId: 'scope:pages',
          reason: `truncated: showing ${caps.registryCap} of ${resolution.pages.length} pages`,
        });
      }
      addRegistryPages(pages);
    }
  }

  // Stable order: rank first, plan order within a rank (Array.sort is stable).
  candidates.sort((a, b) => a.rank - b.rank);

  // maxUnits: beyond the cap units are NOT scheduled; the dropped ids are
  // reported and the run is truncated (never silently dropped).
  let ordered = candidates;
  if (candidates.length > budget.maxUnits) {
    ordered = candidates.slice(0, budget.maxUnits);
    for (const dropped of candidates.slice(budget.maxUnits)) {
      skipped.push({
        unitId: dropped.unitId,
        reason: `truncated: exceeds maxUnits=${budget.maxUnits}`,
      });
    }
    truncated = true;

    // A Full reader cursor is opaque and names the last fetched row's
    // encoded `(tier, id)` pair. If maxUnits leaves a fetched page
    // unscheduled, that cursor would skip the page on the next request.
    // Rewind to the predecessor page's opaque cursor
    // (`previousPage?.cursor ?? previousPage?.id`) immediately before the
    // FIRST unattempted fetched page; the next keyset read then resumes at
    // that page without repeating any page already scheduled in this
    // batch. The `?? previousPage?.id` fallback exists for fixtures that
    // construct page refs without a cursor (review adjudication 4); the
    // prod Full reader always supplies `cursor`.
    if (registry !== undefined) {
      const scheduled = new Set(ordered);
      rewindRegistryBeforeUnattempted(
        registry,
        pageUnits.find((unit) => !scheduled.has(unit)),
      );
    }
  }

  return {
    ordered,
    preRecorded,
    skipped,
    truncated,
    pageUnits,
    ...(registry !== undefined ? { registry } : {}),
  };
}

// ---------------------------------------------------------------------------
// Bounded pool (STEP 3)
// ---------------------------------------------------------------------------

type StopCause = 'done' | 'cancel' | 'budget';

interface PoolCtx {
  budget: RunBudget;
  deadlineMs: number;
  graceMs: number;
  signal: AbortSignal;
  isCancelled: () => boolean;
  executor: (unit: ExecutableUnit, signal: AbortSignal) => Promise<RawJob[]>;
  units: RunUnitState[];
  /**
   * Wave 15 (T900) parallel timing array. Populated only when
   * `attributeTiming === true`; otherwise an empty array is kept so the
   * existing record() / finalize() code paths stay uniform. The two arrays
   * are index-correlated by `pool launch order` (NOT the plan order, which
   * the budget may truncate before launch).
   */
  timings: UnitTiming[];
  attributeTiming: boolean;
  jobs: RawJob[];
  skipped: Array<{ unitId: string; reason: string }>;
  /** Pool start (overwritten by `executePool` at its entry; the initial
   *  value in `runSearch` exists only so the field is defined before the
   *  first pool call). Used to compute `queuedMs`. */
  poolStartMs: number;
  /** Wave 15 (T900) optional best-effort phase tracker; unwrapped when absent. */
  phaseTracker?: UnitPhaseTracker;
  /**
   * Wave 15 (T907) optional per-bucket admission gate. When supplied,
   * `executePool` parks units that cannot be admitted (no in-flight slot,
   * no global capacity consumed) and waits for the earliest next-ready
   * event bounded by `ctx.deadlineMs`. Absent means the pre-wave pool
   * (no admission check, every unit is launchable when capacity allows).
   */
  politenessGate?: PolitenessGate;
  /**
   * Wave 15 (T907) monotonic clock used by the admission scheduler.
   * Defaults to `Date.now` when the gate is absent. Tests supply a stub.
   */
  poolNow: () => number;
  /**
   * Wave 15 (T908) bounded rate-limit counters, copied onto the outcome at the
   * end of `runSearch`. `signals` counts units whose observed httpStatus was
   * 429/503; `blocks` counts the `noteBlocked` calls that opened or extended
   * a block. Both are 0 whenever no politeness gate was supplied.
   */
  rateLimitSignals: number;
  blocksOpened: number;
}

interface KillToken {
  killed: boolean;
  settled: boolean;
  promise: Promise<void>;
  kill: () => void;
}

function makeKillToken(): KillToken {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  const token: KillToken = {
    killed: false,
    settled: false,
    promise,
    kill: () => {
      token.killed = true;
      resolve();
    },
  };
  return token;
}

function sleepMs(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

type ExecOutcome =
  | { kind: 'rows'; rows: RawJob[] }
  | { kind: 'error'; err: unknown }
  | { kind: 'timeout' }
  | { kind: 'killed' };

async function executeOne(
  unit: PlannedUnit,
  launchMs: number,
  ctx: PoolCtx,
  token: KillToken,
): Promise<void> {
  const startedAt = Date.now();
  const record = (
    status: RunUnitStatus,
    resultCount: number,
    reason?: string,
    extras?: { rawResultCount?: number; httpStatus?: number; failureKind?: TransportFailureKind },
  ): void => {
    const finishedAt = Date.now();
    const latencyMs = finishedAt - startedAt;
    ctx.units.push({
      unitId: unit.unitId,
      kind: unit.kind,
      providerType: unit.providerType,
      tier: unit.tier,
      group: unit.group,
      status,
      resultCount,
      latencyMs,
      ...(reason !== undefined ? { reason } : {}),
      ...(extras?.rawResultCount !== undefined ? { rawResultCount: extras.rawResultCount } : {}),
      ...(extras?.httpStatus !== undefined ? { httpStatus: extras.httpStatus } : {}),
      ...(extras?.failureKind !== undefined ? { failureKind: extras.failureKind } : {}),
    });
    if (ctx.attributeTiming) {
      // queuedMs = launch time - pool start (the pool's saturation curve).
      // fetchMs  = finishedAt - startedAt (executor call wall time).
      // totalMs  = latencyMs (always equals RunUnitState.latencyMs).
      // `fetchMs + queuedMs <= totalMs` is NOT enforced: totalMs also
      // includes the slice between two consecutive units and per-pool wakeup
      // jitter, which is exactly the gap `consistency.deviation` exposes.
      ctx.timings.push({
        unitId: unit.unitId,
        kind: unit.kind,
        providerType: unit.providerType,
        group: unit.group,
        queuedMs: Math.max(0, launchMs - ctx.poolStartMs),
        fetchMs: Math.max(0, finishedAt - startedAt),
        totalMs: latencyMs,
        outcome: status,
        resultCount,
      });
    }
  };
  try {
    const invoke = (): Promise<RawJob[]> => Promise.resolve(ctx.executor(unit, ctx.signal));
    const work = ctx.phaseTracker !== undefined
      ? Promise.resolve(ctx.phaseTracker.wrap(unit.unitId, invoke))
      : invoke();
    // The pool owns the outcome race; a late settlement after timeout/kill
    // must never surface as an unhandled rejection.
    void work.catch(() => {});
    const timeout = sleepMs(ctx.budget.perUnitTimeoutMs);
    let outcome: ExecOutcome;
    try {
      outcome = await Promise.race([
        (async (): Promise<ExecOutcome> => {
          try {
            return { kind: 'rows', rows: await work };
          } catch (err) {
            return { kind: 'error', err };
          }
        })(),
        timeout.promise.then((): ExecOutcome => ({ kind: 'timeout' })),
        token.promise.then((): ExecOutcome => ({ kind: 'killed' })),
      ]);
    } finally {
      timeout.cancel();
    }
    // Killed by the budget grace expiry: the killer already recorded
    // `budget_exhausted`; never double-record.
    if (token.killed || outcome.kind === 'killed') return;
    if (outcome.kind === 'timeout') {
      // T904: a per-unit timeout is a `timeout` failure kind (no httpStatus;
      // the probe did not observe a status).
      // T908: a timeout can NEVER open a 429/503 block - the upstream never
      // answered, so no status was observed and there is no server pressure to
      // react to. The signal counter is deliberately untouched here.
      record('failed', 0, `timeout after ${ctx.budget.perUnitTimeoutMs}ms`, {
        failureKind: 'timeout',
      });
      return;
    }
    if (outcome.kind === 'error') {
      // T820 BOUNDARY RULE (deterministic, see module header): cancel wins
      // over failure. A unit stopped by cancel - observed via the flag or
      // via an AbortError from a cooperative executor - is `cancelled`,
      // NOT `failed`, so a cancelled run never looks broken.
      if (ctx.isCancelled() || isAbortError(outcome.err)) {
        record('cancelled', 0, 'cancelled');
        return;
      }
      // Skipped-brand (absent browser tier): skipped-with-reason, not failed.
      const skipReason = skippedReasonOf(outcome.err);
      if (skipReason !== null) {
        record('skipped', 0, skipReason);
        ctx.skipped.push({ unitId: unit.unitId, reason: skipReason });
        return;
      }
      // T904: classify the throw into the canonical failure kind so the
      // write-back can map it onto the 8-value verifyStatus vocabulary. A
      // branded skip was excluded above; classifyTransportFailure therefore
      // returns a non-null TransportFailureKind here (a plain Error becomes
      // `'http_error'`).
      const failureKind = classifyTransportFailure(outcome.err) ?? 'http_error';
      const httpStatus = httpStatusOf(outcome.err);
      // T908: observed 429/503 SERVER PRESSURE feeds the per-bucket backoff.
      // `failureKind === 'blocked'` is deliberately NOT the test here: 403 is
      // classified `blocked` too and must never open a rate-limit block
      // (ADR-034 D2.4). The trigger is the observed status alone.
      //
      // MUTATION SPOT-CHECK (T908): the call below is the wiring under test.
      // Deleting it must fail three tests in
      // `wave 15 T908 429/503 backoff wiring in the orchestrator` (no block
      // opens, so `blocksOpened` reads 0 and the blocked bucket is re-fetched).
      // Do not "simplify" this away.
      if (httpStatus !== undefined) {
        noteRateLimitSignal(ctx, unit, httpStatus, retryAfterOf(outcome.err) ?? null);
      }
      record('failed', 0, boundReason(outcome.err), {
        failureKind,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      });
      return;
    }
    if (!Array.isArray(outcome.rows)) {
      record('failed', 0, 'unit returned non-array result');
      return;
    }
    // T820 BOUNDARY RULE (deterministic, see module header): rows received
    // win over cancel. Success is success: a unit whose executor resolved
    // finished its work, even if cancel landed mid-flight (cancel stops
    // SCHEDULING and marks erroring units cancelled; it does not rewrite a
    // completed result). The rows are kept in the partial set the cancelled
    // run resolves with - retention, not rollback.
    const rawResultCount = outcome.rows.length;
    const capped = outcome.rows.slice(0, ctx.budget.perSourceResultCap);
    // T904: rawResultCount is the honest yield - recorded BEFORE the cap
    // slice so the write-back stores the truth and the crawler's own
    // SUSPECT-drop rule never fires on our truncation.
    record('ok', capped.length, undefined, { rawResultCount });
    ctx.jobs.push(...capped);
  } finally {
    token.settled = true;
  }
}

interface PoolResult {
  stop: StopCause;
  /**
   * Index of the first unit that was never launched. `null` means every unit in
   * this pool was launched. This is scheduling evidence, not a count inferred
   * from failures/timeouts, so a timed-out/failed page remains accounted.
   *
   * T907: kept for compatibility with pre-wave consumers that reason about a
   * contiguous ordered.slice(next) suffix. Parking makes the never-launched
   * set non-contiguous; `neverLaunched` is the truth. New code should read
   * `neverLaunched` first and treat `firstUnscheduledIndex` as a derived view.
   */
  firstUnscheduledIndex: number | null;
  /**
   * T907: set of indices into `ordered` that were never launched in this
   * pool pass. Supersedes the implicit `ordered.slice(firstUnscheduledIndex)`
   * suffix because parking (per-bucket admission) makes the never-launched
   * set non-contiguous. `cancel` reports every unscheduled unit; `budget`
   * reports every parked + every unscheduled unit; `done` is empty.
   */
  neverLaunched: ReadonlySet<number>;
}

/**
 * Compute the politeness bucket key for a planned unit. The KEY RULE
 * (ADR-034 D2.1) lives in `politeness.ts`. The orchestrator passes the
 * unit's resolved adapter as `provider` (planned unit's providerType is
 * the adapter type returned by `adapterTypeFor(page.provider)`), the
 * unit's tier, an optional page host (threaded through by the route -
 * additive, currently null), and the unit's pageUrl.
 */
function bucketKeyForUnit(unit: PlannedUnit, pageHost?: string | null): PolitenessKey {
  return politenessKeyFor({
    providerType: unit.providerType,
    tier: unit.tier,
    provider: unit.providerType,
    host: pageHost ?? null,
    pageUrl: unit.pageUrl ?? null,
  });
}

/**
 * Read the registry-page `host` for the politeness key derivation. Today
 * no provider descriptor exposes a `host` field on the planned unit; the
 * helper returns `null` so `politenessKeyFor` derives the host from
 * `pageUrl` (or falls through to `fallback`). The seam is here so a
 * future additive `host` column on the page ref can be threaded through
 * without changing the gate wiring.
 */
function pageHostForUnit(_unit: PlannedUnit): string | null {
  return null;
}

/**
 * T908: report one OBSERVED rate-limit signal to the per-bucket backoff, and
 * keep the two bounded run counters.
 *
 * Rules, all deliberate:
 *   - The trigger is the observed status (429/503), never the `blocked`
 *     failure kind: 403 is `blocked` for health and must not back off a bucket.
 *   - The key is `bucketKeyForUnit` - the SAME function admission uses in
 *     `executePool`. A divergence here would either block an unrelated bucket
 *     ("one tenant's 429 blocks the whole host") or park units on a bucket the
 *     block never touched ("the block hits an empty queue").
 *   - `rateLimitSignals` counts the OBSERVED unit, `blocksOpened` counts the
 *     calls that actually opened or extended a block. A signal absorbed by an
 *     already-active window (one-event-per-window) counts in the first and not
 *     the second, so `blocksOpened <= rateLimitSignals` holds structurally.
 *   - With no gate supplied (`SEARCH_FULL_POLITENESS=off`) nothing is opened
 *     and the signal is still recorded: the response marks the sweep as
 *     unprotected, and the honesty of the counter does not depend on the knob.
 */
function noteRateLimitSignal(
  ctx: PoolCtx,
  unit: PlannedUnit,
  status: number,
  retryAfter: string | null,
): void {
  if (!isRateLimitStatus(status)) return;
  ctx.rateLimitSignals += 1;
  const gate = ctx.politenessGate;
  if (gate === undefined) return;
  const key = bucketKeyForUnit(unit, pageHostForUnit(unit));
  const before = gate.backoffStateFor(key);
  gate.noteBlocked(key, status, retryAfter);
  const after = gate.backoffStateFor(key);
  if (after.blockedUntilMs > before.blockedUntilMs) ctx.blocksOpened += 1;
}

async function executePool(
  ordered: PlannedUnit[],
  ctx: PoolCtx,
  launchedCounter: { count: number },
): Promise<PoolResult> {
  ctx.poolStartMs = ctx.poolNow();
  const width = Math.max(1, ctx.budget.maxConcurrent);
  const gate = ctx.politenessGate;
  const inFlight = new Set<Promise<void>>();
  const tokens: Array<{ unit: PlannedUnit; token: KillToken; launchMs: number; index: number }> = [];
  const parked: Array<{ index: number; bucketKey: PolitenessKey }> = [];
  // Track every (index, bucketKey) pair that ever sat in `parked` (gate-
  // deferred). The `parked` array is a worklist that the scheduler loop
  // empties as it re-tries admission; `parkedHistory` is the cumulative
  // map used to build the never-launched accounting and the politeness-
  // deferred skipped reasons.
  const parkedHistory = new Map<number, PolitenessKey>();
  // Set of indices that WERE parked at some point and later admitted
  // (launched) by the scheduler loop. Subtracted from `parkedHistory`
  // when computing `neverLaunched` so an eventually-admitted unit is
  // not reported as deferred.
  const admittedFromParked = new Set<number>();
  let stop: StopCause = 'done';
  let next = 0;

  // Walk the plan in index order. Each index is either launched (admitted
  // and consuming an in-flight slot) or parked (gate refused; never
  // enters in-flight, never consumes a global slot). When the gate is
  // absent, every unit is launchable when capacity allows.
  while (next < ordered.length) {
    if (ctx.isCancelled()) { stop = 'cancel'; break; }
    if (ctx.poolNow() >= ctx.deadlineMs) { stop = 'budget'; break; }
    if (inFlight.size >= width) {
      const wake = sleepMs(Math.max(0, ctx.deadlineMs - ctx.poolNow()));
      try { await Promise.race([...inFlight, wake.promise]); }
      finally { wake.cancel(); }
      // Re-check: an in-flight unit may have freed a slot.
      if (inFlight.size < width) continue;
      // Still full: deadline-bound sleep protects against a hung unit.
      if (ctx.poolNow() >= ctx.deadlineMs) { stop = 'budget'; break; }
      continue;
    }
    const unit = ordered[next];
    let bucketKey: PolitenessKey | null = null;
    if (gate !== undefined) {
      bucketKey = bucketKeyForUnit(unit, pageHostForUnit(unit));
      const admitted = gate.tryAcquire(bucketKey);
      if (!admitted) {
        parked.push({ index: next, bucketKey });
        parkedHistory.set(next, bucketKey);
        gate.noteDeferred(bucketKey);
        next += 1;
        continue;
      }
    }
    launchedCounter.count += 1;
    const i = next;
    next += 1;
    const launchMs = ctx.poolNow();
    const token = makeKillToken();
    tokens.push({ unit, token, launchMs, index: i });
    const p = executeOne(unit, launchMs, ctx, token).then(
      () => {
        inFlight.delete(p);
        if (gate !== undefined && bucketKey !== null) gate.release(bucketKey);
      },
      () => {
        inFlight.delete(p);
        if (gate !== undefined && bucketKey !== null) gate.release(bucketKey);
      },
    );
    inFlight.add(p);
  }

  // Main scheduler loop: parked + capacity + budget headroom -> retry
  // admission. When nothing is admissible, sleep until the earliest
  // next-ready event or the deadline.
  while (
    parked.length > 0 &&
    inFlight.size < width &&
    !ctx.isCancelled() &&
    ctx.poolNow() < ctx.deadlineMs
  ) {
    const stillParked: typeof parked = [];
    let admittedAny = false;
    for (const p of parked) {
      if (ctx.isCancelled() || ctx.poolNow() >= ctx.deadlineMs) { stillParked.push(p); continue; }
      if (inFlight.size >= width) { stillParked.push(p); continue; }
      if (gate !== undefined) {
        if (gate.tryAcquire(p.bucketKey)) {
          const unit = ordered[p.index];
          if (unit !== undefined) {
            launchedCounter.count += 1;
            admittedFromParked.add(p.index);
            const launchMs = ctx.poolNow();
            const token = makeKillToken();
            tokens.push({ unit, token, launchMs, index: p.index });
            const bucketKey = p.bucketKey;
            const promise = executeOne(unit, launchMs, ctx, token).then(
              () => {
                inFlight.delete(promise);
                if (gate !== undefined) gate.release(bucketKey);
              },
              () => {
                inFlight.delete(promise);
                if (gate !== undefined) gate.release(bucketKey);
              },
            );
            inFlight.add(promise);
            admittedAny = true;
          }
        } else {
          gate.noteDeferred(p.bucketKey);
          stillParked.push(p);
        }
      }
    }
    parked.length = 0;
    for (const p of stillParked) parked.push(p);
    if (admittedAny) continue;
    if (parked.length === 0) break;
    if (ctx.isCancelled()) break;
    if (ctx.poolNow() >= ctx.deadlineMs) break;

    // Nothing admissible. Compute a sleep until the earliest concrete
    // event: a minGap window expiring, a backoff clearing, or simply the
    // next in-flight unit settling (which may free a bucket slot). The
    // existing `sleepMs` + `Promise.race` shape guarantees a hung unit
    // cannot pin the loop past the wall clock.
    const tNow = ctx.poolNow();
    let earliest = ctx.deadlineMs;
    if (gate !== undefined) {
      for (const p of parked) {
        const ready = gate.nextReadyAt(p.bucketKey);
        if (ready > tNow && ready < earliest) earliest = ready;
      }
    }
    const waitMs = Math.max(0, earliest - tNow);
    const cap = Math.max(0, ctx.deadlineMs - tNow);
    if (cap === 0) break;
    // Wait for in-flight to settle OR the earliest next-ready OR the
    // deadline, whichever comes first. Including in-flight in the race
    // matters when nextReadyAt returns `t` for an over-cap bucket - any
    // settlement may free a slot.
    if (inFlight.size > 0) {
      const wake = sleepMs(Math.min(waitMs || cap, cap));
      try { await Promise.race([...inFlight, wake.promise]); }
      finally { wake.cancel(); }
    } else {
      const wake = sleepMs(Math.min(waitMs, cap));
      try { await wake.promise; }
      finally { wake.cancel(); }
    }
  }

  // Determine stop cause and the never-launched set.
  //
  // T907 D1 (review-T907 D1): a deadline stop with parked (gate-deferred)
  // units and ZERO in-flight units must still report those parked units as
  // `skipped` with a truthful reason, force `hasMore = true`, and run the
  // rewind. Pre-fix, the classification at the original site flipped `stop`
  // to `'budget'` ONLY when `inFlight.size > 0`, so an all-parked-at-deadline
  // shape left `stop = 'done'` with a non-empty `neverLaunched` and the
  // accounting at :1500-1508 (below) was skipped entirely: pages fetched but
  // never launched vanished from both `units` and `skipped`, the cursor
  // advanced past them, and contract acceptance 5 / invariant 6 / spec edge
  // case 17 all failed. The `neverLaunched` set is therefore built FIRST
  // (so the budget classification has it in scope), and the classification
  // is widened to `'budget'` whenever the deadline fires AND parked work
  // remained, regardless of in-flight count.
  const neverLaunched = new Set<number>();
  for (const idx of parkedHistory.keys()) {
    if (!admittedFromParked.has(idx)) neverLaunched.add(idx);
  }
  // `next` is the next index the walk loop would have processed; indices
  // >= `next` were never touched by the walk. A `'done'` walk walked
  // everything (no parked, no in-flight) and there is nothing left to add
  // here; a `'budget'`/`'cancel'` walk may have parked everything and
  // `next` is the lower bound of the still-unwalked suffix.
  const walkStoppedEarly = stop !== 'done' || parked.length > 0;
  if (walkStoppedEarly) {
    for (let i = next; i < ordered.length; i++) neverLaunched.add(i);
  }

  if (ctx.isCancelled()) stop = 'cancel';
  else if (ctx.poolNow() >= ctx.deadlineMs && (inFlight.size > 0 || neverLaunched.size > 0)) {
    stop = 'budget';
  }

  // parkedHistory is the source of truth for parked bucket keys (the
  // `parked` worklist may be empty by the time we reach this branch
  // because the scheduler loop empties it as units it admits). All keys in
  // neverLaunched have an entry in parkedHistory; entries in parkedHistory
  // for indices NOT in neverLaunched were admitted (and are accounted for
  // elsewhere).
  const parkedBucket = parkedHistory;

  let firstUnscheduledIndex: number | null = null;
  if (neverLaunched.size > 0) {
    let lowest = Number.POSITIVE_INFINITY;
    for (const idx of neverLaunched) if (idx < lowest) lowest = idx;
    firstUnscheduledIndex = lowest === Number.POSITIVE_INFINITY ? null : lowest;
  }

  // Done-with-nothing: every unit walked, no parked, no in-flight. The
  // all-parked-at-deadline case is now correctly classified as `budget`
  // above (parkedHistory keys fall into `neverLaunched`, which widened the
  // budget classification), so this branch only fires when there really is
  // no never-launched work to account for and `stop` is still `'done'`.
  if (stop === 'done' && parked.length === 0 && inFlight.size === 0) {
    return { stop, firstUnscheduledIndex: null, neverLaunched: new Set() };
  }

  // T907 D1 (review-T907 D1, site 2): the drain may flip `done` to
  // `'budget'` (deadline fired while we waited for in-flight settlement) or
  // `'cancel'`. In EITHER case we must NOT `return` here with the original
  // `{ stop, firstUnscheduledIndex, neverLaunched }` shape - the cancel and
  // budget branches below do the truthful-skipped / parkedBucket accounting
  // that `runSearch` reads to force `hasMore` and drive the rewind. The
  // drain itself is `await Promise.allSettled([...inFlight])`; falling
  // through to the cancel/budget branches below reuses that wait.
  if (stop === 'done') {
    while (inFlight.size > 0) {
      if (ctx.isCancelled()) { stop = 'cancel'; break; }
      if (ctx.poolNow() >= ctx.deadlineMs) { stop = 'budget'; break; }
      const wake = sleepMs(Math.max(0, ctx.deadlineMs - ctx.poolNow()));
      try { await Promise.race([...inFlight, wake.promise]); }
      finally { wake.cancel(); }
    }
    if (stop === 'done') {
      await Promise.allSettled([...inFlight]);
      if (ctx.isCancelled()) {
        stop = 'cancel';
      }
    }
  }

  // T907 D1 (review-T907 D1-3): the drain does NOT re-scan the parked
  // worklist, so a pool that settles BEFORE the deadline can return
  // `stop: 'done'` with a non-empty `neverLaunched` (the scheduler loop
  // exits immediately when `inFlight.size >= width` at :1353). The
  // units are reported by the accounting below, but `runSearch` gates
  // the rewind / `hasMore` forcing / `truncated` on `stop === 'budget'`
  // (:1664), so the batch would report a clean finish while dropping a
  // fetched page for good. Classify any residual never-launched work as
  // a budget stop so the rewind runs (spec AC20 / edge case 5).
  if (stop === 'done' && neverLaunched.size > 0) stop = 'budget';

  if (stop === 'cancel') {
    await Promise.allSettled([...inFlight]);
    for (const idx of neverLaunched) {
      const unit = ordered[idx];
      if (unit === undefined) continue;
      const bk = parkedBucket.get(idx);
      const reason = bk !== undefined
        ? `politeness deferred: ${bk}`
        : 'cancelled';
      ctx.skipped.push({ unitId: unit.unitId, reason });
    }
    return { stop, firstUnscheduledIndex, neverLaunched };
  }

  // stop === 'budget'
  for (const idx of neverLaunched) {
    const unit = ordered[idx];
    if (unit === undefined) continue;
    const bk = parkedBucket.get(idx);
    const reason = bk !== undefined
      ? `politeness deferred: ${bk}`
      : 'budget exhausted';
    ctx.skipped.push({ unitId: unit.unitId, reason });
  }
  if (inFlight.size > 0) {
    const grace = sleepMs(ctx.graceMs);
    try { await Promise.race([Promise.allSettled([...inFlight]), grace.promise]); }
    finally { grace.cancel(); }
    for (const { unit, token, launchMs } of tokens) {
      if (!token.settled && !token.killed) {
        const now = ctx.poolNow();
        const latencyMs = now - ctx.deadlineMs + ctx.budget.totalBudgetMs;
        token.kill();
        ctx.units.push({
          unitId: unit.unitId,
          kind: unit.kind,
          providerType: unit.providerType,
          tier: unit.tier,
          group: unit.group,
          status: 'failed',
          resultCount: 0,
          latencyMs,
          reason: 'budget_exhausted',
        });
        if (ctx.attributeTiming) {
          ctx.timings.push({
            unitId: unit.unitId,
            kind: unit.kind,
            providerType: unit.providerType,
            group: unit.group,
            queuedMs: Math.max(0, launchMs - ctx.poolStartMs),
            fetchMs: Math.max(0, now - launchMs),
            totalMs: latencyMs,
            outcome: 'failed',
            resultCount: 0,
          });
        }
      }
    }
  }
  await Promise.allSettled([...inFlight]);
  return { stop, firstUnscheduledIndex, neverLaunched };
}

// ---------------------------------------------------------------------------
// runSearch (STEP 1)
// ---------------------------------------------------------------------------

/**
 * Run a search intent through scope resolution, ordered bounded execution,
 * and gated tier-4 follow-ups. Per-unit failures never fail the run; every
 * truncation, skip, and budget kill is reported in the outcome.
 */
export async function runSearch(
  intent: SearchIntent,
  opts: OrchestratorOptions,
  deps: OrchestratorDeps = {},
): Promise<RunOutcome> {
  const budget = deps.budget ?? budgetFor(intent.mode);
  const graceMs = deps.graceMs ?? BUDGET_GRACE_MS;
  const listUserBoards = deps.listUserBoards ?? defaultListUserBoards;
  const resolveCompanies = deps.resolveCompanies ?? defaultResolveCompanies;
  const executor = deps.executeUnit ?? defaultExecuteUnit;

  const entry: LiveRun = { userId: opts.userId, cancelled: false, controller: new AbortController() };
  liveRuns.set(opts.runId, entry);
  const onExternalAbort = (): void => {
    entry.cancelled = true;
    entry.controller.abort();
  };
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const outcome: RunOutcome = { jobs: [], cancelled: false, truncated: false, skipped: [], units: [] };
  const timings: UnitTiming[] = [];
  const attributeTiming = deps.attributeTiming === true;
  const phaseTracker = deps.phaseTracker;
  try {
    const poolNow = deps.poolNow ?? (() => Date.now());
    const startMs = poolNow();
    const ctx: PoolCtx = {
      budget,
      // T907: deadline is expressed on the SAME clock as `poolNow`. When
      // the caller injects a stub clock, the deadline is also stub-relative
      // so the two are comparable inside `executePool`. When no stub is
      // injected, `poolNow === Date.now` and the deadline is wall-clock.
      deadlineMs: startMs + budget.totalBudgetMs,
      graceMs,
      signal: entry.controller.signal,
      isCancelled: () =>
        entry.cancelled || entry.controller.signal.aborted || opts.signal?.aborted === true,
      executor,
      units: outcome.units,
      timings,
      attributeTiming,
      jobs: outcome.jobs,
      skipped: outcome.skipped,
      poolStartMs: startMs,
      // T907: pool's monotonic clock. Defaults to Date.now when no gate is
      // supplied (pre-wave behaviour). A test that wires both `politenessGate`
      // and a stubbed `poolNow` is hermetic.
      poolNow,
      rateLimitSignals: 0,
      blocksOpened: 0,
      ...(deps.politenessGate !== undefined ? { politenessGate: deps.politenessGate } : {}),
      ...(phaseTracker !== undefined ? { phaseTracker } : {}),
    };

    const plan = await buildPlan(
      intent,
      opts.userId,
      {
        listUserBoards,
        resolveCompanies,
        resolveRegistryPageBatch: deps.resolveRegistryPageBatch,
        afterCursor: deps.afterCursor,
      },
      budget,
    );
    outcome.units.push(...plan.preRecorded);
    outcome.skipped.push(...plan.skipped);
    if (plan.truncated) outcome.truncated = true;
    if (intent.mode === 'full') {
      outcome.hasMore = plan.registry?.hasMore ?? false;
      outcome.nextCursor = plan.registry?.nextCursor ?? null;
      outcome.registry = {
        processed: plan.registry?.processed ?? 0,
        total: plan.registry?.total ?? 0,
      };
    }

    const launched = { count: 0 };
    const pool = await executePool(plan.ordered, ctx, launched);
    const stop = pool.stop;
    // `truncated` is reserved for maxUnits/budget drops (STEP 3); a cancel
    // is reported via `cancelled`, never via `truncated`.
    if (stop === 'budget') {
      outcome.truncated = true;
      // A Full reader cursor is opaque and names the last fetched row's
      // encoded `(tier, id)` pair. A wall-clock stop can leave a fetched
      // page unscheduled, so rewind to the predecessor page's opaque
      // cursor (`previousPage?.cursor ?? previousPage?.id`) immediately
      // before the FIRST page that never launched. The `?? previousPage?.id`
      // fallback exists for fixtures that construct page refs without a
      // cursor (review adjudication 4); the prod Full reader always
      // supplies `cursor`. Failed/time-out pages were launched and remain
      // accounted; cancellation deliberately does not enter this branch,
      // preserving terminal/cancelled null cursors.
      const unscheduled = pool.neverLaunched;
      if (plan.registry !== undefined && unscheduled.size > 0) {
        // T907: the never-launched set is non-contiguous (parking can
        // scatter indices across the plan). Find the FIRST registry page
        // whose planned unit is in the never-launched set, in `pageUnits`
        // order - NOT `ordered.slice(cutoff)`, which would silently skip
        // a parked unit earlier in the order.
        const firstUnscheduledPage = plan.pageUnits.find((unit) => {
          // Look up the planned unit's index in `plan.ordered`.
          const idx = plan.ordered.indexOf(unit);
          return idx >= 0 && unscheduled.has(idx);
        });
        rewindRegistryBeforeUnattempted(plan.registry, firstUnscheduledPage);
        outcome.hasMore = plan.registry.hasMore;
        outcome.nextCursor = plan.registry.nextCursor;
      }
    }
    if (stop === 'cancel') {
      outcome.cancelled = true;
    } else {
      // Tier-4 follow-ups (STEP 5): Deep/Full only, only for a page URL whose
      // cheaper-tier unit FAILED, and only when the browser group is opted in.
      // Every other case is recorded skipped-with-reason.
      const failedPageIds = new Set(
        outcome.units
          .filter((u) => u.kind === 'registry-page' && u.status === 'failed')
          .map((u) => u.unitId),
      );
      const browserOptedIn = new Set(intent.sourceGroups).has('browser');
      const followups: PlannedUnit[] = [];
      for (const pageUnit of plan.pageUnits) {
        const followupId = `${pageUnit.unitId}:browser`;
        if (!browserTierAllowed(intent.mode)) {
          outcome.skipped.push({ unitId: followupId, reason: 'deep mode only' });
        } else if (!failedPageIds.has(pageUnit.unitId)) {
          outcome.skipped.push({ unitId: followupId, reason: 'cheaper tier succeeded' });
        } else if (!browserOptedIn) {
          outcome.skipped.push({ unitId: followupId, reason: 'group disabled: browser' });
        } else {
          followups.push({
            unitId: followupId,
            kind: 'browser-followup',
            providerType: 'browser',
            config: {
              type: 'browser',
              feedUrl: pageUnit.pageUrl,
              query: pageUnit.config.query,
              userId: opts.userId,
              deepMode: true,
            },
            tier: 4,
            group: 'browser',
            pageUrl: pageUnit.pageUrl,
            rank: 70,
          });
        }
      }
      // Follow-ups count against maxUnits like any other unit.
      const remaining = Math.max(0, budget.maxUnits - launched.count);
      const scheduled = followups.slice(0, remaining);
      for (const dropped of followups.slice(remaining)) {
        outcome.skipped.push({
          unitId: dropped.unitId,
          reason: `truncated: exceeds maxUnits=${budget.maxUnits}`,
        });
        outcome.truncated = true;
      }
      if (scheduled.length > 0) {
        const stop2 = (await executePool(scheduled, ctx, launched)).stop;
        if (stop2 === 'budget') outcome.truncated = true;
        if (stop2 === 'cancel') outcome.cancelled = true;
      }
    }
    // T908: attach the bounded rate-limit counters AFTER every pool has run
    // (the tier-4 follow-up pool can open blocks too), and only when a signal
    // was actually observed, so a pre-wave caller's outcome shape is unchanged.
    // The route turns these into the bounded `politeness` marker and derives
    // `wiringOk` (a limiter that is on, sees signals, and never opens a block is
    // a wiring failure - detectable, not silent).
    if (ctx.rateLimitSignals > 0) outcome.rateLimitSignals = ctx.rateLimitSignals;
    if (ctx.blocksOpened > 0) outcome.blocksOpened = ctx.blocksOpened;
    // T783 FINAL STEP - evaluate (wave 9 pipeline, per intent's `evaluate`
    // option). Runs AFTER all collection (nothing after it mutates `jobs`);
    // the route layer performs dedupe/filter/order/persist on these jobs and
    // records this summary into the run snapshot post-persist, so the
    // documented order scope -> collect -> dedupe -> filter/order -> persist
    // -> evaluate holds end to end. The step never fails the run: an
    // unexpected throw leaves `evaluation` absent (additive optional).
    try {
      const evalDeps = deps.evaluation ?? {};
      const evaluated = await evaluateResults(outcome.jobs, {
        evaluate: effectiveEvaluateMode(intent),
        intent,
        ...(evalDeps.resumeText !== undefined ? { resumeText: evalDeps.resumeText } : {}),
        ...(evalDeps.matcherProfile !== undefined ? { matcherProfile: evalDeps.matcherProfile } : {}),
        ...(evalDeps.minScore !== undefined ? { minScore: evalDeps.minScore } : {}),
        ...(evalDeps.maxCount !== undefined ? { maxCount: evalDeps.maxCount } : {}),
        ...(evalDeps.existingEvaluations !== undefined
          ? { existingEvaluations: evalDeps.existingEvaluations }
          : {}),
        ...(evalDeps.evaluateOne !== undefined ? { evaluateOne: evalDeps.evaluateOne } : {}),
        ...(evalDeps.probeLlmKey !== undefined ? { probeLlmKey: evalDeps.probeLlmKey } : {}),
        ...(evalDeps.onEstimate !== undefined ? { onEstimate: evalDeps.onEstimate } : {}),
        isCancelled: () => ctx.isCancelled(),
      });
      outcome.evaluation = {
        requested: evaluated.ai.requested,
        completed: evaluated.ai.completed,
        skipped: evaluated.ai.skipped,
        ...(evaluated.ai.reason !== undefined ? { reason: evaluated.ai.reason } : {}),
        estimate: {
          calls: evaluated.estimate.calls,
          approxTokens: evaluated.estimate.approxTokens,
        },
      };
    } catch {
      // Evaluation must never fail a search: collection results stand alone.
    }
    // Wave 15 (T900) timing summary. Computed AFTER all collection so the
    // per-unit timings array is complete; attached ONLY when
    // `attributeTiming === true`, preserving the byte-stable response when
    // the env flag is off. Phase totals are added when a tracker was
    // supplied AND the channels were available. The tracker is disposed
    // (unsubscribe) on every exit path so a phase probe wired by the
    // route never leaks handler subscriptions across requests.
    if (attributeTiming && timings.length > 0) {
      const base = summarizeTimings(timings);
      if (phaseTracker !== undefined) {
        try {
          const { phases, phasesUnavailable } = phaseTracker.finalize();
          outcome.timing = phasesUnavailable || phases === null
            ? base
            : { ...base, phases, phasesUnavailable: false };
        } finally {
          phaseTracker.unsubscribe();
        }
      } else {
        outcome.timing = base;
      }
    } else if (phaseTracker !== undefined) {
      // Attribute timing was off but a tracker was supplied (test-only
      // combination): still dispose so subscriptions are not leaked.
      phaseTracker.unsubscribe();
    }
    return outcome;
  } finally {
    opts.signal?.removeEventListener('abort', onExternalAbort);
    // Finished runs leave the registry: a later cancelRun for this runId is
    // a documented no-op (returns false).
    liveRuns.delete(opts.runId);
  }
}
