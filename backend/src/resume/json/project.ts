// =====================================================================================
// resume/json/project.ts - DB (profile + claims) -> Resume JSON (T1030)
// NORMATIVE: 05 sec.1, sec.6. DECISION: ADR-035. INVARIANT: ADR-036.
//
// WHAT THIS IS. The forward direction of ADR-035's "direction of truth": the career
// profile and its claims are the STORE, and a Resume JSON document is a PROJECTION of
// them. Nothing here writes a claim, and nothing here can promote one.
//
//   CareerProfile + Experience/Education/Project/Skill + CareerClaim[]
//        -> ResumeJson (JSON Resume + x-clearance)
//        -> ResumeRevision.resumeJson  (resume/revisions.ts)
//
// THE PROJECTION DOES NOT FILTER BY STATUS, AND THAT IS THE POINT. It emits every
// claim the caller selected, each with its REAL status in the `x-clearance` block, and
// the `x-clearance` block records the usage so the pre-render gate can decide. A
// projector that silently dropped unconfirmed claims would make the gate untestable and
// would hide the draft from the user - 05 sec.2.5 says an inferred claim "may exist in
// the profile and may even be surfaced as 'suggested'", and the draft revision is how
// the user SEES it before confirming. Selection is the CALLER's decision
// (`ProjectionSelection`); this module reports truthfully what it was given.
//
// THE STATUS IN `x-clearance` COMES FROM THE CLAIM ROW AND NOWHERE ELSE. There is no
// parameter, no option and no field through which a caller could pass a status, so a
// projector that lied about a status is not a reachable state of this code. The
// hand-edited-import direction is closed on the other side, in `lowerResumeJson`.
//
// DETERMINISM IS A REQUIREMENT, NOT A NICETY. `ResumeRevision.jsonHash` is the identity
// of a snapshot, and the diff UX compares two of them, so the same inputs must produce
// byte-identical output on every host and in every process. That means: every array is
// ordered by an explicit total order (never by whatever the database returned), every
// object is built with literal keys in a fixed order, and the final serialisation goes
// through `canonicalJsonString`. NO CLOCK, NO RANDOM, NO `createdAt` in the document.
// `createdAt` IS available for ORDERING (it is data), which is the one legitimate use.
//
// THE DB SEAM IS INJECTED, following `career/claims.ts`. This module never imports the
// `prisma` singleton, so the whole projection - including the legacy
// `modelVersion = 1` backfill - is provable with no live database.
// =====================================================================================

import {
  ClaimKind,
  ClaimStatus,
  ResumeUsage,
  type CareerClaim,
  type Certification,
  type Education,
  type Experience,
  type PrismaClient,
  type Project as ProjectRow,
  type Skill,
} from '@prisma/client';

import {
  ClearanceClaimEntry,
  canonicalJsonString,
  type ClearanceBlock,
  type JsonResumeBasics,
  type JsonResumeCertificate,
  type JsonResumeEducation,
  type JsonResumeLocation,
  type JsonResumeProfile,
  type JsonResumeProject,
  type JsonResumeSkill,
  type JsonResumeWork,
  type ResumeJson,
  X_CLEARANCE_KEY,
  X_CLEARANCE_VERSION,
} from './jsonresume.js';
import {
  GATED_USAGES,
  IMPORTED_CLAIM_PROVENANCE,
  IMPORTED_CLAIM_STATUS,
  isRejectedClaimStatus,
  isRenderableClaimStatus,
} from '../../career/claimUsage.js';
import { CLAIM_BACKED_TEXT_PATHS, pathFromTemplate } from './claimSurface.js';

/**
 * The templates this projector writes CLAIM text into, by index into the single
 * shared definition (`claimSurface.ts`, ADR-043).
 *
 * They are not written out as literals here on purpose. The pre-render belt walks the
 * SAME constant, and its rule is "every claim-backed string must be named, at that exact
 * path, by a text-rendering entry of this document's own block". A second literal would
 * be a second thing to keep in step with the belt, and the previous attempt's bug was
 * exactly a second thing kept out of step.
 *
 * `BASICS_SUMMARY` is the third member, added when T1080 closed ADR-043's R-SUMMARY
 * residual. It carries no wildcard, so it needs no index.
 */
const WORK_HIGHLIGHTS = CLAIM_BACKED_TEXT_PATHS[0];
const PROJECT_HIGHLIGHTS = CLAIM_BACKED_TEXT_PATHS[1];
const BASICS_SUMMARY = CLAIM_BACKED_TEXT_PATHS[2];

// ---------------------------------------------------------------------------
// The injected DB seam
// ---------------------------------------------------------------------------

/**
 * The narrowest seam the projector needs, `Pick`ed from the generated client. Read-only
 * by construction: `Pick` selects only the read delegates, so this module CANNOT write
 * a claim, a profile or an entity even if someone tried - the compiler refuses.
 */
export type ResumeProjectionStore = Pick<
  PrismaClient,
  'careerProfile' | 'experience' | 'education' | 'project' | 'skill' | 'certification' | 'careerClaim' | 'resume'
>;

// ---------------------------------------------------------------------------
// The projection input
// ---------------------------------------------------------------------------

/** One candidate claim, paired with how (or whether) it appears. */
export interface ProjectedClaim {
  claim: CareerClaim;
  /**
   * `verbatim` - the claim's statement appears as-is.
   * `tailored` - it appears re-worded; `renderedText` carries the text and the claim
   *   is the source of the FACTS (05 sec.6.3: tailoring may re-phrase a confirmed
   *   claim's text, never introduce a fact).
   * `omitted` - considered, and deliberately not in the document. This is how a draft
   *   says "the profile knows this and the resume does not say it".
   *
   * Omit it and the projector decides: attached to an entity -> `verbatim`, otherwise
   * `omitted`.
   */
  usage?: ResumeUsage;
  /** Required whenever the claim appears in the document. Ignored when `omitted`. */
  renderedText?: string | null;
}

export interface ProjectedExperience {
  experience: Experience;
  claims: ProjectedClaim[];
}

export interface ProjectedEducation {
  education: Education;
  claims: ProjectedClaim[];
}

