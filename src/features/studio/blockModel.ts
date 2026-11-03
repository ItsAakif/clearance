// blockModel.ts - the EDITABLE MODEL over a Resume JSON document (T1050, ADR-037).
//
// Runner-compatible by construction: no React, no JSX, no network, no clock - this is the
// shape the repo's frontend tests can actually assert (ADR-031 decision 3, cf.
// `features/career/claimPresentation.ts`). `StructureEditor.tsx` / `BlockList.tsx` are thin
// views over these functions.
//
// WHAT THIS MODELS. JSON Resume has no "block" entity: a document is a root object of
// arrays. So a "semantic block" here IS one entry of one array (`work[0]`, `skills[2]`, ...)
// or, for `basics`, the whole contact/summary block. Every entry has:
//   - an id, DERIVED from its position (`work:0`). It is stable while the entry stays put
//     and changes when it moves, which is exactly the identity a reorder needs, and it
//     needs no new persisted field: the document schema has no slot for one and inventing
//     one would fork JSON Resume.
//   - the fields the schema allows for that member.
//   - for the members on the CLAIM RAIL, the CLAIM LINKAGE: which `x-clearance` entry owns
//     each text. Without it a reorder could not keep the block honest, which is the whole
//     point (see below).
//
// THE ONE RULE THIS FILE ENFORCES, AND WHY IT IS NOT OPTIONAL.
// `claimBackedTextAt` (backend `resume/json/claimSurface.ts`) walks
// `work[*].highlights[*]` and `projects[*].highlights[*]`; `createRevision` refuses any
// document where such a string is not named, AT THAT EXACT PATH, WITH THAT EXACT TEXT, by an
// `x-clearance` entry whose usage is `verbatim`/`tailored` (`assertClaimBackedTextAccounted`).
// And the read-time gate applies the identical predicate to the STORED bytes.
//
// So a naive editor that reorders `work` and leaves the block alone would be refused at save
// time with a 400 naming a path the user never touched - or, worse, would be accepted with a
// stale block that lies about where its text is. Every mutator here therefore RE-DERIVES the
// paths from the model's own claim linkage, and `serialize` is the single place a document
// and a block are written together. There is no code path that writes one without the other.
//
// WHAT EXCLUDE MEANS, PRECISELY. "Not rendered" is ABSENCE from the document: an excluded
// entry is removed from its array and every claim it carried becomes `usage: 'omitted'` with
// `jsonPath: null` and `renderedText: null`. That is the same vocabulary the projector uses
// for a claim it considered and did not place, so an excluded block reads identically to a
// claim the profile knows about and this resume does not assert - which is the honest state
// (05 sec.6). The removed entry is kept in `StudioModel.excluded` so include can restore it
// verbatim, including its claim linkage; restoring RE-PLACES the claims and RE-DERIVES their
// paths.
//
// WHAT THIS FILE WILL NOT DO. It never writes a claim STATUS. The status in a document is a
// copy of `CareerClaim.status` copied by the projector, and `createRevision` refuses a block
// that disagrees with the rows, so a client that could edit a status would be able to produce
// a document the server rejects (or, in a future where that check moved, forge one). Status
// is read-only here and `assertStatusUnchanged` says so mechanically.

import {
  X_CLEARANCE_KEY,
  type ResumeDocumentJson,
  type StudioCertificateEntry,
  type StudioClearanceBlock,
  type StudioClearanceClaim,
  type StudioClaimUsage,
  type StudioEducationEntry,
  type StudioProjectEntry,
  type StudioSkillEntry,
  type StudioWorkEntry,
} from "@/services/api/studio";

/** The `generatedBy` marker this editor writes. Names the producer, as the projector does. */
export const STUDIO_GENERATOR = "clearance/resume-studio@1";

/**
 * The `x-clearance` key, re-exported from the service module.
 *
 * Re-exported rather than restated: the extension key is the one member name both halves of
 * the feature have to agree on, and a second literal here would be a second thing to keep in
 * step with the schema (`X_CLEARANCE_KEY` in `backend/src/resume/json/jsonresume.ts`).
 */
export { X_CLEARANCE_KEY };

/** The root sections the Studio edits, in DOCUMENT ORDER. */
export const SECTION_KEYS = ["basics", "work", "education", "projects", "skills", "certificates"] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** How a section is labelled in the UI. Never a colour-only distinction. */
export const SECTION_LABELS: Record<SectionKey, string> = {
  basics: "Contact and summary",
  work: "Experience",
  education: "Education",
  projects: "Projects",
  skills: "Skills",
  certificates: "Certifications",
};

/** The array members that hold one entry per block. `basics` is a single block. */
export const LIST_SECTIONS: readonly Exclude<SectionKey, "basics">[] = [
  "work",
  "education",
  "projects",
  "skills",
  "certificates",
];

// ---------------------------------------------------------------------------
// The inline rich-text value
// ---------------------------------------------------------------------------

/** The marks the inline primitive supports. Exactly three; see ADR-037 item 2. */
export const INLINE_MARKS = ["bold", "italic", "link"] as const;
export type InlineMark = (typeof INLINE_MARKS)[number];

/** One styled span of the inline value. `marks` is ABSENT for unmarked text, not `[]`. */
export interface InlineRun {
  text: string;
  marks?: InlineMark[];
}

