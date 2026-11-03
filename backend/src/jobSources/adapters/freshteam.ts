// Freshteam adapter (Wave 4, T682).
//
// LIST (research-verified live 2026-09-20, no auth):
//   GET https://{domain}.freshteam.com/jobs
// server-rendered HTML: per-job
// `<a href="/jobs/{id}/{slug}" class="heading" data-portal-title="..."
// data-portal-location="..." data-portal-job-type="..."
// data-portal-remote-location="...">` with `.job-title` / `.job-location`
// divs, plus a department/query filter form (the adapter reads the
// unfiltered page). One page lists all open positions; no pagination. The
// keyed REST API (`{domain}.freshteam.com/api`, Bearer account token) is
// NOT used. NOTE: Freshworks has announced Freshteam end-of-life for NEW
// signups; existing customer boards remain live (verified this wave). See
// `.planning/research/ats-adapter-shapes.md` section 8.
//
// DETAIL per job (same verification):
//   GET https://{domain}.freshteam.com/jobs/{id}/{slug}
// HTML containing an `application/ld+json` JobPosting block (`title`,
// `datePosted` like `"2026-03-07 02:25:31 UTC"`, `employmentType`,
// `hiringOrganization`, `jobLocation`, `description`).
//
// Parsing uses regex/string scanning only (zero new deps; no HTML parser,
// no JS execution). Detail fetches run sequentially, one board at a time,
// bounded by MAX_FRESHTEAM_DETAIL_FETCHES; each detail is isolated by its
// own try/catch so one bad page keeps its list-level row and never fails
// the run.
//
// Date rule (N4): ONLY the detail JSON-LD `datePosted` (real posting time)
// becomes `postedAt` -> `source-posted`. List text is never a date.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { matchHaystack, type RawJob } from './http.js';

// Cap on parsed list rows per page (the list page carries every open
// position; this bound keeps a 400+ posting page from growing the run).
export const MAX_FRESHTEAM_LIST_ROWS = 400;
// Bound on sequential per-job detail fetches per run (rate-limit
// friendly: strictly one request at a time, never parallel).
export const MAX_FRESHTEAM_DETAIL_FETCHES = 100;

const USER_AGENT = 'ClearanceJobBot/1.0 (+https://clearance.app)';

interface FreshteamListRow {
  jobId: string;
  slug: string;
  title: string;
  location?: string;
  remoteFlag?: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

function parseFreshteamList(html: string): FreshteamListRow[] {
  const rows: FreshteamListRow[] = [];
  // Per-job anchor: `<a href="/jobs/{id}/{slug}" class="heading" ...>`.
  // Attribute order varies; the class token `heading` identifies the card.
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    const attrs = m[1];
    if (!/\bheading\b/i.test(attrs)) continue;
    const href = /href="(\/jobs\/([^"'\s?#\/]+)\/([^"'\s?#\/]+))"/i.exec(attrs);
    if (!href) continue;
    const body = m[2];
    const titleDiv = /<div[^>]*class="[^"]*\bjob-title\b[^"]*"[^>]*>([\s\S]*?)<\/div\s*>/i.exec(body);
    const title = htmlToText(titleDiv ? titleDiv[1] : body);
    if (title.length === 0) continue;
    const portalLocation = /data-portal-location="([^"]*)"/i.exec(attrs)?.[1];
    const remoteFlag = /data-portal-remote-location="([^"]*)"/i.exec(attrs)?.[1];
    const locDiv = /<div[^>]*class="[^"]*\bjob-location\b[^"]*"[^>]*>([\s\S]*?)<\/div\s*>/i.exec(body);
    const location = (portalLocation && portalLocation.trim().length > 0)
      ? portalLocation.trim()
      : (locDiv ? htmlToText(locDiv[1]) : '');
    rows.push({
      jobId: href[2],
      slug: href[3],
      title,
      location: location.length > 0 ? location : undefined,
      remoteFlag: remoteFlag && remoteFlag.trim().length > 0 ? remoteFlag.trim() : undefined,
    });
    if (rows.length >= MAX_FRESHTEAM_LIST_ROWS) break;
  }
  return rows;
}

