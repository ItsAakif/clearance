// The DOCX renderer - a PEER of the PDF renderer, not a child of any typesetter.
//
// NORMATIVE DOC: .planning/decisions/ADR-039-docx-renders-independently.md
//                   ("DOCX renders independently from Resume JSON. It is a peer of the PDF
//                   renderer, not a child of any typesetting engine.")
//                 .planning/decisions/ADR-044-render-transport-storage-and-phase-split.md D3
//                   (ONE shared dictionary, three serialisers)
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 5 (the
//                   dictionary), sec. 13 ruling 15 (the shared parity fixture)
//                 .planning/specs/clearance-v2/render-sandbox-policy.md 7.4 (reproducibility),
//                   9.2/9.3/9.4 (the error surface)
// Task:         T1041
//
// =====================================================================================
// WHAT THIS MODULE IS, AND WHY IT IMPORTS SO LITTLE
// =====================================================================================
//
// ADR-039 decided DOCX renders off Resume JSON directly, with `docxtemplater` filling a
// user-supplied template as the fallback. It also decided what this module must NOT be: a
// LaTeX -> DOCX converter, and anything derived from Typst. That is why the import set below
// is three npm packages plus one TYPE import:
//
//   docx          - the programmatic OOXML builder (A4 sectPr, real styles, real lists)
//   docxtemplater - ADR-039 decision 2, the `{{placeholder}}` fill for a user template
//   pizzip        - the zip reader/writer used to NORMALISE the produced bytes (see below)
//   ./dict.js     - TYPES ONLY. `ResumeDict`, `ResumeDictSection`. No runtime import.
//
// It imports NOTHING from `typst.ts`, `latexExport.ts`, `brokerClient.ts`, `stage.ts` or
// `sandbox.ts`, and `docx.test.ts` asserts that import set by reading THIS FILE, so a later
// "just call the compile path" edit fails a named test instead of quietly making DOCX a
// child of a typesetter. It also reads no clock, no environment, no filesystem and no
// network: the only inputs are the dictionary's own values.
//
// WHY THE DATES ARE NOT FORMATTED HERE. ADR-044 D3 makes `projectResumeDict` the ONE
// projection, and `dict.ts` pre-formats every date into `rangeText` / `dateText` as ASCII
// (`Mar 2020 - Present`). This module prints those strings verbatim and contains no `Date`,
// no `Intl` and no locale table, so a DOCX can never disagree with a PDF about what a date
// says - and a test asserts that mutating the dictionary's date mutates the artifact.
//
// WHY THE BYTES ARE NORMALISED, because this is a real discovery and not a nicety.
// `docx@8.5.0` stamps `docProps/core.xml` with `new Date()` (`dcterms:created` and
// `dcterms:modified`) and JSZip stamps every zip entry with the wall clock, and the library
// exposes NO option to pin either. Two renders of one revision therefore produce different
// bytes and different digests, which would make the determinism cache's `hash` describe a
// document the row cannot reproduce and would orphan a content-addressed blob on every
// re-render. So the produced package is re-emitted here with FIXED entry dates and FIXED
// core-property timestamps, which makes the artifact a pure function of the dictionary.
// `docx.test.ts` asserts byte-identity across two calls more than a second apart.
//
// A LIBRARY QUIRK THIS HAD TO WORK AROUND, recorded so the next editor does not undo it: a
// `Document` INSTANCE is mutated by `Packer.toBuffer` - its numbering part gains an
// `abstractNum` per pack - so two packs of the SAME instance differ in `word/numbering.xml`.
// `renderDocxFromDictionary` therefore builds a FRESH `Document` per call and never caches
// one. That is why the two-call determinism test passes.
//
// A4 AND NOTHING ELSE. `sectionPageSizeDefaults` in the library is US Letter (12240 x 15840
// twips). A resume this product renders is A4, and the `.tex` exporter already declares
// `a4paper`, so the geometry is stated here as literals - 11906 x 16838 twips, i.e. 210mm x
// 297mm - rather than taken from a default that is wrong for us. `parity.test.ts` reads the
// produced `word/document.xml` and asserts those two numbers, so A4 is a property of the
// BYTES rather than of the arguments we passed.
//
// SECTION SEMANTICS ARE REAL, NOT FORMATTED TEXT. Every paragraph carries a named style
// (`ClearanceSection`, `ClearanceEntry`, `ClearanceMeta`, `ClearanceBody`) declared in
// `word/styles.xml`, section headings carry `w:outlineLvl 0` so Word's navigation pane lists
// them, and every bullet is a real numbered-list paragraph (`w:numPr`) rather than a literal
// glyph. That is what makes "same section order, same entry counts, same bullet strings"
// checkable against the dictionary by reading the XML, which is the Phase 4 parity property.
//
// THE USER-CONTENT BOUNDARY (policy 8.4). Resume text reaches this module only as
// ALREADY-PROJECTED strings, and it leaves as XML text runs. The `docx` builder escapes the
// XML-active characters itself (`&`, `<`, `>`, `"` are entity-encoded, asserted by a test),
// so a resume cannot introduce structure: there is no markup channel here to escape into.
//
// DETERMINISM. Same dictionary in, same bytes out: no clock (the two timestamps are
// rewritten to a constant), no locale, no environment, no randomness, no iteration over an
// unordered collection. Section order is `dict.sections`, which is the dictionary's fixed
// order - this module never decides an order for itself (ADR-044 D3).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZipCtor = require('pizzip') as unknown as new (input?: Buffer) => PizZipArchive;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const DocxtemplaterCtor = require('docxtemplater') as unknown as new (
  zip: unknown,
  options?: Record<string, unknown>,
) => DocxtemplaterEngine;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const docx = require('docx') as unknown as DocxSurface;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AlignmentType, Document, LevelFormat, Packer, Paragraph, TextRun } = docx;

