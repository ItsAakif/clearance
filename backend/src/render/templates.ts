// Template registry - the review gate every template passes before it may render.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md 8.3 (the registry
//                 gate), 5.1 (the staged payload), 8.1/8.2 (permitted / denied), 8.6
//                 (no try/catch in a loop or a function)
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 4
//                 .planning/decisions/ADR-044-...md D4 (templates live at
//                   backend/typst/templates/<id>/; ResumeTemplate.version exists)
//                 .planning/decisions/ADR-044-...md D5 + sec. 13 ruling 2 (thumbnail null)
// Task:         T1040
//
// WHAT THIS MODULE IS. Policy 8.3: "a template is REVIEWED and LICENCE-RECORDED before it
// can render". This is that review, made executable and fail-closed. A template directory
// is loaded, validated, and either it is a `TemplateRecord` a render may use, or the load
// throws a `TemplateRejectionError` with a machine code and a machine reason. There is no
// "load with a warning" path, and no "render and see": a template either cleared the gate
// or it is not in the registry.
//
// THE GATES, in the order they run. The order is not cosmetic - the cheap structural
// failures are reported before the ones that need file contents:
//
//   1. ROOT       the templates directory exists
//   2. RESERVED   a directory may not take a reserved id (`none` is how a `.tex`/`.json`
//                 export row names "no template", so `none` must never become a real one)
//   3. ID         the directory name is a legal, lower-kebab template id
//   4. FILES      all four files exist and are REGULAR FILES, not symlinks: `template.typ`,
//                 `metadata.json`, `LICENSE`, `packages.lock` (policy 5.1 / plan sec. 4).
//                 Checked with `lstat` before anything is read, so a template cannot
//                 validate a file that lives somewhere else in the tree
//   5. SCHEMA     `metadata.json` parses and matches a STRICT schema. Strict, not
//                 lenient: an unknown key is a rejection, not a strip, because a silently
//                 stripped `atsProfile` is a template that renders with a capability
//                 nobody approved
//   6. IDENTITY   `metadata.id` is the directory name
//   7. PIN        `engineVersionPins.typst` is the pin in `sandbox.ts`, else
//                 `RENDER_TOOLCHAIN_MISMATCH` - never a silent degrade onto another
//                 engine (policy 8.3)
//   8. SECTIONS   `supportedSections` and `requiredDictKeys` are subsets of the dictionary
//                 vocabulary, and `requiredDictKeys` is a subset of `supportedSections`
//   9. LICENCE    `licence`, every `fonts[].licence` and every `packages[].licence` is
//                 non-empty, every declared font FILE is vendored, and every declared
//                 package SPEC is vendored. An unrecorded licence cannot render (policy
//                 7.3, 04 D.4)
//  10. AGREEMENT  the template's own `packages.lock` agrees with its `metadata.json` on
//                 id, version, engine pin, font set and licences, and with the shared
//                 lockfile on the font digests
//  11. IMPORTS    every `@ns/name:ver` literal in `template.typ` is DECLARED. Declared
//                 vs used, both directions, at registry load time (policy 7.3 / 8.1)
//  12. CAPABILITY `atsProfile` agrees with the template's own geometry, and no template
//                 claims an icon font when none is vendored (policy 8.2 B13)
//  13. SOURCE     the source uses no denied surface: no `eval`, no `read`, no `.wasm`, no
//                 URL, no `try`/`catch` (a parse error inside a loop or a function on the
//                 pinned engine - policy 8.6 - and pointless outside one), and no
//                 relative `import`/`include`, which would need a staged file this
//                 registry has no key to declare
//
// WHY THE FAILURE SURFACE IS A CLOSED SET. The same rule `sandbox.ts`, `stage.ts` and
// `storage.ts` follow (policy 9.3/9.4): every rejection is `{code, reason}` with a FIXED
// message per reason. No template id, no path, no file content and no metadata value is
// ever interpolated into a message, so a rejection can be logged, counted and asserted
// on without becoming a disclosure. `TemplateRejectionError.reason` is what a caller logs
// server-side; the user sees the generic message from policy 9.3.
//
// STATIC ASSETS, NO I/O BEYOND READING THEM. The registry reads four files per template
// plus the two shared records. It writes nothing, opens no socket, starts no container and
// talks to no database. `resolveTemplateForRender()` is PURE: it inspects an already
// loaded registry and returns a record, so the render path's decision is unit-testable
// without a daemon. A caller that wants the database's view of a template version passes
// it in (`templateVersion`) and a disagreement is a rejection, not a preference - that is
// what makes the determinism cache's `templateVersion` trustworthy (policy 10.4).

