// =====================================================================================
// resume/json/jsonresume.ts - the canonical document shape: JSON Resume + `x-clearance`,
// plus the LOWERING direction (ADR-035, 05 sec.1 / sec.6).
//
// NORMATIVE: .planning/specs/clearance-v2/05-canonical-model.md sec.1 (JSON Resume
//            decision), sec.6 (how a resume derives from the profile).
// DECISION:  .planning/decisions/ADR-035-canonical-model-jsonresume-hybrid.md
//
// WHAT THIS FILE IS. The interchange substrate. `ResumeRevision.resumeJson` holds a
// JSON Resume document with ONE extension block, `x-clearance`, which is where the
// V2-specific concepts live (claim identity, status, provenance, confidence, how the
// claim is used). ADR-035 rejected "JSON Resume as-is" precisely because the community
// schema has no vocabulary for evidence/provenance/verification, and rejected
// "Clearance-native only" because it would throw away the free MIT ecosystem. So the
// document IS a JSON Resume - every theme, `resume-cli` and
// `@jsonresume/ats-validator` keep working - and everything JSON Resume cannot express
// is additive and namespaced.
//
// WHY `x-clearance` IS PERMITTED, MECHANICALLY. The canonical `@jsonresume/schema` is
// draft-07 with `additionalProperties: true` at the root and in nested objects
// (05 sec.1). That single fact is what makes an extension legal instead of a fork, and
// it is TESTED here rather than asserted in a comment: `validate.test.ts` compiles the
// schema with `additionalProperties: false` and shows the same document is REJECTED, so
// the property cannot quietly become load-bearing if the upstream schema tightens.
//
// DIRECTION OF TRUTH. DB -> Resume JSON -> renderers. `resumeJson` is a DERIVED
// artifact; it is never the store, and no renderer ever edits it in place (05 sec.1).
// Editing produces revision N+1 (see `resume/revisions.ts`).
//
// THE ONE INVARIANT THIS FILE OWNS: LOWERING NEVER CONFIRMS. `lowerResumeJson` is the
// import path for a plain, third-party JSON Resume, and it is the path an LLM
// re-extraction would take. Every claim it produces is `IMPORTED_CLAIM_STATUS`, which
// the career layer owns (ADR-036 item 2 / item 4: a re-observation never upgrades). It
// does not read a status out of the document - not even one this module itself wrote.
// A hand-edited `x-clearance` block claiming the confirming status lowers to exactly
// the same inferred claim as a document with no block at all, which is asserted in
// `project.test.ts` and `routes/resumes.test.ts`.
//
// DETERMINISM. `canonicalJsonString` is the ONLY serialisation used for a revision
// snapshot or a hash. Object keys are emitted in sorted order and arrays keep their
// (already deterministic) order, so the same logical data always produces the same
// bytes, on any host, in any process. `resume/revisions.ts` hashes that string; the
// `jsonHash` stability acceptance item depends on it.
// =====================================================================================

import { createHash } from 'node:crypto';
import type { ClaimKind, ClaimProvenance, ClaimStatus, ResumeUsage } from '@prisma/client';

import { IMPORTED_CLAIM_PROVENANCE, IMPORTED_CLAIM_STATUS } from '../../career/claimUsage.js';

// ---------------------------------------------------------------------------
// JSON Resume (the community shape, unmodified)
// ---------------------------------------------------------------------------

/** `basics.location` - the JSON Resume shape, not ours. */
export interface JsonResumeLocation {
  address?: string;
  postalCode?: string;
  city?: string;
  countryCode?: string;
  region?: string;
  country?: string;
}

/** One entry of `basics.profiles`. */
export interface JsonResumeProfile {
  network?: string;
  username?: string;
  url: string;
}

export interface JsonResumeBasics {
  name: string;
  label?: string;
  image?: string;
  email?: string;
  phone?: string;
  url?: string;
  summary?: string;
  location?: JsonResumeLocation;
  profiles?: JsonResumeProfile[];
}

export interface JsonResumeWork {
  /** The employer. JSON Resume calls the employer `name` and the job title `position`. */
  name: string;
  position: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  summary?: string;
  highlights?: string[];
}

export interface JsonResumeEducation {
  institution: string;
  url?: string;
  area?: string;
  studyType?: string;
  startDate?: string;
  endDate?: string;
  score?: string;
  courses?: string[];
}

export interface JsonResumeProject {
  name: string;
  description?: string;
  highlights?: string[];
  keywords?: string[];
  startDate?: string;
  endDate?: string;
  roles?: string[];
  entity?: string;
  url?: string;
}

