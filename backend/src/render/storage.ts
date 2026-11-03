// Artifact storage port - the ONLY module in the repository that writes artifact
// bytes to disk.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 2
//                 .planning/decisions/ADR-041-*.md (D2: metadata in Postgres)
//                 .planning/decisions/ADR-042-*.md      (D3: the port lands BEFORE
//                                                          the first persisted artifact)
//                 .planning/decisions/ADR-044-*.md      (D2: content-addressed,
//                                                          fs now, S3 later)
// Task:         T1032
//
// WHAT THIS MODULE GUARANTEES, stated in the words the plan uses (ADR-041 D2):
//   PostgreSQL stores METADATA ONLY - revisionId, format, templateId, templateVersion,
//   engineVersion, pageCount, sha256, byteSize, mimeType, storageKey. The BYTES live
//   here. The worker container NEVER receives this mount: policy 4.5's bind allowlist is
//   exactly three entries and all three are under `backend/typst/`, so a render that
//   succeeded inside the sandbox cannot have written to storage, and a storage write can
//   never have been made by the code that ran inside the sandbox.
//   `storage.test.ts` holds the grep gate that keeps that "only place" claim true, and
//   the one documented future exception (`render/broker/spool.ts`'s bounded `/out` spool,
//   T1031) is listed there with its reason.
//
// WHY CONTENT ADDRESSING, and why the key carries nothing else (ADR-044 D2):
//   `storageKeyFor(sha256) = artifacts/<first two hex>/<sha256>`. Two identical renders
//   produce two identical keys, so a re-render is a no-op instead of a second copy, and a
//   failed DB write can only ever ORPHAN a blob - never overwrite one another. The key
//   carries no template id, no revision id and no user data, so there is no injection
//   surface, no id-collision class, and no privacy question about what a path leaks. The
//   fan-out is the first two hex digits purely so no directory holds more than 256
//   entries.
//   The consequence, stated because it drives the whole implementation: because the key
//   IS the digest, `open`/`head` can report `sha256` from the key itself, and every
//   rejection has to be about the BYTES, never about a name.
//
// THE KEY GATE IS THE PATTERN, AND THE RESOLVED HALF IS PROVED AT THE CALL SITES. The
//   contract words this as "assertStorageKey(key): regex + resolved-path containment", and
//   the two halves live in two places ON PURPOSE, which is stated here so the contract and
//   the code cannot be read as disagreeing:
//     - `assertStorageKey` is SYNCHRONOUS and ROOT-LESS. It is handed a key and nothing
//       else, so there is no root to resolve a path against, and `realpath` is async - a
//       resolved check inside it would mean an async signature change to a function T1043
//       already calls, or a synchronous `realpath` that does not exist. The PATTERN is the
//       control: a key that matches cannot contain `..`, a leading `/`, a backslash, a
//       percent-encoded separator, a drive letter or a second segment, so resolving it
//       against ANY root lands inside that root. The pattern is what MAKES containment
//       true; it is not a weaker stand-in for it.
//     - the RESOLVED half - the check a pattern cannot make, because it is about a
//       SYMLINKED PARENT planted under the root rather than about the key - is
//       `assertResolvedInsideRoot`, and it runs on every path this module touches, before a
//       single byte is read or written: the fan-out directory (`prepareFanout`), an
//       existing blob (`verifyExisting`), and `open`, `head` and `remove`.
//   `storage.test.ts` pins BOTH halves: the pattern half in `every key the module can
//   produce resolves INSIDE the root, whatever the root is`, the resolved half in the
//   symlinked-fan-out tests (which cover `put`, `open`, `head` and `remove`).
//
// THE WRITE PATH, and why it is temp-then-publish rather than write-directly:
//   `put` streams into a `.tmp-` name INSIDE the fan-out directory, hashing and counting
//   as it goes, and only renames into place once the digest and the byte count both
//   match the declaration. Three things follow, each with a test:
//     - a WRONG digest or a WRONG declared size leaves NOTHING behind, so a failed put can
//       never leave a half-written blob at an address that describes different bytes;
//     - a blob is never observable in a partial state, because the key only appears once
//       its bytes are proven;
//     - the publish step is a `link()`, not a `rename()`. A rename OVERWRITES an existing
//       key, which would let a late writer replace the bytes an earlier reader already
//       recorded a hash for. `link()` fails with EEXIST instead, and EEXIST is the
//       content-addressed idempotence answer: re-verify the file that is already there
//       and report success - or, if it does not match its own address, refuse. Never
//       report success for a blob that is not what its key says.
//
// EVERY FAILURE IS A `StorageError` WITH A FIXED MESSAGE (policy 9.3/9.4's rule, the same
//   rule `stage.ts` follows): the message is a lookup keyed by a CLOSED set of reasons, so
//   no host path, no storage key, no digest, no byte count and no artifact byte can be
//   interpolated into it. The `reason` is the machine string a caller logs server-side.
//   `STORAGE_NOT_FOUND` is in the closed set for a caller's error mapping, but this
//   implementation never throws it: the plan makes absence a `null` from `open`/`head` so
//   the caller's 404 decision is explicit and cannot be mistaken for a host fault.
//
// THE S3 SEAM IS A SEAM, NOT A FALLBACK (ADR-044 D2): `kind: 's3'` maps to
//   Put/Get/Head/DeleteObject, and it throws `STORAGE_UNAVAILABLE` at construction. It
//   performs no filesystem call and no dependency is added, so selecting it can never
//   silently write artifacts to the local disk under an operator who asked for object
//   storage.
//
// =====================================================================================
// T1052 - WHERE THE READ-PATH VERIFIER LIVES, AND WHY IT IS OPT-IN
// =====================================================================================
// The gap this closes: the WRITE path verifies (`put` hashes while streaming) and the key IS
// the digest, but `open` only REPORTED the digest its key names - it never compared the bytes.
// So a blob that was truncated, bit-rotted or replaced in place under its own address was
// handed to a reader as if it were the artifact, and the document download served it.
//
// THE DECISION: the verifier lives HERE, as an OPT-IN `open(key, {verify: true})`, and the
// document route asks for it. The two alternatives were weighed and both are worse:
//
//   - "verify by default". `head` exists precisely for a caller that needs to prove PRESENCE
//     cheaply, and `open` is for a caller that needs the BYTES. Making verification
//     unconditional taxes every future caller with a whole-blob read it may not want, and it
//     would change the meaning of an existing call. The default is therefore unchanged and
//     the verification is a NAMED request: `open(key)` still means "these are the bytes at
//     this address", and `open(key, {verify: true})` means "and prove they are".
//   - "verify at the route". The route would then own its own `createHash` loop, its own
//     comparison, and its own reading of the row's `hash` - a second answer to a question
//     this module owns ("do these bytes match this address?"), and a second place where the
//     closed `STORAGE_*` vocabulary is decided. ADR-044 D2 makes the key the digest precisely
//     so that question has ONE answer in ONE module.
//
// WHY IT IS NOT "STREAM THROUGH AND VERIFY": a route that has already committed
// `Content-Length` cannot turn a bad digest into a machine-readable answer - the bytes are on
// the wire and the best it can do is truncate, which is not an error the client can read. So
// `open(key, {verify: true})` proves the blob FIRST (one bounded read; a resume PDF is about
// 17 KB) and only then returns the stream it is about to hand over. The cost is one extra
// read of a file that is about to be read anyway; the benefit is that a corrupted blob is a
// refusal with a `code` instead of a silently corrupt 200. The reader is `hashFile`, the
// EXISTING bounded one `verifyExisting` already uses, so there is no second hashing
// implementation here.
//
// ENV: the root is injectable (`createArtifactStore({root})`) and otherwise read
//   LAZILY from `RENDER_STORAGE_ROOT` at call time, defaulting to `backend/.artifacts`
//   outside production. The zod wiring for `RENDER_STORAGE_KIND` / `RENDER_STORAGE_ROOT`
//   and the boot call belong to T1043 (plan sec. 7 owns the env block); this module
//   exports the key names and `assertRequiredStorageConfig()` so that wiring is one line,
//   and nothing here throws at import time, so a test can read the env either way.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, type ReadStream, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { ARTIFACT_MIME_TYPES, StageError, assertPathInsideRoot, assertRealPathInsideRoot } from './stage.js';
import { RENDER_LIMITS } from './sandbox.js';