import type { ResumeDict, ResumeDictSection } from './dict.js';

// ---------------------------------------------------------------------------
// The vocabulary this module owns
// ---------------------------------------------------------------------------

/**
 * The engine this serialiser records on a row, and the half of the determinism cache key
 * that changes when the renderer itself changes.
 *
 * A DOCX row's `templateVersion` is `DOCX_RENDERER_VERSION`: for a compiled PDF the
 * "template" is a `.typ` directory, and for a DOCX the renderer's own styles ARE the
 * template. So a renderer revision is what invalidates a stored DOCX, exactly as a template
 * revision invalidates a stored PDF.
 */
export const DOCX_ENGINE = 'docx' as const;

/**
 * The renderer's layout revision. Bump it when a style, a heading or the page geometry
 * changes: the value lands in `ResumeDocument.templateVersion`, and the cache only serves a
 * row whose `templateVersion` matches exactly.
 */
export const DOCX_RENDERER_VERSION = '1.0.0' as const;

/** A4 page size in twentieths of a point (twips): 210mm x 297mm. Never US Letter. */
export const DOCX_PAGE_WIDTH_TWIPS = 11906 as const;
export const DOCX_PAGE_HEIGHT_TWIPS = 16838 as const;

/** The page margins, in twips: 20mm on every side, 12.5mm header/footer. */
export const DOCX_MARGIN_TWIPS = Object.freeze({
  top: 1134,
  right: 1134,
  bottom: 1134,
  left: 1134,
  header: 708,
  footer: 708,
} as const);

/** The file extension the artifact is named with, without the dot. */
export const DOCX_EXTENSION = 'docx';

/** The bullet glyph, as an escape so this file stays ASCII. */
const BULLET_TEXT = '\u2022';

/** The numbering reference every bullet list in this document uses. */
export const DOCX_BULLET_REFERENCE = 'clearance-bullets';

/** The paragraph style ids, as literals: the XML markers a parity test reads. */
export const DOCX_STYLE_SECTION = 'ClearanceSection';
export const DOCX_STYLE_ENTRY = 'ClearanceEntry';
export const DOCX_STYLE_META = 'ClearanceMeta';
export const DOCX_STYLE_BODY = 'ClearanceBody';

/** The character style ids. */
export const DOCX_CHARACTER_STRONG = 'ClearanceStrong';
export const DOCX_CHARACTER_MUTED = 'ClearanceMuted';

/** The reserved core-property timestamp written into every produced package. */
const FIXED_TIMESTAMP_ISO = '1980-01-01T00:00:00Z';

/**
 * The zip entry date, in milliseconds. The zip epoch is 1980-01-01T00:00:00Z, which is the
 * earliest instant the DOS date field can encode, so this is also the value a fixed archive
 * would carry. It is a CONSTANT, never a clock read.
 */
const FIXED_ZIP_DATE_MS = Date.UTC(1980, 0, 1, 0, 0, 0);

/** The core-properties part whose two timestamps are rewritten. */
const CORE_PROPERTIES_PART = 'docProps/core.xml';

