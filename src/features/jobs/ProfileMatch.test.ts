// Unit tests for the pure ProfileMatch module (T401, runner added T602).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`
// (unchanged) so every assertion reads exactly as before.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { CareerProfile, JobSearchFilters } from '@/services/api/jobs';
import { applyProfileMatch, buildProfileMatch, isProfileMatchApplied, mergeQueryWithKeywords, MAX_PROFILE_QUERY_LENGTH } from './ProfileMatch';
import { toggleSeniorityValue } from './seniority';

const BASE_FILTERS: JobSearchFilters = {
  query: 'react',
  location: [],
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
};

function filtersWith(overrides: Partial<JobSearchFilters>): JobSearchFilters {
  return { ...BASE_FILTERS, ...overrides };
}

describe('buildProfileMatch - null/empty profiles', () => {
  it('returns null for null profile', () => {
    assert.equal(buildProfileMatch(null), null);
  });

  it('returns null for undefined profile', () => {
    assert.equal(buildProfileMatch(undefined), null);
  });

  it('returns null for an empty profile object', () => {
    assert.equal(buildProfileMatch({} as CareerProfile), null);
  });

  it('returns null for blank locationPref + remoteOnly false + no seniority', () => {
    assert.equal(
      buildProfileMatch({ locationPref: '   ', remoteOnly: false } as CareerProfile),
      null,
    );
  });

  it('returns null for an invalid seniority string with nothing else', () => {
    assert.equal(
      buildProfileMatch({ seniority: 'intern' } as unknown as CareerProfile),
      null,
    );
  });
});

describe('buildProfileMatch - variants', () => {
  it('returns a level-only summary', () => {
    const summary = buildProfileMatch({ seniority: 'senior' });
    assert.ok(summary !== null);
    assert.equal(summary.candidate.level, 'senior');
    assert.deepEqual(summary.candidate.locations, []);
    assert.equal(summary.candidate.remoteOnly, false);
    assert.deepEqual(summary.lines, ['Experience level: Senior']);
  });

  it('returns a locations-only summary from a legacy plain string', () => {
    const summary = buildProfileMatch({ locationPref: 'Berlin' });
    assert.ok(summary !== null);
    assert.equal(summary.candidate.level, undefined);
    assert.deepEqual(summary.candidate.locations, ['Berlin']);
    assert.equal(summary.candidate.remoteOnly, false);
    assert.deepEqual(summary.lines, ['Locations: Berlin']);
  });

  it('parses a JSON-array locationPref preserving order', () => {
    const summary = buildProfileMatch({
      locationPref: JSON.stringify(['Remote', 'Berlin']),
    });
    assert.ok(summary !== null);
    assert.deepEqual(summary.candidate.locations, ['Remote', 'Berlin']);
    assert.deepEqual(summary.lines, ['Locations: Remote, Berlin']);
  });

  it('returns a remote-only summary with only the remote line', () => {
    const summary = buildProfileMatch({ remoteOnly: true });
    assert.ok(summary !== null);
    assert.equal(summary.candidate.level, undefined);
    assert.deepEqual(summary.candidate.locations, []);
    assert.equal(summary.candidate.remoteOnly, true);
    assert.deepEqual(summary.lines, ['Remote only']);
  });

  it('combines level + locations + remote into three lines', () => {
    const summary = buildProfileMatch({
      seniority: 'mid',
      locationPref: JSON.stringify(['Remote', 'Berlin']),
      remoteOnly: true,
    });
    assert.ok(summary !== null);
    assert.equal(summary.candidate.level, 'mid');
    assert.deepEqual(summary.candidate.locations, ['Remote', 'Berlin']);
    assert.equal(summary.candidate.remoteOnly, true);
    assert.deepEqual(summary.lines, [
      'Experience level: Mid',
      'Locations: Remote, Berlin',
      'Remote only',
    ]);
  });

  it('maps junior to its first label row (labels-only mapping preserved)', () => {
    const summary = buildProfileMatch({ seniority: 'junior' });
    assert.ok(summary !== null);
    assert.deepEqual(summary.lines, ['Experience level: Fresher / Entry']);
  });
});

