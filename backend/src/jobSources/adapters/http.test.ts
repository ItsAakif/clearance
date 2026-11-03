// Shared HTTP helper tests for the wave-15 T902 transport contract:
// - the structured HttpStatusError throw path at both sites,
// - 304 specifically throws HttpStatusError(304) (classified `not_modified`),
// - Retry-After (delta-seconds and HTTP-date) is captured verbatim,
// - the existing redirect / body-cap / timeout behaviour is unchanged.
//
// All tests stub the global `fetch` per the convention used in
// `career-page.test.ts`; no live calls.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BoundedPage,
  fetchTextBounded,
  MAX_CAREER_PAGE_BODY_BYTES,
  MAX_CAREER_PAGE_REDIRECTS,
  CAREER_PAGE_FETCH_TIMEOUT_MS,
  REDIRECT_STATUSES,
} from './http.js';
import { HttpStatusError } from '../httpStatus.js';

interface StubResponse {
  ok: boolean;
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function stubFetch(handler: (url: string) => StubResponse | Promise<StubResponse>) {
  return vi.fn(async (url: string) => {
    const r = await handler(String(url));
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) lower[k.toLowerCase()] = v;
    return {
      ok: r.ok,
      status: r.status,
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
    };
  });
}

const html = (body: string, contentType = 'text/html; charset=utf-8'): StubResponse => ({
  ok: true,
  status: 200,
  body,
  headers: { 'content-type': contentType },
});

describe('fetchTextBounded - bounds exports (unchanged contract)', () => {
  it('exports the documented bounds unchanged', () => {
    expect(MAX_CAREER_PAGE_BODY_BYTES).toBe(2_000_000);
    expect(MAX_CAREER_PAGE_REDIRECTS).toBe(5);
    expect(CAREER_PAGE_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(Array.from(REDIRECT_STATUSES)).toEqual([301, 302, 303, 307, 308]);
  });
});

describe('fetchTextBounded - body cap (unchanged behaviour)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects a body larger than the bound', async () => {
    vi.stubGlobal('fetch', stubFetch(() => html('x'.repeat(200))));
    await expect(
      fetchTextBounded('https://careers.acme.example.test/', { maxBytes: 100 }),
    ).rejects.toThrow(/exceeds 100 bytes/);
  });
});

describe('fetchTextBounded - redirect chain (unchanged behaviour)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('follows a bounded redirect chain and reports the final URL + status', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        if (url === 'https://careers.acme.example.test/') {
          return { ok: false, status: 301, body: '', headers: { location: '/jobs' } };
        }
        return html('<html><body>jobs</body></html>');
      }),
    );
    const page: BoundedPage = await fetchTextBounded('https://careers.acme.example.test/');
    expect(page.finalUrl).toBe('https://careers.acme.example.test/jobs');
    expect(page.text).toContain('jobs');
    // T902: the observed final status is now recorded on the result.
    expect(page.status).toBe(200);
  });

  it('throws past the redirect bound instead of chasing', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => ({
        ok: false,
        status: 302,
        body: '',
        headers: { location: `${url}/next` },
      })),
    );
    await expect(
      fetchTextBounded('https://careers.acme.example.test/', { maxRedirects: 2 }),
    ).rejects.toThrow(/Too many redirects \(>2\)/);
  });
});

describe('fetchTextBounded - timeout (unchanged behaviour)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('times out explicitly instead of hanging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('The operation was aborted')),
            );
          }),
      ),
    );
    await expect(
      fetchTextBounded('https://careers.acme.example.test/', { timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/);
  });
});

describe('fetchTextBounded - structured HttpStatusError (T902)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a 404 throws HttpStatusError with status 404 and no retryAfter', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: false, status: 404, body: 'not found' })),
    );
    let caught: unknown;
    try {
      await fetchTextBounded('https://careers.acme.example.test/');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.status).toBe(404);
    expect(err.url).toBe('https://careers.acme.example.test/');
    expect(err.retryAfter).toBeUndefined();
    expect(err.name).toBe('HttpStatusError');
    // message still carries the numeric status for message-only consumers.
    expect(err.message).toContain('404');
  });

  it('a 429 captures Retry-After verbatim (delta-seconds form)', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({
        ok: false,
        status: 429,
        body: 'slow down',
        headers: { 'retry-after': '120' },
      })),
    );
    let caught: unknown;
    try {
      await fetchTextBounded('https://careers.acme.example.test/');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe('120');
  });

  it('a 429 captures Retry-After verbatim (HTTP-date form)', async () => {
    const date = 'Fri, 31 Dec 2027 23:59:59 GMT';
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({
        ok: false,
        status: 429,
        body: 'slow down',
        headers: { 'retry-after': date },
      })),
    );
    let caught: unknown;
    try {
      await fetchTextBounded('https://careers.acme.example.test/');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.retryAfter).toBe(date);
  });

  it('a 304 throws HttpStatusError with status 304 (classified `not_modified`, never `failed`, never `empty`)', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: false, status: 304, body: '', headers: {} })),
    );
    let caught: unknown;
    try {
      await fetchTextBounded('https://careers.acme.example.test/');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    const err = caught as HttpStatusError;
    expect(err.status).toBe(304);
    // Not a redirect error and not a body error.
    expect(err.message).not.toMatch(/redirect/i);
    expect(err.message).not.toMatch(/exceeds/i);
  });

  it('a 304 throws HttpStatusError with status 304 even after a redirect chain', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) => {
        if (url === 'https://careers.acme.example.test/') {
          return {
            ok: false,
            status: 301,
            body: '',
            headers: { location: '/v2' } as Record<string, string>,
          };
        }
        return { ok: false, status: 304, body: '', headers: {} };
      }),
    );
    let caught: unknown;
    try {
      await fetchTextBounded('https://careers.acme.example.test/');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    expect((caught as HttpStatusError).status).toBe(304);
  });

  it('a 503 throws HttpStatusError with status 503', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: false, status: 503, body: 'unavailable' })),
    );
    let caught: unknown;
    try {
      await fetchTextBounded('https://careers.acme.example.test/');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    expect((caught as HttpStatusError).status).toBe(503);
  });

  it('an HttpStatusError throw does NOT match the regex-shaped text error path (no plain `Error` from the throw site)', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(() => ({ ok: false, status: 500, body: 'oops' })),
    );
    let caught: unknown;
    try {
      await fetchTextBounded('https://careers.acme.example.test/');
    } catch (err) {
      caught = err;
    }
    // Proves the structured path: instanceof Error (still true) AND instanceof HttpStatusError.
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(HttpStatusError);
    expect((caught as Error).message).toContain('500');
  });
});

describe('fetchTextBounded - BoundedPage.status (T902)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a successful 200 response carries status: 200', async () => {
    vi.stubGlobal('fetch', stubFetch(() => html('<html></html>')));
    const page = await fetchTextBounded('https://careers.acme.example.test/');
    expect(page.status).toBe(200);
  });
});
