// Recruitee adapter - moved verbatim from `jobSources/index.ts` (Wave 1,
// T621); endpoint corrected live 2026-11-01.
//
// LIST (research-verified live 2026-11-01, no auth):
//   GET https://{token}.recruitee.com/api/offers/
// The old `/api/offers.json` path 302s to the HTML career page for live
// boards, so the fetch parsed an HTML document as JSON and every recruitee
// board failed. The trailing-slash JSON endpoint answers 200
// `application/json` with `{ offers: [...] }`.
//
// A board that still redirects to its career page returns HTML; that is a
// per-board failure (the caller records it on CompanyCareerPage), never a
// crash that takes the sweep batch down.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { fetcherJsonOnly, matchHaystack, type RawJob } from './http.js';

// ---- Recruitee (public postings API, keyless) ----
export async function fetchRecruitee(company: string, query: string): Promise<RawJob[]> {
  const data = await fetcherJsonOnly(
    `https://${encodeURIComponent(company)}.recruitee.com/api/offers/`,
  );
  const jobs: any[] = Array.isArray(data?.offers) ? data.offers : [];
  const needle = parseQuery(query);
  return jobs
    .filter((j) => matchesQuery(matchHaystack({
      title: j.title,
      location: j.location,
      description: htmlToText(j.description || ''),
    }), needle))
    .map((j) => {
      const sourceUrl = j.careers_url ?? j.url;
      return {
        externalId: String(j.id),
        source: 'recruitee',
        sourceUrl,
        title: j.title || 'Untitled Role',
        company: j.company_name || company,
        location: j.location || undefined,
        description: htmlToText(j.description || ''),
        applyUrl: j.careers_apply_url ?? sourceUrl,
        postedAt: j.published_at ? new Date(j.published_at) : undefined,
        // Wave 3 (T662, ADR-028): `published_at` is an explicit posted claim ->
        // `source-posted`.
        postedAtSource: j.published_at ? ('source-posted' as const) : undefined,
        postedAtRaw: j.published_at ?? undefined,
      };
    });
}
