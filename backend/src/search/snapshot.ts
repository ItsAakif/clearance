// Catalogue snapshot: the normalized, excerpt-only export/import wire shape.
//
// The snapshot is ONE gzipped JSONL file (`catalogue.jsonl.gz`) plus a sibling
// `manifest.json`. It is deliberately NOT a database dump:
//   * only ACTIVE listings are exported;
//   * every record carries identity + display fields + the DERIVED
//     `searchDocument` facets (workMode, seniority, ...), so a local instance
//     can browse the catalogue without re-running the sweep;
//   * the full `description` is NEVER included. Only the bounded
//     `descriptionExcerpt` (280 chars) travels, because a full JD corpus is
//     both large and a redistribution question the snapshot must not answer.
//
// Everything in this module is pure (no DB, no clock, no I/O beyond the
// in-memory gzip helpers) so the exporter, importer, merge job and their tests
// share one definition of the record and the manifest.

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  buildSearchDocument,
  SEARCH_DOC_VERSION,
  type RegionId,
  type SearchDocument,
  type SearchSalary,
  type SearchDocumentSource,
  type SeniorityLevel,
  type SpecializationId,
  type WorkMode,
} from './document.js';

/** Bumped only when the record/manifest layout changes incompatibly. */
export const SNAPSHOT_VERSION = 1;

/** Fixed artifact names - the release and the importer both rely on them. */
export const SNAPSHOT_FILENAME = 'catalogue.jsonl.gz';
export const SNAPSHOT_MANIFEST_FILENAME = 'manifest.json';

/**
 * Oldest app that can read this snapshot layout. Bump alongside
 * `SNAPSHOT_VERSION` when an older importer would mis-read a newer file.
 */
export const SNAPSHOT_MIN_APP_VERSION = '1.0.0';

/** Keyset page size for the exporter (contract: 1,000). */
export const SNAPSHOT_PAGE_SIZE = 1000;

/**
 * The `JobListing.source` vocabulary a snapshot may contain. This is the
 * catalogue's own source contract (`shared/job-sources.json`), not the registry
 * provider ids: the weekly Action shards `breezy` and `pinpointhq`, whose rows
 * persist as `breezyhr` and `pinpoint`.
 *
 * An importer skips anything outside this set rather than writing an
 * unverified source into the catalogue. The last group lists writers that are
 * not part of the weekly ATS shards but can still appear in a locally exported
 * snapshot.
 */
export const SNAPSHOT_SOURCES = [
  // The weekly Action's 13 keyless ATS shards (persisted source names).
  'greenhouse',
  'ashby',
  'lever',
  'workable',
  'bamboohr',
  'breezyhr',
  'jobvite',
  'pinpoint',
  'teamtailor',
  'recruitee',
  'smartrecruiters',
  'freshteam',
  'rippling',
  // Other catalogue writers (aggregators / generic boards / tiers).
  'workday',
  'personio',
  'jobicy',
  'hnalgolia',
  'adzuna',
  'usajobs',
  'reed',
  'findwork',
  'rss',
  'json',
  'career-page',
  'search',
  'scraper',
  'dorking',
  'browser',
] as const;

export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

export const SNAPSHOT_SOURCE_SET: ReadonlySet<string> = new Set<string>(SNAPSHOT_SOURCES);

export function isSnapshotSource(source: unknown): source is SnapshotSource {
  return typeof source === 'string' && SNAPSHOT_SOURCE_SET.has(source);
}

/** One line of `catalogue.jsonl.gz`. */
export interface SnapshotRecord {
  id: string;
  canonicalKey: string | null;
  source: string;
  externalId: string | null;
  title: string;
  company: string;
  location: string | null;
  sourceUrl: string;
  applyUrl: string | null;
  postedAt: string | null;
  firstSeenAt: string | null;
  isActive: boolean;
  workMode: WorkMode | null;
  seniority: SeniorityLevel | null;
  specialization: SpecializationId | null;
  skills: string[];
  salary: SearchSalary | null;
  region: RegionId | null;
  descriptionExcerpt: string;
  docVersion: string;
}

/** The stored columns a record is built from (searchDocument is optional). */
export interface SnapshotListingRow extends SearchDocumentSource {
  id: string;
  source?: string | null;
  canonicalKey?: string | null;
  externalId?: string | null;
  searchDocument?: unknown;
}

export interface SnapshotManifest {
  version: number;
  generatedAt: string;
  count: number;
  sources: Record<string, number>;
  sha256: string;
  filename: string;
  minAppVersion: string;
}

export type SnapshotErrorCode =
  | 'snapshot_invalid'
  | 'snapshot_format_invalid'
  | 'snapshot_version_unsupported'
  | 'snapshot_sha_mismatch'
  | 'snapshot_count_mismatch';

/** A snapshot that cannot be trusted. Routes map this to a 400. */
export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;

  constructor(code: SnapshotErrorCode, message: string) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

function asIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

/** Stored document if it is an object; otherwise null (derive from columns). */
function storedDocument(value: unknown): Partial<SearchDocument> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Partial<SearchDocument>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function salaryOrNull(value: unknown): SearchSalary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const salary = value as Partial<SearchSalary>;
  if (typeof salary.min !== 'number' || typeof salary.max !== 'number') return null;
  if (typeof salary.currency !== 'string') return null;
  return { min: salary.min, max: salary.max, currency: salary.currency };
}

/**
 * Normalize one stored listing into a snapshot record.
 *
 * The stored `searchDocument` is preferred (it is what the browse API serves);
 * a row that has not been backfilled derives the same document from its
 * columns, so every record carries the full facet set either way. The
 * `description` column is never read into the record.
 */
export function buildSnapshotRecord(row: SnapshotListingRow): SnapshotRecord {
  const stored = storedDocument(row.searchDocument);
  const doc = stored ?? buildSearchDocument(row);
  return {
    id: row.id,
    canonicalKey: row.canonicalKey ?? null,
    source: row.source ?? doc.source ?? '',
    externalId: row.externalId ?? null,
    title: row.title ?? doc.title ?? '',
    company: row.company ?? doc.company ?? '',
    location: row.location ?? doc.location ?? null,
    sourceUrl: row.sourceUrl ?? doc.sourceUrl ?? '',
    applyUrl: row.applyUrl ?? doc.applyUrl ?? null,
    postedAt: asIso(row.postedAt) ?? doc.postedAt ?? null,
    firstSeenAt: asIso(row.firstSeenAt) ?? doc.firstSeenAt ?? null,
    isActive: row.isActive !== false,
    workMode: (doc.workMode as WorkMode | null | undefined) ?? null,
    seniority: (doc.seniority as SeniorityLevel | null | undefined) ?? null,
    specialization: (doc.specialization as SpecializationId | null | undefined) ?? null,
    skills: stringArray(doc.skills),
    salary: salaryOrNull(doc.salary),
    region: (doc.region as RegionId | null | undefined) ?? null,
    descriptionExcerpt: typeof doc.descriptionExcerpt === 'string' ? doc.descriptionExcerpt : '',
    docVersion: typeof doc.docVersion === 'string' ? doc.docVersion : SEARCH_DOC_VERSION,
  };
}