/**
 * The inline rich-text VALUE (ADR-037 item 2): `{format:"inline-v1", runs:[{text, marks}]}`.
 *
 * IT IS AN EDITING REPRESENTATION, NOT A DOCUMENT SHAPE, and the difference is load-bearing.
 * The members it edits - `basics.summary`, `work[].summary`, `highlights[]`, `skills[].name`,
 * `projects[].description` - are `type: 'string'` in the JSON Resume schema
 * (`backend/src/resume/json/validate.ts`), so storing an object there would make every
 * document the Studio saved INVALID. The document therefore carries the value's plain text
 * (`plainText`), and the runs are what the editor holds in component state so a user can bold
 * or link part of a sentence. `plainTextToInline` and `inlineToPlainText` are the exact
 * round trip, and both are tested - including that the round trip is lossless for
 * unmarked text, which is what every claim-backed highlight is.
 */
export interface InlineValue {
  format: "inline-v1";
  runs: InlineRun[];
}

/** Wrap plain text as an inline value. Marked runs are impossible, so the result is a single run. */
export function plainTextToInline(text: string): InlineValue {
  return { format: "inline-v1", runs: [{ text }] };
}

/**
 * The text a document member carries: the runs concatenated in order.
 *
 * Empty when there are no runs, so an emptied field serialises to `""` rather than to
 * `undefined` - and the callers DROP an empty optional member rather than storing a blank.
 */
export function inlineToPlainText(value: InlineValue): string {
  return value.runs.map((run) => run.text).join("");
}

/** Read an inline value back from plain text. The inverse of `inlineToPlainText`. */
export function inlineFromPlainText(text: string): InlineValue {
  return plainTextToInline(text);
}

/**
 * Merge adjacent runs that carry the same marks.
 *
 * A caret that moves across a bold boundary and back produces `a`, `b`, `a`; without this the
 * value would grow a run per keystroke and `jsonHash` would change for a document whose
 * TEXT did not change. Two documents that read identically must serialise identically, or
 * the revision identity stops meaning anything.
 */
export function normalizeInlineValue(value: InlineValue): InlineValue {
  const runs: InlineRun[] = [];
  for (const run of value.runs) {
    if (run.text.length === 0) continue;
    const marks = normalizeMarks(run.marks);
    const previous = runs[runs.length - 1];
    if (previous && sameMarks(previous.marks, marks)) {
      previous.text += run.text;
      continue;
    }
    runs.push(marks.length === 0 ? { text: run.text } : { text: run.text, marks });
  }
  return { format: "inline-v1", runs };
}

function normalizeMarks(marks: readonly InlineMark[] | undefined): InlineMark[] {
  if (!Array.isArray(marks)) return [];
  // Sorted and de-duplicated: `['bold','bold']` and `['bold']` are the same text and must
  // produce the same bytes, or toggling a mark twice would change the hash.
  const unique = [...new Set(marks.filter((mark): mark is InlineMark => INLINE_MARKS.includes(mark)))];
  return unique.sort();
}

function sameMarks(a: readonly InlineMark[] | undefined, b: readonly InlineMark[]): boolean {
  const left = a ?? [];
  if (left.length !== b.length) return false;
  return left.every((mark, index) => mark === b[index]);
}

/** Add a mark to a run if absent, remove it if present. Never leaves a duplicate. */
export function toggleRunMark(run: InlineRun, mark: InlineMark): InlineRun {
  const marks = normalizeMarks(run.marks);
  const next = marks.includes(mark) ? marks.filter((entry) => entry !== mark) : [...marks, mark].sort();
  return next.length === 0 ? { text: run.text } : { text: run.text, marks: next };
}

/** Apply a mark across a half-open run range. Used by the toolbar over the current selection. */
export function applyMarkToRange(value: InlineValue, from: number, to: number, mark: InlineMark): InlineValue {
  if (to <= from) return value;
  const runs: InlineRun[] = [];
  let offset = 0;
  for (const run of value.runs) {
    const start = offset;
    const end = offset + run.text.length;
    offset = end;
    if (end <= from || start >= to) {
      runs.push(run);
      continue;
    }
    const head = run.text.slice(0, Math.max(0, from - start));
    const tail = run.text.slice(Math.max(0, to - start));
    const middle = run.text.slice(Math.max(0, from - start), Math.max(0, to - start));
    if (head.length > 0) runs.push(withText(run, head));
    if (middle.length > 0) runs.push(toggleRunMark({ ...run, text: middle }, mark));
    if (tail.length > 0) runs.push(withText(run, tail));
  }
  return normalizeInlineValue({ format: "inline-v1", runs });
}

function withText(run: InlineRun, text: string): InlineRun {
  return run.marks === undefined ? { text } : { text, marks: [...run.marks] };
}

/**
 * Split runs at a character OFFSET, so a caret position can be represented.
 *
 * The primitive edits by caret offset rather than by DOM range because a range is a live
 * object and an offset is data: a run list built from offsets is reproducible in a
 * node-environment test, which is the only place this logic is asserted.
 */