import { lstat, readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

import { RESUME_DICT_SECTIONS } from './dict.js';
import {
  LockfileError,
  parseLatexLockfile,
  parseLockfileRecords,
  summariseLatexLockfile,
  summariseLockfile,
  type LatexLockfileSummary,
  type LockfileRecords,
  type LockfileSummary,
} from './lockfile.js';
import { LATEX_PIN, RENDER_ENGINES, RENDER_FORMATS, TYPST_PIN, type RenderEngine } from './sandbox.js';

// ---------------------------------------------------------------------------
// The rejection vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed set of codes a template rejection may carry.
 *
 * - `RENDER_TEMPLATE_SCHEMA`              - the metadata or the template's own lockfile
 *                                            is structurally wrong. A host/repo fault,
 *                                            reported before any render.
 * - `RENDER_TOOLCHAIN_MISMATCH`           - `engineVersionPins` is not the pin in
 *                                            `sandbox.ts`. Reused from the policy 9.2
 *                                            outcome set rather than invented, because it
 *                                            is the same operator story.
 * - `RENDER_TEMPLATE_SECTION_UNKNOWN`     - a declared section is not in the dictionary
 *                                            vocabulary, or a caller asked for a section
 *                                            this template does not support. The registry
 *                                            never claims a section the canonical model
 *                                            cannot fill (`jsonresume.ts`, the
 *                                            `UNSUPPORTED_SECTIONS` table).
 * - `RENDER_TEMPLATE_LICENCE_MISSING`     - a licence is empty, or a declared font file
 *                                            is not vendored. An unrecorded licence
 *                                            cannot render.
 * - `RENDER_TEMPLATE_PACKAGE_UNRECORDED`  - a declared package spec is not in the shared
 *                                            lockfile, or its licence is empty.
 * - `RENDER_TEMPLATE_FILE_MISSING`        - the templates root, or one of the four
 *                                            required files, is absent, is not a regular
 *                                            file, or is a symlink to somewhere else.
 * - `RENDER_TEMPLATE_IMPORT_UNDECLARED`   - `template.typ` imports a package it does not
 *                                            declare.
 * - `RENDER_TEMPLATE_CAPABILITY_MISMATCH` - the request or the template's own declared
 *                                            capability is not what it claims: columns,
 *                                            format, an icon font, or a denied source
 *                                            surface.
 */
export const TEMPLATE_REJECTION_CODES = Object.freeze([
  'RENDER_TEMPLATE_SCHEMA',
  'RENDER_TOOLCHAIN_MISMATCH',
  'RENDER_TEMPLATE_SECTION_UNKNOWN',
  'RENDER_TEMPLATE_LICENCE_MISSING',
  'RENDER_TEMPLATE_PACKAGE_UNRECORDED',
  'RENDER_TEMPLATE_FILE_MISSING',
  'RENDER_TEMPLATE_IMPORT_UNDECLARED',
  'RENDER_TEMPLATE_CAPABILITY_MISMATCH',
] as const);

export type TemplateRejectionCode = (typeof TEMPLATE_REJECTION_CODES)[number];

/** The closed set of reasons. Machine-readable, log-safe, never user-facing. */
export const TEMPLATE_REJECTION_REASONS = Object.freeze([
  // structure
  'TEMPLATE_ROOT_MISSING',
  'TEMPLATE_FILE_MISSING',
  'TEMPLATE_LOCKFILE_INVALID',
  'TEMPLATE_LOCKFILE_MISMATCH',
  'METADATA_NOT_JSON',
  'METADATA_SCHEMA',
  // identity and version
  'TEMPLATE_ID_INVALID',
  'TEMPLATE_ID_RESERVED',
  'TEMPLATE_ID_MISMATCH',
  'TEMPLATE_ID_UNKNOWN',
  'TEMPLATE_VERSION_MISMATCH',
  // pins and pages
  'ENGINE_PIN_MISMATCH',
  'PAGE_SIZE_UNKNOWN',
  'COLUMNS_UNKNOWN',
  // sections
  'SECTION_UNKNOWN',
  'REQUIRED_KEY_NOT_SUPPORTED',
  'SECTION_NOT_SUPPORTED',
  // licences
  'TEMPLATE_LICENCE_MISSING',
  'FONT_LICENCE_MISSING',
  'FONT_NOT_VENDORED',
  'PACKAGE_LICENCE_MISSING',
  'PACKAGE_NOT_RECORDED',
  // imports
  'IMPORT_UNDECLARED',
  // capability
  'ATS_PROFILE_MISMATCH',
  'ICON_FONTS_NOT_VENDORED',
  'COLUMNS_NOT_SUPPORTED',
  'FORMAT_NOT_SUPPORTED',
  'REQUEST_INVALID',
  // denied source surface (policy 8.2, 8.6)
  'SOURCE_EVAL_FORBIDDEN',
  'SOURCE_FILE_READ_FORBIDDEN',
  'SOURCE_WASM_FORBIDDEN',
  'SOURCE_NETWORK_FORBIDDEN',
  'SOURCE_TRY_FORBIDDEN',
  'SOURCE_RELATIVE_IMPORT_FORBIDDEN',
] as const);

export type TemplateRejectionReason = (typeof TEMPLATE_REJECTION_REASONS)[number];

/**
 * Fixed text per reason. A lookup table, not a template, so it is structurally impossible
 * to interpolate a template id, a host path, a metadata value or staged content into a
 * message (policy 9.3/9.4).
 */
const REASON_TEXT: Readonly<Record<TemplateRejectionReason, string>> = Object.freeze({
  TEMPLATE_ROOT_MISSING: 'the templates root is not a directory',
  TEMPLATE_FILE_MISSING: 'a required template file is missing',
  TEMPLATE_LOCKFILE_INVALID: 'the template lockfile could not be read',
  TEMPLATE_LOCKFILE_MISMATCH: 'the template lockfile disagrees with the template metadata',
  METADATA_NOT_JSON: 'the template metadata is not a JSON document',
  METADATA_SCHEMA: 'the template metadata does not match the template schema',
  TEMPLATE_ID_INVALID: 'a template directory name is not a legal template id',
  TEMPLATE_ID_RESERVED: 'a template directory uses a reserved template id',
  TEMPLATE_ID_MISMATCH: 'the template metadata id is not the template directory id',
  TEMPLATE_ID_UNKNOWN: 'no template is registered under the requested id',
  TEMPLATE_VERSION_MISMATCH: 'the template version does not agree with the recorded version',
  ENGINE_PIN_MISMATCH: 'the template engine pin is not the pinned toolchain',
  PAGE_SIZE_UNKNOWN: 'the template page size is not a known page size',
  COLUMNS_UNKNOWN: 'the template column count is not a supported column count',
  SECTION_UNKNOWN: 'a declared section is not in the render dictionary vocabulary',
  REQUIRED_KEY_NOT_SUPPORTED: 'a required dictionary key is not a supported section',
  SECTION_NOT_SUPPORTED: 'a requested section is not supported by the template',
  TEMPLATE_LICENCE_MISSING: 'the template records no licence',
  FONT_LICENCE_MISSING: 'a declared font carries no licence',
  FONT_NOT_VENDORED: 'a declared font file is not vendored',
  PACKAGE_LICENCE_MISSING: 'a declared package carries no licence',
  PACKAGE_NOT_RECORDED: 'a declared package is not in the vendored package lock',
  IMPORT_UNDECLARED: 'the template imports a package it does not declare',
  ATS_PROFILE_MISMATCH: 'the declared ATS profile does not match the template layout',
  ICON_FONTS_NOT_VENDORED: 'the template claims an icon font that is not vendored',
  COLUMNS_NOT_SUPPORTED: 'the requested column count is not the template column count',
  FORMAT_NOT_SUPPORTED: 'the requested format is not a render format',
  REQUEST_INVALID: 'the template render request is malformed',
  SOURCE_EVAL_FORBIDDEN: 'the template source evaluates code',
  SOURCE_FILE_READ_FORBIDDEN: 'the template source reads a file',
  SOURCE_WASM_FORBIDDEN: 'the template source names a webassembly module',
  SOURCE_NETWORK_FORBIDDEN: 'the template source names a network location',
  SOURCE_TRY_FORBIDDEN: 'the template source uses exception control flow',
  SOURCE_RELATIVE_IMPORT_FORBIDDEN: 'the template source imports a file from its own directory',
});

/** A template rejection. Carries a machine code and reason, never a path or a value. */
export class TemplateRejectionError extends Error {
  readonly code: TemplateRejectionCode;
  readonly reason: TemplateRejectionReason;

  constructor(code: TemplateRejectionCode, reason: TemplateRejectionReason) {
    super(`${code}: ${REASON_TEXT[reason]}`);
    this.name = 'TemplateRejectionError';
    this.code = code;
    this.reason = reason;
  }
}

function fail(code: TemplateRejectionCode, reason: TemplateRejectionReason): never {
  throw new TemplateRejectionError(code, reason);
}

// ---------------------------------------------------------------------------
// The constants the gate is written against
// ---------------------------------------------------------------------------

/** The template a render uses when the caller names none. */
export const RENDER_DEFAULT_TEMPLATE_ID = 'typst-ats-classic';

/**
 * Legacy template ids that the V1 builder wrote (or a pre-cutover `Resume.templateId`
 * still holds) mapped onto a REVIEWED render-registry template.
 *
 * The two namespaces are not the same: a legacy id names a DOCX/HTML layout the old
 * builder drew in the browser, and the render registry cannot compile it. Before this
 * map, a resume created through the old path reached the Studio with `templateId:
 * 'classic'`, the registry refused it (`TEMPLATE_ID_UNKNOWN`), and the fallback path drew
 * the default template's page. The keys are lower-case because the legacy ids were
 * mixed-case (`Classic`, `Minimal_Blue`) and the lookup normalises.
 *
 * A registry id is NEVER remapped: `canonicalTemplateId` returns it untouched, so this
 * table cannot shadow a template that exists.
 */
export const LEGACY_TEMPLATE_ID_MAP: Readonly<Record<string, string>> = Object.freeze({
  'professional-standard': RENDER_DEFAULT_TEMPLATE_ID,
  classic: RENDER_DEFAULT_TEMPLATE_ID,
  standard: RENDER_DEFAULT_TEMPLATE_ID,
  bullets: RENDER_DEFAULT_TEMPLATE_ID,
  descriptive: RENDER_DEFAULT_TEMPLATE_ID,
  accountant: RENDER_DEFAULT_TEMPLATE_ID,
  'ats-minimilistic': RENDER_DEFAULT_TEMPLATE_ID,
  minimalist_1: RENDER_DEFAULT_TEMPLATE_ID,
  minimalist_2column: RENDER_DEFAULT_TEMPLATE_ID,
  'minimal-green': RENDER_DEFAULT_TEMPLATE_ID,
  minimal_blue: RENDER_DEFAULT_TEMPLATE_ID,
  graphic: RENDER_DEFAULT_TEMPLATE_ID,
  graphic2: RENDER_DEFAULT_TEMPLATE_ID,
  graphic3: RENDER_DEFAULT_TEMPLATE_ID,
  desinger: RENDER_DEFAULT_TEMPLATE_ID,
  marketting: RENDER_DEFAULT_TEMPLATE_ID,
  marketting2: RENDER_DEFAULT_TEMPLATE_ID,
  minimalist_2: RENDER_DEFAULT_TEMPLATE_ID,
  minimalist_3: RENDER_DEFAULT_TEMPLATE_ID,
  minimal_color: RENDER_DEFAULT_TEMPLATE_ID,
  'ux-designer': RENDER_DEFAULT_TEMPLATE_ID,
  'with-image': RENDER_DEFAULT_TEMPLATE_ID,
  minimal: RENDER_DEFAULT_TEMPLATE_ID,
  modern: RENDER_DEFAULT_TEMPLATE_ID,
});

/**
 * The render-registry id for a stored template id.
 *
 * A registry id passes through unchanged (the map is consulted only after the caller has
 * decided the id is not already one). A legacy id maps to the reviewed default. An empty
 * or non-string value is the default. An UNKNOWN id is returned as-is so the caller can
 * decide: the Studio falls back visibly, and the registry refuses it explicitly.
 */
export function canonicalTemplateId(id: string | null | undefined): string {
  if (typeof id !== 'string') return RENDER_DEFAULT_TEMPLATE_ID;
  const trimmed = id.trim();
  if (trimmed.length === 0) return RENDER_DEFAULT_TEMPLATE_ID;
  return LEGACY_TEMPLATE_ID_MAP[trimmed.toLowerCase()] ?? trimmed;
}

/** Whether an id is a legacy layout name rather than a render-registry template. */
export function isLegacyTemplateId(id: string | null | undefined): boolean {
  if (typeof id !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(LEGACY_TEMPLATE_ID_MAP, id.trim().toLowerCase());
}

/**
 * Ids that mean "no template" and therefore may never be a template.
 *
 * A `.tex` / `.json` export row records `templateId: 'none'` (plan sec. 7, and ruling 4:
 * "the registry MUST export the reserved set and refuse a template directory whose id is
 * in it"). If `none` could also be a real template, a row meaning "no template" and a row
 * meaning "the none template" would be indistinguishable, and a cache key keyed on
 * `templateId` would conflate them.
 */
export const TEMPLATE_RESERVED_IDS = Object.freeze(['none'] as const);

/** The directory a template lives in, relative to the typst root. */
export const TEMPLATE_FILES_DIRNAME = 'templates';

/** The four files every TYPST template directory carries (policy 5.1, plan sec. 4). */
export const TEMPLATE_REQUIRED_FILES = Object.freeze([
  'template.typ',
  'metadata.json',
  'LICENSE',
  'packages.lock',
] as const);

/**
 * The four files every LaTeX template directory carries. The source file is
 * `template.tex`: it is a reviewed marker, because the document actually compiled is
 * generated per resume by `latexExport.ts`. The loader still requires it so a template
 * with no reviewed source is not in the registry.
 */
export const TEMPLATE_REQUIRED_FILES_LATEX = Object.freeze([
  'template.tex',
  'metadata.json',
  'LICENSE',
  'packages.lock',
] as const);

/** The template source basename per engine. */
export function templateSourceName(engine: RenderEngine): string {
  return engine === 'latex' ? 'template.tex' : 'template.typ';
}

/** The required file set for one engine. */
export function requiredTemplateFiles(engine: RenderEngine): readonly string[] {
  return engine === 'latex' ? TEMPLATE_REQUIRED_FILES_LATEX : TEMPLATE_REQUIRED_FILES;
}

/** The shared lockfile, relative to the typst root. Policy 7.3: the gate reads THIS file. */
export const TEMPLATE_SHARED_LOCKFILE = 'packages.lock';

/** A legal template id: lower case, digits and single dashes, starting alphanumeric. */
export const TEMPLATE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The page sizes a template may declare. A closed set, never a free string. */
export const TEMPLATE_PAGE_SIZES = Object.freeze(['a4', 'letter'] as const);

/**
 * The column counts a template may declare. A closed set: the vendored font set and the
 * ATS profile both care about how a page is divided, and "however many the author liked"
 * is not a capability the registry can check.
 */
export const TEMPLATE_COLUMN_COUNTS = Object.freeze([1, 2] as const);

/**
 * `backend/typst/templates`, derived from this module's own location so it is correct
 * both compiled (`backend/dist/render`) and run from source (`backend/src/render`).
 * Injectable through `loadTemplateRegistry({ root })`, which is how the negative
 * fixtures are built without touching the shipped templates.
 */
export function defaultTemplatesRoot(): string {
  return path.resolve(__dirname, '..', '..', 'typst', TEMPLATE_FILES_DIRNAME);
}

/**
 * `backend/latex/templates`, derived the same way. The registry loads BOTH roots for a
 * real build: a LaTeX template is a peer of a Typst template, not a second class of
 * object, so the Studio sees one list and `resolveTemplateForRender` ignores the root a
 * record came from.
 */
export function defaultLatexTemplatesRoot(): string {
  return path.resolve(__dirname, '..', '..', 'latex', TEMPLATE_FILES_DIRNAME);
}

// ---------------------------------------------------------------------------
// The metadata schema (STRICT)
// ---------------------------------------------------------------------------

const SEMVER_LIKE = /^\d+\.\d+\.\d+$/;

const TemplateFontSchema = z
  .object({
    family: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    licence: z.string(),
  })
  .strict();

const TemplatePackageSchema = z
  .object({
    /** The exact `@namespace/name:version`, the same vocabulary the lockfile uses. */
    spec: z.string().min(1),
    licence: z.string(),
  })
  .strict();

const TemplateAtsProfileSchema = z
  .object({
    singleColumn: z.boolean(),
    tablesAllowed: z.boolean(),
    iconFonts: z.boolean(),
  })
  .strict();

/**
 * The `metadata.json` schema. EXACTLY the keys plan sec. 4 declares - no more, no fewer:
 *
 *   id, version, name, category, engine, engineVersionPins, pageSize, columns, maxPages,
 *   supportedSections, requiredDictKeys, fonts, packages, licence, attribution,
 *   atsProfile, thumbnail
 *
 * `strict()` on every object is the point. Zod's default is to strip an unknown key,
 * which is the wrong answer for a review gate: a `preview.png` key, a `packages` key with
 * a different shape, or a typo'd `supportedSection` would all render with a capability
 * the gate never saw. An unknown key is a rejection instead.
 *
 * `thumbnail` is `z.null()` and nothing else. ADR-044 D5 and ruling 2: a thumbnail would
 * be a second artifact, and policy 6.1/6.3 allows exactly one entry in `/out`.
 */
export const TemplateMetadataSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().regex(SEMVER_LIKE),
    name: z.string().min(1),
    category: z.string().min(1),
    /**
     * A one-line description for the Studio picker. Optional so every template that
     * predates the field still validates; when present it is the template's own claim about
     * its layout, not prose invented by the client.
     */
    description: z.string().min(1).optional(),
    engine: z.enum(RENDER_ENGINES),
    /**
     * The LaTeX serialiser variant this template renders with. Only meaningful when
     * `engine` is `latex`; an absent or unknown value falls back to `ats-classic` in
     * `latexExport.ts`. The string is deliberately not an enum here, because the registry
     * gate is engine-neutral and the serialiser owns the closed variant set.
     */
    variant: z.string().min(1).optional(),
    /**
     * The pin for the engine the template declares. A Typst template carries
     * `{ typst }`; a LaTeX template carries `{ latex }`. Both keys are optional in the
     * schema because the ENGINE decides which one is mandatory, and the gate below is
     * the place that can name a missing pin; `.strict()` still rejects any other key.
     */
    engineVersionPins: z
      .object({
        typst: z.string().min(1).optional(),
        latex: z.string().min(1).optional(),
      })
      .strict(),
    pageSize: z.enum(TEMPLATE_PAGE_SIZES),
    columns: z.union([z.literal(1), z.literal(2)]),
    maxPages: z.number().int().positive().nullable(),
    /**
     * The two section lists are `string[]` here, NOT `z.enum(RESUME_DICT_SECTIONS)`, and
     * that is deliberate: the acceptance contract says a template that DECLARES
     * `languages` must be rejected with `RENDER_TEMPLATE_SECTION_UNKNOWN`, so the
     * vocabulary has to be checked by the gate that can say so. An enum would reject the
     * same input earlier with a generic schema error and the specific diagnosis would be
     * unreachable. `assertSections()` is therefore the ONLY place the vocabulary is
     * enforced, on both lists.
     *
     * `requiredDictKeys` additionally must be NON-EMPTY: a template that requires nothing
     * has not declared what it reads, and policy 8.1 scopes a template's reads to the
     * keys it lists.
     */
    supportedSections: z.array(z.string().min(1)),
    requiredDictKeys: z.array(z.string().min(1)).min(1),
    fonts: z.array(TemplateFontSchema),
    packages: z.array(TemplatePackageSchema),
    licence: z.string(),
    attribution: z.string().min(1),
    atsProfile: TemplateAtsProfileSchema,
    thumbnail: z.null(),
  })
  .strict();

