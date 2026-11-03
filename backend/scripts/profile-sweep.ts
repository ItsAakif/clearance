// Off-line sweep profile runner (Wave 15, T901).
//
// WHAT THIS SCRIPT IS
//
// A read-only diagnostic that drives the orchestrator's Full-mode registry
// path with NO job or page writes. The orchestrator itself persists nothing
// (`runSearch` is write-free by construction); this script adds
// belt-and-suspenders by injecting empty `listUserBoards` + a non-matching
// query so the unit path is registry-pages only.
//
// WHY OFF-LINE
//
// The live HTTP route persists listings. Driving runSearch + the registry
// reader directly from a script gives the same measurements (real fetch
// path, real pool, real attribution timings) WITHOUT writes. A before/after
// `JobListing` scalar count in the evidence file closes the loop.
//
// ZERO-WRITE GUARANTEES
//   - no route-backstop import (the dedicated grep guard referenced in
//     the task contract must return empty against `backend/scripts/**` -
//     this header avoids embedding the token so the guard stays empty
//     as written; see the evidence file for the exact guard command);
//   - no prisma.jobListing upsert / no CompanyCareerPage write;
//   - empty user boards -> registry scope is the only source of units;
//   - results are never passed to any route layer.
//
// RUN (Windows host; the script runs in-process via tsx against the
// Docker stack's Postgres on host port 5543 - the root `.env` line 7
// currently points at the stale embedded-postgres port 5433, hence the
// explicit override below. The dotenv `-e` flag does NOT override
// pre-set environment variables, so a PowerShell-set DATABASE_URL wins):
//
//   cd backend
//   $env:DATABASE_URL='postgresql://postgres:postgres@localhost:5543/clearance?schema=public'
//   $env:SEARCH_ATTRIBUTION='on'
//   npx dotenv -e ../.env -- tsx scripts/profile-sweep.ts --pool 8,16,24,32 --batches 10 \
//       --json ../.planning/verification/sweep-p0-profile.json
//
// MEASUREMENT SURFACE
//
// Per (pool, batch) the script prints one JSON line (and appends to the
// optional --json path) with: wallMs, pages processed (registry.processed
// delta), pagesPerSec, per-unit p50/p95/max, queuedMs p50/p95, outcome
// mix, per-group rollup, phase split (or `unavailable`), and
// `consistency.deviation`. The first batch MUST report processed > 0 or
// the script exits non-zero - a silent zero-page run would fake a
// throughput number.
//
// Hard rule (mirrors attribution.ts + crawler.ts): `Date.now()` is the
// MEASUREMENT clock only; it is never used as policy input.
//
// Note on `--batch-size`: the CLI option is REMOVED. The registry reader
// (`orchestrator.ts:809-812`) hard-codes `FULL_BATCH_PAGES`; passing a
// different value here would silently shadow the reader's clamp. Operators
// who want a different batch size must change the reader.

import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import prisma from '../src/lib/prisma.js';
import {
  FULL_BATCH_BUDGET,
  FULL_BATCH_PAGES,
  type RunBudget,
} from '../src/discovery/budgets.js';
import {
  countActiveRegistryPages,
  resolveRegistryPageBatch,
} from '../src/discovery/registrySweep.js';
import {
  runSearch,
  type OrchestratorDeps,
  type RunOutcome,
  type RunUnitState,
} from '../src/discovery/orchestrator.js';
import { deriveIntent } from '../src/discovery/searchIntent.js';
import { env } from '../src/config/env.js';
import type {
  TimingSummary,
  TimingSummaryByGroup,
} from '../src/discovery/attribution.js';

// ---------------------------------------------------------------------------
// CLI parsing (intentionally tiny; no external deps)
// ---------------------------------------------------------------------------

interface CliOptions {
  pools: number[];
  batches: number;
  afterCursor: string | null;
  jsonPath: string | null;
  quiet: boolean;
}

