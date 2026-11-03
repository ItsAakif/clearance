// entityModel.ts - the pure half of the career entity surface (T1054).
//
// WHY A SEPARATE MODULE. The server's rules are authoritative (`backend/src/career/entities.ts`
// owns the field names, the pairing table and the `sortOrder` column), and this file MIRRORS
// them for two jobs a React component cannot do well on its own:
//
//   1. building a form per kind - the field list, its labels, and whether a member is required
//      are data, not markup, so a new kind is a row here rather than a new component;
//   2. answering "which entries can this statement go under?" WITHOUT a round trip, so the
//      picker can hide the pairings the server would refuse.
//
// THE MIRROR IS CHECKED, NOT ASSUMED. `entityModel.test.ts` reads the backend source and
// asserts that every field name, every required flag and every pairing here agrees with it -
// the same technique `features/studio/templates.ts` and `features/career/claimPresentation.ts`
// use for their mirrors. A kind added to the schema without a row here fails a test rather
// than rendering an empty form.
//
// NOTHING HERE DECIDES ANYTHING. Attaching a statement is bookkeeping; this module can tell a
// form which pairings are legal, and the server refuses the rest with the same answer
// (`career_entity_claim_refused`). Both are asserted against the same table.

/** The six kinds, in the order the projector reads them. Mirrors `CAREER_ENTITY_KINDS`. */
export const CAREER_ENTITY_KINDS = [
  "experience",
  "education",
  "project",
  "skill",
  "certification",
  "achievement",
] as const;

export type CareerEntityKind = (typeof CAREER_ENTITY_KINDS)[number];

export const ENTITY_KIND_LABELS: Readonly<Record<CareerEntityKind, string>> = {
  experience: "Experience",
  education: "Education",
  project: "Projects",
  skill: "Skills",
  certification: "Certifications",
  achievement: "Achievements",
};

/** The singular noun for one entry, used in every per-row sentence. */
export const ENTITY_KIND_SINGULAR: Readonly<Record<CareerEntityKind, string>> = {
  experience: "role",
  education: "education entry",
  project: "project",
  skill: "skill",
  certification: "certification",
  achievement: "achievement",
};

export type EntityFieldType = "text" | "multiline" | "boolean" | "integer" | "stringList";

export interface EntityFieldSpec {
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly type: EntityFieldType;
  /** A hint, never a validation rule: the server owns the caps. */
  readonly placeholder?: string;
}

/**
 * The writable members of each kind, exactly as `backend/src/career/entities.ts#ENTITY_FIELDS`
 * declares them. `certification` has no order member because the schema has no such column.
 */
export const ENTITY_FIELDS: Readonly<Record<CareerEntityKind, readonly EntityFieldSpec[]>> = {
  experience: [
    { name: "title", label: "Role", required: true, type: "text", placeholder: "Senior Engineer" },
    { name: "company", label: "Employer", required: true, type: "text", placeholder: "Acme" },
    { name: "location", label: "Location", required: false, type: "text", placeholder: "London, UK" },
    { name: "employmentType", label: "Employment type", required: false, type: "text", placeholder: "Full time" },
    { name: "startDate", label: "Start date", required: false, type: "text", placeholder: "2021-03" },
    { name: "endDate", label: "End date", required: false, type: "text", placeholder: "Present" },
    { name: "current", label: "Current role", required: false, type: "boolean" },
    { name: "sortOrder", label: "Order", required: false, type: "integer" },
  ],
  education: [
    { name: "degree", label: "Degree", required: true, type: "text", placeholder: "BSc Computer Science" },
    { name: "institution", label: "Institution", required: true, type: "text", placeholder: "University of London" },
    { name: "field", label: "Field of study", required: false, type: "text" },
    { name: "location", label: "Location", required: false, type: "text" },
    { name: "graduationYear", label: "Graduation year", required: false, type: "text", placeholder: "2020" },
    { name: "sortOrder", label: "Order", required: false, type: "integer" },
  ],
  project: [
    { name: "name", label: "Project name", required: true, type: "text", placeholder: "LedgerKit" },
    { name: "role", label: "Your role", required: false, type: "text", placeholder: "Maintainer" },
    { name: "description", label: "Description", required: false, type: "multiline" },
    { name: "repoUrl", label: "Repository URL", required: false, type: "text" },
    { name: "liveUrl", label: "Live URL", required: false, type: "text" },
    { name: "tech", label: "Technologies", required: false, type: "stringList", placeholder: "TypeScript, Postgres" },
    { name: "startDate", label: "Start date", required: false, type: "text" },
    { name: "endDate", label: "End date", required: false, type: "text" },
    { name: "sortOrder", label: "Order", required: false, type: "integer" },
  ],
  skill: [
    { name: "name", label: "Skill", required: true, type: "text", placeholder: "TypeScript" },
    { name: "category", label: "Category", required: false, type: "text", placeholder: "language, framework, soft skill" },
    { name: "level", label: "Level", required: false, type: "text", placeholder: "expert" },
    { name: "sortOrder", label: "Order", required: false, type: "integer" },
  ],
  certification: [
    { name: "name", label: "Certification", required: true, type: "text" },
    { name: "issuer", label: "Issuer", required: false, type: "text" },
    { name: "issuedOn", label: "Issued on", required: false, type: "text" },
    { name: "expiresOn", label: "Expires on", required: false, type: "text" },
    { name: "credentialUrl", label: "Credential URL", required: false, type: "text" },
  ],
  achievement: [
    { name: "statement", label: "Achievement", required: true, type: "multiline" },
    { name: "sortOrder", label: "Order", required: false, type: "integer" },
  ],
};

