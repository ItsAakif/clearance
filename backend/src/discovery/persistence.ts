// Wave 3 (T665, ADR-028/ADR-032): persistence mapping + API shaping for
// date provenance and multi-source dedupe.
//
// Provenance is computed upstream (fetchers set `postedAtSource`/`postedAtRaw`,
// `dedupe.ts` attaches `sources`/`canonicalKey`); this module makes both
// survive persistence and reach the client (spec SCOPE items 5-6).
//
// Rules enforced here:
// - `firstSeenAt` is stamped on CREATE only from an injected `now`. It is
//   NEVER part of an update payload (unlike `lastVerifiedAt`). The helpers
//   are pure: they read no clock (`new Date()` / `Date.now()` must only
//   appear in the impure route layer that supplies `now`).
// - `@@unique([source, externalId])` behaviour is unchanged; the new columns
//   are plain data writes.
// - Pre-migration rows (`postedAt` set, `postedAtSource` null) read as
//   `unknown` WITHOUT nulling the stored date (no data destruction) and
//   WITHOUT letting the row claim `source-posted`. The response keeps
//   `postedAt` verbatim; only the label falls back.
// - API changes are ADDITIVE: the nine pre-existing response keys are
//   byte-identical, `postedAtSource`/`dateLabel` are always present, and
//   `sources` is present only when a non-empty array is known.
// - T892: these two builders are the ONE choke point every discovered row
//   passes through before it reaches Prisma, so `postedAtRaw` is stringified
//   here (`coercePostedAtRaw`). An upstream non-string date (a JSON Int from
//   Lever's epoch `createdAt`) must not 500 a whole full-scan batch; the claim
//   itself is never dropped, only stringified. It does NOT swallow any other
//   validation error - this closes the one known type lie, not a general
//   batch-resilience hole.
//
// This module is pure: no DB, no Prisma runtime import (types only), no I/O,
// no clock. Zero new dependencies.

import type { Prisma } from '@prisma/client';
import type { RawJob } from '../jobSources/adapters/http.js';
import type { SourceRef } from './dedupe.js';
import {
  dateLabel,
  isPostedAtSource,
  type DateLabel,
  type PostedAtSource,
} from './provenance.js';

/**
 * A discovered row plus the additive wave-3 fields a deduped survivor may
 * carry. `DedupedJob` (discovery/dedupe.ts) is assignable to this; a plain
 * `RawJob` yields null extras (persisted as null, never fabricated).
 */
export interface PersistableJob extends RawJob {
  dateConfidence?: string | null;
  canonicalKey?: string | null;
  sources?: SourceRef[] | null;
}

// ---------------------------------------------------------------------------
// Upsert payloads (wave-3 columns only; existing field lists stay inline at
// each call site so the description guard and other per-site logic stay
// obvious).
// ---------------------------------------------------------------------------

export type JobListingProvenanceCreate = Pick<
  Prisma.JobListingCreateInput,
  'postedAtSource' | 'postedAtRaw' | 'firstSeenAt' | 'dateConfidence' | 'canonicalKey'
>;

export type JobListingProvenanceUpdate = Pick<
  Prisma.JobListingUpdateInput,
  'postedAtSource' | 'postedAtRaw' | 'dateConfidence' | 'canonicalKey'
>;

/**
 * Coerce one upstream date claim to the `String | null` shape the
 * `JobListing.postedAtRaw` column accepts. T892 (live 2026-09-25): a full-scan
 * batch 500'd with
 * `PrismaClientValidationError: Argument 'postedAtRaw': Invalid value
 * provided. Expected String or Null, provided Int` because ONE discovered job
 * carried a numeric upstream date (a JSON Int) where the declared type claimed
 * `string`. The persisted claim is still the verbatim upstream value - it is
 * only STRINGIFIED, never re-parsed, reformatted or dropped, so the audit
 * column keeps saying exactly what upstream said.
 *
 * Contract:
 * - a `string` (the overwhelmingly common case) is returned byte-identical,
 *   including `''` (never normalised, never trimmed);
 * - `null` / `undefined` stay `null` (a missing claim is still missing, never
 *   the string `"undefined"`);
 * - anything else becomes `String(value)`, so an upstream Int (Lever's epoch
 *   `createdAt`) can no longer abort a whole batch with a 500.
 *
 * `unknown` (not `string`) is the parameter type on purpose: the value arrives
 * from untyped upstream JSON, so the defence must hold even when the static
 * type is proven wrong at runtime.
 */
