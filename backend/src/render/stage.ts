// Render staging + artifact validation - the control that actually contains typst.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md
//                 sections 3.3 (M3, the lstat mandate), 5 (input handling),
//                 6.3 (artifact validation), 9.4 (error surface), 10.1 (cleanup).
// Task:         T1013
//
// WHY THIS MODULE IS LOAD-BEARING (measured, T1005):
//   typst 0.15.1 FOLLOWS a symlink planted inside its `--root` and renders the
//   target's content into the PDF. typst/typst issue #5454 is still open. The spike
//   proved it by byte-identity: rendering a symlink to a canary file outside the
//   root produced a PDF byte-identical to rendering a regular file with the same
//   content. A literal `read("../etc/passwd")` IS correctly refused, so `--root`
//   contains `..` but not a symlink - and that asymmetry is the bug.
//   Consequence: `--root` is NOT a containment boundary. This module is. Until it
//   existed, a symlink reaching the work dir was an arbitrary read of the image.
//
// WHAT IT GUARANTEES, in the order the guards run:
//   1. NAMES      - only policy-fixed names (`template.typ` / `artifact.tex`,
//                   `data.json`) plus `metadata.json`-declared asset basenames.
//                   Each name goes through `assertSafeStageName()` (sandbox.ts), so
//                   no separator, no `..`, no absolute path, no leading dash/dot,
//                   no control byte, nothing outside `[A-Za-z0-9._-]`, <= 64 chars.
//   2. TYPE       - `lstat` (never `stat`) on every entry. Only a regular file with
//                   `nlink === 1` is accepted. Symlinks, hardlinks, FIFOs, sockets,
//                   block and character devices are refused. This is the guard that
//                   closes #5454; the name allowlist alone would not, because a
//                   symlink can be NAMED `data.json`.
//   3. CONTAINMENT - every staged path must resolve inside the staging root, and
//                   after `realpath` still resolve inside it, so neither `..` nor a
//                   symlinked parent can move the target.
//   4. SIZE       - declared bytes, then `lstat` size, then the actual streamed
//                   byte count MID-STREAM, then a per-JOB running total, then the
//                   size of the finished copy. The mid-stream pair is the only thing
//                   that stops bytes landing before a rejection, so it is checked
//                   BEFORE the bytes are handed to their sink and is NOT redundant
//                   with any later check.
//   5. MINIMALITY - the staged tree is exactly the declared files plus the empty
//                   redirected package cache directory. Nothing else. The result is
//                   re-audited with `lstat` after staging (directory mode) or
//                   re-walked over the buffers (in-memory mode), so the post-condition
//                   is proven rather than assumed.
//
// VALIDATE-THEN-COPY (and why, not copy-then-validate):
//   `copy-then-validate` would `open()` the source BEFORE knowing what it is, and
//   `open()` on POSIX FOLLOWS a symlink. That is precisely the arbitrary read this
//   module exists to prevent, so the order is fixed: `lstat` the source, prove it
//   is a regular unhardlinked file of an allowed size, THEN open it, then prove the
//   opened descriptor is the SAME file (`fstat` identity vs the `lstat`), then copy
//   under a hard byte budget. The destination is created with `O_EXCL`, so a
//   symlink pre-planted at the destination path cannot be written through either.
//   After the copy the destination is `lstat`ed again (regular, `nlink === 1`,
//   size == bytes written).
//   NO I/O AGAINST THE UNTRUSTED TREE AFTER VALIDATION: once `auditStageRoot()`
//   has passed, this module performs no further read of the staged content. It
//   hands the worker the paths and stops. The single exception is the bounded copy
//   described above, which is validation-driven I/O by construction.
//
// FAIL CLOSED, and the error surface (policy 9.3 / 9.4):
//   Every rejection is a `StageError` carrying a machine-readable `code` and a
//   `reason` from a CLOSED set. The message is a fixed string per reason: no caller
//   data, no basename, no host path, no staged content is ever interpolated. A
//   caller that needs to know WHICH file failed logs the `reason` server-side
//   (`logSecurityEvent`, policy 9.2) and shows the generic message to the user.
//   `RENDER_INPUT_INVALID` / `RENDER_INPUT_TOO_LARGE` / `RENDER_ARTIFACT_INVALID` are
//   the policy's own codes (9.2, 5.2.2, 6.3). `RENDER_STAGE_IO` is a host fault, not
//   a security outcome: the caller maps it to a generic failure and it is never
//   treated as "the input was fine".
//
// MECHANISM-AGNOSTIC ON PURPOSE, AND IT NEVER TOUCHES THE HOST FILESYSTEM
// (T1005 OI-1 for the transport; ADR-042 D4 for the filesystem):
//   `docker cp` is unusable against this container contract - both into a running
//   container (`container rootfs is marked read-only`) and out of one - so this module
//   never talks to docker. Policy 3.1 and 4.4 mandate that `/work` is a TMPFS and never
//   a host directory, and the broker (ADR-042 D2/D4) therefore creates the container
//   with `/work` as a tmpfs and streams the staged tree INTO it. So:
//     - PRODUCTION PATH - `stageRenderJobInMemory()` builds the whole validated tree in
//       memory, bounded by the existing caps (5 files / 8 MiB total), and
//       `openStageTreeStream()` emits it as a ustar stream the broker pipes into the
//       container's tmpfs (`docker exec -i <c> tar -x -C /work`). NO HOST PATH IS EVER
//       WRITTEN, so an attacker-influenced write has nothing on the host to reach.
//     - DIRECTORY MODE - `stageRenderJob()` still fills a real directory, because
//       policy 3.3's lstat walk (`auditStageRoot`) has to be callable on a REAL
//       directory (an entrypoint-prepared `/work`, a root a broker hands over) and
//       because the disk-copy guard ordering needs a test surface. It is NOT the
//       production ingestion path; a caller that filled a host directory and bind-
//       mounted it at `/work` would contradict 3.1 and lose the kernel `size=32m` bound.
//     - ARTIFACT SIDE - `validateRenderArtifact()` inspects a directory the broker
//       materialised from `/out` (a named volume, an exec-based `tar` over stdout -
//       whatever the broker settled on) and returns a validated handle + digest;
//       `openArtifactStream()` hands the bytes to the storage port as a stream, so
//       nothing has to be materialised twice. This is the broker's own storage, not a
//       container mount, so the tmpfs rule does not apply to it.
//   The BROKER INTEGRATION POINT is therefore two module calls, no bind mount:
//     1. broker: `stageRenderJobInMemory({...})`, then pipe
//        `openStageTreeStream(tree)` into `docker exec -i <c> tar -x -C /work`;
//     2. broker: materialise `/out` however it chose, call
//        `validateRenderArtifact({ outDir, format })`, then pipe
//        `openArtifactStream()` into storage (policy 6.4, ADR-041 D2).
//   Which guarantee binds where: the NAME, TYPE, CONTAINMENT, SIZE and MINIMALITY
//   guards are properties of the TREE and hold in both modes, because both modes share
//   one source validator and one mid-stream byte budget. The DISK-COPY guards
//   (`O_EXCL` on the destination, the post-copy `lstat`, the cleanup-on-failure path)
//   bind only in directory mode, because in-memory mode has no destination path, no
//   partial tree and nothing to clean up. `O_EXCL` is load-bearing in directory mode
//   (two concurrent jobs on one root: the second must fail, not truncate the first's
//   bytes) and is pinned by a regression test; see the progress note.
//
// NOT IN SCOPE HERE: diagnostics redaction (policy 9.4, T1040), container creation
// and the compile itself (`buildCompileArgs` in sandbox.ts), and persistence
// (the storage port, OI-4).

import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import * as path from 'node:path';

import {
  RENDER_LIMITS,
  RENDER_PATHS,
  RENDER_POLICY,
  assertSafeStageName,
  type RenderEngine,
  type RenderFormat,
  type RenderLimits,
} from './sandbox.js';

// ---------------------------------------------------------------------------
// The rejection vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed set of codes a staging/validation rejection may carry.
 *
 * - `RENDER_INPUT_INVALID`   - policy 3.3 / 5.2.3-5.2.5: the job's INPUT tree is not
 *                              the tree the policy permits. Also the code the
 *                              pre-existing `assertSafeStageName()` in sandbox.ts
 *                              already uses, so a name rejection is classified
 *                              consistently wherever it is caught.
 * - `RENDER_INPUT_TOO_LARGE` - policy 5.2.2, named in 9.2. Enforced BEFORE the
 *                              container exists, so it can never become an OOM.
 * - `RENDER_ARTIFACT_INVALID`- policy 6.3, named in 9.2. Any of the six checks.
 * - `RENDER_STAGE_IO`        - a HOST fault (EACCES, ENOSPC, a vanished file). Not a
 *                              statement about the input. It still fails closed: the
 *                              job is rejected and the caller must not treat it as a
 *                              successful render.
 */
export const STAGE_REJECTION_CODES = Object.freeze([
  'RENDER_INPUT_INVALID',
  'RENDER_INPUT_TOO_LARGE',
  'RENDER_ARTIFACT_INVALID',
  'RENDER_STAGE_IO',
] as const);

export type StageRejectionCode = (typeof STAGE_REJECTION_CODES)[number];

