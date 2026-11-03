// Job Discovery & Evaluation Routes
// Search public ATS sources (zero-token) and evaluate listings with the career-ops rubric.

import { Router, Request, Response } from 'express';
import type { JobListing, Prisma } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { ensureSearchDocument } from '../search/refresh.js';
import { refreshCatalogueFacets } from '../search/store.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, HttpError, NotFoundError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, jobSearchSchema, jobLocationsQuerySchema, evaluateJobSchema, normalizeBatchSchema, normalizeJobSchema, normalizeLocationPref } from '../shared/validation.js';
import { runSource, boardToConfig, type JobSourceConfig, type RawJob } from '../jobSources/index.js';
import { seedDefaultBoardsForUser } from '../jobSources/defaultBoards.js';
import { recordSourceSuccess, recordSourceFailure } from '../jobSources/sourceHealth.js';
import {
  beginRun,
  finishRun,
  getRun,
  isLikelyMissingKeyError,
  markCancelled,
  markFailed,
  markNeedsKey,
  markOk,
  markRunning,
  setRunEvaluation,
  setRunMode,
  setRunSweep,
  touchRun,
} from '../jobSources/discoveryRuns.js';
import {
  cancelRun,
  runSearch,
  type CompanyScopeResolution,
  type ExecutableUnit,
  type UserBoardRef,
} from '../discovery/orchestrator.js';
import {
  DEFAULT_SOURCE_GROUPS,
  SEARCH_MODES,
  deriveIntent,
  type SearchIntent,
} from '../discovery/searchIntent.js';
import { DEEP_RUN_TTL_MS } from '../discovery/budgets.js';
import { randomUUID } from 'node:crypto';
import { dedupeJobs, withDeterministicExternalId } from '../jobSources/jobIdentity.js';
import type { SourceRef } from '../discovery/dedupe.js';
import {
  provenanceCreateData,
  provenanceUpdateData,
  shapeListingResponse,
  type JobListingResponse,
  type PersistableJob,
} from '../discovery/persistence.js';
import { parseQuery, queryScore } from '../jobSources/queryMatch.js';
import {
  isFresh,
  sortByRelevanceThenRecency,
  POSTED_WITHIN_DAYS,
  type PostedWithin,
} from '../jobSources/freshness.js';
import { checkLiveness } from '../jobSources/liveness.js';
import { evaluateJob } from '../ai/evaluation.js';
import { isRateLimitError } from '../ai/keyManager.js';
import {
  cleanDescription,
  normalizationHash,
  normalizeJobDescription,
  NormalizationError,
  type NormalizedDescription,
} from '../ai/jdNormalizer.js';
import { getProviderModel } from '../ai/providerModels.js';
import { LLM_PROVIDER_IDS } from '../ai/providerRegistry.js';
import fullScanHandler from './jobs.fullscan.js';
import {
  applyPageResult,
  sweepBoards,
  type PageFetchResult,
  type PageRecordOutcome,
  type SweepPage,
  type SweepResult,
} from '../discovery/boardSweep.js';
import {
  closeStalePostings,
  type SweepCycleDeps,
} from '../discovery/sweepCycle.js';
import { fetchGreenhouse } from '../jobSources/adapters/greenhouse.js';
import { fetchAshby } from '../jobSources/adapters/ashby.js';
import { fetchLever } from '../jobSources/adapters/lever.js';
import { fetchWorkable } from '../jobSources/adapters/workable.js';
import { fetchBambooHR } from '../jobSources/adapters/bamboohr.js';
import { fetchBreezyHR } from '../jobSources/adapters/breezyhr.js';
import { fetchJobvite } from '../jobSources/adapters/jobvite.js';
import { fetchPinpoint } from '../jobSources/adapters/pinpoint.js';
import { fetchTeamtailor } from '../jobSources/adapters/teamtailor.js';
import { fetchRecruitee } from '../jobSources/adapters/recruitee.js';
import { fetchSmartRecruiters } from '../jobSources/adapters/smartrecruiters.js';
import { fetchFreshteam } from '../jobSources/adapters/freshteam.js';
import { fetchRippling } from '../jobSources/adapters/rippling.js';

const router = Router();

/**
 * Description persistence guard (stored-description-wins on empty re-discovery).
 *
 * Re-discovery rows sometimes arrive with an empty description (e.g. a board
 * list page that omits `content`). Blindly upserting that empty string would
 * clobber a good stored description, which then breaks evaluation ("no usable
 * description"). Returns true when the stored text must be kept: stored is
 * non-blank and the incoming text is blank. Pure helper, exported for testing.
 */
export function shouldKeepStoredDescription(
  stored: string | null | undefined,
  incoming: string | null | undefined,
): boolean {
  return (stored ?? '').trim().length > 0 && (incoming ?? '').trim().length === 0;
}

/**
 * Upsert flattened, deduped source results into JobListing.
 * Every job is guaranteed a deterministic externalId so repeated scans
 * update the same row instead of creating duplicates.
 *
 * Wave 3 (T665, ADR-028/ADR-032): the five provenance columns
 * (`postedAtSource`, `postedAtRaw`, `firstSeenAt`, `dateConfidence`,
 * `canonicalKey`) are written on every upsert. `firstSeenAt` is stamped from
 * the injected `now` on CREATE only - the update payload never moves it, so
 * a second upsert of the same row keeps its original stamp. The survivor's
 * in-memory `sources` array (attached by `dedupeJobs`) is carried on the
 * returned record so the API can expose it; it is not a DB column.
 */
export interface UpsertedJobListing extends JobListing {
  sources?: SourceRef[];
}

// ---------------------------------------------------------------------------
// T892 boundary guard - unusable discovered rows never reach Prisma.
//
// `RawJob` declares `source` / `sourceUrl` / `title` / `company` as required
// `string`s, but the adapters that pass untyped upstream JSON straight through
// (`greenhouse.ts` `j.absolute_url`, `ashby.ts` `j.jobUrl || j.applyUrl`,
// `json.ts`, `rss.ts`, `recruitee.ts`, `personio.ts`, `smartrecruiters.ts`,
// `jobicy.ts`) hand the real runtime value over unguarded: when upstream omits
// the field the key is `undefined` at runtime even though the type says
// `string` - the same type-lie class as the `postedAtRaw` Int fix, which is
// defended one layer down in `discovery/persistence.ts` (`coercePostedAtRaw`).
//
// T892 live test (2026-09-25) measured the cost: a Full-scan batch 500'd with
//     PrismaClientValidationError: Argument 'sourceUrl' is missing.
//       at prisma.jobListing.upsert()  <- upsertDiscoveredJobs
// on the FIRST such row, losing the whole batch. The old `/scan` `limit`
// slice hid these rows; Full now persists every matched row, so the guard has
// to live at this one shared choke point - not in each adapter.
//
// Two rules, per row, BEFORE the upsert:
//   1. FALLBACK FIRST. A blank `sourceUrl` with a non-blank `applyUrl` is
//      persisted as `sourceUrl = applyUrl` - the same precedence dorking
//      already uses (`dorking/index.ts` `row.sourceUrl || row.applyUrl || ''`).
//      This is the common real case: the apply link IS the link.
//   2. DROP AS UNUSABLE. A row still left with no usable link, or with a blank
//      `title` / `company` / `source`, cannot be written at all, so it is
//      dropped (never persisted with a fabricated value) and reported once per
//      run on a greppable `[persist-skip]` line.
//
// Schema audit (`backend/prisma/schema.prisma` `model JobListing`): the
// non-null columns this function writes are `source`, `sourceUrl`, `title`,
// `company` and `description`; `description` needs no guard because
// `sanitizeRawJob` (via `withDeterministicExternalId`) already normalises it
// to a string. Everything else written here (`location`, `applyUrl`,
// `postedAt`, the five provenance columns, `lastVerifiedAt`) is NULLABLE in
// the schema and is never given an invented value.
//
// Row identity is untouched by rule 1: `jobIdentity.buildCanonical` already
// prefers `applyUrl` over `sourceUrl`, so a row that only carried `applyUrl`
// hashes to the same deterministic `externalId` with or without the fallback.
// Dedupe therefore behaves exactly as before.
// ---------------------------------------------------------------------------

/** Max chars of a title kept in a `[persist-skip]` record (a snippet, never a description). */
const SKIP_TITLE_SNIPPET_CHARS = 60;
/** Max `[persist-skip]` records per run, so one run can never flood the logs. */
const MAX_SKIP_LOG_RECORDS = 20;
/** Greppable prefix for the live test (`docker logs | grep '[persist-skip]'`). */
const PERSIST_SKIP_PREFIX = '[persist-skip]';

/**
 * One dropped row, as it appears in the `[persist-skip]` log: the board/page
 * source name, the adapter-supplied external id, a bounded title snippet and
 * the single missing field. No description, no URL, no secret ever appears
 * here - a skip log is not a data dump.
 */
export interface PersistSkipRecord {
  source: string;
  externalId: string | null;
  title: string;
  missing: string;
}

/** `value` is a string with at least one non-whitespace character. */
function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** One-line, whitespace-collapsed, length-bounded title for a skip record. */
function titleSnippet(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return text.length > SKIP_TITLE_SNIPPET_CHARS
    ? `${text.slice(0, SKIP_TITLE_SNIPPET_CHARS)}...`
    : text;
}

function skipRecord(job: RawJob, missing: string): PersistSkipRecord {
  return {
    source: isNonBlank(job.source) ? job.source : 'unknown',
    externalId: isNonBlank(job.externalId) ? job.externalId : null,
    title: titleSnippet(job.title),
    missing,
  };
}

/**
 * Apply the T892 boundary rules to ONE discovered row. Pure (no DB, no clock),
 * exported for testing. Returns the row to persist - possibly with `sourceUrl`
 * filled from `applyUrl` - or the compact record explaining why the row can
 * never be persisted.
 *
 * The `title` / `company` / `source` checks run on the SANITIZED row, i.e. on
 * exactly the strings the create payload carries: a title that sanitizes to
 * `''` (NUL-only, control-only) is as unusable as one that never arrived.
 */
export function prepareRowForPersist(
  job: RawJob,
): { row: RawJob } | { skip: PersistSkipRecord } {
  // Rule 1 - fallback. `sourceUrl` is kept byte-identical whenever it is
  // already usable, so well-formed rows are untouched.
  const sourceUrl = isNonBlank(job.sourceUrl)
    ? job.sourceUrl
    : isNonBlank(job.applyUrl)
      ? job.applyUrl
      : '';
  // Rule 2a - no usable link at all: drop before any DB call.
  if (sourceUrl.length === 0) return { skip: skipRecord(job, 'sourceUrl') };

  // withDeterministicExternalId always sanitizes title/company/location/
  // description to WIN1252-safe text (the DB server encoding rejects e.g.
  // U+2192 with 22P05 -> backend 500) and fills a stable post-sanitize id.
  const row = withDeterministicExternalId({ ...job, sourceUrl });
  if (!isNonBlank(row.title)) return { skip: skipRecord(job, 'title') };
  if (!isNonBlank(row.company)) return { skip: skipRecord(job, 'company') };
  if (!isNonBlank(row.source)) return { skip: skipRecord(job, 'source') };
  return { row };
}

