import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { formatSalary } from './salary';
import { formatFreshness } from './freshnessFormat';

describe('formatSalary', () => {
  it('formats a range with a currency symbol and compact bounds', () => {
    assert.equal(
      formatSalary({ min: 120000, max: 150000, currency: 'USD' }),
      '$120k–$150k',
    );
  });

  it('formats a single bound when min equals max', () => {
    assert.equal(formatSalary({ min: 90000, max: 90000, currency: 'EUR' }), '€90k');
  });

  it('formats millions and sub-thousand values', () => {
    assert.equal(formatSalary({ min: 1000000, max: 1200000, currency: 'GBP' }), '£1m–£1.2m');
    assert.equal(formatSalary({ min: 500, max: 900, currency: 'USD' }), '$500–$900');
  });

  it('returns null for an absent range so the row can omit it', () => {
    assert.equal(formatSalary(null), null);
    assert.equal(formatSalary(undefined), null);
  });
});

describe('formatFreshness', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');

  it('formats days, hours and minutes', () => {
    assert.equal(formatFreshness('2026-10-27T12:00:00Z', now), '3d ago');
    assert.equal(formatFreshness('2026-10-30T09:00:00Z', now), '3h ago');
    assert.equal(formatFreshness('2026-10-30T11:30:00Z', now), '30m ago');
    assert.equal(formatFreshness('2026-10-30T11:59:40Z', now), 'just now');
  });

  it('formats months and years', () => {
    assert.equal(formatFreshness('2026-08-01T12:00:00Z', now), '3mo ago');
    assert.equal(formatFreshness('2024-10-30T12:00:00Z', now), '2y ago');
  });

  it('clamps future timestamps and refuses unparseable values', () => {
    assert.equal(formatFreshness('2026-11-01T12:00:00Z', now), 'just now');
    assert.equal(formatFreshness(null, now), null);
    assert.equal(formatFreshness('not-a-date', now), null);
  });
});