/** The closed set of REASONS. Machine-readable, log-safe, never user-facing. */
export const STAGE_REJECTION_REASONS = Object.freeze([
  // input structure
  'NAME_UNSAFE',
  'NAME_NOT_ALLOWLISTED',
  'NOT_REGULAR',
  'SYMLINK',
  'HARDLINK',
  'UNEXPECTED_ENTRY',
  'MISSING_ENTRY',
  'PATH_ESCAPES_ROOT',
  'ROOT_NOT_FRESH',
  'PACKAGE_CACHE_NOT_EMPTY',
  'SOURCE_MISSING',
  // size
  'FILE_TOO_LARGE',
  'TOTAL_TOO_LARGE',
  'TOO_MANY_FILES',
  'SIZE_MISMATCH',
  'LIMITS_TOO_LOOSE',
  'LIMITS_INVALID',
  // malformed caller input (never a statement about the tree)
  'REQUEST_INVALID',
  // host fault
  'IO_ERROR',
  // artifact (policy 6.3)
  'ARTIFACT_MISSING',
  'ARTIFACT_NOT_REGULAR',
  'ARTIFACT_UNEXPECTED_ENTRY',
  'ARTIFACT_OUTDIR_INVALID',
  'ARTIFACT_OUTSIDE_OUT',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACT_SIZE_CHANGED',
  'ARTIFACT_BAD_MAGIC',
  'ARTIFACT_FORMAT_UNKNOWN',
] as const);

export type StageRejectionReason = (typeof STAGE_REJECTION_REASONS)[number];

/**
 * Fixed text per reason. A lookup table, not a template, so it is structurally
 * impossible to interpolate a caller-supplied name or a host path into a message
 * (policy 9.3, 9.4, and the same rule `assertSafeStageName()` follows).
 */
const REASON_TEXT: Readonly<Record<StageRejectionReason, string>> = Object.freeze({
  NAME_UNSAFE: 'a staged name is not a safe basename',
  NAME_NOT_ALLOWLISTED: 'a staged name is not on the allowlist for this job',
  NOT_REGULAR: 'a staged entry is not a regular file',
  SYMLINK: 'a staged entry is a symbolic link',
  HARDLINK: 'a staged entry is a hardlinked file',
  UNEXPECTED_ENTRY: 'the staging root carries an entry the job did not declare',
  MISSING_ENTRY: 'the staging root is missing an entry the job declared',
  PATH_ESCAPES_ROOT: 'a path resolves outside the staging root',
  ROOT_NOT_FRESH: 'the staging root is not empty; work directories are never reused',
  PACKAGE_CACHE_NOT_EMPTY: 'the redirected package cache directory is not empty',
  SOURCE_MISSING: 'a declared source could not be read',
  FILE_TOO_LARGE: 'a staged file exceeds the policy cap for its kind',
  TOTAL_TOO_LARGE: 'the staged tree exceeds the policy total byte cap',
  TOO_MANY_FILES: 'the staged tree exceeds the policy file-count cap',
  SIZE_MISMATCH: 'a staged file changed size while it was being copied',
  LIMITS_TOO_LOOSE: 'a caller supplied staging limits weaker than the policy caps',
  LIMITS_INVALID: 'a caller supplied staging limits that are not a set of numbers',
  REQUEST_INVALID: 'the staging request is malformed',
  IO_ERROR: 'the host filesystem could not complete the staging operation',
  ARTIFACT_MISSING: 'the expected artifact is absent from the output directory',
  ARTIFACT_NOT_REGULAR: 'the artifact is not a regular file',
  ARTIFACT_UNEXPECTED_ENTRY: 'the output directory carries more than the single artifact',
  ARTIFACT_OUTDIR_INVALID: 'the output directory is not a plain directory',
  ARTIFACT_OUTSIDE_OUT: 'the artifact resolves outside the output directory',
  ARTIFACT_TOO_LARGE: 'the artifact exceeds the policy output cap',
  ARTIFACT_SIZE_CHANGED: 'the artifact changed size while it was being read',
  ARTIFACT_BAD_MAGIC: 'the artifact content does not match the requested format',
  ARTIFACT_FORMAT_UNKNOWN: 'the requested format is not a render format',
});

/** A staging or artifact-validation rejection. Carries a code, never a path. */
export class StageError extends Error {
  readonly code: StageRejectionCode;
  readonly reason: StageRejectionReason;

  constructor(code: StageRejectionCode, reason: StageRejectionReason) {
    super(`${code}: ${REASON_TEXT[reason]}`);
    this.name = 'StageError';
    this.code = code;
    this.reason = reason;
    // The stack is server-side only (`handleApiError` never forwards it), but the
    // message itself is the part that could reach a log aggregator, so it is fixed.
  }
}

function fail(code: StageRejectionCode, reason: StageRejectionReason): never {
  throw new StageError(code, reason);
}

// ---------------------------------------------------------------------------
// The staged-tree contract
// ---------------------------------------------------------------------------

/**
 * The redirected package cache DIRECTORY inside the work root. Policy 3.3 lists it
 * as the one non-file entry the root may carry, and 7.3 says it is expected to stay
 * EMPTY because there is no network. The audit enforces both: it must be a
 * directory (not a file, not a symlink) and it must contain no entries.
 *
 * It is a policy constant derived from `RENDER_PATHS.packageCache`, not a staged
 * name, which is why it is allowed to begin with a dot that `assertSafeStageName()`
 * would otherwise refuse.
 */
export const STAGE_PACKAGE_CACHE_DIR = path.posix.basename(RENDER_PATHS.packageCache);

/** The stager-generated name for a given engine (policy 5.1, 5.3). */
export function stageTemplateName(engine: RenderEngine): string {
  return engine === 'typst' ? RENDER_PATHS.names.typstTemplate : RENDER_PATHS.names.latexTemplate;
}

/** True when this engine's allowlist permits a staged `data.json` at all. */
export function engineStagesData(engine: RenderEngine): boolean {
  return RENDER_POLICY.allowedStageNames[engine].includes(RENDER_PATHS.names.data);
}

/** The five cap fields a caller-supplied limits object has to carry as finite numbers. */
const LIMIT_FIELDS = Object.freeze([
  'inputFileBytes',
  'dataFileBytes',
  'inputTotalBytes',
  'inputFileCount',
  'outputBytes',
] as const);

/**
 * The caps this module enforces. `RENDER_LIMITS` itself, or refuse.
 *
 * A caller may TIGHTEN the caps (policy 4.6: lowering is always allowed) but may never
 * loosen them. Two refusals, kept distinct because they are different operator stories:
 *   - `LIMITS_INVALID`  - the object is not a limits object at all (`null`, an array, a
 *     missing or non-numeric field). Every entry point validates its arguments, so a
 *     malformed `limits` can never escape as a raw `TypeError` (the module's contract is
 *     that every rejection is a `StageError`).
 *   - `LIMITS_TOO_LOOSE` - a well-formed object that is weaker than the policy.
 *
 * `outputBytes` is included in the comparison even though nothing in this module reads
 * it: it travels on `StageResult.limits` / `StageAudit.limits`, and a limits object that
 * claims a weaker output cap than the policy is wrong whatever the caller does with it.
 *
 * The returned object is a FROZEN COPY, never the caller's: the value is threaded into
 * `StageResult` / `StageAudit` and read again after several `await`s, so a caller that
 * mutated it in the meantime would change a policy cap under a guard that had already
 * proved itself.
 */
export function assertStageLimits(limits: RenderLimits | undefined): Readonly<RenderLimits> {
  if (limits === undefined) return RENDER_LIMITS;
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    fail('RENDER_INPUT_INVALID', 'LIMITS_INVALID');
  }
  const offered = limits as unknown as Record<string, unknown>;
  for (const field of LIMIT_FIELDS) {
    const value = offered[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail('RENDER_INPUT_INVALID', 'LIMITS_INVALID');
    }
  }
  const policy = RENDER_LIMITS as unknown as Record<string, number>;
  const tightens = LIMIT_FIELDS.every((field) => (offered[field] as number) <= policy[field]);
  if (!tightens) {
    fail('RENDER_INPUT_INVALID', 'LIMITS_TOO_LOOSE');
  }
  return Object.freeze({ ...limits });
}

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

/** One file to copy into the work root. */
export interface StageSource {
  /** Absolute path of the file. It is `lstat`ed, never trusted. */
  readonly path: string;
  /**
   * Declared byte length, when the caller knows it (a template's registry entry, the
   * adapter's reported size). Checked against the cap BEFORE any I/O, so an
   * over-large declared size is rejected without ever opening the file. Omit it and
   * the stager measures with `lstat`; both bounds are enforced either way.
   */
  readonly declaredBytes?: number;
}

/** A template-local asset declared in `metadata.json` (policy 5.1). */
export interface StagedAsset {
  /** The name the template will use: `image("logo.png")`. Validated, never trusted. */
  readonly name: string;
  readonly source: StageSource;
}

