// T892: Lever's postings API returns `createdAt` as an epoch-milliseconds JSON
// Int (`"createdAt":1781037166218`), not an ISO string. The wave-3 line passed
// that number straight into `postedAtRaw`, so ONE Lever row produced
// `PrismaClientValidationError: Argument 'postedAtRaw': Invalid value
// provided. Expected String or Null, provided Int` and 500'd a live full-scan
// batch (2026-09-25, `upsertDiscoveredJobs` -> `fullScanHandler`).
//
// These tests pin the source-side fix: `postedAtRaw` is a String for a numeric
// `createdAt`, while `postedAt` and `postedAtSource` keep their exact previous
// meaning (the epoch value is still parsed into the same instant). A string
// `createdAt` stays byte-identical.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchLever } from './lever.js';

function stubFetch(body: unknown) {
  return vi.fn(async (url: string) => {
    const text = JSON.stringify(body);
    return {
      ok: true,
      status: 200,
      url: String(url),
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lever createdAt (T892)', () => {
  it('a numeric epoch createdAt yields a STRING postedAtRaw and an unchanged date', async () => {
    // Exactly the upstream shape: Int epoch millis.
    vi.stubGlobal('fetch', stubFetch([{
      id: 'l-zaimler-1',
      text: 'Forward Deployed Engineer',
      hostedUrl: 'https://jobs.lever.co/zaimler/l-zaimler-1',
      categories: { location: 'Remote' },
      descriptionPlain: 'Ship with customers.',
      createdAt: 1781037166218,
    }]));
    const rows = await fetchLever('zaimler', 'engineer');
    expect(rows).toHaveLength(1);
    // The Prisma column is `String | null`: an Int here 500s the batch.
    expect(typeof rows[0].postedAtRaw).toBe('string');
    expect(rows[0].postedAtRaw).toBe('1781037166218');
    // The date itself and its provenance class are exactly what they were
    // before the fix: the same instant, the same `source-posted` class.
    expect(rows[0].postedAt).toEqual(new Date(1781037166218));
    expect(rows[0].postedAtSource).toBe('source-posted');
    expect(rows[0].source).toBe('lever');
  });

  it('a string createdAt is passed through byte-identical', async () => {
    vi.stubGlobal('fetch', stubFetch([{
      id: 'l-2',
      text: 'Backend Engineer',
      hostedUrl: 'https://jobs.lever.co/acme/l-2',
      categories: { location: 'Remote' },
      descriptionPlain: 'Build APIs.',
      createdAt: '2026-09-05T10:00:00Z',
    }]));
    const rows = await fetchLever('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAtRaw).toBe('2026-09-05T10:00:00Z');
    expect(rows[0].postedAt).toEqual(new Date('2026-09-05T10:00:00Z'));
    expect(rows[0].postedAtSource).toBe('source-posted');
  });

  it('a missing createdAt stays absent (no "undefined" claim)', async () => {
    vi.stubGlobal('fetch', stubFetch([{
      id: 'l-3',
      text: 'Backend Engineer',
      hostedUrl: 'https://jobs.lever.co/acme/l-3',
      categories: { location: 'Remote' },
      descriptionPlain: 'Build APIs.',
    }]));
    const rows = await fetchLever('acme', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].postedAtRaw).toBeUndefined();
    expect(rows[0].postedAt).toBeUndefined();
    expect(rows[0].postedAtSource).toBeUndefined();
  });
});
