// HTTP status contract tests (Wave 15, T902). Pins the spec section 2
// mapping table and the documented fallback order in
// `classifyTransportFailure`. Pure module; no prisma, no fetch.
import { describe, it, expect } from 'vitest';
import {
  HttpStatusError,
  REDIRECT_STATUSES,
  classifyTransportFailure,
  httpStatusOf,
  retryAfterOf,
} from './httpStatus.js';
import { UnknownSourceTypeError, SourceConfigError } from './providerRegistry.js';
describe('HttpStatusError', () => {
  it('exposes status, url, optional retryAfter and has the canonical name', () => {
    const err = new HttpStatusError(429, 'https://x.example.test/', '120');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.name).toBe('HttpStatusError');
    expect(err.status).toBe(429);
    expect(err.url).toBe('https://x.example.test/');
    expect(err.retryAfter).toBe('120');
    expect(err.message).toContain('429');
    expect(err.message).toContain('https://x.example.test/');
  });

  it('message contains the numeric status (message-only consumers)', () => {
    expect(new HttpStatusError(503, 'https://x.example.test/').message).toMatch(/503/);
  });

  it('retryAfter is undefined when not supplied', () => {
    expect(new HttpStatusError(404, 'https://x.example.test/').retryAfter).toBeUndefined();
  });

  it('preserves an HTTP-date Retry-After verbatim', () => {
    const date = 'Fri, 31 Dec 2027 23:59:59 GMT';
    const err = new HttpStatusError(429, 'https://x.example.test/', date);
    expect(err.retryAfter).toBe(date);
  });
});

describe('httpStatusOf / retryAfterOf', () => {
  it('returns the status / retryAfter from an HttpStatusError', () => {
    const err = new HttpStatusError(503, 'https://x.example.test/', '60');
    expect(httpStatusOf(err)).toBe(503);
    expect(retryAfterOf(err)).toBe('60');
  });

  it('returns undefined for a plain Error', () => {
    expect(httpStatusOf(new Error('boom'))).toBeUndefined();
    expect(retryAfterOf(new Error('boom'))).toBeUndefined();
  });

  it('returns undefined for a non-Error value', () => {
    expect(httpStatusOf('boom')).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
    expect(httpStatusOf(undefined)).toBeUndefined();
    expect(httpStatusOf(42)).toBeUndefined();
    expect(retryAfterOf(null)).toBeUndefined();
    expect(retryAfterOf(undefined)).toBeUndefined();
  });
});

describe('REDIRECT_STATUSES', () => {
  it('contains exactly the 5 redirect codes from the spec', () => {
    expect(Array.from(REDIRECT_STATUSES)).toEqual([301, 302, 303, 307, 308]);
  });
});

describe('classifyTransportFailure - spec section 2 mapping table', () => {
  // Cases verified against the normative table in
  // `.planning/specs/sweep-throughput-p0.md` section 2.
  const cases: Array<{ status: number; kind: ReturnType<typeof classifyTransportFailure> }> = [
    { status: 200, kind: 'http_error' }, // 2xx that should not reach here falls through to http_error
    { status: 300, kind: 'invalid' },
    { status: 301, kind: 'http_error' }, // redirects are followed, so a 301 here is unexpected -> http_error
    { status: 304, kind: 'not_modified' },
    { status: 400, kind: 'http_error' },
    { status: 401, kind: 'http_error' },
    { status: 403, kind: 'blocked' },
    { status: 404, kind: 'http_error' },
    { status: 408, kind: 'timeout' },
    { status: 410, kind: 'http_error' },
    { status: 429, kind: 'blocked' },
    { status: 500, kind: 'http_error' },
    { status: 503, kind: 'blocked' },
  ];

  for (const c of cases) {
    it(`${c.status} -> ${c.kind}`, () => {
      const err = new HttpStatusError(c.status, 'https://x.example.test/');
      expect(classifyTransportFailure(err)).toBe(c.kind);
    });
  }

  it('a 304 carries status 304 through to the classifier (not modified)', () => {
    const err = new HttpStatusError(304, 'https://x.example.test/');
    expect(classifyTransportFailure(err)).toBe('not_modified');
    expect(httpStatusOf(err)).toBe(304);
  });

  it('a 429 with a Retry-After preserves the header on the structured error', () => {
    const err = new HttpStatusError(429, 'https://x.example.test/', '120');
    expect(classifyTransportFailure(err)).toBe('blocked');
    expect(retryAfterOf(err)).toBe('120');
  });

  it('300, 305, 306 are `invalid` (real status recorded)', () => {
    expect(classifyTransportFailure(new HttpStatusError(300, 'https://x.example.test/'))).toBe('invalid');
    expect(classifyTransportFailure(new HttpStatusError(305, 'https://x.example.test/'))).toBe('invalid');
    expect(classifyTransportFailure(new HttpStatusError(306, 'https://x.example.test/'))).toBe('invalid');
  });
});

