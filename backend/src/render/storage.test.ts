// Artifact storage port - unit tests.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 2
//                 .planning/decisions/ADR-041 (metadata in Postgres, bytes in storage)
//                 .planning/decisions/ADR-042 D3 (the port lands BEFORE an artifact exists)
//                 .planning/decisions/ADR-044 D2 (content-addressed, fs now, S3 later)
// Task:         T1032
//
// Every guard below has a test that fails if the guard is removed. The mutation evidence
// for each is in `.planning/progress/T1032-artifact-storage-port.md`.
//
// NOTHING HERE NEEDS A DOCKER DAEMON. The integration test drives the real composition -
// `validateRenderArtifact()` -> `openArtifactStream()` -> `store.put()` -> `store.open()` -
// against a real `/out` directory holding a real artifact, which is the whole point of the
// port being testable before the broker exists.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ARTIFACT_MIME_TYPES, openArtifactStream, validateRenderArtifact } from './stage.js';
import { RENDER_LIMITS } from './sandbox.js';
import {
  STORAGE_CONTENT_TYPES,
  STORAGE_DEFAULT_DIRNAME,
  STORAGE_ENV_KEYS,
  STORAGE_ERROR_CODES,
  STORAGE_KEY_PATTERN,
  STORAGE_KEY_PREFIX,
  STORAGE_REJECTION_REASONS,
  STORAGE_UNKNOWN_CONTENT_TYPE,
  StorageError,
  assertRequiredStorageConfig,
  assertStorageKey,
  createArtifactStore,
  defaultStorageRoot,
  storageKeyFor,
  type ArtifactStore,
  type PutArtifactRequest,
} from './storage.js';

// __dirname is available both compiled to CJS and under vitest (repo convention:
// see src/ats/promptLoader.ts:8).
const HERE = __dirname;
const SRC = path.resolve(HERE, '..');

const PDF_BYTES = Buffer.from('%PDF-1.7\n% artifact fixture\n1 0 obj\n<<>>\nendobj\n', 'latin1');
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('rest'),
]);
const SVG_BYTES = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
]);
const TEX_BYTES = Buffer.from('\\documentclass{article}\n\\begin{document}x\\end{document}\n');
const CANARY = 'CLEARANCE_CANARY_T1032_41a7c9';

/** The SHA-256 of `bytes`, hex. The only way a test derives a legal key. */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let sandbox: string;
let root: string;
let store: ArtifactStore;
let created: string[] = [];

function track<T extends string>(p: T): T {
  created.push(p);
  return p;
}

beforeEach(async () => {
  sandbox = track(await mkdtemp(path.join(tmpdir(), 'clearance-storage-')));
  root = path.join(sandbox, 'store');
  store = createArtifactStore({ root });
});

