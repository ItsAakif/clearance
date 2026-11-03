// The ONE shared render dictionary - the engine-neutral projection every serialiser reads.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 5
//                 .planning/decisions/ADR-044-render-transport-storage-and-phase-split.md D3
//                 .planning/specs/clearance-v2/render-sandbox-policy.md 5.4 / 7.4 / 8.4
//                 04-technology-comparison.md D.4 ("exactly one shared adapter")
// Task:         T1040
//
// WHAT THIS IS, AND WHY IT IS THE ONLY ONE. ADR-044 D3: a flat, always-fully-populated
// dictionary with pre-formatted dates and a `sections[]` render order, consumed by Typst
// (as `data.json`), by the DOCX renderer (T1041) and by the `.tex`/`.json` export
// (T1044). Three serialisers, one projection - which is how 07 Phase 4 (a) "the same
// content in the same order in every output" becomes a structural property rather than
// three implementations agreeing by hand. The file this replaces,
// `_shared/resume_json_to_typst.ts`, is RETIRED: a Typst-shaped projection would have
// made the other two engines a consumer of a Typst module.
//
// THE FOUR RULES THAT MAKE A TEMPLATE WRITABLE, in order of how often they are forgotten:
//
//  1. EVERY DECLARED KEY IS ALWAYS PRESENT, with a typed default. A template never asks
//     "is there an experience array?" - there is an array, possibly empty. A missing
//     key is a render failure, and a render failure is a user-visible bug on someone
//     else's resume.
//  2. EVERY STRING IS TRIMMED AND CONTROL-STRIPPED. Resume content is UNTRUSTED input
//     (policy 1.1): a name containing a NUL, a BEL, or an ANSI escape must not be able
//     to reach a terminal, a PDF text run or a log line. Control bytes are replaced by
//     a space and then collapsed, rather than deleted, so a newline cannot fuse two
//     words ("Dev\nOps" must not become "DevOps").
//  3. DATES ARE PRE-FORMATTED, HERE, ONCE. `rangeText` / `dateText` are ASCII
//     `Mar 2020 - Present` strings. No template does date arithmetic, no template
//     depends on a locale, and policy 7.4 pins `TZ=UTC` and `LC_ALL=C.UTF-8` anyway -
//     so the one place a date is interpreted is this file, and it is pure.
//  4. `sections[]` IS THE RENDER ORDER. Fixed, non-empty-only, in `RESUME_DICT_SECTIONS`
//     order. A template iterates it; it never decides an order for itself.
//  5. NOTHING THE PROJECTOR EMITS IS LOST. ADR-035: the projection may not drop profile
//     text. This file is the ONE dictionary DOCX (T1041) and `.tex`/`.json` (T1044) will
//     read, so a member missing here is missing in three outputs - and the whole table
//     below is the rule, stated against the canonical projector
//     (`resume/json/project.ts`), which is the only producer of documents in this
//     pipeline. A member the projector writes reaches the dictionary; a member it never
//     writes is listed under DELIBERATELY OUTSIDE, with the reason.
//
//     document member                          dictionary
//     ----------------------------------------  -----------------------------------------
//     basics.name                              contact.name
//     basics.label                             contact.headline
//     basics.email / basics.phone              contact.email / contact.phone
//     basics.url                               contact.website
//     basics.summary                           summary
//     basics.location (six members)            contact.location (the joined line) AND
//                                              contact.locationParts (all six, unjoined)
//     basics.profiles[] (network,username,url) contact.profiles[] AND the two derived
//                                              convenience fields contact.linkedin and
//                                              contact.github
//     work[].name / .position / .summary       experience[].organisation / .title /
//                                              .location   (see the note on `summary`)
//     work[].startDate / .endDate              experience[].rangeText
//     work[].highlights                        experience[].highlights
//     education[].institution                  education[].institution
//     education[].studyType / .area            education[].qualification
//     education[].endDate                      education[].rangeText
//     projects[].name / .description           projects[].name / .description
//     projects[].startDate / .endDate          projects[].rangeText
//     projects[].keywords / .highlights        projects[].keywords / .highlights
//     projects[].url                           projects[].url   (repoUrl, else liveUrl)
//     skills[].name                            skills[].name
//     skills[].level                           skills[].level
//     certificates[].name / .issuer / .date    certifications[].name / .issuer / .dateText
//     certificates[].url                       certifications[].url   (credentialUrl)
//
//     DELIBERATELY OUTSIDE THE RULE, each for a reason a reader can check:
//
//     - `x-clearance`. The block is a claim LEDGER - claim ids, statuses, evidence ids -
//       and a render is a render of the resume text. It stays in the revision document,
//       where ADR-036's statuses are reviewable, and printing a claim status beside a
//       name on a PDF is not a decision this projection may take. The TEXT a claim
//       guards is in the table above, at the position the projector gave it.
//     - `education[].location`. There is no such member to lose: `JsonResumeEducation`
//       (`resume/json/jsonresume.ts:95-103`) has no `location`, so the key is declared
//       for TOTILITY and is unreachable from any document.
//     - `education[].score`, and the other JSON Resume members the canonical model never
//       emits: `work[].url`, `education[].url`, `education[].courses`, `projects[].roles`,
//       `projects[].entity`, `basics.image`. A hand-written third-party document may carry
//       them, and `lowerResumeJson` keeps them in the revision JSON - but the dictionary
//       is the render projection of the CANONICAL model, so `education[].score` is `''`
//       and the rest have no key. Widening the dictionary for the import path is a
//       `RESUME_DICT_VERSION` bump with a named owner (T1041 / T1044), which is a
//       recorded decision rather than a silent omission.
//     - `basics.profiles[][].username` and every network other than LinkedIn and GitHub
//       ARE in the table: they reach `contact.profiles`. Before 1.1.0 they were dropped
//       with the two derived fields, which is the omission this rule exists to prevent.
//
// SECTION VOCABULARY, AND WHY IT IS NARROWER THAN JSON RESUME. `RESUME_DICT_SECTIONS`
// is exactly the seven sections the CANONICAL model can emit. `languages`, `awards`,
// `interests`, `publications`, `references` and `volunteer` are real JSON Resume
// sections, but `lowerResumeJson` records them as `no_canonical_entity`
// (`resume/json/jsonresume.ts`, the `UNSUPPORTED_SECTIONS` table) and the projector
// never emits them. A template that declared one would be claiming a section the
// pipeline can never fill, so the registry REJECTS the declaration
// (`RENDER_TEMPLATE_SECTION_UNKNOWN`) instead of rendering an empty section. The
// vocabulary is the set of sections a document can actually carry.
//
// THE USER-CONTENT BOUNDARY (policy 8.4). Resume text reaches a typesetter ONLY as a
// JSON string value inside `data.json`. This module is a projection, not a source
// generator: it never concatenates content into markup, and a value containing
// `#eval(...)` or `#raw` is carried through as the STRING it is. `dictToDataJson` uses
// `canonicalJsonString` from `resume/json/jsonresume.ts`, the same serialiser the
// revision snapshot and `jsonHash` use, so `data.json` bytes are canonical (keys sorted
// at every depth) and two renders of the same revision stage byte-identical input.
//
// DETERMINISM IS A REQUIREMENT, NOT A NICOETY. No clock, no random, no environment
// read, no iteration over an unordered collection, no `undefined` in the output. The
// only inputs are the document's own values, and the only orderings applied are the
// document's own array order (which the projector already made deterministic) and the
// fixed `RESUME_DICT_SECTIONS` order.

