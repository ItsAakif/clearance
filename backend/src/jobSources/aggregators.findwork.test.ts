import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFindworkUrl, fetchFindwork } from './aggregators.findwork.js';

const leaseNextKeyMock = vi.fn();

vi.mock('../ai/keyManager.js', () => ({
  leaseNextKey: (...args: any[]) => leaseNextKeyMock(...args),
  markKeySuccess: vi.fn(async () => undefined),
  markKeyFailure: vi.fn(async () => undefined),
}));

const SAVED_ENV = { ...process.env };
const KEY = 'findwork-test-token';

function okResponse(payload: any) {
  return { ok: true, status: 200, json: async () => payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FINDWORK_API_KEY;
  leaseNextKeyMock.mockResolvedValue({ apiKey: KEY, id: 'k1' });
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  vi.unstubAllGlobals();
});

describe('buildFindworkUrl', () => {
  it('produces a bare endpoint when query/location are empty', () => {
    const url = new URL(buildFindworkUrl({ query: '', location: '' }));
    expect(url.searchParams.get('search')).toBeNull();
    expect(url.searchParams.get('location')).toBeNull();
    expect(url.searchParams.get('order_by')).toBeNull();
    expect(url.searchParams.get('limit')).toBeNull();
    expect(url.searchParams.get('count')).toBeNull();
  });

  it('sends search=<q> and never an ordering/count param', () => {
    const url = new URL(buildFindworkUrl({ query: 'engineer', location: 'Remote' }));
    expect(url.searchParams.get('search')).toBe('engineer');
    expect(url.searchParams.get('location')).toBe('Remote');
    expect(url.searchParams.get('order_by')).toBeNull();
    expect(url.searchParams.get('limit')).toBeNull();
    expect(url.searchParams.get('count')).toBeNull();
    expect(url.searchParams.get('page_size')).toBeNull();
  });
});

describe('fetchFindwork auth', () => {
  it('retries once with Bearer after a 401 on Token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce(okResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchFindwork({ query: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0] as any[])[1].headers.Authorization).toBe(`Token ${KEY}`);
    expect((fetchMock.mock.calls[1] as any[])[1].headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('does not retry on a non-auth failure', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchFindwork({ query: 'x' })).rejects.toThrow('Findwork failed: 500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls fetch exactly once when Token succeeds', async () => {
    const fetchMock = vi.fn(async () => okResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchFindwork({ query: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as any[])[1].headers.Authorization).toBe(`Token ${KEY}`);
  });

  it('throws naming FINDWORK_API_KEY before any fetch when no key exists', async () => {
    leaseNextKeyMock.mockRejectedValue(new Error('no key'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchFindwork({ query: 'x' })).rejects.toThrow(/FINDWORK_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchFindwork mapping', () => {
  it('maps a complete item and a minimal item without "undefined" strings', async () => {
    const payload = {
      results: [
        {
          id: 42,
          role: 'Frontend Engineer',
          company_name: 'Acme',
          location: 'Remote',
          text: 'Build UIs.',
          url: 'https://findwork.dev/jobs/42',
          date_posted: '2026-09-10T00:00:00Z',
        },
        { title: 'Designer', company: 'Beta', description: 'Design things.' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(payload)));
    const jobs = await fetchFindwork({ query: 'x' });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: 'findwork-42',
      source: 'findwork',
      title: 'Frontend Engineer',
      company: 'Acme',
      applyUrl: 'https://findwork.dev/jobs/42',
      sourceUrl: 'https://findwork.dev/jobs/42',
    });
    expect(jobs[1].externalId).toBeDefined();
    expect(jobs[1].applyUrl).toBe('');
    expect(jobs[1].sourceUrl).toBe('');
    expect(String(jobs[1].applyUrl)).not.toContain('undefined');
  });

  it('maps a remote-only item location to "Remote"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([{ id: 7, role: 'Dev', remote: true }])));
    const jobs = await fetchFindwork({ query: 'x' });
    expect(jobs[0].location).toBe('Remote');
  });

  it('tolerates a bare array and data.jobs shapes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse([{ id: 1, role: 'A' }])));
    await expect(fetchFindwork({ query: 'x' })).resolves.toHaveLength(1);
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ jobs: [{ id: 2, role: 'B' }] })));
    const jobs = await fetchFindwork({ query: 'x' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].externalId).toBe('findwork-2');
  });

  it('returns newest-first when postedAt is present', async () => {
    const payload = [
      { id: 1, role: 'Old', date_posted: '2026-01-01T00:00:00Z' },
      { id: 2, role: 'New', date_posted: '2026-09-01T00:00:00Z' },
      { id: 3, role: 'Mid', date_posted: '2026-06-01T00:00:00Z' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(payload)));
    const jobs = await fetchFindwork({ query: 'x' });
    expect(jobs.map((j) => j.title)).toEqual(['New', 'Mid', 'Old']);
  });
});
