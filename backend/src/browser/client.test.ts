/**
 * Unit tests for the browser-tier thin client (`./client.js`).
 *
 * MOCK SOURCE (per T722 step 4): Camoufox is NOT installed in this
 * environment and nothing was executed against a live engine, so no
 * captured responses exist. Every mock below is HAND-WRITTEN from the
 * doc-derived request/response shapes the T720 probe recorded in
 * `.planning/research/camofox-protocol.md`:
 *  - `browser.newPage(): Promise<Page>` (constructor/launch surface)
 *  - navigation answering with an HTTP status (`Response.status()`)
 *  - `page.content()` returning rendered HTML
 *  - `page.screenshot()` returning bytes, `page.evaluate()` returning a value
 *  - explicit `page.close()` / `browser.close()`
 *  - timeout surfacing as a `TimeoutError`-named rejection
 * The default (real-library) factory is exercised only through the
 * absent-module path, which is the path every CI run takes.
 */

import { describe, it, expect } from 'vitest';
import {
  BROWSER_UNAVAILABLE_HINT,
  MAX_EVAL_SCRIPT_CHARS,
  captureScreenshot,
  closeBrowserSession,
  evaluateOnPage,
  fetchRenderedPage,
  isBrowserAvailable,
  redactCredentials,
  type AutomationBrowser,
  type AutomationPage,
  type BrowserTransportFactory,
} from './client.js';

const PAGE_URL = 'https://careers.example.com/jobs/123';

type HangStep =
  | 'launch'
  | 'newPage'
  | 'goto'
  | 'content'
  | 'screenshot'
  | 'evaluate'
  | null;

interface MockBehavior {
  httpStatus?: number | null;
  finalUrl?: string | null;
  remoteAddress?: string | null;
  html?: string;
  evalValue?: unknown;
  screenshotBytes?: Uint8Array;
  hang?: HangStep;
  launchError?: unknown;
  gotoError?: unknown;
  contentError?: unknown;
  browserCloseError?: unknown;
}

interface MockCounts {
  launch: number;
  newPage: number;
  goto: number;
  content: number;
  screenshot: number;
  evaluate: number;
  pageClose: number;
  browserClose: number;
}

function pending(): Promise<never> {
  return new Promise<never>(() => {});
}

function makeTransport(behavior: MockBehavior = {}): {
  factory: BrowserTransportFactory;
  counts: MockCounts;
} {
  const counts: MockCounts = {
    launch: 0,
    newPage: 0,
    goto: 0,
    content: 0,
    screenshot: 0,
    evaluate: 0,
    pageClose: 0,
    browserClose: 0,
  };
  const page: AutomationPage = {
    goto: async () => {
      counts.goto += 1;
      if (behavior.hang === 'goto') return pending();
      if (behavior.gotoError !== undefined) throw behavior.gotoError;
      return {
        httpStatus: behavior.httpStatus ?? 200,
        finalUrl: behavior.finalUrl ?? null,
        remoteAddress: behavior.remoteAddress ?? null,
      };
    },
    content: async () => {
      counts.content += 1;
      if (behavior.hang === 'content') return pending();
      if (behavior.contentError !== undefined) throw behavior.contentError;
      return behavior.html ?? '<html><body>hello</body></html>';
    },
    screenshot: async () => {
      counts.screenshot += 1;
      if (behavior.hang === 'screenshot') return pending();
      return behavior.screenshotBytes ?? new Uint8Array([1, 2, 3]);
    },
    evaluate: async () => {
      counts.evaluate += 1;
      if (behavior.hang === 'evaluate') return pending();
      return behavior.evalValue ?? null;
    },
    close: async () => {
      counts.pageClose += 1;
    },
  };
  const browser: AutomationBrowser = {
    newPage: async () => {
      counts.newPage += 1;
      if (behavior.hang === 'newPage') return pending();
      return page;
    },
    close: async () => {
      counts.browserClose += 1;
      if (behavior.browserCloseError !== undefined) {
        throw behavior.browserCloseError;
      }
    },
  };
  const factory: BrowserTransportFactory = async () => {
    counts.launch += 1;
    if (behavior.hang === 'launch') return pending();
    if (behavior.launchError !== undefined) throw behavior.launchError;
    return browser;
  };
  return { factory, counts };
}