/** The claim kinds each entity kind accepts. Mirrors `ENTITY_CLAIM_KINDS`. */
export const ENTITY_CLAIM_KINDS: Readonly<Record<CareerEntityKind, readonly string[]>> = {
  experience: ["role", "responsibility", "achievement", "metric", "technology", "domain"],
  education: ["education", "domain"],
  project: ["project", "achievement", "metric", "technology", "domain", "responsibility"],
  skill: ["skill", "technology", "language", "domain", "soft_skill"],
  certification: ["certification"],
  achievement: ["achievement", "metric"],
};

/** The claim-FK column each kind owns. Mirrors `ENTITY_KIND_CLAIM_FIELD`. */
export const ENTITY_KIND_CLAIM_FIELD: Readonly<Record<CareerEntityKind, string>> = {
  experience: "experienceId",
  education: "educationId",
  project: "projectId",
  skill: "skillId",
  certification: "certificationId",
  achievement: "achievementId",
};

/** Which entries can a statement of this kind be filed under. */
export function entityKindsForClaimKind(claimKind: string): CareerEntityKind[] {
  return CAREER_ENTITY_KINDS.filter((kind) => ENTITY_CLAIM_KINDS[kind].includes(claimKind));
}

/** Whether this pairing would be accepted. The server refuses the rest; the picker hides them. */
export function canAttach(claimKind: string, entityKind: CareerEntityKind): boolean {
  return ENTITY_CLAIM_KINDS[entityKind].includes(claimKind);
}

/** Whether the kind can be reordered at all (i.e. whether the schema has an order column). */
export function isReorderable(entityKind: CareerEntityKind): boolean {
  return ENTITY_FIELDS[entityKind].some((field) => field.name === "sortOrder");
}

/** The claim column this kind owns. The mirror the picker, the list and the server all use. */
export function attachmentFieldOf(entityKind: CareerEntityKind): string {
  return ENTITY_KIND_CLAIM_FIELD[entityKind];
}

/**
 * The statements filed under one entry, or - with `entityId: null` - under ANY entry of the
 * kind, which is the denominator the "nothing is placed on the page" line needs.
 *
 * `null` is not "nothing": a column is nullable in the schema (`String?`), so a claim with no
 * attachment really does hold `null` there, and `!== null` is the honest test. A truthiness test
 * would read the same here, and would start lying the day the column became non-nullable.
 */
export function statementsFor<T extends { id: string }>(
  claims: readonly T[],
  entityKind: CareerEntityKind,
  entityId: string | null,
): readonly T[] {
  const field = attachmentFieldOf(entityKind);
  return claims.filter((claim) => {
    const attached = (claim as unknown as Record<string, unknown>)[field];
    return entityId === null ? attached !== null : attached === entityId;
  });
}

