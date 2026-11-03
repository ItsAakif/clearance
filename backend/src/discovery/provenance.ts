// Date provenance classification + the absolute null invariant (ADR-028, N4).
//
// Every displayed date must be honest about where it came from. An index date,
// a discovery time, or an unknown must NEVER be presented as a posted date.
// That rule is structural: it is enforced inside `classify` (below), not by
// callers remembering to check.
//
// Closed vocabulary (`postedAtSource`), per ADR-028 decision 1:
//
// | value            | meaning                                              | postedAt |
// |------------------|------------------------------------------------------|----------|
// | `source-posted`  | source states an explicit posted/published date    | kept     |
// | `source-updated` | source states only an updated/modified date        | kept     |
// | `page-derived`   | date extracted from page body / JSON-LD `datePosted`| kept     |
// | `discovery-at`   | no date anywhere; only our first-seen time           | null     |
// | `index-date`     | search-engine index signal (Google, Tavily, Exa)     | null     |
// | `unknown`        | parser could not classify                            | null     |
//
// THE NULL INVARIANT: when the resulting `postedAtSource` is in
// `NULL_DATE_SOURCES`, `classify` returns `postedAt` undefined REGARDLESS of
// any input date. A caller cannot bypass it by passing a date.
//
// Provenance rank (higher number = stronger provenance; sort descending).
// These exact numbers are the contract the wave-3 ordering tie-break reads:
// `source-posted` (50) > `source-updated` (40) > `page-derived` (30) >
// `discovery-at` (20) > `index-date` (10) > `unknown` (0). The group
// guarantee is: every null-date class ranks below every date-bearing class.
// Within the null-date group, `discovery-at` outranks `index-date`, which
// outranks `unknown` (ADR-028 decision 3 suggestion, adapted so
// `source-updated` outranks `page-derived` per the wave-3 task contract).
// Only the relative order is contractual; the magnitudes are arbitrary.
//
// Date labels for the API/UI: `source-posted` and `page-derived` (both are
// posted-date claims) -> `Posted`; `source-updated` -> `Updated`;
// `discovery-at` / `index-date` / `unknown` (and a missing source) -> `Found`.
// A `Found` row is therefore never labelled `Posted`.
//
// Notes:
// - This module is pure: it reads no DB, imports no Prisma, performs no I/O,
//   and never reads the clock (no `Date.now()` / `new Date()` defaults). The
//   sole discovery-at timestamp (`firstSeenAt`) is stamped by the persistence
//   layer, which must accept an injected `now` so tests stay deterministic.
// - `postedAtRaw` is audit-only: kept verbatim (even when unparseable) and
//   NEVER parsed into `postedAt`. Callers pass an already-parsed `postedAt`.
// - `classify` never invents provenance: a date without a recognised
//   date-bearing source is dropped (null), because presenting it would be an
//   unlabelled claim. Pre-migration DB rows (`postedAt` set, source null) are
//   handled by the reader layer, which labels them `unknown` WITHOUT nulling
//   the stored date (no data destruction) - that reader rule lives outside
//   this module and must not let such rows claim `source-posted`.

export type PostedAtSource =
  | 'source-posted'
  | 'source-updated'
  | 'page-derived'
  | 'discovery-at'
  | 'index-date'
  | 'unknown';

export const NULL_DATE_SOURCES: readonly PostedAtSource[] = [
  'discovery-at',
  'index-date',
  'unknown',
];

export interface DatedRow {
  postedAt?: Date;
  postedAtSource?: PostedAtSource;
  postedAtRaw?: string;
}

export interface ClassifyInput {
  postedAt?: Date | string | number | null;
  postedAtSource?: PostedAtSource | string | null;
  postedAtRaw?: string | null;
}

export type DateLabel = 'Posted' | 'Updated' | 'Found';

/** Documented numeric ordering consumed by the wave-3 ordering tie-break. */
export const PROVENANCE_RANKS: Readonly<Record<PostedAtSource, number>> = {
  'source-posted': 50,
  'source-updated': 40,
  'page-derived': 30,
  'discovery-at': 20,
  'index-date': 10,
  unknown: 0,
};

export function isPostedAtSource(value: unknown): value is PostedAtSource {
  return (
    value === 'source-posted' ||
    value === 'source-updated' ||
    value === 'page-derived' ||
    value === 'discovery-at' ||
    value === 'index-date' ||
    value === 'unknown'
  );
}

function toValidDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? undefined : new Date(t);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return undefined;
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : new Date(t);
  }
  return undefined;
}

function isUnparseableRaw(raw: string): boolean {
  return raw.trim() !== '' && Number.isNaN(Date.parse(raw));
}

/**
 * Normalise an upstream date claim into a `DatedRow`, enforcing the null
 * invariant: a `postedAtSource` in `NULL_DATE_SOURCES` always yields
 * `postedAt` undefined, even when the caller passes a usable date.
 */
export function classify(input: ClassifyInput): DatedRow {
  const safe: ClassifyInput = input ?? {};
  const postedAtRaw = typeof safe.postedAtRaw === 'string' ? safe.postedAtRaw : undefined;
  const candidate = toValidDate(safe.postedAt);

  let postedAtSource: PostedAtSource = isPostedAtSource(safe.postedAtSource)
    ? safe.postedAtSource
    : 'unknown';

  // An unparseable raw string with no usable date backs no claim: unknown.
  // (When a usable date IS present this branch does not fire, so a valid
  // explicit date is never discarded because of audit text.)
  if (candidate === undefined && postedAtRaw !== undefined && isUnparseableRaw(postedAtRaw)) {
    postedAtSource = 'unknown';
  }

  // THE NULL INVARIANT (N4): null-date classes can never carry a date.
  const postedAt = NULL_DATE_SOURCES.includes(postedAtSource) ? undefined : candidate;

  return { postedAt, postedAtSource, postedAtRaw };
}

/** True only for search-engine index signals (never a posted date). */
export function isIndexDate(row: DatedRow): boolean {
  return row?.postedAtSource === 'index-date';
}

/**
 * UI/API label: `Posted` for posted-date claims, `Updated` for update-only
 * claims, `Found` for everything else (including a missing source - never
 * claim `Posted` without provenance).
 */
export function dateLabel(row: DatedRow): DateLabel {
  switch (row?.postedAtSource) {
    case 'source-posted':
    case 'page-derived':
      return 'Posted';
    case 'source-updated':
      return 'Updated';
    default:
      return 'Found';
  }
}

/** Rank for the ordering tie-break (higher = stronger provenance). */
export function provenanceRank(row: DatedRow): number {
  const source = row?.postedAtSource;
  return isPostedAtSource(source) ? PROVENANCE_RANKS[source] : PROVENANCE_RANKS.unknown;
}
