// Keyed probe of the RapidAPI job-search endpoints behind the open live-shape
// questions (gates T321/T322/T323 + ADR-018). BYOK: the key is read ONLY from
// the `RAPIDAPI_PROBE_KEY` environment variable - never from argv, never from
// a file - and is never printed or logged (only status codes, bounded message
// text, and key NAMES are reported).
//
// User-run (no key exists in CI or in this repo):
//   PowerShell (key lives only in this shell session):
//     $env:RAPIDAPI_PROBE_KEY = 'PASTE_KEY_HERE'
//     cd backend; npx tsx scripts/probe-rapidapi.ts
//     Remove-Item Env:RAPIDAPI_PROBE_KEY   # clear immediately afterwards
//   bash/zsh: export RAPIDAPI_PROBE_KEY='...'; <run>; unset RAPIDAPI_PROBE_KEY
//
// With no RAPIDAPI_PROBE_KEY in the environment the script prints the
// "probe owed" line and exits 0 WITHOUT any network request.
// Output: one JSON line per probe, then a SUMMARY line. Exit 0 even when
// endpoints fail (it is a report). Paste the output into
// .planning/progress/T320-rapidapi-probe.md.

const TIMEOUT_MS = 15_000;
const MAX_MESSAGE_CHARS = 200;

interface ProbeDef {
  name: string;
  host: string;
  path: string;
  params: Record<string, string>;
}

const PROBES: ProbeDef[] = [
  {
    name: 'jsearch',
    host: 'jsearch.p.rapidapi.com',
    path: '/search-v2',
    params: { query: 'software engineer in remote', num_pages: '1', date_posted: 'month' },
  },
  {
    name: 'jsearch_old',
    host: 'jsearch.p.rapidapi.com',
    path: '/search',
    params: { query: 'software engineer', num_pages: '1' },
  },
  {
    name: 'pat92_old',
    host: 'jobs-api12.p.rapidapi.com',
    path: '/v1/getJobData',
    params: { query: 'software engineer' },
  },
  {
    name: 'pat92_new',
    host: 'jobs-api14.p.rapidapi.com',
    path: '/v2/linkedin/search',
    params: { query: 'software engineer', location: 'Worldwide', datePosted: 'month' },
  },
  {
    name: 'pat92_indeed',
    host: 'jobs-api14.p.rapidapi.com',
    path: '/v2/indeed/search',
    params: { query: 'software engineer', location: 'Worldwide' },
  },
  {
    name: 'pull_linkedin',
    host: 'linkedin-scraper-api6.p.rapidapi.com',
    path: '/linkedin/jobs',
    params: { keywords: 'software engineer', page: '1' },
  },
  {
    name: 'pull_indeed',
    host: 'indeed-scraper-api2.p.rapidapi.com',
    path: '/indeed/search',
    params: { query: 'software engineer', page: '1' },
  },
];

interface ProbeLine {
  name: string;
  host: string;
  path: string;
  httpStatus: number | null;
  rowCount: number | null;
  topLevelKeys: string[] | null;
  rowsPath: string | null;
  firstRowKeys: string[] | null;
  message: string | null;
  urlKeysFound?: string[];
}

function bound(text: string): string {
  return text.slice(0, MAX_MESSAGE_CHARS);
}

function boundError(err: unknown): string {
  return bound(err instanceof Error ? err.message : String(err));
}

function buildUrl(host: string, path: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `https://${host}${path}${qs ? `?${qs}` : ''}`;
}

function keysOf(value: unknown): string[] | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>);
  }
  return null;
}

/** Detect the job-row array inside a 2xx body. Returns rows + the path used. */
function findRows(body: unknown): { rows: unknown[]; path: string } | null {
  if (Array.isArray(body)) return { rows: body, path: '(root)' };
  if (body !== null && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj['data'])) return { rows: obj['data'] as unknown[], path: 'data' };
    if (obj['data'] !== null && typeof obj['data'] === 'object') {
      const data = obj['data'] as Record<string, unknown>;
      if (Array.isArray(data['jobs'])) return { rows: data['jobs'] as unknown[], path: 'data.jobs' };
    }
    if (Array.isArray(obj['jobs'])) return { rows: obj['jobs'] as unknown[], path: 'jobs' };
    if (Array.isArray(obj['results'])) return { rows: obj['results'] as unknown[], path: 'results' };
  }
  return null;
}

