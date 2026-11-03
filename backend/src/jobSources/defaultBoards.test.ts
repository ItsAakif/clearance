import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({
  default: {
    jobBoard: {
      count: vi.fn(async () => 0),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

import { getDefaultBoards, DEFAULT_AGGREGATOR_BOARDS, DEFAULT_SCRAPER_BOARDS } from './defaultBoards.js';
import { SUPPORTED_SCRAPER_PROVIDERS } from './index.js';

describe('default aggregator boards', () => {
  it('contains exactly one entry per provider adzuna/usajobs/reed/findwork', () => {
    const providers = DEFAULT_AGGREGATOR_BOARDS.map((b) => b.aggregatorProvider).sort();
    expect(providers).toEqual(['adzuna', 'findwork', 'reed', 'usajobs']);
  });

  it('gives every aggregator entry type "aggregator"', () => {
    for (const b of DEFAULT_AGGREGATOR_BOARDS) {
      expect(b.type).toBe('aggregator');
    }
  });

  it('returns no careerjet/jooble board from getDefaultBoards()', () => {
    const boards = getDefaultBoards();
    expect(boards.filter((b: any) => b.aggregatorProvider === 'careerjet')).toEqual([]);
    expect(boards.filter((b: any) => b.aggregatorProvider === 'jooble')).toEqual([]);
  });

  it('keeps the pre-existing keyless boards', () => {
    const names = getDefaultBoards().map((b) => b.name);
    for (const expected of ['RemoteOK', 'Remotive', 'We Work Remotely', 'Arbeitnow (EU)', 'Jobicy (Remote)', 'Hacker News - Who is Hiring', 'Hacker News - Ask HN Jobs (Algolia)']) {
      expect(names).toContain(expected);
    }
  });

  it('types the Jobicy default board as jobicy (not json) with a jobicy.com feedUrl', () => {
    const board = getDefaultBoards().find((b) => b.name === 'Jobicy (Remote)');
    expect(board).toBeDefined();
    expect((board as { type: string }).type).toBe('jobicy');
    expect((board as { feedUrl?: string }).feedUrl).toContain('jobicy.com');
  });

  it('D5: seeds only supported scraperProvider values (no bare "google")', () => {
    const supported = SUPPORTED_SCRAPER_PROVIDERS as readonly string[];
    for (const b of DEFAULT_SCRAPER_BOARDS) {
      expect(supported).toContain(b.scraperProvider);
    }
    expect(DEFAULT_SCRAPER_BOARDS.some((b) => b.scraperProvider === 'google')).toBe(false);
  });

  it('T317: no duplicate (type, boardId) pair in getDefaultBoards()', () => {
    const boards = getDefaultBoards() as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    for (const b of boards) {
      if (b.boardId === undefined || b.boardId === null) continue;
      const key = `${String(b.type)}/${String(b.boardId)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('T317: every ATS entry (greenhouse/ashby/lever) has a non-empty boardId', () => {
    const boards = getDefaultBoards() as Array<Record<string, unknown>>;
    for (const b of boards) {
      if (b.type === 'greenhouse' || b.type === 'ashby' || b.type === 'lever') {
        expect(typeof b.boardId).toBe('string');
        expect((b.boardId as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('T317: seed set contains none of the probe-confirmed dead tokens (probe 2026-09-18)', () => {
    // Dead set from the live probe run (all HTTP 404); probe was NOT owed.
    const dead = new Set([
      'greenhouse/openai',
      'greenhouse/notion',
      'greenhouse/ramp',
      'ashby/anysphere',
      'lever/scale-ai',
      'lever/ramp',
      'lever/tavus',
    ]);
    const boards = getDefaultBoards() as Array<Record<string, unknown>>;
    for (const b of boards) {
      if (b.type === 'greenhouse' || b.type === 'ashby' || b.type === 'lever') {
        expect(dead.has(`${String(b.type)}/${String(b.boardId)}`)).toBe(false);
      }
    }
  });

  it('T317: exactly one Ramp board remains in the seed set', () => {
    const boards = getDefaultBoards() as Array<Record<string, unknown>>;
    const ramp = boards.filter((b) => String(b.name).toLowerCase().includes('ramp'));
    expect(ramp.length).toBe(1);
    expect(String(ramp[0].name)).toBe('Ramp (Ashby)');
  });
});
