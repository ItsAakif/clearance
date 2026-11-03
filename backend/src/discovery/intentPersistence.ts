// intentPersistence - derivation layer between SearchIntent and the legacy
// SavedSearch / JobAlert string fields (Wave 12, T840).
//
// PURE MODULE: no ORM client import, no DB access, no I/O, no clock, no network.
// It converts values only; it never reads or writes a row. In particular
// `deriveIntentForRow` derives an intent for a pre-existing row ON THE FLY
// and does not write anything back (there is nothing here to write with).
//
// Verified ground truth this module is built on:
// - `SavedSearch` stores `query`, `location` (`String?`), `company`,
//   `sources` (Json), `minMatchScore`, `remoteOnly`, `sortBy`.
// - `JobAlert` stores `query`, `location`, `sources` (Json), `minMatchScore`,
//   `remoteOnly` (+ `notifyInApp`/`notifyEmail`/`savedSearchId`, untouched).
// - Replay paths (`routes/saved-searches.ts`, `routes/job-alerts.ts`) feed the
//   stored `query` string VERBATIM into `runSource` per board, so the legacy
//   `query` must stay a space-separated token string with `-exclusions` - the
//   same token language `parseQuery` (`jobSources/queryMatch.ts`) consumes.
// - `location` stays a `String?` column: arrays persist as `JSON.stringify`
//   via `serializeLocationPref`, plain strings pass through verbatim, and
//   reads decode with `normalizeLocationPref` (ADR-008 / ADR-019). This module
//   reuses those exact helpers so the serialisation cannot drift.
// - `SearchIntent` / `deriveIntent` are wave 7's (`discovery/searchIntent.ts`);
//   the many-to-one source-id <-> group mapping and its superset guarantee
//   are documented there and reused here, not re-decided.
//
// LOSSY ASYMMETRY (documented here so it is recorded, not discovered later).
// The legacy shape cannot carry everything an intent holds:
//   1. `query` verbatim text is NORMALISED. `intentToLegacy` renders the query
//      from roles/skills/seniority/`remote`/`-exclusions` in normalised order
//      (lowercased by derivation), so casing and token order of the original
//      text are not preserved. What IS preserved is the token SET the
//      token-OR replay consumes. `legacyToIntent` keeps the legacy string
//      verbatim, so the intent -> legacy -> intent trip changes `query` to the
//      normalised rendering (asserted in tests, not skipped).
//   2. `location` representation may shift. A legacy plain string (`Berlin`)
//      decodes to `["Berlin"]` and re-serialises as the JSON form
//      (`["Berlin"]`). Same list, different representation - the documented
//      ADR-008 dual representation. JSON-array rows re-serialise byte-identical.
//   3. `company` carries ONE value. Only the first entry of
//      `intent.companies` is stored; extras are dropped (asserted).
//   4. `sources` are many-to-one. Legacy source ids map to intent groups, and
//      groups expand back to the FULL id list of each group (wave-7 superset
//      guarantee: no requested source is ever dropped, siblings are included).
//      An intent with exactly the default groups stores `sources: null`
//      ("no source filter", today's meaning); an empty group list normalises
//      to the defaults, matching `deriveIntent`.
//   5. `minMatchScore` / `sortBy` are NOT carried by the intent. `intentToLegacy`
//      emits `minMatchScore: null` and `sortBy: 'relevance'` (the column
//      default); `legacyToIntent` drops them. Route callers that update a row
//      from an intent MUST merge these two fields from the existing row
//      instead of overwriting them (T843's job). Both losses are asserted.
//   6. `mode` / `limit` / `postedWithin` / `evaluate` are intent-only. They
//      have no legacy column, so a legacy row always derives the schema
//      defaults (`fast` / 30 / undefined / `deterministic`). Old readers
//      ignore them; the new replay uses the stored intent.
//   7. A legacy payload with no exclusions/seniority/skills structure derives
//      them deterministically from the query text, or leaves them defaulted -
//      nothing is invented (`companies`/`locations` are never derived from
//      free text, per wave 7).
//
// EMPTINESS: an alert with no criteria must be rejectable (T842 owns the
// 400). `isEmptyIntent` / `isEmptyLegacy` let the caller detect that case:
// only real criteria count (query text, roles, skills, seniority, exclusions,
// locations, companies, remoteOnly, sources). Modifiers that are not criteria
// (`minMatchScore`, `sortBy`, `mode`, `limit`, `postedWithin`, `evaluate`,
// notification flags) never make a payload non-empty.

import {
  deriveIntent,
  searchIntentSchema,
  sourceIdsForGroups,
  DEFAULT_SOURCE_GROUPS,
  type SearchIntent,
} from './searchIntent.js';
import {
  normalizeLocationPref,
  serializeLocationPref,
} from '../shared/validation.js';

/** Legacy columns shared by SavedSearch and JobAlert, spelled exactly as the
 * columns are. `company` / `sortBy` exist only on SavedSearch; JobAlert rows
 * simply leave them undefined. `sources` is typed `unknown` because the Json
 * column can hold whatever was written historically; decoding is defensive. */
export interface LegacySearchFields {
  query?: string | null;
  location?: string | null;
  company?: string | null;
  sources?: unknown;
  minMatchScore?: number | null;
  remoteOnly?: boolean;
  sortBy?: string | null;
}

/** Column default for `SavedSearch.sortBy`; the intent carries no ordering. */
const DEFAULT_SORT_BY = 'relevance';

/** Saved-search queries are capped at 200 chars; alerts allow 500, so 200 is
 * the safe bound for a value written to either table. */
const LEGACY_QUERY_MAX = 200;

