// Unit tests for the contract-derived source groups (T801).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (ProfileMatch.test.ts).
//
// Membership pins below mirror `SOURCE_ID_TO_GROUP` in
// `backend/src/discovery/searchIntent.ts` (T740), lines 118-146 - not prose.
// If the backend table moves, these pins must move with it. The pins live in
// the TEST (same precedent as EXPECTED_SOURCES in sourceContract.test.ts);
// the module itself carries no hand-listed source ids.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../../../shared/job-sources.json';
import {
  BROWSER_GROUP,
  SOURCE_GROUPS,
  SOURCE_GROUP_MEMBERS,
  cleanSourceGroups,
  groupCheckState,
  groupForContractProvider,
  resolveSourceGroups,
  selectedSourceGroups,
  toggleSourceGroup,
} from './sourceGroups';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_TEXT = readFileSync(path.join(HERE, 'sourceGroups.ts'), 'utf8');

// Source ids that are never group/type/kind names: their presence in the
// module would prove a hand-maintained source list (the ADR-031 drift
// hazard). Group/type/kind words (`search`, `scraper`, `dorking`, `browser`,
// `rss`, `json`) legitimately appear as mapping-rule inputs/outputs.
const SOURCE_ID_PROBES = [
  'greenhouse',
  'ashby',
  'lever',
  'workday',
  'smartrecruiters',
  'recruitee',
  'personio',
  'jobicy',
  'hnalgolia',
  'adzuna',
  'usajobs',
  'reed',
  'findwork',
  'workable',
  'bamboohr',
  'breezyhr',
  'jobvite',
  'teamtailor',
  'pinpoint',
  'freshteam',
  'career-page',
];

describe('sourceGroups - contract consumption (no local list)', () => {
  it('resolves from the generated contract', () => {
    assert.ok(MODULE_TEXT.includes('shared/job-sources.json'));
  });

  it('carries no hand-listed source ids and no group array literal', () => {
    for (const probe of SOURCE_ID_PROBES) {
      assert.ok(
        !MODULE_TEXT.includes(`'${probe}'`),
        `module must not hand-list source id '${probe}'`,
      );
    }
    assert.ok(!MODULE_TEXT.includes(`['ats'`));
    assert.ok(!MODULE_TEXT.includes(`"ats",`));
  });

  it('resolves the seven intent groups in contract-source order', () => {
    assert.deepEqual([...SOURCE_GROUPS], [
      'ats',
      'feeds',
      'aggregators',
      'search',
      'scraper',
      'dorking',
      'browser',
    ]);
  });

  it('claims every canonical source id exactly once (no drift, no gaps)', () => {
    const { members, ungrouped } = resolveSourceGroups();
    assert.deepEqual(ungrouped, []);
    const claimed = (
      Object.keys(members) as Array<keyof typeof members>
    ).flatMap((g) => members[g]);
    assert.deepEqual([...claimed].sort(), [...contract.sources].sort());
    assert.equal(new Set(claimed).size, contract.sources.length);
  });

  it('matches the backend SOURCE_ID_TO_GROUP table (T740:118-146)', () => {
    assert.deepEqual([...SOURCE_GROUP_MEMBERS.ats], [
      'greenhouse',
      'ashby',
      'lever',
      'smartrecruiters',
      'recruitee',
      'personio',
      'jobicy',
      'hnalgolia',
      'workable',
      'bamboohr',
      'breezyhr',
      'jobvite',
      'teamtailor',
      'pinpoint',
      'freshteam',
    ]);
    assert.deepEqual([...SOURCE_GROUP_MEMBERS.feeds], [
      'workday',
      'rss',
      'json',
      'career-page',
    ]);
    assert.deepEqual([...SOURCE_GROUP_MEMBERS.aggregators], [
      'adzuna',
      'usajobs',
      'reed',
      'findwork',
    ]);
    assert.deepEqual([...SOURCE_GROUP_MEMBERS.search], ['search']);
    assert.deepEqual([...SOURCE_GROUP_MEMBERS.dorking], ['dorking']);
    assert.deepEqual([...SOURCE_GROUP_MEMBERS.scraper], ['scraper']);
    assert.deepEqual([...SOURCE_GROUP_MEMBERS.browser], ['browser']);
  });

  it('keeps the browser group a one-member opt-in tier (N2)', () => {
    assert.equal(BROWSER_GROUP, 'browser');
    assert.deepEqual([...SOURCE_GROUP_MEMBERS.browser], ['browser']);
    assert.ok(SOURCE_GROUPS.includes('browser'));
  });
});

describe('sourceGroups - provider mapping rule', () => {
  it('maps api/feed/json/aggregator/scraper/browser kinds', () => {
    assert.equal(groupForContractProvider('api', 'greenhouse'), 'ats');
    assert.equal(groupForContractProvider('feed', 'rss'), 'feeds');
    assert.equal(groupForContractProvider('json', 'json'), 'feeds');
    assert.equal(groupForContractProvider('aggregator', 'aggregator'), 'aggregators');
    assert.equal(groupForContractProvider('scraper', 'scraper'), 'scraper');
    assert.equal(groupForContractProvider('browser', 'browser'), 'browser');
  });

  it('splits the search kind on provider type', () => {
    assert.equal(groupForContractProvider('search', 'search'), 'search');
    assert.equal(groupForContractProvider('search', 'dorking'), 'dorking');
  });

  it('returns null for an unknown kind (never silently mis-groups)', () => {
    assert.equal(groupForContractProvider('quantum', 'quantum'), null);
  });
});

describe('sourceGroups - toggle helpers', () => {
  const ats = [...SOURCE_GROUP_MEMBERS.ats];

  it('toggle on unions members, keeping order and appending in contract order', () => {
    assert.deepEqual(toggleSourceGroup([], ats, true), ats);
    assert.deepEqual(toggleSourceGroup(['search'], ats, true), ['search', ...ats]);
    assert.deepEqual(toggleSourceGroup(ats, ats, true), ats);
  });

  it('toggle off subtracts members only', () => {
    assert.deepEqual(toggleSourceGroup([...ats, 'search'], ats, false), ['search']);
    assert.deepEqual(toggleSourceGroup([], ats, false), []);
    assert.deepEqual(toggleSourceGroup(['search'], ats, false), ['search']);
  });

  it('selectedSourceGroups reports fully covered groups only', () => {
    assert.deepEqual(selectedSourceGroups([], SOURCE_GROUP_MEMBERS), []);
    assert.deepEqual(selectedSourceGroups(ats, SOURCE_GROUP_MEMBERS), ['ats']);
    assert.deepEqual(selectedSourceGroups([...ats, 'search'], SOURCE_GROUP_MEMBERS), [
      'ats',
      'search',
    ]);
    assert.deepEqual(
      selectedSourceGroups(ats.slice(1), SOURCE_GROUP_MEMBERS).includes('ats'),
      false,
    );
  });

  it('groupCheckState is false/true/indeterminate', () => {
    assert.equal(groupCheckState([], ats), false);
    assert.equal(groupCheckState(ats, ats), true);
    assert.equal(groupCheckState([ats[0] as string], ats), 'indeterminate');
    assert.equal(groupCheckState([], []), false);
  });

  it('cleanSourceGroups keeps known groups in contract order, deduped', () => {
    assert.deepEqual(cleanSourceGroups(['browser', 'ats', 'ats', 'nope']), [
      'ats',
      'browser',
    ]);
    assert.deepEqual(cleanSourceGroups(undefined), []);
  });
});