export function coercePostedAtRaw(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return String(value);
}

/**
 * The five wave-3 columns for the CREATE path. `firstSeenAt` is the injected
 * `now` (route layer owns the clock). Missing extras persist as null.
 */
export function provenanceCreateData(job: PersistableJob, now: Date): JobListingProvenanceCreate {
  return {
    postedAtSource: job.postedAtSource ?? null,
    postedAtRaw: coercePostedAtRaw(job.postedAtRaw),
    firstSeenAt: now,
    dateConfidence: job.dateConfidence ?? null,
    canonicalKey: job.canonicalKey ?? null,
  };
}

/**
 * The wave-3 columns for the UPDATE path. `firstSeenAt` is INTENTIONALLY
 * absent: the create-only stamp must never move on re-discovery. Asserted by
 * test (`'firstSeenAt' in update` is false).
 */
export function provenanceUpdateData(job: PersistableJob): JobListingProvenanceUpdate {
  return {
    postedAtSource: job.postedAtSource ?? null,
    postedAtRaw: coercePostedAtRaw(job.postedAtRaw),
    dateConfidence: job.dateConfidence ?? null,
    canonicalKey: job.canonicalKey ?? null,
  };
}

// ---------------------------------------------------------------------------
// Legacy read rule (ADR-028 consequences).
// ---------------------------------------------------------------------------

/**
 * Resolve the effective provenance for a stored row. A null (or unrecognised)
 * stored value reads as `unknown` - this covers pre-migration rows that carry
 * a `postedAt` but no source. The stored date itself is never touched here;
 * callers return it verbatim so no data is destroyed, while the `unknown`
 * label (via `dateLabel` -> `Found`) stops the row claiming `source-posted`.
 */
export function resolvePostedAtSource(row: {
  postedAtSource?: string | null;
}): PostedAtSource {
  return isPostedAtSource(row.postedAtSource) ? row.postedAtSource : 'unknown';
}

// ---------------------------------------------------------------------------
// API response shaping (additive).
// ---------------------------------------------------------------------------

/** Minimal stored-row shape the response shaper reads. */
export interface ListingRowLike {
  id: string;
  source: string;
  title: string;
  company: string;
  location: string | null;
  applyUrl: string | null;
  sourceUrl: string;
  postedAt: Date | null;
  isActive: boolean;
  postedAtSource?: string | null;
}

/** GET /jobs/search + /jobs/scan item: the nine pre-existing keys verbatim. */
export interface JobListingResponse {
  id: string;
  source: string;
  title: string;
  company: string;
  location: string | null;
  applyUrl: string | null;
  postedUrl: string;
  postedAt: Date | null;
  isActive: boolean;
  postedAtSource: PostedAtSource;
  dateLabel: DateLabel;
  sources?: SourceRef[];
}

/**
 * Shape one stored row into its API item. The nine pre-existing keys keep
 * their exact names and values; `postedAtSource` (resolved, never null) and
 * the derived `dateLabel` are additive; `sources` is attached only when a
 * non-empty array is known (omitted otherwise, never `[]` or null).
 */
export function shapeListingResponse(
  row: ListingRowLike,
  extras?: { sources?: SourceRef[] | null },
): JobListingResponse {
  const postedAtSource = resolvePostedAtSource(row);
  const response: JobListingResponse = {
    id: row.id,
    source: row.source,
    title: row.title,
    company: row.company,
    location: row.location,
    applyUrl: row.applyUrl,
    postedUrl: row.sourceUrl,
    postedAt: row.postedAt,
    isActive: row.isActive,
    postedAtSource,
    dateLabel: dateLabel({ postedAtSource }),
  };
  if (extras?.sources && extras.sources.length > 0) {
    response.sources = extras.sources;
  }
  return response;
}
