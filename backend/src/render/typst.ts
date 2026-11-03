// The Typst renderer: a staged tree in, a validated artifact out. No HTTP, no database,
// no Express - the port owns the boundary, this module owns the pipeline.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md 6.3 (artifact
//                 validation), 6.4 (metadata only, bytes to the storage abstraction),
//                 7.4 (reproducibility: the PDF creation timestamp is pinned), 9.2/9.3/9.4
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 3 (the
//                 broker steps), sec. 5 (the shared dictionary), sec. 7 (the path)
//                 .planning/decisions/ADR-042-*.md D2 (the backend never touches Docker)
//                 .planning/decisions/ADR-044-*.md D1 (transport), D2 (content addressing)
// Task:         T1043
//
// =====================================================================================
// ARTIFACT VALIDATION - WHAT THIS MODULE RE-CHECKS, AND WHY IT DOES NOT SPOOL `/out`
// =====================================================================================
//
// The contract's path says this module calls `validateRenderArtifact({outDir: the
// broker's spooled /out})`. It does NOT, and the reason is that this module has no `/out`:
// the `/out` tmpfs is inside the job CONTAINER, and the bytes arrive here over the wire.
// Re-implementing the validation against a host spool here would mean materialising a
// SECOND copy of the artifact on the host - a write the staging layer exists to remove
// (policy 3.1, ADR-042 D4) and that the broker already performed once. So the work is
// split, and each half is done once, by the component that can actually do it:
//
//   1. INSIDE THE BROKER, against the real `/out` (policy 6.3, all six checks plus the
//      link count): exactly one entry in the output dir, a regular unhardlinked
//      non-symlink `artifact.pdf`, `realpath` contained in the output dir, size under the
//      cap, and the `%PDF-` magic. `validateRenderArtifact` is T1013's module, unmodified;
//      the broker calls it on its own bounded spool and answers
//      `RENDER_ARTIFACT_INVALID` with a machine reason if any check fails. Nothing about
//      the artifact is streamed back to a caller that has not passed that gate.
//
//   2. ON THE WIRE, in `brokerClient.ts` (T1031, unmodified): the declared byte length
//      equals the body actually received, the body is non-empty and within the cap, the
//      leading bytes match the format's magic, and the digest header is a well-formed
//      sha256. That is the client refusing to report success on a status code alone.
//
//   3. HERE, immediately before `store.put` - the checks this module adds, and the only
//      ones the two halves above do not make:
//
//      a. SIZE  - `result.byteSize` equals the length of the buffer this module is about
//         to hand the store, re-read from the buffer rather than trusted from a header.
//      b. SHA256 - the digest this module COMPUTES over those exact bytes equals the
//         digest the broker DECLARED (`x-clearance-sha256`, carried on
//         `RenderResult.sha256`).
//      c. MAGIC - the leading bytes match the format's magic, re-checked here.
//      d. CAP - the byte length is within `RENDER_LIMITS.outputBytes`.
//
// (b) is not redundant with anything, and it is the one real gap the chain had:
//
// `brokerClient.render` verifies that the `x-clearance-sha256` header is a well-formed
// digest, but it never compares that header against the BODY it received. So a broker (or
// anything that could answer on that socket) could declare digest X and return bytes that
// hash to Y, and the client would hand back `sha256: X` with the wrong bytes attached. The
// fs storage port happens to catch it - `put` re-computes the digest while streaming and
// throws `STORAGE_HASH_MISMATCH` - but it catches it as a HOST FAULT, so the API would
// answer `STORAGE_IO`/500-class instead of `RENDER_ARTIFACT_INVALID`/503, and the row's
// `hash` would be a digest that never described the bytes at its key. `brokerClient.ts`
// is a T1031 module that has been reviewed twice and is outside this task's change list,
// and the check is required here anyway by the contract, so it lives here: the smallest
// place available to me, in the last component before `store.put`, with the right code.
// `renderPort.test.ts` pins it (`M-b` in the note's mutation table drops it and the
// store's own guard is what starts reporting the failure).
//
// WHAT THIS MODULE DOES NOT DO, EXPLICITLY. It does not create a container, does not
// import a Docker client, does not `child_process`, does not read a clock except the one
// value the caller passes as `creationTimestampUnix`, and does not decide what a template
// is - `templates.ts` already reviewed it, and this module only carries out the plan.
// =====================================================================================

import { createHash } from 'node:crypto';

import {
  buildJobSpec,
  type RenderBrokerClient,
  type RenderJobSpec,
} from './brokerClient.js';
import { openStageTreeStream, type StageTree } from './stage.js';
import { dictToDataJson, projectResumeDict, type ResumeDict } from './dict.js';
import { RENDER_LIMITS, buildCompileArgs, type CompilePlan } from './sandbox.js';
import { stageRenderJobInMemory } from './stage.js';
import { storageKeyFor, type ArtifactStore } from './storage.js';
import { TEMPLATE_RESERVED_IDS, type TemplateRecord } from './templates.js';
import { RenderPortError, requestMimeType } from './types.js';

// ---------------------------------------------------------------------------
// The magic bytes, one more time
// ---------------------------------------------------------------------------

/**
 * `%PDF-` for a PDF. A CONTENT check, matching policy 6.3.6 and the broker's own, and a
 * FORK of `stage.ts`'s private table rather than a shared helper: that table is bound to
 * `stage.ts`'s three `RenderFormat`s AND its `RENDER_ARTIFACT_INVALID` vocabulary, and
 * exporting it would widen a do-not-touch module's surface to serve one caller that needs
 * exactly one of the three. The value is five bytes; the duplication is bounded and
 * `renderPort.test.ts` asserts a bad-magic artifact is refused with
 * `RENDER_ARTIFACT_INVALID`, which is the property that matters.
 */
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

// (The magic check below is bounded by the magic itself - five bytes for `%PDF-`. The 512-byte
// `MAGIC_WINDOW` this module used to declare was only ever a bound for the PAGE COUNT's scan,
// and deleting that scan is what made the constant dead; see `countPdfPages`.)

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export interface TypstRenderInput {
  /** The immutable snapshot's document. Projected through the ONE shared dictionary. */
  readonly resumeJson: unknown;
  /** The reviewed template record (`templates.ts`), already resolved by the port. */
  readonly record: TemplateRecord;
  /** Admission only. Never argv, never env, never a container name (ADR-044 D1). */
  readonly userId: string;
  readonly revisionId: string;
  readonly jobId: string;
  /**
   * The pinned PDF creation timestamp, UNIX epoch SECONDS.
   *
   * REQUIRED and never a wall clock read here. Typst's `pdf_options` falls back to
   * `chrono::Local::now()`, which is embedded in the PDF, so a render that read the clock
   * would never be byte-identical to a second render of the same revision - and the
   * determinism cache would then be the only thing standing between a user and a document
   * whose bytes differ from the `hash` the row records. The port passes the revision's own
   * `createdAt`, which is immutable, so the same revision always compiles to the same
   * bytes. This is policy 7.4 / risk R14.
   */
  readonly creationTimestampUnix: number;
  /** The revision's own `enginePins`, folded into the cache key by `renderPort.ts`. */
  readonly revisionPins: unknown;
  /** A pre-projected dictionary, when the caller already has one. Test seam + reuse. */
  readonly dict?: ResumeDict;
}

export interface TypstRenderOutput {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly engineVersion: string;
  readonly templateVersion: string;
  /** The storage key the bytes must be stored under. Derived from the digest, nothing else. */
  readonly storageKey: string;
  /** The page count read from the PDF, or `null` when the bytes do not answer (see below). */
  readonly pageCount: number | null;
  /** Compile + transport duration, milliseconds. The job log's `durationMs`. */
  readonly durationMs: number;
  /** Policy 10.5's "whether the input caps were near their limits", as fractions. */
  readonly nearLimit: {
    readonly inputBytes: number;
    readonly inputTotalBytes: number;
    readonly outputBytes: number;
  };
  /** The staged tree, for a test that wants to prove what was sent. Never logged. */
  readonly tree: StageTree;
  /** The plan the broker enforced. For the job log's pinned version. */
  readonly plan: CompilePlan;
}

// ---------------------------------------------------------------------------
// The page count
// ---------------------------------------------------------------------------

/**
 * The page count read from a PDF, or `null` when the bytes do not answer.
 *
 * DELIBERATELY CONSERVATIVE, and it returns `null` rather than a guess because the column
 * is metadata a UI can show and a record nobody should be able to be wrong about. A
 * typst-produced PDF carries plain `/Type /Page` objects, so the common case is exact; a
 * producer that compresses its objects into an object stream (PDF 1.5+) hides them, and
 * then this returns `null` and the row records `null`. A wrong number is worse than none:
 * it would be persisted, listed, and quoted.
 *
 * THE WHOLE BUFFER IS SCANNED (defect round, finding F2). This used to read only the first
 * `MAGIC_WINDOW * 64` bytes - 32,768 - and returned `null` for anything longer, on the
 * theory that a page tree past the window means a compressed producer. That theory was
 * wrong about real documents: the three live resume renders are 27,863 / 32,920 / 34,789
 * bytes, so `pageCount` was `null` for two of the three templates and every real resume was
 * missing the one number the Studio's "N pages" caption shows. The bytes are already in
 * memory and already bounded (`RENDER_LIMITS.outputBytes`, 20 MiB - enforced twice by the
 * broker and re-checked in `assertArtifactBytes` below), so the window bought nothing and
 * cost the answer.
 *
 * WHY PAGE OBJECTS AND NOT THE PAGE TREE'S `/Count`. Both are supported by the format, and
 * `/Count` is the one a producer fills in honestly, but `/Count` also appears in outline
 * and named-destination dictionaries, so reading it "robustly" means parsing a dictionary
 * grammar - a second implementation of PDF syntax in a module whose job is to avoid being
 * one. Counting `/Type /Page` objects needs one anchored token and a negative lookahead
 * that excludes `/Pages` (the tree ROOT), which is a rule this module can state in one
 * line and a test can pin. The residual risk - a content stream whose compressed bytes
 * happen to spell `/Type /Page` - is the exposure the original implementation already had,
 * and the `count === 0 -> null` policy still declines rather than guessing.
 *
 * THE PAGE GEOMETRY IS NOT DECIDED HERE. There is no MediaBox/A4 check in this module and
 * there never was one: page geometry is asserted on the produced artifact itself (the live
 * proof reads `/MediaBox` out of the stored bytes), and `assertArtifactBytes` re-checks the
 * `%PDF-` magic on the same buffer this scans. Neither depends on a scan window, so
 * widening this scan changes nothing about what either of them accepts.
 */
export function countPdfPages(bytes: Buffer): number | null {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  // latin1 keeps one byte per byte, so a byte offset is a character offset and the
  // substring comparison cannot be thrown off by a multi-byte sequence.
  const text = bytes.toString('latin1');
  const pattern = /\/Type\s*\/Page(?![A-Za-z])/g;
  let count = 0;
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) break;
    count += 1;
  }
  return count === 0 ? null : count;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** The two collaborators, injected so a test needs no daemon, no socket and no files. */