export interface ProjectedProject {
  project: ProjectRow;
  claims: ProjectedClaim[];
}

export interface ProjectedSkill {
  skill: Skill;
  claims: ProjectedClaim[];
}

export interface ProjectedCertificate {
  certification: Certification;
  claims: ProjectedClaim[];
}

export interface ProjectionBasics {
  name: string;
  label?: string | null;
  email?: string | null;
  phone?: string | null;
  url?: string | null;
  summary?: string | null;
  location?: JsonResumeLocation | null;
  profiles?: JsonResumeProfile[];
}

export interface ProjectionInput {
  profileId: string;
  basics: ProjectionBasics;
  work?: readonly ProjectedExperience[];
  education?: readonly ProjectedEducation[];
  projects?: readonly ProjectedProject[];
  skills?: readonly ProjectedSkill[];
  certificates?: readonly ProjectedCertificate[];
  /**
   * Claims that belong to no projected entity. They still appear in the `x-clearance`
   * block (with `usage: 'omitted'` and `jsonPath: null`) so the document accounts for
   * everything the projection considered - an audit that only lists what it emitted
   * cannot answer "what did you leave out?".
   */
  otherClaims?: readonly ProjectedClaim[];
  /**
   * The candidates for `basics.summary`, i.e. the profile's SUMMARY claims (T1080,
   * ADR-043 R-SUMMARY).
   *
   * WHY THEY ARE A SEPARATE LIST AND NOT PART OF `basics`. `basics.summary` is the only
   * profile column on the claim rail: T1020 creates a `soft_skill` claim for the parsed
   * professional summary, so the summary can be - and from T1080 IS - a CLAIM the belt
   * accounts for. The projector places the EARLIEST candidate (by `createdAt`, then `id`,
   * the same total order it uses for a highlight run) at `basics.summary` as a rendered
   * usage, and records every OTHER candidate as `omitted`.
   *
   * WHEN THE LIST IS EMPTY, `basics.summary` falls back to the profile column and the
   * string is placed with NO claim naming it - which the pre-render belt now REFUSES
   * (`DOCUMENT_UNAUDITED`, naming the path). That is the honest state of a summary the
   * user typed and never turned into a claim, and it is the price ADR-043 accepted when it
   * named R-SUMMARY. The projector deliberately does not throw: it must not drop profile
   * text to satisfy the belt (ADR-035), and the PREVIEW route is where a user sees the
   * document they would get, this problem included.
   *
   * WHEN THE EARLIEST CANDIDATE IS REJECTED, `resolveUsage` makes it `omitted` and NO
   * fallback happens: a rejected claim's statement must never reach the document as text
   * (F3), and falling back to the profile column would put the same sentence back with
   * even less provenance. The summary is then simply absent.
   */
  summaryClaims?: readonly ProjectedClaim[];
  /** `Resume.modelVersion` of the row this snapshot came from. 1 for a legacy backfill. */
  sourceModelVersion?: number;
}

export interface ProjectionResult {
  document: ResumeJson;
  clearance: ClearanceBlock;
  /** The canonical bytes. What `jsonHash` is computed over. */
  canonical: string;
}

// ---------------------------------------------------------------------------
// Ordering: one total order per collection, never "whatever the query returned"
// ---------------------------------------------------------------------------

/**
 * Ascending by `createdAt` (data, so it is stable), then `id` (never null, unique).
 *
 * TOLERANT of a missing or non-Date `createdAt`: a real row always has one, but a
 * projection is also fed DRAFT claim objects (the legacy `modelVersion = 1` preview
 * builds them from a JSON row that has never been persisted), and a total order that
 * throws a raw `TypeError: Cannot read properties of undefined (reading 'getTime')` on a
 * perfectly reasonable input is not an order. A missing timestamp sorts as epoch, so the
 * `id` tiebreak still makes the result deterministic.
 */