export interface StageRequest {
  readonly engine: RenderEngine;
  /**
   * The reviewed template source, staged as `template.typ` / `artifact.tex`.
   *
   * EXACTLY ONE of `template` and `templateBytes` is required. `template` is the
   * reviewed file path (Typst); `templateBytes` is the generated document (LaTeX, whose
   * exporter emits the whole source per resume). Both are held to the same cap and the
   * same name.
   */
  readonly template?: StageSource;
  /**
   * The template source HELD IN MEMORY, for an engine whose source is generated rather
   * than read. Additive for the same reason `dataBytes` is: a LaTeX document is produced
   * by `latexExport.ts` in this process and policy 3.1/4.4 forbid writing a host temp
   * file just to read it back. It lands under the SAME policy-fixed name and is capped
   * by the SAME per-file and per-job budgets as a file source.
   */
  readonly templateBytes?: Buffer;
  /**
   * The adapter's `data.json`. REQUIRED for typst. Refused for latex, because
   * `RENDER_POLICY.allowedStageNames.latex` is exactly `['artifact.tex']` and this
   * module will not stage a name the policy does not allow for that engine. (The escalation
   * note in `.planning/progress/T1013-render-staging-module.md` left the allowlist open
   * pending T1042. It is SETTLED: ADR-042 D1 closed OI-6b in favour of export-only, so the
   * latex allowlist is NOT to be widened, and this refusal is the INTENDED behaviour rather
   * than a defect. See `.planning/progress/T1042-latex-export-guarantees.md`.)
   */
  readonly data?: StageSource;
  /**
   * The adapter's `data.json` HELD IN MEMORY, for the case where there is no host file
   * for it - which is the PRODUCTION case: the Typst path builds `data.json` in the
   * render process (`dictToDataJson`) and policy 3.1/4.4 forbid writing a host temp file
   * for the work dir, and ADR-042 D4 makes `/work` a tmpfs that never exists on the host.
   * A temporary file would have been the only way to reach the file-sourced entry point,
   * and a host temp file is precisely the write the staging layer exists to remove.
   *
   * ADDITIVE (T1043, ADR-042 D4 compliant), and it is NOT a weaker input. `dataBytes` is
   * counted into the SAME per-file cap (`dataFileBytes`, 4 MiB) and the SAME per-job
   * running total (`inputTotalBytes`, 8 MiB) as a file source, in the SAME order - the
   * per-file cap first, then the running total, both checked BEFORE the payload is
   * accepted, which is what `pumpBounded` does for a file - and it lands in the tree under
   * the same policy-fixed name and is re-audited by the same `assertTreeShape`. Two rules
   * keep it from becoming a second, weaker door:
   *   - EXACTLY ONE of `data` / `dataBytes` may be set. Both is `REQUEST_INVALID`, because
   *     "which one wins" would be a silent choice between two different documents;
   *   - the buffer is COPIED, never aliased, so a caller that mutates its buffer after the
   *     call cannot change bytes that were already under a cap.
   * A buffer also cannot smuggle the risk a path can (a symlink, a hardlink, a TOCTOU swap
   * between `lstat` and `open`), which is why this is an addition and not a replacement:
   * `data` remains the only way to stage a file, and it keeps all four path guards.
   */
  readonly dataBytes?: Buffer;
  readonly assets?: readonly StagedAsset[];
  /**
   * The staging root. Defaults to `RENDER_PATHS.work` (`/work`), the exact path the
   * worker mounts as `--root`. A host-side caller (the broker, or a test) passes the
   * directory it is about to bind-mount there; it must be absent or EMPTY, because
   * policy 3.2 forbids reusing a work directory.
   */
  readonly root?: string;
  /**
   * When set, every source must resolve (after `realpath`) inside this directory.
   * The template registry and the adapter's scratch area are the intended values, so
   * a compromised caller cannot point `template.path` at `/etc/passwd`.
   */
  readonly sourceRoot?: string;
  /** Must not be looser than `RENDER_LIMITS`. */
  readonly limits?: RenderLimits;
}

/** One file in the staged tree. */
export interface StageEntry {
  readonly name: string;
  readonly path: string;
  readonly byteSize: number;
}

export interface StageResult {
  readonly root: string;
  readonly engine: RenderEngine;
  /** Sorted by name. Exactly the files this job declared - no more, no fewer. */
  readonly entries: readonly StageEntry[];
  readonly names: readonly string[];
  readonly totalBytes: number;
  readonly packageCacheDir: string;
  readonly limits: Readonly<RenderLimits>;
}

export interface StageAudit {
  readonly root: string;
  readonly entries: readonly StageEntry[];
  readonly names: readonly string[];
  readonly totalBytes: number;
  readonly packageCacheEntries: number;
  readonly limits: Readonly<RenderLimits>;
}

// ---------------------------------------------------------------------------
// Low-level guards
// ---------------------------------------------------------------------------

/**
 * Resolve `candidate` and prove it is `root` or lives strictly inside it.
 *
 * The CODE and REASON are parameters, not constants, because the same lexical question
 * is asked of two different trees: the staged input (`RENDER_INPUT_INVALID` /
 * `PATH_ESCAPES_ROOT`) and the artifact inside `/out` (`RENDER_ARTIFACT_INVALID` /
 * `ARTIFACT_OUTSIDE_OUT`, policy 6.3 check 4). A hardcoded input code would make a
 * containment failure on the artifact path surface as an input rejection, which is a
 * different operator story and a different policy section.
 *
 * Exported so the code parameterisation itself is provable by a test; the module's own
 * call sites pass the pair that matches the tree they are checking.
 */
export async function assertRealPathInsideRoot(
  root: string,
  candidate: string,
  code: StageRejectionCode,
  reason: StageRejectionReason,
): Promise<void> {
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realpath(root);
    realCandidate = await realpath(candidate);
  } catch {
    fail('RENDER_STAGE_IO', 'IO_ERROR');
  }
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realCandidate !== realRoot && !realCandidate.startsWith(prefix)) {
    fail(code, reason);
  }
}

/** Lexical containment. See `assertRealPathInsideRoot` for why code/reason are passed. */
export function assertPathInsideRoot(
  root: string,
  candidate: string,
  code: StageRejectionCode,
  reason: StageRejectionReason,
): void {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(prefix)) {
    fail(code, reason);
  }
}

/**
 * The type gate. `lstat`, never `stat`: a symlink must be REFUSED, not followed.
 *
 * A hardlink is indistinguishable from a regular file except by link count, so
 * `nlink > 1` is refused. Where a platform does not expose a usable link count
 * (`nlink` undefined or 0), that is stated in the reason a caller logs rather than
 * silently assumed - the symlink and name gates do not depend on it.
 */
function assertRegularUnhardlinked(stats: Stats, name: string): void {
  if (stats.isSymbolicLink()) {
    fail('RENDER_INPUT_INVALID', 'SYMLINK');
  }
  if (!stats.isFile()) {
    fail('RENDER_INPUT_INVALID', 'NOT_REGULAR');
  }
  if (typeof stats.nlink === 'number' && stats.nlink > 1) {
    fail('RENDER_INPUT_INVALID', 'HARDLINK');
  }
  void name; // the name is deliberately NOT used in any message (policy 9.3)
}

/**
 * Prove an OPENED descriptor is the same file the `lstat` described, closing the
 * window between the two calls (TOCTOU). `ino`/`dev` are the identity; where the
 * platform does not expose them, size+mtime is the fallback.
 */
function assertSameFile(before: Stats, opened: Stats): void {
  const beforeHasIno = typeof before.ino === 'number' && before.ino > 0;
  const openedHasIno = typeof opened.ino === 'number' && opened.ino > 0;
  if (beforeHasIno && openedHasIno) {
    if (before.ino !== opened.ino) fail('RENDER_INPUT_INVALID', 'SYMLINK');
    if (typeof before.dev === 'number' && typeof opened.dev === 'number' && before.dev !== opened.dev) {
      fail('RENDER_INPUT_INVALID', 'SYMLINK');
    }
    return;
  }
  if (before.size !== opened.size || before.mtimeMs !== opened.mtimeMs) {
    fail('RENDER_INPUT_INVALID', 'SYMLINK');
  }
}

function assertWithinCap(byteSize: number, cap: number): void {
  if (byteSize > cap) fail('RENDER_INPUT_TOO_LARGE', 'FILE_TOO_LARGE');
}

/** The cap for a given staged name, from policy 5.2.2. */
function capForName(name: string, limits: Readonly<RenderLimits>): number {
  return name === RENDER_PATHS.names.data ? limits.dataFileBytes : limits.inputFileBytes;
}

// ---------------------------------------------------------------------------
// The audit - the sole control for the typst symlink escape
// ---------------------------------------------------------------------------

export interface StageAuditOptions {
  /** The names this job declared. Anything else in the root is a rejection. */
  readonly expectedNames: readonly string[];
  readonly limits?: RenderLimits;
  /**
   * Require the root to contain EXACTLY the expected names (default). Set false only
   * to audit a root that is allowed to hold a subset - the staged-tree post-condition
   * always uses the default.
   */
  readonly requireExact?: boolean;
}

/**
 * Walk the work root with `lstat` and reject anything that is not a plain,
 * allowlisted, in-bounds regular file. This is policy 3.3's mandate, and it is the
 * ONLY thing standing between a symlink and an arbitrary read of the image, because
 * typst 0.15.1 follows symlinks inside `--root` (issue #5454, open).
 *
 * Rejects: a symlink, a hardlink, a FIFO/socket/device node, a name that is not on
 * the allowlist, an unexpected extra entry, a missing declared entry, a path that
 * resolves outside the root, a per-file or total size over cap, too many files, a
 * non-empty package cache, and a non-empty or non-directory root.
 *
 * Performs NO reads of file CONTENT - only metadata. It is safe to call on a root
 * that is currently in use, and calling it is idempotent.
 */