/**
 * Upsert flattened, deduped source results into JobListing, one row at a time.
 *
 * T892: this is the ONE shared choke point every discovery route (`/search`,
 * `/scan`, `/full-scan`, plus the saved-search and job-alert callers) persists
 * through, so the unusable-row boundary guard lives here and not in each
 * adapter - see the block comment above `prepareRowForPersist`. Rows that
 * cannot satisfy the non-null `JobListing` columns are dropped (and reported
 * once per run on a `[persist-skip]` line) rather than 500-ing the batch.
 * The returned array is exactly the rows that were persisted, so callers'
 * `persisted` / `totalListings` counts stay honest to what was written.
 *
 * REACTIVATION: the update branch writes `isActive: true`. A soft-closed row
 * (`closeStalePostings`) that reappears - from a normal re-discovery or from a
 * catalogue snapshot import - comes back instead of staying invisible, which
 * closes the last gap where rediscovery alone could not revive a closed row.
 */
export async function upsertDiscoveredJobs(
  jobs: RawJob[],
  now: Date = new Date(),
): Promise<UpsertedJobListing[]> {
  const upserted: UpsertedJobListing[] = [];
  // T892 boundary guard bookkeeping: one aggregated `[persist-skip]` line per
  // run, never one line per row.
  const skipSamples: PersistSkipRecord[] = [];
  let skippedCount = 0;
  for (const job of jobs) {
    // T892 boundary guard (see the block comment above `prepareRowForPersist`):
    // a blank `sourceUrl` borrows a non-blank `applyUrl`; a row that still
    // cannot satisfy the non-null JobListing columns is dropped here, before
    // the findUnique/upsert pair, instead of 500-ing the whole batch.
    const prepared = prepareRowForPersist(job);
    if ('skip' in prepared) {
      skippedCount += 1;
      if (skipSamples.length < MAX_SKIP_LOG_RECORDS) skipSamples.push(prepared.skip);
      continue;
    }
    const withId = prepared.row;
    // Never overwrite a stored non-empty description with an empty
    // re-discovery: the update path keeps the stored text while create still
    // stores whatever arrived (possibly empty). The lookup is best-effort -
    // a lookup failure falls through to the incoming description rather than
    // failing the row.
    let descriptionForUpdate = withId.description;
    try {
      const existing = await prisma.jobListing.findUnique({
        where: { source_externalId: { source: withId.source, externalId: withId.externalId! } },
        select: { description: true },
      });
      if (existing && shouldKeepStoredDescription(existing.description, withId.description)) {
        descriptionForUpdate = existing.description;
      }
    } catch {
      // Best-effort guard only; the upsert below still runs with incoming text.
    }
    const rec = await prisma.jobListing.upsert({
      where: { source_externalId: { source: withId.source, externalId: withId.externalId! } },
      update: { title: withId.title, company: withId.company, location: withId.location, description: descriptionForUpdate, applyUrl: withId.applyUrl, sourceUrl: withId.sourceUrl, postedAt: withId.postedAt, lastVerifiedAt: new Date(), isActive: true, ...provenanceUpdateData(withId as PersistableJob) },
      create: {
        source: withId.source,
        externalId: withId.externalId,
        sourceUrl: withId.sourceUrl,
        title: withId.title,
        company: withId.company,
        location: withId.location,
        description: withId.description,
        applyUrl: withId.applyUrl,
        postedAt: withId.postedAt,
        lastVerifiedAt: new Date(),
        ...provenanceCreateData(withId as PersistableJob, now),
      },
    });
    // Keep the derived searchDocument in step with the persisted row so the
    // catalogue store and facets see newly discovered rows without a backfill.
    await ensureSearchDocument(prisma, rec, now);
    const sources = (withId as PersistableJob).sources;
    upserted.push(sources && sources.length > 0 ? { ...rec, sources } : rec);
  }
  if (skippedCount > 0) {
    // Return value stays "rows actually persisted", so route counts
    // (`persisted`, `totalListings`) stay honest to what was written.
    console.warn(`${PERSIST_SKIP_PREFIX} dropped unusable discovered row(s) before upsert`, {
      dropped: skippedCount,
      sampled: skipSamples.length,
      rows: skipSamples,
    });
  }
  return upserted;
}

// location may arrive repeated (?location=a&location=b) or comma-joined. Both forms are
// accepted (ADR-008), trimmed, blank-dropped and case-insensitively deduped. A single
// JSON-array-looking value (["a","b"], the StoredLocation write form) is decoded the same
// way ADR-008 decodes stored locations; anything else is kept literally. Never throws.
export function parseLocationParam(raw: unknown): string[] {
  const entries: string[] = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : typeof raw === 'string' ? [raw] : [];
  const values: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (typeof item === 'string') values.push(item);
          }
          continue;
        }
      } catch {
        // Not valid JSON - fall through and keep the whole string literally.
      }
    }
    for (const part of entry.split(',')) {
      values.push(part);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const needle = value.trim();
    if (!needle) continue;
    const key = needle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(needle);
  }
  return out;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function getOptionalRunId(req: Request): string | undefined {
  const raw = req.query.runId;
  if (typeof raw !== 'string') return undefined;
  if (!RUN_ID_PATTERN.test(raw)) return undefined;
  return raw;
}

function getOptionalPostedWithin(req: Request): PostedWithin | undefined {
  const raw = req.query.postedWithin;
  if (typeof raw !== 'string') return undefined;
  if ((Object.keys(POSTED_WITHIN_DAYS) as string[]).includes(raw)) return raw as PostedWithin;
  // Anything else is ignored (never a 400) per the freshness contract.
  return undefined;
}

function scoreText(job: { title?: string | null; company?: string | null; location?: string | null; description?: string | null }): string {
  return `${job.title || ''} ${job.company || ''} ${job.location || ''} ${job.description || ''}`;
}

// ADR-021 decision 2 (uniform server-side query post-filter): after dedupe,
// attach a token-OR query score, DROP zero-score rows when the query is
// meaningful, then sort by (score desc, postedAt desc, undated last) and drop
// stale rows. A non-meaningful query keeps every row and scores 0 (unchanged
// ADR-012 semantics). This gives scraper/aggregator/search rows the same
// token-OR rule the keyless fetchers already apply. Exported for testing.
// Returns scored rows in final display order.
export function filterAndOrder<T extends { title?: any; company?: any; location?: any; description?: any; postedAt?: Date }>(
  jobs: T[],
  query: string,
  postedWithin?: PostedWithin,
): T[] {
  const needle = parseQuery(query);
  const scored = jobs.map((job) => ({ ...job, score: queryScore(scoreText(job as any), needle) }));
  const kept = needle.isMeaningful ? scored.filter((job) => job.score > 0) : scored;
  const sorted = sortByRelevanceThenRecency(kept);
  return sorted.filter((job) => isFresh(job, postedWithin === undefined ? undefined : { postedWithin }));
}

function safeRegistry(fn: () => void): void {
  try {
    fn();
  } catch {
    // Registry bugs must never fail a search/scan request.
  }
}

function registryErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 500);
}

// Wave 7 (T743) additive search-item flags, wave 11 (T820) retention truth:
// `cancelled` / `partial` ride on top of shapeListingResponse without
// renaming or removing any pre-existing key. Derived from the run snapshot
// when a runId is attached (a finished run whose boards are not all `ok` is
// partial); plain searches report false. `outcomeCancelled` is the
// orchestrator's own `cancelled` boolean for this request: it is OR-ed in
// so a cancelled run is still flagged when the snapshot has expired
// (RUN_TTL_MS can outlive a deep run - retention MUST NOT depend on the
// snapshot surviving) or when the cancel arrived via an external abort
// rather than POST /runs/:runId/cancel.
export type SearchListingResponse = JobListingResponse & {
  cancelled: boolean;
  partial: boolean;
};

export function shapeSearchResponse(
  j: UpsertedJobListing,
  runId?: string,
  userId?: string,
  outcomeCancelled?: boolean,
): SearchListingResponse {
  const shaped = shapeListingResponse(j, { sources: j.sources });
  let cancelled = outcomeCancelled === true;
  let partial = outcomeCancelled === true;
  if (runId && userId) {
    const snap = getRun(runId, userId);
    if (snap) {
      cancelled = cancelled || snap.cancelled === true;
      partial = partial || cancelled || snap.boards.some((b) => b.status !== 'ok');
    }
  }
  return { ...shaped, cancelled, partial };
}

// Wave 7 (T744, ADR-027) - contract-preserving orchestrator wiring shared by
// GET /search and GET /scan. Only the internal fan-out path goes through the
// orchestrator; every response field, status code, filter, ordering, upsert,
// health and run-registry behaviour stays exactly as before.
//
// What the injected deps guarantee:
// - `listUserBoards` reuses the boards + configs the route already built
//   (single DB read, D4 aggregator + ADR-021 scraper location mirroring
//   intact) - the orchestrator only orders, bounds and cancels the fan-out.
// - `resolveCompanies` is boards-only for `fast` and every no-mode request:
//   `company` remains the route's post-filter, exactly as today. Since
//   ADR-033 (T886) the `standard`/`deep` modes on `/search` deliberately OMIT
//   this key so the orchestrator's default registry-backed resolver applies
//   (Standard's registryCap=0 short-circuits it with an explicit skip; Deep
//   resolves the named companies under its caps). `/scan` carries no company
//   filter and stays boards-only in every mode. The registry is never SWEPT
//   here - only Full's dedicated route batches it.
// - the executor keeps the legacy per-board try/catch semantics verbatim
//   (registry marks, health writes, failing board yields [] and the request
//   still succeeds) and restores the verbatim legacy board query: the
//   orchestrator derives the executed query from the intent, but the legacy
//   contract queries every board with the raw request q.
export interface LegacySearchFields {
  q: string;
  sources?: string[];
  locations: string[];
  company?: string;
  /** Additive intent fields accepted by the Full-scan batch route. */
  roles?: string[];
  skills?: string[];
  exclusions?: string[];
  companies?: string[];
  sourceGroups?: string[];
  limit: number;
  postedWithin?: PostedWithin;
  // Wave 10 follow-up: the UI sends `mode` additively (fast is the omission
  // default) and may send `evaluate`; both ride through to `deriveIntent`,
  // which validates them (unknown -> fast / deterministic). Kept as raw
  // strings so the route can pass query values verbatim and can decide the
  // mode-scoped pieces (registry resolver, snapshot TTL) from the same value.
  // ADR-033 (T886): the mode vocabulary is now the four canonical wire values
  // `fast | standard | deep | full`; the two legacy routes only pass their
  // bounded standard/deep values, while the dedicated Full route may pass the
  // explicit `full` value below.
  mode?: string;
  evaluate?: string;
}

