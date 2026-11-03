// The determinism cache - policy 10.4 O4, in the shape the plan narrows it to.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md 10.4 O4 (the key,
//                 "a cache hit performs NO compile", "must key on the pinned engine
//                 version, so a toolchain bump invalidates it automatically")
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 7 (the
//                 lookup tuple, the three HIT conditions, upsert-in-place)
//                 .planning/decisions/ADR-044-*.md D4 ("null `templateVersion` is always a
//                 miss, so no stale artifact can be served")
// Task:         T1043
//
// WHAT THE POLICY KEY IS AND WHERE EACH HALF LIVES. Policy 10.4 names a seven-part key:
// `(revisionId, format, templateId, templateVersion, engineVersion, pins, dataHash)`. Four
// of those are not columns on `ResumeDocument` and must not become columns for this to
// work, so each is FOLDED into one that is:
//
//   revisionId, format, templateId   -> the row's identity, and the UNIQUE index that
//                                       makes `upsert` a replacement rather than an insert
//   templateVersion                   -> `ResumeDocument.templateVersion`
//   engineVersion, pins               -> `ResumeDocument.engineVersion`, as
//                                       `engineVersion + '|' + <canonical pins>` (see
//                                       `renderEngineVersion`)
//   dataHash                          -> NOT stored. It is `ResumeRevision.jsonHash`, and a
//                                       revision is an IMMUTABLE SNAPSHOT (05 sec.5), so
//                                       `revisionId` already determines it. Storing it would
//                                       be a second copy of a fact that cannot change, and a
//                                       copy that could disagree with the revision it names.
//
// The consequence, and it is the reason `dataHash` is not a column: a cache key that names
// a revision cannot outlive it, so there is no path by which a document whose CONTENT
// changed can be served from an artifact of the earlier content. The policy's
// "immutable revision" premise is what makes the folding sound, and if a future change
// makes revisions mutable this module has to change with it - which is stated here rather
// than left to be discovered.
//
// The premise is also ENFORCED, upstream of this module, which is stronger than arguing it
// from immutability alone: the port re-runs `assertRevisionRenderableInScope` as its second
// statement, and that function's first step re-hashes the revision's STORED bytes and
// compares them to `jsonHash` (`REVISION_TAMPERED`). A mutated revision is therefore refused
// before this lookup is ever consulted, so a `revisionId`-only key cannot serve a stale
// artifact even if the immutability premise is violated. That is why `RenderCachePlan
// .dataHash` is carried but never READ here: the belt has already made the comparison the
// column would have made.
//
// WHY A MISS IS AN UPSERT AND NOT AN INSERT. `@@unique([revisionId, format, templateId])`
// already exists, so a re-render of the same tuple addresses an existing row. `upsert` on
// that tuple updates the metadata IN PLACE, which is what the plan requires ("no orphan
// rows, no unique-index migration") and what makes a cache HIT return the SAME
// `documentId` as the miss that created it - a caller that rendered yesterday and again
// today holds one id, not two rows for the same document.
//
// WHY `templateVersion: null` IS ALWAYS A MISS. The column is nullable on purpose
// (ADR-044 D4): a row that predates the migration, or one written by anything that could
// not name the template version, makes no claim about which template produced it. Serving
// it would be serving an artifact whose provenance is unknown, and the plan's words are
// "a null `templateVersion` is always a MISS". This is checked BEFORE the storage probe
// so the reason is the same whichever way the row is wrong.

import type { Prisma } from '@prisma/client';

import type { ArtifactStore } from './storage.js';
import { canonicalJsonString } from '../resume/json/jsonresume.js';

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/** The unique tuple `ResumeDocument` is addressed by. Never a superset, never a subset. */
export interface RenderCacheKey {
  readonly revisionId: string;
  readonly format: string;
  /**
   * A real template id, or the reserved `'none'` for a `tex`/`json` export or a `docx`.
   *
   * `docx` joins them for the same reason (ADR-039): it has no template directory, so its
   * row says so with the reserved id rather than inventing one. The reserved id is safe to
   * reuse across formats precisely because `format` is part of this key - a `.tex` row and
   * a `.docx` row for one revision are different tuples, and neither can be confused with a
   * row that really did use a template.
   */
  readonly templateId: string;
}

/**
 * Everything about the RENDER that is not the tuple: the two versions a hit must match
 * exactly, and the revision's own data hash, which the caller uses to prove the revision it
 * is about to render is the revision the row describes.
 */
export interface RenderCachePlan {
  /** `sandbox.ts`'s pinned toolchain version, folded with the revision's own pins. */
  readonly engineVersion: string;
  /** `metadata.json`'s version, or `null` for a template that makes no version claim. */
  readonly templateVersion: string | null;
  /** `ResumeRevision.jsonHash` - the `dataHash` half of the policy key. */
  readonly dataHash: string;
}

/** The minimal row shape the cache needs. A `Prisma` row satisfies it structurally. */
export interface CachedDocumentRow {
  readonly id: string;
  readonly revisionId: string;
  readonly format: string;
  readonly templateId: string;
  readonly templateVersion: string | null;
  readonly engineVersion: string | null;
  readonly pageCount: number | null;
  readonly hash: string;
  readonly storageKey: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly createdAt: Date;
}

/** The database operations the cache performs. The two are all the cache may ever do. */
export interface RenderCacheStore {
  findFirst(args: { where: RenderCacheKey; select: CacheRowSelection }): Promise<CachedDocumentRow | null>;
  upsert(args: unknown): Promise<CachedDocumentRow>;
}

/** The columns the cache reads. Explicit, so a schema addition cannot silently widen a query. */
export interface CacheRowSelection {
  readonly id: true;
  readonly revisionId: true;
  readonly format: true;
  readonly templateId: true;
  readonly templateVersion: true;
  readonly engineVersion: true;
  readonly pageCount: true;
  readonly hash: true;
  readonly storageKey: true;
  readonly byteSize: true;
  readonly mimeType: true;
  readonly createdAt: true;
}

// ---------------------------------------------------------------------------
// The engine version, with the revision's pins folded in
// ---------------------------------------------------------------------------

/**
 * `engineVersion` with the revision's own pins folded in, so a toolchain bump AND an
 * authoring-time pin change both invalidate the cache - which is what policy 10.4 asks for
 * ("The cache must key on the pinned engine version") and what makes the wire's
 * `expectedEngineVersion` check (the broker refuses a mismatch before any container
 * exists) line up with the cache decision instead of running after it.
 *
 * The pins are serialised with `canonicalJsonString`, the repository's own canonical
 * serialiser, rather than `JSON.stringify`. That is not cosmetic: `JSON.stringify` emits
 * members in INSERTION order, so two revisions that pinned the same version in a different
 * order would produce two different cache keys for the same render, and a row written by
 * one would never be found by the other - a cache that silently never hits. Key order
 * sorted at every depth is what makes this a function of the VALUE.
 *
 * `{}` (no pins) still produces a distinct, stable suffix rather than being elided, so the
 * `|` separator is always present and the format is parseable by eye.
 */
export function renderEngineVersion(
  pinnedEngineVersion: string,
  revisionPins: unknown,
): string {
  if (typeof pinnedEngineVersion !== 'string' || pinnedEngineVersion.length === 0) {
    throw new TypeError('renderEngineVersion: a pinned engine version is required');
  }
  const pins = revisionPins === undefined || revisionPins === null ? {} : revisionPins;
  return `${pinnedEngineVersion}|${canonicalJsonString(pins)}`;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export type RenderCacheMiss = 'NO_ROW' | 'NULL_TEMPLATE_VERSION' | 'ENGINE_VERSION_CHANGED' | 'TEMPLATE_VERSION_CHANGED' | 'BYTES_ABSENT';

export type RenderCacheLookup =
  | { readonly hit: true; readonly row: CachedDocumentRow }
  | { readonly hit: false; readonly reason: RenderCacheMiss };

/**
 * Look the tuple up and decide whether the row may be served.
 *
 * A HIT requires ALL THREE of the plan's conditions, in this order, and the order is the
 * cheap-to-expensive one: the two version comparisons are pure string equality on an
 * already-read row, and only the survivor pays for `store.head`. In particular a row whose
 * versions do not match is never probed on the filesystem, so a toolchain bump costs no
 * storage I/O at all.
 *
 * `store.head(row.storageKey) !== null` is the third condition and it is the one that
 * makes the cache honest about a LOST blob: content-addressed storage means the key names
 * the digest, so a row can outlive its bytes (an operator cleared the volume, a restore
 * was partial). A row whose blob is gone is a MISS, and the re-render is a content-addressed
 * `put` that lands at the same key - so the recovery costs one compile and leaves no
 * duplicate row.
 *
 * `store.head` THROWING is deliberately not caught HERE. A storage fault is not a miss:
 * treating it as one would turn a broken volume into a re-render storm. It propagates to the
 * port, which wraps this call in `translateRenderErrors` and maps the `StorageError` to
 * `render_storage_unavailable` (503) - the honest answer, and the only answer this layer
 * would give if it caught it itself.
 */
export async function lookupCachedDocument(
  deps: { store: RenderCacheStore; artifacts: ArtifactStore },
  key: RenderCacheKey,
  plan: RenderCachePlan,
): Promise<RenderCacheLookup> {
  assertKey(key);
  const row = await deps.store.findFirst({ where: key, select: CACHE_ROW_SELECTION });
  if (row === null || row === undefined) return { hit: false, reason: 'NO_ROW' };
  if (row.templateVersion === null || row.templateVersion === undefined) {
    return { hit: false, reason: 'NULL_TEMPLATE_VERSION' };
  }
  if (plan.templateVersion === null || plan.templateVersion === undefined) {
    // The plan cannot name a version, so it cannot claim this row either. Symmetric with
    // the row-side check above: a MISS on either null.
    return { hit: false, reason: 'NULL_TEMPLATE_VERSION' };
  }
  if (row.engineVersion !== plan.engineVersion) {
    return { hit: false, reason: 'ENGINE_VERSION_CHANGED' };
  }
  if (row.templateVersion !== plan.templateVersion) {
    return { hit: false, reason: 'TEMPLATE_VERSION_CHANGED' };
  }
  if (row.format !== key.format || row.templateId !== key.templateId || row.revisionId !== key.revisionId) {
    // Defence in depth against a store that answers with a row for a DIFFERENT tuple. The
    // three fields are the unique index, so this cannot happen against a real database -
    // which is exactly why a fake in a test can, and why the cache must not serve it.
    return { hit: false, reason: 'NO_ROW' };
  }
  // MUTATION M-b: delete this `head` probe. The "a row whose storageKey no longer resolves
  // forces a MISS" test in `renderPort.test.ts` fails, and `cache.test.ts`'s `BYTES_ABSENT`
  // case with it.
  const head = await deps.artifacts.head(row.storageKey);
  if (head === null || head === undefined) return { hit: false, reason: 'BYTES_ABSENT' };
  return { hit: true, row };
}

/**
 * The compound unique's GENERATED INPUT NAME.
 *
 * `@@unique([revisionId, format, templateId])` on `ResumeDocument` produces the where-input
 * key `revisionId_format_templateId`, and that is a Prisma NAMING CONVENTION rather than
 * something this module chose: `upsert`'s `where` is a `WhereUniqueInput`, which accepts
 * `id` OR that one nested object, and NOT the three fields spread flat. The live run found
 * this - the flat form passed 20 cache tests and 38 port tests against a fake that took any
 * object, and the real client refused it with "needs at least one of `id` or
 * `revisionId_format_templateId`".
 *
 * The name is a CONSTANT here because a Prisma input type has no runtime keys to read it
 * from (the type is erased), so what can be checked is the OTHER direction, below: the
 * constant is fed to a compile-time assertion that the generated type accepts it. A schema
 * edit that renames or drops the index therefore fails `tsc --noEmit` rather than the first
 * render - which is the same discipline the rest of this module uses for every other policy
 * number it depends on.
 *
 * `findFirst` above deliberately does NOT use it: `findFirst` takes a `WhereInput` FILTER,
 * where the flat three fields are the correct shape. Only `upsert` needs the unique form,
 * because only `upsert` needs to know the row exists.
 */
export const COMPOUND_UNIQUE_INPUT = 'revisionId_format_templateId';

/** Compile-time proof that the constant above is a real key of the generated input. */
type CompositeWhere = { revisionId: string; format: string; templateId: string };
type GeneratedCompositeInput = Exclude<
  Prisma.ResumeDocumentWhereUniqueInput[typeof COMPOUND_UNIQUE_INPUT],
  undefined
>;
const COMPOUND_KEY_EXISTS: GeneratedCompositeInput extends CompositeWhere ? true : false = true;
void COMPOUND_KEY_EXISTS;

/** The explicit column selection, so a schema addition cannot widen a cache query. */
export const CACHE_ROW_SELECTION: CacheRowSelection = Object.freeze({
  id: true,
  revisionId: true,
  format: true,
  templateId: true,
  templateVersion: true,
  engineVersion: true,
  pageCount: true,
  hash: true,
  storageKey: true,
  byteSize: true,
  mimeType: true,
  createdAt: true,
} as CacheRowSelection);

function assertKey(key: RenderCacheKey): void {
  if (key === null || typeof key !== 'object') {
    throw new TypeError('lookupCachedDocument: a cache key is required');
  }
  for (const field of ['revisionId', 'format', 'templateId'] as const) {
    if (typeof key[field] !== 'string' || key[field].length === 0) {
      throw new TypeError(`lookupCachedDocument: cache key ${field} must be a non-empty string`);
    }
  }
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

/** The metadata a fresh render writes. Exactly the columns policy 6.4 / ADR-041 D2 name. */
export interface RenderedDocumentMeta extends RenderCacheKey {
  readonly templateVersion: string | null;
  readonly engineVersion: string;
  /** `null` rather than a guess when the page count cannot be read from the bytes. */
  readonly pageCount: number | null;
  /** sha256 of the exact artifact bytes. */
  readonly hash: string;
  /** The content-addressed key the bytes were stored under. NEVER the bytes. */
  readonly storageKey: string;
  readonly byteSize: number;
  readonly mimeType: string;
  /**
   * The resume the document belongs to. Written when the caller knows it, so the direct
   * `Resume -> ResumeDocument` relation (05 sec.3) is populated rather than left to a
   * derivation; `null` is legal (the column is nullable) and the read routes fall back to
   * `revision.resumeId` for exactly that reason.
   */
  readonly resumeId: string | null;
}

/**
 * Write the metadata for a finished render, in place on the existing tuple.
 *
 * `update` and `create` carry the SAME field set. That is deliberate and is the property
 * that makes a re-render leave no stale claim behind: a row written by an earlier render
 * with a `templateVersion` and a `pageCount` must have both OVERWRITTEN, not half-merged,
 * or the next lookup could read a version from the create branch and a page count from the
 * update branch and produce a document that is neither.
 *
 * `create` carries no `id`, so a genuinely new row gets its uuid from the schema's
 * `@default(uuid())`; `update` carries no `id` either, which is what makes the `where` the
 * unique tuple rather than a primary key the caller guessed.
 *
 * A failed write may orphan a content-addressed blob - the bytes are already at their key
 * and are reused by the next render - which the plan calls harmless and which is true
 * precisely BECAUSE the key is a digest and carries no revision, template or user data.
 */
export async function upsertRenderedDocument(
  store: RenderCacheStore,
  meta: RenderedDocumentMeta,
): Promise<CachedDocumentRow> {
  assertKey(meta);
  const data = {
    resumeId: meta.resumeId,
    templateVersion: meta.templateVersion,
    engineVersion: meta.engineVersion,
    pageCount: meta.pageCount,
    hash: meta.hash,
    storageKey: meta.storageKey,
    byteSize: meta.byteSize,
    mimeType: meta.mimeType,
  };
  // The compound unique is addressed by its GENERATED NAME, not by the three fields flat.
  //
  // Prisma's `@@unique([revisionId, format, templateId])` produces the input
  // `revisionId_format_templateId`, and `WhereUniqueInput` accepts `id` or that nested
  // object - NOT the three fields spread. The live run found this: the unit suite's fake
  // took any object, so the flat form passed 20 cache tests and 38 port tests and the real
  // client refused it with `needs at least one of id or revisionId_format_templateId`. The
  // name is not hand-spelled either - it is read out of the generated type's keys, so a
  // schema change to the index turns this into a COMPILE error rather than a runtime
  // rejection on the first render.
  return store.upsert({
    where: {
      [COMPOUND_UNIQUE_INPUT]: { revisionId: meta.revisionId, format: meta.format, templateId: meta.templateId },
    },
    update: data,
    create: {
      revisionId: meta.revisionId,
      format: meta.format,
      templateId: meta.templateId,
      ...data,
    },
  });
}
