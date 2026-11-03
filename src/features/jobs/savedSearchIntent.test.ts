// Unit tests for the pure save-current-search helpers (T844).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (ProfileMatch.test.ts).

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  filtersToIntentInput,
  intentInputCarriesCriteria,
  summarizeSavedSearch,
} from './savedSearchIntent';
import type { JobSearchFilters } from '../../services/api/jobs';

function filtersWith(overrides: Partial<JobSearchFilters>): JobSearchFilters {
  return {
    query: '',
    location: [],
    company: '',
    workMode: 'all',
    sources: [],
    postedWithin: 'all',
    sortBy: 'relevance',
    experienceLevel: [],
    roles: [],
    skills: [],
    exclusions: [],
    companies: [],
    sourceGroups: [],
    mode: 'fast',
    ...overrides,
  };
}

describe('filtersToIntentInput', () => {
  it('maps the live filter state field-for-field', () => {
    const input = filtersToIntentInput(
      filtersWith({
        query: '  Senior Frontend  ',
        roles: ['backend'],
        skills: ['react'],
        exclusions: ['crypto'],
        location: ['Berlin'],
        company: 'Acme',
        companies: ['Beta'],
        workMode: 'remote',
        sourceGroups: ['ats'] as JobSearchFilters['sourceGroups'],
        mode: 'deep',
        postedWithin: 'week',
      }),
    );
    assert.equal(input.query, 'Senior Frontend');
    assert.deepEqual(input.roles, ['backend']);
    assert.deepEqual(input.skills, ['react']);
    assert.deepEqual(input.exclusions, ['crypto']);
    assert.deepEqual(input.locations, ['Berlin']);
    assert.equal(input.remoteOnly, true);
    // The legacy single-company field folds in first, exactly as the scope
    // gate counts it.
    assert.deepEqual(input.companies, ['Acme', 'Beta']);
    assert.deepEqual(input.sourceGroups, ['ats']);
    assert.equal(input.mode, 'deep');
    assert.equal(input.postedWithin, 'week');
  });

  it('leaves postedWithin absent for "all" and remoteOnly false unless remote', () => {
    const input = filtersToIntentInput(filtersWith({ query: 'x' }));
    assert.equal(input.postedWithin, undefined);
    assert.equal(input.remoteOnly, false);
    assert.equal(input.mode, 'fast');
  });

  it('never invents companies or locations from free text', () => {
    const input = filtersToIntentInput(filtersWith({ query: 'Acme Berlin engineer' }));
    assert.deepEqual(input.companies, []);
    assert.deepEqual(input.locations, []);
  });
});

describe('intentInputCarriesCriteria - the one gate predicate', () => {
  it('an empty intent carries nothing (save stays blocked)', () => {
    assert.equal(intentInputCarriesCriteria(filtersToIntentInput(filtersWith({}))), false);
  });

  it('query text alone carries criteria (free-text path still saves)', () => {
    assert.equal(
      intentInputCarriesCriteria(filtersToIntentInput(filtersWith({ query: 'frontend' }))),
      true,
    );
  });

  it('each structured criterion counts on its own', () => {
    assert.equal(
      intentInputCarriesCriteria(filtersToIntentInput(filtersWith({ roles: ['backend'] }))),
      true,
    );
    assert.equal(
      intentInputCarriesCriteria(filtersToIntentInput(filtersWith({ skills: ['react'] }))),
      true,
    );
    assert.equal(
      intentInputCarriesCriteria(filtersToIntentInput(filtersWith({ exclusions: ['crypto'] }))),
      true,
    );
    assert.equal(
      intentInputCarriesCriteria(filtersToIntentInput(filtersWith({ location: ['Berlin'] }))),
      true,
    );
    assert.equal(
      intentInputCarriesCriteria(filtersToIntentInput(filtersWith({ company: 'Acme' }))),
      true,
    );
    assert.equal(
      intentInputCarriesCriteria(filtersToIntentInput(filtersWith({ workMode: 'remote' }))),
      true,
    );
  });

  it('modifiers alone never count (mode, groups, recency, sort)', () => {
    assert.equal(
      intentInputCarriesCriteria(
        filtersToIntentInput(
          filtersWith({ mode: 'deep', sourceGroups: ['ats'] as never, postedWithin: 'week', sortBy: 'newest' }),
        ),
      ),
      false,
    );
  });

  it('never throws on malformed input', () => {
    assert.equal(intentInputCarriesCriteria(undefined as never), false);
    assert.equal(intentInputCarriesCriteria(null as never), false);
  });
});

describe('summarizeSavedSearch - roles + mode + groups', () => {
  it('summarises an intent row as roles, mode, groups', () => {
    assert.equal(
      summarizeSavedSearch({
        query: 'derived query',
        intent: { roles: ['backend', 'frontend'], mode: 'deep', sourceGroups: ['ats', 'feeds'] },
      }),
      'backend, frontend · deep · ats + feeds',
    );
  });

  it('omits fast mode and caps long role lists', () => {
    assert.equal(
      summarizeSavedSearch({
        query: 'q',
        intent: { roles: ['a', 'b', 'c', 'd'], mode: 'fast', sourceGroups: [] },
      }),
      'a, b, c +1 more',
    );
  });

  it('falls back to the query text for legacy or malformed rows', () => {
    assert.equal(summarizeSavedSearch({ query: 'frontend', intent: null }), 'frontend');
    assert.equal(summarizeSavedSearch({ query: 'frontend' }), 'frontend');
    assert.equal(summarizeSavedSearch({ query: '', intent: { mode: 'fast' } }), 'Saved search');
    assert.equal(summarizeSavedSearch({}), 'Saved search');
  });
});