/**
 * The `docxtemplater` fill's scope. Exactly the dictionary: ADR-044 D3 makes it the ONE
 * projection, so a user template reads the same values, in the same order, as the built-in
 * styles do.
 */
export type DocxTemplateScope = Readonly<Record<string, unknown>>;

/** A template fault. The message is a FIXED string; the reason is the machine token. */
export class DocxTemplateError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super('the DOCX template could not be filled');
    this.name = 'DocxTemplateError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// The library surfaces, declared rather than imported
// ---------------------------------------------------------------------------
//
// THREE LIBRARIES, THREE REASONS, ONE RULE: this module names exactly the members it uses
// and nothing else, so the types it checks against are its own declarations rather than a
// vendor's.
//
//   `pizzip` ships NO TypeScript declarations at all. Importing it untyped would put `any`
//   on the path between the produced bytes and the storage key.
//
//   `docx@8.5.0` ships declarations that DO NOT RESOLVE under this repository's
//   `moduleResolution: NodeNext`: its `build/index.d.ts` re-exports with extensionless
//   relative specifiers (`export * from "./file"`), which NodeNext refuses, so only the one
//   explicitly-named `export { File as Document }` survives and `Paragraph`, `Packer`,
//   `TextRun`, `AlignmentType` and `LevelFormat` are all reported as "no exported member".
//   This was measured, not assumed: `routes/resume.ts` sidesteps it by `require`-ing the
//   whole module, which is why the same approach is used here - the runtime is identical
//   and the types are ours. (A `src/types/docx.d.ts` would be the alternative, and is
//   outside this task's change list.)
//
//   `docxtemplater` DOES ship declarations (`export = Docxtemplater`) and they resolve, but
//   its options are `any`-typed at the boundary, so declaring the two methods this module
//   calls keeps the fill honest.
//
// Narrowing the surface is also what makes the import-set assertion meaningful: a member this
// module does not name cannot be reached through it, so the only way to grow what the DOCX
// path can touch is to name it here - in reviewable code, in this file.

/** A run's formatting. The members the renderer uses, spelled out. */
interface DocxRunStyle {
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly color?: string;
  /** Half-points, as OOXML counts them: 22 is 11pt. */
  readonly size?: number;
}

/** A run's identity: the text, plus the character style it wears. */
interface DocxRunOptions extends DocxRunStyle {
  readonly text: string;
  readonly style?: string;
}

/** A paragraph's spacing, in twentieths of a point. */
interface DocxSpacing {
  readonly before?: number;
  readonly after?: number;
}

/** A paragraph style declaration, as it appears in `word/styles.xml`. */
interface DocxParagraphStyleOptions {
  readonly id: string;
  readonly name: string;
  readonly basedOn: string;
  readonly next: string;
  readonly quickFormat?: boolean;
  readonly run?: DocxRunStyle;
  readonly paragraph?: {
    readonly spacing?: DocxSpacing;
    /** 0 is a top-level heading; Word's navigation pane and an ATS both read this. */
    readonly outlineLevel?: number;
    readonly keepNext?: boolean;
  };
}

/** A character style declaration. */
interface DocxCharacterStyleOptions {
  readonly id: string;
  readonly name: string;
  readonly basedOn: string;
  readonly quickFormat?: boolean;
  readonly run?: DocxRunStyle;
}

/** One bullet-list level. A resume bullet is a glyph and an indent, never a counter. */
interface DocxLevelOptions {
  readonly level: number;
  readonly format: string;
  readonly text: string;
  readonly alignment: string;
  readonly style?: {
    readonly paragraph?: {
      readonly indent?: { readonly left?: number; readonly hanging?: number };
    };
  };
}

interface DocxNumberingReference {
  readonly reference: string;
  readonly levels: readonly DocxLevelOptions[];
}

interface DocxParagraphOptions {
  readonly style?: string;
  readonly text?: string;
  readonly numbering?: { readonly reference: string; readonly level: number };
  readonly children?: readonly DocxRun[];
}

interface DocxSectionOptions {
  readonly properties?: {
    readonly page?: {
      /** Twips. A4 is 11906 x 16838; the library's own default is US Letter. */
      readonly size?: { readonly width: number; readonly height: number; readonly orientation: string };
      readonly margin?: {
        readonly top?: number;
        readonly right?: number;
        readonly bottom?: number;
        readonly left?: number;
        readonly header?: number;
        readonly footer?: number;
      };
    };
  };
  readonly children: readonly DocxParagraph[];
}

