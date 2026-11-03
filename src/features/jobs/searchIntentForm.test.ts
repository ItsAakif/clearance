// Unit tests for the pure intent-form helpers (T800).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (ProfileMatch.test.ts).
//
// Backend limits mirrored here are read from `searchIntentSchema` in
// `backend/src/discovery/searchIntent.ts` (T740), lines 192-215 - not from
// prose. If the backend schema moves, these tests must move with it.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMPANIES_MAX,
  COMPANY_MAX_LENGTH,
  EXCLUSION_MAX_LENGTH,
  EXCLUSIONS_MAX,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  LIMIT_MIN,
  LOCATIONS_MAX,
  LOCATION_MAX_LENGTH,
  QUERY_MAX_LENGTH,
  ROLES_MAX,
  ROLE_MAX_LENGTH,
  SKILL_MAX_LENGTH,
  SKILLS_MAX,
  addListItem,
  formToIntentInput,
  removeListItem,
  validateForm,
} from './searchIntentForm';
import type { SearchIntentFormValues } from './searchIntentForm';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function str(n: number): string {
  return 'x'.repeat(n);
}

function items(n: number, len = 3): string[] {
  return Array.from({ length: n }, (_, i) => `item-${i}-${str(Math.max(0, len - 7))}`);
}

function fieldsWith(overrides: Partial<SearchIntentFormValues>): SearchIntentFormValues {
  return { ...overrides };
}

function fieldNames(issues: Array<{ field: string }>): string[] {
  return issues.map((i) => i.field);
}

describe('validateForm - empty form is valid', () => {
  it('returns no issues for an empty form (0 boundary)', () => {
    assert.deepEqual(validateForm({}), []);
  });

  it('returns no issues for a fully valid form', () => {
    assert.deepEqual(
      validateForm({
        query: 'backend engineer',
        roles: ['backend', 'engineer'],
        skills: ['go', 'postgres'],
        seniority: 'senior',
        exclusions: ['php'],
        locations: ['Berlin'],
        remoteOnly: true,
        companies: ['Acme'],
        sourceGroups: ['ats'],
        mode: 'deep',
        limit: 30,
        postedWithin: 'week',
      }),
      [],
    );
  });
});

describe('validateForm - query boundary', () => {
  it('accepts an empty query (0)', () => {
    assert.deepEqual(validateForm({ query: '' }), []);
  });

  it(`accepts a query at the limit (${QUERY_MAX_LENGTH})`, () => {
    assert.equal(QUERY_MAX_LENGTH, 200);
    assert.deepEqual(validateForm({ query: str(200) }), []);
  });

  it('flags a query over the limit', () => {
    const issues = validateForm({ query: str(201) });
    assert.ok(fieldNames(issues).includes('query'));
  });
});

describe('validateForm - roles boundary', () => {
  it('accepts 0 roles', () => {
    assert.deepEqual(validateForm({ roles: [] }), []);
  });

  it(`accepts roles at the limit (${ROLES_MAX})`, () => {
    assert.equal(ROLES_MAX, 10);
    assert.deepEqual(validateForm({ roles: items(10) }), []);
  });

  it('flags roles over the limit', () => {
    const issues = validateForm({ roles: items(11) });
    assert.ok(fieldNames(issues).includes('roles'));
  });

  it(`accepts a role item at the length limit (${ROLE_MAX_LENGTH})`, () => {
    assert.equal(ROLE_MAX_LENGTH, 100);
    assert.deepEqual(validateForm({ roles: [str(100)] }), []);
  });

  it('flags a role item over the length limit', () => {
    const issues = validateForm({ roles: [str(101)] });
    assert.ok(fieldNames(issues).includes('roles[0]'));
  });
});

describe('validateForm - skills boundary', () => {
  it('accepts 0 skills', () => {
    assert.deepEqual(validateForm({ skills: [] }), []);
  });

  it(`accepts skills at the limit (${SKILLS_MAX})`, () => {
    assert.equal(SKILLS_MAX, 30);
    assert.deepEqual(validateForm({ skills: items(30) }), []);
  });

  it('flags skills over the limit', () => {
    const issues = validateForm({ skills: items(31) });
    assert.ok(fieldNames(issues).includes('skills'));
  });

  it(`accepts a skill item at the length limit (${SKILL_MAX_LENGTH})`, () => {
    assert.equal(SKILL_MAX_LENGTH, 50);
    assert.deepEqual(validateForm({ skills: [str(50)] }), []);
  });

  it('flags a skill item over the length limit', () => {
    const issues = validateForm({ skills: [str(51)] });
    assert.ok(fieldNames(issues).includes('skills[0]'));
  });
});

