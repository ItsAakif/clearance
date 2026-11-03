// USAJobs (https://developer.usajobs.gov/) - US federal openings.
// Auth: header-only. `User-Agent` must be the requester's email and
// `Authorization-Key` the API key. Free, no paid tier, email signup.
// Endpoint: GET https://data.usajobs.gov/api/search?Keyword=&LocationName=&ResultsPerPage=&Page=&WhoMayApply=Public

import { leaseNextKey } from '../ai/keyManager.js';
import type { AggregatorConfig, AggregatorKeySlot } from './aggregators.js';
import type { RawJob } from './index.js';

/** Build the USAJobs search URL (exported for tests). Credentials are header-only. */
export function buildUsaJobsUrl(config: AggregatorConfig): string {
  const url = new URL('https://data.usajobs.gov/api/search');
  if (config.query) url.searchParams.set('Keyword', config.query);
  if (config.location) url.searchParams.set('LocationName', config.location);
  url.searchParams.set('ResultsPerPage', String(Math.min(config.resultsWanted ?? 20, 50)));
  url.searchParams.set('Page', '1');
  url.searchParams.set('WhoMayApply', 'Public');
  return url.toString();
}

export async function fetchUsaJobs(config: AggregatorConfig, slot?: AggregatorKeySlot): Promise<RawJob[]> {
  let email = process.env.USAJOBS_EMAIL || '';
  let apiKey = process.env.USAJOBS_API_KEY || '';
  if (!email || !apiKey) {
    try {
      const rec = await leaseNextKey('usajobs', config.userId);
      if (slot) slot.record = rec;
      const raw: string = rec.apiKey || '';
      const idx = raw.indexOf(':');
      email = idx >= 0 ? raw.slice(0, idx) : '';
      apiKey = idx >= 0 ? raw.slice(idx + 1) : '';
    } catch {
      email = '';
      apiKey = '';
    }
  }
  if (!email || !apiKey) {
    throw new Error(
      'USAJobs requires an email and an API key. Store "email:apiKey" as a USAJobs key, or set USAJOBS_EMAIL + USAJOBS_API_KEY.'
    );
  }

  const res = await fetch(buildUsaJobsUrl(config), {
    headers: {
      Host: 'data.usajobs.gov',
      'User-Agent': email,
      'Authorization-Key': apiKey,
    },
  });
  if (!res.ok) throw new Error(`USAJobs failed: ${res.status}`);
  const data: any = await res.json();
  const items: any[] = data?.SearchResult?.SearchResultItems ?? [];
  return items.map((item, i) => {
    const d: any = item?.MatchedObjectDescriptor ?? {};
    const postedRaw: string | undefined = d.PublicationStartDate || d.PositionStartDate;
    let postedAt: Date | undefined;
    if (postedRaw) {
      const date = new Date(postedRaw);
      if (Number.isFinite(date.getTime())) postedAt = date;
    }
    return {
      externalId: `usajobs-${d.MatchedObjectId ?? d.PositionID ?? i}`,
      source: 'usajobs',
      title: d.PositionTitle || 'Untitled Role',
      company: d.OrganizationName || d.DepartmentName || 'Unknown',
      location: d.PositionLocationDisplay || d.PositionLocation?.[0]?.LocationName || config.location,
      description:
        d.QualificationSummary ||
        d.UserArea?.Details?.JobSummary ||
        d.PositionFormattedDescription?.[0]?.Content ||
        '',
      applyUrl: d.ApplyURI?.[0] || d.PositionURI || '',
      sourceUrl: d.PositionURI || d.ApplyURI?.[0] || '',
      postedAt,
      // Wave 3 (T662, ADR-028): `PublicationStartDate` is the posting's
      // publication claim -> `source-posted`.
      postedAtSource: postedRaw ? ('source-posted' as const) : undefined,
      postedAtRaw: postedRaw ?? undefined,
    };
  });
}