// ---------------------------------------------------------------------------
// The rejection vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed set of codes a storage rejection may carry.
 *
 * - `STORAGE_KEY_INVALID`  - the key is not a content-addressed artifact path, or it does
 *                            not address the digest the caller declared. A caller bug, and
 *                            the one code here that is safe to show.
 * - `STORAGE_NOT_FOUND`    - reserved for a caller's error mapping. NEVER thrown by the
 *                            fs implementation: `open`/`head` return `null` instead, so
 *                            "absent" can never be confused with "the host is broken".
 * - `STORAGE_IO`           - a host fault or a refused path: EACCES, ENOSPC, a symlink at
 *                            the key, a root that is not a directory.
 * - `STORAGE_TOO_LARGE`    - the declared or measured size is wrong in EITHER direction,
 *                            or over the policy cap. One code for "the declared size is
 *                            not this artifact's size", because a caller has one branch to
 *                            write; `reason` says which direction it was.
 * - `STORAGE_HASH_MISMATCH`- the bytes do not hash to the digest the key names - on the
 *                            way in, or on the file already at the key.
 * - `STORAGE_UNAVAILABLE`  - a storage kind this build does not implement. Fail closed.
 */
export const STORAGE_ERROR_CODES = Object.freeze([
  'STORAGE_KEY_INVALID',
  'STORAGE_NOT_FOUND',
  'STORAGE_IO',
  'STORAGE_TOO_LARGE',
  'STORAGE_HASH_MISMATCH',
  'STORAGE_UNAVAILABLE',
] as const);

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/** The closed set of REASONS. Machine-readable, log-safe, never user-facing. */
export const STORAGE_REJECTION_REASONS = Object.freeze([
  // key shape and address
  'KEY_MALFORMED',
  'KEY_ADDRESS_MISMATCH',
  // malformed caller input (never a statement about the bytes)
  'REQUEST_INVALID',
  'CONTENT_TYPE_INVALID',
  'DECLARED_SIZE_INVALID',
  // size, in both directions
  'EXCEEDS_DECLARED',
  'SHORT_OF_DECLARED',
  'OVER_CAP',
  'EXISTING_SIZE_MISMATCH',
  // content
  'HASH_MISMATCH',
  'EXISTING_HASH_MISMATCH',
  // refused paths
  'SYMLINK_REFUSED',
  'NOT_REGULAR',
  'HARDLINK_REFUSED',
  'ROOT_INVALID',
  'PATH_ESCAPES_ROOT',
  // host fault
  'IO_ERROR',
  // configuration
  'KIND_UNAVAILABLE',
] as const);

export type StorageRejectionReason = (typeof STORAGE_REJECTION_REASONS)[number];

/**
 * Fixed text per reason. A lookup table, not a template, so it is structurally impossible
 * to interpolate a key, a digest, a path or artifact content into a message.
 */
