import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { resolveAdzunaCountry, buildAdzunaUrl } from './aggregators.js';
import {
  AGGREGATOR_PROVIDERS,
  isAggregatorProvider,
  isDeprecatedAggregatorProvider,
  fetchAggregator,
} from './aggregators.js';
import { leaseNextKey, markKeySuccess, markKeyFailure } from '../ai/keyManager.js';

vi.mock('../ai/keyManager.js', () => ({
  leaseNextKey: vi.fn(async () => ({ apiKey: 'mock-key', id: 'mock-id' })),
  markKeySuccess: vi.fn(async () => undefined),
  markKeyFailure: vi.fn(async () => undefined),
}));

const CREDS = { appId: 'test-id', appKey: 'test-key' };

function countryOf(location?: string): string {
  const url = new URL(buildAdzunaUrl({ query: 'engineer', location }, CREDS));
  const match = url.pathname.match(/\/jobs\/([^/]+)\/search/);
  return match ? match[1] : '';
}

describe('Adzuna country handling', () => {
  it('defaults to us when no location is given', () => {
    expect(countryOf(undefined)).toBe('us');
    expect(countryOf('')).toBe('us');
    expect(countryOf('New York')).toBe('us');
    expect(resolveAdzunaCountry(undefined)).toEqual({ country: 'us', location: undefined });
  });

  it('resolves in for India locations and "<cc>:" prefixes', () => {
    expect(countryOf('Mumbai, India')).toBe('in');
    expect(countryOf('Bengaluru')).toBe('in');
    expect(countryOf('in:Bengaluru')).toBe('in');
    // Prefix is stripped from the `where` param.
    const url = new URL(buildAdzunaUrl({ query: 'engineer', location: 'in:Bengaluru' }, CREDS));
    expect(url.searchParams.get('where')).toBe('Bengaluru');
  });

  it('resolves gb for UK locations and "<cc>:" prefixes', () => {
    expect(countryOf('London, United Kingdom')).toBe('gb');
    expect(countryOf('London')).toBe('gb');
    expect(countryOf('gb:London')).toBe('gb');
    const url = new URL(buildAdzunaUrl({ query: 'engineer', location: 'gb:London' }, CREDS));
    expect(url.searchParams.get('where')).toBe('London');
  });
});

describe('aggregator provider registry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists exactly the four supported providers', () => {
    expect(AGGREGATOR_PROVIDERS).toEqual(['adzuna', 'usajobs', 'reed', 'findwork']);
  });

  it('isAggregatorProvider accepts registry ids and rejects the rest', () => {
    for (const p of AGGREGATOR_PROVIDERS) expect(isAggregatorProvider(p)).toBe(true);
    expect(isAggregatorProvider('careerjet')).toBe(false);
    expect(isAggregatorProvider('jooble')).toBe(false);
    expect(isAggregatorProvider('')).toBe(false);
    expect(isAggregatorProvider(null)).toBe(false);
    expect(isAggregatorProvider(undefined)).toBe(false);
    expect(isAggregatorProvider('ADZUNA')).toBe(false);
  });

  it('isDeprecatedAggregatorProvider flags only careerjet/jooble', () => {
    expect(isDeprecatedAggregatorProvider('careerjet')).toBe(true);
    expect(isDeprecatedAggregatorProvider('jooble')).toBe(true);
    expect(isDeprecatedAggregatorProvider('adzuna')).toBe(false);
    expect(isDeprecatedAggregatorProvider('usajobs')).toBe(false);
    expect(isDeprecatedAggregatorProvider(null)).toBe(false);
    expect(isDeprecatedAggregatorProvider(undefined)).toBe(false);
  });

  it('rejects deprecated and unknown providers without fetching', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchAggregator('jooble', { query: 'x' })).rejects.toThrow(/no longer supported/);
    await expect(fetchAggregator('nope', { query: 'x' })).rejects.toThrow(/Unknown aggregator/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reaches the usajobs fetcher (no longer "not implemented")', async () => {
    process.env.USAJOBS_EMAIL = 'registry@example.com';
    process.env.USAJOBS_API_KEY = 'registry-key';
    try {
      const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
      vi.stubGlobal('fetch', fetchSpy);
      await expect(fetchAggregator('usajobs', { query: 'x' })).resolves.toEqual([]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.USAJOBS_EMAIL;
      delete process.env.USAJOBS_API_KEY;
    }
  });
});