async function probeOne(key: string, def: ProbeDef): Promise<ProbeLine> {
  const url = buildUrl(def.host, def.path, def.params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': def.host },
      signal: controller.signal,
    });
    if (!res.ok) {
      let message: string;
      try {
        const body: unknown = await res.json();
        const msg =
          body !== null && typeof body === 'object'
            ? (body as { message?: unknown }).message
            : null;
        message =
          typeof msg === 'string' && msg.length > 0 ? bound(msg) : bound(await res.text());
      } catch {
        try {
          message = bound(await res.text());
        } catch (err) {
          message = boundError(err);
        }
      }
      if (message.length === 0) message = `HTTP ${res.status}`;
      return {
        name: def.name,
        host: def.host,
        path: def.path,
        httpStatus: res.status,
        rowCount: null,
        topLevelKeys: null,
        rowsPath: null,
        firstRowKeys: null,
        message,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return {
        name: def.name,
        host: def.host,
        path: def.path,
        httpStatus: res.status,
        rowCount: null,
        topLevelKeys: null,
        rowsPath: null,
        firstRowKeys: null,
        message: boundError(err),
      };
    }
    const found = findRows(body);
    const first = found !== null && found.rows.length > 0 ? found.rows[0] : null;
    return {
      name: def.name,
      host: def.host,
      path: def.path,
      httpStatus: res.status,
      rowCount: found !== null ? found.rows.length : null,
      topLevelKeys: keysOf(body),
      rowsPath: found !== null ? found.path : null,
      firstRowKeys: first !== null && first !== undefined ? keysOf(first) : null,
      message: null,
    };
  } catch (err) {
    return {
      name: def.name,
      host: def.host,
      path: def.path,
      httpStatus: null,
      rowCount: null,
      topLevelKeys: null,
      rowsPath: null,
      firstRowKeys: null,
      message: boundError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADR-018 follow-up: if PullAPI /indeed/search returns rows whose first row
 * carries a `job_key`, fetch /indeed/job for it and report whether the detail
 * row contains any job_url/url/apply_url KEY (names only). Expected: none.
 */
async function probeIndeedDetail(key: string, search: ProbeLine): Promise<ProbeLine | null> {
  if (search.httpStatus === null || search.httpStatus < 200 || search.httpStatus >= 300) return null;
  if (search.firstRowKeys === null || !search.firstRowKeys.includes('job_key')) return null;
  // Re-fetch the search body to recover the job_key VALUE locally (never printed).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      buildUrl('indeed-scraper-api2.p.rapidapi.com', '/indeed/search', PROBES[6].params),
      {
        headers: {
          'x-rapidapi-key': key,
          'x-rapidapi-host': 'indeed-scraper-api2.p.rapidapi.com',
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const found = findRows(body);
    if (found === null || found.rows.length === 0) return null;
    const first = found.rows[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) return null;
    const row = first as Record<string, unknown>;
    if (typeof row['job_key'] !== 'string' || (row['job_key'] as string).length === 0) return null;
    const detail = await probeOne(key, {
      name: 'pull_indeed_detail',
      host: 'indeed-scraper-api2.p.rapidapi.com',
      path: '/indeed/job',
      params: { job_key: row['job_key'] as string },
    });
    const urlKeys = (detail.firstRowKeys ?? []).filter((k) =>
      ['job_url', 'url', 'apply_url'].includes(k),
    );
    detail.urlKeysFound = urlKeys;
    return detail;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function printUsage(): void {
  console.log('Usage: npx tsx scripts/probe-rapidapi.ts');
  console.log('Env: RAPIDAPI_PROBE_KEY only (never argv, never a file).');
  console.log('No key -> prints the probe-owed line and exits 0 with no network call.');
  console.log('Clear the variable right after the run (PowerShell: Remove-Item Env:RAPIDAPI_PROBE_KEY).');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  if (args.some((a) => a.startsWith('--key') || a.startsWith('key='))) {
    console.error('refused: pass the key via RAPIDAPI_PROBE_KEY env only, never as an argument');
    process.exitCode = 2;
    return;
  }
  const key = process.env['RAPIDAPI_PROBE_KEY'] ?? '';
  if (key.trim().length === 0) {
    console.log('probe owed: no RAPIDAPI_PROBE_KEY in this environment');
    return;
  }
  const lines: ProbeLine[] = [];
  for (const def of PROBES) {
    // Sequential: stay polite to the metered RapidAPI endpoints.
    lines.push(await probeOne(key, def));
  }
  const indeedSearch = lines.find((l) => l.name === 'pull_indeed');
  if (indeedSearch !== undefined) {
    const detail = await probeIndeedDetail(key, indeedSearch);
    if (detail !== null) lines.push(detail);
  }
  for (const line of lines) {
    console.log(JSON.stringify(line));
  }
  const ok = lines.filter(
    (l) => l.httpStatus !== null && l.httpStatus >= 200 && l.httpStatus < 300,
  ).length;
  console.log(`SUMMARY: probed ${lines.length}, 2xx ${ok}, non-2xx ${lines.length - ok}`);
}

void main();
