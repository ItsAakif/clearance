// Dataset -> registry row preparation + batched idempotent apply (T642).
//
// Pipeline: source row -> prepareRow (pure) -> importPrepared (store-backed).
// The store is dependency-injected so unit tests prove idempotence with an
// in-memory fake while the CLI script wires the real Prisma adapter.
//
// Field-refresh contract (wave-2 spec edge cases): a re-import may refresh
// ONLY Company name/websiteUrl/industries. CompanyCareerPage.isActive and all
// verification fields (verifyStatus, verifyMethod, verifiedAt, lastCheckedAt,
// httpStatus, resultCount, failureCount, nextCheckAt, lastError) are
// create-only: the page upsert performs a no-op update, so an operator
// deactivation is never resurrected by a re-import.

import { extractAts } from './atsUrl.js';
import { companySlug } from './slug.js';

/** Hard cap on career-page URL length: over-long rows are SKIPPED + reported. */
export const MAX_URL_LENGTH = 1024;
export const MAX_COMPANY_NAME_LENGTH = 200;
export const IMPORT_BATCH_SIZE = 250;
// Single-blob guard for the small JSON seed source (measured ~1KB).
export const MAX_SEED_BLOB_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Dataset manifests. Every field below was READ from the dataset's own
// metadata on 2026-09-20 (see .planning/progress/T642-company-registry-importer.md
// research gate) - never asserted from memory.
// ---------------------------------------------------------------------------

export interface DatasetManifest {
  id: string;
  /** Exact download URL used by the importer. */
  sourceUrl: string;
  format: string;
  /** Short licence name recorded onto every written row. */
  license: string;
  /** URL where the licence is stated. */
  licenseUrl: string;
  retrievedAt: string;
  /** Row count claimed by the dataset metadata (null when unstated). */
  claimedRowCount: number | null;
  note?: string;
}

export const DATASET_ATS_CAREER_PAGE_URLS: DatasetManifest = {
  id: 'ats-career-page-urls',
  sourceUrl:
    'https://huggingface.co/datasets/latmay/ats-career-page-urls/resolve/main/ats_career_page_urls.csv',
  format: 'csv with header canonical_url,ats_platform (CRLF line endings)',
  license: 'CC-BY-4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  retrievedAt: '2026-09-20',
  claimedRowCount: 69638,
  note: 'HF metadata (tags + README frontmatter) states license cc-by-4.0; README License section links the CC-BY-4.0 deed and asks attribution to Latmay (latmay.com). Sibling file is ats_career_page_urls.csv (the README pandas snippet names ats_page_urls.csv, which does not exist).',
};

export const DATASET_MHERZOG4_JOB_BOARDS: DatasetManifest = {
  id: 'mherzog4-job-boards',
  sourceUrl:
    'https://raw.githubusercontent.com/mherzog4/job-boards/main/boards.seed.json',
  format: 'single JSON blob: { <platform>: <boardToken[]> } (measured 937 bytes, 60 tokens)',
  license: 'MIT',
  licenseUrl: 'https://github.com/mherzog4/job-boards/blob/main/LICENSE',
  retrievedAt: '2026-09-20',
  claimedRowCount: 60,
  note: 'Not a company-row dataset: a Python board-client library whose only data file is boards.seed.json ({ashby: 35, greenhouse: 18, lever: 7} board tokens). The importer maps each token to its canonical board URL via SEED_BOARD_URL (the exact canonical shapes extractAts parses); company name = token. Memory ceiling: blob rejected above 1 MiB.',
};

export const SUPPORTED_DATASETS: Record<string, DatasetManifest> = {
  [DATASET_ATS_CAREER_PAGE_URLS.id]: DATASET_ATS_CAREER_PAGE_URLS,
  [DATASET_MHERZOG4_JOB_BOARDS.id]: DATASET_MHERZOG4_JOB_BOARDS,
};

/** Datasets skipped per N14 (licence verifiable but no importable row data). */
export const SKIPPED_DATASETS: Record<string, string> = {
  careerscout:
    'SKIPPED (N14): Ramcharan747/careerscout (MIT, https://github.com/Ramcharan747/careerscout) is a Go/Rust discovery-engine codebase; its file tree (100 blobs, retrieved 2026-09-20) contains no dataset/data file with company or career-page rows, so there is nothing to import.',
};

