#!/usr/bin/env node
// Build script for the offline world-city asset.
//
// Usage:
//   node scripts/build-cities.mjs           # download/refresh, filter, transform, write the asset
//   node scripts/build-cities.mjs --check   # validate only: assert shape + required cities + aliases
//
// Source: GeoNames cities15000 (population > 15000 or capitals, ca 25,000 rows, CC-BY).
//   https://download.geonames.org/export/dump/cities15000.zip
// plus the admin1 English names:
//   https://download.geonames.org/export/dump/admin1CodesASCII.txt
// History: cities5000 was the first choice, but the 2026-09-17 dump yields 69,654 rows and
// 833,671 bytes gzipped, over the 700,000-byte budget, so the script was switched to the
// documented cities15000 fallback (one-line SOURCE_ZIP_URL change + regenerate).
// Measured gzipped asset size (zlib.gzipSync): see stdout of --check.
//
// Cache: extracted dump files live under .cache/geonames/ (git-ignored) so a re-run needs no
// network. The zip itself is never committed and the dump is never checked into git.
//
// Zip extraction: Node has no built-in unzip, so the script shells out to the platform `tar`
// (bsdtar ships with Windows 10+, macOS and most Linux distros and reads .zip). The exit code
// is checked and any failure aborts loudly. If `tar` is unavailable, place a pre-extracted
// `cities5000.txt` at .cache/geonames/cities5000.txt and the script will use it as-is.
//
// The alias table is owned by src/features/jobs/cityAliases.ts (the only copy in the repo).
// This script parses the literal map out of that file; the table is NOT duplicated here.
//
// Output: public/data/cities.min.json, a single compact JSON array of { n, c, a? } rows
// (key order exactly n, c, a; `a` omitted entirely when absent), sorted by population
// descending with a stable (n, c) tiebreak so the same dump always yields a byte-identical
// file. If the download fails on a cold cache the script exits non-zero and writes nothing.

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const SOURCE_ZIP_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
// Previous source (over budget, kept for reference):
// const SOURCE_ZIP_URL = 'https://download.geonames.org/export/dump/cities5000.zip';
const SOURCE_ADMIN1_URL = 'https://download.geonames.org/export/dump/admin1CodesASCII.txt';

const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'geonames');
// Cache file names derive from the source URL so switching tiers never mixes dumps.
const SOURCE_BASENAME = SOURCE_ZIP_URL.split('/').pop().replace(/\.zip$/i, '');
const CACHED_ZIP = path.join(CACHE_DIR, `${SOURCE_BASENAME}.zip`);
const CACHED_DUMP = path.join(CACHE_DIR, `${SOURCE_BASENAME}.txt`);
const CACHED_ADMIN1 = path.join(CACHE_DIR, 'admin1CodesASCII.txt');

const ALIAS_FILE = path.join(REPO_ROOT, 'src', 'features', 'jobs', 'cityAliases.ts');
const OUT_FILE = path.join(REPO_ROOT, 'public', 'data', 'cities.min.json');

const GZIP_BUDGET_BYTES = 700000;

// [name, countryCode] pairs that must exist in the asset. IN entries also assert c === 'IN'.
const REQUIRED_CITIES = [
  ['Pune', 'IN'],
  ['Mumbai', 'IN'],
  ['Bengaluru', 'IN'],
  ['Delhi', 'IN'],
  ['Chennai', 'IN'],
  ['Kolkata', 'IN'],
  ['Hyderabad', 'IN'],
  ['Ahmedabad', 'IN'],
  ['London', null],
  ['Berlin', null],
  ['Paris', null],
  ['New York City', null],
  ['San Francisco', null],
  ['Toronto', null],
  ['Singapore', null],
  ['Dubai', null],
  ['Sydney', null],
];

function fail(message) {
  console.error(`build-cities: error: ${message}`);
  process.exit(1);
}

