// SmartRecruiters adapter - moved verbatim from `jobSources/index.ts`
// (Wave 1, T621); URL construction fixed live 2026-11-01.
//
// LIST (research-verified live 2026-11-01, no auth):
//   GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=100
// The list rows expose `id` and `ref` (an API URL) but no web posting URL,
// so the old adapter emitted `sourceUrl: undefined` and every row was dropped
// by the persist guard. The public posting page is
//   https://jobs.smartrecruiters.com/{company}/{id}
// (verified 200 for Hastee/744000077955015). `applyUrl` /
// `references.landingPage` still win when the API supplies them.
//
// Dates: `postedDate` is the documented claim; live rows also carry
// `releasedDate`, used as the fallback so a posting does not lose its date.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';

/** Public SmartRecruiters posting URL for a list row. */
export function smartRecruitersPostingUrl(company: string, id: string): string {
  return `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${encodeURIComponent(id)}`;
}

// ---- SmartRecruiters (public postings API, keyless) ----
export async function fetchSmartRecruiters(company: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?limit=100`,
  );
  const jobs: any[] = Array.isArray(data?.content) ? data.content : [];
  const needle = parseQuery(query);
  return jobs
    .filter((j) => matchesQuery(matchHaystack({
      title: j.name,
      company: j.company?.name,
      location: j.location?.fullLocation ?? j.location?.city,
      description: htmlToText(j.description || ''),
    }), needle))
    .map((j) => {
      const sourceUrl =
        j.applyUrl ??
        j.references?.landingPage ??
        smartRecruitersPostingUrl(company, String(j.id));
      const postedAtRaw = j.postedDate ?? j.releasedDate;
      return {
        externalId: String(j.id),
        source: 'smartrecruiters',
        sourceUrl,
        title: j.name || 'Untitled Role',
        company: j.company?.name || company,
        location:
          j.location?.fullLocation ||
          j.location?.city ||
          (j.location ? `${j.location.city || ''}` : undefined) ||
          undefined,
        description: htmlToText(j.description || ''),
        applyUrl: j.applyUrl ?? j.references?.landingPage ?? sourceUrl,
        postedAt: postedAtRaw ? new Date(postedAtRaw) : undefined,
        // Wave 3 (T662, ADR-028): `postedDate` is an explicit posted claim ->
        // `source-posted`.
        postedAtSource: postedAtRaw ? ('source-posted' as const) : undefined,
        postedAtRaw,
      };
    });
}
