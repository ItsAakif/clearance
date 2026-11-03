import { describe, it, expect } from 'vitest';
import {
  DORK_TEMPLATES,
  DORK_FAMILIES,
  templatesForFamily,
} from './templates.js';

// BRAND-CHECK BASIS RECORD (task STEP 6): the Company registry is empty in
// the test environment (no DB-backed Company fixtures exist - see
// backend/src/registry/importer.test.ts, whose companies are synthetic
// `example.test` rows), so this check runs against a synthetic
// `example.test` fixture name set below instead of the real registry.
// The rule asserted: no template's `site` or `label` contains any of these
// hiring-company names (case-insensitive substring match).
const SYNTHETIC_COMPANY_FIXTURES: readonly string[] = [
  'acme',
  'acme-test',
  'globex',
  'initech',
  'umbrella',
  'example',
];

// Provenance vocabulary guard (ADR-028): template text must never present
// an index signal as a posted date.
const DATE_POSTED_VOCABULARY: readonly string[] = [
  'posted',
  'published',
  'recent',
  'fresh',
  'new jobs',
  'days ago',
  'after:',
  'before:',
];

describe('dork template registry', () => {
  it('covers the four families with at least one template each', () => {
    expect(DORK_FAMILIES).toEqual([
      'ats-board',
      'career-page',
      'job-index',
      'company-site',
    ]);
    for (const family of DORK_FAMILIES) {
      expect(
        templatesForFamily(family).length,
        `family ${family} must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it('gives every template a unique, non-empty id (stable API surface)', () => {
    const ids = DORK_TEMPLATES.map((t) => t.id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(id.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('restricts every template family to the closed four-family vocabulary', () => {
    for (const t of DORK_TEMPLATES) {
      expect(DORK_FAMILIES).toContain(t.family);
    }
  });

  it('sets an explicit boolean enabledByDefault on every template', () => {
    expect(DORK_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of DORK_TEMPLATES) {
      expect(typeof t.enabledByDefault).toBe('boolean');
    }
  });

  it('embeds no company/brand name in any site or label', () => {
    for (const t of DORK_TEMPLATES) {
      const haystack = `${t.site ?? ''} ${t.label}`.toLowerCase();
      for (const company of SYNTHETIC_COMPANY_FIXTURES) {
        expect(
          haystack.includes(company.toLowerCase()),
          `template ${t.id} embeds fixture company name "${company}"`,
        ).toBe(false);
      }
    }
  });

  it('uses no index-date-as-posted-date vocabulary in any site or label', () => {
    // Word-boundary match for plain words (so the ATS provider name
    // "Freshteam", taken from the codebase host table, is not flagged by
    // the substring "fresh"); raw substring match for operator markers.
    const flagged = (haystack: string, word: string): boolean =>
      /[^a-z]/.test(word)
        ? haystack.includes(word)
        : new RegExp(`\\b${word}\\b`).test(haystack);
    for (const t of DORK_TEMPLATES) {
      const haystack = `${t.site ?? ''} ${t.label}`.toLowerCase();
      for (const word of DATE_POSTED_VOCABULARY) {
        expect(
          flagged(haystack, word),
          `template ${t.id} uses date-posted vocabulary "${word}"`,
        ).toBe(false);
      }
    }
  });

  it('declares a non-empty operator list and an array of path hints', () => {
    for (const t of DORK_TEMPLATES) {
      expect(t.operators.length).toBeGreaterThan(0);
      expect(Array.isArray(t.pathHints)).toBe(true);
    }
  });

  it('returns an empty set for an unknown family without throwing', () => {
    expect(
      templatesForFamily('unknown-family' as never),
    ).toEqual([]);
  });
});
