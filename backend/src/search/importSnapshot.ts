// Import a catalogue snapshot into the local database.
//
// The import is a local UPDATE, not a database restore: every record goes
// through the same `upsertDiscoveredJobs` path a real discovery run uses, so
// `externalId`/`canonicalKey` and the derived `searchDocument` are recomputed
// from the row rather than trusted from the file. Three consequences:
//
//   * IDEMPOTENT - a second import of the same file updates the same rows;
//   * REACTIVATING - `upsertDiscoveredJobs` writes `isActive: true` on its
//     update branch, so a row that a previous sweep soft-closed comes back when
//     it reappears in a snapshot (this also closes the older gap where plain
//     rediscovery did not reactivate a closed row);
//   * EXCERPT-ONLY - the importer never persists an excerpt as if it were a
//     full job description. `description` is sent empty, so an existing local
//     full description is preserved by the persistence guard and a brand-new
//     row starts with no full text (never fabricated).
//
// The sha256 in the manifest is verified against the COMPRESSED bytes before a
// single line is parsed. Unknown sources are skipped, duplicate
// `(source, externalId)` lines are deduped, and records without an external id
// cannot be upserted, so they are skipped too.

import type { RawJob } from '../jobSources/index.js';
import {
  gunzipSnapshot,
  isSnapshotSource,
  parseSnapshotJsonl,
  SnapshotError,
  verifySnapshotBytes,
  type SnapshotManifest,
  type SnapshotRecord,
} from './snapshot.js';

export interface ImportedJobKey {
  source: string;
  externalId: string;
}

export interface ImportSnapshotDeps {
  /** Persist through the shared discovery upsert path. */
  upsertJobs: (jobs: RawJob[]) => Promise<Array<{ source?: string; externalId?: string | null }>>;
  /** Rows currently closed for the given sources, so reactivations can be counted. */
  loadInactiveKeys: (
    sources: string[],
  ) => Promise<Array<{ source: string; externalId: string | null }>>;
}

export interface ImportSnapshotResult {
  imported: number;
  reactivated: number;
  skipped: number;
  snapshotGeneratedAt: string;
}

/** A job plus the optional provenance fields `upsertDiscoveredJobs` reads. */
type SnapshotJob = RawJob & { canonicalKey?: string | null };

function parseDate(value: string | null): Date | undefined {
  if (value === null) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toRawJob(record: SnapshotRecord): SnapshotJob {
  return {
    externalId: record.externalId ?? undefined,
    source: record.source,
    sourceUrl: record.sourceUrl,
    title: record.title,
    company: record.company,
    ...(record.location ? { location: record.location } : {}),
    // NEVER the excerpt: it is not a description, and the persistence guard
    // keeps an existing local full description when this is empty.
    description: '',
    ...(record.applyUrl ? { applyUrl: record.applyUrl } : {}),
    ...(parseDate(record.postedAt) ? { postedAt: parseDate(record.postedAt)! } : {}),
    // Carried so the update branch does not null a stored canonicalKey.
    canonicalKey: record.canonicalKey,
  };
}

/**
 * Verify and import one snapshot. `gzip` is the exact byte body the manifest
 * hashes (the `.jsonl.gz` file, not its decompressed text).
 */
export async function importSnapshot(
  input: { gzip: Uint8Array; manifest: SnapshotManifest },
  deps: ImportSnapshotDeps,
): Promise<ImportSnapshotResult> {
  verifySnapshotBytes(input.manifest, input.gzip);
  const { records, lines } = parseSnapshotJsonl(gunzipSnapshot(input.gzip));
  if (lines !== input.manifest.count) {
    throw new SnapshotError(
      'snapshot_count_mismatch',
      `manifest count ${input.manifest.count} does not match ${lines} line(s)`,
    );
  }

  let skipped = 0;
  const seen = new Set<string>();
  const jobs: SnapshotJob[] = [];
  for (const record of records) {
    if (!isSnapshotSource(record.source)) {
      skipped += 1;
      continue;
    }
    if (!record.externalId) {
      skipped += 1;
      continue;
    }
    const key = `${record.source}\u0000${record.externalId}`;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    jobs.push(toRawJob(record));
  }

  const sources = [...new Set(jobs.map((job) => job.source))];
  const inactive = new Set(
    (await deps.loadInactiveKeys(sources))
      .filter((row): row is ImportedJobKey =>
        typeof row.source === 'string' && typeof row.externalId === 'string',
      )
      .map((row) => `${row.source}\u0000${row.externalId}`),
  );

  const upserted = jobs.length > 0 ? await deps.upsertJobs(jobs) : [];
  let reactivated = 0;
  for (const row of upserted) {
    if (typeof row.source !== 'string' || typeof row.externalId !== 'string') continue;
    if (inactive.has(`${row.source}\u0000${row.externalId}`)) reactivated += 1;
  }

  return {
    imported: upserted.length,
    reactivated,
    skipped,
    snapshotGeneratedAt: input.manifest.generatedAt,
  };
}
