// Lever adapter - moved verbatim from `jobSources/index.ts` (Wave 1, T621).
//
// T892: Lever's postings API returns `createdAt` as an epoch-milliseconds JSON
// Int (e.g. `"createdAt":1781037166218`), NOT an ISO string. The wave-3 line
// below passed that number straight into `postedAtRaw`, so a single Lever row
// made `PrismaClientValidationError: Argument 'postedAtRaw': Invalid value
// provided. Expected String or Null, provided Int` and 500'd a live full-scan
// batch. `postedAt` / `postedAtSource` are unchanged (both already read the
// raw value fine); only the persisted CLAIM is stringified, and `String()` of
// an already-string value is byte-identical, so nothing else moves.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';

// ---- Lever (postings API) ----
export async function fetchLever(site: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(`https://api.lever.co/v0/postings/${site}?mode=json`);
  const jobs: any[] = Array.isArray(data) ? data : [];
  const needle = parseQuery(query);
  return jobs
    .filter((j) => j.hostedUrl)
    .filter((j) => matchesQuery(matchHaystack({
      title: j.text,
      location: j.categories?.location,
      team: j.categories?.team,
      description: j.descriptionPlain || htmlToText(j.description || ''),
    }), needle))
    .map((j) => ({
      externalId: j.id,
      source: 'lever',
      sourceUrl: j.hostedUrl,
      title: j.text,
      company: site,
      location: j.categories?.location,
      description: j.descriptionPlain || htmlToText(j.description || ''),
      applyUrl: j.hostedUrl,
      postedAt: j.createdAt ? new Date(j.createdAt) : undefined,
      // Wave 3 (T662, ADR-028): Lever `createdAt` is the posting creation
      // timestamp -> `source-posted`.
      postedAtSource: j.createdAt ? ('source-posted' as const) : undefined,
      // T892: the verbatim claim is stringified, never reformatted: the
      // `JobListing.postedAtRaw` column is `String | null`.
      postedAtRaw: j.createdAt != null ? String(j.createdAt) : undefined,
    }));
}
