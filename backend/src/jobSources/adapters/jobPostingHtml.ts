// Shared rendered/parsed-HTML job-posting extraction (Wave 6, T724).
//
// MOVE RECORD (T724 STEP 1): the three functions below
// (`collectJobPostingJsonLd`, `mapJsonLdPostings`, `findAtsDelegation`) plus
// the `ATS_DELEGATION` table moved VERBATIM here from
// `adapters/career-page.ts` (Wave 4, T683), parameterised by `source`,
// `maxPostings`, and `logTag`. `career-page.ts` imports them back, so the
// tier-3 adapter keeps byte-identical behaviour (its tests are the proof);
// `browser/tier.ts` reuses the SAME implementation against the RENDERED DOM
// instead of a second copy. There is exactly ONE JSON-LD JobPosting parser
// in the codebase: this module.
//
// PRIMARY mechanism: parse every `<script type="application/ld+json">`
// block and collect `@type === 'JobPosting'` entries (title, datePosted,
// hiringOrganization, jobLocation, url, description). A block that fails
// to parse is skipped, never fatal.
//
// SECONDARY mechanism: follow well-known ATS link patterns found on the
// page to the matching tier-1 adapter (e.g. a `boards.greenhouse.io/<token>`
// link routes to `fetchGreenhouse`). Deterministic pattern matching, NOT
// scraping and NOT guessing: recognition is `extractAts`
// (registry/atsUrl.ts), which owns the ONE host table in the codebase;
// this module only maps its provider ids to the keyless tier-1 fetchers.
//
// Date rule (N4): ONLY a valid `datePosted` becomes `postedAt` ->
// `source-posted`. A posting whose only date signal is relative text
// ("2 days ago") is NOT parsed into a date: the row is `discovery-at`
// with a null `postedAt`.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { extractAts } from '../../registry/atsUrl.js';
import { matchHaystack, type RawJob } from './http.js';
import { classify } from '../../discovery/provenance.js';
import { fetchGreenhouse } from './greenhouse.js';
import { fetchAshby } from './ashby.js';
import { fetchLever } from './lever.js';
import { fetchSmartRecruiters } from './smartrecruiters.js';
import { fetchRecruitee } from './recruitee.js';
import { fetchPersonio } from './personio.js';
import { fetchWorkable } from './workable.js';
import { fetchBambooHR } from './bamboohr.js';
import { fetchBreezyHR } from './breezyhr.js';
import { fetchJobvite } from './jobvite.js';
import { fetchTeamtailor } from './teamtailor.js';
import { fetchPinpoint } from './pinpoint.js';
import { fetchFreshteam } from './freshteam.js';

export type BoardFetcher = (token: string, query: string) => Promise<RawJob[]>;

// Deterministic ATS-link -> tier-1 delegation. Keys are `extractAts`
// provider ids: `breezy` and `pinpointhq` are that table's ids for the
// breezyhr/pinpoint adapters. `rippling` is deferred (no keyless adapter
// verified) so it is absent: a rippling link is not a recognised route
// and the page falls through to the clean-empty result.
const ATS_DELEGATION: Record<string, BoardFetcher> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  ashby: fetchAshby,
  workable: fetchWorkable,
  recruitee: fetchRecruitee,
  personio: fetchPersonio,
  smartrecruiters: fetchSmartRecruiters,
  bamboohr: fetchBambooHR,
  breezy: fetchBreezyHR,
  jobvite: fetchJobvite,
  teamtailor: fetchTeamtailor,
  pinpointhq: fetchPinpoint,
  freshteam: fetchFreshteam,
};

function isJobPostingType(t: unknown): boolean {
  return t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
}

// Every JobPosting entry across every JSON-LD block. Unparseable blocks
// are skipped, never fatal.
export function collectJobPostingJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const scripts = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scripts.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sm[1]);
    } catch {
      continue;
    }
    const graph = (parsed as { '@graph'?: unknown } | null)?.['@graph'];
    const candidates: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(graph)
        ? graph
        : [parsed];
    for (const c of candidates) {
      const t = (c as { '@type'?: unknown } | null)?.['@type'];
      if (isJobPostingType(t)) out.push(c);
    }
  }
  return out;
}

function orgName(org: unknown): string | undefined {
  if (typeof org === 'string') return org.trim().length > 0 ? org : undefined;
  if (org !== null && typeof org === 'object') {
    const name = (org as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim().length > 0) return name;
  }
  return undefined;
}

