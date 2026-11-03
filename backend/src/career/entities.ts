// =====================================================================================
// career/entities.ts - the ENTITY rows the projector places claims against (T1054).
//
// WHY THIS MODULE EXISTS. The V2 resume is a PROJECTION of the career profile
// (`resume/json/project.ts`): `loadProjectionInput` reads `Experience` / `Education` /
// `Project` / `Skill` / `Certification` rows and buckets the claims under each one by the
// claim's own foreign key. The import (T1020) deliberately writes only `EvidenceSource` +
// `CareerClaim` rows - T1030 judgement 7: "entity rows are not created by an import" - so
// after an import the profile holds claims the projector has nothing to hang them on, every
// claim lands in `otherClaims`, and the Studio edits an almost empty document
// (`rendered: 0` in the T1050 live run). These are user-authored CRUD operations, so this
// module is deliberately NOT part of any import: it never infers a row, never writes a claim
// and never touches a status.
//
// ATTACHMENT IS NOT A STATUS CHANGE, AND THAT IS THE POINT OF THE IMPLEMENTATION.
// `CareerClaim`'s six entity columns are ordinary attributes, so the write goes through
// `claims.ts#updateClaimAttributes` - the one function in the career layer whose TYPE has no
// `status` member and which THROWS at runtime when one is smuggled in past the type
// (ADR-036 item 2). Consequences, all of them asserted in `routes/career.test.ts`:
//
//   1. no `ClaimVerification` row is written: attachment is not a human DECISION about a
//      claim's truth, it is bookkeeping, and an audit row here would say the user had
//      decided something they did not;
//   2. `status` is untouched, so attaching cannot confirm anything;
//   3. a `rejected` claim is REFUSED outright rather than quietly re-parented. A claim the
//      user rejected is not part of their career profile, and attaching it to an entity is
//      the first step of putting it back in a document - so the refusal is here, not left to
//      the reopen that has not happened yet.
//
// THE PAIRING RULE, AND WHY IT IS A TABLE AND NOT A LOOPHOLE. 05 sec.5 gives every entity a
// `claims` relation, and the schema lets a claim carry any of the six FKs, so the DATABASE
// allows nonsense: a claim of kind `education` may name a `Project`. Nothing in the
// projection would break, but the document would say it. `ENTITY_CLAIM_KINDS` is therefore
// the compatibility relation the API enforces, and every entry is defensible in one line:
//
//   experience     <- role, responsibility, achievement, metric, technology, domain
//                     what was done AT a job. An `achievement` claim may equally attach to a
//                     `Project` or to an `Achievement` row; that is the user's call.
//   education      <- education, domain
//   project        <- project, achievement, metric, technology, domain, responsibility
//   skill          <- skill, technology, language, domain, soft_skill
//                     `language` and `soft_skill` are skills: the projector has no separate
//                     section for either, and `Skill.category` is the free-text column that
//                     distinguishes them ("language", "communication").
//   certification  <- certification
//   achievement    <- achievement, metric
//
// COVERAGE IS A TEST, NOT A COMMENT: `routes/career.test.ts` asserts that every one of the
// schema's twelve `ClaimKind` values appears in at least one list, so a new claim kind cannot
// be added to the vocabulary and left unattachable.
//
// THE FIELD RULES ARE THE SCHEMA'S, AND THE SCHEMA IS NOT NEGOTIABLE. Each kind's writable
// members are declared in `ENTITY_FIELDS`, read off `backend/prisma/schema.prisma`: same
// names, same optionality, same types. Two asymmetries are load-bearing and are asserted:
//
//   - `Skill.normalized` is REQUIRED BY THE UNIQUE KEY `@@unique([profileId, normalized])`,
//     so it is DERIVED from `name` (NFKC, lowercase, whitespace collapsed) rather than asked
//     for: two spellings of one skill are one skill, and a caller cannot create a duplicate
//     by capitalising. A duplicate is a 409, not a 500.
//   - `Certification` has NO `sortOrder` column. One of the six kinds therefore does not
//     accept an order, and a request that supplies one is REFUSED rather than silently
//     dropped - the projector sorts certificates by name (`project.ts`), and a dropped
//     `sortOrder` would be a request answered with something other than what was asked.
//
// The DB seam is INJECTED (`CareerEntityStore`), never imported: `prisma.ts` is not
// referenced anywhere under `backend/src/career/` (`claimWriterAI.test.ts` asserts it), so
// every rule above is unit-provable with no live database. No module under
// `backend/src/career/` imports `verification.js` either - a route may not, and neither does
// the layer above it.
// =====================================================================================

