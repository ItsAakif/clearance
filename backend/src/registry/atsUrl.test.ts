import { describe, it, expect } from 'vitest';
import { extractAts } from './atsUrl.js';

// One case per ADR-026 decision 2 host-table row, asserting the exact
// { provider, boardToken } per case. Fixture hosts are the real ATS host
// shapes; company tokens are synthetic ("acme").
describe('extractAts host table (ADR-026 decision 2)', () => {
  it('extracts boards.greenhouse.io token from the first path segment', () => {
    expect(extractAts('https://boards.greenhouse.io/acme')).toEqual({
      provider: 'greenhouse',
      boardToken: 'acme',
    });
  });

  it('extracts job-boards.greenhouse.io token from the first path segment', () => {
    expect(extractAts('https://job-boards.greenhouse.io/acme')).toEqual({
      provider: 'greenhouse',
      boardToken: 'acme',
    });
  });

  it('extracts jobs.lever.co token from the first path segment', () => {
    expect(extractAts('https://jobs.lever.co/acme')).toEqual({
      provider: 'lever',
      boardToken: 'acme',
    });
  });

  it('extracts jobs.ashbyhq.com token from the first path segment', () => {
    expect(extractAts('https://jobs.ashbyhq.com/acme')).toEqual({
      provider: 'ashby',
      boardToken: 'acme',
    });
  });

  it('extracts apply.workable.com token from the first path segment', () => {
    expect(extractAts('https://apply.workable.com/acme/j/abc123/')).toEqual({
      provider: 'workable',
      boardToken: 'acme',
    });
  });

  it('extracts *.recruitee.com token from the subdomain', () => {
    expect(extractAts('https://acme.recruitee.com/')).toEqual({
      provider: 'recruitee',
      boardToken: 'acme',
    });
  });

  it('extracts *.jobs.personio.de token from the subdomain', () => {
    expect(extractAts('https://acme.jobs.personio.de/')).toEqual({
      provider: 'personio',
      boardToken: 'acme',
    });
  });

  it('extracts *.smartrecruiters.com token from the first path segment', () => {
    expect(extractAts('https://jobs.smartrecruiters.com/Acme/details/1')).toEqual({
      provider: 'smartrecruiters',
      boardToken: 'Acme',
    });
  });

  it('extracts *.bamboohr.com token from the subdomain', () => {
    expect(extractAts('https://acme.bamboohr.com/jobs/')).toEqual({
      provider: 'bamboohr',
      boardToken: 'acme',
    });
  });

  it('extracts *.breezy.hr token from the subdomain', () => {
    expect(extractAts('https://acme.breezy.hr/')).toEqual({
      provider: 'breezy',
      boardToken: 'acme',
    });
  });

  it('extracts *.jobvite.com token from the first path segment', () => {
    expect(extractAts('https://jobs.jobvite.com/acme')).toEqual({
      provider: 'jobvite',
      boardToken: 'acme',
    });
  });

  it('extracts *.teamtailor.com token from the subdomain', () => {
    expect(extractAts('https://acme.teamtailor.com/')).toEqual({
      provider: 'teamtailor',
      boardToken: 'acme',
    });
  });

  it('extracts *.pinpointhq.com token from the subdomain', () => {
    expect(extractAts('https://acme.pinpointhq.com/')).toEqual({
      provider: 'pinpointhq',
      boardToken: 'acme',
    });
  });

  it('extracts *.rippling.com token from the subdomain', () => {
    expect(extractAts('https://acme.rippling.com/')).toEqual({
      provider: 'rippling',
      boardToken: 'acme',
    });
  });

  it('extracts the ats.rippling.com slug from the first path segment', () => {
    // The live registry stored the host label "ats" for all 1,276 rows; the
    // public board API needs the slug (`/element/jobs` -> `element`).
    expect(extractAts('https://ats.rippling.com/element/jobs')).toEqual({
      provider: 'rippling',
      boardToken: 'element',
    });
  });

  it('extracts *.freshteam.com token from the subdomain', () => {
    expect(extractAts('https://acme.freshteam.com/')).toEqual({
      provider: 'freshteam',
      boardToken: 'acme',
    });
  });
});

describe('extractAts edge cases', () => {
  it('returns nulls for an unknown host', () => {
    expect(extractAts('https://careers.example.com/jobs')).toEqual({
      provider: null,
      boardToken: null,
    });
  });

  it('never throws on a malformed string and returns nulls', () => {
    expect(extractAts('not a url at all!!!')).toEqual({
      provider: null,
      boardToken: null,
    });
    expect(extractAts('')).toEqual({ provider: null, boardToken: null });
    expect(extractAts('   ')).toEqual({ provider: null, boardToken: null });
  });

  it('returns the provider with a null token for a URL with no path', () => {
    expect(extractAts('https://boards.greenhouse.io')).toEqual({
      provider: 'greenhouse',
      boardToken: null,
    });
    expect(extractAts('https://jobs.lever.co/')).toEqual({
      provider: 'lever',
      boardToken: null,
    });
  });

  it('ignores the query string when extracting the token', () => {
    expect(extractAts('https://jobs.lever.co/acme?foo=bar&x=1')).toEqual({
      provider: 'lever',
      boardToken: 'acme',
    });
  });

  it('matches hosts case-insensitively but preserves token case', () => {
    expect(extractAts('https://BOARDS.GREENHOUSE.IO/Acme')).toEqual({
      provider: 'greenhouse',
      boardToken: 'Acme',
    });
  });

  it('accepts a scheme-less career-page value without throwing', () => {
    expect(extractAts('boards.greenhouse.io/acme')).toEqual({
      provider: 'greenhouse',
      boardToken: 'acme',
    });
  });
});