export interface TypstRenderDeps {
  readonly broker: Pick<RenderBrokerClient, 'render'>;
  readonly artifacts: ArtifactStore;
  readonly now?: () => number;
}

/**
 * Stage, compile through the broker, and re-validate what came back.
 *
 * The order is the contract's and it is also the order in which the guarantees become
 * true, so it is worth stating once:
 *
 *   1. build the COMPILE PLAN first, so an engine-pin disagreement is refused before any
 *      byte is staged (the template's `engineVersionPins.typst` against the pinned
 *      toolchain - `RENDER_TOOLCHAIN_MISMATCH`, no template read, no tree, no socket);
 *   2. project the document through the ONE shared dictionary and serialise `data.json`
 *      canonically, so two renders of one revision stage byte-identical input;
 *   3. stage IN MEMORY (ADR-042 D4: `/work` is a tmpfs and never a host directory), with
 *      `dataBytes` so the adapter's payload never needs a host temp file;
 *   4. build the JobSpec from the staged tree's real byte and file counts, so a
 *      mis-declared size is impossible by construction;
 *   5. render through the broker, which admits, creates, stages, compiles, extracts,
 *      validates and destroys - none of it visible here;
 *   6. RE-VALIDATE the received bytes (size, digest, magic, cap) and derive the
 *      content-addressed key.
 *
 * Step 6 happens BEFORE the caller can store anything, so a bad artifact cannot reach the
 * store even as an orphan blob.
 */