export type TemplateMetadata = z.infer<typeof TemplateMetadataSchema>;

export interface TemplateFontDeclaration {
  readonly family: string;
  readonly files: readonly string[];
  readonly licence: string;
}

export interface TemplatePackageDeclaration {
  readonly spec: string;
  readonly licence: string;
}

export interface TemplateAtsProfile {
  readonly singleColumn: boolean;
  readonly tablesAllowed: boolean;
  readonly iconFonts: boolean;
}

/** A validated template, ready to stage. */
export interface TemplateRecord {
  readonly id: string;
  /** The template's own directory on the host. Never passed into a container. */
  readonly dir: string;
  /** `metadata.version`. What the determinism cache keys on (policy 10.4). */
  readonly version: string;
  readonly metadata: TemplateMetadata;
  /** The exact host path of the reviewed `template.typ` the stager copies. */
  readonly templatePath: string;
  /**
   * Template-local assets to stage, by basename.
   *
   * Always EMPTY in this phase, and that is not an accident: the strict metadata schema
   * has no asset key (plan sec. 4 fixes the key list), and the staged payload is exactly
   * `template.typ` + `data.json` (policy 5.1). The field exists because `stage.ts` takes
   * `assets` and policy 5.1 anticipates them, so widening the schema later is a
   * metadata change and not a module change.
   */
  readonly assets: readonly string[];
}