// Shared four-value wire vocabulary (ADR-033 decision 1). Imported from
// searchIntent.ts - the ONE list - so the route validator and the intent
// schema can never drift apart.
const SEARCH_MODE_VALUES: ReadonlySet<string> = new Set(SEARCH_MODES);

/**
 * Raw `mode` query value, validated against the shared four-value vocabulary.
 * Unknown or absent values yield undefined (the intent defaults to fast) -
 * never a 400, mirroring the postedWithin contract below.
 *
 * WHY `allowFull` DEFAULTS TO FALSE (ADR-033 decision 1, spec edge case 1):
 * Full is ROUTE-EXCLUSIVE - it belongs to `GET /jobs/full-scan` and its
 * batched sweep mechanics. A stray `mode=full` on `/jobs/search` or
 * `/jobs/scan` is therefore treated exactly like any unknown value: it
 * degrades to the documented `fast` default. It is deliberately NOT a 400
 * (a client that sends it keeps working) and deliberately NOT a partial
 * sweep (a half-run Full would be unbounded I/O with no honest
 * `hasMore`), so the only two possibilities are "fast" and "reject".
 * Only the full-scan route calls this with `{ allowFull: true }`.
 */
export function getOptionalMode(req: Request, opts: { allowFull?: boolean } = {}): string | undefined {
  const raw = req.query.mode;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (!SEARCH_MODE_VALUES.has(value)) return undefined;
  if (value === 'full' && opts.allowFull !== true) return undefined;
  return value;
}

/**
 * Registry-backed company scoping is opt-in per mode (ADR-033 decision 3).
 * `standard` and `deep` are the only modes on these two routes that may
 * resolve the named-company scope through the registry:
 * - `fast` (and every no-mode request) keeps `boardsOnlyCompanyScope`
 *   byte-identically - the legacy `company` post-filter, no registry read.
 * - `standard` omits the resolver too, but its own `registryCap = 0`
 *   (T882) short-circuits the lookup and records the
 *   `registry scope disabled: standard mode` skip with no DB access.
 * - `deep` resolves the intent's company names through the orchestrator's
 *   default registry-backed resolver, under the mode's caps (10 names /
 *   200 pages), reporting overflow. The registry is never SWEPT by any of
 *   these modes - only Full's dedicated route batches it.
 */
function usesRegistryCompanyScope(mode: string | undefined): boolean {
  return mode === 'standard' || mode === 'deep';
}

// Raw `evaluate` query value, validated to the SearchIntent vocabulary.
// Unknown or absent values yield undefined (the intent defaults to
// deterministic) - never a 400.
export function getOptionalEvaluate(req: Request): string | undefined {
  const raw = req.query.evaluate;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'off' || value === 'deterministic' || value === 'ai-subset') return value;
  return undefined;
}

export function intentForLegacySearch(fields: LegacySearchFields): SearchIntent {
  try {
    return deriveIntent({
      q: fields.q,
      sources: fields.sources,
      location: fields.locations,
      company: fields.company,
      ...(fields.roles !== undefined ? { roles: fields.roles } : {}),
      ...(fields.skills !== undefined ? { skills: fields.skills } : {}),
      ...(fields.exclusions !== undefined ? { exclusions: fields.exclusions } : {}),
      ...(fields.companies !== undefined ? { companies: fields.companies } : {}),
      ...(fields.sourceGroups !== undefined ? { sourceGroups: fields.sourceGroups as SearchIntent['sourceGroups'] } : {}),
      limit: fields.limit,
      postedWithin: fields.postedWithin,
      mode: fields.mode,
      evaluate: fields.evaluate,
    });
  } catch {
    // deriveIntent's token derivation can reject adversarial-but-legal legacy
    // input (e.g. a single >100-char token exceeds the roles item cap) that
    // jobSearchSchema accepts. The intent only drives orchestrator scheduling
    // here, so the safe fallback is the same search with no derived
    // structure - execution is identical, never a 500 where legacy 200'd.
    // Mode/evaluate still ride through (validated the same way deriveIntent
    // validates them) so a standard/deep request never silently runs fast
    // here. ADR-033: the fallback literal accepts the whole shared
    // four-value vocabulary and still defaults to 'fast' for anything else
    // (including a raw 'full' this route pair never lets through).
    const mode: 'fast' | 'standard' | 'deep' | 'full' = SEARCH_MODE_VALUES.has(fields.mode ?? '')
      ? (fields.mode as 'fast' | 'standard' | 'deep' | 'full')
      : 'fast';
    const evaluate: 'off' | 'deterministic' | 'ai-subset' =
      fields.evaluate === 'off' || fields.evaluate === 'deterministic' || fields.evaluate === 'ai-subset'
        ? fields.evaluate
        : 'deterministic';
    const fallbackRoles = Array.isArray(fields.roles)
      ? fields.roles.filter((value): value is string => typeof value === 'string').slice(0, 10)
      : [];
    const fallbackSkills = Array.isArray(fields.skills)
      ? fields.skills.filter((value): value is string => typeof value === 'string').slice(0, 30)
      : [];
    const fallbackExclusions = Array.isArray(fields.exclusions)
      ? fields.exclusions.filter((value): value is string => typeof value === 'string').slice(0, 20)
      : [];
    const fallbackCompanies = Array.isArray(fields.companies)
      ? fields.companies.filter((value): value is string => typeof value === 'string').slice(0, 500)
      : [];
    const fallbackSourceGroups = Array.isArray(fields.sourceGroups)
      ? fields.sourceGroups.filter((value): value is SearchIntent['sourceGroups'][number] =>
          value === 'ats' || value === 'feeds' || value === 'aggregators' || value === 'search' ||
          value === 'dorking' || value === 'scraper' || value === 'browser')
      : [];
    return {
      query: fields.q,
      roles: fallbackRoles,
      skills: fallbackSkills,
      exclusions: fallbackExclusions,
      locations: [...fields.locations],
      remoteOnly: false,
      companies: fields.company ? [fields.company, ...fallbackCompanies] : fallbackCompanies,
      sourceGroups: fallbackSourceGroups.length > 0 ? fallbackSourceGroups : [...DEFAULT_SOURCE_GROUPS],
      mode,
      // Wave 9 default: deterministic passes only, never the AI pass.
      evaluate,
      limit: Math.min(100, Math.max(1, Math.floor(fields.limit) || 30)),
      ...(fields.postedWithin ? { postedWithin: fields.postedWithin } : {}),
    };
  }
}

export function boardsOnlyCompanyScope(): Promise<CompanyScopeResolution> {
  return Promise.resolve({ matchedNames: [], pages: [], registryEmpty: true });
}

export function legacyBoardExecutor(runId: string | undefined, query: string, userId: string) {
  return async (unit: ExecutableUnit): Promise<RawJob[]> => {
    const config = { ...unit.config, query, userId };
    const boardId = unit.unitId.startsWith('board:')
      ? unit.unitId.slice('board:'.length)
      : unit.unitId;
    const startedAt = Date.now();
    if (runId) safeRegistry(() => markRunning(runId, boardId));
    try {
      const jobs = await runSource(config);
      const latencyMs = Date.now() - startedAt;
      if (runId) safeRegistry(() => markOk(runId, boardId, jobs.length, latencyMs));
      try {
        await recordSourceSuccess(boardId, jobs.length, latencyMs);
      } catch {
        // Health writes must never fail the request (sourceHealth also swallows errors).
      }
      return jobs;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      if (runId) {
        const message = registryErrorMessage(error);
        safeRegistry(() => {
          if (isLikelyMissingKeyError(message)) markNeedsKey(runId, boardId, message);
          else markFailed(runId, boardId, message, latencyMs);
        });
      }
      try {
        await recordSourceFailure(boardId, error, latencyMs);
      } catch {
        // Health writes must never fail the request (sourceHealth also swallows errors).
      }
      return [];
    }
  };
}

// ==================== DEEP CATALOGUE SWEEP ====================
// Deep search keeps its title-search phase untouched and adds this second
// phase: one keyset batch of active company boards, fetched with an empty
// query (the shared queryMatch "match everything" path). Full scan is NOT
// touched. Cursor/cycle live in AppSetting (`deepSweep:cursor`,
// `deepSweep:cycle`); this module owns no scheduler.
const SWEEP_CURSOR_KEY = 'deepSweep:cursor';
const SWEEP_CYCLE_KEY = 'deepSweep:cycle';
// First batch of a cycle stamps this; completion clears it. The soft-close
// uses it as the "did this cycle see the row?" boundary (see sweepCycle.ts).
const SWEEP_CYCLE_STARTED_AT_KEY = 'deepSweep:cycleStartedAt';
const SWEEP_CONCURRENCY = 8;
const SWEEP_PER_BOARD_TIMEOUT_MS = 20_000;
const DEFAULT_SWEEP_BOARDS = 120;
const DEFAULT_SWEEP_MAX_ROWS = 5000;

type SweepFetcher = (token: string, query: string) => Promise<RawJob[]>;

// Registry provider id -> adapter, all `(token, query)`. `breezy` /
// `pinpointhq` are the registry's host-table ids for the breezyhr / pinpoint
// adapters. `rippling` uses the public ats.rippling.com JSON board endpoint;
// its registry token is the first path segment (e.g. `element`, not the host
// label `ats` - atsUrl.ts extracts that shape).
export const SWEEP_PROVIDER_ADAPTERS: Readonly<Record<string, SweepFetcher>> = {
  greenhouse: fetchGreenhouse,
  ashby: fetchAshby,
  lever: fetchLever,
  workable: fetchWorkable,
  bamboohr: fetchBambooHR,
  breezy: fetchBreezyHR,
  jobvite: fetchJobvite,
  pinpointhq: fetchPinpoint,
  teamtailor: fetchTeamtailor,
  recruitee: fetchRecruitee,
  smartrecruiters: fetchSmartRecruiters,
  freshteam: fetchFreshteam,
  rippling: fetchRippling,
};

export const SUPPORTED_SWEEP_PROVIDERS: string[] = Object.keys(SWEEP_PROVIDER_ADAPTERS);

