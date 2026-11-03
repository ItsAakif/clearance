// Vendored-asset lockfile reader - unit tests.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md 7.1-7.3
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 4
// Task:         T1040
//
// NOTHING HERE NEEDS A DOCKER DAEMON. The parsing half is pure; the one I/O helper is
// tested against the REAL backend/typst/packages.lock, because a lockfile reader that is
// only ever tested against a fixture of its own author proves nothing about the file the
// gate actually reads.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LOCKFILE_ENGINE_KEYS,
  LOCKFILE_ERROR_CODES,
  LOCKFILE_FONT_KEYS,
  LOCKFILE_PACKAGE_KEYS,
  LOCKFILE_REJECTION_REASONS,
  LockfileError,
  lockfileLicences,
  parseLockfile,
  parseLockfileRecords,
  readLockfile,
  summariseLockfile,
  vendoredFontLicence,
  vendoredFontSha256,
  vendoredPackageLicence,
} from './lockfile.js';
import { TYPST_PIN } from './sandbox.js';

// __dirname is available both compiled to CJS and under vitest (repo convention:
// see src/ats/promptLoader.ts:8).
const HERE = __dirname;
const SRC = path.resolve(HERE, '..');
const TYPST_ROOT = path.resolve(SRC, '..', 'typst');
const REAL_LOCKFILE = path.join(TYPST_ROOT, 'packages.lock');
const REAL_LICENCES = path.join(TYPST_ROOT, 'LICENSES.md');

/** A minimal, well-formed lockfile text, in the same grammar as the real one. */
const GOOD_LOCKFILE = [
  '// a comment line',
  'engine.typst.version       = 0.15.1',
  'engine.typst.asset         = typst-x86_64-unknown-linux-musl.tar.xz',
  'engine.typst.asset.sha256  = aaaa',
  'engine.typst.binary.sha256 = bbbb',
  'engine.typst.license       = Apache-2.0',
  'font.license              = OFL-1.1',
  'font.faces.0.file         = Regular.ttf',
  'font.faces.0.sha256       = cccc',
  'font.faces.1.file         = Bold.ttf',
  'font.faces.1.sha256       = dddd',
  'thirdPartyPackages.count = 1',
  'packages.count = 1',
  'packages.0.spec          = @preview/example:1.0.0',
  'packages.0.name          = example',
  'packages.0.license       = MIT',
].join('\n');

function reasonOf(run: () => unknown): { code: string; reason: string } {
  try {
    run();
  } catch (err) {
    if (err instanceof LockfileError) return { code: err.code, reason: err.reason };
    throw err;
  }
  throw new Error('expected a LockfileError');
}