export function splitRunsAt(value: InlineValue, offset: number): InlineRun[] {
  const runs: InlineRun[] = [];
  let position = 0;
  for (const run of value.runs) {
    const end = position + run.text.length;
    if (offset <= position || offset >= end) {
      runs.push(run);
      position = end;
      continue;
    }
    const cut = offset - position;
    runs.push(withText(run, run.text.slice(0, cut)));
    runs.push(withText(run, run.text.slice(cut)));
    position = end;
  }
  return runs;
}

/** The caret offset at the START of a run index, plus the total length. */
export function runOffsets(runs: readonly InlineRun[]): Array<{ index: number; start: number; end: number }> {
  const out: Array<{ index: number; start: number; end: number }> = [];
  let position = 0;
  runs.forEach((run, index) => {
    out.push({ index, start: position, end: position + run.text.length });
    position += run.text.length;
  });
  return out;
}

// ---------------------------------------------------------------------------
// The editable model
// ---------------------------------------------------------------------------

/** One highlighted statement: a claim's text, plus the claim that backs it. */
export interface RailText {
  claimId: string;
  text: string;
  /** `verbatim` until the user re-words it, which is `tailored` (05 sec.6.3). */
  usage: Extract<StudioClaimUsage, "verbatim" | "tailored">;
}

export interface BasicsBlock {
  id: "basics";
  name: string;
  label: string;
  email: string;
  phone: string;
  url: string;
  summary: string;
  location: string;
}

export interface WorkBlock {
  id: string;
  name: string;
  position: string;
  url: string;
  startDate: string;
  endDate: string;
  summary: string;
  highlights: RailText[];
}

export interface EducationBlock {
  id: string;
  institution: string;
  area: string;
  studyType: string;
  startDate: string;
  endDate: string;
  url: string;
}

export interface ProjectBlock {
  id: string;
  name: string;
  description: string;
  url: string;
  startDate: string;
  endDate: string;
  roles: string[];
  keywords: string[];
  highlights: RailText[];
}

export interface SkillBlock {
  id: string;
  name: string;
  level: string;
  keywords: string[];
}

export interface CertificateBlock {
  id: string;
  name: string;
  date: string;
  issuer: string;
  url: string;
}

export type AnyBlock =
  | BasicsBlock
  | WorkBlock
  | EducationBlock
  | ProjectBlock
  | SkillBlock
  | CertificateBlock;

// deslop-ignore-next-line 09 — a conditional TYPE, not decorative strike-through text.
export type BlockOf<S extends SectionKey> = S extends "basics"
  ? BasicsBlock
  : S extends "work"
    ? WorkBlock
    : S extends "education"
      ? EducationBlock
      : S extends "projects"
        ? ProjectBlock
        : S extends "skills"
          ? SkillBlock
          : CertificateBlock;

/** A block the user excluded, kept so include can restore it verbatim. */
export interface ExcludedBlock {
  section: Exclude<SectionKey, "basics">;
  block: AnyBlock;
  /** The claim entries that were placed inside it, captured BEFORE they were omitted. */
  claims: StudioClearanceClaim[];
}

export interface StudioModel {
  basics: BasicsBlock;
  work: WorkBlock[];
  education: EducationBlock[];
  projects: ProjectBlock[];
  skills: SkillBlock[];
  certificates: CertificateBlock[];
  /** The claim entries as the server last wrote them. Statuses are never edited here. */
  claims: StudioClearanceClaim[];
  /** Block-level identity of the block itself: `version`, `generatedBy`, `profileId`, counts. */
  block: Omit<StudioClearanceBlock, "claims">;
  /** Excluded blocks, newest last. Not part of the document. */
  excluded: ExcludedBlock[];
}

// ---------------------------------------------------------------------------
// Reading a document into the model
// ---------------------------------------------------------------------------

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function blockId(section: Exclude<SectionKey, 'basics'>, index: number): string {
  return `${section}:${index}`;
}

/**
 * The claim entry that names `path`, or `null`.
 *
 * The lookup is BY PATH, never by text: two claims can carry identical text (the same
 * achievement imported twice), and matching on it would let an edit relabel one as the
 * other - which is the forging hole `deriveUsageFromDocument`'s comment describes.
 */
function claimAtPath(claims: readonly StudioClearanceClaim[], path: string): StudioClearanceClaim | null {
  return claims.find((entry) => entry.jsonPath === path) ?? null;
}

/**
 * The claim rail text of one entry, as the model holds it.
 *
 * A highlight that NO entry names is DROPPED, not adopted. This is the belt's rule read in
 * the editor direction: such a document cannot be saved (`assertClaimBackedTextAccounted`
 * refuses it) and it cannot be rendered either, so the editor shows it as absent rather than
 * offering to save a document the server will reject. `unaccountedText` reports the paths it
 * dropped so the UI can say so out loud instead of silently losing a line.
 */
function railTexts(
  section: 'work' | 'projects',
  entryIndex: number,
  highlights: readonly string[],
  claims: readonly StudioClearanceClaim[],
): { texts: RailText[]; unaccounted: string[] } {
  const texts: RailText[] = [];
  const unaccounted: string[] = [];
  highlights.forEach((value, highlightIndex) => {
    const path = `${section}[${entryIndex}].highlights[${highlightIndex}]`;
    const entry = claimAtPath(claims, path);
    if (!entry || entry.usage === 'omitted' || typeof entry.renderedText !== 'string') {
      unaccounted.push(path);
      return;
    }
    texts.push({
      claimId: entry.claimId,
      text: value,
      usage: entry.usage === 'tailored' ? 'tailored' : 'verbatim',
    });
  });
  return { texts, unaccounted };
}