describe('validateForm - exclusions boundary', () => {
  it('accepts 0 exclusions', () => {
    assert.deepEqual(validateForm({ exclusions: [] }), []);
  });

  it(`accepts exclusions at the limit (${EXCLUSIONS_MAX})`, () => {
    assert.equal(EXCLUSIONS_MAX, 20);
    assert.deepEqual(validateForm({ exclusions: items(20) }), []);
  });

  it('flags exclusions over the limit', () => {
    const issues = validateForm({ exclusions: items(21) });
    assert.ok(fieldNames(issues).includes('exclusions'));
  });

  it(`accepts an exclusion item at the length limit (${EXCLUSION_MAX_LENGTH})`, () => {
    assert.equal(EXCLUSION_MAX_LENGTH, 50);
    assert.deepEqual(validateForm({ exclusions: [str(50)] }), []);
  });

  it('flags an exclusion item over the length limit', () => {
    const issues = validateForm({ exclusions: [str(51)] });
    assert.ok(fieldNames(issues).includes('exclusions[0]'));
  });
});

describe('validateForm - locations boundary', () => {
  it('accepts 0 locations', () => {
    assert.deepEqual(validateForm({ locations: [] }), []);
  });

  it(`accepts locations at the limit (${LOCATIONS_MAX})`, () => {
    assert.equal(LOCATIONS_MAX, 10);
    assert.deepEqual(validateForm({ locations: items(10) }), []);
  });

  it('flags locations over the limit', () => {
    const issues = validateForm({ locations: items(11) });
    assert.ok(fieldNames(issues).includes('locations'));
  });

  it(`accepts a location item at the length limit (${LOCATION_MAX_LENGTH})`, () => {
    assert.equal(LOCATION_MAX_LENGTH, 80);
    assert.deepEqual(validateForm({ locations: [str(80)] }), []);
  });

  it('flags a location item over the length limit', () => {
    const issues = validateForm({ locations: [str(81)] });
    assert.ok(fieldNames(issues).includes('locations[0]'));
  });
});

describe('validateForm - companies boundary', () => {
  it('accepts 0 companies', () => {
    assert.deepEqual(validateForm({ companies: [] }), []);
  });

  it(`accepts companies at the limit (${COMPANIES_MAX})`, () => {
    assert.equal(COMPANIES_MAX, 500);
    assert.deepEqual(validateForm({ companies: items(500) }), []);
  });

  it('flags companies over the limit', () => {
    const issues = validateForm({ companies: items(501) });
    assert.ok(fieldNames(issues).includes('companies'));
  });

  it(`accepts a company item at the length limit (${COMPANY_MAX_LENGTH})`, () => {
    assert.equal(COMPANY_MAX_LENGTH, 120);
    assert.deepEqual(validateForm({ companies: [str(120)] }), []);
  });

  it('flags a company item over the length limit', () => {
    const issues = validateForm({ companies: [str(121)] });
    assert.ok(fieldNames(issues).includes('companies[0]'));
  });
});

describe('validateForm - limit boundary', () => {
  it(`accepts the low end (${LIMIT_MIN}) and high end (${LIMIT_MAX})`, () => {
    assert.equal(LIMIT_MIN, 1);
    assert.equal(LIMIT_MAX, 100);
    assert.deepEqual(validateForm({ limit: 1 }), []);
    assert.deepEqual(validateForm({ limit: 100 }), []);
  });

  it('flags 0 and 101', () => {
    assert.ok(fieldNames(validateForm({ limit: 0 })).includes('limit'));
    assert.ok(fieldNames(validateForm({ limit: 101 })).includes('limit'));
  });

  it('flags non-integers and non-finite values', () => {
    assert.ok(fieldNames(validateForm({ limit: 2.5 })).includes('limit'));
    assert.ok(fieldNames(validateForm({ limit: Number.NaN })).includes('limit'));
  });

  it('treats an absent limit as valid (backend default applies)', () => {
    assert.deepEqual(validateForm({}), []);
  });
});

