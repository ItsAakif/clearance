// Shared HTTP helper, RawJob shape, and haystack builder for job-source
// adapters. Moved verbatim from `jobSources/index.ts` (Wave 1, T621):
// `RawJob`, the internal `fetcher` helper, and `matchHaystack` live here so
// every adapter imports them from one place without a runtime cycle back
// into `index.ts`. `index.ts` re-exports `RawJob` and `matchHaystack` so its
// public surface is unchanged (`fetcher` stays internal to jobSources).
//
// Wave 3 (T662, ADR-028): `RawJob` gains the optional date-provenance pair
// `postedAtSource` / `postedAtRaw`. Each fetcher sets them at the exact
// point it reads its upstream date field; `postedAtRaw` is the verbatim
// upstream string (audit-only, never re-parsed). The `PostedAtSource` import
// is type-only and `provenance.ts` imports nothing, so there is no runtime
// cycle.
//
// T892: `postedAtRaw` is narrowed to `string` on purpose and NOT widened.
// The declared type used to lie - Lever's postings API returns `createdAt` as
// an epoch-milliseconds Int and the adapter passed the number straight
// through, so a batch 500'd with `Expected String or Null, provided Int`. The
// producing adapter now stringifies (`adapters/lever.ts`), so every in-repo
// producer really does emit a string; widening the field here would only force
// its readers (dedupe, provenance classify, dorking, the API shapers) to
// handle a case no producer can emit any more, i.e. weaken them. A fetcher
// reading an untyped upstream JSON date MUST stringify it; `coercePostedAtRaw`
// in `discovery/persistence.ts` is the last line of defence if one forgets.
//
// T902 (Wave 15): the two `!res.ok` throw sites use `HttpStatusError` from
// `jobSources/httpStatus.ts` so the classifier can read status/Retry-After
// from structure (no message-regex dependency). 304 specifically throws
// HttpStatusError(304) which classifies as `not_modified` - it is not a
// generic failure and not an empty body. `BoundedPage` gains `status` so the
// caller can record the observed final status without re-deriving it.

import type { PostedAtSource } from '../../discovery/provenance.js';
import { HttpStatusError, REDIRECT_STATUSES } from '../httpStatus.js';

export interface RawJob {
  externalId?: string;
  source: string;
  sourceUrl: string;
  title: string;
  company: string;
  location?: string;
  description: string;
  applyUrl?: string;
  postedAt?: Date;
  postedAtSource?: PostedAtSource;
  postedAtRaw?: string;
}

export const fetcher = async (url: string): Promise<any> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ClearanceJobBot/1.0 (+https://clearance.app)' },
  });
  if (!res.ok) {
    // T902: structured HTTP failure so the crawler / classifier can read the
    // status without parsing the message string. The text form preserves
    // the pre-wave message for log/migration compatibility.
    throw new HttpStatusError(
      res.status,
      url,
      res.headers?.get?.('retry-after') ?? undefined,
    );
  }
  return res.json();
};

/**
 * JSON-only variant of `fetcher` for boards whose API endpoint can redirect to
 * an HTML career page. A non-JSON 200 is a per-board failure (a descriptive
 * throw), never a JSON-parse crash that loses the reason. A stubbed response
 * with no headers keeps the old behaviour (parse as JSON).
 */
export const fetcherJsonOnly = async (url: string): Promise<any> => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ClearanceJobBot/1.0 (+https://clearance.app)' },
  });
  if (!res.ok) {
    throw new HttpStatusError(
      res.status,
      url,
      res.headers?.get?.('retry-after') ?? undefined,
    );
  }
  const contentType = res.headers?.get?.('content-type') ?? '';
  if (contentType !== '' && !/json/i.test(contentType)) {
    throw new Error(
      `Expected JSON but got ${contentType.split(';')[0] || contentType} from ${url}`,
    );
  }
  return res.json();
};