interface DocxDocumentOptions {
  readonly creator?: string;
  readonly lastModifiedBy?: string;
  readonly title?: string;
  readonly revision?: number;
  readonly styles?: {
    readonly paragraphStyles?: readonly DocxParagraphStyleOptions[];
    readonly characterStyles?: readonly DocxCharacterStyleOptions[];
  };
  readonly numbering?: { readonly config: readonly DocxNumberingReference[] };
  readonly sections: readonly DocxSectionOptions[];
}

/** A zip entry, as `pizzip` exposes it. */
interface PizZipFile {
  readonly dir: boolean;
  asNodeBuffer(): Buffer;
}

/** The options `pizzip`'s `file()` takes, narrowed to the two this module sets. */
interface PizZipFileOptions {
  readonly date?: Date;
  readonly binary?: boolean;
}

interface PizZipArchive {
  readonly files: Record<string, PizZipFile | null>;
  file(name: string): PizZipFile | null;
  /** Adding an entry. The returned archive is this one, so the call is chainable. */
  file(name: string, content: Buffer, options?: PizZipFileOptions): PizZipArchive;
  generate(options: {
    readonly type: 'nodebuffer';
    readonly compression: 'DEFLATE';
    readonly compressionOptions: { readonly level: number };
    readonly platform: 'UNIX';
  }): Buffer;
}

/** The `docx` builder, as this module uses it. */
interface DocxParagraph {
  readonly kind: 'paragraph';
}

interface DocxRun {
  readonly kind: 'run';
}

interface DocxSurface {
  readonly Document: new (options: DocxDocumentOptions) => unknown;
  readonly Paragraph: new (options: DocxParagraphOptions) => DocxParagraph;
  readonly TextRun: new (options: DocxRunOptions | string) => DocxRun;
  readonly Packer: { toBuffer(document: unknown): Promise<Buffer> };
  readonly AlignmentType: Readonly<Record<string, string>>;
  readonly LevelFormat: Readonly<Record<string, string>>;
}

/** The `docxtemplater` engine, as this module uses it. */
interface DocxtemplaterEngine {
  render(scope: unknown): void;
  getZip(): PizZipArchive;
}

/** A tag RESOLVER: what `{{tag}}` means against the scope. */
interface DocxTemplateResolver {
  get(scope: unknown): unknown;
}

/**
 * The template's PATH resolver, so `{{contact.name}}` means what a template author expects.
 *
 * MEASURED, NOT ASSUMED: docxtemplater's DEFAULT parser resolves `{{a.b}}` to the EMPTY
 * STRING against a plain object scope. A nested dictionary member - which is most of
 * `contact` - would silently render as nothing, and the user would see a resume with a blank
 * name and no error anywhere. The library's own answer to this is a custom `parser`, which is
 * also what the legacy export route has always done (`routes/resume.ts:801-818`), so this is
 * the SAME resolution semantics as the path users already have.
 *
 * The library hands this function the tag as a plain STRING (measured: it is called with
 * `'contact.name'`, not with an object carrying `.raw`), and expects an object whose `get`
 * answers for a scope.
 *
 * TOTAL and side-effect-free: a missing intermediate, a non-object intermediate, a prototype
 * member and an empty tag all resolve to `undefined`, which `nullGetter` then renders as
 * `''`. It reads the scope and nothing else - no `eval`, no `Function`, and no property read
 * beyond the path the template itself named.
 */