export interface TemplateRegistry {
  /** Sorted by id, frozen. */
  readonly templates: readonly TemplateRecord[];
  /** The record for `id`, or a `RENDER_TEMPLATE_SCHEMA` / `TEMPLATE_ID_UNKNOWN` throw. */
  get(id: string): TemplateRecord;
  /** The vendored set this registry was validated against. */
  readonly lock: LockfileSummary;
  /** The directory the templates were loaded from. */
  readonly root: string;
}

// ---------------------------------------------------------------------------
// The source scan
// ---------------------------------------------------------------------------

/** An `@namespace/name:version` literal, as it appears in Typst source. */
const PACKAGE_IMPORT_PATTERN =
  /@([A-Za-z][A-Za-z0-9._-]*)\/([A-Za-z][A-Za-z0-9._-]*):([0-9]+\.[0-9]+\.[0-9]+)/g;

/**
 * The denied source surfaces, each with its own reason. Comments are stripped before
 * these run, so prose about `eval` is not mistaken for a call to it.
 *
 * `try`/`catch` is refused outright, which is STRICTER than policy 8.6 (which refuses it
 * inside a loop or a function). That is deliberate and safe: on the pinned engine it
 * cannot propagate an assignment either, so a template can never rely on it, and none of
 * the shipped templates need it. The container remains the enforcement point; this is the
 * review gate that makes the denial visible at registry load time.
 */
