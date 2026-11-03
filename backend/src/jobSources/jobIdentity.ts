import { createHash } from 'node:crypto';
import type { RawJob } from './index.js';
import { dedupeJobs as dedupeJobsTiered } from '../discovery/dedupe.js';

// ---------------------------------------------------------------------------
// WIN1252-safe text sanitizer (app-level, no migration).
//
// The JobListing table lives in a Postgres database whose server encoding is
// WIN1252, so any character outside the WIN1252 repertoire (e.g. U+2192 RIGHT
// ARROW, bytes 0xE2 0x86 0x92 in UTF-8) aborts the upsert with Prisma error
// P1012 / Postgres 22P05 and turns POST /jobs/search into a backend 500.
// sanitizeJobText() rewrites title/company/location/description into text that
// is guaranteed encodable in WIN1252 before it ever reaches Prisma, and
// before the deterministic externalId hash is computed (so the hash is stable
// post-sanitize and repeated scans keep hitting the update path).
//
// Rules:
//   1. Strip NUL and C0/C1 controls (except TAB/LF/CR) - Postgres rejects NUL
//      in text fields regardless of encoding.
//   2. Transliterate a small set of common non-WIN1252 symbols (arrows) to
//      ASCII so "Senior -> Engineer" keeps its meaning instead of "Senior ?
//      Engineer".
//   3. Replace lone surrogates with '?' (they are not valid scalar values and
//      can never be encoded).
//   4. Replace every remaining code point outside the WIN1252 repertoire with
//      '?'. '?' (U+003F) is always encodable; U+FFFD itself is NOT in WIN1252
//      so it must never be used as the replacement.
// ---------------------------------------------------------------------------

// WIN1252 bytes 0x80-0x9F map to these Unicode code points (0x81,0x8D,0x8F,
// 0x90,0x9D are undefined and therefore absent). Everything U+0000-U+00FF
// outside the C0/C1 controls is directly encodable.
const WIN1252_EXTRA = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

const ARROW_TRANSLITERATIONS: Array<[RegExp, string]> = [
  [/[\u2192\u21d2\u27f6]/g, '->'],
  [/[\u2190\u21d0\u27f5]/g, '<-'],
  [/[\u2194\u21d4]/g, '<->'],
  [/[\u2191\u21d1]/g, '^'],
  [/[\u2193\u21d3]/g, 'v'],
  [/[\u2212]/g, '-'],
];

// Lone-surrogate matcher: a high surrogate not followed by a low surrogate,
// or a low surrogate not preceded by a high surrogate.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function isWin1252Encodable(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return true;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  return WIN1252_EXTRA.has(cp);
}

export function sanitizeJobText(s: string): string {
  if (s == null) return '';
  let str = String(s);
  // 1) Strip NUL + C0 controls (except TAB/LF/CR) + DEL + C1 controls.
  // eslint-disable-next-line no-control-regex
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u0080-\u009F]/g, '');
  // 2) Transliterate common non-WIN1252 symbols before the repertoire filter.
  for (const [re, replacement] of ARROW_TRANSLITERATIONS) {
    str = str.replace(re, replacement);
  }
  // 3) Lone surrogates -> '?'.
  str = str.replace(LONE_SURROGATE_RE, '?');
  // 4) Anything left outside WIN1252 -> '?'. Iterate by code point so astral
  //    characters (emoji, CJK extensions) collapse to a single '?'.
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    out += isWin1252Encodable(cp) ? ch : '?';
  }
  return out;
}

/** Sanitize the free-text fields of a RawJob; ids/urls/dates pass through. */
export function sanitizeRawJob(job: RawJob): RawJob {
  return {
    ...job,
    title: sanitizeJobText(job.title ?? ''),
    company: sanitizeJobText(job.company ?? ''),
    location: job.location == null ? job.location : sanitizeJobText(job.location),
    description: sanitizeJobText(job.description ?? ''),
  };
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Canonical URL normalisation owned by this module (lowercased
 * scheme/host, fragment stripped, tracking params stripped, trailing
 * slash stripped; non-URLs fall back to normalised text). Reused by
 * the browser pool (`browser/pool.ts`) so the per-run URL cap is spent
 * on DISTINCT pages — one normaliser, not two.
 */
export function normalizeUrl(raw: unknown): string {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  try {
    const url = new URL(str);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    const cleaned = new URL(url.href);
    // Collect keys first: deleting during iteration skips entries.
    const keys: string[] = [];
    for (const [key] of cleaned.searchParams) keys.push(key);
    for (const key of keys) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) {
        cleaned.searchParams.delete(key);
      }
    }
    let result = cleaned.href;
    if (result.endsWith('/') && result.length > cleaned.origin.length + 1) {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    return normalizeText(str);
  }
}

function buildCanonical(job: Pick<RawJob, 'title' | 'company' | 'location' | 'description' | 'sourceUrl' | 'applyUrl'>): string {
  const applyUrl = normalizeUrl(job.applyUrl);
  const sourceUrl = normalizeUrl(job.sourceUrl);
  if (applyUrl || sourceUrl) {
    return `url:${applyUrl || sourceUrl}`;
  }
  return `content:${normalizeText(job.title)}|${normalizeText(job.company)}|${normalizeText(job.location)}|${normalizeText(job.description)}`;
}

export function canonicalizeJobIdentity(job: Pick<RawJob, 'title' | 'company' | 'location' | 'description' | 'sourceUrl' | 'applyUrl'>): string {
  return buildCanonical(job);
}

export function jobExternalId(job: Pick<RawJob, 'title' | 'company' | 'location' | 'description' | 'sourceUrl' | 'applyUrl'>): string {
  const canonical = buildCanonical(job);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256-${digest}`;
}

export function withDeterministicExternalId(job: RawJob): RawJob {
  // Sanitize BEFORE hashing so the id is stable post-sanitize: the same
  // posting always hashes to the same key no matter which raw bytes arrived.
  const clean = sanitizeRawJob(job);
  return { ...clean, externalId: clean.externalId || jobExternalId(clean) };
}

/**
 * Wave 3 (T663, ADR-032): thin delegate to the single tiered implementation
 * in `discovery/dedupe.ts` (T1 canonical URL .. T6 fuzzy + source union).
 * Kept here under its original name and `RawJob[]` return type so existing
 * callers (`routes/jobs.ts`, `routes/saved-searches.ts`,
 * `routes/job-alerts.ts`) are unchanged; `sources`/`canonicalKey` arrive as
 * additive optional fields on each surviving row.
 */
export function dedupeJobs(jobs: RawJob[]): RawJob[] {
  return dedupeJobsTiered(jobs);
}
