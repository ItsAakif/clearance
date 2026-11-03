// Wave 3 (T665): persistence mapping + sources API shape.
// Pure tests (no DB): payload builders, legacy read rule, response shape,
// canonicalKey strongest-identity wiring.

import { describe, it, expect } from 'vitest';
import {
  coercePostedAtRaw,
  provenanceCreateData,
  provenanceUpdateData,
  resolvePostedAtSource,
  shapeListingResponse,
  type PersistableJob,
} from './persistence.js';
import {
  dedupeJobs,
  groupCanonicalKey,
  type SourceRef,
} from './dedupe.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

function persistable(overrides: Partial<PersistableJob> = {}): PersistableJob {
  return {
    source: 'greenhouse',
    sourceUrl: 'https://boards.greenhouse.io/testco/jobs/111',
    title: 'Backend Engineer',
    company: 'testco',
    location: 'Remote',
    description: 'Build things.',
    applyUrl: 'https://boards.greenhouse.io/testco/jobs/111',
    postedAt: new Date('2026-09-01T10:00:00.000Z'),
    postedAtSource: 'source-updated',
    postedAtRaw: '2026-09-01T10:00:00Z',
    dateConfidence: 'medium',
    canonicalKey: 'sha256-abc123',
    ...overrides,
  };
}

describe('provenance upsert payloads', () => {
  it('create writes all five columns with firstSeenAt === injected now', () => {
    const create = provenanceCreateData(persistable(), NOW);
    expect(create.postedAtSource).toBe('source-updated');
    expect(create.postedAtRaw).toBe('2026-09-01T10:00:00Z');
    expect(create.firstSeenAt).toBe(NOW);
    expect(create.dateConfidence).toBe('medium');
    expect(create.canonicalKey).toBe('sha256-abc123');
  });

  it('update writes four columns and never moves firstSeenAt', () => {
    const update = provenanceUpdateData(persistable());
    expect(update.postedAtSource).toBe('source-updated');
    expect(update.postedAtRaw).toBe('2026-09-01T10:00:00Z');
    expect(update.dateConfidence).toBe('medium');
    expect(update.canonicalKey).toBe('sha256-abc123');
    expect('firstSeenAt' in update).toBe(false);
  });

  it('missing extras persist as null, never fabricated', () => {
    const create = provenanceCreateData(persistable({
      postedAtSource: undefined,
      postedAtRaw: undefined,
      dateConfidence: undefined,
      canonicalKey: undefined,
    }), NOW);
    expect(create.postedAtSource).toBeNull();
    expect(create.postedAtRaw).toBeNull();
    expect(create.dateConfidence).toBeNull();
    expect(create.canonicalKey).toBeNull();
    expect(create.firstSeenAt).toBe(NOW);
  });
});

// T892 (live 2026-09-25): a full-scan batch died with
// `PrismaClientValidationError: Argument 'postedAtRaw': Invalid value
// provided. Expected String or Null, provided Int` because ONE discovered job
// carried a numeric upstream date (Lever's epoch `createdAt`) while the column
// is `String | null`. These two tests pin the choke-point coercion on BOTH
// payload builders: the batch no longer 500s, and the claim is stringified
// (kept verbatim as text) rather than dropped.
describe('T892: non-string postedAtRaw never reaches Prisma as a non-String', () => {
  // The runtime value violates the declared `string` type, which is exactly
  // the point: the cast reproduces what upstream JSON produced. The helper
  // must hold even when the static type is proven wrong.
  const numericRawJob = (postedAtRaw: number): PersistableJob =>
    ({ ...persistable(), postedAtRaw } as unknown as PersistableJob);

  it('create stringifies an Int postedAtRaw and leaves the rest of the five columns alone', () => {
    const create = provenanceCreateData(numericRawJob(1781037166218), NOW);
    expect(create.postedAtRaw).toBe('1781037166218');
    expect(typeof create.postedAtRaw).toBe('string');
    // The other four wave-3 columns are untouched by the coercion.
    expect(create.postedAtSource).toBe('source-updated');
    expect(create.firstSeenAt).toBe(NOW);
    expect(create.dateConfidence).toBe('medium');
    expect(create.canonicalKey).toBe('sha256-abc123');
  });

  it('update stringifies an Int postedAtRaw and still never moves firstSeenAt', () => {
    const update = provenanceUpdateData(numericRawJob(1781037166218));
    expect(update.postedAtRaw).toBe('1781037166218');
    expect(typeof update.postedAtRaw).toBe('string');
    expect(update.postedAtSource).toBe('source-updated');
    expect(update.dateConfidence).toBe('medium');
    expect(update.canonicalKey).toBe('sha256-abc123');
    expect('firstSeenAt' in update).toBe(false);
  });

  it('coercePostedAtRaw: strings byte-identical, missing stays null, other JSON scalars stringify', () => {
    // Byte-identical for the normal case (no trim, no normalisation, no '' -> null).
    expect(coercePostedAtRaw('2026-09-01T10:00:00Z')).toBe('2026-09-01T10:00:00Z');
    expect(coercePostedAtRaw('')).toBe('');
    expect(coercePostedAtRaw('  padded  ')).toBe('  padded  ');
    // A missing claim stays missing - never the text "undefined"/"null".
    expect(coercePostedAtRaw(null)).toBeNull();
    expect(coercePostedAtRaw(undefined)).toBeNull();
    // Non-string JSON scalars are stringified, never dropped.
    expect(coercePostedAtRaw(1781037166218)).toBe('1781037166218');
    expect(coercePostedAtRaw(0)).toBe('0');
    expect(coercePostedAtRaw(1700000000)).toBe('1700000000');
    expect(coercePostedAtRaw(true)).toBe('true');
  });

  it('a string input is unchanged end to end (no reformatting of the claim)', () => {
    const create = provenanceCreateData(persistable(), NOW);
    const update = provenanceUpdateData(persistable());
    expect(create.postedAtRaw).toBe('2026-09-01T10:00:00Z');
    expect(update.postedAtRaw).toBe('2026-09-01T10:00:00Z');
  });
});