const REASON_TEXT: Readonly<Record<StorageRejectionReason, string>> = Object.freeze({
  KEY_MALFORMED: 'a storage key is not a content-addressed artifact path',
  KEY_ADDRESS_MISMATCH: 'a storage key does not address the digest the caller declared',
  REQUEST_INVALID: 'the storage request is malformed',
  CONTENT_TYPE_INVALID: 'a content type is not a bare media type',
  DECLARED_SIZE_INVALID: 'a declared byte count is not a whole number of bytes',
  EXCEEDS_DECLARED: 'the artifact is larger than its declared byte count',
  SHORT_OF_DECLARED: 'the artifact is smaller than its declared byte count',
  OVER_CAP: 'the artifact exceeds the render output cap',
  EXISTING_SIZE_MISMATCH: 'the file already at the key is not the declared size',
  HASH_MISMATCH: 'the stored bytes do not hash to the declared digest',
  EXISTING_HASH_MISMATCH: 'the file already at the key does not match its own address',
  SYMLINK_REFUSED: 'a storage path is a symbolic link',
  NOT_REGULAR: 'a storage path is not a regular file',
  HARDLINK_REFUSED: 'a storage path is a hardlinked file',
  ROOT_INVALID: 'the storage root is not a real directory',
  PATH_ESCAPES_ROOT: 'a storage path resolves outside the storage root',
  IO_ERROR: 'the host filesystem could not complete the storage operation',
  KIND_UNAVAILABLE: 'the configured artifact storage kind is not implemented in this build',
});

/** A storage rejection. Carries a code and a reason, never a path. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly reason: StorageRejectionReason;

  constructor(code: StorageErrorCode, reason: StorageRejectionReason) {
    super(`${code}: ${REASON_TEXT[reason]}`);
    this.name = 'StorageError';
    this.code = code;
    this.reason = reason;
  }
}

/** The one way out of this module: every rejection is a `StorageError`, never a raw throw. */
function fail(code: StorageErrorCode, reason: StorageRejectionReason): never {
  throw new StorageError(code, reason);
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The one directory a key may live under, relative to the storage root. */
export const STORAGE_KEY_PREFIX = 'artifacts/';

/**
 * The whole key grammar: a fixed prefix, a two-hex fan-out segment, and a 64-hex digest.
 *
 * Deliberately has no escape hatch. It cannot contain `..`, a leading `/`, a backslash, a
 * drive letter, a NUL, a percent-encoded separator or a second segment, so every key that
 * matches is a plain relative path whose resolution against ANY root stays inside that
 * root - the containment `assertStorageKey` documents is a property of the pattern, not a
 * runtime check. `.tmp-` (the `put` scratch name) cannot match, so a scratch file can
 * never be addressed as an artifact.
 */
export const STORAGE_KEY_PATTERN = /^artifacts\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** A bare media type: `type/subtype`, no parameters, no whitespace, no control bytes. */
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,62}$/;

const DIGEST_LENGTH = 64;

/**
 * The content-addressed key for a digest. Pure derivation: the same bytes always produce
 * the same key, which is what makes `put` idempotent and a failed DB write harmless.
 */
export function storageKeyFor(sha256: string): string {
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    fail('STORAGE_KEY_INVALID', 'KEY_MALFORMED');
  }
  return `${STORAGE_KEY_PREFIX}${sha256.slice(0, 2)}/${sha256}`;
}

/**
 * The key gate: the pattern, and nothing else - BY DESIGN, not by omission. It is handed a
 * key and no root, so there is nothing to resolve a path against, and `realpath` is async,
 * so a resolved check here would be an async signature change to a function T1043 already
 * calls. The pattern is what makes containment true (see `STORAGE_KEY_PATTERN`); the
 * RESOLVED containment check, which catches a symlinked parent directory, lives in
 * `assertResolvedInsideRoot` and runs on every path the store touches. The module header
 * states the split in full, and `storage.test.ts` pins both halves.
 */
export function assertStorageKey(key: string): string {
  if (typeof key !== 'string' || !STORAGE_KEY_PATTERN.test(key)) {
    fail('STORAGE_KEY_INVALID', 'KEY_MALFORMED');
  }
  return key;
}

/** The digest a validated key names. Never read off the filesystem - it IS the name. */
function digestForKey(key: string): string {
  const digest = key.slice(key.length - DIGEST_LENGTH);
  // Cheap by construction (the pattern already matched) and load-bearing: it is what
  // makes the fan-out segment and the digest one address rather than two fields.
  if (storageKeyFor(digest) !== key) fail('STORAGE_KEY_INVALID', 'KEY_MALFORMED');
  return digest;
}

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

/** One artifact going in. Every field is DECLARED by the caller and re-checked here. */
export interface PutArtifactRequest {
  /** `storageKeyFor(sha256)`. The caller derives it; the store re-checks both halves. */
  readonly key: string;
  /** `openArtifactStream(artifact)` (T1013), or any `Readable`. Never buffered whole. */
  readonly bytes: Readable;
  /** `ARTIFACT_MIME_TYPES[format]` (T1013) / the export MIME types (T1044). */
  readonly contentType: string;
  /** Declared length, re-counted WHILE streaming. */
  readonly byteSize: number;
  /** Declared digest, re-computed WHILE streaming. */
  readonly sha256: string;
}

/** What a successful `put`/`head` knows about a stored artifact. */
export interface StoredArtifact {
  readonly key: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly contentType: string;
}

/** `open` is the only call that hands bytes out. `null` means "absent", never "broken". */
export interface OpenArtifact {
  readonly stream: ReadStream;
  readonly byteSize: number;
  readonly sha256: string;
  readonly contentType: string;
}

/**
 * How much `open` should prove about the blob it is about to hand out (T1052).
 *
 * Absent, or `verify: false`, keeps the ORIGINAL contract and the ORIGINAL cost: the same
 * guards `open` has always run (key pattern, resolved containment, regular-and-unhardlinked,
 * over-cap, content-type sniff) and no whole-blob read. `verify: true` adds ONE bounded pass
 * that hashes the file and refuses it unless it hashes to the digest its key names
 * (`STORAGE_HASH_MISMATCH` / `EXISTING_HASH_MISMATCH`) - the read-side twin of the check
 * `verifyExisting` already performs on the write side.
 */
