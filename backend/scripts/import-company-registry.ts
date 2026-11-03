// Company-registry dataset importer (T642; wave-2 spec DESIGN Importer).
//
// Run: cd backend && npx tsx scripts/import-company-registry.ts --dataset <id> [--limit N] [--dry-run]
//
// Supported --dataset ids (manifests in src/registry/importer.ts, every
// licence/URL/row-count read from the dataset's own metadata on 2026-09-20):
//   ats-career-page-urls  HF CSV (CC-BY-4.0), streamed line-by-line
//   mherzog4-job-boards   GitHub JSON seed blob (MIT), single small blob
// Skipped per N14 (prints the recorded reason, writes nothing):
//   careerscout           engine codebase, no dataset file published
//
// Guarantees:
// - Streaming: the CSV body is consumed via readline and only one bounded
//   batch of prepared rows is ever held in memory (never one giant array).
// - Idempotent: upserts on Company.slug and CompanyCareerPage.url; a resumed
//   run re-matches the same keys and creates nothing new.
// - Provenance: every written row carries registrySource, registryLicense and
//   registrySourceRef. A row missing a licence is never written.
// - Preservation: re-import refreshes ONLY name/websiteUrl/industries;
//   isActive and all verification fields are create-only (page re-match is a
//   no-op update), so operator deactivations survive re-imports.
// - Over-long URLs (>1024 chars) are SKIPPED + reported, never fatal.
// - --dry-run writes NOTHING and reports per-provider / per-tier counts.
// - No secrets are ever logged (DATABASE_URL is read but never printed).

import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  IMPORT_BATCH_SIZE,
  MAX_SEED_BLOB_BYTES,
  SEED_BOARD_URL,
  SKIPPED_DATASETS,
  SUPPORTED_DATASETS,
  emptyStats,
  importPrepared,
  mergeStats,
  parseCsvRecord,
  prepareRow,
  summarize,
  type DatasetManifest,
  type PreparedRow,
  type RegistryStore,
  type SourceRow,
} from '../src/registry/importer.js';

const USER_AGENT = 'ClearanceRegistryBot/1.0 (+https://clearance.app; registry seed import)';

interface CliArgs {
  dataset: string;
  limit: number | null;
  dryRun: boolean;
}

function usage(): string {
  return 'Usage: npx tsx scripts/import-company-registry.ts --dataset <id> [--limit N] [--dry-run]';
}

function parseArgs(argv: string[]): CliArgs | null {
  let dataset: string | null = null;
  let limit: number | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset' && i + 1 < argv.length) {
      dataset = argv[++i];
    } else if (arg === '--limit' && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) return null;
      limit = n;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      return null;
    }
  }
  if (dataset === null) return null;
  return { dataset, limit, dryRun };
}