describe('applyProfileMatch - confirmed merges', () => {
  it('unions locations with case-insensitive dedupe, order preserved', () => {
    const summary = buildProfileMatch({
      locationPref: JSON.stringify(['berlin', 'Paris']),
    });
    assert.ok(summary !== null);
    const next = applyProfileMatch(
      true,
      filtersWith({ location: ['Berlin', 'London'] }),
      summary,
    );
    assert.deepEqual(next.location, ['Berlin', 'London', 'Paris']);
  });

  it('leaves existing locations untouched when the candidate adds nothing', () => {
    const summary = buildProfileMatch({ seniority: 'senior' });
    assert.ok(summary !== null);
    const next = applyProfileMatch(true, filtersWith({ location: ['Berlin'] }), summary);
    assert.deepEqual(next.location, ['Berlin']);
    assert.deepEqual(next.experienceLevel, ['senior']);
  });

  it('ORs experienceLevel without duplicating an existing value', () => {
    const summary = buildProfileMatch({ seniority: 'senior' });
    assert.ok(summary !== null);
    const next = applyProfileMatch(
      true,
      filtersWith({ experienceLevel: ['senior', 'mid'] }),
      summary,
    );
    assert.deepEqual(next.experienceLevel, ['senior', 'mid']);
  });

  it('does not drop unrelated filter fields', () => {
    const summary = buildProfileMatch({ seniority: 'lead' });
    assert.ok(summary !== null);
    const before = filtersWith({ query: 'go', company: 'Acme', sources: ['hn'] });
    const next = applyProfileMatch(true, before, summary);
    assert.equal(next.query, 'go');
    assert.equal(next.company, 'Acme');
    assert.deepEqual(next.sources, ['hn']);
    assert.deepEqual(next.experienceLevel, ['lead']);
  });
});

describe('applyProfileMatch - workMode upgrade-only rule', () => {
  it("upgrades onsite to remote when remoteOnly is true", () => {
    const summary = buildProfileMatch({ remoteOnly: true });
    assert.ok(summary !== null);
    const next = applyProfileMatch(true, filtersWith({ workMode: 'onsite' }), summary);
    assert.equal(next.workMode, 'remote');
  });

  it('leaves onsite alone when remoteOnly is false', () => {
    const summary = buildProfileMatch({ seniority: 'mid' });
    assert.ok(summary !== null);
    const next = applyProfileMatch(true, filtersWith({ workMode: 'onsite' }), summary);
    assert.equal(next.workMode, 'onsite');
  });

  it('leaves hybrid alone when remoteOnly is false', () => {
    const summary = buildProfileMatch({
      locationPref: 'Berlin',
    });
    assert.ok(summary !== null);
    const next = applyProfileMatch(true, filtersWith({ workMode: 'hybrid' }), summary);
    assert.equal(next.workMode, 'hybrid');
  });

  it('keeps an existing remote workMode', () => {
    const summary = buildProfileMatch({ remoteOnly: true });
    assert.ok(summary !== null);
    const next = applyProfileMatch(true, filtersWith({ workMode: 'remote' }), summary);
    assert.equal(next.workMode, 'remote');
  });
});

describe('applyProfileMatch - declined', () => {
  it('returns the input filters by reference', () => {
    const summary = buildProfileMatch({
      seniority: 'senior',
      locationPref: 'Berlin',
      remoteOnly: true,
    });
    assert.ok(summary !== null);
    const before = filtersWith({ workMode: 'onsite', location: ['Oslo'] });
    const next = applyProfileMatch(false, before, summary);
    assert.equal(next, before);
  });
});