describe('Adzuna credential merge (env + leased appId:appKey)', () => {
  const ADZUNA_RESULTS = {
    results: [
      {
        id: 'abc123',
        title: 'Backend Engineer',
        company: { display_name: 'AdzunaCo' },
        location: { display_name: 'New York, US' },
        redirect_url: 'https://www.adzuna.com/jobs/abc123',
        description: 'Build APIs.',
        created: '2025-09-01T10:00:00Z',
      },
    ],
  };

  beforeEach(() => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    vi.unstubAllGlobals();
    vi.mocked(leaseNextKey).mockResolvedValue({ apiKey: 'mock-key', id: 'mock-id' } as any);
  });

  it('uses both halves of a combined "appId:appKey" leased key', async () => {
    vi.mocked(leaseNextKey).mockResolvedValue({ apiKey: 'my-app-id:my-app-key', id: 'leased-id' } as any);
    const fetchSpy = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ADZUNA_RESULTS }));
    vi.stubGlobal('fetch', fetchSpy);
    const jobs = await fetchAggregator('adzuna', { query: 'engineer' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(vi.mocked(fetchSpy).mock.calls[0][0]));
    expect(url.searchParams.get('app_id')).toBe('my-app-id');
    expect(url.searchParams.get('app_key')).toBe('my-app-key');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source: 'adzuna', title: 'Backend Engineer', company: 'AdzunaCo' });
  });

  it('supports colon-containing keys (split on the first colon only)', async () => {
    vi.mocked(leaseNextKey).mockResolvedValue({ apiKey: 'my-app-id:part1:part2', id: 'leased-id' } as any);
    const fetchSpy = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ADZUNA_RESULTS }));
    vi.stubGlobal('fetch', fetchSpy);
    await fetchAggregator('adzuna', { query: 'engineer' });
    const url = new URL(String(vi.mocked(fetchSpy).mock.calls[0][0]));
    expect(url.searchParams.get('app_id')).toBe('my-app-id');
    expect(url.searchParams.get('app_key')).toBe('part1:part2');
  });

  it('rejects a single leased key without a colon with a clear APP_ID/APP_KEY error', async () => {
    vi.mocked(leaseNextKey).mockResolvedValue({ apiKey: 'singlekey', id: 'leased-id' } as any);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ADZUNA_RESULTS }));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchAggregator('adzuna', { query: 'engineer' })).rejects.toThrow(/APP_ID and APP_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('merges partial env (ADZUNA_APP_ID only) with the leased halves', async () => {
    process.env.ADZUNA_APP_ID = 'env-app-id';
    vi.mocked(leaseNextKey).mockResolvedValue({ apiKey: 'leased-id:leased-key', id: 'leased-id' } as any);
    const fetchSpy = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ADZUNA_RESULTS }));
    vi.stubGlobal('fetch', fetchSpy);
    const jobs = await fetchAggregator('adzuna', { query: 'engineer' });
    const url = new URL(String(vi.mocked(fetchSpy).mock.calls[0][0]));
    expect(url.searchParams.get('app_id')).toBe('env-app-id');
    expect(url.searchParams.get('app_key')).toBe('leased-key');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe('adzuna');
  });
});

describe('D3: key attribution reuses the leased key (no second lease)', () => {
  const ADZUNA_OK = {
    results: [
      {
        id: 'abc123',
        title: 'Backend Engineer',
        company: { display_name: 'AdzunaCo' },
        location: { display_name: 'New York, US' },
        redirect_url: 'https://www.adzuna.com/jobs/abc123',
        description: 'Build APIs.',
        created: '2025-09-01T10:00:00Z',
      },
    ],
  };

  beforeEach(() => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    vi.unstubAllGlobals();
    vi.mocked(leaseNextKey).mockResolvedValue({ apiKey: 'mock-key', id: 'mock-id' } as any);
  });

  it('marks success on the SAME key the fetch leased (one lease total, rotation-safe)', async () => {
    const recA = { apiKey: 'id-A:key-A', id: 'key-id-A', provider: 'adzuna', source: 'database', userId: 'u1' };
    const recB = { apiKey: 'id-B:key-B', id: 'key-id-B', provider: 'adzuna', source: 'database', userId: 'u1' };
    // Even if rotation would hand out a different key next, marking must use the first.
    vi.mocked(leaseNextKey).mockResolvedValueOnce(recA as any).mockResolvedValue(recB as any);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ADZUNA_OK }));
    vi.stubGlobal('fetch', fetchSpy);
    const jobs = await fetchAggregator('adzuna', { query: 'engineer', userId: 'u1' });
    expect(jobs).toHaveLength(1);
    expect(vi.mocked(leaseNextKey)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markKeySuccess)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markKeySuccess).mock.calls[0][0]).toMatchObject({ id: 'key-id-A' });
    expect(vi.mocked(markKeyFailure)).not.toHaveBeenCalled();
  });

  it('marks failure on the SAME key when the fetch throws', async () => {
    const recA = { apiKey: 'id-A:key-A', id: 'key-id-A', provider: 'adzuna', source: 'database', userId: 'u1' };
    vi.mocked(leaseNextKey).mockResolvedValue(recA as any);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(fetchAggregator('adzuna', { query: 'engineer', userId: 'u1' })).rejects.toThrow(
      /Adzuna failed: 500/
    );
    expect(vi.mocked(leaseNextKey)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markKeyFailure)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markKeyFailure).mock.calls[0][0]).toMatchObject({ id: 'key-id-A' });
    expect(vi.mocked(markKeySuccess)).not.toHaveBeenCalled();
  });

  it('skips marking entirely for env-key fetches (no lease at all)', async () => {
    process.env.ADZUNA_APP_ID = 'env-id';
    process.env.ADZUNA_APP_KEY = 'env-key';
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ADZUNA_OK }));
    vi.stubGlobal('fetch', fetchSpy);
    await fetchAggregator('adzuna', { query: 'engineer' });
    expect(vi.mocked(leaseNextKey)).not.toHaveBeenCalled();
    expect(vi.mocked(markKeySuccess)).not.toHaveBeenCalled();
    expect(vi.mocked(markKeyFailure)).not.toHaveBeenCalled();
  });
});