export async function renderTypstDocument(
  deps: TypstRenderDeps,
  input: TypstRenderInput,
): Promise<TypstRenderOutput> {
  if (deps === null || typeof deps !== 'object' || deps.broker === undefined || deps.artifacts === undefined) {
    throw new TypeError('renderTypstDocument: a broker and an artifact store are required');
  }
  if (input === null || typeof input !== 'object') {
    throw new TypeError('renderTypstDocument: a render input is required');
  }
  if ((TEMPLATE_RESERVED_IDS as readonly string[]).includes(input.record.id)) {
    // A reserved id means "no template" (ruling 4), so a `TemplateRecord` carrying one is
    // a caller bug, and rendering it would file a row whose templateId means two things.
    throw new TypeError('renderTypstDocument: a reserved template id cannot be rendered as a template');
  }

  // 1. The plan. Pure, no I/O: a pin disagreement costs nothing.
  const plan = buildCompileArgs('typst', {
    creationTimestampUnix: input.creationTimestampUnix,
    expectedEngineVersion: input.record.metadata.engineVersionPins.typst,
    format: 'pdf',
  });

  // 2. The ONE projection, then the canonical bytes. `dictToDataJson` is the same
  //    serialiser the revision hash was taken over, so the staged input is canonical.
  const dict = input.dict ?? projectResumeDict(input.resumeJson);
  const dataBytes = dictToDataJson(dict);

  // 3. In-memory staging, with the adapter's payload supplied as bytes.
  const tree = await stageRenderJobInMemory({
    engine: 'typst',
    template: { path: input.record.templatePath },
    dataBytes,
    assets: input.record.assets.map((name) => ({ name, source: { path: name } })),
    sourceRoot: input.record.dir,
  });

  // 4. The JobSpec, with the tree's REAL numbers.
  //
  //    `treeBytes` is the length of the ustar ARCHIVE, not `tree.totalBytes` (the sum of the
  //    FILE bytes). The two differ by a 512-byte header per entry, per-file padding to 512,
  //    the `.pkgcache` directory entry, two zero blocks and the 10240-byte record pad - so
  //    passing `totalBytes` here is a `RENDER_INPUT_INVALID` from the client, on every job,
  //    and a real container is never created. The length is MEASURED through the same
  //    `openStageTreeStream` the client will frame from rather than computed with an
  //    arithmetic copy of the format's rules, because a second implementation of the tar
  //    layout is a second thing to get wrong, and this one has to match the emitter exactly.
  //
  //    The measurement is bounded by the staging caps (5 files / 8 MiB) plus 512 bytes of
  //    header per entry, so this is a bounded copy of an already-validated tree.
  const treeBytes = await measureArchiveBytes(tree);
  const spec: RenderJobSpec = buildJobSpec({
    jobId: input.jobId,
    templateId: input.record.id,
    templateVersion: input.record.version,
    creationTimestampUnix: input.creationTimestampUnix,
    userId: input.userId,
    revisionId: input.revisionId,
    format: 'pdf',
    treeBytes,
    treeFileCount: tree.files.length,
  });
  if (spec.expectedEngineVersion !== plan.engineVersion) {
    // The spec's pin is derived from its own `buildCompileArgs` call and the plan's from
    // this one, so this cannot differ - which is exactly why it is checked: if a future
    // edit ever made the two builders disagree, the wire and the enforced plan would be
    // different documents of the same job, and the broker would enforce one of them.
    throw new RenderPortError('RENDER_TOOLCHAIN_MISMATCH', 'PLAN_AND_SPEC_DISAGREE');
  }

  // 5. The broker: admit, create, stage, compile, extract, validate, destroy.
  const started = deps.now === undefined ? Date.now() : deps.now();
  const result = await deps.broker.render(spec, tree);
  const durationMs = (deps.now === undefined ? Date.now() : deps.now()) - started;

  // 6. Re-validate the RECEIVED bytes before anything can store them.
  const mimeType = requestMimeType('pdf');
  assertArtifactBytes(result.artifact, result.byteSize, result.sha256, mimeType);
  const sha256 = result.sha256;

  return Object.freeze({
    bytes: result.artifact,
    sha256,
    byteSize: result.artifact.length,
    mimeType,
    engineVersion: plan.engineVersion,
    templateVersion: input.record.version,
    storageKey: storageKeyFor(sha256),
    pageCount: countPdfPages(result.artifact),
    durationMs,
    nearLimit: {
      inputBytes: tree.totalBytes,
      inputTotalBytes: RENDER_LIMITS.inputTotalBytes,
      outputBytes: result.artifact.length,
    },
    tree,
    plan,
  });
}