export interface JsonResumeSkill {
  name: string;
  level?: string;
  keywords?: string[];
}

export interface JsonResumeCertificate {
  name: string;
  date?: string;
  issuer?: string;
  url?: string;
}

export interface JsonResumeAward {
  title: string;
  date?: string;
  awarder?: string;
  summary?: string;
}

export interface JsonResumePublication {
  name: string;
  publisher: string;
  releaseDate?: string;
  url?: string;
  summary?: string;
}

export interface JsonResumeLanguage {
  language: string;
  fluency?: string;
}

export interface JsonResumeInterest {
  name: string;
  keywords?: string[];
}

export interface JsonResumeVolunteer {
  organization: string;
  position: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  summary?: string;
  highlights?: string[];
}

export interface JsonResumeReference {
  name: string;
  reference?: string;
}

/** `meta` is the community's own free-form bag; it is passed through untouched. */
export type JsonResumeMeta = Record<string, unknown>;

export interface JsonResumeContent {
  basics?: JsonResumeBasics;
  work?: JsonResumeWork[];
  volunteer?: JsonResumeVolunteer[];
  education?: JsonResumeEducation[];
  awards?: JsonResumeAward[];
  certificates?: JsonResumeCertificate[];
  publications?: JsonResumePublication[];
  skills?: JsonResumeSkill[];
  languages?: JsonResumeLanguage[];
  interests?: JsonResumeInterest[];
  projects?: JsonResumeProject[];
  references?: JsonResumeReference[];
  meta?: JsonResumeMeta;
}

// ---------------------------------------------------------------------------
// The `x-clearance` extension block
// ---------------------------------------------------------------------------

/** The single extension key. Namespaced, so a community theme ignores it. */
export const X_CLEARANCE_KEY = 'x-clearance';

/**
 * The version of the BLOCK's own shape (ADR-035: "the `x-clearance` block needs an
 * explicit schema and version"). Bump this when a member is removed or its meaning
 * changes; adding an optional member does not need a bump.
 */
export const X_CLEARANCE_VERSION = 1;

/**
 * One claim, as it appears in the document, with the provenance JSON Resume has no
 * vocabulary for.
 *
 * `status` is COPIED FROM THE CLAIM ROW by `resume/json/project.ts` and is the reason
 * this block exists. It is not a summary, an opinion or a hint: it is the same enum
 * value the gate re-reads from the database, so a reader of the document and the
 * pre-render validator can never disagree about whether a fact was confirmed.
 */
export interface ClearanceClaimEntry {
  claimId: string;
  fingerprint: string;
  kind: ClaimKind;
  /** Derived from `CareerClaim.status`. Never from a caller, never from a document. */
  status: ClaimStatus;
  provenance: ClaimProvenance;
  /** Producer belief in [0,1]. Metadata only - it never affects `status` (05 sec.4). */
  confidence: number | null;
  evidenceSourceId: string | null;
  /** `verbatim` | `tailored` | `omitted` - the same vocabulary the gate reads. */
  usage: ResumeUsage;
  /** Where the claim landed, e.g. `work[0].highlights[2]`. `null` when omitted. */
  jsonPath: string | null;
  /** The exact text that appears, when the claim is used. `null` when omitted. */
  renderedText: string | null;
}

export interface ClearanceBlock {
  version: typeof X_CLEARANCE_VERSION;
  /** The producer, for provenance of the DOCUMENT itself. */
  generatedBy: string;
  /** `Resume.modelVersion` of the row this snapshot was projected from (1 or 2). */
  sourceModelVersion: number;
  profileId: string;
  claimCount: number;
  /** Claims whose status is the confirming one. The gate re-derives this; it is a hint. */
  confirmedClaimCount: number;
  /** `claimCount - confirmedClaimCount`. A non-zero value means the gate will block. */
  unconfirmedClaimCount: number;
  /**
   * Every claim the projection considered, sorted by `claimId`. Including the OMITTED
   * ones is deliberate: "the profile knows this and the resume does not say it" is
   * information a reviewer needs, and an omitted claim can never be gate-relevant.
   */
  claims: ClearanceClaimEntry[];
}

/** The whole document: JSON Resume plus the one extension block. */
export interface ResumeJson extends JsonResumeContent {
  'x-clearance'?: ClearanceBlock;
}

// ---------------------------------------------------------------------------
// Canonical serialisation (the ONLY form a revision snapshot or hash sees)
// ---------------------------------------------------------------------------

