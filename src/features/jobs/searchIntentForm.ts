// Pure intent-form mapping + validation (Wave 10, T800, ADR-031 decision 3).
//
// These helpers are the wave's testable logic surface: components (T801-T804)
// stay thin and call into here. Pure: no React, no network, no clock.
//
// SOURCE OF TRUTH for every limit below is the backend zod schema
// `searchIntentSchema` in `backend/src/discovery/searchIntent.ts` (T740),
// lines 192-215. Do NOT copy limits from prose - re-read that schema if any
// limit below looks stale. Seniority membership reuses the existing frontend
// module (`./seniority`, itself pinned to the backend enum), never a local
// list. The source-group vocabulary is intentionally NOT listed here: group
// ids come from the generated contract (`shared/job-sources.json`, T624/T625)
// and the UI toggles only offer valid values, so `validateForm` flags blank
// entries while membership stays enforced by the toggles + backend zod.
//
// `formToIntentInput` normalises only (trim, blank-drop, case-insensitive
// first-seen dedupe, documented defaults). It never truncates: over-limit
// input is reported by `validateForm` and blocked by the component, so no
// user data is silently lost. `limit` follows the backend rule
// (`backend/src/discovery/searchIntent.ts:486-489`): a finite number passes
// through untouched (even out of range - validation flags it); a missing or
// non-finite value falls back to 30.

import { isSeniorityValue } from './seniority';
import type { SeniorityValue } from './seniority';

// Backend `searchIntentSchema` limits (mirrored field-for-field):
export const QUERY_MAX_LENGTH = 200;
export const ROLES_MAX = 10;
export const ROLE_MAX_LENGTH = 100;
export const SKILLS_MAX = 30;
export const SKILL_MAX_LENGTH = 50;
export const EXCLUSIONS_MAX = 20;
export const EXCLUSION_MAX_LENGTH = 50;
export const LOCATIONS_MAX = 10;
export const LOCATION_MAX_LENGTH = 80;
export const COMPANIES_MAX = 500;
export const COMPANY_MAX_LENGTH = 120;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;
export const LIMIT_DEFAULT = 30;

/** Raw form state as held by the filter UI. All fields optional. */
export interface SearchIntentFormValues {
  query?: string;
  roles?: readonly string[];
  skills?: readonly string[];
  seniority?: string;
  exclusions?: readonly string[];
  locations?: readonly string[];
  remoteOnly?: boolean;
  companies?: readonly string[];
  sourceGroups?: readonly string[];
  mode?: string;
  limit?: number;
  postedWithin?: string;
}

/** Sanitised payload the search API receives (intent-expressible subset). */
export interface IntentInput {
  query?: string;
  roles: string[];
  skills: string[];
  seniority?: SeniorityValue;
  exclusions: string[];
  locations: string[];
  remoteOnly: boolean;
  companies: string[];
  sourceGroups: string[];
  mode: 'fast' | 'deep';
  limit: number;
  postedWithin?: 'day' | 'week' | 'month';
}

export interface FormValidationIssue {
  field: string;
  message: string;
}