export interface OpenArtifactOptions {
  /** Hash the blob and refuse it unless it matches its own address. Default `false`. */
  readonly verify?: boolean;
}

export interface ArtifactHead {
  readonly byteSize: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly createdAt: Date;
}

export type StorageDescriptor =
  | { readonly kind: 'fs'; readonly root: string }
  | { readonly kind: 's3'; readonly bucket: string };

/**
 * The port. The ONLY way artifact bytes reach the disk, so a future renderer cannot write
 * one by accident: it has to come through `put`, and `put` is the code below.
 */
export interface ArtifactStore {
  put(request: PutArtifactRequest): Promise<StoredArtifact>;
  /**
   * The bytes at a key. `options.verify` (T1052) additionally proves they hash to the digest
   * the key names; omitted, the call costs what it always cost. An implementation that
   * ignores the option is still contract-conformant on the DEFAULT and non-conformant on the
   * verified call, which is exactly the mistake the option exists to catch.
   */
  open(key: string, options?: OpenArtifactOptions): Promise<OpenArtifact | null>;
  head(key: string): Promise<ArtifactHead | null>;
  remove(key: string): Promise<void>;
  /** Diagnostics for a boot log or a health probe. NEVER client-visible. */
  describe(): StorageDescriptor;
}

/** The store configuration, injectable so a test needs no env and no shared directory. */
export interface StorageEnv {
  readonly kind?: 'fs' | 's3';
  readonly root?: string;
}

// ---------------------------------------------------------------------------
// Env - read LAZILY, owned by T1043's zod block (plan sec. 7)
// ---------------------------------------------------------------------------

const ENV_KIND = 'RENDER_STORAGE_KIND';
const ENV_ROOT = 'RENDER_STORAGE_ROOT';

/** The env key names, exported so the zod schema in `config/env.ts` has one source. */
export const STORAGE_ENV_KEYS = Object.freeze([ENV_KIND, ENV_ROOT] as const);

/** The out-of-production default: `backend/.artifacts`, gitignored. */
export const STORAGE_DEFAULT_DIRNAME = '.artifacts';

function envValue(key: string): string | undefined {
  const raw = process.env[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * The production boot assertion, mirroring `assertRequiredRuntimeConfig()`: outside
 * production the default is fine, and in production an unset root is a configuration
 * error rather than a surprise directory appearing in the image. Called by T1043's boot
 * path; it reads env at CALL time, so it never throws on import.
 */
export function assertRequiredStorageConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (envValue(ENV_ROOT) === undefined) {
    throw new Error(
      'RENDER_STORAGE_ROOT is not set. Set it before starting in production; the default is a development directory.'
    );
  }
}

// ---------------------------------------------------------------------------
// Path guards
// ---------------------------------------------------------------------------

function errnoCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** `lstat`, with "absent" as a value. Any other errno is a host fault, not a null. */
async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return null;
    if (errnoCode(err) === 'ENOTDIR') return null;
    fail('STORAGE_IO', 'IO_ERROR');
  }
}

/**
 * The one place this module's error vocabulary meets `stage.ts`'s.
 *
 * The two containment guards below are `stage.ts`'s, not this module's, so they reject
 * with a `StageError` carrying the STAGING codes. The rule stated in this module's header
 * - the only way out is a `StorageError` with a fixed message - is what this translation
 * keeps, and it FAILS CLOSED: anything that is not the escape answer becomes a host fault,
 * so a foreign error can neither reach a caller nor carry a host path into a message. The
 * two helpers can only report the reason passed in (`PATH_ESCAPES_ROOT`) or a host fault
 * (`IO_ERROR`, when a `realpath` throws), which is the whole of this function.
 */
function rejectFromStageGuard(err: unknown): never {
  if (err instanceof StageError && err.reason === 'PATH_ESCAPES_ROOT') {
    fail('STORAGE_IO', 'PATH_ESCAPES_ROOT');
  }
  fail('STORAGE_IO', 'IO_ERROR');
}

/**
 * Lexical containment, before a resolved path is trusted.
 *
 * `stage.ts` OWNS this check and this module REUSES it rather than forking it: two
 * containment implementations in one repository is a drift surface in the most
 * security-relevant code in the phase, and the helper is exported from `stage.ts` for
 * exactly this. The `code`/`reason` parameters are how `stage.ts` keeps the two trees it
 * guards apart; the code is `RENDER_STAGE_IO` and the reason is translated above, because
 * only the REASON is a statement about this store.
 */
function assertLexicallyInsideRoot(root: string, candidate: string): void {
  try {
    assertPathInsideRoot(root, candidate, 'RENDER_STAGE_IO', 'PATH_ESCAPES_ROOT');
  } catch (err) {
    rejectFromStageGuard(err);
  }
}

/**
 * Resolved containment: `realpath` BOTH sides, then the same prefix test - reused from
 * `stage.ts`'s exported `assertRealPathInsideRoot`, which `stage.ts` already applies to
 * the staged tree and to `/out`.
 *
 * This is the check the key pattern cannot make (see the header). A key is lexically safe
 * by construction, but the fan-out DIRECTORY it names could be a symlink planted under the
 * root - on a case-insensitive filesystem, or by anything that can write into the root -
 * and then the lexically-safe key would resolve to a blob outside the storage root. The
 * type gate (`lstat`, below) refuses a symlinked blob; this refuses a symlinked parent.
 */
async function assertResolvedInsideRoot(root: string, candidate: string): Promise<void> {
  try {
    await assertRealPathInsideRoot(root, candidate, 'RENDER_STAGE_IO', 'PATH_ESCAPES_ROOT');
  } catch (err) {
    rejectFromStageGuard(err);
  }
}