describe('isProfileMatchApplied - inline toggle state', () => {
  it('is false on default filters with a non-empty summary', () => {
    const summary = buildProfileMatch({
      seniority: 'senior',
      locationPref: JSON.stringify(['Remote', 'Berlin']),
      remoteOnly: true,
    });
    assert.ok(summary !== null);
    assert.equal(isProfileMatchApplied(filtersWith({}), summary), false);
  });

  it('is true right after applyProfileMatch(true, ...)', () => {
    const summary = buildProfileMatch({
      seniority: 'senior',
      locationPref: JSON.stringify(['Remote', 'Berlin']),
      remoteOnly: true,
    });
    assert.ok(summary !== null);
    const next = applyProfileMatch(true, filtersWith({}), summary);
    assert.equal(isProfileMatchApplied(next, summary), true);
  });

  it('matches locations case-insensitively and tolerates extra user filters', () => {
    const summary = buildProfileMatch({ locationPref: 'berlin' });
    assert.ok(summary !== null);
    assert.equal(
      isProfileMatchApplied(filtersWith({ location: ['Berlin', 'Oslo'] }), summary),
      true,
    );
    assert.equal(
      isProfileMatchApplied(filtersWith({ location: ['Oslo'] }), summary),
      false,
    );
  });

  it('requires workMode remote only when remoteOnly is true', () => {
    const remote = buildProfileMatch({ remoteOnly: true });
    assert.ok(remote !== null);
    assert.equal(isProfileMatchApplied(filtersWith({ workMode: 'remote' }), remote), true);
    assert.equal(isProfileMatchApplied(filtersWith({ workMode: 'onsite' }), remote), false);
    const levelOnly = buildProfileMatch({ seniority: 'mid' });
    assert.ok(levelOnly !== null);
    assert.equal(
      isProfileMatchApplied(
        filtersWith({ workMode: 'onsite', experienceLevel: ['mid'] }),
        levelOnly,
      ),
      true,
    );
  });

  it('requires the level when the candidate has one', () => {
    const summary = buildProfileMatch({ seniority: 'senior' });
    assert.ok(summary !== null);
    assert.equal(isProfileMatchApplied(filtersWith({}), summary), false);
    assert.equal(
      isProfileMatchApplied(filtersWith({ experienceLevel: ['senior'] }), summary),
      true,
    );
  });
});

describe('buildProfileMatch - keywords', () => {
  it('collects targetRoles + topSkills deduped, order preserved', () => {
    const summary = buildProfileMatch({
      targetRoles: ['React Engineer', 'react engineer', '  ', 'Go Developer'],
      topSkills: ['Go Developer', 'TypeScript', 42 as unknown as string],
    });
    assert.ok(summary !== null);
    assert.deepEqual(summary.candidate.keywords, ['React Engineer', 'Go Developer', 'TypeScript']);
    assert.deepEqual(summary.lines, ['Keywords: React Engineer, Go Developer, TypeScript']);
  });

  it('returns a keywords-only summary when nothing else is applicable', () => {
    const summary = buildProfileMatch({ targetRoles: ['Designer'] });
    assert.ok(summary !== null);
    assert.equal(summary.candidate.level, undefined);
    assert.deepEqual(summary.candidate.locations, []);
    assert.equal(summary.candidate.remoteOnly, false);
    assert.deepEqual(summary.candidate.keywords, ['Designer']);
  });

  it('still returns null when roles/skills are all blank', () => {
    assert.equal(
      buildProfileMatch({ targetRoles: ['   '], topSkills: [] } as CareerProfile),
      null,
    );
  });
});

