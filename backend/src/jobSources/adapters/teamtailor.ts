// Teamtailor adapter (Wave 4, T682).
//
// LIST (research-verified live 2026-09-20, no auth):
//   GET https://{subdomain}.teamtailor.com/jobs
// server-rendered HTML: `<ul id="jobs_list_container">`, per-job
// `<a data-turbo="false" href="https://{subdomain}.teamtailor.com/jobs/{numericId}-{slug}">`
// with title + inline department/location/workplace spans. One page lists
// all open positions ("N jobs" header); no pagination. The keyed REST API
// (`api.teamtailor.com`, `Authorization: Token token=`) is NOT used. See
// `.planning/research/ats-adapter-shapes.md` section 5.
//
// DETAIL per job (same verification):
//   GET https://{subdomain}.teamtailor.com/jobs/{numericId}-{slug}
// HTML containing an `application/ld+json` JobPosting block (`title`,
// `datePosted`, `employmentType`, `identifier.value`, `hiringOrganization`,
// `jobLocation`, `description`).
//
// Parsing uses regex/string scanning only (zero new deps; no HTML parser,
// no JS execution). Detail fetches run sequentially, one board at a time,
// bounded by MAX_TEAMTAILOR_DETAIL_FETCHES; each detail is isolated by its
// own try/catch so one bad page keeps its list-level row and never fails
// the run.
//
// Date rule (N4): ONLY the detail JSON-LD `datePosted` (real posting
// timestamp) becomes `postedAt` -> `source-posted`. List text is never a date.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { matchHaystack, type RawJob } from './http.js';

// Cap on parsed list rows per page (the list page carries every open
// position; this bound keeps a 400+ posting page from growing the run).
export const MAX_TEAMTAILOR_LIST_ROWS = 400;
// Bound on sequential per-job detail fetches per run (rate-limit
// friendly: strictly one request at a time, never parallel).
export const MAX_TEAMTAILOR_DETAIL_FETCHES = 100;

const USER_AGENT = 'ClearanceJobBot/1.0 (+https://clearance.app)';

interface TeamtailorListRow {
  jobId: string;
  slug: string;
  title: string;
  meta?: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

function parseTeamtailorList(html: string): TeamtailorListRow[] {
  const rows: TeamtailorListRow[] = [];
  // Per-job anchor: href ".../jobs/{numericId}-{slug}". Absolute and
  // relative forms both occur; the numeric id is the stable external id
  // (also JSON-LD `identifier.value`).
  const anchor = /<a[^>]*href="([^"']*\/jobs\/(\d+)-([^"'\s?#\/]+))"[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    const title = htmlToText(m[4]);
    if (title.length === 0) continue;
    // Inline department/location/workplace spans sit in the trailing div
    // right after the anchor; capture the raw text (record raw, never infer).
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 800);
    const divClose = after.search(/<\/div\s*>/i);
    const metaChunk = divClose >= 0 ? after.slice(0, divClose) : '';
    const metaText = htmlToText(metaChunk);
    rows.push({
      jobId: m[2],
      slug: m[3],
      title,
      meta: metaText.length > 0 ? metaText : undefined,
    });
    if (rows.length >= MAX_TEAMTAILOR_LIST_ROWS) break;
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

function teamtailorAddress(jobLocation: any): string | undefined {
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

// ---- Teamtailor (subdomain careers pages + JSON-LD details, keyless) ----
export async function fetchTeamtailor(subdomain: string, query: string): Promise<RawJob[]> {
  const listHtml = await fetchText(
    `https://${encodeURIComponent(subdomain)}.teamtailor.com/jobs`,
  );
  const parsed = parseTeamtailorList(listHtml);
  const needle = parseQuery(query);
  // Detail budget is taken from the head of the list so the bound is
  // deterministic; fetches are strictly sequential (rate-limit friendly).
  const budgeted = parsed.slice(0, MAX_TEAMTAILOR_DETAIL_FETCHES);
  const enriched: Array<{ job: RawJob; meta?: string }> = [];
  for (const row of budgeted) {
    const jobUrl = `https://${subdomain}.teamtailor.com/jobs/${encodeURIComponent(row.jobId)}-${encodeURIComponent(row.slug)}`;
    let title = row.title;
    let location = row.meta;
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
        const detailLocation = teamtailorAddress(ld.jobLocation);
        if (detailLocation) location = detailLocation;
        if (typeof ld.description === 'string') description = htmlToText(ld.description);
        // N4: `datePosted` is the posting timestamp; nothing else is.
        if (typeof ld.datePosted === 'string' && ld.datePosted.trim().length > 0) {
          dateRaw = ld.datePosted;
        }
      }
    } catch {
      // Per-row isolation: keep the list-level row (title/meta from the
      // board page, no description, no date) and continue.
    }
    enriched.push({
      job: {
        externalId: row.jobId,
        source: 'teamtailor',
        sourceUrl: jobUrl,
        title,
        company: company ?? subdomain,
        location,
        description,
        applyUrl: jobUrl,
        postedAt: dateRaw ? new Date(dateRaw) : undefined,
        postedAtSource: dateRaw ? ('source-posted' as const) : undefined,
        postedAtRaw: dateRaw,
      },
      meta: row.meta,
    });
  }
  return enriched
    .filter(({ job, meta }) => matchesQuery(matchHaystack({
      title: job.title,
      company: job.company,
      location: job.location,
      department: meta,
      description: job.description,
    }), needle))
    .map(({ job }) => job);
}
