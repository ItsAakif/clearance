// Merge the weekly Action's per-provider shard snapshots into ONE release.
//
// Usage (from backend/):
//   npx tsx scripts/merge-catalogue.ts --in <dir> --out <dir>
//
// Every `*.jsonl.gz` under `--in` is read (one directory per provider
// artifact). Records are deduped by `(source, externalId)` AND by
// `canonicalKey`, then the merged file is written with a manifest rebuilt from
// the kept rows (count, per-source counts, sha256). No database connection and
// no ATS network call: the merge job is pure artifact arithmetic.

import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { join, resolve } from 'node:path';

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

function findSnapshots(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findSnapshots(full));
    else if (entry.isFile() && entry.name.endsWith('.jsonl.gz')) found.push(full);
  }
  return found.sort();
}

function writeLine(stream: ReturnType<typeof createGzip>, line: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    stream.write(line, (error) => (error ? reject(error) : resolvePromise()));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const inArg = flagValue(argv, '--in');
  if (!inArg) {
    throw new Error('Usage: npx tsx scripts/merge-catalogue.ts --in <dir> --out <dir>');
  }
  const inDir = resolve(process.cwd(), inArg);
  const outDir = resolve(process.cwd(), flagValue(argv, '--out') ?? 'out');
  const filePath = join(outDir, 'catalogue.jsonl.gz');
  const manifestPath = join(outDir, 'manifest.json');

  const snapshot = await import('../src/search/snapshot.js');
  const files = findSnapshots(inDir);
  if (files.length === 0) {
    throw new Error(`no *.jsonl.gz found under ${inDir}`);
  }

  mkdirSync(outDir, { recursive: true });
  const gzip = createGzip();
  const out = createWriteStream(filePath);
  gzip.pipe(out);

  const seenIdentity = new Set<string>();
  const seenCanonical = new Set<string>();
  const sources: Record<string, number> = {};
  let inputLines = 0;
  let kept = 0;
  let duplicateIdentity = 0;
  let duplicateCanonical = 0;

  for (const file of files) {
    const bytes = readFileSync(file);
    const { records } = snapshot.parseSnapshotJsonl(snapshot.gunzipSnapshot(bytes));
    for (const record of records) {
      inputLines += 1;
      const identity = record.externalId ? `${record.source}\u0000${record.externalId}` : null;
      if (identity && seenIdentity.has(identity)) {
        duplicateIdentity += 1;
        continue;
      }
      if (record.canonicalKey && seenCanonical.has(record.canonicalKey)) {
        duplicateCanonical += 1;
        continue;
      }
      if (identity) seenIdentity.add(identity);
      if (record.canonicalKey) seenCanonical.add(record.canonicalKey);
      sources[record.source] = (sources[record.source] ?? 0) + 1;
      kept += 1;
      await writeLine(gzip, snapshot.serializeSnapshotRecord(record));
    }
    console.log(`[merge-catalogue] read ${file} (${records.length} rows, kept=${kept})`);
  }

  await new Promise<void>((resolvePromise, reject) => {
    out.once('finish', resolvePromise);
    out.once('error', reject);
    gzip.once('error', reject);
    gzip.end();
  });

  const bytes = readFileSync(filePath);
  const manifest = snapshot.buildSnapshotManifestFromCounts({
    generatedAt: new Date().toISOString(),
    count: kept,
    sources,
    bytes,
    filename: snapshot.SNAPSHOT_FILENAME,
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const verified = snapshot.verifySnapshotFile(manifest, readFileSync(filePath));

  console.log(
    `[merge-catalogue] files=${files.length} inputLines=${inputLines} kept=${verified.lines} ` +
      `duplicateIdentity=${duplicateIdentity} duplicateCanonical=${duplicateCanonical} ` +
      `bytes=${bytes.length} sha256=${manifest.sha256}`,
  );
  console.log(`[merge-catalogue] sources=${JSON.stringify(manifest.sources)}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[merge-catalogue] failed: ${message}`);
  process.exitCode = 1;
});
