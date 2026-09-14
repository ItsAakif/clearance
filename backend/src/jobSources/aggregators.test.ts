import { describe, it, expect } from 'vitest';
import { resolveAdzunaCountry, buildAdzunaUrl } from './aggregators.js';

const CREDS = { appId: 'test-id', appKey: 'test-key' };

function countryOf(location?: string): string {
  const url = new URL(buildAdzunaUrl({ query: 'engineer', location }, CREDS));
  const match = url.pathname.match(/\/jobs\/([^/]+)\/search/);
  return match ? match[1] : '';
}

describe('Adzuna country handling', () => {
  it('defaults to us when no location is given', () => {
    expect(countryOf(undefined)).toBe('us');
    expect(countryOf('')).toBe('us');
    expect(countryOf('New York')).toBe('us');
    expect(resolveAdzunaCountry(undefined)).toEqual({ country: 'us', location: undefined });
  });

  it('resolves in for India locations and "<cc>:" prefixes', () => {
    expect(countryOf('Mumbai, India')).toBe('in');
    expect(countryOf('Bengaluru')).toBe('in');
    expect(countryOf('in:Bengaluru')).toBe('in');
    // Prefix is stripped from the `where` param.
    const url = new URL(buildAdzunaUrl({ query: 'engineer', location: 'in:Bengaluru' }, CREDS));
    expect(url.searchParams.get('where')).toBe('Bengaluru');
  });

  it('resolves gb for UK locations and "<cc>:" prefixes', () => {
    expect(countryOf('London, United Kingdom')).toBe('gb');
    expect(countryOf('London')).toBe('gb');
    expect(countryOf('gb:London')).toBe('gb');
    const url = new URL(buildAdzunaUrl({ query: 'engineer', location: 'gb:London' }, CREDS));
    expect(url.searchParams.get('where')).toBe('London');
  });
});
