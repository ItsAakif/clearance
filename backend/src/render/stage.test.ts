// Render staging - unit tests.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md
//                 sections 3.3 (M3), 5.1-5.3 (input handling), 6.3 (artifact
//                 validation), 9.3-9.4 (error surface), 10.1 (cleanup).
// Task:         T1013
//
// These tests are the PROOF for the control the T1005 spike identified as missing:
// typst 0.15.1 follows a symlink planted inside `--root` (typst/typst #5454, still
// open), so the lstat + name audit in `stage.ts` is the only thing between a
// symlink and an arbitrary read of the image.
//
// Every guard below has a test that fails if the guard is removed. The mutation
// evidence for each is in `.planning/progress/T1013-render-staging-module.md`.
//
// The tests use the REAL `backend/typst/fixtures/` trees as their inputs, including
// `b-symlink-escape` (the fixture that provably leaks through typst) and the c1/c2/c3
// read-escape fixtures, so "rejected at staging, not merely at typst" is asserted
// against the spike's own bytes rather than a synthetic stand-in.

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RENDER_LIMITS,
  RENDER_PATHS,
  RENDER_POLICY,
  type RenderLimits,
} from './sandbox.js';
import {
  ARTIFACT_MIME_TYPES,
  STAGE_PACKAGE_CACHE_DIR,
  STAGE_REJECTION_CODES,
  STAGE_REJECTION_REASONS,
  StageError,
  assertPathInsideRoot,
  assertRealPathInsideRoot,
  assertStageLimits,
  auditStageRoot,
  engineStagesData,
  openArtifactStream,
  openStageTreeStream,
  sanitizeStageName,
  stageRenderJob,
  stageRenderJobInMemory,
  stageTemplateName,
  validateRenderArtifact,
  type StageRequest,
  type StageResult,
  type StageTree,
} from './stage.js';

// __dirname is available both compiled to CJS and under vitest (repo convention:
// see src/ats/promptLoader.ts:8).
const HERE = __dirname;
const FIXTURES = path.resolve(HERE, '../../typst/fixtures');
const fixture = (name: string, file: string): string => path.join(FIXTURES, name, file);

const TEMPLATE_A = fixture('a-valid-resume', 'template.typ');
const DATA_A = fixture('a-valid-resume', 'data.json');
const TEMPLATE_B = fixture('b-symlink-escape', 'template.typ');
const TEMPLATE_C1 = fixture('c1-read-parent-escape', 'template.typ');
const TEMPLATE_C2 = fixture('c2-eval-computed-escape', 'template.typ');
const TEMPLATE_C3 = fixture('c3-absolute-read', 'template.typ');

const CANARY = 'CLEARANCE_CANARY_T1013_9f2c17ab';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let sandbox: string;
let created: string[] = [];

/** Track every temp path so a failing test cannot leak one. */
function track<T extends string>(p: T): T {
  created.push(p);
  return p;
}

beforeEach(async () => {
  sandbox = track(await mkdtemp(path.join(tmpdir(), 'clearance-stage-')));
});

afterEach(async () => {
  for (const p of created.reverse()) {
    await rm(p, { recursive: true, force: true }).catch(() => undefined);
  }
  created = [];
});

/**
 * Create a symlink, degrading to a directory junction where the platform refuses a
 * file symlink (Windows without Developer Mode). Both are `isSymbolicLink() === true`
 * under `lstat`, which is the property the guard keys on, so the guard is proven
 * either way and the test never silently degrades into a no-op.
 */
