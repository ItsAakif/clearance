/**
 * Tier-4 browser adapter (wave 6, T724; ADR-029 decisions 1 and 4).
 *
 * LAST-RESORT, deep-mode-only, ENHANCEMENT ONLY: this tier contributes rows
 * for a page no cheaper tier could read; it never gates rows and is never
 * selected unless deep mode is on and a cheaper tier already failed for the
 * same URL (routing belongs to wave 7; this module only declares the
 * capability via its registry descriptor).
 *
 * EXTRACTION REUSE (T724 STEP 1): parsing mirrors the tier-3 career-page
 * adapter (JSON-LD JobPosting blocks first, recognised ATS links second)
 * but runs against the RENDERED DOM. The parsing is NOT reimplemented
 * here: it is the ONE implementation in
 * `jobSources/adapters/jobPostingHtml.ts` (moved there verbatim from
 * `adapters/career-page.ts` by this task), called with the tier-4 source
 * id and cap below.
 *
 * DATE RULE (N4): `postedAt` comes ONLY from a real posting field
 * (`datePosted` via the shared mapper). An index/render date is NEVER
 * used: a page that shows only a relative date ("2 days ago") yields
 * `discovery-at` rows with a null `postedAt` (enforced inside the shared
 * mapper, asserted by `tier.test.ts`).
 *
 * POOL (T723): every URL runs through the bounded browser pool, so
 * CAMOUFOX_MAX_CONCURRENCY / CAMOUFOX_MAX_URLS_PER_RUN / CAMOUFOX_MAX_QUEUE_DEPTH
 * apply on every path. Pool-level drops (truncated / queue-overflow /
 * cancelled / failed) are a CLEAN EMPTY result, never a throw: the tier
 * reports, it does not fail the run.
 *
 * UNAVAILABLE (N2): when the tier is disabled or the automation library /
 * remote endpoint is absent, this module throws `BrowserTierSkippedError`
 * (skipped-with-reason, NOT failed). The orchestrator (wave 7) maps that
 * brand to a skipped unit result; the run continues on the cheaper tiers.
 *
 * PRODUCT BOUNDARY (ADR-029 decision 5): no challenge solving, no
 * sign-in flows, no secret submission, no identity cycling to dodge a
 * block. A page presenting a challenge or sign-in wall is reported by the
 * client as `blocked` and surfaces here as a clean empty result.
 *
 * This module performs NO logging, so no secret (URL credential, endpoint
 * credential, page content) can leak into logs.
 */

import {
  collectJobPostingJsonLd,
  findAtsDelegation,
  mapJsonLdPostings,
} from '../jobSources/adapters/jobPostingHtml.js';
import type { RawJob } from '../jobSources/adapters/http.js';
import {
  fetchRenderedPage,
  isBrowserAvailable,
  type BrowserAvailability,
  type FetchPageResult,
} from './client.js';
import { createBrowserPool, type BrowserPool } from './pool.js';

/** Declared tier-4 source id (providerRegistry.ts `sourceIds`). */
export const BROWSER_SOURCE_ID = 'browser';

/** Cap on parsed postings per rendered page (truncation is logged, never silent). */
export const MAX_BROWSER_POSTINGS = 400;

/**
 * Branded skip signal: the tier is absent/misconfigured, so the caller
 * records skipped-with-reason and continues with the cheaper tiers. Never
 * a failure, never a retry trigger.
 */
export class BrowserTierSkippedError extends Error {
  readonly reason: string;
  readonly skipped = true;
  constructor(reason: string) {
    super(`browser tier skipped: ${reason}`);
    this.name = 'BrowserTierSkippedError';
    this.reason = reason;
  }
}

/** Injection point for tests (mocked pool/client, no real launch). */
export interface BrowserTierDeps {
  pool?: BrowserPool;
  fetchPage?: (url: string) => Promise<FetchPageResult>;
  isAvailable?: () => Promise<BrowserAvailability>;
}

function skipped(reason: string): never {
  throw new BrowserTierSkippedError(reason);
}

/**
 * Read one company page through the browser tier and return RawJob rows.
 * JSON-LD JobPosting blocks first, a recognised ATS link (plain-HTTP
 * tier-1 delegation, same as tier 3) second, clean [] otherwise.
 */
export async function fetchViaBrowser(
  url: string,
  query: string,
  deps?: BrowserTierDeps,
): Promise<RawJob[]> {
  const availability = deps?.isAvailable
    ? await deps.isAvailable()
    : await isBrowserAvailable();
  if (!availability.available) {
    skipped(availability.reason);
  }
  const pool: BrowserPool = deps?.pool ?? createBrowserPool();
  const fetchPage = deps?.fetchPage ?? ((u: string) => fetchRenderedPage(u));
  const results = await pool.run([{ url, run: () => fetchPage(url) }]);
  const first = results[0];
  // Pool-level outcomes (truncated / queue-overflow / cancelled / failed)
  // are REPORTED by the pool result contract and surface here as a clean
  // empty set: the tier never fails the run.
  if (!first || !first.ok) return [];
  const page = first.value;
  if (!page || page.status !== 'ok') {
    // A tier that vanished between the probe and the visit is still a
    // skip, not a failure; every other non-ok visit is a clean empty.
    if (page && page.status === 'unavailable') skipped(page.reason);
    return [];
  }
  const postings = collectJobPostingJsonLd(page.html);
  if (postings.length > 0) {
    return mapJsonLdPostings({
      pageUrl: url,
      postings,
      query,
      source: BROWSER_SOURCE_ID,
      maxPostings: MAX_BROWSER_POSTINGS,
      logTag: '[browser/tier]',
    });
  }
  const delegation = findAtsDelegation(page.html, url);
  if (delegation !== undefined) return delegation.fetch(delegation.token, query);
  return [];
}
