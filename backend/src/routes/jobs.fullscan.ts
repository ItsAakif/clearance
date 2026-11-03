// Client-driven Full-scan batch route (ADR-033 decision 4; T885).
//
// A request executes at most one bounded registry batch under the Full
// per-request budget (resolved via `budgetFor('full')` so the
// `SEARCH_FULL_MAX_CONCURRENCY` / `SEARCH_FULL_BUDGET_MS` self-hoster
// knobs are honoured and clamped - see `discovery/budgets.ts`). The next
// batch is driven by the client through the opaque keyset cursor, so this
// route has no scheduler, queue, worker, timer, or background continuation.
// Registry page units are deliberately NOT retained in the run snapshot: a
// whole-registry sweep would otherwise add tens of thousands of rows to the
// in-memory snapshot. Only aggregate cursor/progress fields and bounded batch
// issue summaries are returned; per-unit reasons and counts never turn the
// response into an unbounded array.
//
// The user's boards are scanned only on the first batch. A later batch resumes
// the stored cursor and supplies no boards, so a sweep cannot rescan a board on
// every request. Full never resolves named companies: the boards-only resolver
// is retained as an explicit dependency for the shared orchestrator contract.
//
// PERSISTENCE INVARIANT (T892 live-test find #2): a batch persists EVERY row it
// matched. The keyset cursor permanently consumes the pages a batch read, so a
// per-batch row slice would discard matches that no later batch revisits. The
// validated `limit` query field therefore rides the contract and the intent but
// caps nothing here; only the batch budget bounds a response.
//
// VERIFICATION WRITE-BACK (T904, Wave 15): the Full sweep is the second writer
// of CompanyCareerPage verification columns. The admin crawl path (crawler.ts)
// remains the first writer; both share the recompute-not-increment rule inside
// `buildVerificationUpdate` and the shared prisma surface in
// `registry/verifyStore.ts`.
//
// COEXISTENCE RULES (documented, enforced by `verifyStore.ts` +
// `buildVerificationUpdate` + the per-page try/catch here):
//  - recompute-never-increment `failureCount` (already inside
//    buildVerificationUpdate: 0 on ok/empty, stored+1 on failure).
//  - one row per update, no batch transaction: a thrown update on one page
//    never rolls back another page's write.
//  - last-writer-wins per page across two concurrent writers (the admin
//    crawl and this route). Both read the freshest stored row at write time
//    so `failureCount` is recomputed against the latest snapshot.
//  - `nextCheckAt` is computed inside `buildVerificationUpdate` from
//    staleness.nextCheckAt under the SAME injected clock this route supplies
//    (one `now` per batch).
//  - a thrown write or read NEVER fails the batch: per-page try/catch counts
//    into the bounded `verification.failed` counter; the batch response stays
//    in shape (existing keys unchanged).
//  - no credential or page content ever reaches `lastError`: the existing
//    500-char bound inside buildVerificationUpdate is reused; this route
//    passes only bounded reasons and the route never reads page bodies.
//  - `tier`, `provider` (except through the provider-correction seam inside
//    `buildVerificationUpdate`, shared with the admin crawl), `companyId`
//    and the listing models are NEVER written here. `JobSourceHealth` is
//    NEVER written on this path (the `executeUntrackedUnit` split keeps the
//    legacy health surface off the sweep).
//
// The switch `SEARCH_FULL_VERIFY_WRITEBACK=off` (default 'on') short-circuits
// the entire section: zero store calls and no `verification` key on the
// response. With the switch off the batch response IS byte-stable against the
// pre-T904 baseline; with the switch on (default) the response gains only the
// additive `verification: { written, failed }` key. Per-page runs honour
// `SEARCH_ATTRIBUTION=on` for the additive `timing` key (T900); that switch is
// independent.
//
// POLITENESS (T907, wave 15; T908): `SEARCH_FULL_POLITENESS=off` (default
// 'on') bypasses the per-bucket admission gate entirely - the orchestrator
// then behaves exactly as pre-wave (no admission check, no per-bucket cap and,
// since T908, no 429/503 backoff, because the backoff writer lives on the
// gate). Every batch response carries the bounded additive
// `politeness: { mode, signals, blocks, deferred, wiringOk }` marker, so an
// unprotected sweep is never silent AND a limiter that is on but never fires
// is detectable (`wiringOk === false`). The gate is constructed fresh per
// request so per-request state does not leak across users.
//
// WIDTH-INTERACTION (T906 folded-in from the T906 review, F-1; T910 D7
// supersedes the batch-size term): the documented math at
// `backend/src/discovery/budgets.ts:62-78` explains why a width-32 pool is
// admissible on the post-D7 Full batch. Frozen values (T910):
// `FULL_BATCH_PAGES = 200` and `maxUnits = FULL_BATCH_PAGES +
// FULL_BATCH_BOARD_HEADROOM = 200 + 120 = 320` (budgets.ts:200,210,227).
// Batch-1 worst-case composition is 59 boards + 200 pages = 259 units
// (per spec EDGE CASES 1, "59 boards + 100 pages = 159 units"; D7 raises
// the page term to 200 and maxUnits to 320, so the 259-unit batch fits
// with 61 units of margin, 23.5% - no truncation). Width math at the
// frozen width 32: a 200-page all-20s batch needs
// `ceil(200/32) * 20 = 7 * 20 = 140 s < 180 s`, so the wall clock still
// does not fire on this frozen width; at the pre-wave width 8 the same
// batch needed `ceil(200/8) * 20 = 500 s > 180 s` and that is why the
// wall clock fired before. The rewind seam owns the cursor for any
// fetched-but-never-launched pages; a successful sweep with no wall
// rewind leaves the cursor at the reader's last-fetched id.

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { handleApiError } from '../shared/errors.js';
import { validateInput, jobSearchSchema } from '../shared/validation.js';
import { seedDefaultBoardsForUser } from '../jobSources/defaultBoards.js';
import { runSource, boardToConfig, type JobSourceConfig, type RawJob } from '../jobSources/index.js';
import {
  beginRun,
  finishRun,
  getRun,
  markCancelled,
  setRunEvaluation,
  setRunMode,
  setRunRegistryProgress,
  setRunTotalListings,
  touchRun,
} from '../jobSources/discoveryRuns.js';
import { FULL_RUN_TTL_MS, budgetFor } from '../discovery/budgets.js';
import { runSearch, type ExecutableUnit, type UserBoardRef } from '../discovery/orchestrator.js';
import { resolveRegistryPageBatch as readRegistryPageBatch } from '../discovery/registrySweep.js';
import { PolitenessGate } from '../discovery/politeness.js';
import { dedupeJobs } from '../discovery/dedupe.js';
import { createPhaseProbe } from '../discovery/attribution.js';
import { env } from '../config/env.js';
import {
  readPageForUpdate,
  writePageVerification,
} from '../registry/verifyStore.js';
import {
  buildVerificationUpdate,
  LAST_ERROR_MAX_CHARS,
  type CrawlOutcome,
  type CrawlStatus,
  type StoredCareerPage,
} from '../registry/crawler.js';
// jobs.ts mounts this handler and these are its already-tested shared route
// helpers. The namespace import is intentional: the two modules form a small
// ESM live-binding cycle, but the handler reads the bindings only at request
// time, after both modules have initialized.
import * as legacyRoute from './jobs.js';