import { z } from 'zod';
import { ClaimKind, ClaimStatus, type PrismaClient } from '@prisma/client';

import {
  CLAIM_ENTITY_FIELDS,
  requireClaimById,
  updateClaimAttributes,
  type CareerClaimRow,
  type ClaimEntityField,
} from './claims.js';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** The six entity kinds, in the order the projector reads them. */
export const CAREER_ENTITY_KINDS = [
  'experience',
  'education',
  'project',
  'skill',
  'certification',
  'achievement',
] as const;

export type CareerEntityKind = (typeof CAREER_ENTITY_KINDS)[number];

export function isCareerEntityKind(value: unknown): value is CareerEntityKind {
  return typeof value === 'string' && (CAREER_ENTITY_KINDS as readonly string[]).includes(value);
}

/**
 * The claim-FK column each entity kind owns. `CLAIM_ENTITY_FIELDS` in `claims.ts` is the
 * schema's own list; this is the mapping the API needs, and it is total over both sets (the
 * test asserts that, because a kind with no column would be CRUD the projector cannot use).
 */
export const ENTITY_KIND_CLAIM_FIELD: Readonly<Record<CareerEntityKind, ClaimEntityField>> = Object.freeze({
  experience: 'experienceId',
  education: 'educationId',
  project: 'projectId',
  skill: 'skillId',
  certification: 'certificationId',
  achievement: 'achievementId',
});

/** The claim kinds each entity kind will accept. See the header for every entry's reasoning. */
export const ENTITY_CLAIM_KINDS: Readonly<Record<CareerEntityKind, readonly ClaimKind[]>> = Object.freeze({
  experience: Object.freeze([
    ClaimKind.role,
    ClaimKind.responsibility,
    ClaimKind.achievement,
    ClaimKind.metric,
    ClaimKind.technology,
    ClaimKind.domain,
  ] as ClaimKind[]),
  education: Object.freeze([ClaimKind.education, ClaimKind.domain] as ClaimKind[]),
  project: Object.freeze([
    ClaimKind.project,
    ClaimKind.achievement,
    ClaimKind.metric,
    ClaimKind.technology,
    ClaimKind.domain,
    ClaimKind.responsibility,
  ] as ClaimKind[]),
  skill: Object.freeze([
    ClaimKind.skill,
    ClaimKind.technology,
    ClaimKind.language,
    ClaimKind.domain,
    ClaimKind.soft_skill,
  ] as ClaimKind[]),
  certification: Object.freeze([ClaimKind.certification] as ClaimKind[]),
  achievement: Object.freeze([ClaimKind.achievement, ClaimKind.metric] as ClaimKind[]),
});

/** The entity kinds one claim kind may be attached to. The inverse of the table above. */
export function entityKindsForClaimKind(kind: ClaimKind): readonly CareerEntityKind[] {
  return CAREER_ENTITY_KINDS.filter((entityKind) =>
    (ENTITY_CLAIM_KINDS[entityKind] as readonly ClaimKind[]).includes(kind),
  );
}

/** Whether this pairing is allowed. `false` for a nonsensical one (education claim -> Project). */
export function isCompatiblePairing(entityKind: CareerEntityKind, claimKind: ClaimKind): boolean {
  return (ENTITY_CLAIM_KINDS[entityKind] as readonly ClaimKind[]).includes(claimKind);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A request that cannot be acted on as written (bad field, unknown member, missing column). */
export class CareerEntityInputError extends Error {
  readonly code = 'career_entity_invalid_input' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CareerEntityInputError';
  }
}

/** No such entity for THIS profile. The only "not found" this module raises. */
export class CareerEntityNotFoundError extends Error {
  readonly code = 'career_entity_not_found' as const;

  constructor(kind: CareerEntityKind, id: string) {
    super(`career entity not found: ${kind}/${id}`);
    this.name = 'CareerEntityNotFoundError';
  }
}

/**
 * The row the request asks for ALREADY EXISTS on this profile. Today that is exactly one
 * thing: `@@unique([profileId, normalized])` on `Skill`, so a second `Postgres` cannot be
 * created. A 409 rather than a 400, because the request was well formed and the STATE refuses
 * it - the same distinction `routes/career.ts` draws for an illegal claim transition.
 */
export class CareerEntityConflictError extends Error {
  readonly code = 'career_entity_conflict' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CareerEntityConflictError';
  }
}

