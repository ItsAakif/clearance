// Registry crawler: bounded, tier-routed verification with write-back
// (Wave 8, T760; ADR-026, ADR-013).
//
// The registry (wave 2) stores verification fields on CompanyCareerPage
// (verifyStatus, verifiedAt, verifyMethod, httpStatus, resultCount,
// failureCount, nextCheckAt, lastError) and NOTHING writes them. This module
// is the writer: it takes a bounded batch from the work queue, crawls each
// page through the mechanism its tier maps to, and writes the outcome back.
//
// ROUTING (STEP 2): tiers 1/2/3 go through the wave-4 registry-provider
// mapping (`configForRegistryRow` + `runSource` over the PROVIDERS
// descriptor table) - there is deliberately NO per-provider if-ladder here,
// only the shared mapping both search and crawl use. Tier 4 goes through
// wave 6's browser descriptor as a deep-mode unit; its handler reports
// skipped-with-reason when the engine is absent, so an unserviceable tier is
// SKIPPED WITH A REASON, never counted as a failure. This module holds no
// static reference to the browser tree: tier 4 reaches it exclusively via
// the registry descriptor's lazy path.
//
// BOUNDS: CRAWL_BATCH_SIZE caps rows per request (crawlBatch CLAMPS a larger
// limit down to it - the chosen behaviour, documented and tested); no single
// request ever crawls the whole registry. CRAWL_CONCURRENCY caps in-flight
// units. No scheduler, no worker, no background loop (ADR-013):
// crawling runs only inside the caller's request, triggered on demand.
//
// TIME: `now` is injected and is the ONLY time the staleness policy reads.
// Date.now() is used solely to measure per-unit latencyMs, never as policy
// input, so tests stay deterministic under an injected clock.
//
// RE-ENTRANCE (STEP 8): there is no batch-level transaction - each page is
// read, recomputed, and written independently, so already-written outcomes
// survive a mid-batch interruption while the rest keep their prior
// nextCheckAt. failureCount is RECOMPUTED from (stored value, outcome) at
// write time inside buildVerificationUpdate, never applied as a blind
// increment, so two overlapping crawl requests settle last-writer-wins per
// page without corrupting the count sequence.
//
// GLOBAL vs PER-USER STATE (STEP 6): this module writes ONLY to
// CompanyCareerPage through the injected CrawlStore. User-board state is
// never imported, read, or written here - it keeps its per-user behaviour
// untouched, and the CrawlStore interface exposes no surface that could
// carry a registry result anywhere else.
//
// PROVIDER CORRECTION: when a transport observes a redirect landing on a
// different KNOWN ATS host, the correction is written AND the previous value
// is retained in the lastError audit text - never silently overwritten.
// A redirect to an unknown or removed host is the transport's `invalid`
// outcome with a specific message, not a silent overwrite and not a generic
// timeout. `tier` is intentionally left untouched by a correction: the
// write-back table authorises provider/boardToken only.
//
// T902 (Wave 15): classifyProbeError reads the structured HttpStatusError
// (from `jobSources/httpStatus.ts`) FIRST; the existing message-regex block
// is the documented fallback for inputs the structured path declines (the
// transport throw has not yet been converted everywhere; e.g. career-page
// content-type guards still throw plain Errors). defaultProbe's two success
// branches stop writing `httpStatus: 200` (the truth is "the HTTP status
// observed by the last probe", not "the success code"); a successful probe
// that did not observe a specific status writes `undefined`, which the
// write-back renders as `null`. A 304 from a proxy/CDN is `not_modified`,
// never `failed` and never `empty`.
//
// No secrets are logged: outcome error text names providers and page URLs
// only (registry page rows carry no credentials by construction), and the
// write-back failure warning below carries the page id only.