const FORBIDDEN_SOURCE_SURFACES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: TemplateRejectionReason;
}> = Object.freeze([
  { pattern: /\beval\s*\(/, reason: 'SOURCE_EVAL_FORBIDDEN' },
  { pattern: /\bread\s*\(/, reason: 'SOURCE_FILE_READ_FORBIDDEN' },
  { pattern: /\.wasm\b/, reason: 'SOURCE_WASM_FORBIDDEN' },
  { pattern: /https?:\/\//, reason: 'SOURCE_NETWORK_FORBIDDEN' },
  { pattern: /\b(?:try|catch)\b/, reason: 'SOURCE_TRY_FORBIDDEN' },
  {
    // A QUOTED import with no `@namespace/name:version` in it is a relative import of a
    // sibling file, which would need a staged name this registry has no key to declare.
    // The negative lookahead is what keeps a package import out of this rule so the
    // declared-vs-used gate can name it precisely.
    pattern: /(?:^|[\n;])\s*#?(?:import|include)\s+["'](?![^"'\n]*@)/,
    reason: 'SOURCE_RELATIVE_IMPORT_FORBIDDEN',
  },
]);

/**
 * Remove typst line comments and block comments, so prose about a denied surface is
 * never mistaken for a call to it. Applied before every pattern in
 * `FORBIDDEN_SOURCE_SURFACES` and before the import scan.
 *
 * STRING-AWARE, and it has to be. A regex-only stripper (a plain "slash-slash to end of
 * line" replace) removes the pair of slashes INSIDE a string literal, so a template that
 * carries a URL in a string would have that string truncated and the URL gate would never
 * see it. The escape hatch would be a one-character edit to any reviewed template, so a
 * correct stripper is the gate, not a nicer regex.
 *
 * This is a LEXICAL scan, not a typst parser: it tracks double-quoted strings (with
 * backslash escapes), line comments and block comments, and replaces a comment with a
 * single space so two tokens either side of it cannot fuse into one. Typst has no other
 * comment form and no raw string delimiter this needs to know about.
 */
function stripTypstComments(source: string): string {
  let out = '';
  let index = 0;
  let inString = false;
  while (index < source.length) {
    const char = source[index] as string;
    if (inString) {
      out += char;
      if (char === '\\' && index + 1 < source.length) {
        out += source[index + 1] as string;
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      out += ' ';
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      out += ' ';
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Every distinct `@ns/name:ver` literal in the source, sorted. */
export function packageImportsIn(source: string): readonly string[] {
  const found = new Set<string>();
  for (const match of stripTypstComments(source).matchAll(PACKAGE_IMPORT_PATTERN)) {
    found.add(`@${match[1] as string}/${match[2] as string}:${match[3] as string}`);
  }
  return Object.freeze([...found].sort());
}

// ---------------------------------------------------------------------------
// Loading one template
// ---------------------------------------------------------------------------

async function readTemplateFile(dir: string, name: string): Promise<string> {
  try {
    return await readFile(path.join(dir, name), 'utf8');
  } catch {
    fail('RENDER_TEMPLATE_FILE_MISSING', 'TEMPLATE_FILE_MISSING');
  }
}

/**
 * Gate 4, for EVERY one of the four required files and BEFORE any of them is read.
 *
 * `lstat`, not `stat`: `stat` FOLLOWS a symlink, so `metadata.json -> somewhere/valid.json`
 * would pass `isFile()` and the registry would validate a file the review never saw. Git
 * stores symlinks, so that is a PR-shaped hole rather than a theoretical one. A symlinked
 * DIRECTORY is already invisible to `readdir`-with-dirents (a symlink dirent reports
 * `isDirectory() === false`), so this closes the file half.
 *
 * `LICENSE` is checked for presence and type only, never parsed: its content is the
 * attribution the review already read, and this module has no reason to interpret it.
 *
 * Residual, stated rather than hidden: the check and the later `readFile` are two calls,
 * so a path swapped between them is a window. It is a repo checkout under review, not an
 * attacker-controlled path, and the container remains the enforcement point - but this
 * gate's job is that the file it validated is the file in the tree, not that it defends
 * against a concurrent writer.
 */
async function assertTemplateFileIsRegular(dir: string, name: string): Promise<void> {
  try {
    const stats = await lstat(path.join(dir, name));
    if (stats.isSymbolicLink() || !stats.isFile()) {
      fail('RENDER_TEMPLATE_FILE_MISSING', 'TEMPLATE_FILE_MISSING');
    }
  } catch (err) {
    if (err instanceof TemplateRejectionError) throw err;
    fail('RENDER_TEMPLATE_FILE_MISSING', 'TEMPLATE_FILE_MISSING');
  }
}

function summariseTemplateLock(text: string): LockfileSummary {
  try {
    return summariseLockfile(parseLockfileRecords(text));
  } catch (err) {
    if (err instanceof LockfileError) {
      fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_LOCKFILE_INVALID');
    }
    throw err;
  }
}

/** Gate 9a: the template's own licence, and every licence it declares, is non-empty. */
function assertLicencesNonEmpty(metadata: TemplateMetadata): void {
  if (metadata.licence.trim().length === 0) {
    fail('RENDER_TEMPLATE_LICENCE_MISSING', 'TEMPLATE_LICENCE_MISSING');
  }
  for (const font of metadata.fonts) {
    if (font.licence.trim().length === 0) {
      fail('RENDER_TEMPLATE_LICENCE_MISSING', 'FONT_LICENCE_MISSING');
    }
  }
  for (const entry of metadata.packages) {
    if (entry.licence.trim().length === 0) {
      fail('RENDER_TEMPLATE_PACKAGE_UNRECORDED', 'PACKAGE_LICENCE_MISSING');
    }
  }
}

/**
 * Gate 9b: every declared font FILE is vendored in the shared lock, with a non-empty
 * recorded licence, and every declared package SPEC is vendored with a non-empty licence.
 *
 * This is the rule that makes "an unrecorded licence cannot render" (policy 7.3) true for
 * FONTS and not only for packages: a `fonts[].files` entry naming a file the vendored set
 * does not contain is a font nobody fetched, nobody hashed and nobody recorded.
 */
function assertVendored(metadata: TemplateMetadata, lock: LockfileSummary): void {
  for (const font of metadata.fonts) {
    for (const file of font.files) {
      const vendored = lock.fonts.find((entry) => entry.file === file);
      if (vendored === undefined) {
        fail('RENDER_TEMPLATE_LICENCE_MISSING', 'FONT_NOT_VENDORED');
      }
      if (vendored.licence.trim().length === 0) {
        fail('RENDER_TEMPLATE_LICENCE_MISSING', 'FONT_LICENCE_MISSING');
      }
      if (vendored.licence !== font.licence) {
        // The template claims a different licence for a vendored face than the lockfile
        // records. Both are non-empty, so this is a DISAGREEMENT, not a gap.
        fail('RENDER_TEMPLATE_LICENCE_MISSING', 'FONT_LICENCE_MISSING');
      }
    }
  }
  for (const entry of metadata.packages) {
    const vendored = lock.packages.find((candidate) => candidate.spec === entry.spec);
    if (vendored === undefined) {
      fail('RENDER_TEMPLATE_PACKAGE_UNRECORDED', 'PACKAGE_NOT_RECORDED');
    }
    if (vendored.licence.trim().length === 0) {
      fail('RENDER_TEMPLATE_PACKAGE_UNRECORDED', 'PACKAGE_LICENCE_MISSING');
    }
    if (vendored.licence !== entry.licence) {
      fail('RENDER_TEMPLATE_PACKAGE_UNRECORDED', 'PACKAGE_LICENCE_MISSING');
    }
  }
}

/** Gate 8: both section lists are in the vocabulary, and required is inside supported. */
function assertSections(metadata: TemplateMetadata): void {
  for (const section of metadata.supportedSections) {
    if (!(RESUME_DICT_SECTIONS as readonly string[]).includes(section)) {
      fail('RENDER_TEMPLATE_SECTION_UNKNOWN', 'SECTION_UNKNOWN');
    }
  }
  for (const key of metadata.requiredDictKeys) {
    if (!(RESUME_DICT_SECTIONS as readonly string[]).includes(key)) {
      fail('RENDER_TEMPLATE_SECTION_UNKNOWN', 'SECTION_UNKNOWN');
    }
    if (!metadata.supportedSections.includes(key)) {
      fail('RENDER_TEMPLATE_SECTION_UNKNOWN', 'REQUIRED_KEY_NOT_SUPPORTED');
    }
  }
}

/**
 * Gate 10: the template's own `packages.lock` agrees with its `metadata.json`, and with
 * the shared lockfile on the digests.
 *
 * Two records that can drift is one more than a review gate can carry, so the template's
 * own lockfile is not free text: it is the same machine-readable grammar, and it must say
 * the same id, the same version, the same engine pin, the same font files and the same
 * licences. The font DIGESTS are compared against the shared lockfile, so a template
 * cannot pin a face file the repository no longer vendors under those bytes.
 */
function assertTemplateLockAgreement(
  metadata: TemplateMetadata,
  templateLock: LockfileSummary,
  templateRecords: LockfileRecords,
  lock: LockfileSummary,
): void {
  if (templateRecords.get('template.id') !== metadata.id) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_LOCKFILE_MISMATCH');
  }
  if (templateRecords.get('template.version') !== metadata.version) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_VERSION_MISMATCH');
  }
  if (templateLock.engine.version !== TYPST_PIN.version) {
    fail('RENDER_TOOLCHAIN_MISMATCH', 'ENGINE_PIN_MISMATCH');
  }
  if (templateLock.engine.version !== lock.engine.version) {
    fail('RENDER_TOOLCHAIN_MISMATCH', 'ENGINE_PIN_MISMATCH');
  }

  const declaredFiles = metadata.fonts.flatMap((font) => [...font.files]).sort();
  const lockedFiles = templateLock.fonts.map((font) => font.file).sort();
  if (declaredFiles.join(',') !== lockedFiles.join(',')) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_LOCKFILE_MISMATCH');
  }
  for (const font of templateLock.fonts) {
    const declared = metadata.fonts.find((candidate) => candidate.files.includes(font.file));
    if (declared === undefined || declared.licence !== font.licence) {
      fail('RENDER_TEMPLATE_LICENCE_MISSING', 'FONT_LICENCE_MISSING');
    }
    const vendored = lock.fonts.find((entry) => entry.file === font.file);
    if (vendored === undefined || vendored.sha256 !== font.sha256) {
      fail('RENDER_TEMPLATE_LICENCE_MISSING', 'FONT_NOT_VENDORED');
    }
  }
  const declaredSpecs = metadata.packages.map((entry) => entry.spec).sort();
  const lockedSpecs = templateLock.packages.map((entry) => entry.spec).sort();
  if (declaredSpecs.join(',') !== lockedSpecs.join(',')) {
    fail('RENDER_TEMPLATE_PACKAGE_UNRECORDED', 'PACKAGE_NOT_RECORDED');
  }
}

/**
 * Gate 10 for a LaTeX template: its own lockfile names the same id/version and the
 * LaTeX pin, and declares exactly the font faces and packages its metadata declares.
 *
 * TeX Live is the image, not a vendored archive, so the shared Typst lockfile is not
 * consulted for the engine pin. That is not a weakening: the required pin is
 * `LATEX_PIN.version`, the same constant the broker checks against the job spec, and a
 * template cannot render if its own lockfile disagrees.
 */
function assertLatexTemplateLockAgreement(
  metadata: TemplateMetadata,
  templateLock: LatexLockfileSummary,
  templateRecords: LockfileRecords,
): void {
  if (templateRecords.get('template.id') !== metadata.id) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_LOCKFILE_MISMATCH');
  }
  if (templateRecords.get('template.version') !== metadata.version) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_VERSION_MISMATCH');
  }
  if (templateLock.engine.version !== LATEX_PIN.version) {
    fail('RENDER_TOOLCHAIN_MISMATCH', 'ENGINE_PIN_MISMATCH');
  }
  const declaredFiles = metadata.fonts.flatMap((font) => [...font.files]).sort();
  const lockedFiles = templateLock.fonts.map((font) => font.file).sort();
  if (declaredFiles.join(',') !== lockedFiles.join(',')) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_LOCKFILE_MISMATCH');
  }
  for (const font of templateLock.fonts) {
    const declared = metadata.fonts.find((candidate) => candidate.files.includes(font.file));
    if (declared === undefined || declared.licence !== font.licence) {
      fail('RENDER_TEMPLATE_LICENCE_MISSING', 'FONT_LICENCE_MISSING');
    }
  }
  const declaredSpecs = metadata.packages.map((entry) => entry.spec).sort();
  const lockedSpecs = templateLock.packages.map((entry) => entry.spec).sort();
  if (declaredSpecs.join(',') !== lockedSpecs.join(',')) {
    fail('RENDER_TEMPLATE_PACKAGE_UNRECORDED', 'PACKAGE_NOT_RECORDED');
  }
  for (const entry of metadata.packages) {
    const vendored = templateLock.packages.find((candidate) => candidate.spec === entry.spec);
    if (vendored === undefined || vendored.licence !== entry.licence) {
      fail('RENDER_TEMPLATE_PACKAGE_UNRECORDED', 'PACKAGE_LICENCE_MISSING');
    }
  }
}

/** Gate 12: the declared ATS profile agrees with the template's own geometry. */
function assertAtsProfile(metadata: TemplateMetadata): void {
  // A template that renders in two columns while declaring `singleColumn: true` is making
  // a claim to an applicant-tracking system that the document does not keep. The layout
  // is the truth and the profile has to agree with it.
  if (metadata.atsProfile.singleColumn !== (metadata.columns === 1)) {
    fail('RENDER_TEMPLATE_CAPABILITY_MISMATCH', 'ATS_PROFILE_MISMATCH');
  }
  // Policy 8.2 B13: icon fonts are denied, and the vendored set is three faces of one
  // text family. A template that claims an icon font is claiming a capability the
  // font allowlist makes unreachable.
  if (metadata.atsProfile.iconFonts) {
    fail('RENDER_TEMPLATE_CAPABILITY_MISMATCH', 'ICON_FONTS_NOT_VENDORED');
  }
}

/**
 * Gates 11 and 13: declared-vs-used imports, then the denied source surfaces.
 *
 * The ORDER matters and is the point of the test that pins it: `#import
 * "@preview/cetz:0.3.1": *` is BOTH an undeclared import AND a quoted import, and the
 * specific diagnosis (`RENDER_TEMPLATE_IMPORT_UNDECLARED`, "this template imports a
 * package it does not declare") is the one an operator can act on, so the import gate
 * runs first. The quoted-import surface rule exists for a RELATIVE import - a sibling
 * file, which would need a staged name this registry has no key to declare - and its
 * pattern therefore does not fire on a `@namespace/name:version` spec.
 */
function assertSourceSurface(source: string, declaredSpecs: readonly string[]): void {
  for (const used of packageImportsIn(source)) {
    if (!declaredSpecs.includes(used)) {
      fail('RENDER_TEMPLATE_IMPORT_UNDECLARED', 'IMPORT_UNDECLARED');
    }
  }
  const code = stripTypstComments(source);
  for (const surface of FORBIDDEN_SOURCE_SURFACES) {
    if (surface.pattern.test(code)) {
      fail('RENDER_TEMPLATE_CAPABILITY_MISMATCH', surface.reason);
    }
  }
}

function parseMetadata(text: string): TemplateMetadata {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    fail('RENDER_TEMPLATE_SCHEMA', 'METADATA_NOT_JSON');
  }
  const parsed = TemplateMetadataSchema.safeParse(value);
  if (!parsed.success) {
    fail('RENDER_TEMPLATE_SCHEMA', 'METADATA_SCHEMA');
  }
  // Zod returns a plain mutable object. This record is what every later gate read, and a
  // caller holding a mutable copy could widen a capability AFTER the gate passed - so the
  // validated value is deep-frozen here, once, and every reader sees the same bytes.
  return deepFreeze(parsed.data) as TemplateMetadata;
}