function byCreatedThenId<T extends { id: string; createdAt: Date }>(a: T, b: T): number {
  const time = (value: Date | undefined): number =>
    value instanceof Date && !Number.isNaN(value.getTime()) ? value.getTime() : 0;
  const delta = time(a.createdAt) - time(b.createdAt);
  if (delta !== 0) return delta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Entity order is `sortOrder` (the user's explicit ordering, 05 sec.5 gives every
 * entity one) then `id`. `sortOrder` defaults to 0, so a profile that never ordered
 * anything falls back to insertion order and then to the id, which is a total order
 * and therefore still deterministic.
 */
function bySortOrderThenId<T extends { id: string; sortOrder: number }>(a: T, b: T): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Document order for the TEXT of a claim set: `createdAt` (when the user added the
 * fact) then `id`. This is the order a reader expects inside a role - chronological -
 * and it is a total order over data, so it is deterministic.
 *
 * NOT `claimId`: a production id is a uuid, so sorting highlights by it would produce a
 * stable but arbitrary order that changes completely if a claim is re-created with the
 * same text. The `x-clearance` block's own `claims` array IS sorted by `claimId`
 * instead, because that array is an audit list rather than a document, and an audit
 * list wants a key that never moves.
 */
function byClaimCreatedThenId(a: ProjectedClaim, b: ProjectedClaim): number {
  return byCreatedThenId(a.claim, b.claim);
}

// ---------------------------------------------------------------------------
// Small readers (tolerant, so one bad row cannot take the whole projection down)
// ---------------------------------------------------------------------------

function text(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function nonEmpty(value: string | null | undefined, fallback: string): string {
  return text(value) ?? fallback;
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/** The `generatedBy` marker. Names the module, so a document says who produced it. */
export const PROJECTION_GENERATOR = 'clearance/resume-json/project@1';

/**
 * The usage a claim is recorded with, and therefore the only question that decides whether
 * its text reaches the document.
 *
 * F3: A REJECTED CLAIM IS NEVER PLACED AS RENDERED TEXT. `loadProjectionInput` loads every
 * claim of the profile with no status filter, and an attach-then-reject (which T1054's
 * reject-then-attach rule does not cover - `rejectUserClaim` writes only `status` and leaves
 * the FK alone) leaves a `rejected` claim attached to an experience. Without this line the
 * projector put that statement into `work[i].highlights` as `verbatim` and returned it to
 * the client from `POST /resumes/:id/project`: a statement the user had rejected, shown on
 * the page, and the only signal anything was wrong was the revision write's 409.
 *
 * The claim is NOT dropped. It is recorded as `omitted` with a null `jsonPath`, which is
 * what it is: considered, and not said. That is the `x-clearance` block's job (05 sec.2.5's
 * "what did you leave out?"), it keeps the document a complete account of itself, and an
 * `omitted` usage is inert at render time - `career/claimUsage.ts` records it without
 * complaint and `evaluatePreRenderGate` returns early for it. The rule is applied HERE, in
 * the pure projector, rather than by filtering `loadProjectionInput`, because a loader-side
 * filter would drop the claim out of the block entirely and lose the accounting.
 *
 * `superseded` is DELIBERATELY NOT COVERED. A superseded claim is replaced by a newer one
 * that carries the text, and ADR-036 item 5 puts it outside the renderable set rather than
 * outside the profile: it is still placed, and the pre-render gate is what refuses it, with
 * `CLAIM_NOT_CONFIRMED`. Widening this to every non-renderable status would stop the gate
 * from ever firing and delete its demonstration.
 */
function resolveUsage(entry: ProjectedClaim, isPlaced: boolean): ResumeUsage {
  // `isRejectedClaimStatus`, not a status literal: the claim status vocabulary belongs
  // to `career/`, and the source guard in `claimWriterAI.test.ts` fails the moment a module
  // outside it hard-codes a status literal.
  if (isRejectedClaimStatus(entry.claim.status)) return ResumeUsage.omitted;
  if (entry.usage !== undefined) return entry.usage;
  return isPlaced ? ResumeUsage.verbatim : ResumeUsage.omitted;
}

function renderedTextFor(entry: ProjectedClaim, usage: ResumeUsage): string | null {
  if (usage === ResumeUsage.omitted) return null;
  if (typeof entry.renderedText === 'string' && entry.renderedText.trim().length > 0) {
    return entry.renderedText.trim();
  }
  return entry.claim.statement.trim();
}

/**
 * Project a profile + its claims into a Resume JSON document.
 *
 * PURE and DETERMINISTIC: no clock, no randomness, no I/O, no module state. The same
 * input object graph produces the same bytes every time, which is what makes
 * `jsonHash` a usable snapshot identity.
 *
 * The `x-clearance` block is assembled from the CLAIM ROWS. `status` is copied from
 * `claim.status` and there is no code path by which any other value can reach that
 * field - the acceptance test asserts that a projector asked to lie cannot be written
 * at all, and the import test asserts the other direction (a hand-edited document
 * cannot lie on the way in).
 */
export function projectResumeJson(input: ProjectionInput): ProjectionResult {
  if (input === null || typeof input !== 'object') {
    throw new ProjectionError('INVALID_INPUT', 'projectResumeJson needs an input object');
  }
  if (typeof input.profileId !== 'string' || input.profileId.length === 0) {
    throw new ProjectionError('INVALID_INPUT', 'a non-empty profileId is required');
  }
  if (input.basics === null || typeof input.basics !== 'object') {
    throw new ProjectionError('INVALID_INPUT', 'basics is required (JSON Resume requires basics.name)');
  }

  const entries: Array<{ claim: CareerClaim; usage: ResumeUsage; jsonPath: string | null; renderedText: string | null }> = [];

  /**
   * Decide a claim's placement BEFORE recording it, because "is it placed" decides
   * whether it has a `jsonPath` at all, and the index inside a `highlights` array is
   * only knowable once every claim that contributes nothing has been dropped.
   *
   * WHY THAT IS NOT A DETAIL (ADR-043). The first version of this projector did
   * `.map((entry, i) => place(entry, `work[0].highlights[${i}]`, true)).filter(v => v !== null)`,
   * so `i` was the PRE-filter index: a claim that produced no text was dropped from the
   * array while keeping the block entry that named its slot, and every later highlight
   * was recorded one slot to the right of where its text actually is. The read-time belt
   * compares the stored text's path against the block entry's path, so that document -
   * a perfectly legitimate projection - was refused as `DOCUMENT_UNAUDITED`. The belt is
   * right to refuse a path that does not hold the text; the PROJECTOR was wrong to name
   * it, and the rule was not relaxed to accommodate it.
   *
   * A claim that renders NO TEXT is recorded as what it is - considered, not rendered -
   * because a `''` bullet is not a rendering of anything, and `recordClaimUsages` refuses
   * a gated usage whose `renderedText` is blank anyway, so the previous shape produced a
   * document the revision writer would not accept.
   */
  const placementOf = (
    entry: ProjectedClaim,
    isPlaced: boolean,
    jsonPath: string,
  ): { text: string | null; usage: ResumeUsage; jsonPath: string | null; renderedText: string | null } => {
    const usage = resolveUsage(entry, isPlaced);
    const rendered = renderedTextFor(entry, usage);
    const placed = typeof rendered === 'string' && rendered.length > 0;
    return {
      text: placed ? rendered : null,
      usage: placed ? usage : ResumeUsage.omitted,
      jsonPath: placed ? jsonPath : null,
      renderedText: placed ? rendered : null,
    };
  };

  /** Record a claim's placement in the block; the text is what the document carries. */
  const place = (
    entry: ProjectedClaim,
    placement: { usage: ResumeUsage; jsonPath: string | null; renderedText: string | null },
  ): void => {
    entries.push({
      claim: entry.claim,
      usage: placement.usage,
      jsonPath: placement.jsonPath,
      renderedText: placement.renderedText,
    });
  };

  /**
   * Place a run of claim-backed text into one array member, recording the POST-filter
   * index each claim really occupies.
   *
   * One loop, two steps, in this order: decide whether a claim contributes anything, and
   * only then take the next index. `work[0].highlights[j]` is a claim's address in the
   * document, so an address that is off by one is the block lying about where its own
   * text is - and both the belt and a human reading the audit would be reading the lie.
   */
  const placeClaimText = (claims: readonly ProjectedClaim[], pathFor: (index: number) => string): string[] => {
    const texts: string[] = [];
    for (const claim of [...claims].sort(byClaimCreatedThenId)) {
      const placement = placementOf(claim, true, '');
      if (placement.text === null) {
        // Renders nothing: recorded as `omitted` with a null path, so the block never
        // names a slot this claim does not occupy.
        place(claim, placement);
        continue;
      }
      texts.push(placement.text);
      place(claim, { ...placement, jsonPath: pathFor(texts.length - 1) });
    }
    return texts;
  };

  // -- work -----------------------------------------------------------------------
  // The index is threaded as a MAP PARAMETER, not read from `work.length` inside the
  // callback. Reading the array being assigned is a temporal-dead-zone bug: `work` is in
  // scope but uninitialised until the whole `.map()` returns, so the first access throws
  // `ReferenceError: Cannot access 'work' before initialization`. The first version of
  // this module did exactly that, and the projection failed on its very first work
  // entry - which is why the tests below are the acceptance item they are.
  const sortedWork = [...(input.work ?? [])].sort((a, b) =>
    bySortOrderThenId(a.experience, b.experience),
  );
  const work: JsonResumeWork[] = sortedWork.map(({ experience, claims }, index) => {
    const highlights = placeClaimText(claims, (highlightIndex) =>
      pathFromTemplate(WORK_HIGHLIGHTS, [index, highlightIndex]),
    );
    const entry: JsonResumeWork = {
      name: nonEmpty(experience.company, 'Unknown employer'),
      position: nonEmpty(experience.title, 'Unknown role'),
    };
    // `Experience.location` is a free-text place, not a URL. JSON Resume's `location`
    // member lives on `basics` only, and `url` would be turned into a hyperlink to
    // "Berlin, Germany" by most themes, so the place goes in the entry's own `summary`
    // line - which is the one free-text field a work entry has.
    const place_ = text(experience.location);
    if (place_ !== undefined) entry.summary = place_;
    const startDate = text(experience.startDate);
    if (startDate !== undefined) entry.startDate = startDate;
    // A CURRENT role has no end date. JSON Resume's convention is an absent endDate,
    // and emitting `endDate: ''` would render as "2020 - " in most themes.
    if (!experience.current) {
      const endDate = text(experience.endDate);
      if (endDate !== undefined) entry.endDate = endDate;
    }
    if (highlights.length > 0) entry.highlights = highlights;
    return entry;
  });

  // -- education ------------------------------------------------------------------
  const sortedEducation = [...(input.education ?? [])].sort((a, b) =>
    bySortOrderThenId(a.education, b.education),
  );
  const education: JsonResumeEducation[] = sortedEducation.map(({ education: row, claims }, index) => {
    // Education claims are `omitted` in practice: the row already carries the
    // institution, the degree and the year, and restating them as highlights would
    // duplicate the section. They are still RECORDED, so the block accounts for them.
    [...claims].sort(byClaimCreatedThenId).forEach((entry) => place(entry, placementOf(entry, false, `education[${index}]`)));
    const out: JsonResumeEducation = {
      institution: nonEmpty(row.institution, 'Unknown institution'),
    };
    const studyType = text(row.degree);
    if (studyType !== undefined) out.studyType = studyType;
    const area = text(row.field);
    if (area !== undefined) out.area = area;
    const endDate = text(row.graduationYear);
    if (endDate !== undefined) out.endDate = endDate;
    return out;
  });

  // -- projects -------------------------------------------------------------------
  const sortedProjects = [...(input.projects ?? [])].sort((a, b) =>
    bySortOrderThenId(a.project, b.project),
  );
  const projects: JsonResumeProject[] = sortedProjects.map(({ project, claims }, index) => {
    const sorted = [...claims].sort(byClaimCreatedThenId);
    const out: JsonResumeProject = { name: nonEmpty(project.name, 'Untitled project') };
    const description = text(project.description);
    if (description !== undefined) out.description = description;
    const highlights = placeClaimText(sorted, (highlightIndex) =>
      pathFromTemplate(PROJECT_HIGHLIGHTS, [index, highlightIndex]),
    );
    if (highlights.length > 0) out.highlights = highlights;
    // `Project.tech` is a Json column with no schema on it; only a genuine string array
    // is projected, so a malformed column degrades to "no keywords" instead of putting
    // a non-string into the document and failing validation over one bad column.
    const tech = Array.isArray(project.tech)
      ? project.tech.filter((item): item is string => typeof item === 'string')
      : [];
    if (tech.length > 0) out.keywords = [...tech];
    const repoUrl = text(project.repoUrl) ?? text(project.liveUrl);
    if (repoUrl !== undefined) out.url = repoUrl;
    const startDate = text(project.startDate);
    if (startDate !== undefined) out.startDate = startDate;
    const endDate = text(project.endDate);
    if (endDate !== undefined) out.endDate = endDate;
    return out;
  });

  // -- skills ---------------------------------------------------------------------
  const sortedSkills = [...(input.skills ?? [])].sort((a, b) =>
    bySortOrderThenId(a.skill, b.skill),
  );
  const skills: JsonResumeSkill[] = sortedSkills.map(({ skill, claims }, index) => {
    // The skill NAME is a claim (`kind: 'skill'`), so it is recorded against the skill's
    // own path. It is `omitted` because the name is already in the document from the
    // `Skill` row - the claim is the EVIDENCE for the name, not a second copy of it.
    [...claims].sort(byClaimCreatedThenId).forEach((entry) => place(entry, placementOf(entry, false, `skills[${index}].name`)));
    const out: JsonResumeSkill = { name: nonEmpty(skill.name, 'Unnamed skill') };
    const level = text(skill.level);
    if (level !== undefined) out.level = level;
    return out;
  });

  // -- certificates ---------------------------------------------------------------
  const sortedCertificates = [...(input.certificates ?? [])].sort((a, b) =>
    a.certification.name < b.certification.name ? -1 : a.certification.name > b.certification.name ? 1 : 0,
  );
  const certificates: JsonResumeCertificate[] = sortedCertificates.map(
    ({ certification, claims }, index) => {
      [...claims]
        .sort(byClaimCreatedThenId)
        .forEach((entry) => place(entry, placementOf(entry, false, `certificates[${index}]`)));
      const out: JsonResumeCertificate = {
        name: nonEmpty(certification.name, 'Unnamed certificate'),
      };
      const issuedOn = text(certification.issuedOn);
      if (issuedOn !== undefined) out.date = issuedOn;
      const issuer = text(certification.issuer);
      if (issuer !== undefined) out.issuer = issuer;
      const url = text(certification.credentialUrl);
      if (url !== undefined) out.url = url;
      return out;
    },
  );

  // -- unplaced claims ------------------------------------------------------------
  [...(input.otherClaims ?? [])].sort(byClaimCreatedThenId).forEach((entry) => place(entry, placementOf(entry, false, '')));

  // -- basics.summary (ADR-043 R-SUMMARY, closed by T1080) -------------------------
  //
  // `place`/`placementOf` above are scoped to this function, so the summary is placed HERE
  // rather than in a helper, and its text is remembered for the `basics` literal below.
  //
  // THE ORDER OF THE TWO LINES IS THE RULE. A summary CLAIM, when one is offered, is the
  // summary: there is no column fallback behind it, so a rejected candidate leaves the
  // summary absent rather than resurrecting the same sentence from `basics.summary`. Only
  // when there is NO candidate at all does the profile column carry the string - and that
  // string is then on the claim rail with nothing behind it, which the belt refuses at
  // revision-write time. Both halves are stated in `ProjectionInput.summaryClaims`.
  const summaryPath = pathFromTemplate(BASICS_SUMMARY);
  const summaryCandidates = [...(input.summaryClaims ?? [])].sort(byClaimCreatedThenId);
  let summaryText: string | undefined;
  if (summaryCandidates.length > 0) {
    const [placed, ...rest] = summaryCandidates as [ProjectedClaim, ...ProjectedClaim[]];
    const placement = placementOf(placed, true, summaryPath);
    place(placed, placement);
    summaryText = placement.text ?? undefined;
    // Every other candidate is CONSIDERED AND NOT USED. Dropping it from the block would
    // make the document an incomplete account of itself, which is the one thing the
    // `x-clearance` ledger exists to prevent (05 sec.2.5's "what did you leave out?").
    for (const entry of rest) place(entry, placementOf(entry, false, summaryPath));
  } else {
    summaryText = text(input.basics.summary);
  }

  // -- the x-clearance block ------------------------------------------------------
  // Sorted by `claimId`: a TOTAL order that does not depend on the order entries were
  // placed in, so two projections of the same data produce the same array.
  const ordered = [...entries].sort((a, b) =>
    a.claim.id < b.claim.id ? -1 : a.claim.id > b.claim.id ? 1 : 0,
  );

  const claims: ClearanceClaimEntry[] = ordered.map((entry) => ({
    claimId: entry.claim.id,
    fingerprint: entry.claim.fingerprint,
    kind: entry.claim.kind,
    // THE LINE. The status is the claim row's, read at projection time. There is no
    // parameter through which a different value could arrive.
    status: entry.claim.status,
    provenance: entry.claim.provenance,
    confidence: entry.claim.confidence ?? null,
    evidenceSourceId: entry.claim.evidenceSourceId ?? null,
    usage: entry.usage,
    jsonPath: entry.jsonPath,
    renderedText: entry.renderedText,
  }));

  const confirmed = claims.filter((entry) => isRenderableClaimStatus(entry.status)).length;
  const clearance: ClearanceBlock = {
    version: X_CLEARANCE_VERSION,
    generatedBy: PROJECTION_GENERATOR,
    sourceModelVersion: input.sourceModelVersion ?? 2,
    profileId: input.profileId,
    claimCount: claims.length,
    confirmedClaimCount: confirmed,
    unconfirmedClaimCount: claims.length - confirmed,
    claims,
  };

  const basics: JsonResumeBasics = { name: nonEmpty(input.basics.name, 'Unnamed') };
  const label = text(input.basics.label);
  if (label !== undefined) basics.label = label;
  const email = text(input.basics.email);
  if (email !== undefined) basics.email = email;
  const phone = text(input.basics.phone);
  if (phone !== undefined) basics.phone = phone;
  const url = text(input.basics.url);
  if (url !== undefined) basics.url = url;
  const summary = summaryText;
  if (summary !== undefined) basics.summary = summary;
  if (input.basics.location && Object.keys(input.basics.location).length > 0) {
    basics.location = input.basics.location;
  }
  if (input.basics.profiles && input.basics.profiles.length > 0) {
    // Sorted by url then network: `basics.profiles` has no `sortOrder`, and an
    // unordered array would make the document's bytes depend on insertion order.
    basics.profiles = [...input.basics.profiles]
      .filter((profile) => typeof profile?.url === 'string' && profile.url.trim().length > 0)
      .sort((a, b) => {
        if (a.url !== b.url) return a.url < b.url ? -1 : 1;
        const left = a.network ?? '';
        const right = b.network ?? '';
        return left < right ? -1 : left > right ? 1 : 0;
      });
  }

  const document: ResumeJson = { basics };
  if (work.length > 0) document.work = work;
  if (education.length > 0) document.education = education;
  if (projects.length > 0) document.projects = projects;
  if (skills.length > 0) document.skills = skills;
  if (certificates.length > 0) document.certificates = certificates;
  document[X_CLEARANCE_KEY] = clearance;

  return { document, clearance, canonical: canonicalJsonString(document) };
}

function endDateOf(project: ProjectRow): string | undefined {
  return text(project.endDate);
}

/** The projected section counts, for a caller that wants the shape without the document. */
export interface ProjectionShape {
  work: number;
  education: number;
  projects: number;
  skills: number;
  certificates: number;
}

export function projectionShape(document: ResumeJson): ProjectionShape {
  return {
    work: document.work?.length ?? 0,
    education: document.education?.length ?? 0,
    projects: document.projects?.length ?? 0,
    skills: document.skills?.length ?? 0,
    certificates: document.certificates?.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Loading the projection input from the database
// ---------------------------------------------------------------------------

export interface LoadProjectionOptions {
  /**
   * `Resume.modelVersion` recorded in the block. 1 for a legacy row, so the document
   * says which shape it came from without a renderer having to ask.
   */
  sourceModelVersion?: number;
  basics?: ProjectionBasics;
}

/** The legacy `Resume` row shape the backfill reads (05 sec.7.7). */
interface LegacyResumeRow {
  id: string;
  modelVersion: number;
  profileId: string | null;
  personalInfo: unknown;
  summary: string;
  experience: unknown;
  education: unknown;
  skills: unknown;
  name: string;
}

function legacyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function legacyText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function legacyTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(legacyText).filter((entry): entry is string => entry !== undefined);
}

/**
 * A `modelVersion = 1` (legacy builder) `Resume` row as claim drafts.
 *
 * 05 sec.7.7 is the requirement and it is unambiguous: for each existing `Resume` with
 * `modelVersion = 1`, `experience[].bullets` become claims with `status = inferred`,
 * `provenance = document_import`, "so a user's existing resume appears in the new
 * studio as an UNVERIFIED DRAFT - which is the honest state. Never auto-confirm
 * imported content."
 *
 * So this returns DRAFTS with `IMPORTED_CLAIM_STATUS` hard-coded. The career layer owns
 * that constant (see `career/claimUsage.ts`), and `createClaim` is the only thing that
 * can turn a draft into a row - and it cannot be handed a confirming status. There is no
 * parameter here to influence the status, which is the acceptance criterion.
 *
 * PURE: it reads a row and returns drafts; it writes nothing.
 */
export function legacyResumeToClaimDrafts(resume: LegacyResumeRow): Array<{
  kind: import('@prisma/client').ClaimKind;
  statement: string;
  status: typeof IMPORTED_CLAIM_STATUS;
  provenance: typeof IMPORTED_CLAIM_PROVENANCE;
  inferenceMethod: 'legacy_resume_backfill';
  jsonPath: string;
}> {
  const drafts: Array<{
    kind: import('@prisma/client').ClaimKind;
    statement: string;
    status: typeof IMPORTED_CLAIM_STATUS;
    provenance: typeof IMPORTED_CLAIM_PROVENANCE;
    inferenceMethod: 'legacy_resume_backfill';
    jsonPath: string;
  }> = [];

  const experience = Array.isArray(resume.experience) ? resume.experience : [];
  experience.forEach((raw, index) => {
    const entry = legacyRecord(raw);
    const position = legacyText(entry.title);
    const company = legacyText(entry.company);
    // The ROLE itself is a claim ("was a Staff Engineer at Acme"), and it is the fact a
    // legacy row asserts most confidently, so it is captured - as an inferred one.
    if (position !== undefined) {
      drafts.push({
        kind: 'role',
        statement: company === undefined ? position : `${position} at ${company}`,
        status: IMPORTED_CLAIM_STATUS,
        provenance: IMPORTED_CLAIM_PROVENANCE,
        inferenceMethod: 'legacy_resume_backfill',
        jsonPath: `experience[${index}].title`,
      });
    }
    legacyTextArray(entry.bullets).forEach((bullet, bulletIndex) => {
      drafts.push({
        kind: 'achievement',
        statement: bullet,
        status: IMPORTED_CLAIM_STATUS,
        provenance: IMPORTED_CLAIM_PROVENANCE,
        inferenceMethod: 'legacy_resume_backfill',
        jsonPath: `experience[${index}].bullets[${bulletIndex}]`,
      });
    });
  });

  const skills = Array.isArray(resume.skills) ? resume.skills : [];
  skills.forEach((raw, index) => {
    const name = typeof raw === 'string' ? legacyText(raw) : legacyText(legacyRecord(raw).name);
    if (name === undefined) return;
    drafts.push({
      kind: 'skill',
      statement: name,
      status: IMPORTED_CLAIM_STATUS,
      provenance: IMPORTED_CLAIM_PROVENANCE,
      inferenceMethod: 'legacy_resume_backfill',
      jsonPath: `skills[${index}]`,
    });
  });

  const summary = legacyText(resume.summary);
  if (summary !== undefined) {
    drafts.push({
      kind: 'soft_skill',
      statement: summary,
      status: IMPORTED_CLAIM_STATUS,
      provenance: IMPORTED_CLAIM_PROVENANCE,
      inferenceMethod: 'legacy_resume_backfill',
      jsonPath: 'summary',
    });
  }

  return drafts;
}

/**
 * Build a `ProjectionInput` for a profile, reading only what the projector needs.
 *
 * Every collection is sorted HERE as well as in the projector. Belt and braces: the
 * projector's sort is what makes the function pure-and-deterministic, and this one
 * makes the loaded input itself inspectable in a test without depending on the
 * projector's internal ordering.
 */
export async function loadProjectionInput(
  profileId: string,
  store: ResumeProjectionStore,
  options: LoadProjectionOptions = {},
): Promise<ProjectionInput> {
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new ProjectionError('INVALID_INPUT', 'loadProjectionInput: a non-empty profileId is required');
  }
  const profile = await store.careerProfile.findUnique({ where: { id: profileId } });
  if (!profile) throw new ProjectionError('PROFILE_NOT_FOUND', `career profile ${profileId}`);

  const [experiences, educations, projects, skills, certifications, claims] = await Promise.all([
    store.experience.findMany({ where: { profileId } }),
    store.education.findMany({ where: { profileId } }),
    store.project.findMany({ where: { profileId } }),
    store.skill.findMany({ where: { profileId } }),
    store.certification.findMany({ where: { profileId } }),
    store.careerClaim.findMany({ where: { profileId } }),
  ]);

  const sortedClaims = [...claims].sort(byCreatedThenId);
  const byEntity = (field: keyof CareerClaim, id: string): ProjectedClaim[] =>
    sortedClaims
      .filter((claim) => claim[field] === id)
      .map((claim) => ({ claim }));

  /**
   * A claim attached to NO projected entity. The single definition both collections below
   * use, so the `otherClaims` / `summaryClaims` split cannot double-record one claim -
   * which would be refused at write time by ADR-043 decision 4
   * (`assertOneUsagePerClaimId`), i.e. every projection of a profile with a summary claim
   * would fail for a reason that looks like a bug and is a fixture.
   *
   * `achievementId` is DELIBERATELY NOT one of the six checks, because the `otherClaims`
   * filter it replaces did not check it either: a claim attached only to an `Achievement`
   * appears in NEITHER list, exactly as before. Changing that is a different task's
   * decision, and quietly widening this predicate would change every existing projection.
   */
  const isUnattached = (claim: CareerClaim): boolean =>
    claim.experienceId === null &&
    claim.educationId === null &&
    claim.projectId === null &&
    claim.skillId === null &&
    claim.certificationId === null;

  /**
   * WHICH CLAIMS ARE THE SUMMARY (T1080, ADR-043 R-SUMMARY).
   *
   * `kind === 'soft_skill'` AND unattached. The kind is T1020's own: the resume import
   * emits the professional summary as a `soft_skill` claim and nothing else, and the
   * legacy backfill does the same (`legacyResumeToClaimDrafts`). The unattached half is
   * what keeps a `soft_skill` claim that was attached to an `Experience` as a highlight -
   * which is a different thing entirely - out of `basics.summary`.
   *
   * `ClaimKind` is READ from the enum, never a literal: the career layer owns that
   * vocabulary (`career/claimWriterAI.test.ts` fails a module outside `career/` that
   * hard-codes a status literal, and reading the enum is the same discipline applied to a
   * kind).
   */
  const isSummaryClaim = (claim: CareerClaim): boolean =>
    claim.kind === ClaimKind.soft_skill && isUnattached(claim);

  const basics: ProjectionBasics = options.basics ?? {
    name: nonEmpty(profile.headline, nonEmpty(profile.seniority, 'Unnamed')),
    summary: text(profile.summary) ?? null,
  };

  const input: ProjectionInput = {
    profileId,
    basics,
    work: [...experiences]
      .sort(bySortOrderThenId)
      .map((experience) => ({ experience, claims: byEntity('experienceId', experience.id) })),
    education: [...educations]
      .sort(bySortOrderThenId)
      .map((education) => ({ education, claims: byEntity('educationId', education.id) })),
    projects: [...projects]
      .sort(bySortOrderThenId)
      .map((project) => ({ project, claims: byEntity('projectId', project.id) })),
    skills: [...skills]
      .sort(bySortOrderThenId)
      .map((skill) => ({ skill, claims: byEntity('skillId', skill.id) })),
    certificates: [...certifications]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((certification) => ({
        certification,
        claims: byEntity('certificationId', certification.id),
      })),
    otherClaims: sortedClaims
      .filter((claim) => isUnattached(claim) && !isSummaryClaim(claim))
      .map((claim) => ({ claim })),
    // R-SUMMARY: offered to the projector as the summary, NOT as an unplaced claim. The
    // split above is what keeps the two lists disjoint, so the block records each claim
    // exactly once - which is the invariant `assertOneUsagePerClaimId` enforces.
    summaryClaims: sortedClaims.filter(isSummaryClaim).map((claim) => ({ claim })),
    sourceModelVersion: options.sourceModelVersion ?? 2,
  };
  return input;
}

/** Read a legacy `Resume` row for the `modelVersion = 1` backfill. */
export async function loadLegacyResume(
  resumeId: string,
  store: ResumeProjectionStore,
): Promise<LegacyResumeRow> {
  if (typeof resumeId !== 'string' || resumeId.length === 0) {
    throw new ProjectionError('INVALID_INPUT', 'loadLegacyResume: a non-empty resumeId is required');
  }
  const row = await store.resume.findUnique({ where: { id: resumeId } });
  if (!row) throw new ProjectionError('RESUME_NOT_FOUND', `resume ${resumeId}`);
  return row as unknown as LegacyResumeRow;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ProjectionErrorReason =
  | 'INVALID_INPUT'
  | 'PROFILE_NOT_FOUND'
  | 'RESUME_NOT_FOUND';

const REASON_TEXT: Readonly<Record<ProjectionErrorReason, string>> = Object.freeze({
  INVALID_INPUT: 'the projection input is malformed',
  PROFILE_NOT_FOUND: 'the career profile does not exist',
  RESUME_NOT_FOUND: 'the resume does not exist',
});

/** A projection that could not be built. Carries a machine-readable reason. */
export class ProjectionError extends Error {
  readonly code = 'resume_projection_failed' as const;
  readonly reason: ProjectionErrorReason;

  constructor(reason: ProjectionErrorReason, detail: string) {
    super(`resume_projection_failed: ${REASON_TEXT[reason]} (${detail})`);
    this.name = 'ProjectionError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// The projection's own self-check
// ---------------------------------------------------------------------------

/**
 * Verify that a projected document's `x-clearance` block agrees with the claim rows it
 * came from. This is the PROJECTOR'S OWN POST-CONDITION, and it is deliberately NOT what
 * the revision writer calls any more.
 *
 * WHY IT IS NOT THE WRITE PATH. It used to be, and the live V2 run is why that was wrong.
 * It refuses any block whose status disagrees with its row, and it cannot tell a FORGERY
 * from a STALE SNAPSHOT - the two are the same disagreement. The Studio loads the current
 * revision's document, the user edits it, and by then a claim has been CONFIRMED: the
 * block's statuses are honest and out of date, and autosave 400'd on every resume whose
 * claims moved after its revision was written. A guard that only ever punished the honest
 * case was not a guard. `createRevision` now calls `refreshClearanceFromClaims` below,
 * which is the same comparison with the disagreement RESOLVED in the database's favour.
 *
 * It stays, exported and unchanged, because the question it asks is still the right one
 * about the projector's own output: the projector copies `status` from the row and has no
 * parameter through which another value could arrive, so a projection that disagrees with
 * its rows is a BUG in the projector rather than a stale document, and refusing is correct.
 * A future edit that starts deriving a status from somewhere else fails this.
 */
export function assertClearanceMatchesClaims(
  clearance: ClearanceBlock,
  claims: readonly CareerClaim[],
): void {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  for (const entry of clearance.claims) {
    const claim = byId.get(entry.claimId);
    if (!claim) {
      throw new ProjectionError(
        'INVALID_INPUT',
        `x-clearance names claim ${entry.claimId}, which is not among the projected claims`,
      );
    }
    if (entry.status !== claim.status) {
      throw new ProjectionError(
        'INVALID_INPUT',
        `x-clearance claims ${entry.claimId} is ${entry.status} but the claim row says ${claim.status}`,
      );
    }
  }
}

/**
 * THE WRITE-TIME CROSS-CHECK, AS IT NOW STANDS: REFRESH, DO NOT REFUSE.
 *
 * Given a document's `x-clearance` block and the `CareerClaim` rows it names, return a
 * block whose ROW-DERIVED members are the rows' own values, and REFUSE the two cases that
 * are not about a stale field at all. This is what `revisions.ts#createRevision` calls.
 *
 * WHY REFRESHING IS NOT WEAKER THAN REFUSING - THE ARGUMENT, ONCE. The pre-render gate
 * reads status from the DATABASE (`loadGateUsages` -> the `ResumeClaimUsage` rows' claims)
 * and the render path RE-DERIVES the block from those same rows, so a forged `status`
 * cannot make anything render: there is no code path on which a document's stated status
 * is the status that is acted on. Refusing therefore bought nothing at render time, and
 * at write time it bought one thing - a stored block that is never a lie - which
 * overwriting the row's values delivers more completely than a 400 does. The one thing a
 * 400 DOES buy, which this does not, is telling the CALLER their document was wrong. The
 * live run showed what that is worth: the caller was not forging anything, the document
 * was simply older than the database, and the answer 400'd the Studio's autosave on every
 * resume whose claims had moved since its revision was written.
 *
 * So: a disagreement in a field the DATABASE owns is REPAIRED, and a disagreement about
 * WHICH claims are in play - the structure - is still refused.
 *
 * WHAT IS REFRESHED, and why exactly those members: `status`, `provenance`, `confidence`
 * and `evidenceSourceId`. Those are the four the projector copies from the row, and they
 * are the four a claim's EVIDENCE is described by. `claimCount` / `confirmedClaimCount` /
 * `unconfirmedClaimCount` are recomputed from the refreshed statuses with the same
 * `isRenderableClaimStatus` the projector uses, because leaving a stale count next to a
 * fresh status is the same lie one field over.
 *
 * WHAT IS NOT REFRESHED, deliberately: `usage`, `jsonPath` and `renderedText` - those
 * describe what the DOCUMENT does, not what the row says, and they are what
 * `assertClaimBackedTextAccounted` (write time) and rule 5 (read time) police.
 * `claimId`, `fingerprint` and `kind` are also left alone: the claim set is the writer's
 * to name, and refreshing `fingerprint`/`kind` would rewrite a document's own identity
 * claims about rows it merely references. `generatedBy`, `version`, `sourceModelVersion`
 * and `profileId` describe the document, not the rows.
 *
 * FAILS CLOSED, in three cases, and none of them is a stale field:
 *   1. the block names a claim that resolves to no row - there is no value to refresh
 *      FROM, and a claim id nobody can resolve is an unaccounted placement;
 *   2. a row is in play that the block does not name - the structural set mismatch. The
 *      block is a complete account of itself, so this is refused rather than invented;
 *   3. a block entry that is not a usable `{ claimId, ... }` object, or a `claims` member
 *      that is not an array - silently dropping such an entry would DELETE it from the
 *      stored document, which is a write this module must not make.
 */
export function refreshClearanceFromClaims(
  clearance: ClearanceBlock,
  claims: readonly CareerClaim[],
): { clearance: ClearanceBlock; changed: boolean } {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  if (!Array.isArray(clearance.claims)) {
    throw new ProjectionError('INVALID_INPUT', 'x-clearance.claims must be an array');
  }

  const refreshed: ClearanceClaimEntry[] = [];
  const named = new Set<string>();
  for (const entry of clearance.claims) {
    if (entry === null || typeof entry !== 'object' || typeof entry.claimId !== 'string' || entry.claimId.length === 0) {
      throw new ProjectionError(
        'INVALID_INPUT',
        'x-clearance.claims holds an entry that names no claim, so there is nothing to refresh it from',
      );
    }
    const claim = byId.get(entry.claimId);
    if (!claim) {
      throw new ProjectionError(
        'INVALID_INPUT',
        `x-clearance names claim ${entry.claimId}, which resolves to no claim row, so there is nothing to refresh it from`,
      );
    }
    named.add(entry.claimId);
    // Spread first, then overwrite: a refreshed member is never a merge that can leave a
    // stale copy of itself behind.
    refreshed.push({
      ...entry,
      status: claim.status,
      provenance: claim.provenance,
      confidence: claim.confidence ?? null,
      evidenceSourceId: claim.evidenceSourceId ?? null,
    });
  }

  // The structural set mismatch, in the direction the block cannot see for itself.
  for (const claimId of byId.keys()) {
    if (!named.has(claimId)) {
      throw new ProjectionError(
        'INVALID_INPUT',
        `x-clearance omits claim ${claimId}, which is in play for this revision; the block is the document's complete account of itself and may not under-declare`,
      );
    }
  }

  const confirmed = refreshed.filter((entry) => isRenderableClaimStatus(entry.status)).length;
  const next: ClearanceBlock = {
    ...clearance,
    claimCount: refreshed.length,
    confirmedClaimCount: confirmed,
    unconfirmedClaimCount: refreshed.length - confirmed,
    claims: refreshed,
  };
  return { clearance: next, changed: canonicalJsonString(clearance) !== canonicalJsonString(next) };
}

/** The gated-usage count in a document, for a caller that wants the shape of the risk. */
export function clearanceGatedUsageCount(clearance: ClearanceBlock): number {
  return clearance.claims.filter((entry) => GATED_USAGES.includes(entry.usage)).length;
}

export { ClaimStatus, ResumeUsage };
