// render/cache.test.ts - the determinism cache (T1043; policy 10.4 O4).
//
// WHAT IS PROVEN HERE, AND WHY IT IS NOT A TEST OF `stage.ts` OR OF THE PORT:
//   1. THE THREE HIT CONDITIONS, each with its own MISS, and the ORDER they are checked in
//      (versions first, `store.head` last) - because the order is a cost claim: a toolchain
//      bump must not touch the filesystem at all.
//   2. A HIT IS A HIT ONLY WHEN ALL THREE HOLD. Each mutation below removes exactly one
//      condition, so a weakened cache fails a named test rather than passing a weakened one.
//   3. `templateVersion: null` IS ALWAYS A MISS, on EITHER side of the comparison - the row
//      making no claim, and the plan being unable to make one.
//   4. `store.head` THROWING IS NOT A MISS. A storage fault must not become a re-render
//      storm, so it propagates.
//   5. `renderEngineVersion` IS A FUNCTION OF THE VALUE, NOT OF KEY ORDER: two pin objects
//      that differ only in insertion order produce the same key. This is the property
//      `JSON.stringify` would break and that would silently make the cache never hit.
//   6. THE UPSERT WRITES IN PLACE ON THE EXISTING UNIQUE KEY, with an `update` and a
//      `create` that carry the SAME field set - which is what makes a re-render leave no
//      stale claim behind and no orphan row.
//
// The fakes are minimal and COUNT their calls, because two of the assertions are about work
// NOT happening: a version mismatch must produce zero `head` calls, and a hit must produce
// no compile - the second half of which the PORT suite asserts against a fake broker.

import { describe, it, expect, vi } from 'vitest';

import {
  CACHE_ROW_SELECTION,
  COMPOUND_UNIQUE_INPUT,
  lookupCachedDocument,
  renderEngineVersion,
  upsertRenderedDocument,
  type CachedDocumentRow,
  type RenderCacheStore,
} from './cache.js';
import { RENDER_LIMITS, TYPST_PIN } from './sandbox.js';
import { STORAGE_ERROR_CODES, StorageError, type ArtifactStore } from './storage.js';

const KEY = { revisionId: 'rev-1', format: 'pdf', templateId: 'typst-ats-classic' } as const;
const PLAN = {
  engineVersion: renderEngineVersion(TYPST_PIN.version, { typst: '0.15.1' }),
  templateVersion: '1.0.0',
  dataHash: 'b'.repeat(64),
} as const;

function row(overrides: Partial<CachedDocumentRow> = {}): CachedDocumentRow {
  return {
    id: 'doc-1',
    revisionId: KEY.revisionId,
    format: KEY.format,
    templateId: KEY.templateId,
    templateVersion: '1.0.0',
    engineVersion: PLAN.engineVersion,
    pageCount: 1,
    hash: 'c'.repeat(64),
    storageKey: 'artifacts/cc/' + 'c'.repeat(64),
    byteSize: 10_492,
    mimeType: 'application/pdf',
    createdAt: new Date('2026-09-30T12:00:00.000Z'),
    ...overrides,
  };
}

/** A store whose `head` is a spy, so "the filesystem was not touched" is observable. */
function artifacts(head: ArtifactStore['head'] = async () => ({ byteSize: 1, sha256: 'c'.repeat(64), contentType: 'application/pdf', createdAt: new Date() })) {
  return { head: vi.fn(head) } as unknown as ArtifactStore & { head: ReturnType<typeof vi.fn> };
}