export async function auditStageRoot(
  root: string,
  options: StageAuditOptions,
): Promise<StageAudit> {
  // Argument types are validated, not assumed: the module's contract is that every
  // rejection is a `StageError`, so a malformed call may not escape as a raw
  // `TypeError` from a property access on `null`.
  if (options === null || typeof options !== 'object') {
    fail('RENDER_INPUT_INVALID', 'REQUEST_INVALID');
  }
  if (typeof root !== 'string' || root.length === 0) {
    fail('RENDER_INPUT_INVALID', 'PATH_ESCAPES_ROOT');
  }
  if (!Array.isArray(options.expectedNames)) {
    fail('RENDER_INPUT_INVALID', 'REQUEST_INVALID');
  }
  if (options.expectedNames.some((name) => typeof name !== 'string')) {
    fail('RENDER_INPUT_INVALID', 'NAME_UNSAFE');
  }
  const limits = assertStageLimits(options.limits);
  const requireExact = options.requireExact !== false;
  const expected = [...new Set(options.expectedNames)].sort();

  // The root itself: a real directory, never a symlink to one.
  let rootStats: Stats;
  try {
    rootStats = await lstat(root);
  } catch {
    fail('RENDER_STAGE_IO', 'IO_ERROR');
  }
  if (rootStats.isSymbolicLink()) fail('RENDER_INPUT_INVALID', 'SYMLINK');
  if (!rootStats.isDirectory()) fail('RENDER_INPUT_INVALID', 'NOT_REGULAR');

  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    fail('RENDER_STAGE_IO', 'IO_ERROR');
  }
  names.sort();

  const entries: StageEntry[] = [];
  const seen: string[] = [];
  let totalBytes = 0;
  let packageCacheEntries = 0;
  let sawPackageCache = false;

  for (const name of names) {
    const entryPath = path.join(root, name);

    if (name === STAGE_PACKAGE_CACHE_DIR) {
      // Policy 3.3 item 4 / 7.3: the one legal non-file entry, expected to stay empty.
      let stats: Stats;
      try {
        stats = await lstat(entryPath);
      } catch {
        fail('RENDER_STAGE_IO', 'IO_ERROR');
      }
      if (stats.isSymbolicLink()) fail('RENDER_INPUT_INVALID', 'SYMLINK');
      if (!stats.isDirectory()) fail('RENDER_INPUT_INVALID', 'NOT_REGULAR');
      let inside: string[];
      try {
        inside = await readdir(entryPath);
      } catch {
        fail('RENDER_STAGE_IO', 'IO_ERROR');
      }
      packageCacheEntries = inside.length;
      if (packageCacheEntries !== 0) fail('RENDER_INPUT_INVALID', 'PACKAGE_CACHE_NOT_EMPTY');
      sawPackageCache = true;
      continue;
    }

    // 1. NAME. Structure first, then the per-job allowlist. A name that is not a
    //    safe basename can never be joined onto the root, so this is also the
    //    traversal, absolute-path and control-byte guard.
    try {
      assertSafeStageName(name);
    } catch {
      fail('RENDER_INPUT_INVALID', 'NAME_UNSAFE');
    }
    // 3. CONTAINMENT (lexical), before any type is trusted. A name that already
    //    passed the structural gate cannot contain a separator, so this is a
    //    belt-and-braces assertion rather than the primary traversal guard.
    assertPathInsideRoot(root, entryPath, 'RENDER_INPUT_INVALID', 'PATH_ESCAPES_ROOT');
    // 1b. ALLOWLIST. Off-allowlist but syntactically safe is still a rejection: the
    //     root contains only what this job declared (policy 3.3).
    if (!expected.includes(name)) fail('RENDER_INPUT_INVALID', 'UNEXPECTED_ENTRY');

    // 2. TYPE. Checked BEFORE the realpath containment test on purpose: a symlink
    //    must be reported (and refused) as a symlink, which is the R5 diagnosis,
    //    rather than as the incidental "it escapes the root" that follows from it.
    let stats: Stats;
    try {
      stats = await lstat(entryPath);
    } catch {
      fail('RENDER_STAGE_IO', 'IO_ERROR');
    }
    assertRegularUnhardlinked(stats, name);

    // 3. CONTAINMENT, on the RESOLVED path, so neither `..` nor a symlinked parent
    //    can move the target out of the root.
    await assertRealPathInsideRoot(root, entryPath, 'RENDER_INPUT_INVALID', 'PATH_ESCAPES_ROOT');

    // 4. SIZE.
    assertWithinCap(stats.size, capForName(name, limits));
    totalBytes += stats.size;
    if (totalBytes > limits.inputTotalBytes) fail('RENDER_INPUT_TOO_LARGE', 'TOTAL_TOO_LARGE');
    if (seen.length + 1 > limits.inputFileCount) fail('RENDER_INPUT_TOO_LARGE', 'TOO_MANY_FILES');

    seen.push(name);
    entries.push(Object.freeze({ name, path: entryPath, byteSize: stats.size }));
  }

  if (requireExact) {
    for (const name of expected) {
      if (!seen.includes(name)) fail('RENDER_INPUT_INVALID', 'MISSING_ENTRY');
    }
  }
  if (!sawPackageCache) {
    fail('RENDER_INPUT_INVALID', 'MISSING_ENTRY');
  }
  if (entries.length > limits.inputFileCount) fail('RENDER_INPUT_TOO_LARGE', 'TOO_MANY_FILES');

  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Object.freeze({
    root,
    entries: Object.freeze(entries),
    names: Object.freeze(seen.sort()),
    totalBytes,
    packageCacheEntries,
    limits,
  });
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * One resolved entry of a job: either a HOST SOURCE (four path guards) or an IN-MEMORY
 * PAYLOAD (the same caps, the same name, no path and therefore no path risk).
 *
 * The two variants exist as one union rather than as two code paths so the cap
 * arithmetic (`enforceDeclaredCaps`), the per-file cap lookup (`capForName`) and the
 * emitted `data.json` entry are literally the same code for both. That is the "the two
 * modes cannot drift" property `stage.test.ts` already asserts for directory vs in-memory
 * staging, extended to source-vs-buffer.
 */
type PlannedEntry =
  | {
      readonly kind: 'file';
      readonly name: string;
      readonly source: StageSource;
      readonly declaredBytes: number | undefined;
    }
  | {
      readonly kind: 'buffer';
      readonly name: string;
      readonly bytes: Buffer;
      readonly declaredBytes: number;
    };

/** The declared byte count of a planned entry, or `undefined` when nothing was declared. */
function plannedDeclaredBytes(entry: PlannedEntry): number | undefined {
  return entry.kind === 'file' ? entry.source.declaredBytes : entry.declaredBytes;
}

/** Resolve the sources of one job into `(stagedName, source, cap)` triples. */
function planEntries(request: StageRequest): PlannedEntry[] {
  if (request === null || typeof request !== 'object') {
    fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
  }
  if (request.engine !== 'typst' && request.engine !== 'latex') {
    fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
  }
  if (request.template !== undefined && request.templateBytes !== undefined) {
    // EXACTLY ONE template source, for the same reason `data`/`dataBytes` is exclusive:
    // picking one silently would be a choice between two different documents.
    fail('RENDER_INPUT_INVALID', 'REQUEST_INVALID');
  }
  if (request.templateBytes !== undefined && !Buffer.isBuffer(request.templateBytes)) {
    fail('RENDER_INPUT_INVALID', 'REQUEST_INVALID');
  }

  const templateEntry: PlannedEntry =
    request.templateBytes !== undefined
      ? {
          kind: 'buffer',
          name: stageTemplateName(request.engine),
          bytes: request.templateBytes,
          declaredBytes: request.templateBytes.length,
        }
      : {
          kind: 'file',
          name: stageTemplateName(request.engine),
          source: request.template as StageSource,
          declaredBytes: request.template?.declaredBytes,
        };
  if (templateEntry.kind === 'file' && (request.template === undefined || typeof request.template.path !== 'string')) {
    fail('RENDER_INPUT_INVALID', 'SOURCE_MISSING');
  }

  const plan: PlannedEntry[] = [templateEntry];

  const stagesData = engineStagesData(request.engine);
  if (request.data !== undefined && request.dataBytes !== undefined) {
    // EXACTLY ONE source for `data.json`. Picking one silently would let a caller change
    // which document renders by adding a field, and the two could disagree.
    fail('RENDER_INPUT_INVALID', 'REQUEST_INVALID');
  }
  if (request.dataBytes !== undefined && !Buffer.isBuffer(request.dataBytes)) {
    fail('RENDER_INPUT_INVALID', 'REQUEST_INVALID');
  }
  if (request.data !== undefined) {
    if (!stagesData) {
      // Fail closed rather than stage a name this engine's allowlist excludes.
      fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
    }
    plan.push({
      kind: 'file',
      name: RENDER_PATHS.names.data,
      source: request.data,
      declaredBytes: request.data.declaredBytes,
    });
  } else if (request.dataBytes !== undefined) {
    if (!stagesData) {
      fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
    }
    plan.push({
      kind: 'buffer',
      name: RENDER_PATHS.names.data,
      bytes: request.dataBytes,
      declaredBytes: request.dataBytes.length,
    });
  } else if (stagesData) {
    // The typst contract is template + data + assets; data.json is not optional.
    fail('RENDER_INPUT_INVALID', 'MISSING_ENTRY');
  }

  const assets = request.assets ?? [];
  if (!Array.isArray(assets)) fail('RENDER_INPUT_INVALID', 'REQUEST_INVALID');
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || !asset.source) {
      fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
    }
    // The package cache directory is a policy constant, not a staged file, so it is
    // checked before the structural gate (whose answer for a dotfile is NAME_UNSAFE).
    if (asset.name === STAGE_PACKAGE_CACHE_DIR) fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
    // Structural validation happens before the name can be used as a path segment.
    let safe: string;
    try {
      safe = assertSafeStageName(asset.name);
    } catch {
      fail('RENDER_INPUT_INVALID', 'NAME_UNSAFE');
    }
    // A declared asset may not SHADOW a policy-fixed name: that would let a caller
    // choose the bytes the engine reads as its entry document or its data. The
    // comparison is CASE-FOLDED, not exact: on a case-insensitive filesystem
    // (Windows, default macOS APFS) `Template.typ` and `template.typ` are the same
    // FILE even though they are different strings, so an exact comparison would let a
    // declared asset overwrite the entry document and only fail later, by accident, on
    // `O_EXCL` - reported as a host fault (`RENDER_STAGE_IO`) rather than as the input
    // error it is. Case folding is strictly stricter and costs nothing.
    const folded = safe.toLowerCase();
    if (plan.some((entry) => entry.name.toLowerCase() === folded)) {
      fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
    }
    plan.push({
      kind: 'file',
      name: safe,
      source: asset.source,
      declaredBytes: asset.source.declaredBytes,
    });
  }

  const names = plan.map((entry) => entry.name);
  if (new Set(names).size !== names.length) fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
  return plan;
}