import { canonicalJsonString } from '../resume/json/jsonresume.js';

/**
 * The dictionary's own shape version. Bump it when a declared key changes meaning.
 *
 * `1.1.0` is ADDITIVE: the members rule 5 of the module header required
 * (`projects[].url`, `certifications[].url`, `skills[].level`, `contact.locationParts`,
 * `contact.profiles`) were added, and nothing that 1.0.0 declared changed meaning or
 * disappeared. A template written against 1.0.0 still reads exactly the keys it read.
 * Nothing consumed 1.0.0 outside this repository when the bump was made.
 */
export const RESUME_DICT_VERSION = '1.1.0';

/**
 * The section vocabulary, IN RENDER ORDER. The order is the contract: `sections[]`
 * carries it, and Typst, DOCX and LaTeX all consume that one array, so "the same
 * content in the same order in every output" is structural (ADR-044 D3).
 *
 * A template may not name anything outside this list (policy 8.3's registry gate), and
 * this list may not gain a member the canonical model cannot emit.
 */
export const RESUME_DICT_SECTIONS = Object.freeze([
  'contact',
  'summary',
  'experience',
  'projects',
  'education',
  'skills',
  'certifications',
] as const);

export type ResumeDictSection = (typeof RESUME_DICT_SECTIONS)[number];