/** Trim, drop blanks, dedupe case-insensitively keeping first-seen order. */
function cleanList(values: readonly string[] | undefined): string[] {  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Incremental chip-commit for the filter-sheet list inputs (T801: roles,
 * skills, exclusions, companies). Same normalisation as `cleanList` (trim,
 * blank-drop, case-insensitive dedupe) but deliberately WITHOUT a length or
 * count cap: over-limit entries stay committable and `validateForm` reports
 * them as inline messages instead of a 400 (T801 STEP 5). This differs from
 * `addLocation` in `./jobSearchUtils`, which enforces its hard cap at commit
 * time with its own visible error.
 */
export function addListItem(current: string[], raw: string): string[] {
  const list = Array.isArray(current) ? current : [];
  if (typeof raw !== 'string') return list;
  const trimmed = raw.trim();
  if (!trimmed) return list;
  if (list.some((entry) => typeof entry === 'string' && entry.toLowerCase() === trimmed.toLowerCase())) {
    return list;
  }
  return [...list, trimmed];
}

/** Remove every entry equal to value (case-insensitive on the trimmed value). */
export function removeListItem(current: readonly string[], value: string): string[] {
  const list = Array.isArray(current) ? current : [];
  const target = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return list.filter(
    (entry) => typeof entry !== 'string' || entry.toLowerCase() !== target,
  );
}

function isPostedWithin(value: string): value is 'day' | 'week' | 'month' {
  return value === 'day' || value === 'week' || value === 'month';
}

export function formToIntentInput(filters: SearchIntentFormValues): IntentInput {
  const source = filters ?? {};
  const query = cleanString(source.query);
  const seniorityRaw = cleanString(source.seniority);
  const seniority = isSeniorityValue(seniorityRaw) ? seniorityRaw : undefined;
  const postedWithinRaw = cleanString(source.postedWithin);
  const postedWithin = isPostedWithin(postedWithinRaw) ? postedWithinRaw : undefined;
  const mode = cleanString(source.mode) === 'deep' ? 'deep' : 'fast';
  const limit =
    typeof source.limit === 'number' && Number.isFinite(source.limit)
      ? source.limit
      : LIMIT_DEFAULT;
  return {
    ...(query ? { query } : {}),
    roles: cleanList(source.roles),
    skills: cleanList(source.skills),
    ...(seniority ? { seniority } : {}),
    exclusions: cleanList(source.exclusions),
    locations: cleanList(source.locations),
    remoteOnly: source.remoteOnly === true,
    companies: cleanList(source.companies),
    sourceGroups: cleanList(source.sourceGroups),
    mode,
    limit,
    ...(postedWithin ? { postedWithin } : {}),
  };
}

function checkList(
  issues: FormValidationIssue[],
  field: string,
  values: readonly string[] | undefined,
  maxItems: number,
  maxChars: number,
): void {
  if (values === undefined) return;
  if (!Array.isArray(values)) return;
  if (values.length > maxItems) {
    issues.push({
      field,
      message: `Too many ${field}: at most ${maxItems} allowed.`,
    });
  }
  values.forEach((raw, index) => {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (trimmed.length > maxChars) {
      issues.push({
        field: `${field}[${index}]`,
        message: `${field}[${index}] is too long: at most ${maxChars} characters allowed.`,
      });
    }
  });
}

/**
 * Field-level validation mirroring the backend zod limits exactly (see the
 * header for the source-of-truth file/line). Reads the TRIMMED values - the
 * same values `formToIntentInput` sends - so surrounding whitespace never
 * fails a length check. Returns an empty array when the form is submittable.
 */
export function validateForm(filters: SearchIntentFormValues): FormValidationIssue[] {
  const issues: FormValidationIssue[] = [];
  const source = filters ?? {};

  const query = cleanString(source.query);
  if (query.length > QUERY_MAX_LENGTH) {
    issues.push({
      field: 'query',
      message: `Search text is too long: at most ${QUERY_MAX_LENGTH} characters allowed.`,
    });
  }

  checkList(issues, 'roles', source.roles, ROLES_MAX, ROLE_MAX_LENGTH);
  checkList(issues, 'skills', source.skills, SKILLS_MAX, SKILL_MAX_LENGTH);
  checkList(issues, 'exclusions', source.exclusions, EXCLUSIONS_MAX, EXCLUSION_MAX_LENGTH);
  checkList(issues, 'locations', source.locations, LOCATIONS_MAX, LOCATION_MAX_LENGTH);
  checkList(issues, 'companies', source.companies, COMPANIES_MAX, COMPANY_MAX_LENGTH);

  const seniority = cleanString(source.seniority);
  if (seniority && !isSeniorityValue(seniority)) {
    issues.push({ field: 'seniority', message: `Unknown seniority: "${seniority}".` });
  }

  if (source.limit !== undefined) {
    const limit = source.limit;
    if (
      typeof limit !== 'number' ||
      !Number.isFinite(limit) ||
      !Number.isInteger(limit) ||
      limit < LIMIT_MIN ||
      limit > LIMIT_MAX
    ) {
      issues.push({
        field: 'limit',
        message: `Result limit must be a whole number from ${LIMIT_MIN} to ${LIMIT_MAX}.`,
      });
    }
  }

  const postedWithin = cleanString(source.postedWithin);
  if (postedWithin && !isPostedWithin(postedWithin)) {
    issues.push({ field: 'postedWithin', message: `Unknown recency filter: "${postedWithin}".` });
  }

  const mode = cleanString(source.mode);
  if (mode && mode !== 'fast' && mode !== 'deep') {
    issues.push({ field: 'mode', message: `Unknown search mode: "${mode}".` });
  }

  if (source.sourceGroups !== undefined && Array.isArray(source.sourceGroups)) {
    source.sourceGroups.forEach((raw, index) => {
      if (typeof raw !== 'string' || !raw.trim()) {
        issues.push({
          field: `sourceGroups[${index}]`,
          message: `sourceGroups[${index}] must be a non-empty source group.`,
        });
      }
    });
  }

  return issues;
}