/**
 * The per-JOB running byte total. This is the bound the review's MAJOR-2 called for and
 * the old evidence record wrongly called redundant: the per-file cap and the pre-copy
 * `lstat` both fire BEFORE the copy loop, so with neither of them binding, a source that
 * is small when measured and large when read would land in full before any check that
 * can reject it. Mutable by design: it is threaded through the whole job and updated
 * only after a file's bytes have been accepted.
 */
interface ByteBudget {
  used: number;
  cap: number;
}

/**
 * Validate a source and open it, returning the already-validated descriptor. Every
 * guard that must precede a single read lives here, in this fixed order:
 *   1. the path is a non-empty string;
 *   2. `lstat` succeeds (a symlink is NOT followed to find out);
 *   3. TYPE: a regular file, `nlink === 1`;
 *   4a. the DECLARED byte count is a non-negative safe integer and within cap;
 *   4b. the MEASURED `lstat` size is within cap;
 *   5. `open` succeeds, and the descriptor is the SAME file (`ino`/`dev`, or
 *      size+mtime where the platform exposes no inode) - the TOCTOU close.
 * `open()` on POSIX follows a symlink, so the type gate has to precede it and the
 * descriptor identity has to follow it. Both staging modes share it, so the modes
 * cannot drift apart on any of these five.
 */
async function openValidatedSource(source: StageSource, cap: number): Promise<FileHandle> {
  if (!source || typeof source.path !== 'string' || source.path.length === 0) {
    fail('RENDER_INPUT_INVALID', 'SOURCE_MISSING');
  }
  let before: Stats;
  try {
    before = await lstat(source.path);
  } catch {
    fail('RENDER_INPUT_INVALID', 'SOURCE_MISSING');
  }
  // 2. TYPE, on the SOURCE as well as on the destination. A caller that hands the
  //    stager a symlink to /etc/passwd is refused before it is ever opened.
  assertRegularUnhardlinked(before, source.path);
  if (source.declaredBytes !== undefined) {
    // A negative or fractional declared size is nonsense, not a small file: it would
    // also REDUCE the job's declared total in the pre-copy sum and weaken that early
    // exit, so it is refused rather than clamped.
    if (!Number.isSafeInteger(source.declaredBytes) || source.declaredBytes < 0) {
      fail('RENDER_INPUT_INVALID', 'SIZE_MISMATCH');
    }
    // 4a. DECLARED size, before any I/O.
    assertWithinCap(source.declaredBytes, cap);
  }
  // 4b. MEASURED size, before any read.
  assertWithinCap(before.size, cap);

  // Every fs rejection below is translated into a fixed StageError, so a raw
  // `Error: ENOENT: no such file or directory, open 'C:\\...\\secret'` can never
  // reach the error surface (policy 9.3).
  let handle: FileHandle;
  try {
    handle = await open(source.path, 'r');
  } catch {
    fail('RENDER_INPUT_INVALID', 'SOURCE_MISSING');
  }
  try {
    const opened = await handle.stat();
    // 2b. The descriptor is the file we validated, not whatever took its place.
    assertSameFile(before, opened);
    if (!opened.isFile()) fail('RENDER_INPUT_INVALID', 'NOT_REGULAR');
    return handle;
  } catch (err) {
    // A failure after the descriptor exists must still close it, and the raw fs
    // rejection is translated rather than allowed to escape (policy 9.3).
    await handle.close().catch(() => undefined);
    if (err instanceof StageError) throw err;
    fail('RENDER_STAGE_IO', 'IO_ERROR');
  }
}

/**
 * Stream an ALREADY-VALIDATED descriptor into `sink` under two mid-stream budgets.
 *
 * This is the only place bytes are accepted, and BOTH staging modes share it, so the
 * two bounds cannot drift apart:
 *   4c. the per-file running count, against that file's cap;
 *   4e. the per-JOB running total, against `inputTotalBytes`.
 * Both are checked BEFORE the chunk reaches the sink, so nothing over a cap ever lands
 * in a destination file or in memory. That is exactly why this is NOT redundant with
 * the post-copy audit: remove it and the only remaining check arrives after the whole
 * oversized file is already on disk.
 */
async function pumpBounded(
  handle: FileHandle,
  sink: (chunk: Buffer) => Promise<void>,
  cap: number,
  budget: ByteBudget,
): Promise<number> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let written = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    written += bytesRead;
    // 4c. ACTUAL bytes read, enforced mid-stream.
    if (written > cap) fail('RENDER_INPUT_TOO_LARGE', 'FILE_TOO_LARGE');
    // 4e. JOB running total, enforced mid-stream, before the bytes land.
    if (budget.used + written > budget.cap) fail('RENDER_INPUT_TOO_LARGE', 'TOTAL_TOO_LARGE');
    await sink(buffer.subarray(0, bytesRead));
  }
  budget.used += written;
  return written;
}

/**
 * Copy one source into the root, under a hard byte budget. The budget is enforced on
 * the bytes actually READ, not only on the size `lstat` reported, so a file that grows
 * after it was measured is still caught.
 *
 * `O_EXCL` on the destination is LOAD-BEARING, not a belt to the freshness check. Two
 * concurrent `stageRenderJob` calls on one root both pass the freshness check (the
 * listing is empty, or holds only `.pkgcache`), so without `O_EXCL` the second `open`
 * would TRUNCATE and rewrite the first job's bytes: both calls would resolve, both
 * audits would pass, the failure cleanup would be skipped, and each `StageResult` would
 * describe a tree the other job had just overwritten - exactly the cross-job reuse
 * policy 3.2 exists to prevent. `stage.test.ts` pins it with a concurrent-staging test.
 */
