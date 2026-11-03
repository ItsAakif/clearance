// JSON-board adapter - moved verbatim from `jobSources/index.ts` (Wave 1,
// T621).

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';

// ---- RemoteOK-style public JSON boards (keyless) ----
// e.g. https://remoteok.com/api  and  https://remotive.com/api/remote-jobs
// Also tolerates Arbeitnow ({data:[...]}) and Jobicy-shaped rows so stale
// json-typed boards keep returning rows instead of silently dropping them.
export async function fetchJsonBoard(feedUrl: string, query: string): Promise<RawJob[]> {
  const data: any = await fetcher(feedUrl);
  // RemoteOK wraps the array in an object keyed by "job" sometimes, or returns
  // a bare array; Remotive returns { "job-count": n, "jobs": [...] }.
  let items: any[] = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data?.jobs)) items = data.jobs;
  else if (Array.isArray(data?.data)) items = data.data;
  else if (Array.isArray(data?.items)) items = data.items;

  // Known-remote feeds: a missing location means remote, so default it instead
  // of leaving it undefined (undefined locations are dropped by location-chip
  // filters on both the server and the client).
  const remoteFeed = /remotive|remoteok|jobicy/i.test(feedUrl);
  const firstString = (...vals: unknown[]): string | undefined => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };

  const needle = parseQuery(query);
  const locString = (j: any): string => {
    if (Array.isArray(j.location)) return j.location.join(' ');
    return firstString(j.location, j.candidate_required_location, j.job_location, '') || '';
  };
  return items
    .filter((j) => j && (j.title || j.position || j.text || j.job_title)) // RemoteOK index 0 is a legal notice
    .filter((j) => matchesQuery(matchHaystack({
      title: firstString(j.title, j.position, j.job_title, ''),
      company: firstString(j.company, j.company_name, j.employer_name, ''),
      location: locString(j),
      description: htmlToText(firstString(j.description, j.job_description, j.content) || ''),
    }),
      needle,
    ))
    .map((j) => {
      const explicit = Array.isArray(j.location)
        ? j.location.join(', ')
        : firstString(j.location, j.candidate_required_location, j.job_location);
      // Known-remote feeds default a missing location to Remote; Arbeitnow
      // rows carry `remote: true` instead, which maps the same way. An
      // explicit location string is never overridden.
      const location = explicit || (remoteFeed || j.remote === true ? 'Remote' : undefined);
      // Wave 3 (T662, ADR-028): per-key provenance. None of the date keys
      // read below is an `updated*` key (the read list is unchanged, so no
      // previously-undated row gains a date); every key here is a posted
      // claim -> `source-posted`. The verbatim upstream value travels in
      // `postedAtRaw`.
      const postedRaw = j.date || j.pubDate || j.publication_date || j.created_at || j.job_posted_at_datetime_utc;
      return {
        externalId: String(j.id ?? j.slug ?? j.url ?? j.job_url ?? `${j.title || j.job_title}-${j.company || j.employer_name}`),
        source: 'json',
        sourceUrl: j.url || j.apply_url || j.job_url || j.link,
        title: firstString(j.title, j.position, j.text, j.job_title) || 'Untitled Role',
        company: firstString(j.company, j.company_name, j.employer_name) || 'Unknown',
        location,
        description: htmlToText(firstString(j.description, j.job_description, j.content) || ''),
        applyUrl: j.url || j.apply_url || j.job_url || j.link,
        postedAt: postedRaw ? new Date(postedRaw) : undefined,
        postedAtSource: postedRaw ? ('source-posted' as const) : undefined,
        postedAtRaw: postedRaw ?? undefined,
      };
    });
}