/**
 * Serialise `value` so the same logical data always yields the same bytes.
 *
 * - object keys are emitted in ascending code-unit order, at every depth;
 * - array order is PRESERVED (it is meaningful: `work[0]` is a position in the
 *   document, and the projector already makes that order deterministic);
 * - `undefined` members are dropped, exactly as `JSON.stringify` drops them, so an
 *   optional field is absent rather than `null` unless a caller meant `null`;
 * - anything that is not a JSON value (a function, a symbol, `NaN`, `Infinity`, a
 *   `Date`, a `Map`, a class instance) is REJECTED, not silently coerced. A projection
 *   that quietly serialised a `Date` to a string would make `jsonHash` depend on an
 *   implementation detail.
 *
 * The rejection is a `TypeError` on purpose: reaching this function with a non-JSON
 * value is a programming error in the projector, not a user input error, and the
 * revision writer turns it into a `ResumeRevisionError`.
 */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(
        `canonicalJsonString: ${String(value)} is not a JSON number (a projection may not serialise NaN or Infinity - convert it to a string at the point of use)`,
      );
    }
    return value;
  }
  if (type === 'bigint') {
    throw new TypeError('canonicalJsonString: a BigInt is not a JSON value');
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    throw new TypeError(`canonicalJsonString: a ${type} is not a JSON value`);
  }
  if (type !== 'object') {
    throw new TypeError(`canonicalJsonString: unsupported value of type ${type}`);
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError('canonicalJsonString: the value is cyclic');
  }
  // Anything with a non-plain prototype would serialise through a toJSON hook or lose
  // members, both of which make the hash depend on a class rather than on the data.
  const prototype = Object.getPrototypeOf(object);
  if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `canonicalJsonString: expected a plain object or array, got ${object.constructor?.name ?? 'an exotic object'} - a projection must produce plain JSON`,
    );
  }

  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return object.map((entry) => (entry === undefined ? null : canonicalize(entry, seen)));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const member = (object as Record<string, unknown>)[key];
      if (member === undefined) continue;
      out[key] = canonicalize(member, seen);
    }
    return out;
  } finally {
    seen.delete(object);
  }
}