/** The language every render is typeset in. See the note on `ResumeDict.language`. */
export const RESUME_DICT_LANGUAGE = 'en';

/**
 * The document-level ATS profile, as the dictionary always carries it.
 *
 * These are the CONSERVATIVE values, and they are a property of the CONTENT rather than
 * of a template: a resume built from these sections needs no table, no icon font and no
 * multi-column trickery to be parseable. A template's own layout capability is declared
 * in its `metadata.json` (`atsProfile`), and the registry is what checks that the two
 * agree with the template's actual geometry - a template may not widen this object.
 */
export const RESUME_DICT_ATS_PROFILE = Object.freeze({
  singleColumn: true,
  iconFonts: false,
  tablesAllowed: false,
} as const);

/**
 * The STRUCTURED `basics.location`, carried member by member.
 *
 * `contact.location` is the one readable LINE, and a line cannot carry a street address
 * and a postal code without becoming something no one reads on a single page. So the six
 * members of `JsonResumeLocation` (`resume/json/jsonresume.ts:56-63`) are also carried
 * separately - each normalised, each `''` when absent - and a template that wants a
 * postal block, or that wants to compose its own one, has one. Two of the six
 * (`address`, `postalCode`) appear ONLY here; the other four are also in `location`.
 */
export interface ResumeDictLocation {
  readonly address: string;
  readonly postalCode: string;
  readonly city: string;
  readonly region: string;
  readonly countryCode: string;
  readonly country: string;
}

/** One entry of `basics.profiles`, in document order. */
export interface ResumeDictProfile {
  /** `''` when the document named only the URL. Never lower-cased: it is a display name. */
  readonly network: string;
  /** `''` when the document carried no handle. The projector emits the URL, not this. */
  readonly username: string;
  /** The only REQUIRED member of `JsonResumeProfile`, and the reason a projection exists. */
  readonly url: string;
}

/** `basics`, flattened. Every field is a string; an absent field is `''`. */
export interface ResumeDictContact {
  readonly name: string;
  /** `basics.label` - the one-line professional headline. */
  readonly headline: string;
  readonly email: string;
  readonly phone: string;
  /**
   * THE LOCATION LINE, pre-composed: `city`, `region`, `countryCode`, `country` in that
   * order, each dropped when empty, exact repeats dropped, joined with `", "`. So
   * `{city: 'London', region: 'Greater London', countryCode: 'GB'}` is
   * `London, Greater London, GB`, and `{city: 'Berlin', country: 'Berlin'}` is `Berlin`.
   * `address` and `postalCode` are deliberately NOT in this line - see
   * `contact.locationParts`, which carries all six.
   */
  readonly location: string;
  /** The same six members, unjoined. `location` is composed from four of them. */
  readonly locationParts: ResumeDictLocation;
  readonly website: string;
  /** The `basics.profiles` entry for LinkedIn, matched by `network` then by URL host. */
  readonly linkedin: string;
  /** The same, for GitHub. */
  readonly github: string;
  /**
   * EVERY profile entry with a URL, in document order - including networks that are
   * neither LinkedIn nor GitHub, and the `username` handle. The two fields above are
   * derived from this array and never disagree with it.
   */
  readonly profiles: readonly ResumeDictProfile[];
}

