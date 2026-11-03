// Pure save-current-search helpers (Wave 12, T844, ADR-027).
//
// Testable logic surface for the "save current search" action in
// `SavedSearchManager`: live filters -> intent input, the ONE no-criteria
// gate predicate, and the human row summary (roles + mode + groups per the
// spec's UI section). Pure: no React, no network, no clock. The component
// stays thin and calls into here.
//
// Normalisation (trim, blank-drop, dedupe) is `formToIntentInput`'s (T800) -
// never restated here. The criteria rule mirrors the backend's `isEmptyIntent`
// (T840, reused by T842's `intentCarriesCriteria`): only real criteria count
// (query text, roles, skills, seniority, exclusions, locations, companies,
// remoteOnly). Modifiers (`mode`, `limit`, `postedWithin`, `sourceGroups`,
// scores, notification flags) never do. `sourceGroups` is a modifier here on
// purpose: a group toggles a set of source ids, and the selected ids already
// count through the board filter - the group names alone carry no criteria.

import { formToIntentInput, type IntentInput } from './searchIntentForm';
import type { JobSearchFilters } from '../../services/api/jobs';

/**
 * Capture the live filter state as an intent input. The legacy single-company
 * field folds in exactly as the deep-search scope gate folds it
 * (`Jobs.tsx` `scopeCompanies`): `[legacy, ...companies]`, so the saved
 * intent never searches a different set than the filters show. `postedWithin:
 * 'all'` maps to absent (no recency filter); `workMode: 'remote'` maps to
 * `remoteOnly` (hybrid/onsite have no intent field and stay client-side).
 * `experienceLevel` is client-side only by design and never sent.
 */
export function filtersToIntentInput(filters: JobSearchFilters): IntentInput {
  const source = filters ?? ({} as JobSearchFilters);
  const legacyCompany =
    typeof source.company === 'string' ? source.company.trim() : '';
  return formToIntentInput({
    query: source.query,
    roles: source.roles,
    skills: source.skills,
    exclusions: source.exclusions,
    locations: source.location,
    remoteOnly: source.workMode === 'remote',
    companies: legacyCompany
      ? [legacyCompany, ...(source.companies ?? [])]
      : source.companies,
    sourceGroups: source.sourceGroups,
    mode: source.mode,
    postedWithin: source.postedWithin === 'all' ? undefined : source.postedWithin,
  });
}

/**
 * THE one no-criteria predicate for the save-current-search gate (T842's
 * rule, frontend side): true when the intent input carries real search
 * criteria. The server remains the authority (400); this gate is courtesy.
 * Never throws on malformed input - an unreadable value simply carries no
 * criteria. One place, so the manual form and the save-current action cannot
 * drift apart.
 */
export function intentInputCarriesCriteria(input: IntentInput): boolean {
  if (!input || typeof input !== 'object') return false;
  if (typeof input.query === 'string' && input.query.trim().length > 0) return true;
  if (typeof input.seniority === 'string' && input.seniority.trim().length > 0) return true;
  if (input.remoteOnly === true) return true;
  const lists = [input.roles, input.skills, input.exclusions, input.locations, input.companies];
  for (const list of lists) {
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (typeof entry === 'string' && entry.trim().length > 0) return true;
      }
    }
  }
  return false;
}

/** Minimal row shape the summary reads (legacy rows carry `intent: null`). */
export interface SavedSearchRowLike {
  query?: string | null;
  intent?: unknown;
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) out.push(entry.trim());
  }
  return out;
}

/**
 * Human summary for a saved-search row, derived from the intent (roles +
 * mode + groups per the spec's UI section). A legacy row without an intent -
 * or a malformed one - falls back to the stored query text, never throws,
 * and never returns blank.
 */
export function summarizeSavedSearch(row: SavedSearchRowLike): string {
  const fallback =
    row && typeof row.query === 'string' && row.query.trim().length > 0
      ? row.query.trim()
      : 'Saved search';
  const intent = row?.intent;
  if (!intent || typeof intent !== 'object') return fallback;
  const rec = intent as Record<string, unknown>;
  const roles = cleanStrings(rec.roles);
  const groups = cleanStrings(rec.sourceGroups);
  const mode = typeof rec.mode === 'string' ? rec.mode.trim() : '';
  const bits: string[] = [];
  if (roles.length > 0) {
    bits.push(
      roles.slice(0, 3).join(', ') + (roles.length > 3 ? ` +${roles.length - 3} more` : ''),
    );
  }
  if (mode.length > 0 && mode !== 'fast') bits.push(mode);
  if (groups.length > 0) bits.push(groups.join(' + '));
  return bits.length > 0 ? bits.join(' · ') : fallback;
}