describe('legacy read rule (pre-migration rows)', () => {
  it('a stored source passes through', () => {
    expect(resolvePostedAtSource({ postedAtSource: 'source-posted' })).toBe('source-posted');
    expect(resolvePostedAtSource({ postedAtSource: 'index-date' })).toBe('index-date');
  });

  it('null source reads as unknown (even with a stored date)', () => {
    expect(resolvePostedAtSource({ postedAtSource: null })).toBe('unknown');
    expect(resolvePostedAtSource({})).toBe('unknown');
  });

  it('an unrecognised stored value reads as unknown', () => {
    expect(resolvePostedAtSource({ postedAtSource: 'source-posted-typo' })).toBe('unknown');
  });

  it('a legacy row keeps its stored date and is labelled Found, never Posted', () => {
    const storedAt = new Date('2026-06-15T08:00:00.000Z');
    const out = shapeListingResponse({
      id: 'legacy-1',
      source: 'greenhouse',
      title: 'Backend Engineer',
      company: 'testco',
      location: 'Remote',
      applyUrl: 'https://boards.greenhouse.io/testco/jobs/111',
      sourceUrl: 'https://boards.greenhouse.io/testco/jobs/111',
      postedAt: storedAt,
      isActive: true,
      postedAtSource: null,
    });
    // No data destruction: the stored date is returned verbatim.
    expect(out.postedAt).toBe(storedAt);
    // ...but it must not claim source-posted.
    expect(out.postedAtSource).toBe('unknown');
    expect(out.dateLabel).toBe('Found');
  });
});

describe('listing response shape (additive)', () => {
  const row = {
    id: 'row-1',
    source: 'greenhouse',
    title: 'Backend Engineer',
    company: 'testco',
    location: 'Remote',
    applyUrl: 'https://boards.greenhouse.io/testco/jobs/111',
    sourceUrl: 'https://boards.greenhouse.io/testco/jobs/111',
    postedAt: new Date('2026-09-01T10:00:00.000Z'),
    isActive: true,
    postedAtSource: 'source-posted' as const,
  };

  it('pre-existing fields are unchanged', () => {
    const out = shapeListingResponse(row, { sources: undefined });
    expect(out.id).toBe(row.id);
    expect(out.source).toBe(row.source);
    expect(out.title).toBe(row.title);
    expect(out.company).toBe(row.company);
    expect(out.location).toBe(row.location);
    expect(out.applyUrl).toBe(row.applyUrl);
    expect(out.postedUrl).toBe(row.sourceUrl);
    expect(out.postedAt).toBe(row.postedAt);
    expect(out.isActive).toBe(row.isActive);
  });

  it('exposes postedAtSource and the derived dateLabel', () => {
    expect(shapeListingResponse(row).postedAtSource).toBe('source-posted');
    expect(shapeListingResponse(row).dateLabel).toBe('Posted');
    expect(shapeListingResponse({ ...row, postedAtSource: 'source-updated' }).dateLabel).toBe('Updated');
    expect(shapeListingResponse({ ...row, postedAtSource: 'discovery-at' }).dateLabel).toBe('Found');
  });

  it('sources is present when known, omitted when not', () => {
    const sources: SourceRef[] = [
      { source: 'greenhouse', sourceUrl: row.sourceUrl, applyUrl: row.applyUrl, externalId: 'gh-111' },
      { source: 'ashby', sourceUrl: 'https://ashby.testco/jobs/9', externalId: 'ash-9' },
    ];
    const withSources = shapeListingResponse(row, { sources });
    expect(withSources.sources).toEqual(sources);
    expect('sources' in shapeListingResponse(row, { sources: [] })).toBe(false);
    expect('sources' in shapeListingResponse(row)).toBe(false);
    expect('sources' in shapeListingResponse(row, { sources: null })).toBe(false);
  });
});

describe('canonicalKey strongest-identity wiring', () => {
  // One real posting seen on three sources via the same canonical URL (T1).
  const threeSources = [
    persistable({ source: 'greenhouse', externalId: 'gh-111' }),
    persistable({
      source: 'ashby',
      externalId: 'ash-9',
      sourceUrl: 'https://ashby.testco/jobs/9',
      description: 'Build things. Longer copy from the Ashby board with more detail.',
    }),
    persistable({
      source: 'lever',
      externalId: 'lev-3',
      sourceUrl: 'https://lever.testco/jobs/3',
      title: 'Backend Engineer (Remote)',
    }),
  ];

  it('three sources dedupe to one survivor whose canonicalKey is the group T1 identity', () => {
    const survivors = dedupeJobs(threeSources);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].sources).toHaveLength(3);
    // Strongest identity present is T1 (shared canonical URL).
    expect(survivors[0].canonicalKey).toBe(groupCanonicalKey(threeSources));
    // ...and the upsert create payload carries exactly that key.
    const create = provenanceCreateData(survivors[0] as PersistableJob, NOW);
    expect(create.canonicalKey).toBe(survivors[0].canonicalKey);
  });

  it('canonicalKey is stable across re-runs regardless of input order', () => {
    const forward = dedupeJobs(threeSources);
    const reversed = dedupeJobs([...threeSources].reverse());
    expect(forward[0].canonicalKey).toBe(reversed[0].canonicalKey);
  });
});