import prisma from '../lib/prisma.js';
import { nextCheckAt as stalenessNextCheckAt } from './staleness.js';
import type { VerifyStatus } from './verifyStatus.js';
import { readPageForUpdate, writePageVerification } from './verifyStore.js';
import { adapterTypeFor, capabilityFor } from './providers.js';
import {
  configForRegistryRow,
  getProvider,
  SourceConfigError,
  UnknownSourceTypeError,
} from '../jobSources/providerRegistry.js';
import { runSource, type JobSourceConfig } from '../jobSources/index.js';
import {
  HttpStatusError,
  classifyTransportFailure,
} from '../jobSources/httpStatus.js';

// ---------------------------------------------------------------------------
// Public contract (exact exports per T760 STEP 1)
// ---------------------------------------------------------------------------

export interface CrawlUnit {
  pageId: string;
  url: string;
  provider: string | null;
  boardToken: string | null;
  tier: number;
}

export type CrawlStatus = VerifyStatus;

export interface CrawlOutcome {
  pageId: string;
  status: CrawlStatus;
  httpStatus?: number;
  resultCount: number;
  latencyMs: number;
  observedProvider?: string | null;
  observedBoardToken?: string | null;
  error?: string;
}

/**
 * Cap on rows crawled per request. crawlBatch clamps a larger limit down to
 * this value (documented, tested). 20 keeps an admin-triggered request
 * interactive while bounding provider load.
 */
export const CRAWL_BATCH_SIZE = 20;

/**
 * Cap on in-flight crawl units. 4 matches the fast-search pool width
 * precedent (budgets.ts): cheap HTTP tiers run in-process, so a narrow pool
 * keeps latency low without hammering providers.
 */
export const CRAWL_CONCURRENCY = 4;

/** Length bound on verification error/audit text (discoveryRuns.ts convention). */
export const LAST_ERROR_MAX_CHARS = 500;

/**
 * SUSPECT-drop rule (STEP 7): an `ok` page whose resultCount collapses is
 * still `ok`, but the drop is recorded when the previous count reached
 * SUSPECT_DROP_MIN_PREVIOUS and the new count is at most 1/SUSPECT_DROP_RATIO
 * of it (e.g. 200 -> 1), so a silent breakage stays visible in health output.
 */
export const SUSPECT_DROP_MIN_PREVIOUS = 20;
export const SUSPECT_DROP_RATIO = 10;

// ---------------------------------------------------------------------------
// Store + probe seams (dependency-injected; unit tests use fakes/mocks)
// ---------------------------------------------------------------------------

/** Minimal CompanyCareerPage verification state the crawler reads/writes. */
export interface StoredCareerPage {
  id: string;
  url: string;
  provider: string | null;
  boardToken: string | null;
  tier: number;
  isActive: boolean;
  verifyStatus: string;
  verifyMethod: string | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  /**
   * The HTTP status observed by the last probe; populated for a failure
   * (and for the browser tier's own navigation status), null when a
   * successful probe did not observe an exact code. T902 removed the
   * pre-wave invention of 200 on success.
   */
  httpStatus: number | null;
  resultCount: number;
  failureCount: number;
  nextCheckAt: Date | null;
  lastError: string | null;
}

/** Exact verification fields written back per outcome (STEP 4 table). */
export interface VerificationUpdate {
  verifyStatus: string;
  verifyMethod: string;
  verifiedAt: Date | null;
  lastCheckedAt: Date;
  httpStatus: number | null;
  resultCount: number;
  failureCount: number;
  nextCheckAt: Date;
  lastError: string | null;
  provider: string | null;
  boardToken: string | null;
}

/**
 * Registry persistence surface. Deliberately narrow: the ONLY write is a
 * per-page verification update, so no code path here can carry a registry
 * result into any other table. Reads are bounded (listDue takes a limit).
 */
export interface CrawlStore {
  listDue(limit: number, now: Date): Promise<StoredCareerPage[]>;
  readForUpdate(pageId: string): Promise<StoredCareerPage | null>;
  writeVerification(pageId: string, update: VerificationUpdate): Promise<void>;
}

/** Transport seam: the default probe routes through the wave-4 mapping. */
export type ProbeFn = (unit: CrawlUnit) => Promise<CrawlOutcome>;

