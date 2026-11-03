import { describe, it, expect, vi } from 'vitest';
import { ensureSearchDocument } from './refresh.js';
import { buildSearchDocument, SEARCH_DOC_VERSION } from './document.js';

describe('ensureSearchDocument', () => {
  const now = new Date('2026-10-30T18:26:46.000Z');
  const listing = {
    id: 'id-1',
    title: 'Backend Engineer',
    company: 'testco',
    location: 'Remote',
    source: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/testco/jobs/111',
    applyUrl: 'https://boards.greenhouse.io/testco/jobs/111',
    postedAt: now,
    firstSeenAt: now,
    isActive: true,
    description: 'Build things.',
    searchDocument: null,
  };

  it('writes when the stored document is null', async () => {
    const update = vi.fn().mockResolvedValue({});
    const store = { jobListing: { update } } as any;
    const result = await ensureSearchDocument(store, listing, now);
    expect(result).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    const args = update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'id-1' });
    expect(args.data.searchUpdatedAt).toBe(now);
    expect(args.data.searchDocument).toEqual(buildSearchDocument(listing));
  });

  it('writes when docVersion differs', async () => {
    const update = vi.fn().mockResolvedValue({});
    const store = { jobListing: { update } } as any;
    const staleDoc = { ...buildSearchDocument(listing), docVersion: '0' };
    const result = await ensureSearchDocument(store, { ...listing, searchDocument: staleDoc }, now);
    expect(result).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data.searchDocument).toEqual(buildSearchDocument(listing));
  });

  it('does not write when the document is current', async () => {
    const update = vi.fn().mockResolvedValue({});
    const store = { jobListing: { update } } as any;
    const currentDoc = buildSearchDocument(listing);
    expect(currentDoc.docVersion).toBe(SEARCH_DOC_VERSION);
    const result = await ensureSearchDocument(store, { ...listing, searchDocument: currentDoc }, now);
    expect(result).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it('writes when a source column changed even though docVersion matches', async () => {
    const update = vi.fn().mockResolvedValue({});
    const store = { jobListing: { update } } as any;
    const staleDoc = buildSearchDocument({ ...listing, title: 'Old Title' });
    expect(staleDoc.docVersion).toBe(SEARCH_DOC_VERSION);
    const result = await ensureSearchDocument(store, { ...listing, searchDocument: staleDoc }, now);
    expect(result).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data.searchDocument.title).toBe('Backend Engineer');
  });

  it('returns the boolean and writes a document deep-equal to buildSearchDocument', async () => {
    const update = vi.fn().mockResolvedValue({});
    const store = { jobListing: { update } } as any;
    await ensureSearchDocument(store, { ...listing, searchDocument: undefined }, now);
    expect(update.mock.calls[0][0].data.searchDocument).toStrictEqual(buildSearchDocument(listing));
  });
});