/**
 * The type gate, `lstat` and never `stat`. The same shape `stage.ts` applies to a staged
 * entry: a symlink must be REFUSED, not followed, because `open`/`createReadStream` on
 * POSIX follow one; a non-regular entry is refused; and a hardlink (`nlink > 1`) is refused
 * because it is indistinguishable from a regular file except by link count, and a hardlinked
 * "artifact" in a content-addressed store means some other name can rewrite these bytes.
 *
 * `ownLinks` is the number of THIS module's scratch names that still point at the same
 * inode. The publish step is `link` + unlink, so between the two calls a concurrent `put`
 * of the SAME content can legitimately observe a blob with a second name - and refusing
 * that would make two identical renders race instead of de-duplicating. Every OTHER link
 * is still refused.
 *
 * NOT shared with `stage.ts`, deliberately: that guard is module-private, has no allowance
 * (a staged tree has no publish step), and reports the STAGING reasons `SYMLINK`/`HARDLINK`
 * rather than this module's. The two containment checks above ARE shared, because those are
 * genuinely the same question asked of two trees.
 */
function assertRegularUnhardlinked(stats: Stats, ownLinks = 0): void {
  if (stats.isSymbolicLink()) fail('STORAGE_IO', 'SYMLINK_REFUSED');
  if (!stats.isFile()) fail('STORAGE_IO', 'NOT_REGULAR');
  if (typeof stats.nlink === 'number' && stats.nlink - ownLinks > 1) {
    fail('STORAGE_IO', 'HARDLINK_REFUSED');
  }
}

interface KeyPaths {
  readonly fanout: string;
  readonly target: string;
  readonly digest: string;
}

function keyPaths(root: string, key: string): KeyPaths {
  const digest = digestForKey(key);
  const fanout = path.join(root, STORAGE_KEY_PREFIX.slice(0, -1), digest.slice(0, 2));
  const target = path.join(fanout, digest);
  assertLexicallyInsideRoot(root, target);
  return { fanout, target, digest };
}

// ---------------------------------------------------------------------------
// Content type
// ---------------------------------------------------------------------------

/**
 * The metadata content types this build can recognise, taken from `stage.ts`'s
 * `ARTIFACT_MIME_TYPES` (policy 6.4) rather than from a second table or a dependency.
 */
export const STORAGE_CONTENT_TYPES: Readonly<Record<'pdf' | 'png' | 'svg', string>> =
  Object.freeze({
    pdf: ARTIFACT_MIME_TYPES.pdf,
    png: ARTIFACT_MIME_TYPES.png,
    svg: ARTIFACT_MIME_TYPES.svg,
  });

/** What a blob whose leading bytes match none of the three reports. Never a guess. */
export const STORAGE_UNKNOWN_CONTENT_TYPE = 'application/octet-stream';

const MAGIC_WINDOW = 512;
const SVG_SKIPPABLE = new Set<number>([0x20, 0x09, 0x0a, 0x0d]);

/**
 * A CONTENT check on a bounded prefix, the same shape `stage.ts` uses to decide a format
 * but a FORK of it, deliberately: `stage.ts`'s magic matcher is module-private and is
 * bound to its three `RenderFormat`s plus a `RENDER_ARTIFACT_INVALID` vocabulary, and a
 * fourth copy of a magic-number table in the most security-relevant code in the phase is
 * the drift surface worth avoiding (the two containment checks above are the same question
 * asked of two trees, which is why those two are shared).
 *
 * This exists because the address is content-only: a digest does not say whether the bytes
 * it names were stored as a pdf or as a png, and `open`/`head` have to answer
 * `contentType` for a blob written by an earlier process. Reading one 512-byte prefix
 * answers it without a sidecar file (a second thing to keep consistent, and a second
 * thing to leave behind on failure) and without re-hashing the whole artifact on a cache
 * probe. It is NOT a validation gate: `validateRenderArtifact()` already made that
 * decision, and an export blob (T1044) legitimately matches nothing here and reports
 * `application/octet-stream`, which is the honest answer rather than a wrong one.
 */
async function resolveContentType(target: string): Promise<string> {
  const buffer = Buffer.alloc(MAGIC_WINDOW);
  let filled = 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, 'r');
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    filled = bytesRead;
  } catch {
    fail('STORAGE_IO', 'IO_ERROR');
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
  const head = buffer.subarray(0, filled);
  if (head.subarray(0, 5).equals(Buffer.from('%PDF-', 'latin1'))) return STORAGE_CONTENT_TYPES.pdf;
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return STORAGE_CONTENT_TYPES.png;
  }
  // An SVG may carry a BOM, an XML declaration and whitespace before the root element.
  let offset = head.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  if (head.subarray(offset, offset + 5).toString('latin1') === '<?xml') {
    const close = head.indexOf('?>', offset, 'latin1');
    if (close !== -1) offset = close + 2;
  }
  while (offset < head.length && SVG_SKIPPABLE.has(head[offset] as number)) offset += 1;
  if (head.subarray(offset, offset + 4).equals(Buffer.from('<svg', 'latin1'))) {
    return STORAGE_CONTENT_TYPES.svg;
  }
  return STORAGE_UNKNOWN_CONTENT_TYPE;
}

// ---------------------------------------------------------------------------
// The fs implementation
// ---------------------------------------------------------------------------

/** Fan-out and scratch directory modes. Group-readable, never world-readable. */
const DIR_MODE = 0o750;
const BLOB_MODE = 0o640;
const TEMP_PREFIX = '.tmp-';

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  fail('STORAGE_IO', 'REQUEST_INVALID');
}

function assertContentType(contentType: unknown): string {
  if (
    typeof contentType !== 'string' ||
    contentType.length === 0 ||
    contentType.length > 127 ||
    !MEDIA_TYPE_PATTERN.test(contentType)
  ) {
    fail('STORAGE_IO', 'CONTENT_TYPE_INVALID');
  }
  return contentType;
}

