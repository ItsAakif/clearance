import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { prismaUpsertMock } = vi.hoisted(() => ({
  prismaUpsertMock: vi.fn(),
}));

vi.mock('../lib/prisma.js', () => ({
  default: { jobListing: { upsert: prismaUpsertMock, update: vi.fn().mockResolvedValue({}) } },
}));

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
  sanitizeJobText,
  withDeterministicExternalId,
} from './jobIdentity.js';
import {
  scrapeBoard,
  resetRapidApiThrottle,
  isRapidApiCoolingDown,
} from './scrapingBackend.js';
import { upsertDiscoveredJobs } from '../routes/jobs.js';
import type { RawJob } from './index.js';

const ARROW = '→'; // U+2192, UTF-8 bytes 0xE2 0x86 0x92 - no WIN1252 equivalent

function makeRawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: 'rapidapi',
    sourceUrl: 'https://example.com/jobs/1',
    title: 'Senior Engineer',
    company: 'Acme',
    location: 'Remote',
    description: 'Build things.',
    applyUrl: 'https://example.com/jobs/1',
    ...overrides,
  };
}

describe('WIN1252 sanitize (backend 500 on upsert)', () => {
  it(`transliterates U+2192 (${ARROW}) instead of passing it to Prisma`, () => {
    expect(sanitizeJobText(`Senior ${ARROW} Engineer`)).toBe('Senior -> Engineer');
  });

  it('replaces lone surrogates, strips NUL, and maps astral chars to ?', () => {
    expect(sanitizeJobText('a\ud800b')).toBe('a?b');
    expect(sanitizeJobText('a\udc00b')).toBe('a?b');
    expect(sanitizeJobText('a\x00b')).toBe('ab');
    expect(sanitizeJobText('Dev \u{1F680}')).toBe('Dev ?');
    expect(sanitizeJobText('CJK \u6f22\u5b57 test')).toBe('CJK ?? test');
  });

  it('preserves WIN1252-encodable text byte-for-byte', () => {
    const safe = 'caf\u00e9 \u2014 \u201cHi\u201d \u20ac \u2026 \u00fc \u00a0';
    expect(sanitizeJobText(safe)).toBe(safe);
  });

  it('hash is stable post-sanitize (raw arrow vs sanitized arrow hash alike)', () => {
    const raw = makeRawJob({ title: `Senior ${ARROW} Engineer`, externalId: undefined });
    const preSanitized = makeRawJob({ title: 'Senior -> Engineer', externalId: undefined });
    expect(withDeterministicExternalId(raw).externalId).toBe(
      withDeterministicExternalId(preSanitized).externalId,
    );
  });

  it('upsert of a job containing U+2192 succeeds with WIN1252-safe values', async () => {
    prismaUpsertMock.mockImplementation(async ({ create }: any) => ({ id: 'listing-1', ...create }));
    const jobs = [
      makeRawJob({
        externalId: 'arrow-1',
        title: `Senior ${ARROW} Engineer`,
        description: `Ship ${ARROW} fast \u{1F680}`,
      }),
    ];
    const upserted = await upsertDiscoveredJobs(jobs);
    expect(upserted).toHaveLength(1);
    expect(prismaUpsertMock).toHaveBeenCalledTimes(1);
    const create = prismaUpsertMock.mock.calls[0][0].create;
    expect(create.title).toBe('Senior -> Engineer');
    expect(create.description).toBe('Ship -> fast ?');
    expect(create.title).not.toContain(ARROW);
    expect(create.description).not.toContain(ARROW);
  });
});

describe('RapidAPI 429 / fallback storm calm', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    resetRapidApiThrottle();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown = {}) {
    const fetchMock = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('concurrent boards share in-flight upstreams, warn once per board, then cool down', async () => {
    const fetchMock = stubFetch(429);
    const settled = await Promise.allSettled([
      scrapeBoard({ provider: 'linkedin', query: 'engineer' }),
      scrapeBoard({ provider: 'indeed', query: 'engineer' }),
      scrapeBoard({ provider: 'linkedin', query: 'engineer' }),
    ]);
    // Every board surfaces ONE aggregated failure (route records failed health
    // once per board via its own catch) - never key material, never a hang.
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      if (s.status === 'rejected') {
        expect(String((s.reason as Error).message)).toMatch(/RapidAPI all upstreams failed/);
        expect(String((s.reason as Error).message)).not.toContain('SECRET-KEY-VALUE');
      }
    }
    // Unique upstream URLs fetched once (JSearch x1 shared,
    // PullAPI LinkedIn x1, PullAPI Indeed x1) - not N boards x M upstreams.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
    // At most one fallback line per board + one cooldown line - not ~24 lines.
    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(4);
    expect(isRapidApiCoolingDown()).toBe(true);
  });

  it('post-429 searches skip RapidAPI with zero fetches (cooldown, no busy retry)', async () => {
    const fetchMock = stubFetch(429);
    await expect(scrapeBoard({ provider: 'linkedin', query: 'engineer' })).rejects.toThrow(
      /RapidAPI all upstreams failed/,
    );
    expect(isRapidApiCoolingDown()).toBe(true);
    const fetchesAfterFirst = fetchMock.mock.calls.length;
    const warnsAfterFirst = warnSpy.mock.calls.length;

    await expect(scrapeBoard({ provider: 'ziprecruiter', query: 'engineer' })).rejects.toThrow(
      /RapidAPI all upstreams failed/,
    );
    // Cooldown short-circuits every upstream: no new HTTP calls at all.
    expect(fetchMock.mock.calls.length).toBe(fetchesAfterFirst);
    // At most one new fallback line for the new board signature - no repeat storm.
    expect(warnSpy.mock.calls.length - warnsAfterFirst).toBeLessThanOrEqual(1);
  });

  it('PullAPI fallback fires at most once per upstream per search (shared cache)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('jsearch.p.rapidapi.com')) return { ok: false, status: 403, json: async () => ({}) };
      if (u.includes('linkedin-scraper-api6.p.rapidapi.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { jobs: [{ job_url: 'https://example.com/li/1', title: 'Eng', company: 'LiCo' }] } }),
        };
      }
      if (u.includes('indeed-scraper-api2.p.rapidapi.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { jobs: [{ job_url: 'https://example.com/iv/1', title: 'Eng', company: 'IvCo' }] } }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const [li, iv] = await Promise.all([
      scrapeBoard({ provider: 'linkedin', query: 'engineer' }),
      scrapeBoard({ provider: 'indeed', query: 'engineer' }),
    ]);
    expect(li.length).toBeGreaterThan(0);
    expect(iv.length).toBeGreaterThan(0);
    const countHost = (host: string) =>
      fetchMock.mock.calls.filter((c) => String(c[0]).includes(host)).length;
    // One JSearch call shared by both boards; one PullAPI call per endpoint.
    expect(countHost('jsearch.p.rapidapi.com')).toBe(1);
    expect(countHost('linkedin-scraper-api6.p.rapidapi.com')).toBe(1);
    expect(countHost('indeed-scraper-api2.p.rapidapi.com')).toBe(1);
  });
});
