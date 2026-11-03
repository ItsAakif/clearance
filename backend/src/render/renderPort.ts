// The render port - the T1030 `setResumeRenderPort` hole, filled, and the only place in
// the repository that turns "render this revision" into a stored artifact.
//
// NORMATIVE DOC: .planning/tasks/T1043-render-orchestration-routes.md (the contract)
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 7 (the
//                 path, the persistence, the cache, the error mapping), sec. 8 (the gate
//                 paragraph), sec. 13 rulings 1 and 4 (`typ` refused; `none` reserved)
//                 .planning/specs/clearance-v2/render-sandbox-policy.md 6.4, 9.2, 9.3, 9.4,
//                 10.2, 10.4, 10.5
//                 .planning/decisions/ADR-043-*.md (the pre-render belt), ADR-044 D2/D4/D5
// Task:         T1043
//
// =====================================================================================
// THE GATE IS RE-RUN HERE, AND THAT IS WHY THIS MODULE IS NOT JUST A WIRING SHIM
// =====================================================================================
//
// `POST /resumes/:id/render` runs `preRenderGuard()` as express MIDDLEWARE, so the gate
// executes before the handler body: on a blocked revision the port is never INVOKED, and
// `resumes.test.ts` proves that by installing a port that records every call and asserting
// the record is EMPTY. That is the belt.
//
// This module is the braces. It calls `assertRevisionRenderableInScope` - the SAME function
// the guard calls, over the SAME stored bytes and the SAME database reads - as its second
// statement, before it resolves a template, before it stages a byte, before it opens a
// socket. So:
//
//   - a direct call (a script, a future route, a test that installs this port directly)
//     cannot render a revision the gate refuses;
//   - there is NO code path from a render request to the broker, the registry or the
//     storage port that passes only one of the two checks;
//   - the guarantee is a property of the PORT rather than of the route that happens to
//     call it, which is the only way it survives the next route someone writes.
//
// It costs one extra pass over a revision's own usages (a handful of indexed rows) and buys
// the difference between "the gate runs first" (an ordering claim) and "the gate is
// unavoidable" (an invariant). The refusals it throws are the SAME types `sendServiceError`
// already maps to 409, so a direct caller sees what an HTTP caller sees, code included.
//
// NOTHING IS WEAKENED, WIDENED OR RE-ROUTED. The legacy export refusals live in
// `resume/legacyExportGuard.ts` and are untouched; the gate reads claim status from the
// DATABASE, never from the `x-clearance` block; and a toolchain bump cannot smuggle a
// revision past the belt either, because the broker refuses an `expectedEngineVersion`
// mismatch with `RENDER_TOOLCHAIN_MISMATCH` before any container exists.
//
// =====================================================================================
// THE ORDER, AND THE ONE PLACE IT DIFFERS FROM THE CONTRACT'S LISTED ORDER
// =====================================================================================
//
//   1. resolve the revision          - a render of nothing is not a render
//   2. RE-RUN THE GATE               - see above
//   3. refuse `typ`                  - no row, no tree, no template read
//   4. resolve the template          - the registry's review gate (PURE; see the note)
//   5. CACHE LOOKUP                  - a hit performs NO compile
//   6. serialise the bytes           - the ONE shared dictionary, then the format's own
//                                      serialiser (a broker job for pdf, a pure function
//                                      for tex and docx, the revision document for json)
//   7. stage / compile / validate    - `typst.ts` owns this half
//   8. store.put, then upsert the row- bytes first, metadata second
//   9. structured job log            - policy 10.5, never staged content
//
// Step 7 carries ONE extra thing, `compilePdfWithColdStartRetry`: a single re-attempt when
// the broker answers `RENDER_TIMEOUT`, which is a cold-container artefact rather than a
// property of the document (the escalation is documented on the function). It does not move
// step 7's position relative to anything else, does not touch the budget in `sandbox.ts`,
// and cannot hide a runaway - see the function for why, and `renderPort.test.ts` for the
// two tests that pin it.
//
// The contract lists 5 (cache lookup) before 4 (template resolution). It cannot be done in
// that order, and the contract's own HIT RULE says why: a hit requires
// `row.templateVersion === record.version`, so the RECORD has to exist before the decision
// is made. Resolving it first costs nothing - `resolveTemplateForRender` is pure, does no
// I/O and reads no clock - so the only cost is loading the registry, which is memoised per
// port. The observable behaviour is exactly the one the contract describes, and the
// deviation is recorded here rather than left to be noticed.
//
// Step 8's order is the interesting one. The BYTES go to storage before the ROW is
// written, so a failure between the two can only ORPHAN a content-addressed blob - which
// is harmless and is reused by the next render, because the key IS the digest and carries
// no revision, template or user data (ADR-044 D2). The reverse order would write a row
// pointing at bytes that do not exist, and that row is what the cache would have to
// distrust forever. One production path, ONE persistence path: an export and a DOCX have no
// template and no broker job, but they go through the same `put` and the same `upsert`,
// which is what lets the documents routes serve a `.tex`, a `.docx` and a `.pdf` the same
// way.

import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import prisma from '../lib/prisma.js';
import type { ResumeDocument } from '@prisma/client';
import {
  assertRevisionRenderableInScope,
  getRevision,
  type ResumeRevision,
  type ResumeRevisionStore,
} from '../resume/revisions.js';
import type { ResumeClaimUsageStore } from '../career/claimUsage.js';
import type { ResumeRenderPort } from '../routes/resumes.js';
import {
  lookupCachedDocument,
  renderEngineVersion,
  upsertRenderedDocument,
  type CachedDocumentRow,
  type RenderCacheStore,
  type RenderedDocumentMeta,
} from './cache.js';
import { projectResumeDict } from './dict.js';
import { DOCX_ENGINE, DOCX_RENDERER_VERSION, renderDocxFromDictionary } from './docx.js';
import { brokerEndpoint, resolveRenderBudget } from './env.js';
import { renderJsonExportBytes } from './jsonExport.js';
import { renderLatexExportBytes } from './latexExport.js';
import { renderLatexDocument } from './latex.js';
import { LATEX_PIN, RENDER_ENGINES, RENDER_LIMITS, TYPST_PIN, type RenderEngine } from './sandbox.js';
import { RenderBrokerClient } from './brokerClient.js';
import { createArtifactStore, storageKeyFor, StorageError, type ArtifactStore } from './storage.js';
import { STAGE_REJECTION_CODES, StageError } from './stage.js';
import {
  RENDER_DEFAULT_TEMPLATE_ID,
  TEMPLATE_RESERVED_IDS,
  TemplateRejectionError,
  canonicalTemplateId,
  isLegacyTemplateId,
  loadTemplateRegistry,
  resolveTemplateForRender,
  type TemplateRecord,
  type TemplateRegistry,
} from './templates.js';
import { renderTypstDocument } from './typst.js';
import {
  DOCX_MIME_TYPE,
  EXPORT_MIME_TYPES,
  RenderPortError,
  isRenderRequestFormat,
  requestMimeType,
  type RenderPortErrorCode,
} from './types.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * The broker transport, narrowed to the one method this port calls. Declared as
 * `Pick<RenderBrokerClient, 'render'>` rather than a hand-written signature so the port's
 * view of the client and the client's own method cannot drift: a change to the wire result
 * is a change here, and `tsc --noEmit` is what says so.
 */
export type RenderBrokerLike = Pick<RenderBrokerClient, 'render'>;

/**
 * The database surface the port needs, as the DELEGATES rather than as a flattened pair of
 * methods.
 *
 * The cache's two operations live on `resumeDocument` because that is where Prisma put
 * them, and a flattened `{findFirst, upsert}` would need a wrapper object built on every
 * call - a second place where the port could pick the wrong delegate. So this names
 * `resumeDocument` explicitly and the cache is handed that delegate.
 *
 * The other two seams are the ones the BELT reads through, taken as they already exist
 * (`ResumeRevisionStore`, `ResumeClaimUsageStore`, both from T1030) rather than
 * re-declared: the gate's own signature is what decides whether a revision is renderable,
 * so re-declaring its inputs could only weaken it.
 */
export type RenderPortDb = ResumeRevisionStore & ResumeClaimUsageStore & {
  resumeDocument: RenderCacheStore;
};

export interface RenderPortDeps {
  /** Metadata persistence: `findFirst` for the cache, `upsert` for the write. */
  readonly db: RenderPortDb;
  /** The byte store. Metadata in Postgres, bytes here (ADR-041 D2). */
  readonly artifacts: ArtifactStore;
  /**
   * The broker client. Optional: omitted, one is built from the ENVIRONMENT (unix socket
   * preferred, loopback URL as the dev fallback, shared secret required) so the same build
   * talks to a compose socket in production and a loopback port in development.
   */
  readonly broker?: RenderBrokerLike;
  /**
   * The template registry. Optional: omitted, it is loaded from
   * `backend/typst/templates` ONCE and memoised. It is NOT loaded at boot: a template
   * that fails its review gate must fail the RENDER with a machine reason, never the
   * process, because the render tier is behind a feature flag and a broken template must
   * not take down an API with other work to do.
   */
  readonly registry?: TemplateRegistry;
  /** A clock, for the job log's durations and the job id. NEVER for a PDF timestamp. */
  readonly now?: () => number;
  /** Where the structured per-job record goes. Defaults to `console.error`. */
  readonly log?: (line: string) => void;
  /**
   * The template a `pdf` render uses when the request names none. Defaults to
   * `RENDER_DEFAULT_TEMPLATE_ID`.
   *
   * A TEST SEAM AND A DEFAULT, not a feature: it is what a caller that names no template gets,
   * which is every existing caller, and what lets a negative fixture (a template that fails a
   * registry gate) be reachable without a second registry on disk. A request's OWN
   * `templateId` takes precedence over this - see `createRenderPort`.
   */
  readonly templateId?: string;
}

/** The reserved id an export row records, because it has no template (ruling 4). */
export const EXPORT_TEMPLATE_ID = TEMPLATE_RESERVED_IDS[0];

/** The format a `pdf` render resolves its template for, and the only one that compiles. */
type CompiledFormat = 'pdf';
/** The two formats that need no typesetter and no container (ADR-042 D1, T1044). */
type ExportFormat = 'tex' | 'json';
/**
 * DOCX is a third in-process serialiser: a PEER of the PDF renderer off Resume JSON, not a
 * child of any typesetter (ADR-039), and needing no template, no broker and no container.
 *
 * It is grouped with the exports because that is exactly what it is operationally, and the
 * difference is one line of dispatch rather than a second pipeline.
 */
type DocxFormat = 'docx';
type PortFormat = CompiledFormat | ExportFormat | DocxFormat;

// ---------------------------------------------------------------------------
// The format contract
// ---------------------------------------------------------------------------

/**
 * The format dispatch, decided before any work: nothing is read, staged or stored for a
 * format this port cannot produce, and NO ROW IS WRITTEN for a refused format.
 *
 * `typ` is refused because a `.typ` export is a BUNDLE (template + `data.json` +
 * `packages.lock`) and this phase ships neither a bundle nor the fragile single-file
 * substitution ruling 1 declined to ship. `TYP_EXPORT_IS_A_BUNDLE` is the one reason a
 * client can act on, so it is one of the two reasons
 * `types.ts`'s `CLIENT_VISIBLE_RENDER_REASONS` lets the route surface.
 *
 * `docx` used to be refused here with `DOCX_RENDERER_NOT_SHIPPED`, which is the T1041 hole
 * this task closed: the ROUTE accepted `docx` from T1030 onward and the PORT declined it.
 * It is now produced in-process by `docx.ts` (ADR-039), and the reason is no longer
 * reachable - which is why it is gone from `CLIENT_VISIBLE_RENDER_REASONS` too, because a
 * reason set that still advertised a refusal nobody can provoke is a second answer to "what
 * can this format do". The route's shipped `format` contract is untouched: `docx` is in it
 * and now means something.
 */
function decideFormat(format: unknown): PortFormat {
  if (format === undefined || format === null) return 'pdf';
  if (typeof format !== 'string' || !isRenderRequestFormat(format)) {
    throw new RenderPortError('render_format_unsupported', 'FORMAT_UNKNOWN');
  }
  if (format === 'typ') {
    throw new RenderPortError('render_format_unsupported', 'TYP_EXPORT_IS_A_BUNDLE');
  }
  return format;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * Build the T1030 `ResumeRenderPort`.
 *
 * Everything the port touches is a parameter, so a unit test needs no broker, no Docker,
 * no socket, no template directory and no database - and the LIVE path constructs it from
 * the real modules with the real registry against a real daemon.
 */
export function createRenderPort(overrides: Partial<RenderPortDeps> = {}): ResumeRenderPort {
  const db: RenderPortDb = overrides.db ?? (prisma as unknown as RenderPortDb);
  const artifacts: ArtifactStore = overrides.artifacts ?? createArtifactStore();
  const now = overrides.now ?? ((): number => Date.now());
  const log = overrides.log ?? defaultLogger;
  /**
   * The template this port falls back to. NOT the template every render uses: a request that
   * names one gets THAT one (`args.templateId`), resolved through the registry's own review
   * gate in step 4 below. The fallback is what an unnamed request gets, which is why it stays a
   * construction-time dependency - a test can point the whole port at one registry and still
   * ask for another template by id.
   *
   * Three levels, most specific first, and nothing else is consulted:
   *   1. `args.templateId`  - the caller's per-request choice (the Studio's template switch);
   *   2. `overrides.templateId` - this port's default;
   *   3. `RENDER_DEFAULT_TEMPLATE_ID` - the registry's own default.
   *
   * An UNRESOLVABLE id is a refusal, never a substitute: `resolveRecord` throws
   * `render_template_unsupported`, so a caller cannot be handed a document laid out by a
   * template it did not ask for.
   */
  const defaultTemplateId = overrides.templateId ?? RENDER_DEFAULT_TEMPLATE_ID;

  // ONE registry load per port, memoised on the first `pdf` render, and a load FAILURE is
  // memoised too: a template that did not clear its review gate is a repo fault an
  // operator fixes, so re-reading four files per template on every request would be work
  // nobody asked for, and the same machine reason would be re-derived each time.
  let registryPromise: Promise<TemplateRegistry> | null = null;
  const registry = (): Promise<TemplateRegistry> => {
    if (overrides.registry !== undefined) return Promise.resolve(overrides.registry);
    if (registryPromise === null) registryPromise = loadTemplateRegistry();
    return registryPromise;
  };

  return async (args) => {
    if (args === null || typeof args !== 'object') {
      throw new RenderPortError('render_revision_unavailable', 'REQUEST_INVALID');
    }

    // 1 + 2. Resolve, then RE-RUN THE GATE. Nothing above this line touches a template, a
    //        staged byte, a socket or any row beyond the revision read itself.
    const revision = await resolveAndGate(args.revisionId, db);

    // 3. The format contract.
    const format = decideFormat(args.format);

    const startedAt = now();
    const jobId = randomUUID();

    // 4. The template. PURE over an already loaded registry; the only I/O is the memoised
    //    load, and neither an export nor a DOCX ever reaches it. The request's own choice
    //    wins over the port's default, and an id the registry cannot resolve throws here -
    //    above the cache lookup, above any staging, above the broker.
    //
    //    F6: A `templateId` ON AN EXPORT IS REFUSED, NOT IGNORED. The three in-process
    //    formats have no template - `record` is `null` for each, so `rowTemplateId` is the
    //    reserved `'none'` and the caller's id was dropped without a word. T1043's rule is
    //    "a caller's explicit choice is never silently ignored", and a body that says
    //    "render this in typst-modern-cards" and receives a `.tex` file laid out by no
    //    template at all is exactly the substitution that cannot be defended. Resolving it
    //    is not available either: `resolveTemplateForRender` is reached for `pdf` only, and a
    //    template applied to an export would need a second layout engine. So it is refused
    //    with a machine-readable reason, ABOVE the cache lookup (nothing is written, and a
    //    refusal cannot be cached), above staging and above the broker. `null` and an absent
    //    member are NOT refusals: "no template" is the default for these formats, and the
    //    route's own `format` contract is unchanged.
    if (format !== 'pdf' && typeof args.templateId === 'string' && args.templateId.trim().length > 0) {
      throw new RenderPortError('render_template_unsupported', 'EXPORT_HAS_NO_TEMPLATE');
    }
    const requestedTemplateId =
      typeof args.templateId === 'string' && args.templateId.trim().length > 0
        ? args.templateId.trim()
        : defaultTemplateId;
    const record =
      format === 'pdf' ? resolveRecord(await registry(), requestedTemplateId) : null;
    const rowTemplateId = record?.id ?? EXPORT_TEMPLATE_ID;

    // 5. The cache. A hit performs NO compile: no staging, no broker call, no storage
    //    write - only the `store.head` that proves the bytes are still there.
    //
    // `templateVersion` for a DOCX is `DOCX_RENDERER_VERSION`, and this is the one place
    // the decision is made. ADR-039 makes DOCX a PEER off Resume JSON with no template
    // directory, so `templateId` is the reserved `'none'` and the cache would otherwise see
    // a NULL `templateVersion` - which is always a miss (ADR-044 D4), so every DOCX request
    // would re-serialise and no cache could ever serve one. The renderer's own revision is
    // the honest stand-in for a template revision here: it is the thing whose change makes
    // stored bytes stale, which is exactly what the column is for. Bump
    // `DOCX_RENDERER_VERSION` and every stored DOCX misses, which is the intended behaviour.
    const plan = {
      engineVersion: engineVersionFor(format, revision, record?.metadata.engine),
      templateVersion: record?.version ?? (format === 'docx' ? DOCX_RENDERER_VERSION : null),
      dataHash: revision.jsonHash,
    };
    // MUTATION M-e: delete the `withStorageErrors` wrapper HERE. The cache's `store.head`
    // is the only storage call in the port that is not translated, and a `StorageError` from
    // a broken volume escaped it - past the `RenderPortError` branch in `sendServiceError`,
    // into `handleApiError`'s generic 500, which contradicts this module's own header, the
    // cache's header, `types.ts` and the contract. The new test in `renderPort.test.ts`
    // ("a storage fault in the CACHE LOOKUP is a 503, never a 500") is what dies.
    // T1052 narrowed what that wrapper translates: it maps `StorageError` and re-throws
    // everything else, so the `findFirst` in the same call keeps its own status.
    const lookup = await withStorageErrors(() =>
      lookupCachedDocument(
        { store: db.resumeDocument, artifacts },
        { revisionId: revision.id, format, templateId: rowTemplateId },
        plan,
      ),
    );
    if (lookup.hit) {
      logJob(log, {
        event: 'render.job',
        jobId,
        outcome: 'ok',
        code: 'CACHE_HIT',
        engine: format === 'pdf' ? (record?.metadata.engine ?? 'typst') : 'none',
        engineVersion: plan.engineVersion,
        format,
        templateId: rowTemplateId,
        templateVersion: plan.templateVersion,
        revisionId: revision.id,
        durationMs: now() - startedAt,
        cacheHit: true,
      });
      return { documentId: lookup.row.id, format, hash: lookup.row.hash };
    }

    // 6 + 7. Produce the bytes. Two producers, ONE persistence path.
    const produced =
      format === 'pdf'
        ? await compilePdfWithColdStartRetry(
            {
              deps: { artifacts, now, broker: overrides.broker, templateId: rowTemplateId },
              record: record as TemplateRecord,
              revision,
              userId: args.userId,
              jobId,
            },
            log,
          )
        : await serialiseInProcess(format, revision);

    // 8a. The BYTES, under a key derived from their own digest and nothing else.
    const stored = await withStorageErrors(() =>
      artifacts.put({
        key: produced.storageKey,
        bytes: produced.stream(),
        contentType: produced.mimeType,
        byteSize: produced.byteSize,
        sha256: produced.sha256,
      }),
    );

    // 8b. Then the metadata, upserted IN PLACE on the tuple, so a re-render leaves no
    //     orphan row and the documentId is stable across renders.
    const meta: RenderedDocumentMeta = {
      revisionId: revision.id,
      format,
      templateId: rowTemplateId,
      templateVersion: plan.templateVersion,
      engineVersion: plan.engineVersion,
      pageCount: produced.pageCount,
      hash: produced.sha256,
      storageKey: stored.key,
      byteSize: stored.byteSize,
      mimeType: stored.contentType,
      resumeId: typeof revision.resumeId === 'string' && revision.resumeId.length > 0 ? revision.resumeId : null,
    };
    const row: CachedDocumentRow = await upsertRenderedDocument(db.resumeDocument, meta);

    // 9. The structured per-job record. Policy 10.5's list and nothing on it is content:
    //    no staged bytes, no resume text, no host path, no stderr.
    logJob(log, {
      event: 'render.job',
      jobId,
      outcome: 'ok',
      code: 'RENDERED',
      engine: format === 'pdf' ? (record?.metadata.engine ?? 'typst') : 'none',
      engineVersion: plan.engineVersion,
      format,
      templateId: rowTemplateId,
      templateVersion: plan.templateVersion,
      revisionId: revision.id,
      documentId: row.id,
      durationMs: now() - startedAt,
      compileDurationMs: produced.compileDurationMs,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      pageCount: produced.pageCount,
      cacheHit: false,
      nearLimit: {
        inputBytes: produced.inputBytes,
        inputTotalBytes: RENDER_LIMITS.inputTotalBytes,
        inputNearLimit: produced.inputBytes >= 0.8 * RENDER_LIMITS.inputTotalBytes,
        outputBytes: stored.byteSize,
        outputTotalBytes: RENDER_LIMITS.outputBytes,
        outputNearLimit: stored.byteSize >= 0.8 * RENDER_LIMITS.outputBytes,
      },
    });

    return { documentId: row.id, format, hash: row.hash };
  };
}

// ---------------------------------------------------------------------------
// Step 1 + 2: resolve, then the gate
// ---------------------------------------------------------------------------

/**
 * Read the revision and RE-RUN THE BELT over it.
 *
 * The refusals this propagates are `PreRenderGateError` and `RevisionAuditError` - the same
 * types T1030's route maps to 409 with the machine code and reason intact - and
 * `sendServiceError` is shared, so a direct caller of the port sees the same classification
 * an HTTP caller does.
 *
 * The refusal happens BEFORE the format dispatch on purpose. A blocked revision is refused
 * whatever was asked for: "confirm these claims" is true of the document, not of the
 * format, and answering `render_format_unsupported` to a caller whose revision is blocked
 * would tell them to pick a different format when the actual problem is upstream of format.
 */
async function resolveAndGate(revisionId: string, db: RenderPortDb): Promise<ResumeRevision> {
  if (typeof revisionId !== 'string' || revisionId.length === 0) {
    throw new RenderPortError('render_revision_unavailable', 'REVISION_ID_INVALID');
  }
  const revision = await getRevision(revisionId, db as never);
  if (revision === null || revision === undefined) {
    throw new RenderPortError('render_revision_unavailable', 'REVISION_NOT_FOUND');
  }
  // MUTATION M-a: the port's own re-run of the belt. Deleting THIS line is the whole
  // mutation: the route's `preRenderGuard` still runs over HTTP, so the HTTP half of the
  // blocked test keeps passing and only the DIRECT half dies - which is exactly the half no
  // route guard can cover, and the reason this call exists.
  await assertRevisionRenderableInScope(revision, db as never);
  return revision;
}

// ---------------------------------------------------------------------------
// Step 6 + 7: the two producers
// ---------------------------------------------------------------------------

interface ProducedBytes {
  readonly sha256: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly storageKey: string;
  /** `null` for an export: a source file has no pages, and 0 would be a different claim. */
  readonly pageCount: number | null;
  readonly inputBytes: number;
  readonly compileDurationMs: number;
  /**
   * A FRESH stream per call. The store consumes the stream exactly once, and a `put` that
   * finds the key already present never reads it - so a re-render must be able to hand over
   * a new one rather than a drained buffer.
   */
  stream(): Readable;
}

/**
 * The IN-PROCESS producer: a pure serialiser, no template, no broker, no container.
 *
 * Three formats reach it and they differ in exactly one respect, which is what it takes:
 *
 *   `tex`  reads the ONE shared dictionary (ADR-044 D3: the same content in the same order
 *          as the compiled renderers, which is how 07 Phase 4 (a) parity becomes
 *          structural);
 *   `docx` reads the SAME dictionary, through the SAME module the parity fixture is
 *          compared over, and is async only because the OOXML packer is (ADR-039: a peer of
 *          the PDF renderer, not a child of any typesetter);
 *   `json` serialises the REVISION DOCUMENT through `canonicalJsonString` - NOT the
 *          dictionary, because the dictionary deliberately omits the `x-clearance` ledger and
 *          deriving the export from it would delete the user's own provenance (ruling 14).
 *
 * `pageCount` is `null` for all three, and for `docx` that is not merely a shrug: a `.docx`
 * is a paginated-on-open format. There is no page count in the bytes to read (unlike the
 * PDF's `/Type /Page` objects), and recording a number no renderer measured would be a
 * guess in a column the documents list quotes. `null` says "not read", which is true.
 */
async function serialiseInProcess(
  format: ExportFormat | DocxFormat,
  revision: ResumeRevision,
): Promise<ProducedBytes> {
  const dict = projectResumeDict(revision.resumeJson);
  // F4: an EXPLICIT switch, not a nested conditional whose final arm is an implicit `else`.
  // The old shape read `json` as "whatever is left", which is only true while the type is a
  // two-member union - the day a fourth in-process format arrives, the fallback would silently
  // serialise it as JSON. Every arm is named here, and `exhaustive` fails the build on a new
  // member rather than letting it fall through.
  const bytes = await (async (): Promise<Buffer> => {
    switch (format) {
      case 'tex':
        return renderLatexExportBytes(dict);
      case 'docx':
        return renderDocxFromDictionary(dict);
      case 'json':
        return renderJsonExportBytes(revision.resumeJson);
      default:
        return exhaustive(format);
    }
  })();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({
    sha256,
    byteSize: bytes.length,
    mimeType: format === 'docx' ? DOCX_MIME_TYPE : EXPORT_MIME_TYPES[format],
    storageKey: storageKeyFor(sha256),
    pageCount: null,
    inputBytes: bytes.length,
    compileDurationMs: 0,
    stream: (): Readable => Readable.from([bytes]),
  });
}

/**
 * Compile-time exhaustiveness. Calling it is a TYPE error unless its argument is `never`, so
 * adding a format to the union without adding an arm above does not compile.
 */
function exhaustive(value: never): never {
  throw new Error(`unreachable render format: ${String(value)}`);
}

/** The arguments `compilePdf` takes, named so the retry below can pass the SAME ones twice. */
interface CompilePdfArgs {
  deps: { artifacts: ArtifactStore; now: () => number; broker?: RenderBrokerLike; templateId: string };
  record: TemplateRecord;
  revision: ResumeRevision;
  userId: string;
  jobId: string;
}

/**
 * THE ONE BOUNDED COLD-START RETRY, AND WHY IT IS HERE AND NOT ANYWHERE ELSE.
 *
 * The escalation this closes: the FIRST render of a template after a cold container can
 * exceed the broker's 10 s wall clock (`RENDER_LIMITS.wallClockMs`, pinned in `sandbox.ts`
 * and therefore not touchable) because that budget INCLUDES creating the container, and a
 * cold docker daemon spends most of those seconds pulling the image. One live run produced
 * exactly one 503 out of about five compiles, immediately after a rebuild, and the
 * identical request succeeded once warm. So the failure is real and it is a STARTUP
 * artefact, not a property of the document.
 *
 * WHY IT IS SAFE. It fires only on `RENDER_TIMEOUT` - the wall-clock KILL, which the broker
 * answers after TERM -> grace -> KILL and after DISCARDING `/out` (broker `A4.2`). A job that
 * timed out therefore wrote neither bytes nor a row, so the second attempt is not a second
 * write: the whole render is redone from the cache-miss point, `store.put` is
 * content-addressed so identical bytes land on the identical key, and the row is an upsert
 * on `(revisionId, format, templateId)`. There is nothing to clean up because there was
 * nothing written.
 *
 * WHY IT CANNOT MASK A REAL RUNAWAY. Exactly ONE retry, and only for that one code. A
 * genuinely slow compile times out on the first attempt AND on the second, and the second
 * failure is what the caller receives - same code, same status, same machine reason. The
 * cost is that such a document is bounded by two wall clocks rather than one, which is the
 * honest price of not failing a cold user on the first render and is strictly less than
 * doubling any limit.
 *
 * IT IS NOT A BACKOFF AND NOT A LOOP. No delay, no jitter, no counter: a second compile of
 * a cold image that took longer than 10 s will not take less on the next try, and a loop
 * would be an unbounded retry dressed as a bounded one.
 */
const COLD_START_RETRY_CODES: readonly RenderPortErrorCode[] = ['RENDER_TIMEOUT'];

async function compilePdfWithColdStartRetry(
  args: CompilePdfArgs,
  log: (line: string) => void,
): Promise<ProducedBytes> {
  let firstFailure: RenderPortError;
  try {
    return await compilePdf(args);
  } catch (error) {
    const failure = toRenderPortError(error);
    if (!COLD_START_RETRY_CODES.includes(failure.code)) throw failure;
    firstFailure = failure;
  }
  // Policy 10.5's list, and nothing on it is content: no staged bytes, no resume text, no
  // host path, no stderr. `COLD_START_RETRY` is the marker an operator greps for when a
  // render was slow on a cold broker and was not slow afterwards.
  logJob(log, {
    event: 'render.job.retry',
    jobId: args.jobId,
    outcome: 'retry',
    code: 'COLD_START_RETRY',
    engine: args.record.metadata.engine,
    engineVersion:
      args.record.metadata.engine === 'latex'
        ? args.record.metadata.engineVersionPins.latex
        : args.record.metadata.engineVersionPins.typst,
    format: 'pdf',
    templateId: args.deps.templateId,
    templateVersion: args.record.version,
    revisionId: args.revision.id,
    firstAttemptCode: firstFailure.code,
    firstAttemptReason: firstFailure.reason,
  });
  // Not caught: a second refusal is the answer, not something to soften.
  return compilePdf(args);
}

/** The COMPILED producer: the registry's record in, a validated artifact out. */
async function compilePdf(args: CompilePdfArgs): Promise<ProducedBytes> {
  const { deps, record, revision, userId, jobId } = args;
  const broker = deps.broker ?? requireBroker();
  const common = {
    resumeJson: revision.resumeJson,
    record,
    userId,
    revisionId: revision.id,
    jobId,
    // The revision's OWN creation time, in epoch SECONDS. Never a clock read here: a
    // wall clock would be embedded in the PDF and two renders of one revision would
    // differ (policy 7.4, R14), leaving the cache as the only thing keeping the bytes
    // consistent with the `hash` the row records.
    creationTimestampUnix: Math.floor(revision.createdAt.getTime() / 1000),
    revisionPins: revision.enginePins,
  };
  const result = await translateRenderErrors(() =>
    record.metadata.engine === 'latex'
      ? renderLatexDocument({ broker, artifacts: deps.artifacts, now: deps.now }, common)
      : renderTypstDocument({ broker, artifacts: deps.artifacts, now: deps.now }, common),
  );
  return Object.freeze({
    sha256: result.sha256,
    byteSize: result.byteSize,
    mimeType: result.mimeType,
    storageKey: result.storageKey,
    pageCount: result.pageCount,
    inputBytes: result.nearLimit.inputBytes,
    compileDurationMs: result.durationMs,
    stream: (): Readable => Readable.from([result.bytes]),
  });
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

/**
 * Run a phase, translating the CLOSED vocabularies of the modules below into this layer's
 * one error type, and passing a `RenderPortError` through untouched.
 *
 * Three vocabularies meet here, and each is translated rather than re-derived, because
 * each of those modules already has a CLOSED set with FIXED messages (policy 9.3) and a
 * second answer to "which code is this" would be a second place to get it wrong:
 *
 *   - `StageError` (T1013): the staging caps and the tree audit. Its
 *     `RENDER_INPUT_TOO_LARGE` keeps that code; its `RENDER_INPUT_INVALID` keeps that
 *     code; its `RENDER_STAGE_IO` is a HOST fault and becomes
 *     `render_storage_unavailable` (503), never a 422 - "the input was fine" is the whole
 *     meaning of that code.
 *   - `BrokerClientError` / `BrokerUnavailableError` (T1031): the broker's own policy
 *     9.2 outcomes, carried VERBATIM by code, so a reason the operator can read in the
 *     broker's log is the same string at the API boundary. A code this layer does not know
 *     becomes `RENDER_COMPILE_ERROR` (422) rather than a 500: the request is well-formed
 *     and the render did not happen, which is the honest classification even when the
 *     broker reported something new.
 *   - `TemplateRejectionError` (T1040): a template that did not clear its review gate,
 *     including `RENDER_TOOLCHAIN_MISMATCH` - which is a 409, the status the V2 route
 *     already uses for a stored-state disagreement, not a 503.
 *   - `StorageError` (T1032): `render_storage_unavailable` (503), always. A `null` from
 *     `open`/`head` is absence, not a fault, and is handled as a MISS by the cache, so
 *     only a real rejection reaches here. The two STORAGE phases - the cache's `head` probe
 *     (step 5) and the `put` of the produced bytes (step 8a) - are inside
 *     `translateStorageErrors` instead, which maps this one vocabulary and passes everything
 *     else through untouched, so a broken volume is a 503 with a machine code whichever store
 *     call raised it AND a database fault in the same phase is not mistaken for one (T1052).
 *
 * `handleApiError` remains the fallback for anything else, and its 500 is correct but
 * throws away the machine code - which is the whole point of the design.
 */
async function translateRenderErrors<T>(phase: () => Promise<T>): Promise<T> {
  try {
    return await phase();
  } catch (error) {
    throw toRenderPortError(error);
  }
}

/**
 * The name `withStorageErrors` carries at BOTH storage call sites, and there are exactly
 * two: the cache's `store.head` probe and the `store.put` of the produced bytes. Both are
 * inside `translateStorageErrors` because both can raise a `StorageError`, and a `StorageError`
 * that escaped this layer would be the one answer this port never gives - a generic 500 with
 * no machine code, from a module whose whole point is that a caller always gets one.
 *
 * AND IT TRANSLATES THE STORAGE FAULT AND NOTHING ELSE (T1052, the T1043 re-review's N1).
 * This used to be `translateRenderErrors`, which is a translator for the RENDER phase and
 * whose last resort is `RENDER_COMPILE_ERROR` - a 422. Both wrapped calls are storage calls
 * (`head`, `put`), but neither is ONLY a storage call: `lookupCachedDocument` reads the
 * DATABASE first, so a `findFirst` that failed because Postgres is down was reported to the
 * caller as "the render could not be compiled" - 422, a statement about the request, which is
 * the one thing a database outage is not. The wrapper now inspects the rejection: a storage
 * rejection becomes `render_storage_unavailable` (503) and EVERYTHING ELSE propagates
 * untouched, so a database fault keeps its own status (500 from `handleApiError`, or whatever
 * the driver's own error carries) instead of being laundered into a render refusal.
 */
function withStorageErrors<T>(phase: () => Promise<T>): Promise<T> {
  return translateStorageErrors(phase);
}

/**
 * The NARROW translator: `StorageError` (T1032) in, `render_storage_unavailable` out; anything
 * else, re-thrown AS IT CAME. Deliberately not `toRenderPortError` - that function answers
 * "which RENDER refusal is this?", and its generic fallback is a 422 by design because every
 * rejection it can see comes from a compile. Using it here meant a database fault was answered
 * with a render code, which is a category error rather than a status choice.
 */
async function translateStorageErrors<T>(phase: () => Promise<T>): Promise<T> {
  try {
    return await phase();
  } catch (error) {
    if (isStorageRejection(error)) {
      throw new RenderPortError('render_storage_unavailable', storageRejectionReason(error));
    }
    // Not storage. Untouched on purpose: the caller's own error mapping (or
    // `handleApiError`'s 500) is the honest answer for a fault this port does not own.
    throw error;
  }
}

/**
 * Is this rejection one of `storage.ts`'s?
 *
 * `instanceof` OR the `name`, because the class is what a real store throws and the `name` is
 * what a test double (or a second copy of the module in another realm) reports. The duck-typed
 * half is load-bearing for the SAME reason `toRenderPortError` needs it: a test that faked the
 * class rather than importing it would otherwise be testing the generic fallback instead of the
 * storage mapping. Neither half can be reached by a database error, which is the property the
 * narrowing above depends on.
 */
function isStorageRejection(error: unknown): boolean {
  if (error instanceof StorageError) return true;
  return error instanceof Error && error.name === 'StorageError';
}

/** A storage rejection's machine reason, or the fixed fallback when it carries none. */
function storageRejectionReason(error: unknown): string {
  const reason = (error as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : 'IO_ERROR';
}

/**
 * The one translator. Exported so a route (or a test) can classify a rejection it caught
 * from a collaborator without re-deriving the mapping, and so the mapping is a single
 * function rather than a shape repeated in three places.
 */
export function toRenderPortError(error: unknown): RenderPortError {
  if (error instanceof RenderPortError) return error;

  if (error instanceof StageError) {
    if (error.code === 'RENDER_INPUT_TOO_LARGE') {
      return new RenderPortError('RENDER_INPUT_TOO_LARGE', error.reason);
    }
    if (error.code === 'RENDER_INPUT_INVALID') {
      return new RenderPortError('RENDER_INPUT_INVALID', error.reason);
    }
    if (error.code === 'RENDER_ARTIFACT_INVALID') {
      return new RenderPortError('RENDER_ARTIFACT_INVALID', error.reason);
    }
    // `RENDER_STAGE_IO` is a host fault, never a statement about the input.
    return new RenderPortError('render_storage_unavailable', error.reason);
  }

  if (error instanceof TemplateRejectionError) {
    if (error.code === 'RENDER_TOOLCHAIN_MISMATCH') {
      return new RenderPortError('RENDER_TOOLCHAIN_MISMATCH', error.reason);
    }
    if (error.code === 'RENDER_TEMPLATE_SECTION_UNKNOWN') {
      return new RenderPortError('render_template_unsupported', error.reason);
    }
    return new RenderPortError('render_template_unsupported', error.reason);
  }

  if (error instanceof Error) {
    const name = error.name;
    if (name === 'BrokerUnavailableError') {
      return new RenderPortError('render_broker_unavailable', 'BROKER_UNREACHABLE');
    }
    if (name === 'BrokerClientError') {
      const code = (error as { code?: unknown }).code;
      const reason = (error as { reason?: unknown }).reason;
      const codeText = typeof code === 'string' ? code : 'BROKER_REFUSED';
      const reasonText = typeof reason === 'string' ? reason : 'UNKNOWN';
      if (codeText === 'RENDER_BUSY') return new RenderPortError('RENDER_BUSY', reasonText);
      if (codeText === 'RENDER_TIMEOUT') return new RenderPortError('RENDER_TIMEOUT', reasonText);
      if (codeText === 'RENDER_RESOURCE_LIMIT') {
        return new RenderPortError('RENDER_RESOURCE_LIMIT', reasonText);
      }
      if (codeText === 'RENDER_ARTIFACT_INVALID') {
        return new RenderPortError('RENDER_ARTIFACT_INVALID', reasonText);
      }
      if (codeText === 'RENDER_COMPILE_ERROR') {
        return new RenderPortError('RENDER_COMPILE_ERROR', reasonText);
      }
      if (codeText === 'RENDER_TOOLCHAIN_MISMATCH') {
        return new RenderPortError('RENDER_TOOLCHAIN_MISMATCH', reasonText);
      }
      // A transport-contract rejection (`RENDER_BROKER_CONTRACT`, a malformed error body)
      // and any code this build does not know both mean the same thing here: the render
      // did not happen and the broker is the component that says so.
      return new RenderPortError('RENDER_COMPILE_ERROR', reasonText);
    }
    if (isStorageRejection(error)) {
      return new RenderPortError('render_storage_unavailable', storageRejectionReason(error));
    }
    if (isToolchainMismatch(error)) {
      return new RenderPortError('RENDER_TOOLCHAIN_MISMATCH', 'ENGINE_PIN_MISMATCH');
    }
  }

  // Not one of ours. `handleApiError` answers 500 with a generic message; the port's own
  // contract is that every rejection carries a code, so the honest last resort is the
  // generic RENDER failure with the class name as the server-side reason.
  return new RenderPortError('RENDER_COMPILE_ERROR', `UNEXPECTED:${(error as { name?: string })?.name ?? 'unknown'}`);
}

/**
 * `sandbox.ts` refuses a pin disagreement by THROWING a plain `Error` whose message starts
 * with the code, rather than with a typed error of its own - that module is pure data and
 * pure functions with no error class of its own. Matching on the PREFIX (not on the whole
 * message) is the only way to recover the code, and a message that merely CONTAINS
 * `RENDER_TOOLCHAIN_MISMATCH` is exactly the shape `sandbox.ts` produces.
 */
function isToolchainMismatch(error: Error): boolean {
  return error.message.startsWith('RENDER_TOOLCHAIN_MISMATCH');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * The template a `pdf` render uses, or a machine refusal: the registry's own, the RESERVED-id
 * one, or an unknown engine.
 *
 * POLICY REVERSAL (owner decision, 2026-10-31): a template declaring `engine: 'latex'` is
 * now RENDERED by the LaTeX producer, not refused. The refusal that remains is for an
 * engine value this build does not implement - never a silent degrade onto Typst, which is
 * the failure `resolveTemplateForRender`'s contract forbids ("every failure mode is a
 * rejection rather than a substitute"). The check is still at step 4, before the cache
 * lookup, before staging and before any broker call.
 */
function resolveRecord(registry: TemplateRegistry, templateId: string): TemplateRecord {
  if ((TEMPLATE_RESERVED_IDS as readonly string[]).includes(templateId)) {
    // A caller that named a RESERVED id is asking for a row whose `templateId` would mean
    // two things, so it is refused here rather than resolved to the default template.
    throw new RenderPortError('render_template_unsupported', 'TEMPLATE_ID_RESERVED');
  }
  let record: TemplateRecord;
  try {
    // A LEGACY id is a layout name the old builder wrote, not a registry id. Mapping it
    // here (and only here, where a render is about to happen) is what keeps a resume
    // created before the cutover renderable without teaching the registry a second
    // namespace. A registry id is never in the map, so it passes through untouched; an
    // unknown id is still refused by `resolveTemplateForRender`.
    const resolvedId = isLegacyTemplateId(templateId) ? canonicalTemplateId(templateId) : templateId;
    record = resolveTemplateForRender(registry, { templateId: resolvedId, format: 'pdf' });
  } catch (error) {
    throw toRenderPortError(error);
  }
  // Defence in depth for an injected registry: the shipped schema already narrows the
  // engine to `RENDER_ENGINES`, but a test double (or a future loader change) could hand
  // this port anything. An unknown engine is refused, never rendered by the default.
  if (!(RENDER_ENGINES as readonly string[]).includes(record.metadata.engine)) {
    throw new RenderPortError('render_template_unsupported', 'ENGINE_UNSUPPORTED');
  }
  return record;
}

/** The broker client from the environment, or a machine-readable refusal. */
function requireBroker(): RenderBrokerLike {
  const endpoint = brokerEndpoint();
  if (endpoint === null) {
    // No shared secret, or neither a socket nor a URL: there is no renderer to ask. A 503
    // with a reason that names the CONFIGURATION rather than the user, because nothing
    // about this request can fix it.
    throw new RenderPortError('render_broker_unavailable', 'BROKER_NOT_CONFIGURED');
  }
  // Wrapped rather than `.bind`: `bind` widens the return to a bare function type, which
  // loses the `Pick<RenderBrokerClient, 'render'>` shape the port declares. The closure
  // keeps it, and it is the same object either way - one client, one config, one timeout.
  const client = new RenderBrokerClient({
    endpoint,
    timeoutMs: resolveRenderBudget().clientTimeoutMs,
  });
  return {
    render: (spec: Parameters<RenderBrokerLike['render']>[0], tree: Parameters<RenderBrokerLike['render']>[1]) =>
      client.render(spec, tree),
  };
}

/**
 * The `engineVersion` a row is written with: the policy's pinned toolchain for a `pdf`
 * render, an ENGINE sentinel for the three in-process serialisers, each folded with the
 * revision's own `enginePins` so a pin change invalidates the cache exactly as a toolchain
 * bump does (policy 10.4).
 *
 * The sentinel is the engine's own name rather than an empty string, because an empty
 * `engineVersion` would collide with any row written by something that left it blank, and a
 * collision on a cache key is how a stale artifact gets served. `DOCX_ENGINE` is the
 * DOCX renderer's name, so a future DOCX library bump is a one-line change here rather than
 * a cache key that quietly stopped discriminating.
 */
function engineVersionFor(
  format: PortFormat,
  revision: ResumeRevision,
  engine: RenderEngine | undefined,
): string {
  if (format === 'tex') return renderEngineVersion('latex-export', revision.enginePins);
  if (format === 'json') return renderEngineVersion('json-export', revision.enginePins);
  if (format === 'docx') return renderEngineVersion(DOCX_ENGINE, revision.enginePins);
  // A compiled PDF's engine is the template's own declared engine, so a LaTeX render and a
  // Typst render of the same revision are different cache entries even if the template
  // version string happened to collide.
  const version = engine === 'latex' ? LATEX_PIN.version : TYPST_PIN.version;
  return renderEngineVersion(version, revision.enginePins);
}

/** One structured line per job. Never staged content, never a path, never stderr. */
function logJob(log: (line: string) => void, record: Record<string, unknown>): void {
  log(JSON.stringify(record));
}

function defaultLogger(line: string): void {
  console.error(line);
}

// ---------------------------------------------------------------------------
// Compile-time evidence that the real client satisfies the port's seam
// ---------------------------------------------------------------------------
// Nothing runs these lines; `npx tsc --noEmit` does. They exist because a port that needs a
// cast to hand `prisma` to itself means the seam and the schema have drifted, and the
// drift should be a build failure rather than an `as unknown as` in production.
// The two things a `RenderPortDb` cast hides, checked separately and honestly.
//
// `RenderCacheStore` cannot be asserted in one line, and the reason is Prisma's generics:
// its `findFirst`/`upsert` return type is computed FROM the `select` argument, so a
// `Promise<CachedDocumentRow | null>` signature is not literally satisfied even when every
// selected column is present. So the check is split into the three facts that actually
// matter - the two methods exist and accept a loosely typed argument, the real client
// satisfies the two seam types the BELT reads through - and the ROW SHAPE is pinned by a
// separate assertion on the model type, which is where a missing column would show up.
const SEAM_CACHE_FIND: RenderPortDb['resumeDocument'] extends {
  findFirst(args: unknown): Promise<unknown>;
} ? true : false = true;
const SEAM_CACHE_UPSERT: RenderPortDb['resumeDocument'] extends {
  upsert(args: unknown): Promise<unknown>;
} ? true : false = true;
const SEAM_REVISION: typeof prisma extends ResumeRevisionStore ? true : false = true;
const SEAM_USAGE: typeof prisma extends ResumeClaimUsageStore ? true : false = true;

/** Every `CachedDocumentRow` member exists on the model, with a compatible type. */
type RowIsPresent = Pick<
  ResumeDocument,
  | 'id' | 'revisionId' | 'format' | 'templateId' | 'templateVersion' | 'engineVersion'
  | 'pageCount' | 'hash' | 'storageKey' | 'byteSize' | 'mimeType' | 'createdAt'
>;
const SEAM_ROW: RowIsPresent extends CachedDocumentRow ? true : false = true;

void [SEAM_CACHE_FIND, SEAM_CACHE_UPSERT, SEAM_REVISION, SEAM_USAGE, SEAM_ROW];

/** The broker client type, re-exported so a caller constructing a port needs one import. */
export type { RenderBrokerClient };

// Re-exported so a caller of the port does not need a second import for the one thing it
// has to name: the content type of the artifact it is about to be handed.
export { requestMimeType, STAGE_REJECTION_CODES };