function timeoutNamedError(): Error {
  const err = new Error('Timeout exceeded while waiting');
  err.name = 'TimeoutError';
  return err;
}

describe('guard runs before any request', () => {
  it('refuses loopback without touching the transport', async () => {
    const { factory, counts } = makeTransport();
    const result = await fetchRenderedPage('http://127.0.0.1/jobs', {
      transport: factory,
    });
    expect(result.status).toBe('guard-rejected');
    if (result.status !== 'guard-rejected') throw new Error('wrong shape');
    expect(result.attempts).toBe(0);
    expect(counts.launch).toBe(0);
    expect(counts.goto).toBe(0);
  });

  it('refuses non-HTTP schemes without touching the transport', async () => {
    const { factory, counts } = makeTransport();
    const result = await fetchRenderedPage('file:///etc/passwd', {
      transport: factory,
    });
    expect(result.status).toBe('guard-rejected');
    expect(counts.launch).toBe(0);
  });

  it('refuses credentials-in-URL without touching the transport', async () => {
    const { factory, counts } = makeTransport();
    const result = await fetchRenderedPage(
      'https://user:pass@careers.example.com/jobs',
      { transport: factory },
    );
    expect(result.status).toBe('guard-rejected');
    expect(counts.launch).toBe(0);
  });
});

describe('pre-resolved address check', () => {
  it('denies a private connected address and never reads content', async () => {
    const { factory, counts } = makeTransport({ remoteAddress: '10.0.0.5' });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('guard-rejected');
    if (result.status !== 'guard-rejected') throw new Error('wrong shape');
    expect(result.attempts).toBe(1);
    expect(result.reason).toMatch(/connected address refused/);
    expect(counts.goto).toBe(1);
    expect(counts.content).toBe(0);
    // Post-connect denial still releases the session (no leak).
    expect(counts.pageClose).toBe(1);
    expect(counts.browserClose).toBe(1);
  });

  it('accepts a public connected address', async () => {
    const { factory } = makeTransport({ remoteAddress: '93.184.216.34' });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('ok');
  });
});

describe('fetchRenderedPage happy path and lifecycle', () => {
  it('reads the rendered document and closes the session', async () => {
    const html =
      '<html><head><script type="application/ld+json">{"@type":"JobPosting"}</script></head><body>role</body></html>';
    const { factory, counts } = makeTransport({ html });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result).toMatchObject({
      status: 'ok',
      url: PAGE_URL,
      finalUrl: PAGE_URL,
      httpStatus: 200,
      truncated: false,
      attempts: 1,
    });
    if (result.status !== 'ok') throw new Error('wrong shape');
    expect(result.html).toBe(html);
    expect(counts.launch).toBe(1);
    expect(counts.newPage).toBe(1);
    expect(counts.goto).toBe(1);
    expect(counts.pageClose).toBe(1);
    expect(counts.browserClose).toBe(1);
  });

  it('an empty document is ok, never blocked', async () => {
    const { factory } = makeTransport({ html: '' });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('wrong shape');
    expect(result.html).toBe('');
  });
});

describe('blocked is reported, never retried', () => {
  for (const httpStatus of [403, 429]) {
    it(`maps HTTP ${httpStatus} to blocked with exactly one attempt`, async () => {
      const { factory, counts } = makeTransport({ httpStatus });
      const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
      expect(result.status).toBe('blocked');
      if (result.status !== 'blocked') throw new Error('wrong shape');
      expect(result.attempts).toBe(1);
      expect(result.reason).toContain(String(httpStatus));
      expect(counts.goto).toBe(1);
      expect(counts.content).toBe(0);
    });
  }

  it('maps challenge markup to blocked with exactly one attempt', async () => {
    const { factory, counts } = makeTransport({
      html: '<html><body><div class="cf-challenge">checking your browser</div></body></html>',
    });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('wrong shape');
    expect(result.attempts).toBe(1);
    expect(result.reason).toMatch(/challenge marker/);
    expect(counts.goto).toBe(1);
    expect(counts.content).toBe(1);
  });

  it('maps a login form to blocked and submits nothing', async () => {
    const { factory, counts } = makeTransport({
      html: '<html><body><form><input type="password" name="pw"></form></body></html>',
    });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('wrong shape');
    expect(result.reason).toMatch(/auth wall/);
    expect(counts.goto).toBe(1);
    expect(counts.evaluate).toBe(0);
    expect(counts.screenshot).toBe(0);
  });
});

