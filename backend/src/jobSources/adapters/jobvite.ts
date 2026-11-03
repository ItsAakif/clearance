// Jobvite adapter (Wave 4, T681).
//
// LIST (research-verified live 2026-09-20, no auth):
//   GET https://jobs.jobvite.com/{site}/jobs
// server-rendered HTML: category groups (`<h3 class="h2">`), tables
// `table.jv-job-list`, rows with
// `td.jv-job-list-name > a[href="/{site}/job/{jobId}"]` and
// `td.jv-job-list-location`. One page lists all open positions; no
// pagination. The paid Job Feed REST API (`api.jobvite.com`, key+secret)
// is NOT used. See `.planning/research/ats-adapter-shapes.md` section 4.
//
// DETAIL per job (same verification):
//   GET https://jobs.jobvite.com/{site}/job/{jobId}
// HTML containing an `application/ld+json` JobPosting block (`title`,
// `datePosted`, `hiringOrganization`, `jobLocation`, `description`).
//
// Parsing uses regex/string scanning only (zero new deps; no HTML parser,
// no JS execution). Detail fetches run sequentially, one board at a time,
// bounded by MAX_JOBVITE_DETAIL_FETCHES; each detail is isolated by its
// own try/catch so one bad page keeps its list-level row and never fails
// the run.
//
// Date rule (N4): ONLY the detail JSON-LD `datePosted` (real posting day)
// becomes `postedAt` -> `source-posted`. List text is never a date.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { matchHaystack, type RawJob } from './http.js';

// Cap on parsed list rows per page (the list page carries every open
// position; this bound keeps a 400+ posting page from growing the run).
export const MAX_JOBVITE_LIST_ROWS = 400;
// Bound on sequential per-job detail fetches per run (rate-limit
// friendly: strictly one request at a time, never parallel).
export const MAX_JOBVITE_DETAIL_FETCHES = 100;

const USER_AGENT = 'ClearanceJobBot/1.0 (+https://clearance.app)';

interface JobviteListRow {
  jobId: string;
  title: string;
  location?: string;
  department?: string;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.text();
}

function parseJobviteList(html: string): JobviteListRow[] {
  // Category headers carry positions so each row inherits the nearest
  // preceding group header (e.g. "Product"). Record raw, never infer.
  const headers: Array<{ index: number; label: string }> = [];
  const h3 = /<h3[^>]*class="[^"]*\bh2\b[^"]*"[^>]*>([\s\S]*?)<\/h3\s*>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = h3.exec(html)) !== null) {
    const label = htmlToText(hm[1]);
    if (label.length > 0) headers.push({ index: hm.index, label });
  }
  const rows: JobviteListRow[] = [];
  const tr = /<tr[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tr.exec(html)) !== null) {
    const body = tm[1];
    const link = /<a[^>]*href="\/([^"'\/\s]+)\/job\/([^"'\/\s?#]+)"[^>]*>([\s\S]*?)<\/a\s*>/i.exec(body);
    if (!link) continue;
    const title = htmlToText(link[3]);
    if (title.length === 0) continue;
    const loc = /<td[^>]*class="[^"]*jv-job-list-location[^"]*"[^>]*>([\s\S]*?)<\/td\s*>/i.exec(body);
    const location = loc ? htmlToText(loc[1]) : '';
    let department: string | undefined;
    for (const h of headers) {
      if (h.index < tm.index) department = h.label;
      else break;
    }
    rows.push({
      jobId: link[2],
      title,
      location: location.length > 0 ? location : undefined,
      department,
    });
    if (rows.length >= MAX_JOBVITE_LIST_ROWS) break;
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

function jobviteAddress(jobLocation: any): string | undefined {
  const loc = Array.isArray(jobLocation) ? jobLocation[0] : jobLocation;
  const addr = loc?.address ?? loc;
  if (!addr || typeof addr !== 'object') return undefined;
  const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
    .filter((v) => typeof v === 'string' && v.trim().length > 0);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

// ---- Jobvite (site-slug careers pages + JSON-LD details, keyless) ----
export async function fetchJobvite(site: string, query: string): Promise<RawJob[]> {
  const listHtml = await fetchText(
    `https://jobs.jobvite.com/${encodeURIComponent(site)}/jobs`,
  );
  const parsed = parseJobviteList(listHtml);
  const needle = parseQuery(query);
  // Detail budget is taken from the head of the list so the bound is
  // deterministic; fetches are strictly sequential (rate-limit friendly).
  const budgeted = parsed.slice(0, MAX_JOBVITE_DETAIL_FETCHES);
  const enriched: Array<{ job: RawJob; department?: string }> = [];
  for (const row of budgeted) {
    const jobUrl = `https://jobs.jobvite.com/${encodeURIComponent(site)}/job/${encodeURIComponent(row.jobId)}`;
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
        const detailLocation = jobviteAddress(ld.jobLocation);
        if (detailLocation) location = detailLocation;
        if (typeof ld.description === 'string') description = htmlToText(ld.description);
        // N4: `datePosted` is the posting day; nothing else on the page is.
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
        source: 'jobvite',
        sourceUrl: jobUrl,
        title,
        company: company ?? site,
        location,
        description,
        applyUrl: jobUrl,
        postedAt: dateRaw ? new Date(dateRaw) : undefined,
        postedAtSource: dateRaw ? ('source-posted' as const) : undefined,
        postedAtRaw: dateRaw,
      },
      department: row.department,
    });
  }
  return enriched
    .filter(({ job, department }) => matchesQuery(matchHaystack({
      title: job.title,
      company: job.company,
      location: job.location,
      department,
      description: job.description,
    }), needle))
    .map(({ job }) => job);
}
