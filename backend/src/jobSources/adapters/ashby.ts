// Ashby adapter - moved verbatim from `jobSources/index.ts` (Wave 1, T621).

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { matchHaystack, type RawJob } from './http.js';
import type { PostedAtSource } from '../../discovery/provenance.js';

// ---- Ashby (documented public posting API, keyless) ----
// GET https://api.ashbyhq.com/posting-api/job-board/{board} returns jobs[]
// with descriptionPlain/publishedAt/jobUrl (verified live 2026-09-18).
export async function fetchAshby(company: string, query: string): Promise<RawJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${company}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ClearanceJobBot/1.0 (+https://clearance.app)' },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  const data: any = await res.json();
  const jobs: any[] = Array.isArray(data) ? data : data?.jobs || [];
  const needle = parseQuery(query);
  const desc = (j: any): string => j.descriptionPlain || htmlToText(j.descriptionHtml || '');
  return jobs
    .filter((j) => j && j.isListed !== false)
    .filter((j) => matchesQuery(matchHaystack({
      title: j.title,
      location: j.location,
      company: j.companyName,
      description: desc(j),
    }),
      needle,
    ))
    .map((j) => {
      const location = j.location
        || (Array.isArray(j.secondaryLocations) ? j.secondaryLocations.join(', ') : undefined);
      // Wave 3 (T662, ADR-028): `publishedAt` is an explicit posted claim ->
      // `source-posted`; a row with only `updatedAt` -> `source-updated`.
      const postedRaw = j.publishedAt || j.updatedAt;
      const postedSource: PostedAtSource | undefined = postedRaw
        ? (j.publishedAt ? 'source-posted' : 'source-updated')
        : undefined;
      return {
        externalId: String(j.id),
        source: 'ashby',
        sourceUrl: j.jobUrl || j.applyUrl,
        title: j.title,
        company: j.companyName || company,
        location,
        description: desc(j),
        applyUrl: j.applyUrl || j.jobUrl,
        postedAt: postedRaw ? new Date(postedRaw) : undefined,
        postedAtSource: postedSource,
        postedAtRaw: postedRaw ?? undefined,
      };
    });
}