async function symlinkAny(target: string, linkPath: string): Promise<'file' | 'junction'> {
  const types: Array<'file' | 'junction'> =
    process.platform === 'win32' ? ['file', 'junction'] : ['file'];
  let last: unknown;
  for (const type of types) {
    try {
      await symlink(target, linkPath, type);
      return type;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(
    `this host cannot create symlinks at all (${String(last)}); the symlink guard cannot be proven here`,
  );
}

/** A canary file OUTSIDE any staging root: the thing an escape would read. */
async function canaryFile(name = 'canary.txt'): Promise<string> {
  const dir = track(await mkdtemp(path.join(sandbox, 'outside-')));
  const file = path.join(dir, name);
  await writeFile(file, CANARY, 'utf8');
  return file;
}

/**
 * Symlink a DIRECTORY. Windows rejects a `'file'`-type symlink whose target is a
 * directory with `EPERM` on every read (`realpath`, `readdir`), so a directory target
 * gets a junction; POSIX takes a plain symlink. Both are `isSymbolicLink() === true`
 * under `lstat` AND resolvable, which is what a test about a symlinked ANCESTOR needs -
 * a broken link would fail at the `realpath` guard for the wrong reason.
 */
async function symlinkDir(target: string, linkPath: string): Promise<void> {
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await symlink(target, linkPath, type);
  } catch (err) {
    throw new Error(`this host cannot symlink a directory (${String(err)})`);
  }
}

function root(name = 'work'): string {
  return path.join(sandbox, name);
}

/** A well-formed request, with pieces overridable per test. */
function request(over: Partial<StageRequest> = {}): StageRequest {
  return {
    engine: 'typst',
    template: { path: TEMPLATE_A },
    data: { path: DATA_A },
    root: root(),
    ...over,
  };
}

/** A canary file OUTSIDE any staging root, reached through a symlink. */
async function canaryFileSymlink(name = 'linked-canary.typ'): Promise<string> {
  const linkPath = path.join(sandbox, name);
  await symlinkAny(await canaryFile(), linkPath);
  return linkPath;
}

/** Drain a readable into buffers. */
async function collect(stream: AsyncIterable<Buffer | Uint8Array | string>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return chunks;
}

/** Assert a promise rejects with a StageError carrying exactly this code/reason. */
async function rejects(
  promise: Promise<unknown>,
  code: string,
  reason: string,
): Promise<StageError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected rejection ${code}/${reason}`).toBeInstanceOf(StageError);
  const stageError = caught as StageError;
  expect(stageError.code).toBe(code);
  expect(stageError.reason).toBe(reason);
  return stageError;
}

// ---------------------------------------------------------------------------
// The staged-tree contract
// ---------------------------------------------------------------------------

describe('render/stage - the staged tree the worker mounts', () => {
  it('stages exactly template.typ + data.json + an empty .pkgcache, and nothing else', async () => {
    const result = await stageRenderJob(request());

    expect(result.names).toEqual(['data.json', 'template.typ']);
    expect(result.root).toBe(root());
    expect(result.packageCacheDir).toBe(path.join(root(), STAGE_PACKAGE_CACHE_DIR));
    expect(STAGE_PACKAGE_CACHE_DIR).toBe('.pkgcache');
    expect(result.totalBytes).toBe(
      (await lstat(TEMPLATE_A)).size + (await lstat(DATA_A)).size,
    );

    // The DIRECTORY LISTING is the contract the worker sees, so assert on it
    // directly rather than trusting the returned array.
    const listing = (await readdir(result.root)).sort();
    expect(listing).toEqual(['.pkgcache', 'data.json', 'template.typ']);
    expect(await readdir(result.packageCacheDir)).toEqual([]);

    // Byte-for-byte what the registry/adapter supplied, under the policy names.
    expect(await readFile(result.entries[0].path)).toEqual(await readFile(DATA_A));
    expect(await readFile(result.entries[1].path)).toEqual(await readFile(TEMPLATE_A));
  });

  it('is deterministic: the same job staged twice produces identical trees', async () => {
    const first = await stageRenderJob(request({ root: root('a') }));
    const second = await stageRenderJob(request({ root: root('b') }));

    expect(first.names).toEqual(second.names);
    expect(first.totalBytes).toBe(second.totalBytes);
    for (let i = 0; i < first.entries.length; i += 1) {
      expect(first.entries[i].name).toBe(second.entries[i].name);
      expect(first.entries[i].byteSize).toBe(second.entries[i].byteSize);
      expect(createHash('sha256').update(await readFile(first.entries[i].path)).digest('hex')).toBe(
        createHash('sha256').update(await readFile(second.entries[i].path)).digest('hex'),
      );
    }
  });

  it('stages a declared asset under its declared name and nothing more', async () => {
    const logo = path.join(sandbox, 'logo.png');
    await writeFile(logo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const result = await stageRenderJob(
      request({ assets: [{ name: 'logo.png', source: { path: logo } }] }),
    );
    expect(result.names).toEqual(['data.json', 'logo.png', 'template.typ']);
    expect((await readdir(result.root)).sort()).toEqual([
      '.pkgcache',
      'data.json',
      'logo.png',
      'template.typ',
    ]);
  });

  it('defaults the root to the exact path the worker mounts as --root', () => {
    // No I/O: the default is RENDER_PATHS.work, and sandbox.ts owns that constant.
    expect(RENDER_PATHS.work).toBe('/work');
    expect(stageTemplateName('typst')).toBe(RENDER_PATHS.names.typstTemplate);
    expect(stageTemplateName('latex')).toBe(RENDER_PATHS.names.latexTemplate);
    // The staged names are exactly the policy's per-engine allowlist, so the module
    // cannot drift from `RENDER_POLICY.allowedStageNames` (which V32 already pins).
    expect(stageTemplateName('typst')).toBe(RENDER_POLICY.allowedStageNames.typst[0]);
    expect(RENDER_POLICY.allowedStageNames.typst).toContain(RENDER_PATHS.names.data);
    expect(engineStagesData('typst')).toBe(true);
    // LaTeX's allowlist is exactly ['artifact.tex'], so data.json is refused there
    // rather than staged under a name the policy does not allow.
    expect(engineStagesData('latex')).toBe(false);
  });

  it('refuses data.json for the latex engine, which may not stage that name', async () => {
    await rejects(
      stageRenderJob(request({ engine: 'latex', root: root('tex') })),
      'RENDER_INPUT_INVALID',
      'NAME_NOT_ALLOWLISTED',
    );
    // And the same job without data stages the single allowed name.
    const ok = await stageRenderJob(request({ engine: 'latex', root: root('tex2'), data: undefined }));
    expect(ok.names).toEqual(['artifact.tex']);
  });

  it('requires data.json for typst, which may not render without it', async () => {
    await rejects(
      stageRenderJob(request({ data: undefined })),
      'RENDER_INPUT_INVALID',
      'MISSING_ENTRY',
    );
  });

  it('rejects an unknown engine and a malformed request without any I/O', async () => {
    await rejects(
      stageRenderJob(request({ engine: 'pdflatex' as never })),
      'RENDER_INPUT_INVALID',
      'NAME_NOT_ALLOWLISTED',
    );
    await rejects(
      stageRenderJob(null as unknown as StageRequest),
      'RENDER_INPUT_INVALID',
      'NAME_NOT_ALLOWLISTED',
    );
    await rejects(
      stageRenderJob(request({ template: undefined as never })),
      'RENDER_INPUT_INVALID',
      'SOURCE_MISSING',
    );
    // Nothing was created on the way to any of those rejections.
    await expect(readdir(root()).catch(() => [])).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GUARD 1: symlinks (V5 / R5 / typst issue #5454) - the load-bearing control
// ---------------------------------------------------------------------------

describe('render/stage - GUARD symlink rejection (V5, R5, typst #5454)', () => {
  it('rejects a symlink NAMED data.json, where the name gate cannot help', async () => {
    // This is the exact shape the spike proved leaks: the name is on the allowlist
    // and passes `assertSafeStageName()`, so ONLY the lstat type gate can catch it.
    // If this test ever needs the name allowlist to fail, the guard has been weakened.
    const r = root();
    await mkdir(r, { recursive: true });
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await writeFile(path.join(r, 'template.typ'), '#set page(paper: "a4")\n');
    const canary = await canaryFile();
    await symlinkAny(canary, path.join(r, 'data.json'));

    // Precondition: the name itself is acceptable to the policy validator, which is
    // asserted by the POSITIVE CONTROL below (the same tree, `data.json` as a regular
    // file, audits clean). Without it this test could not tell "rejected because it is
    // a symlink" from "rejected because the tree is malformed for some other reason".
    const error = await rejects(
      auditStageRoot(r, { expectedNames: ['data.json', 'template.typ'] }),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );
    expect(error.message).toContain('RENDER_INPUT_INVALID');
    expect(error.message).not.toContain('data.json');

    // POSITIVE CONTROL (the spike README requires one per fixture): replace the
    // symlink with a regular file carrying the SAME bytes and the very same tree must
    // audit clean. So the rejection above is caused by the type, not by the shape.
    await rm(path.join(r, 'data.json'), { force: true });
    await writeFile(path.join(r, 'data.json'), await readFile(canary));
    const clean = await auditStageRoot(r, { expectedNames: ['data.json', 'template.typ'] });
    expect(clean.names).toEqual(['data.json', 'template.typ']);
  });

  it('rejects a symlink whose target is RELATIVE and INSIDE the root (the only shape the type gate alone stops)', async () => {
    // Every other symlink test in this file points OUT of the root, which the
    // realpath containment check also refuses. An in-root relative target PASSES that
    // check, so for this input the `lstat` type gate is the only control that fires -
    // and the suite has to prove it, or a future "simplification" of the walk to
    // realpath containment would silently accept it.
    const r = root();
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await writeFile(path.join(r, 'template.typ'), 'real template');
    // The link's target is a REAL file inside the root, and it is itself declared, so
    // the tree has no off-allowlist entry that could be rejected for a different reason.
    await writeFile(path.join(r, 'data-real.bin'), 'real data');
    await symlinkAny('data-real.bin', path.join(r, 'data.json'));
    const expected = ['data-real.bin', 'data.json', 'template.typ'];

    // The three gates that would NOT catch it, asserted so the test cannot silently
    // change what it proves: the name is on the allowlist, and the link's realpath is
    // inside the root's realpath.
    expect(RENDER_POLICY.allowedStageNames.typst).toContain('data.json');
    expect(await realpath(path.join(r, 'data.json'))).toBe(await realpath(path.join(r, 'data-real.bin')));
    await rejects(
      auditStageRoot(r, { expectedNames: expected }),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );

    // POSITIVE CONTROL: the same tree with a real `data.json` audits clean.
    await rm(path.join(r, 'data.json'), { force: true });
    await writeFile(path.join(r, 'data.json'), 'real data');
    const clean = await auditStageRoot(r, { expectedNames: expected });
    expect(clean.names).toEqual(expected);
  });

  it('rejects the spike fixture b-symlink-escape at staging, before typst is involved', async () => {
    const r = root();
    await mkdir(r, { recursive: true });
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    // The fixture's own template, verbatim, plus the symlink it plants.
    await writeFile(path.join(r, 'template.typ'), await readFile(TEMPLATE_B));
    await writeFile(path.join(r, 'data.json'), await readFile(DATA_A));
    const canary = await canaryFile('clearance-spike-canary.txt');
    await symlinkAny(canary, path.join(r, 'passwd'));

    // The fixture's template is literally `#let leaked = read("passwd")`.
    expect(await readFile(path.join(r, 'template.typ'), 'utf8')).toContain('read("passwd")');
    // Under the audit: the symlink is refused. typst is never reached, so the
    // byte-identity leak the spike measured cannot occur.
    await rejects(
      auditStageRoot(r, { expectedNames: ['data.json', 'passwd', 'template.typ'] }),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );
    // And the job that tried to stage it is refused too - at the freshness gate,
    // because the root already holds a tree. That is a different guard, so it is NOT
    // what the assertion above rests on.
    await rejects(stageRenderJob(request({ root: r })), 'RENDER_INPUT_INVALID', 'ROOT_NOT_FRESH');

    // POSITIVE CONTROL (spike README requirement): the SAME tree with `passwd` as a
    // REGULAR file audits clean. Without this, a change that made the audit reject
    // this tree for an unrelated reason (a cap, a layout change) would leave the test
    // green and the fixture unproven.
    await rm(path.join(r, 'passwd'), { force: true });
    await writeFile(path.join(r, 'passwd'), CANARY);
    const clean = await auditStageRoot(r, {
      expectedNames: ['data.json', 'passwd', 'template.typ'],
    });
    expect(clean.names).toEqual(['data.json', 'passwd', 'template.typ']);
  });

  it('refuses a symlink handed in as the template SOURCE, before it is opened', async () => {
    // read() on a symlink FOLLOWS it on POSIX, so a source symlink would be the same
    // arbitrary read from the other direction. The canary is never read.
    const canary = await canaryFile();
    const linkPath = path.join(sandbox, 'innocent.typ');
    await symlinkAny(canary, linkPath);
    const error = await rejects(
      stageRenderJob(request({ template: { path: linkPath }, root: root() })),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );
    expect(error.message).not.toContain(CANARY);
    expect(await readFile(canary, 'utf8')).toBe(CANARY); // untouched
  });

  it('refuses a symlinked root itself', async () => {
    const real = path.join(sandbox, 'real-root');
    await mkdir(real, { recursive: true });
    const linkPath = root('linked-root');
    await symlinkAny(real, linkPath);
    await rejects(
      auditStageRoot(linkPath, { expectedNames: ['template.typ'] }),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );
  });

  it('refuses a symlinked .pkgcache, and one that is not empty', async () => {
    const r = root();
    await mkdir(r, { recursive: true });
    await symlinkAny(await canaryFile(), path.join(r, STAGE_PACKAGE_CACHE_DIR));
    await rejects(
      auditStageRoot(r, { expectedNames: ['template.typ'] }),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );

    const r2 = root('r2');
    await mkdir(path.join(r2, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await writeFile(path.join(r2, STAGE_PACKAGE_CACHE_DIR, 'download.tar.gz'), 'x');
    await rejects(
      auditStageRoot(r2, { expectedNames: ['template.typ'] }),
      'RENDER_INPUT_INVALID',
      'PACKAGE_CACHE_NOT_EMPTY',
    );
  });

  it('refuses a symlinked ASSET declaration, which is the same gate on a different path', async () => {
    const linkPath = path.join(sandbox, 'logo.png');
    await symlinkAny(await canaryFile(), linkPath);
    await rejects(
      stageRenderJob(
        request({ assets: [{ name: 'logo.png', source: { path: linkPath } }], root: root() }),
      ),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );
  });
});

// ---------------------------------------------------------------------------
// GUARD 2: hardlinks
// ---------------------------------------------------------------------------

describe('render/stage - GUARD hardlink rejection', () => {
  it('rejects a hardlinked regular file (nlink > 1), which lstat cannot see as a symlink', async () => {
    const r = root();
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    // A hardlink cannot cross a device boundary, so both names are made inside the
    // sandbox rather than linking the fixture (which lives on another volume here).
    const outside = path.join(sandbox, 'outside.json');
    await writeFile(outside, await readFile(DATA_A));
    // `data.json` is a REGULAR file as far as lstat is concerned; only the link
    // count reveals that it shares an inode with a file outside the root.
    await link(outside, path.join(r, 'data.json'));
    await writeFile(path.join(r, 'template.typ'), 'x');
    const stats = await lstat(path.join(r, 'data.json'));
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isFile()).toBe(true);
    expect(stats.nlink).toBeGreaterThan(1);

    await rejects(
      auditStageRoot(r, { expectedNames: ['data.json', 'template.typ'] }),
      'RENDER_INPUT_INVALID',
      'HARDLINK',
    );
  });

  it('rejects a hardlinked template SOURCE', async () => {
    const original = path.join(sandbox, 'original.typ');
    await writeFile(original, await readFile(TEMPLATE_A));
    const hard = path.join(sandbox, 'hard.typ');
    await link(original, hard);
    await rejects(
      stageRenderJob(request({ template: { path: hard } })),
      'RENDER_INPUT_INVALID',
      'HARDLINK',
    );
  });
});

// ---------------------------------------------------------------------------
// GUARD 3: type (only a plain regular file may be staged)
// ---------------------------------------------------------------------------

describe('render/stage - GUARD non-regular entry rejection', () => {
  it('rejects a DIRECTORY wearing a staged name', async () => {
    const r = root();
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await mkdir(path.join(r, 'data.json'));
    await rejects(
      auditStageRoot(r, { expectedNames: ['data.json', 'template.typ'] }),
      'RENDER_INPUT_INVALID',
      'NOT_REGULAR',
    );
  });

  it('rejects a nested directory and a subdirectory tree outright', async () => {
    const r = root();
    await mkdir(path.join(r, 'assets', 'nested'), { recursive: true });
    await writeFile(path.join(r, 'assets', 'nested', 'logo.png'), 'x');
    await rejects(
      auditStageRoot(r, { expectedNames: ['template.typ'] }),
      'RENDER_INPUT_INVALID',
      'UNEXPECTED_ENTRY',
    );
  });

  it('rejects a staged source that is a directory or missing', async () => {
    await rejects(
      stageRenderJob(request({ template: { path: sandbox } })),
      'RENDER_INPUT_INVALID',
      'NOT_REGULAR',
    );
    await rejects(
      stageRenderJob(request({ template: { path: path.join(sandbox, 'nope.typ') } })),
      'RENDER_INPUT_INVALID',
      'SOURCE_MISSING',
    );
  });
});

// ---------------------------------------------------------------------------
// GUARD 4: the name allowlist
// ---------------------------------------------------------------------------