/**
 * Registry providers that deliberately have NO adapter. Empty today: every
 * registry ATS id the sweep supports resolves to a keyless endpoint. A future
 * provider without one must be listed here with a reason instead of getting a
 * fake adapter.
 */
export const SWEEP_NO_ADAPTER: Readonly<Record<string, string>> = {};

export interface CatalogueSweepOptions {
  boards: number;
  maxRows: number;
  /**
   * Optional provider filter (e.g. ['workable']). Empty/undefined sweeps every
   * supported provider. Filtered runs use their own cursor key so a targeted
   * proof pass cannot move the global scheduler cursor.
   */
  providers?: string[];
  /**
   * Batch mechanics, defaulted for the route. The cycle runner passes its own
   * per-batch values; the /jobs/sweep contract never exposes them.
   */
  concurrency?: number;
  perBoardTimeoutMs?: number;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

async function readAppSetting(key: string): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return typeof row?.value === 'string' ? row.value : '';
}

async function writeAppSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

/**
 * Cursor/cycle keys for a run. An unfiltered run keeps the global scheduler
 * keys; a provider-filtered run gets its own keys so targeted sweeps never
 * move (or wrap) the global cursor and never clear the scheduler's cycle-start
 * boundary.
 */
function sweepStateKeys(providers?: string[]): {
  cursor: string;
  cycle: string;
  cycleStartedAt: string;
} {
  if (!providers || providers.length === 0) {
    return {
      cursor: SWEEP_CURSOR_KEY,
      cycle: SWEEP_CYCLE_KEY,
      cycleStartedAt: SWEEP_CYCLE_STARTED_AT_KEY,
    };
  }
  const scope = [...providers].sort().join('+');
  return {
    cursor: `${SWEEP_CURSOR_KEY}:${scope}`,
    cycle: `${SWEEP_CYCLE_KEY}:${scope}`,
    cycleStartedAt: `${SWEEP_CYCLE_STARTED_AT_KEY}:${scope}`,
  };
}

/**
 * Persist the sweep continuation cursor. A short batch (`exhausted`) wraps the
 * cursor to the beginning so the next batch starts a new cycle and bumps
 * `deepSweep:cycle` for observability. Writes are sequential so a crash cannot
 * leave the cycle bumped with the old cursor still in place.
 */
async function persistSweepCursor(
  result: SweepResult,
  keys: { cursor: string; cycle: string } = {
    cursor: SWEEP_CURSOR_KEY,
    cycle: SWEEP_CYCLE_KEY,
  },
): Promise<void> {
  if (!result.exhausted) {
    await writeAppSetting(keys.cursor, result.nextCursor);
    return;
  }
  const cycleRaw = await readAppSetting(keys.cycle);
  const parsed = Number.parseInt(cycleRaw, 10);
  const cycle = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  await writeAppSetting(keys.cursor, '');
  await writeAppSetting(keys.cycle, String(cycle + 1));
}

/**
 * The registry read predicate for a sweep batch. One definition, shared by the
 * batch reader and the dry-run "boards due" count, so a preflight can never
 * disagree with what a real cycle would visit.
 *
 * Registry hygiene at the read side: inactive rows and rows whose backoff has
 * not elapsed never enter a sweep batch. The index from wave 2
 * ([isActive, tier, nextCheckAt]) serves this predicate.
 */
function sweepDueWhere(after: string, providers?: string[]): Prisma.CompanyCareerPageWhereInput {
  const dueNow = new Date();
  return {
    isActive: true,
    boardToken: { not: null },
    provider: {
      in: providers && providers.length > 0 ? providers : SUPPORTED_SWEEP_PROVIDERS,
    },
    id: { gt: after },
    OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: dueNow } }],
  };
}

function normalizeSweepProviders(providers?: string[]): string[] | undefined {
  return Array.isArray(providers) && providers.length > 0 ? [...new Set(providers)] : undefined;
}

/**
 * Run ONE sweep batch at an explicit cursor (no AppSetting read/write). The
 * single-batch route and the cycle runner both build on this, so the registry
 * predicate, the adapter map and the persist path cannot drift apart.
 */
async function sweepBatchAtCursor(
  cursor: string,
  options: CatalogueSweepOptions,
  providers?: string[],
): Promise<SweepResult> {
  return sweepBoards(
    {
      pages: async ({ cursor: after, take, providers: filter }) => {
        const rows = await prisma.companyCareerPage.findMany({
          where: sweepDueWhere(after, filter),
          orderBy: { id: 'asc' },
          take,
          select: {
            id: true,
            provider: true,
            boardToken: true,
            company: { select: { name: true } },
          },
        });
        const pages: SweepPage[] = [];
        for (const row of rows) {
          if (typeof row.provider !== 'string' || row.provider.length === 0) continue;
          if (typeof row.boardToken !== 'string' || row.boardToken.length === 0) continue;
          const companyName =
            typeof row.company?.name === 'string' ? row.company.name.trim() : '';
          pages.push({
            id: row.id,
            provider: row.provider,
            boardToken: row.boardToken,
            ...(companyName.length > 0 ? { companyName } : {}),
          });
        }
        return pages;
      },
      fetchBoard: async (provider, token, query) => {
        const adapter = SWEEP_PROVIDER_ADAPTERS[provider];
        if (!adapter) throw new Error(`unsupported sweep provider: ${provider}`);
        return adapter(token, query);
      },
      persist: async (rows) => (await upsertDiscoveredJobs(rows)).length,
      // Registry write-back: keep CompanyCareerPage honest so dead tokens back
      // off and eventually leave the keyset. The policy is pure
      // (applyPageResult); this closure only reads/writes the row.
      recordPageResult: async (
        pageId: string,
        pageResult: PageFetchResult,
      ): Promise<PageRecordOutcome> => {
        const page = await prisma.companyCareerPage.findUnique({
          where: { id: pageId },
          select: { failureCount: true, isActive: true, verifiedAt: true },
        });
        if (!page) return { deactivated: false, backedOff: false };
        const detail = applyPageResult(page, pageResult, new Date());
        await prisma.companyCareerPage.update({
          where: { id: pageId },
          data: detail.update,
        });
        return { deactivated: detail.deactivated, backedOff: detail.backedOff };
      },
    },
    {
      cursor,
      maxBoards: options.boards,
      concurrency: options.concurrency ?? SWEEP_CONCURRENCY,
      maxRows: options.maxRows,
      perBoardTimeoutMs: options.perBoardTimeoutMs ?? SWEEP_PER_BOARD_TIMEOUT_MS,
      providers,
    },
  );
}

/**
 * Run one Deep catalogue-sweep batch against the company registry.
 *
 * `pages` is the contract's keyset read (id asc, `id > cursor`), restricted to
 * active pages with a board token and a supported provider. `persist` is the
 * shared `upsertDiscoveredJobs`, so every sweep row gets its derived
 * `searchDocument` exactly like a title-search row.
 */
export async function runCatalogueSweep(options: CatalogueSweepOptions): Promise<SweepResult> {
  const providers = normalizeSweepProviders(options.providers);
  const keys = sweepStateKeys(providers);
  const cursor = await readAppSetting(keys.cursor);
  const result = await sweepBatchAtCursor(cursor, options, providers);
  await persistSweepCursor(result, keys);
  return result;
}

/**
 * How many boards an unfiltered cycle is due to visit right now - the dry-run
 * preflight used by scripts/sweep-all.ts and the Action. Read-only.
 */
export async function countDueSweepBoards(providers?: string[]): Promise<number> {
  return prisma.companyCareerPage.count({
    where: sweepDueWhere('', normalizeSweepProviders(providers)),
  });
}

/**
 * The production dependencies of the cycle runner (sweepCycle.ts).
 *
 * Everything the cycle needs that is boundary-specific lives here: the
 * AppSetting cursor/cycle/start keys, one real batch through the adapter map +
 * `upsertDiscoveredJobs`, the due-board count and the soft-close statement.
 * The cycle module itself imports no Prisma and no adapter.
 *
 * `providers` is the optional shard filter used by the weekly Action
 * (`scripts/sweep-all.ts --providers <p>`). A filtered cycle reads/writes its
 * OWN cursor/cycle/start keys and restricts the registry predicate, so a shard
 * cannot move the scheduler's global cursor.
 */
export function createSweepCycleDeps(providers?: string[]): SweepCycleDeps {
  const filter = normalizeSweepProviders(providers);
  const keys = sweepStateKeys(filter);
  return {
    readCursor: () => readAppSetting(keys.cursor),
    persistCursor: (result) =>
      persistSweepCursor(result, { cursor: keys.cursor, cycle: keys.cycle }),
    readCycleStartedAt: () => readAppSetting(keys.cycleStartedAt),
    writeCycleStartedAt: (value) => writeAppSetting(keys.cycleStartedAt, value),
    runBatch: (options) =>
      sweepBatchAtCursor(
        options.cursor,
        {
          boards: options.maxBoards,
          maxRows: options.maxRows,
          concurrency: options.concurrency,
          perBoardTimeoutMs: options.perBoardTimeoutMs,
        },
        filter,
      ),
    countDueBoards: () => countDueSweepBoards(filter),
    // The soft-close itself is `closeStalePostings` (sweepCycle.ts); this only
    // hands it the two JobListing statements it needs.
    closeStale: (filter) =>
      closeStalePostings(
        {
          jobListing: {
            count: ({ where }) => prisma.jobListing.count({ where }),
            updateMany: ({ where, data }) => prisma.jobListing.updateMany({ where, data }),
          },
        },
        filter,
      ),
    refreshFacetCache: async () => {
      await refreshCatalogueFacets(prisma);
    },
  };
}

function parseSweepLimit(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const floored = Math.floor(raw);
  return floored >= 1 ? floored : null;
}

/**
 * Parse the optional `providers` sweep filter. Undefined means "all"; an empty
 * array is treated the same way. Anything else must be a non-empty array of
 * supported provider ids (unknown ids are a 400, never a silent no-op).
 */
