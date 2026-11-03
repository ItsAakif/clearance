// Unit tests for the pure admin display helpers (T861).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (provenanceLabel.test.ts).

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  RUN_TTL_MS,
  IMPORT_COMMAND,
  latencyLabel,
  absoluteLabel,
  relativeAge,
  timestampText,
  isRunExpired,
  countLabel,
  cooldownText,
} from './format';

const NOW = new Date('2026-09-22T12:00:00.000Z').getTime();
const isoAt = (ms: number): string => new Date(ms).toISOString();

describe('latencyLabel - unrun renders "-", never 0ms', () => {
  it('renders "-" for null (never ran)', () => {
    assert.equal(latencyLabel(null), '-');
  });

  it('renders "-" for undefined', () => {
    assert.equal(latencyLabel(undefined), '-');
  });

  it('renders a real measured zero as "0ms", distinct from "-"', () => {
    assert.equal(latencyLabel(0), '0ms');
    assert.notEqual(latencyLabel(0), latencyLabel(null));
  });

  it('renders measured latencies with the ms suffix', () => {
    assert.equal(latencyLabel(42), '42ms');
    assert.equal(latencyLabel(1500), '1500ms');
  });
});

describe('relativeAge - absolute-friendly buckets plus skew', () => {
  it('returns null for null/undefined/unparseable input', () => {
    assert.equal(relativeAge(null, NOW), null);
    assert.equal(relativeAge(undefined, NOW), null);
    assert.equal(relativeAge('not-a-date', NOW), null);
  });

  it('buckets seconds, minutes, hours and days', () => {
    assert.equal(relativeAge(isoAt(NOW - 5 * 1000), NOW), '5s ago');
    assert.equal(relativeAge(isoAt(NOW - 2 * 60 * 1000), NOW), '2m ago');
    assert.equal(relativeAge(isoAt(NOW - 3 * 60 * 60 * 1000), NOW), '3h ago');
    assert.equal(relativeAge(isoAt(NOW - 4 * 24 * 60 * 60 * 1000), NOW), '4d ago');
  });

  it('names clock skew instead of printing a negative age', () => {
    assert.equal(
      relativeAge(isoAt(NOW + 60 * 1000), NOW),
      'ahead of local clock (clock skew?)',
    );
  });
});

describe('timestampText - absolute and relative together', () => {
  it('returns null for null input', () => {
    assert.equal(timestampText(null, NOW), null);
  });

  it('combines the absolute label and the relative age', () => {
    const text = timestampText(isoAt(NOW - 2 * 60 * 1000), NOW);
    assert.ok(text !== null);
    assert.ok(text.includes('2m ago'), `expected relative age in "${text}"`);
    assert.ok(
      text.includes(absoluteLabel(isoAt(NOW - 2 * 60 * 1000)) as string),
      `expected absolute label in "${text}"`,
    );
  });

  it('falls back to the raw string when unparseable', () => {
    assert.equal(timestampText('not-a-date', NOW), 'not-a-date');
  });
});

describe('isRunExpired - in-memory bound rows get a refresh, not a spinner', () => {
  it('marks runs older than the TTL as expired', () => {
    assert.equal(isRunExpired(isoAt(NOW - RUN_TTL_MS - 1000), NOW), true);
  });

  it('keeps fresh runs live', () => {
    assert.equal(isRunExpired(isoAt(NOW - 60 * 1000), NOW), false);
  });

  it('treats the exact TTL boundary as still live', () => {
    assert.equal(isRunExpired(isoAt(NOW - RUN_TTL_MS), NOW), false);
  });

  it('never expires an unparseable timestamp (no false refresh)', () => {
    assert.equal(isRunExpired('not-a-date', NOW), false);
  });
});

describe('countLabel - "no data" is distinguishable from a real zero', () => {
  it('renders "no data" when nothing was measured', () => {
    assert.equal(countLabel(false, 0), 'no data');
  });

  it('renders a real zero as "0", distinct from "no data"', () => {
    assert.equal(countLabel(true, 0), '0');
    assert.notEqual(countLabel(true, 0), countLabel(false, 0));
  });

  it('renders measured counts as-is', () => {
    assert.equal(countLabel(true, 17), '17');
  });
});

describe('cooldownText - rate-limited keys show their expiry', () => {
  it('returns null when the key is not in cooldown', () => {
    assert.equal(cooldownText(null, NOW), null);
    assert.equal(cooldownText(undefined, NOW), null);
  });

  it('names the cooldown expiry with absolute and relative age', () => {
    const until = isoAt(NOW + 10 * 60 * 1000);
    const text = cooldownText(until, NOW);
    assert.ok(text !== null);
    assert.ok(text.startsWith('in cooldown until '));
    assert.ok(text.includes('clock skew'), `expected skew note in "${text}"`);
  });
});

describe('format - registry empty states name the import command', () => {
  it('exports an import command pointing at the wave-2 importer', () => {
    assert.ok(IMPORT_COMMAND.includes('import-company-registry'));
  });
});
