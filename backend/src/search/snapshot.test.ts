// Catalogue snapshot record/manifest contract.
//
// Pins the exported JSONL shape (identity + derived facets, NO full
// description), the gzip round-trip, and the manifest's count/sha256.

import { describe, expect, it } from 'vitest';
import { buildSearchDocument } from './document.js';
import {
  buildSnapshotManifest,
  buildSnapshotRecord,
  computeSha256,
  encodeSnapshotJsonl,
  gzipSnapshot,
  gunzipSnapshot,
  parseSnapshotJsonl,
  parseSnapshotManifest,
  SnapshotError,
  verifySnapshotBytes,
  verifySnapshotFile,
  type SnapshotRecord,
} from './snapshot.js';

const LONG_DESCRIPTION =
  `${'Useful job context. '.repeat(20)}TypeScript and AWS. ` +
  'FULL_DESCRIPTION_MARKER that must never travel in a snapshot.';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    canonicalKey: 'sha256-canonical-1',
    source: 'greenhouse',
    externalId: 'gh-1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote - US',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1?gh_jid=1',
    postedAt: new Date('2026-09-01T10:00:00.000Z'),
    firstSeenAt: new Date('2026-09-02T10:00:00.000Z'),
    isActive: true,
    description: LONG_DESCRIPTION,
    ...overrides,
  };
}

function record(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    ...buildSnapshotRecord(row()),
    ...overrides,
  };
}

describe('buildSnapshotRecord', () => {
  it('carries identity, display fields and every derived facet', () => {
    const built = buildSnapshotRecord(row());
    expect(built).toMatchObject({
      id: 'row-1',
      canonicalKey: 'sha256-canonical-1',
      source: 'greenhouse',
      externalId: 'gh-1',
      title: 'Senior Backend Engineer',
      company: 'Acme',
      location: 'Remote - US',
      sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/1?gh_jid=1',
      postedAt: '2026-09-01T10:00:00.000Z',
      firstSeenAt: '2026-09-02T10:00:00.000Z',
      isActive: true,
      workMode: 'remote',
      seniority: 'senior',
      specialization: 'backend-engineer',
      region: 'us',
    });
    expect(built.skills.length).toBeGreaterThan(0);
    expect(built.docVersion).toBe('1');
    expect(built.salary).toBeNull();
  });

  it('never reads the full description into the record', () => {
    const built = buildSnapshotRecord(row());
    expect('description' in built).toBe(false);
    expect(built.descriptionExcerpt.length).toBeLessThanOrEqual(280);
    expect(built.descriptionExcerpt).not.toContain('FULL_DESCRIPTION_MARKER');
  });

  it('prefers the stored searchDocument and derives one when it is absent', () => {
    const stored = {
      ...buildSearchDocument(row()),
      workMode: 'hybrid',
      descriptionExcerpt: 'Stored excerpt.',
      docVersion: '1',
    };
    const withStored = buildSnapshotRecord({ ...row(), searchDocument: stored });
    expect(withStored.workMode).toBe('hybrid');
    expect(withStored.descriptionExcerpt).toBe('Stored excerpt.');

    const derived = buildSnapshotRecord(row());
    expect(derived.descriptionExcerpt).not.toBe('Stored excerpt.');
    expect(derived.docVersion).toBe('1');
  });
});

describe('JSONL + gzip round-trip', () => {
  it('serializes one normalized record per line without the description', () => {
    const text = encodeSnapshotJsonl([record()]);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(text.trim());
    expect(Object.keys(parsed)).toEqual([
      'id',
      'canonicalKey',
      'source',
      'externalId',
      'title',
      'company',
      'location',
      'sourceUrl',
      'applyUrl',
      'postedAt',
      'firstSeenAt',
      'isActive',
      'workMode',
      'seniority',
      'specialization',
      'skills',
      'salary',
      'region',
      'descriptionExcerpt',
      'docVersion',
    ]);
    expect(text).not.toContain('"description":');
    expect(text).not.toContain('FULL_DESCRIPTION_MARKER');
  });

  it('round-trips through gzip byte-for-byte at the record level', () => {
    const records = [record(), record({ id: 'row-2', externalId: 'gh-2' })];
    const text = encodeSnapshotJsonl(records);
    const bytes = gzipSnapshot(text);
    expect(gunzipSnapshot(bytes)).toBe(text);
    expect(parseSnapshotJsonl(gunzipSnapshot(bytes)).records).toEqual(records);
  });

  it('rejects a malformed line with a snapshot_format_invalid error', () => {
    expect(() => parseSnapshotJsonl('{"id":"x"}\n')).toThrowError(SnapshotError);
    try {
      parseSnapshotJsonl('not json\n');
    } catch (error) {
      expect((error as SnapshotError).code).toBe('snapshot_format_invalid');
    }
  });
});

describe('manifest', () => {
  const records = [record(), record({ id: 'row-2', externalId: 'gh-2' })];
  const bytes = gzipSnapshot(encodeSnapshotJsonl(records));
  const manifest = buildSnapshotManifest({
    generatedAt: '2026-10-01T00:00:00.000Z',
    records,
    bytes,
  });

  it('records the line count, per-source counts and the gzip sha256', () => {
    expect(manifest).toMatchObject({
      version: 1,
      generatedAt: '2026-10-01T00:00:00.000Z',
      count: 2,
      sources: { greenhouse: 2 },
      filename: 'catalogue.jsonl.gz',
      minAppVersion: '1.0.0',
    });
    expect(manifest.sha256).toBe(computeSha256(bytes));
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies its own file (count == lines, sha matches)', () => {
    expect(verifySnapshotFile(manifest, bytes)).toEqual({ lines: 2 });
    expect(manifest.count).toBe(parseSnapshotJsonl(gunzipSnapshot(bytes)).lines);
  });

  it('refuses tampered bytes and an unsupported version', () => {
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => verifySnapshotBytes(manifest, tampered)).toThrowError(SnapshotError);
    try {
      verifySnapshotBytes(manifest, tampered);
    } catch (error) {
      expect((error as SnapshotError).code).toBe('snapshot_sha_mismatch');
    }

    try {
      verifySnapshotBytes({ ...manifest, version: 2 }, bytes);
    } catch (error) {
      expect((error as SnapshotError).code).toBe('snapshot_version_unsupported');
    }
  });

  it('parses a manifest written as JSON text and rejects a broken one', () => {
    expect(parseSnapshotManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(() => parseSnapshotManifest('{"version":1}')).toThrowError(SnapshotError);
  });
});
