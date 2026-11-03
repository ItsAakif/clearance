import { describe, it, expect } from 'vitest';
import type { PostedAtSource } from '../discovery/provenance.js';
import {
  MAX_POSTED_AGE_DAYS,
  POSTED_WITHIN_DAYS,
  isFresh,
  sortByRelevanceThenRecency,
} from './freshness.js';

const NOW = new Date('2026-09-18T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

describe('isFresh absolute guard', () => {
  it('drops a 200-day-old row with no window', () => {
    expect(MAX_POSTED_AGE_DAYS).toBe(180);
    expect(isFresh({ postedAt: daysAgo(200) }, { now: NOW })).toBe(false);
  });

  it('keeps a 10-day-old row with no window', () => {
    expect(isFresh({ postedAt: daysAgo(10) }, { now: NOW })).toBe(true);
  });

  it('keeps undated rows when no window is set', () => {
    expect(isFresh({}, { now: NOW })).toBe(true);
    expect(isFresh({ postedAt: undefined }, { now: NOW })).toBe(true);
  });

  it('keeps an invalid Date (guard never drops what it cannot read)', () => {
    expect(isFresh({ postedAt: new Date('not-a-date') }, { now: NOW })).toBe(true);
  });

  it('drops undated rows under an explicit window', () => {
    expect(isFresh({}, { now: NOW, postedWithin: 'week' })).toBe(false);
    expect(isFresh({ postedAt: new Date('bad') }, { now: NOW, postedWithin: 'month' })).toBe(false);
  });
});

describe('isFresh postedWithin window', () => {
  it('exposes day/week/month windows', () => {
    expect(POSTED_WITHIN_DAYS).toEqual({ day: 1, week: 7, month: 30 });
  });

  it('applies the day boundary (hours matter)', () => {
    const twelveHoursAgo = new Date(NOW.getTime() - 12 * 60 * 60 * 1000);
    const twoDaysAgo = daysAgo(2);
    expect(isFresh({ postedAt: twelveHoursAgo }, { now: NOW, postedWithin: 'day' })).toBe(true);
    expect(isFresh({ postedAt: twoDaysAgo }, { now: NOW, postedWithin: 'day' })).toBe(false);
  });

  it('applies the week boundary', () => {
    expect(isFresh({ postedAt: daysAgo(3) }, { now: NOW, postedWithin: 'week' })).toBe(true);
    expect(isFresh({ postedAt: daysAgo(10) }, { now: NOW, postedWithin: 'week' })).toBe(false);
  });

  it('applies the month boundary', () => {
    expect(isFresh({ postedAt: daysAgo(20) }, { now: NOW, postedWithin: 'month' })).toBe(true);
    expect(isFresh({ postedAt: daysAgo(60) }, { now: NOW, postedWithin: 'month' })).toBe(false);
  });
});

describe('sortByRelevanceThenRecency', () => {
  it('orders higher score first, then newer first, undated last', () => {
    const old = { id: 'old', score: 1, postedAt: daysAgo(30) };
    const fresh = { id: 'fresh', score: 1, postedAt: daysAgo(1) };
    const undated: { id: string; score: number; postedAt?: Date } = { id: 'undated', score: 1 };
    const top = { id: 'top', score: 3, postedAt: daysAgo(90) };
    const out = sortByRelevanceThenRecency([old, undated, fresh, top]);
    expect(out.map((r) => r.id)).toEqual(['top', 'fresh', 'old', 'undated']);
  });

  it('treats missing score as 0 and keeps equal undated rows in input order', () => {
    const a: { id: string; score?: number; postedAt?: Date } = { id: 'a' };
    const b: { id: string; score?: number; postedAt?: Date } = { id: 'b', score: 0 };
    const c: { id: string; score?: number; postedAt?: Date } = { id: 'c', score: 0 };
    const out = sortByRelevanceThenRecency([c, b, a]);
    expect(out.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the input array', () => {
    const input: Array<{ id: string; score?: number; postedAt?: Date }> = [
      { id: 'x', score: 0 },
      { id: 'y', score: 5, postedAt: daysAgo(2) },
    ];
    const snapshot = [...input];
    sortByRelevanceThenRecency(input);
    expect(input).toEqual(snapshot);
  });
});

describe('sortByRelevanceThenRecency provenance tie-break (wave 3, ADR-028)', () => {
  interface SortRow {
    id: string;
    score?: number;
    postedAt?: Date;
    postedAtSource?: PostedAtSource;
  }

  it('never ranks an index-date row above an equal-score source-posted row (both undated)', () => {
    const indexed: SortRow = { id: 'indexed', score: 2, postedAtSource: 'index-date' };
    const posted: SortRow = { id: 'posted', score: 2, postedAtSource: 'source-posted' };
    expect(sortByRelevanceThenRecency([indexed, posted]).map((r) => r.id)).toEqual([
      'posted',
      'indexed',
    ]);
    expect(sortByRelevanceThenRecency([posted, indexed]).map((r) => r.id)).toEqual([
      'posted',
      'indexed',
    ]);
  });

  it('breaks ties between equal-score, equal-date rows by provenance rank', () => {
    const derived: SortRow = {
      id: 'derived',
      score: 1,
      postedAt: daysAgo(5),
      postedAtSource: 'page-derived',
    };
    const posted: SortRow = {
      id: 'posted',
      score: 1,
      postedAt: daysAgo(5),
      postedAtSource: 'source-posted',
    };
    expect(sortByRelevanceThenRecency([derived, posted]).map((r) => r.id)).toEqual([
      'posted',
      'derived',
    ]);
  });

  it('does not crash on a source-posted row with a null date (classify prevents this)', () => {
    const anomalous: SortRow = {
      id: 'anomalous',
      score: 1,
      postedAt: undefined,
      postedAtSource: 'source-posted',
    };
    const indexed: SortRow = { id: 'indexed', score: 1, postedAtSource: 'index-date' };
    const out = sortByRelevanceThenRecency([indexed, anomalous]);
    expect(out.map((r) => r.id)).toEqual(['anomalous', 'indexed']);
  });

  it('keeps undated-last: a dated row outranks an undated row regardless of provenance', () => {
    const dated: SortRow = {
      id: 'dated',
      score: 1,
      postedAt: daysAgo(60),
      postedAtSource: 'page-derived',
    };
    const undatedPosted: SortRow = {
      id: 'undated-posted',
      score: 1,
      postedAtSource: 'source-posted',
    };
    expect(sortByRelevanceThenRecency([undatedPosted, dated]).map((r) => r.id)).toEqual([
      'dated',
      'undated-posted',
    ]);
  });

  it('preserves input order for fully-equal rows (equal score, date and provenance)', () => {
    const a: SortRow = { id: 'a', score: 1, postedAtSource: 'index-date' };
    const b: SortRow = { id: 'b', score: 1, postedAtSource: 'index-date' };
    expect(sortByRelevanceThenRecency([b, a]).map((r) => r.id)).toEqual(['b', 'a']);
    const c: SortRow = {
      id: 'c',
      score: 1,
      postedAt: daysAgo(5),
      postedAtSource: 'source-posted',
    };
    const d: SortRow = {
      id: 'd',
      score: 1,
      postedAt: daysAgo(5),
      postedAtSource: 'source-posted',
    };
    expect(sortByRelevanceThenRecency([d, c]).map((r) => r.id)).toEqual(['d', 'c']);
  });
});