function resolveTemplatePath(tag: string): DocxTemplateResolver {
  return {
    get(scope: unknown): unknown {
      let current: unknown = scope;
      for (const part of tag.split('.')) {
        if (current === null || current === undefined || typeof current !== 'object') {
          return undefined;
        }
        // `hasOwnProperty` rather than a bare read: a template that names `constructor` or
        // `__proto__` gets nothing rather than a function.
        if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return current;
    },
  };
}

// ---------------------------------------------------------------------------
// The document structure
// ---------------------------------------------------------------------------

/**
 * The section HEADINGS, keyed by the dictionary's own section vocabulary.
 *
 * A closed frozen table rather than a derived title, for the reason `latexExport.ts` gives:
 * a heading is the only prose this module authors, and prose authored by a serialiser is a
 * liability. The keys are `ResumeDictSection`, so a section added to the dictionary without
 * a heading here is a COMPILE error rather than a rendered `undefined`; the keys are ASCII
 * with no markup and are emitted verbatim.
 */
const SECTION_HEADINGS: Readonly<Record<ResumeDictSection, string>> = Object.freeze({
  contact: 'Contact',
  summary: 'Profile',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education',
  skills: 'Skills',
  certifications: 'Certifications',
});

/** Every labelled line uses this separator. Fixed text, not user content. */
const LABEL_SEPARATOR = ': ';

/** The real styles, declared once. `ClearanceSection` carries `outlineLvl 0`. */
const PARAGRAPH_STYLES = Object.freeze([
  {
    id: DOCX_STYLE_SECTION,
    name: 'Clearance Section',
    basedOn: 'Normal',
    next: DOCX_STYLE_BODY,
    quickFormat: true,
    run: { bold: true, size: 26 },
    paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0, keepNext: true },
  },
  {
    id: DOCX_STYLE_ENTRY,
    name: 'Clearance Entry',
    basedOn: 'Normal',
    next: DOCX_STYLE_META,
    quickFormat: true,
    run: { bold: true, size: 22 },
    paragraph: { spacing: { before: 120, after: 40 }, keepNext: true },
  },
  {
    id: DOCX_STYLE_META,
    name: 'Clearance Meta',
    basedOn: 'Normal',
    next: DOCX_STYLE_META,
    run: { size: 20 },
    paragraph: { spacing: { after: 40 } },
  },
  {
    id: DOCX_STYLE_BODY,
    name: 'Clearance Body',
    basedOn: 'Normal',
    next: DOCX_STYLE_BODY,
    run: { size: 22 },
    paragraph: { spacing: { after: 120 } },
  },
] as const);

const CHARACTER_STYLES = Object.freeze([
  {
    id: DOCX_CHARACTER_STRONG,
    name: 'Clearance Strong',
    basedOn: 'DefaultParagraphFont',
    quickFormat: true,
    run: { bold: true },
  },
  {
    id: DOCX_CHARACTER_MUTED,
    name: 'Clearance Muted',
    basedOn: 'DefaultParagraphFont',
    quickFormat: true,
    run: { color: '444444' },
  },
] as const);

/**
 * The one bullet list definition.
 *
 * `LevelFormat.BULLET` with a single level: a resume bullet is a glyph and an indent, not a
 * counter, and a nested level would be a structure the dictionary cannot express.
 */
const NUMBERING_CONFIG = Object.freeze([
  {
    reference: DOCX_BULLET_REFERENCE,
    levels: Object.freeze([
      Object.freeze({
        level: 0,
        format: LevelFormat.BULLET,
        text: BULLET_TEXT,
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 360, hanging: 180 } } },
      }),
    ]),
  },
] as const);

// ---------------------------------------------------------------------------
// Paragraph builders
// ---------------------------------------------------------------------------

/** A run of plain text, never empty: the builder drops empty runs. */
function run(text: string, style?: string): DocxRun {
  return style === undefined ? new TextRun(text) : new TextRun({ text, style });
}

/** A body paragraph, or nothing at all when there is no text. */
function bodyParagraph(text: string): DocxParagraph[] {
  if (text.length === 0) return [];
  return [new Paragraph({ style: DOCX_STYLE_BODY, children: [run(text)] })];
}

/**
 * A section heading.
 *
 * Emitted for every section in `dict.sections`, in that order, with this module's heading
 * text. The style carries `outlineLvl 0`, so the heading is real document structure rather
 * than a bold paragraph - which is what a screen reader and an ATS both navigate by.
 */
function sectionHeading(section: ResumeDictSection): DocxParagraph[] {
  const heading = SECTION_HEADINGS[section];
  if (heading === undefined) {
    throw new Error(`DOCX_SECTION_UNKNOWN: no heading for section "${section}"`);
  }
  return [new Paragraph({ style: DOCX_STYLE_SECTION, children: [run(heading)] })];
}

/** Exactly one entry headline per dictionary entry, whichever field carries it. */
function entryParagraph(...candidates: readonly string[]): DocxParagraph[] {
  for (const candidate of candidates) {
    if (candidate.length > 0) {
      return [
        new Paragraph({
          style: DOCX_STYLE_ENTRY,
          children: [run(candidate, DOCX_CHARACTER_STRONG)],
        }),
      ];
    }
  }
  return [];
}

/**
 * A `Label: value` line, in the meta style, with the label in a character style.
 *
 * Nothing is emitted when the value is empty, and the value is never re-formatted: a date
 * reaches here already formatted by the dictionary.
 */