// Read the CITY_ALIASES literal map out of src/features/jobs/cityAliases.ts without
// duplicating the table. The alias module is plain TS with no imports, so a small
// text parse of the object literal is enough and works on any Node version.
function loadAliases() {
  if (!existsSync(ALIAS_FILE)) fail(`alias table not found at ${path.relative(REPO_ROOT, ALIAS_FILE)}`);
  const text = readFileSync(ALIAS_FILE, 'utf8');
  const marker = 'CITY_ALIASES';
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) fail(`alias table does not export ${marker}`);
  const openIdx = text.indexOf('{', markerIdx);
  const closeIdx = text.lastIndexOf('}');
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) fail('could not parse CITY_ALIASES literal');
  const body = text.slice(openIdx + 1, closeIdx);
  const entries = {};
  const entryRe = /['"]?([A-Za-z0-9_.\-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = entryRe.exec(body)) !== null) {
    entries[match[1].toLowerCase()] = match[2];
  }
  if (Object.keys(entries).length === 0) fail('parsed zero entries out of CITY_ALIASES');
  return entries;
}

async function downloadToFile(url, dest) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    fail(`download failed for ${url}: ${err.message} (no usable cache; wrote nothing)`);
  }
  if (!response.ok || !response.body) {
    fail(`download failed for ${url}: HTTP ${response.status} (no usable cache; wrote nothing)`);
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmpDest = `${dest}.part`;
  const fileStream = createWriteStream(tmpDest);
  try {
    await pipeline(response.body, fileStream);
  } catch (err) {
    try { (await import('node:fs/promises')).unlink(tmpDest); } catch {}
    fail(`download failed for ${url}: ${err.message} (no usable cache; wrote nothing)`);
  }
  (await import('node:fs/promises')).rename(tmpDest, dest);
}

// Extract the first .txt entry from the zip using the platform tar. Throws on failure.
function extractZipWithTar(zipPath, destDir, expectedName) {
  try {
    execFileSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'pipe' });
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim().slice(0, 300) : err.message;
    fail(
      `could not extract ${path.basename(zipPath)} with 'tar -xf' (${detail}). ` +
      `Install tar/bsdtar or place a pre-extracted ${expectedName} at ${CACHED_DUMP}; wrote nothing.`,
    );
  }
}

async function ensureCache() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const hasDump = existsSync(CACHED_DUMP);
  const hasAdmin1 = existsSync(CACHED_ADMIN1);
  if (hasDump && hasAdmin1) {
    console.log('build-cities: reusing cached dump (no download)');
    return;
  }
  // Cold cache: download the zip (unless a pre-extracted dump was placed by hand) and admin1.
  if (!hasDump) {
    if (!existsSync(CACHED_ZIP)) {
      console.log(`build-cities: downloading ${SOURCE_ZIP_URL}`);
      await downloadToFile(SOURCE_ZIP_URL, CACHED_ZIP);
    } else {
      console.log('build-cities: reusing cached zip');
    }
    console.log('build-cities: extracting dump with tar');
    extractZipWithTar(CACHED_ZIP, CACHE_DIR, `${SOURCE_BASENAME}.txt`);
  }
  if (!existsSync(CACHED_ADMIN1)) {
    console.log(`build-cities: downloading ${SOURCE_ADMIN1_URL}`);
    await downloadToFile(SOURCE_ADMIN1_URL, CACHED_ADMIN1);
  }
  if (!existsSync(CACHED_DUMP)) {
    fail(`extraction produced no ${path.basename(CACHED_DUMP)}; wrote nothing.`);
  }
}

// admin1CodesASCII.txt columns: code, name, asciiname, geonameid. Key on column 1
// (`CC.admin1`, e.g. `IN.16`), value is column 2 (the English name).
function loadAdmin1Names() {
  const map = new Map();
  const text = readFileSync(CACHED_ADMIN1, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 2) continue;
    map.set(cols[0].trim(), (cols[1] ?? '').trim());
  }
  return map;
}