/**
 * Canonical board-URL constructors for seed tokens. The URL SHAPES mirror the
 * ADR-026 host table implemented by extractAts (boards.greenhouse.io/<token>,
 * jobs.lever.co/<token>, jobs.ashbyhq.com/<token>); adding a platform here
 * requires a matching extractAts host rule, otherwise rows land on tier 3.
 */
export const SEED_BOARD_URL: Record<string, (token: string) => string> = {
  ashby: (token) => `https://jobs.ashbyhq.com/${token}`,
  greenhouse: (token) => `https://boards.greenhouse.io/${token}`,
  lever: (token) => `https://jobs.lever.co/${token}`,
};

// ---------------------------------------------------------------------------
// Row preparation (pure).
// ---------------------------------------------------------------------------

/** One raw source row: a career-page URL plus optional company metadata. */
export interface SourceRow {
  url: string;
  name?: string;
  websiteUrl?: string;
  industries?: string[];
  /** Locator back to the dataset row (e.g. `row:123`, `seed:ashby:openai`). */
  sourceRef: string;
}

/** Import-ready row: natural keys derived, provenance attached. */
export interface PreparedRow {
  slug: string;
  companyName: string;
  websiteUrl: string | null;
  industries: string[] | null;
  pageUrl: string;
  host: string;
  provider: string | null;
  boardToken: string | null;
  /** ADR-026: 1=API (known ATS host), 3=HTTP page (unknown host). */
  tier: 1 | 3;
  registrySource: string;
  registryLicense: string;
  registrySourceRef: string;
}

export type PrepareError =
  | 'empty-url'
  | 'bad-url'
  | 'unsupported-scheme'
  | 'url-too-long'
  | 'missing-license';

export type PrepareResult =
  | { ok: true; row: PreparedRow }
  | { ok: false; reason: PrepareError };

/**
 * Company display name when the dataset gives no explicit name (the ATS
 * dataset carries no company metadata): humanize the board token
 * ("pareto-ai" -> "pareto ai"); fall back to the host when there is no token.
 */
export function deriveCompanyName(boardToken: string | null, host: string): string {
  if (boardToken !== null && boardToken.trim() !== '') {
    return boardToken.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim() || host;
  }
  return host;
}

/**
 * Validate + normalize one source row. Never throws on bad input: every
 * rejection is a { ok: false, reason } so the importer can SKIP + report
 * instead of aborting. A row missing a licence is never written.
 */
