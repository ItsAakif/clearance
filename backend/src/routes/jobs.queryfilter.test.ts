import { describe, it, expect, vi } from 'vitest';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    jobListing: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

import { filterAndOrder } from './jobs.js';

interface Row {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  postedAt?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

function row(overrides: Row = {}): Row {
  return {
    title: 'Untitled',
    company: 'Acme',
    location: 'Remote',
    description: '',
    postedAt: new Date(now - DAY_MS),
    ...overrides,
  };
}

describe('filterAndOrder (ADR-021 server-side query post-filter)', () => {
  it('keeps a row matching one token in the title for a meaningful query', () => {
    const kept = row({ title: 'React Engineer', description: 'Java shop' });
    const out = filterAndOrder([kept], 'react python');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'React Engineer' });
  });

  it('drops a row matching no token anywhere for a meaningful query', () => {
    const dropped = row({ title: 'Java Engineer', company: 'Acme', location: 'Berlin', description: 'Spring shop' });
    const out = filterAndOrder([dropped], 'react python');
    expect(out).toHaveLength(0);
  });

  it('keeps description-only matches (token-OR over the full haystack)', () => {
    const bodyMatch = row({ title: 'Backend Engineer', description: 'We use react daily' });
    const out = filterAndOrder([bodyMatch], 'react');
    expect(out).toHaveLength(1);
  });

  it('keeps every row with score 0 for a non-meaningful query', () => {
    const a = row({ title: 'Java Engineer', description: 'Spring shop' });
    const b = row({ title: 'Go Engineer', description: 'Gin shop' });
    const out = filterAndOrder([a, b], 'remote jobs');
    expect(out).toHaveLength(2);
    for (const job of out) {
      expect((job as { score?: number }).score).toBe(0);
    }
  });

  it('orders survivors by score desc, then postedAt desc, undated last', () => {
    const lowRecent = row({ title: 'React Engineer', postedAt: new Date(now - DAY_MS) });
    const highOld = row({ title: 'React Python Engineer', postedAt: new Date(now - 3 * DAY_MS) });
    const undated = row({ title: 'Python React Engineer', postedAt: undefined });
    const out = filterAndOrder([lowRecent, highOld, undated], 'react python');
    expect(out.map((j) => j.title)).toEqual([
      'React Python Engineer',
      'Python React Engineer',
      'React Engineer',
    ]);
  });

  it('still applies the freshness filter after the drop', () => {
    const fresh = row({ title: 'React Engineer', postedAt: new Date(now - DAY_MS) });
    const stale = row({ title: 'React Veteran', postedAt: new Date(now - 200 * DAY_MS) });
    const out = filterAndOrder([fresh, stale], 'react');
    expect(out.map((j) => j.title)).toEqual(['React Engineer']);
  });

  it('drops rows that match nothing even when they are fresh and recent', () => {
    const freshMiss = row({ title: 'Java Engineer', description: 'Spring shop', postedAt: new Date(now) });
    const freshHit = row({ title: 'React Engineer', description: '', postedAt: new Date(now - 10 * DAY_MS) });
    const out = filterAndOrder([freshMiss, freshHit], 'react');
    expect(out.map((j) => j.title)).toEqual(['React Engineer']);
  });
});
