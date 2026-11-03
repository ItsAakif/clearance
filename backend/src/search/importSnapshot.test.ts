// Catalogue snapshot import semantics: integrity first, then an idempotent
// upsert through the discovery path.

import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshotManifest,
  encodeSnapshotJsonl,
  gzipSnapshot,
  SnapshotError,
  type SnapshotManifest,
  type SnapshotRecord,
} from './snapshot.js';
import { importSnapshot, type ImportSnapshotDeps } from './importSnapshot.js';
import type { RawJob } from '../jobSources/index.js';

function record(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    id: 'row-1',
    canonicalKey: 'sha256-canonical-1',
    source: 'greenhouse',
    externalId: 'gh-1',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote - US',
    sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    postedAt: '2026-09-01T10:00:00.000Z',
    firstSeenAt: '2026-09-02T10:00:00.000Z',
    isActive: true,
    workMode: 'remote',
    seniority: 'senior',
    specialization: 'backend-engineer',
    skills: ['typescript'],
    salary: null,
    region: 'us',
    descriptionExcerpt: 'Excerpt only.',
    docVersion: '1',
    ...overrides,
  };
}

function snapshot(records: SnapshotRecord[]): { gzip: Buffer; manifest: SnapshotManifest } {
  const bytes = gzipSnapshot(encodeSnapshotJsonl(records));
  const manifest = buildSnapshotManifest({
    generatedAt: '2026-10-01T00:00:00.000Z',
    records,
    bytes,
  });
  return { gzip: bytes, manifest };
}

function deps(overrides: Partial<ImportSnapshotDeps> = {}): ImportSnapshotDeps {
  return {
    upsertJobs: vi.fn(async (jobs: RawJob[]) =>
      jobs.map((job) => ({ source: job.source, externalId: job.externalId ?? null })),
    ),
    loadInactiveKeys: vi.fn(async () => []),
    ...overrides,
  };
}

describe('importSnapshot integrity', () => {
  it('refuses a sha256 mismatch before calling the upsert path', async () => {
    const { gzip, manifest } = snapshot([record()]);
    const upsertJobs = vi.fn(async () => []);
    const input = {
      gzip,
      manifest: { ...manifest, sha256: '0'.repeat(64) },
    };
    await expect(
      importSnapshot(input, deps({ upsertJobs })),
    ).rejects.toMatchObject({ code: 'snapshot_sha_mismatch' });
    expect(upsertJobs).not.toHaveBeenCalled();
  });

  it('refuses a manifest whose count does not match the decoded lines', async () => {
    const { gzip, manifest } = snapshot([record()]);
    await expect(
      importSnapshot({ gzip, manifest: { ...manifest, count: 2 } }, deps()),
    ).rejects.toBeInstanceOf(SnapshotError);
  });
});

describe('importSnapshot rows', () => {
  it('dedupes duplicate (source, externalId) lines and counts them as skipped', async () => {
    const duplicate = record();
    const { gzip, manifest } = snapshot([duplicate, { ...duplicate, title: 'Duplicate title' }]);
    const upsertJobs = vi.fn(async (jobs: RawJob[]) => jobs.map((job) => ({ source: job.source, externalId: job.externalId })));

    const result = await importSnapshot({ gzip, manifest }, deps({ upsertJobs }));

    expect(upsertJobs).toHaveBeenCalledTimes(1);
    expect(upsertJobs.mock.calls[0][0]).toHaveLength(1);
    expect(result).toMatchObject({ imported: 1, skipped: 1, snapshotGeneratedAt: manifest.generatedAt });
  });

  it('counts a reappearing closed row as reactivated', async () => {
    const { gzip, manifest } = snapshot([record(), record({ id: 'row-2', externalId: 'gh-2' })]);
    const result = await importSnapshot(
      { gzip, manifest },
      deps({
        loadInactiveKeys: async () => [{ source: 'greenhouse', externalId: 'gh-1' }],
      }),
    );

    expect(result.imported).toBe(2);
    expect(result.reactivated).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('skips an unknown source without sending it to the upsert path', async () => {
    const { gzip, manifest } = snapshot([record({ source: 'linkedin', externalId: 'li-1' })]);
    const upsertJobs = vi.fn(async () => []);
    const result = await importSnapshot({ gzip, manifest }, deps({ upsertJobs }));

    expect(upsertJobs).not.toHaveBeenCalled();
    expect(result).toEqual({
      imported: 0,
      reactivated: 0,
      skipped: 1,
      snapshotGeneratedAt: manifest.generatedAt,
    });
  });

  it('never persists the excerpt as a full description and keeps the provenance key', async () => {
    const { gzip, manifest } = snapshot([record()]);
    const upsertJobs = vi.fn(async (jobs: RawJob[]) => jobs.map((job) => ({ source: job.source, externalId: job.externalId })));
    await importSnapshot({ gzip, manifest }, deps({ upsertJobs }));

    const [job] = upsertJobs.mock.calls[0][0] as unknown as Array<Record<string, unknown>>;
    expect(job.description).toBe('');
    expect(job.descriptionExcerpt).toBeUndefined();
    expect(job.canonicalKey).toBe('sha256-canonical-1');
    expect(job.postedAt).toEqual(new Date('2026-09-01T10:00:00.000Z'));
  });
});
