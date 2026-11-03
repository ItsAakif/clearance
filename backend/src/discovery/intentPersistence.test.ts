// intentPersistence tests (T840): intentToLegacy / legacyToIntent round
// trips (including explicitly-asserted documented losses), the existing
// location string serialisation, null-intent read-path derivation without
// write-back, and emptiness detection for the no-criteria alert rule.
// Pure: schema parsing + string conversion only, no DB, no network.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  deriveIntentForRow,
  intentToLegacy,
  isEmptyIntent,
  isEmptyLegacy,
  legacyToIntent,
} from './intentPersistence.js';
import {
  deriveIntent,
  searchIntentSchema,
  DEFAULT_SOURCE_GROUPS,
  GROUP_TO_SOURCE_IDS,
} from './searchIntent.js';

const MODULE_PATH = path.join(__dirname, 'intentPersistence.ts');

describe('module purity contract', () => {
  it('imports no ORM client (mirrors the task diff check)', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    expect(source).not.toMatch(/prisma/i);
  });

  it('intentToLegacy populates every legacy field old readers need', () => {
    const legacy = intentToLegacy(
      deriveIntent({ query: 'backend engineer', location: ['Berlin'] }),
    );
    for (const key of [
      'query',
      'location',
      'company',
      'sources',
      'minMatchScore',
      'remoteOnly',
      'sortBy',
    ] as const) {
      expect(legacy, `missing field ${key}`).toHaveProperty(key);
    }
  });
});

describe('intent -> legacy -> intent round trip', () => {
  it('preserves every structured field of a UI-produced intent; only `query` normalises (documented loss 1)', () => {
    const intent = deriveIntent({
      query: 'Senior Backend Engineer React remote -php',
      location: ['Berlin'],
      company: 'Acme',
      sources: ['greenhouse', 'search'],
    });

    const roundTripped = legacyToIntent(intentToLegacy(intent));

    // Structured fields survive exactly.
    expect(roundTripped.roles).toEqual(intent.roles);
    expect(roundTripped.skills).toEqual(intent.skills);
    expect(roundTripped.seniority).toEqual(intent.seniority);
    expect(roundTripped.exclusions).toEqual(intent.exclusions);
    expect(roundTripped.locations).toEqual(intent.locations);
    expect(roundTripped.remoteOnly).toEqual(intent.remoteOnly);
    expect(roundTripped.companies).toEqual(intent.companies);
    expect(roundTripped.sourceGroups).toEqual(intent.sourceGroups);
    // The verbatim text is NOT preserved: the legacy query is the normalised
    // rendering (roles/skills/seniority/remote/-exclusions, normalised order).
    expect(roundTripped.query).toBe('backend engineer react senior remote -php');
    expect(roundTripped.query).not.toBe(intent.query);
  });

  it('round-trips a structured-only intent (no raw query); `query` becomes the rendering (documented loss 1)', () => {
    const intent = searchIntentSchema.parse({
      roles: ['frontend'],
      skills: ['typescript'],
      locations: ['Remote'],
      remoteOnly: true,
      companies: ['Acme'],
      sourceGroups: ['ats'],
      mode: 'deep',
    });

    const roundTripped = legacyToIntent(intentToLegacy(intent));

    expect(roundTripped.roles).toEqual(['frontend']);
    expect(roundTripped.skills).toEqual(['typescript']);
    expect(roundTripped.locations).toEqual(['Remote']);
    expect(roundTripped.remoteOnly).toBe(true);
    expect(roundTripped.companies).toEqual(['Acme']);
    expect(roundTripped.sourceGroups).toEqual(['ats']);
    // The original had no raw text; re-derivation sets it to the rendering.
    expect(intent.query).toBeUndefined();
    expect(roundTripped.query).toBe('frontend typescript remote');
    // `mode` has no legacy column: the default comes back (documented loss 6).
    expect(roundTripped.mode).toBe('fast');
  });

  it('is a fixed point on the legacy side: re-deriving stabilises', () => {
    const once = legacyToIntent({
      query: 'senior backend engineer react remote -php',
      location: 'Berlin',
      company: 'Acme',
      sources: ['greenhouse', 'search'],
      remoteOnly: true,
    });
    const legacyOnce = intentToLegacy(once);
    const legacyTwice = intentToLegacy(legacyToIntent(legacyOnce));
    expect(legacyTwice).toEqual(legacyOnce);
    // And the intent stabilises too, modulo the documented query normalisation.
    const twice = legacyToIntent(legacyOnce);
    expect(twice).toEqual({ ...once, query: legacyOnce.query });
  });
});

