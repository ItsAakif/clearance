// Vendored-asset lockfile reader - the machine-readable half of the licence gate.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md sections 7.1-7.3
//                 (a package with no recorded licence cannot be vendored; a template
//                 that declares a package absent from packages.lock cannot render)
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 4
//                 (lockfile.ts: parse backend/typst/packages.lock into
//                  {engine:{version,sha256,license}, fonts:[{file,sha256,licence}],
//                   packages:[{spec,licence}]})
// Task:         T1040
//
// WHAT THIS MODULE IS. `backend/typst/packages.lock` declares ITSELF machine-readable
// (its own header says so) and is a flat, line-oriented record: `key = value`, with
// `//` comment lines. There is no tool to parse it, so the "parse" is deliberately
// trivial and deliberately STRICT:
//
//   - only full-line `//` comments are skipped. Trailing comments are NOT stripped,
//     because a value in that file is a URL (`font.upstream.tag =
//     https://github.com/...`) and stripping at the first `//` would corrupt it. The
//     file is a record, not prose, so full-line comments carry all the commentary;
//   - a key is `[A-Za-z0-9_.$@-]+`, the separator is `=` with optional spaces, and an
//     EMPTY value is a rejection rather than a default: a licence recorded as blank is
//     exactly the failure this gate exists to catch;
//   - a DUPLICATE key is a rejection, so a file cannot mean two things;
//   - a line that is neither a comment nor `key = value` is a rejection. Silent
//     skipping is how a licence key stops being required one release from now.
//
// WHY THE SUMMARY IS A SEPARATE TYPE. `parseLockfile()` returns only what the gate
// needs - the engine pin, the vendored faces, the vendored specs, and the count of
// third-party packages - and the raw `key = value` map stays available through
// `parseLockfileRecords()` so the TEMPLATE registry can read a template's OWN
// `packages.lock` (`template.id` / `template.version`) without this module knowing
// anything about templates. One parser, two callers, one grammar.
//
// FAILURE IS A CLOSED CODE + REASON WITH FIXED TEXT, the same rule `stage.ts` and
// `storage.ts` follow (policy 9.3/9.4): no host path, no key name and no file content
// is ever interpolated into the message. The caller logs `code` + `reason`; the user
// sees a generic failure.
//
// PURE-ISH, AND WHY: the parsing half (`parseLockfile`, `parseLockfileRecords`) touches
// no filesystem and no clock, so the whole grammar is unit-testable without a daemon.
// `readLockfile()` is the only function that does I/O, and it does exactly one read.

import { readFile } from 'node:fs/promises';

/** The keys every lockfile must carry for the engine pin to be provable. */
export const LOCKFILE_ENGINE_KEYS = Object.freeze({
  version: 'engine.typst.version',
  assetSha256: 'engine.typst.asset.sha256',
  binarySha256: 'engine.typst.binary.sha256',
  license: 'engine.typst.license',
} as const);

/** The keys every lockfile must carry for the vendored font set to be provable. */
export const LOCKFILE_FONT_KEYS = Object.freeze({
  license: 'font.license',
  faceFilePrefix: 'font.faces.',
  faceFileSuffix: '.file',
  faceSha256Suffix: '.sha256',
} as const);

/** The keys that carry the third-party package count and the vendored package set. */
export const LOCKFILE_PACKAGE_KEYS = Object.freeze({
  thirdPartyCount: 'thirdPartyPackages.count',
  count: 'packages.count',
  specPrefix: 'packages.',
  specSuffix: '.spec',
  licenseSuffix: '.license',
} as const);

// ---------------------------------------------------------------------------
// The rejection vocabulary
// ---------------------------------------------------------------------------

/** The closed set of codes a lockfile read may carry. */
export const LOCKFILE_ERROR_CODES = Object.freeze([
  'RENDER_LOCKFILE_MISSING',
  'RENDER_LOCKFILE_INVALID',
] as const);

export type LockfileErrorCode = (typeof LOCKFILE_ERROR_CODES)[number];

/** The closed set of reasons. Machine-readable, log-safe, never user-facing. */
export const LOCKFILE_REJECTION_REASONS = Object.freeze([
  'LOCKFILE_UNREADABLE',
  'LOCKFILE_SYNTAX',
  'LOCKFILE_DUPLICATE_KEY',
  'LOCKFILE_KEY_MISSING',
  'LOCKFILE_VALUE_EMPTY',
  'LOCKFILE_FACE_INCOMPLETE',
  'LOCKFILE_PACKAGE_INCOMPLETE',
  'LOCKFILE_PACKAGE_COUNT_MISMATCH',
] as const);

