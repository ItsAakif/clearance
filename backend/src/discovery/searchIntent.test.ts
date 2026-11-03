// searchIntent tests (T740): schema round-trip, deterministic LLM-free
// derivation, legacy mapping, intentToQuery. No network access: every test
// here is pure (schema parse + string tokenisation only).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  searchIntentSchema,
  deriveIntent,
  intentToQuery,
  sourceGroupsForSources,
  sourceIdsForGroups,
  DEFAULT_SOURCE_GROUPS,
  SOURCE_ID_TO_GROUP,
  GROUP_TO_SOURCE_IDS,
  SEARCH_MODES,
} from './searchIntent.js';
import { parseQuery } from '../jobSources/queryMatch.js';

const MODULE_PATH = path.join(__dirname, 'searchIntent.ts');

describe('searchIntentSchema', () => {
  it('round-trips: parse -> serialise -> parse yields an equal intent', () => {
    const intent = deriveIntent({
      query: 'senior backend engineer react remote -php',
      location: ['Berlin'],
      company: 'Acme',
      sources: ['greenhouse', 'search'],
      limit: 10,
      postedWithin: 'week',
    });
    const reparsed = searchIntentSchema.parse(JSON.parse(JSON.stringify(intent)));
    expect(reparsed).toEqual(intent);
  });

  it('matches the spec defaults (limit 30, mode fast, documented sourceGroups)', () => {
    const intent = searchIntentSchema.parse({});
    expect(intent.limit).toBe(30);
    expect(intent.mode).toBe('fast');
    expect(intent.sourceGroups).toEqual([...DEFAULT_SOURCE_GROUPS]);
    expect(intent.sourceGroups).toEqual(['ats', 'feeds', 'aggregators', 'search', 'dorking', 'scraper']);
    expect(intent.roles).toEqual([]);
    expect(intent.skills).toEqual([]);
    expect(intent.exclusions).toEqual([]);
    expect(intent.locations).toEqual([]);
    expect(intent.remoteOnly).toBe(false);
    expect(intent.companies).toEqual([]);
  });

  it('round-trips every canonical wire mode through the shared vocabulary', () => {
    expect(SEARCH_MODES).toEqual(['fast', 'standard', 'deep', 'full']);
    for (const mode of SEARCH_MODES) {
      expect(searchIntentSchema.parse({ mode }).mode).toBe(mode);
    }
  });

  it('keeps `browser` a valid sourceGroups value (N2: optional tier, not hidden)', () => {
    const intent = searchIntentSchema.parse({ sourceGroups: ['browser'] });
    expect(intent.sourceGroups).toEqual(['browser']);
    expect(DEFAULT_SOURCE_GROUPS).not.toContain('browser');
  });

  it('rejects unknown source groups', () => {
    expect(() => searchIntentSchema.parse({ sourceGroups: ['nope'] })).toThrow();
  });
});