describe('legacy -> intent -> legacy round trip', () => {
  it('keeps company/remoteOnly; asserts the documented losses explicitly', () => {
    const legacy = {
      query: 'senior backend engineer',
      location: 'Berlin',
      company: 'Acme',
      sources: ['greenhouse', 'search'],
      minMatchScore: 70,
      remoteOnly: false,
      sortBy: 'newest',
    };

    const intent = legacyToIntent(legacy);
    expect(intent.roles).toEqual(['backend', 'engineer']);
    expect(intent.seniority).toBe('senior');
    expect(intent.locations).toEqual(['Berlin']);
    expect(intent.companies).toEqual(['Acme']);
    expect(intent.sourceGroups).toEqual(['ats', 'search']);

    const back = intentToLegacy(intent);
    // Query normalises to rendering order (documented loss 1).
    expect(back.query).toBe('backend engineer senior');
    // Plain-string location re-serialises as the JSON form: same list,
    // different representation (documented loss 2).
    expect(back.location).toBe('["Berlin"]');
    expect(back.company).toBe('Acme');
    expect(back.remoteOnly).toBe(false);
    // minMatchScore/sortBy are not carried by the intent (documented loss 5).
    expect(back.minMatchScore).toBeNull();
    expect(back.sortBy).toBe('relevance');
  });

  it('expands source subsets to their groups (superset: nothing requested is dropped; documented loss 4)', () => {
    const intent = legacyToIntent({ query: 'backend', sources: ['greenhouse'] });
    expect(intent.sourceGroups).toEqual(['ats']);

    const back = intentToLegacy(intent);
    expect(back.sources).toEqual([...GROUP_TO_SOURCE_IDS.ats]);
    expect(back.sources).toContain('greenhouse');
  });

  it('stores null sources for the default groups and derives defaults back', () => {
    const intent = deriveIntent({ query: 'backend' });
    expect(intent.sourceGroups).toEqual([...DEFAULT_SOURCE_GROUPS]);
    expect(intentToLegacy(intent).sources).toBeNull();

    expect(legacyToIntent({ query: 'backend' }).sourceGroups).toEqual([
      ...DEFAULT_SOURCE_GROUPS,
    ]);
    expect(legacyToIntent({ query: 'backend', sources: [] }).sourceGroups).toEqual([
      ...DEFAULT_SOURCE_GROUPS,
    ]);
    expect(legacyToIntent({ query: 'backend', sources: null }).sourceGroups).toEqual([
      ...DEFAULT_SOURCE_GROUPS,
    ]);
  });

  it('preserves an explicit browser opt-in through the round trip', () => {
    const intent = searchIntentSchema.parse({
      roles: ['backend'],
      sourceGroups: [...DEFAULT_SOURCE_GROUPS, 'browser'],
    });
    const legacy = intentToLegacy(intent);
    expect(legacy.sources).toContain('browser');
    expect(legacyToIntent(legacy).sourceGroups).toContain('browser');
  });

  it('drops companies beyond the first (documented loss 3)', () => {
    const intent = searchIntentSchema.parse({
      roles: ['backend'],
      companies: ['Acme', 'Globex'],
    });
    expect(intentToLegacy(intent).company).toBe('Acme');
  });

  it('keeps the legacy column authoritative for remoteOnly over query text', () => {
    // Query mentions remote but the stored toggle is off: stays off.
    expect(
      legacyToIntent({ query: 'backend remote', remoteOnly: false }).remoteOnly,
    ).toBe(false);
    // Stored toggle on: stays on even without a marker in the text.
    const on = legacyToIntent({ query: 'backend', remoteOnly: true });
    expect(on.remoteOnly).toBe(true);
    expect(intentToLegacy(on).remoteOnly).toBe(true);
  });
});