/** Read a document into the editable model. Tolerant: a malformed member becomes empty. */
export function modelFromDocument(document: ResumeDocumentJson | null | undefined): StudioModel {
  const source = record(document);
  const basics = record(source.basics);
  const block = record(source[X_CLEARANCE_KEY]);
  const claims: StudioClearanceClaim[] = Array.isArray(block.claims)
    ? (block.claims as StudioClearanceClaim[])
    : [];

  const location = record(basics.location);
  const basicsBlock: BasicsBlock = {
    id: 'basics',
    name: text(basics.name),
    label: text(basics.label),
    email: text(basics.email),
    phone: text(basics.phone),
    url: text(basics.url),
    summary: text(basics.summary),
    location: text(location.city) || text(location.address) || text(location.region),
  };

  const work: WorkBlock[] = (Array.isArray(source.work) ? source.work : []).map((raw, index) => {
    const entry = record(raw);
    const { texts } = railTexts('work', index, stringList(entry.highlights), claims);
    return {
      id: blockId('work', index),
      name: text(entry.name),
      position: text(entry.position),
      url: text(entry.url),
      startDate: text(entry.startDate),
      endDate: text(entry.endDate),
      summary: text(entry.summary),
      highlights: texts,
    };
  });

  const education: EducationBlock[] = (Array.isArray(source.education) ? source.education : []).map(
    (raw, index) => {
      const entry = record(raw);
      return {
        id: blockId('education', index),
        institution: text(entry.institution),
        area: text(entry.area),
        studyType: text(entry.studyType),
        startDate: text(entry.startDate),
        endDate: text(entry.endDate),
        url: text(entry.url),
      };
    },
  );

  const projects: ProjectBlock[] = (Array.isArray(source.projects) ? source.projects : []).map(
    (raw, index) => {
      const entry = record(raw);
      const { texts } = railTexts('projects', index, stringList(entry.highlights), claims);
      return {
        id: blockId('projects', index),
        name: text(entry.name),
        description: text(entry.description),
        url: text(entry.url),
        startDate: text(entry.startDate),
        endDate: text(entry.endDate),
        roles: stringList(entry.roles),
        keywords: stringList(entry.keywords),
        highlights: texts,
      };
    },
  );

  const skills: SkillBlock[] = (Array.isArray(source.skills) ? source.skills : []).map((raw, index) => {
    const entry = record(raw);
    return {
      id: blockId('skills', index),
      name: text(entry.name),
      level: text(entry.level),
      keywords: stringList(entry.keywords),
    };
  });

  const certificates: CertificateBlock[] = (
    Array.isArray(source.certificates) ? source.certificates : []
  ).map((raw, index) => {
    const entry = record(raw);
    return {
      id: blockId('certificates', index),
      name: text(entry.name),
      date: text(entry.date),
      issuer: text(entry.issuer),
      url: text(entry.url),
    };
  });

  return {
    basics: basicsBlock,
    work,
    education,
    projects,
    skills,
    certificates,
    claims,
    block: {
      version: typeof block.version === 'number' ? block.version : 1,
      generatedBy: typeof block.generatedBy === 'string' ? block.generatedBy : STUDIO_GENERATOR,
      sourceModelVersion: typeof block.sourceModelVersion === 'number' ? block.sourceModelVersion : 2,
      profileId: text(block.profileId),
      claimCount: 0,
      confirmedClaimCount: 0,
      unconfirmedClaimCount: 0,
    },
    excluded: [],
  };
}

// ---------------------------------------------------------------------------
// The editors
// ---------------------------------------------------------------------------

export type Editor = (model: StudioModel) => StudioModel;

/** The rail entries an editor touched, so callers can record `changes` for the diff log. */
export interface RailChange {
  claimId: string;
  path: string;
  text: string;
  usage: 'verbatim' | 'tailored';
  previousText: string;
  previousUsage: 'verbatim' | 'tailored';
}

/**
 * Edit one inline value and derive what changed on the CLAIM RAIL.
 *
 * Two rules, both from `assertClaimBackedTextAccounted`:
 *   1. the document's string and the block's `renderedText` must stay IDENTICAL (both are
 *      compared after trimming), so the change is applied to the block in the same pass;
 *   2. a re-worded claim is `tailored`, not `verbatim` (05 sec.6.3: tailoring may re-phrase a
 *      confirmed claim's text, never introduce a fact). It is never a NEW usage value - the
 *      server's vocabulary has exactly three and inventing a fourth would be refused.
 *
 * An edit to BLANK text omits the claim instead of writing an empty string: the server
 * refuses a gated usage whose rendered text is blank, and a blank bullet is not a rendering
 * of anything.
 */
