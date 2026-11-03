import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/prisma.js', () => ({ default: {} }));
vi.mock('../lib/crypto.js', () => ({ decryptSecret: (s: string) => s }));
vi.mock('../ai/keyManager.js', () => ({
  leaseNextKey: vi.fn(async () => ({
    id: 'rapidapi-key-1',
    apiKey: 'SECRET-KEY-VALUE',
    provider: 'rapidapi',
    source: 'database',
    userId: 'user-1',
  })),
  markKeySuccess: vi.fn(async () => undefined),
  markKeyFailure: vi.fn(async () => undefined),
}));

import {
  RAPIDAPI_HOSTS,
  RAPIDAPI_PATHS,
  classifyRapidStatus,
  extractJSearchItems,
} from './scrapingBackend.js';

describe('RAPIDAPI_HOSTS drift guard', () => {
  it('matches the documented host table exactly', () => {
    expect(RAPIDAPI_HOSTS).toEqual({
      jsearch: 'jsearch.p.rapidapi.com',
      pullLinkedin: 'linkedin-scraper-api6.p.rapidapi.com',
      pullIndeed: 'indeed-scraper-api2.p.rapidapi.com',
      fantasticLinkedin: 'fantastic-jobs-linkedin-job-search-api.p.rapidapi.com',
    });
  });
});

describe('RAPIDAPI_PATHS drift guard', () => {
  it('matches the documented path table exactly', () => {
    expect(RAPIDAPI_PATHS).toEqual({
      jsearch: '/search-v2',
      pullLinkedin: '/linkedin/jobs',
      pullIndeed: '/indeed/search',
    });
  });
});

describe('classifyRapidStatus regression guard (ADR-010)', () => {
  it('classifies 403/404 terminal, 429 rate_limited, 500 transient', () => {
    expect(classifyRapidStatus(403)).toBe('terminal');
    expect(classifyRapidStatus(404)).toBe('terminal');
    expect(classifyRapidStatus(429)).toBe('rate_limited');
    expect(classifyRapidStatus(500)).toBe('transient');
  });
});

describe('JSearch v2 live-shape fixture (array + envelope variants)', () => {
  const liveRow = {
    job_id: 'live-1',
    job_title: 'Platform Engineer',
    employer_name: 'Example Corp',
    job_description: 'Run infra.',
    job_apply_link: 'https://example.com/apply/live-1',
  };

  it('accepts the documented { data: [] } shape', () => {
    expect(extractJSearchItems({ data: [liveRow] })).toEqual([liveRow]);
  });

  it('accepts a bare array body', () => {
    expect(extractJSearchItems([liveRow])).toEqual([liveRow]);
  });

  it('accepts cursor/object envelopes without throwing', () => {
    expect(
      extractJSearchItems({ data: { jobs: [liveRow], cursor: 'mock-cursor-abc' } })
    ).toEqual([liveRow]);
    expect(extractJSearchItems({ data: { data: [liveRow] } })).toEqual([liveRow]);
    expect(extractJSearchItems({ data: { cursor: 'mock-cursor', count: 0 } })).toEqual([]);
  });
});