async function copyBounded(
  source: StageSource,
  dest: string,
  cap: number,
  budget: ByteBudget,
): Promise<number> {
  const handle = await openValidatedSource(source, cap);
  try {
    // O_EXCL: the destination must not already exist, so a symlink pre-planted at
    // that exact path cannot be written through, and a concurrent job cannot silently
    // replace this one's bytes.
    const out = await open(dest, 'wx', 0o600);
    let completed = false;
    try {
      const written = await pumpBounded(
        handle,
        async (chunk) => {
          await out.write(chunk, 0, chunk.length);
        },
        cap,
        budget,
      );
      // 4d. SIZE, measured on the copy.
      const after = await lstat(dest);
      if (after.isSymbolicLink()) fail('RENDER_INPUT_INVALID', 'SYMLINK');
      if (!after.isFile()) fail('RENDER_INPUT_INVALID', 'NOT_REGULAR');
      if (typeof after.nlink === 'number' && after.nlink > 1) fail('RENDER_INPUT_INVALID', 'HARDLINK');
      if (after.size !== written) fail('RENDER_INPUT_INVALID', 'SIZE_MISMATCH');
      completed = true;
      return written;
    } finally {
      // Close before the unlink: on Windows an open descriptor blocks the removal.
      await out.close().catch(() => undefined);
      if (!completed) {
        // The destination was created HERE and holds a PARTIAL copy, and the caller
        // never registered it for cleanup because the copy never finished. Without
        // this, a mid-stream rejection (a source that grew, or a job over its running
        // total) would leave bytes behind in a root that pre-existed the call - which
        // is exactly what the cleanup in `stageRenderJob` promises cannot happen.
        await rm(dest, { force: true }).catch(() => undefined);
      }
    }
  } catch (err) {
    if (err instanceof StageError) throw err;
    fail('RENDER_STAGE_IO', 'IO_ERROR');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Accept an in-memory payload under the SAME two budgets `pumpBounded` applies to a file,
 * in the SAME order, and return a COPY.
 *
 * The check order is the file path's order and is load-bearing: per-file cap first, then
 * the per-JOB running total, both before the payload is admitted. A buffer needs no
 * `lstat`, no `open` and no descriptor-identity check (it is not a path and therefore
 * cannot be a symlink, a hardlink or a TOCTOU swap), but it needs the caps exactly as much
 * a file does - otherwise `dataBytes` would be the door that walks past policy 5.2.2.
 *
 * The result is a COPY rather than the caller's buffer. The buffer is already under a cap
 * at this point, but it is the CALLER's memory: aliasing it would let a caller that mutates
 * it later change bytes the caps were proved against, and would let the emitted `data.json`
 * differ from the one that was validated. `copyBounded` gets that property from a fresh
 * `O_EXCL` file; this is the same guarantee for the in-memory mode.
 */
function acceptBuffer(bytes: Buffer, cap: number, budget: ByteBudget): Buffer {
  if (!Buffer.isBuffer(bytes)) {
    fail('RENDER_INPUT_INVALID', 'REQUEST_INVALID');
  }
  // MUTATION M-c: delete the two cap checks below. `stage.test.ts`'s over-cap `dataBytes`
  // case fails with a `StageError` that never arrives, because an uncapped buffer produces a
  // tree and `assertTreeShape` re-checks the same per-file cap afterwards - so the test that
  // dies is the one asserting the REJECTION, not one that reads a different number.
  // 4c. Per-file cap, the data.json cap when the name is `data.json` - identical to the
  //      measured-size check `openValidatedSource` applies before it opens anything.
  if (bytes.length > cap) fail('RENDER_INPUT_TOO_LARGE', 'FILE_TOO_LARGE');
  // 4e. Per-JOB running total, the same line `pumpBounded` runs before every chunk.
  if (budget.used + bytes.length > budget.cap) fail('RENDER_INPUT_TOO_LARGE', 'TOTAL_TOO_LARGE');
  budget.used += bytes.length;
  return Buffer.from(bytes);
}

/**
 * The file-count and DECLARED-size caps, before any I/O in either mode. Undeclared
 * sizes fall back to the measured `lstat` size and then to the mid-stream byte count,
 * so omitting a declared size is a weaker early exit, never a weaker bound.
 */
function enforceDeclaredCaps(
  plan: readonly PlannedEntry[],
  limits: Readonly<RenderLimits>,
): void {
  if (plan.length > limits.inputFileCount) fail('RENDER_INPUT_TOO_LARGE', 'TOO_MANY_FILES');
  // The TOTAL is checked before the per-entry caps, so a job whose declared sizes are
  // individually legal and jointly over cap is reported as the total breach it is.
  // A buffer ALWAYS declares (its length is its declared size), so a `dataBytes` job
  // reaches the same arithmetic with no I/O at all.
  let declaredTotal = 0;
  for (const entry of plan) {
    const declared = plannedDeclaredBytes(entry);
    if (declared !== undefined) declaredTotal += declared;
  }
  if (declaredTotal > limits.inputTotalBytes) fail('RENDER_INPUT_TOO_LARGE', 'TOTAL_TOO_LARGE');
  for (const entry of plan) {
    if (entry.kind === 'buffer') {
      // `acceptBuffer` re-checks the per-file cap; this is the no-I/O early exit that
      // makes an over-large payload fail before a root is created or a byte is copied.
      if (entry.bytes.length > capForName(entry.name, limits)) {
        fail('RENDER_INPUT_TOO_LARGE', 'FILE_TOO_LARGE');
      }
      continue;
    }
    if (entry.source.declaredBytes === undefined) continue;
    assertWithinCap(entry.source.declaredBytes, capForName(entry.name, limits));
  }
}

/**
 * Write an already-accepted in-memory payload into a destination in DIRECTORY mode, with
 * the same `O_EXCL` and post-copy `lstat` guards `copyBounded` uses for a file.
 *
 * Directory mode exists for the disk-copy guard ordering and for policy 3.3's lstat walk,
 * so a `dataBytes` payload that went through it must arrive in the SAME shape - otherwise
 * "staged with a file" and "staged from memory" would produce two different trees and the
 * determinism cache would be keyed on something that is not the document.
 */
async function writeAcceptedBuffer(
  bytes: Buffer,
  dest: string,
  cap: number,
  budget: ByteBudget,
): Promise<number> {
  let completed = false;
  try {
    const out = await open(dest, 'wx', 0o600);
    try {
      // `budget` already accounts for these bytes (checked before the copy), so the
      // loop re-checks the per-file cap the way `pumpBounded` does and writes in one
      // bounded move.
      if (bytes.length > cap) fail('RENDER_INPUT_TOO_LARGE', 'FILE_TOO_LARGE');
      await out.write(bytes, 0, bytes.length);
      const after = await lstat(dest);
      if (after.isSymbolicLink()) fail('RENDER_INPUT_INVALID', 'SYMLINK');
      if (!after.isFile()) fail('RENDER_INPUT_INVALID', 'NOT_REGULAR');
      if (typeof after.nlink === 'number' && after.nlink > 1) fail('RENDER_INPUT_INVALID', 'HARDLINK');
      if (after.size !== bytes.length) fail('RENDER_INPUT_INVALID', 'SIZE_MISMATCH');
      completed = true;
      return bytes.length;
    } finally {
      // Close before the unlink: on Windows an open descriptor blocks the removal.
      await out.close().catch(() => undefined);
      if (!completed) await rm(dest, { force: true }).catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof StageError) throw err;
    fail('RENDER_STAGE_IO', 'IO_ERROR');
  }
}

/**
 * Stage one render job into a FRESH work root and prove the result with `lstat`.
 *
 * DIRECTORY MODE. This is the mode that has a destination PATH, so it is where the
 * disk-copy guards live: `O_EXCL` on every destination, the post-copy `lstat`, and the
 * cleanup-on-failure path. It is not the production ingestion path - policy 3.1/4.4
 * make `/work` a tmpfs, so the broker stages in memory (`stageRenderJobInMemory`) and
 * streams into the container. It is kept because policy 3.3's lstat walk has to be
 * callable on a real directory, and because these guards need a test surface.
 *
 * Order of operations, and why this order:
 *   1. plan the names (structure + per-engine allowlist) - no I/O;
 *   2. enforce the file-count and total-byte caps on the DECLARED sizes - no I/O,
 *      so an over-large job is rejected before the container could exist (5.2.2);
 *   3. check the ROOT's own type, then prepare it: create it if absent, refuse it if
 *      it is not an empty directory (policy 3.2, no reuse), create the empty package
 *      cache dir;
 *   4. validate each source with `lstat`, then copy it under a per-file AND a per-job
 *      running byte budget;
 *   5. `auditStageRoot()` on the finished tree - the post-condition, not a hope;
 *   6. on ANY failure, remove everything this call created, so a partially staged
 *      root can never reach the compiler (policy 5.2.6).
 */
export async function stageRenderJob(request: StageRequest): Promise<StageResult> {
  if (request === null || typeof request !== 'object') {
    fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
  }
  const limits = assertStageLimits(request.limits);
  if (request.root !== undefined && (typeof request.root !== 'string' || request.root.length === 0)) {
    fail('RENDER_INPUT_INVALID', 'PATH_ESCAPES_ROOT');
  }
  if (
    request.sourceRoot !== undefined &&
    (typeof request.sourceRoot !== 'string' || request.sourceRoot.length === 0)
  ) {
    fail('RENDER_INPUT_INVALID', 'PATH_ESCAPES_ROOT');
  }
  const root = path.resolve(request.root ?? RENDER_PATHS.work);
  const plan = planEntries(request);

  // 2. Cap arithmetic on declared sizes, before any I/O.
  enforceDeclaredCaps(plan, limits);

  // 3. The root must be fresh, AND it must be the kind of thing a root may be.
  const createdPaths: string[] = [];
  let createdRoot = false;
  const budget: ByteBudget = { used: 0, cap: limits.inputTotalBytes };
  try {
    let rootStats: Stats | undefined;
    try {
      rootStats = await lstat(root);
    } catch {
      rootStats = undefined;
    }
    if (rootStats !== undefined) {
      // The root's own TYPE, decided BEFORE anything is written. Without this, a
      // symlinked root pointing at an empty directory passes the freshness check
      // (its listing is empty) and the copies land inside the link target, with the
      // audit refusing the job only afterwards - a write into a directory the module
      // had just declared off-limits. A root that is not a directory at all
      // (`ENOTDIR` from `readdir`) is now reported as `NOT_REGULAR` rather than as an
      // opaque host fault.
      if (rootStats.isSymbolicLink()) fail('RENDER_INPUT_INVALID', 'SYMLINK');
      if (!rootStats.isDirectory()) fail('RENDER_INPUT_INVALID', 'NOT_REGULAR');
      // Policy 3.2: a work directory is never reused, so a root that already holds
      // anything is refused rather than merged into. This is the R11 control, and it
      // is also what makes "the staged tree is exactly what this job declared" a
      // property of the root rather than a property of this call.
      let existing: string[];
      try {
        existing = await readdir(root);
      } catch {
        fail('RENDER_STAGE_IO', 'IO_ERROR');
      }
      if (existing.length > 0) {
        // The ONE tolerated pre-existing entry is the package cache directory the
        // image entrypoint creates; it must still be empty, which the post-staging
        // audit proves. Anything else is a leftover from another job.
        const leftovers = existing.filter((name) => name !== STAGE_PACKAGE_CACHE_DIR);
        if (leftovers.length > 0) fail('RENDER_INPUT_INVALID', 'ROOT_NOT_FRESH');
      }
    } else {
      try {
        await mkdir(root, { mode: 0o700 });
      } catch {
        fail('RENDER_STAGE_IO', 'IO_ERROR');
      }
      createdRoot = true;
    }
    const packageCache = path.join(root, STAGE_PACKAGE_CACHE_DIR);
    try {
      await mkdir(packageCache, { mode: 0o700 });
    } catch {
      // Already present and empty is the expected shape when the entrypoint made it;
      // `auditStageRoot` below is what decides whether it is actually empty.
    }
    createdPaths.push(packageCache);

    // 4. Validate-then-copy, one file at a time, names sorted so the result is
    //    deterministic regardless of the order the caller listed them in.
    const ordered = [...plan].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of ordered) {
      const dest = path.join(root, entry.name);
      assertPathInsideRoot(root, dest, 'RENDER_INPUT_INVALID', 'PATH_ESCAPES_ROOT');
      if (entry.kind === 'buffer') {
        // No `sourceRoot` hop: a buffer is not a path, so there is nothing to resolve
        // against a root, and nothing a symlinked parent could redirect.
        await writeAcceptedBuffer(acceptBuffer(entry.bytes, capForName(entry.name, limits), budget), dest, capForName(entry.name, limits), budget);
        createdPaths.push(dest);
        continue;
      }
      // When the caller declares a source root (the template registry, the adapter's
      // scratch area), the source must RESOLVE inside it: a symlinked hop out of the
      // registry is refused, not followed.
      if (request.sourceRoot !== undefined) {
        await assertRealPathInsideRoot(
          request.sourceRoot,
          entry.source.path,
          'RENDER_INPUT_INVALID',
          'PATH_ESCAPES_ROOT',
        );
      }
      await copyBounded(entry.source, dest, capForName(entry.name, limits), budget);
      createdPaths.push(dest);
    }

    // 5. Prove it.
    const audit = await auditStageRoot(root, {
      expectedNames: plan.map((entry) => entry.name),
      limits,
    });
    if (audit.totalBytes > limits.inputTotalBytes) fail('RENDER_INPUT_TOO_LARGE', 'TOTAL_TOO_LARGE');

    return Object.freeze({
      root,
      engine: request.engine,
      entries: audit.entries,
      names: audit.names,
      totalBytes: audit.totalBytes,
      packageCacheDir: path.join(root, STAGE_PACKAGE_CACHE_DIR),
      limits,
    });
  } catch (err) {
    // 6. Fail closed with nothing left behind. Only paths THIS call created are
    //    removed; a pre-existing root is left exactly as it was found.
    for (const created of createdPaths.reverse()) {
      try {
        await rm(created, { force: true });
      } catch {
        // Cleanup is best effort and MUST NOT mask the original rejection.
      }
    }
    if (createdRoot) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        // Same: the StageError from the original failure is what the caller sees.
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// In-memory staging - the PRODUCTION path (ADR-042 D4, policy 3.1 / 4.4)
// ---------------------------------------------------------------------------

/** One file of an in-memory staged tree, held as bytes rather than as a path. */
export interface StagedFile {
  readonly name: string;
  readonly bytes: Buffer;
}

/**
 * A fully validated staged tree that never touched the host filesystem.
 *
 * `packageCacheDir` is the NAME (`.pkgcache`), not a path: the directory is created by
 * whatever extracts the stream, inside the container's tmpfs. The tree carries no
 * `root` for the same reason - the container path is the policy constant `/work`.
 */
export interface StageTree {
  readonly engine: RenderEngine;
  /** Sorted by name. Exactly the files this job declared; no directory entries. */
  readonly files: readonly StagedFile[];
  readonly names: readonly string[];
  readonly totalBytes: number;
  readonly packageCacheDir: string;
  readonly limits: Readonly<RenderLimits>;
}

/**
 * Re-walk the finished in-memory tree and prove the post-condition, the way
 * `auditStageRoot` proves it for a directory: every name is a legal basename, no name
 * repeats, the count and per-file caps hold, and the running total is within
 * `inputTotalBytes`. The only writer of `files` is this module, so this is defence in
 * depth rather than a second independent control - but it is the same shape as the
 * directory walk, so a future edit to either cannot silently drop a bound.
 */
function assertTreeShape(files: readonly StagedFile[], limits: Readonly<RenderLimits>): number {
  if (files.length > limits.inputFileCount) fail('RENDER_INPUT_TOO_LARGE', 'TOO_MANY_FILES');
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    try {
      assertSafeStageName(file.name);
    } catch {
      fail('RENDER_INPUT_INVALID', 'NAME_UNSAFE');
    }
    if (seen.has(file.name)) fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
    seen.add(file.name);
    assertWithinCap(file.bytes.length, capForName(file.name, limits));
    total += file.bytes.length;
    if (total > limits.inputTotalBytes) fail('RENDER_INPUT_TOO_LARGE', 'TOTAL_TOO_LARGE');
  }
  return total;
}

/**
 * Stage one render job ENTIRELY IN MEMORY. This is the production path: policy 3.1 and
 * 4.4 make `/work` a tmpfs that is never a host directory, so the broker creates the
 * container first and pipes `openStageTreeStream(tree)` into it
 * (`docker exec -i <c> tar -x -C /work`). No host path is ever created, so there is
 * nothing on the host for an attacker-influenced write to reach - which is also what
 * makes the mid-stream byte budget, not the filesystem, the bound on how many bytes a
 * job can cause to exist.
 *
 * The same guards as directory mode, in the same order, on the same shared helpers:
 * name structure and per-engine allowlist, then the declared caps with no I/O, then
 * per source: `lstat` -> type gate -> declared/measured caps -> `open` -> descriptor
 * identity -> the mid-stream per-file and per-job byte budgets. `StageRequest.root` is
 * NOT read here: the container path is a policy constant, and a host root would be the
 * contradiction this function exists to remove.
 *
 * `StageRequest.dataBytes` takes the SAME route through the SAME guards, minus the four
 * that only a path can need: `acceptBuffer` applies the per-file cap and the per-job
 * running total in `pumpBounded`'s order, and `assertTreeShape` below re-walks the result.
 * That is the whole reason the field is additive rather than a second entry point - the
 * emitted tree is byte-identical to the file-sourced one, so the broker frame, the
 * container's `/work` and the determinism cache cannot tell which was used.
 */
export async function stageRenderJobInMemory(request: StageRequest): Promise<StageTree> {
  if (request === null || typeof request !== 'object') {
    fail('RENDER_INPUT_INVALID', 'NAME_NOT_ALLOWLISTED');
  }
  const limits = assertStageLimits(request.limits);
  if (
    request.sourceRoot !== undefined &&
    (typeof request.sourceRoot !== 'string' || request.sourceRoot.length === 0)
  ) {
    fail('RENDER_INPUT_INVALID', 'PATH_ESCAPES_ROOT');
  }
  const plan = planEntries(request);
  enforceDeclaredCaps(plan, limits);

  const budget: ByteBudget = { used: 0, cap: limits.inputTotalBytes };
  const ordered = [...plan].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: StagedFile[] = [];
  for (const entry of ordered) {
    const cap = capForName(entry.name, limits);
    if (entry.kind === 'buffer') {
      // The same two budgets a file source pays, then the same COPY, then the same
      // `data.json` entry. Nothing about the emitted tree distinguishes the two.
      files.push(Object.freeze({ name: entry.name, bytes: acceptBuffer(entry.bytes, cap, budget) }));
      continue;
    }
    if (request.sourceRoot !== undefined) {
      await assertRealPathInsideRoot(
        request.sourceRoot,
        entry.source.path,
        'RENDER_INPUT_INVALID',
        'PATH_ESCAPES_ROOT',
      );
    }
    const handle = await openValidatedSource(entry.source, cap);
    const chunks: Buffer[] = [];
    try {
      // Same mid-stream budget as the disk copy, checked before a chunk is accepted.
      await pumpBounded(
        handle,
        async (chunk) => {
          // The read buffer is reused across iterations, so the memory sink COPIES.
          chunks.push(Buffer.from(chunk));
        },
        cap,
        budget,
      );
    } catch (err) {
      if (err instanceof StageError) throw err;
      fail('RENDER_STAGE_IO', 'IO_ERROR');
    } finally {
      await handle.close().catch(() => undefined);
    }
    files.push(Object.freeze({ name: entry.name, bytes: Buffer.concat(chunks) }));
  }

  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const totalBytes = assertTreeShape(files, limits);
  return Object.freeze({
    engine: request.engine,
    files: Object.freeze(files),
    names: Object.freeze(files.map((file) => file.name)),
    totalBytes,
    packageCacheDir: STAGE_PACKAGE_CACHE_DIR,
    limits,
  });
}

// A ustar header is one 512-byte block; the archive ends with two zero blocks and is
// padded out to the 10240-byte record GNU tar writes, so `tar -x` reads it without a
// short-archive warning.
const TAR_BLOCK = 512;
const TAR_RECORD = 10 * TAR_BLOCK;
const TAR_MODE_FILE = 0o600;
const TAR_MODE_DIR = 0o700;
/** mtime 0, never a wall clock: the archive bytes are deterministic (policy 10.4, R14). */
const TAR_MTIME = '00000000000';

/** One ustar header block, with the checksum computed over it. */
function tarHeader(name: string, size: number, typeflag: string, mode: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK, 0);
  const writeField = (offset: number, length: number, value: string): void => {
    // A field that does not fit is a hard error rather than a silent truncation: a
    // truncated name would extract to a DIFFERENT path than the audited one.
    if (value.length > length - 1) {
      fail('RENDER_INPUT_INVALID', 'NAME_UNSAFE');
    }
    header.write(value, offset, length - 1, 'latin1');
  };
  writeField(0, 100, name);
  writeField(100, 8, mode.toString(8).padStart(7, '0'));
  writeField(108, 8, '0000000');
  writeField(116, 8, '0000000');
  writeField(124, 12, size.toString(8).padStart(11, '0'));
  writeField(136, 12, TAR_MTIME);
  header.write(typeflag, 156, 1, 'latin1');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  // The checksum is the sum of every header byte with the checksum field read as
  // spaces, so it is computed LAST - after every other field, including the magic -
  // and then written as six octal digits, a NUL and a space.
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'latin1');
  header[154] = 0x00;
  header[155] = 0x20;
  return header;
}