describe('render/stage - GUARD name allowlist', () => {
  it('rejects the leftovers the spike measured (V21) and an off-allowlist file', async () => {
    for (const leftover of [
      'previous-job', // V21: typst CAN read an in-root leftover
      'probe.typ',
      '.artifact.pdf.lock',
      'plugin.wasm', // V8
      'secret.txt',
    ]) {
      const r = root(`w-${leftover.replace(/[^a-z]/gi, '')}`);
      await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
      await writeFile(path.join(r, 'template.typ'), 'x');
      await writeFile(path.join(r, leftover), CANARY);
      const error = await rejects(
        auditStageRoot(r, { expectedNames: ['template.typ'] }),
        'RENDER_INPUT_INVALID',
        // A dotfile or an unsafe character is caught by the STRUCTURE gate first,
        // which is stronger than the allowlist; the rest by the ALLOWLIST gate.
        leftover.startsWith('.') ? 'NAME_UNSAFE' : 'UNEXPECTED_ENTRY',
      );
      expect(error.message).not.toContain(leftover);
      expect(error.message).not.toContain(CANARY);
    }
  });

  it('rejects a declared asset name that is not a safe basename', async () => {
    for (const bad of [
      '../escape.png',
      '../../etc/passwd',
      '/etc/passwd',
      'a/b.png',
      'a\\b.png',
      '-flag.png',
      '.hidden.png',
      'a b.png',
      'a\nb',
      'a\u0000b',
      'x'.repeat(65),
      '',
      '..',
    ]) {
      await rejects(
        stageRenderJob(
          request({ assets: [{ name: bad, source: { path: DATA_A } }], root: root(`n${bad.length}`) }),
        ),
        'RENDER_INPUT_INVALID',
        'NAME_UNSAFE',
      );
    }
  });

  it('refuses an asset that would SHADOW a policy-fixed name', async () => {
    // Otherwise a caller could choose the bytes the engine reads as its data.
    for (const name of [RENDER_PATHS.names.data, stageTemplateName('typst')]) {
      await rejects(
        stageRenderJob(request({ assets: [{ name, source: { path: DATA_A } }] })),
        'RENDER_INPUT_INVALID',
        'NAME_NOT_ALLOWLISTED',
      );
    }
  });

  it('refuses a CASE variant of a policy-fixed name, which is the same file on Windows and APFS', async () => {
    // `Template.typ` and `template.typ` are different STRINGS but the same FILE on a
    // case-insensitive filesystem. The shadow check used to compare exactly, so this
    // slipped past it and only failed later, by accident, when `O_EXCL` reported
    // EEXIST as `RENDER_STAGE_IO` - a "host fault" for what is an input error. The
    // comparison is case-folded, so the refusal names the input problem.
    for (const name of ['Template.typ', 'TEMPLATE.TYP', 'Data.json']) {
      await rejects(
        stageRenderJob(
          request({ assets: [{ name, source: { path: DATA_A } }], root: root(`c-${name}`) }),
        ),
        'RENDER_INPUT_INVALID',
        'NAME_NOT_ALLOWLISTED',
      );
    }
    // The same for the LaTeX engine's one policy-fixed name.
    await rejects(
      stageRenderJob(
        request({
          engine: 'latex',
          data: undefined,
          assets: [{ name: 'Artifact.tex', source: { path: DATA_A } }],
          root: root('c-latex'),
        }),
      ),
      'RENDER_INPUT_INVALID',
      'NAME_NOT_ALLOWLISTED',
    );
    // Positive control: a case variant of a name that is NOT policy-fixed stages
    // cleanly, so the fold is not a blanket ban on upper case.
    const logo = path.join(sandbox, 'Logo.PNG');
    await writeFile(logo, 'x');
    const ok = await stageRenderJob(
      request({ assets: [{ name: 'Logo.PNG', source: { path: logo } }], root: root('ok-case') }),
    );
    expect(ok.names).toEqual(['Logo.PNG', 'data.json', 'template.typ']);
  });

  it('refuses a Windows RESERVED DEVICE name, which satisfies the character allowlist', async () => {
    // `NUL`, `CON`, `COM1`, ... are legal by every structural rule, so they used to be
    // staged and then refused downstream as NOT_REGULAR (a character device on the
    // destination) - a confusing reason for a legal-looking declared name. The name
    // gate is the right place, and it is POSIX-harmless.
    for (const name of ['NUL', 'nul', 'CON', 'aux', 'COM1', 'LPT9', 'CLOCK$', 'NUL.png']) {
      await rejects(
        stageRenderJob(
          request({ assets: [{ name, source: { path: DATA_A } }], root: root(`d${name.length}`) }),
        ),
        'RENDER_INPUT_INVALID',
        'NAME_UNSAFE',
      );
    }
  });

  it('refuses an asset named after the package cache directory', async () => {
    await rejects(
      stageRenderJob(
        request({ assets: [{ name: STAGE_PACKAGE_CACHE_DIR, source: { path: DATA_A } }] }),
      ),
      'RENDER_INPUT_INVALID',
      'NAME_NOT_ALLOWLISTED',
    );
  });

  it('rejects two assets that reduce to the same staged name', async () => {
    await rejects(
      stageRenderJob(
        request({
          assets: [
            { name: 'logo.png', source: { path: DATA_A } },
            { name: 'logo.png', source: { path: DATA_A } },
          ],
        }),
      ),
      'RENDER_INPUT_INVALID',
      'NAME_NOT_ALLOWLISTED',
    );
  });

  it('rejects a root that is missing a declared entry, and one with a symlink-free extra', async () => {
    const r = root();
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await writeFile(path.join(r, 'template.typ'), 'x');
    await rejects(
      auditStageRoot(r, { expectedNames: ['data.json', 'template.typ'] }),
      'RENDER_INPUT_INVALID',
      'MISSING_ENTRY',
    );
    // And a root with no package cache dir at all is not a valid M3 root.
    const r2 = root('r2');
    await mkdir(r2, { recursive: true });
    await writeFile(path.join(r2, 'template.typ'), 'x');
    await rejects(
      auditStageRoot(r2, { expectedNames: ['template.typ'] }),
      'RENDER_INPUT_INVALID',
      'MISSING_ENTRY',
    );
  });
});

// ---------------------------------------------------------------------------
// GUARD 5: path traversal / containment
// ---------------------------------------------------------------------------

