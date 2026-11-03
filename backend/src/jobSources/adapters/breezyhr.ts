// BreezyHR adapter (Wave 4, T681).
//
// LIST (research-verified live 2026-09-20, no auth):
//   GET https://{slug}.breezy.hr/json
// where {slug} is the portal slug (`{slug}` of `{slug}.breezy.hr`, also
// `company.friendly_id`; registry `boardToken`). Single JSON array; no
// pagination. The keyed v3 REST API (`api.breezy.hr`, PAT auth) is NOT
// used. See `.planning/research/ats-adapter-shapes.md` section 3.
//
// Date rule (N4): `published_date` (ISO-8601, varies per job) is the real
// posting timestamp -> `source-posted`.
//
// Description rule: the feed carries no description, so rows ship
// title-only with an empty description (per-job `/p/{friendly_id}`
// extraction is an OWED follow-up recorded in the research doc).

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';

// ---- BreezyHR (portal-slug JSON feed, keyless) ----
export async function fetchBreezyHR(slug: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(`https://${encodeURIComponent(slug)}.breezy.hr/json`);
  const jobs: any[] = Array.isArray(data) ? data : [];
  const needle = parseQuery(query);
  return jobs
    .filter((j) => matchesQuery(matchHaystack({
      title: j.name,
      company: j.company?.name,
      location: breezyLocation(j),
    }), needle))
    .map((j) => ({
      externalId: String(j.id),
      source: 'breezyhr',
      sourceUrl: j.url,
      title: j.name || 'Untitled Role',
      company: j.company?.name ?? slug,
      location: breezyLocation(j),
      description: '',
      applyUrl: j.url,
      postedAt: j.published_date ? new Date(j.published_date) : undefined,
      // N4: `published_date` is the posting timestamp -> `source-posted`.
      postedAtSource: j.published_date ? ('source-posted' as const) : undefined,
      postedAtRaw: j.published_date ?? undefined,
    }));
}

function breezyLocation(j: any): string | undefined {
  const names: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v !== 'string' || v.trim().length === 0) return;
    const clean = v.trim();
    if (!names.some((n) => n.toLowerCase() === clean.toLowerCase())) names.push(clean);
  };
  // Multi-location boards expose `locations[]`; single-location boards
  // expose `location{name, country{name}}` (name and country name may be
  // identical, e.g. both "Nigeria" - deduped, never inferred).
  if (Array.isArray(j.locations)) {
    for (const l of j.locations) push(typeof l === 'string' ? l : l?.name);
  }
  push(j.location?.name);
  push(j.location?.country?.name);
  return names.length > 0 ? names.join(', ') : undefined;
}