function extractJobPostingJsonLd(html: string): any | undefined {
  const scripts = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scripts.exec(html)) !== null) {
    let parsed: any;
    try {
      parsed = JSON.parse(sm[1]);
    } catch {
      continue;
    }
    const candidates: any[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.['@graph'])
        ? parsed['@graph']
        : [parsed];
    for (const c of candidates) {
      const t = c?.['@type'];
      if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) return c;
    }
  }
  return undefined;
}

function freshteamAddress(jobLocation: any): string | undefined {
  const loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  const addr = loc?.address ?? loc;
  if (!addr || typeof addr !== 'object') return undefined;
  const parts = [
    addr.streetAddress,
    addr.addressLocality,
    addr.addressRegion,
    addr.postalCode,
    addr.addressCountry,
  ].filter((v) => typeof v === 'string' && v.trim().length > 0);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

// ---- Freshteam (domain careers pages + JSON-LD details, keyless) ----
export async function fetchFreshteam(domain: string, query: string): Promise<RawJob[]> {
  const listHtml = await fetchText(
    `https://${encodeURIComponent(domain)}.freshteam.com/jobs`,
  );
  const parsed = parseFreshteamList(listHtml);
  const needle = parseQuery(query);
  // Detail budget is taken from the head of the list so the bound is
  // deterministic; fetches are strictly sequential (rate-limit friendly).
  const budgeted = parsed.slice(0, MAX_FRESHTEAM_DETAIL_FETCHES);
  const enriched: Array<{ job: RawJob; remoteFlag?: string }> = [];
  for (const row of budgeted) {
    const jobUrl = `https://${domain}.freshteam.com/jobs/${encodeURIComponent(row.jobId)}/${encodeURIComponent(row.slug)}`;
    let title = row.title;
    let location = row.location;
    let company: string | undefined;
    let description = '';
    let dateRaw: string | undefined;
    try {
      const detailHtml = await fetchText(jobUrl);
      const ld = extractJobPostingJsonLd(detailHtml);
      if (ld) {
        if (typeof ld.title === 'string' && ld.title.trim().length > 0) {
          title = htmlToText(ld.title);
        }
        company = typeof ld.hiringOrganization === 'string'
          ? ld.hiringOrganization
          : (typeof ld.hiringOrganization?.name === 'string'
            ? ld.hiringOrganization.name
            : undefined);
        const detailLocation = freshteamAddress(ld.jobLocation);
        if (detailLocation) location = detailLocation;
        if (typeof ld.description === 'string') description = htmlToText(ld.description);
        // N4: `datePosted` is the posting time; nothing else on the page is.
        if (typeof ld.datePosted === 'string' && ld.datePosted.trim().length > 0) {
          dateRaw = ld.datePosted;
        }
      }
    } catch {
      // Per-row isolation: keep the list-level row (title/location from
      // the board page, no description, no date) and continue.
    }
    enriched.push({
      job: {
        externalId: row.jobId,
        source: 'freshteam',
        sourceUrl: jobUrl,
        title,
        company: company ?? domain,
        location,
        description,
        applyUrl: jobUrl,
        postedAt: dateRaw ? new Date(dateRaw) : undefined,
        postedAtSource: dateRaw ? ('source-posted' as const) : undefined,
        postedAtRaw: dateRaw,
      },
      remoteFlag: row.remoteFlag,
    });
  }
  return enriched
    .filter(({ job, remoteFlag }) => matchesQuery(matchHaystack({
      title: job.title,
      company: job.company,
      location: job.location,
      department: remoteFlag,
      description: job.description,
    }), needle))
    .map(({ job }) => job);
}