const MAX_REPORTED_ISSUES = 20;
const MAX_REPORTED_ID_CHARS = 200;
const MAX_REPORTED_REASON_CHARS = 500;

type UnitIssue = { unitId: string; reason: string };

function isTruncationReason(reason: string | undefined): boolean {
  return reason === 'budget exhausted' ||
    reason === 'budget_exhausted' ||
    reason?.startsWith('truncated:') === true;
}

function boundIssue(issue: { unitId: string; reason?: string }): UnitIssue {
  return {
    unitId: issue.unitId.slice(0, MAX_REPORTED_ID_CHARS),
    reason: (issue.reason ?? 'unspecified').slice(0, MAX_REPORTED_REASON_CHARS),
  };
}

/** Bound a response array while retaining the total for honest overflow reporting. */
function reportedIssues(
  issues: ReadonlyArray<{ unitId: string; reason?: string }>,
  prioritized: ReadonlyArray<{ unitId: string; reason?: string }> = issues,
): { items: UnitIssue[]; total: number } {
  return {
    items: prioritized.slice(0, MAX_REPORTED_ISSUES).map(boundIssue),
    total: issues.length,
  };
}

function parseListParam(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const entries = Array.isArray(raw) ? raw : [raw];
  const values: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    if (text.startsWith('[') && text.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string') {
              for (const part of item.split(',')) {
                const value = part.trim();
                if (value) values.push(value);
              }
            }
          }
          continue;
        }
      } catch {
        // Keep a malformed JSON-looking value as ordinary comma-separated text.
      }
    }
    for (const part of text.split(',')) {
      const value = part.trim();
      if (value) values.push(value);
    }
  }
  return values;
}