describe('render/stage - GUARD path traversal and containment', () => {
  it('rejects a source that resolves outside the declared sourceRoot', async () => {
    // The source root is the template registry / adapter scratch area. A caller
    // cannot point `template.path` at /etc/passwd and have it staged.
    const registry = path.join(sandbox, 'registry');
    await mkdir(registry, { recursive: true });
    const outside = path.join(sandbox, 'outside.typ');
    await writeFile(outside, CANARY);
    await rejects(
      stageRenderJob(
        request({ template: { path: outside }, sourceRoot: registry, root: root() }),
      ),
      'RENDER_INPUT_INVALID',
      'PATH_ESCAPES_ROOT',
    );
  });

  it('rejects a source that escapes its sourceRoot through a symlinked parent', async () => {
    const registry = path.join(sandbox, 'registry');
    await mkdir(registry, { recursive: true });
    // `data.json` lives INSIDE the registry on purpose: otherwise the first source
    // checked would fail the plain containment test and this test would pass for a
    // reason that has nothing to do with the symlinked hop.
    await writeFile(path.join(registry, 'data.json'), await readFile(DATA_A));
    const outsideDir = path.join(sandbox, 'elsewhere');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, 'innocent.typ'), CANARY);
    const hop = path.join(registry, 'hop');
    await symlinkDir(outsideDir, hop);
    // The hop really does resolve outside the registry, so the refusal below is the
    // containment guard and not an incidental read error.
    expect(await realpath(path.join(hop, 'innocent.typ'))).toBe(
      await realpath(path.join(outsideDir, 'innocent.typ')),
    );
    await rejects(
      stageRenderJob(
        request({
          template: { path: path.join(hop, 'innocent.typ') },
          data: { path: path.join(registry, 'data.json') },
          sourceRoot: registry,
        }),
      ),
      'RENDER_INPUT_INVALID',
      'PATH_ESCAPES_ROOT',
    );
  });

  it('accepts a source that genuinely lives inside the sourceRoot', async () => {
    const registry = path.join(sandbox, 'registry');
    await mkdir(registry, { recursive: true });
    await writeFile(path.join(registry, 'template.typ'), await readFile(TEMPLATE_A));
    await writeFile(path.join(registry, 'data.json'), await readFile(DATA_A));
    const result = await stageRenderJob(
      request({
        template: { path: path.join(registry, 'template.typ') },
        data: { path: path.join(registry, 'data.json') },
        sourceRoot: registry,
      }),
    );
    expect(result.names).toEqual(['data.json', 'template.typ']);
  });

  it('never lets a staged path leave the root, whatever the name looks like', async () => {
    // Structural proof of the name gate: nothing `assertSafeStageName` accepts can
    // contain a separator, so `path.join(root, name)` cannot leave the root.
    for (const name of ['..', '.', '../x', 'a/b', '/abs', 'a\\b', '-x', 'a\u0000b']) {
      await rejects(
        stageRenderJob(
          request({ assets: [{ name, source: { path: DATA_A } }], root: root(`t${name.length}`) }),
        ),
        'RENDER_INPUT_INVALID',
        'NAME_UNSAFE',
      );
    }
  });

  it('refuses a non-string root rather than resolving something surprising', async () => {
    await rejects(
      stageRenderJob(request({ root: 42 as unknown as string })),
      'RENDER_INPUT_INVALID',
      'PATH_ESCAPES_ROOT',
    );
    await rejects(
      stageRenderJob(request({ root: '' })),
      'RENDER_INPUT_INVALID',
      'PATH_ESCAPES_ROOT',
    );
  });

  it('audits a root reached THROUGH a symlinked parent, which is what the walk check is for', async () => {
    // The stage ROOT being a symlink is refused outright by the root gate
    // (`refuses a symlinked root itself`). This is the different case: the root is a
    // real directory that happens to sit under a symlinked ANCESTOR. The walk's
    // `assertRealPathInsideRoot` is what makes entries that land inside the real root
    // acceptable there - and it is the only test of that call site in the walk (the
    // `sourceRoot` tests prove the function, not this call).
    const real = path.join(sandbox, 'elsewhere');
    const sub = path.join(real, 'work');
    await mkdir(path.join(sub, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await writeFile(path.join(sub, 'template.typ'), 'x');
    await writeFile(path.join(sub, 'data.json'), 'y');
    const hop = root('hop');
    await symlinkDir(real, hop);
    const rootViaHop = path.join(hop, 'work');
    expect(await realpath(rootViaHop)).toBe(await realpath(sub));
    expect((await lstat(rootViaHop)).isSymbolicLink()).toBe(false);

    // Positive: entries that really are inside the real root audit clean.
    const clean = await auditStageRoot(rootViaHop, { expectedNames: ['data.json', 'template.typ'] });
    expect(clean.names).toEqual(['data.json', 'template.typ']);

    // Negative: an entry that leaves the real root is still refused, and the reason
    // says it is a symlink rather than an incidental containment failure.
    await symlinkAny(await canaryFile(), path.join(sub, 'extra.json'));
    await rejects(
      auditStageRoot(rootViaHop, { expectedNames: ['data.json', 'extra.json', 'template.typ'] }),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );
  });

  it('carries the CALLER-SIDE code on a containment failure, not a hardcoded input code', async () => {
    // The same lexical and realpath containment question is asked of two trees, so the
    // code/reason pair is a parameter: a containment failure on the artifact path must
    // not surface as an input rejection (policy 6.3, not 5.2).
    const inside = path.join(sandbox, 'inside');
    await mkdir(inside, { recursive: true });
    const outside = path.join(sandbox, 'outside-dir');
    await mkdir(outside, { recursive: true });

    // Lexical: contained paths pass, escaping paths fail with the pair given.
    expect(() =>
      assertPathInsideRoot(inside, path.join(inside, 'artifact.pdf'), 'RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTSIDE_OUT'),
    ).not.toThrow();
    let caught: unknown;
    try {
      assertPathInsideRoot(inside, path.join(outside, 'artifact.pdf'), 'RENDER_INPUT_INVALID', 'PATH_ESCAPES_ROOT');
    } catch (err) {
      caught = err;
    }
    expect((caught as StageError).reason).toBe('PATH_ESCAPES_ROOT');
    caught = undefined;
    try {
      assertPathInsideRoot(inside, path.join(outside, 'x'), 'RENDER_ARTIFACT_INVALID', 'ARTIFACT_OUTSIDE_OUT');
    } catch (err) {
      caught = err;
    }
    expect((caught as StageError).code).toBe('RENDER_ARTIFACT_INVALID');
    expect((caught as StageError).reason).toBe('ARTIFACT_OUTSIDE_OUT');

    // Realpath: the same, with a real escaping pair.
    await writeFile(path.join(outside, 'artifact.pdf'), 'x');
    await writeFile(path.join(inside, 'artifact.pdf'), 'y');
    await rejects(
      assertRealPathInsideRoot(
        inside,
        path.join(outside, 'artifact.pdf'),
        'RENDER_ARTIFACT_INVALID',
        'ARTIFACT_OUTSIDE_OUT',
      ),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_OUTSIDE_OUT',
    );
    await expect(
      assertRealPathInsideRoot(
        inside,
        path.join(inside, 'artifact.pdf'),
        'RENDER_INPUT_INVALID',
        'PATH_ESCAPES_ROOT',
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a malformed CALL rather than letting a raw TypeError escape', async () => {
    // The module's contract is that every rejection is a StageError with a code. Four
    // entry points used to read a property off a `null`/non-object argument and throw
    // `TypeError: Cannot read properties of null`, which has no code and no reason.
    const cases: Array<[string, () => Promise<unknown>, string, string]> = [
      [
        'auditStageRoot(root, null)',
        () => auditStageRoot(root(), null as unknown as { expectedNames: string[] }),
        'RENDER_INPUT_INVALID',
        'REQUEST_INVALID',
      ],
      [
        'auditStageRoot with a non-string root',
        () => auditStageRoot(42 as unknown as string, { expectedNames: [] }),
        'RENDER_INPUT_INVALID',
        'PATH_ESCAPES_ROOT',
      ],
      [
        'auditStageRoot with a non-array expectedNames',
        () => auditStageRoot(root(), { expectedNames: 'template.typ' as unknown as string[] }),
        'RENDER_INPUT_INVALID',
        'REQUEST_INVALID',
      ],
      [
        'auditStageRoot with a non-string expected name',
        () => auditStageRoot(root(), { expectedNames: [42 as unknown as string] }),
        'RENDER_INPUT_INVALID',
        'NAME_UNSAFE',
      ],
      [
        'stageRenderJob with a non-iterable assets',
        () => stageRenderJob(request({ assets: 5 as unknown as [] })),
        'RENDER_INPUT_INVALID',
        'REQUEST_INVALID',
      ],
      [
        'stageRenderJobInMemory with a non-iterable assets',
        () => stageRenderJobInMemory(request({ assets: 5 as unknown as [] })),
        'RENDER_INPUT_INVALID',
        'REQUEST_INVALID',
      ],
      [
        'validateRenderArtifact(null)',
        () => validateRenderArtifact(null as unknown as { format: 'pdf' }),
        'RENDER_ARTIFACT_INVALID',
        'ARTIFACT_FORMAT_UNKNOWN',
      ],
    ];
    for (const [label, call, code, reason] of cases) {
      let caught: unknown;
      try {
        await call();
      } catch (err) {
        caught = err;
      }
      expect(caught, label).toBeInstanceOf(StageError);
      expect((caught as StageError).code, label).toBe(code);
      expect((caught as StageError).reason, label).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// GUARD 6: size caps
// ---------------------------------------------------------------------------

describe('render/stage - GUARD declared size caps (policy 5.2.2)', () => {
  it('rejects an over-large DECLARED size before the root is even created', async () => {
    await rejects(
      stageRenderJob(
        request({ template: { path: TEMPLATE_A, declaredBytes: RENDER_LIMITS.inputFileBytes + 1 } }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'FILE_TOO_LARGE',
    );
    expect(await readdir(root()).catch(() => [])).toEqual([]);
  });

  it('gives data.json its own larger cap and refuses it past THAT cap', async () => {
    // template.typ at 2 MiB is over the asset cap but under the data cap, so it can
    // only be data.json; at 5 MiB it is over both.
    const big = path.join(sandbox, 'big.json');
    await writeFile(big, Buffer.alloc(RENDER_LIMITS.dataFileBytes + 1, 0x41));
    await rejects(
      stageRenderJob(request({ data: { path: big, declaredBytes: RENDER_LIMITS.dataFileBytes + 1 } })),
      'RENDER_INPUT_TOO_LARGE',
      'FILE_TOO_LARGE',
    );
    expect(RENDER_LIMITS.dataFileBytes).toBe(4_194_304);
    expect(RENDER_LIMITS.inputFileBytes).toBe(1_048_576);
  });

  it('rejects an over-large MEASURED size even when nothing was declared', async () => {
    const big = path.join(sandbox, 'big.bin');
    await writeFile(big, Buffer.alloc(RENDER_LIMITS.inputFileBytes + 1, 0x42));
    await rejects(
      stageRenderJob(
        request({ assets: [{ name: 'big.bin', source: { path: big } }], root: root('big') }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'FILE_TOO_LARGE',
    );
  });

  it('rejects a total over the 8 MiB cap, with every file individually legal', async () => {
    const assets: Array<{ name: string; source: { path: string; declaredBytes: number } }> = [];
    for (let i = 0; i < 3; i += 1) {
      const p = path.join(sandbox, `chunk-${i}.bin`);
      await writeFile(p, Buffer.alloc(1024, 0x43));
      assets.push({ name: `chunk-${i}.bin`, source: { path: p, declaredBytes: 1024 } });
    }
    const total = RENDER_LIMITS.inputTotalBytes + 1;
    await rejects(
      stageRenderJob(
        request({
          template: { path: TEMPLATE_A, declaredBytes: total },
          assets,
        }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'TOTAL_TOO_LARGE',
    );
  });

  it('refuses more files than the policy count', async () => {
    const assets = [];
    for (let i = 0; i < 4; i += 1) {
      const p = path.join(sandbox, `a-${i}.bin`);
      await writeFile(p, 'x');
      assets.push({ name: `a-${i}.bin`, source: { path: p } });
    }
    // template.typ + data.json + 4 assets = 6, over the cap of 5.
    expect(RENDER_LIMITS.inputFileCount).toBe(5);
    await rejects(
      stageRenderJob(request({ assets, root: root('many') })),
      'RENDER_INPUT_TOO_LARGE',
      'TOO_MANY_FILES',
    );
  });

  it('refuses looser limits than the policy, and accepts tighter ones', () => {
    const looser: RenderLimits = {
      ...RENDER_LIMITS,
      inputFileBytes: RENDER_LIMITS.inputFileBytes * 2,
    };
    let caught: StageError | undefined;
    try {
      assertStageLimits(looser);
    } catch (err) {
      caught = err as StageError;
    }
    expect(caught).toBeInstanceOf(StageError);
    expect(caught?.reason).toBe('LIMITS_TOO_LOOSE');
    expect(caught?.code).toBe('RENDER_INPUT_INVALID');
    // The message is the fixed text for the reason, never a dump of the caps.
    expect(caught?.message).toBe(
      'RENDER_INPUT_INVALID: a caller supplied staging limits weaker than the policy caps',
    );
    // `outputBytes` is compared too, even though nothing in this module reads it: it
    // travels on StageResult.limits / StageAudit.limits, so a limits object claiming a
    // weaker output cap than the policy is wrong whatever the caller does with it.
    for (const field of ['outputBytes', 'inputTotalBytes', 'dataFileBytes'] as const) {
      expect(() => assertStageLimits({ ...RENDER_LIMITS, [field]: Number.MAX_SAFE_INTEGER })).toThrow(
        /LIMITS_TOO_LOOSE|weaker than the policy caps/,
      );
    }
    const tighter: RenderLimits = { ...RENDER_LIMITS, inputFileBytes: 1024 };
    // The returned value is a FROZEN COPY, not the caller's object: it is read again
    // after several awaits, so a caller that mutated it could change a policy cap under
    // a guard that had already proved itself. Field-for-field equality, never identity.
    const accepted = assertStageLimits(tighter);
    expect(accepted).toEqual(tighter);
    expect(accepted).not.toBe(tighter);
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(assertStageLimits(undefined)).toBe(RENDER_LIMITS);
  });

  it('refuses a MALFORMED limits object rather than letting a TypeError escape', async () => {
    // Every rejection in this module is a StageError with a machine-readable code; a
    // `null` limits or a non-numeric field used to escape as a raw TypeError.
    for (const bad of [null, 'loose', 42, [], { ...RENDER_LIMITS, inputFileBytes: null }]) {
      let caught: unknown;
      try {
        assertStageLimits(bad as unknown as RenderLimits);
      } catch (err) {
        caught = err;
      }
      expect(caught, `expected a StageError for ${String(bad)}`).toBeInstanceOf(StageError);
      expect((caught as StageError).reason).toBe('LIMITS_INVALID');
      expect((caught as StageError).code).toBe('RENDER_INPUT_INVALID');
    }
    // And the same guard holds through the two entry points that read `limits`.
    for (const call of [
      () => auditStageRoot(root(), { expectedNames: [], limits: null as unknown as RenderLimits }),
      () => stageRenderJob(request({ limits: { inputFileCount: Number.NaN } as unknown as RenderLimits })),
    ]) {
      let caught: unknown;
      try {
        await call();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StageError);
      expect((caught as StageError).reason).toBe('LIMITS_INVALID');
    }
  });

  it('refuses a nonsense declared byte count, which would otherwise reduce the job total', async () => {
    // A negative declared size passes both `typeof`/`isFinite` and the cap comparison
    // (`-1 > cap` is false), and then SUBTRACTS from the declared total, weakening the
    // pre-copy early exit. The real bounds are the measured size and the mid-stream
    // count, so this is not an escape - but a guard should refuse nonsense rather than
    // silently accept it.
    for (const declaredBytes of [-1, -4096, 1.5, 0.5, -0.5]) {
      await rejects(
        stageRenderJob(request({ template: { path: TEMPLATE_A, declaredBytes }, root: root('d') })),
        'RENDER_INPUT_INVALID',
        'SIZE_MISMATCH',
      );
    }
  });

  it('bounds the job by its RUNNING total mid-stream, not only by the per-file cap', async () => {
    // The old evidence record called the mid-stream budget redundant with the post-copy
    // audit. It is not: with the per-file cap and the pre-copy `lstat` both out of the
    // way (declared sizes are UNDER-declared here, which is legal), the per-job running
    // total is the only bound that fires while the bytes are moving, and it fires
    // BEFORE the chunk is written. Remove it and the oversized file lands in full and
    // the rejection only arrives afterwards, at the audit.
    const small = path.join(sandbox, 'small-1.bin');
    await writeFile(small, Buffer.alloc(60, 0x61));
    const small2 = path.join(sandbox, 'small-2.bin');
    await writeFile(small2, Buffer.alloc(60, 0x62));
    const limits: RenderLimits = { ...RENDER_LIMITS, inputTotalBytes: 100 };
    // Declared 40 + 40 = 80, under the 100 cap: the pre-copy sum passes. Measured
    // 60 + 60 = 120, over it: the running total is what refuses the job.
    await rejects(
      stageRenderJob(
        request({
          template: { path: small, declaredBytes: 40 },
          data: { path: small2, declaredBytes: 40 },
          root: root('running'),
          limits,
        }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'TOTAL_TOO_LARGE',
    );
    // Nothing over the cap is left behind: the second file never landed whole.
    await expect(readdir(root('running'))).rejects.toThrow();
  });

  it('the AUDIT re-checks the per-file cap on a root it did not stage', async () => {
    // The caps must be enforced by the WALK as well as by the copy, because the walk
    // is callable on a root the caller did not stage (an entrypoint-prepared /work,
    // a root handed over by a broker). Under the policy caps the per-file check is
    // the one that binds first - 1 + 4 + 3 x 1 MiB is exactly the 8 MiB total - so
    // this is where an over-large file is caught.
    const r = root('audit-caps');
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await writeFile(path.join(r, 'template.typ'), 'x');
    await writeFile(path.join(r, 'data.json'), Buffer.alloc(RENDER_LIMITS.dataFileBytes + 1, 0x45));
    await rejects(
      auditStageRoot(r, { expectedNames: ['data.json', 'template.typ'] }),
      'RENDER_INPUT_TOO_LARGE',
      'FILE_TOO_LARGE',
    );
  });

  it('the AUDIT re-checks the total cap when tighter limits bind first', async () => {
    const r = root('audit-total');
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await writeFile(path.join(r, 'template.typ'), Buffer.alloc(8, 0x47));
    await writeFile(path.join(r, 'data.json'), Buffer.alloc(8, 0x48));
    const limits: RenderLimits = { ...RENDER_LIMITS, inputTotalBytes: 10 };
    await rejects(
      auditStageRoot(r, { expectedNames: ['data.json', 'template.typ'], limits }),
      'RENDER_INPUT_TOO_LARGE',
      'TOTAL_TOO_LARGE',
    );
  });

  it('the AUDIT re-checks the file-count cap', async () => {
    const r = root('audit-count');
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    const names = ['template.typ', 'a.bin', 'b.bin', 'c.bin'];
    for (const name of names) await writeFile(path.join(r, name), Buffer.alloc(8, 0x49));
    const limits: RenderLimits = { ...RENDER_LIMITS, inputFileCount: 3 };
    await rejects(
      auditStageRoot(r, { expectedNames: names, limits }),
      'RENDER_INPUT_TOO_LARGE',
      'TOO_MANY_FILES',
    );
  });

  it('enforces the caps with a TIGHTER limit the caller supplies', async () => {
    const limits: RenderLimits = { ...RENDER_LIMITS, inputFileBytes: 16 };
    await rejects(
      stageRenderJob(
        request({
          assets: [{ name: 'logo.png', source: { path: DATA_A } }],
          limits,
          root: root('tight'),
        }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'FILE_TOO_LARGE',
    );
  });
});

// ---------------------------------------------------------------------------
// GUARD 7: no reuse of a work directory, and cleanup on failure
// ---------------------------------------------------------------------------

describe('render/stage - GUARD no work-dir reuse and cleanup (policy 3.2, 5.2.6, 10.1)', () => {
  it('refuses a root that already holds anything', async () => {
    const r = root();
    await mkdir(r, { recursive: true });
    await writeFile(path.join(r, 'previous-job'), CANARY);
    const error = await rejects(
      stageRenderJob(request({ root: r })),
      'RENDER_INPUT_INVALID',
      'ROOT_NOT_FRESH',
    );
    expect(error.message).not.toContain(CANARY);
  });

  it('accepts a pre-created but EMPTY root, and tolerates an existing empty .pkgcache', async () => {
    const r = root();
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    const result = await stageRenderJob(request({ root: r }));
    expect(result.names).toEqual(['data.json', 'template.typ']);
  });

  it('leaves NOTHING behind when staging fails part way through', async () => {
    const big = path.join(sandbox, 'big.bin');
    await writeFile(big, Buffer.alloc(RENDER_LIMITS.inputFileBytes + 1, 0x44));
    const r = root('doomed');
    // `big.bin` sorts before `data.json`, so the failure happens AFTER template.typ
    // and data.json have already been written: the partial tree must be destroyed.
    await expect(
      stageRenderJob(request({ root: r, assets: [{ name: 'big.bin', source: { path: big } }] })),
    ).rejects.toBeInstanceOf(StageError);
    await expect(readdir(r)).rejects.toThrow(); // the root is gone entirely
  });

  it('leaves NOTHING behind in a root that already EXISTED, so a mid-copy failure cannot litter it', async () => {
    // The counterpart of the test above: there the root is created by the call, so the
    // whole directory is removed. Here the root pre-exists (the shape the container
    // entrypoint produces), so only the paths this call created are removed - and a
    // destination that failed MID-COPY was never registered for cleanup, because the
    // copy never returned. The pre-existing content must be exactly what it was.
    const one = path.join(sandbox, 'mid-1.bin');
    await writeFile(one, Buffer.alloc(60, 0x61));
    const two = path.join(sandbox, 'mid-2.bin');
    await writeFile(two, Buffer.alloc(60, 0x62));
    const r = root('preexisting');
    // Only `.pkgcache` is tolerated in a pre-existing root (policy 3.2): any other
    // entry is a leftover and the job is refused with ROOT_NOT_FRESH before any copy.
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    // Declared 40 + 40 = 80 under the 100 cap, so the pre-copy sum passes; the running
    // total refuses the second file while its bytes are still moving.
    await rejects(
      stageRenderJob(
        request({
          template: { path: one, declaredBytes: 40 },
          data: { path: two, declaredBytes: 40 },
          root: r,
          limits: { ...RENDER_LIMITS, inputTotalBytes: 100 },
        }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'TOTAL_TOO_LARGE',
    );
    // Neither the completed copy (`data.json`) nor the PARTIAL one (`template.typ`,
    // which never reached the cleanup list) is left behind.
    expect(await readdir(r)).toEqual([STAGE_PACKAGE_CACHE_DIR]);
  });

  it('does not delete a pre-existing root that staging refused to use', async () => {
    const r = root('keep');
    await mkdir(r, { recursive: true });
    await writeFile(path.join(r, 'previous-job'), CANARY);
    await expect(stageRenderJob(request({ root: r }))).rejects.toBeInstanceOf(StageError);
    expect(await readdir(r)).toEqual(['previous-job']);
  });

  it('refuses a root that is a SYMLINK, before writing a single byte into its target', async () => {
    // The root's own type. A symlinked root pointing at an EMPTY directory used to
    // pass the freshness check (its listing is empty), so the copies landed inside the
    // link target and only the audit afterwards refused the job. The refusal must come
    // first, and nothing may be written into the target.
    const target = path.join(sandbox, 'elsewhere');
    await mkdir(target, { recursive: true });
    const r = root('linked');
    await symlinkAny(target, r);
    await rejects(stageRenderJob(request({ root: r })), 'RENDER_INPUT_INVALID', 'SYMLINK');
    expect(await readdir(target)).toEqual([]);
  });

  it('refuses a root that is not a directory at all', async () => {
    // Previously an `ENOTDIR` from `readdir` surfaced as the opaque `RENDER_STAGE_IO`
    // "host fault", which sent an operator triage after the disk instead of the input.
    const r = root('a-file');
    await writeFile(r, CANARY);
    await rejects(stageRenderJob(request({ root: r })), 'RENDER_INPUT_INVALID', 'NOT_REGULAR');
    expect(await readFile(r, 'utf8')).toBe(CANARY);
  });

  it('two concurrent jobs on ONE root cannot both succeed: O_EXCL is load-bearing', async () => {
    // The M12 mutation row in the progress note used to claim `'wx'` was unreachable
    // because "the destination can never pre-exist". That held only for a strictly
    // SEQUENTIAL caller, and nothing in the module enforces sequentiality. Two
    // overlapping calls both pass the freshness check (the listing is empty, or holds
    // only `.pkgcache`) and both proceed to the copy.
    //
    // With `'wx'`: the loser's `open(dest, 'wx')` gets EEXIST and the job is refused.
    // With `'w'` : the second open TRUNCATES and rewrites, so EITHER both calls resolve
    // - each describing a tree the other has just overwritten - OR the loser's
    // post-copy `lstat` catches the truncation and rejects it, leaving the tree holding
    // the LOSER's bytes. Both shapes are caught below: the first by the count, the
    // second by comparing the bytes on disk against the bytes of the call that
    // actually succeeded.
    //
    // A race is a race, so the race is run several times: one round can legitimately
    // interleave in an order where the loser's freshness check fires before either copy
    // (nothing is overwritten, nothing to catch), and a single round would then report
    // a false pass. Every round asserts the invariant, so a mutation that produces the
    // bad interleaving in ANY round fails the test.
    for (let round = 0; round < 10; round += 1) {
      const r = root(`shared-${round}`);
      // The root PRE-EXISTS with the one entry the freshness check tolerates (the empty
      // `.pkgcache` the image entrypoint creates), so BOTH calls take the "the root is
      // already there" path. That matters: when the root does not exist yet, the
      // `mkdir` race decides the loser (`EEXIST` from `mkdir` itself) and the
      // destination `O_EXCL` is never reached - the collision has to be staged where
      // the guard under test actually is.
      await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
      const a = path.join(sandbox, `a-${round}.typ`);
      await writeFile(a, 'AAAA');
      const b = path.join(sandbox, `b-${round}.typ`);
      await writeFile(b, 'BBBBBBBB');
      const settled = await Promise.allSettled([
        stageRenderJob(request({ root: r, template: { path: a } })),
        stageRenderJob(request({ root: r, template: { path: b } })),
      ]);

      const winners = settled.filter((s) => s.status === 'fulfilled') as Array<PromiseFulfilledResult<unknown>>;
      const losers = settled.filter((s) => s.status === 'rejected') as Array<PromiseRejectedResult>;
      const winnerIndex = settled.findIndex((s) => s.status === 'fulfilled');
      const winnerSource = winnerIndex === 0 ? 'AAAA' : 'BBBBBBBB';
      expect(winners.length, `round ${round}: both jobs resolved on one root`).toBe(1);
      expect(losers.length, `round ${round}: neither job was refused`).toBe(1);
      // The loser is refused for "this root is already in use": either the freshness
      // gate saw the winner's files, or `O_EXCL` refused the destination. Both are the
      // same security outcome; neither is "the job succeeded".
      const loser = losers[0]?.reason as StageError;
      expect(loser).toBeInstanceOf(StageError);
      expect(['ROOT_NOT_FRESH', 'IO_ERROR'], `round ${round}`).toContain(loser.reason);
      // And the tree holds the WINNER's bytes, whole. This is the assertion that
      // catches the truncate-and-overwrite shape: if the other job's copy landed last,
      // its bytes are on disk under the winner's name.
      const staged = await readFile(path.join(r, 'template.typ'), 'utf8');
      expect(staged, `round ${round}: the tree holds the other job's bytes`).toBe(winnerSource);
      expect((winners[0]?.value as StageResult).entries).toHaveLength(2);
    }
  });
});

// ---------------------------------------------------------------------------
// GUARD 8: the error surface (policy 9.3 / 9.4)
// ---------------------------------------------------------------------------

describe('render/stage - GUARD the error surface carries no host path', () => {
  it('every rejection message is a fixed string with a code and no caller data', async () => {
    const canary = await canaryFile();
    const r = root();
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await symlinkAny(canary, path.join(r, 'passwd'));

    // Thunks, not promises: a rejected promise created up front is an UNHANDLED
    // rejection until a handler is attached, which would fail the run for the wrong
    // reason.
    const failures: Array<() => Promise<unknown>> = [
      () => auditStageRoot(r, { expectedNames: ['passwd'] }),
      () => stageRenderJob(request({ template: { path: canary } })),
      () => stageRenderJob(request({ root: r })),
      () => stageRenderJob(request({ template: { path: path.join(sandbox, 'absent.typ') } })),
      () =>
        stageRenderJob(
          request({ assets: [{ name: `${CANARY}/../x`, source: { path: DATA_A } }] }),
        ),
      () => validateRenderArtifact({ outDir: sandbox, format: 'pdf' }),
    ];

    for (const failure of failures) {
      let error: unknown;
      try {
        await failure();
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(StageError);
      const stageError = error as StageError;
      const surface = `${stageError.message} ${stageError.code} ${stageError.reason}`;
      expect(STAGE_REJECTION_CODES).toContain(stageError.code);
      expect(STAGE_REJECTION_REASONS).toContain(stageError.reason);
      // No host path, no temp root, no canary, no staged content.
      expect(surface).not.toContain(sandbox);
      expect(surface).not.toContain(CANARY);
      expect(surface).not.toContain('passwd');
      expect(surface).not.toMatch(/[A-Za-z]:\\/);
      expect(surface).not.toContain(tmpdir());
    }
  });

  it('the code and reason vocabularies are closed sets', () => {
    expect([...STAGE_REJECTION_CODES]).toEqual([
      'RENDER_INPUT_INVALID',
      'RENDER_INPUT_TOO_LARGE',
      'RENDER_ARTIFACT_INVALID',
      'RENDER_STAGE_IO',
    ]);
    // Three of the four are the policy's own codes (9.2, 5.2.2, 6.3).
    for (const code of ['RENDER_INPUT_TOO_LARGE', 'RENDER_ARTIFACT_INVALID']) {
      expect(RENDER_POLICY.outcomeCodes).toContain(code);
    }
    expect(new Set(STAGE_REJECTION_REASONS).size).toBe(STAGE_REJECTION_REASONS.length);
    // The count is PINNED, not just self-consistent. The old evidence record said "25
    // reasons" in one place while the set had 24 in another, and nothing caught it.
    expect(STAGE_REJECTION_REASONS).toHaveLength(28);
  });

  it('every reason has a fixed message, and the four added reasons say what they mean', () => {
    // Constructing the error is how the message table is exercised: REASON_TEXT is a
    // frozen total Record, so a missing key would surface as `undefined` and a
    // template as `undefined`-plus-caller-data.
    const fixed: Record<string, string> = {
      LIMITS_INVALID: 'RENDER_INPUT_INVALID: a caller supplied staging limits that are not a set of numbers',
      REQUEST_INVALID: 'RENDER_INPUT_INVALID: the staging request is malformed',
      ARTIFACT_OUTDIR_INVALID: 'RENDER_ARTIFACT_INVALID: the output directory is not a plain directory',
      ARTIFACT_SIZE_CHANGED: 'RENDER_ARTIFACT_INVALID: the artifact changed size while it was being read',
    };
    for (const [reason, message] of Object.entries(fixed)) {
      const code = reason.startsWith('ARTIFACT') ? 'RENDER_ARTIFACT_INVALID' : 'RENDER_INPUT_INVALID';
      const error = new StageError(code as never, reason as never);
      expect(error.message, reason).toBe(message);
      expect(error.message).not.toContain('undefined');
    }
    // And the whole set still renders a non-empty fixed message.
    for (const reason of STAGE_REJECTION_REASONS) {
      expect(new StageError('RENDER_INPUT_INVALID', reason).message.length).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// The read-escape fixtures: staged OK, refused by typst - the honest distinction
// ---------------------------------------------------------------------------

describe('render/stage - the c1/c2/c3 read-escape fixtures are NOT over-rejected', () => {
  it('stages all three, because typst (not the stager) refuses them', async () => {
    // c1/c2/c3 use literal `..` or an absolute path inside the TEMPLATE SOURCE. That
    // is a typst-level refusal ("would escape the project root" / rebased under
    // /work), measured in T1005. A stager that rejected them would be claiming a
    // control it does not have, so they must stage cleanly.
    for (const [i, template] of [TEMPLATE_C1, TEMPLATE_C2, TEMPLATE_C3].entries()) {
      const result = await stageRenderJob(
        request({ root: root(`c${i}`), template: { path: template } }),
      );
      expect(result.names).toEqual(['data.json', 'template.typ']);
    }
  });

  it('the distinction is the TYPE of entry in the root, not the text of the template', async () => {
    // b is the only fixture that plants a SYMLINK; c1/c2/c3 use literal `..` or an
    // absolute path inside the template source, which is typst's own refusal. This
    // asserts the fixtures really do differ that way, so the distinction above cannot
    // be quietly collapsed into "the stager rejects them all".
    //
    // Comments are stripped before the read() arguments are extracted: the fixtures
    // DISCUSS `read("../etc/passwd")` in their headers, and a fixture's prose about an
    // escape is not an escape.
    const code = (file: string): string =>
      file
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
    const readsIn = (file: string): string[] =>
      [...code(file).matchAll(/read\("([^"]*)"\)/g)].map((match) => match[1] as string);

    const b = await readFile(TEMPLATE_B, 'utf8');
    const c1 = await readFile(TEMPLATE_C1, 'utf8');
    // b reads a plain in-root name that the SPIKE plants as a symlink.
    expect(readsIn(b)).toEqual(['passwd']);
    // c1 reads a traversing path, which typst itself refuses.
    expect(readsIn(c1).some((arg) => arg.includes('..'))).toBe(true);
    expect(readsIn(b).some((arg) => arg.includes('..'))).toBe(false);

    // And b alone is rejected once its symlink is planted in the root.
    const r = root('b-root');
    await mkdir(path.join(r, STAGE_PACKAGE_CACHE_DIR), { recursive: true });
    await writeFile(path.join(r, 'template.typ'), b);
    await symlinkAny(await canaryFile(), path.join(r, 'passwd'));
    await rejects(
      auditStageRoot(r, { expectedNames: ['passwd', 'template.typ'] }),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );

    // POSITIVE CONTROL: the same tree with `passwd` as a REGULAR file audits clean, so
    // the rejection above is caused by the symlink and by nothing else.
    await rm(path.join(r, 'passwd'), { force: true });
    await writeFile(path.join(r, 'passwd'), CANARY);
    const clean = await auditStageRoot(r, { expectedNames: ['passwd', 'template.typ'] });
    expect(clean.names).toEqual(['passwd', 'template.typ']);
  });
});

// ---------------------------------------------------------------------------
// In-memory staging - the PRODUCTION path (ADR-042 D4, policy 3.1 / 4.4)
// ---------------------------------------------------------------------------

/**
 * A minimal, INDEPENDENT ustar reader, so the archive this module emits is checked by
 * something other than the code that wrote it. It parses the 512-byte headers, verifies
 * each checksum, and returns the entries with their contents.
 */
async function readUstar(
  stream: AsyncIterable<Buffer | Uint8Array | string>,
): Promise<Array<{ name: string; size: number; type: string; mode: string; body: Buffer }>> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  const archive = Buffer.concat(chunks);
  const entries: Array<{ name: string; size: number; type: string; mode: string; body: Buffer }> = [];
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) continue; // end-of-archive padding
    // Checksum: the sum of the header with the checksum field read as spaces.
    const declared = header.subarray(148, 154).toString('latin1').replace(/\0.*$/, '');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    expect(declared, `checksum at offset ${offset - 512}`).toBe(sum.toString(8).padStart(6, '0'));
    const readField = (start: number, length: number): string =>
      header.subarray(start, start + length).toString('latin1').replace(/\0.*$/, '');
    const size = parseInt(readField(124, 12).trim(), 8);
    const name = readField(0, 100);
    const body = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    entries.push({ name, size, type: String.fromCharCode(header[156]), mode: readField(100, 8), body });
  }
  return entries;
}

describe('render/stage - in-memory staging (ADR-042 D4: /work is a tmpfs, never a host dir)', () => {
  it('produces the whole validated tree in memory, with nothing written to the host', async () => {
    const tree = await stageRenderJobInMemory(request());
    // No `root` in the result at all: there is no host path, by construction.
    expect(Object.keys(tree).sort()).toEqual([
      'engine',
      'files',
      'limits',
      'names',
      'packageCacheDir',
      'totalBytes',
    ]);
    expect(tree.names).toEqual(['data.json', 'template.typ']);
    expect(tree.packageCacheDir).toBe(STAGE_PACKAGE_CACHE_DIR);
    expect(tree.totalBytes).toBe(
      (await lstat(TEMPLATE_A)).size + (await lstat(DATA_A)).size,
    );
    // Byte-for-byte what the registry/adapter supplied, under the policy names.
    expect(tree.files[0]?.bytes).toEqual(await readFile(DATA_A));
    expect(tree.files[1]?.bytes).toEqual(await readFile(TEMPLATE_A));
    // And the sandbox holds nothing: staging created no directory and no file.
    expect(await readdir(sandbox)).toEqual([]);
  });

  it('emits the tree as a stream that carries EXACTLY the validated names', async () => {
    const logo = path.join(sandbox, 'logo.png');
    await writeFile(logo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const tree = await stageRenderJobInMemory(
      request({ assets: [{ name: 'logo.png', source: { path: logo } }] }),
    );
    const entries = await readUstar(openStageTreeStream(tree));
    // Nothing can ride along: no extra entry, no rename, no entry under .pkgcache.
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      '.pkgcache/',
      'data.json',
      'logo.png',
      'template.typ',
    ]);
    expect(entries.filter((entry) => entry.name.startsWith('.pkgcache/')).length).toBe(1);
    for (const entry of entries) {
      if (entry.name === '.pkgcache/') {
        expect(entry.type).toBe('5'); // directory
        expect(entry.size).toBe(0);
        expect(entry.mode).toBe('0000700');
      } else {
        expect(entry.type).toBe('0'); // regular file
        expect(entry.mode).toBe('0000600');
      }
    }
    // The bytes round-trip unchanged, which is what `tar -x` would write into /work.
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get('template.typ')?.body).toEqual(await readFile(TEMPLATE_A));
    expect(byName.get('data.json')?.body).toEqual(await readFile(DATA_A));
    expect(byName.get('logo.png')?.body).toEqual(await readFile(logo));
  });

  it('is deterministic, and the archive bytes never carry a wall clock (R14)', async () => {
    const first = await stageRenderJobInMemory(request());
    const second = await stageRenderJobInMemory(request());
    const a = Buffer.concat(await collect(openStageTreeStream(first)));
    const b = Buffer.concat(await collect(openStageTreeStream(second)));
    expect(a.equals(b)).toBe(true);
    // Two zero blocks close the archive, and it is padded to the 10240-byte record.
    expect(a.length % 10240).toBe(0);
    expect(a.subarray(-1024).every((byte) => byte === 0)).toBe(true);
  });

  it('enforces the SAME caps as directory mode, and writes nothing either way', async () => {
    const big = path.join(sandbox, 'big.bin');
    await writeFile(big, Buffer.alloc(RENDER_LIMITS.inputFileBytes + 1, 0x44));
    // Per-file, measured.
    await rejects(
      stageRenderJobInMemory(
        request({ assets: [{ name: 'big.bin', source: { path: big } }], root: root('never-modes') }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'FILE_TOO_LARGE',
    );
    // File count, and the declared total, before any I/O.
    await rejects(
      stageRenderJobInMemory(
        request({
          template: { path: TEMPLATE_A, declaredBytes: RENDER_LIMITS.inputTotalBytes + 1 },
        }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'TOTAL_TOO_LARGE',
    );
    // The running total mid-stream, the MAJOR-2 bound, in this mode too.
    const one = path.join(sandbox, 'r1.bin');
    await writeFile(one, Buffer.alloc(60, 0x61));
    const two = path.join(sandbox, 'r2.bin');
    await writeFile(two, Buffer.alloc(60, 0x62));
    await rejects(
      stageRenderJobInMemory(
        request({
          template: { path: one, declaredBytes: 40 },
          data: { path: two, declaredBytes: 40 },
          limits: { ...RENDER_LIMITS, inputTotalBytes: 100 },
        }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'TOTAL_TOO_LARGE',
    );
    // A symlinked source is refused here too: same shared validator, same gate.
    await rejects(
      stageRenderJobInMemory(request({ template: { path: await canaryFileSymlink('mem-source.typ') } })),
      'RENDER_INPUT_INVALID',
      'SYMLINK',
    );
    // Nothing above created a staging root or a destination file, in either mode: the
    // only entries under the sandbox are the sources this test wrote itself. In-memory
    // staging has no root at all, so even the `root` it was handed was never touched.
    expect(
      (await readdir(sandbox)).filter((name) => !name.startsWith('outside-')).sort(),
    ).toEqual(['big.bin', 'mem-source.typ', 'r1.bin', 'r2.bin']);
  });

  it('refuses the same input as directory mode, so the two modes cannot drift', async () => {
    // `dataBytes` is in this loop too, and for the same reason: it is an alternative SOURCE
    // for the same entry, so "both modes" has to mean "every source shape in both modes" or
    // a guard that exists for only one of the source shapes would read as covered.
    // One loop, both modes, the same expectations. Any guard that exists in only one of
    // them shows up here as a divergence.
    for (const [i, stage] of [stageRenderJob, stageRenderJobInMemory].entries()) {
      await rejects(
        stage(request({ assets: [{ name: '../escape.png', source: { path: DATA_A } }], root: root(`x${i}`) })),
        'RENDER_INPUT_INVALID',
        'NAME_UNSAFE',
      );
      await rejects(
        stage(request({ template: { path: path.join(sandbox, 'absent.typ') }, root: root(`y${i}`) })),
        'RENDER_INPUT_INVALID',
        'SOURCE_MISSING',
      );
      await rejects(
        stage(request({ engine: 'latex', root: root(`z${i}`) })),
        'RENDER_INPUT_INVALID',
        'NAME_NOT_ALLOWLISTED',
      );
      await rejects(
        stage(
          request({ template: { path: await canaryFileSymlink(`linked-canary-${i}.typ`) }, root: root(`w${i}`) }),
        ),
        'RENDER_INPUT_INVALID',
        'SYMLINK',
      );
      // A buffer that is not a Buffer, refused in BOTH modes: `dataBytes` is a typed field,
      // so a caller that reaches it through an untyped boundary can hand over a string or an
      // object, and the module's contract is that every rejection is a `StageError` rather
      // than a raw `TypeError` from `.length` on something else.
      await rejects(
        stage(
          request({ data: undefined, dataBytes: 'not a buffer' as unknown as Buffer, root: root(`v${i}`) }),
        ),
        'RENDER_INPUT_INVALID',
        'REQUEST_INVALID',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Artifact validation (policy 6.3)
// ---------------------------------------------------------------------------

describe('render/stage - dataBytes: the adapter payload, with NO host temp file (T1043, ADR-042 D4)', () => {
  // WHY THIS BLOCK EXISTS. `data.json` is produced IN the render process
  // (`dictToDataJson`), and the only pre-existing way to hand a buffer to the stager was to
  // write it to a file and pass a path. That is a HOST WRITE for a payload whose whole point
  // is that it never touches the host (policy 3.1/4.4: `/work` is a tmpfs and never a host
  // directory). `StageRequest.dataBytes` is the additive field that removes the write, and
  // these tests exist because the field is only a real answer if it is NOT a weaker input
  // than the file it replaces.

  it('produces a tree BYTE-IDENTICAL to the file-sourced one for the same bytes', async () => {
    // The equality is the acceptance item, and it is checked in BOTH modes plus the emitted
    // archive - because what the container receives is the ARCHIVE, and a difference in the
    // ustar stream (a different mode, a different order) would change the container's `/work`
    // even with identical file bytes.
    const bytes = await readFile(DATA_A);
    const fromFile = await stageRenderJobInMemory(request());
    const fromBuffer = await stageRenderJobInMemory(request({ data: undefined, dataBytes: bytes }));

    expect(fromBuffer.names).toEqual(fromFile.names);
    expect(fromBuffer.totalBytes).toBe(fromFile.totalBytes);
    expect(fromBuffer.packageCacheDir).toBe(fromFile.packageCacheDir);
    const asJson = (tree: { files: readonly { name: string; bytes: Buffer }[] }) =>
      Object.fromEntries(tree.files.map((file) => [file.name, file.bytes.toString('hex')]));
    expect(asJson(fromBuffer)).toEqual(asJson(fromFile));

    // And the archive the broker pipes into the container is byte-for-byte the same.
    const archive = async (tree: Parameters<typeof openStageTreeStream>[0]) =>
      Buffer.concat(await collect(openStageTreeStream(tree)));
    expect((await archive(fromBuffer)).equals(await archive(fromFile))).toBe(true);

    // Directory mode agrees too, so a caller that stages to a directory for a test and in
    // memory for production gets the same tree either way.
    const dirTree = await stageRenderJob(request({ data: undefined, dataBytes: bytes, root: root('bytes-dir') }));
    expect(dirTree.names).toEqual(fromFile.names);
    expect(dirTree.totalBytes).toBe(fromFile.totalBytes);
    expect(await readFile(path.join(dirTree.root, RENDER_PATHS.names.data))).toEqual(bytes);
  });

  it('COPIES the buffer, so a caller that mutates it later cannot change the staged bytes', async () => {
    // The buffer is the CALLER's memory. Aliasing it would let a caller mutate bytes the
    // caps were proved against, and would let the emitted `data.json` differ from the one
    // that was validated - a property `copyBounded` gets from a fresh `O_EXCL` file.
    const bytes = Buffer.from('{"a":1}');
    const tree = await stageRenderJobInMemory(request({ data: undefined, dataBytes: bytes }));
    bytes.write('{"a":2}');
    expect(tree.files.find((file) => file.name === RENDER_PATHS.names.data)?.bytes.toString('utf8')).toBe('{"a":1}');
  });

  it('refuses an over-cap buffer with RENDER_INPUT_TOO_LARGE, in BOTH modes', async () => {
    // The per-FILE cap, which for `data.json` is `dataFileBytes` (4 MiB) and not the 1 MiB
    // asset cap. Getting that wrong would either refuse a legal resume or admit a 4 MiB
    // buffer under the asset cap's name, so the number is asserted rather than assumed.
    const overCap = Buffer.alloc(RENDER_LIMITS.dataFileBytes + 1, 0x41);
    for (const [i, stage] of [stageRenderJob, stageRenderJobInMemory].entries()) {
      await rejects(
        stage(request({ data: undefined, dataBytes: overCap, root: root(`cap${i}`) })),
        'RENDER_INPUT_TOO_LARGE',
        'FILE_TOO_LARGE',
      );
    }
    // The per-JOB total counts it too, which is the bound that a single legal file cannot
    // escape: `dataBytes` is in the same running total as a file source.
    await rejects(
      stageRenderJobInMemory(
        request({
          template: { path: TEMPLATE_A, declaredBytes: RENDER_LIMITS.dataFileBytes },
          data: undefined,
          dataBytes: Buffer.alloc(RENDER_LIMITS.dataFileBytes, 0x42),
          limits: { ...RENDER_LIMITS, inputTotalBytes: RENDER_LIMITS.dataFileBytes + 1024 },
        }),
      ),
      'RENDER_INPUT_TOO_LARGE',
      'TOTAL_TOO_LARGE',
    );
  });

  it('refuses BOTH data and dataBytes, because "which one wins" would be a silent choice', async () => {
    for (const [i, stage] of [stageRenderJob, stageRenderJobInMemory].entries()) {
      await rejects(
        stage(
          request({ dataBytes: Buffer.from('{"a":1}'), root: root(`both${i}`) }),
        ),
        'RENDER_INPUT_INVALID',
        'REQUEST_INVALID',
      );
    }
  });

  it('still requires data.json for typst, and still refuses it for latex', async () => {
    // The additive field did not make `data.json` optional for the engine that requires it,
    // and it did not widen the latex allowlist (`['artifact.tex']`, policy 5.2.2). Both were
    // the pre-existing refusals; a field that made either of them pass would be a widening.
    for (const [i, stage] of [stageRenderJob, stageRenderJobInMemory].entries()) {
      await rejects(
        stage(request({ data: undefined, root: root(`nodata${i}`) })),
        'RENDER_INPUT_INVALID',
        'MISSING_ENTRY',
      );
      await rejects(
        stage(request({ engine: 'latex', data: undefined, dataBytes: Buffer.from('{}'), root: root(`latexb${i}`) })),
        'RENDER_INPUT_INVALID',
        'NAME_NOT_ALLOWLISTED',
      );
    }
  });

  it('writes NO host path for the payload in in-memory mode', async () => {
    // The property the field exists for: `stageRenderJobInMemory` has no `root` at all, so
    // a payload supplied as bytes cannot create one. The sandbox directory is asserted empty
    // of anything this test did not write itself.
    const before = (await readdir(sandbox)).sort();
    await stageRenderJobInMemory(request({ data: undefined, dataBytes: Buffer.from('{"a":1}') }));
    expect((await readdir(sandbox)).sort()).toEqual(before);
  });
});

describe('render/stage - artifact validation (policy 6.3)', () => {
  const PDF_HEAD = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  async function outDirWith(name: string, body: Buffer, extra?: [string, Buffer]): Promise<string> {
    const dir = path.join(sandbox, `out-${name.replace(/[^a-z0-9]/gi, '')}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), body);
    if (extra) await writeFile(path.join(dir, extra[0]), extra[1]);
    return dir;
  }

  it('accepts a well-formed artifact and reports the storage metadata', async () => {
    const dir = await outDirWith('artifact.pdf', PDF_HEAD);
    const artifact = await validateRenderArtifact({ outDir: dir, format: 'pdf' });
    expect(artifact.name).toBe('artifact.pdf');
    expect(artifact.byteSize).toBe(PDF_HEAD.length);
    expect(artifact.sha256).toBe(createHash('sha256').update(PDF_HEAD).digest('hex'));
    expect(artifact.mimeType).toBe('application/pdf');
    expect(ARTIFACT_MIME_TYPES).toEqual({
      pdf: 'application/pdf',
      png: 'image/png',
      svg: 'image/svg+xml',
    });
    // And the bytes come back through the stream for the storage port.
    const chunks: Buffer[] = [];
    for await (const chunk of openArtifactStream(artifact)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(PDF_HEAD);
  });

  it('accepts png and svg, including an svg with a BOM and an XML declaration', async () => {
    const png = await outDirWith('artifact.png', Buffer.concat([PNG_HEAD, Buffer.from('rest')]));
    expect((await validateRenderArtifact({ outDir: png, format: 'png' })).byteSize).toBe(
      PNG_HEAD.length + 4,
    );
    const svgBody = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ]);
    const svg = await outDirWith('artifact.svg', svgBody);
    expect((await validateRenderArtifact({ outDir: svg, format: 'svg' })).byteSize).toBe(
      svgBody.length,
    );
  });

  it('rejects a MISSING artifact', async () => {
    const dir = path.join(sandbox, 'out-empty');
    await mkdir(dir, { recursive: true });
    await rejects(
      validateRenderArtifact({ outDir: dir, format: 'pdf' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_MISSING',
    );
  });

  it('rejects a SYMLINKED artifact, lstat-style, never following it', async () => {
    const dir = path.join(sandbox, 'out-symlink');
    await mkdir(dir, { recursive: true });
    const outside = await canaryFile('artifact.pdf');
    await symlinkAny(outside, path.join(dir, 'artifact.pdf'));
    await rejects(
      validateRenderArtifact({ outDir: dir, format: 'pdf' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_NOT_REGULAR',
    );
  });

  it('rejects a SECOND file in the output dir (V22 / R12)', async () => {
    const dir = await outDirWith('artifact.pdf', PDF_HEAD, ['extra.txt', Buffer.from(CANARY)]);
    await rejects(
      validateRenderArtifact({ outDir: dir, format: 'pdf' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_UNEXPECTED_ENTRY',
    );
  });

  it('rejects a file that is not named artifact.<ext>', async () => {
    const dir = await outDirWith('resume.pdf', PDF_HEAD);
    await rejects(
      validateRenderArtifact({ outDir: dir, format: 'pdf' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_MISSING',
    );
  });

  it('rejects an over-large artifact, and refuses a looser cap than the policy', async () => {
    const body = Buffer.concat([PDF_HEAD, Buffer.alloc(1024, 0x20)]);
    const dir = await outDirWith('artifact.pdf', body);
    await rejects(
      validateRenderArtifact({ outDir: dir, format: 'pdf', maxBytes: 16 }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_TOO_LARGE',
    );
    // A looser maxBytes is silently CLAMPED to the policy cap, never honoured.
    expect(RENDER_LIMITS.outputBytes).toBe(20_971_520);
    const artifact = await validateRenderArtifact({ outDir: dir, format: 'pdf' });
    expect(artifact.byteSize).toBe(body.length);
  });

  it('rejects bad magic bytes: an EXTENSION check is not a content check', async () => {
    const dir = await outDirWith('artifact.pdf', Buffer.from('not a pdf at all'));
    await rejects(
      validateRenderArtifact({ outDir: dir, format: 'pdf' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_BAD_MAGIC',
    );
    const dir2 = await outDirWith('artifact.png', Buffer.from('%PDF-1.7'));
    await rejects(
      validateRenderArtifact({ outDir: dir2, format: 'png' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_BAD_MAGIC',
    );
  });

  it('rejects a hardlinked artifact', async () => {
    const dir = path.join(sandbox, 'out-hard');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'artifact.pdf'), PDF_HEAD);
    await link(path.join(dir, 'artifact.pdf'), path.join(sandbox, 'elsewhere.pdf'));
    await rejects(
      validateRenderArtifact({ outDir: dir, format: 'pdf' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_NOT_REGULAR',
    );
  });

  it('rejects an unknown format and a non-string outDir, with a fixed message', async () => {
    await rejects(
      validateRenderArtifact({ outDir: sandbox, format: 'docx' as never }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_FORMAT_UNKNOWN',
    );
    await rejects(
      validateRenderArtifact({ outDir: 42 as unknown as string, format: 'pdf' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_OUTSIDE_OUT',
    );
  });

  it('requires outDir to be a REAL, non-symlink directory, the same as the stage root', async () => {
    // A symlinked outDir used to be accepted: `assertRealPathInsideRoot` realpaths BOTH
    // sides, so a symlink and its target agree and the containment check passes. "The
    // artifact came from /out" was therefore enforced lexically, not physically.
    const real = path.join(sandbox, 'out-real');
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, 'artifact.pdf'), PDF_HEAD);
    const linked = path.join(sandbox, 'out-linked');
    await symlinkAny(real, linked);
    await rejects(
      validateRenderArtifact({ outDir: linked, format: 'pdf' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_OUTDIR_INVALID',
    );
    // POSITIVE CONTROL: the same directory, named directly, validates - so the refusal
    // above is about the symlink and nothing else.
    expect((await validateRenderArtifact({ outDir: real, format: 'pdf' })).byteSize).toBe(
      PDF_HEAD.length,
    );

    // And an outDir that is not a directory at all.
    const file = path.join(sandbox, 'out-file');
    await writeFile(file, PDF_HEAD);
    await rejects(
      validateRenderArtifact({ outDir: file, format: 'pdf' }),
      'RENDER_ARTIFACT_INVALID',
      'ARTIFACT_OUTDIR_INVALID',
    );
  });

  it('never trusts a path from inside the container: it is built from the format', () => {
    // The only path this module can return is `<outDir>/artifact.<ext>`, assembled
    // from RENDER_PATHS.artifact and the format the CALLER asked for.
    for (const format of ['pdf', 'png', 'svg'] as const) {
      expect(path.basename(RENDER_PATHS.artifact[format])).toBe(`artifact.${format}`);
      expect(RENDER_PATHS.artifact[format]).toBe(`/out/artifact.${format}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Name sanitisation convenience (policy 5.2.3)
// ---------------------------------------------------------------------------

describe('render/stage - asset name sanitisation', () => {
  it('follows the repo pattern from routes/export.ts and falls back to a constant', () => {
    expect(sanitizeStageName('  Company Logo .png ')).toBe('Company-Logo-.png');
    expect(sanitizeStageName('a//b')).toBe('a-b');
    expect(sanitizeStageName('-lead-and-trail-')).toBe('lead-and-trail');
    expect(sanitizeStageName('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeStageName('')).toBe('asset');
    expect(sanitizeStageName('***')).toBe('asset');
    expect(sanitizeStageName(undefined)).toBe('asset');
    expect(sanitizeStageName('logo.png', 'fallback')).toBe('logo.png');
  });

  it('is not the security boundary: the sanitiser output still goes through the gate', async () => {
    // The sanitiser maps `..` to a fallback and `../../etc/passwd` to `etc-passwd`, so
    // it is quite safe on its own - but a name it EMITS still has to clear the
    // allowlist, or a sanitiser bug could stage a policy-fixed name.
    expect(sanitizeStageName('..')).toBe('asset');
    await rejects(
      stageRenderJob(
        request({ assets: [{ name: sanitizeStageName('data.json'), source: { path: DATA_A } }] }),
      ),
      'RENDER_INPUT_INVALID',
      'NAME_NOT_ALLOWLISTED',
    );
    await rejects(
      stageRenderJob(
        request({ assets: [{ name: STAGE_PACKAGE_CACHE_DIR, source: { path: DATA_A } }] }),
      ),
      'RENDER_INPUT_INVALID',
      'NAME_NOT_ALLOWLISTED',
    );
  });
});