export function editInlineValue(
  model: StudioModel,
  change: { section: 'work' | 'projects'; blockId: string; highlightIndex: number; value: InlineValue },
): { model: StudioModel; change: RailChange | null } {
  const value = normalizeInlineValue(change.value);
  const plain = inlineToPlainText(value).trim();
  const list = model[change.section] as Array<WorkBlock | ProjectBlock>;
  const blockIndex = list.findIndex((entry) => entry.id === change.blockId);
  if (blockIndex < 0) return { model, change: null };
  const block = list[blockIndex];
  const rail = block.highlights[change.highlightIndex];
  if (!rail) return { model, change: null };

  const nextUsage = plain === rail.text ? rail.usage : 'tailored';
  const nextList = [...list];
  const nextBlock = {
    ...block,
    highlights: block.highlights.map((entry, index) =>
      index === change.highlightIndex ? { ...entry, text: plain, usage: nextUsage } : entry,
    ),
  };
  nextList[blockIndex] = nextBlock;

  const nextModel: StudioModel = { ...model, [change.section]: nextList } as StudioModel;
  const railChange: RailChange = {
    claimId: rail.claimId,
    // The path is re-derived by `serialize`; the value here is the PREVIOUS one, used only
    // as the `before` of the diff-log entry.
    path: `${change.section}[${blockIndex}].highlights[${change.highlightIndex}]`,
    text: plain,
    usage: nextUsage,
    previousText: rail.text,
    previousUsage: rail.usage,
  };
  return {
    model: {
      ...nextModel,
      claims: applyRailUsage(nextModel.claims, rail.claimId, plain, nextUsage),
    },
    change: railChange,
  };
}

/** The model's own block entries, patched for one claim. Status/kind/provenance untouched. */
function applyRailUsage(
  claims: readonly StudioClearanceClaim[],
  claimId: string,
  text: string,
  usage: 'verbatim' | 'tailored' | 'omitted',
): StudioClearanceClaim[] {
  return claims.map((entry) => {
    if (entry.claimId !== claimId) return entry;
    if (usage === 'omitted') return { ...entry, usage, jsonPath: null, renderedText: null };
    return { ...entry, usage, renderedText: text };
  });
}

/**
 * Move a block within its section.
 *
 * Out-of-range indices are a NO-OP rather than a clamp: a clamp would silently move the WRONG
 * block, and a reorder that moved something the user did not name is worse than one that did
 * nothing. The ids are re-stamped on serialize, so a move is expressed purely as a new order.
 */
export function reorderBlock(
  model: StudioModel,
  section: Exclude<SectionKey, 'basics'>,
  from: number,
  to: number,
): StudioModel {
  const list = model[section] as AnyBlock[];
  if (
    !Array.isArray(list) ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    from >= list.length ||
    to >= list.length ||
    from === to
  ) {
    return model;
  }
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return { ...model, [section]: next } as StudioModel;
}

/**
 * Exclude a block: it leaves the document and its claims become `omitted`.
 *
 * The claim entries are captured on the way out (with the paths they had) so include can
 * restore the exact linkage; `serialize` re-derives the paths anyway, so a restore after a
 * reorder still lands correctly rather than resurrecting a stale path.
 */
export function excludeBlock(model: StudioModel, section: Exclude<SectionKey, 'basics'>, index: number): StudioModel {
  const list = model[section] as AnyBlock[];
  if (!Array.isArray(list) || index < 0 || index >= list.length) return model;
  const block = list[index];
  const paths = railPathsFor(section, index, block);
  const claims = paths.map((path) => claimAtPath(model.claims, path)).filter((entry): entry is StudioClearanceClaim => entry !== null);
  const next = [...list];
  next.splice(index, 1);
  const omitted = new Set(claims.map((entry) => entry.claimId));
  return {
    ...model,
    [section]: next,
    claims: model.claims.map((entry) =>
      omitted.has(entry.claimId) ? { ...entry, usage: 'omitted', jsonPath: null, renderedText: null } : entry,
    ),
    excluded: [...model.excluded, { section, block, claims }],
  } as StudioModel;
}

/** Include a previously excluded block back into its section. */
export function includeBlock(model: StudioModel, index: number): StudioModel {
  const entry = model.excluded[index];
  if (!entry) return model;
  const list = [...(model[entry.section] as AnyBlock[])];
  list.push(entry.block);
  const omitted = new Set(entry.claims.map((claim) => claim.claimId));
  const restored = new Set<string>();
  return {
    ...model,
    [entry.section]: list,
    claims: model.claims.map((claim) => {
      if (!omitted.has(claim.claimId) || restored.has(claim.claimId)) return claim;
      restored.add(claim.claimId);
      // The usage and text come from the capture; the PATH is re-derived on serialize, so it
      // is left null here rather than resurrected at its old index.
      return { ...claim, usage: claim.usage === 'tailored' ? 'tailored' : 'verbatim', jsonPath: null, renderedText: claim.renderedText };
    }),
    excluded: model.excluded.filter((_, position) => position !== index),
  } as StudioModel;
}

/** Forget an excluded block entirely (its claims stay `omitted`). */
export function discardExcluded(model: StudioModel, index: number): StudioModel {
  if (!model.excluded[index]) return model;
  return { ...model, excluded: model.excluded.filter((_, position) => position !== index) };
}