/**
 * The byte length of a staged tree's ustar archive, measured by draining the SAME emitter
 * the client will frame from.
 *
 * Refuses to report a length the stager could not have produced, so a caller that somehow
 * handed over a tree larger than the policy allows gets a refusal here rather than a
 * declaration the broker would have to diagnose from a frame that never arrives.
 */
export async function measureArchiveBytes(tree: StageTree): Promise<number> {
  let total = 0;
  for await (const chunk of openStageTreeStream(tree)) {
    total += (chunk as Buffer).length;
  }
  // A bound the stager already enforced, re-asserted because this number goes on the WIRE:
  // the archive adds headers and padding to the file bytes, so the two caps are not the same
  // number and the archive's is the one that has to hold.
  const cap = RENDER_LIMITS.inputTotalBytes + (tree.files.length + 1) * 512 + 2 * 512 + 10 * 512;
  if (total > cap) {
    throw new RenderPortError('RENDER_INPUT_TOO_LARGE', 'TOTAL_TOO_LARGE');
  }
  return total;
}

/**
 * The four checks this module owns (the header states the whole split). Every rejection is
 * `RENDER_ARTIFACT_INVALID` - policy 9.2's "any section 6.3 check failed", reported as a
 * generic failure and never as the check's raw text - and the message is the fixed string
 * that `types.ts` looks up, so a digest, a length or a byte never reaches a response.
 *
 * The checks are in the order that produces the most useful reason on a broker that is
 * behaving badly in a specific way, and the SIZE check comes first because it is the one
 * that means "the wire lied about its own framing".
 */
