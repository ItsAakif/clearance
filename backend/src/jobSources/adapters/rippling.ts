// Rippling adapter (live-probed 2026-11-01, keyless).
//
// LIST (research-verified live 2026-11-01, no auth):
//   GET https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs
// `{slug}` is the first path segment of `https://ats.rippling.com/{slug}/jobs`
// (NOT the host label `ats`; `registry/atsUrl.ts` extracts the path segment
// for this host). The response is a JSON array of postings:
//   [{ uuid, name, department: { label }, url, workLocation: { label } }]
//
// No API key and no browser tier. The list carries no description or posted
// date, so those stay absent rather than being invented.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';

export const RIPPLING_ENDPOINT = 'https://api.rippling.com/platform/api/ats/v1/board';

// ---- Rippling (public ATS board API, keyless) ----
export async function fetchRippling(slug: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(
    `${RIPPLING_ENDPOINT}/${encodeURIComponent(slug)}/jobs`,
  );
  const jobs: any[] = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
  const needle = parseQuery(query);
  return jobs
    .filter((j) => matchesQuery(matchHaystack({
      title: j.name,
      company: j.company?.name ?? slug,
      location: j.workLocation?.label ?? j.location?.label,
    }), needle))
    .map((j) => {
      const id = String(j.uuid ?? j.id ?? '');
      const sourceUrl =
        j.url ??
        (id.length > 0 ? `https://ats.rippling.com/${encodeURIComponent(slug)}/jobs/${id}` : '');
      return {
        externalId: id,
        source: 'rippling',
        sourceUrl,
        title: j.name || 'Untitled Role',
        company: j.company?.name || slug,
        location: j.workLocation?.label ?? j.location?.label ?? undefined,
        // The list endpoint exposes no description; the persist guard keeps
        // any stored description from a later detail pass.
        description: '',
        applyUrl: sourceUrl,
      };
    });
}