/** `sha256` of the canonical form, lowercase hex. The `ResumeRevision.jsonHash`. */
export function canonicalJsonHash(value: unknown): string {
  return createHash('sha256').update(canonicalJsonString(value), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Reading a document defensively
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asTextArray(value: unknown): string[] {
  return asArray(value)
    .map(asText)
    .filter((entry): entry is string => entry !== null);
}

/**
 * The `x-clearance` block of a document, or `null`.
 *
 * This is a READ for tooling (a diff view, a validator, the round-trip test). It is
 * deliberately NOT trusted for a status by anything that decides: the pre-render gate
 * re-reads `CareerClaim.status` from the database, and `lowerResumeJson` ignores the
 * block entirely.
 */
export function readClearanceBlock(document: unknown): ClearanceBlock | null {
  const block = asRecord(asRecord(document)[X_CLEARANCE_KEY]);
  if (Object.keys(block).length === 0) return null;
  return block as unknown as ClearanceBlock;
}

// ---------------------------------------------------------------------------
// LOWERING: JSON Resume -> profile/claim drafts (all inferred, never confirmed)
// ---------------------------------------------------------------------------

/**
 * A claim the import path wants to exist. It is a DRAFT, never a row: the caller
 * persists it through `career/claims.ts#createClaim`, which is the only dedupe point
 * and which cannot be handed a confirming status.
 *
 * `status` is typed as the single inferred literal, so `status: <the confirming one>`
 * is a COMPILE error in this repository - and the value itself comes from the career
 * layer's constant, so the vocabulary is not re-declared here.
 */
export interface LoweredClaimDraft {
  kind: ClaimKind;
  statement: string;
  status: typeof IMPORTED_CLAIM_STATUS;
  provenance: typeof IMPORTED_CLAIM_PROVENANCE;
  confidence: null;
  inferenceMethod: 'json_resume_import';
  evidenceSourceId: string | null;
  experienceId: null;
  educationId: null;
  projectId: null;
  skillId: null;
  certificationId: null;
  /**
   * The claim this text came from, when the document is one of OUR projections.
   *
   * This is IDENTITY, not status. It lets a re-import reconcile with a claim that
   * already exists instead of forking a second row, and it carries no authority: the
   * status of the persisted claim is whatever the database says it is, and the gate
   * reads the row. A hand-edited `sourceClaimId` can therefore never make anything
   * confirmed - it can only mis-attribute a text, which the pre-render gate and the
   * evidence browser both surface.
   */
  sourceClaimId: string | null;
  /** Where the text sat in the source document, for the evidence trail. */
  jsonPath: string;
}

export interface LoweredBasics {
  name: string;
  label: string | null;
  email: string | null;
  phone: string | null;
  url: string | null;
  summary: string | null;
  location: JsonResumeLocation | null;
  profiles: JsonResumeProfile[];
}

export interface LoweredExperience {
  company: string;
  position: string;
  startDate: string | null;
  endDate: string | null;
  current: boolean;
  highlights: string[];
}

export interface LoweredEducation {
  institution: string;
  studyType: string | null;
  area: string | null;
  endDate: string | null;
  courses: string[];
}

export interface LoweredProject {
  name: string;
  description: string | null;
  url: string | null;
  startDate: string | null;
  endDate: string | null;
  roles: string[];
  highlights: string[];
  keywords: string[];
}

export interface LoweredSkill {
  name: string;
  level: string | null;
  category: string | null;
}

export interface LoweredCertificate {
  name: string;
  issuer: string | null;
  date: string | null;
  url: string | null;
}

/** A document section the canonical model has no entity for. Reported, never dropped. */
export interface LoweredUnsupportedSection {
  section: string;
  entries: number;
  reason: 'no_canonical_entity';
}

export interface LoweredResume {
  basics: LoweredBasics;
  work: LoweredExperience[];
  education: LoweredEducation[];
  projects: LoweredProject[];
  skills: LoweredSkill[];
  certificates: LoweredCertificate[];
  /** Every one of these is `IMPORTED_CLAIM_STATUS`. See the module header. */
  claims: LoweredClaimDraft[];
  /** The source block, carried forward verbatim. It is NEVER a status authority. */
  xClearance: ClearanceBlock | null;
  unsupported: LoweredUnsupportedSection[];
}

/** Sections JSON Resume has and the V2 canonical schema deliberately does not model. */
const UNSUPPORTED_SECTIONS = [
  'awards',
  'interests',
  'languages',
  'publications',
  'references',
  'volunteer',
] as const;

/**
 * Lower a JSON Resume document into profile fields + claim drafts + entities.
 *
 * EVERY claim this returns is `IMPORTED_CLAIM_STATUS` with
 * `IMPORTED_CLAIM_PROVENANCE`. That is the whole point of the function and it is
 * unconditional: the status is a hard-coded value, so there is no input - not a
 * hand-edited `x-clearance` block, not a `status` member smuggled into a highlight
 * object, not a second call site with a different literal - that can produce a
 * different one.
 *
 * The document is walked defensively (every reader tolerates a wrong type by skipping
 * the entry) so a hostile or merely sloppy third-party file lowers to something
 * reviewable instead of throwing halfway. Structural validity is `validate.ts`'s job,
 * and a route runs it BEFORE calling this.
 *
 * What becomes a claim: every `highlights` entry of `work` / `volunteer` / `projects`,
 * every `keywords` entry of `skills` / `projects`, every skill name, every
 * certificate, every education entry, and every project entry. Contact details and
 * dates are PROFILE fields, not claims: a phone number is not a career assertion and
 * gating it would make the invariant meaningless.
 */
export function lowerResumeJson(document: unknown): LoweredResume {
  const root = asRecord(document);
  const basics = asRecord(root.basics);
  const clearance = readClearanceBlock(root);

  // claimId lookup by rendered text, so a document we produced reconciles with the
  // claims it already names. Identity only - see LoweredClaimDraft.sourceClaimId.
  const byText = new Map<string, string>();
  for (const entry of clearance?.claims ?? []) {
    const text = asText(entry?.renderedText);
    if (text !== null && typeof entry?.claimId === 'string') byText.set(text, entry.claimId);
  }

  const claims: LoweredClaimDraft[] = [];
  const draft = (
    kind: ClaimKind,
    statement: string | null,
    jsonPath: string,
  ): void => {
    const text = asText(statement);
    if (text === null) return;
    claims.push({
      kind,
      statement: text,
      status: IMPORTED_CLAIM_STATUS,
      provenance: IMPORTED_CLAIM_PROVENANCE,
      confidence: null,
      inferenceMethod: 'json_resume_import',
      evidenceSourceId: null,
      experienceId: null,
      educationId: null,
      projectId: null,
      skillId: null,
      certificationId: null,
      sourceClaimId: byText.get(text) ?? null,
      jsonPath,
    });
  };

  const work: LoweredExperience[] = [];
  asArray(root.work).forEach((entry, index) => {
    const item = asRecord(entry);
    const company = asText(item.name);
    const position = asText(item.position);
    if (company === null || position === null) return;
    const highlights = asTextArray(item.highlights);
    highlights.forEach((text, highlightIndex) => {
      draft('achievement', text, `work[${index}].highlights[${highlightIndex}]`);
    });
    work.push({
      company,
      position,
      startDate: asText(item.startDate),
      endDate: asText(item.endDate),
      // JSON Resume has no `current` flag; the convention is an open end date, and
      // that is the only signal the format carries.
      current: asText(item.endDate) === null,
      highlights,
    });
  });

  const education: LoweredEducation[] = [];
  asArray(root.education).forEach((entry, index) => {
    const item = asRecord(entry);
    const institution = asText(item.institution);
    if (institution === null) return;
    const studyType = asText(item.studyType);
    const area = asText(item.area);
    // One claim per education entry: the credential itself, in plain language.
    const parts = [studyType, area === null ? null : `in ${area}`, `(${institution})`];
    draft(
      'education',
      parts.filter((part): part is string => part !== null).join(' '),
      `education[${index}]`,
    );
    education.push({
      institution,
      studyType,
      area,
      endDate: asText(item.endDate),
      courses: asTextArray(item.courses),
    });
  });

  const projects: LoweredProject[] = [];
  asArray(root.projects).forEach((entry, index) => {
    const item = asRecord(entry);
    const name = asText(item.name);
    if (name === null) return;
    const description = asText(item.description);
    const highlights = asTextArray(item.highlights);
    const keywords = asTextArray(item.keywords);
    const roles = asTextArray(item.roles);
    draft('project', description ?? name, `projects[${index}]`);
    highlights.forEach((text, i) => draft('achievement', text, `projects[${index}].highlights[${i}]`));
    keywords.forEach((text, i) => draft('technology', text, `projects[${index}].keywords[${i}]`));
    roles.forEach((text, i) => draft('role', text, `projects[${index}].roles[${i}]`));
    projects.push({
      name,
      description,
      url: asText(item.url),
      startDate: asText(item.startDate),
      endDate: asText(item.endDate),
      roles,
      highlights,
      keywords,
    });
  });

  const skills: LoweredSkill[] = [];
  asArray(root.skills).forEach((entry, index) => {
    const item = asRecord(entry);
    const name = asText(item.name);
    if (name === null) return;
    const keywords = asTextArray(item.keywords);
    const level = asText(item.level);
    // The skill NAME is the claim; the level is a display attribute, and a level is
    // exactly the kind of self-assessment a resume should not assert unverified.
    draft('skill', name, `skills[${index}].name`);
    keywords.forEach((text, i) => draft('technology', text, `skills[${index}].keywords[${i}]`));
    skills.push({ name, level, category: null });
  });

  const certificates: LoweredCertificate[] = [];
  asArray(root.certificates).forEach((entry, index) => {
    const item = asRecord(entry);
    const name = asText(item.name);
    if (name === null) return;
    const issuer = asText(item.issuer);
    draft('certification', issuer === null ? name : `${name} (${issuer})`, `certificates[${index}]`);
    certificates.push({ name, issuer, date: asText(item.date), url: asText(item.url) });
  });

  const unsupported: LoweredUnsupportedSection[] = [];
  for (const section of UNSUPPORTED_SECTIONS) {
    const entries = asArray(root[section]).length;
    if (entries > 0) unsupported.push({ section, entries, reason: 'no_canonical_entity' });
  }

  const location = asRecord(basics.location);
  const hasLocation = Object.keys(location).length > 0;

  return {
    basics: {
      name: asText(basics.name) ?? '',
      label: asText(basics.label),
      email: asText(basics.email),
      phone: asText(basics.phone),
      url: asText(basics.url),
      summary: asText(basics.summary),
      location: hasLocation ? (location as JsonResumeLocation) : null,
      profiles: asArray(basics.profiles)
        .map(asRecord)
        .map((profile) => ({ network: asText(profile.network) ?? undefined, username: asText(profile.username) ?? undefined, url: asText(profile.url) ?? '' }))
        .filter((profile) => profile.url.length > 0),
    },
    work,
    education,
    projects,
    skills,
    certificates,
    claims,
    xClearance: clearance,
    unsupported,
  };
}
