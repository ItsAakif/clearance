// Unit tests for the pure provenance helpers (T800).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (ProfileMatch.test.ts).
//
// Label rule mirrored from `dateLabel` in
// `backend/src/discovery/provenance.ts` (T661), lines 160-170, with the one
// documented frontend divergence: `unknown` renders NO label (null).

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../../../shared/job-sources.json';
import { dateLabelFor, sourceBadges } from './provenanceLabel';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('dateLabelFor - all six provenance classes', () => {
  it("labels source-posted rows 'Posted'", () => {
    assert.equal(dateLabelFor({ postedAtSource: 'source-posted' }), 'Posted');
  });

  it("labels page-derived rows 'Posted'", () => {
    assert.equal(dateLabelFor({ postedAtSource: 'page-derived' }), 'Posted');
  });

  it("labels source-updated rows 'Updated'", () => {
    assert.equal(dateLabelFor({ postedAtSource: 'source-updated' }), 'Updated');
  });

  it("labels discovery-at rows 'Found'", () => {
    assert.equal(dateLabelFor({ postedAtSource: 'discovery-at' }), 'Found');
  });

  it("labels index-date rows 'Found' - NEVER 'Posted' (N4 null invariant)", () => {
    const label = dateLabelFor({ postedAtSource: 'index-date' });
    assert.equal(label, 'Found');
    assert.notEqual(label, 'Posted');
  });

  it('returns null (no label) for unknown - NEVER Posted', () => {
    const label = dateLabelFor({ postedAtSource: 'unknown' });
    assert.equal(label, null);
    assert.notEqual(label, 'Posted');
  });

  it('returns null for a missing or unrecognised source', () => {
    assert.equal(dateLabelFor({ postedAtSource: undefined }), null);
    assert.equal(dateLabelFor({ postedAtSource: null }), null);
    assert.equal(dateLabelFor({ postedAtSource: 'no-such-class' }), null);
  });
});

describe('sourceBadges - dedupe and deterministic order', () => {
  it('falls back to the single source when sources[] is absent', () => {
    assert.deepEqual(sourceBadges({ source: 'rss' }), ['rss']);
  });

  it('falls back when sources[] is empty', () => {
    assert.deepEqual(sourceBadges({ source: 'rss', sources: [] }), ['rss']);
  });

  it('dedupes exact duplicates', () => {
    assert.deepEqual(
      sourceBadges({ source: 'rss', sources: ['rss', 'rss', 'json'] }),
      ['rss', 'json'],
    );
  });

  it('dedupes case-insensitively, keeping first-seen casing', () => {
    // sources[] is read before the row's own source, so first-seen wins.
    assert.deepEqual(sourceBadges({ source: 'rss', sources: ['RSS'] }), ['RSS']);
    assert.deepEqual(sourceBadges({ source: 'RSS', sources: ['rss'] }), ['rss']);
  });

  it('orders by the generated contract, whatever the input order', () => {
    const ids = [...contract.sources].reverse();
    const badges = sourceBadges({ source: ids[0], sources: ids });
    assert.deepEqual(badges, contract.sources);
  });

  it('reads object entries and unions a missing row source (N11)', () => {
    const badges = sourceBadges({
      source: 'json',
      sources: [{ source: 'rss' }, 'rss', { source: '  ' }],
    });
    assert.deepEqual(badges, ['rss', 'json']);
  });

  it('appends ids outside the contract in first-seen order, dropping blanks', () => {
    const badges = sourceBadges({
      source: 'rss',
      sources: ['zz-custom', '', '  ', 'rss', 'yy-other', 'zz-custom'],
    });
    assert.deepEqual(badges, ['rss', 'zz-custom', 'yy-other']);
  });
});

describe('provenanceLabel - vocabulary comes from the generated contract', () => {
  it('helper imports the contract for ordering', () => {
    const text = readFileSync(path.join(HERE, 'provenanceLabel.ts'), 'utf8');
    assert.ok(text.includes('shared/job-sources.json'));
  });

  it('helper keeps no hand-listed source ids', () => {
    const text = readFileSync(path.join(HERE, 'provenanceLabel.ts'), 'utf8');
    for (const id of contract.sources as string[]) {
      assert.ok(!text.includes(`'${id}'`), `helper must not contain '${id}'`);
    }
  });
});
