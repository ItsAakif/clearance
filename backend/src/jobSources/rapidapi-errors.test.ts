import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/prisma.js', () => ({ default: {} }));

vi.mock('../lib/crypto.js', () => ({ decryptSecret: (s: string) => s }));

vi.mock('../ai/keyManager.js', () => ({
  leaseNextKey: vi.fn(async () => ({
    id: 'rapidapi-key-1',
    apiKey: 'SECRET-KEY-VALUE',
    provider: 'rapidapi',
    source: 'database',
    userId: 'user-1',
  })),
  markKeySuccess: vi.fn(async () => undefined),
  markKeyFailure: vi.fn(async () => undefined),
}));

import {
  classifyRapidStatus,
  isRapidHostDisabled,
  isRapidApiCoolingDown,
  resetRapidApiThrottle,
  scrapeBoard,
} from './scrapingBackend.js';

describe('classifyRapidStatus', () => {
  it('maps 403/404 to terminal', () => {
    expect(classifyRapidStatus(403)).toBe('terminal');
    expect(classifyRapidStatus(404)).toBe('terminal');
  });
  it('maps 429 to rate_limited', () => {
    expect(classifyRapidStatus(429)).toBe('rate_limited');
  });
  it('maps everything else to transient', () => {
    for (const s of [500, 408, 200, 0, 401, 502]) {
      expect(classifyRapidStatus(s)).toBe('transient');
    }
  });
});

describe('terminal per-host disable', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    resetRapidApiThrottle();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRapidApiThrottle();
  });

  it('disables the jsearch host after 404 and skips the second upstream call', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('jsearch.p.rapidapi.com')) {
        return {
          ok: false,
          status: 404,
          text: async () => '{"message":"You are not subscribed to this API."}',
          json: async () => ({}),
        };
      }
      return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const err = await scrapeBoard({ provider: 'linkedin', query: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain('jsearch.p.rapidapi.com');
    expect(String(err.message)).toContain('not subscribed');
    expect(isRapidHostDisabled('jsearch.p.rapidapi.com')).toContain('not subscribed');
    expect(String(err.message)).not.toContain('SECRET-KEY-VALUE');

    const jsearchCallsAfterFirst = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('jsearch.p.rapidapi.com'),
    ).length;
    expect(jsearchCallsAfterFirst).toBe(1);

    // Second board: jsearch host must not be fetched again (disabled), but
    // other hosts (pull/linkedin + pull/indeed) remain reachable (per-host isolation).
    await scrapeBoard({ provider: 'indeed', query: 'x' }).catch(() => undefined);
    const jsearchCallsAfterSecond = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('jsearch.p.rapidapi.com'),
    ).length;
    expect(jsearchCallsAfterSecond).toBe(1);
    expect(isRapidHostDisabled('linkedin-scraper-api6.p.rapidapi.com')).toBeUndefined();
  });

  it('429 sets cooldown and reset clears host-disable state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => 'too many',
        json: async () => ({}),
      })),
    );
    await scrapeBoard({ provider: 'linkedin', query: 'x' }).catch(() => undefined);
    expect(isRapidApiCoolingDown()).toBe(true);
    resetRapidApiThrottle();
    expect(isRapidApiCoolingDown()).toBe(false);
    expect(isRapidHostDisabled('jsearch.p.rapidapi.com')).toBeUndefined();
  });

  it('bounds long error bodies and never leaks the key', async () => {
    const longBody = 'E'.repeat(5000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => longBody,
        json: async () => ({}),
      })),
    );
    const err = await scrapeBoard({ provider: 'linkedin', query: 'x' }).catch((e) => e);
    const msg = String((err as Error).message);
    expect(msg).not.toContain('SECRET-KEY-VALUE');
    expect(msg.length).toBeLessThan(2000);
  });

  it('JSearch requests hit /search-v2 with query/num_pages/date_posted and no page/location params', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return { ok: true, status: 200, text: async () => '', json: async () => ({ data: [] }) };
      }),
    );
    await scrapeBoard({ provider: 'linkedin', query: 'engineer' });
    const jsearchUrl = seen.find((u) => u.includes('jsearch.p.rapidapi.com'));
    expect(jsearchUrl).toBeDefined();
    expect(jsearchUrl).toContain('/search-v2');
    expect(jsearchUrl).toContain('date_posted=month');
    const parsed = new URL(jsearchUrl!);
    expect(parsed.searchParams.has('page')).toBe(false);
    expect(parsed.searchParams.has('location')).toBe(false);
    expect(parsed.searchParams.get('num_pages')).toBe('1');
  });

  it('folds a supplied location into the free-form query', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return { ok: true, status: 200, text: async () => '', json: async () => ({ data: [] }) };
      }),
    );
    await scrapeBoard({ provider: 'linkedin', query: 'engineer', location: 'Berlin' });
    const jsearchUrl = seen.find((u) => u.includes('jsearch.p.rapidapi.com'));
    expect(jsearchUrl).toBeDefined();
    const parsed = new URL(jsearchUrl!);
    expect(parsed.searchParams.get('query')).toBe('engineer in Berlin');
    expect(parsed.searchParams.has('location')).toBe(false);
  });
});
