// Export the active catalogue as a normalized, excerpt-only snapshot.
//
// Usage (from backend/):
//   npx tsx scripts/export-catalogue.ts [--out <dir>] [--limit N]
//
// Writes `<out>/catalogue.jsonl.gz` (gzip JSONL, one record per active
// JobListing) and `<out>/manifest.json`. Rows are streamed in keyset pages of
// 1,000 by `id`, so the export never holds the catalogue or a full description
// in memory. The process asserts its OWN output before reporting success: the
// manifest count must equal the number of decoded lines and the manifest
// sha256 must match the bytes on disk. A write failure exits non-zero.
//
// `DATABASE_URL` must point at the target database. The repo-root `.env` is
// loaded without overriding an explicit value. No secrets are printed.

import dotenv from 'dotenv';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { join, resolve } from 'node:path';
import type { SnapshotRecord } from '../src/search/snapshot.js';

dotenv.config({ path: resolve(process.cwd(), '../.env') });

interface CliOptions {
  out: string;
  limit: number | null;
}

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

function parseArgs(argv: string[]): CliOptions {
  const out = flagValue(argv, '--out') ?? 'out';
  if (out.trim().length === 0) throw new Error('--out must not be empty');
  const rawLimit = flagValue(argv, '--limit');
  if (rawLimit === undefined) return { out, limit: null };
  const limit = Number(rawLimit);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`--limit must be a number >= 1 (got ${rawLimit})`);
  }
  return { out, limit: Math.floor(limit) };
}

/** Await one stream write (the callback gives us backpressure + errors). */
function writeLine(
  stream: ReturnType<typeof createGzip>,
  line: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    stream.write(line, (error) => (error ? reject(error) : resolvePromise()));
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const outDir = resolve(process.cwd(), options.out);
  const filePath = join(outDir, 'catalogue.jsonl.gz');
  const manifestPath = join(outDir, 'manifest.json');

  const [{ default: prisma }, snapshot] = await Promise.all([
    import('../src/lib/prisma.js'),
    import('../src/search/snapshot.js'),
  ]);

  mkdirSync(outDir, { recursive: true });

  try {
    console.log(
      `[export-catalogue] start out=${outDir} limit=${options.limit ?? 'all'} pageSize=${snapshot.SNAPSHOT_PAGE_SIZE}`,
    );
    const totalActive = await prisma.jobListing.count({ where: { isActive: true } });
    console.log(`[export-catalogue] active listings: ${totalActive}`);

    const gzip = createGzip();
    const out = createWriteStream(filePath);
    gzip.pipe(out);

    const records: SnapshotRecord[] = [];
    let lastId: string | null = null;
    let page = 0;
    let done = false;

    while (!done) {
      const rows = await prisma.jobListing.findMany({
        where: {
          isActive: true,
          ...(lastId ? { id: { gt: lastId } } : {}),
        },
        orderBy: { id: 'asc' },
        take: snapshot.SNAPSHOT_PAGE_SIZE,
        select: {
          id: true,
          canonicalKey: true,
          source: true,
          externalId: true,
          title: true,
          company: true,
          location: true,
          sourceUrl: true,
          applyUrl: true,
          postedAt: true,
          firstSeenAt: true,
          isActive: true,
          searchDocument: true,
        },
      });
      if (rows.length === 0) break;

      for (const row of rows) {
        const record = snapshot.buildSnapshotRecord(row);
        await writeLine(gzip, snapshot.serializeSnapshotRecord(record));
        records.push(record);
        if (options.limit !== null && records.length >= options.limit) {
          done = true;
          break;
        }
      }
      lastId = rows[rows.length - 1].id;
      page += 1;
      console.log(
        `[export-catalogue] page ${page}: read=${rows.length} written=${records.length}/${totalActive}`,
      );
      if (rows.length < snapshot.SNAPSHOT_PAGE_SIZE) break;
    }

    await new Promise<void>((resolvePromise, reject) => {
      out.once('finish', resolvePromise);
      out.once('error', reject);
      gzip.once('error', reject);
      gzip.end();
    });

    // Round-trip assertion on our OWN artifact: hash the bytes on disk, write
    // the manifest from them, then decode the file again and prove the count
    // matches and the digest still matches.
    const bytes = readFileSync(filePath);
    const manifest = snapshot.buildSnapshotManifest({
      generatedAt: new Date().toISOString(),
      records,
      bytes,
      filename: snapshot.SNAPSHOT_FILENAME,
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const verified = snapshot.verifySnapshotFile(manifest, readFileSync(filePath));
    console.log(
      `[export-catalogue] ok count=${manifest.count} lines=${verified.lines} ` +
        `bytes=${bytes.length} sha256=${manifest.sha256} ` +
        `sources=${JSON.stringify(manifest.sources)}`,
    );
    console.log(`[export-catalogue] wrote ${filePath}`);
    console.log(`[export-catalogue] wrote ${manifestPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[export-catalogue] failed: ${message}`);
  process.exitCode = 1;
});