/**
 * The request was well formed and the STATE refuses it: a rejected claim, or a pairing the
 * model does not intend. A 409, for the same reason `routes/career.ts` answers 409 for an
 * illegal transition - "your body was fine, the state is not".
 */
export class CareerEntityClaimRefusedError extends Error {
  readonly code = 'career_entity_claim_refused' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CareerEntityClaimRefusedError';
  }
}

// ---------------------------------------------------------------------------
// The field rules (read off the schema, never invented)
// ---------------------------------------------------------------------------

export type EntityFieldType = 'text' | 'multiline' | 'boolean' | 'integer' | 'stringList';

export interface EntityFieldSpec {
  /** The column's own name in `backend/prisma/schema.prisma`. */
  readonly name: string;
  readonly required: boolean;
  readonly type: EntityFieldType;
  /** Maximum stored length, as a cap on an HTTP body rather than on the column. */
  readonly maxLength: number;
  /** A human label. Display only; the API never takes it. */
  readonly label: string;
}

/**
 * The writable members of each entity, exactly as the schema declares them.
 *
 * `sortOrder` is present on five of the six because `Certification` has no such column, and
 * `normalized` appears only on `Skill` (derived - see the header). `description` and
 * `statement` are the two `@db.Text` columns, and they are the two long ones a UI needs a
 * textarea for.
 */
export const ENTITY_FIELDS: Readonly<Record<CareerEntityKind, readonly EntityFieldSpec[]>> =
  Object.freeze({
    experience: Object.freeze([
      { name: 'title', required: true, type: 'text', maxLength: 200, label: 'Role' },
      { name: 'company', required: true, type: 'text', maxLength: 200, label: 'Employer' },
      { name: 'location', required: false, type: 'text', maxLength: 200, label: 'Location' },
      { name: 'employmentType', required: false, type: 'text', maxLength: 100, label: 'Employment type' },
      { name: 'startDate', required: false, type: 'text', maxLength: 40, label: 'Start date' },
      { name: 'endDate', required: false, type: 'text', maxLength: 40, label: 'End date' },
      { name: 'current', required: false, type: 'boolean', maxLength: 0, label: 'Current role' },
      { name: 'sortOrder', required: false, type: 'integer', maxLength: 0, label: 'Order' },
    ] as EntityFieldSpec[]),
    education: Object.freeze([
      { name: 'degree', required: true, type: 'text', maxLength: 200, label: 'Degree' },
      { name: 'institution', required: true, type: 'text', maxLength: 200, label: 'Institution' },
      { name: 'field', required: false, type: 'text', maxLength: 200, label: 'Field of study' },
      { name: 'location', required: false, type: 'text', maxLength: 200, label: 'Location' },
      { name: 'graduationYear', required: false, type: 'text', maxLength: 20, label: 'Graduation year' },
      { name: 'sortOrder', required: false, type: 'integer', maxLength: 0, label: 'Order' },
    ] as EntityFieldSpec[]),
    project: Object.freeze([
      { name: 'name', required: true, type: 'text', maxLength: 200, label: 'Project name' },
      { name: 'role', required: false, type: 'text', maxLength: 200, label: 'Your role' },
      { name: 'description', required: false, type: 'multiline', maxLength: 4000, label: 'Description' },
      { name: 'repoUrl', required: false, type: 'text', maxLength: 500, label: 'Repository URL' },
      { name: 'liveUrl', required: false, type: 'text', maxLength: 500, label: 'Live URL' },
      { name: 'tech', required: false, type: 'stringList', maxLength: 80, label: 'Technologies' },
      { name: 'startDate', required: false, type: 'text', maxLength: 40, label: 'Start date' },
      { name: 'endDate', required: false, type: 'text', maxLength: 40, label: 'End date' },
      { name: 'sortOrder', required: false, type: 'integer', maxLength: 0, label: 'Order' },
    ] as EntityFieldSpec[]),
    skill: Object.freeze([
      { name: 'name', required: true, type: 'text', maxLength: 120, label: 'Skill' },
      { name: 'category', required: false, type: 'text', maxLength: 80, label: 'Category' },
      { name: 'level', required: false, type: 'text', maxLength: 40, label: 'Level' },
      { name: 'sortOrder', required: false, type: 'integer', maxLength: 0, label: 'Order' },
    ] as EntityFieldSpec[]),
    certification: Object.freeze([
      { name: 'name', required: true, type: 'text', maxLength: 200, label: 'Certification' },
      { name: 'issuer', required: false, type: 'text', maxLength: 200, label: 'Issuer' },
      { name: 'issuedOn', required: false, type: 'text', maxLength: 40, label: 'Issued on' },
      { name: 'expiresOn', required: false, type: 'text', maxLength: 40, label: 'Expires on' },
      { name: 'credentialUrl', required: false, type: 'text', maxLength: 500, label: 'Credential URL' },
    ] as EntityFieldSpec[]),
    achievement: Object.freeze([
      { name: 'statement', required: true, type: 'multiline', maxLength: 4000, label: 'Achievement' },
      { name: 'sortOrder', required: false, type: 'integer', maxLength: 0, label: 'Order' },
    ] as EntityFieldSpec[]),
  });