/** Add an empty block of `section`. The schema's required members are pre-filled. */
export function addBlock(model: StudioModel, section: Exclude<SectionKey, 'basics'>): StudioModel {
  const id = `${section}:new-${(model[section] as AnyBlock[]).length}`;
  const block: AnyBlock =
    section === 'work'
      ? { id, name: '', position: '', url: '', startDate: '', endDate: '', summary: '', highlights: [] }
      : section === 'education'
        ? { id, institution: '', area: '', studyType: '', startDate: '', endDate: '', url: '' }
        : section === 'projects'
          ? { id, name: '', description: '', url: '', startDate: '', endDate: '', roles: [], keywords: [], highlights: [] }
          : section === 'skills'
            ? { id, name: '', level: '', keywords: [] }
            : { id, name: '', date: '', issuer: '', url: '' };
  return { ...model, [section]: [...(model[section] as AnyBlock[]), block] } as StudioModel;
}

/** Set one string field of one block. The ONLY way a non-rail field changes. */
export function setBlockField(
  model: StudioModel,
  section: SectionKey,
  blockId: string,
  field: string,
  value: string,
): StudioModel {
  if (section === 'basics') {
    if (blockId !== 'basics') return model;
    return { ...model, basics: { ...model.basics, [field]: value } } as StudioModel;
  }
  const list = model[section] as AnyBlock[];
  const index = list.findIndex((entry) => entry.id === blockId);
  if (index < 0) return model;
  const next = [...list];
  next[index] = { ...list[index], [field]: value } as AnyBlock;
  return { ...model, [section]: next } as StudioModel;
}

/** Set a list-of-strings field of one block (`roles`, `keywords`). */
export function setBlockList(
  model: StudioModel,
  section: Exclude<SectionKey, 'basics'>,
  blockId: string,
  field: 'roles' | 'keywords',
  value: readonly string[],
): StudioModel {
  const list = model[section] as AnyBlock[];
  const index = list.findIndex((entry) => entry.id === blockId);
  if (index < 0) return model;
  const next = [...list];
  next[index] = { ...list[index], [field]: [...value] } as AnyBlock;
  return { ...model, [section]: next } as StudioModel;
}

function railPathsFor(
  section: Exclude<SectionKey, 'basics'>,
  index: number,
  block: AnyBlock,
): string[] {
  const highlights = (block as Partial<WorkBlock & ProjectBlock>).highlights ?? [];
  return highlights.map((_, highlightIndex) => `${section}[${index}].highlights[${highlightIndex}]`);
}

// ---------------------------------------------------------------------------
// Writing the document back
// ---------------------------------------------------------------------------

function optional(target: Record<string, unknown>, key: string, value: string): void {
  if (value.length > 0) target[key] = value;
}

/**
 * The document and its block, written TOGETHER.
 *
 * This is the only place either is produced, and the paths are DERIVED here - never carried
 * from the model, never remembered. That is what makes a reorder safe: `work[0]` becoming
 * `work[1]` is invisible to the model (it holds no paths at all) and is handled exactly once,
 * here, by walking the arrays in their final order.
 *
 * The claim rail is enumerated in INDEX order and each entry is matched by CLAIM ID - the
 * linkage the model owns - so a claim can never end up naming another claim's slot.
 *
 * `serialize` takes NO template and no layout input of any kind. That is the mechanism behind
 * "a template switch changes the layout without changing the resume JSON hash": the template
 * is not a parameter, so it cannot reach the document.
 */
