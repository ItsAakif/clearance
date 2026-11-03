// BambooHR adapter (Wave 4, T681).
//
// LIST (research-verified live 2026-09-20, no auth):
//   GET https://{subdomain}.bamboohr.com/careers/list
// where {subdomain} is the `{subdomain}` of
// `https://{subdomain}.bamboohr.com` (registry `board`, i.e. the
// boardToken). Single `result[]` response (`meta.totalCount`); no
// pagination. See `.planning/research/ats-adapter-shapes.md` section 2.
//
// Date rule (N4): the endpoint exposes NO posting date (neither the list
// nor the client-rendered detail HTML carries one), so `postedAt` stays
// undefined and every row is `discovery-at` via `classify` (same shape as
// the Workday adapter).
//
// Description rule: the list response carries no description and the
// detail page is client-rendered, so rows ship title-only with an empty
// description (detail-page extraction is an OWED follow-up recorded in
// the research doc; an empty description never fails the row).

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';
import { classify } from '../../discovery/provenance.js';

// ---- BambooHR (subdomain careers feed, keyless) ----
export async function fetchBambooHR(subdomain: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(
    `https://${encodeURIComponent(subdomain)}.bamboohr.com/careers/list`,
  );
  const jobs: any[] = data?.result || [];
  const needle = parseQuery(query);
  return jobs
    .filter((j) => matchesQuery(matchHaystack({
      title: j.jobOpeningName,
      location: bambooLocation(j),
    }), needle))
    .map((j) => {
      const jobUrl = `https://${subdomain}.bamboohr.com/careers/${j.id}`;
      return {
        externalId: String(j.id),
        source: 'bamboohr',
        sourceUrl: jobUrl,
        title: j.jobOpeningName || 'Untitled Role',
        // The list response names no company; keep the registry token as
        // the company fallback (same convention as greenhouse/lever).
        company: subdomain,
        location: bambooLocation(j),
        description: '',
        applyUrl: jobUrl,
        // No posting-date field anywhere on this endpoint -> discovery-at.
        ...classify({ postedAtSource: 'discovery-at' }),
      };
    });
}

function bambooLocation(j: any): string | undefined {
  const parts = [j.location?.city, j.location?.state]
    .filter((v) => typeof v === 'string' && v.trim().length > 0);
  if (parts.length === 0) {
    parts.push(
      ...[j.atsLocation?.city, j.atsLocation?.state, j.atsLocation?.country]
        .filter((v) => typeof v === 'string' && v.trim().length > 0),
    );
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}
