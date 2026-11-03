// Pinpoint adapter (Wave 4, T682).
//
// LIST (research-verified live 2026-09-20, no auth, CORS-open per the
// provider's own docs at `developers.pinpointhq.com/docs/jobs-json-endpoint`):
//   GET https://{subdomain}.pinpointhq.com/postings.json
// where {subdomain} is the `{subdomain}` of `{subdomain}.pinpointhq.com`
// (registry `board`). Single `data[]` response; no pagination. The keyed
// JSON:API (`/api/v1`, `X-API-KEY`) is NOT used. See
// `.planning/research/ats-adapter-shapes.md` section 6.
//
// Date rule (N4): the endpoint exposes NO posting date - `deadline_at` is a
// closing date, NOT a posting date, and MUST NEVER become `postedAt`. Every
// row is `discovery-at` via `classify` (same shape as the BambooHR/Workday
// adapters).
//
// Description rule: `description` (HTML) plus `key_responsibilities` and
// `benefits` are concatenated (HTML stripped); a posting with none of them
// ships an empty description and never fails the row.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { fetcher, matchHaystack, type RawJob } from './http.js';
import { classify } from '../../discovery/provenance.js';

// ---- Pinpoint (subdomain postings.json feed, keyless) ----
export async function fetchPinpoint(subdomain: string, query: string): Promise<RawJob[]> {
  const data = await fetcher(
    `https://${encodeURIComponent(subdomain)}.pinpointhq.com/postings.json`,
  );
  const postings: any[] = data?.data || [];
  const needle = parseQuery(query);
  return postings
    .filter((p) => matchesQuery(matchHaystack({
      title: p.title,
      location: pinpointLocation(p),
      department: p.job?.department?.name,
      description: pinpointDescription(p),
    }), needle))
    .map((p) => {
      const jobUrl = typeof p.url === 'string' && p.url.length > 0
        ? p.url
        : `https://${subdomain}.pinpointhq.com${typeof p.path === 'string' ? p.path : ''}`;
      return {
        externalId: String(p.id),
        source: 'pinpoint',
        sourceUrl: jobUrl,
        title: p.title || 'Untitled Role',
        // The feed names no company; keep the registry token as the
        // company fallback (same convention as greenhouse/lever/bamboohr).
        company: subdomain,
        location: pinpointLocation(p),
        description: pinpointDescription(p),
        applyUrl: jobUrl,
        // No posting-date field anywhere on this endpoint (`deadline_at`
        // is a closing date) -> discovery-at.
        ...classify({ postedAtSource: 'discovery-at' }),
      };
    });
}

function pinpointLocation(p: any): string | undefined {
  const loc = p.location;
  if (!loc || typeof loc !== 'object') return undefined;
  const parts = [loc.city, loc.name, loc.province, loc.postal_code, loc.street_address]
    .filter((v) => typeof v === 'string' && v.trim().length > 0);
  // `name` often duplicates `city` (e.g. city "London", name "Remote"):
  // keep both verbatim (record raw, never infer) but drop exact dupes.
  const seen = new Set<string>();
  const deduped = parts.filter((v) => {
    const key = v.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.length > 0 ? deduped.join(', ') : undefined;
}

function pinpointDescription(p: any): string {
  return htmlToText(
    [p.description, p.key_responsibilities, p.benefits]
      .filter((s) => typeof s === 'string' && s.length > 0)
      .join('\n'),
  );
}