describe('validateForm - enums', () => {
  it('accepts every backend seniority value, flags an unknown one', () => {
    for (const seniority of ['junior', 'mid', 'senior', 'staff', 'lead', 'principal']) {
      assert.deepEqual(validateForm({ seniority }), []);
    }
    assert.ok(fieldNames(validateForm({ seniority: 'intern' })).includes('seniority'));
  });

  it('accepts every recency value, flags an unknown one', () => {
    for (const postedWithin of ['day', 'week', 'month']) {
      assert.deepEqual(validateForm({ postedWithin }), []);
    }
    assert.ok(fieldNames(validateForm({ postedWithin: 'year' })).includes('postedWithin'));
  });

  it('accepts both modes, flags an unknown one', () => {
    assert.deepEqual(validateForm({ mode: 'fast' }), []);
    assert.deepEqual(validateForm({ mode: 'deep' }), []);
    assert.ok(fieldNames(validateForm({ mode: 'turbo' })).includes('mode'));
  });

  it('flags blank source-group entries', () => {
    const issues = validateForm({ sourceGroups: ['ats', '   '] });
    assert.ok(fieldNames(issues).includes('sourceGroups[1]'));
  });
});

describe('formToIntentInput - normalisation', () => {
  it('trims, drops blanks, and dedupes case-insensitively', () => {
    const input = formToIntentInput(
      fieldsWith({ roles: ['  Backend ', '', 'backend', 'ENGINEER'] }),
    );
    assert.deepEqual(input.roles, ['Backend', 'ENGINEER']);
  });

  it('applies documented defaults for an empty form', () => {
    assert.equal(LIMIT_DEFAULT, 30);
    const input = formToIntentInput({});
    assert.deepEqual(input, {
      roles: [],
      skills: [],
      exclusions: [],
      locations: [],
      remoteOnly: false,
      companies: [],
      sourceGroups: [],
      mode: 'fast',
      limit: 30,
    });
  });

  it('keeps a valid seniority/postedWithin/mode and drops invalid ones', () => {
    const valid = formToIntentInput({ seniority: 'lead', postedWithin: 'month', mode: 'deep' });
    assert.equal(valid.seniority, 'lead');
    assert.equal(valid.postedWithin, 'month');
    assert.equal(valid.mode, 'deep');
    const invalid = formToIntentInput({
      seniority: 'intern',
      postedWithin: 'year',
      mode: 'turbo',
    });
    assert.equal(invalid.seniority, undefined);
    assert.equal(invalid.postedWithin, undefined);
    assert.equal(invalid.mode, 'fast');
  });

  it('omits a blank query but keeps a trimmed one', () => {
    assert.ok(!('query' in formToIntentInput({ query: '   ' })));
    assert.equal(formToIntentInput({ query: '  go developer ' }).query, 'go developer');
  });

  it('falls back to the default limit only for missing/non-finite input', () => {
    assert.equal(formToIntentInput({}).limit, 30);
    assert.equal(formToIntentInput({ limit: Number.NaN }).limit, 30);
    assert.equal(formToIntentInput({ limit: 101 }).limit, 101);
  });
});

describe('searchIntentForm - chip commit helpers (T801 sheet inputs)', () => {
  it('addListItem trims, drops blanks, and dedupes case-insensitively', () => {
    assert.deepEqual(addListItem([], '  Backend '), ['Backend']);
    assert.deepEqual(addListItem(['Backend'], 'backend'), ['Backend']);
    assert.deepEqual(addListItem(['a'], '   '), ['a']);
    assert.deepEqual(addListItem(['a'], 'b'), ['a', 'b']);
  });

  it('addListItem never truncates: over-limit entries stay for validateForm', () => {
    const long = str(ROLE_MAX_LENGTH + 1);
    assert.deepEqual(addListItem([], long), [long]);
  });

  it('removeListItem drops case-insensitive trimmed matches', () => {
    assert.deepEqual(removeListItem(['Backend', 'Go'], ' backend '), ['Go']);
    assert.deepEqual(removeListItem(['a'], 'b'), ['a']);
    assert.deepEqual(removeListItem([], 'a'), []);
  });
});

describe('searchIntentForm - no local source vocabulary (contract owns it)', () => {  it('helper keeps no hand-listed source ids or group names', () => {
    const text = readFileSync(path.join(HERE, 'searchIntentForm.ts'), 'utf8');
    const forbidden = [
      'greenhouse', 'ashby', 'lever', 'smartrecruiters', 'recruitee',
      'personio', 'jobicy', 'hnalgolia', 'workable', 'bamboohr',
      'breezyhr', 'jobvite', 'teamtailor', 'pinpoint', 'freshteam',
      'workday', 'career-page', 'adzuna', 'usajobs', 'reed',
      'findwork', 'dorking', 'scraper', 'browser',
      "'ats'", "'feeds'", "'aggregators'",
    ];
    for (const literal of forbidden) {
      assert.ok(!text.includes(literal), `helper must not contain ${literal}`);
    }
  });
});