function postingAddress(jobLocation: unknown): string | undefined {
  const loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  if (typeof loc === 'string') return loc.trim().length > 0 ? loc : undefined;
  if (loc === null || typeof loc !== 'object') return undefined;
  const addr = (loc as { address?: unknown }).address ?? loc;
  if (typeof addr === 'string') return addr.trim().length > 0 ? addr : undefined;
  if (addr === null || typeof addr !== 'object') return undefined;
  const rec = addr as Record<string, unknown>;
  const parts = [rec.addressLocality, rec.addressRegion, rec.addressCountry]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function postingIdentifier(ld: Record<string, unknown>): string | undefined {
  const id = ld.identifier;
  if (typeof id === 'string' && id.trim().length > 0) return id;
  if (id !== null && typeof id === 'object') {
    const value = (id as Record<string, unknown>).value;
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function validDate(raw: string): Date | undefined {
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t);
}

function pageHostname(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname;
  } catch {
    return pageUrl;
  }
}

export interface MapJsonLdPostingsOptions {
  pageUrl: string;
  postings: unknown[];
  query: string;
  /** Source id stamped on rows parsed from the page itself. */
  source: string;
  /** Cap on parsed postings per page (truncation is logged, never silent). */
  maxPostings: number;
  /** Log tag for the truncation warning (e.g. '[jobSources/career-page]'). */
  logTag: string;
}

export function mapJsonLdPostings(opts: MapJsonLdPostingsOptions): RawJob[] {
  const { pageUrl, postings, query, source, maxPostings, logTag } = opts;
  const needle = parseQuery(query);
  const host = pageHostname(pageUrl);
  const rows: RawJob[] = [];
  let truncated = false;
  for (let i = 0; i < postings.length; i += 1) {
    const ld = postings[i] as Record<string, unknown>;
    const title = typeof ld.title === 'string' ? htmlToText(ld.title) : '';
    if (title === '') continue;
    if (rows.length >= maxPostings) {
      truncated = true;
      break;
    }
    // N4: ONLY a valid `datePosted` becomes a date. Relative text
    // ("2 days ago") anywhere on the posting is never parsed into one.
    const dateRaw =
      typeof ld.datePosted === 'string' && ld.datePosted.trim() !== ''
        ? ld.datePosted
        : undefined;
    const posted = dateRaw !== undefined ? validDate(dateRaw) : undefined;
    // A posting with no `url`: the apply URL is synthesised from the page
    // base and the raw value is kept in `sourceUrl`.
    const rawUrl =
      typeof ld.url === 'string' && ld.url.trim() !== '' ? ld.url.trim() : undefined;
    let applyUrl = pageUrl;
    if (rawUrl !== undefined) {
      try {
        applyUrl = new URL(rawUrl, pageUrl).toString();
      } catch {
        applyUrl = pageUrl;
      }
    }
    rows.push({
      externalId: postingIdentifier(ld) ?? rawUrl ?? `${pageUrl}#posting-${i}`,
      source,
      sourceUrl: rawUrl ?? pageUrl,
      title,
      company: orgName(ld.hiringOrganization) ?? host,
      location: postingAddress(ld.jobLocation),
      description: typeof ld.description === 'string' ? htmlToText(ld.description) : '',
      applyUrl,
      ...(posted !== undefined && dateRaw !== undefined
        ? { postedAt: posted, postedAtSource: 'source-posted' as const, postedAtRaw: dateRaw }
        : classify({ postedAtSource: 'discovery-at' })),
    });
  }
  if (truncated) {
    console.warn(
      `${logTag} truncated ${postings.length} postings to ${maxPostings} for ${pageUrl}`,
    );
  }
  return rows.filter((r) =>
    matchesQuery(
      matchHaystack({
        title: r.title,
        company: r.company,
        location: r.location,
        description: r.description,
      }),
      needle,
    ),
  );
}

// First recognised ATS link in document order. Relative hrefs resolve
// against the page URL; non-HTTP(S) hrefs are skipped. Recognition is
// `extractAts` (the ONE host table); a known host with no keyless adapter
// (e.g. rippling) is not a route and is skipped.
export function findAtsDelegation(
  html: string,
  pageUrl: string,
): { fetch: BoardFetcher; token: string } | undefined {
  const anchors = /<a[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchors.exec(html)) !== null) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    if (raw === '') continue;
    const lower = raw.toLowerCase();
    if (lower.startsWith('#') || lower.startsWith('javascript:') || lower.startsWith('mailto:')) {
      continue;
    }
    let absolute: string;
    try {
      absolute = new URL(raw, pageUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(absolute)) continue;
    const { provider, boardToken } = extractAts(absolute);
    if (provider === null || boardToken === null || boardToken === '') continue;
    const fetch: BoardFetcher | undefined = ATS_DELEGATION[provider];
    if (fetch === undefined) continue;
    return { fetch, token: boardToken };
  }
  return undefined;
}