// Single haystack builder for every fetcher's matchesQuery input (ADR-021
// decision 1): joins title/company/location/description with single spaces
// and skips undefined/empty parts so body-only keyword hits are kept.
export function matchHaystack(parts: Record<string, string | undefined>): string {
  return Object.values(parts)
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(' ');
}

// ---- Tier-3 bounded page fetch (Wave 4, T683) ----
//
// `fetcher` above is untouched (keyless JSON APIs keep their behaviour).
// Career pages need the same User-Agent but with explicit bounds: max body
// size, max redirect count, explicit timeout. Plain `fetch` only - no
// browser, no rendering service, no new dependency.
//
// The bounds are named exported constants so the adapter and its tests
// share them; per-call overrides exist so tests can use small bounds
// without building multi-megabyte fixtures.
export const MAX_CAREER_PAGE_BODY_BYTES = 2_000_000;
export const MAX_CAREER_PAGE_REDIRECTS = 5;
export const CAREER_PAGE_FETCH_TIMEOUT_MS = 15_000;

// Re-exported for callers that historically imported it from here. The
// authoritative definition lives in `jobSources/httpStatus.ts` (T902).
export { REDIRECT_STATUSES };

export interface BoundedPage {
  text: string;
  finalUrl: string;
  contentType: string;
  /** T902: the observed final status (post-redirect-chain). */
  status: number;
}

export interface BoundedFetchOptions {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

async function readBodyCapped(res: Response, maxBytes: number, url: string): Promise<string> {
  // Stream with a byte cap when a body stream is present (the production
  // path: an oversized page aborts before it is fully buffered). Fixture
  // stubs without a body stream fall through to text() plus a length
  // check, which enforces the same bound on what gets parsed.
  const stream: unknown = res.body;
  if (
    stream !== null &&
    stream !== undefined &&
    typeof (stream as { getReader?: unknown }).getReader === 'function'
  ) {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best effort: the cap error below is what matters.
        }
        throw new Error(`Response body exceeds ${maxBytes} bytes for ${url}`);
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }
  const text = await res.text();
  if (text.length > maxBytes) {
    throw new Error(`Response body exceeds ${maxBytes} bytes for ${url}`);
  }
  return text;
}

export async function fetchTextBounded(url: string, opts?: BoundedFetchOptions): Promise<BoundedPage> {
  const maxBytes = opts?.maxBytes ?? MAX_CAREER_PAGE_BODY_BYTES;
  const maxRedirects = opts?.maxRedirects ?? MAX_CAREER_PAGE_REDIRECTS;
  const timeoutMs = opts?.timeoutMs ?? CAREER_PAGE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      const res = await fetch(current, {
        headers: { 'User-Agent': 'ClearanceJobBot/1.0 (+https://clearance.app)' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.includes(res.status)) {
        if (hop >= maxRedirects) {
          throw new Error(`Too many redirects (>${maxRedirects}) for ${url}`);
        }
        const location = res.headers?.get?.('location') ?? null;
        if (location === null || location === '') {
          throw new Error(`Redirect ${res.status} without a location for ${current}`);
        }
        try {
          current = new URL(location, current).toString();
        } catch {
          throw new Error(`Redirect ${res.status} with an unresolvable location for ${current}`);
        }
        continue;
      }
      // T902: 304 is a structured `not_modified`, NOT a generic failure or an
      // empty body. No conditional-request path exists today, so a 304 can
      // only come from a proxy/CDN; it must never be recorded as a failure
      // and never as `empty`. The classifier in httpStatus.ts maps 304 to
      // `not_modified`, which the crawler maps to `skipped`.
      //
      // We still throw (a 304 carries no body to parse here) but the throw
      // is the structured HttpStatusError, so the classifier wins.
      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          url,
          res.headers?.get?.('retry-after') ?? undefined,
        );
      }
      const text = await readBodyCapped(res, maxBytes, url);
      const contentType = res.headers?.get?.('content-type') ?? '';
      return { text, finalUrl: current, contentType, status: res.status };
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Fetch timed out after ${timeoutMs}ms for ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