async function fetchText(url: string, maxBytes: number): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status} for dataset download`);
  const text = await res.text();
  if (text.length > maxBytes) {
    throw new Error(`dataset blob exceeds ${maxBytes} bytes; refusing to buffer (streaming required)`);
  }
  return text;
}

/** Stream CSV data rows as SourceRows without ever materializing the file. */
async function* streamCsvRows(
  manifest: DatasetManifest,
  limit: number | null,
): AsyncGenerator<SourceRow, { rowsRead: number }, void> {
  const res = await fetch(manifest.sourceUrl, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || res.body === null) {
    throw new Error(`fetch failed: HTTP ${res.status} for ${manifest.sourceUrl}`);
  }
  const lines = createInterface({ input: Readable.fromWeb(res.body as never) });
  let rowsRead = 0;
  let urlIdx = -1;
  let headerSeen = false;
  for await (const line of lines) {
    if (line.trim() === '') continue;
    if (!headerSeen) {
      headerSeen = true;
      const header = parseCsvRecord(line).map((h) => h.trim().toLowerCase());
      urlIdx = header.indexOf('canonical_url');
      if (urlIdx === -1) throw new Error('CSV header lacks canonical_url column');
      continue;
    }
    if (limit !== null && rowsRead >= limit) break;
    rowsRead += 1;
    const fields = parseCsvRecord(line);
    yield { url: (fields[urlIdx] ?? '').trim(), sourceRef: `row:${rowsRead}` };
  }
  return { rowsRead };
}

/** Parse the small JSON seed blob into SourceRows (bounded by size guard). */
function seedRows(manifest: DatasetManifest, seedJson: unknown): SourceRow[] {
  if (seedJson === null || typeof seedJson !== 'object' || Array.isArray(seedJson)) {
    throw new Error('seed blob has unexpected shape (expected { <platform>: string[] })');
  }
  const rows: SourceRow[] = [];
  const skippedPlatforms: string[] = [];
  for (const [platform, tokens] of Object.entries(seedJson as Record<string, unknown>)) {
    const build = SEED_BOARD_URL[platform];
    if (build === undefined || !Array.isArray(tokens)) {
      skippedPlatforms.push(platform);
      continue;
    }
    for (const token of tokens) {
      if (typeof token !== 'string' || token.trim() === '') continue;
      const clean = token.trim();
      rows.push({
        url: build(clean),
        name: clean,
        sourceRef: `seed:${platform}:${clean}`,
      });
    }
  }
  if (skippedPlatforms.length > 0) {
    console.log(`[import] seed platforms without a canonical URL shape (skipped): ${skippedPlatforms.join(', ')}`);
  }
  return rows;
}

function prismaStore(prisma: PrismaClient): RegistryStore {
  return {
    async upsertCompany({ slug, create, refresh }) {
      const existing = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
      if (existing) {
        // Refresh ONLY name/websiteUrl/industries (STEP 10).
        await prisma.company.update({
          where: { slug },
          data: {
            name: refresh.name,
            websiteUrl: refresh.websiteUrl,
            industries: refresh.industries ?? Prisma.JsonNull,
          },
        });
        return { id: existing.id, created: false };
      }
      const created = await prisma.company.create({
        data: {
          slug,
          name: create.name,
          websiteUrl: create.websiteUrl,
          industries: create.industries ?? Prisma.JsonNull,
          registrySource: create.registrySource,
          registryLicense: create.registryLicense,
          registrySourceRef: create.registrySourceRef,
        },
      });
      return { id: created.id, created: true };
    },
    async upsertCareerPage({ url, companyId, create }) {
      const existing = await prisma.companyCareerPage.findUnique({ where: { url }, select: { id: true } });
      // Re-match is a deliberate no-op: isActive + verification fields are
      // create-only so re-imports never resurrect deactivated pages.
      if (existing) return { created: false };
      await prisma.companyCareerPage.create({
        data: {
          companyId,
          url,
          host: create.host,
          provider: create.provider,
          boardToken: create.boardToken,
          tier: create.tier,
        },
      });
      return { created: true };
    },
  };
}

function printSummary(summary: { total: number; byProvider: Record<string, number>; byTier: Record<string, number> }): void {
  console.log(`[import] total prepared rows: ${summary.total}`);
  console.log('[import] per-provider:');
  for (const [provider, count] of Object.entries(summary.byProvider).sort((a, b) => b[1] - a[1])) {
    console.log(`[import]   ${provider}: ${count}`);
  }
  console.log('[import] per-tier:');
  for (const [tier, count] of Object.entries(summary.byTier).sort()) {
    console.log(`[import]   ${tier}: ${count}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.error(usage());
    console.error(`supported datasets: ${Object.keys(SUPPORTED_DATASETS).join(', ')}`);
    process.exit(1);
  }

  const skippedReason = SKIPPED_DATASETS[args.dataset];
  if (skippedReason !== undefined) {
    console.log(`[import] dataset=${args.dataset} status=skipped`);
    console.log(`[import] reason: ${skippedReason}`);
    return;
  }
  const manifest = SUPPORTED_DATASETS[args.dataset];
  if (manifest === undefined) {
    console.error(`unknown dataset: ${args.dataset}`);
    console.error(`supported datasets: ${Object.keys(SUPPORTED_DATASETS).join(', ')}`);
    console.error(`skipped datasets: ${Object.keys(SKIPPED_DATASETS).join(', ')}`);
    process.exit(1);
  }

  console.log(`[import] dataset=${manifest.id} license=${manifest.license} (${manifest.licenseUrl})`);
  console.log(`[import] source=${manifest.sourceUrl}`);
  if (args.limit !== null) console.log(`[import] limit=${args.limit}`);
  if (args.dryRun) console.log('[import] mode=dry-run (writes nothing)');

  let prisma: PrismaClient | null = null;
  if (!args.dryRun) {
    if (!process.env.DATABASE_URL) {
      console.error('[import] DATABASE_URL is not set; refusing to run a writing import without a database.');
      process.exit(1);
    }
    prisma = new PrismaClient();
  }

  try {
    if (manifest.id === 'mherzog4-job-boards') {
      await runSeedBlob(manifest, args, prisma);
    } else {
      await runCsvStream(manifest, args, prisma);
    }
  } finally {
    await prisma?.$disconnect();
  }
}

