// Wave 3 (T665): upsert persistence mapping at the route layer (mocked DB).
// - an upsert writes all five provenance columns;
// - a second upsert does not move firstSeenAt;
// - the survivor's sources array rides the returned record to the API.
// T892: the unusable-row boundary guard at the same choke point
// (`prepareRowForPersist`), including the negative control that shows the
// pre-guard payload is what Prisma rejects with `Argument 'sourceUrl' is
// missing.`

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    jobListing: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

import { upsertDiscoveredJobs, prepareRowForPersist } from './jobs.js';
import type { RawJob } from '../jobSources/index.js';

const NOW_CREATE = new Date('2026-09-20T12:00:00.000Z');
const NOW_REDISCOVER = new Date('2026-09-21T12:00:00.000Z');

const discovered = {
  externalId: 'gh-111',
  source: 'greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/testco/jobs/111',
  title: 'Backend Engineer',
  company: 'testco',
  location: 'Remote',
  description: 'Build things.',
  applyUrl: 'https://boards.greenhouse.io/testco/jobs/111',
  postedAt: new Date('2026-09-01T10:00:00.000Z'),
  postedAtSource: 'source-updated' as const,
  postedAtRaw: '2026-09-01T10:00:00Z',
  canonicalKey: 'sha256-group-identity',
  sources: [
    {
      source: 'greenhouse',
      sourceUrl: 'https://boards.greenhouse.io/testco/jobs/111',
      applyUrl: 'https://boards.greenhouse.io/testco/jobs/111',
      externalId: 'gh-111',
    },
    { source: 'ashby', sourceUrl: 'https://ashby.testco/jobs/9', externalId: 'ash-9' },
  ],
};

describe('upsertDiscoveredJobs provenance persistence', () => {
  beforeEach(() => {
    prismaMocks.jobListing.findUnique.mockReset();
    prismaMocks.jobListing.upsert.mockReset();
    prismaMocks.jobListing.findUnique.mockResolvedValue(null);
  });

  it('writes all five provenance columns on create with the injected now', async () => {
    prismaMocks.jobListing.upsert.mockImplementation(async (args: any) => ({
      id: 'id-1',
      ...args.create,
    }));
    const [rec] = await upsertDiscoveredJobs([discovered], NOW_CREATE);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    expect(args.create.postedAtSource).toBe('source-updated');
    expect(args.create.postedAtRaw).toBe('2026-09-01T10:00:00Z');
    expect(args.create.firstSeenAt).toBe(NOW_CREATE);
    expect(args.create.dateConfidence).toBeNull();
    expect(args.create.canonicalKey).toBe('sha256-group-identity');
    expect(rec.firstSeenAt).toBe(NOW_CREATE);
  });

  it('a second upsert does not move firstSeenAt', async () => {
    // Fake DB: create stores the row; update merges over it the way Prisma
    // would (keys absent from `update` keep their stored values).
    const stored: Record<string, any> = {};
    prismaMocks.jobListing.upsert.mockImplementation(async (args: any) => {
      const key = `${args.where.source_externalId.source}||${args.where.source_externalId.externalId}`;
      if (!stored[key]) {
        stored[key] = { id: 'id-1', ...args.create };
      } else {
        stored[key] = { ...stored[key], ...args.update };
      }
      return stored[key];
    });

    const [first] = await upsertDiscoveredJobs([discovered], NOW_CREATE);
    expect(first.firstSeenAt).toBe(NOW_CREATE);

    const [second] = await upsertDiscoveredJobs([discovered], NOW_REDISCOVER);
    const updateArgs = prismaMocks.jobListing.upsert.mock.calls[1][0];
    expect('firstSeenAt' in updateArgs.update).toBe(false);
    expect(second.firstSeenAt).toBe(NOW_CREATE);
    expect(second.firstSeenAt).not.toBe(NOW_REDISCOVER);
  });

  it('carries the survivor sources array on the returned record for the API', async () => {
    prismaMocks.jobListing.upsert.mockImplementation(async (args: any) => ({
      id: 'id-1',
      ...args.create,
    }));
    const [rec] = await upsertDiscoveredJobs([discovered], NOW_CREATE);
    expect(rec.sources).toHaveLength(2);
    expect(rec.sources?.[0]).toMatchObject({ source: 'greenhouse', externalId: 'gh-111' });
    expect(rec.sources?.[1]).toMatchObject({ source: 'ashby', externalId: 'ash-9' });
  });
});

