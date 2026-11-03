// The broker's ONE host write path: a bounded, private, per-job spool for `/out`.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md sec. 6.2 (the 20
//                MiB cap), 6.3 (extraction defences), 10.1 (cleanup guarantees)
//                .planning/decisions/ADR-042-*.md D4 (`/work` NEVER touches the host)
//                .planning/decisions/ADR-044-*.md D1 (`tar -c` into a broker-private dir)
// Task:         T1031
//
// WHY THIS FILE EXISTS AT ALL, stated so the next reader does not "fix" it. Policy 3.1/4.4
// make `/work` a tmpfs, so the STAGED TREE NEVER EXISTS ON THE HOST (ADR-042 D4): it is
// built in memory by `stageRenderJobInMemory` and piped into the container through
// `docker exec -i ... tar -x -C /work`. The container's `/out`, however, has to come back
// out - and `docker cp` is unusable here for a MEASURED reason (ADR-042 D2: it fails
// against a running container under `read_only: true`, and it fails against a created one
// because `Could not find the file /work`, a tmpfs being empty until start). So the broker
// runs `docker exec <c> tar -c -C /out .`, captures that stream into a private directory it
// created itself, and hands the directory to `validateRenderArtifact()` (T1013), which is
// unchanged and still does all six policy 6.3 checks.
//
// THAT MAKES THIS THE ONLY NEW HOST WRITE PATH IN THE RENDER PHASE, and the mitigation is
// four properties, each enforced in code rather than in a comment:
//   1. PRIVATE. The directory is a `mkdtemp` under a broker-owned root with mode 0700, and
//      its name carries no job data (a random suffix, not a jobId), so nothing about a user
//      is legible in the host filesystem and nothing is guessable.
//   2. BOUNDED TWICE. The capture sink counts bytes as they are written and errors past
//      `RENDER_LIMITS.outputBytes` BEFORE the excess reaches the file, and the extractor
//      independently re-counts against the same cap. The first bound protects the host
//      disk; the second protects against a `tar` stream that would inflate on the way out.
//   3. PARSED, NOT SHELLED OUT. The archive is read by the bounded ustar reader in this
//      file, never by a host `tar`. A host `tar` would be a second, differently-configured
//      archive parser in the trust path (GNU tar strips a leading `/` and warns on `..`,
//      which is a POLICY decision delegated to a version nobody pinned); here the entry
//      rules are explicit, closed, and total.
//   4. REMOVED IN `finally`. `dispose()` is idempotent and never throws, so a failed job
//      cannot leave bytes behind - the cleanup guarantee of policy 10.1 and of the broker's
//      own per-job `finally`.
//
// WHAT THE EXTRACTOR REFUSES, and why each rule is a refusal rather than a repair:
//   - a symlink ('2'), hardlink ('1'), FIFO ('6'), device ('3'/'4') or pax/GNU extension
//     header ('x', 'g', 'L', 'K'): a `/out` that contains one of these is a template that
//     wrote outside its contract, which is `RENDER_ARTIFACT_INVALID` (policy 6.3) and not
//     something to normalise. Accepting a symlink here would reopen exactly the hole
//     `stage.ts` exists to close (typst follows symlinks - upstream #5454, open).
//   - a name with a separator, a `..`, a leading `/` or a leading dash: traversal and
//     argv-injection shapes, refused through `assertSafeStageName()` (policy 5.2.4), the
//     same validator the stager uses.
//   - a `prefix` field (ustar's 345..500 path continuation): a name that needs one is a
//     path, and a path is refused, so the field is required to be empty.
//   - a header whose checksum does not verify: a corrupt or tampered archive, refused
//     before a single entry is created.
//   - a destination that already exists: written with `O_EXCL`, so a second file can never
//     silently replace the first.
//   - more than `RENDER_LIMITS.inputFileCount` entries, which is also the count policy 6.1
//     permits in `/out` (exactly one artifact) plus nothing else.

import { randomBytes } from 'node:crypto';
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { assertSafeStageName, RENDER_LIMITS } from '../sandbox.js';
import { StageError } from '../stage.js';

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

/**
 * The spool cap. Policy 6.2's 20 MiB - the SUPERVISOR-side assertion. The kernel-side
 * guarantee is the container's `/out` tmpfs at 16 MiB, so this bound is a backstop and is
 * deliberately the LOOSER of the two: the tmpfs ENOSPCs first (policy 6.2, "two
 * independent bounds, deliberately").
 */
export const SPOOL_MAX_BYTES = RENDER_LIMITS.outputBytes;

