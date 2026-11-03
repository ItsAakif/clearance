// Personio adapter - moved verbatim from `jobSources/index.ts` (Wave 1,
// T621).

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';

// ---- Personio (public postings API, keyless) ----
export async function fetchPersonio(company: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(`https://${company}.jobs.personio.de/search.json?language=en`);
  const jobs: any[] = data?.jobPostings || [];
  const needle = parseQuery(query);
  return jobs
    .filter((j) => matchesQuery(matchHaystack({
      title: j.name,
      location: j.officeName,
      description: htmlToText(j.jobDescriptions?.[0]?.value || ''),
    }), needle))
    .map((j) => ({
      externalId: String(j.id),
      source: 'personio',
      sourceUrl: j.applicationUrl || j.url,
      title: j.name || 'Untitled Role',
      company: j.company || company,
      location: j.officeName || undefined,
      description: htmlToText(j.jobDescriptions?.[0]?.value || ''),
      applyUrl: j.applicationUrl || j.url,
      postedAt: j.createdAt ? new Date(j.createdAt) : undefined,
      // Wave 3 (T662, ADR-028): `createdAt` is the posting creation
      // timestamp -> `source-posted`.
      postedAtSource: j.createdAt ? ('source-posted' as const) : undefined,
      postedAtRaw: j.createdAt ?? undefined,
    }));
}