export type LockfileRejectionReason = (typeof LOCKFILE_REJECTION_REASONS)[number];

/**
 * Fixed text per reason. A lookup table, not a template, so a host path, a key name or
 * a file's content cannot reach a message (policy 9.3/9.4).
 */
const REASON_TEXT: Readonly<Record<LockfileRejectionReason, string>> = Object.freeze({
  LOCKFILE_UNREADABLE: 'the lockfile could not be read',
  LOCKFILE_SYNTAX: 'the lockfile has a line that is neither a comment nor a key/value record',
  LOCKFILE_DUPLICATE_KEY: 'the lockfile declares the same key twice',
  LOCKFILE_KEY_MISSING: 'the lockfile is missing a key the licence gate requires',
  LOCKFILE_VALUE_EMPTY: 'the lockfile records an empty value where a pin is required',
  LOCKFILE_FACE_INCOMPLETE: 'the lockfile records a vendored font face without its digest',
  LOCKFILE_PACKAGE_INCOMPLETE: 'the lockfile records a package without a spec or a licence',
  LOCKFILE_PACKAGE_COUNT_MISMATCH: 'the lockfile package count does not match its package records',
});

/** A lockfile read rejection. Carries a machine code and reason, never a path. */
export class LockfileError extends Error {
  readonly code: LockfileErrorCode;
  readonly reason: LockfileRejectionReason;

  constructor(code: LockfileErrorCode, reason: LockfileRejectionReason) {
    super(`${code}: ${REASON_TEXT[reason]}`);
    this.name = 'LockfileError';
    this.code = code;
    this.reason = reason;
  }
}

function fail(code: LockfileErrorCode, reason: LockfileRejectionReason): never {
  throw new LockfileError(code, reason);
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

/** The pinned engine, as recorded in the lockfile. */
export interface LockfileEngine {
  readonly version: string;
  /** The release ARCHIVE digest, which is the pin `sandbox.ts` carries. */
  readonly sha256: string;
  readonly license: string;
  /** The digest of the unpacked binary, recorded separately by the same file. */
  readonly binarySha256: string;
}

/** One vendored font face: the file, its digest, and the licence it is vendored under. */
export interface LockfileFont {
  readonly file: string;
  readonly sha256: string;
  readonly licence: string;
}

/** One vendored Typst Universe package: the exact `@ns/name:ver` and its licence. */
export interface LockfilePackage {
  readonly spec: string;
  readonly licence: string;
}

/**
 * The whole gate's view of a lockfile. Frozen and ordered: fonts are in the file's own
 * face order (index 0, 1, 2 ...), packages in the file's own record order, so the
 * summary is a deterministic function of the bytes.
 */
export interface LockfileSummary {
  readonly engine: LockfileEngine;
  readonly fonts: readonly LockfileFont[];
  readonly packages: readonly LockfilePackage[];
  /** `thirdPartyPackages.count`: how many Universe packages the vendored set carries. */
  readonly thirdPartyPackages: number;
}

/** The parsed `key = value` map. The caller owns it; the module does not freeze it. */
export type LockfileRecords = ReadonlyMap<string, string>;

// ---------------------------------------------------------------------------
// The grammar
// ---------------------------------------------------------------------------

/**
 * Only full-line comments are skipped. See the module header: the file carries URL
 * values, so a trailing `//` strip would truncate one.
 */
const KEY_VALUE = /^[ \t]*([A-Za-z0-9_.$@-]+)[ \t]*=[ \t]*(.*?)[ \t]*$/;

/**
 * Parse a lockfile into its `key = value` records. NO I/O, NO clock, NO path.
 *
 * Throws `LockfileError` / `RENDER_LOCKFILE_INVALID` for a malformed line, a duplicate
 * key, or an empty value. The message never contains the key or the line.
 */
export function parseLockfileRecords(text: string): LockfileRecords {
  if (typeof text !== 'string') {
    fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_UNREADABLE');
  }
  const records = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('//')) continue;
    const match = KEY_VALUE.exec(line);
    if (match === null) fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_SYNTAX');
    const key = match[1] as string;
    const value = match[2] as string;
    if (value.length === 0) fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_VALUE_EMPTY');
    if (records.has(key)) fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_DUPLICATE_KEY');
    records.set(key, value);
  }
  return records;
}

/** One required value, with the "absent" and "blank" cases both rejected. */
function required(records: LockfileRecords, key: string): string {
  const value = records.get(key);
  if (value === undefined) fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_KEY_MISSING');
  return value;
}