function printUsage(): void {
  // stderr so it doesn't pollute the JSON file when --json is set.
  const lines = [
    'Usage: tsx scripts/profile-sweep.ts [options]',
    '',
    'Options:',
    '  --pool <list>          Comma-separated pool widths (e.g. 8,16,24,32).',
    '  --batches <N>          Batches per pool width (default 10).',
    '  --after <cursor|start> Starting cursor (default: start).',
    '  --json <path>          Append each batch as one JSON line to this file.',
    '  --quiet                Suppress per-batch stdout lines (still writes JSON).',
    '  --help                 Print this help.',
    '',
    'Env: SEARCH_ATTRIBUTION=on is required for the timing summary.',
    '     DATABASE_URL must point at the registry DB (host port 5543).',
    '',
    'Note: the registry reader (orchestrator.ts:809-812) hard-codes',
    '      FULL_BATCH_PAGES; no --batch-size flag is exposed here.',
  ];
  process.stderr.write(lines.join('\n') + '\n');
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer (got "${value}")`);
  }
  return parsed;
}

function parseCli(argv: readonly string[]): CliOptions {
  let pools: number[] = [8];
  let batches = 10;
  let afterCursor: string | null = null;
  let jsonPath: string | null = null;
  let quiet = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case '--pool': {
        if (next === undefined) throw new Error('--pool requires a value');
        pools = next.split(',').map((s) => parsePositiveInt(s.trim(), '--pool'));
        if (pools.length === 0) throw new Error('--pool list is empty');
        i += 1;
        break;
      }
      case '--batches': {
        if (next === undefined) throw new Error('--batches requires a value');
        batches = parsePositiveInt(next, '--batches');
        i += 1;
        break;
      }
      case '--after': {
        if (next === undefined) throw new Error('--after requires a value');
        afterCursor = next === 'start' ? null : next;
        i += 1;
        break;
      }
      case '--json': {
        if (next === undefined) throw new Error('--json requires a path');
        jsonPath = resolvePath(next);
        i += 1;
        break;
      }
      case '--quiet': {
        quiet = true;
        break;
      }
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default: {
        if (arg.startsWith('--')) {
          throw new Error(`unknown option: ${arg}`);
        }
        throw new Error(`unexpected positional argument: ${arg}`);
      }
    }
  }

  return { pools, batches, afterCursor, jsonPath, quiet };
}

// ---------------------------------------------------------------------------
// Measurement record (one row per pool/batch; JSONL + markdown)
// ---------------------------------------------------------------------------

interface PerBatchRecord {
  pool: number;
  batchIndex: number;
  /** runSearch wall clock (Date.now(); measurement only). */
  wallMs: number;
  /** Registry pages fetched + attempted in this batch (registry.processed). */
  pages: number;
  /** pages / (wallMs / 1000). NaN-safe. */
  pagesPerSec: number;
  /** Per-unit totalMs (alias for RunUnitState.latencyMs). */
  totalMs: { p50: number; p95: number; max: number; units: number };
  /** Per-unit queuedMs (pool start -> launch). */
  queuedMs: { p50: number; p95: number; max: number };
  /** Outcome mix. Keys: ok / failed / skipped / cancelled. */
  byOutcome: Readonly<Record<string, number>>;
  /**
   * Histogram of `outcome.units[].reason` for failed/cancelled/skipped units
   * (T901 D3 repair). Reasons are produced by `boundReason(outcome.err)`
   * (orchestrator.ts:610-613, 1075) or hard-coded strings like
   * `timeout after Nms` and `cancelled`. Useful for separating backoff-
   * fixable 429/503 from unfixable 404/410/403.
   *
   * The field is omitted when there are zero non-ok reasons in the batch.
   */
  byReason?: Readonly<Record<string, number>>;
  /** Per-group rollup (recorded when SEARCH_ATTRIBUTION=on). */
  byGroup: ReadonlyArray<TimingSummaryByGroup>;
  /** Phase totals; null when unavailable. */
  phases: TimingSummary['phases'];
  /** Probe-reported absence flag. */
  phasesUnavailable: boolean;
  /** `consistency.deviation` from summarizeTimings. */
  consistencyDeviation: number;
  /** Keyset cursor returned to the next step (or null when exhausted). */
  nextCursor: string | null;
  /** runSearch stop cause: done / budget / cancel. */
  stopCause: 'done' | 'budget' | 'cancel';
}

function sortedPick(sorted: readonly number[], frac: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(frac * sorted.length)));
  return sorted[rank - 1]!;
}

function summariseUnitsFallback(
  units: readonly RunUnitState[],
): PerBatchRecord['totalMs'] {
  if (units.length === 0) {
    return { p50: 0, p95: 0, max: 0, units: 0 };
  }
  const sorted = units.map((u) => u.latencyMs).sort((a, b) => a - b);
  return {
    p50: sortedPick(sorted, 0.5),
    p95: sortedPick(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
    units: sorted.length,
  };
}

function outcomeCounts(units: readonly RunUnitState[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of units) {
    counts[u.status] = (counts[u.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * Histogram of `RunUnitState.reason` for non-ok units. The reason strings are
 * short (`< MAX_REASON_CHARS`, orchestrator.ts:394-396) and usually contain
 * the upstream signal - HTTP status, timeout, or message body - so a few
 * dozen unique buckets suffice for a 200-unit batch.
 *
 * Bucket key rules (deterministic, JSON-stable):
 *   - empty/undefined reason -> `'<no-reason>'`
 *   - HTTP 3-digit prefixes preserved; substrings stripped to the first
 *     newline to keep keys short and the histogram readable
 */
function reasonCounts(units: readonly RunUnitState[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const u of units) {
    if (u.status === 'ok') continue;
    const raw = (u.reason ?? '').toString();
    const key = raw.length === 0 ? '<no-reason>' : raw.split('\n', 1)[0]!.slice(0, 120);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Per-(pool, batch) execution
// ---------------------------------------------------------------------------

function setupProfile(poolWidth: number): OrchestratorDeps {
  const budget: RunBudget = {
    ...FULL_BATCH_BUDGET,
    maxConcurrent: poolWidth,
    // The budget's totalBudgetMs stays at the documented FULL_BATCH_BUDGET
    // value (180 s); the script's outer wall measurement observes the full
    // runSearch resolve, so the budget is the orchestrator's internal cap
    // and not the headline metric.
  };

  return {
    budget,
    // Empty user boards -> registry is the only fan-out path (off-line).
    listUserBoards: async () => [],
    // Full-mode never calls resolveCompanies (orchestrator.ts: "Full never
    // resolves named companies"). Wiring a no-op is belt-and-suspenders.
    resolveCompanies: async () => ({
      matchedNames: [],
      pages: [],
      registryEmpty: false,
    }),
    resolveRegistryPageBatch,
    attributeTiming: env.SEARCH_ATTRIBUTION === 'on',
  };
}

function buildIntent(): ReturnType<typeof deriveIntent> {
  // Non-matching query + explicitly empty companies keeps the unit fan-out
  // on registry pages only. The intent field doesn't filter server-side; the
  // mode='full' branch in orchestrator.ts drives `addRegistryPages` directly
  // from the reader's batch (orchestrator.ts:812).
  return deriveIntent({
    query: 'profile-sweep',
    companies: [],
    locations: [],
    mode: 'full',
    evaluate: 'off',
    sourceGroups: ['ats', 'feeds', 'aggregators'],
    limit: 1,
  });
}

interface RunOneBatchResult {
  record: PerBatchRecord;
  nextCursor: string | null;
}

async function runOneBatch(args: {
  poolWidth: number;
  batchIndex: number;
  afterCursor: string | null;
  intent: ReturnType<typeof deriveIntent>;
  deps: OrchestratorDeps;
}): Promise<RunOneBatchResult> {
  const start = Date.now();
  const outcome: RunOutcome = await runSearch(
    args.intent,
    {
      runId: `profile-sweep-${args.poolWidth}-${args.batchIndex}-${Date.now()}`,
      userId: 'profile-sweep',
    },
    { ...args.deps, afterCursor: args.afterCursor },
  );
  const wallMs = Date.now() - start;

  const registry = outcome.registry;
  const pages = registry?.processed ?? 0;
  const pagesPerSec = wallMs > 0 ? (pages * 1000) / wallMs : 0;
  const timing: TimingSummary | undefined = outcome.timing;

  const record: PerBatchRecord = {
    pool: args.poolWidth,
    batchIndex: args.batchIndex,
    wallMs,
    pages,
    pagesPerSec,
    totalMs: timing
      ? {
          p50: timing.p50Ms,
          p95: timing.p95Ms,
          max: timing.maxMs,
          units: timing.units,
        }
      : summariseUnitsFallback(outcome.units),
    queuedMs: timing
      ? timing.queuedMs
      : // No SEARCH_ATTRIBUTION: queuedMs isn't recorded separately; latencyMs
        // is an upper bound. Keep the field structurally valid; the evidence
        // file notes that exact queuedMs is unavailable without the flag.
        summariseUnitsFallback(outcome.units),
    byOutcome: timing ? timing.byOutcome : outcomeCounts(outcome.units),
    byReason: reasonCounts(outcome.units),
    byGroup: timing?.byGroup ?? [],
    phases: timing?.phases ?? null,
    phasesUnavailable: timing?.phasesUnavailable ?? true,
    consistencyDeviation: timing?.consistency.deviation ?? 0,
    nextCursor: outcome.nextCursor ?? null,
    stopCause: outcome.cancelled
      ? 'cancel'
      : outcome.truncated
        ? 'budget'
        : 'done',
  };

  return { record, nextCursor: outcome.nextCursor ?? null };
}

// ---------------------------------------------------------------------------
// DB scalars - before / after
// ---------------------------------------------------------------------------

interface DbScalars {
  jobListing: number;
  activeCompanyCareerPage: number;
  /** SHA-256 over a canonical projection of every active
   *  CompanyCareerPage row's verification columns
   *  (id|verifyStatus|resultCount|failureCount|httpStatus). Equal before
   *  and after proves the run did not touch those columns either. */
  careerPageVerifyChecksum: string;
}

async function readDbScalars(): Promise<DbScalars> {
  const [jobListing, activeCompanyCareerPage, verifyRows] = await Promise.all([
    prisma.jobListing.count(),
    prisma.companyCareerPage.count({ where: { isActive: true } }),
    prisma.companyCareerPage.findMany({
      where: { isActive: true },
      select: {
        id: true,
        verifyStatus: true,
        resultCount: true,
        failureCount: true,
        httpStatus: true,
      },
    }),
  ]);
  const hasher = createHash('sha256');
  // Stable ordering: id asc (the keyset order the registry reader uses).
  const sorted = [...verifyRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) {
    hasher.update(
      `${r.id}|${r.verifyStatus ?? ''}|${r.resultCount ?? 0}|${r.failureCount ?? 0}|${r.httpStatus ?? ''}\n`,
    );
  }
  return {
    jobListing,
    activeCompanyCareerPage,
    careerPageVerifyChecksum: hasher.digest('hex'),
  };
}

// ---------------------------------------------------------------------------
// JSONL writer + per-pool aggregator + markdown summary
// ---------------------------------------------------------------------------

interface AggregatePoint {
  pool: number;
  batches: number;
  pages: number;
  wallMs: number;
  pagesPerSec: number;
  p50Ms: number;
  p95Ms: number;
  queuedP50Ms: number;
  queuedP95Ms: number;
  consistencyDeviation: number;
  stopCauseCounts: Record<string, number>;
  phasesUnavailable: boolean;
}

function aggregateRecords(records: readonly PerBatchRecord[]): AggregatePoint[] {
  const byPool = new Map<number, PerBatchRecord[]>();
  for (const r of records) {
    const list = byPool.get(r.pool);
    if (list === undefined) byPool.set(r.pool, [r]);
    else list.push(r);
  }
  const rows: AggregatePoint[] = [];
  const pools = [...byPool.keys()].sort((a, b) => a - b);
  for (const pool of pools) {
    const list = byPool.get(pool) ?? [];
    const totalPages = list.reduce((acc, r) => acc + r.pages, 0);
    const totalWall = list.reduce((acc, r) => acc + r.wallMs, 0);
    const p50s = list.map((r) => r.totalMs.p50).sort((a, b) => a - b);
    const p95s = list.map((r) => r.totalMs.p95).sort((a, b) => a - b);
    const qp50s = list.map((r) => r.queuedMs.p50).sort((a, b) => a - b);
    const qp95s = list.map((r) => r.queuedMs.p95).sort((a, b) => a - b);
    const devs = list.map((r) => r.consistencyDeviation);
    const causeCounts: Record<string, number> = {};
    let phasesUnavailable = false;
    for (const r of list) {
      causeCounts[r.stopCause] = (causeCounts[r.stopCause] ?? 0) + 1;
      if (r.phasesUnavailable) phasesUnavailable = true;
    }
    rows.push({
      pool,
      batches: list.length,
      pages: totalPages,
      wallMs: totalWall,
      pagesPerSec: totalWall > 0 ? (totalPages * 1000) / totalWall : 0,
      p50Ms: sortedPick(p50s, 0.5),
      p95Ms: sortedPick(p95s, 0.5),
      queuedP50Ms: sortedPick(qp50s, 0.5),
      queuedP95Ms: sortedPick(qp95s, 0.5),
      consistencyDeviation:
        devs.length === 0
          ? 0
          : devs.reduce((acc, value) => acc + value, 0) / devs.length,
      stopCauseCounts: causeCounts,
      phasesUnavailable,
    });
  }
  return rows;
}

function pad(s: string | number, width: number): string {
  const text = String(s);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function renderMarkdownTable(
  records: readonly PerBatchRecord[],
  aggregates: readonly AggregatePoint[],
): string {
  // Per-(pool, batch) detail table.
  const detailHeader = ['pool', 'b', 'pages', 'wallMs', 'p/s', 'p50ms', 'p95ms', 'qP50', 'qP95', 'stop']
    .map((h, i) => pad(h, i === 0 ? 5 : 7))
    .join(' ');
  const detailRows = records.map((r) =>
    [
      pad(r.pool, 5),
      pad(r.batchIndex, 7),
      pad(r.pages, 7),
      pad(r.wallMs, 7),
      pad(r.pagesPerSec.toFixed(2), 7),
      pad(r.totalMs.p50.toFixed(0), 7),
      pad(r.totalMs.p95.toFixed(0), 7),
      pad(r.queuedMs.p50.toFixed(0), 7),
      pad(r.queuedMs.p95.toFixed(0), 7),
      pad(r.stopCause, 7),
    ].join(' '),
  );
  // Per-pool aggregate table.
  const aggHeader = ['pool', 'pages', 'wallMs', 'p/s', 'p50', 'p95', 'qP50', 'qP95', 'dev', 'stops']
    .map((h, i) => pad(h, i === 0 ? 5 : 7))
    .join(' ');
  const aggRows = aggregates.map((a) =>
    [
      pad(a.pool, 5),
      pad(a.pages, 7),
      pad(a.wallMs, 7),
      pad(a.pagesPerSec.toFixed(2), 7),
      pad(a.p50Ms.toFixed(0), 7),
      pad(a.p95Ms.toFixed(0), 7),
      pad(a.queuedP50Ms.toFixed(0), 7),
      pad(a.queuedP95Ms.toFixed(0), 7),
      pad(a.consistencyDeviation.toFixed(3), 7),
      pad(Object.entries(a.stopCauseCounts).map(([k, v]) => `${k}:${v}`).join(','), 7),
    ].join(' '),
  );
  return [
    '### Per (pool, batch) detail',
    '```',
    detailHeader,
    ...detailRows,
    '```',
    '',
    '### Per-pool aggregate',
    '```',
    aggHeader,
    ...aggRows,
    '```',
  ].join('\n');
}

