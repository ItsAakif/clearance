// Tier-3 career-page adapter (Wave 4, T683).
//
// Reads a company's OWN career page over plain HTTP so the browser tier
// (wave 6) stays a last resort rather than the default path to a company
// site. Plain `fetch` only: NO browser import, NO Playwright, NO external
// rendering service. Bounds (body size, redirect count, timeout) come from
// the shared helper in `adapters/http.ts`.
//
// Extraction (JSON-LD first, recognised ATS link second) lives in the
// shared `adapters/jobPostingHtml.ts` module (moved there verbatim by Wave
// 6, T724, so the tier-4 browser adapter reuses the ONE implementation
// against the rendered DOM). This module keeps the tier-3 behaviour
// exactly: same source id, same cap, same clean-[] result.
//
// Absence of JSON-LD AND of a recognisable ATS link is a CLEAN EMPTY
// result (`[]`), NOT an error and NOT a failed source. The wave-6 browser
// tier is what such a page escalates to, in deep mode only.
//
// Date rule (N4): ONLY a valid `datePosted` becomes `postedAt` ->
// `source-posted`. A posting whose only date signal is relative text
// ("2 days ago") is NOT parsed into a date: the row is `discovery-at`
// with a null `postedAt`.
//
// `source` for JSON-LD rows is the tier-3 source id below (a declared
// `sourceIds` value); delegated rows keep the tier-1 provider's own
// source from that adapter. Public pages only, no auth-wall bypassing:
// the fetch sends no credentials and follows only same-fetch redirects.

import { fetchTextBounded, type RawJob } from './http.js';
import {
  collectJobPostingJsonLd,
  findAtsDelegation,
  mapJsonLdPostings,
} from './jobPostingHtml.js';

// Declared tier-3 source id (providerRegistry.ts `sourceIds`): the
// `source` stamped on rows parsed from the page itself.
export const CAREER_PAGE_SOURCE_ID = 'career-page';

// Cap on parsed postings per page (a 400+ posting page must not grow the
// run; truncation is logged explicitly, never silently).
export const MAX_CAREER_PAGE_POSTINGS = 400;

// HTML-only gate: a PDF is reported unsupported rather than saved, and a
// non-HTML content type is a bounded actionable error. An absent
// content-type header is allowed (many servers omit it).
function assertHtmlPage(contentType: string, finalUrl: string, url: string): void {
  const ct = contentType.split(';')[0].trim();
  let path = finalUrl;
  try {
    path = new URL(finalUrl).pathname;
  } catch {
    // Keep the raw value; the suffix check below still applies.
  }
  if (/pdf/i.test(ct) || /\.pdf$/i.test(path)) {
    throw new Error(
      `Unsupported content type (PDF) for ${url}: career pages must be HTML; nothing was saved`,
    );
  }
  if (ct !== '' && !/html/i.test(ct)) {
    throw new Error(`Unsupported content type "${ct}" for ${url}: expected an HTML career page`);
  }
}

// ---- Career page (company-owned HTTP page, keyless) ----
export async function fetchCareerPage(url: string, query: string): Promise<RawJob[]> {
  const page = await fetchTextBounded(url);
  assertHtmlPage(page.contentType, page.finalUrl, url);
  const postings = collectJobPostingJsonLd(page.text);
  if (postings.length > 0) {
    return mapJsonLdPostings({
      pageUrl: url,
      postings,
      query,
      source: CAREER_PAGE_SOURCE_ID,
      maxPostings: MAX_CAREER_PAGE_POSTINGS,
      logTag: '[jobSources/career-page]',
    });
  }
  const delegation = findAtsDelegation(page.text, url);
  if (delegation !== undefined) return delegation.fetch(delegation.token, query);
  return [];
}
