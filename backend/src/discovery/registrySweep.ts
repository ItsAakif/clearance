// Keyset-cursor reader for the Full-scan company-career-page sweep (T884,
// T905; ADR-033 decision 4 amended by ADR-034 decision 3).
//
// Ordering and cursor (T905, ADR-034 D3): the reader orders the active pages
// by the IMMUTABLE pair `(tier asc, id asc)`. The cursor is an OPAQUE
// encoding of that pair produced by THIS module only; everything outside
// treats the cursor as a string. An unparseable/absent cursor (including
// any value from a hand-edited or pre-T905 snapshot) restarts the sweep
// from the beginning by design: repeats are idempotent through
// `upsertDiscoveredJobs`, so a silent skip would not be recoverable.
// `nextCheckAt` is mutable registry scheduling state and so remains
// UNUSABLE as a keyset cursor (a row's `nextCheckAt` could move a different
// row across the boundary between batches and make the sweep skip or
// repeat a row).
//
// This module is read-only and deliberately has no writes, timers, scheduler,
// queue, or worker. It returns only the routing fields needed by the
// orchestrator; it never logs or returns page content or credentials.

import prisma from '../lib/prisma.js';
import { FULL_BATCH_PAGES } from './budgets.js';

export interface RegistrySweepPage {
  /**
   * Stable CompanyCareerPage primary key. It stays internal to the reader and
   * orchestrator; the route exposes it only through the opaque continuation
   * cursor when a fetched page must be retried.
   */
  id: string;
  companyName: string;
  url: string;
  provider: string | null;
  boardToken: string | null;
  /**
   * Wave 15 (T905) additive - the immutable tier from the importer. Surfaced
   * here so the orchestrator can rewind to the PREDECESSOR page's opaque
   * cursor without parsing it (a rewind stores `cursor`, not `id`).
   */
  tier: number;
  /**
   * Wave 15 (T905) opaque per-page "resume-after-this-row" cursor. Encoded
   * from `{tier, id}` by THIS module only; treated as opaque by every other
   * module. Format: a single character delimiter (`|`) joining `tier` and
   * `id`, e.g. `"1|<uuid>"`. Decoding any malformed input returns
   * `null`, which restarts the sweep from the beginning (documented
   * idempotent-via-upsert rationale; see module header).
   */
  cursor: string;
}

export interface RegistrySweepBatch {
  pages: RegistrySweepPage[];
  total: number; // total ACTIVE career pages in the registry
  hasMore: boolean;
  nextCursor: string | null; // opaque cursor for the next batch, or null on a short final batch
}

/**
 * Convert a caller-supplied limit into a safe Prisma take value. A full-scan
 * request is bounded by the shared budget constant, while malformed runtime
 * values are treated as an empty batch instead of reaching Prisma and throwing.
 */
function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 0;
  return Math.min(Math.floor(limit), FULL_BATCH_PAGES);
}

/**
 * Wave 15 (T905) private cursor encoding. The encoding is an implementation
 * detail of this module; callers treat the cursor as opaque. We prefix the
 * payload with `t:` so any future upgrade (e.g. switching to a signed cursor)
 * can keep older snapshots working as a malformed-cursor restart.
 */
function encodeCursor(payload: { tier: number; id: string }): string {
  return `t:${payload.tier}|${payload.id}`;
}

/**
 * Wave 15 (T905) private cursor decoder. Returns `null` for any malformed
 * input, which causes the reader to start from the beginning. Repeats are
 * idempotent through the upsert path; skipping would not be recoverable.
 */
function decodeCursor(s: string | null | undefined): { tier: number; id: string } | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (!s.startsWith('t:')) return null;
  const body = s.slice(2);
  const sep = body.indexOf('|');
  if (sep <= 0 || sep === body.length - 1) return null;
  const tierText = body.slice(0, sep);
  const id = body.slice(sep + 1);
  const tier = Number(tierText);
  if (!Number.isFinite(tier) || !Number.isInteger(tier) || tier < 1 || id.length === 0) {
    return null;
  }
  return { tier, id };
}

export async function countActiveRegistryPages(): Promise<number> {
  return prisma.companyCareerPage.count({ where: { isActive: true } });
}

export async function resolveRegistryPageBatch(
  afterCursor: string | null,
  limit: number,
): Promise<RegistrySweepBatch> {
  const take = boundedLimit(limit);
  const totalPromise = countActiveRegistryPages();
  const decoded = decodeCursor(afterCursor);

  if (take === 0) {
    return {
      pages: [],
      total: await totalPromise,
      hasMore: false,
      nextCursor: null,
    };
  }

  // T905 / ADR-034 D3: keyset on the immutable pair `(tier asc, id asc)`.
  // `nextCheckAt` is mutable and so cannot participate in keyset ordering.
  // `isActive` is a leading column so the active-row filter can use the
  // matching index (`@@index([isActive, tier, id])`).
  const [rows, total] = await Promise.all([
    prisma.companyCareerPage.findMany({
      where: {
        isActive: true,
        ...(decoded !== null
          ? {
              OR: [
                { tier: { gt: decoded.tier } },
                { tier: decoded.tier, id: { gt: decoded.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ tier: 'asc' }, { id: 'asc' }],
      take,
      include: { company: { select: { name: true } } },
    }),
    totalPromise,
  ]);

  const pages: RegistrySweepPage[] = rows.map((row) => ({
    id: row.id,
    companyName: row.company.name,
    url: row.url,
    provider: row.provider,
    boardToken: row.boardToken,
    tier: row.tier,
    cursor: encodeCursor({ tier: row.tier, id: row.id }),
  }));
  const lastPage = pages[pages.length - 1];
  // `nextCursor` is the LAST page's opaque cursor when the batch is full;
  // otherwise null (unchanged semantics). A malformed cursor restart (decoded
  // === null and afterCursor was non-null) still returns the first batch's
  // cursor from row[0].
  const nextCursor =
    pages.length === take && lastPage !== undefined ? lastPage.cursor : null;
  const hasMore = nextCursor !== null;

  return {
    pages,
    total,
    hasMore,
    nextCursor,
  };
}