/** The default broker-private root. Inside the broker container it is a tmpfs path; on a
 *  host it is never used, because the broker is always a container. */
export const SPOOL_DEFAULT_ROOT = '/tmp/clearance-render-spool';

/** ustar geometry. Identical to `stage.ts`'s writer, and re-derived rather than imported
 *  so the reader and the writer cannot disagree about the block size. */
const TAR_BLOCK = 512;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const TYPE_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;
const MAGIC_OFFSET = 257;
const MAGIC_LENGTH = 6;

const TYPE_FILE = '0';
/**
 * The typeflag a header carries when the field holds NUL. POSIX ustar says a regular file
 * is `'0'`, and an all-NUL field means the same thing (it is what an old `tar` writes for
 * a plain file). It is built with `String.fromCharCode(0)` rather than written as a
 * literal, so the byte survives any editor, encoding pass or diff tool intact.
 */
const TYPE_FILE_ALT = String.fromCharCode(0);
const TYPE_DIR = '5';

/** Read the typeflag as a one-character string, normalising an all-NUL field. */
function readTypeflag(header: Buffer): string {
  const byte = header[TYPE_OFFSET] as number;
  return byte === 0 ? TYPE_FILE_ALT : String.fromCharCode(byte);
}

// ---------------------------------------------------------------------------
// The spool directory
// ---------------------------------------------------------------------------

export interface Spool {
  /** The private directory. Contains exactly one child: `out`. */
  readonly dir: string;
  /** The directory `validateRenderArtifact` is pointed at. */
  readonly outDir: string;
  /** Where the `tar -c` capture lands. Opened with `openCapture()`. */
  readonly archivePath: string;
  /** Create (truncating) the capture sink, bounded at `maxBytes`. */
  openCapture(maxBytes?: number): Writable;
  /** Idempotent, never throws. */
  dispose(): Promise<void>;
}

/** A `mkdtemp` name that leaks nothing: 16 hex characters of kernel-independent entropy. */
function randomSuffix(): string {
  return randomBytes(8).toString('hex');
}

async function assertPrivateDirectory(dir: string): Promise<void> {
  const stats = await stat(dir).catch(() => undefined);
  if (stats === undefined) return;
  if (!stats.isDirectory()) {
    throw new StageError('RENDER_STAGE_IO', 'IO_ERROR');
  }
}

/**
 * Create the broker-private spool directory for ONE job.
 *
 * The root is created if absent (mode 0700) and the job directory is a fresh `mkdtemp`
 * inside it, so two concurrent jobs can never share a spool and a job can never inherit a
 * previous job's bytes. `O_EXCL` semantics come from `mkdtemp` itself, which fails rather
 * than reusing an existing name.
 *
 * The job directory name is `job-<hex>`: opaque, no job id, no user id, no template id.
 */
