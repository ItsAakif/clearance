import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    jobListing: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

import { upsertDiscoveredJobs, shouldKeepStoredDescription } from './jobs.js';
import { fetchGreenhouse } from '../jobSources/index.js';

const baseJob = {
  externalId: 'gh-111',
  source: 'greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/testco/jobs/111',
  title: 'Backend Engineer',
  company: 'testco',
  location: 'Remote',
  applyUrl: 'https://boards.greenhouse.io/testco/jobs/111',
};

function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }) {
  return vi.fn(async (url: string) => {
    const r = handler(String(url));
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      ok: r.ok,
      status: r.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
}

describe('description persistence guard', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    prismaMocks.jobListing.findUnique.mockReset();
    prismaMocks.jobListing.upsert.mockReset();
    prismaMocks.jobListing.upsert.mockImplementation(async (args: any) => ({
      id: `id-${args.create.source}-${args.create.externalId}`,
      ...args.create,
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shouldKeepStoredDescription keeps stored text only when incoming is blank', () => {
    expect(shouldKeepStoredDescription('Good stored text', '')).toBe(true);
    expect(shouldKeepStoredDescription('Good stored text', '   ')).toBe(true);
    expect(shouldKeepStoredDescription('Good stored text', 'New text')).toBe(false);
    expect(shouldKeepStoredDescription('', '')).toBe(false);
    expect(shouldKeepStoredDescription(undefined, '')).toBe(false);
    expect(shouldKeepStoredDescription('Good stored text', undefined)).toBe(true);
  });

  it('empty re-discovery never clobbers a stored non-empty description', async () => {
    prismaMocks.jobListing.findUnique.mockResolvedValue({ description: 'Good stored text' });
    await upsertDiscoveredJobs([{ ...baseJob, description: '' }]);
    expect(prismaMocks.jobListing.upsert).toHaveBeenCalledTimes(1);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    expect(args.update.description).toBe('Good stored text');
  });

  it('a fresh non-empty discovery still overwrites the stored description', async () => {
    prismaMocks.jobListing.findUnique.mockResolvedValue({ description: 'Stale text' });
    await upsertDiscoveredJobs([{ ...baseJob, description: 'Fresh full description text' }]);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    expect(args.update.description).toBe('Fresh full description text');
  });

  it('empty stays empty without throwing when nothing is stored either', async () => {
    prismaMocks.jobListing.findUnique.mockResolvedValue({ description: '' });
    await expect(upsertDiscoveredJobs([{ ...baseJob, description: '' }])).resolves.toHaveLength(1);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    expect(args.update.description).toBe('');
    expect(args.create.description).toBe('');
  });

  it('a failed guard lookup falls through to the incoming text instead of failing the row', async () => {
    prismaMocks.jobListing.findUnique.mockRejectedValue(new Error('db down'));
    await expect(upsertDiscoveredJobs([{ ...baseJob, description: '' }])).resolves.toHaveLength(1);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    expect(args.update.description).toBe('');
  });

  it('detail fallback fills then stores: backfilled text reaches the create path', async () => {
    const listRow = {
      id: 111,
      title: 'Backend Engineer',
      absolute_url: 'https://boards.greenhouse.io/testco/jobs/111',
      location: { name: 'Remote' },
      content: '',
      updated_at: '2026-09-01T10:00:00Z',
    };
    vi.stubGlobal(
      'fetch',
      stubFetch((url) =>
        url.includes('content=true')
          ? { ok: true, status: 200, body: { jobs: [listRow] } }
          : { ok: true, status: 200, body: { id: 111, content: '<p>Backfilled detail text.</p>' } },
      ),
    );
    const fetched = await fetchGreenhouse('testco', 'engineer');
    expect(fetched).toHaveLength(1);
    expect(fetched[0].description).toBe('Backfilled detail text.');
    prismaMocks.jobListing.findUnique.mockResolvedValue(null);
    await upsertDiscoveredJobs(fetched);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    expect(args.create.description).toBe('Backfilled detail text.');
  });
});