export interface ResumeDictExperience {
  readonly title: string;
  readonly organisation: string;
  readonly location: string;
  /** Pre-formatted, ASCII: `Mar 2020 - Present`, `Mar 2020 - Jun 2022`, or `2018`. */
  readonly rangeText: string;
  /**
   * Always `''` for a canonical document: `work[].summary` in the canonical projection
   * carries the PLACE, which is `location` here, and JSON Resume has no other free-text
   * field on a work entry. The key exists so the interface is total and so a future
   * canonical `roleSummary` has a home without a dictionary version bump.
   */
  readonly summary: string;
  readonly highlights: readonly string[];
}

export interface ResumeDictProject {
  readonly name: string;
  readonly description: string;
  readonly rangeText: string;
  /**
   * `projects[].url` - the projector writes `repoUrl`, falling back to `liveUrl`
   * (`resume/json/project.ts`), and `''` when the document carries neither. A resume
   * whose project links are not in the dictionary is missing them in all three engines.
   */
  readonly url: string;
  readonly keywords: readonly string[];
  readonly highlights: readonly string[];
}

export interface ResumeDictEducation {
  /** `studyType` and `area` joined, e.g. `MEng, Computer Science`. */
  readonly qualification: string;
  readonly institution: string;
  /**
   * Always `''`, and unreachable: `JsonResumeEducation` has no `location` member at all
   * (`resume/json/jsonresume.ts`), so there is nothing to read it from. Declared so the
   * interface is total and so a template may print a place for an entry without asking
   * whether one exists.
   */
  readonly location: string;
  readonly rangeText: string;
  readonly score: string;
}

export interface ResumeDictSkill {
  readonly name: string;
  /**
   * `skills[].level` - the proficiency the record claims, free text ("Advanced", "3/5").
   * `''` when the document carries none; the canonical projector writes it only when the
   * skill row has one.
   */
  readonly level: string;
  /**
   * Always `[]` for a canonical document: the projector emits no `keywords` on a skill
   * (the skill NAME is the claim). A lowered third-party document does carry them, and
   * the key is total either way.
   */
  readonly keywords: readonly string[];
}

export interface ResumeDictCertification {
  readonly name: string;
  readonly issuer: string;
  /** Pre-formatted, ASCII: `Mar 2020`, or `2018` for a year-only value. */
  readonly dateText: string;
  /**
   * `certificates[].url` - the credential link the projector writes from
   * `credentialUrl`, and `''` when there is none. A certificate rendered without its
   * verification link is a claim a reader cannot check.
   */
  readonly url: string;
}

/** The whole dictionary. Every member is ALWAYS present with a typed default. */
export interface ResumeDict {
  readonly dictVersion: string;
  readonly language: string;
  readonly contact: ResumeDictContact;
  readonly summary: string;
  /**
   * THE RENDER ORDER. Non-empty sections only, in `RESUME_DICT_SECTIONS` order. A
   * template iterates this and never invents an order, which is what makes three
   * engines produce the same document order from one input.
   */
  readonly sections: readonly ResumeDictSection[];
  readonly experience: readonly ResumeDictExperience[];
  readonly projects: readonly ResumeDictProject[];
  readonly education: readonly ResumeDictEducation[];
  readonly skills: readonly ResumeDictSkill[];
  readonly certifications: readonly ResumeDictCertification[];
  readonly ats: typeof RESUME_DICT_ATS_PROFILE;
}

// ---------------------------------------------------------------------------
// Defensive readers - the same discipline `lowerResumeJson` uses
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

// C0, DEL and C1. A tab and a newline survive as a space (see the module header);
// everything else in those blocks becomes a space and is then collapsed away.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE_RUN = /\s+/g;

/**
 * The one normalisation every string passes: strip control characters, collapse
 * whitespace runs, trim. `''` for anything that is not a string, so a hostile document
 * cannot put a number where a string is declared.
 */
function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, ' ').replace(WHITESPACE_RUN, ' ').trim();
}

/** A list of normalised, NON-EMPTY strings, in document order. */
function textList(value: unknown): readonly string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    const item = text(entry);
    if (item.length > 0) out.push(item);
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Dates, formatted once, here
// ---------------------------------------------------------------------------

const MONTH_ABBREVIATIONS = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]);