export async function createSpool(root: string = SPOOL_DEFAULT_ROOT): Promise<Spool> {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('RENDER_POLICY_VIOLATION: the spool root must be a non-empty path');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtempStrict(path.join(root, 'job-'));
  const outDir = path.join(dir, 'out');
  const archivePath = path.join(dir, 'out.tar');
  let disposed = false;
  return {
    dir,
    outDir,
    archivePath,
    openCapture(maxBytes: number = SPOOL_MAX_BYTES): Writable {
      assertBoundedCap(maxBytes);
      return createBoundedCapture(archivePath, maxBytes);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** `mkdtemp` with an explicit `ux` mode and a `job-` prefix, isolated so the temp-name
 *  suffix is a random hex string rather than anything derived from the caller. */
async function mkdtempStrict(prefix: string): Promise<string> {
  const suffix = randomSuffix();
  const candidate = `${prefix}${suffix}`;
  try {
    await mkdir(candidate, { mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      throw new StageError('RENDER_STAGE_IO', 'IO_ERROR');
    }
    // Astronomically unlikely; retry once with a fresh suffix rather than reusing a
    // directory another job may already own.
    return mkdtempStrict(prefix);
  }
  await assertPrivateDirectory(candidate);
  return candidate;
}

function assertBoundedCap(maxBytes: number): void {
  if (
    typeof maxBytes !== 'number' ||
    !Number.isFinite(maxBytes) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > SPOOL_MAX_BYTES
  ) {
    throw new Error(
      `RENDER_POLICY_VIOLATION: the spool bound must be a positive integer no larger than ${SPOOL_MAX_BYTES}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The bounded capture sink
// ---------------------------------------------------------------------------

/**
 * A Writable that writes to `file` and FAILS the stream once more than `maxBytes` have
 * been offered to it.
 *
 * The check is in `_write`, i.e. before the bytes are handed to the descriptor, so the
 * excess never reaches the file. That is the whole point: a supervisor that counted
 * afterwards would already have let a runaway writer fill the host disk, and the kernel
 * `size=` bound on the container's tmpfs is the only thing that would have saved it.
 *
 * The file is opened with `O_EXCL` and the writes are chained onto that ONE handle rather
 * than driven through `createWriteStream`. Both are deliberate:
 *   - `O_EXCL` means a capture can never overwrite a file another job left behind, so
 *     "the spool is broker-private" is enforced by the OPEN and not only by the directory
 *     name. It is also the one write shape `storage.test.ts` recognises as a write, so this
 *     module is caught by that gate rather than slipping past it - the same reason
 *     `storage.ts` writes through `open(..., 'wx')` rather than a stream;
 *   - one handle and one promise chain remove the backpressure and double-`end` failure
 *     modes a piped write stream has, and a spool capture has exactly one producer.
 *
 * The emitted error is a `SpoolOverflowError`, which the broker classifies as
 * `RENDER_ARTIFACT_INVALID` (policy 6.2/6.3: the supervisor was handed more than the
 * policy allows).
 */
export class SpoolOverflowError extends Error {
  readonly code = 'RENDER_ARTIFACT_INVALID';
  readonly reason = 'ARTIFACT_TOO_LARGE';

  constructor(readonly limit: number) {
    super(`RENDER_ARTIFACT_INVALID: the artifact spool exceeded its ${limit} byte bound`);
    this.name = 'SpoolOverflowError';
  }
}

function createBoundedCapture(file: string, maxBytes: number): Writable {
  let written = 0;
  let handle: FileHandle | null = null;
  let closed = false;
  // Every operation is chained onto this, so writes stay ordered and `final` cannot close
  // the descriptor while a chunk is still in flight.
  let queue: Promise<void> = open(file, 'wx', 0o600).then((opened) => {
    handle = opened;
  });
  // WHY EVERY REASSIGNMENT IS GUARDED (and this is a fix, not decoration). The chain below
  // is internal: the caller-visible surface is the sink's `'error'` EVENT, which
  // `waitForSink` observes and the broker classifies. Node treats a rejected promise with
  // no handler as an unhandled rejection, which - depending on the process's flags - prints
  // and can terminate the broker. So three shapes of "nobody is listening" were live at
  // once, and each of them is a real path rather than a theoretical one:
  //   1. the initial `open(file, 'wx')` rejects (a leftover file, a full spool volume);
  //   2. `_write` refuses an over-bound chunk and the chain is left rejected;
  //   3. `destroy()` re-assigns the chain and leaves THAT promise rejected - the reported
  //      "out.tar" teardown race, which fired when the broker destroyed an already-failing
  //      sink and then deleted the directory it was holding open.
  // `guard()` attaches a no-op handler WITHOUT consuming the rejection: the `_write` and
  // `_final` continuations below still see it and still hand it to their callback, so the
  // bound refusal is unchanged and only the process-level crash surface is removed.
  const guard = (): void => {
    queue.catch(() => undefined);
  };
  guard();
  const closeOnce = async (): Promise<void> => {
    if (closed || handle === null) return;
    closed = true;
    const current = handle;
    handle = null;
    await current.close().catch(() => undefined);
  };
  const asError = (error: unknown): Error =>
    error instanceof Error ? error : new Error(String(error));

  return new Writable({
    write(chunk, _encoding, callback) {
      written += chunk.length;
      if (written > maxBytes) {
        // Refuse BEFORE the write, and close the descriptor first so it is not leaked when
        // the consumer reacts to the error by deleting the directory.
        queue = queue.then(closeOnce);
        guard();
        callback(new SpoolOverflowError(maxBytes));
        return;
      }
      const bytes = chunk as Buffer;
      queue = queue.then(async () => {
        if (handle === null) throw new Error('RENDER_BROKER_UNAVAILABLE: the capture is closed');
        await handle.write(bytes, 0, bytes.length);
      });
      guard();
      queue.then(() => callback(), (error: unknown) => callback(asError(error)));
    },
    final(callback) {
      queue = queue.then(closeOnce);
      guard();
      queue.then(() => callback(), (error: unknown) => callback(asError(error)));
    },
    destroy(error, callback) {
      queue = queue.then(closeOnce);
      guard();
      callback(error);
    },
  });
}
/**
 * Resolve when the sink has finished, reject with the error it raised.
 *
 * The broker needs this between `docker exec` returning and reading the archive back,
 * because the capture is a FILE: the child's stdout reaching the sink is not the same event
 * as the bytes reaching the disk, and reading the file before the latter has happened is
 * either a truncated archive or - the failure this test suite actually hit - a file the
 * write stream never got to create. So the sink, not the child, decides when the capture is
 * complete.
 *
 * A sink that was already ended (a producer that closed it itself) resolves immediately
 * rather than hanging, and `destroy()` is idempotent, so a caller can end-then-wait or
 * wait-then-end without knowing which the producer did.
 *
 * AN ALREADY-DESTROYED SINK RESOLVES, and that is not a weaker promise than it looks. A
 * `Writable` destroys itself when `_write` refuses (that is how the 20 MiB bound is enforced),
 * so by the time the broker gets here the `'error'` and `'close'` events have ALREADY been
 * emitted and a listener attached now would never see either - waiting for a `'finish'` that
 * cannot arrive is how a job hangs holding its admission slot. The caller is therefore the one
 * that must remember the error: the broker attaches its own `'error'` listener BEFORE the
 * child starts, for exactly that reason, and checks it after this resolves.
 */
export function waitForSink(sink: Writable): Promise<void> {
  if (sink.destroyed || (sink.writableEnded && sink.writableFinished)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      sink.removeListener('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      sink.removeListener('finish', finish);
      sink.removeListener('close', finish);
      reject(error);
    };
    sink.once('finish', finish);
    sink.once('close', finish);
    sink.once('error', onError);
  });
}

// ---------------------------------------------------------------------------
// The bounded ustar reader
// ---------------------------------------------------------------------------

function parseOctal(field: Buffer): number {
  const text = field.toString('latin1').replace(/\0.*$/, '').trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
  }
  return value;
}

/**
 * The header checksum, computed the way tar computes it: every byte summed with the
 * checksum FIELD ITSELF read as spaces. Verified before the entry is trusted, because a
 * header that does not verify is either corrupt or not a ustar header at all, and either
 * way its `size` field is not something to hand to `ftruncate`.
 */
function verifyChecksum(header: Buffer): void {
  let signed = 0;
  let unsigned = 0;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    const inField =
      index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + CHECKSUM_LENGTH;
    const byte = inField ? 0x20 : (header[index] as number);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  const recorded = parseOctal(
    header.subarray(CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_LENGTH),
  );
  // Both spellings are accepted: a POSIX tar writes `0` spaces, some writers `8`.
  if (recorded !== unsigned && recorded !== signed) {
    throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
  }
}

/**
 * Read an entry name, reduced to the shape this reader is willing to act on.
 *
 * The reduction is `./`-stripping and nothing else, and the `./` is not optional
 * bookkeeping: `tar -c -C /out .` - the exact extraction command the broker runs - emits
 * `./` for the directory itself and `./artifact.pdf` for its single file, because that is
 * what "archive this directory, relatively" means to tar. A reader that refused the prefix
 * would refuse every real artifact, and a reader that STRIPPED it blindly would happily
 * accept a genuine path.
 *
 * So the rules, in order:
 *   - a ustar `prefix` (a path longer than 100 bytes) is refused outright: a name needing one
 *     is a path, and a path is refused, so the field is required to be empty;
 *   - leading `./` segments are removed - that is the archive-relative marker, and it is the
 *     only prefix accepted;
 *   - what remains must be a single segment. A remaining `/` (absolute or nested) or a `\`
 *     is refused, so `../x` and `/etc/passwd` cannot both survive the same normalisation;
 *   - an empty remainder is the ROOT entry (`./` or `.`), which is metadata rather than an
 *     entry to create, and is reported as such.
 *
 * The returned basename is handed to `assertSafeStageName()` before anything is created, so
 * the stager and the broker cannot drift apart on what a safe name is.
 */
interface EntryName {
  /** `''` for the archive root (`./`), otherwise a single safe segment. */
  readonly basename: string;
  readonly isRoot: boolean;
}

function readName(header: Buffer): EntryName {
  const prefix = header.subarray(PREFIX_OFFSET, PREFIX_OFFSET + PREFIX_LENGTH);
  if (prefix.some((byte) => byte !== 0)) {
    throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTSIDE_OUT');
  }
  const raw = header.subarray(NAME_OFFSET, NAME_OFFSET + NAME_LENGTH);
  const end = raw.indexOf(0);
  if (end === -1 && raw.every((byte) => byte !== 0)) {
    // A name that fills the field with no NUL terminator is a truncated header.
    throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
  }
  let name = raw.subarray(0, end === -1 ? raw.length : end).toString('latin1');
  // A directory entry's name always carries a trailing `/` in a real archive, so it is
  // stripped BEFORE the prefix and the separator checks. Order matters: `./` reduces to the
  // root only once both markers are gone.
  while (name.endsWith('/')) name = name.slice(0, -1);
  while (name.startsWith('./')) name = name.slice(2);
  if (name === '' || name === '.') return { basename: '', isRoot: true };
  if (name.startsWith('/') || name.includes('/') || name.includes('\\')) {
    throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTSIDE_OUT');
  }
  return { basename: name, isRoot: false };
}

/** Exact-length block reader over an async iterable of chunks. */
class BlockReader {
  private readonly chunks: Buffer[] = [];
  private offset = 0;

  constructor(private readonly source: AsyncIterator<Buffer>) {}

  /** The next exactly-`size` bytes, or `null` at a clean end of archive. */
  async next(size: number): Promise<Buffer | null> {
    while (this.byteLength() < size) {
      const next = await this.source.next();
      if (next.done === true) {
        if (this.byteLength() === 0) return null;
        throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
      }
      this.chunks.push(next.value as Buffer);
    }
    return this.take(size);
  }

  private byteLength(): number {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    return total;
  }

  private take(size: number): Buffer {
    const out = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const head = this.chunks[0] as Buffer;
      const available = head.length - this.offset;
      const take = Math.min(available, size - filled);
      head.copy(out, filled, this.offset, this.offset + take);
      filled += take;
      this.offset += take;
      if (this.offset === head.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return out;
  }
}

export interface SpoolExtraction {
  readonly fileCount: number;
  readonly dirCount: number;
  readonly totalBytes: number;
  /** The basenames created, in archive order. For the job log; never for the response. */
  readonly names: readonly string[];
}

/**
 * Extract a ustar archive into `destDir`, under a hard byte budget.
 *
 * `destDir` is created (not reused): a spool directory that already held an `out` would
 * make "exactly one entry in `/out`" - policy 6.3 check 3, which
 * `validateRenderArtifact` performs - mean something weaker. An existing `destDir` is
 * refused, not merged into.
 *
 * Every refusal is a `StageError` with the ARTIFACT code and a reason from `stage.ts`'s
 * closed set, so the broker's classification of the job is policy-shaped rather than a
 * bespoke vocabulary, and no path or entry name ever reaches a message.
 */
export async function extractUstarToDir(
  archive: Readable,
  destDir: string,
  maxBytes: number = SPOOL_MAX_BYTES,
): Promise<SpoolExtraction> {
  assertBoundedCap(maxBytes);
  const existing = await stat(destDir).catch(() => undefined);
  if (existing !== undefined) {
    throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTDIR_INVALID');
  }
  await mkdir(destDir, { mode: 0o700 });

  const reader = new BlockReader(archive[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  const names: string[] = [];
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;
  let entryCount = 0;
  let sawTerminator = false;

  for (;;) {
    const header = await reader.next(TAR_BLOCK);
    if (header === null) break;
    // The end-of-archive marker is two zero blocks; a single one is enough to stop.
    if (header.every((byte) => byte === 0)) {
      sawTerminator = true;
      break;
    }
    if (entryCount >= RENDER_LIMITS.inputFileCount) {
      throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
    }
    entryCount += 1;
    verifyChecksum(header);
    // `ustar\0` is six bytes with a NUL terminator, so the COMPARISON is five. Comparing
    // six would reject every archive `stage.ts` writes, which is the archive format this
    // reader exists to consume.
    if (header.subarray(MAGIC_OFFSET, MAGIC_OFFSET + 5).toString('latin1') !== 'ustar') {
      throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
    }
    const entry = readName(header);
    const size = parseOctal(header.subarray(SIZE_OFFSET, SIZE_OFFSET + SIZE_LENGTH));
    const type = readTypeflag(header);

    if (type === TYPE_DIR) {
      // The archive ROOT (`./`), which is what `tar -c -C /out .` emits first. It is
      // metadata, not an entry: `destDir` already IS the root, so creating anything for it
      // would be a no-op at best and a name collision at worst. Counted, not created.
      if (entry.isRoot) {
        dirCount += 1;
        continue;
      }
      // A real subdirectory: require the name to be a single safe segment, so `.pkgcache`
      // (legal as a staged DIRECTORY, not as a staged file) is accepted while `../x`,
      // `/etc` and `a/b` are not.
      await mkdir(path.join(destDir, entry.basename), { mode: 0o700 }).catch(() => {
        throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
      });
      dirCount += 1;
      names.push(entry.basename);
      continue;
    }
    if (type !== TYPE_FILE && type !== TYPE_FILE_ALT) {
      // A symlink, hardlink, device, FIFO or extension header. Refused, not repaired:
      // accepting a link here would reopen what stage.ts exists to close.
      throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
    }
    if (entry.isRoot) {
      // A REGULAR FILE named `./` is not a thing; treating it as "the artifact" would let a
      // malformed archive satisfy the single-artifact check with a nameless file.
      throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
    }
    // The name goes through the SAME validator the stager uses, so the broker and the
    // stager cannot disagree about what a safe staged name is. Its refusal is an
    // `RENDER_INPUT_INVALID` Error, which is the wrong CODE for this tree, so it is
    // translated: an extraction that lets a non-StageError escape would surface as a
    // broker fault (503) for what is plainly an invalid artifact (422).
    try {
      assertSafeStageName(entry.basename);
    } catch {
      throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
    }
    if (entry.basename !== entry.basename.trim() || entry.basename.includes(' ')) {
      throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
    }
    totalBytes += size;
    if (totalBytes > maxBytes) {
      throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_TOO_LARGE');
    }

    // O_EXCL: a duplicate entry fails here rather than overwriting what is already there,
    // so `exactly one entry in /out` cannot be faked by a later archive member. The path is
    // bound to a name first so the exclusive open is textually a plain `open(dest, 'wx')`,
    // which is what `storage.test.ts`'s write scan looks for.
    const dest = path.join(destDir, entry.basename);
    const handle = await open(dest, 'wx', 0o600).catch(() => {
      throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
    });
    try {
      let remaining = size;
      while (remaining > 0) {
        const chunk = await reader.next(Math.min(TAR_BLOCK, remaining));
        if (chunk === null) {
          throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_SIZE_CHANGED');
        }
        await handle.write(chunk, 0, chunk.length);
        remaining -= chunk.length;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    // tar pads every member out to a 512-byte boundary.
    const pad = size % TAR_BLOCK;
    if (pad !== 0) {
      await reader.next(TAR_BLOCK - pad);
    }
    fileCount += 1;
    names.push(entry.basename);
  }

  /* c8 ignore next 3 -- defensive: every writer this broker accepts emits a terminator */
  if (!sawTerminator) {
    throw new StageError('RENDER_ARTIFACT_INVALID', 'ARTIFACT_UNEXPECTED_ENTRY');
  }
  return Object.freeze({
    fileCount,
    dirCount,
    totalBytes,
    names: Object.freeze(names),
  });
}

/**
 * The staged tree's own ustar bytes, read back out of a buffer, for the `<content>`
 * redaction candidates. Reuses the reader, so a malformed archive cannot crash the
 * diagnostics path: a failure yields no candidates and the shape-based redaction still
 * stands on its own.
 */
export async function stagedTextCandidates(
  tree: Buffer,
  maxCandidates = RENDER_LIMITS.inputFileCount,
): Promise<string[]> {
  const candidates: string[] = [];
  const reader = new BlockReader(Readable.from([tree])[Symbol.asyncIterator]());
  try {
    for (;;) {
      if (candidates.length >= maxCandidates) break;
      const header = await reader.next(TAR_BLOCK);
      if (header === null || header.every((byte) => byte === 0)) break;
      verifyChecksum(header);
      readName(header);
      const size = parseOctal(header.subarray(SIZE_OFFSET, SIZE_OFFSET + SIZE_LENGTH));
      const type = readTypeflag(header);
      if (type === TYPE_DIR) {
        continue;
      }
      if (type !== TYPE_FILE && type !== TYPE_FILE_ALT) break;
      if (size === 0) continue;
      if (size > RENDER_LIMITS.outputBytes) break;
      const body = await reader.next(size);
      if (body === null) break;
      const pad = size % TAR_BLOCK;
      if (pad !== 0) await reader.next(TAR_BLOCK - pad);
      candidates.push(body.toString('utf8'));
    }
  } catch {
    // A tree this reader cannot parse contributes no candidates. Redaction does not
    // depend on them: the shape rule and the known-constant table are independent.
  }
  return candidates;
}
