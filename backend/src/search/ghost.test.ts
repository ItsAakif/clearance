import { describe, expect, it } from 'vitest';
import { computeGhost } from './ghost.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function daysAgoIso(n: number): string {
  return new Date(NOW.getTime() - n * DAY).toISOString();
}

describe('computeGhost - agedOut boundary', () => {
  it('is clear at exactly 60 days', () => {
    const res = computeGhost(
      { isActive: true, firstSeenAt: daysAgoIso(60), postedAt: daysAgoIso(60) },
      { repostCount: 1, sourceCount: 1, lastVerifiedAt: NOW.toISOString() },
      NOW,
    );
    expect(res.level).toBe('clear');
    expect(res.evidence).toEqual([]);
  });

  it('is watch at 61 days', () => {
    const res = computeGhost(
      { isActive: true, firstSeenAt: daysAgoIso(61), postedAt: daysAgoIso(61) },
      { repostCount: 1, sourceCount: 1, lastVerifiedAt: NOW.toISOString() },
      NOW,
    );
    expect(res.level).toBe('watch');
    expect(res.evidence).toContain('first seen 61 days ago');
    expect(res.evidence).toContain('posted 61 days ago');
  });
});

describe('computeGhost - reposted', () => {
  it('watches at 3 listings on 1 source', () => {
    const res = computeGhost(
      { isActive: true },
      { repostCount: 3, sourceCount: 1, firstSeenAt: NOW.toISOString(), lastVerifiedAt: NOW.toISOString(), postedAt: NOW.toISOString() },
      NOW,
    );
    expect(res.level).toBe('watch');
    expect(res.evidence).toContain('reposted 3 times across 1 sources');
  });

  it('watches at 2 sources', () => {
    const res = computeGhost(
      { isActive: true },
      { repostCount: 2, sourceCount: 2, firstSeenAt: NOW.toISOString(), lastVerifiedAt: NOW.toISOString(), postedAt: NOW.toISOString() },
      NOW,
    );
    expect(res.level).toBe('watch');
  });

  it('is clear at 1 source and 2 listings', () => {
    const res = computeGhost(
      { isActive: true },
      { repostCount: 2, sourceCount: 1, firstSeenAt: NOW.toISOString(), lastVerifiedAt: NOW.toISOString(), postedAt: NOW.toISOString() },
      NOW,
    );
    expect(res.level).toBe('clear');
    expect(res.evidence).toEqual([]);
  });
});

describe('computeGhost - stale', () => {
  it('stale alone is clear', () => {
    const res = computeGhost(
      { isActive: true },
      { repostCount: 1, sourceCount: 1, firstSeenAt: NOW.toISOString(), lastVerifiedAt: daysAgoIso(21), postedAt: NOW.toISOString() },
      NOW,
    );
    expect(res.level).toBe('clear');
    expect(res.evidence).toEqual([]);
  });

  it('stale appends only when already watch', () => {
    const res = computeGhost(
      { isActive: true, firstSeenAt: daysAgoIso(61), postedAt: daysAgoIso(61) },
      { repostCount: 1, sourceCount: 1, lastVerifiedAt: daysAgoIso(21) },
      NOW,
    );
    expect(res.level).toBe('watch');
    expect(res.evidence).toContain('not verified in 21 days');
  });

  it('null lastVerifiedAt adds no line', () => {
    const res = computeGhost(
      { isActive: true, firstSeenAt: daysAgoIso(61), postedAt: daysAgoIso(61) },
      { repostCount: 1, sourceCount: 1, lastVerifiedAt: null },
      NOW,
    );
    expect(res.level).toBe('watch');
    expect(res.evidence.some((e) => /not verified/.test(e))).toBe(false);
  });

  it('appends the stale line only past 14 days', () => {
    const at14 = computeGhost(
      { isActive: true, firstSeenAt: daysAgoIso(61), postedAt: daysAgoIso(61) },
      { repostCount: 1, sourceCount: 1, lastVerifiedAt: daysAgoIso(14) },
      NOW,
    );
    expect(at14.level).toBe('watch');
    expect(at14.evidence.some((e) => /not verified/.test(e))).toBe(false);

    const at15 = computeGhost(
      { isActive: true, firstSeenAt: daysAgoIso(61), postedAt: daysAgoIso(61) },
      { repostCount: 1, sourceCount: 1, lastVerifiedAt: daysAgoIso(15) },
      NOW,
    );
    expect(at15.level).toBe('watch');
    expect(at15.evidence).toContain('not verified in 15 days');
  });
});

describe('computeGhost - inactive and fail-soft', () => {
  it('inactive is clear', () => {
    const res = computeGhost(
      { isActive: false, firstSeenAt: daysAgoIso(90), postedAt: daysAgoIso(90) },
      { repostCount: 5, sourceCount: 3, lastVerifiedAt: daysAgoIso(30) },
      NOW,
    );
    expect(res.level).toBe('clear');
    expect(res.evidence).toEqual([]);
  });

  it('invalid dates and non-finite counts fail soft to clear', () => {
    const res = computeGhost(
      { isActive: true, firstSeenAt: 'not-a-date', postedAt: 'also-not-a-date' },
      { repostCount: Number.NaN, sourceCount: Number.POSITIVE_INFINITY, lastVerifiedAt: 'nope' },
      NOW,
    );
    expect(res).toEqual({ level: 'clear', evidence: [] });
  });
});

describe('computeGhost - determinism and wording', () => {
  it('is deterministic for the same now', () => {
    const input = {
      row: { isActive: true, firstSeenAt: daysAgoIso(61), postedAt: daysAgoIso(61) },
      aggregate: { repostCount: 3, sourceCount: 2, lastVerifiedAt: daysAgoIso(21) },
      now: NOW,
    };
    const a = computeGhost(input);
    const b = computeGhost(input);
    expect(a).toEqual(b);
  });

  it('evidence contains digits', () => {
    const res = computeGhost(
      { isActive: true, firstSeenAt: daysAgoIso(61), postedAt: daysAgoIso(61) },
      { repostCount: 3, sourceCount: 2, lastVerifiedAt: daysAgoIso(21) },
      NOW,
    );
    expect(res.evidence.join(' ')).toMatch(/\d/);
  });

  it('evidence contains no forbidden word', () => {
    const res = computeGhost(
      { isActive: true, firstSeenAt: daysAgoIso(61), postedAt: daysAgoIso(61) },
      { repostCount: 3, sourceCount: 2, lastVerifiedAt: daysAgoIso(21) },
      NOW,
    );
    const joined = res.evidence.join(' ').toLowerCase();
    for (const word of ['ghost', 'likely', 'probably', 'suspicious', 'scam', 'dead', 'fake', 'verdict']) {
      expect(joined).not.toContain(word);
    }
  });

  it('orders evidence agedOut -> reposted -> stale', () => {
    const res = computeGhost(
      { isActive: true, firstSeenAt: daysAgoIso(61), postedAt: daysAgoIso(61) },
      { repostCount: 3, sourceCount: 2, lastVerifiedAt: daysAgoIso(21) },
      NOW,
    );
    expect(res.evidence).toEqual([
      'first seen 61 days ago',
      'posted 61 days ago',
      'reposted 3 times across 2 sources',
      'not verified in 21 days',
    ]);
  });
});