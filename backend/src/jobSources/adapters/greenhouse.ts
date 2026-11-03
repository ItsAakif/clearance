// Greenhouse adapter - moved verbatim from `jobSources/index.ts` (Wave 1,
// T621). No parsing, signature, or comment change: bodies are identical,
// only the module path changed.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';

// ---- Greenhouse (board token based) ----
// Per-job detail fallback: list rows sometimes carry no `content`, which used
// to persist as '' and (before the upsert guard) clobber good stored text.
// When a list-row description is missing/empty, fetch the per-job detail
// (GET /boards/{board}/jobs/{id}, same keyless host) and use its `content`
// before accepting empty. On-demand only, per-row try/catch: a detail failure
// keeps the row with an empty description and never fails the row.
export async function fetchGreenhouseDetail(board: string, id: string | number): Promise<string> {
  try {
    const detail: any = await fetcher(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(String(id))}`,
    );
    return htmlToText(detail?.content || '');
  } catch {
    return '';
  }
}

export async function fetchGreenhouse(board: string, query: string): Promise<RawJob[]> {
  const base = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
  const data = await fetcher(base);
  const jobs: any[] = data.jobs || [];
  const needle = parseQuery(query);
  const rows: RawJob[] = jobs
    .filter((j) => matchesQuery(matchHaystack({
      title: j.title,
      location: j.location?.name,
      description: htmlToText(j.content || ''),
    }), needle))
    .map((j) => ({
      externalId: String(j.id),
      source: 'greenhouse',
      sourceUrl: j.absolute_url,
      title: j.title,
      company: board,
      location: j.location?.name,
      description: htmlToText(j.content || ''),
      applyUrl: j.absolute_url,
      postedAt: j.updated_at ? new Date(j.updated_at) : undefined,
      // Wave 3 (T662, ADR-028): Greenhouse exposes only `updated_at` (an ATS
      // row-mutation timestamp, not a posting date) -> `source-updated`.
      postedAtSource: j.updated_at ? ('source-updated' as const) : undefined,
      postedAtRaw: j.updated_at ?? undefined,
    }));
  // Bounded backfill, sequential: only rows with an empty list description hit
  // the detail endpoint, one at a time, each isolated by the helper's catch.
  for (const row of rows) {
    if ((row.description ?? '').trim().length === 0 && row.externalId) {
      const detailText = await fetchGreenhouseDetail(board, row.externalId);
      if (detailText.trim().length > 0) row.description = detailText;
    }
  }
  return rows;
}