function metaLine(label: string, value: string): DocxParagraph[] {
  if (value.length === 0) return [];
  return [
    new Paragraph({
      style: DOCX_STYLE_META,
      children: [
        run(`${label}${LABEL_SEPARATOR}`, DOCX_CHARACTER_STRONG),
        run(value, DOCX_CHARACTER_MUTED),
      ],
    }),
  ];
}

/** A URL line: the value in the muted character style so it reads as a link target. */
function urlLine(value: string): DocxParagraph[] {
  if (value.length === 0) return [];
  return [
    new Paragraph({
      style: DOCX_STYLE_META,
      children: [run(value, DOCX_CHARACTER_MUTED)],
    }),
  ];
}

/** One real list paragraph per entry, in the dictionary's order. Empty lists emit nothing. */
function bulletList(entries: readonly string[]): DocxParagraph[] {
  const out: DocxParagraph[] = [];
  for (const entry of entries) {
    if (entry.length === 0) continue;
    out.push(
      new Paragraph({
        style: DOCX_STYLE_BODY,
        numbering: { reference: DOCX_BULLET_REFERENCE, level: 0 },
        children: [run(entry)],
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// One section -> its paragraphs
// ---------------------------------------------------------------------------

function contactParagraphs(dict: ResumeDict): DocxParagraph[] {
  const { contact } = dict;
  const out: DocxParagraph[] = [];
  // F6: the headline is printed EXACTLY ONCE. `entryParagraph` falls through to the headline
  // when the name is empty, so the body line is suppressed in exactly that case - otherwise
  // the contact block carries the same string twice, once strong as the headline and once
  // plain as a body paragraph, which reads as a rendering bug rather than as a resume.
  const headlineIsTheHeadline = contact.name.length === 0 && contact.headline.length > 0;
  out.push(
    ...entryParagraph(contact.name, contact.headline, contact.email, contact.location),
    ...(headlineIsTheHeadline ? [] : bodyParagraph(contact.headline)),
    ...metaLine('Email', contact.email),
    ...metaLine('Phone', contact.phone),
    ...metaLine('Location', contact.location),
    ...urlLine(contact.website),
    ...urlLine(contact.linkedin),
    ...urlLine(contact.github),
  );
  for (const profile of contact.profiles) {
    const network = profile.network.length > 0 ? profile.network : 'Profile';
    out.push(
      ...metaLine(network, profile.url),
      ...metaLine(`${network} handle`, profile.username),
    );
  }
  return out;
}

function experienceParagraphs(dict: ResumeDict): DocxParagraph[] {
  const out: DocxParagraph[] = [];
  for (const entry of dict.experience) {
    out.push(
      ...entryParagraph(entry.title, entry.organisation, entry.location, entry.rangeText),
      ...metaLine('Organisation', entry.organisation),
      ...metaLine('Dates', entry.rangeText),
      ...metaLine('Location', entry.location),
      ...bodyParagraph(entry.summary),
      ...bulletList(entry.highlights),
    );
  }
  return out;
}

function projectsParagraphs(dict: ResumeDict): DocxParagraph[] {
  const out: DocxParagraph[] = [];
  for (const entry of dict.projects) {
    out.push(
      ...entryParagraph(
        entry.name,
        entry.description,
        entry.url,
        entry.rangeText,
        entry.keywords[0] ?? '',
      ),
      ...metaLine('Dates', entry.rangeText),
      ...bodyParagraph(entry.description),
      ...urlLine(entry.url),
      ...bulletList(entry.keywords),
      ...bulletList(entry.highlights),
    );
  }
  return out;
}

function educationParagraphs(dict: ResumeDict): DocxParagraph[] {
  const out: DocxParagraph[] = [];
  for (const entry of dict.education) {
    out.push(
      ...entryParagraph(entry.qualification, entry.institution, entry.rangeText, entry.score),
      ...metaLine('Institution', entry.institution),
      ...metaLine('Dates', entry.rangeText),
      ...metaLine('Location', entry.location),
      ...metaLine('Grade', entry.score),
    );
  }
  return out;
}

function skillsParagraphs(dict: ResumeDict): DocxParagraph[] {
  const out: DocxParagraph[] = [];
  for (const entry of dict.skills) {
    out.push(
      ...entryParagraph(entry.name, entry.level, entry.keywords[0] ?? ''),
      ...metaLine('Level', entry.level),
      ...bulletList(entry.keywords),
    );
  }
  return out;
}

function certificationsParagraphs(dict: ResumeDict): DocxParagraph[] {
  const out: DocxParagraph[] = [];
  for (const entry of dict.certifications) {
    out.push(
      ...entryParagraph(entry.name, entry.issuer, entry.dateText, entry.url),
      ...metaLine('Issuer', entry.issuer),
      ...metaLine('Date', entry.dateText),
      ...urlLine(entry.url),
    );
  }
  return out;
}

/**
 * The dispatch, in the dictionary's own order: a section absent from `dict.sections` is
 * never reached, and a section present in it is emitted exactly once, in that position.
 */
const SECTION_RENDERERS: Readonly<Record<ResumeDictSection, (dict: ResumeDict) => DocxParagraph[]>> =
  Object.freeze({
    contact: contactParagraphs,
    summary: (dict: ResumeDict): DocxParagraph[] => bodyParagraph(dict.summary),
    experience: experienceParagraphs,
    projects: projectsParagraphs,
    education: educationParagraphs,
    skills: skillsParagraphs,
    certifications: certificationsParagraphs,
  });

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * The `docx` `Document` for a dictionary, before packing.
 *
 * Exported so a test can assert the built object exists and a caller has a starting point;
 * the A4 geometry and the styles are asserted from the produced BYTES in `parity.test.ts`,
 * which is the stronger claim because it is the artifact's own geometry rather than the
 * arguments this module passed.
 *
 * A FRESH instance per call, always - see the module header on why a `Document` is not
 * reusable across packs. The return type is `unknown` on purpose: the library's own
 * declarations are the ones declared above this function, and widening them to a vendor's
 * nominal class would be a claim about internals this module does not depend on.
 */
export function buildDocxDocument(dict: ResumeDict): unknown {
  if (dict === null || typeof dict !== 'object') {
    throw new TypeError('buildDocxDocument: a ResumeDict is required');
  }
  const children: DocxParagraph[] = [];
  for (const section of dict.sections) {
    const render = SECTION_RENDERERS[section];
    if (render === undefined) {
      throw new Error(`DOCX_SECTION_UNKNOWN: no renderer for section "${section}"`);
    }
    children.push(...sectionHeading(section), ...render(dict));
  }
  return new Document({
    // Fixed, non-user metadata. A name, a summary or an email must never reach a document
    // property, because properties are read by search indexes and document browsers that
    // never render the body.
    creator: 'Clearance',
    lastModifiedBy: 'Clearance',
    title: 'Resume',
    revision: 1,
    styles: {
      paragraphStyles: PARAGRAPH_STYLES.map((style) => ({ ...style })),
      characterStyles: CHARACTER_STYLES.map((style) => ({ ...style })),
    },
    numbering: {
      config: NUMBERING_CONFIG.map((entry) => ({
        reference: entry.reference,
        levels: entry.levels.map((level) => ({ ...level })),
      })),
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: DOCX_PAGE_WIDTH_TWIPS,
              height: DOCX_PAGE_HEIGHT_TWIPS,
              orientation: 'portrait',
            },
            margin: { ...DOCX_MARGIN_TWIPS },
          },
        },
        children,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/** The two `dcterms` elements `docx@8.5.0` fills from the wall clock. */
const CORE_TIMESTAMP_PATTERN = /(<dcterms:(?:created|modified)\b[^>]*>)[^<]*(<\/dcterms:[^>]*>)/g;

/**
 * Re-emit a produced package with FIXED zip entry dates and FIXED core-property
 * timestamps.
 *
 * Both sources of drift are the library's, not ours: `docx` writes `new Date()` into
 * `docProps/core.xml` and JSZip stamps every entry with the clock, and neither is
 * configurable. Rewriting the archive afterwards is the only way to make the artifact a pure
 * function of the dictionary - which is what the determinism cache, the content-addressed
 * storage key and the row's `hash` all assume.
 *
 * Directory entries are dropped rather than copied: a zip does not require them, and
 * omitting them keeps the entry set a function of the library's own file list.
 */
export function normaliseDocxBytes(bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new TypeError('normaliseDocxBytes: the produced DOCX bytes are required');
  }
  const source = new PizZipCtor(bytes);
  const target = new PizZipCtor();
  for (const name of Object.keys(source.files)) {
    const entry = source.files[name];
    if (entry === null || entry === undefined || entry.dir) continue;
    let content: Buffer = entry.asNodeBuffer();
    if (name === CORE_PROPERTIES_PART) {
      content = Buffer.from(
        content.toString('utf8').replace(CORE_TIMESTAMP_PATTERN, (_match, open: string, close: string) =>
          `${open}${FIXED_TIMESTAMP_ISO}${close}`,
        ),
        'utf8',
      );
    }
    target.file(name, content, { date: new Date(FIXED_ZIP_DATE_MS), binary: true });
  }
  return target.generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
}

// ---------------------------------------------------------------------------
// The two entry points
// ---------------------------------------------------------------------------

/**
 * The PRIMARY path: `ResumeDict -> .docx` bytes, the artifact the route stores.
 *
 * Async because the OOXML packer is, and deterministic because of `normaliseDocxBytes`.
 * Takes the DICTIONARY, not the revision document, for the same reason `latexExport.ts`
 * does: the dictionary is the ONE projection, and this module must not be able to reach a
 * second one.
 *
 * Throws only on a programming error: a non-dictionary argument, or a section outside the
 * closed vocabulary. An EMPTY dictionary is a valid input and yields a well-formed package
 * whose body is empty and whose only section is A4.
 */
export async function renderDocxFromDictionary(dict: ResumeDict): Promise<Buffer> {
  const document = buildDocxDocument(dict);
  const packed = await Packer.toBuffer(document);
  return normaliseDocxBytes(packed);
}

/**
 * The FALLBACK path (ADR-039 decision 2): fill a user-supplied `.docx` template whose
 * placeholders are `{{name}}`, with the dictionary as the scope.
 *
 * The dictionary IS the scope, so `{{contact.name}}` and a `{{#experience}}` loop read the
 * same values, in the same order, as the built-in styles do - one projection, three
 * serialisers. `nullGetter` answers `''` for a placeholder the dictionary does not carry,
 * because a corporate template routinely contains a field a given resume has not filled.
 *
 * NOT REACHED when the caller supplies no template: `renderDocx` never calls this, and the
 * port's DOCX producer never supplies one (ADR-039's primary path is template-free). A test
 * drives the dispatcher with a template that CANNOT be filled and asserts the template-free
 * call still succeeds, which is the only honest way to prove a branch was not taken.
 *
 * `errorLogging` is off: the library's default logger writes template internals to the
 * console, and this module's error surface is the fixed message above plus a reason
 * (policy 9.3/9.4).
 *
 * Refuses a template that is not a zip, or that fails to fill, with `DocxTemplateError`
 * and a FIXED reason. The library's own message names template parts and placeholder tags,
 * so it is never propagated.
 */
export function renderDocxFromTemplate(dict: ResumeDict, template: Buffer): Buffer {
  if (dict === null || typeof dict !== 'object') {
    throw new TypeError('renderDocxFromTemplate: a ResumeDict is required');
  }
  if (!Buffer.isBuffer(template) || template.length === 0) {
    throw new DocxTemplateError('DOCX_TEMPLATE_EMPTY');
  }
  let zip: PizZipArchive;
  try {
    zip = new PizZipCtor(template);
  } catch {
    throw new DocxTemplateError('DOCX_TEMPLATE_NOT_A_ZIP');
  }
  let filled: PizZipArchive;
  try {
    const engine = new DocxtemplaterCtor(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: (): string => '',
      errorLogging: false,
      delimiters: { start: '{{', end: '}}' },
      // See `resolveTemplatePath`: without this a nested tag resolves to nothing at all.
      parser: resolveTemplatePath,
    });
    engine.render(dict as unknown as DocxTemplateScope);
    filled = engine.getZip();
  } catch {
    throw new DocxTemplateError('DOCX_TEMPLATE_FILL_FAILED');
  }
  return normaliseDocxBytes(
    filled.generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
      platform: 'UNIX',
    }),
  );
}

/**
 * The dispatcher: a template when one is supplied, the built-in styles when one is not.
 *
 * `template` is `null` or absent for the primary path. Splitting it from
 * `renderDocxFromDictionary` is what makes "the fallback is not reached when the user
 * supplies no template" a property of the CODE rather than a claim: there is exactly one
 * branch that reads the template, and it is guarded by exactly this test.
 */
export async function renderDocx(request: {
  readonly dict: ResumeDict;
  readonly template?: Buffer | null;
}): Promise<Buffer> {
  if (request === null || typeof request !== 'object') {
    throw new TypeError('renderDocx: a render request is required');
  }
  if (request.template === undefined || request.template === null) {
    return renderDocxFromDictionary(request.dict);
  }
  return renderDocxFromTemplate(request.dict, request.template);
}