describe('deriveIntent determinism + N18', () => {
  it('is deterministic: two calls yield identical output', () => {
    const input = {
      query: 'Senior Backend Engineer React Node.js remote -php',
      location: ['Berlin', 'berlin'],
      company: 'Acme',
      sources: ['greenhouse', 'adzuna'],
      limit: 25,
      postedWithin: 'month',
    };
    const first = deriveIntent(input);
    const second = deriveIntent(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('derives skills from the fixed vocabulary and keeps leftover tokens as roles', () => {
    const intent = deriveIntent({ query: 'backend engineer react python' });
    expect(intent.skills).toEqual(expect.arrayContaining(['react', 'python']));
    expect(intent.roles).toEqual(expect.arrayContaining(['backend', 'engineer']));
    expect(intent.seniority).toBeUndefined();
    expect(intent.remoteOnly).toBe(false);
  });

  it('derives seniority (first keyword wins), remoteOnly, and exclusions', () => {
    const intent = deriveIntent({ query: 'senior frontend developer remote -java -php' });
    expect(intent.seniority).toBe('senior');
    expect(intent.remoteOnly).toBe(true);
    expect(intent.exclusions).toEqual(expect.arrayContaining(['java', 'php']));
    // Derivation markers must not leak into roles/skills.
    expect(intent.roles).not.toContain('senior');
    expect(intent.roles).not.toContain('remote');
    expect(intentToQuery(intent)).not.toMatch(/(^|\s)senior\s+senior/);
  });

  it('never fabricates a company name (or a location) from free text', () => {
    const intent = deriveIntent({ query: 'backend engineer at Acme in Berlin' });
    expect(intent.companies).toEqual([]);
    expect(intent.locations).toEqual([]);
  });

  it('imports no LLM client (no openai/anthropic) and uses no clock or randomness', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    expect(source).not.toMatch(/openai|anthropic/i);
    expect(source).not.toMatch(/Date\.now\(\)|Math\.random\(\)/);
    expect(source).not.toMatch(/from ['"]..\/llm\//);
  });

  it('unions explicit structured fields with derived tokens instead of dropping either', () => {
    const intent = deriveIntent({ query: 'backend react', roles: ['devops'], skills: ['go'] });
    expect(intent.roles).toEqual(expect.arrayContaining(['devops', 'backend']));
    expect(intent.skills).toEqual(expect.arrayContaining(['go', 'react']));
  });

  it('coerces unknown or omitted modes to fast while preserving the legacy deep boolean', () => {
    for (const mode of SEARCH_MODES) {
      expect(deriveIntent({ q: 'x', mode }).mode).toBe(mode);
    }
    expect(deriveIntent({ q: 'x', mode: 'bogus' }).mode).toBe('fast');
    expect(deriveIntent({ q: 'x', deep: true }).mode).toBe('deep');
    expect(deriveIntent({ q: 'x' }).mode).toBe('fast');
  });
});

describe('deriveIntent legacy mapping', () => {
  it('maps a legacy request losslessly: q/location/company/limit/postedWithin preserved', () => {
    const intent = deriveIntent({
      q: 'frontend engineer vue',
      location: ['Bengaluru'],
      company: 'Initech',
      limit: 15,
      postedWithin: 'day',
    });
    expect(intent.query).toBe('frontend engineer vue');
    expect(intent.locations).toEqual(['Bengaluru']);
    expect(intent.companies).toEqual(['Initech']);
    expect(intent.limit).toBe(15);
    expect(intent.postedWithin).toBe('day');
  });

  it('maps `sources` onto a superset of groups: every requested id is covered, none dropped', () => {
    const intent = deriveIntent({ q: 'engineer', sources: ['greenhouse', 'adzuna', 'search'] });
    expect(intent.sourceGroups).toEqual(expect.arrayContaining(['ats', 'aggregators', 'search']));
    const covered = new Set(sourceIdsForGroups(intent.sourceGroups));
    for (const id of ['greenhouse', 'adzuna', 'search']) {
      expect(covered.has(id)).toBe(true);
    }
  });

  it('treats missing or explicit-empty `sources` as no filter (the defaults)', () => {
    expect(deriveIntent({ q: 'engineer' }).sourceGroups).toEqual([...DEFAULT_SOURCE_GROUPS]);
    expect(deriveIntent({ q: 'engineer', sources: [] }).sourceGroups).toEqual([...DEFAULT_SOURCE_GROUPS]);
  });

  it('maps every canonical source id to exactly one group (table is total)', () => {
    const ids = Object.values(GROUP_TO_SOURCE_IDS).flat();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(SOURCE_ID_TO_GROUP[id]).toBeDefined();
    }
    expect(sourceGroupsForSources(['browser'])).toEqual(['browser']);
  });

  it('reproduces the legacy query semantics: rendered intent covers the legacy tokens', () => {
    const legacyQuery = 'senior backend engineer react';
    const intent = deriveIntent({ q: legacyQuery });
    const legacyTokens = parseQuery(legacyQuery).tokens;
    const renderedTokens = parseQuery(intentToQuery(intent)).tokens;
    // Token-OR filtering drops zero-score rows: every meaningful legacy
    // token must still hit the rendered string, or rows the legacy query
    // kept would be dropped by the intent query.
    for (const token of legacyTokens) {
      expect(renderedTokens).toContain(token);
    }
  });
});

describe('intentToQuery', () => {
  it('renders roles/skills/seniority/remote/locations/companies/exclusions', () => {
    const rendered = intentToQuery(
      searchIntentSchema.parse({
        roles: ['backend', 'engineer'],
        skills: ['react'],
        seniority: 'senior',
        remoteOnly: true,
        locations: ['Berlin'],
        companies: ['Acme'],
        exclusions: ['php'],
      }),
    );
    expect(rendered).toContain('backend');
    expect(rendered).toContain('react');
    expect(rendered).toContain('senior');
    expect(rendered).toContain('remote');
    expect(rendered).toContain('Berlin');
    expect(rendered).toContain('"Acme"');
    expect(rendered).toContain('-php');
  });

  it('states its round-trip limitation: output need not equal the input verbatim, token set is preserved', () => {
    const raw = 'Senior   Backend Engineer (React) -php';
    const intent = deriveIntent({ query: raw });
    const rendered = intentToQuery(intent);
    // Normalised, not verbatim ...
    expect(rendered).not.toBe(raw);
    // ... but every intent token survives the render.
    const renderedTokens = new Set(parseQuery(rendered).tokens);
    for (const token of [...intent.roles, ...intent.skills]) {
      expect(renderedTokens.has(token.toLowerCase())).toBe(true);
    }
  });
});