// ---------------------------------------------------------------------------
// One line about one entry
// ---------------------------------------------------------------------------

type EntityLike = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The label a list row shows. Short, and never a sentence the user has to decode: for a
 * statement-shaped kind (`achievement`) the statement IS the label.
 */
export function entitySummary(entityKind: CareerEntityKind, entity: EntityLike): string {
  if (entityKind === "experience") {
    return [text(entity.position), text(entity.title), text(entity.company)].filter(Boolean).join(" - ") || "Untitled role";
  }
  if (entityKind === "education") {
    return [text(entity.degree), text(entity.institution)].filter(Boolean).join(" - ") || "Untitled education entry";
  }
  if (entityKind === "project") return text(entity.name) ?? "Untitled project";
  if (entityKind === "skill") return text(entity.name) ?? "Unnamed skill";
  if (entityKind === "certification") {
    return [text(entity.name), text(entity.issuer)].filter(Boolean).join(" - ") || "Unnamed certification";
  }
  return text(entity.statement) ?? "Empty achievement";
}

/** The secondary line: the dates, the category, the issuer - whatever the kind actually has. */
export function entityDetail(entityKind: CareerEntityKind, entity: EntityLike): string | null {
  const parts: string[] = [];
  if (entityKind === "experience" || entityKind === "project") {
    if (entity.current === true) {
      if (text(entity.startDate)) parts.push(`${text(entity.startDate)} - present`);
    } else {
      const from = text(entity.startDate);
      const to = text(entity.endDate);
      if (from || to) parts.push(`${from ?? ""}${from || to ? " - " : ""}${to ?? ""}`);
    }
    if (text(entity.location)) parts.push(text(entity.location) as string);
  }
  if (entityKind === "education" && text(entity.graduationYear)) parts.push(text(entity.graduationYear) as string);
  if (entityKind === "skill") {
    if (text(entity.category)) parts.push(text(entity.category) as string);
    if (text(entity.level)) parts.push(text(entity.level) as string);
  }
  if (entityKind === "certification") {
    if (text(entity.issuedOn)) parts.push(`issued ${text(entity.issuedOn)}`);
    if (text(entity.expiresOn)) parts.push(`expires ${text(entity.expiresOn)}`);
  }
  return parts.length > 0 ? parts.join(" - ") : null;
}

// ---------------------------------------------------------------------------
// Reordering: two real buttons, and the patches they imply
// ---------------------------------------------------------------------------

export interface EntityReorderPatch {
  id: string;
  sortOrder: number;
}

export interface ReorderOutcome {
  /** The new order, so the caller can render it before the server answers. */
  ordered: EntityLike[];
  /** One `sortOrder` patch per moved entry. The server refuses an order on a kind without one. */
  patches: EntityReorderPatch[];
  /** `false` when the move is impossible (a kind with no order column, or an end of the list). */
  moved: boolean;
}

/**
 * Move one entry up or down and return the `sortOrder` patches that make it stick.
 *
 * The whole list is renumbered on every move rather than swapping two positions. Two entries
 * cannot share an order and the projector sorts by `sortOrder` then `id`, so a swap would leave
 * the pair ordered by a uuid - stable, arbitrary, and different from what the user just did.
 */
export function moveEntity(
  entityKind: CareerEntityKind,
  entities: readonly EntityLike[],
  id: string,
  direction: "up" | "down",
): ReorderOutcome {
  const unchanged: ReorderOutcome = { ordered: [...entities], patches: [], moved: false };
  if (!isReorderable(entityKind)) return unchanged;
  const index = entities.findIndex((entity) => entity.id === id);
  if (index === -1) return unchanged;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= entities.length) return unchanged;
  const ordered = [...entities];
  const [moved] = ordered.splice(index, 1);
  ordered.splice(target, 0, moved);
  return {
    ordered,
    patches: ordered.map((entity, position) => ({ id: entity.id as string, sortOrder: position })),
    moved: true,
  };
}

// ---------------------------------------------------------------------------
// Form drafts
// ---------------------------------------------------------------------------

/** What a form holds: one string per field, plus the checkboxes. Never a typed entity. */
export type EntityDraft = Record<string, string | boolean>;

