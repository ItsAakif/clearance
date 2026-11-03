import { describe, it, expect } from 'vitest';
import { parseQuery, matchesQuery, queryScore } from './queryMatch.js';

describe('queryMatch parseQuery', () => {
  it('empty / undefined / stopword-only queries are non-meaningful', () => {
    expect(parseQuery('')).toEqual({ tokens: [], isMeaningful: false });
    expect(parseQuery(undefined)).toEqual({ tokens: [], isMeaningful: false });
    expect(parseQuery('remote')).toEqual({ tokens: [], isMeaningful: false });
  });

  it('parses a boolean-shaped query into content tokens', () => {
    const needle = parseQuery('"Software Engineer" OR "Backend" remote');
    expect(needle.isMeaningful).toBe(true);
    expect(needle.tokens).toContain('software');
    expect(needle.tokens).toContain('engineer');
    expect(needle.tokens).toContain('backend');
    expect(needle.tokens).not.toContain('remote');
    expect(needle.tokens).not.toContain('or');
  });

  it('drops site: operators', () => {
    expect(parseQuery('site:jobs.ashbyhq.com React')).toEqual({
      tokens: ['react'],
      isMeaningful: true,
    });
  });

  it('keeps c++, c#, node.js tokens', () => {
    expect(parseQuery('C++ Developer').tokens).toContain('c++');
    expect(parseQuery('C# Engineer').tokens).toContain('c#');
    expect(parseQuery('Node.js').tokens).toContain('node.js');
  });

  it('caps long queries at 12 tokens', () => {
    const q = [
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta',
      'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi',
    ].join(' ');
    const needle = parseQuery(q);
    expect(needle.tokens).toHaveLength(12);
    expect(needle.isMeaningful).toBe(true);
  });
});

describe('queryMatch matchesQuery/queryScore', () => {
  it('is OR: any token matches', () => {
    const needle = parseQuery('senior react engineer');
    expect(matchesQuery('React Developer at Acme', needle)).toBe(true);
  });

  it('nonsense tokens match nothing', () => {
    const needle = parseQuery('zzzqqq');
    expect(needle.isMeaningful).toBe(true);
    expect(matchesQuery('React Developer at Acme', needle)).toBe(false);
  });

  it('non-meaningful queries match every row', () => {
    const needle = parseQuery('remote');
    expect(matchesQuery('anything at all', needle)).toBe(true);
    expect(matchesQuery('', needle)).toBe(true);
  });

  it('queryScore counts distinct matches and is 0 when non-meaningful', () => {
    expect(queryScore('React Developer at Acme', parseQuery('senior react engineer'))).toBe(1);
    expect(queryScore('Senior React Engineer at Acme', parseQuery('senior react engineer'))).toBe(3);
    expect(queryScore('anything', parseQuery('remote'))).toBe(0);
  });

  it('never throws for undefined input', () => {
    expect(() => parseQuery(undefined as unknown as string)).not.toThrow();
    expect(() => matchesQuery(undefined as unknown as string, parseQuery('react'))).not.toThrow();
    expect(() => queryScore('text', undefined as unknown as never)).not.toThrow();
  });
});