// geoname columns: geonameid, name, asciiname, alternatenames, lat, lng, featureClass,
// featureCode, countryCode, cc2, admin1, admin2, admin3, admin4, population, elevation,
// dem, timezone, modDate
function buildRows() {
  const admin1Names = loadAdmin1Names();
  const text = readFileSync(CACHED_DUMP, 'utf8');
  const withPop = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 19) continue;
    const name = (cols[1] ?? '').trim();
    const featureClass = (cols[6] ?? '').trim();
    const countryCode = (cols[8] ?? '').trim();
    const admin1 = (cols[10] ?? '').trim();
    const population = Number.parseInt((cols[14] ?? '').trim(), 10);
    if (featureClass !== 'P') continue;
    if (!Number.isFinite(population) || population <= 0) continue;
    if (!name || !countryCode) continue;
    let adminName = admin1Names.get(`${countryCode}.${admin1}`) ?? '';
    adminName = adminName.trim();
    if (!adminName || adminName === name) adminName = '';
    withPop.push({ name, countryCode, adminName, population });
  }
  // Population descending, then name and country ascending for a deterministic order.
  withPop.sort((x, y) => {
    if (y.population !== x.population) return y.population - x.population;
    if (x.name < y.name) return -1;
    if (x.name > y.name) return 1;
    if (x.countryCode < y.countryCode) return -1;
    if (x.countryCode > y.countryCode) return 1;
    return 0;
  });
  return withPop.map(({ name, countryCode, adminName }) => {
    const row = { n: name, c: countryCode };
    if (adminName) row.a = adminName;
    return row;
  });
}

function readAsset() {
  if (!existsSync(OUT_FILE)) fail(`asset not found at ${path.relative(REPO_ROOT, OUT_FILE)}`);
  let rows;
  try {
    rows = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch (err) {
    fail(`asset is not valid JSON: ${err.message}`);
  }
  return rows;
}

// Shared validator used by --check and at the end of a write. Returns the rows.
function validateAsset(rows, aliases) {
  const rel = path.relative(REPO_ROOT, OUT_FILE);
  if (!Array.isArray(rows) || rows.length === 0) fail(`${rel} must be a non-empty JSON array`);
  const byName = new Map();
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`${rel}[${i}] is not an object`);
    if (typeof row.n !== 'string' || !row.n) fail(`${rel}[${i}] has a bad 'n'`);
    if (typeof row.c !== 'string' || row.c.length !== 2) fail(`${rel}[${i}] has a bad 'c'`);
    if ('a' in row && (typeof row.a !== 'string' || !row.a)) fail(`${rel}[${i}] has a bad 'a'`);
    if ('p' in row) fail(`${rel}[${i}] carries a population field; the asset must not include one`);
    if (!byName.has(row.n)) byName.set(row.n, row);
  });
  for (const [name, country] of REQUIRED_CITIES) {
    const row = byName.get(name);
    if (!row) fail(`required city ${JSON.stringify(name)} is missing from ${rel}`);
    if (country !== null && row.c !== country) {
      fail(`required city ${JSON.stringify(name)} has c=${JSON.stringify(row.c)}, want ${JSON.stringify(country)}`);
    }
  }
  for (const [alias, target] of Object.entries(aliases)) {
    if (!byName.has(target)) fail(`alias ${JSON.stringify(alias)} points at missing city ${JSON.stringify(target)}`);
  }
  const rawBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
  void rawBytes;
  const gzipped = zlib.gzipSync(Buffer.from(readFileSync(OUT_FILE)));
  const gzipBytes = gzipped.length;
  console.log(`build-cities: rows=${rows.length} gzipped=${gzipBytes} bytes (budget ${GZIP_BUDGET_BYTES})`);
  if (gzipBytes > GZIP_BUDGET_BYTES) {
    fail(`gzipped size ${gzipBytes} exceeds budget ${GZIP_BUDGET_BYTES}; consider the cities15000 fallback`);
  }
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  if (args.some((a) => a !== '--check')) fail(`unknown argument: ${args.find((a) => a !== '--check')}`);

  // The alias table is parsed as text (see loadAliases); it has a single owner and
  // is never duplicated in this script.
  const aliases = loadAliases();

  if (checkOnly) {
    validateAsset(readAsset(), aliases);
    console.log('build-cities: check OK');
    return;
  }

  await ensureCache();
  const rows = buildRows();
  if (rows.length === 0) fail('no rows survived filtering; wrote nothing.');
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const payload = JSON.stringify(rows);
  writeFileSync(OUT_FILE, payload);
  console.log(`build-cities: wrote ${rows.length} rows, ${Buffer.byteLength(payload, 'utf8')} bytes`);
  validateAsset(readAsset(), aliases);
  console.log('build-cities: done');
}

await main();