/** The member of `Achievement` that names the experience it belongs to. */
export const ACHIEVEMENT_EXPERIENCE_FIELD = 'experienceId' as const;

/** A human label for a kind, for an error message and for the UI's own heading. */
export const ENTITY_KIND_LABELS: Readonly<Record<CareerEntityKind, string>> = Object.freeze({
  experience: 'Experience',
  education: 'Education',
  project: 'Project',
  skill: 'Skill',
  certification: 'Certification',
  achievement: 'Achievement',
});

// ---------------------------------------------------------------------------
// The DB seam
// ---------------------------------------------------------------------------

/**
 * One Prisma entity delegate, structurally narrowed.
 *
 * `CareerEntityStore` is INJECTED rather than imported for the same reason every other career
 * service does it: `prisma.ts` must not be reachable from `backend/src/career/`, so the whole
 * module stays unit-testable with a fake. The delegates are typed loosely because Prisma
 * computes each one's return type from the `select` argument, so a hand-written row type would
 * be a second thing to keep in step with the schema; the row is returned to the caller AS
 * Prisma produced it and never re-shaped.
 */
export interface CareerEntityDelegate {
  findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
  create(args: unknown): Promise<Record<string, unknown>>;
  update(args: unknown): Promise<Record<string, unknown>>;
  delete(args: unknown): Promise<Record<string, unknown>>;
  count(args: unknown): Promise<number>;
}

/** The claim delegate, narrowed to what the attachment needs (the type owns its own guards). */
export interface CareerEntityClaimDelegate {
  findFirst(args: unknown): Promise<CareerClaimRow | null>;
  update(args: {
    where: { id: string };
    data: Partial<ClaimEntityField> & Record<string, string | null>;
  }): Promise<CareerClaimRow>;
  count(args: unknown): Promise<number>;
}

export interface CareerEntityStore {
  experience: CareerEntityDelegate;
  education: CareerEntityDelegate;
  project: CareerEntityDelegate;
  skill: CareerEntityDelegate;
  certification: CareerEntityDelegate;
  achievement: CareerEntityDelegate;
  careerClaim: CareerEntityClaimDelegate;
}

export type CareerEntityRow = Record<string, unknown>;

function delegateFor(store: CareerEntityStore, kind: CareerEntityKind): CareerEntityDelegate {
  return store[kind];
}

function requireKind(kind: unknown): CareerEntityKind {
  if (!isCareerEntityKind(kind)) {
    throw new CareerEntityInputError(
      `kind must be one of ${CAREER_ENTITY_KINDS.join('|')}, got ${JSON.stringify(kind)}`,
    );
  }
  return kind;
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

function cleanText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new CareerEntityInputError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CareerEntityInputError(`${field} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new CareerEntityInputError(`${field} is longer than ${maxLength} characters`);
  }
  return trimmed;
}

function cleanOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new CareerEntityInputError(`${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new CareerEntityInputError(`${field} is longer than ${maxLength} characters`);
  }
  return trimmed;
}

function cleanInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new CareerEntityInputError(`${field} must be an integer`);
  }
  // Bounded so `sortOrder` stays a display order rather than a coordinate space, and so a
  // caller cannot write a value no renderer would place sensibly.
  if (value < -100_000 || value > 100_000) {
    throw new CareerEntityInputError(`${field} must be between -100000 and 100000`);
  }
  return value;
}

function cleanBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new CareerEntityInputError(`${field} must be a boolean`);
  }
  return value;
}

function cleanStringList(value: unknown, field: string, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    throw new CareerEntityInputError(`${field} must be an array of strings`);
  }
  if (value.length > 40) {
    throw new CareerEntityInputError(`${field} accepts at most 40 entries`);
  }
  return value.map((entry, index) => cleanText(entry, `${field}[${index}]`, maxLength));
}