describe('the REAL backend/typst/packages.lock', () => {
  it('parses, and pins fonts=3 and thirdPartyPackages=0', async () => {
    const lock = await readLockfile(REAL_LOCKFILE);
    // The two numbers the task pins. A vendored font added without a licence, or a
    // Universe package added without a review, changes these two numbers.
    expect(lock.fonts).toHaveLength(3);
    expect(lock.thirdPartyPackages).toBe(0);
    expect(lock.engine.version).toBe(TYPST_PIN.version);
  });

  it('records the engine pin that sandbox.ts carries, so the two copies cannot drift', async () => {
    const lock = await readLockfile(REAL_LOCKFILE);
    expect(lock.engine.version).toBe('0.15.1');
    expect(lock.engine.version).toBe(TYPST_PIN.version);
    expect(lock.engine.sha256).toBe(TYPST_PIN.sha256);
    expect(lock.engine.license).toBe(TYPST_PIN.license);
  });

  it('records exactly the three vendored Source Serif 4 faces, in file order', async () => {
    const lock = await readLockfile(REAL_LOCKFILE);
    expect(lock.fonts.map((font) => font.file)).toEqual([
      'SourceSerif4-Regular.ttf',
      'SourceSerif4-Semibold.ttf',
      'SourceSerif4-Bold.ttf',
    ]);
    for (const font of lock.fonts) {
      expect(font.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(font.licence).toBe('OFL-1.1');
    }
  });

  it('records the one first-party vendored package and no third-party one', async () => {
    const lock = await readLockfile(REAL_LOCKFILE);
    expect(lock.packages).toHaveLength(1);
    expect(lock.packages[0]?.spec).toBe('@clearance/spike-probe:1.0.0');
    expect(lock.packages[0]?.licence).toBe('Apache-2.0');
    // The first-party spike-probe package is in the vendored TREE, which is not the same
    // statement as "a Universe package is vendored". If a package is ever added, this
    // assertion is the one that must be revisited in the same change.
    expect(lock.thirdPartyPackages).toBe(0);
  });

  it('every licence the lockfile records also appears in LICENSES.md', async () => {
    const lock = await readLockfile(REAL_LOCKFILE);
    const licences = await readFile(REAL_LICENCES, 'utf8');
    const recorded = lockfileLicences(lock);
    expect(recorded.length).toBeGreaterThan(0);
    // A cheap `includes`, not markdown parsing: the point is that a licence recorded in
    // the machine-readable file is not absent from the human manifest.
    for (const licence of recorded) {
      expect(licences).toContain(licence);
    }
    // And the engine's own licence, which is recorded in the lockfile too.
    expect(licences).toContain(lock.engine.license);
  });

  it('exposes the vendored lookups the licence gate uses, by file and by spec', async () => {
    const lock = await readLockfile(REAL_LOCKFILE);
    expect(vendoredFontSha256(lock, 'SourceSerif4-Bold.ttf')).toMatch(/^[0-9a-f]{64}$/);
    expect(vendoredFontLicence(lock, 'SourceSerif4-Regular.ttf')).toBe('OFL-1.1');
    expect(vendoredPackageLicence(lock, '@clearance/spike-probe:1.0.0')).toBe('Apache-2.0');
    // An absent one is `undefined`, not a throw and not a guess: the gate's question is
    // "is this recorded", and an unrecorded thing has no licence.
    expect(vendoredFontLicence(lock, 'NotVendored.ttf')).toBeUndefined();
    expect(vendoredPackageLicence(lock, '@preview/absent:9.9.9')).toBeUndefined();
  });
});

describe('the grammar', () => {
  it('parses a well-formed file into the gate summary', () => {
    const lock = parseLockfile(GOOD_LOCKFILE);
    expect(lock.engine).toEqual({
      version: '0.15.1',
      sha256: 'aaaa',
      license: 'Apache-2.0',
      binarySha256: 'bbbb',
    });
    expect(lock.fonts).toHaveLength(2);
    expect(lock.packages).toEqual([{ spec: '@preview/example:1.0.0', licence: 'MIT' }]);
    expect(lock.thirdPartyPackages).toBe(1);
  });

  it('accepts the British `licence` spelling for a package record as well as `license`', () => {
    const lock = parseLockfile(GOOD_LOCKFILE.replace('packages.0.license', 'packages.0.licence'));
    expect(lock.packages[0]?.licence).toBe('MIT');
  });

  it('keeps a URL value whole, because only FULL-LINE comments are stripped', () => {
    // A trailing-`//` strip would truncate this value at the first `//` and silently
    // record `https:` as a provenance URL.
    const lock = parseLockfile(`${GOOD_LOCKFILE}\nfont.upstream.tag = https://example.org/a/b\n`);
    expect(lock.fonts).toHaveLength(2);
    expect(parseLockfileRecords(`${GOOD_LOCKFILE}\nfont.upstream.tag = https://example.org/a/b`).get('font.upstream.tag')).toBe(
      'https://example.org/a/b',
    );
  });

  it('rejects a line that is neither a comment nor a key/value record', () => {
    expect(reasonOf(() => parseLockfile(`${GOOD_LOCKFILE}\nthis is prose`))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_SYNTAX',
    });
  });

  it('rejects a duplicate key, so a file cannot mean two things', () => {
    expect(reasonOf(() => parseLockfile(`${GOOD_LOCKFILE}\nengine.typst.version = 0.16.0`))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_DUPLICATE_KEY',
    });
  });

  it('rejects an EMPTY value, because a blank licence is the failure this gate exists for', () => {
    expect(reasonOf(() => parseLockfile(GOOD_LOCKFILE.replace('font.license              = OFL-1.1', 'font.license              =')))).toEqual(
      { code: 'RENDER_LOCKFILE_INVALID', reason: 'LOCKFILE_VALUE_EMPTY' },
    );
  });

  it('rejects a missing engine key rather than defaulting it', () => {
    const without = GOOD_LOCKFILE.replace('engine.typst.license       = Apache-2.0', '');
    expect(reasonOf(() => parseLockfile(without))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_KEY_MISSING',
    });
  });

  it('rejects a font face recorded without its digest: a face with no digest is unverified', () => {
    const headless = GOOD_LOCKFILE.replace('font.faces.1.sha256       = dddd', '');
    expect(reasonOf(() => parseLockfile(headless))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_FACE_INCOMPLETE',
    });
  });

  it('rejects a lockfile with no vendored face at all', () => {
    const noFonts = [
      'engine.typst.version       = 0.15.1',
      'engine.typst.asset.sha256  = aaaa',
      'engine.typst.binary.sha256 = bbbb',
      'engine.typst.license       = Apache-2.0',
      'font.license              = OFL-1.1',
    ].join('\n');
    expect(reasonOf(() => parseLockfile(noFonts))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_KEY_MISSING',
    });
  });

  it('rejects a package record with a spec and no licence', () => {
    const noLicence = GOOD_LOCKFILE.replace('packages.0.license       = MIT', '');
    expect(reasonOf(() => parseLockfile(noLicence))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_PACKAGE_INCOMPLETE',
    });
  });

  it('rejects a declared package count that does not match the number of records', () => {
    const lying = GOOD_LOCKFILE.replace('packages.count = 1', 'packages.count = 3');
    expect(reasonOf(() => parseLockfile(lying))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_PACKAGE_COUNT_MISMATCH',
    });
  });

  it('tolerates a non-integer count only as a rejection, never as a default', () => {
    const bad = GOOD_LOCKFILE.replace('thirdPartyPackages.count = 1', 'thirdPartyPackages.count = many');
    expect(reasonOf(() => parseLockfile(bad))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_SYNTAX',
    });
  });

  it('ignores a numbered package record member the gate does not read', () => {
    const withProse = GOOD_LOCKFILE.replace('packages.0.license       = MIT', 'packages.0.license       = MIT\npackages.0.upstream      = first-party: somewhere');
    expect(parseLockfile(withProse).packages).toHaveLength(1);
  });

  it('refuses a summary of something that is not a records map', () => {
    expect(reasonOf(() => summariseLockfile(null as never))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_UNREADABLE',
    });
    expect(reasonOf(() => parseLockfile(42 as never))).toEqual({
      code: 'RENDER_LOCKFILE_INVALID',
      reason: 'LOCKFILE_UNREADABLE',
    });
  });

  it('an unreadable file is RENDER_LOCKFILE_MISSING, so no host path escapes the message', async () => {
    let caught: LockfileError | null = null;
    try {
      await readLockfile(path.join(TYPST_ROOT, 'no-such-lockfile-9c1d.txt'));
    } catch (err) {
      caught = err as LockfileError;
    }
    expect(caught).toBeInstanceOf(LockfileError);
    expect(caught?.code).toBe('RENDER_LOCKFILE_MISSING');
    expect(caught?.reason).toBe('LOCKFILE_UNREADABLE');
    expect(caught?.message).toBe('RENDER_LOCKFILE_MISSING: the lockfile could not be read');
    expect(caught?.message).not.toContain('no-such-lockfile');
    expect(caught?.message).not.toContain('typst');
  });
});

