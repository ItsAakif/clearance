// Tier-4 browser adapter tests (Wave 6, T724). Fixture-driven; mocked
// pool/client, no real launch (per the task verification contract).
//
// The browser client is stubbed UNAVAILABLE for this whole file
// (`vi.mock('./client.js')` below): every `runSource` browser test below
// therefore exercises the real lazy descriptor path with the tier absent,
// which is exactly the N2 shape the task requires (skipped-with-reason,
// never failed, normal search unaffected). Unit tests that need page
// content inject `deps.fetchPage` / `deps.isAvailable` directly.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

vi.mock('./client.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./client.js')>();
  return {
    ...orig,
    isBrowserAvailable: vi.fn(async () => ({
      available: false,
      reason: 'stubbed unavailable: engine absent for test',
      hint: 'test hint',
    })),
    fetchRenderedPage: vi.fn(async () => {
      throw new Error('fetchRenderedPage must not be called while the tier is stubbed unavailable');
    }),
  };
});

import {
  BROWSER_SOURCE_ID,
  MAX_BROWSER_POSTINGS,
  BrowserTierSkippedError,
  fetchViaBrowser,
  type BrowserTierDeps,
} from './tier.js';
import {
  PROVIDERS,
  getProvider,
} from '../jobSources/providerRegistry.js';
import { getDefaultBoards } from '../jobSources/boardCatalog.js';
import { runSource, type JobSourceConfig } from '../jobSources/index.js';
import { SourceConfigError } from '../jobSources/providerRegistry.js';
import type { BrowserPool } from './pool.js';
import type { FetchPageResult } from './client.js';

const HERE = __dirname;
const SRC_ROOT = path.resolve(HERE, '..');

const PAGE_URL = 'https://careers.acme.example/jobs';

const available = (): BrowserTierDeps['isAvailable'] =>
  (async () => ({ available: true, mode: 'library' as const }));

function okPage(html: string): (url: string) => Promise<FetchPageResult> {
  return async (url: string) => ({
    status: 'ok',
    url,
    finalUrl: url,
    httpStatus: 200,
    html,
    truncated: false,
    attempts: 1,
  });
}

function jsonLdPage(postings: unknown[], extraHead = ''): string {
  return (
    `<html><head>${extraHead}<script type="application/ld+json">` +
    `${JSON.stringify(postings)}</script></head>` +
    `<body><div id="app">rendered client app</div></body></html>`
  );
}

const posting = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  '@type': 'JobPosting',
  title: 'Senior Backend Engineer',
  datePosted: '2026-09-10',
  hiringOrganization: { name: 'Acme' },
  jobLocation: { address: { addressLocality: 'Berlin', addressCountry: 'DE' } },
  url: 'https://careers.acme.example/jobs/1',
  description: '<p>Build backend things</p>',
  identifier: 'acme-1',
  ...overrides,
});