/** Freeze a validated value and everything it owns. Arrays included: `files` is one. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const member of Object.values(value as Record<string, unknown>)) {
    deepFreeze(member);
  }
  return Object.freeze(value);
}

async function loadOneTemplate(
  dir: string,
  id: string,
  lock: LockfileSummary,
): Promise<TemplateRecord> {
  if ((TEMPLATE_RESERVED_IDS as readonly string[]).includes(id)) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_ID_RESERVED');
  }
  if (!TEMPLATE_ID_PATTERN.test(id)) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_ID_INVALID');
  }

  // 4. FILES. `metadata.json` is lstat'ed before it is read, and it is the ONE file
  //    that decides which source basename the rest of the gate requires
  //    (`template.typ` for Typst, `template.tex` for LaTeX). Every other required file
  //    is still lstat'ed before it is read, so a symlink is refused before any content
  //    is opened.
  await assertTemplateFileIsRegular(dir, 'metadata.json');
  const metadata = parseMetadata(await readTemplateFile(dir, 'metadata.json'));
  for (const name of requiredTemplateFiles(metadata.engine)) {
    if (name === 'metadata.json') continue;
    await assertTemplateFileIsRegular(dir, name);
  }
  const source = await readTemplateFile(dir, templateSourceName(metadata.engine));
  const templateLockText = await readTemplateFile(dir, TEMPLATE_SHARED_LOCKFILE);

  // 6. IDENTITY
  if (metadata.id !== id) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_ID_MISMATCH');
  }
  // 7. PIN - never a silent degrade onto another engine. The ENGINE decides which pin
  //    is mandatory; an absent pin for the declared engine is the same refusal as a
  //    wrong one.
  if (metadata.engine === 'latex') {
    if (metadata.engineVersionPins.latex !== LATEX_PIN.version) {
      fail('RENDER_TOOLCHAIN_MISMATCH', 'ENGINE_PIN_MISMATCH');
    }
  } else if (metadata.engineVersionPins.typst !== TYPST_PIN.version) {
    fail('RENDER_TOOLCHAIN_MISMATCH', 'ENGINE_PIN_MISMATCH');
  }
  // 8. SECTIONS
  assertSections(metadata);
  // 9. LICENCE + vendored set
  assertLicencesNonEmpty(metadata);
  assertVendored(metadata, lock);
  // 10. AGREEMENT between the template's own lockfile, its metadata and (for Typst) the
  //     shared vendored set. A LaTeX template's toolchain is the worker image, not a
  //     vendored archive, so its own lockfile is the engine record.
  const templateRecords = parseLockfileRecords(templateLockText);
  if (metadata.engine === 'latex') {
    let latexLock: LatexLockfileSummary;
    try {
      latexLock = summariseLatexLockfile(templateRecords);
    } catch (err) {
      if (err instanceof LockfileError) {
        fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_LOCKFILE_INVALID');
      }
      throw err;
    }
    assertLatexTemplateLockAgreement(metadata, latexLock, templateRecords);
  } else {
    assertTemplateLockAgreement(metadata, summariseTemplateLock(templateLockText), templateRecords, lock);
  }
  // 11 + 13. Declared-vs-used imports, and the denied source surfaces. These are TYPST
  //     source rules (`@ns/name:ver`, `#eval`, `#read`); a LaTeX template's source is a
  //     marker, and the document actually compiled is generated by `latexExport.ts`,
  //     whose own test enumerates every macro it emits.
  if (metadata.engine === 'typst') {
    assertSourceSurface(source, metadata.packages.map((entry) => entry.spec));
  }
  // 12. CAPABILITY
  assertAtsProfile(metadata);

  return Object.freeze({
    id,
    dir,
    version: metadata.version,
    metadata,
    templatePath: path.join(dir, templateSourceName(metadata.engine)),
    assets: Object.freeze([] as readonly string[]),
  });
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface LoadTemplateRegistryOptions {
  /**
   * ONE templates directory to load, used by tests and negative fixtures. Omitted, the
   * registry loads BOTH shipped roots: `backend/typst/templates` and
   * `backend/latex/templates`. The shared lockfile is read from the PARENT of the
   * FIRST root, because policy 7.3 makes `backend/typst/packages.lock` the vendored
   * allowlist and the Typst templates' own `packages.lock` the record of what each
   * claims.
   */
  readonly root?: string;
}

