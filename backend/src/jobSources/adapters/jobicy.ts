// Jobicy adapter - moved verbatim from `jobSources/index.ts` (Wave 1,
// T621).

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';

// ---- Jobicy (remote, keyless JSON) ----
export async function fetchJobicy(query: string): Promise<RawJob[]> {
  const data = await fetcher('https://jobicy.com/api/remote-jobs?count=50');
  const jobs: any[] = Array.isArray(data) ? data : data?.jobs || [];
  const needle = parseQuery(query);
  return jobs
    .filter((j) => j && j.job_title)
    .filter((j) => matchesQuery(matchHaystack({
      title: j.job_title,
      company: j.employer_name,
      location: j.job_location,
      description: htmlToText(j.job_description || ''),
    }), needle))
    .map((j) => ({
      externalId: String(j.id ?? j.slug ?? j.job_url),
      source: 'jobicy',
      sourceUrl: j.job_url || j.url,
      title: j.job_title || 'Untitled Role',
      company: j.employer_name || 'Unknown',
      location: j.job_location || (j.job_is_remote ? 'Remote' : undefined),
      description: htmlToText(j.job_description || ''),
      applyUrl: j.job_url || j.url,
      postedAt: j.job_posted_at_datetime_utc ? new Date(j.job_posted_at_datetime_utc) : undefined,
      // Wave 3 (T662, ADR-028): `job_posted_at_datetime_utc` is an explicit
      // posted claim -> `source-posted`.
      postedAtSource: j.job_posted_at_datetime_utc ? ('source-posted' as const) : undefined,
      postedAtRaw: j.job_posted_at_datetime_utc ?? undefined,
    }));
}