/** Keep the legacy /search source parsing semantics, including an explicit []. */
function parseSourcesLikeSearch(raw: unknown): string[] | undefined {
  return raw ? String(raw).split(',').filter(Boolean) : undefined;
}

function safeRegistry(fn: () => void): void {
  try {
    fn();
  } catch {
    // Snapshot bookkeeping must never fail a discovery response.
  }
}

function abortError(): Error {
  const error = new Error('unit aborted');
  error.name = 'AbortError';
  return error;
}

/** Bound the unit reason to a non-secret length before it can reach lastError. */
function boundUnitReason(reason: string | undefined): string | null {
  if (reason === undefined || reason === '') return null;
  return reason.slice(0, LAST_ERROR_MAX_CHARS);
}

/**
 * T904: map a `RunUnitState` for a registry-page unit into the inputs
 * `buildVerificationUpdate` expects. The mapping is exactly the contract:
 *  - status `ok` -> `'ok'` when `rawResultCount > 0` else `'empty'`.
 *  - status `failed` -> mapped from `failureKind`; default `'http_error'`.
 *  - `resultCount` for the write-back is `rawResultCount ?? resultCount` so
 *    the crawler's SUSPECT-drop rule never fires on our cap truncation.
 *  - `error` is the bounded unit reason (never page content, never a
 *    credential).
 *  - `httpStatus` is forwarded verbatim (undefined -> null in
 *    buildVerificationUpdate).
 */
function crawlOutcomeForRegistryPage(unit: {
  status: string;
  resultCount: number;
  rawResultCount?: number;
  httpStatus?: number;
  failureKind?: 'blocked' | 'http_error' | 'timeout' | 'invalid' | 'not_modified';
  reason?: string;
}): { status: CrawlStatus; httpStatus?: number; resultCount: number; error?: string } {
  if (unit.status === 'ok') {
    const uncapped = unit.rawResultCount ?? unit.resultCount;
    return {
      status: uncapped > 0 ? 'ok' : 'empty',
      ...(unit.httpStatus !== undefined ? { httpStatus: unit.httpStatus } : {}),
      resultCount: uncapped,
    };
  }
  // Failed terminal state: map the canonical failure kind onto the
  // 8-value verifyStatus vocabulary; default to 'http_error' so an
  // absent/unexpected failureKind (defensive) still records a real value.
  // `not_modified` is mapped to `skipped` (mirrors `crawler.ts:449-456` /
  // `classifyProbeError`): a 304 from a proxy/CDN is a NOT-MODIFIED signal,
  // not a transport failure - `buildVerificationUpdate` then preserves the
  // prior `verifyStatus` and does NOT increment `failureCount` (crawler.ts:319-321).
  const mapped: CrawlStatus =
    unit.failureKind === 'blocked' ? 'blocked'
    : unit.failureKind === 'timeout' ? 'timeout'
    : unit.failureKind === 'invalid' ? 'invalid'
    : unit.failureKind === 'not_modified' ? 'skipped'
    : 'http_error';
  const bounded = boundUnitReason(unit.reason);
  return {
    status: mapped,
    ...(unit.httpStatus !== undefined ? { httpStatus: unit.httpStatus } : {}),
    resultCount: unit.rawResultCount ?? unit.resultCount,
    ...(bounded !== null ? { error: bounded } : {}),
  };
}

interface VerificationCounters {
  written: number;
  failed: number;
}

/**
 * T904: write verification for every terminal registry-page unit. Per-page
 * try/catch; failures never fail the batch and never touch the persisted
 * listings. Returns the bounded `{ written, failed }` counter that the
 * route exposes on the response (omitted entirely when env is off).
 *
 * `cancelled` and `skipped` units produce NO write (their stored state is
 * left alone; `lastCheckedAt` does not advance for them).
 *
 * `tier`, `provider`, `companyId` and the listing models are not written here.
 * `JobSourceHealth` is NEVER written on this path - the
 * `executeUntrackedUnit` split keeps the legacy health surface off the
 * sweep.
 */