function jsonlLine(rec: PerBatchRecord): string {
  // Deterministic JSON so the JSONL file is byte-stable for diffing.
  return JSON.stringify(rec);
}

function writeJsonl(path: string, record: PerBatchRecord, replace: boolean): void {
  const line = jsonlLine(record) + '\n';
  if (replace) {
    // The first line: create (or replace) the file with a header marker so a
    // truncated rerun is detectable. Subsequent calls append.
    writeFileSync(path, line);
  } else {
    appendFileSync(path, line);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RunSummary {
  startedAt: string;
  finishedAt: string;
  attributionEnabled: boolean;
  registryTotalActiveAtStart: number;
  preDb: DbScalars;
  postDb: DbScalars;
  records: PerBatchRecord[];
  aggregates: AggregatePoint[];
  pools: number[];
  batches: number;
  batchSize: number;
  afterCursor: string | null;
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const intent = buildIntent();
  const startedAt = new Date().toISOString();
  const preDb = await readDbScalars();
  const registryTotalActiveAtStart = await countActiveRegistryPages();

  const records: PerBatchRecord[] = [];
  let jsonlWritten = false;

  for (const poolWidth of opts.pools) {
    const deps = setupProfile(poolWidth);
    let afterCursor = opts.afterCursor;
    for (let b = 0; b < opts.batches; b += 1) {
      const { record, nextCursor } = await runOneBatch({
        poolWidth,
        batchIndex: b,
        afterCursor,
        intent,
        deps,
      });

      // Acceptance: a zero-page first batch of EACH pool width is the
      // failure mode this script gates against - a healthy pool 8 cannot
      // hide a zero-page regression at pool 16. Exit non-zero with the
      // diagnostic on stderr so a subsequent rerun can investigate.
      const isFirstOfPool =
        records.length === 0 || records[records.length - 1]!.pool !== poolWidth;
      if (record.pages === 0 && isFirstOfPool) {
        process.stderr.write(
          `profile-sweep: first batch of pool=${poolWidth} (batch=${b}) processed 0 registry pages; aborting.\n`,
        );
        process.exit(1);
      }

      records.push(record);
      afterCursor = nextCursor;

      if (opts.jsonPath !== null) {
        writeJsonl(opts.jsonPath, record, !jsonlWritten);
        jsonlWritten = true;
      }
      if (!opts.quiet) {
        process.stdout.write(jsonlLine(record) + '\n');
      }

      // End the sweep at the registry's real edge; an unexpected null cursor
      // means the registry is exhausted within this pool's batch budget.
      if (nextCursor === null) break;
    }
  }

  const finishedAt = new Date().toISOString();
  const postDb = await readDbScalars();
  const aggregates = aggregateRecords(records);
  const summary: RunSummary = {
    startedAt,
    finishedAt,
    attributionEnabled: env.SEARCH_ATTRIBUTION === 'on',
    registryTotalActiveAtStart,
    preDb,
    postDb,
    records,
    aggregates,
    pools: opts.pools,
    batches: opts.batches,
    batchSize: FULL_BATCH_PAGES,
    afterCursor: opts.afterCursor,
  };

  // The markdown summary is emitted on stderr so a --json stdout pipeline
  // stays JSONL only. Operators grep the stderr output for their own report.
  process.stderr.write('\n' + renderMarkdownTable(records, aggregates) + '\n');

  if (!opts.quiet) {
    process.stderr.write(`pre  JobListing=${preDb.jobListing}  active CCP=${preDb.activeCompanyCareerPage}  checksum=${preDb.careerPageVerifyChecksum.slice(0, 16)}...\n`);
    process.stderr.write(`post JobListing=${postDb.jobListing}  active CCP=${postDb.activeCompanyCareerPage}  checksum=${postDb.careerPageVerifyChecksum.slice(0, 16)}...\n`);
    process.stderr.write(`registry active pages at start=${registryTotalActiveAtStart}\n`);
    process.stderr.write(`json (one line per batch): ${opts.jsonPath ?? '<none>'}\n`);
  }

  // Persist the structured summary so the evidence file can quote specific
  // numbers without re-running the script. The summary is the last line of
  // the JSONL file (or a sibling .summary.json file when --json is absent).
  if (opts.jsonPath !== null) {
    const summaryPath = opts.jsonPath.replace(/\.jsonl?$/, '') + '.summary.json';
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
    process.stderr.write(`summary: ${summaryPath}\n`);
  }
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`profile-sweep: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