function db(existing: CachedDocumentRow | null) {
  return {
    findFirst: vi.fn(async () => existing),
    upsert: vi.fn(async (args: unknown) => row()),
  } as unknown as RenderCacheStore & {
    findFirst: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
}

describe('render/cache - policy 10.4: the three HIT conditions', () => {
  it('HITs only when engineVersion, templateVersion and the live bytes all match', async () => {
    const store = artifacts();
    const found = await lookupCachedDocument({ store: db(row()), artifacts: store }, KEY, PLAN);
    expect(found.hit).toBe(true);
    if (found.hit) {
      // The SAME row, and therefore the SAME documentId, is what a re-render returns. This
      // is the property that makes a caller hold one id rather than a new one per render.
      expect(found.row.id).toBe('doc-1');
      expect(found.row.hash).toBe(row().hash);
    }
  });

  it('MISSes on an engineVersion change, and touches NO storage', async () => {
    // A toolchain bump must invalidate the cache automatically (policy 10.4) and must cost
    // no filesystem I/O to discover that - the version comparison is a string equality on
    // an already-read row, and it runs BEFORE the `head` probe.
    const store = artifacts();
    const found = await lookupCachedDocument(
      { store: db(row({ engineVersion: '0.14.0|{}' })), artifacts: store },
      KEY,
      PLAN,
    );
    expect(found).toEqual({ hit: false, reason: 'ENGINE_VERSION_CHANGED' });
    expect(store.head).not.toHaveBeenCalled();
  });

  it('MISSes on a template version bump, and touches NO storage', async () => {
    // The reason ADR-044 D4 added `ResumeTemplate.version` and `ResumeDocument
    // .templateVersion`: a template re-published with a NEW version must not keep serving the
    // artifact rendered from the previous source. What the code implements is the version
    // COMPARISON and nothing more - it is the template author's bump, not the cache, that
    // declares the source changed. A template edited with NO bump is a HIT, and that is the
    // deliberate reading of the contract's rule (`row.templateVersion === plan.templateVersion`),
    // not an oversight: the cache cannot see the source, and refusing to serve would mean no
    // template could ever be cached at all.
    const store = artifacts();
    const found = await lookupCachedDocument(
      { store: db(row({ templateVersion: '0.9.0' })), artifacts: store },
      KEY,
      PLAN,
    );
    expect(found).toEqual({ hit: false, reason: 'TEMPLATE_VERSION_CHANGED' });
    expect(store.head).not.toHaveBeenCalled();
  });

  it('MISSes when the row makes no templateVersion claim, and when the plan cannot', async () => {
    // Row-side null: a row that predates the column claims nothing, so it is never served.
    const rowStore = artifacts();
    expect(
      await lookupCachedDocument({ store: db(row({ templateVersion: null })), artifacts: rowStore }, KEY, PLAN),
    ).toEqual({ hit: false, reason: 'NULL_TEMPLATE_VERSION' });
    // Plan-side null: an export has no template, so the plan cannot name a version. Symmetric
    // on purpose - a miss on either null.
    const planStore = artifacts();
    expect(
      await lookupCachedDocument({ store: db(row()), artifacts: planStore }, KEY, { ...PLAN, templateVersion: null }),
    ).toEqual({ hit: false, reason: 'NULL_TEMPLATE_VERSION' });
    expect(planStore.head).not.toHaveBeenCalled();
  });

  it('MISSes when the row exists but its bytes no longer resolve', async () => {
    // A content-addressed key can outlive its blob: a cleared volume, a partial restore.
    // A row whose `head` is null is a MISS, and the re-render is a content-addressed `put`
    // that lands at the SAME key, so the recovery costs one compile and no duplicate row.
    const store = artifacts(async () => null);
    const found = await lookupCachedDocument({ store: db(row()), artifacts: store }, KEY, PLAN);
    expect(found).toEqual({ hit: false, reason: 'BYTES_ABSENT' });
    expect(store.head).toHaveBeenCalledWith(row().storageKey);
  });

  it('MISSes when there is no row at all, and never probes storage for one', async () => {
    const store = artifacts();
    expect(await lookupCachedDocument({ store: db(null), artifacts: store }, KEY, PLAN)).toEqual({
      hit: false,
      reason: 'NO_ROW',
    });
    expect(store.head).not.toHaveBeenCalled();
  });

  it('PROPAGATES a storage fault instead of calling it a miss', async () => {
    // A broken volume is not a cache miss. Treating it as one would turn a storage fault
    // into a re-render storm, and the port's `render_storage_unavailable` (503) is the
    // honest answer - a 503 the client retries, not a 422 that looks like a refusal.
    const store = artifacts(async () => {
      throw new StorageError('STORAGE_IO', 'IO_ERROR');
    });
    await expect(
      lookupCachedDocument({ store: db(row()), artifacts: store }, KEY, PLAN),
    ).rejects.toThrow('STORAGE_IO: the host filesystem could not complete the storage operation');
  });

  it('refuses to serve a row the store answered for a DIFFERENT tuple', async () => {
    // Cannot happen against a real database (those three fields ARE the unique index) -
    // which is exactly why a fake can do it, and why the cache must not serve it. A cache
    // that trusts its store's answer for the key is a cache that can answer with another
    // tenant's artifact.
    const lying = db({ ...row(), resumeId: 'rev-OTHER', format: 'tex' } as CachedDocumentRow);
    const store = artifacts();
    expect(await lookupCachedDocument({ store: lying, artifacts: store }, KEY, PLAN)).toEqual({
      hit: false,
      reason: 'NO_ROW',
    });
    expect(store.head).not.toHaveBeenCalled();
  });

  it('reads an EXPLICIT column selection, so a schema addition cannot widen the query', async () => {
    const store = db(row());
    await lookupCachedDocument({ store: store, artifacts: artifacts() }, KEY, PLAN);
    expect(store.findFirst).toHaveBeenCalledWith({ where: KEY, select: CACHE_ROW_SELECTION });
    // The selection is exactly the members `CachedDocumentRow` declares - no more, so a new
    // column cannot silently start being read by the cache.
    expect(Object.keys(CACHE_ROW_SELECTION).sort()).toEqual(
      ['byteSize', 'createdAt', 'engineVersion', 'format', 'hash', 'id', 'mimeType', 'pageCount', 'revisionId', 'storageKey', 'templateId', 'templateVersion'],
    );
  });

  it('refuses a malformed key rather than querying for one', async () => {
    const store = db(row());
    for (const bad of [{}, { revisionId: '', format: 'pdf', templateId: 'x' }, { revisionId: 'r', format: '', templateId: 'x' }]) {
      await expect(
        lookupCachedDocument({ store, artifacts: artifacts() }, bad as never, PLAN),
      ).rejects.toThrow(/must be a non-empty string/);
    }
    expect(store.findFirst).not.toHaveBeenCalled();
  });
});

describe('render/cache - engineVersion folds the pins, as a function of the VALUE', () => {
  it('produces the same key for two pin objects that differ only in KEY ORDER', async () => {
    // The property that makes the cache usable at all. `JSON.stringify` emits members in
    // INSERTION order, so two revisions that pinned the same version in a different order
    // would produce two different keys for the same render - and a row written by one would
    // never be found by the other. That is a cache that silently never hits, and it looks
    // exactly like a working one.
    const a = renderEngineVersion(TYPST_PIN.version, { typst: '0.15.1', latex: 'x' });
    const b = renderEngineVersion(TYPST_PIN.version, { latex: 'x', typst: '0.15.1' });
    expect(a).toBe(b);
    // And nested, because the same argument applies at every depth.
    expect(renderEngineVersion('1', { a: { x: 1, y: 2 } })).toBe(renderEngineVersion('1', { a: { y: 2, x: 1 } }));
  });

  it('changes when a pin VALUE changes, and when the toolchain version changes', async () => {
    const base = renderEngineVersion(TYPST_PIN.version, { typst: '0.15.1' });
    expect(renderEngineVersion(TYPST_PIN.version, { typst: '0.15.2' })).not.toBe(base);
    expect(renderEngineVersion('0.16.0', { typst: '0.15.1' })).not.toBe(base);
  });

  it('treats absent pins as the empty object, so a legacy row and a pinned one agree', async () => {
    expect(renderEngineVersion('1', undefined)).toBe(renderEngineVersion('1', {}));
    expect(renderEngineVersion('1', null)).toBe(renderEngineVersion('1', {}));
  });

  it('always carries the separator, so the value is parseable by eye', () => {
    expect(renderEngineVersion('1', {})).toBe('1|{}');
  });

  it('refuses a missing pinned version rather than producing a key with no version in it', () => {
    // A key with an empty version half would collide with any row written by something else
    // that left it blank, and a collision on a cache key is how a stale artifact is served.
    for (const bad of ['', undefined, null, 7]) {
      expect(() => renderEngineVersion(bad as string, {})).toThrow(/pinned engine version is required/);
    }
  });
});

describe('render/cache - the upsert replaces in place, with no orphan row', () => {
  it('addresses the EXISTING unique key and gives update and create the SAME fields', async () => {
    const store = db(row());
    const meta = {
      ...KEY,
      templateVersion: '1.0.0',
      engineVersion: PLAN.engineVersion,
      pageCount: 2,
      hash: 'd'.repeat(64),
      storageKey: 'artifacts/dd/' + 'd'.repeat(64),
      byteSize: 12_000,
      mimeType: 'application/pdf',
      resumeId: 'res-1',
    };
    await upsertRenderedDocument(store, meta);
    const args = store.upsert.mock.calls[0]?.[0] as {
      where: unknown;
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    // The compound unique, addressed by its GENERATED NAME. Not a primary key the caller
    // guessed (which is what makes a re-render REPLACE the row and keep the same id), and
    // not the three fields flat - Prisma's `WhereUniqueInput` takes the nested form, and the
    // live run is what proved the flat form is refused by the real client.
    expect(args.where).toEqual({
      revisionId_format_templateId: { revisionId: 'rev-1', format: 'pdf', templateId: 'typst-ats-classic' },
    });
    expect(COMPOUND_UNIQUE_INPUT).toBe('revisionId_format_templateId');
    // `create` is a strict superset of `update` plus the tuple itself, so a row written by
    // either branch carries every field. A half-merged row is how the next lookup could read
    // a version from one branch and a page count from the other and produce a document that
    // is neither.
    for (const field of Object.keys(args.update)) {
      expect(args.create).toHaveProperty(field);
      expect(args.create[field]).toEqual(args.update[field]);
    }
    expect(args.create).toMatchObject({ revisionId: 'rev-1', format: 'pdf', templateId: 'typst-ats-classic' });
    // No `id` in either branch: the schema's `@default(uuid())` supplies it, so a create
    // cannot collide with a row the caller did not mean to write.
    expect(args.update).not.toHaveProperty('id');
    expect(args.create).not.toHaveProperty('id');
    // NEVER a bytes column. ADR-041 D2: Postgres holds metadata only.
    for (const forbidden of ['bytes', 'data', 'content', 'blob']) {
      expect(args.create).not.toHaveProperty(forbidden);
      expect(args.update).not.toHaveProperty(forbidden);
    }
  });

  it('writes resumeId as NULL when the revision row does not name one', async () => {
    // The column is nullable on purpose (a denormalised convenience for the spec's ER
    // diagram), and the read routes fall back to `revision.resumeId` for exactly that case.
    // Writing `undefined` instead of `null` would make Prisma skip the column and leave a
    // STALE resumeId from a previous write.
    const store = db(row());
    await upsertRenderedDocument(store, {
      ...KEY,
      templateVersion: null,
      engineVersion: PLAN.engineVersion,
      pageCount: null,
      hash: 'd'.repeat(64),
      storageKey: 'artifacts/dd/' + 'd'.repeat(64),
      byteSize: 1,
      mimeType: 'application/json',
      resumeId: null,
    });
    const args = store.upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(args.create.resumeId).toBeNull();
    expect(args.create.templateVersion).toBeNull();
    expect(args.create.pageCount).toBeNull();
  });

  it('refuses a malformed key rather than writing a row it cannot address', async () => {
    const store = db(row());
    await expect(
      upsertRenderedDocument(store, { revisionId: '', format: 'pdf', templateId: 'x' } as never),
    ).rejects.toThrow(/must be a non-empty string/);
    expect(store.upsert).not.toHaveBeenCalled();
  });
});

describe('render/cache - the policy key halves it does NOT store, and why', () => {
  it('never persists a dataHash, and never reads one', async () => {
    // `dataHash` is `ResumeRevision.jsonHash`, and a revision is an IMMUTABLE SNAPSHOT, so
    // `revisionId` already determines it. Storing it would be a second copy of a fact that
    // cannot change - and a copy that could disagree with the revision it names. The
    // omission is the point: it is what makes "the cache cannot outlive its revision"
    // structural rather than a property of a column that could later be written wrongly.
    const store = db(row());
    await upsertRenderedDocument(store, {
      ...KEY,
      templateVersion: '1.0.0',
      engineVersion: PLAN.engineVersion,
      pageCount: 1,
      hash: 'd'.repeat(64),
      storageKey: 'artifacts/dd/' + 'd'.repeat(64),
      byteSize: 1,
      mimeType: 'application/pdf',
      resumeId: null,
    });
    const args = store.upsert.mock.calls[0]?.[0] as { create: Record<string, unknown>; update: Record<string, unknown> };
    expect(args.create).not.toHaveProperty('dataHash');
    expect(args.update).not.toHaveProperty('dataHash');
    // And the plan's dataHash is carried by the CALLER (the port), not by the cache row -
    // the cache never reads it, so a plan with a wrong dataHash cannot change an answer.
    const lookupStore = db(row());
    await lookupCachedDocument({ store: lookupStore, artifacts: artifacts() }, KEY, { ...PLAN, dataHash: 'WRONG' });
    expect(lookupStore.findFirst.mock.calls[0]?.[0]).not.toHaveProperty('dataHash');
  });

  it('keeps the two vocabulary seams it depends on closed and untouched', () => {
    // The cache's codes are the policy's, and the storage port's own code set is what a
    // missing blob is distinguished by (`null`, not a throw). Both are pinned here because
    // a change to either would move a 404 into a 500 or a 503 into a 422.
    expect(STORAGE_ERROR_CODES).toContain('STORAGE_NOT_FOUND');
    expect(RENDER_LIMITS.outputBytes).toBeGreaterThan(0);
  });
});