async function writeBatchVerification(
  units: ReadonlyArray<{
    unitId: string;
    kind: string;
    status: string;
    resultCount: number;
    rawResultCount?: number;
    httpStatus?: number;
    failureKind?: 'blocked' | 'http_error' | 'timeout' | 'invalid' | 'not_modified';
    reason?: string;
  }>,
  batch: { pages: Array<{ id: string }> } | null,
): Promise<VerificationCounters> {
  const counters: VerificationCounters = { written: 0, failed: 0 };
  if (batch === null) return counters;
  // One `now` for the whole batch; injected into every buildVerificationUpdate
  // call so all writes in this request share a clock.
  const now = new Date();
  for (const unit of units) {
    if (unit.kind !== 'registry-page') continue;
    if (unit.status !== 'ok' && unit.status !== 'failed') continue;
    // Map `page:<index>` -> batch.pages[index].id. If the index is out of
    // range the plan has been re-cut since the batch was read; skip without
    // a write so we never carry a registry result to a different row.
    const match = /^page:(\d+)$/.exec(unit.unitId);
    if (match === null) continue;
    const index = Number.parseInt(match[1], 10);
    const page = batch.pages[index];
    if (page === undefined) continue;
    try {
      const stored = await readPageForUpdate(page.id);
      if (stored === null) {
        counters.failed += 1;
        continue;
      }
      const outcome: CrawlOutcome = {
        pageId: page.id,
        latencyMs: 0,
        ...crawlOutcomeForRegistryPage(unit),
      };
      const { update } = buildVerificationUpdate(stored, outcome, now);
      await writePageVerification(page.id, update);
      counters.written += 1;
    } catch {
      counters.failed += 1;
    }
  }
  return counters;
}

/**
 * Execute a registry-page (or browser follow-up) unit without touching the
 * legacy board health/mark path. JobSourceHealth is owned by the crawler wave;
 * a page must never be recorded as if it were a configured board. The signal
 * wrapper still lets a cancelled batch stop waiting on an in-flight source.
 */