/**
 * Load and validate every template in the registry. Fail-closed: ONE bad template fails
 * the whole load with its machine code and reason, because a registry that silently drops
 * a template turns a review failure into a 404 in the Studio and a fallback to a different
 * template in a render.
 */
export async function loadTemplateRegistry(
  opts: LoadTemplateRegistryOptions = {},
): Promise<TemplateRegistry> {
  if (opts === null || typeof opts !== 'object') {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_ROOT_MISSING');
  }
  const roots =
    opts.root === undefined
      ? [path.resolve(defaultTemplatesRoot()), path.resolve(defaultLatexTemplatesRoot())]
      : [path.resolve(opts.root)];

  const directoryNames: Array<{ root: string; name: string }> = [];
  for (const root of roots) {
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      const dirents = await readdir(root, { withFileTypes: true });
      entries = dirents.map((dirent) => ({ name: dirent.name, isDirectory: dirent.isDirectory() }));
    } catch {
      // An injected root is the only root, and a missing one is still a hard failure. A
      // shipped LaTeX root that is absent would mean a release is missing its templates,
      // which is the same operator story.
      fail('RENDER_TEMPLATE_FILE_MISSING', 'TEMPLATE_ROOT_MISSING');
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      directoryNames.push({ root, name: entry.name });
    }
  }

  // The shared lockfile, parsed with the SAME grammar as a template's own, so both
  // records are held to one parser. It is the TYPST vendored set; a LaTeX template does
  // not consult it for its engine pin (see `assertLatexTemplateLockAgreement`).
  const sharedLockText = await readFile(
    path.resolve(path.dirname(roots[0] as string), TEMPLATE_SHARED_LOCKFILE),
    'utf8',
  ).catch((): never => fail('RENDER_TEMPLATE_FILE_MISSING', 'TEMPLATE_FILE_MISSING'));
  let lock: LockfileSummary;
  try {
    lock = summariseLockfile(parseLockfileRecords(sharedLockText));
  } catch (err) {
    if (err instanceof LockfileError) {
      fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_LOCKFILE_INVALID');
    }
    throw err;
  }

  directoryNames.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const templates: TemplateRecord[] = [];
  const seen = new Set<string>();
  for (const entry of directoryNames) {
    if (seen.has(entry.name)) {
      fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_ID_MISMATCH');
    }
    seen.add(entry.name);
    templates.push(await loadOneTemplate(path.join(entry.root, entry.name), entry.name, lock));
  }

  const byId = new Map(templates.map((record) => [record.id, record] as const));
  return Object.freeze({
    templates: Object.freeze(templates),
    lock,
    root: roots[0] as string,
    get(id: string): TemplateRecord {
      if (typeof id !== 'string') {
        fail('RENDER_TEMPLATE_SCHEMA', 'REQUEST_INVALID');
      }
      const record = byId.get(id);
      if (record === undefined) {
        fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_ID_UNKNOWN');
      }
      return record;
    },
  });
}