describe('dead / timeout / crashed classification', () => {
  for (const httpStatus of [404, 410]) {
    it(`maps HTTP ${httpStatus} to dead with exactly one attempt`, async () => {
      const { factory, counts } = makeTransport({ httpStatus });
      const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
      expect(result.status).toBe('dead');
      expect(counts.goto).toBe(1);
    });
  }

  it('a hung navigation maps to timeout and still closes the session', async () => {
    const { factory, counts } = makeTransport({ hang: 'goto' });
    const result = await fetchRenderedPage(PAGE_URL, {
      transport: factory,
      timeoutMs: 60,
    });
    expect(result.status).toBe('timeout');
    if (result.status !== 'timeout') throw new Error('wrong shape');
    expect(result.attempts).toBe(1);
    expect(counts.goto).toBe(1);
    expect(counts.pageClose).toBe(1);
    expect(counts.browserClose).toBe(1);
  });

  it('a navigation throw closes the session and maps to crashed', async () => {
    const { factory, counts } = makeTransport({
      gotoError: new Error('boom'),
    });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('crashed');
    if (result.status !== 'crashed') throw new Error('wrong shape');
    expect(result.reason).toBe('boom');
    expect(counts.pageClose).toBe(1);
    expect(counts.browserClose).toBe(1);
  });

  it('unknown error shapes map to crashed, never to blocked', async () => {
    const { factory } = makeTransport({ gotoError: { weird: true } });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('crashed');
  });

  it('maps the documented TimeoutError shape to timeout', async () => {
    const { factory } = makeTransport({ gotoError: timeoutNamedError() });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('timeout');
  });
});

describe('redirect scope', () => {
  it('refuses a cross-domain redirect and still closes', async () => {
    const { factory, counts } = makeTransport({
      finalUrl: 'https://other.example.net/jobs',
    });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('guard-rejected');
    if (result.status !== 'guard-rejected') throw new Error('wrong shape');
    expect(result.attempts).toBe(1);
    expect(counts.content).toBe(0);
    expect(counts.pageClose).toBe(1);
    expect(counts.browserClose).toBe(1);
  });

  it('allows a same-registrable-domain subdomain redirect', async () => {
    const { factory } = makeTransport({
      finalUrl: 'https://jobs.example.com/listings',
    });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('wrong shape');
    expect(result.finalUrl).toBe('https://jobs.example.com/listings');
  });
});

describe('unavailable tier never throws', () => {
  it('a missing-module factory reports unavailable with an actionable hint', async () => {
    const missing = new Error(
      "Cannot find module 'camoufox-js'",
    ) as Error & { code: string };
    missing.code = 'ERR_MODULE_NOT_FOUND';
    const { factory, counts } = makeTransport({ launchError: missing });
    const result = await fetchRenderedPage(PAGE_URL, { transport: factory });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('wrong shape');
    expect(result.hint).toBe(BROWSER_UNAVAILABLE_HINT);
    expect(counts.browserClose).toBe(0);
  });

  it('the default factory reports unavailable when the tier is absent', async () => {
    // No injected transport: resolves the real optional library, which is
    // absent here and in CI. Must report, never throw.
    const result = await fetchRenderedPage(PAGE_URL, { timeoutMs: 5000 });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('wrong shape');
    expect(result.hint).toContain('cheaper tiers');
  });

  it('isBrowserAvailable never throws and reports a well-formed verdict', async () => {
    const verdict = await isBrowserAvailable();
    expect(typeof verdict.available).toBe('boolean');
    if (!verdict.available) {
      expect(verdict.reason.length).toBeGreaterThan(0);
      expect(verdict.hint).toBe(BROWSER_UNAVAILABLE_HINT);
    }
  });

  it('isBrowserAvailable reports unavailable while the tier is disabled', async () => {
    // Default env in this repo/CI: CAMOUFOX_ENABLED is not "true" and no
    // remote endpoint is configured, so the verdict is deterministic.
    const verdict = await isBrowserAvailable();
    expect(verdict.available).toBe(false);
  });
});