export function prepareRow(input: SourceRow, manifest: DatasetManifest): PrepareResult {
  if (manifest.license.trim() === '') return { ok: false, reason: 'missing-license' };
  const rawUrl = input.url.trim();
  if (rawUrl === '') return { ok: false, reason: 'empty-url' };
  if (rawUrl.length > MAX_URL_LENGTH) return { ok: false, reason: 'url-too-long' };

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'bad-url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-scheme' };
  }
  const host = parsed.hostname.toLowerCase();
  if (host === '') return { ok: false, reason: 'bad-url' };

  const { provider, boardToken } = extractAts(rawUrl);
  const explicitName = (input.name ?? '').trim().slice(0, MAX_COMPANY_NAME_LENGTH);
  const companyName =
    explicitName !== '' ? explicitName : deriveCompanyName(boardToken, host).slice(0, MAX_COMPANY_NAME_LENGTH);
  const websiteUrl = (input.websiteUrl ?? '').trim();

  return {
    ok: true,
    row: {
      slug: companySlug(companyName, host),
      companyName,
      websiteUrl: websiteUrl === '' ? null : websiteUrl,
      industries: input.industries ?? null,
      pageUrl: rawUrl,
      host,
      provider,
      boardToken,
      tier: provider === null ? 3 : 1,
      registrySource: manifest.id,
      registryLicense: manifest.license,
      registrySourceRef: input.sourceRef,
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal quoted-CSV record parser (zero deps). Handles quoted fields with
// embedded commas/doubled quotes; strips a trailing CR (CRLF datasets).
// ---------------------------------------------------------------------------

export function parseCsvRecord(line: string): string[] {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

// ---------------------------------------------------------------------------
// Batched idempotent apply over an injected store.
// ---------------------------------------------------------------------------

export interface CompanyCreateInput {
  name: string;
  websiteUrl: string | null;
  industries: string[] | null;
  registrySource: string;
  registryLicense: string;
  registrySourceRef: string;
}

/** ONLY these Company fields may refresh on re-import (STEP 10). */
export interface CompanyRefreshInput {
  name: string;
  websiteUrl: string | null;
  industries: string[] | null;
}

export interface CareerPageCreateInput {
  host: string;
  provider: string | null;
  boardToken: string | null;
  tier: number;
}

export interface RegistryStore {
  upsertCompany(args: {
    slug: string;
    create: CompanyCreateInput;
    refresh: CompanyRefreshInput;
  }): Promise<{ id: string; created: boolean }>;
  /**
   * Create the page when the URL is new; otherwise a NO-OP update so
   * isActive and every verification field are preserved (STEP 10).
   */
  upsertCareerPage(args: {
    url: string;
    companyId: string;
    create: CareerPageCreateInput;
  }): Promise<{ created: boolean }>;
}

export interface SkippedRow {
  ref: string;
  reason: string;
}

export interface ImportStats {
  rowsSeen: number;
  companiesCreated: number;
  companiesMatched: number;
  pagesCreated: number;
  pagesMatched: number;
  skipped: SkippedRow[];
}

export function emptyStats(): ImportStats {
  return {
    rowsSeen: 0,
    companiesCreated: 0,
    companiesMatched: 0,
    pagesCreated: 0,
    pagesMatched: 0,
    skipped: [],
  };
}

export function mergeStats(into: ImportStats, extra: ImportStats): ImportStats {
  into.rowsSeen += extra.rowsSeen;
  into.companiesCreated += extra.companiesCreated;
  into.companiesMatched += extra.companiesMatched;
  into.pagesCreated += extra.pagesCreated;
  into.pagesMatched += extra.pagesMatched;
  into.skipped.push(...extra.skipped);
  return into;
}

export interface ImportOptions {
  batchSize?: number;
  onProgress?: (done: number, stats: ImportStats) => void;
}

/**
 * Apply prepared rows idempotently in bounded batches. Natural keys:
 * Company.slug, CompanyCareerPage.url. A resumed run re-matches the same
 * keys and creates nothing new.
 */
export async function importPrepared(
  store: RegistryStore,
  rows: PreparedRow[],
  opts: ImportOptions = {},
): Promise<ImportStats> {
  const batchSize = opts.batchSize ?? IMPORT_BATCH_SIZE;
  const stats = emptyStats();
  let done = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const row of batch) {
      stats.rowsSeen += 1;
      const company = await store.upsertCompany({
        slug: row.slug,
        create: {
          name: row.companyName,
          websiteUrl: row.websiteUrl,
          industries: row.industries,
          registrySource: row.registrySource,
          registryLicense: row.registryLicense,
          registrySourceRef: row.registrySourceRef,
        },
        refresh: {
          name: row.companyName,
          websiteUrl: row.websiteUrl,
          industries: row.industries,
        },
      });
      if (company.created) stats.companiesCreated += 1;
      else stats.companiesMatched += 1;
      const page = await store.upsertCareerPage({
        url: row.pageUrl,
        companyId: company.id,
        create: {
          host: row.host,
          provider: row.provider,
          boardToken: row.boardToken,
          tier: row.tier,
        },
      });
      if (page.created) stats.pagesCreated += 1;
      else stats.pagesMatched += 1;
    }
    done += batch.length;
    opts.onProgress?.(done, stats);
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Dry-run summary (pure; writes nothing).
// ---------------------------------------------------------------------------

export interface DryRunSummary {
  total: number;
  byProvider: Record<string, number>;
  byTier: Record<string, number>;
}

export function summarize(rows: PreparedRow[]): DryRunSummary {
  const byProvider: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  for (const row of rows) {
    const provider = row.provider ?? '(unknown)';
    byProvider[provider] = (byProvider[provider] ?? 0) + 1;
    const tier = `tier-${row.tier}`;
    byTier[tier] = (byTier[tier] ?? 0) + 1;
  }
  return { total: rows.length, byProvider, byTier };
}