describe('the vocabularies are closed and every reason has a fixed message', () => {
  it('names the exact keys the gate reads, and the code set is closed', () => {
    expect(LOCKFILE_ENGINE_KEYS).toEqual({
      version: 'engine.typst.version',
      assetSha256: 'engine.typst.asset.sha256',
      binarySha256: 'engine.typst.binary.sha256',
      license: 'engine.typst.license',
    });
    expect(LOCKFILE_FONT_KEYS.license).toBe('font.license');
    expect(LOCKFILE_FONT_KEYS.faceFilePrefix).toBe('font.faces.');
    expect(LOCKFILE_PACKAGE_KEYS.thirdPartyCount).toBe('thirdPartyPackages.count');
    expect(LOCKFILE_ERROR_CODES).toEqual(['RENDER_LOCKFILE_MISSING', 'RENDER_LOCKFILE_INVALID']);
  });

  it('every reason is a distinct fixed message with no caller data in it', () => {
    const texts = new Set<string>();
    for (const reason of LOCKFILE_REJECTION_REASONS) {
      const err = new LockfileError('RENDER_LOCKFILE_INVALID', reason);
      expect(err.reason).toBe(reason);
      expect(err.name).toBe('LockfileError');
      expect(err.message.startsWith('RENDER_LOCKFILE_INVALID: ')).toBe(true);
      texts.add(err.message);
      // No path, no key, no file content, no canary.
      expect(err.message).not.toContain('C:\\');
      expect(err.message).not.toContain('typst/');
    }
    expect(texts.size).toBe(LOCKFILE_REJECTION_REASONS.length);
  });
});