function executeUntrackedUnit(
  config: JobSourceConfig,
  signal: AbortSignal = new AbortController().signal,
): Promise<RawJob[]> {
  if (signal.aborted) return Promise.reject(abortError());
  const work = Promise.resolve().then(() => runSource(config));
  return new Promise<RawJob[]>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (rows) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(rows);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function makeBoardRefs(
  boards: Array<{
    id: string;
    name: string;
    type: string;
    boardId: string | null;
    feedUrl: string | null;
    searchQuery: string | null;
    searchSite: string | null;
    scraperProvider: string | null;
    scraperLocation: string | null;
    scraperResults: number | null;
    scraperUseProxy: boolean | null;
    aggregatorProvider: string | null;
    aggregatorLocation: string | null;
  }>,
  query: string,
  locations: string[],
  userId: string,
): UserBoardRef[] {
  const searchLocation = locations[0];
  return boards.map((board) => ({
    boardId: board.id,
    name: board.name,
    type: board.type,
    config: {
      ...boardToConfig(board),
      query,
      userId,
      // Mirror the existing /search D4/ADR-021 location rules for first-batch
      // personal boards. Later batches do not receive boards at all.
      ...(board.type === 'aggregator' &&
      (!board.aggregatorLocation || board.aggregatorLocation.trim().toLowerCase() === 'us') &&
      searchLocation
        ? { aggregatorLocation: searchLocation }
        : {}),
      ...(board.type === 'scraper' &&
      (!board.scraperLocation || board.scraperLocation.trim().length === 0) &&
      searchLocation
        ? { scraperLocation: searchLocation }
        : {}),
    },
  }));
}

/**
 * T908 politeness response marker. Extracted as an exported pure function
 * (rather than left inline in the response literal) so the
 * "off -> fixed off shape / on -> real counters" contract is directly
 * assertable without standing up the full express + prisma route harness.
 * Pure derivation of `env.SEARCH_FULL_POLITENESS` plus the run's bounded
 * counters; the handler spreads its return value into the response verbatim.
 *
 * T908 SHAPE CHANGE: the T907 marker was the string `politeness: 'off'`
 * (present only with the knob off). It is now the bounded object
 * `{ mode, signals, blocks, deferred, wiringOk }` in BOTH modes. Emitting it
 * in the default `'on'` mode is the point of the WIRING ASSERT (ADR-034 D2.5):
 * `wiringOk === false` is how "a limiter that is on and never fires" becomes
 * DETECTABLE instead of invisible. With the knob off no gate is constructed,
 * so no block can ever be opened and the fixed off shape is reported
 * (`signals: 0, blocks: 0, deferred: 0, wiringOk: true`).
 *
 * Byte-stability rule: every PRE-EXISTING response key keeps its name and
 * type; `politeness` is purely additive. Counters are clamped to
 * non-negative integers at this boundary (they are the only untrusted input to
 * the marker, since they cross a module boundary from the orchestrator).
 */
export interface PolitenessResponse {
  /** `'on'` when the gate was constructed for this batch, `'off'` when not. */
  mode: 'on' | 'off';
  /** Units whose observed httpStatus was 429 or 503. */
  signals: number;
  /** Blocks opened or extended by the gate (always <= signals). */
  blocks: number;
  /** Cumulative gate deferrals (units parked by the admission scheduler). */
  deferred: number;
  /**
   * WIRING ASSERT: false when signals arrived and no block was opened (the
   * limiter is on but inert - a hard wiring failure), or when blocks somehow
   * exceed signals (an impossible counter, also a wiring failure).
   */
  wiringOk: boolean;
}

function boundedCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

export function politenessResponseMarker(counters?: {
  signals?: number;
  blocks?: number;
  deferred?: number;
}): { politeness: PolitenessResponse } {
  if (env.SEARCH_FULL_POLITENESS === 'off') {
    return {
      politeness: { mode: 'off', signals: 0, blocks: 0, deferred: 0, wiringOk: true },
    };
  }
  const signals = boundedCount(counters?.signals);
  const blocks = boundedCount(counters?.blocks);
  const deferred = boundedCount(counters?.deferred);
  return {
    politeness: {
      mode: 'on',
      signals,
      blocks,
      deferred,
      wiringOk: blocks <= signals && !(signals > 0 && blocks === 0),
    },
  };
}

/**
 * The single Express handler mounted by jobs.ts at GET /jobs/full-scan.
 * Authentication is deliberately attached at the mount, matching every other
 * job-discovery route and keeping this handler focused on one authenticated
 * user's batch.
 */
export default async function fullScanHandler(req: Request, res: Response): Promise<void> {
  try {
    // Validate the same legacy search fields as /search. Full adds only the
    // opaque continuation cursor and structured intent fields below; a
    // caller-supplied mode is read through the allowFull seam but deliberately
    // ignored because this route always forces mode='full'.
    const parsedLocations = legacyRoute.parseLocationParam(req.query.location);
    const parsed = validateInput(jobSearchSchema, {
      q: req.query.q,
      limit: req.query.limit ? Number(req.query.limit) : 30,
      sources: parseSourcesLikeSearch(req.query.sources),
      postedWithin: typeof req.query.postedWithin === 'string' ? req.query.postedWithin : undefined,
      runId: typeof req.query.runId === 'string' ? req.query.runId : undefined,
      location: parsedLocations.length > 0 ? parsedLocations : undefined,
      company: req.query.company ? String(req.query.company) : undefined,
    });
    const after = typeof req.query.after === 'string' && req.query.after.length > 0
      ? req.query.after
      : undefined;
    const roles = parseListParam(req.query.roles);
    const skills = parseListParam(req.query.skills);
    const exclusions = parseListParam(req.query.exclusions);
    const companies = parseListParam(req.query.companies);
    const sourceGroups = parseListParam(req.query.sourceGroups);
    const q = parsed.q;
    // `limit` stays a validated client field so the request contract and the
    // intent below stay byte-identical, but Full NEVER uses it as a per-batch
    // row cap. Full is a sweep whose keyset cursor permanently consumes the
    // registry pages this batch read, so a slice here would silently discard
    // matched rows that no later batch can ever revisit (live defect, T892
    // find #2: every batch reported exactly persisted=30). `/search` and
    // `/scan` keep their `limit` slice (jobs.ts) because one response there IS
    // the whole answer; here the batch budget is the only bound. ADR-033
    // "Consequences": matched rows "are persisted per batch through the
    // existing upsert path", with no per-batch result cap.
    const limit = parsed.limit ?? 30;
    const locations = parsed.location ?? [];
    const company = parsed.company;
    const sources = parsed.sources;
    const postedWithin = parsed.postedWithin;

    // Full is route-exclusive. Reading the shared validator keeps the seam
    // explicit, but its result is intentionally not forwarded to the intent.
    legacyRoute.getOptionalMode(req, { allowFull: true });

    try {
      await seedDefaultBoardsForUser(req.user!.id);
    } catch {
      // Lazy seeding is best-effort, exactly as on /search and /scan.
    }

    const runId = parsed.runId ?? `full-${randomUUID()}`;
    const existing = getRun(runId, req.user!.id);
    if (after !== undefined && existing === undefined) {
      res.status(404).json({ error: 'Discovery run not found or expired' });
      return;
    }

    const firstBatch = existing === undefined;
    let boards: Awaited<ReturnType<typeof prisma.jobBoard.findMany>> = [];
    if (firstBatch) {
      // Boards are read once, after lazy seeding, and only the first batch
      // receives them. Intermediate batches must not reseed or rescan them.
      boards = await prisma.jobBoard.findMany({
        where: { userId: req.user!.id, isActive: true },
      });
      safeRegistry(() => beginRun(
        runId,
        req.user!.id,
        boards.map((board) => ({ id: board.id, name: board.name, type: board.type })),
        FULL_RUN_TTL_MS,
      ));
      // The dedicated route is always Full, regardless of caller-supplied
      // mode. Write that resolved value without changing beginRun's signature.
      safeRegistry(() => setRunMode(runId, 'full'));
    }

    const previous = getRun(runId, req.user!.id) ?? existing;
    const cursor = previous?.cursor ?? null;
    const boardRefs = firstBatch
      ? makeBoardRefs(boards, q, locations, req.user!.id)
      : [];
    const boardExecutor = legacyRoute.legacyBoardExecutor(runId, q, req.user!.id);
    const intent = legacyRoute.intentForLegacySearch({
      q,
      sources,
      locations,
      company,
      roles,
      skills,
      exclusions,
      companies,
      sourceGroups,
      limit,
      postedWithin,
      mode: 'full',
      evaluate: legacyRoute.getOptionalEvaluate(req),
    });

    // T904: capture the resolved Full batch so we can map `page:<index>` to
    // its stable page id at write-back time. The orchestrator does not
    // surface this; the route reads it via its own seam (a thin wrapper).
    type CapturedBatch = Awaited<ReturnType<typeof readRegistryPageBatch>>;
    let lastBatch: CapturedBatch | null = null;
    const captureBatch = async (
      afterId: string | null,
      limitForBatch: number,
    ): Promise<CapturedBatch> => {
      const b = await readRegistryPageBatch(afterId ?? cursor, limitForBatch);
      lastBatch = b;
      return b;
    };

    // T907/T908: one gate per request, constructed only when the switch is on.
    // Keeping the reference here (rather than inline in `deps`) lets the
    // response report the gate's own cumulative deferral count.
    const politenessGate =
      env.SEARCH_FULL_POLITENESS === 'on' ? new PolitenessGate(() => Date.now()) : undefined;

    const outcome = await runSearch(
      intent,
      { runId, userId: req.user!.id },
      {
        // T906: budget resolved PER REQUEST through `budgetFor('full')` so
        // the documented self-hoster env knobs `SEARCH_FULL_MAX_CONCURRENCY`
        // and `SEARCH_FULL_BUDGET_MS` are honoured at request time. They are
        // CLAMPED inside `budgetFor` to `[1, FULL_CONCURRENCY_CEILING=64]`
        // and `[FULL_BUDGET_MS_MIN=30_000, FULL_BUDGET_MS_MAX=600_000]`
        // respectively (ADR-034 D1.2/D1.5: an unbounded env value is an
        // accidental stampede on third parties). The pre-T906 path passed
        // the frozen `FULL_BATCH_BUDGET` constant and short-circuited the
        // env knob for the Full route even though it was documented for two
        // waves.
        budget: budgetFor('full'),
        listUserBoards: async (): Promise<UserBoardRef[]> => (firstBatch ? boardRefs : []),
        // Full never resolves named companies. The explicit boards-only seam
        // keeps that invariant visible and prevents accidental registry lookup.
        resolveCompanies: legacyRoute.boardsOnlyCompanyScope,
        afterCursor: cursor,
        resolveRegistryPageBatch: captureBatch,
        // Wave 15 (T900) attribution: default OFF so the response stays
        // byte-stable; an operator opts in by setting SEARCH_ATTRIBUTION=on.
        attributeTiming: env.SEARCH_ATTRIBUTION === 'on',
        // Wire the best-effort phase probe alongside attribution so a
        // measurable subset of `phases` lands on the summary when the
        // bundled undici publishes its diagnostics channels. Off by
        // default (probe factory degrades to a no-op when channels are
        // absent, so this is safe to wire on every `attribution=on`
        // request).
        ...(env.SEARCH_ATTRIBUTION === 'on'
          ? { phaseTracker: createPhaseProbe() }
          : {}),
        // Wave 15 (T907) politeness gate: default ON (per the env switch).
        // The gate is constructed only when the switch is on; with the
        // switch off the orchestrator receives no gate and behaves exactly
        // as pre-wave (no admission check, no per-bucket cap, no 429/503
        // backoff - T908's `noteBlocked` writer is unreachable without a
        // gate, so no block can ever be opened). The constructor takes a
        // fresh `now` factory so it does not share state across requests.
        // The reference is kept (not inlined into `deps`) because the
        // response marker reports the gate's own deferral count after the
        // run - `politeness: { ..., deferred }`.
        ...(politenessGate !== undefined ? { politenessGate } : {}),
        executeUnit: async (
          unit: ExecutableUnit,
          signal: AbortSignal = new AbortController().signal,
        ): Promise<RawJob[]> => {
          if (unit.kind === 'board' && unit.unitId.startsWith('board:')) {
            return boardExecutor(unit);
          }
          // Registry-page units never use the board executor: it would mark
          // page:<n> as a board and write JobSourceHealth. Registry health is
          // deliberately owned by the crawler job (wave 8), not this route.
          return executeUntrackedUnit(unit.config, signal);
        },
      },
    );

    // T904: per-page verification write-back. Terminal registry-page units
    // (status `ok` or `failed`) drive a per-page read -> buildVerificationUpdate
    // -> writePageVerification. `cancelled`/`skipped` units produce NO write;
    // their stored state is left alone (lastCheckedAt does not advance for
    // them). Failures never fail the batch; they count into the bounded
    // `verification.failed` counter. One `now` is injected for the whole
    // batch so all writes in this request share a clock.
    const verificationWriteback = env.SEARCH_FULL_VERIFY_WRITEBACK === 'on'
      ? await writeBatchVerification(outcome.units, lastBatch)
      : null;

    // Keep the same post-collection pipeline as /search: dedupe, query
    // relevance/freshness ordering, then the legacy company/source/location
    // filters. Unlike /search this pipeline ends at the filters - there is no
    // trailing limit slice (see `limit` above).
    const companyFilters = [company, ...(companies ?? [])]
      .map((value) => (value ?? '').trim())
      .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
      .map((value) => value.toLowerCase());
    const ordered = legacyRoute.filterAndOrder(
      dedupeJobs(outcome.jobs)
        .filter((job) => companyFilters.length === 0 || companyFilters.includes((job.company || '').toLowerCase()))
        .filter((job) => sources === undefined || sources.includes(job.source)),
      q,
      postedWithin,
    );
    const locationFiltered = locations.length > 0
      ? ordered.filter((job) => {
          const jobLocation = (job.location || '').toLowerCase();
          return locations.some((needle) => jobLocation.includes(needle.toLowerCase()));
        })
      : ordered;
    // Full persists EVERY matched row of the batch: no `limit` slice, ever.
    // The cursor has already advanced past these pages for good, so a truncated
    // batch is unrecoverable - dropped rows are neither stored nor re-fetched,
    // which is exactly the silent-loss defect this line used to cause. The only
    // bound on a batch response is the batch budget itself (`FULL_BATCH_PAGES`
    // registry pages x `FULL_BATCH_BUDGET.perSourceResultCap` per unit, far
    // less after dedupe), matching the spec's already-accepted "no total cap"
    // Full row-volume risk.
    const upserted = await legacyRoute.upsertDiscoveredJobs(locationFiltered);
    legacyRoute.scheduleAutoNormalization(req.user!.id, upserted);

    const cancelled = outcome.cancelled === true;
    const hasMore = outcome.hasMore === true && !cancelled;
    // The orchestrator owns the keyset rewind for BOTH truncation causes: when
    // maxUnits or the wall clock leaves a fetched page unscheduled, it returns
    // the stable id immediately before the first such page and forces
    // hasMore. Never replace it with the reader's last-fetched id.
    const nextCursor = hasMore ? (outcome.nextCursor ?? null) : null;
    const total = outcome.registry?.total ?? previous?.registryTotal ?? 0;
    const unitStates = Array.isArray(outcome.units) ? outcome.units : [];
    // `outcome.registry.processed` counts pages fetched by the reader. Some of
    // those candidates can be dropped before execution (FULL maxUnits) or
    // never scheduled (wall clock), so it is NOT honest run progress. A
    // registry-page unit state is the route's
    // accounting record that the page was scheduled and reached a terminal
    // state (ok, failed, skipped, or cancelled).
    const pageUnitStates = unitStates.filter((unit) => unit.kind === 'registry-page');
    const batchProcessed = pageUnitStates.length;
    const processed = Math.max(0, previous?.registryProcessed ?? 0) + batchProcessed;
    const cumulativeListings = Math.max(0, previous?.totalListings ?? 0) + upserted.length;

    const skippedIssues = Array.isArray(outcome.skipped) ? outcome.skipped : [];
    const failedIssues = pageUnitStates.filter((unit) => unit.status === 'failed');
    // Keep truncation reasons visible even when ordinary browser-follow-up
    // skips would otherwise fill the bounded response window.
    const prioritizedSkippedIssues = [
      ...skippedIssues.filter((issue) => isTruncationReason(issue.reason)),
      ...skippedIssues.filter((issue) => !isTruncationReason(issue.reason)),
    ];
    const skippedReport = reportedIssues(skippedIssues, prioritizedSkippedIssues);
    const failedReport = reportedIssues(failedIssues);
    const truncated = outcome.truncated === true;
    const truncationIssueCount =
      skippedIssues.filter((issue) => isTruncationReason(issue.reason)).length +
      failedIssues.filter((unit) => isTruncationReason(unit.reason)).length;
    const truncatedCount = truncated ? Math.max(1, truncationIssueCount) : 0;

    safeRegistry(() => setRunRegistryProgress(runId, {
      cursor: nextCursor,
      processed,
      total,
    }));
    // Carry cumulative persisted rows between batches without calling
    // finishRun (which would incorrectly stamp finishedAt on an intermediate
    // Full-scan request).
    safeRegistry(() => setRunTotalListings(runId, cumulativeListings));
    safeRegistry(() => touchRun(runId, FULL_RUN_TTL_MS));
    if (cancelled) safeRegistry(() => markCancelled(runId));
    if (outcome.evaluation !== undefined) {
      safeRegistry(() => setRunEvaluation(runId, outcome.evaluation!));
    }
    if (!hasMore || cancelled) {
      safeRegistry(() => finishRun(runId, cumulativeListings));
    }

    res.json({
      results: upserted.map((job) =>
        legacyRoute.shapeSearchResponse(job, runId, req.user!.id, cancelled),
      ),
      runId,
      hasMore,
      nextCursor,
      processed,
      total,
      persisted: upserted.length,
      // Every issue array is hard-bounded. Counts preserve the honest total
      // when details are omitted, and truncation reasons are prioritized.
      skipped: skippedReport.items,
      skippedCount: skippedReport.total,
      failed: failedReport.items,
      failedCount: failedReport.total,
      truncated,
      truncatedCount,
      cancelled,
      // Wave 15 (T900) timing summary: present ONLY when
      // `SEARCH_ATTRIBUTION=on`. Byte-stable otherwise.
      ...(outcome.timing !== undefined ? { timing: outcome.timing } : {}),
      // Wave 15 (T904) per-page verification write-back counter: present
      // ONLY when `SEARCH_FULL_VERIFY_WRITEBACK=on`. The counter is
      // bounded (`{ written, failed }`); the response shape stays
      // byte-stable against the pre-T904 baseline otherwise.
      ...(verificationWriteback !== null
        ? { verification: verificationWriteback }
        : {}),
      // Wave 15 (T907/T908) politeness marker: always present, carrying the
      // bounded `{ mode, signals, blocks, deferred, wiringOk }` object. The
      // `off` mode reports the fixed off shape (no gate was constructed, so no
      // block can exist); the default `'on'` mode reports the run's real
      // counters, which is how the wiring assert becomes visible.
      ...politenessResponseMarker({
        signals: outcome.rateLimitSignals,
        blocks: outcome.blocksOpened,
        deferred:
          politenessGate === undefined
            ? 0
            : politenessGate.snapshot().reduce((sum, b) => sum + b.deferred, 0),
      }),
    });
  } catch (error) {
    handleApiError(error, res);
  }
}