/** One JSONL line, newline included. */
export function serializeSnapshotRecord(record: SnapshotRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function encodeSnapshotJsonl(records: readonly SnapshotRecord[]): string {
  return records.map(serializeSnapshotRecord).join('');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SnapshotError('snapshot_format_invalid', `snapshot record is missing "${field}"`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parse one JSONL line into a record. Throws `snapshot_format_invalid` for a
 * line that cannot be a record at all; a merely missing optional facet falls
 * back to its typed default so a slightly older snapshot still imports.
 */
export function parseSnapshotRecord(line: string): SnapshotRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new SnapshotError('snapshot_format_invalid', 'snapshot line is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotError('snapshot_format_invalid', 'snapshot line is not an object');
  }
  const raw = value as Record<string, unknown>;
  return {
    id: requireString(raw.id, 'id'),
    canonicalKey: optionalString(raw.canonicalKey),
    source: requireString(raw.source, 'source'),
    externalId: optionalString(raw.externalId),
    title: requireString(raw.title, 'title'),
    company: requireString(raw.company, 'company'),
    location: optionalString(raw.location),
    sourceUrl: requireString(raw.sourceUrl, 'sourceUrl'),
    applyUrl: optionalString(raw.applyUrl),
    postedAt: optionalString(raw.postedAt),
    firstSeenAt: optionalString(raw.firstSeenAt),
    isActive: raw.isActive !== false,
    workMode: (raw.workMode as WorkMode | null | undefined) ?? null,
    seniority: (raw.seniority as SeniorityLevel | null | undefined) ?? null,
    specialization: (raw.specialization as SpecializationId | null | undefined) ?? null,
    skills: stringArray(raw.skills),
    salary: salaryOrNull(raw.salary),
    region: (raw.region as RegionId | null | undefined) ?? null,
    descriptionExcerpt: typeof raw.descriptionExcerpt === 'string' ? raw.descriptionExcerpt : '',
    docVersion: typeof raw.docVersion === 'string' ? raw.docVersion : SEARCH_DOC_VERSION,
  };
}

export interface ParsedSnapshot {
  records: SnapshotRecord[];
  /** Non-empty lines read (duplicates included - the manifest counts lines). */
  lines: number;
}

/** Decode a decompressed snapshot body. Blank lines are ignored. */
export function parseSnapshotJsonl(text: string): ParsedSnapshot {
  const records: SnapshotRecord[] = [];
  let lines = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    lines += 1;
    records.push(parseSnapshotRecord(line));
  }
  return { records, lines };
}

export function gzipSnapshot(text: string): Buffer {
  return gzipSync(Buffer.from(text, 'utf8'));
}

export function gunzipSnapshot(bytes: Uint8Array): string {
  try {
    return gunzipSync(bytes).toString('utf8');
  } catch {
    throw new SnapshotError('snapshot_format_invalid', 'snapshot file is not valid gzip');
  }
}

export function computeSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function countSnapshotSources(records: readonly SnapshotRecord[]): Record<string, number> {
  const sources: Record<string, number> = {};
  for (const record of records) {
    sources[record.source] = (sources[record.source] ?? 0) + 1;
  }
  return sources;
}

/** Build the manifest for already-written gzip bytes. */
export function buildSnapshotManifestFromCounts(input: {
  generatedAt: string;
  count: number;
  sources: Record<string, number>;
  bytes: Uint8Array;
  filename?: string;
}): SnapshotManifest {
  return {
    version: SNAPSHOT_VERSION,
    generatedAt: input.generatedAt,
    count: input.count,
    sources: { ...input.sources },
    sha256: computeSha256(input.bytes),
    filename: input.filename ?? SNAPSHOT_FILENAME,
    minAppVersion: SNAPSHOT_MIN_APP_VERSION,
  };
}

/** Build the manifest for already-written gzip bytes. */
export function buildSnapshotManifest(input: {
  generatedAt: string;
  records: readonly SnapshotRecord[];
  bytes: Uint8Array;
  filename?: string;
}): SnapshotManifest {
  return buildSnapshotManifestFromCounts({
    generatedAt: input.generatedAt,
    count: input.records.length,
    sources: countSnapshotSources(input.records),
    bytes: input.bytes,
    filename: input.filename,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Parse and shape-check a manifest. Throws `snapshot_invalid`. */
export function parseSnapshotManifest(input: string | unknown): SnapshotManifest {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new SnapshotError('snapshot_invalid', 'manifest is not valid JSON');
    }
  }
  if (!isPlainObject(value)) {
    throw new SnapshotError('snapshot_invalid', 'manifest is not an object');
  }
  const version = value.version;
  const count = value.count;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SnapshotError('snapshot_invalid', 'manifest version is missing or invalid');
  }
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
    throw new SnapshotError('snapshot_invalid', 'manifest count is missing or invalid');
  }
  if (typeof value.generatedAt !== 'string' || value.generatedAt.trim().length === 0) {
    throw new SnapshotError('snapshot_invalid', 'manifest generatedAt is missing');
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) {
    throw new SnapshotError('snapshot_invalid', 'manifest sha256 is missing or invalid');
  }
  if (typeof value.filename !== 'string' || value.filename.trim().length === 0) {
    throw new SnapshotError('snapshot_invalid', 'manifest filename is missing');
  }
  if (typeof value.minAppVersion !== 'string' || value.minAppVersion.trim().length === 0) {
    throw new SnapshotError('snapshot_invalid', 'manifest minAppVersion is missing');
  }
  const sources: Record<string, number> = {};
  if (value.sources !== undefined) {
    if (!isPlainObject(value.sources)) {
      throw new SnapshotError('snapshot_invalid', 'manifest sources is not an object');
    }
    for (const [name, n] of Object.entries(value.sources)) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        throw new SnapshotError('snapshot_invalid', 'manifest source count is invalid');
      }
      sources[name] = n;
    }
  }
  return {
    version,
    generatedAt: value.generatedAt,
    count,
    sources,
    sha256: value.sha256.toLowerCase(),
    filename: value.filename,
    minAppVersion: value.minAppVersion,
  };
}

/**
 * Verify a gzip body against its manifest BEFORE anything is parsed or
 * written. `count` is checked by the importer once the lines are decoded.
 */
export function verifySnapshotBytes(manifest: SnapshotManifest, bytes: Uint8Array): void {
  if (manifest.version !== SNAPSHOT_VERSION) {
    throw new SnapshotError(
      'snapshot_version_unsupported',
      `unsupported snapshot version ${manifest.version} (this app reads version ${SNAPSHOT_VERSION})`,
    );
  }
  const actual = computeSha256(bytes);
  if (actual !== manifest.sha256.toLowerCase()) {
    throw new SnapshotError(
      'snapshot_sha_mismatch',
      'snapshot sha256 does not match its manifest',
    );
  }
}

/** Re-read a written file and assert the manifest describes it exactly. */
export function verifySnapshotFile(
  manifest: SnapshotManifest,
  bytes: Uint8Array,
): { lines: number } {
  verifySnapshotBytes(manifest, bytes);
  const { lines } = parseSnapshotJsonl(gunzipSnapshot(bytes));
  if (lines !== manifest.count) {
    throw new SnapshotError(
      'snapshot_count_mismatch',
      `manifest count ${manifest.count} does not match ${lines} line(s)`,
    );
  }
  return { lines };
}
