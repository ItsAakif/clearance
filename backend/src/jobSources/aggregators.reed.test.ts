import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildReedSearchUrl, fetchReed } from './aggregators.reed.js';

const leaseNextKeyMock = vi.fn();

vi.mock('../ai/keyManager.js', () => ({
  leaseNextKey: (...args: any[]) => leaseNextKeyMock(...args),
  markKeySuccess: vi.fn(async () => undefined),
  markKeyFailure: vi.fn(async () => undefined),
}));

const SAVED_ENV = { ...process.env };
const KEY = 'reed-test-key';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.REED_API_KEY;
  leaseNextKeyMock.mockRejectedValue(new Error('no key'));
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  vi.unstubAllGlobals();
});

describe('buildReedSearchUrl', () => {
  it('encodes the key as Basic base64("<key>:") with the trailing colon', () => {
    const { headers } = buildReedSearchUrl({ query: 'x' }, { apiKey: KEY });
    const header: string = headers.Authorization;
    expect(header.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(header.slice('Basic '.length), 'base64').toString()).toBe(`${KEY}:`);
  });

  it('caps resultsToTake at 50 and defaults to 20', () => {
    const capped = new URL(buildReedSearchUrl({ query: 'x', resultsWanted: 200 }, { apiKey: KEY }).url);
    expect(capped.searchParams.get('resultsToTake')).toBe('50');
    const def = new URL(buildReedSearchUrl({ query: 'x' }, { apiKey: KEY }).url);
    expect(def.searchParams.get('resultsToTake')).toBe('20');
  });

  it('omits keywords/locationName when empty; sends location as locationName only', () => {
    const bare = new URL(buildReedSearchUrl({ query: '', location: '' }, { apiKey: KEY }).url);
    expect(bare.searchParams.get('keywords')).toBeNull();
    expect(bare.searchParams.get('locationName')).toBeNull();
    expect(bare.searchParams.get('location')).toBeNull();
    const withLoc = new URL(buildReedSearchUrl({ query: 'dev', location: 'London' }, { apiKey: KEY }).url);
    expect(withLoc.searchParams.get('keywords')).toBe('dev');
    expect(withLoc.searchParams.get('locationName')).toBe('London');
    expect(withLoc.searchParams.get('location')).toBeNull();
  });
});

describe('fetchReed', () => {
  it('maps a complete and a minimal item defensively', async () => {
    process.env.REED_API_KEY = KEY;
    const payload = {
      totalResults: 2,
      results: [
        {
          jobId: 12345,
          jobTitle: 'Backend Engineer',
          employerName: 'Acme UK',
          locationName: 'London',
          description: 'Build APIs.',
        },
        { jobId: 67890, jobTitle: 'Designer' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
    const jobs = await fetchReed({ query: 'engineer' });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: 'reed-12345',
      source: 'reed',
      title: 'Backend Engineer',
      company: 'Acme UK',
      location: 'London',
      description: 'Build APIs.',
      applyUrl: 'https://www.reed.co.uk/jobs/12345',
      sourceUrl: 'https://www.reed.co.uk/jobs/12345',
    });
    expect(jobs[1]).toMatchObject({
      externalId: 'reed-67890',
      source: 'reed',
      title: 'Designer',
      company: 'Unknown',
      description: '',
    });
    expect(typeof jobs[1].applyUrl).toBe('string');
    expect((jobs[1].applyUrl as string).length).toBeGreaterThan(0);
  });

  it('returns [] when results is missing', async () => {
    process.env.REED_API_KEY = KEY;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    await expect(fetchReed({ query: 'x' })).resolves.toEqual([]);
  });

  it('throws naming REED_API_KEY before any fetch when no key exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchReed({ query: 'x' })).rejects.toThrow(/REED_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a 401 as "Reed failed: 401"', async () => {
    process.env.REED_API_KEY = KEY;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));
    await expect(fetchReed({ query: 'x' })).rejects.toThrow('Reed failed: 401');
  });
});