export function assertArtifactBytes(
  bytes: Buffer,
  declaredByteSize: number,
  declaredSha256: string,
  mimeType: string,
): void {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new RenderPortError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_EMPTY');
  }
  // a. SIZE, re-read from the buffer rather than trusted from the header.
  if (declaredByteSize !== bytes.length) {
    throw new RenderPortError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_SIZE_CHANGED');
  }
  // d. CAP. Strictly the same number the broker enforced twice and the store enforces a
  //    third time; a fourth place is cheap and a fourth disagreement is loud.
  if (bytes.length > RENDER_LIMITS.outputBytes) {
    throw new RenderPortError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_TOO_LARGE');
  }
  // b. SHA256 over the bytes this module is about to store. See the header: the client
  //    checks that the digest is well-formed, not that it describes the body.
  const computed = createHash('sha256').update(bytes).digest('hex');
  if (computed !== declaredSha256) {
    throw new RenderPortError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_DIGEST_MISMATCH');
  }
  // c. MAGIC. `application/pdf` is the only content type that reaches here (the exports
  //    never pass through this module), and a content type is not a format: the check is
  //    on the bytes.
  if (!matchesMime(bytes, mimeType)) {
    throw new RenderPortError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_BAD_MAGIC');
  }
}

/**
 * Does a bounded prefix of `bytes` carry the magic of `mimeType`?
 *
 * One media type today (`application/pdf`), and a value outside it is a refusal rather
 * than a permissive "no opinion": an unrecognised content type means the caller's tables
 * disagree, and treating that as "check nothing" is how a content check quietly stops being
 * one.
 */
function matchesMime(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === 'application/pdf') {
    return bytes.length >= PDF_MAGIC.length && bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
  }
  return false;
}