export function serialize(model: StudioModel): ResumeDocumentJson {
  const document: Record<string, unknown> = {};

  const basics: Record<string, unknown> = { name: model.basics.name };
  optional(basics, 'label', model.basics.label);
  optional(basics, 'email', model.basics.email);
  optional(basics, 'phone', model.basics.phone);
  optional(basics, 'url', model.basics.url);
  optional(basics, 'summary', model.basics.summary);
  if (model.basics.location.length > 0) basics.location = { city: model.basics.location };
  document.basics = basics;

  if (model.work.length > 0) {
    document.work = model.work.map((block) => {
      const entry: Record<string, unknown> = { name: block.name, position: block.position };
      optional(entry, 'url', block.url);
      optional(entry, 'startDate', block.startDate);
      optional(entry, 'endDate', block.endDate);
      optional(entry, 'summary', block.summary);
      // Blank statements are DROPPED, not written as `''`. A blank string is not a rendering
      // of anything (`recordClaimUsages` refuses a gated usage with no text, and
      // `claimBackedTextAt` skips empty strings), so the projector never emits one either.
      const highlights = block.highlights.filter((rail) => rail.text.length > 0);
      if (highlights.length > 0) {
        entry.highlights = highlights.map((rail) => rail.text);
      }
      return entry as unknown as StudioWorkEntry;
    });
  }

  if (model.education.length > 0) {
    document.education = model.education.map((block) => {
      const entry: Record<string, unknown> = { institution: block.institution };
      optional(entry, 'area', block.area);
      optional(entry, 'studyType', block.studyType);
      optional(entry, 'startDate', block.startDate);
      optional(entry, 'endDate', block.endDate);
      optional(entry, 'url', block.url);
      return entry as unknown as StudioEducationEntry;
    });
  }

  if (model.projects.length > 0) {
    document.projects = model.projects.map((block) => {
      const entry: Record<string, unknown> = { name: block.name };
      optional(entry, 'description', block.description);
      optional(entry, 'url', block.url);
      optional(entry, 'startDate', block.startDate);
      optional(entry, 'endDate', block.endDate);
      if (block.roles.length > 0) entry.roles = [...block.roles];
      if (block.keywords.length > 0) entry.keywords = [...block.keywords];
      const highlights = block.highlights.filter((rail) => rail.text.length > 0);
      if (highlights.length > 0) {
        entry.highlights = highlights.map((rail) => rail.text);
      }
      return entry as unknown as StudioProjectEntry;
    });
  }

  if (model.skills.length > 0) {
    document.skills = model.skills.map((block) => {
      const entry: Record<string, unknown> = { name: block.name };
      optional(entry, 'level', block.level);
      if (block.keywords.length > 0) entry.keywords = [...block.keywords];
      return entry as unknown as StudioSkillEntry;
    });
  }

  if (model.certificates.length > 0) {
    document.certificates = model.certificates.map((block) => {
      const entry: Record<string, unknown> = { name: block.name };
      optional(entry, 'date', block.date);
      optional(entry, 'issuer', block.issuer);
      optional(entry, 'url', block.url);
      return entry as unknown as StudioCertificateEntry;
    });
  }

  const placed = new Map<string, { path: string; text: string; usage: 'verbatim' | 'tailored' }>();
  const railPath = (section: 'work' | 'projects', index: number, block: WorkBlock | ProjectBlock): void => {
    block.highlights.forEach((rail, highlightIndex) => {
      if (rail.text.length === 0) return;
      placed.set(rail.claimId, {
        path: `${section}[${index}].highlights[${highlightIndex}]`,
        text: rail.text,
        usage: rail.usage,
      });
    });
  };
  model.work.forEach((block, index) => railPath('work', index, block));
  model.projects.forEach((block, index) => railPath('projects', index, block));

  // `basics.summary` is on the claim rail too (ADR-043 R-SUMMARY, closed by T1080). It is a
  // single string with no index, so it is placed here rather than by `railPath`. The linkage
  // lives on the claim entry the projector wrote; when the user rewrites the sentence the
  // usage becomes `tailored`, exactly as a reworded highlight does. Without this line the
  // Studio would serialize the summary text while declaring its claim `omitted`, and
  // `createRevision` would refuse the document as claim-backed text the block does not name.
  const summaryEntry = model.claims.find((entry) => entry.jsonPath === 'basics.summary');
  if (summaryEntry && model.basics.summary.trim().length > 0) {
    const unchanged = (summaryEntry.renderedText ?? '').trim() === model.basics.summary.trim();
    placed.set(summaryEntry.claimId, {
      path: 'basics.summary',
      text: model.basics.summary,
      usage: summaryEntry.usage === 'tailored' || !unchanged ? 'tailored' : 'verbatim',
    });
  }

  // Every claim the block named stays in it, INCLUDING the ones an excluded block took with
  // it: the block is the document's account of what the projection considered, and "the
  // profile knows this and the resume does not say it" is exactly what a reviewer needs.
  const claims = model.claims.map((entry) => {
    const placement = placed.get(entry.claimId);
    if (!placement) {
      return { ...entry, usage: 'omitted', jsonPath: null, renderedText: null };
    }
    return { ...entry, usage: placement.usage, jsonPath: placement.path, renderedText: placement.text };
  });

  const confirmed = claims.filter((entry) => entry.status === 'user_confirmed').length;
  document[X_CLEARANCE_KEY] = {
    ...model.block,
    generatedBy: STUDIO_GENERATOR,
    claimCount: claims.length,
    confirmedClaimCount: confirmed,
    unconfirmedClaimCount: claims.length - confirmed,
    claims,
  };

  return document as unknown as ResumeDocumentJson;
}

// ---------------------------------------------------------------------------
// Canonical serialisation (the same rule the server hashes)
// ---------------------------------------------------------------------------

/**
 * `JSON.stringify` with object keys in ascending code-unit order, at every depth.
 *
 * A MIRROR of `canonicalJsonString` in `backend/src/resume/json/jsonresume.ts`, and it has
 * to be a mirror rather than `JSON.stringify`: the Studio shows the user WHICH document they
 * are editing (its hash) before the server has confirmed a revision, and a key order that
 * depended on insertion order would make two identical documents look different.
 *
 * The hash itself is NOT computed here. `crypto.subtle` is async and unavailable in this
 * runner; the server's `jsonHash` is the authority and the Studio displays the revision's own
 * hash after each save. What is asserted here is the BYTES: `canonicalJsonString(a) ===
 * canonicalJsonString(b)` exactly when `a` and `b` are the same document.
 */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : canonicalize(entry)));
  if (typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const member = source[key];
    if (member === undefined) continue;
    out[key] = canonicalize(member);
  }
  return out;
}

/** The bytes the revision's `jsonHash` is computed over. What the Studio calls "the document". */
export function documentBytes(model: StudioModel): string {
  return canonicalJsonString(serialize(model));
}

// ---------------------------------------------------------------------------
// The invariants, as assertions a caller (and a test) can run
// ---------------------------------------------------------------------------

/**
 * Every non-empty string on the claim rail is named, at that exact path, with that exact
 * text, by an `x-clearance` entry whose usage is gated.
 *
 * This is the belt's rule (`claimBackedTextAt` + `assertClaimBackedTextAccounted`) restated
 * in the frontend, and it exists for a reason beyond tidiness: `createRevision` refuses a
 * document that fails it, so an editor that could produce one would show a green save for a
 * 400. The Studio calls this before saving and refuses to save if it fails, naming the path -
 * the same shape as the server's refusal, so the message a user reads is the same either way.
 */