describe('evaluateOnPage', () => {
  it('runs one bounded evaluation after a guarded navigation', async () => {
    const { factory, counts } = makeTransport({ evalValue: { jobs: 3 } });
    const result = await evaluateOnPage(
      PAGE_URL,
      'document.querySelectorAll(".job").length',
      { transport: factory },
    );
    expect(result).toMatchObject({ status: 'ok', attempts: 1 });
    if (result.status !== 'ok') throw new Error('wrong shape');
    expect(result.value).toEqual({ jobs: 3 });
    expect(counts.goto).toBe(1);
    expect(counts.evaluate).toBe(1);
    expect(counts.pageClose).toBe(1);
    expect(counts.browserClose).toBe(1);
  });

  it('rejects an oversized script without launching', async () => {
    const { factory, counts } = makeTransport();
    const result = await evaluateOnPage(
      PAGE_URL,
      'x'.repeat(MAX_EVAL_SCRIPT_CHARS + 1),
      { transport: factory },
    );
    expect(result.status).toBe('crashed');
    expect(counts.launch).toBe(0);
  });

  it('caps oversized results', async () => {
    const { factory } = makeTransport({ evalValue: 'y'.repeat(100) });
    const result = await evaluateOnPage(PAGE_URL, 'big()', {
      transport: factory,
      maxResultChars: 10,
    });
    expect(result.status).toBe('crashed');
    if (result.status !== 'crashed') throw new Error('wrong shape');
    expect(result.reason).toMatch(/exceeds 10 characters/);
  });

  it('reports blocked from the navigation status without evaluating', async () => {
    const { factory, counts } = makeTransport({ httpStatus: 403 });
    const result = await evaluateOnPage(PAGE_URL, 'read()', {
      transport: factory,
    });
    expect(result.status).toBe('blocked');
    expect(counts.evaluate).toBe(0);
  });
});

describe('captureScreenshot', () => {
  it('captures bytes on ok pages', async () => {
    const { factory, counts } = makeTransport({
      screenshotBytes: new Uint8Array([9, 8, 7]),
    });
    const result = await captureScreenshot(PAGE_URL, { transport: factory });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('wrong shape');
    expect(result.mediaType).toBe('image/png');
    expect(Array.from(result.image)).toEqual([9, 8, 7]);
    expect(counts.screenshot).toBe(1);
    expect(counts.pageClose).toBe(1);
    expect(counts.browserClose).toBe(1);
  });

  it('reports blocked without capturing', async () => {
    const { factory, counts } = makeTransport({ httpStatus: 403 });
    const result = await captureScreenshot(PAGE_URL, { transport: factory });
    expect(result.status).toBe('blocked');
    expect(counts.screenshot).toBe(0);
  });
});

describe('session release', () => {
  it('closeBrowserSession swallows close errors and tolerates null', async () => {
    const { factory } = makeTransport({
      browserCloseError: new Error('already closed'),
    });
    const browser = await factory(1000);
    await expect(closeBrowserSession(browser)).resolves.toBeUndefined();
    await expect(closeBrowserSession(null)).resolves.toBeUndefined();
    await expect(closeBrowserSession(undefined)).resolves.toBeUndefined();
  });
});

describe('no secrets handling', () => {
  it('redactCredentials strips userinfo from endpoint text', () => {
    expect(redactCredentials('ws://user:pass@host:3131/x')).toBe(
      'ws://***@host:3131/x',
    );
    expect(redactCredentials('https://host/x')).toBe('https://host/x');
  });
});
