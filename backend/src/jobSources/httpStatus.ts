// HTTP transport status contract (Wave 15, T902, ADR-034).
//
// The transport layer (`adapters/http.ts` and the crawler's tier routing)
// publishes ONE structured failure type and ONE classification function.
// Consumers (crawler, registry write-back, politeness gate) read the
// structured error FIRST; the existing message-regex heuristic survives as
// a DOCUMENTED FALLBACK only, so code paths that still throw plain Errors
// (e.g. `adapters/career-page.ts` content-type / size guards) keep working
// while every transport throw becomes structured.
//
// Pure module: no prisma, no fetch, no I/O. The contract is the one the
// spec section 2 table is judged on.
//
// Note: the registry error classes (`UnknownSourceTypeError`,
// `SourceConfigError`) are referenced by `name` rather than `instanceof`
// to keep this module free of a top-level import of `./providerRegistry.js`.
// Both classes set `this.name` in their constructors (see
// `providerRegistry.ts:145` and `:152`), so for any instance produced by
// them the name check is exactly equivalent to `instanceof` while keeping
// `httpStatus.ts` dependency-free.
//
// classifyTransportFailure ordering (rules are exact, do not reorder):
//   1. branded skip (skipped===true or name==='BrowserTierSkippedError') -> null
//   2. UnknownSourceTypeError | SourceConfigError                      -> 'invalid'
//   3. HttpStatusError -> by status:
//        304           -> 'not_modified'
//        408           -> 'timeout'
//        403, 429, 503 -> 'blocked'
//        300, 305, 306 -> 'invalid'
//        other 4xx/5xx -> 'http_error'
//        other (incl. 2xx/3xx that should not reach here) -> 'http_error'
//   4. message heuristics (fallback for non-HTTP throws):
//        timeout/abort/DNS -> 'timeout'
//        'unsupported content type' -> 'invalid'
//        forbidden|captcha|challenge|cloudflare|rate.?limit|too many
//        requests|access denied|blocked -> 'blocked'
//        otherwise -> 'http_error'
//   5. anything unclassifiable -> 'http_error' (a plain Error falls
//      through step 4 and yields 'http_error'; null is reserved for the
//      explicit branded-skip case in step 1).
//
// Steps 1-3 are structure (the primary path). Step 4 exists because some
// paths still throw plain Errors (career-page content-type guards, body
// size cap, etc.); it is a FALLBACK, not the primary path.

export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryAfter?: string;

  constructor(status: number, url: string, retryAfter?: string, message?: string) {
    // The default message MUST contain the numeric status so message-only
    // consumers (the regex fallback, log scrapers, manual debugging) keep
    // working unchanged. A caller may pass an alternate `message` for
    // diagnostic contexts (e.g. capturing a proxy/CDN's own phrasing) as
    // long as it still embeds the status - the contract below enforces
    // that invariant.
    const finalMessage = message ?? `Fetch failed ${status} for ${url}`;
    if (!finalMessage.includes(String(status))) {
      throw new Error(
        `HttpStatusError message must contain the numeric status ${status}; got ${JSON.stringify(finalMessage)}`,
      );
    }
    super(finalMessage);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
    this.retryAfter = retryAfter;
  }
}

/** Extract the observed status, or undefined for a non-HTTP throw. */
export function httpStatusOf(err: unknown): number | undefined {
  if (err instanceof HttpStatusError) return err.status;
  return undefined;
}

/** Extract the verbatim Retry-After header, or undefined. */
export function retryAfterOf(err: unknown): string | undefined {
  if (err instanceof HttpStatusError) return err.retryAfter;
  return undefined;
}

/** Statuses followed manually by `fetchTextBounded` (redirect: 'manual'). */
export const REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];

export type TransportFailureKind =
  | 'blocked'
  | 'http_error'
  | 'timeout'
  | 'invalid'
  | 'not_modified';

// Kept narrow on purpose: only the truly missing-kind case (branded skip)
// returns null. A plain Error is a real failure and yields 'http_error'.
const STATUS_BLOCKED = new Set<number>([403, 429, 503]);
const STATUS_INVALID = new Set<number>([300, 305, 306]);

function asBrandedSkip(
  err: unknown,
): { skipped?: unknown; name?: unknown; reason?: unknown } | null {
  if (err === null || typeof err !== 'object') return null;
  const obj = err as { skipped?: unknown; name?: unknown; reason?: unknown };
  if (obj.skipped === true || obj.name === 'BrowserTierSkippedError') return obj;
  return null;
}

function messageOfUnknown(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m !== '') return m;
  }
  return String(err ?? '');
}

/**
 * Classify a transport throw into the canonical failure kind. See the
 * module header for the exact rules. Returns null only for a branded
 * skip; every non-skip error yields a `TransportFailureKind`.
 */
export function classifyTransportFailure(err: unknown): TransportFailureKind | null {
  if (asBrandedSkip(err) !== null) return null;

  // Step 2: config errors -> invalid (with the mapping's specific message).
  // Both classes set `this.name` to their constructor name at construction
  // (see `providerRegistry.ts`), so a name check is equivalent to
  // `instanceof` for our purposes and avoids the import cycle described in
  // the module header.
  if (err !== null && typeof err === 'object') {
    const name = (err as { name?: unknown }).name;
    if (name === 'UnknownSourceTypeError' || name === 'SourceConfigError') {
      return 'invalid';
    }
  }

  if (err instanceof HttpStatusError) {
    const s = err.status;
    if (s === 304) return 'not_modified';
    if (s === 408) return 'timeout';
    if (STATUS_BLOCKED.has(s)) return 'blocked';
    if (STATUS_INVALID.has(s)) return 'invalid';
    return 'http_error';
  }

  // Step 4: message heuristics fallback for non-HTTP throws.
  const message = messageOfUnknown(err);
  if (/timed?\s*out|ETIMEDOUT|EAI_AGAIN|aborted|\babort\b/i.test(message)) {
    return 'timeout';
  }
  if (/unsupported content type/i.test(message)) {
    return 'invalid';
  }
  if (
    /forbidden|captcha|challenge|cloudflare|rate.?limit|too many requests|access denied|\bblocked\b/i.test(
      message,
    )
  ) {
    return 'blocked';
  }
  return 'http_error';
}
