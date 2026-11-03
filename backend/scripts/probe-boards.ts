// Offline probe of DEFAULT_ATS_BOARDS tokens against the same keyless public
// endpoints the fetchers use. No auth, no secrets, global fetch only.
// Run: cd backend && npx tsx scripts/probe-boards.ts [--fail-on-dead]
// Output: one JSON line per token, then DEAD lines + a PROBED summary line.
// Exit 0 always, unless --fail-on-dead is passed and dead tokens exist.

import { DEFAULT_ATS_BOARDS } from '../src/jobSources/boardCatalog.js';

const USER_AGENT = 'ClearanceJobBot/1.0 (+https://clearance.app)';
const TIMEOUT_MS = 15_000;
const FAIL_ON_DEAD = process.argv.includes('--fail-on-dead');

interface ProbeResult {
  type: string;
  boardId: string;
  name: string;
  httpStatus: number | null;
  resultCount: number | null;
  error: string | null;
}

function endpointFor(type: string, boardId: string): string {
  if (type === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${boardId}/jobs?content=true`;
  if (type === 'ashby') return `https://api.ashbyhq.com/posting-api/job-board/${boardId}`;
  if (type === 'lever') return `https://api.lever.co/v0/postings/${boardId}?mode=json`;
  throw new Error(`unsupported ATS type: ${type}`);
}

function countResults(type: string, body: unknown): number | null {
  if (type === 'lever') return Array.isArray(body) ? body.length : null;
  if (body !== null && typeof body === 'object') {
    const jobs = (body as { jobs?: unknown }).jobs;
    return Array.isArray(jobs) ? jobs.length : null;
  }
  return null;
}

function boundError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 200);
}

async function probeOne(entry: { type: string; boardId: string; name: string }): Promise<ProbeResult> {
  const url = endpointFor(entry.type, entry.boardId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    let resultCount: number | null = null;
    let error: string | null = null;
    if (res.ok) {
      try {
        const body: unknown = await res.json();
        resultCount = countResults(entry.type, body);
      } catch (err) {
        error = boundError(err);
      }
    } else {
      error = `HTTP ${res.status}`.slice(0, 200);
    }
    return { type: entry.type, boardId: entry.boardId, name: entry.name, httpStatus: res.status, resultCount, error };
  } catch (err) {
    return { type: entry.type, boardId: entry.boardId, name: entry.name, httpStatus: null, resultCount: null, error: boundError(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const results: ProbeResult[] = [];
  for (const entry of DEFAULT_ATS_BOARDS) {
    // Sequential: be polite to the public board APIs.
    results.push(await probeOne(entry));
  }
  for (const r of results) {
    console.log(JSON.stringify(r));
  }
  const dead = results.filter((r) => r.httpStatus === null || r.httpStatus < 200 || r.httpStatus >= 300);
  for (const d of dead) {
    console.log(`DEAD: ${d.type}/${d.boardId}`);
  }
  const live = results.length - dead.length;
  console.log(`PROBED ${results.length}, LIVE ${live}, DEAD ${dead.length}`);
  if (FAIL_ON_DEAD && dead.length > 0) process.exit(1);
}

void main();
