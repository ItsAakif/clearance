import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { JobListingSummary } from '@/services/api';
import { mergeResultRows } from './jobSearchUtils';

function listing(id: string, title = id): JobListingSummary {
  return {
    id,
    source: 'test-source',
    title,
    company: 'Test Company',
    isActive: true,
  };
}

describe('mergeResultRows - Full-scan batch accumulation', () => {
  it('concatenates new ids in first-seen order', () => {
    const existing = [listing('a'), listing('b')];
    const incoming = [listing('c'), listing('d')];

    const merged = mergeResultRows(existing, incoming);

    assert.deepEqual(merged.map((row) => row.id), ['a', 'b', 'c', 'd']);
  });

  it('drops duplicates across and within batches while keeping the first row', () => {
    const first = listing('a', 'first version');
    const replacement = listing('a', 'later version');
    const existing = [first, listing('b')];
    const incoming = [replacement, listing('c'), listing('c', 'duplicate')];

    const merged = mergeResultRows(existing, incoming);

    assert.deepEqual(merged.map((row) => row.id), ['a', 'b', 'c']);
    assert.equal(merged[0], first);
    assert.equal(merged[0]?.title, 'first version');
  });

  it('does not mutate either input batch', () => {
    const existing = [listing('a')];
    const incoming = [listing('a'), listing('b')];

    mergeResultRows(existing, incoming);

    assert.deepEqual(existing.map((row) => row.id), ['a']);
    assert.deepEqual(incoming.map((row) => row.id), ['a', 'b']);
  });
});