/**
 * Emit a staged tree as a POSIX ustar stream, for the broker to pipe into the
 * container's tmpfs: `docker exec -i <container> tar -x -C /work`.
 *
 * The archive carries EXACTLY the tree's files plus the one empty `.pkgcache`
 * directory entry (policy 3.3 item 4), and nothing else - there is no code path here
 * that can add, rename or drop an entry, so what the container receives is what
 * `stageRenderJobInMemory` validated. The size is bounded by the staging caps (5 files,
 * 8 MiB) plus 512 bytes of header per entry, so the whole archive is assembled in
 * memory and the consumer streams it out; nothing is written to disk here either.
 */
export function openStageTreeStream(tree: StageTree): Readable {
  const blocks: Buffer[] = [];
  for (const file of tree.files) {
    blocks.push(tarHeader(file.name, file.bytes.length, '0', TAR_MODE_FILE));
    blocks.push(file.bytes);
    const pad = file.bytes.length % TAR_BLOCK;
    if (pad !== 0) blocks.push(Buffer.alloc(TAR_BLOCK - pad, 0));
  }
  // The redirected package cache: a directory entry with no contents, so the extracted
  // root is the shape policy 3.3 describes and the audit's emptiness check holds.
  blocks.push(tarHeader(`${tree.packageCacheDir}/`, 0, '5', TAR_MODE_DIR));
  blocks.push(Buffer.alloc(2 * TAR_BLOCK, 0));
  let emitted = blocks.reduce((sum, block) => sum + block.length, 0);
  while (emitted % TAR_RECORD !== 0) {
    blocks.push(Buffer.alloc(TAR_BLOCK, 0));
    emitted += TAR_BLOCK;
  }
  return Readable.from(blocks);
}

