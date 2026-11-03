// Idempotent backfill for `JobListing.searchDocument`.
//
// Default mode selects only rows whose document is missing or was derived by a
// different SEARCH_DOC_VERSION, walks them in ascending id order (keyset
// pagination, no OFFSET drift), and calls the same `refreshSearchDocument`
// service the app uses. Safe to re-run: a second run selects zero rows.
//
// `--reconcile` mode walks EVERY row (not just version-stale ones), derives the
// document from the row's canonical columns, and updates only rows whose stored
// JSON differs. Use it to heal content drift (e.g. a title/postedAt change that
// landed after the document was written). Prints before/after drift counts and
// is safe to re-run (second run: 0 updates).
//
// Run: cd backend && npx tsx scripts/backfill-search-documents.ts
//      cd backend && npx tsx scripts/backfill-search-documents.ts --reconcile
// (DATABASE_URL must point at the target database.)

import prisma from '../src/lib/prisma.js';
import { SEARCH_DOC_VERSION } from '../src/search/document.js';
import { buildSearchDocument } from '../src/search/document.js';
import { refreshSearchDocument, sameDocument } from '../src/search/refresh.js';
import { Prisma } from '@prisma/client';

const BATCH_SIZE = 200;

interface CountsRow {
  total: number;
  fresh: number;
  stale: number;
}

const SELECT = {
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
  searchDocument: true,
} as const;

async function readCounts(): Promise<CountsRow> {
  const rows = await prisma.$queryRaw<CountsRow[]>`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE "searchDocument" IS NOT NULL
          AND ("searchDocument"->>'docVersion') = ${SEARCH_DOC_VERSION}
      )::int AS fresh,
      count(*) FILTER (
        WHERE "searchDocument" IS NULL
          OR ("searchDocument"->>'docVersion') IS DISTINCT FROM ${SEARCH_DOC_VERSION}
      )::int AS stale
    FROM "JobListing"
  `;
  return rows[0] ?? { total: 0, fresh: 0, stale: 0 };
}

async function nextIds(cursor: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "JobListing"
    WHERE (("searchDocument" IS NULL)
      OR (("searchDocument"->>'docVersion') IS DISTINCT FROM ${SEARCH_DOC_VERSION}))
      AND "id" > ${cursor}
    ORDER BY "id" ASC
    LIMIT ${BATCH_SIZE}
  `;
  return rows.map((row) => row.id);
}

async function fetchBatch(cursor: string) {
  return prisma.jobListing.findMany({
    where: cursor ? { id: { gt: cursor } } : undefined,
    orderBy: { id: 'asc' },
    take: BATCH_SIZE,
    select: SELECT,
  });
}

async function countDrift(): Promise<number> {
  let cursor = '';
  let drift = 0;
  while (true) {
    const rows = await fetchBatch(cursor);
    if (rows.length === 0) break;
    for (const row of rows) {
      const derived = buildSearchDocument(row as any);
      const stored = row.searchDocument as Record<string, unknown> | null;
      if (!stored || !sameDocument(stored, derived)) drift += 1;
    }
    cursor = rows[rows.length - 1].id;
  }
  return drift;
}

async function runBackfill(): Promise<void> {
  const before = await readCounts();
  console.log(
    `[catalogue-backfill] before: total=${before.total} fresh=${before.fresh} stale=${before.stale}`,
  );

  let cursor = '';
  let updated = 0;
  let batches = 0;
  while (true) {
    const ids = await nextIds(cursor);
    if (ids.length === 0) break;
    batches += 1;
    for (const id of ids) {
      const doc = await refreshSearchDocument(prisma, id, new Date());
      if (doc) updated += 1;
    }
    cursor = ids[ids.length - 1];
    console.log(
      `[catalogue-backfill] batch=${batches} updated=${updated} cursor=${cursor}`,
    );
  }

  const after = await readCounts();
  console.log(
    `[catalogue-backfill] after: total=${after.total} fresh=${after.fresh} stale=${after.stale}`,
  );
  console.log(
    `[catalogue-backfill] updated=${updated} batches=${batches} version=${SEARCH_DOC_VERSION}`,
  );
  if (after.stale !== 0) {
    throw new Error(`catalogue backfill left ${after.stale} stale row(s)`);
  }
}

async function runReconcile(): Promise<void> {
  const beforeDrift = await countDrift();
  console.log(`[search-reconcile] before drift=${beforeDrift}`);

  let cursor = '';
  let scanned = 0;
  let updated = 0;
  let batches = 0;
  while (true) {
    const rows = await fetchBatch(cursor);
    if (rows.length === 0) break;
    batches += 1;
    for (const row of rows) {
      scanned += 1;
      const stored = row.searchDocument as Record<string, unknown> | null;
      const derived = buildSearchDocument(row as any);
      const drifted = !stored || !sameDocument(stored, derived);
      if (drifted) {
        await prisma.jobListing.update({
          where: { id: row.id },
          data: {
            searchDocument: derived as unknown as Prisma.InputJsonValue,
            searchUpdatedAt: new Date(),
          },
        });
        updated += 1;
      }
    }
    cursor = rows[rows.length - 1].id;
    console.log(
      `[search-reconcile] batch=${batches} scanned=${scanned} updated=${updated} cursor=${cursor}`,
    );
  }

  const afterDrift = await countDrift();
  console.log(`[search-reconcile] after drift=${afterDrift}`);
  console.log(`[search-reconcile] scanned=${scanned} updated=${updated}`);
  if (afterDrift !== 0) {
    throw new Error(`search reconcile left ${afterDrift} drifted row(s)`);
  }
}

async function main(): Promise<void> {
  const reconcile = process.argv.slice(2).includes('--reconcile');
  if (reconcile) {
    await runReconcile();
  } else {
    await runBackfill();
  }
}

main()
  .catch((error) => {
    console.error('[catalogue-backfill] failed', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());