/**
 * Render the legacy `query` string from an intent's token fields. This is the
 * replay-oriented subset of `intentToQuery` (same token language, same
 * `-exclusion` form): `locations` and `companies` are deliberately EXCLUDED
 * because they have their own legacy columns, and embedding them in the query
 * would leak company/location tokens back into `roles` on re-derivation.
 */
function renderLegacyQuery(intent: SearchIntent): string {
  const parts: string[] = [];
  for (const role of intent.roles) parts.push(role);
  for (const skill of intent.skills) parts.push(skill);
  if (intent.seniority) parts.push(intent.seniority);
  if (intent.remoteOnly) parts.push('remote');
  for (const exclusion of intent.exclusions) parts.push(`-${exclusion}`);
  return parts.join(' ').slice(0, LEGACY_QUERY_MAX);
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (new Set(a).size !== new Set(b).size) return false;
  const setB = new Set(b);
  for (const value of new Set(a)) {
    if (!setB.has(value)) return false;
  }
  return true;
}

function decodeSources(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = (value as unknown[]).filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0,
  );
  return ids.length > 0 ? ids : undefined;
}

/**
 * Derive every legacy field from an intent so an old reader keeps working.
 * Non-carryable fields are filled with the documented fallbacks
 * (`minMatchScore: null`, `sortBy: 'relevance'`); see the module comment.
 */
export function intentToLegacy(intent: SearchIntent): LegacySearchFields {
  const parsed = searchIntentSchema.parse(intent);
  const groups = [...parsed.sourceGroups];
  // Default (or empty, which wave 7 normalises to default) groups mean "no
  // source filter" - store null exactly as legacy rows do. Any other set
  // expands to the full id list of its groups (superset guarantee).
  const isDefault =
    groups.length === 0 || sameStringSet(groups, [...DEFAULT_SOURCE_GROUPS]);
  return {
    query: renderLegacyQuery(parsed),
    // Existing string serialisation: arrays become JSON, via the one helper.
    location: serializeLocationPref(parsed.locations),
    // The column holds one company; extras are dropped (documented loss 3).
    company: parsed.companies.length > 0 ? parsed.companies[0] : null,
    sources: isDefault ? null : sourceIdsForGroups(groups),
    minMatchScore: null,
    remoteOnly: parsed.remoteOnly,
    sortBy: DEFAULT_SORT_BY,
  };
}

/**
 * Inverse for legacy callers: derive an intent from legacy fields. Lossless
 * for what the legacy shape can carry; anything it cannot express
 * (exclusions beyond the query text, extra companies, exact source-id
 * subsets, minMatchScore/sortBy, mode/limit/postedWithin/evaluate) comes back
 * defaulted, never invented. See the module comment.
 */
export function legacyToIntent(fields: LegacySearchFields): SearchIntent {
  const sources = decodeSources(fields.sources);
  return deriveIntent({
    ...(typeof fields.query === 'string' && fields.query.trim().length > 0
      ? { query: fields.query }
      : {}),
    ...(fields.location !== undefined && fields.location !== null
      ? { location: normalizeLocationPref(fields.location) }
      : {}),
    ...(typeof fields.company === 'string' && fields.company.trim().length > 0
      ? { company: fields.company }
      : {}),
    ...(sources ? { sources } : {}),
    // The legacy column is authoritative: an explicit false wins over a
    // `remote` marker that may appear in the query text.
    remoteOnly: fields.remoteOnly ?? false,
  });
}

/**
 * Read-path derivation for a stored row. A row with a valid stored intent
 * returns it (normalised through the schema, so defaults are filled in). A
 * row with `intent: null` (created before the migration), a missing intent,
 * or an unparseable one derives an intent from its string fields ON THE FLY
 * and does NOT write it back - this function is pure and never mutates its
 * input; persisting the derived intent happens only on row update.
 */
export function deriveIntentForRow(
  row: { intent?: unknown } & LegacySearchFields,
): SearchIntent {
  if (row.intent !== null && row.intent !== undefined) {
    const parsed = searchIntentSchema.safeParse(row.intent);
    if (parsed.success) return parsed.data;
  }
  return legacyToIntent(row);
}

/**
 * True when an intent carries no search criteria at all. Only criteria count;
 * `mode`, `limit`, `postedWithin`, `evaluate` and `sourceGroups` never do.
 */
export function isEmptyIntent(intent: SearchIntent): boolean {
  const parsed = searchIntentSchema.parse(intent);
  return (
    (!parsed.query || parsed.query.trim().length === 0) &&
    parsed.roles.length === 0 &&
    parsed.skills.length === 0 &&
    parsed.seniority === undefined &&
    parsed.exclusions.length === 0 &&
    parsed.locations.length === 0 &&
    parsed.remoteOnly === false &&
    parsed.companies.length === 0
  );
}

/**
 * True when a legacy payload carries no search criteria at all. Only criteria
 * count (`query`, `location`, `company`, `sources`, `remoteOnly`);
 * `minMatchScore` and `sortBy` are modifiers and never do.
 */
export function isEmptyLegacy(fields: LegacySearchFields): boolean {
  const hasQuery =
    typeof fields.query === 'string' && fields.query.trim().length > 0;
  const hasLocation =
    normalizeLocationPref(fields.location ?? null).length > 0;
  const hasCompany =
    typeof fields.company === 'string' && fields.company.trim().length > 0;
  const hasSources = decodeSources(fields.sources) !== undefined;
  const hasRemote = fields.remoteOnly === true;
  return !(hasQuery || hasLocation || hasCompany || hasSources || hasRemote);
}