function parseSweepProviders(raw: unknown): string[] | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) return null;
    if (!SUPPORTED_SWEEP_PROVIDERS.includes(value)) return null;
    if (!out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

// ==================== SEARCH JOBS (user boards + filters) ====================
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    // ADR-021 decision 6: location is parsed first (repeated /
    // comma-joined / JSON-array literal via parseLocationParam) and the
    // parsed array is validated by jobSearchSchema; company is validated as
    // an optional <=100-char string. A blank location parses to [] and is
    // passed as undefined so it means no filtering (unchanged behaviour).
    const parsedLocations = parseLocationParam(req.query.location);
    const rawCompany = req.query.company ? String(req.query.company) : undefined;
    const { q, limit, sources, postedWithin, runId, location, company } = validateInput(jobSearchSchema, {
      q: req.query.q,
      limit: req.query.limit ? Number(req.query.limit) : 30,
      sources: req.query.sources ? String(req.query.sources).split(',').filter(Boolean) : undefined,
      postedWithin: typeof req.query.postedWithin === 'string' ? req.query.postedWithin : undefined,
      runId: typeof req.query.runId === 'string' ? req.query.runId : undefined,
      location: parsedLocations.length > 0 ? parsedLocations : undefined,
      company: rawCompany,
    });
    const locations = location ?? [];
    const sourceTypes = sources;
    // ADR-033 (T886): the requested mode is read ONCE, before the run
    // snapshot is seeded, because two things downstream are mode-scoped -
    // the snapshot TTL and the company-scope resolver. `getOptionalMode` is
    // a pure read of `req.query.mode`, so hoisting it changes nothing for a
    // no-mode request.
    const mode = getOptionalMode(req);

    // Lazy-seed defaults here too (GET /boards is not always visited first);
    // without this a fresh user searches zero boards and always gets [].
    try {
      await seedDefaultBoardsForUser(req.user!.id);
    } catch {
      // Seeding is best-effort; the search still runs against existing boards.
    }

    // Build source configs from the user's configured boards (per-user, no hardcoded defaults)
    // D4 (country wiring decision): the board's aggregatorLocation governs the
    // Adzuna country EXCEPT when the board carries no explicit location (blank
    // or the seeded 'us' default) and the search carries a location chip - then
    // the first chip is forwarded so Adzuna queries the user's country instead
    // of US rows that the chip post-filter below would drop to []. Explicit
    // board locations (e.g. 'in:Bengaluru') keep governing.
    const boards = await prisma.jobBoard.findMany({ where: { userId: req.user!.id, isActive: true } });
    const searchLocation = locations.length > 0 ? locations[0] : undefined;
    const configs: JobSourceConfig[] = boards.map((b) => ({
      ...boardToConfig(b),
      query: q,
      userId: req.user!.id,
      ...(b.type === 'aggregator' &&
      (!b.aggregatorLocation || b.aggregatorLocation.trim().toLowerCase() === 'us') &&
      searchLocation
        ? { aggregatorLocation: searchLocation }
        : {}),
      // ADR-021 decision 4 (scraper mirror of the D4 aggregator rule): a
      // scraper board with no explicit scraperLocation receives the first
      // search location chip. An explicit board location is never overridden.
      ...(b.type === 'scraper' &&
      (!b.scraperLocation || b.scraperLocation.trim().length === 0) &&
      searchLocation
        ? { scraperLocation: searchLocation }
        : {}),
    }));

    if (runId) {
      safeRegistry(() => beginRun(
        runId,
        req.user!.id,
        boards.map((b) => ({ id: b.id, name: b.name, type: b.type })),
        // ADR-033 (T886): Deep Scan runs for up to 10 minutes
        // (DEEP_BUDGET.totalBudgetMs), which outlives the 5-minute
        // RUN_TTL_MS - without a mode-scoped TTL the progress snapshot would
        // expire mid-run and the run would look "gone" while it is still
        // running (losing the cancel handle with it). fast/standard pass
        // `undefined`, so `beginRun`'s own RUN_TTL_MS default applies
        // unchanged (the same convention saved-searches.ts / job-alerts.ts
        // use for a deep intent).
        mode === 'deep' ? DEEP_RUN_TTL_MS : undefined,
      ));
      // Persist the mode actually resolved by the route (unknown/omitted
      // values are Fast). This is an additive writer so beginRun's existing
      // signature and legacy snapshot shape stay unchanged.
      safeRegistry(() => setRunMode(runId, mode ?? 'fast'));
    }

    // Wave 7 (T744, ADR-027): the per-board fan-out below used to be an
    // unbounded `Promise.all` here; it now runs through the orchestrator
    // (bounded pool, tier ordering, cooperative cancel). Boards, configs,
    // marks, health, filters, ordering, upsert and the response shape are
    // unchanged - only the fan-out path moved. `mode`/`evaluate` ride from
    // the query into the intent (absent/unknown means fast+deterministic,
    // the legacy default; `mode=full` degrades to fast - it is
    // route-exclusive); the response shape is untouched.
    const intent = intentForLegacySearch({ q, sources: sourceTypes, locations, company, limit: limit ?? 30, postedWithin, mode, evaluate: getOptionalEvaluate(req) });
    const outcome = await runSearch(
      intent,
      { runId: runId ?? `anon-${randomUUID()}`, userId: req.user!.id },
      {
        listUserBoards: async (): Promise<UserBoardRef[]> =>
          boards.map((b, i) => ({ boardId: b.id, name: b.name, type: b.type, config: configs[i] })),
        // ADR-033 (T886): standard/deep OMIT the resolver so the
        // orchestrator's default registry-backed resolver applies (Standard's
        // registryCap=0 short-circuits it with an explicit skip). fast and
        // every no-mode request keep `boardsOnlyCompanyScope` byte-identically
        // - the legacy `company` post-filter, zero registry reads.
        ...(usesRegistryCompanyScope(mode) ? {} : { resolveCompanies: boardsOnlyCompanyScope }),
        executeUnit: legacyBoardExecutor(runId, q, req.user!.id),
      },
    );

    const results = filterAndOrder(dedupeJobs(outcome.jobs)
      .filter((job) => !company || (job.company || '').toLowerCase().includes(company.toLowerCase()))
      .filter((job) => !sourceTypes || (sourceTypes as string[]).includes(job.source)), q, postedWithin);

    // Location/company/source filters all run BEFORE the limit slice (mirroring
    // the scan ordering intent: order -> filter -> slice -> upsert). Slicing
    // first and filtering after returned thin results whenever the location
    // chip removed rows from the already-capped page.
    // Mirrors matchesLocation() in src/features/jobs/jobSearchUtils.ts - keep the two in step.
    const locationFiltered = locations.length > 0
      ? results.filter((job) => {
        const jobLocation = (job.location || '').toLowerCase();
        return locations.some((needle) => jobLocation.includes(needle.toLowerCase()));
      })
      : results;

    const upserted = await upsertDiscoveredJobs(locationFiltered.slice(0, limit));

    // Best-effort LLM markdown normalization of freshly discovered rows.
    // Fire-and-forget: the search response never waits for it.
    scheduleAutoNormalization(req.user!.id, upserted);

    // Wave 11 (T820) cancel retention (N16): a cancelled run resolves with
    // the partial set collected so far - it is deduped, filtered, ordered
    // and upserted EXACTLY like a completed run, and the response carries
    // the additive `cancelled: true` / `partial: true` flags (threaded from
    // `outcome.cancelled`, so the flags survive snapshot expiry).
    // NO ROLLBACK: cancel never deletes or rolls back an already-persisted
    // listing. There is no delete of any kind on the listing models
    // anywhere on this path - the upserted rows below stay
    // queryable after a cancel, which is the durability backstop.
    if (runId && outcome.cancelled) safeRegistry(() => markCancelled(runId));
    if (runId) safeRegistry(() => finishRun(runId, upserted.length));

    // Wave 9 (T783) - evaluation summary, recorded AFTER persistence so any
    // evaluation attaches to stored rows (order: scope -> collect -> dedupe
    // -> filter/order -> persist -> evaluate). The orchestrator already ran
    // the pipeline per the intent's `evaluate` option (a legacy search
    // without mode/evaluate params is fast + deterministic: zero AI calls,
    // zero estimate); this only
    // publishes that outcome's summary onto the run snapshot, additively.
    // SAME-REQUEST MODEL: the estimate and the pass live in the same
    // request - wave 11 owns the confirm gate.
    if (runId && outcome.evaluation !== undefined) {
      const summary = outcome.evaluation;
      safeRegistry(() => setRunEvaluation(runId, summary));
    }

    // Deep-only catalogue sweep: the title-search phase above is complete and
    // the response below is the unchanged title-search array. The sweep's only
    // effect on THIS request is that its postings are now in the catalogue (and
    // a compact summary rides on the run snapshot). A sweep failure must never
    // fail the search - it is recorded as `error` on the snapshot and swallowed.
    if (mode === 'deep') {
      // The sweep can outlive the deep budget; refresh the snapshot TTL so a
      // late summary is not written into an expired (invisible) entry.
      if (runId) safeRegistry(() => touchRun(runId, DEEP_RUN_TTL_MS));
      const sweepLimits: CatalogueSweepOptions = {
        boards: envPositiveInt('DEEP_SWEEP_BOARDS', DEFAULT_SWEEP_BOARDS),
        maxRows: envPositiveInt('DEEP_SWEEP_MAX_ROWS', DEFAULT_SWEEP_MAX_ROWS),
      };
      try {
        const sweep = await runCatalogueSweep(sweepLimits);
        if (runId) {
          safeRegistry(() => setRunSweep(runId, {
            boards: sweep.boards,
            ok: sweep.ok,
            failed: sweep.failed,
            rowsFetched: sweep.rowsFetched,
            rowsPersisted: sweep.rowsPersisted,
            exhausted: sweep.exhausted,
          }));
        }
      } catch (error) {
        if (runId) {
          safeRegistry(() => setRunSweep(runId, {
            boards: 0,
            ok: 0,
            failed: 0,
            rowsFetched: 0,
            rowsPersisted: 0,
            exhausted: false,
            error: registryErrorMessage(error),
          }));
        }
      }
    }

    res.json(upserted.map((j) => shapeSearchResponse(j, runId, req.user!.id, outcome.cancelled)));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== SCAN ALL MY BOARDS (optionally filtered) ====================
router.get('/scan', requireAuth, async (req: Request, res: Response) => {
  try {
    const query = req.query.query ? String(req.query.query) : '';
    const boardIds = req.query.boardIds ? String(req.query.boardIds).split(',').filter(Boolean) : undefined;
    const runId = getOptionalRunId(req);
    const postedWithin = getOptionalPostedWithin(req);

    // Same lazy-seed as /search so a fresh user's first scan is not empty.
    try {
      await seedDefaultBoardsForUser(req.user!.id);
    } catch {
      // Seeding is best-effort; the scan still runs against existing boards.
    }

    const boards = await prisma.jobBoard.findMany({
      where: { userId: req.user!.id, isActive: true, ...(boardIds ? { id: { in: boardIds } } : {}) },
    });
    const configs: JobSourceConfig[] = boards.map((b) => ({
      ...boardToConfig(b),
      query,
      userId: req.user!.id,
    }));
    // ADR-033 (T886): /scan gains the shared four-value vocabulary
    // (`standard`/`deep` forward; `full` degrades to fast, it is
    // route-exclusive). Read once, before the snapshot is seeded, because the
    // snapshot TTL is mode-scoped.
    const mode = getOptionalMode(req);
    if (runId) {
      safeRegistry(() => beginRun(
        runId,
        req.user!.id,
        boards.map((b) => ({ id: b.id, name: b.name, type: b.type })),
        // Same mode-scoped TTL as /search above (T886): deep keeps its
        // snapshot for DEEP_RUN_TTL_MS, fast/standard fall through to
        // beginRun's own RUN_TTL_MS default.
        mode === 'deep' ? DEEP_RUN_TTL_MS : undefined,
      ));
      // Same resolved-mode contract as /search: omitted/unknown is Fast,
      // while Standard and Deep retain their actual route-selected mode.
      safeRegistry(() => setRunMode(runId, mode ?? 'fast'));
    }
    // Wave 7 (T744, ADR-027): same orchestrated fan-out as /search above.
    // Configs stay unmirrored (as before - /scan never applied the D4/ADR-021
    // location mirroring); the limit slice below keeps its legacy
    // `Number(req.query.limit) || 100` expression verbatim. `mode`/`evaluate`
    // ride from the query into the intent (absent/unknown means
    // fast+deterministic, the legacy default).
    const scanIntent = intentForLegacySearch({
      q: query,
      sources: undefined,
      locations: [],
      company: undefined,
      limit: Number(req.query.limit) || 100,
      postedWithin,
      mode,
      evaluate: getOptionalEvaluate(req),
    });
    const scanOutcome = await runSearch(
      scanIntent,
      { runId: runId ?? `anon-${randomUUID()}`, userId: req.user!.id },
      {
        listUserBoards: async (): Promise<UserBoardRef[]> =>
          boards.map((b, i) => ({ boardId: b.id, name: b.name, type: b.type, config: configs[i] })),
        // /scan carries no company filter at all (`company: undefined` in
        // the intent above), so its scope stays boards-only for every mode -
        // exactly as before T886. Only the vocabulary widens here; the
        // Standard envelope and the deeper budgets then apply through the
        // orchestrator.
        resolveCompanies: boardsOnlyCompanyScope,
        executeUnit: legacyBoardExecutor(runId, query, req.user!.id),
      },
    );
    const results = filterAndOrder(dedupeJobs(scanOutcome.jobs), query, postedWithin);

    const upserted = await upsertDiscoveredJobs(results.slice(0, Number(req.query.limit) || 100));

    // Best-effort LLM markdown normalization of freshly discovered rows.
    // Fire-and-forget: the scan response never waits for it.
    scheduleAutoNormalization(req.user!.id, upserted);

    // Wave 11 (T820) cancel retention (N16): same partial-set contract as
    // /search above - a cancelled scan resolves with the rows collected so
    // far, upserted like a completed run, flagged via `scanOutcome`.
    // NO ROLLBACK: no delete of any kind on the listing models anywhere on
    // this path; persisted rows stay queryable after a cancel.
    if (runId && scanOutcome.cancelled) safeRegistry(() => markCancelled(runId));
    if (runId) safeRegistry(() => finishRun(runId, upserted.length));

    // Wave 9 (T783) - same post-persist evaluation summary as /search above:
    // the orchestrator ran the pipeline per the intent's `evaluate` option
    // (a scan without mode/evaluate params is fast + deterministic: zero AI
    // calls); publish the
    // summary onto the snapshot additively, never failing the response.
    if (runId && scanOutcome.evaluation !== undefined) {
      const summary = scanOutcome.evaluation;
      safeRegistry(() => setRunEvaluation(runId, summary));
    }

    res.json(upserted.map((j) => shapeSearchResponse(j, runId ?? undefined, req.user!.id, scanOutcome.cancelled)));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== FULL-SCAN (client-driven registry batches) ====================
// Registered immediately after /scan and before /runs/:runId (and therefore
// before the catch-all /:id) so the literal route can never be shadowed.
router.get('/full-scan', requireAuth, fullScanHandler);

// ==================== EVALUATION WIRE SHAPE - NO DERIVED SCORE ====================
//
// T1101's acceptance - "no UI or API response exposes a single score/grade/percentage for resume
// quality" - covers TWO routes, not one. `POST /:id/evaluate` used to return `overallScore` plus a
// `scores` object holding six more, and `GET /evaluations` returned the raw `JobEvaluation` rows,
// which carry every score COLUMN on the model. Both are projected through `toEvaluationWire` below,
// and the projection is the only way either route builds a body, so a handler cannot assemble one by
// hand and forget it. This is the same shape-discipline `routes/ats.ts` already uses (`toWire` +
// `AtsScanResponse`), and it closes runbook sec. 9 gap 3.
//
// WHAT DID NOT CHANGE. `evaluateJob` still produces the six 1-5 dimensions and the weighted
// `overallScore`, and `JobEvaluation` still STORES all seven columns: they are the evaluator's
// internal signal (FREEZE B-16), the upstream prompt derives `isScam`/`recommendation` from them,
// and no row is deleted or rewritten. Only the WIRE changed. `routes/jobs.evaluate.noScore.test.ts`
// asserts both halves - the body has no number in it, and the write still carried seven.
//
// WHY `reportJson` IS PROJECTED TOO. `reportJson` is the evaluator's whole parsed JSON object, so it
// carries the SAME seven numbers one level deeper; dropping only the top-level pair would leave the
// identical verdict on the wire under a different key. `withoutNumbers` drops every NUMBER in the
// subtree and keeps the prose - `interviewPrepBullets`, `redFlags`, `compNotes`, `keySkills`,
// `skillGaps`, `evaluationResults` - which is the same reasoning and the same blunt mechanism
// `routes/ats.ts` applies to `evaluationJson`. It is duplicated rather than imported because
// `ats.ts` is FREEZE K-02 and a route-to-route import out of a frozen file is a coupling, not a
// shared utility.
//
// EXPORTED so `routes/jobs.evaluate.noScore.test.ts` can assert the members BY NAME rather than by
// re-typing the object, and so a future response cannot quietly grow a number back without the type
// changing. There is deliberately no `overallScore`, no `scores`, and no per-dimension member.
export interface JobEvaluationWire {
  id: string;
  recommendation: string | null;
  /** A yes/no fact about the listing. */
  isScam: boolean;
  roleSummary: string | null;
  /** The evaluator's prose, with every number removed (see `withoutNumbers`). */
  reportJson: unknown;
}

/** The members that identify WHICH evaluation this is. Not part of the verdict, so not part of
 *  `JobEvaluationWire` - `POST /:id/evaluate` has never returned them and its published shape is
 *  left exactly as narrow as it was; `GET /evaluations` is a LIST of rows and has always carried
 *  them, so it adds them back on top of the same verdict. */
interface JobEvaluationRowIdentity {
  userId?: string;
  jobListingId?: string;
  resumeId?: string | null;
  createdAt?: Date;
  jobListing?: { title: string; company: string; applyUrl?: string | null } | null;
}

/**
 * Drop every NUMBER from a subtree, recursively.
 *
 * Identical in behaviour to `withoutNumbers` in `routes/ats.ts`, and for the same stated reason:
 * a member list nobody remembers to extend is not a guard. The evaluator's JSON has exactly two
 * kinds of leaf - NAMES (a role summary, an interview-prep prompt, a red flag, a named skill) and
 * NUMBERS (a 1-5 dimension, a weighted total, a percentage breakdown). Only the numbers are
 * verdicts, so only the numbers go.
 */
function withoutNumbers(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutNumbers);
  if (node && typeof node === 'object') {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'number') continue;
      kept[key] = withoutNumbers(value);
    }
    return kept;
  }
  return node;
}

/** The shape both routes build the body from. Exported so the test asserts it by NAME. */
export function toEvaluationVerdict(row: {
  id: string;
  recommendation?: string | null;
  isScam: boolean;
  roleSummary?: string | null;
  reportJson?: unknown;
}): JobEvaluationWire {
  return {
    id: row.id,
    recommendation: row.recommendation ?? null,
    isScam: row.isScam,
    roleSummary: row.roleSummary ?? null,
    reportJson: withoutNumbers(row.reportJson ?? null),
  };
}

/** The list shape: the same verdict, plus the row's own identifying members. */
export function toEvaluationWire(row: {
  id: string;
  userId?: string;
  jobListingId?: string;
  resumeId?: string | null;
  recommendation?: string | null;
  isScam: boolean;
  roleSummary?: string | null;
  reportJson?: unknown;
  createdAt?: Date;
  jobListing?: { title: string; company: string; applyUrl?: string | null } | null;
}): JobEvaluationWire & JobEvaluationRowIdentity {
  return {
    ...toEvaluationVerdict(row),
    ...(row.userId !== undefined ? { userId: row.userId } : {}),
    ...(row.jobListingId !== undefined ? { jobListingId: row.jobListingId } : {}),
    ...(row.resumeId != null ? { resumeId: row.resumeId } : {}),
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    ...(row.jobListing !== undefined ? { jobListing: row.jobListing } : {}),
  };
}

// ==================== LIST EVALUATIONS ====================
router.get('/evaluations', requireAuth, async (req: Request, res: Response) => {
  try {
    // The SELECT stops at the measured facts: `overallScore` and the six `*Score` columns are not
    // even READ off the row, which is what `routes/ats.ts` does for `GET /ats/reports/:id`.
    const evals = await prisma.jobEvaluation.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        userId: true,
        jobListingId: true,
        resumeId: true,
        recommendation: true,
        isScam: true,
        roleSummary: true,
        reportJson: true,
        createdAt: true,
        jobListing: { select: { title: true, company: true, applyUrl: true } },
      },
    });
    res.json(evals.map(toEvaluationWire));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== LOCATION SUGGESTIONS ====================
// Registered before /:id so Express does not match /locations as a listing id.
router.get('/locations', requireAuth, async (req: Request, res: Response) => {
  try {
    const { q, limit } = validateInput(jobLocationsQuerySchema, {
      q: req.query.q ? String(req.query.q) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    const rows = await prisma.jobListing.groupBy({
      by: ['location'],
      where: { location: q ? { contains: q, mode: 'insensitive' } : { not: null } },
      _count: { _all: true },
      orderBy: { _count: { location: 'desc' } },
      take: limit,
    });
    // The DB orders by count only; the count desc, value asc tiebreak runs here in JS
    // over the already-capped rows (at most 50) since multi-key groupBy orderBy is
    // version-dependent. Blank values are stripped after the query, so the response may
    // contain fewer than limit entries - an empty-string value is never returned.
    const locations = rows
      .map((r) => ({ value: (r.location ?? '').trim(), count: r._count._all }))
      .filter((r) => r.value.length > 0)
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    res.json({ locations });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== DISCOVERY RUN SNAPSHOT ====================
// Registered before /:id with the other static routes so ordering stays obvious
// ('/runs/:runId' has two segments and cannot shadow '/:id' regardless).
router.get('/runs/:runId', requireAuth, (req: Request, res: Response) => {
  const snapshot = getRun(req.params.runId, req.user!.id);
  if (!snapshot) return res.status(404).json({ error: 'Discovery run not found or expired' });
  res.json(snapshot);
});

// ==================== CANCEL DISCOVERY RUN ====================
// POST /jobs/runs/:runId/cancel (Wave 7, T743; retention Wave 11, T820):
// auth-scoped, IDEMPOTENT.
// Ownership is proven FIRST via getRun: another user's run (or an unknown /
// expired run) is the same 404 as GET /runs/:runId and is never touched, so
// markCancelled's run-only scope cannot cross user boundaries. A live run
// flips the orchestrator flag (in-flight units observe it) and the snapshot
// is marked cancelled; a repeat call (or a cancel of an already-finished run)
// is a no-op returning the current snapshot unchanged.
// RETENTION (T820, N16): this endpoint only flips flags - it never deletes
// or rolls back listings. The in-flight search request itself resolves with
// the partial set (flagged `cancelled: true` / `partial: true`), and every
// row already persisted by `upsertDiscoveredJobs` stays queryable.
router.post('/runs/:runId/cancel', requireAuth, (req: Request, res: Response) => {
  const runId = req.params.runId;
  const userId = req.user!.id;
  const owned = getRun(runId, userId);
  if (!owned) return res.status(404).json({ error: 'Discovery run not found or expired' });
  safeRegistry(() => {
    cancelRun(runId, userId);
  });
  safeRegistry(() => {
    markCancelled(runId);
  });
  const snapshot = getRun(runId, userId);
  if (!snapshot) return res.status(404).json({ error: 'Discovery run not found or expired' });
  res.json(snapshot);
});

// ==================== DEEP CATALOGUE SWEEP (manual / Action entry) ====================
// POST /jobs/sweep { boards?, maxRows? } -> SweepResult. This is the entry
// point the future GitHub Action will call. Auth-scoped like every other jobs
// route. Mounted before the `/:id` routes below (order matters).
router.post('/sweep', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const boards = parseSweepLimit(body.boards, DEFAULT_SWEEP_BOARDS);
    const maxRows = parseSweepLimit(body.maxRows, DEFAULT_SWEEP_MAX_ROWS);
    if (boards === null) throw new HttpError(400, 'boards must be a positive number');
    if (maxRows === null) throw new HttpError(400, 'maxRows must be a positive number');
    const providers = parseSweepProviders(body.providers);
    if (providers === null) {
      throw new HttpError(
        400,
        `providers must be an array of supported providers (${SUPPORTED_SWEEP_PROVIDERS.join(', ')})`,
      );
    }
    const result = await runCatalogueSweep({ boards, maxRows, providers });
    res.json(result);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET LISTING ====================
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const listing = await prisma.jobListing.findUnique({ where: { id: req.params.id } });
    if (!listing) throw new NotFoundError('Job Listing');
    // ADR-020 decision 8: `format=md` exposes the stored normalized markdown.
    // The default shape is byte-identical to before (AC11). This read path
    // never calls the LLM: with stored markdown it returns 200 even when no
    // key exists; without stored markdown and without a key it is an
    // actionable 409 (llm_key_missing), otherwise 200 with null markdown.
    if (req.query.format === 'md') {
      if (!listing.descriptionMd || !listing.descriptionMdHash) {
        const provider = await peekNormalizeLlmProvider(req.user!.id);
        if (!provider) {
          res.status(409).json({
            error: 'No LLM key configured. Add an LLM provider key in Settings (BYOK) to format descriptions.',
            code: 'llm_key_missing',
          });
          return;
        }
      }
      res.json({ ...listing, descriptionMd: listing.descriptionMd ?? null, descriptionMdHash: listing.descriptionMdHash ?? null });
      return;
    }
    res.json(listing);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== NORMALIZE ERROR MAPPING ====================
// Distinct actionable errors for POST /:id/normalize and POST /normalize,
// mirroring the mapEvaluateErrorToResponse style above. Only fixed strings
// are ever returned or logged - never the prompt body, the key, or raw
// provider payloads.
export interface NormalizeErrorResponse {
  status: number;
  body: { error: string; code: string };
}

// Carries an already-mapped actionable failure through the normalize helpers
// so the single route can render { error, code } and the batch route can
// record the per-item errorCode. Extends HttpError so unexpected paths still
// flow through handleApiError with the right status.
export class NormalizeRequestError extends HttpError {
  code: string;

  constructor(statusCode: number, message: string, code: string) {
    super(statusCode, message);
    this.name = 'NormalizeRequestError';
    this.code = code;
  }
}

// Maps known normalizeJobDescription failures to an actionable status/code.
// Returns null for unknown errors so the caller rethrows them to handleApiError.
export function mapNormalizeErrorToResponse(error: unknown): NormalizeErrorResponse | null {
  const message = error instanceof Error ? error.message : String(error);
  if (MISSING_LLM_KEY_PATTERN.test(message)) {
    return {
      status: 409,
      body: {
        error: 'No LLM key configured. Add an LLM provider key in Settings (BYOK) to format descriptions.',
        code: 'llm_key_missing',
      },
    };
  }
  // isRateLimitError covers status/code/message shapes from providers; the
  // bare-429 fallback covers raw bodies that only carry the status digits.
  if (isRateLimitError(error) || RATE_LIMIT_STATUS_PATTERN.test(message)) {
    return {
      status: 429,
      body: {
        error: 'The LLM provider rate-limited this normalization. Try again shortly.',
        code: 'rate_limited',
      },
    };
  }
  if (error instanceof NormalizationError) {
    return {
      status: 502,
      body: {
        error: 'The AI response could not be parsed as a normalized description. The original text was kept.',
        code: 'normalization_failed',
      },
    };
  }
  return null;
}

// ==================== NORMALIZE HELPERS ====================

// Read-only provider probe for the normalize cache check. Mirrors the
// leaseNextLlmKey provider order (DB keys per provider, then env fallback)
// WITHOUT leasing: leasing touches lastUsedAt, so a cache hit must not
// lease. Returns the provider id whose model governs the content hash, or
// null when no LLM key exists anywhere.
async function peekNormalizeLlmProvider(userId: string | undefined): Promise<string | null> {
  let dbProviders: Set<string> = new Set();
  try {
    const where: Prisma.AIProviderKeyWhereInput = {
      provider: { in: [...LLM_PROVIDER_IDS] },
      isActive: true,
    };
    if (userId) {
      where.OR = [{ userId }, { userId: null }];
    }
    const rows = await prisma.aIProviderKey.findMany({
      where,
      select: { provider: true },
    });
    dbProviders = new Set(rows.map((row) => String(row.provider).toLowerCase()));
  } catch {
    // DB unreadable - fall through to env keys only.
  }
  for (const candidate of LLM_PROVIDER_IDS) {
    if (dbProviders.has(candidate.toLowerCase())) return candidate;
    const upper = candidate.toUpperCase();
    if (process.env[`${upper}_API_KEY`]) return candidate;
    for (let index = 1; index <= 20; index += 1) {
      if (process.env[`${upper}_API_KEY_${index}`]) return candidate;
    }
  }
  return null;
}

export interface NormalizeOutcome {
  markdown: string;
  title: string | null;
  company: string | null;
  location: string | null;
  sections: NormalizedDescription['sections'];
  cached: boolean;
  model: string;
  provider: string;
}

// Single-listing normalize with hash caching. Throws NotFoundError for an
// unknown (or vanished) listing, NormalizeRequestError for actionable
// failures (no_description / llm_key_missing / rate_limited /
// normalization_failed), and rethrows anything else. A cache hit performs no
// LLM call; a hit or a no-key probe performs no key lease write.
async function normalizeListingOrThrow(userId: string | undefined, id: string): Promise<NormalizeOutcome> {
  const listing = await prisma.jobListing.findUnique({ where: { id } });
  if (!listing) throw new NotFoundError('Job Listing');

  const raw = typeof listing.description === 'string' ? listing.description : '';
  if (raw.length < 50) {
    throw new NormalizeRequestError(
      400,
      'This listing has no usable description to normalize.',
      'no_description',
    );
  }
  const cleanText = cleanDescription(raw);
  if (!cleanText) {
    throw new NormalizeRequestError(
      400,
      'This listing has no usable description to normalize.',
      'no_description',
    );
  }

  const peekedProvider = await peekNormalizeLlmProvider(userId);
  if (!peekedProvider) {
    throw new NormalizeRequestError(
      409,
      'No LLM key configured. Add an LLM provider key in Settings (BYOK) to format descriptions.',
      'llm_key_missing',
    );
  }
  const model = await getProviderModel(peekedProvider, { envOverride: process.env.JD_MD_MODEL });
  const expectedHash = normalizationHash(cleanText, model);
  if (listing.descriptionMd && listing.descriptionMdHash === expectedHash) {
    return {
      markdown: listing.descriptionMd,
      title: listing.title ?? null,
      company: listing.company ?? null,
      location: listing.location ?? null,
      sections: {},
      cached: true,
      model,
      provider: peekedProvider,
    };
  }

  let result: NormalizedDescription;
  let actualModel = model;
  let actualProvider = peekedProvider;
  try {
    const normalized = await normalizeJobDescription(userId, raw);
    result = normalized.result;
    actualModel = normalized.model;
    actualProvider = normalized.provider;
  } catch (error) {
    const mapped = mapNormalizeErrorToResponse(error);
    if (mapped) {
      throw new NormalizeRequestError(mapped.status, mapped.body.error, mapped.body.code);
    }
    throw error; // unknown -> existing handleApiError behaviour
  }

  try {
    await prisma.jobListing.update({
      where: { id },
      data: {
        descriptionMd: result.markdown,
        descriptionMdHash: normalizationHash(cleanText, actualModel),
        descriptionMdAt: new Date(),
      },
    });
  } catch {
    // The listing vanished between the read and the write.
    throw new NotFoundError('Job Listing');
  }
  // Secrets hygiene: provider + model ids only, never prompt/key/payload.
  console.log(`[jobs] Normalized listing (provider=${actualProvider}, model=${actualModel}, cached=false).`);
  return {
    markdown: result.markdown,
    title: result.title,
    company: result.company,
    location: result.location,
    sections: result.sections,
    cached: false,
    model: actualModel,
    provider: actualProvider,
  };
}

// Bounded worker pool: at most `limit` invocations of fn run concurrently.
// Per-item failures are the caller's business (fn should catch); a throw
// here fails the whole pool, so batch items always use a catching fn.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface NormalizeBatchItemResult {
  id: string;
  ok: boolean;
  markdown?: string;
  cached?: boolean;
  errorCode?: string;
}

// ==================== AUTO-NORMALIZE ON DISCOVERY ====================
// Best-effort LLM markdown normalization for freshly discovered rows.
// Fire-and-forget from GET /search + /scan: the discovery response never
// waits for it, and a normalization failure never fails the response.
//
// Contract (no API shape changes):
// - Only rows lacking stored markdown are attempted, capped at
//   AUTO_NORMALIZE_MAX_ROWS per run, at AUTO_NORMALIZE_CONCURRENCY.
// - Skips entirely (one debug line max) when no LLM key is configured.
// - Per-row isolation: one failure is skipped silently; a bounded one-line
//   summary is logged at most once per run. No secrets are ever logged.
export const AUTO_NORMALIZE_MAX_ROWS = 20;
export const AUTO_NORMALIZE_CONCURRENCY = 2;

export interface AutoNormalizeSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  skippedNoKey: boolean;
}

// Core worker. Awaited only by tests and by the fire-and-forget wrapper's
// internal promise chain - never by the /search or /scan handlers.
export async function autoNormalizeDiscoveredListings(
  userId: string | undefined,
  listings: Array<{ id: string; descriptionMd?: string | null }>,
): Promise<AutoNormalizeSummary> {
  const idle: AutoNormalizeSummary = { attempted: 0, succeeded: 0, failed: 0, skippedNoKey: false };
  let ids: string[];
  try {
    ids = listings
      .filter((row) => row && typeof row.id === 'string' && row.id.length > 0 && !row.descriptionMd)
      .slice(0, AUTO_NORMALIZE_MAX_ROWS)
      .map((row) => row.id);
  } catch {
    return idle;
  }
  if (ids.length === 0) return idle;

  let provider: string | null;
  try {
    provider = await peekNormalizeLlmProvider(userId);
  } catch {
    provider = null;
  }
  if (!provider) {
    console.debug('[jobs] Auto-normalization skipped (no LLM key).');
    return { attempted: 0, succeeded: 0, failed: 0, skippedNoKey: true };
  }

  let succeeded = 0;
  let failed = 0;
  try {
    await mapWithConcurrency(ids, AUTO_NORMALIZE_CONCURRENCY, async (id): Promise<void> => {
      // Per-row isolation: any single failure is skipped silently.
      try {
        await normalizeListingOrThrow(userId, id);
        succeeded += 1;
      } catch {
        failed += 1;
      }
    });
  } catch {
    // The pool itself must never throw (fn always catches); guard anyway.
  }
  console.debug(`[jobs] Auto-normalization finished (ok=${succeeded}, failed=${failed}).`);
  return { attempted: ids.length, succeeded, failed, skippedNoKey: false };
}

// Fire-and-forget entry point for the discovery routes. Returns void and
// never rejects: background failures are contained in the summary above.
export function scheduleAutoNormalization(
  userId: string | undefined,
  listings: Array<{ id: string; descriptionMd?: string | null }>,
): void {
  try {
    const pending = autoNormalizeDiscoveredListings(userId, listings);
    void pending.then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // Scheduling must never fail a search/scan response.
  }
}

// ==================== BATCH NORMALIZE ====================
// Registered BEFORE POST /:id/normalize so Express never treats the literal
// "normalize" as an :id value.
router.post('/normalize', requireAuth, async (req: Request, res: Response) => {
  try {
    const { ids } = validateInput(normalizeBatchSchema, req.body);
    const results = await mapWithConcurrency(ids, 2, async (id): Promise<NormalizeBatchItemResult> => {
      // Per-item isolation: one bad job never fails the other 19.
      try {
        const outcome = await normalizeListingOrThrow(req.user!.id, id);
        return { id, ok: true, markdown: outcome.markdown, cached: outcome.cached };
      } catch (error) {
        if (error instanceof NormalizeRequestError) {
          return { id, ok: false, errorCode: error.code };
        }
        if (error instanceof NotFoundError) {
          return { id, ok: false, errorCode: 'not_found' };
        }
        // Never log the prompt body, the key, or raw provider payloads.
        console.warn(`[jobs] Batch normalize item failed (code=normalization_failed).`);
        return { id, ok: false, errorCode: 'normalization_failed' };
      }
    });
    res.json({ results });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== SINGLE NORMALIZE ====================
router.post('/:id/normalize', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = validateInput(normalizeJobSchema, { id: req.params.id });
    try {
      const outcome = await normalizeListingOrThrow(req.user!.id, id);
      res.json({
        markdown: outcome.markdown,
        title: outcome.title,
        company: outcome.company,
        location: outcome.location,
        sections: outcome.sections,
        cached: outcome.cached,
        model: outcome.model,
        provider: outcome.provider,
      });
    } catch (itemError) {
      if (itemError instanceof NormalizeRequestError) {
        res.status(itemError.statusCode).json({ error: itemError.message, code: itemError.code });
        return;
      }
      throw itemError; // unknown + NotFoundError -> handleApiError
    }
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== EVALUATE ERROR MAPPING ====================
// Distinct actionable errors for POST /:id/evaluate so the caller can explain
// itself instead of surfacing a generic 500 (handleApiError fallback).
export interface EvaluateErrorResponse {
  status: number;
  body: { error: string; code: string };
}

const MISSING_LLM_KEY_PATTERN = /no .*api keys? configured|add a key in settings|requires? a .*key/i;
const RATE_LIMIT_STATUS_PATTERN = /\b429\b/;

// A description shorter than 50 chars is not evaluable (mirrors the
// evaluateJobSchema minimum for supplied body values).
export function isUsableEvaluateDescription(description: unknown): boolean {
  return typeof description === 'string' && description.length >= 50;
}

// Maps known evaluateJob failures to an actionable status/code pair.
// Returns null for unknown errors so the caller rethrows them to handleApiError.
export function mapEvaluateErrorToResponse(error: unknown): EvaluateErrorResponse | null {
  const message = error instanceof Error ? error.message : String(error);
  if (MISSING_LLM_KEY_PATTERN.test(message)) {
    return {
      status: 409,
      body: {
        error: 'No LLM key configured. Add an LLM provider key in Settings (BYOK) to evaluate jobs.',
        code: 'llm_key_missing',
      },
    };
  }
  // isRateLimitError covers status/code/message shapes from providers; the
  // bare-429 fallback covers raw bodies that only carry the status digits.
  // No key material or provider raw bodies are echoed - only fixed strings.
  if (isRateLimitError(error) || RATE_LIMIT_STATUS_PATTERN.test(message)) {
    return {
      status: 429,
      body: {
        error: 'The LLM provider rate-limited this evaluation. Try again shortly.',
        code: 'rate_limited',
      },
    };
  }
  return null;
}

// ==================== EVALUATE LISTING ====================
router.post('/:id/evaluate', requireAuth, async (req: Request, res: Response) => {
  try {
    const { resumeId, jobDescription } = validateInput(evaluateJobSchema, { ...req.body, jobDescription: req.body.jobDescription || undefined });
    const listing = await prisma.jobListing.findUnique({ where: { id: req.params.id } });
    if (!listing) throw new NotFoundError('Job Listing');

    // When the caller supplies no description, fall back to the stored listing
    // text; a short/absent result is an actionable 400, not a validation dump.
    const descriptionText = jobDescription || listing.description;
    if (!isUsableEvaluateDescription(descriptionText)) {
      res.status(400).json({ error: 'This listing has no usable description to evaluate.', code: 'no_description' });
      return;
    }

    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
    if (!resume) throw new NotFoundError('Resume');
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    // Liveness check (zero-token) before spending eval tokens
    const alive = await checkLiveness(listing.applyUrl || listing.sourceUrl);
    if (!alive) {
      // checkLiveness returns true when the URL is missing, so a dead result
      // always means a real probe failed - but guard the write regardless.
      if (listing.applyUrl || listing.sourceUrl) {
        await prisma.jobListing.update({ where: { id: listing.id }, data: { isActive: false } });
      }
      res.status(409).json({ error: 'This job posting appears to be closed (dead link).', code: 'posting_closed' });
      return;
    }

    const hasTavily = !!(await prisma.aIProviderKey.findFirst({ where: { userId: req.user!.id, provider: 'tavily', isActive: true } }).catch(() => null));

    // Load the user's career profile (optional) to contextualize the evaluation
    const profile = await prisma.careerProfile.findUnique({ where: { userId: req.user!.id } });

    let result;
    try {
      result = await evaluateJob(req.user!.id, resume as any, descriptionText, {
        useTavily: hasTavily,
        companyName: listing.company,
        profile: profile ? {
          targetRoles: (profile.targetRoles as string[]) || [],
          seniority: profile.seniority || undefined,
          topSkills: (profile.topSkills as string[]) || [],
          industries: (profile.industries as string[]) || [],
          redFlags: (profile.redFlags as string[]) || [],
          proofPoints: (profile.proofPoints as string[]) || [],
          minSalary: profile.minSalary ?? undefined,
          maxSalary: profile.maxSalary ?? undefined,
          currency: profile.currency || undefined,
          locationPref: normalizeLocationPref(profile.locationPref).join(', ') || undefined,
          remoteOnly: profile.remoteOnly,
          summary: profile.summary || undefined,
        } : undefined,
      });
    } catch (e) {
      const mapped = mapEvaluateErrorToResponse(e);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw e; // unknown -> existing handleApiError behaviour
    }

    // T1101: the row still stores all seven numbers - the evaluator's internal signal (FREEZE B-16),
    // and the write is unchanged. Only the RESPONSE is projected, so the 201 body is the verdict, the
    // scam fact and the prose, and its key set is exactly what it was minus `overallScore`/`scores`.
    // See `toEvaluationVerdict`.
    const evaluation = await prisma.jobEvaluation.create({
      data: {
        userId: req.user!.id,
        jobListingId: listing.id,
        resumeId,
        roleSummary: result.roleSummary,
        cvMatchScore: result.cvMatchScore,
        levelFitScore: result.levelFitScore,
        compFitScore: result.compFitScore,
        personalizationScore: result.personalizationScore,
        interviewPrepScore: result.interviewPrepScore,
        legitimacyScore: result.legitimacyScore,
        overallScore: result.overallScore,
        recommendation: result.recommendation,
        isScam: result.isScam,
        reportJson: result.reportJson as any,
      },
    });

    res.status(201).json(toEvaluationVerdict(evaluation));
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