/**
 * The canonical key `Skill.normalized` stores: NFKC, lowercase, whitespace collapsed.
 *
 * The same normalisation `claims.ts#normalizeStatement` uses, because both answer the same
 * question - "is this the same thing, differently written?" - and one function that answers
 * it means "Postgres" and " postgres " cannot become two skills.
 */
export function normalizeSkillName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The writable columns of one kind, minus anything the schema does not declare. */
function specsFor(kind: CareerEntityKind): readonly EntityFieldSpec[] {
  return ENTITY_FIELDS[kind];
}

/**
 * Validate and render the write data for one kind.
 *
 * `mode: 'create'` requires every required field; `mode: 'patch'` touches only the members
 * present, and refuses to clear a required one (`null` for `company` would write a role with
 * no employer, which the projector would render as "Unknown employer").
 *
 * Unknown members are REFUSED rather than ignored: a body carrying `companyy` has misspelled
 * something, and silently dropping it is how a user loses an edit without being told.
 */
function entityWriteData(
  kind: CareerEntityKind,
  input: Record<string, unknown>,
  mode: 'create' | 'patch',
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const specs = specsFor(kind);
  const names = new Set(specs.map((spec) => spec.name));

  // F5: `Achievement.experienceId` is a REFERENCE, not a column of free text, so it is not
  // in `ENTITY_FIELDS` - but it is a WRITABLE member all the same, and this function used to
  // refuse it outright ("resolved by the server ... not written as text"), which ran BEFORE
  // `resolveAchievementExperienceId` and therefore left that resolver permanently dead: it
  // could only ever receive `undefined`, `Achievement.experienceId` could never be written
  // through the API at all, and the refusal message contradicted the code three lines above
  // it. The member is ACCEPTED here and the resolver OWNS the value: it resolves the id
  // against THIS profile's experiences and writes the column itself. Nothing else about the
  // validation changes - `experienceId` is still refused for every other kind, because only
  // an achievement hangs off an experience, and a member that is not on the allow list is
  // still refused with the message naming the writable fields.
  const referenceField = kind === 'achievement' ? ACHIEVEMENT_EXPERIENCE_FIELD : null;

  for (const [key, value] of Object.entries(input)) {
    if (!names.has(key) && key !== referenceField) {
      throw new CareerEntityInputError(
        `${key} is not a field of a ${kind}; writable fields are ${specs.map((spec) => spec.name).join(', ')}`,
      );
    }
  }

  for (const spec of specs) {
    if (!Object.prototype.hasOwnProperty.call(input, spec.name)) {
      if (mode === 'create' && spec.required) {
        throw new CareerEntityInputError(`${spec.name} is required`);
      }
      continue;
    }
    const value = input[spec.name];
    switch (spec.type) {
      case 'text':
      case 'multiline': {
        if (value === null) {
          if (spec.required) {
            throw new CareerEntityInputError(`${spec.name} is required`);
          }
          data[spec.name] = null;
          break;
        }
        data[spec.name] = cleanText(value, spec.name, spec.maxLength);
        break;
      }
      case 'integer': {
        if (value === null) {
          if (mode === 'patch') {
            // Absent is the schema's default (0), and `null` is not a legal `Int`.
            data[spec.name] = 0;
            break;
          }
          throw new CareerEntityInputError(`${spec.name} must be an integer`);
        }
        data[spec.name] = cleanInteger(value, spec.name);
        break;
      }
      case 'boolean': {
        if (value === null) {
          if (mode === 'patch') {
            data[spec.name] = false;
            break;
          }
          throw new CareerEntityInputError(`${spec.name} must be a boolean`);
        }
        data[spec.name] = cleanBoolean(value, spec.name);
        break;
      }
      case 'stringList': {
        data[spec.name] = value === null ? [] : cleanStringList(value, spec.name, spec.maxLength);
        break;
      }
      default: {
        throw new CareerEntityInputError(`${spec.name} has an unknown field type`);
      }
    }
  }

  if (kind === 'skill' && data.name !== undefined) {
    data.normalized = normalizeSkillName(data.name as string);
  }
  return data;
}

/**
 * `Achievement.experienceId`, resolved against THIS profile.
 *
 * The column is a bare `String?` with no relation (05 sec.5: an achievement may hang off an
 * experience, and the schema deliberately keeps no FK), so nothing in the database would stop
 * it naming another tenant's row. It is checked here: an id that is not one of this profile's
 * experiences is a 404, not a dangling pointer.
 */