/** An OPTIONAL value. Absent and blank are the same answer here, by construction. */
function optional(records: LockfileRecords, key: string): string | undefined {
  return records.get(key);
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(value)) fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_SYNTAX');
  return Number.parseInt(value, 10);
}

/**
 * The vendored faces, in the file's own index order.
 *
 * `font.faces.<n>.file` and `font.faces.<n>.sha256` are read as PAIRS: a face recorded
 * without its digest is a rejection, because a face with no digest is a font nobody
 * verified and this is the gate that would otherwise wave it through.
 */
function summariseFonts(
  records: LockfileRecords,
  requireFaces = true,
): readonly LockfileFont[] {
  const indices = new Set<number>();
  for (const key of records.keys()) {
    if (!key.startsWith(LOCKFILE_FONT_KEYS.faceFilePrefix)) continue;
    const rest = key.slice(LOCKFILE_FONT_KEYS.faceFilePrefix.length);
    const match = /^([0-9]+)\.(file|sha256)$/.exec(rest);
    if (match === null) fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_SYNTAX');
    indices.add(Number.parseInt(match[1] as string, 10));
  }
  if (indices.size === 0) {
    // Typst templates always declare a vendored face; a LA (TeX Live) template uses the
    // image's own fonts, so `requireFaces: false` is the only caller that may have none.
    if (requireFaces) fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_KEY_MISSING');
    return Object.freeze([]);
  }
  const licence = required(records, LOCKFILE_FONT_KEYS.license);
  const fonts: LockfileFont[] = [];
  for (const index of [...indices].sort((a, b) => a - b)) {
    const file = records.get(`${LOCKFILE_FONT_KEYS.faceFilePrefix}${index}.file`);
    const sha256 = records.get(`${LOCKFILE_FONT_KEYS.faceFilePrefix}${index}.sha256`);
    if (file === undefined || sha256 === undefined) {
      fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_FACE_INCOMPLETE');
    }
    fonts.push(Object.freeze({ file, sha256, licence }));
  }
  return Object.freeze(fonts);
}

/** The vendored package set, in the file's own record order. */
function summarisePackages(records: LockfileRecords): readonly LockfilePackage[] {
  const indices = new Set<number>();
  for (const key of records.keys()) {
    if (!key.startsWith(LOCKFILE_PACKAGE_KEYS.specPrefix)) continue;
    const rest = key.slice(LOCKFILE_PACKAGE_KEYS.specPrefix.length);
    // `packages.count` is the count OF the records below, and a numbered record may carry
    // descriptive members the gate does not read (`upstream`, `usedBy`, `spikeOnly`), so
    // only `spec` and `licen[cs]e` are load-bearing. Anything else numbered is ignored:
    // the file is a record with commentary, not a closed schema. A numbered record with a
    // spec but no licence, or a licence but no spec, is still a rejection below.
    const match = /^([0-9]+)\.(?:spec|licen[cs]e)$/.exec(rest);
    if (match === null) continue;
    indices.add(Number.parseInt(match[1] as string, 10));
  }
  const declaredCount = parseNonNegativeInteger(
    optional(records, LOCKFILE_PACKAGE_KEYS.count),
    indices.size,
  );
  if (declaredCount !== indices.size) {
    fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_PACKAGE_COUNT_MISMATCH');
  }
  const packages: LockfilePackage[] = [];
  for (const index of [...indices].sort((a, b) => a - b)) {
    const prefix = `${LOCKFILE_PACKAGE_KEYS.specPrefix}${index}.`;
    const spec = records.get(`${prefix}spec`);
    // `license` is the file's spelling; `licence` is accepted so a hand-edited record
    // that follows LICENSES.md's British spelling still parses rather than vanishing.
    const licence = records.get(`${prefix}license`) ?? records.get(`${prefix}licence`);
    if (spec === undefined || licence === undefined) {
      fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_PACKAGE_INCOMPLETE');
    }
    packages.push(Object.freeze({ spec, licence }));
  }
  return Object.freeze(packages);
}

/**
 * Summarise already-parsed records. The second half of `parseLockfile`, exposed so the
 * template registry can read a template's own lockfile records and then summarise them
 * with the SAME rules the shared lockfile is held to.
 */
export function summariseLockfile(records: LockfileRecords): LockfileSummary {
  if (records === null || typeof records !== 'object' || typeof records.get !== 'function') {
    fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_UNREADABLE');
  }
  const engine: LockfileEngine = Object.freeze({
    version: required(records, LOCKFILE_ENGINE_KEYS.version),
    sha256: required(records, LOCKFILE_ENGINE_KEYS.assetSha256),
    license: required(records, LOCKFILE_ENGINE_KEYS.license),
    binarySha256: required(records, LOCKFILE_ENGINE_KEYS.binarySha256),
  });
  const fonts = summariseFonts(records);
  const packages = summarisePackages(records);
  const thirdPartyPackages = parseNonNegativeInteger(
    optional(records, LOCKFILE_PACKAGE_KEYS.thirdPartyCount),
    packages.length,
  );
  return Object.freeze({
    engine,
    fonts,
    packages,
    thirdPartyPackages,
  });
}