/**
 * `YYYY`, `YYYY-MM` and `YYYY-MM-DD` become `2018`, `Mar 2020` and `Mar 2020`.
 *
 * A value that is not one of those three shapes is kept VERBATIM (after the usual
 * normalisation). That is the total-function choice: a resume typed as `2020-03` and
 * one typed as `Spring 2020` both render, and neither is silently dropped. The cost is
 * that a template cannot assume the shape of the text - which is exactly why the
 * templates treat these as opaque strings and no template formats anything.
 */
function formatDate(value: unknown): string {
  const raw = text(value);
  if (raw.length === 0) return '';
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(raw);
  if (match === null) return raw;
  const year = match[1] as string;
  const month = match[2];
  if (month === undefined) return year;
  const monthIndex = Number.parseInt(month, 10) - 1;
  const abbreviation = MONTH_ABBREVIATIONS[monthIndex];
  // A month outside 01-12 is not a date; keeping the text is the honest answer.
  if (abbreviation === undefined) return raw;
  return `${abbreviation} ${year}`;
}

/**
 * The pre-formatted range, e.g. `Mar 2020 - Present`.
 *
 *   both ends   -> `Mar 2020 - Jun 2022`
 *   start only  -> `Mar 2020 - Present`   (an open end IS the convention, and the
 *                                           canonical projector OMITS `endDate` for a
 *                                           current role rather than writing `''`)
 *   end only    -> `Jun 2022`             (education publishes a graduation year)
 *   neither     -> `''`
 */
function formatRange(start: unknown, end: unknown): string {
  const from = formatDate(start);
  const to = formatDate(end);
  if (from.length > 0 && to.length > 0) return `${from} - ${to}`;
  if (from.length > 0) return `${from} - Present`;
  return to;
}

// ---------------------------------------------------------------------------
// Contact
// ---------------------------------------------------------------------------

/**
 * The six members of `basics.location`, normalised, in a FIXED order.
 *
 * The order is this literal's, not the document's key order, so two documents carrying
 * the same place produce the same object (and `canonicalJsonString` sorts the keys
 * again on the way to `data.json`).
 */
function readLocation(value: unknown): ResumeDictLocation {
  const location = asRecord(value);
  return Object.freeze({
    address: text(location.address),
    postalCode: text(location.postalCode),
    city: text(location.city),
    region: text(location.region),
    countryCode: text(location.countryCode),
    country: text(location.country),
  });
}

/**
 * The pre-composed location LINE, from the structured parts.
 *
 * The composition is fixed, total and documented because a template cannot re-derive it:
 * `city`, then `region`, then `countryCode`, then `country` - each dropped when empty,
 * each dropped when it exactly repeats a part already in the line, joined with `", "`.
 * It never invents a component, and it never drops one silently: `address` and
 * `postalCode` are not in a one-line address at all, which is why they are carried in
 * `contact.locationParts` (rule 5 of the module header) and named there.
 */
function joinLocation(parts: ResumeDictLocation): string {
  const line: string[] = [];
  for (const key of ['city', 'region', 'countryCode', 'country'] as const) {
    const part = parts[key];
    if (part.length > 0 && !line.includes(part)) line.push(part);
  }
  return line.join(', ');
}

/**
 * EVERY `basics.profiles` entry that carries a URL, in document order.
 *
 * `JsonResumeProfile.url` is the only REQUIRED member of the shape, so an entry with no
 * URL is not a profile and is skipped rather than rendered as a nameless line. The
 * canonical projector already filters to non-empty URLs and sorts the array by URL then
 * network (`resume/json/project.ts`), so "first" is stable for the two derived fields
 * below; a hand-written document keeps its own order, which is preserved.
 */
