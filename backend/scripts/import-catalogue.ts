// Import a catalogue snapshot into the local database (offline CLI).
//
// Usage (from backend/):
//   npx tsx scripts/import-catalogue.ts --file path.jsonl.gz [--manifest path.json]
//
// `--manifest` defaults to `manifest.json` next to the snapshot file. The
// import goes through the SAME path as `POST /catalogue/import`: sha256 is
// verified against the compressed bytes, rows are upserted via
// `upsertDiscoveredJobs` (canonical keys + search documents recomputed), closed
// rows that reappear are reactivated, and `AppSetting catalogue:importedAt` is
// stamped so the Settings card shows the local "last updated".
//
// Re-running the same file is idempotent. `DATABASE_URL` must point at the
// target database. No secrets are printed.

import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

dotenv.config({ path: resolve(process.cwd(), '../.env') });

function flagValue(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith('--') ? next : '';
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fileArg = flagValue(argv, '--file');
  if (!fileArg) {
    throw new Error('Usage: npx tsx scripts/import-catalogue.ts --file path.jsonl.gz [--manifest path.json]');
  }
  const filePath = resolve(process.cwd(), fileArg);
  const manifestPath = resolve(
    process.cwd(),
    flagValue(argv, '--manifest') ?? join(dirname(fileArg), 'manifest.json'),
  );

  const [{ default: prisma }, snapshot, importer, service] = await Promise.all([
    import('../src/lib/prisma.js'),
    import('../src/search/snapshot.js'),
    import('../src/search/importSnapshot.js'),
    import('../src/search/catalogueImportService.js'),
  ]);

  try {
    const gzip = readFileSync(filePath);
    const manifest = snapshot.parseSnapshotManifest(readFileSync(manifestPath, 'utf8'));
    console.log(
      `[import-catalogue] file=${filePath} manifest=${manifestPath} ` +
        `count=${manifest.count} generatedAt=${manifest.generatedAt} sha256=${manifest.sha256}`,
    );

    const before = await prisma.jobListing.count({ where: { isActive: true } });
    const result = await importer.importSnapshot(
      { gzip, manifest },
      service.createPrismaSnapshotImportDeps(),
    );
    const after = await prisma.jobListing.count({ where: { isActive: true } });
    await service.recordCatalogueImport(new Date().toISOString());

    console.log(
      `[import-catalogue] imported=${result.imported} reactivated=${result.reactivated} ` +
        `skipped=${result.skipped} snapshotGeneratedAt=${result.snapshotGeneratedAt}`,
    );
    console.log(`[import-catalogue] active before=${before} after=${after}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[import-catalogue] failed: ${message}`);
  process.exitCode = 1;
});
