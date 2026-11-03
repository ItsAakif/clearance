// Workable adapter (Wave 4, T681; endpoint corrected live 2026-11-01).
//
// LIST (research-verified live 2026-11-01, no auth):
//   GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
// where {slug} is the first path segment of `apply.workable.com/{slug}/`
// (the registry `boardToken`). The old
// `jobs.workable.com/api/v1/companies/{companyId}` endpoint 404s for most
// stored tokens (7,075 workable rows), which is why the sweep yielded nothing.
//
// The widget response is `{ name, description, jobs: [...] }`, single request,
// no pagination. `details=true` adds the HTML `description` field; without it
// the list rows carry no body text.
//
// RATE LIMITS: workable answers 429 when hit hard. Requests are capped at a
// provider-level concurrency of 2 and a single Retry-After-aware retry; no
// unbounded spinning. A 429 without a usable Retry-After throws immediately
// and is recorded as the registry's `blocked` status.
//
// Date rule (N4): `created_at` (or the legacy `created`) is the posting
// timestamp -> `source-posted`. `updated` / `published_on` are never
// substitutes.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { matchHaystack, type RawJob } from './http.js';
import { HttpStatusError } from '../httpStatus.js';

export const WORKABLE_MAX_CONCURRENCY = 2;
/** Largest Retry-After wait we will honour (never park a sweep worker longer). */
export const WORKABLE_MAX_RETRY_WAIT_MS = 30_000;
export const WORKABLE_ENDPOINT = 'https://apply.workable.com/api/v1/widget/accounts';

let active = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (active < WORKABLE_MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  // The slot was handed over by releaseSlot; `active` is unchanged.
}

function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  active = Math.max(0, active - 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After is either delta-seconds or an HTTP date. Null when unusable. */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

async function fetchWorkableJson(url: string): Promise<any> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ClearanceJobBot/1.0 (+https://clearance.app)' },
    });
    const retryAfter = res.headers?.get?.('retry-after') ?? undefined;
    if (res.status === 429 && attempt === 0) {
      const delay = parseRetryAfterMs(retryAfter);
      if (delay !== null && delay <= WORKABLE_MAX_RETRY_WAIT_MS) {
        await sleep(delay);
        continue;
      }
    }
    if (!res.ok) throw new HttpStatusError(res.status, url, retryAfter);
    return res.json();
  }
}

function locationOf(job: any): string | undefined {
  if (Array.isArray(job.locations) && job.locations.length > 0) {
    const parts: string[] = [];
    for (const entry of job.locations) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        parts.push(entry.trim());
      } else if (entry !== null && typeof entry === 'object') {
        const label = [entry.city, entry.region ?? entry.subregion, entry.country]
          .filter((v): v is string => typeof v === 'string' && v.length > 0)
          .join(', ');
        if (label.length > 0) parts.push(label);
      }
    }
    const unique = [...new Set(parts)];
    if (unique.length > 0) return unique.join(', ');
  }
  const fallback = [job.location?.city, job.location?.subregion, job.location?.countryName]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(', ');
  return fallback.length > 0 ? fallback : undefined;
}

// ---- Workable (public widget board API, keyless) ----
export async function fetchWorkable(slug: string, query: string): Promise<RawJob[]> {
  const url = `${WORKABLE_ENDPOINT}/${encodeURIComponent(slug)}?details=true`;
  await acquireSlot();
  let data: any;
  try {
    data = await fetchWorkableJson(url);
  } finally {
    releaseSlot();
  }

  const jobs: any[] = Array.isArray(data?.jobs) ? data.jobs : [];
  const company =
    data?.name ?? data?.title ?? (typeof jobs[0]?.company?.title === 'string' ? jobs[0].company.title : slug);
  const needle = parseQuery(query);

  return jobs
    .filter((j) => matchesQuery(matchHaystack({
      title: j.title,
      company: j.company?.title ?? company,
      location: locationOf(j),
      description: htmlToText(
        [j.description, j.requirementsSection, j.benefitsSection]
          .filter((s) => typeof s === 'string' && s.length > 0)
          .join('\n'),
      ),
    }), needle))
    .map((j) => {
      const description = htmlToText(
        [j.description, j.requirementsSection, j.benefitsSection]
          .filter((s) => typeof s === 'string' && s.length > 0)
          .join('\n'),
      );
      const postedAtRaw =
        typeof j.created_at === 'string'
          ? j.created_at
          : typeof j.created === 'string'
            ? j.created
            : undefined;
      return {
        externalId: String(j.shortcode ?? j.id),
        source: 'workable',
        sourceUrl: j.url ?? j.shortlink ?? j.application_url,
        title: j.title,
        company: j.company?.title ?? company,
        location: locationOf(j),
        description,
        applyUrl: j.application_url ?? j.url ?? j.shortlink,
        // N4: created_at/created is the posting timestamp; updated and
        // published_on are never substitutes.
        postedAt: postedAtRaw ? new Date(postedAtRaw) : undefined,
        postedAtSource: postedAtRaw ? ('source-posted' as const) : undefined,
        postedAtRaw,
      };
    });
}
