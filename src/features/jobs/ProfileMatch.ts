// Generalized profile -> filter logic (Track A, T401) + keyword injection.
//
// Pure module: no React, no fetching, no storage. Reads `seniority`
// (labels-only mapping via seniority.ts), `locationPref` (via
// normalizeLocations, so legacy strings and JSON arrays both work),
// `remoteOnly`, and `targetRoles` + `topSkills` (deduped into `keywords`)
// from a CareerProfile and turns them into a confirmable
// summary plus a merged filter patch. Nothing is persisted.

import type { CareerProfile, JobSearchFilters } from '@/services/api/jobs';
import { isSeniorityValue, labelForValue, type SeniorityValue } from './seniority';
import { normalizeLocations } from './jobSearchUtils';

/** Backend `q` cap (jobSearchSchema: min 2, max 200). Keyword injection must never exceed it. */
export const MAX_PROFILE_QUERY_LENGTH = 200;

export interface ProfileMatchCandidate {
  level?: SeniorityValue;
  locations: string[];
  remoteOnly: boolean;
  /** Deduped `targetRoles` + `topSkills` injection keywords, order preserved. */
  keywords: string[];
}

export interface ProfileMatchSummary {
  candidate: ProfileMatchCandidate;
  /** Human lines, e.g. "Experience level: Senior", "Locations: Remote, Berlin". */
  lines: string[];
}

/** Returns null when the profile offers nothing applicable (no level/locations/remote/keywords). */
export function buildProfileMatch(
  profile: CareerProfile | null | undefined,
): ProfileMatchSummary | null {
  if (!profile) return null;
  const rawSeniority: unknown = profile.seniority;
  const level: SeniorityValue | undefined =
    typeof rawSeniority === 'string' && isSeniorityValue(rawSeniority) ? rawSeniority : undefined;
  const locations = normalizeLocations(profile.locationPref);
  const remoteOnly = profile.remoteOnly === true;
  const keywords = collectKeywords(profile);
  if (level === undefined && locations.length === 0 && !remoteOnly && keywords.length === 0) return null;
  const candidate: ProfileMatchCandidate = { locations, remoteOnly, keywords };
  if (level !== undefined) candidate.level = level;
  const lines: string[] = [];
  if (level !== undefined) lines.push(`Experience level: ${labelForValue(level)}`);
  if (locations.length > 0) lines.push(`Locations: ${locations.join(', ')}`);
  if (remoteOnly) lines.push('Remote only');
  if (keywords.length > 0) lines.push(`Keywords: ${keywords.join(', ')}`);
  return { candidate, lines };
}

/** `targetRoles` + `topSkills`, trimmed, blank-dropped, case-insensitive deduped, order preserved. */
function collectKeywords(profile: CareerProfile): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lists: unknown[] = [profile.targetRoles, profile.topSkills];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const cleaned = item.trim().replace(/\s+/g, ' ');
      if (!cleaned) continue;
      const key = cleaned.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cleaned);
    }
  }
  return out;
}

/** Append each keyword to `query` when absent (case-insensitive substring),
 *  skipping any keyword that would push the query past the backend `q` cap.
 *  Keywords already present are never duplicated; the input is returned
 *  unchanged when there is nothing to add. Pure. */
export function mergeQueryWithKeywords(query: string, keywords: string[]): string {
  let out = query;
  for (const raw of keywords) {
    const kw = typeof raw === 'string' ? raw.trim() : '';
    if (!kw) continue;
    if (out.toLowerCase().includes(kw.toLowerCase())) continue;
    const base = out.trimEnd();
    const next = base.length > 0 ? `${base} ${kw}` : kw;
    if (next.length > MAX_PROFILE_QUERY_LENGTH) continue;
    out = next;
  }
  return out;
}

/** Union `current` + `incoming` locations, case-insensitive dedupe, order preserved. */
function unionLocations(current: string[], incoming: string[]): string[] {
  const out = [...current];
  const seen = new Set<string>(current.map((c) => c.toLowerCase()));
  for (const loc of incoming) {
    const key = loc.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(loc);
  }
  return out;
}

/** Returns true when `filters` already contain everything `summary` would apply
 *  (level present, all candidate locations present case-insensitively,
 *  workMode remote when remoteOnly). Union semantics: extra user filters keep
 *  it applied; clearing any contributed value flips it back to false.
 *  Keywords are intentionally NOT checked here: since the hidden-keywords
 *  change the visible `filters.query` always holds the base typed query only,
 *  while profile keywords ride out-of-band (Jobs.tsx `appliedKeywords`) and
 *  are composed into the outgoing `q` at send time via mergeQueryWithKeywords. */
export function isProfileMatchApplied(
  filters: JobSearchFilters,
  summary: ProfileMatchSummary,
): boolean {
  const { candidate } = summary;
  if (
    candidate.level !== undefined &&
    !filters.experienceLevel.includes(candidate.level)
  ) {
    return false;
  }
  if (candidate.locations.length > 0) {
    const current = new Set(filters.location.map((l) => l.toLowerCase()));
    for (const loc of candidate.locations) {
      if (!current.has(loc.toLowerCase())) return false;
    }
  }
  if (candidate.remoteOnly && filters.workMode !== 'remote') return false;
  return true;
}

/** Confirmed -> merged filter patch; declined -> the input filters unchanged (same ref).
 *  The patch unions locations, ORs `experienceLevel`, and upgrades `workMode`
 *  to `remote` when `remoteOnly`. It never touches `filters.query`: profile
 *  keywords stay out of the visible search box and are composed into the
 *  outgoing `q` at send time only (Jobs.tsx `appliedKeywords` +
 *  mergeQueryWithKeywords). Toggle-OFF simply clears that out-of-band list;
 *  no query restoration is needed because the base query is never mutated. */
export function applyProfileMatch(
  confirmed: boolean,
  filters: JobSearchFilters,
  summary: ProfileMatchSummary,
): JobSearchFilters {
  if (!confirmed) return filters;
  return {
    ...filters,
    location: unionLocations(filters.location, summary.candidate.locations),
    experienceLevel:
      summary.candidate.level !== undefined &&
      !filters.experienceLevel.includes(summary.candidate.level)
        ? [...filters.experienceLevel, summary.candidate.level]
        : filters.experienceLevel,
    // Upgrade-only: remoteOnly promotes to 'remote', never downgrades.
    workMode: summary.candidate.remoteOnly ? 'remote' : filters.workMode,
  };
}