afterEach(async () => {
  for (const p of created.reverse()) {
    await rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
  created = [];
});

/** The fan-out directory a key lands in, computed without going through the module. */
function fanoutFor(key: string): string {
  const parts = key.split('/');
  return path.join(root, parts[0] as string, parts[1] as string);
}

function targetFor(key: string): string {
  return path.join(fanoutFor(key), key.slice(key.length - 64));
}

/** A well-formed request, with pieces overridable per test. */
function request(bytes: Buffer, over: Partial<PutArtifactRequest> = {}): PutArtifactRequest {
  const sha256 = sha256Of(bytes);
  return {
    key: storageKeyFor(sha256),
    bytes: Readable.from([bytes]),
    contentType: ARTIFACT_MIME_TYPES.pdf,
    byteSize: bytes.length,
    sha256,
    ...over,
  };
}

async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/** Assert an async call rejects with a StorageError carrying exactly this code/reason. */
async function rejects(
  call: () => Promise<unknown>,
  code: string,
  reason?: string,
): Promise<StorageError> {
  // Thunks, not promises: a rejected promise created up front is an UNHANDLED rejection
  // until a handler is attached, which would fail the run for the wrong reason.
  let caught: unknown;
  try {
    await call();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected rejection ${code}`).toBeInstanceOf(StorageError);
  const storageError = caught as StorageError;
  expect(storageError.code).toBe(code);
  if (reason !== undefined) expect(storageError.reason).toBe(reason);
  return storageError;
}

/** The same for a synchronous call (`createArtifactStore`, `assertStorageKey`). */
function throwsSync(call: () => unknown, code: string, reason?: string): StorageError {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected throw ${code}`).toBeInstanceOf(StorageError);
  const storageError = caught as StorageError;
  expect(storageError.code).toBe(code);
  if (reason !== undefined) expect(storageError.reason).toBe(reason);
  return storageError;
}

/**
 * Create a symlink, degrading to a directory junction where the platform refuses a file
 * symlink (Windows without Developer Mode). Both are `isSymbolicLink() === true` under
 * `lstat`, which is the property the guard keys on, so the guard is proven either way and
 * the test never silently degrades into a no-op.
 */
async function symlinkAny(target: string, linkPath: string, dir = false): Promise<void> {
  const types: Array<'file' | 'dir' | 'junction'> =
    process.platform === 'win32' ? (dir ? ['junction'] : ['file', 'junction']) : dir
      ? ['dir']
      : ['file'];
  let last: unknown;
  for (const type of types) {
    try {
      await symlink(target, linkPath, type);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(
    `this host cannot create symlinks at all (${String(last)}); the symlink guard cannot be proven here`,
  );
}

/** A canary file OUTSIDE the storage root: the thing an escape would read or overwrite. */
async function canaryFile(name = 'canary.bin'): Promise<string> {
  const dir = track(await mkdtemp(path.join(sandbox, 'outside-')));
  const file = path.join(dir, name);
  await writeFile(file, CANARY);
  return file;
}

// ---------------------------------------------------------------------------
// Acceptance 1 - the key grammar
// ---------------------------------------------------------------------------

describe('render/storage - the content-addressed key', () => {
  it('a valid key round-trips: storageKeyFor -> assertStorageKey, and the key names the digest', () => {
    const digest = sha256Of(PDF_BYTES);
    const key = storageKeyFor(digest);
    expect(key).toBe(`artifacts/${digest.slice(0, 2)}/${digest}`);
    expect(key.startsWith(STORAGE_KEY_PREFIX)).toBe(true);
    expect(STORAGE_KEY_PATTERN.test(key)).toBe(true);
    expect(assertStorageKey(key)).toBe(key);
    // The fan-out segment IS the first two hex of the digest, so the two halves of the
    // address cannot disagree.
    expect(key.split('/')[1]).toBe(digest.slice(0, 2));
  });

  it('refuses ../x, an absolute path, a percent-encoded separator, a 63- and a 65-hex digest, and a non-string', () => {
    const digest = sha256Of(PDF_BYTES);
    const bad: unknown[] = [
      '../x',
      `artifacts/${digest.slice(0, 2)}/../../../etc/passwd`,
      'artifacts/aa/..%2F..%2Fetc%2Fpasswd',
      `artifacts/../artifacts/aa/${digest}`,
      '/etc/passwd',
      'C:\\Windows\\System32\\config\\SAM',
      `artifacts/${digest.slice(0, 2)}/${digest.slice(0, 63)}`,
      `artifacts/${digest.slice(0, 2)}/${digest}0`,
      `artifacts/${digest.slice(0, 2).toUpperCase()}/${digest}`,
      `artifacts/${digest.slice(0, 3)}/${digest}`,
      `artifacts/${digest}`,
      `templates/${digest.slice(0, 2)}/${digest}`,
      `${STORAGE_KEY_PREFIX}${digest.slice(0, 2)}/${digest}\n`,
      '',
      null,
      undefined,
      42,
      { key: digest },
    ];
    for (const key of bad) {
      const error = throwsSync(
        () => assertStorageKey(key as string),
        'STORAGE_KEY_INVALID',
        'KEY_MALFORMED',
      );
      expect(error.message).toBe(
        'STORAGE_KEY_INVALID: a storage key is not a content-addressed artifact path',
      );
    }
  });

  it('storageKeyFor refuses a digest that is not 64 lowercase hex, so a key cannot be built from junk', () => {
    const digest = sha256Of(PDF_BYTES);
    for (const bad of [digest.slice(0, 63), digest.toUpperCase(), '', 'zz', null, 7]) {
      throwsSync(() => storageKeyFor(bad as string), 'STORAGE_KEY_INVALID', 'KEY_MALFORMED');
    }
  });

  it('the key message is a fixed string: no key, no digest, no path and no canary is interpolated', () => {
    for (const key of [`${CANARY}/../x`, `artifacts/aa/${CANARY}`]) {
      const error = throwsSync(() => assertStorageKey(key), 'STORAGE_KEY_INVALID');
      const surface = `${error.message} ${error.code} ${error.reason}`;
      expect(surface).not.toContain(CANARY);
      expect(surface).not.toContain(sandbox);
      expect(surface).not.toContain(tmpdir());
      expect(surface).not.toMatch(/[A-Za-z]:\\/);
      expect(surface).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it('every key the module can produce resolves INSIDE the root, whatever the root is', () => {
    // Containment is a property of the PATTERN, so it is asserted as one: no key resolves
    // out of any root, and no scratch name is addressable as an artifact.
    for (const bytes of [PDF_BYTES, PNG_BYTES, SVG_BYTES, Buffer.alloc(0)]) {
      const key = storageKeyFor(sha256Of(bytes));
      const base = path.resolve(root);
      expect(path.resolve(base, key).startsWith(base + path.sep)).toBe(true);
    }
    expect(STORAGE_KEY_PATTERN.test('.tmp-abc')).toBe(false);
    expect(STORAGE_KEY_PATTERN.test(`artifacts/aa/${sha256Of(PDF_BYTES)}.tmp`)).toBe(false);
  });

  it('assertStorageKey is PATTERN-ONLY by design, and the RESOLVED half runs at every call site', async () => {
    // The contract words the key gate as "regex + resolved-path containment" and the two
    // halves live in two places ON PURPOSE (module header): `assertStorageKey` is
    // SYNCHRONOUS and ROOT-LESS, so it has nothing to resolve a path against and no way to
    // await a `realpath`, and the pattern is what makes containment true. This pins that
    // decision so nobody later reads the split as an omission - and pins that the resolved
    // half is really ENFORCED at every call site rather than merely documented.
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    const returned = assertStorageKey(key);
    expect(returned).toBe(key);
    expect(typeof returned).toBe('string');
    // A legal key resolves inside ANY root, so the missing async half is unreachable rather
    // than merely untested. The prefix is built as the module builds it, so a filesystem
    // root that already ends in a separator is handled rather than doubled.
    for (const other of [sandbox, path.parse(root).root, tmpdir()]) {
      const base = path.resolve(other);
      const prefix = base.endsWith(path.sep) ? base : base + path.sep;
      expect(path.resolve(base, key).startsWith(prefix)).toBe(true);
    }

    // The resolved half: a symlinked `artifacts/` under the root. Every call site that
    // touches a path refuses it - `prepareFanout` (put), `open`, `head` and `remove`.
    const outside = track(await mkdtemp(path.join(sandbox, 'escaped-key-gate-')));
    const fanout = key.split('/')[1] as string;
    await mkdir(path.join(outside, fanout), { recursive: true });
    await writeFile(path.join(outside, fanout, key.slice(-64)), PDF_BYTES);
    await mkdir(root, { recursive: true });
    await symlinkAny(outside, path.join(root, STORAGE_KEY_PREFIX.slice(0, -1)), true);
    await rejects(() => store.put(request(PNG_BYTES)), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');
    await rejects(() => store.open(key), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');
    await rejects(() => store.head(key), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');
    await rejects(() => store.remove(key), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');
  });
});

// ---------------------------------------------------------------------------
// Acceptance 2 - the store contract: put / open / head / remove
// ---------------------------------------------------------------------------

describe('render/storage - put, open, head, remove', () => {
  it('put then open returns the same bytes and the same sha256, and head reports the same size', async () => {
    const stored = await store.put(request(PDF_BYTES));
    expect(stored.key).toBe(storageKeyFor(sha256Of(PDF_BYTES)));
    expect(stored.byteSize).toBe(PDF_BYTES.length);
    expect(stored.sha256).toBe(sha256Of(PDF_BYTES));
    expect(stored.contentType).toBe(ARTIFACT_MIME_TYPES.pdf);

    const opened = await store.open(stored.key);
    expect(opened).not.toBeNull();
    expect(opened?.byteSize).toBe(PDF_BYTES.length);
    expect(opened?.sha256).toBe(stored.sha256);
    expect(opened?.contentType).toBe(ARTIFACT_MIME_TYPES.pdf);
    expect(await collect(opened?.stream as AsyncIterable<unknown>)).toEqual(PDF_BYTES);

    const head = await store.head(stored.key);
    expect(head?.byteSize).toBe(PDF_BYTES.length);
    expect(head?.sha256).toBe(stored.sha256);
    expect(head?.contentType).toBe(ARTIFACT_MIME_TYPES.pdf);
    expect(head?.createdAt).toBeInstanceOf(Date);
  });

  it('remove makes open return null, and a second remove is a no-op', async () => {
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    await store.remove(key);
    expect(await store.open(key)).toBeNull();
    expect(await store.head(key)).toBeNull();
    // Deletion is retried by callers; "already gone" is the desired end state, not a fault.
    await expect(store.remove(key)).resolves.toBeUndefined();
    await expect(store.remove(key)).resolves.toBeUndefined();
  });

  it('an absent key is a null from open and head, never a STORAGE_NOT_FOUND exception', async () => {
    const key = storageKeyFor(sha256Of(Buffer.from('never stored')));
    expect(await store.open(key)).toBeNull();
    expect(await store.head(key)).toBeNull();
    // And the closed set carries the code for a caller's error mapping even though this
    // implementation never throws it.
    expect(STORAGE_ERROR_CODES).toContain('STORAGE_NOT_FOUND');
    const fixed: Array<[string, string]> = [
      ['STORAGE_KEY_INVALID', 'KEY_MALFORMED'],
      ['STORAGE_IO', 'IO_ERROR'],
      ['STORAGE_TOO_LARGE', 'OVER_CAP'],
      ['STORAGE_HASH_MISMATCH', 'HASH_MISMATCH'],
    ];
    for (const [code, reason] of fixed) {
      const error = new StorageError(code as never, reason as never);
      expect(STORAGE_ERROR_CODES).toContain(error.code);
      expect(STORAGE_REJECTION_REASONS).toContain(error.reason);
      expect(error.message.startsWith(`${code}: `)).toBe(true);
    }
  });

  it('describe reports the fs kind and the resolved root, and is a diagnostics value only', () => {
    expect(store.describe()).toEqual({ kind: 'fs', root: path.resolve(root) });
    expect(Object.isFrozen(store.describe())).toBe(true);
    // The descriptor is the only value here that mentions a host path, and it is never
    // client-visible: it has exactly the two fields the plan specifies, no more.
    expect(Object.keys(store.describe()).sort()).toEqual(['kind', 'root']);
  });

  it('recognises png, svg and a blob that is none of the three, from CONTENT rather than from a name', async () => {
    // The address is content-only, so the content type is read back off the bytes. An
    // export blob (T1044) legitimately matches no magic: the answer is the honest generic
    // one, never a wrong claim about the format.
    const png = await store.put(request(PNG_BYTES, { contentType: ARTIFACT_MIME_TYPES.png }));
    expect((await store.open(png.key))?.contentType).toBe(ARTIFACT_MIME_TYPES.png);
    const svg = await store.put(request(SVG_BYTES, { contentType: ARTIFACT_MIME_TYPES.svg }));
    expect((await store.head(svg.key))?.contentType).toBe(ARTIFACT_MIME_TYPES.svg);
    const tex = await store.put(request(TEX_BYTES, { contentType: 'application/x-tex' }));
    expect((await store.open(tex.key))?.contentType).toBe(STORAGE_UNKNOWN_CONTENT_TYPE);
    expect(STORAGE_CONTENT_TYPES).toEqual(ARTIFACT_MIME_TYPES);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 3-4 - put re-verifies while streaming
// ---------------------------------------------------------------------------

describe('render/storage - GUARD the digest and the byte count are re-checked mid-stream', () => {
  it('a wrong declared sha256 throws STORAGE_HASH_MISMATCH and leaves NO file behind', async () => {
    const other = sha256Of(PNG_BYTES);
    const key = storageKeyFor(other);
    const error = await rejects(
      () => store.put(request(PDF_BYTES, { key, sha256: other, byteSize: PDF_BYTES.length })),
      'STORAGE_HASH_MISMATCH',
      'HASH_MISMATCH',
    );
    expect(error.message).toBe(
      'STORAGE_HASH_MISMATCH: the stored bytes do not hash to the declared digest',
    );
    // Nothing at the key, and no scratch file left in the fan-out directory either.
    expect(existsSync(targetFor(key))).toBe(false);
    expect(await readdir(fanoutFor(key))).toEqual([]);
    expect(await store.open(key)).toBeNull();
  });

  it('a declared byteSize larger than the streamed bytes throws STORAGE_TOO_LARGE and leaves no file', async () => {
    const sha256 = sha256Of(PDF_BYTES);
    const key = storageKeyFor(sha256);
    const error = await rejects(
      () => store.put(request(PDF_BYTES, { key, sha256, byteSize: PDF_BYTES.length + 1 })),
      'STORAGE_TOO_LARGE',
      'SHORT_OF_DECLARED',
    );
    expect(error.message).toBe(
      'STORAGE_TOO_LARGE: the artifact is smaller than its declared byte count',
    );
    expect(existsSync(targetFor(key))).toBe(false);
    expect(await readdir(fanoutFor(key))).toEqual([]);
  });

  it('a stream LARGER than the declared byteSize is refused before the over-sized chunk lands', async () => {
    // The mid-stream bound, which the post-write checks cannot do: the second chunk is
    // never written, so an over-sized source cannot even partially land.
    const sha256 = sha256Of(PDF_BYTES);
    const key = storageKeyFor(sha256);
    await rejects(
      () =>
        store.put(
          request(PDF_BYTES, {
            key,
            sha256,
            byteSize: 8,
            bytes: Readable.from([PDF_BYTES.subarray(0, 4), PDF_BYTES.subarray(4)]),
          }),
        ),
      'STORAGE_TOO_LARGE',
      'EXCEEDS_DECLARED',
    );
    expect(existsSync(targetFor(key))).toBe(false);
    expect(await readdir(fanoutFor(key))).toEqual([]);
  });

  it('a declared byteSize over the policy cap is refused before any I/O, so no directory appears', async () => {
    const bytes = Buffer.alloc(16, 0x41);
    await rejects(
      () => store.put(request(bytes, { byteSize: RENDER_LIMITS.outputBytes + 1 })),
      'STORAGE_TOO_LARGE',
      'OVER_CAP',
    );
    expect(existsSync(root)).toBe(false);
  });

  it('refuses a key that does not address the declared digest, so bytes cannot be filed under a lie', async () => {
    const key = storageKeyFor(sha256Of(PNG_BYTES));
    const error = await rejects(
      () => store.put(request(PDF_BYTES, { key })),
      'STORAGE_KEY_INVALID',
      'KEY_ADDRESS_MISMATCH',
    );
    expect(error.message).toBe(
      'STORAGE_KEY_INVALID: a storage key does not address the digest the caller declared',
    );
    expect(existsSync(root)).toBe(false);
  });

  it('refuses a malformed request rather than letting a raw TypeError escape', async () => {
    const bytes = PDF_BYTES;
    await rejects(
      () => store.put(null as unknown as PutArtifactRequest),
      'STORAGE_IO',
      'REQUEST_INVALID',
    );
    await rejects(
      () => store.put(request(bytes, { bytes: 'not a stream' as unknown as Readable })),
      'STORAGE_IO',
      'REQUEST_INVALID',
    );
    await rejects(() => store.put(request(bytes, { byteSize: 1.5 })), 'STORAGE_IO', 'DECLARED_SIZE_INVALID');
    await rejects(() => store.put(request(bytes, { byteSize: -1 })), 'STORAGE_IO', 'DECLARED_SIZE_INVALID');
    expect(existsSync(root)).toBe(false);
  });

  it('refuses a content type that is not a bare media type, so no header injection rides along', async () => {
    const bad = [
      '',
      'application/pdf; charset=utf-8',
      'application/pdf\r\nX-Injected: 1',
      'application',
      'application/',
      '/pdf',
      'application pdf',
      CANARY,
      null,
      42,
    ];
    for (const contentType of bad) {
      await rejects(
        () => store.put(request(PDF_BYTES, { contentType: contentType as string })),
        'STORAGE_IO',
        'CONTENT_TYPE_INVALID',
      );
    }
    // The three policy types and an export type are all legal media types.
    for (const contentType of [...Object.values(ARTIFACT_MIME_TYPES), 'application/x-tex', 'application/json']) {
      await store.put(request(PDF_BYTES, { contentType }));
    }
  });

  it('a source stream that ERRORS mid-flight is translated, so its host path cannot escape', async () => {
    const canary = await canaryFile();
    const bytes = await readFile(canary);
    const sha256 = sha256Of(bytes);
    const error = await rejects(
      () =>
        store.put(
          request(bytes, {
            key: storageKeyFor(sha256),
            sha256,
            bytes: (async function* failing(): AsyncGenerator<Buffer> {
              yield bytes.subarray(0, 2);
              throw new Error(`ENOENT: no such file or directory, open '${canary}'`);
            })() as unknown as Readable,
          }),
        ),
      'STORAGE_IO',
      'IO_ERROR',
    );
    expect(error.message).not.toContain(canary);
    expect(error.message).not.toContain(CANARY);
    expect(await readdir(fanoutFor(storageKeyFor(sha256)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 5-6 - content-addressed idempotence
// ---------------------------------------------------------------------------

describe('render/storage - GUARD open(key, {verify}) proves the bytes against the key', () => {
  it('verify:true refuses a blob replaced in place under its own address', async () => {
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    const target = targetFor(key);
    // Same length, different bytes: the shape a bit-rot, a partial restore or a hand-edited
    // volume produces. `lstat` cannot see it and `head` still reports a plausible size.
    const corrupt = Buffer.alloc(PDF_BYTES.length, 0x58);
    await writeFile(target, corrupt);
    await rejects(() => store.open(key, { verify: true }), 'STORAGE_HASH_MISMATCH', 'EXISTING_HASH_MISMATCH');
    // The refusal left the corrupt bytes alone rather than "repairing" them: this module reads,
    // and writes bytes only through `put`.
    expect(await readFile(target)).toEqual(corrupt);
  });

  it('verify:true passes a blob that still matches, and the stream is byte-identical', async () => {
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    const opened = await store.open(key, { verify: true });
    expect(opened?.sha256).toBe(sha256Of(PDF_BYTES));
    expect(await collect(opened?.stream as AsyncIterable<unknown>)).toEqual(PDF_BYTES);
  });

  it('THE DEFAULT IS UNCHANGED: open(key) with no options does not verify', async () => {
    // The other half of the contract, and the one that keeps existing callers usable: a caller
    // that wants the bytes gets the ORIGINAL behaviour and the ORIGINAL cost. This is what
    // makes the option a decision the caller makes rather than a change imposed on it.
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    await writeFile(targetFor(key), Buffer.alloc(PDF_BYTES.length, 0x58));
    expect((await store.open(key))?.sha256).toBe(sha256Of(PDF_BYTES));
    // `verify: false` is the same answer, stated explicitly rather than by omission.
    expect((await store.open(key, { verify: false }))?.sha256).toBe(sha256Of(PDF_BYTES));
  });

  it('verify:true still answers ABSENCE with null, never an exception', async () => {
    // The option must not change what `null` means: a missing blob is a value, so the caller's
    // 404 decision stays explicit. A refusal is for a blob that is present and wrong.
    expect(await store.open(storageKeyFor(sha256Of(PDF_BYTES)), { verify: true })).toBeNull();
  });

  it('verify:true runs AFTER the type gate, so a symlink is still refused as a symlink', async () => {
    // Ordering, not just presence: the hash pass must never be the thing that reads a symlinked
    // path, or this option would become a way to follow one. The shape is the symlink suite's -
    // unlink the blob, drop a link to an OUTSIDE canary in its place, and ask for a verified
    // open. If the hash pass ran first it would read the canary and answer a digest question
    // about a file this store has already refused to acknowledge.
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    const target = targetFor(key);
    await rm(target);
    const canary = await canaryFile();
    await symlinkAny(canary, target);
    await rejects(() => store.open(key, { verify: true }), 'STORAGE_IO', 'SYMLINK_REFUSED');
    // The escape never happened: the canary is untouched and the link is still a link.
    expect(await readFile(canary, 'utf8')).toBe(CANARY);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });
});

describe('render/storage - GUARD put is idempotent on an existing key', () => {
  it('re-putting identical bytes succeeds without rewriting the file (same inode, same mtime)', async () => {
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    const target = targetFor(key);
    // An old, unmistakable mtime: a rewrite that happened to land in the same millisecond
    // would still be caught, so this proves "not rewritten" rather than "not changed".
    const old = new Date('2001-02-03T04:05:06Z');
    await utimes(target, old, old);
    const before = await lstat(target);
    expect(before.mtimeMs).toBe(old.getTime());

    // A source that throws if it is read: the idempotent path must not even consume the
    // caller's stream, because there is nothing to write.
    const again = await store.put({
      key,
      bytes: (async function* unreadable(): AsyncGenerator<Buffer> {
        yield Buffer.from('never');
        throw new Error('the idempotent path read the stream');
      })() as unknown as Readable,
      contentType: ARTIFACT_MIME_TYPES.pdf,
      byteSize: PDF_BYTES.length,
      sha256: sha256Of(PDF_BYTES),
    });
    expect(again.sha256).toBe(sha256Of(PDF_BYTES));

    const after = await lstat(target);
    expect(after.mtimeMs).toBe(old.getTime());
    if (typeof before.ino === 'number' && before.ino > 0) expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    expect(await collect((await store.open(key))?.stream as AsyncIterable<unknown>)).toEqual(PDF_BYTES);
  });

  it('a corrupt existing file makes the idempotent re-put throw STORAGE_HASH_MISMATCH, never success', async () => {
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    const target = targetFor(key);
    // Same length, different bytes: only a re-read can catch this, so a store that trusted
    // the presence of the key would report success here.
    const corrupt = Buffer.alloc(PDF_BYTES.length, 0x58);
    await writeFile(target, corrupt);
    await rejects(() => store.put(request(PDF_BYTES)), 'STORAGE_HASH_MISMATCH', 'EXISTING_HASH_MISMATCH');
    // And the refusal did not "fix" it by overwriting: the corrupt bytes are still there.
    expect(await readFile(target)).toEqual(corrupt);

    // A truncated file is caught by the size comparison, under the same code.
    await writeFile(target, corrupt.subarray(0, 3));
    await rejects(() => store.put(request(PDF_BYTES)), 'STORAGE_HASH_MISMATCH', 'EXISTING_SIZE_MISMATCH');
    expect(existsSync(target)).toBe(true);
  });

  it('two concurrent puts of the same content both succeed and leave exactly one blob', async () => {
    // The publish step is `link`, not `rename`: EEXIST is the concurrent-writer answer, and
    // both callers must end up with a success rather than one clobbering the other.
    const results = await Promise.all([
      store.put(request(PDF_BYTES)),
      store.put(request(PDF_BYTES)),
      store.put(request(PDF_BYTES)),
    ]);
    for (const result of results) expect(result.sha256).toBe(sha256Of(PDF_BYTES));
    expect(await readdir(fanoutFor(results[0].key))).toEqual([sha256Of(PDF_BYTES)]);
    expect((await store.head(results[0].key))?.byteSize).toBe(PDF_BYTES.length);
  });

  it('a put that loses the publish race re-verifies instead of replacing the winner', async () => {
    // The one path the presence check above cannot cover: the target does not exist when
    // `put` looks, and exists by the time it publishes. The publish must be a no-clobber
    // `link`, so the loser's EEXIST re-verifies the WINNER's file and leaves it alone - a
    // `rename` would replace it, and the replacement is invisible in the content (the bytes
    // are identical by construction) and visible only in the inode. So the inode is the
    // assertion, and the slow stream is what makes the ordering deterministic.
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    const slow = Readable.from(
      (async function* trickle(): AsyncGenerator<Buffer> {
        for (let offset = 0; offset < PDF_BYTES.length; offset += 4) {
          await new Promise((done) => setTimeout(done, 10));
          yield PDF_BYTES.subarray(offset, offset + 4);
        }
      })(),
    );
    const losing = store.put(request(PDF_BYTES, { bytes: slow }));
    // Long enough that the slow put is provably still streaming, not yet publishing.
    await new Promise((done) => setTimeout(done, 15));
    const winner = await store.put(request(PDF_BYTES));
    const published = await lstat(targetFor(key));
    expect((await losing).sha256).toBe(winner.sha256);
    const after = await lstat(targetFor(key));
    expect(after.ino).toBe(published.ino);
    expect(after.mtimeMs).toBe(published.mtimeMs);
    expect(await readdir(fanoutFor(key))).toEqual([sha256Of(PDF_BYTES)]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 7 - symlinks and containment
// ---------------------------------------------------------------------------

describe('render/storage - GUARD a symlink is refused, never followed', () => {
  it('refuses a SYMLINKED file at the key path, on put and on open, and never follows it', async () => {
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    const target = targetFor(key);
    await rm(target);
    const canary = await canaryFile();
    await symlinkAny(canary, target);

    await rejects(() => store.put(request(PDF_BYTES)), 'STORAGE_IO', 'SYMLINK_REFUSED');
    await rejects(() => store.open(key), 'STORAGE_IO', 'SYMLINK_REFUSED');
    await rejects(() => store.head(key), 'STORAGE_IO', 'SYMLINK_REFUSED');
    // The escape never happened: the canary is untouched and the link is still a link.
    expect(await readFile(canary, 'utf8')).toBe(CANARY);
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
  });

  it('refuses a hardlinked blob at the key path, which lstat cannot see as a symlink', async () => {
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    const elsewhere = path.join(track(await mkdtemp(path.join(sandbox, 'hardlink-'))), 'other.bin');
    await writeFile(elsewhere, PDF_BYTES);
    const target = targetFor(key);
    await rm(target);
    await link(elsewhere, target);
    await rejects(() => store.put(request(PDF_BYTES)), 'STORAGE_IO', 'HARDLINK_REFUSED');
    await rejects(() => store.open(key), 'STORAGE_IO', 'HARDLINK_REFUSED');
  });

  it('refuses a symlinked FAN-OUT directory, which is the containment the key pattern cannot make', async () => {
    // The key is lexically safe by construction, so the only way to move a blob out of the
    // root is a symlinked PARENT under it - and the blob there passes `lstat` as an ordinary
    // regular file, which is exactly why the RESOLVED containment check exists.
    const outside = track(await mkdtemp(path.join(sandbox, 'escaped-')));
    const plantedKey = storageKeyFor(sha256Of(PDF_BYTES));
    const plantedBody = Buffer.from('planted outside the root');
    await mkdir(path.join(outside, plantedKey.split('/')[1] as string), { recursive: true });
    await writeFile(
      path.join(outside, plantedKey.split('/')[1] as string, plantedKey.slice(-64)),
      plantedBody,
    );
    await mkdir(root, { recursive: true });
    await symlinkAny(outside, path.join(root, STORAGE_KEY_PREFIX.slice(0, -1)), true);

    // A read of the planted blob is refused even though every component of its path is a
    // real directory to `lstat`.
    await rejects(() => store.open(plantedKey), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');
    await rejects(() => store.head(plantedKey), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');
    expect(await readFile(path.join(outside, plantedKey.split('/')[1] as string, plantedKey.slice(-64)))).toEqual(plantedBody);

    // A put of DIFFERENT bytes is refused before a single byte is written into the link's
    // target. `mkdir` does create the fan-out directory through the link (an empty
    // directory, which is the honest limit of this guard and is asserted as such), but the
    // blob itself never lands.
    const otherKey = storageKeyFor(sha256Of(PNG_BYTES));
    await rejects(() => store.put(request(PNG_BYTES)), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');
    expect(existsSync(path.join(outside, otherKey.split('/')[1] as string, otherKey.slice(-64)))).toBe(false);
    expect(await readdir(path.join(outside, otherKey.split('/')[1] as string))).toEqual([]);
  });

  it('remove unlinks a symlink at the key and never touches its target', async () => {
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    const target = targetFor(key);
    await rm(target);
    const canary = await canaryFile();
    await symlinkAny(canary, target);
    await store.remove(key);
    expect(existsSync(target)).toBe(false);
    expect(await readFile(canary, 'utf8')).toBe(CANARY);
  });

  it('refuses a remove whose FAN-OUT is a symlink, so a delete cannot land OUTSIDE the root', async () => {
    // `remove` is the one operation that DESTROYS a file, so it runs the same resolved
    // containment check `put` does. Without it a symlinked `artifacts/` turns this unlink
    // into a delete outside the root: bounded - a 64-hex name, in a directory only
    // something that can write to the storage root could plant - but an escape all the
    // same, and the one asymmetry in a set of guards that is otherwise uniform.
    const outside = track(await mkdtemp(path.join(sandbox, 'escaped-remove-')));
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    const fanout = key.split('/')[1] as string;
    const planted = path.join(outside, fanout, key.slice(-64));
    await mkdir(path.dirname(planted), { recursive: true });
    await writeFile(planted, PDF_BYTES);
    const link = path.join(root, STORAGE_KEY_PREFIX.slice(0, -1));
    await mkdir(root, { recursive: true });
    await symlinkAny(outside, link, true);

    await rejects(() => store.remove(key), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');
    // Nothing was destroyed: the escapee survives for an operator to inspect, the planted
    // symlink is still a symlink (the refusal is not a partial teardown), and the store
    // still refuses to READ the blob - so no caller can be told a file is gone when it is
    // not. A symlink AT the key is still unlinked, which is the one removal that cannot
    // escape, and the test above pins that it still happens.
    expect(await readFile(planted)).toEqual(PDF_BYTES);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await rejects(() => store.open(key), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');

    // The composition is covered too: a symlink AT the key whose PARENT is also a symlink.
    // Unlinking a link never follows it, so the target is not the thing to resolve - the
    // fan-out is, because that is the directory the unlink happens IN, and without that the
    // call would remove a directory entry outside the root.
    const canary = await canaryFile();
    await rm(planted);
    await symlinkAny(canary, planted);
    await rejects(() => store.remove(key), 'STORAGE_IO', 'PATH_ESCAPES_ROOT');
    expect((await lstat(planted)).isSymbolicLink()).toBe(true);
    expect(await readFile(canary, 'utf8')).toBe(CANARY);
  });

  it('refuses a root that is not a directory at all', async () => {
    const file = path.join(sandbox, 'not-a-dir');
    await writeFile(file, 'x');
    const bad = createArtifactStore({ root: file });
    await rejects(() => bad.put(request(PDF_BYTES)), 'STORAGE_IO', 'IO_ERROR');
  });
});

// ---------------------------------------------------------------------------
// GUARD the guards that are about this module's own temporaries (fix round 2)
// ---------------------------------------------------------------------------

describe('render/storage - GUARD open() builds its ReadStream only AFTER the sniff', () => {
  it('a failing content sniff leaves NO unlistened stream behind, and no unhandled event', async () => {
    // `createReadStream` opens the file on its own schedule and reports a failure by
    // EMITTING `error` on the stream. A stream that is built and then abandoned - because
    // the awaited sniff threw first - has no `error` listener at all, which Node raises as
    // an uncaught exception rather than a rejection. The fix is ordering, so the test
    // observes the ORDER: a fresh copy of the module with `createReadStream` spied and the
    // sniff's `open` failing. Nothing else about the store changes - the same guards, the
    // same real work, the same error surface.
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    await store.put(request(PDF_BYTES));
    const target = targetFor(key);

    const created: string[] = [];
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.resetModules();
    vi.doMock('node:fs', async () => ({
      ...realFs,
      createReadStream: ((p: string) => {
        created.push(String(p));
        // A stream that destroys itself with an error on the next tick: IF the module built
        // it and then abandoned it, nothing holds an `error` listener, so the error
        // surfaces as an uncaught exception and the tripwire below records it. That is the
        // exact symptom the ordering removes.
        const stream = new Readable({ read() { /* the module must never read it */ } });
        setTimeout(() => stream.destroy(new Error('abandoned stream: no error listener')), 0);
        return stream;
      }) as unknown as typeof realFs.createReadStream,
    }));
    vi.doMock('node:fs/promises', async () => ({
      ...realPromises,
      // The sniff is the only thing that opens the blob for reading, so failing it here IS
      // the "the awaited sniff throws" case: EACCES, EMFILE, or a concurrent remove.
      open: (async (p: string, ...rest: unknown[]) => {
        if (String(p) === target) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
        }
        return (realPromises.open as unknown as (...args: unknown[]) => unknown)(p, ...rest);
      }) as typeof realPromises.open,
    }));
    const unhandled: unknown[] = [];
    const record = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', record);
    process.on('uncaughtException', record);
    try {
      const fresh = (await import('./storage.js')).createArtifactStore({ root });
      // The caller's promise still rejects with a StorageError and no host path: the
      // reordering changed WHEN the stream is built, not what this module promises. The
      // fresh module instance has its own `StorageError` CLASS, so the shape is the
      // assertion here rather than `instanceof` against the statically imported one.
      let caught: unknown;
      try {
        await fresh.open(key);
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ name: 'StorageError', code: 'STORAGE_IO', reason: 'IO_ERROR' });
      expect((caught as Error).message).toBe(
        'STORAGE_IO: the host filesystem could not complete the storage operation',
      );
      await new Promise((done) => setTimeout(done, 30));
    } finally {
      process.removeListener('unhandledRejection', record);
      process.removeListener('uncaughtException', record);
      vi.doUnmock('node:fs');
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
    // Two independent proofs, and the mutation run showed BOTH firing. `unhandled` is the
    // symptom: reverse the order and the abandoned stream above raises a real uncaught
    // exception into it. `created` is the cause: it then names the blob, so a reader can
    // see which call built a stream it never handed out.
    expect(unhandled).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe('render/storage - GUARD the publish post-condition cannot refuse a put that published', () => {
  it('a put whose own scratch unlink loses the race is not reported as a hardlink', async () => {
    // The publish is `link` + unlink, and the unlink can lose: Windows refuses it with
    // EPERM/EBUSY while a handle is still closing. The published blob then honestly carries
    // TWO names - its key, and this frame's own scratch - and the post-condition must
    // recognise the second one as THIS frame's (it is the only name `O_EXCL` created)
    // rather than refuse a write that succeeded and verified. With no allowance this put
    // throws HARDLINK_REFUSED on its own correct bytes: a spurious rejection of a
    // successful write, which is the one failure mode a content-addressed store cannot
    // afford, because the caller retries forever against a store that is working.
    const key = storageKeyFor(sha256Of(PDF_BYTES));
    const digest = sha256Of(PDF_BYTES);
    const realPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.resetModules();
    vi.doMock('node:fs/promises', async () => ({
      ...realPromises,
      rm: (async (p: string, options?: unknown) => {
        if (path.basename(String(p)).startsWith('.tmp-')) return undefined; // the unlink loses
        return (realPromises.rm as unknown as (...args: unknown[]) => unknown)(p, options);
      }) as typeof realPromises.rm,
    }));
    let stored: Awaited<ReturnType<ArtifactStore['put']>> | undefined;
    try {
      const fresh = (await import('./storage.js')).createArtifactStore({ root });
      stored = await fresh.put(request(PDF_BYTES));
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
    expect(stored?.sha256).toBe(digest);
    // The published bytes are the verified bytes, so nothing was weakened to get here.
    expect(await readFile(targetFor(key))).toEqual(PDF_BYTES);
    // And the allowance is ONE link wide, not a blanket one: the single surviving second
    // name is this frame's temp name, which is what makes it explainable.
    const names = (await readdir(fanoutFor(key))).sort();
    expect(names).toHaveLength(2);
    expect(names).toContain(digest);
    expect(names.filter((name) => name !== digest)[0]).toMatch(new RegExp(`^\\.tmp-${digest}-[0-9a-f]{16}$`));
  });
});

// ---------------------------------------------------------------------------
// Acceptance 8 - the S3 seam fails closed
// ---------------------------------------------------------------------------

describe('render/storage - the S3 seam is fail-closed', () => {
  it('createArtifactStore({kind:"s3"}) throws STORAGE_UNAVAILABLE and does not touch the filesystem', () => {
    const absent = path.join(sandbox, 'never-created');
    const error = throwsSync(
      () => createArtifactStore({ kind: 's3', root: absent }),
      'STORAGE_UNAVAILABLE',
      'KIND_UNAVAILABLE',
    );
    expect(error.message).toBe(
      'STORAGE_UNAVAILABLE: the configured artifact storage kind is not implemented in this build',
    );
    // No mkdir, no root, no silent fallback to fs.
    expect(existsSync(absent)).toBe(false);
    expect(existsSync(root)).toBe(false);
    // An unknown kind is refused the same way, so a typo cannot select fs by accident.
    throwsSync(
      () => createArtifactStore({ kind: 'gcs' as 'fs', root: absent }),
      'STORAGE_UNAVAILABLE',
      'KIND_UNAVAILABLE',
    );
    expect(existsSync(absent)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The root, and the env wiring T1043 owns
// ---------------------------------------------------------------------------

describe('render/storage - the storage root and the env keys', () => {
  const saved = {
    root: process.env.RENDER_STORAGE_ROOT,
    kind: process.env.RENDER_STORAGE_KIND,
    nodeEnv: process.env.NODE_ENV,
  };

  afterEach(() => {
    for (const [key, value] of [
      ['RENDER_STORAGE_ROOT', saved.root],
      ['RENDER_STORAGE_KIND', saved.kind],
      ['NODE_ENV', saved.nodeEnv],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('the root is injectable, and RENDER_STORAGE_ROOT is read lazily when it is not', () => {
    expect(store.describe()).toEqual({ kind: 'fs', root: path.resolve(root) });
    process.env.RENDER_STORAGE_ROOT = path.join(sandbox, 'from-env');
    expect(createArtifactStore().describe()).toEqual({
      kind: 'fs',
      root: path.resolve(path.join(sandbox, 'from-env')),
    });
    // An argument still wins, so a test never depends on the ambient env.
    expect(createArtifactStore({ root }).describe()).toEqual({
      kind: 'fs',
      root: path.resolve(root),
    });
    // An empty value is a refusal, not a fallback to the process directory.
    process.env.RENDER_STORAGE_ROOT = '';
    expect(createArtifactStore().describe()).toEqual({
      kind: 'fs',
      root: defaultStorageRoot(),
    });
  });

  it('RENDER_STORAGE_KIND=s3 in the env fails closed exactly like the argument does', () => {
    const absent = path.join(sandbox, 'kind-from-env');
    process.env.RENDER_STORAGE_KIND = 's3';
    throwsSync(() => createArtifactStore({ root: absent }), 'STORAGE_UNAVAILABLE', 'KIND_UNAVAILABLE');
    expect(existsSync(absent)).toBe(false);
  });

  it('the development default is backend/.artifacts, and the env key names are one list', () => {
    expect(defaultStorageRoot()).toBe(path.resolve(SRC, '..', STORAGE_DEFAULT_DIRNAME));
    expect(path.basename(defaultStorageRoot())).toBe(STORAGE_DEFAULT_DIRNAME);
    expect(STORAGE_ENV_KEYS).toEqual(['RENDER_STORAGE_KIND', 'RENDER_STORAGE_ROOT']);
  });

  it('assertRequiredStorageConfig refuses an unset root in production and is quiet otherwise', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.RENDER_STORAGE_ROOT;
    expect(() => assertRequiredStorageConfig()).not.toThrow();

    process.env.NODE_ENV = 'production';
    expect(() => assertRequiredStorageConfig()).toThrow(/RENDER_STORAGE_ROOT is not set/);
    process.env.RENDER_STORAGE_ROOT = path.join(sandbox, 'production-root');
    expect(() => assertRequiredStorageConfig()).not.toThrow();
  });

  it('refuses a malformed root argument instead of resolving the process directory', () => {
    for (const bad of ['', '   ', 7, null, {}]) {
      throwsSync(() => createArtifactStore({ root: bad as string }), 'STORAGE_IO', 'REQUEST_INVALID');
    }
    throwsSync(() => createArtifactStore([] as unknown as { kind: 'fs' }), 'STORAGE_IO', 'REQUEST_INVALID');
    throwsSync(() => createArtifactStore(null as unknown as { kind: 'fs' }), 'STORAGE_IO', 'REQUEST_INVALID');
  });
});

// ---------------------------------------------------------------------------
// Acceptance 9 - the real composition, once, with no daemon
// ---------------------------------------------------------------------------

describe('render/storage - the real composition (validate -> stream -> put -> open)', () => {
  it('validates a fixture /out, streams it into the store, and reads back identical bytes', async () => {
    // The exact chain ADR-042 D3 and the broker will use, with the broker replaced by this
    // test: `validateRenderArtifact` (T1013) -> `openArtifactStream` -> `put` -> `open`.
    const outDir = path.join(sandbox, 'out-fixture');
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'artifact.pdf'), PDF_BYTES);

    const artifact = await validateRenderArtifact({ outDir, format: 'pdf' });
    expect(artifact.sha256).toBe(sha256Of(PDF_BYTES));
    expect(artifact.byteSize).toBe(PDF_BYTES.length);
    expect(artifact.mimeType).toBe(ARTIFACT_MIME_TYPES.pdf);

    const key = storageKeyFor(artifact.sha256);
    const stored = await store.put({
      key,
      bytes: openArtifactStream(artifact),
      contentType: artifact.mimeType,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
    });
    expect(stored.key).toBe(key);

    const opened = await store.open(key);
    expect(opened?.sha256).toBe(artifact.sha256);
    expect(opened?.byteSize).toBe(artifact.byteSize);
    expect(opened?.contentType).toBe(artifact.mimeType);
    expect(await collect(opened?.stream as AsyncIterable<unknown>)).toEqual(PDF_BYTES);

    // And the whole thing is idempotent, which is what makes a retried render free.
    const again = await store.put({
      key,
      bytes: openArtifactStream(artifact),
      contentType: artifact.mimeType,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
    });
    expect(again).toEqual(stored);
    expect(await readdir(fanoutFor(key))).toEqual([artifact.sha256]);
  });
});

// ---------------------------------------------------------------------------
// Acceptance 10 - this module is the only place artifact bytes are written
// ---------------------------------------------------------------------------

/**
 * Modules ALLOWED to write bytes to disk, with the reason each one is allowed. This is the
 * declared set the grep gate below checks the source against - it is the list, not a
 * description of one.
 *
 * `render/storage.ts` is the artifact store. `render/broker/spool.ts` is the ONE documented
 * future exception: the broker has to materialise the container's `/out` as a host
 * directory before `validateRenderArtifact` can inspect it (T1040 sec. 3 step 9), it is
 * broker-private, it is bounded at 20 MiB and it is deleted in a `finally`. It does not
 * exist yet - T1031 owns it - and when it lands, this list is the thing that makes the
 * exception explicit rather than accidental.
 */
const ARTIFACT_WRITE_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  'render/storage.ts': 'the artifact storage port (this task)',
  'render/broker/spool.ts': 'the broker-private /out spool, bounded and deleted in a finally (T1031)',
});

/** The blunt write instruments. None of them may appear in a shipped module. */
const WRITE_CALLS =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|openSync)\s*\(/g;

/** `open(path, 'w' | 'wx' | 'a' | 'ax')` is a write too, and is scanned separately. */
const EXCLUSIVE_OPEN = /\bopen\([^)]*['"](?:w|wx|a|ax)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Comments are stripped first: prose ABOUT a write is not a write. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function callSites(
  dir: string,
  pattern: RegExp,
): Array<{ file: string; line: number; call: string }> {
  const sites: Array<{ file: string; line: number; call: string }> = [];
  for (const file of sourceFiles(dir)) {
    const relative = path.relative(SRC, file).split(path.sep).join('/');
    const source = withoutComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(pattern)) {
      sites.push({
        file: relative,
        line: source.slice(0, match.index).split('\n').length,
        call: match[0].trim(),
      });
    }
  }
  return sites;
}

describe('render/storage - the only place artifact bytes reach the disk', () => {
  it('no module under backend/src outside render/storage.ts writes an artifact byte to disk', () => {
    // A grep gate, in the shape `career/claimWriterAI.test.ts` and `browser/tier.test.ts`
    // already use in this repo. The blunt write instruments - `writeFile`,
    // `createWriteStream`, `appendFile` - are used by NO shipped module at all, including
    // this one: the store writes through `open(..., 'wx')` so it can control the mode and
    // the O_EXCL. A new renderer that reaches for `writeFile` therefore fails here.
    const shipped = callSites(SRC, WRITE_CALLS).filter(
      (site) => !site.file.endsWith('.test.ts') && !site.file.endsWith('.fixtures.ts'),
    );
    expect(shipped).toEqual([]);
    // The scan is real: it walked the tree, and it did find writers (the test files).
    expect(sourceFiles(SRC).length).toBeGreaterThan(100);
    expect(
      callSites(SRC, WRITE_CALLS).filter((site) => site.file.endsWith('.test.ts')).length,
    ).toBeGreaterThan(0);
  });

  it('the only modules that open a path for writing are the staging tree, the broker spool and the store', () => {
    // The second half of the same gate, because `open(..., 'w')` IS a write: a module that
    // used it would otherwise slip past the scan above. `stage.ts` writes a per-job staging
    // tree under a hard mid-stream byte budget (policy 5.2) and is NOT an artifact writer;
    // `render/broker/spool.ts` is the broker-private `/out` spool, bounded at 20 MiB and
    // deleted in a `finally` (ADR-042 D4, T1031); `storage.ts` is the artifact writer. Those
    // three are the complete set, asserted rather than described.
    // Test files are excluded here too: this one quotes the very call it is looking for.
    const files = [
      ...new Set(
        callSites(SRC, EXCLUSIVE_OPEN)
          .map((site) => site.file)
          .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.fixtures.ts')),
      ),
    ].sort();
    expect(files).toEqual(['render/broker/spool.ts', 'render/stage.ts', 'render/storage.ts']);
    // The same set, intersected with the ALLOWLIST, so the constant above is load-bearing
    // rather than decorative: a new exclusive-open writer has to be NAMED here with its
    // reason. `stage.ts` is named in the list above only as the staging tree and is not an
    // artifact writer, so it is deliberately absent from `declared`.
    const declared = files.filter((file) => file in ARTIFACT_WRITE_ALLOWLIST);
    expect(declared).toEqual(['render/broker/spool.ts', 'render/storage.ts']);
    for (const file of declared) {
      expect(ARTIFACT_WRITE_ALLOWLIST[file], file).toBeTypeOf('string');
      expect(ARTIFACT_WRITE_ALLOWLIST[file]?.length ?? 0, file).toBeGreaterThan(10);
    }
  });

  it('the allowlist is exactly the storage port plus the one documented exception', () => {
    expect(Object.keys(ARTIFACT_WRITE_ALLOWLIST).sort()).toEqual([
      'render/broker/spool.ts',
      'render/storage.ts',
    ]);
    // T1031 has landed, which is what this test was written to detect. The comment above it
    // predicted the exact hand-off: the spool joins the exclusive-open scan, so the pinned
    // writer set AND the declared-writer assertion both went red until its name was added
    // here with its reason. The reason string still names the owner and the bound.
    expect(existsSync(path.join(SRC, 'render', 'broker', 'spool.ts'))).toBe(true);
    expect(ARTIFACT_WRITE_ALLOWLIST['render/broker/spool.ts']).toMatch(/T1031/);
    // And the exception is a SPOOL, not a second store: it opens a per-job capture with
    // O_EXCL, so it still never writes an artifact at a content-addressed key.
    const spool = readFileSync(path.join(SRC, 'render', 'broker', 'spool.ts'), 'utf8');
    expect(withoutComments(spool)).toContain("open(file, 'wx', 0o600)");
    expect(withoutComments(spool)).not.toContain('artifacts/');
    expect(withoutComments(spool)).not.toMatch(/\bwriteFile\w*\s*\(/);
    expect(withoutComments(spool)).not.toContain('createWriteStream');
  });

  it('storage.ts really is the writer: O_EXCL for the scratch file, link for the publish', () => {
    const source = readFileSync(path.join(SRC, 'render', 'storage.ts'), 'utf8');
    expect(source).toContain("open(scratch, 'wx', BLOB_MODE)");
    // `link` is the no-clobber publish. A `rename` would overwrite an existing key, which
    // is precisely what the idempotence guard exists to prevent. Comments are stripped so
    // the module can DISCUSS a rename without tripping its own gate.
    expect(withoutComments(source)).toContain('await link(scratch, target)');
    expect(withoutComments(source)).not.toMatch(/\brename\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// The error surface
// ---------------------------------------------------------------------------

describe('render/storage - the error surface carries no host path and no content', () => {
  it('every rejection message is a fixed string with a code and no caller data', async () => {
    const canary = await canaryFile();
    const bytes = await readFile(canary);
    const sha256 = sha256Of(bytes);
    const key = storageKeyFor(sha256);
    await store.put(request(bytes));

    const failures: Array<() => Promise<unknown>> = [
      () => store.put(request(bytes, { key: `${CANARY}/../x` })),
      () => store.put(request(bytes, { key: path.join(root, 'x') })),
      () => store.put(request(Buffer.from('other'), { key })),
      () => store.put(request(bytes, { byteSize: 1 })),
      () => store.put(request(bytes, { contentType: CANARY })),
      () => store.put(request(bytes, { key: `artifacts/aa/${sha256.slice(0, 63)}` })),
      () => store.open(CANARY),
      () => store.head(`artifacts/../${sha256}`),
      () => store.remove(`..${path.sep}..${path.sep}etc${path.sep}passwd`),
    ];

    for (const failure of failures) {
      let error: unknown;
      try {
        await failure();
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(StorageError);
      const storageError = error as StorageError;
      const surface = `${storageError.message} ${storageError.code} ${storageError.reason}`;
      expect(STORAGE_ERROR_CODES).toContain(storageError.code);
      expect(STORAGE_REJECTION_REASONS).toContain(storageError.reason);
      // No host path, no temp root, no canary, no digest, no caller content.
      expect(surface).not.toContain(sandbox);
      expect(surface).not.toContain(CANARY);
      expect(surface).not.toContain(canary);
      expect(surface).not.toContain(tmpdir());
      expect(surface).not.toMatch(/[A-Za-z]:\\/);
      expect(surface).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it('the code and reason vocabularies are closed sets, and every reason has a fixed message', () => {
    expect([...STORAGE_ERROR_CODES]).toEqual([
      'STORAGE_KEY_INVALID',
      'STORAGE_NOT_FOUND',
      'STORAGE_IO',
      'STORAGE_TOO_LARGE',
      'STORAGE_HASH_MISMATCH',
      'STORAGE_UNAVAILABLE',
    ]);
    expect(new Set(STORAGE_REJECTION_REASONS).size).toBe(STORAGE_REJECTION_REASONS.length);
    // PINNED, not merely self-consistent: the count is the thing a reviewer checks.
    expect(STORAGE_REJECTION_REASONS).toHaveLength(18);
    // The reason alone does not fix the code, so the pairing is asserted explicitly: one
    // reason must never be reachable under two different codes.
    const codeFor = (reason: string): string => {
      if (reason.startsWith('KEY_')) return 'STORAGE_KEY_INVALID';
      if (reason.endsWith('_DECLARED') || reason === 'OVER_CAP') return 'STORAGE_TOO_LARGE';
      if (reason.endsWith('HASH_MISMATCH') || reason === 'EXISTING_SIZE_MISMATCH') {
        return 'STORAGE_HASH_MISMATCH';
      }
      if (reason === 'KIND_UNAVAILABLE') return 'STORAGE_UNAVAILABLE';
      return 'STORAGE_IO';
    };
    const fixed: Record<string, string> = {
      KEY_MALFORMED: 'STORAGE_KEY_INVALID: a storage key is not a content-addressed artifact path',
      KEY_ADDRESS_MISMATCH:
        'STORAGE_KEY_INVALID: a storage key does not address the digest the caller declared',
      SHORT_OF_DECLARED: 'STORAGE_TOO_LARGE: the artifact is smaller than its declared byte count',
      EXISTING_HASH_MISMATCH:
        'STORAGE_HASH_MISMATCH: the file already at the key does not match its own address',
      SYMLINK_REFUSED: 'STORAGE_IO: a storage path is a symbolic link',
      KIND_UNAVAILABLE:
        'STORAGE_UNAVAILABLE: the configured artifact storage kind is not implemented in this build',
    };
    for (const [reason, message] of Object.entries(fixed)) {
      const error = new StorageError(codeFor(reason) as never, reason as never);
      expect(error.message, reason).toBe(message);
      expect(error.message).not.toContain('undefined');
    }
    // And the whole set still renders a non-empty fixed message.
    for (const reason of STORAGE_REJECTION_REASONS) {
      expect(new StorageError('STORAGE_IO', reason).message.length).toBeGreaterThan(20);
    }
  });
});