async function resolveAchievementExperienceId(
  profileId: string,
  value: unknown,
  mode: 'create' | 'patch',
  store: CareerEntityStore,
): Promise<{ set?: string | null }> {
  if (value === undefined && mode === 'patch') return {};
  if (value === undefined || value === null) return { set: null };
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CareerEntityInputError(`${ACHIEVEMENT_EXPERIENCE_FIELD} must be a non-empty string or null`);
  }
  const experience = await store.experience.findFirst({
    where: { id: value.trim(), profileId },
    select: { id: true },
  });
  if (!experience) throw new CareerEntityNotFoundError('experience', value.trim());
  return { set: experience.id as string };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Every row of one kind, in the order the projector will place them.
 *
 * `sortOrder` then `id` - the SAME total order `project.ts#bySortOrderThenId` uses, so the
 * list a user reorders in the UI is the order the document comes out in. `certification` has
 * no `sortOrder` column and is sorted by `name`, which is what the projector does with it.
 */
export async function listCareerEntities(
  kind: CareerEntityKind,
  profileId: string,
  store: CareerEntityStore,
): Promise<CareerEntityRow[]> {
  const resolved = requireKind(kind);
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new CareerEntityInputError('listCareerEntities needs a non-empty profileId');
  }
  const delegate = delegateFor(store, resolved);
  return resolved === 'certification'
    ? delegate.findMany({
        where: { profileId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      })
    : delegate.findMany({
        where: { profileId },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
}

/** One row of one kind, scoped to THIS profile. */
export async function findCareerEntity(
  kind: CareerEntityKind,
  id: string,
  profileId: string,
  store: CareerEntityStore,
): Promise<CareerEntityRow> {
  const resolved = requireKind(kind);
  if (typeof id !== 'string' || id.length === 0) {
    throw new CareerEntityNotFoundError(resolved, String(id));
  }
  const row = await delegateFor(store, resolved).findFirst({ where: { id, profileId } });
  if (!row) throw new CareerEntityNotFoundError(resolved, id);
  return row;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Create one row. `sortOrder` defaults to the schema's own (0). */
export async function createCareerEntity(
  kind: CareerEntityKind,
  profileId: string,
  input: Record<string, unknown>,
  store: CareerEntityStore,
): Promise<CareerEntityRow> {
  const resolved = requireKind(kind);
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new CareerEntityInputError('createCareerEntity needs a non-empty profileId');
  }
  const data = entityWriteData(resolved, input, 'create');
  if (resolved === 'achievement') {
    const reference = await resolveAchievementExperienceId(profileId, input[ACHIEVEMENT_EXPERIENCE_FIELD], 'create', store);
    data[ACHIEVEMENT_EXPERIENCE_FIELD] = reference.set ?? null;
  }
  try {
    return await delegateFor(store, resolved).create({ data: { ...data, profileId } });
  } catch (error) {
    throw translatePrismaError(error, resolved, 'create');
  }
}

/**
 * Update one row in place.
 *
 * A PATCH is the only way an entity row ever changes, and it changes exactly the members the
 * request names. Nothing else is touched: no timestamp the caller supplied, no `profileId`
 * (a profile move would take the row to another tenant), no derived `normalized` unless the
 * name moved - which is the one case where it must move with it, or the unique key would stop
 * describing the skill it indexes.
 */
export async function updateCareerEntity(
  kind: CareerEntityKind,
  id: string,
  profileId: string,
  input: Record<string, unknown>,
  store: CareerEntityStore,
): Promise<CareerEntityRow> {
  const resolved = requireKind(kind);
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new CareerEntityInputError('updateCareerEntity needs a non-empty profileId');
  }
  // Scope FIRST: a foreign id has to be indistinguishable from an absent one, so this raises
  // the same 404 whichever it is and no write is attempted.
  const existing = await findCareerEntity(resolved, id, profileId, store);
  const data = entityWriteData(resolved, input, 'patch');
  if (resolved === 'achievement') {
    const reference = await resolveAchievementExperienceId(profileId, input[ACHIEVEMENT_EXPERIENCE_FIELD], 'patch', store);
    if (reference.set !== undefined) data[ACHIEVEMENT_EXPERIENCE_FIELD] = reference.set;
  }
  if (Object.keys(data).length === 0) {
    // A PATCH with nothing writable in it is answered with the row unchanged rather than a
    // write: "no members changed" is the truth, and an empty update would still bump `updatedAt`.
    return existing;
  }
  try {
    return await delegateFor(store, resolved).update({ where: { id: existing.id as string }, data });
  } catch (error) {
    throw translatePrismaError(error, resolved, 'update');
  }
}

/**
 * Delete one row.
 *
 * The claims that named it are NOT deleted: `CareerClaim`'s six FKs are `onDelete: SetNull`,
 * so Postgres clears them and the claim survives as one of the projection's `otherClaims`
 * (`usage: omitted`, `jsonPath: null`) - which is the honest state of "the profile knows this
 * and the resume does not place it". `detachedClaims` is reported so the UI can say how many
 * statements lost their placement rather than leaving the user to discover it.
 */
export async function deleteCareerEntity(
  kind: CareerEntityKind,
  id: string,
  profileId: string,
  store: CareerEntityStore,
): Promise<{ id: string; kind: CareerEntityKind; detachedClaims: number }> {
  const resolved = requireKind(kind);
  const existing = await findCareerEntity(resolved, id, profileId, store);
  const field = ENTITY_KIND_CLAIM_FIELD[resolved];
  const detachedClaims = await store.careerClaim.count({
    where: { profileId, [field]: existing.id as string },
  });
  await delegateFor(store, resolved).delete({ where: { id: existing.id as string } });
  return { id: existing.id as string, kind: resolved, detachedClaims };
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

/** A claim with the single entity FK it currently carries, and which column it was. */
export interface ClaimAttachment {
  readonly kind: CareerEntityKind | null;
  readonly entityId: string | null;
}

/** Read a claim's attachment without loading the entity. Pure. */
export function claimAttachment(claim: CareerClaimRow): ClaimAttachment {
  for (const field of CLAIM_ENTITY_FIELDS) {
    const value = claim[field];
    if (typeof value === 'string' && value.length > 0) {
      const kind = CAREER_ENTITY_KINDS.find(
        (candidate) => ENTITY_KIND_CLAIM_FIELD[candidate] === field,
      );
      return { kind: kind ?? null, entityId: value };
    }
  }
  return { kind: null, entityId: null };
}

/**
 * Attach a claim to ONE entity, or refuse.
 *
 * The write is `updateClaimAttributes`, so `status` cannot be part of the payload even by
 * accident, and the row it returns is the row that was written. Everything the refusal needs
 * is decided BEFORE the write:
 *
 *   - a claim the user REJECTED is refused. It is not part of their profile, and attaching it
 *     to an entity is the first step of putting it back on the claim rail;
 *   - a pairing the model does not intend is refused, naming the kinds that WOULD be legal so
 *     the message is actionable rather than a bare "no";
 *   - an entity that is not in the CLAIM'S OWN profile is a 404 - the same answer an absent id
 *     gets, so this endpoint cannot be used to discover that another tenant's row exists;
 *   - re-attaching a claim to the entity it already names is a NO-OP (`changed: false`, no
 *     write at all), so a retry after a dropped response is not a second mutation.
 */
export async function attachClaimToEntity(
  claimId: string,
  kind: CareerEntityKind,
  entityId: string,
  store: CareerEntityStore,
): Promise<{ claim: CareerClaimRow; changed: boolean; field: ClaimEntityField }> {
  const resolved = requireKind(kind);
  if (typeof claimId !== 'string' || claimId.length === 0) {
    throw new CareerEntityInputError('attachClaimToEntity needs a non-empty claimId');
  }
  if (typeof entityId !== 'string' || entityId.trim().length === 0) {
    throw new CareerEntityInputError('attachClaimToEntity needs a non-empty entityId');
  }
  const claim = await requireClaimById(claimId, store as never);
  if (claim.status === ClaimStatus.rejected) {
    throw new CareerEntityClaimRefusedError(
      `claim ${claimId} was rejected, so it cannot be attached to a ${resolved}: reopen it first (a rejection is never cleared implicitly)`,
    );
  }
  if (!isCompatiblePairing(resolved, claim.kind)) {
    const allowed = (ENTITY_CLAIM_KINDS[resolved] as readonly ClaimKind[]).join('|');
    throw new CareerEntityClaimRefusedError(
      `a claim of kind ${claim.kind} cannot be attached to a ${resolved}: a ${resolved} accepts claims of kind ${allowed}`,
    );
  }
  const entity = await delegateFor(store, resolved).findFirst({
    where: { id: entityId.trim(), profileId: claim.profileId },
    select: { id: true },
  });
  if (!entity) throw new CareerEntityNotFoundError(resolved, entityId.trim());

  const field = ENTITY_KIND_CLAIM_FIELD[resolved];
  const already = claim[field] === entity.id;
  if (already) {
    // Idempotent. Exactly one FK is set and it is already this one, so there is nothing to
    // write - and returning the row itself (not a re-read) keeps `changed: false` honest.
    return { claim, changed: false, field };
  }
  const patch: Record<string, string | null> = { [field]: entity.id as string };
  // 05 sec.5: "exactly one of these may be set". Clearing the other five is what makes
  // MOVING a claim (attach elsewhere) a single atomic statement rather than two.
  for (const other of CLAIM_ENTITY_FIELDS) {
    if (other !== field) patch[other] = null;
  }
  const updated = await updateClaimAttributes(claimId, patch as never, store as never);
  return { claim: updated, changed: true, field };
}

/**
 * Detach a claim from whatever entity it names.
 *
 * IDEMPOTENT BY CONSTRUCTION: a claim that names nothing is already detached, so the second
 * call is a no-op with no write and no error. `kind` narrows it to one column when supplied
 * (the common case, "take this statement off this role"); omitting it clears all six, which is
 * the honest answer to "this statement is not part of any of my entries".
 *
 * `entityId` is a second narrowing, never a different one: a request for a pair that is not
 * the current attachment changes nothing and says so, instead of detaching something else.
 */
export async function detachClaimFromEntity(
  claimId: string,
  options: { kind?: CareerEntityKind | null; entityId?: string | null },
  store: CareerEntityStore,
): Promise<{ claim: CareerClaimRow; changed: boolean; fields: ClaimEntityField[] }> {
  if (typeof claimId !== 'string' || claimId.length === 0) {
    throw new CareerEntityInputError('detachClaimFromEntity needs a non-empty claimId');
  }
  const claim = await requireClaimById(claimId, store as never);
  const current = claimAttachment(claim);
  const wanted = options?.kind === undefined || options?.kind === null ? null : requireKind(options.kind);
  const fields = wanted === null ? [...CLAIM_ENTITY_FIELDS] : [ENTITY_KIND_CLAIM_FIELD[wanted]];

  if (options?.entityId !== undefined && options.entityId !== null) {
    if (current.kind !== wanted || current.entityId !== options.entityId) {
      // Not the pair the caller named. Nothing to do, and nothing is written: the alternative
      // would be clearing an attachment because a caller named the wrong one.
      return { claim, changed: false, fields: [] };
    }
  }
  const set = new Set(fields.filter((field) => claim[field] !== null));
  if (set.size === 0) return { claim, changed: false, fields: [] };
  const patch: Record<string, string | null> = {};
  for (const field of set) patch[field] = null;
  const updated = await updateClaimAttributes(claimId, patch as never, store as never);
  return { claim: updated, changed: true, fields: [...set] };
}

// ---------------------------------------------------------------------------
// Request schemas (the route validates with these; the rules above are authoritative)
// ---------------------------------------------------------------------------

/** A non-empty id. Bounded so an HTTP body cannot carry a megabyte of "id". */
const entityIdSchema = z.string().trim().min(1, 'id is required').max(200, 'id too long');

export const attachClaimToEntitySchema = z
  .object({
    kind: z.enum(CAREER_ENTITY_KINDS),
    entityId: entityIdSchema,
  })
  .strict();

export const detachClaimFromEntitySchema = z
  .object({
    /** Omitted = detach from whatever the claim names. */
    kind: z.enum(CAREER_ENTITY_KINDS).optional(),
    entityId: entityIdSchema.nullish(),
  })
  .strict();

export type AttachClaimToEntityInput = z.infer<typeof attachClaimToEntitySchema>;
export type DetachClaimFromEntityInput = z.infer<typeof detachClaimFromEntitySchema>;

/**
 * A Prisma error mapped onto the module's own vocabulary.
 *
 * Only ONE of them is interesting: `@@unique([profileId, normalized])` on `Skill`. A second
 * `Postgres` is a 409 with a message naming the duplicate, not a 500 with a driver error - the
 * user asked for a skill that is already there, and the answer is "it is already there".
 * Everything else is re-thrown untouched, so an unexpected fault is never disguised as a
 * validation failure.
 */
function translatePrismaError(error: unknown, kind: CareerEntityKind, mode: 'create' | 'update'): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'P2002' && kind === 'skill') {
    return new CareerEntityConflictError(
      `that skill is already on this profile (one ${ENTITY_KIND_LABELS[kind].toLowerCase()} per canonical name)`,
    );
  }
  void mode;
  return error;
}