/** Parse a lockfile's text into the gate's summary. NO I/O. */
export function parseLockfile(text: string): LockfileSummary {
  return summariseLockfile(parseLockfileRecords(text));
}

// ---------------------------------------------------------------------------
// LaTeX template lockfiles
// ---------------------------------------------------------------------------

/**
 * A LaTeX template's own lockfile summary.
 *
 * TeX Live is NOT vendored the way Typst Universe packages are: the toolchain is the
 * worker image, and the template declares no font faces (the exporter uses the image's
 * default Computer Modern). So the Typst summary's `engine.typst.*` and mandatory
 * `font.faces.*` shape does not apply. This summary keeps the same grammar and the same
 * package checks, and requires only the honest LaTeX pin:
 *
 *     engine.latex.version = 2022
 *     engine.latex.license = LPPL-1.3c
 *
 * The engine values are REQUIRED, so a LaTeX template cannot render without naming the
 * exact TeX Live release its source was reviewed against.
 */
export interface LatexLockfileSummary {
  readonly engine: {
    readonly version: string;
    readonly licence: string;
  };
  readonly fonts: readonly LockfileFont[];
  readonly packages: readonly LockfilePackage[];
  readonly thirdPartyPackages: number;
}

export const LATEX_LOCKFILE_ENGINE_KEYS = Object.freeze({
  version: 'engine.latex.version',
  license: 'engine.latex.license',
} as const);

export function summariseLatexLockfile(records: LockfileRecords): LatexLockfileSummary {
  if (records === null || typeof records !== 'object' || typeof records.get !== 'function') {
    fail('RENDER_LOCKFILE_INVALID', 'LOCKFILE_UNREADABLE');
  }
  const engine = Object.freeze({
    version: required(records, LATEX_LOCKFILE_ENGINE_KEYS.version),
    licence: required(records, LATEX_LOCKFILE_ENGINE_KEYS.license),
  });
  const fonts = summariseFonts(records, false);
  const packages = summarisePackages(records);
  const thirdPartyPackages = parseNonNegativeInteger(
    optional(records, LOCKFILE_PACKAGE_KEYS.thirdPartyCount),
    packages.length,
  );
  return Object.freeze({ engine, fonts, packages, thirdPartyPackages });
}

/** Parse a LaTeX template lockfile's text. NO I/O. */
export function parseLatexLockfile(text: string): LatexLockfileSummary {
  return summariseLatexLockfile(parseLockfileRecords(text));
}

/**
 * Read and summarise a lockfile. The ONLY function here that touches the filesystem,
 * and it performs exactly one bounded read of a file the caller names.
 *
 * An absent or unreadable file is `RENDER_LOCKFILE_MISSING`, never a raw fs error, so a
 * host path cannot escape through the message (policy 9.3/9.4).
 */
export async function readLockfile(filePath: string): Promise<LockfileSummary> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    fail('RENDER_LOCKFILE_MISSING', 'LOCKFILE_UNREADABLE');
  }
  return parseLockfile(text);
}

// ---------------------------------------------------------------------------
// Lookups the licence gate needs
// ---------------------------------------------------------------------------

/** The vendored digest for a face file, or `undefined` when the face is not vendored. */
export function vendoredFontSha256(lock: LockfileSummary, file: string): string | undefined {
  return lock.fonts.find((font) => font.file === file)?.sha256;
}

/** The recorded licence of a vendored face file, or `undefined` when not vendored. */
export function vendoredFontLicence(lock: LockfileSummary, file: string): string | undefined {
  return lock.fonts.find((font) => font.file === file)?.licence;
}

/** The recorded licence of a vendored `@ns/name:ver`, or `undefined` when not vendored. */
export function vendoredPackageLicence(lock: LockfileSummary, spec: string): string | undefined {
  return lock.packages.find((entry) => entry.spec === spec)?.licence;
}

/** Every distinct licence string the lockfile records. Used by the LICENSES.md gate. */
export function lockfileLicences(lock: LockfileSummary): readonly string[] {
  const seen = new Set<string>();
  for (const font of lock.fonts) seen.add(font.licence);
  for (const entry of lock.packages) seen.add(entry.licence);
  return Object.freeze([...seen].sort());
}