/** A blank draft for a kind: required fields empty, everything else at its default. */
export function emptyDraft(entityKind: CareerEntityKind): EntityDraft {
  const draft: EntityDraft = {};
  for (const field of ENTITY_FIELDS[entityKind]) {
    if (field.type === "boolean") draft[field.name] = false;
    else if (field.type === "stringList") draft[field.name] = "";
    else draft[field.name] = "";
  }
  return draft;
}

/** A draft filled from an existing row, so "Edit" starts from what is stored. */
export function draftFromEntity(entityKind: CareerEntityKind, entity: EntityLike): EntityDraft {
  const draft = emptyDraft(entityKind);
  for (const field of ENTITY_FIELDS[entityKind]) {
    const value = entity[field.name];
    if (field.type === "boolean") draft[field.name] = value === true;
    else if (field.type === "stringList") {
      draft[field.name] = Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join(", ") : "";
    } else draft[field.name] = typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  return draft;
}

/**
 * The request body for a draft.
 *
 * Only the fields the KIND HAS are sent, and an untouched optional field is sent as `null`
 * rather than `""` - the server treats both as "clear it", and sending the whole vocabulary
 * would make a typo in one field fail the whole save. A `stringList` is split on commas,
 * because a tag field is a list the user types, and every other kind is typed.
 */
export function buildEntityInput(entityKind: CareerEntityKind, draft: EntityDraft): Record<string, string | number | boolean | string[]> {
  const body: Record<string, string | number | boolean | string[]> = {};
  for (const field of ENTITY_FIELDS[entityKind]) {
    const raw = draft[field.name];
    if (field.type === "boolean") {
      body[field.name] = raw === true;
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : "";
    if (field.type === "integer") {
      if (value.length === 0) continue;
      const parsed = Number(value);
      // Not a number: send nothing rather than `NaN`, and let the server's own integer rule
      // report the problem against the field it belongs to.
      if (!Number.isInteger(parsed)) continue;
      body[field.name] = parsed;
      continue;
    }
    if (field.type === "stringList") {
      body[field.name] = value.length === 0 ? [] : value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      continue;
    }
    if (value.length === 0) {
      if (!field.required) body[field.name] = null;
      continue;
    }
    body[field.name] = value;
  }
  return body;
}

/** Which required fields a draft is still missing, for the button's disabled state and hint. */
export function missingRequiredFields(entityKind: CareerEntityKind, draft: EntityDraft): string[] {
  return ENTITY_FIELDS[entityKind]
    .filter((field) => field.required && String(draft[field.name] ?? "").trim().length === 0)
    .map((field) => field.label);
}

// ---------------------------------------------------------------------------
// Empty states, in words
// ---------------------------------------------------------------------------

/**
 * What an empty list says.
 *
 * NOT "No data": a user who has not built their profile yet and a user whose import produced no
 * entries need different next steps, and both differ from "you have some, but nothing here".
 * `hasStatements` is what separates them - it is the honest signal, because a statement list
 * that is empty is the only state in which "file a statement under an entry" makes no sense.
 */
export function emptyEntityState(
  entityKind: CareerEntityKind,
  context: { hasStatements: boolean },
): string {
  const noun = ENTITY_KIND_SINGULAR[entityKind];
  if (!context.hasStatements) {
    return `No ${ENTITY_KIND_LABELS[entityKind].toLowerCase()} yet, and no statements to file under them. Import a resume or add a statement on this page first - the resume is built from both.`;
  }
  return `No ${noun} yet. Add one, then file your existing statements under it: a statement is only placed on the page once it belongs to an entry.`;
}

/** The line under a non-empty list, saying what the entries are FOR. */
export function entityListNote(entityKind: CareerEntityKind, attachedCount: number): string {
  const noun = ENTITY_KIND_SINGULAR[entityKind];
  return attachedCount === 0
    ? `Nothing is filed under any ${noun} yet, so the resume places none of your statements.`
    : `${attachedCount} statement${attachedCount === 1 ? "" : "s"} filed under ${attachedCount === 1 ? "this" : "these"} ${noun}${attachedCount === 1 ? "" : "s"}.`;
}