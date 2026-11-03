// Slug determinism tests (T642 STEP 4). No real company data: every fixture
// name/host is synthetic.
import { describe, it, expect } from 'vitest';
import { companySlug, slugPart } from './slug.js';

describe('slugPart', () => {
  it('lowercases, dash-joins and strips accents', () => {
    expect(slugPart('Acme Test GmbH')).toBe('acme-test-gmbh');
    expect(slugPart('  Pareto--AI__labs ')).toBe('pareto-ai-labs');
    expect(slugPart('advice').length).toBeGreaterThan(0);
  });

  it('bounds component length', () => {
    expect(slugPart('a'.repeat(500)).length).toBeLessThanOrEqual(48);
  });
});

describe('companySlug', () => {
  it('is deterministic: same input -> same slug', () => {
    const a = companySlug('Acme Test', 'boards.greenhouse.io');
    const b = companySlug('Acme Test', 'boards.greenhouse.io');
    expect(a).toBe(b);
    // Documented shape: <name>-<host>-<10 hex>.
    expect(a).toMatch(/^[a-z0-9-]{1,108}$/);
    expect(a.slice(-11)).toMatch(/^-[0-9a-f]{10}$/);
  });

  it('is case-insensitive in both inputs', () => {
    expect(companySlug('ACME TEST', 'BOARDS.GREENHOUSE.IO')).toBe(
      companySlug('acme test', 'boards.greenhouse.io'),
    );
  });

  it('never merges on name alone: same name, different hosts -> different slugs', () => {
    const a = companySlug('Acme Test', 'boards.greenhouse.io');
    const b = companySlug('Acme Test', 'jobs.lever.co');
    expect(a).not.toBe(b);
  });

  it('distinguishes different names on the same host', () => {
    expect(companySlug('Acme Test', 'boards.greenhouse.io')).not.toBe(
      companySlug('Acme Other', 'boards.greenhouse.io'),
    );
  });

  it('is total: empty inputs yield a stable non-empty fallback slug', () => {
    const a = companySlug('', '');
    expect(a.length).toBeGreaterThan(0);
    expect(a).toBe(companySlug('', ''));
    expect(a).toContain('company');
    expect(a).toContain('unknown-host');
  });

  it('bounds total length for very long inputs', () => {
    const slug = companySlug('N'.repeat(500), `${'h'.repeat(500)}.example.test`);
    expect(slug.length).toBeLessThanOrEqual(108);
    expect(slug).toBe(companySlug('N'.repeat(500), `${'h'.repeat(500)}.example.test`));
  });
});