// A soft-closed row (`isActive: false`) that reappears must come back. This is
// the update-branch half of the snapshot import's reactivation semantics, and
// it also closes the older gap where plain re-discovery updated the row but
// left it invisible.
describe('upsertDiscoveredJobs reactivation', () => {
  it('reactivates a closed row when the same listing reappears', async () => {
    prismaMocks.jobListing.findUnique.mockResolvedValue({
      description: 'Stored full description',
      isActive: false,
    });
    prismaMocks.jobListing.upsert.mockImplementation(async (args: any) => ({
      id: 'id-1',
      isActive: true,
      ...args.update,
    }));

    const [rec] = await upsertDiscoveredJobs([discovered], NOW_REDISCOVER);

    const updateArgs = prismaMocks.jobListing.upsert.mock.calls[0][0].update;
    expect(updateArgs.isActive).toBe(true);
    expect(rec.isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T892 (live 2026-09-25, find #3): `PrismaClientValidationError: Argument
// 'sourceUrl' is missing.` in `prisma.jobListing.upsert()` <- `upsertDiscoveredJobs`
// <- `fullScanHandler`. The old `/scan` `limit` slice (always 30) masked the
// rows; Full now persists every matched row, so several adapters' unguarded
// upstream passthroughs (`j.absolute_url`, `j.jobUrl || j.applyUrl`, `j.url`,
// `j.link`, ...) surfaced the type lie as `undefined` at runtime.
//
// The Prisma stand-in below reproduces the real client's create-input
// validation: the non-null `JobListing` columns must be present, otherwise the
// real client throws `Argument '<field>' is missing.` and the whole batch 500s.
// ---------------------------------------------------------------------------

/** The non-null String columns `model JobListing` requires on create. */
const NON_NULL_STRING_COLUMNS = ['source', 'sourceUrl', 'title', 'company', 'description'] as const;

function prismaValidationError(column: string): Error {
  return new Error(
    `Invalid \`prisma.jobListing.upsert()\` invocation:\n\nArgument \`${column}\` is missing.`,
  );
}

/**
 * A stand-in for the real Prisma client's create-input validation. Throws the
 * exact live error class when a required non-null column is absent, so a
 * regression that lets `undefined` reach the create payload fails here.
 */
function prismaLikeUpsert() {
  return vi.fn(async (args: any) => {
    for (const column of NON_NULL_STRING_COLUMNS) {
      if (typeof args.create[column] !== 'string') throw prismaValidationError(column);
    }
    return { id: 'id-1', ...args.create };
  });
}

/** A well-formed row, minus whatever the test wants missing. */
function rawJob(overrides: Partial<RawJob> = {}): RawJob {
  return {
    externalId: 'gh-900',
    source: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/testco/jobs/900',
    title: 'Platform Engineer',
    company: 'testco',
    location: 'Remote',
    description: 'Build things.',
    applyUrl: 'https://boards.greenhouse.io/testco/jobs/900',
    ...overrides,
  } as RawJob;
}

/** The runtime shape an adapter really produces when upstream omits a field. */
function withRuntimeMissing(
  fields: Array<'sourceUrl' | 'applyUrl' | 'title' | 'company' | 'source'>,
  overrides: Partial<RawJob> = {},
): RawJob {
  const job = rawJob(overrides) as unknown as Record<string, unknown>;
  for (const field of fields) delete job[field];
  return job as unknown as RawJob;
}

describe('T892: unusable discovered rows never reach Prisma as a missing argument', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prismaMocks.jobListing.findUnique.mockReset();
    prismaMocks.jobListing.upsert.mockReset();
    prismaMocks.jobListing.findUnique.mockResolvedValue(null);
    prismaMocks.jobListing.upsert.mockImplementation(prismaLikeUpsert());
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // (a) Fallback first: a blank sourceUrl borrows a non-blank applyUrl.
  it('persists sourceUrl=applyUrl when upstream omitted sourceUrl', async () => {
    const job = withRuntimeMissing(['sourceUrl']);
    const recs = await upsertDiscoveredJobs([job], NOW_CREATE);
    expect(recs).toHaveLength(1);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    expect(args.create.sourceUrl).toBe('https://boards.greenhouse.io/testco/jobs/900');
    // applyUrl itself is untouched: the fallback never rewrites another column.
    expect(args.create.applyUrl).toBe('https://boards.greenhouse.io/testco/jobs/900');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a blank-string sourceUrl also falls back to applyUrl', async () => {
    const job = rawJob({ sourceUrl: '   ' });
    await upsertDiscoveredJobs([job], NOW_CREATE);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    expect(args.create.sourceUrl).toBe('https://boards.greenhouse.io/testco/jobs/900');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a non-blank sourceUrl is never overwritten by applyUrl', async () => {
    await upsertDiscoveredJobs([rawJob()], NOW_CREATE);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    expect(args.create.sourceUrl).toBe('https://boards.greenhouse.io/testco/jobs/900');
    expect(args.update.sourceUrl).toBe('https://boards.greenhouse.io/testco/jobs/900');
  });

  // (b) Drop: no usable link at all.
  it('drops a row with neither sourceUrl nor applyUrl and excludes it from the return', async () => {
    const recs = await upsertDiscoveredJobs([withRuntimeMissing(['sourceUrl', 'applyUrl'])], NOW_CREATE);
    expect(recs).toEqual([]);
    expect(prismaMocks.jobListing.upsert).not.toHaveBeenCalled();
    expect(prismaMocks.jobListing.findUnique).not.toHaveBeenCalled();
  });

  // (c) Drop: a blank title or company is as unusable as a missing one.
  it('drops a row whose title sanitizes to blank', async () => {
    const recs = await upsertDiscoveredJobs([rawJob({ title: '\u0000\u0007' })], NOW_CREATE);
    expect(recs).toEqual([]);
    expect(prismaMocks.jobListing.upsert).not.toHaveBeenCalled();
  });

  it('drops a row with a missing title and a missing company', async () => {
    expect(await upsertDiscoveredJobs([withRuntimeMissing(['title'])], NOW_CREATE)).toEqual([]);
    prismaMocks.jobListing.upsert.mockClear();
    expect(await upsertDiscoveredJobs([withRuntimeMissing(['company'])], NOW_CREATE)).toEqual([]);
    expect(prismaMocks.jobListing.upsert).not.toHaveBeenCalled();
  });

  it('drops a row with a missing source (a required non-null column)', async () => {
    expect(await upsertDiscoveredJobs([withRuntimeMissing(['source'])], NOW_CREATE)).toEqual([]);
    expect(prismaMocks.jobListing.upsert).not.toHaveBeenCalled();
  });

  // Return value stays "rows actually persisted": a good row alongside a bad one.
  it('persists the usable rows and counts only those in the return', async () => {
    const recs = await upsertDiscoveredJobs(
      [
        withRuntimeMissing(['sourceUrl', 'applyUrl']),
        rawJob(),
        rawJob({ title: '' }),
        rawJob({ externalId: 'gh-901', sourceUrl: 'https://boards.greenhouse.io/testco/jobs/901', applyUrl: 'https://boards.greenhouse.io/testco/jobs/901' }),
      ],
      NOW_CREATE,
    );
    expect(recs).toHaveLength(2);
    expect(recs.map((rec) => rec.externalId)).toEqual(['gh-900', 'gh-901']);
    expect(prismaMocks.jobListing.upsert).toHaveBeenCalledTimes(2);
  });

  // The log line the live test greps for, exactly once per run.
  it('reports drops once per run on a greppable [persist-skip] line with no urls or descriptions', async () => {
    await upsertDiscoveredJobs(
      [
        withRuntimeMissing(['sourceUrl', 'applyUrl']),
        rawJob({ title: '' }),
        rawJob(),
      ],
      NOW_CREATE,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, payload] = warnSpy.mock.calls[0];
    expect(message).toContain('[persist-skip]');
    expect(payload).toMatchObject({ dropped: 2, sampled: 2 });
    expect(payload.rows).toEqual([
      { source: 'greenhouse', externalId: 'gh-900', title: 'Platform Engineer', missing: 'sourceUrl' },
      { source: 'greenhouse', externalId: 'gh-900', title: '', missing: 'title' },
    ]);
    // Never the description, never a URL, never a credential.
    const serialized = JSON.stringify(warnSpy.mock.calls[0]);
    expect(serialized).not.toContain('boards.greenhouse.io');
    expect(serialized).not.toContain('Build things.');
  });

  it('caps the [persist-skip] sample so one run cannot flood the logs', async () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      withRuntimeMissing(['sourceUrl', 'applyUrl', 'title'], { externalId: `drop-${index}` }),
    );
    await upsertDiscoveredJobs(rows, NOW_CREATE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = warnSpy.mock.calls[0][1] as { dropped: number; sampled: number };
    expect(payload.dropped).toBe(40);
    expect(payload.sampled).toBe(20);
  });

  // (d) Well-formed rows are byte-identical: the pre-existing suites above
  // already assert that, and this pins the fallback's non-effect explicitly.
  it('leaves a well-formed row byte-identical to the pre-guard payload', async () => {
    const job = rawJob();
    await upsertDiscoveredJobs([job], NOW_CREATE);
    const args = prismaMocks.jobListing.upsert.mock.calls[0][0];
    for (const key of NON_NULL_STRING_COLUMNS) {
      expect(args.create[key]).toBe(job[key]);
    }
    expect(args.create.location).toBe('Remote');
    expect(args.create.firstSeenAt).toBe(NOW_CREATE);
  });

  it('does not change the deterministic externalId when the fallback applies', async () => {
    // The fallback must not fork row identity: `buildCanonical` already prefers
    // applyUrl over sourceUrl, so a row that only carried applyUrl hashes to
    // the same id with or without the fallback.
    const { jobExternalId } = await import('../jobSources/jobIdentity.js');
    // No adapter-supplied externalId, so the deterministic hash is what is used.
    const withSourceUrl = { ...rawJob(), externalId: undefined };
    const withoutSourceUrl = withRuntimeMissing(['sourceUrl'], { externalId: undefined });
    expect(jobExternalId(withSourceUrl)).toBe(jobExternalId(withoutSourceUrl));

    const preparedWith = prepareRowForPersist(withSourceUrl);
    const preparedWithout = prepareRowForPersist(withoutSourceUrl);
    expect('row' in preparedWith).toBe(true);
    expect('row' in preparedWithout).toBe(true);
    // Dedupe, re-discovery and the @@unique([source, externalId]) key are
    // therefore unaffected by the fallback.
    expect('row' in preparedWithout && preparedWithout.row.externalId).toBe(
      'row' in preparedWith && preparedWith.row.externalId,
    );
  });
});

describe('T892: the pre-guard payload is exactly what Prisma rejects (negative control)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prismaMocks.jobListing.findUnique.mockReset();
    prismaMocks.jobListing.upsert.mockReset();
    prismaMocks.jobListing.findUnique.mockResolvedValue(null);
    prismaMocks.jobListing.upsert.mockImplementation(prismaLikeUpsert());
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('reproduces the live 500 for an unguarded row, and shows the guard is what prevents it', async () => {
    const job = withRuntimeMissing(['sourceUrl']);

    // (1) The pre-guard payload: the raw row handed straight to the upsert,
    //     which is what `const withId = withDeterministicExternalId(job)`
    //     produced before the fix. `sanitizeRawJob` does not touch `sourceUrl`,
    //     so the key stays absent and the real client throws.
    const preGuard = { source: job.source, externalId: job.externalId, title: job.title, company: job.company, description: job.description };
    await expect(prismaMocks.jobListing.upsert({ create: preGuard })).rejects.toThrow(
      /Argument `sourceUrl` is missing\./,
    );

    // (2) The post-guard payload: the same row after the boundary rule fills
    //     sourceUrl from applyUrl. Identical input, no throw.
    await expect(upsertDiscoveredJobs([job], NOW_CREATE)).resolves.toHaveLength(1);

    // (3) A row with no link at all is dropped before the upsert is ever called,
    //     so `undefined` can no longer reach the create input for it either.
    prismaMocks.jobListing.upsert.mockClear();
    await expect(upsertDiscoveredJobs([withRuntimeMissing(['sourceUrl', 'applyUrl'])], NOW_CREATE)).resolves.toEqual([]);
    expect(prismaMocks.jobListing.upsert).not.toHaveBeenCalled();
  });
});