async function runCsvStream(
  manifest: DatasetManifest,
  args: CliArgs,
  prisma: PrismaClient | null,
): Promise<void> {
  const stats = emptyStats();
  const dry = { total: 0, byProvider: {} as Record<string, number>, byTier: {} as Record<string, number> };
  let rowsRead = 0;
  let rejected = 0;
  let pending: PreparedRow[] = [];
  const store = prisma === null ? null : prismaStore(prisma);

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (store === null) {
      const s = summarize(batch);
      dry.total += s.total;
      for (const [k, v] of Object.entries(s.byProvider)) dry.byProvider[k] = (dry.byProvider[k] ?? 0) + v;
      for (const [k, v] of Object.entries(s.byTier)) dry.byTier[k] = (dry.byTier[k] ?? 0) + v;
    } else {
      const batchStats = await importPrepared(store, batch, { batchSize: IMPORT_BATCH_SIZE });
      mergeStats(stats, batchStats);
      console.log(
        `[import] progress rows=${stats.rowsSeen} companies+${stats.companiesCreated} pages+${stats.pagesCreated} matched=${stats.pagesMatched} skipped=${stats.skipped.length}`,
      );
    }
  };

  const gen = streamCsvRows(manifest, args.limit);
  let result = await gen.next();
  while (!result.done) {
    rowsRead += 1;
    const prepared = prepareRow(result.value, manifest);
    if (!prepared.ok) {
      rejected += 1;
      stats.skipped.push({ ref: result.value.sourceRef, reason: prepared.reason });
    } else {
      pending.push(prepared.row);
      if (pending.length >= IMPORT_BATCH_SIZE) await flush();
    }
    result = await gen.next();
  }
  rowsRead = result.value.rowsRead;
  await flush();

  console.log(`[import] streamed data rows: ${rowsRead} (claimed by dataset: ${manifest.claimedRowCount ?? 'unstated'})`);
  console.log(`[import] rejected (skipped, reported): ${rejected}`);
  if (stats.skipped.length > 0) {
    const byReason: Record<string, number> = {};
    for (const s of stats.skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
    for (const [reason, count] of Object.entries(byReason)) console.log(`[import]   skip ${reason}: ${count}`);
  }
  if (store === null) {
    printSummary(dry);
  } else {
    console.log(
      `[import] done companies created=${stats.companiesCreated} matched=${stats.companiesMatched} pages created=${stats.pagesCreated} matched=${stats.pagesMatched}`,
    );
  }
}

async function runSeedBlob(
  manifest: DatasetManifest,
  args: CliArgs,
  prisma: PrismaClient | null,
): Promise<void> {
  // Single small JSON blob: size-guarded fetch, then bounded in-memory rows.
  // Memory ceiling: blob rejected above MAX_SEED_BLOB_BYTES before buffering.
  const text = await fetchText(manifest.sourceUrl, MAX_SEED_BLOB_BYTES);
  const parsed: unknown = JSON.parse(text);
  let rows = seedRows(manifest, parsed);
  console.log(`[import] seed blob rows: ${rows.length} (claimed by dataset: ${manifest.claimedRowCount ?? 'unstated'})`);
  if (args.limit !== null) rows = rows.slice(0, args.limit);

  const prepared: PreparedRow[] = [];
  const skipped: { ref: string; reason: string }[] = [];
  for (const row of rows) {
    const result = prepareRow(row, manifest);
    if (!result.ok) skipped.push({ ref: row.sourceRef, reason: result.reason });
    else prepared.push(result.row);
  }
  console.log(`[import] prepared=${prepared.length} rejected=${skipped.length}`);
  for (const s of skipped) console.log(`[import]   skip ${s.ref}: ${s.reason}`);

  if (prisma === null) {
    printSummary(summarize(prepared));
    return;
  }
  const stats = await importPrepared(prismaStore(prisma), prepared, {
    batchSize: IMPORT_BATCH_SIZE,
    onProgress: (done, s) =>
      console.log(`[import] progress rows=${done} companies+${s.companiesCreated} pages+${s.pagesCreated}`),
  });
  console.log(
    `[import] done companies created=${stats.companiesCreated} matched=${stats.companiesMatched} pages created=${stats.pagesCreated} matched=${stats.pagesMatched}`,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[import] FAILED: ${message.slice(0, 500)}`);
  process.exit(1);
});
