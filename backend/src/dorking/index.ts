// Dorking execution (Wave 5, T702): runs T701's expanded queries through the
// EXISTING search backend and returns index-labelled rows.
//
// TRANSPORT (task STEP 1): `searchJobs` (`jobSources/search.ts`) is the ONLY
// backend - no new HTTP client, no new provider, no new key (wave 5 SCOPE
// "OUT": no new search-engine backend). The transport is a parameter
// (`RunDorkingOptions.transport`, defaulting to `searchJobs` bound with the
// caller's `userId`) so unit tests run hermetically with a mock and the
// suite never issues live search calls. The default path is pinned by
// `index.test.ts` ("runs through the existing search backend").
//
// N4 PROVENANCE (task STEP 2, ADR-028): every returned row goes through
// `classify` (T661) with `postedAtSource: 'index-date'`, so `postedAt` comes
// back null STRUCTURALLY - the module never hand-writes the date fields.
// Even when the backend hands back a row carrying a date claim, the
// index-date class wins and the date is dropped (asserted in
// `index.test.ts`). The template id that produced the row is carried in
// `dorkProvenance`, as is the ATS hint below. `postedAtRaw` keeps the
// backend's verbatim signal untouched (audit-only, never parsed).
//
// ATS-HOST RULE (wave spec EDGE CASES): a result whose URL sits on a known
// ATS host (via `extractAts`, the ONE host table) is labelled with that
// provider hint in `dorkProvenance.atsProvider`, but `postedAtSource`
// REMAINS `'index-date'` - the index found it, it did not post it.
//
// ABUSE GUARDS (task STEP 3, wave spec CONSTRAINTS): a 429 marks THAT query
// failed and is NEVER retried within the run; a 5xx retries AT MOST ONCE
// after a bounded delay (`DORK_RETRY_DELAY_MS`); any other error marks the
// query failed with no retry. There is no alternate-identity logic, no
// alternate-egress logic, no challenge-solving, and no limit-evasion logic
// anywhere in this module (asserted structurally in `index.test.ts`).
//
// FAILURE ISOLATION (task STEP 1, consistent with T622): a failing query
// marks that query failed in the returned snapshot and the remaining
// queries CONTINUE. A whole-family failure surfaces as failed attempts, not
// a healthy zero - `failedQueries` counts them for the caller.
//
// N3 GUARANTEE (task STEP 5 - obligation on wave 7's orchestrator, T742):
// dorking is a board type a user configures, exactly like `scraper`. It
// MUST always run as one unit AMONG the user's other boards - it never
// replaces, suppresses, or short-circuits another board, and the wave-7
// orchestrator must schedule every other configured board alongside it
// (with the deep-mode report stating how many non-dorking sources ran).
// What this module guarantees, and what `index.test.ts` asserts:
//   1. `runDorking` only reads the search intent plus its own options - it
//      has no handle on the user's other boards and cannot read, filter,
//      or disable them (its imports are expand/provenance/host-table/
//      search-backend only).
//   2. Its output is purely additive: dorked rows carry `source: 'dorking'`
//      and merge with other providers' rows by concatenation - merging
//      never drops, rewrites, or replaces a non-dorking row.
//   3. The `dorking` descriptor (`providerRegistry.ts`) carries no
//      `suppresses`/`exclusive` field of any kind.

import { expand } from './expand.js';
import type { DorkQuery, SearchIntent } from './expand.js';
import { classify } from '../discovery/provenance.js';
import { extractAts } from '../registry/atsUrl.js';
import { searchJobs } from '../jobSources/search.js';
import type { SearchConfig } from '../jobSources/search.js';
import type { RawJob } from '../jobSources/index.js';

export type { DorkQuery, SearchIntent } from './expand.js';
export { MAX_DORK_QUERIES_PER_RUN, MAX_DORK_RESULTS_PER_QUERY } from './expand.js';

// The source id every dorked row emits. Registered additively (N1) in
// `providerRegistry.ts` (`sourceIds: ['dorking']`, `kind: 'search'`).
export const DORKING_SOURCE_ID = 'dorking';

// Bounded delay before the single permitted 5xx retry (task STEP 3).
// Overridable per-call via `RunDorkingOptions.retryDelayMs` so tests stay
// instant without weakening the production bound.
export const DORK_RETRY_DELAY_MS = 500;

// Total attempts per query: 1 initial + AT MOST 1 retry (5xx only).
const MAX_DORK_ATTEMPTS = 2;

// A status is retryable only when it is a 5xx. 429s and unknown errors are
// never retried within the run.
function isRetryableStatus(status: number | undefined): boolean {
  return status !== undefined && status >= 500 && status <= 599;
}

// The backend reports failures as thrown Errors whose message carries the
// HTTP status (`Tavily search failed: 429`, `Exa search failed: 503` - see
// `jobSources/search.ts`). A transport may instead throw an object carrying
// a numeric `status`/`statusCode`. Either shape resolves here; anything
// else is an unknown error (no retry).
function statusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    for (const key of ['status', 'statusCode'] as const) {
      const value: unknown = (err as Record<string, unknown>)[key];
      if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 400 &&
        value <= 599
      ) {
        return value;
      }
    }
  }
  const text = err instanceof Error ? err.message : String(err);
  const match = /\b([45]\d{2})\b/.exec(text);
  return match ? Number(match[1]) : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Pluggable search transport: the existing backend behind an injectable
// seam. Production passes nothing (defaults to `searchJobs`); tests inject
// a mock. No live search calls ever run in the suite.
export type DorkSearchTransport = (
  config: SearchConfig,
) => Promise<RawJob[]>;