function projectProfiles(profiles: readonly unknown[]): readonly ResumeDictProfile[] {
  const out: ResumeDictProfile[] = [];
  for (const entry of asArray(profiles)) {
    const profile = asRecord(entry);
    const url = text(profile.url);
    if (url.length === 0) continue;
    out.push(
      Object.freeze({
        network: text(profile.network),
        username: text(profile.username),
        url,
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * One profile URL for a named network, taken from the PROJECTED array, so the derived
 * field can never disagree with `contact.profiles`.
 *
 * `network` is the primary key (the projector writes it for LinkedIn and GitHub) and the
 * URL host is the fallback for a document that only carries the link. The first match in
 * document order wins.
 */
function profileUrl(
  profiles: readonly ResumeDictProfile[],
  network: string,
  hostHint: string,
): string {
  let hostMatch = '';
  for (const profile of profiles) {
    if (profile.network.toLowerCase() === network) return profile.url;
    if (hostMatch.length === 0 && profile.url.toLowerCase().includes(hostHint)) {
      hostMatch = profile.url;
    }
  }
  return hostMatch;
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

function projectContact(basics: Record<string, unknown>): ResumeDictContact {
  const locationParts = readLocation(basics.location);
  const profiles = projectProfiles(asArray(basics.profiles));
  return Object.freeze({
    name: text(basics.name),
    headline: text(basics.label),
    email: text(basics.email),
    phone: text(basics.phone),
    location: joinLocation(locationParts),
    locationParts,
    website: text(basics.url),
    linkedin: profileUrl(profiles, 'linkedin', 'linkedin.com'),
    github: profileUrl(profiles, 'github', 'github.com'),
    profiles,
  });
}

function projectExperience(document: Record<string, unknown>): readonly ResumeDictExperience[] {
  const out: ResumeDictExperience[] = [];
  for (const entry of asArray(document.work)) {
    const item = asRecord(entry);
    // `work[].summary` is the PLACE in the canonical projection (see
    // `resume/json/project.ts`): JSON Resume's `location` lives on `basics` only, and
    // `url` would be rendered as a hyperlink to "Berlin, Germany".
    const location = text(item.summary);
    out.push(
      Object.freeze({
        title: text(item.position),
        organisation: text(item.name),
        location,
        rangeText: formatRange(item.startDate, item.endDate),
        summary: '',
        highlights: textList(item.highlights),
      }),
    );
  }
  return Object.freeze(out);
}

function projectProjects(document: Record<string, unknown>): readonly ResumeDictProject[] {
  const out: ResumeDictProject[] = [];
  for (const entry of asArray(document.projects)) {
    const item = asRecord(entry);
    out.push(
      Object.freeze({
        name: text(item.name),
        description: text(item.description),
        rangeText: formatRange(item.startDate, item.endDate),
        // `repoUrl` with `liveUrl` as the projector's own fallback, already applied there.
        url: text(item.url),
        keywords: textList(item.keywords),
        highlights: textList(item.highlights),
      }),
    );
  }
  return Object.freeze(out);
}

function projectEducation(document: Record<string, unknown>): readonly ResumeDictEducation[] {
  const out: ResumeDictEducation[] = [];
  for (const entry of asArray(document.education)) {
    const item = asRecord(entry);
    // `studyType` then `area`, e.g. `MEng, Computer Science`. A degree with no field
    // prints the degree alone rather than a dangling separator.
    const parts = [text(item.studyType), text(item.area)].filter((part) => part.length > 0);
    out.push(
      Object.freeze({
        qualification: parts.join(', '),
        institution: text(item.institution),
        location: '',
        rangeText: formatRange(item.startDate, item.endDate),
        score: text(item.score),
      }),
    );
  }
  return Object.freeze(out);
}

function projectSkills(document: Record<string, unknown>): readonly ResumeDictSkill[] {
  const out: ResumeDictSkill[] = [];
  for (const entry of asArray(document.skills)) {
    const item = asRecord(entry);
    out.push(
      Object.freeze({
        name: text(item.name),
        // The canonical projector writes `level` only when the skill row carries one.
        level: text(item.level),
        // The canonical projector emits no `keywords` on a skill (the skill NAME is the
        // claim), but a lowered third-party document does, and the key is total either way.
        keywords: textList(item.keywords),
      }),
    );
  }
  return Object.freeze(out);
}

function projectCertifications(document: Record<string, unknown>): readonly ResumeDictCertification[] {
  const out: ResumeDictCertification[] = [];
  for (const entry of asArray(document.certificates)) {
    const item = asRecord(entry);
    out.push(
      Object.freeze({
        name: text(item.name),
        issuer: text(item.issuer),
        dateText: formatDate(item.date),
        // The credential link, which the projector writes from `credentialUrl`.
        url: text(item.url),
      }),
    );
  }
  return Object.freeze(out);
}

/**
 * Is there anything in here a section would render? Strings, arrays and the one nested
 * object (`contact.locationParts`) are all possible now that the contact carries a
 * structured location and a profile list, so the question is asked recursively instead of
 * by assuming a shape. Total and order-independent: a `''` member and an empty array
 * both answer `false`.
 */
function hasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasContent);
  }
  return false;
}

/**
 * The non-empty sections, in `RESUME_DICT_SECTIONS` order. Built by walking the FIXED
 * list rather than by discovering which keys the document happened to have, so the
 * order cannot depend on the document's key order.
 */
function projectSections(
  contact: ResumeDictContact,
  summary: string,
  experience: readonly ResumeDictExperience[],
  projects: readonly ResumeDictProject[],
  education: readonly ResumeDictEducation[],
  skills: readonly ResumeDictSkill[],
  certifications: readonly ResumeDictCertification[],
): readonly ResumeDictSection[] {
  const populated: Readonly<Record<ResumeDictSection, boolean>> = Object.freeze({
    contact: hasContent(contact),
    summary: summary.length > 0,
    experience: experience.length > 0,
    projects: projects.length > 0,
    education: education.length > 0,
    skills: skills.length > 0,
    certifications: certifications.length > 0,
  });
  return Object.freeze(RESUME_DICT_SECTIONS.filter((section) => populated[section]));
}

/**
 * Project a canonical Resume JSON document (JSON Resume + `x-clearance`, as written by
 * `resume/json/project.ts` and read by `lowerResumeJson`) into the render dictionary.
 *
 * COMPLETE as well as pure: every member the canonical projector writes reaches the
 * dictionary (rule 5 of the module header is the table, and the three URLs / the skill
 * level / the six location parts are in it). Nothing is dropped here for being a URL, a
 * proficiency, or half an address.
 *
 * PURE, TOTAL, DETERMINISTIC:
 *   - pure: no I/O, no clock, no environment, no randomness, and the input is never
 *     mutated;
 *   - total: `null`, `[]`, `"x"`, `42` and a malformed `basics` are all valid inputs
 *     and produce a complete dictionary, so a hostile or merely sloppy document cannot
 *     turn a render into a thrown error;
 *   - deterministic: same bytes in, same bytes out (see `dictToDataJson`), including
 *     across a document whose object keys are in a different order.
 */
export function projectResumeDict(resumeJson: unknown): ResumeDict {
  const document = asRecord(resumeJson);
  const basics = asRecord(document.basics);
  const contact = projectContact(basics);
  const summary = text(basics.summary);
  const experience = projectExperience(document);
  const projects = projectProjects(document);
  const education = projectEducation(document);
  const skills = projectSkills(document);
  const certifications = projectCertifications(document);
  return Object.freeze({
    dictVersion: RESUME_DICT_VERSION,
    language: RESUME_DICT_LANGUAGE,
    contact,
    summary,
    sections: projectSections(contact, summary, experience, projects, education, skills, certifications),
    experience,
    projects,
    education,
    skills,
    certifications,
    ats: RESUME_DICT_ATS_PROFILE,
  });
}

/**
 * The `data.json` bytes for a dictionary: `canonicalJsonString` (object keys sorted at
 * every depth, `undefined` members dropped, non-JSON values REJECTED) encoded as UTF-8.
 *
 * The SAME serialiser the revision snapshot and `ResumeRevision.jsonHash` use, so a
 * render's staged input is canonical too, and two renders of one revision stage
 * byte-identical bytes. A non-JSON value reaching here is a bug in a projection, not a
 * user input error, and the `TypeError` is deliberate (`canonicalJsonString`'s own
 * contract).
 */
export function dictToDataJson(dict: ResumeDict): Buffer {
  if (dict === null || typeof dict !== 'object') {
    throw new TypeError('dictToDataJson: a ResumeDict is required');
  }
  return Buffer.from(canonicalJsonString(dict), 'utf8');
}