export interface CrawlerDeps {
  store?: CrawlStore;
  probe?: ProbeFn;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    const withMessage = error as { message?: unknown };
    if (typeof withMessage.message === 'string' && withMessage.message !== '') {
      return withMessage.message;
    }
  }
  return String(error ?? 'unknown error');
}

function boundErrorText(text: string): string {
  return text.slice(0, LAST_ERROR_MAX_CHARS);
}

function toCrawlUnit(page: StoredCareerPage): CrawlUnit {
  return {
    pageId: page.id,
    url: page.url,
    provider: page.provider,
    boardToken: page.boardToken,
    tier: page.tier,
  };
}

/**
 * Mechanism actually used, derived from the row (not the outcome):
 * tier 4 is the browser tier, the 'career-page' adapter is a plain page
 * fetch, everything else is a keyless/feed adapter call. Used for
 * verifyMethod on every outcome, including skipped (records the mechanism
 * that was attempted but unavailable).
 */
export function verifyMethodFor(provider: string | null, tier: number): string {
  if (tier === 4) return 'browser';
  if (adapterTypeFor(provider) === 'career-page') return 'page';
  return 'adapter';
}

/**
 * Pure work-queue selection: active pages that are due
 * (never scheduled, or nextCheckAt <= now), ordered by nextCheckAt ascending
 * with nulls first (mirroring the Postgres ASC nulls-first order the
 * /pages work-queue endpoint documents - never-scheduled pages sort first,
 * which is what the crawler wants), id as the stable tie-break, capped at
 * the limit. nextBatch enforces this even if a store over-returns, and the
 * Prisma store implements the same predicate/order in SQL (see below).
 */