// Global-fetch stub for the ATS-delegation test (delegation reuses the
// plain-HTTP tier-1 fetchers, so stubbing fetch keeps the test hermetic).
const realFetch = globalThis.fetch;
function stubFetch(handler: (url: string) => unknown): void {
  globalThis.fetch = (async (url: unknown) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => handler(String(url)),
    text: async () => JSON.stringify(handler(String(url))),
    body: undefined,
  })) as unknown as typeof fetch;
}
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('fetchViaBrowser extraction (rendered DOM, shared implementation)', () => {
  it('extracts JSON-LD JobPosting rows from a rendered-DOM fixture', async () => {
    const rows = await fetchViaBrowser(PAGE_URL, 'engineer', {
      isAvailable: available(),
      fetchPage: okPage(jsonLdPage([posting()])),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: BROWSER_SOURCE_ID,
      title: 'Senior Backend Engineer',
      company: 'Acme',
      postedAtSource: 'source-posted',
      postedAtRaw: '2026-09-10',
    });
    expect(rows[0].postedAt).toBeInstanceOf(Date);
  });

  it('a page showing only a relative date yields discovery-at with null postedAt', async () => {
    const { datePosted: _dropped, ...noDate } = posting();
    const html = jsonLdPage([noDate]).replace(
      '</body>',
      '<p>Posted 2 days ago</p></body>',
    );
    const rows = await fetchViaBrowser(PAGE_URL, 'engineer', {
      isAvailable: available(),
      fetchPage: okPage(html),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAtSource).toBe('discovery-at');
    expect(rows[0].postedAt).toBeUndefined();
  });

  it('an index/render date is NEVER used as postedAt', async () => {
    const { datePosted: _dropped, ...noDate } = posting();
    const html = jsonLdPage(
      [noDate],
      '<meta property="article:published_time" content="2026-09-18T00:00:00Z" />',
    );
    const rows = await fetchViaBrowser(PAGE_URL, 'engineer', {
      isAvailable: available(),
      fetchPage: okPage(html),
    });
    expect(rows).toHaveLength(1);
    // The render/index signal (2026-09-18) must not leak into postedAt.
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAtSource).toBe('discovery-at');
  });

  it('delegates a recognised ATS link to the tier-1 adapter (greenhouse)', async () => {
    stubFetch((url: string) => {
      if (url.includes('boards-api.greenhouse.io')) {
        return {
          jobs: [
            {
              id: 7,
              title: 'Backend Engineer',
              absolute_url: 'https://boards.greenhouse.io/acme/jobs/7',
              location: { name: 'Remote' },
              content: 'Greenhouse description',
              updated_at: '2026-09-01T00:00:00Z',
            },
          ],
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const html =
      '<html><head></head><body><div id="app">' +
      '<a href="https://boards.greenhouse.io/acme">View jobs</a>' +
      '</div></body></html>';
    const rows = await fetchViaBrowser(PAGE_URL, 'engineer', {
      isAvailable: available(),
      fetchPage: okPage(html),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'greenhouse', title: 'Backend Engineer' });
  });

  it('returns a clean [] when the rendered DOM has neither JSON-LD nor ATS links', async () => {
    const rows = await fetchViaBrowser(PAGE_URL, 'engineer', {
      isAvailable: available(),
      fetchPage: okPage('<html><body><div id="app">Nothing here</div></body></html>'),
    });
    expect(rows).toEqual([]);
  });

  it('caps rendered postings at MAX_BROWSER_POSTINGS and reports the truncation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: MAX_BROWSER_POSTINGS + 5 }, (_, i) =>
      posting({ title: `Engineer ${i}`, identifier: `acme-${i}`, url: `https://careers.acme.example/jobs/${i}` }),
    );
    const rows = await fetchViaBrowser(PAGE_URL, 'engineer', {
      isAvailable: available(),
      fetchPage: okPage(jsonLdPage(many)),
    });
    expect(rows).toHaveLength(MAX_BROWSER_POSTINGS);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('truncated');
  });
});

describe('fetchViaBrowser runs its URLs through the pool (T723 caps apply)', () => {
  it('passes the URL task to the pool and honours a pool-reported drop as clean []', async () => {
    let fetchCalls = 0;
    const seen: string[] = [];
    const fakePool: BrowserPool = {
      get activeSessions(): number {
        return 0;
      },
      cancel(): void {},
      async run<T>(tasks: Array<{ url: string; run: () => Promise<T> }>): Promise<
        Array<{ url: string; ok: boolean; value?: T; reason?: string }>
      > {
        for (const t of tasks) seen.push(t.url);
        // Simulate an over-cap drop: reported, never silent, never thrown.
        return tasks.map((t) => ({
          url: t.url,
          ok: false,
          reason: 'truncated: exceeds CAMOUFOX_MAX_URLS_PER_RUN=1',
        }));
      },
    };
    const rows = await fetchViaBrowser(PAGE_URL, 'engineer', {
      isAvailable: available(),
      pool: fakePool,
      fetchPage: async (url: string) => {
        fetchCalls += 1;
        return {
          status: 'ok',
          url,
          finalUrl: url,
          httpStatus: 200,
          html: jsonLdPage([posting()]),
          truncated: false,
          attempts: 1,
        };
      },
    });
    expect(seen).toEqual([PAGE_URL]);
    // The pool spent no session on the dropped URL: the visit never ran.
    expect(fetchCalls).toBe(0);
    expect(rows).toEqual([]);
  });

  it('a blocked visit surfaces as clean [] (reported, not circumvented, not failed)', async () => {
    const rows = await fetchViaBrowser(PAGE_URL, 'engineer', {
      isAvailable: available(),
      fetchPage: async (url: string) => ({
        status: 'blocked',
        url,
        reason: 'blocked: challenge marker observed (captcha)',
        attempts: 1,
      }),
    });
    expect(rows).toEqual([]);
  });
});

describe('fetchViaBrowser unavailable path (N2: skipped-with-reason, NOT failed)', () => {
  it('throws BrowserTierSkippedError (skipped, not failed) when the tier is unavailable', async () => {
    let fetchCalls = 0;
    const p = fetchViaBrowser(PAGE_URL, 'engineer', {
      isAvailable: async () => ({
        available: false,
        reason: 'stubbed: engine absent',
        hint: 'stub hint',
      }),
      fetchPage: async (url: string) => {
        fetchCalls += 1;
        return {
          status: 'unavailable',
          url,
          reason: 'must not be reached',
          attempts: 0,
        };
      },
    });
    await expect(p).rejects.toThrowError(BrowserTierSkippedError);
    await expect(p).rejects.toThrow(/stubbed: engine absent/);
    try {
      await fetchViaBrowser(PAGE_URL, 'engineer', {
        isAvailable: async () => ({ available: false, reason: 'x', hint: 'y' }),
      });
      expect.unreachable('must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BrowserTierSkippedError);
      expect((err as BrowserTierSkippedError).skipped).toBe(true);
      expect((err as Error).name).toBe('BrowserTierSkippedError');
    }
    // Zero transport attempts when unavailable: the guard is availability.
    expect(fetchCalls).toBe(0);
  });

  it('a normal search still runs while the tier is stubbed unavailable', async () => {
    // Empty effective query is an intentional empty (no network): the app
    // serves searches with the browser tier entirely absent.
    await expect(runSource({ type: 'search', query: '' })).resolves.toEqual([]);
  });

  it('runSource browser via the real lazy path reports skipped-with-reason, not failed', async () => {
    // The descriptor handler lazy-imports the real tier module, whose
    // client is stubbed unavailable for this file: the rejection must be
    // the skipped brand (wave 7 maps it to a skipped unit result).
    const config = {
      type: 'browser',
      feedUrl: PAGE_URL,
      deepMode: true,
      query: 'engineer',
    } as JobSourceConfig;
    await expect(runSource(config)).rejects.toThrowError(BrowserTierSkippedError);
    await expect(runSource(config)).rejects.toThrow(/stubbed unavailable/);
  });

  it('runSource browser without deepMode throws SourceConfigError (deep-mode-only)', async () => {
    await expect(
      runSource({ type: 'browser', feedUrl: PAGE_URL, query: 'x' }),
    ).rejects.toThrowError(SourceConfigError);
    await expect(
      runSource({ type: 'browser', feedUrl: PAGE_URL, query: 'x' }),
    ).rejects.toThrow(/deep mode only/);
  });
});

describe('browser descriptor (registry declaration side, T724 STEP 3)', () => {
  it('carries tier 4, deep-mode requires, and enabledByDefault false', () => {
    const d = getProvider('browser');
    expect(d).toBeDefined();
    expect(d!.tier).toBe(4);
    expect(d!.enabledByDefault).toBe(false);
    expect([...d!.requires]).toEqual(expect.arrayContaining(['feedUrl', 'deepMode']));
    expect(d!.sourceIds).toEqual([BROWSER_SOURCE_ID]);
    expect(d!.kind).toBe('browser');
  });

  it('is never seeded and never auto-enabled', () => {
    expect(getDefaultBoards().some((b) => (b.type as string) === 'browser')).toBe(false);
    for (const p of PROVIDERS) {
      if (p.type === 'browser') expect(p.enabledByDefault).toBe(false);
    }
  });

  it('no tier-1/2/3 descriptor points at the browser handler', () => {
    for (const d of PROVIDERS) {
      if (d.tier === 1 || d.tier === 2 || d.tier === 3) {
        expect(String(d.handler), `${d.type}.handler`).not.toMatch(/browser/i);
      }
    }
    // Positive control: the tier-4 browser descriptor DOES own the handler.
    expect(String(getProvider('browser')!.handler)).toMatch(/browser/i);
  });
});

describe('browser tier structural guards (N2 proof by construction)', () => {
  function allSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        out.push(...allSourceFiles(full));
      } else if (entry.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('nothing outside the lazy path statically imports backend/src/browser/*', () => {
    const files = allSourceFiles(SRC_ROOT).filter(
      (f) => !f.endsWith('.test.ts') && !f.startsWith(path.join(SRC_ROOT, 'browser') + path.sep),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const rel = path.relative(SRC_ROOT, file);
      for (const line of text.split('\n')) {
        // Static imports AND re-exports (but never the dynamic lazy path).
        if (/^\s*import\b(?!\s*\()/.test(line) || /^\s*export\b.*\bfrom\b/.test(line)) {
          expect(line, `${rel} statically imports browser`).not.toMatch(/browser\//);
        }
        if (/require\s*\(/.test(line)) {
          expect(line, `${rel} requires browser`).not.toMatch(/browser\//);
        }
      }
      // Dynamic browser imports are allowed ONLY in the registry lazy path.
      const dynamicBrowser = (text.match(/import\s*\([^)]*browser\//g) ?? []).length;
      if (rel === path.join('jobSources', 'providerRegistry.ts')) {
        expect(dynamicBrowser).toBe(1);
      } else {
        expect(dynamicBrowser, `${rel} dynamic browser import`).toBe(0);
      }
    }
  });

  it('no challenge-solving, sign-in, or identity-cycling mechanism exists in the tier', () => {
    // Mechanism tokens (implementation signatures), NOT report-only words:
    // the client classifies challenge markup to REPORT `blocked`; that
    // detection vocabulary lives in client.ts and is out of scope here.
    // This test pins the tier adapter itself to visit-and-read only.
    const text = readFileSync(path.join(HERE, 'tier.ts'), 'utf8').toLowerCase();
    const forbidden = [
      'captcha',
      '2captcha',
      'anticaptcha',
      'recaptcha',
      'hcaptcha',
      'turnstile',
      'datadome',
      'perimeterx',
      'arkose',
      'proxy',
      'rotat',
      'spoof',
      'harvest',
      'bypass',
      'evad',
      'login',
      'password',
      'cookie',
    ];
    for (const token of forbidden) {
      expect(text, `tier.ts contains "${token}"`).not.toContain(token);
    }
  });
});