/**
 * The source gate. A `Readable` is async-iterable, which is what the write loop consumes,
 * so that is what is required: a value that cannot be iterated is a malformed request, and
 * this module's contract is that every rejection is a `StorageError` rather than a raw
 * `TypeError` from `for await`.
 */
function assertReadable(bytes: unknown): Readable {
  if (bytes === null || typeof bytes !== 'object') fail('STORAGE_IO', 'REQUEST_INVALID');
  const candidate = bytes as { [Symbol.asyncIterator]?: unknown };
  if (typeof candidate[Symbol.asyncIterator] !== 'function') {
    fail('STORAGE_IO', 'REQUEST_INVALID');
  }
  return bytes as Readable;
}

/** Hash an existing blob in bounded chunks, so verification never buffers the artifact. */
async function hashFile(target: string, cap: number): Promise<string> {
  const hash = createHash('sha256');
  let seen = 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, 'r');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      seen += bytesRead;
      if (seen > cap) fail('STORAGE_TOO_LARGE', 'OVER_CAP');
      hash.update(buffer.subarray(0, bytesRead));
    }
  } catch (err) {
    if (err instanceof StorageError) throw err;
    fail('STORAGE_IO', 'IO_ERROR');
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
  return hash.digest('hex');
}

class FsArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  describe(): StorageDescriptor {
    return Object.freeze({ kind: 'fs', root: this.root });
  }

  /**
   * The fan-out directory, created idempotently and proved to be a real directory.
   *
   * The order is `mkdir` first, then the type gate, then the RESOLVED containment check -
   * and the order is load-bearing. `mkdir(..., {recursive: true})` follows a symlinked
   * parent, so a check that ran first would have to decide about a directory that does not
   * exist yet; checking afterwards is what catches it. The honest limit of that choice is
   * that a symlinked `artifacts/` can leave an EMPTY fan-out directory inside the link's
   * target - `mkdir` will not be talked out of it - so the guarantee this module makes is
   * the one that matters: no artifact BYTE lands outside the root, which the check below
   * runs before a single byte is written.
   */
  private async prepareFanout(fanout: string): Promise<void> {
    try {
      await mkdir(fanout, { recursive: true, mode: DIR_MODE });
    } catch {
      fail('STORAGE_IO', 'IO_ERROR');
    }
    const stats = await lstatOrNull(fanout);
    if (stats === null) fail('STORAGE_IO', 'ROOT_INVALID');
    // `mkdir` on a symlink to a directory succeeds, so the type gate has to come after it.
    if (stats.isSymbolicLink()) fail('STORAGE_IO', 'SYMLINK_REFUSED');
    if (!stats.isDirectory()) fail('STORAGE_IO', 'ROOT_INVALID');
    // And the resolved check, because a symlinked ANCESTOR of the fan-out (the root
    // itself, or `artifacts/`) is not a symlink to `lstat` at any path this module lstats.
    await assertResolvedInsideRoot(this.root, fanout);
  }

  /** How many of this module's own scratch names still point at this digest's blob. */
  private async ownScratchLinks(fanout: string, digest: string): Promise<number> {
    let names: string[];
    try {
      names = await readdir(fanout);
    } catch {
      return 0;
    }
    const prefix = `${TEMP_PREFIX}${digest}-`;
    return names.filter((name) => name.startsWith(prefix)).length;
  }

  /**
   * The idempotence answer. The key already exists, so the bytes are re-verified against
   * the address and the file is NOT rewritten; a file that does not match its own key is
   * refused rather than reported as a success. This is the branch that makes a re-render,
   * a retried request and a replayed job all free, and it is the branch that keeps a
   * corrupt or truncated blob from being served as if it were the artifact.
   */
  private async verifyExisting(
    key: string,
    fanout: string,
    target: string,
    stats: Stats,
    contentType: string,
    byteSize: number,
    digest: string,
  ): Promise<StoredArtifact> {
    assertRegularUnhardlinked(stats, await this.ownScratchLinks(fanout, digest));
    await assertResolvedInsideRoot(this.root, target);
    if (stats.size !== byteSize) fail('STORAGE_HASH_MISMATCH', 'EXISTING_SIZE_MISMATCH');
    if ((await hashFile(target, RENDER_LIMITS.outputBytes)) !== digest) {
      fail('STORAGE_HASH_MISMATCH', 'EXISTING_HASH_MISMATCH');
    }
    return Object.freeze({ key, byteSize: stats.size, sha256: digest, contentType });
  }

  /**
   * Stream to a scratch name inside the fan-out directory, verifying as the bytes go, and
   * return that name only if every check passed.
   *
   * The digest and the byte count are computed from the STREAM, never from a buffered
   * copy: the whole point of the mid-stream checks is that a source which is not what it
   * claimed cannot land, and that bound is only real if it is applied per chunk. The
   * scratch name cannot be a legal key (it starts with a dot and is not 64 hex), so a
   * partially written blob is never addressable, and a failed write unlinks it in its own
   * `finally` - the caller never learns the name, so the caller cannot be the one that has
   * to clean it up.
   */
  private async writeScratch(
    fanout: string,
    digest: string,
    source: Readable,
    byteSize: number,
  ): Promise<string> {
    const scratch = path.join(fanout, `${TEMP_PREFIX}${digest}-${randomBytes(8).toString('hex')}`);
    const hash = createHash('sha256');
    let written = 0;
    let completed = false;
    let handle: FileHandle | undefined;
    try {
      // O_EXCL|O_CREAT|O_WRONLY, mode 0640: a scratch name that somehow already exists is
      // a failure, never something to overwrite.
      handle = await open(scratch, 'wx', BLOB_MODE);
      for await (const chunk of source as AsyncIterable<unknown>) {
        const buf = toBuffer(chunk);
        written += buf.length;
        // Checked BEFORE the chunk is written, so an over-sized artifact cannot land even
        // partially. The policy cap was checked against the DECLARED size before any I/O,
        // and this bound is strictly tighter, so it is the one that binds mid-stream.
        if (written > byteSize) fail('STORAGE_TOO_LARGE', 'EXCEEDS_DECLARED');
        hash.update(buf);
        await handle.write(buf, 0, buf.length);
      }
      // A source that ended early is a wrong declared size, not a short read to forgive.
      if (written !== byteSize) fail('STORAGE_TOO_LARGE', 'SHORT_OF_DECLARED');
      if (hash.digest('hex') !== digest) fail('STORAGE_HASH_MISMATCH', 'HASH_MISMATCH');
      // Close before the caller links: an open descriptor would be a second live handle
      // on a blob nobody has published yet.
      await handle.close();
      handle = undefined;
      completed = true;
      return scratch;
    } catch (err) {
      // A `StorageError` is this module's own rejection and propagates untouched. Anything
      // else is a stream that ERRORED (a vanished file, an aborted read) and carries its own
      // path in the message, so it is translated rather than allowed to reach the error
      // surface (policy 9.3). Written as an explicit `throw` on the last line so the
      // function's end is unreachable by construction, not by inference.
      if (!(err instanceof StorageError)) fail('STORAGE_IO', 'IO_ERROR');
      throw err;
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (!completed) await rm(scratch, { force: true }).catch(() => undefined);
    }
  }

  async put(request: PutArtifactRequest): Promise<StoredArtifact> {
    if (request === null || typeof request !== 'object') fail('STORAGE_IO', 'REQUEST_INVALID');
    // 1. The key, then its ADDRESS: both halves of `storageKeyFor` have to agree, so a
    //    caller cannot file bytes under an address that describes different bytes.
    const key = assertStorageKey(request.key);
    const { fanout, target, digest } = keyPaths(this.root, key);
    if (request.sha256 !== digest) fail('STORAGE_KEY_INVALID', 'KEY_ADDRESS_MISMATCH');
    const contentType = assertContentType(request.contentType);
    if (!Number.isSafeInteger(request.byteSize) || request.byteSize < 0) {
      fail('STORAGE_IO', 'DECLARED_SIZE_INVALID');
    }
    // 2. The declared size against the policy cap, before any I/O and before the root is
    //    even created, so an over-cap artifact cannot cause a directory to appear.
    if (request.byteSize > RENDER_LIMITS.outputBytes) fail('STORAGE_TOO_LARGE', 'OVER_CAP');
    const source = assertReadable(request.bytes);

    // 3. Idempotence, cheaply: an already-present key is re-verified, never rewritten, and
    //    the caller's stream is not even read.
    const existing = await lstatOrNull(target);
    if (existing !== null) {
      return this.verifyExisting(key, fanout, target, existing, contentType, request.byteSize, digest);
    }
    return this.putStream(key, fanout, target, digest, contentType, request.byteSize, source);
  }

  private async putStream(
    key: string,
    fanout: string,
    target: string,
    digest: string,
    contentType: string,
    byteSize: number,
    source: Readable,
  ): Promise<StoredArtifact> {
    await this.prepareFanout(fanout);
    // The scratch file's lifetime is THIS frame's business: it is created here, published
    // here, and unlinked here on every path including success, so a `put` can never leave
    // a `.tmp-` file behind for a later run to trip over.
    let scratch: string | null = null;
    try {
      scratch = await this.writeScratch(fanout, digest, source, byteSize);

      // 4. Publish. `link` is the atomic, no-clobber form of "rename into place": a rename
      //    would OVERWRITE an existing key, which would let a late writer replace bytes a
      //    reader already recorded a digest for. EEXIST is a concurrent or earlier writer
      //    having published the same content, and the only correct response is to re-verify
      //    what is there.
      try {
        await link(scratch, target);
      } catch (err) {
        if (errnoCode(err) === 'EEXIST') {
          const now = await lstatOrNull(target);
          if (now !== null) {
            return this.verifyExisting(key, fanout, target, now, contentType, byteSize, digest);
          }
        }
        fail('STORAGE_IO', 'IO_ERROR');
      }
    } finally {
      if (scratch !== null) await rm(scratch, { force: true }).catch(() => undefined);
    }

    // 5. The post-condition, proven rather than assumed: the key exists, is a regular
    //    unhardlinked file, and is exactly the byte count that was verified. This runs
    //    AFTER the scratch name is unlinked, because until then the blob honestly has two
    //    names and `nlink` is 2 - a `put` must not be reported as a hardlink by its own
    //    scratch file.
    const published = await lstatOrNull(target);
    if (published === null) fail('STORAGE_IO', 'IO_ERROR');
    // ...and when that unlink does not take, the ONE link this frame can still explain is
    // its own scratch name: Windows refuses the unlink with EPERM/EBUSY while a handle is
    // closing, and a `put` that published correctly must never report ITSELF as a
    // hardlink - a spurious rejection of a successful write. The leftover is PROVEN, not
    // assumed: it is the name this frame created with `O_EXCL`, so a second name that is
    // not it is still refused and a real hardlink at the key cannot slip past here.
    const ownLink = scratch !== null && (await lstatOrNull(scratch)) !== null ? 1 : 0;
    assertRegularUnhardlinked(published, ownLink);
    if (published.size !== byteSize) fail('STORAGE_HASH_MISMATCH', 'EXISTING_SIZE_MISMATCH');
    return Object.freeze({ key, byteSize, sha256: digest, contentType });
  }

  async open(key: string, options?: OpenArtifactOptions): Promise<OpenArtifact | null> {
    const valid = assertStorageKey(key);
    const { target, digest } = keyPaths(this.root, valid);
    const stats = await lstatOrNull(target);
    // Absence is a VALUE. A caller that has to catch an exception to learn a document has
    // no file yet will eventually treat the exception as the 404 path, and then a host
    // fault becomes a missing document.
    if (stats === null) return null;
    assertRegularUnhardlinked(stats);
    await assertResolvedInsideRoot(this.root, target);
    if (stats.size > RENDER_LIMITS.outputBytes) fail('STORAGE_TOO_LARGE', 'OVER_CAP');
    // T1052: the READ-side twin of `verifyExisting`. It runs AFTER the type and containment
    // gates (so the file is known to be the regular unhardlinked blob it claims to be before
    // a byte of it is read) and BEFORE the content-type sniff and the stream are handed over,
    // so a caller that asked for verification has a refusal and never a partially-usable
    // `OpenArtifact`. The SIZE is not re-checked here: a truncated or padded file cannot hash
    // to its own address, and `stats.size` is already reported for the caller to compare
    // against the byte count it expects.
    if (options !== undefined && options.verify === true) {
      if ((await hashFile(target, RENDER_LIMITS.outputBytes)) !== digest) {
        fail('STORAGE_HASH_MISMATCH', 'EXISTING_HASH_MISMATCH');
      }
    }
    // The sniff is resolved BEFORE the stream is created, not merely before the object is
    // returned. `createReadStream` opens the file on its own schedule and reports a failure
    // by EMITTING `error` on the stream; a stream that is built and then abandoned -
    // because the awaited sniff threw first - has no `error` listener at all, which Node
    // treats as an uncaught exception rather than a rejection. Awaiting first means the
    // only stream this call can leave behind is one the caller is already holding.
    const contentType = await resolveContentType(target);
    return Object.freeze({
      stream: createReadStream(target),
      byteSize: stats.size,
      sha256: digest,
      contentType,
    });
  }

  async head(key: string): Promise<ArtifactHead | null> {
    const valid = assertStorageKey(key);
    const { target } = keyPaths(this.root, valid);
    const stats = await lstatOrNull(target);
    if (stats === null) return null;
    assertRegularUnhardlinked(stats);
    await assertResolvedInsideRoot(this.root, target);
    if (stats.size > RENDER_LIMITS.outputBytes) fail('STORAGE_TOO_LARGE', 'OVER_CAP');
    return Object.freeze({
      byteSize: stats.size,
      sha256: digestForKey(valid),
      contentType: await resolveContentType(target),
      createdAt: stats.mtime,
    });
  }

  async remove(key: string): Promise<void> {
    const valid = assertStorageKey(key);
    const { target } = keyPaths(this.root, valid);
    const stats = await lstatOrNull(target);
    // A second `remove` is a no-op, not an error: deletion is retried by callers and
    // "already gone" is the desired end state, not a failure to report.
    if (stats === null) return;
    // A directory at a key path is refused rather than removed recursively: this call is
    // authorised to remove ONE artifact, never a tree. A symlink is unlinked (which never
    // touches its target) because that leaves the key addressable again.
    if (stats.isDirectory()) fail('STORAGE_IO', 'NOT_REGULAR');
    // Resolved containment, the guard every other mutator runs: a symlinked PARENT (a
    // symlinked `artifacts/`, or a symlinked fan-out) would otherwise make this unlink
    // delete a file OUTSIDE the root, so the refusal is the escape reason and the escapee
    // is left for an operator to inspect.
    //
    // A symlink AT the key is the one case that is proved differently rather than skipped.
    // Unlinking it removes the LINK and never its target, so resolving the target would
    // follow it out of the root and refuse a removal that is exactly contained; its PARENT
    // is proved instead, which is what stops the composition (a symlinked `artifacts/` AND
    // a symlink at the key) from removing a directory entry outside the root.
    if (stats.isSymbolicLink()) {
      await assertResolvedInsideRoot(this.root, path.dirname(target));
    } else {
      await assertResolvedInsideRoot(this.root, target);
    }
    try {
      await rm(target, { force: true });
    } catch {
      fail('STORAGE_IO', 'IO_ERROR');
    }
    if ((await lstatOrNull(target)) !== null) fail('STORAGE_IO', 'IO_ERROR');
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** The root used when neither an argument nor `RENDER_STORAGE_ROOT` names one. */
export function defaultStorageRoot(): string {
  return path.resolve(__dirname, '..', '..', STORAGE_DEFAULT_DIRNAME);
}

/**
 * Resolve the root: the argument, else `RENDER_STORAGE_ROOT`, else the development
 * default. An empty string is a refusal rather than a fallback, because `path.resolve('')`
 * is the process working directory and a storage root that silently became the repository
 * root is exactly the kind of accident this module exists to prevent.
 */
function resolveRoot(root: unknown): string {
  if (root === undefined) return path.resolve(envValue(ENV_ROOT) ?? defaultStorageRoot());
  if (typeof root !== 'string' || root.trim().length === 0) fail('STORAGE_IO', 'REQUEST_INVALID');
  return path.resolve(root);
}

/**
 * Build the store.
 *
 * `kind: 's3'` throws `STORAGE_UNAVAILABLE` HERE, before any filesystem call: the S3
 * mapping (Put/Get/Head/DeleteObject, with the digest and byte count as object metadata)
 * is a seam for a later task, and a build that cannot reach object storage must fail
 * closed rather than quietly keep writing artifacts to a local directory an operator
 * believes is unused. An unknown kind is refused the same way, so a typo cannot select
 * `fs` by accident.
 */
export function createArtifactStore(env: StorageEnv = {}): ArtifactStore {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    fail('STORAGE_IO', 'REQUEST_INVALID');
  }
  const kind = env.kind ?? envValue(ENV_KIND) ?? 'fs';
  if (kind !== 'fs') fail('STORAGE_UNAVAILABLE', 'KIND_UNAVAILABLE');
  return new FsArtifactStore(resolveRoot(env.root));
}