export function selectDueBatch(
  pages: StoredCareerPage[],
  limit: number,
  now: Date,
): CrawlUnit[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (safeLimit <= 0) return [];
  const nowMs = now.getTime();
  const due = pages.filter(
    (p) => p.isActive && (p.nextCheckAt === null || p.nextCheckAt.getTime() <= nowMs),
  );
  due.sort((a, b) => {
    const at = a.nextCheckAt === null ? Number.NEGATIVE_INFINITY : a.nextCheckAt.getTime();
    const bt = b.nextCheckAt === null ? Number.NEGATIVE_INFINITY : b.nextCheckAt.getTime();
    if (at !== bt) return at - bt;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return due.slice(0, safeLimit).map(toCrawlUnit);
}

// ---------------------------------------------------------------------------
// Verification write-back (STEP 4 table, pure)
// ---------------------------------------------------------------------------

export interface WriteBackDetail {
  update: VerificationUpdate;
  /** True when an ok resultCount collapsed per the SUSPECT-drop rule. */
  suspectDrop: boolean;
  /** True when provider/boardToken were corrected (audited in lastError). */
  providerCorrected: boolean;
}

function describeIdentity(provider: string | null, boardToken: string | null): string {
  return `${provider ?? '(none)'}/${boardToken ?? '(none)'}`;
}

/**
 * Build the exact verification update for one outcome (STEP 4 table):
 * - verifyStatus: `ok` when resultCount > 0, `empty` for a valid zero-row
 *   response, blocked/http_error/timeout/invalid per outcome; retained on
 *   `skipped` (a skip is never a failure and never a success).
 * - verifiedAt: set ONLY on `ok`/`empty`, otherwise the stored value stays.
 * - verifyMethod: the mechanism actually used (adapter/page/browser).
 * - provider/boardToken: corrected when the observed redirect landed on a
 *   different KNOWN ATS host; the previous value is retained in the
 *   lastError audit text, never silently overwritten. Unknown observed
 *   hosts retain the stored values (that case is the transport's `invalid`
 *   outcome, recorded as-is).
 * - failureCount: RECOMPUTED from (stored value, outcome) - 0 on ok/empty
 *   (a successful verification clears the streak), stored+1 on failure,
 *   stored on skipped. Never a blind increment (STEP 8).
 * - lastError: bounded outcome error + correction audit + SUSPECT note.
 * - nextCheckAt: SOLELY from staleness.nextCheckAt on the NEW state under
 *   the injected clock (STEP 5) - including skipped, whose lastCheckedAt
 *   still advances so the page is not retried immediately.
 */
export function buildVerificationUpdate(
  page: StoredCareerPage,
  outcome: CrawlOutcome,
  now: Date,
): WriteBackDetail {
  const succeeded = outcome.status === 'ok' || outcome.status === 'empty';
  const skipped = outcome.status === 'skipped';
  const storedFailures =
    typeof page.failureCount === 'number' && Number.isFinite(page.failureCount)
      ? Math.max(0, Math.floor(page.failureCount))
      : 0;

  const verifyStatus = skipped ? page.verifyStatus : outcome.status;
  const verifiedAt = succeeded ? now : (page.verifiedAt ?? null);
  const failureCount = succeeded ? 0 : skipped ? storedFailures : storedFailures + 1;

  let provider = page.provider;
  let boardToken = page.boardToken;
  let providerCorrected = false;
  const observed = outcome.observedProvider;
  if (
    observed !== undefined &&
    observed !== null &&
    observed !== '' &&
    observed !== page.provider &&
    capabilityFor(observed) !== undefined
  ) {
    provider = observed;
    boardToken = outcome.observedBoardToken ?? null;
    providerCorrected = true;
  }

  const previousCount =
    typeof page.resultCount === 'number' && Number.isFinite(page.resultCount)
      ? Math.max(0, Math.floor(page.resultCount))
      : 0;
  const suspectDrop =
    outcome.status === 'ok' &&
    previousCount >= SUSPECT_DROP_MIN_PREVIOUS &&
    outcome.resultCount * SUSPECT_DROP_RATIO <= previousCount;

  const parts: string[] = [];
  if (typeof outcome.error === 'string' && outcome.error !== '') {
    parts.push(outcome.error);
  }
  if (providerCorrected) {
    parts.push(
      `provider corrected ${describeIdentity(page.provider, page.boardToken)} -> ` +
        `${describeIdentity(provider, boardToken)} (previous value retained here)`,
    );
  }
  if (suspectDrop) {
    parts.push(`SUSPECT resultCount drop ${previousCount} -> ${outcome.resultCount}`);
  }
  const lastError = parts.length === 0 ? null : boundErrorText(parts.join(' | '));

  const nextCheckAt = stalenessNextCheckAt(
    { verifyStatus, verifiedAt, lastCheckedAt: now, failureCount },
    now,
  );

  return {
    update: {
      verifyStatus,
      verifyMethod: verifyMethodFor(page.provider, page.tier),
      verifiedAt,
      lastCheckedAt: now,
      httpStatus: outcome.httpStatus ?? null,
      resultCount: outcome.resultCount,
      failureCount,
      nextCheckAt,
      lastError,
      provider,
      boardToken,
    },
    suspectDrop,
    providerCorrected,
  };
}

// ---------------------------------------------------------------------------
// Default probe: tier routing through the wave-4 mapping (STEP 2)
// ---------------------------------------------------------------------------

export type ProbeFailureStatus = 'blocked' | 'http_error' | 'timeout' | 'invalid' | 'skipped';

export interface ClassifiedFailure {
  status: ProbeFailureStatus;
  httpStatus?: number;
  error: string;
}

/**
 * Map a transport throw to a verification outcome.
 *
 * T902 ordering (do not reorder):
 *   1. branded skip (skipped===true or name==='BrowserTierSkippedError') -> skipped
 *   2. UnknownSourceTypeError | SourceConfigError                      -> invalid
 *   3. HttpStatusError -> by status:
 *        304           -> skipped (reason `not modified (304)`)
 *        408           -> timeout
 *        403, 429, 503 -> blocked (status from structure, not regex)
 *        300, 305, 306 -> invalid
 *        other 4xx/5xx -> http_error
 *        other         -> http_error
 *   4. message-regex fallback (kept for inputs the structured path declined):
 *        timeout/abort/DNS / ETIMEDOUT / EAI_AGAIN -> timeout
 *        'unsupported content type'                -> invalid
 *        forbidden|captcha|challenge|cloudflare|rate.?limit|too many
 *        requests|access denied|blocked            -> blocked
 *        otherwise                                 -> http_error
 *
 * Steps 1-3 are structure (the primary path); step 4 is the documented
 * fallback for the code paths that still throw plain Errors
 * (`adapters/career-page.ts` content-type / size guards). A 200 carrying
 * an HTML login/interstitial is reported `blocked` by the transport with a
 * specific message (never counts as `empty`); adapter-clean empties arrive
 * as rows, not throws.
 */
export function classifyProbeError(error: unknown): ClassifiedFailure {
  // Step 1: branded skip (browser tier or any future tier-skipped brand).
  if (error !== null && typeof error === 'object') {
    const branded = error as { skipped?: unknown; name?: unknown; reason?: unknown };
    if (branded.skipped === true || branded.name === 'BrowserTierSkippedError') {
      const reason =
        typeof branded.reason === 'string' && branded.reason !== ''
          ? branded.reason
          : messageOf(error);
      return { status: 'skipped', error: boundErrorText(reason) };
    }
  }

  // Step 2: config errors -> invalid (with the mapping's specific message).
  if (error instanceof UnknownSourceTypeError || error instanceof SourceConfigError) {
    return { status: 'invalid', error: boundErrorText(messageOf(error)) };
  }

  // Step 3: structured HTTP error (T902 primary path).
  if (error instanceof HttpStatusError) {
    const status = error.status;
    const reason = messageOf(error);
    if (status === 304) {
      return { status: 'skipped', httpStatus: 304, error: boundErrorText(`not modified (304): ${reason}`) };
    }
    const kind = classifyTransportFailure(error);
    // classifyTransportFailure returns a non-null kind for every HttpStatusError,
    // so this switch is exhaustive over the kind's mapped ProbeFailureStatus.
    switch (kind) {
      case 'not_modified':
        return { status: 'skipped', httpStatus: status, error: boundErrorText(`not modified (${status}): ${reason}`) };
      case 'timeout':
        return { status: 'timeout', httpStatus: status, error: boundErrorText(reason) };
      case 'blocked':
        return { status: 'blocked', httpStatus: status, error: boundErrorText(reason) };
      case 'invalid':
        return { status: 'invalid', httpStatus: status, error: boundErrorText(reason) };
      case 'http_error':
      default:
        return { status: 'http_error', httpStatus: status, error: boundErrorText(reason) };
    }
  }

  // Step 4: documented message-regex fallback (kept verbatim from the
  // pre-wave implementation; only invoked for inputs the structured path
  // declined, i.e. plain Error throws from non-HTTP code paths).
  const message = messageOf(error);
  if (/timed?\s*out|ETIMEDOUT|EAI_AGAIN|aborted|\babort\b/i.test(message)) {
    return { status: 'timeout', error: boundErrorText(message) };
  }
  if (/unsupported content type/i.test(message)) {
    return { status: 'invalid', error: boundErrorText(message) };
  }
  const fetchFailed = message.match(/fetch failed (\d{3})/i);
  const httpStatus = fetchFailed ? Number(fetchFailed[1]) : undefined;
  if (
    httpStatus === 403 ||
    httpStatus === 429 ||
    /forbidden|captcha|challenge|cloudflare|rate.?limit|too many requests|access denied|\bblocked\b/i.test(
      message,
    )
  ) {
    return { status: 'blocked', httpStatus, error: boundErrorText(message) };
  }
  // Use the structural helper as a last-resort for plain Error throws
  // whose message does not contain a numeric status - keeps the fallback
  // path aligned with the canonical vocabulary in httpStatus.ts.
  const fallbackKind = classifyTransportFailure(error);
  if (fallbackKind === 'blocked' || fallbackKind === 'invalid' || fallbackKind === 'timeout') {
    return { status: fallbackKind, httpStatus, error: boundErrorText(message) };
  }
  return { status: 'http_error', httpStatus, error: boundErrorText(message) };
}

function browserTierConfig(url: string): JobSourceConfig {
  // Deep-mode-only descriptor (wave 6): the crawler always supplies the
  // run-mode flag, so a tier-4 unit is a legitimate deep read, never a
  // default sweep. Routed through the descriptor table, not a ladder.
  return { type: 'browser', query: '', feedUrl: url, deepMode: true };
}

/**
 * Default transport: route the unit through the wave-4 registry-provider
 * mapping. Tiers 1/2/3 resolve via configForRegistryRow (provider id ->
 * backing adapter type -> descriptor config) and execute through runSource;
 * tier 4 executes the browser descriptor as a deep-mode unit. Adapter rows
 * decide ok vs empty by length; every throw is classified (never leaks).
 * Per-unit latency is measured here with Date.now and reported ONLY as
 * latencyMs - policy time still comes from the injected `now`.
 */
export async function defaultProbe(unit: CrawlUnit): Promise<CrawlOutcome> {
  const started = Date.now();
  const latencyMs = (): number => Date.now() - started;
  try {
    // Tier 4: the wave-6 browser descriptor as a deep-mode unit, resolved
    // through the same PROVIDERS table (never a separate ladder). A missing
    // descriptor or an absent engine is skipped-with-reason, never a failure.
    if (unit.tier === 4) {
      const browser = getProvider('browser');
      if (!browser) {
        return {
          pageId: unit.pageId,
          status: 'skipped',
          resultCount: 0,
          latencyMs: latencyMs(),
          error: boundErrorText('browser tier unavailable in this build'),
        };
      }
      const rows = await runSource(browserTierConfig(unit.url));
      const browserCount = rows.length;
      return {
        pageId: unit.pageId,
        status: browserCount > 0 ? 'ok' : 'empty',
        // T902: a successful probe that did not observe an exact code writes
        // undefined; buildVerificationUpdate renders it as null. A failure
        // path still carries the observed status from the structured error.
        httpStatus: undefined,
        resultCount: browserCount,
        latencyMs: latencyMs(),
      };
    }
    const rows = await runSource(
      configForRegistryRow({
        provider: unit.provider,
        boardToken: unit.boardToken,
        url: unit.url,
      }),
    );
    const resultCount = rows.length;
    return {
      pageId: unit.pageId,
      status: resultCount > 0 ? 'ok' : 'empty',
      // T902: success branches no longer invent httpStatus: 200.
      httpStatus: undefined,
      resultCount,
      latencyMs: latencyMs(),
    };
  } catch (error) {
    const classified = classifyProbeError(error);
    if (classified.status === 'skipped') {
      return {
        pageId: unit.pageId,
        status: 'skipped',
        resultCount: 0,
        latencyMs: latencyMs(),
        error: classified.error,
      };
    }
    return {
      pageId: unit.pageId,
      status: classified.status,
      httpStatus: classified.httpStatus,
      resultCount: 0,
      latencyMs: latencyMs(),
      error: classified.error,
    };
  }
}

// ---------------------------------------------------------------------------
// Default Prisma store (production wiring; tests inject a fake)
// ---------------------------------------------------------------------------

function toStored(page: {
  id: string;
  url: string;
  provider: string | null;
  boardToken: string | null;
  tier: number;
  isActive: boolean;
  verifyStatus: string;
  verifyMethod: string | null;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  httpStatus: number | null;
  resultCount: number;
  failureCount: number;
  nextCheckAt: Date | null;
  lastError: string | null;
}): StoredCareerPage {
  return { ...page };
}

const prismaStore: CrawlStore = {
  async listDue(limit: number, now: Date): Promise<StoredCareerPage[]> {
    // The [isActive, tier, nextCheckAt] index from wave 2 is the intended
    // plan: active pages that were never scheduled (null) or whose
    // nextCheckAt passed, oldest first (Postgres ASC sorts nulls first -
    // never-scheduled pages sort first, which is what the crawler wants),
    // id as the stable tie-break. Mirrors selectDueBatch in SQL.
    const rows = await prisma.companyCareerPage.findMany({
      where: {
        isActive: true,
        OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
      },
      orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(toStored);
  },
  async readForUpdate(pageId: string): Promise<StoredCareerPage | null> {
    // T904: delegated to the shared verifyStore so the column list exists in
    // ONE place (writePageVerification below). The CrawlStore contract is
    // unchanged.
    return readPageForUpdate(pageId);
  },
  async writeVerification(pageId: string, update: VerificationUpdate): Promise<void> {
    // T904: delegated to the shared verifyStore; the column list lives there
    // and is asserted by verifyStore.test.ts.
    await writePageVerification(pageId, update);
  },
};

// ---------------------------------------------------------------------------
// Batch entry points
// ---------------------------------------------------------------------------

/**
 * Work-queue read: only active, due pages in deterministic nextCheckAt
 * order (stable id tie-break), capped at the passed limit. Never-scheduled
 * (null nextCheckAt) pages sort first. Inactive pages are never enqueued.
 */
export async function nextBatch(
  limit: number,
  now: Date,
  deps?: CrawlerDeps,
): Promise<CrawlUnit[]> {
  const store = deps?.store ?? prismaStore;
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (safeLimit <= 0) return [];
  const pages = await store.listDue(safeLimit, now);
  return selectDueBatch(pages, safeLimit, now);
}

async function crawlOne(
  store: CrawlStore,
  probe: ProbeFn,
  unit: CrawlUnit,
  now: Date,
): Promise<CrawlOutcome> {
  // Per-company failure isolation: a throwing transport becomes that page's
  // http_error outcome - the batch always continues.
  let outcome: CrawlOutcome;
  try {
    const probed = await probe(unit);
    outcome = { ...probed, pageId: unit.pageId, latencyMs: Math.max(0, probed.latencyMs ?? 0) };
  } catch (error) {
    outcome = {
      pageId: unit.pageId,
      status: 'http_error',
      resultCount: 0,
      latencyMs: 0,
      error: boundErrorText(messageOf(error)),
    };
  }
  try {
    const stored = await store.readForUpdate(unit.pageId);
    // A page deleted mid-batch has nothing to write back to; the observed
    // outcome is still returned.
    if (stored !== null) {
      const detail = buildVerificationUpdate(stored, outcome, now);
      await store.writeVerification(unit.pageId, detail.update);
    }
  } catch (error) {
    // Isolation applies to persistence too: warn (page id only, no secrets)
    // and keep the observed outcome - sibling pages already wrote theirs.
    console.warn(
      `[registry/crawler] write-back failed for page ${unit.pageId}: ${boundErrorText(messageOf(error))}`,
    );
  }
  return outcome;
}

/**
 * Crawl one bounded batch on demand (no scheduler): take up to `limit` due
 * units (CLAMPED to CRAWL_BATCH_SIZE - a larger limit never widens the
 * request), run them through the tier-routed probe with at most
 * CRAWL_CONCURRENCY in flight, isolate every per-company failure, write
 * each outcome back, and return the per-company result records in queue
 * order. A limit <= 0 returns [].
 */
export async function crawlBatch(
  limit: number,
  opts: { now: Date },
  deps?: CrawlerDeps,
): Promise<CrawlOutcome[]> {
  const store = deps?.store ?? prismaStore;
  const probe = deps?.probe ?? defaultProbe;
  const now = opts.now;
  const safeLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
  if (safeLimit <= 0) return [];
  const effective = Math.min(safeLimit, CRAWL_BATCH_SIZE);
  const batch = await nextBatch(effective, now, deps);
  const outcomes: CrawlOutcome[] = new Array(batch.length);
  let cursor = 0;
  const width = Math.min(CRAWL_CONCURRENCY, batch.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < width; w += 1) {
    workers.push(
      (async () => {
        while (cursor < batch.length) {
          const index = cursor;
          cursor += 1;
          outcomes[index] = await crawlOne(store, probe, batch[index], now);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return outcomes;
}
