// Frontend parity for the generated source contract (T625, ADR-031).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (ProfileMatch.test.ts).

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../../../shared/job-sources.json';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const JOBS_TSX = path.join(ROOT, 'src', 'pages', 'Jobs.tsx');
const JOBS_API_TS = path.join(ROOT, 'src', 'services', 'api', 'jobs.ts');

// The source ids the UI expects: the values the source filter
// renders (same values, same order as the generated contract).
// (Wave 5, T702: grown additively by dorking; Wave 6, T724: grown
// additively by browser - existing ids keep their positions.)
const EXPECTED_SOURCES = [
  'greenhouse', 'ashby', 'lever', 'workday', 'rss', 'json',
  'smartrecruiters', 'recruitee', 'personio', 'jobicy', 'hnalgolia',
  'adzuna', 'usajobs', 'reed', 'findwork', 'workable', 'bamboohr',
  'breezyhr', 'jobvite', 'teamtailor', 'pinpoint', 'freshteam',
  'career-page', 'search', 'scraper', 'dorking', 'browser',
];

// The board types the UI expects: the generated JobBoardType union
// members, in contract order.
const EXPECTED_BOARD_TYPES = [
  'greenhouse', 'ashby', 'lever', 'workday', 'rss', 'json', 'search',
  'smartrecruiters', 'recruitee', 'personio', 'jobicy', 'hnalgolia',
  'scraper', 'aggregator', 'workable', 'bamboohr', 'breezyhr',
  'jobvite', 'teamtailor', 'pinpoint', 'freshteam', 'career-page',
  'dorking', 'browser',
];

describe('generated source contract parity (T625)', () => {
  it('contract source ids match the ids the UI expects (27 sources)', () => {
    assert.equal(contract.sources.length, EXPECTED_SOURCES.length);
    assert.deepEqual(contract.sources, EXPECTED_SOURCES);
  });

  it('contract board types match the board types the UI expects (24 board types)', () => {
    assert.equal(contract.boardTypes.length, EXPECTED_BOARD_TYPES.length);
    assert.deepEqual(contract.boardTypes, EXPECTED_BOARD_TYPES);
  });

  it('Jobs.tsx consumes the contract and keeps no local source list', () => {
    const text = readFileSync(JOBS_TSX, 'utf8');
    // Positive: the page imports the generated contract and passes it to
    // the filter (both desktop and mobile call sites).
    assert.ok(text.includes('shared/job-sources.json'));
    assert.ok(text.includes('jobSourcesContract.sources'));
    // Negative: the hand-maintained `SOURCES` const is gone and no
    // source-id literal remains to drift.
    assert.ok(!text.includes('const SOURCES'));
    assert.ok(!text.includes("'greenhouse'"));
    assert.ok(!/\[\s*'greenhouse'/.test(text));
  });

  it('services/api/jobs.ts derives JobBoardType and keeps no hand list', () => {
    const text = readFileSync(JOBS_API_TS, 'utf8');
    // Positive: the module imports the generated contract and derives the
    // board type from its board-type list.
    assert.ok(text.includes('shared/job-sources.json'));
    assert.ok(text.includes('(typeof sourceContract.boardTypes)[number]'));
    assert.ok(text.includes('export type JobBoardType'));
    // Negative: the hand-listed union is gone and no board-type literal
    // remains to drift.
    assert.ok(!text.includes("| 'greenhouse'"));
    assert.ok(!text.includes("'greenhouse'"));
  });
});