export interface RunDorkingOptions {
  userId?: string;
  families?: string[];
  // Test seam + wave-7 seam: defaults to the existing `searchJobs` backend
  // bound with `userId`. Never a new client, key, or provider.
  transport?: DorkSearchTransport;
  // Bounded 5xx-retry delay override (tests pass 0). Defaults to
  // `DORK_RETRY_DELAY_MS`.
  retryDelayMs?: number;
}

// Provenance payload carried on every dorked row: the template id that
// produced it (wave 7/10 display) plus the ATS hint (`null` when the result
// URL is not a known ATS host).
export interface DorkProvenance {
  readonly templateId: string;
  readonly atsProvider: string | null;
}

// A dorked row: a `RawJob` stamped `index-date` (via `classify`, never by
// hand) and labelled with its provenance payload.
export interface DorkedJob extends RawJob {
  dorkProvenance: DorkProvenance;
}

// Per-query outcome for the caller's run snapshot (task STEP 1): a failed
// query is recorded here with its attempt count and error, never thrown.
export interface DorkQueryAttempt {
  readonly query: DorkQuery;
  readonly status: 'ok' | 'failed';
  readonly attempts: number;
  readonly error?: string;
  readonly jobs: DorkedJob[];
}

export interface DorkRunSnapshot {
  readonly queries: DorkQuery[];
  readonly attempts: DorkQueryAttempt[];
  readonly jobs: DorkedJob[];
  // Cap accounting from `expand` (never silent truncation).
  readonly dropped: number;
  readonly truncated: number;
  // A whole-family failure surfaces as failed attempts, not a healthy zero.
  readonly failedQueries: number;
}

function dorkExternalId(
  basis: string,
  templateId: string,
  index: number,
): string {
  const digest = Buffer.from(basis)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 16);
  return `dorking-${templateId}-${index}-${digest}`;
}

// Stamp one backend row as a dorked row. The date pair comes out of
// `classify` with the `index-date` class (N4 null invariant: `postedAt` is
// null even when the backend row carried a date claim). `postedAtRaw` keeps
// the backend's verbatim signal for audit.
function stampRow(
  row: RawJob,
  templateId: string,
  index: number,
): DorkedJob {
  const dated = classify({
    postedAt: row.postedAt,
    postedAtSource: 'index-date',
  });
  const href = row.sourceUrl || row.applyUrl || '';
  return {
    externalId: dorkExternalId(
      row.externalId || href || row.title || `${templateId}:${index}`,
      templateId,
      index,
    ),
    source: DORKING_SOURCE_ID,
    sourceUrl: row.sourceUrl,
    title: row.title || 'Untitled Role',
    company: row.company || 'Unknown',
    location: row.location,
    description: row.description ?? '',
    applyUrl: row.applyUrl,
    postedAt: dated.postedAt,
    postedAtSource: dated.postedAtSource,
    postedAtRaw: row.postedAtRaw,
    dorkProvenance: {
      templateId,
      atsProvider: extractAts(href).provider,
    },
  };
}

async function runOneQuery(
  query: DorkQuery,
  transport: DorkSearchTransport,
  retryDelayMs: number,
): Promise<DorkQueryAttempt> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const rows = await transport({
        query: query.q,
        site: query.site,
        maxResults: query.maxResults,
      });
      const jobs = (Array.isArray(rows) ? rows : []).map((row, index) =>
        stampRow(row, query.templateId, index),
      );
      return { query, status: 'ok', attempts, jobs };
    } catch (err) {
      const status = statusOf(err);
      if (isRetryableStatus(status) && attempts < MAX_DORK_ATTEMPTS) {
        await delay(retryDelayMs);
        continue;
      }
      // 429s, unknown errors, and a twice-failed 5xx land here: the query
      // is marked failed and the run continues with the rest.
      return { query, status: 'failed', attempts, error: messageOf(err), jobs: [] };
    }
  }
}

// Full run with a per-query snapshot for the caller (wave 7 orchestrator).
// Queries come from `expand` (bounded by `MAX_DORK_QUERIES_PER_RUN` /
// `MAX_DORK_RESULTS_PER_QUERY`); one query's failure never aborts the rest.
export async function runDorkingDetailed(
  intent: SearchIntent,
  opts?: RunDorkingOptions,
): Promise<DorkRunSnapshot> {
  const expansion = expand(intent, { families: opts?.families });
  const transport: DorkSearchTransport =
    opts?.transport ?? ((config) => searchJobs(config, opts?.userId));
  const retryDelayMs = opts?.retryDelayMs ?? DORK_RETRY_DELAY_MS;
  const attempts: DorkQueryAttempt[] = [];
  const jobs: DorkedJob[] = [];
  for (const query of expansion.queries) {
    const attempt = await runOneQuery(query, transport, retryDelayMs);
    attempts.push(attempt);
    jobs.push(...attempt.jobs);
  }
  return {
    queries: expansion.queries,
    attempts,
    jobs,
    dropped: expansion.dropped,
    truncated: expansion.truncated,
    failedQueries: attempts.filter((a) => a.status === 'failed').length,
  };
}

// Task STEP 1 entry point: expanded queries -> candidates with provenance.
// `DorkedJob[]` is a `RawJob[]` subtype, so this satisfies the specified
// `Promise<RawJob[]>` shape while keeping the provenance payload visible.
export async function runDorking(
  intent: SearchIntent,
  opts?: RunDorkingOptions,
): Promise<DorkedJob[]> {
  return (await runDorkingDetailed(intent, opts)).jobs;
}
