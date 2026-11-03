// Workday adapter - moved verbatim from `jobSources/index.ts` (Wave 1,
// T621).

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';
import { classify } from '../../discovery/provenance.js';

// ---- Workday (public RSS/JSON feed, generic) ----
// Wave 3 (T662, ADR-028): Workday rows carry no upstream date (verified: no
// `postedAt` is synthesised anywhere in this fetcher) -> `discovery-at` via
// `classify`, so the null invariant holds structurally.
export async function fetchWorkday(rssUrl: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(rssUrl);
  const items: any[] = data?.jobs || [];
  const needle = parseQuery(query);
  return items
    .filter((j) => matchesQuery(matchHaystack({
      title: j.title,
      location: j.location,
      description: htmlToText(j.description || ''),
    }), needle))
    .map((j) => ({
      externalId: j.jobId || j.id,
      source: 'workday',
      sourceUrl: j.url || j.applyUrl,
      title: j.title,
      company: j.company || 'Workday',
      location: j.location,
      description: htmlToText(j.description || j.title || ''),
      applyUrl: j.url || j.applyUrl,
      ...classify({ postedAtSource: 'discovery-at' }),
    }));
}
