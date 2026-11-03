// Re-derive one listing's `searchDocument`. Used by the idempotent backfill and
// available to any future ingest path that wants to refresh a row immediately.

import { Prisma, type PrismaClient } from '@prisma/client';
import { buildSearchDocument, SEARCH_DOC_VERSION, type SearchDocument, type SearchDocumentSource } from './document.js';

export type RefreshStore = Pick<PrismaClient, 'jobListing'>;

/**
 * Key-order-insensitive comparison, because the stored document round-trips
 * through PostgreSQL JSONB (which reorders keys) while the derived object has a
 * fixed literal key order.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function sameDocument(stored: Record<string, unknown>, derived: SearchDocument): boolean {
  return canonical(stored) === canonical(derived);
}

/**
 * Read the canonical columns, derive the document, and stamp both
 * `searchDocument` and `searchUpdatedAt`. Returns null when the row is gone.
 * Idempotent: re-running with unchanged source columns produces the same JSON.
 */
export async function refreshSearchDocument(
  store: RefreshStore,
  id: string,
  now: Date = new Date(),
): Promise<SearchDocument | null> {
  const listing = await store.jobListing.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      source: true,
      sourceUrl: true,
      applyUrl: true,
      postedAt: true,
      firstSeenAt: true,
      isActive: true,
      description: true,
    },
  });
  if (!listing) return null;

  const doc = buildSearchDocument(listing);
  await store.jobListing.update({
    where: { id },
    data: {
      searchDocument: doc as unknown as Prisma.InputJsonValue,
      searchUpdatedAt: now,
    },
  });
  return doc;
}

/**
 * Ensure a persisted listing carries a current `searchDocument`.
 *
 * The crawl hot path calls this after every upsert so newly discovered rows are
 * searchable immediately, without a separate backfill pass. A matching
 * `docVersion` is NOT sufficient to skip the write: the upsert's update branch
 * refreshes title/company/location/description/postedAt, and the document is
 * derived from those columns. So the document is always derived (pure, no I/O)
 * and compared with the stored one; the DB write happens only when they differ.
 *
 * Returns `true` when a write happened, `false` when the stored doc was current.
 */
export async function ensureSearchDocument(
  store: RefreshStore,
  listing: SearchDocumentSource & {
    id: string;
    searchDocument?: unknown;
  },
  now: Date = new Date(),
): Promise<boolean> {
  const stored = listing.searchDocument as Record<string, unknown> | null | undefined;
  const doc = buildSearchDocument(listing);
  if (stored && stored.docVersion === SEARCH_DOC_VERSION && sameDocument(stored, doc)) {
    return false;
  }
  await store.jobListing.update({
    where: { id: listing.id },
    data: {
      searchDocument: doc as unknown as Prisma.InputJsonValue,
      searchUpdatedAt: now,
    },
  });
  return true;
}