describe('location serialisation (ADR-008 / ADR-019)', () => {
  it('writes arrays as JSON strings and reads a JSON-array row back byte-identical', () => {
    const stored = '["Berlin","Remote"]';
    const intent = legacyToIntent({ query: 'backend', location: stored });
    expect(intent.locations).toEqual(['Berlin', 'Remote']);
    expect(intentToLegacy(intent).location).toBe(stored);
  });

  it('decodes a legacy plain string to the same single-location list', () => {
    const intent = legacyToIntent({ query: 'backend', location: 'Berlin' });
    expect(intent.locations).toEqual(['Berlin']);
  });

  it('stores an empty location list as null', () => {
    expect(
      intentToLegacy(searchIntentSchema.parse({ roles: ['backend'] })).location,
    ).toBeNull();
  });
});

describe('deriveIntentForRow (pre-existing rows)', () => {
  it('derives a null-intent row on the fly without mutating it', () => {
    const row = {
      intent: null,
      query: 'react frontend',
      location: '["Berlin"]',
      company: 'Acme',
      sources: ['search'],
      minMatchScore: null,
      remoteOnly: false,
      sortBy: 'relevance',
    };
    const before = JSON.parse(JSON.stringify(row));

    const intent = deriveIntentForRow(row);

    expect(intent.roles).toEqual(['frontend']);
    expect(intent.skills).toEqual(['react']);
    expect(intent.locations).toEqual(['Berlin']);
    expect(intent.companies).toEqual(['Acme']);
    // No write-back: the input is untouched, no intent key added.
    expect(row).toEqual(before);
    expect('intent' in row && (row as { intent: unknown }).intent).toBeNull();
  });

  it('returns a stored valid intent normalised through the schema', () => {
    const stored = {
      roles: ['backend'],
      skills: ['go'],
      locations: ['Remote'],
      remoteOnly: true,
      companies: ['Acme'],
      sourceGroups: ['ats'],
      mode: 'deep',
    };
    const intent = deriveIntentForRow({ intent: stored, query: 'stale text' });
    expect(intent).toEqual(searchIntentSchema.parse(stored));
    // The stored intent wins over the legacy string fields.
    expect(intent.roles).toEqual(['backend']);
  });

  it('falls back to legacy derivation for an unparseable stored intent', () => {
    // `{ roles: 'not-an-array' }` fails schema validation (a bare unknown-key
    // object would strip and parse, so the fallback needs a real type error).
    const intent = deriveIntentForRow({
      intent: { roles: 'not-an-array' },
      query: 'backend engineer',
    });
    expect(intent.roles).toEqual(['backend', 'engineer']);
  });
});

describe('emptiness detection (no-criteria alert rejection)', () => {
  it('detects an empty intent, including one with only modifiers set', () => {
    expect(isEmptyIntent(searchIntentSchema.parse({}))).toBe(true);
    // Mode/limit/postedWithin/evaluate alone are not criteria.
    expect(
      isEmptyIntent(
        searchIntentSchema.parse({ mode: 'deep', limit: 10, postedWithin: 'week' }),
      ),
    ).toBe(true);
    expect(
      isEmptyIntent(deriveIntent({ query: 'backend engineer' })),
    ).toBe(false);
    expect(isEmptyIntent(searchIntentSchema.parse({ remoteOnly: true }))).toBe(
      false,
    );
    expect(isEmptyIntent(searchIntentSchema.parse({ roles: ['backend'] }))).toBe(
      false,
    );
  });

  it('detects an empty legacy payload; score/sort modifiers do not count', () => {
    expect(isEmptyLegacy({})).toBe(true);
    expect(isEmptyLegacy({ query: '   ', location: null })).toBe(true);
    expect(isEmptyLegacy({ minMatchScore: 70, sortBy: 'newest' })).toBe(true);
    expect(isEmptyLegacy({ sources: [] })).toBe(true);
    expect(isEmptyLegacy({ query: 'backend' })).toBe(false);
    expect(isEmptyLegacy({ location: '["Berlin"]' })).toBe(false);
    expect(isEmptyLegacy({ company: 'Acme' })).toBe(false);
    expect(isEmptyLegacy({ sources: ['greenhouse'] })).toBe(false);
    expect(isEmptyLegacy({ remoteOnly: true })).toBe(false);
  });

  it('an empty legacy payload derives a valid but detectably-empty intent', () => {
    const intent = legacyToIntent({});
    expect(() => searchIntentSchema.parse(intent)).not.toThrow();
    expect(isEmptyIntent(intent)).toBe(true);
  });
});