// ---------------------------------------------------------------------------
// Artifact validation (policy 6.3)
// ---------------------------------------------------------------------------

/** Magic bytes per format. A CONTENT check, never an extension check (6.3.6). */
const MAGIC: Readonly<Record<RenderFormat, Buffer>> = Object.freeze({
  pdf: Buffer.from('%PDF-', 'latin1'),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  svg: Buffer.from('<svg', 'latin1'),
});

/** The MIME type recorded alongside the artifact (policy 6.4 metadata list). */
export const ARTIFACT_MIME_TYPES: Readonly<Record<RenderFormat, string>> = Object.freeze({
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
});

/** How many leading bytes the magic check inspects. */
const MAGIC_WINDOW = 512;

/** Whitespace an SVG prolog may be followed by before the root element. */
const SVG_SKIPPABLE = new Set<number>([0x20, 0x09, 0x0a, 0x0d]);

function magicMatches(format: RenderFormat, head: Buffer): boolean {
  if (format === 'pdf') return head.subarray(0, 5).equals(MAGIC.pdf);
  if (format === 'png') return head.subarray(0, 8).equals(MAGIC.png);
  // SVG may legally carry a UTF-8 BOM, an XML declaration, and whitespace/newlines
  // before the root element, so all three are skipped; the root element name itself
  // is what must match. This is still a CONTENT check, not an extension check.
  let offset = head.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  if (head.subarray(offset, offset + 5).toString('latin1') === '<?xml') {
    const close = head.indexOf('?>', offset, 'latin1');
    if (close !== -1) offset = close + 2;
  }
  while (offset < head.length && SVG_SKIPPABLE.has(head[offset] as number)) offset += 1;
  return head.subarray(offset, offset + 4).equals(MAGIC.svg);
}

export interface ArtifactValidationOptions {
  /**
   * A host directory holding the container's `/out` contents. Defaults to
   * `RENDER_PATHS.out` (`/out`). The BROKER decides how those bytes got here - see
   * the header: this module is mechanism-agnostic by design (T1005 OI-1).
   */
  readonly outDir?: string;
  readonly format: RenderFormat;
  /** May only tighten `RENDER_LIMITS.outputBytes` (policy 6.2). */
  readonly maxBytes?: number;
}

/** A validated artifact handle. Never a path that came back from inside the container. */
export interface RenderArtifact {
  readonly format: RenderFormat;
  /** Always `artifact.<ext>` - constructed here, never taken from a container reply. */
  readonly name: string;
  readonly path: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly mimeType: string;
  /** The inspected leading bytes, hex - for the job log, never for the API response. */
  readonly magicHex: string;
}

/**
 * Policy 6.3, all six checks, in the order the policy lists them, plus one extra
 * (link count) that is strictly stricter:
 *
 *   1. `lstat(/out/artifact.<ext>)` succeeds;
 *   2. it is a regular file and NOT a symbolic link (`lstat`, never `stat`);
 *   3. the directory holds EXACTLY ONE entry, and it is the artifact - a second file
 *      means the template wrote outside its contract;
 *   4. `realpath` is inside `realpath(outDir)`, so neither `..` nor a symlinked
 *      parent can move the target;
 *   5. size <= cap (20 MiB policy, 16 MiB kernel mount);
 *   6. the magic bytes match the requested format;
 *   7. EXTRA: `nlink === 1`. A hardlinked artifact inside a private `/out` tmpfs is
 *      anomalous and is refused rather than trusted.
 *
 * The path is CONSTRUCTED from the format this caller asked for. Nothing that came
 * back from inside the container is ever used to locate the file.
 */
export async function validateRenderArtifact(
  options: ArtifactValidationOptions,
): Promise<RenderArtifact> {
  if (options === null || typeof options !== 'object') {
    fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_FORMAT_UNKNOWN');
  }
  const format = options.format;
  if (format !== 'pdf' && format !== 'png' && format !== 'svg') {
    fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_FORMAT_UNKNOWN');
  }
  const cap =
    options.maxBytes === undefined
      ? RENDER_LIMITS.outputBytes
      : Math.min(options.maxBytes, RENDER_LIMITS.outputBytes);
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_TOO_LARGE');
  }

  const outDir = path.resolve(
    options.outDir === undefined
      ? RENDER_PATHS.out
      : typeof options.outDir === 'string' && options.outDir.length > 0
        ? options.outDir
        : fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTSIDE_OUT'),
  );
  // Constructed, never received: the basename is a policy constant.
  const name = path.basename(RENDER_PATHS.artifact[format]);
  const artifactPath = path.join(outDir, name);
  assertPathInsideRoot(outDir, artifactPath, 'RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTSIDE_OUT');
  // `outDir` itself, the same requirement the stage root gets: a real directory, never
  // a symlink to one. Without it "the artifact came from /out" is enforced only
  // lexically - `assertRealPathInsideRoot` below realpaths BOTH sides, so a symlinked
  // outDir would make the two agree and the check would pass on a directory the
  // broker never named.
  let outStats: Stats;
  try {
    outStats = await lstat(outDir);
  } catch {
    fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTDIR_INVALID');
  }
  if (outStats.isSymbolicLink()) fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTDIR_INVALID');
  if (!outStats.isDirectory()) fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTDIR_INVALID');

  // 1. lstat succeeds.
  let stats: Stats;
  try {
    stats = await lstat(artifactPath);
  } catch {
    fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_MISSING');
  }
  // 2. regular file, not a symlink.
  if (stats.isSymbolicLink()) fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_NOT_REGULAR');
  if (!stats.isFile()) fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_NOT_REGULAR');
  if (typeof stats.nlink === 'number' && stats.nlink > 1) {
    fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_NOT_REGULAR');
  }
  // 3. exactly one entry in the output dir, and it is the artifact.
  let entries: string[];
  try {
    entries = await readdir(outDir);
  } catch {
    fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_MISSING');
  }
  if (entries.length !== 1 || entries[0] !== name) {
    fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
  }
  // 4. realpath containment, with the ARTIFACT codes: a containment failure here is a
  //    `RENDER_ARTIFACT_INVALID` (policy 6.3), not an input rejection.
  await assertRealPathInsideRoot(outDir, artifactPath, 'RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTSIDE_OUT');
  // 5. size cap.
  if (stats.size > cap) fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_TOO_LARGE');

  // 6. content, and the digest, in one bounded pass over the descriptor.
  const hash = createHash('sha256');
  const head = Buffer.alloc(MAGIC_WINDOW);
  let filled = 0;
  let handle;
  try {
    handle = await open(artifactPath, 'r');
  } catch {
    fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_MISSING');
  }
  let seen = 0;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || (typeof opened.nlink === 'number' && opened.nlink > 1)) {
      fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_NOT_REGULAR');
    }
    if (opened.size > cap) fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_TOO_LARGE');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      seen += bytesRead;
      if (seen > cap) fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_TOO_LARGE');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      // The magic window is a prefix, so a read that straddles its end is truncated
      // rather than dropped; `filled` never exceeds MAGIC_WINDOW.
      if (filled < MAGIC_WINDOW) {
        const take = Math.min(bytesRead, MAGIC_WINDOW - filled);
        chunk.copy(head, filled, 0, take);
        filled += take;
      }
    }
  } catch (err) {
    if (err instanceof StageError) throw err;
    fail('RENDER_STAGE_IO', 'IO_ERROR');
  } finally {
    await handle.close().catch(() => undefined);
  }
  // A file that SHRANK between `lstat` and the read is not "too large": it is a file
  // that changed under the assertion, which is a different operator story, and
  // ARTIFACT_TOO_LARGE would send the triage after the wrong cause. It still fails
  // closed either way.
  if (seen !== stats.size) fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_SIZE_CHANGED');
  if (!magicMatches(format, head)) fail('RENDER_ARTIFACT_INVALID', 'ARTIFACT_BAD_MAGIC');

  return Object.freeze({
    format,
    name,
    path: artifactPath,
    byteSize: seen,
    sha256: hash.digest('hex'),
    mimeType: ARTIFACT_MIME_TYPES[format],
    magicHex: head.subarray(0, filled).toString('hex'),
  });
}

/**
 * The bytes, as a stream, for the storage port (policy 6.4 / ADR-041 D2: the binary
 * is never written to PostgreSQL, only a `storageKey` + `sha256` + `byteSize`).
 * The caller has already validated the artifact, so this performs no checks of its
 * own - it exists so the broker never has to materialise the bytes twice.
 */
export function openArtifactStream(artifact: RenderArtifact): ReadStream {
  return createReadStream(artifact.path);
}

/**
 * Reduce an arbitrary caller-supplied asset name to a safe staged basename, using the
 * repo's existing pattern (`backend/src/routes/export.ts:34-40`: allowlist, collapse
 * repeats, strip leading/trailing separators, fall back to a constant).
 *
 * This is CONVENIENCE, not the security boundary: the result is still fed to
 * `assertSafeStageName()` and to the per-job allowlist, so a sanitiser bug cannot
 * produce something the stager will accept.
 */
export function sanitizeStageName(raw: unknown, fallback = 'asset'): string {
  const source = typeof raw === 'string' ? raw : '';
  const collapsed = source
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return collapsed || fallback;
}