describe('classifyTransportFailure - step 1: branded skip', () => {
  it('skipped===true returns null', () => {
    expect(
      classifyTransportFailure({ skipped: true, reason: 'browser engine absent' }),
    ).toBeNull();
  });

  it("name === 'BrowserTierSkippedError' returns null", () => {
    expect(
      classifyTransportFailure({ name: 'BrowserTierSkippedError', message: 'skipped' }),
    ).toBeNull();
  });
});

describe('classifyTransportFailure - step 2: config errors', () => {
  it('UnknownSourceTypeError -> invalid', () => {
    expect(classifyTransportFailure(new UnknownSourceTypeError('rippling'))).toBe('invalid');
  });

  it('SourceConfigError -> invalid', () => {
    expect(classifyTransportFailure(new SourceConfigError('missing token'))).toBe('invalid');
  });
});

describe('classifyTransportFailure - step 4: message heuristics fallback', () => {
  it('a plain timeout Error -> timeout', () => {
    expect(classifyTransportFailure(new Error('request timed out after 15000ms'))).toBe('timeout');
  });

  it('a plain ETIMEDOUT Error -> timeout', () => {
    expect(classifyTransportFailure(new Error('connect ETIMEDOUT'))).toBe('timeout');
  });

  it('a plain abort Error -> timeout', () => {
    expect(classifyTransportFailure(new Error('The operation was aborted'))).toBe('timeout');
  });

  it('an unsupported content type Error -> invalid', () => {
    expect(
      classifyTransportFailure(
        new Error('Unsupported content type "application/pdf" for https://x.example.test/'),
      ),
    ).toBe('invalid');
  });

  it('a forbidden message -> blocked (fallback regex)', () => {
    expect(classifyTransportFailure(new Error('403 Forbidden at https://x.example.test/'))).toBe(
      'blocked',
    );
  });

  it('a cloudflare challenge message -> blocked', () => {
    expect(classifyTransportFailure(new Error('cloudflare challenge page'))).toBe('blocked');
  });

  it('a rate-limit message -> blocked', () => {
    expect(classifyTransportFailure(new Error('rate limit exceeded'))).toBe('blocked');
  });

  it('a plain Error with a Fetch failed 500 message falls back to http_error (the regex path is the fallback)', () => {
    expect(classifyTransportFailure(new Error('Fetch failed 500 for https://x.example.test/'))).toBe(
      'http_error',
    );
  });

  it('an unclassifiable plain Error still yields http_error (not null)', () => {
    expect(classifyTransportFailure(new Error('mystery kaboom'))).toBe('http_error');
  });
});

describe('classifyTransportFailure - structured path takes precedence over the regex fallback', () => {
  it('an HttpStatusError(403) whose message does NOT contain "forbidden" is still blocked via structure', () => {
    // Proves step 3 (structure) is the primary path, not the regex.
    const err = new HttpStatusError(403, 'https://x.example.test/');
    expect(err.message).not.toMatch(/forbidden|captcha|challenge|cloudflare|rate.?limit/i);
    expect(classifyTransportFailure(err)).toBe('blocked');
  });

  it('an HttpStatusError(429) is blocked even though its message would not match the fallback regex alone', () => {
    const err = new HttpStatusError(429, 'https://x.example.test/', '60');
    expect(err.message).not.toMatch(/too many requests/i);
    expect(classifyTransportFailure(err)).toBe('blocked');
  });
});