// ---------------------------------------------------------------------------
// Resolution for a render
// ---------------------------------------------------------------------------

export interface TemplateRenderRequest {
  /** Defaults to `RENDER_DEFAULT_TEMPLATE_ID`. A RESERVED id is refused. */
  readonly templateId?: string;
  readonly format: string;
  /** The column count the caller is asking for. Must be the template's own. */
  readonly columns?: number;
  /**
   * The sections the caller is going to fill. Each must be a section the template
   * supports - a request for a section the template does not support is a rejection, not
   * a section quietly dropped from the document.
   */
  readonly sections?: readonly string[];
  /**
   * The template version the CALLER has on record - the `ResumeTemplate.version` row, or
   * the version a cached artifact was rendered from. A disagreement is a rejection: the
   * determinism cache keys on `templateVersion` (policy 10.4), so a template edited
   * without a bump must fail the render rather than serve a stale artifact.
   */
  readonly templateVersion?: string;
}

/**
 * Resolve the template a render must use, or reject with a machine code and reason.
 *
 * PURE: it inspects an already loaded registry and returns a `TemplateRecord`. No I/O, no
 * container, no clock. Every failure mode is a rejection rather than a substitute:
 * an unknown id does not fall back to the default template, a reserved id does not resolve
 * at all, a mismatched column count does not silently render in one column, and a section
 * the template does not support is refused rather than dropped.
 */
export function resolveTemplateForRender(
  registry: TemplateRegistry,
  request: TemplateRenderRequest,
): TemplateRecord {
  if (registry === null || typeof registry !== 'object' || typeof registry.get !== 'function') {
    fail('RENDER_TEMPLATE_SCHEMA', 'REQUEST_INVALID');
  }
  if (request === null || typeof request !== 'object') {
    fail('RENDER_TEMPLATE_SCHEMA', 'REQUEST_INVALID');
  }
  if (typeof request.format !== 'string') {
    fail('RENDER_TEMPLATE_CAPABILITY_MISMATCH', 'FORMAT_NOT_SUPPORTED');
  }

  const requestedId = request.templateId ?? RENDER_DEFAULT_TEMPLATE_ID;
  if (typeof requestedId !== 'string' || requestedId.length === 0) {
    fail('RENDER_TEMPLATE_SCHEMA', 'REQUEST_INVALID');
  }
  if ((TEMPLATE_RESERVED_IDS as readonly string[]).includes(requestedId)) {
    fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_ID_RESERVED');
  }
  const record = registry.get(requestedId);

  if (!(RENDER_FORMATS as readonly string[]).includes(request.format)) {
    fail('RENDER_TEMPLATE_CAPABILITY_MISMATCH', 'FORMAT_NOT_SUPPORTED');
  }
  if (request.columns !== undefined) {
    if (typeof request.columns !== 'number' || !Number.isInteger(request.columns)) {
      fail('RENDER_TEMPLATE_CAPABILITY_MISMATCH', 'REQUEST_INVALID');
    }
    if (request.columns !== record.metadata.columns) {
      fail('RENDER_TEMPLATE_CAPABILITY_MISMATCH', 'COLUMNS_NOT_SUPPORTED');
    }
  }
  if (request.sections !== undefined) {
    if (!Array.isArray(request.sections)) {
      fail('RENDER_TEMPLATE_SCHEMA', 'REQUEST_INVALID');
    }
    for (const section of request.sections) {
      if (typeof section !== 'string') {
        fail('RENDER_TEMPLATE_SCHEMA', 'REQUEST_INVALID');
      }
      if (!(RESUME_DICT_SECTIONS as readonly string[]).includes(section)) {
        fail('RENDER_TEMPLATE_SECTION_UNKNOWN', 'SECTION_UNKNOWN');
      }
      if (!record.metadata.supportedSections.includes(section)) {
        fail('RENDER_TEMPLATE_SECTION_UNKNOWN', 'SECTION_NOT_SUPPORTED');
      }
    }
  }
  if (request.templateVersion !== undefined) {
    if (typeof request.templateVersion !== 'string') {
      fail('RENDER_TEMPLATE_SCHEMA', 'REQUEST_INVALID');
    }
    if (request.templateVersion !== record.version) {
      fail('RENDER_TEMPLATE_SCHEMA', 'TEMPLATE_VERSION_MISMATCH');
    }
  }

  return record;
}
