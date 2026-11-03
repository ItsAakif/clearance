import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildUsaJobsUrl, fetchUsaJobs } from './aggregators.usajobs.js';

const leaseNextKeyMock = vi.fn();

vi.mock('../ai/keyManager.js', () => ({
  leaseNextKey: (...args: any[]) => leaseNextKeyMock(...args),
  markKeySuccess: vi.fn(async () => undefined),
  markKeyFailure: vi.fn(async () => undefined),
}));

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.USAJOBS_EMAIL;
  delete process.env.USAJOBS_API_KEY;
  leaseNextKeyMock.mockResolvedValue({ apiKey: 'user@example.com:secret-key', id: 'k1' });
});

afterEach(() => {
  process.env = { ...SAVED_ENV };
  vi.unstubAllGlobals();
});

function okResponse(payload: any) {
  return { ok: true, status: 200, json: async () => payload };
}

describe('buildUsaJobsUrl', () => {
  it('includes Keyword/LocationName and always WhoMayApply=Public', () => {
    const url = new URL(buildUsaJobsUrl({ query: 'engineer', location: 'Texas' }));
    expect(url.searchParams.get('Keyword')).toBe('engineer');
    expect(url.searchParams.get('LocationName')).toBe('Texas');
    expect(url.searchParams.get('WhoMayApply')).toBe('Public');
    expect(url.searchParams.get('ResultsPerPage')).toBe('20');
    expect(url.searchParams.get('Page')).toBe('1');
  });

  it('omits Keyword when the query is empty', () => {
    const url = new URL(buildUsaJobsUrl({ query: '' }));
    expect(url.searchParams.get('Keyword')).toBeNull();
    expect(url.searchParams.get('WhoMayApply')).toBe('Public');
  });

  it('caps ResultsPerPage at 50 and defaults to 20', () => {
    expect(new URL(buildUsaJobsUrl({ query: 'x', resultsWanted: 200 })).searchParams.get('ResultsPerPage')).toBe('50');
    expect(new URL(buildUsaJobsUrl({ query: 'x' })).searchParams.get('ResultsPerPage')).toBe('20');
  });
});

describe('fetchUsaJobs', () => {
  it('sends Host, User-Agent=email and Authorization-Key headers', async () => {
    process.env.USAJOBS_EMAIL = 'reader@example.com';
    process.env.USAJOBS_API_KEY = 'abc123';
    const fetchMock = vi.fn(async () => okResponse({ SearchResult: { SearchResultItems: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchUsaJobs({ query: 'engineer' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0] as any[])[1].headers;
    expect(headers).toMatchObject({
      Host: 'data.usajobs.gov',
      'User-Agent': 'reader@example.com',
      'Authorization-Key': 'abc123',
    });
  });

  it('maps a complete and a minimal item defensively', async () => {
    const payload = {
      SearchResult: {
        SearchResultItems: [
          {
            MatchedObjectDescriptor: {
              MatchedObjectId: '111',
              PositionTitle: 'Nurse',
              OrganizationName: 'VA',
              PositionLocation: [{ LocationName: 'Austin, Texas' }],
              UserArea: { Details: { JobSummary: 'Care summary' } },
              ApplyURI: ['https://apply?a=1&PostingChannelID=X', 'https://apply-second'],
              PositionURI: 'https://position/111',
              PublicationStartDate: '2026-09-01T00:00:00Z',
            },
          },
          {
            MatchedObjectDescriptor: {
              PositionTitle: 'Clerk',
              PositionURI: 'https://position/222',
            },
          },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(payload)));
    const jobs = await fetchUsaJobs({ query: 'x', location: 'fallback-loc' });
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      externalId: 'usajobs-111',
      source: 'usajobs',
      title: 'Nurse',
      company: 'VA',
      location: 'Austin, Texas',
      description: 'Care summary',
      applyUrl: 'https://apply?a=1&PostingChannelID=X',
      sourceUrl: 'https://position/111',
    });
    expect(jobs[0].postedAt).toBeInstanceOf(Date);
    expect(jobs[1]).toMatchObject({
      source: 'usajobs',
      title: 'Clerk',
      company: 'Unknown',
      description: '',
      applyUrl: 'https://position/222',
    });
    expect(jobs[1].externalId).toBeDefined();
  });

  it('returns [] when SearchResult is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({})));
    await expect(fetchUsaJobs({ query: 'x' })).resolves.toEqual([]);
  });

  it('rejects a DB key without a colon before any fetch', async () => {
    leaseNextKeyMock.mockResolvedValue({ apiKey: 'no-colon-here', id: 'k2' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchUsaJobs({ query: 'x' })).rejects.toThrow(/email:apiKey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws "USAJobs failed: 429" on non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));
    await expect(fetchUsaJobs({ query: 'x' })).rejects.toThrow('USAJobs failed: 429');
  });
});