export function unaccountedText(document: ResumeDocumentJson): string[] {
  const block = (document as unknown as Record<string, unknown>)[X_CLEARANCE_KEY] as
    | { claims?: StudioClearanceClaim[] }
    | undefined;
  const declared = (block?.claims ?? []).filter(
    (entry) => entry.usage === 'verbatim' || entry.usage === 'tailored',
  );
  const out: string[] = [];
  const check = (section: 'work' | 'projects'): void => {
    const entries = (document as unknown as Record<string, unknown>)[section];
    if (!Array.isArray(entries)) return;
    entries.forEach((raw, index) => {
      const highlights = record(raw).highlights;
      if (!Array.isArray(highlights)) return;
      highlights.forEach((value, highlightIndex) => {
        if (typeof value !== 'string' || value.trim().length === 0) return;
        const path = `${section}[${index}].highlights[${highlightIndex}]`;
        const named = declared.some(
          (entry) =>
            entry.jsonPath === path &&
            (entry.renderedText ?? '').trim() === value.trim(),
        );
        if (!named) out.push(path);
      });
    });
  };
  check('work');
  check('projects');
  // ADR-043 R-SUMMARY: the professional summary is claim-backed text. The server's belt
  // walks `basics.summary` too, so the editor's pre-save guard must see the same surface.
  const basics = record((document as unknown as Record<string, unknown>).basics);
  const summary = typeof basics.summary === 'string' ? basics.summary.trim() : '';
  if (summary.length > 0) {
    const named = declared.some(
      (entry) =>
        entry.jsonPath === 'basics.summary' &&
        (entry.renderedText ?? '').trim() === summary,
    );
    if (!named) out.push('basics.summary');
  }
  return out;
}

/**
 * No claim is named twice by the block.
 *
 * `assertOneUsagePerClaimId` refuses a block like this, and the reason matters: two entries
 * for one claim collapse to ONE `ResumeClaimUsage` row (first entry wins), so the recorded
 * usage would depend on entry order.
 */
export function duplicateClaimIds(document: ResumeDocumentJson): string[] {
  const block = (document as unknown as Record<string, unknown>)[X_CLEARANCE_KEY] as
    | { claims?: StudioClearanceClaim[] }
    | undefined;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of block?.claims ?? []) {
    if (seen.has(entry.claimId)) duplicates.add(entry.claimId);
    seen.add(entry.claimId);
  }
  return [...duplicates];
}

/** Whether the document is one the server will accept. Every reason, not the first. */
export function documentProblems(document: ResumeDocumentJson): string[] {
  const problems = unaccountedText(document).map(
    (path) => `${path} is not named by any claim in the x-clearance block`,
  );
  for (const claimId of duplicateClaimIds(document)) {
    problems.push(`the x-clearance block names claim ${claimId} more than once`);
  }
  return problems;
}

/**
 * Every claim's STATUS is exactly what the server's revision said.
 *
 * The forgery check. `createRevision` refuses a block whose status disagrees with the
 * `CareerClaim` rows (`CLEARANCE_DISAGREES_WITH_CLAIMS`), and that refusal exists so a client
 * cannot hand the audit trail a status the database does not hold. This makes the Studio's
 * half of the same promise checkable without a server: the editor may re-word, re-order,
 * include and exclude, and it may not touch a status.
 */
export function assertStatusUnchanged(before: readonly StudioClearanceClaim[], after: readonly StudioClearanceClaim[]): void {
  const statusByClaim = new Map(before.map((entry) => [entry.claimId, entry.status]));
  for (const entry of after) {
    const original = statusByClaim.get(entry.claimId);
    if (original === undefined) {
      throw new Error(`blockModel: the document names claim ${entry.claimId}, which the saved revision did not`);
    }
    if (original !== entry.status) {
      throw new Error(
        `blockModel: claim ${entry.claimId} claims status ${entry.status} but the revision recorded ${original}; a status is server truth and the Studio does not write one`,
      );
    }
  }
}

/** How many claim-backed statements the document actually places. The preview's guarantee line. */
export function placedClaimCount(document: ResumeDocumentJson): number {
  const block = (document as unknown as Record<string, unknown>)[X_CLEARANCE_KEY] as
    | { claims?: StudioClearanceClaim[] }
    | undefined;
  return (block?.claims ?? []).filter(
    (entry) => (entry.usage === 'verbatim' || entry.usage === 'tailored') && (entry.jsonPath !== null),
  ).length;
}

/** How many of those are placed on a claim that is NOT confirmed. Shown as a warning, not a hide. */
export function unconfirmedPlacedCount(document: ResumeDocumentJson): number {
  const block = (document as unknown as Record<string, unknown>)[X_CLEARANCE_KEY] as
    | { claims?: StudioClearanceClaim[] }
    | undefined;
  return (block?.claims ?? []).filter(
    (entry) =>
      (entry.usage === 'verbatim' || entry.usage === 'tailored') &&
      entry.status !== 'user_confirmed',
  ).length;
}