describe('mergeQueryWithKeywords', () => {
  it('appends absent keywords with a single space', () => {
    assert.equal(mergeQueryWithKeywords('react', ['React Engineer', 'TypeScript']), 'react React Engineer TypeScript');
  });

  it('skips keywords already present, case-insensitively', () => {
    assert.equal(mergeQueryWithKeywords('Senior React engineer', ['react ENGINEER', 'Go']), 'Senior React engineer Go');
  });

  it('fills an empty query from keywords alone', () => {
    assert.equal(mergeQueryWithKeywords('', ['React', 'Go']), 'React Go');
    assert.equal(mergeQueryWithKeywords('   ', ['React']), 'React');
  });

  it('never exceeds the backend q cap', () => {
    assert.equal(MAX_PROFILE_QUERY_LENGTH, 200);
    const base = 'react';
    const long = 'x'.repeat(200);
    assert.equal(mergeQueryWithKeywords(base, [long]), base);
    const fits = 'y'.repeat(200 - base.length - 1);
    const merged = mergeQueryWithKeywords(base, [fits, 'overflow-keyword']);
    assert.equal(merged, `${base} ${fits}`);
    assert.ok(merged.length <= 200);
  });

  it('returns the input unchanged when there is nothing to add', () => {
    assert.equal(mergeQueryWithKeywords('go', []), 'go');
    assert.equal(mergeQueryWithKeywords('go', ['GO']), 'go');
  });
});

describe('applyProfileMatch - keyword handling (hidden keywords)', () => {
  it('never writes keywords into the visible query; they compose at send time', () => {
    const summary = buildProfileMatch({
      seniority: 'senior',
      targetRoles: ['React Engineer'],
      topSkills: ['TypeScript', 'react'],
    });
    assert.ok(summary !== null);
    const next = applyProfileMatch(true, filtersWith({ query: 'react' }), summary);
    // Visible input keeps the base typed query only.
    assert.equal(next.query, 'react');
    assert.deepEqual(next.experienceLevel, ['senior']);
    // The outgoing `q` composes base + keywords behind the scenes.
    assert.equal(
      mergeQueryWithKeywords(next.query, summary.candidate.keywords),
      'react React Engineer TypeScript',
    );
  });

  it('leaves the query alone when the candidate has no keywords', () => {
    const summary = buildProfileMatch({ seniority: 'lead' });
    assert.ok(summary !== null);
    const next = applyProfileMatch(true, filtersWith({ query: 'go' }), summary);
    assert.equal(next.query, 'go');
  });

  it('applied state ignores the query; keywords ride out-of-band', () => {
    const summary = buildProfileMatch({ targetRoles: ['React', 'Go'] });
    assert.ok(summary !== null);
    const next = applyProfileMatch(true, filtersWith({ query: '' }), summary);
    // No keywords in the visible query, yet the toggle counts as applied:
    // keywords are armed separately and composed at send time.
    assert.equal(next.query, '');
    assert.equal(isProfileMatchApplied(next, summary), true);
    assert.equal(isProfileMatchApplied(filtersWith({ query: 'React' }), summary), true);
    assert.equal(
      mergeQueryWithKeywords(next.query, summary.candidate.keywords),
      'React Go',
    );
  });

  it('toggle-OFF contract: the base query was never mutated, so nothing restores', () => {
    const summary = buildProfileMatch({ targetRoles: ['React Engineer'] });
    assert.ok(summary !== null);
    const before = filtersWith({ query: 'react  remote' });
    const armed = applyProfileMatch(true, before, summary);
    assert.equal(armed.query, 'react  remote');
  });
});

describe('toggleSeniorityValue - experience multi-select dedupe', () => {
  it('checking two rows that share a stored value produces one entry', () => {
    const once = toggleSeniorityValue([], 'junior', true);
    assert.deepEqual(once, ['junior']);
    const twice = toggleSeniorityValue(once, 'junior', true);
    assert.deepEqual(twice, ['junior']);
  });

  it('unchecking one of a shared-value pair removes the value', () => {
    assert.deepEqual(toggleSeniorityValue(['junior', 'mid'], 'junior', false), ['mid']);
  });

  it('never emits duplicates and drops values outside the stored enum', () => {
    assert.deepEqual(toggleSeniorityValue(['senior'], 'senior', true), ['senior']);
    assert.deepEqual(
      toggleSeniorityValue(['mid'], 'intern' as unknown as Parameters<typeof toggleSeniorityValue>[1], true),
      ['mid'],
    );
  });
});
