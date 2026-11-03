import type { JobListingSummary, JobSearchFilters, JobEvaluation, JobWorkMode, NormalizedJobInsights, JobMatchBreakdown, StoredLocation } from "@/services/api";
import { inferJobLevel } from "./seniority";

/** Hard cap on one location chip. Enforced by LocationFilter with a visible error. */
export const MAX_LOCATION_LENGTH = 80;

/** Decode a stored location (legacy string, array, or null) into a clean string array. */
export function normalizeLocations(input: StoredLocation | undefined): string[] {
  if (input === null || input === undefined) return [];
  let raw: unknown[];
  if (Array.isArray(input)) {
    raw = input;
  } else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          raw = parsed;
        } else {
          raw = [input];
        }
      } catch {
        raw = [input];
      }
    } else {
      // Legacy plain string; treat the whole value as one entry (even if blank, filtered below).
      if (trimmed === '') return [];
      raw = [input];
    }
  } else {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const member of raw) {
    if (typeof member !== 'string') continue;
    const cleaned = member.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

/** Case-insensitive substring OR match; empty selection matches everything. */
export function matchesLocation(jobLocation: string | undefined, selected: string[]): boolean {
  if (selected.length === 0) return true;
  if (!jobLocation) return false;
  const hay = jobLocation.toLowerCase();
  if (!hay) return false;
  return selected.some((needle) => {
    if (typeof needle !== 'string') return false;
    const n = needle.trim().toLowerCase();
    if (!n) return false;
    return hay.includes(n);
  });
}

/** Trim, collapse whitespace, reject empty/overlong/duplicates (case-insensitive). */
export function addLocation(current: string[], raw: string): string[] {
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (!cleaned) return current;
  if (cleaned.length > MAX_LOCATION_LENGTH) return current;
  if (current.some((c) => c.toLowerCase() === cleaned.toLowerCase())) return current;
  return [...current, cleaned];
}

/** Remove every entry equal to value (case-insensitive on the trimmed value). */
export function removeLocation(current: string[], value: string): string[] {
  const target = value.trim().toLowerCase();
  return current.filter((c) => c.toLowerCase() !== target);
}

/**
 * Concatenate two result batches while keeping the first row seen for each
 * id. Full-scan batches can overlap, so callers render this accumulator after
 * every response and never replace already-kept rows with a later duplicate.
 */
export function mergeResultRows(
  existing: readonly JobListingSummary[],
  incoming: readonly JobListingSummary[],
): JobListingSummary[] {
  const merged: JobListingSummary[] = [];
  const seenIds = new Set<string>();
  for (const row of [...existing, ...incoming]) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    merged.push(row);
  }
  return merged;
}

export function getJobSkills(job: JobListingSummary): string[] {
  return job.skills ?? [];
}

export function getJobWorkMode(job: JobListingSummary): JobWorkMode {
  if (job.workMode) {
    const lower = job.workMode.toLowerCase();
    if (lower === 'remote' || lower === 'hybrid' || lower === 'onsite') {
      return lower;
    }
  }
  const loc = (job.location ?? '').toLowerCase();
  if (loc.includes('remote')) return 'remote';
  if (loc.includes('hybrid')) return 'hybrid';
  if (loc.includes('onsite') || loc.includes('on-site')) return 'onsite';
  return 'all';
}

function parseDate(input: string | undefined): Date | null {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function getPostedLabel(postedAt?: string): string {
  if (!postedAt) return "Date unavailable";
  const d = parseDate(postedAt);
  if (!d) return "Date unavailable";
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function isPostedWithin(postedAt: string | undefined, range: JobSearchFilters['postedWithin']): boolean {
  if (range === 'all') return true;
  const d = parseDate(postedAt);
  if (!d) return false;
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (range === 'day') return diffMs <= 24 * 60 * 60 * 1000;
  if (range === 'week') return diffMs <= 7 * 24 * 60 * 60 * 1000;
  if (range === 'month') return diffMs <= 30 * 24 * 60 * 60 * 1000;
  return true;
}

const SCORE_COLOR_MAP: Record<number, string> = {
  4: 'bg-success',
  3: 'bg-primary',
  2: 'bg-warning',
};

function scoreColorClass(v: number): string {
  if (v >= 4) return SCORE_COLOR_MAP[4] ?? 'bg-success';
  if (v >= 3) return SCORE_COLOR_MAP[3] ?? 'bg-primary';
  if (v >= 2) return SCORE_COLOR_MAP[2] ?? 'bg-warning';
  return 'bg-destructive';
}

// The server is the single authority on query matching (ADR-021 decision 5):
// it filters over title/company/location/description, which list rows cannot
// see (no description). filterAndSortJobs therefore never filters by
// filters.query; it keeps location, level, company, work mode, source,
// match-score, posted-within, and sort.

export function filterAndSortJobs(
  jobs: JobListingSummary[],
  filters: JobSearchFilters,
  evaluatedScores: Record<string, number>,
): JobListingSummary[] {
  let result = [...jobs];

  // Same OR rule as backend/src/routes/jobs.ts; both sides must stay in step.
  if (filters.location.length > 0) {
    result = result.filter((j) => matchesLocation(j.location, filters.location));
  }

  if (filters.experienceLevel.length > 0) {
    // Client-only by design: JobListing has no level column (see the spec's NON-GOALS).
    // The list has no description, so the inference runs on the title alone; the detail
    // panel re-runs it with the fetched posting text.
    result = result.filter((j) => {
      const level = inferJobLevel(j.title);
      return level !== 'unknown' && filters.experienceLevel.includes(level);
    });
  }

  // Wave-10 intent companies (T801): the legacy single-company string and the
  // intent `companies` list are OR-matched together against the row's company
  // (the backend unions them the same way: `company` maps to
  // `[company]` inside `companies`). Additive: an empty `companies` list
  // leaves the legacy behaviour byte-identical. Roles, skills and exclusions
  // are intentionally NOT client-filtered - rows carry no description, and
  // the server is the single authority on query matching (ADR-021 decision
  // 5); they travel with the intent payload (T804).
  const companyTerms = [
    ...(filters.company.trim() ? [filters.company.trim().toLowerCase()] : []),
    ...filters.companies
      .map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : ''))
      .filter((c) => c.length > 0),
  ];
  if (companyTerms.length > 0) {
    result = result.filter((j) =>
      companyTerms.some((term) => j.company.toLowerCase().includes(term))
    );
  }

  if (filters.workMode !== 'all') {
    result = result.filter((j) => getJobWorkMode(j) === filters.workMode);
  }

  if (filters.sources.length > 0) {
    result = result.filter((j) => filters.sources.includes(j.source));
  }

  if (filters.minMatchScore !== undefined && filters.minMatchScore > 0) {
    result = result.filter((j) => (evaluatedScores[j.id] ?? -1) >= filters.minMatchScore!);
  }

  if (filters.postedWithin !== 'all') {
    result = result.filter((j) => isPostedWithin(j.postedAt, filters.postedWithin));
  }

  switch (filters.sortBy) {
    case 'matchScore':
      result.sort((a, b) => {
        const sa = evaluatedScores[a.id];
        const sb = evaluatedScores[b.id];
        if (sa !== undefined && sb !== undefined) return sb - sa;
        if (sa !== undefined) return -1;
        if (sb !== undefined) return 1;
        return 0;
      });
      break;
    case 'newest':
      result.sort((a, b) => {
        const da = parseDate(a.postedAt);
        const db = parseDate(b.postedAt);
        if (da && db) return db.getTime() - da.getTime();
        if (da) return -1;
        if (db) return 1;
        return 0;
      });
      break;
    case 'relevance':
    default:
      break;
  }

  return result;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

function asNameArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is { name?: string } => typeof x === 'object' && x !== null && 'name' in x)
    .map((x) => x.name)
    .filter((n): n is string => typeof n === 'string');
}

function clampToPercent(v: unknown): number | undefined {
  if (typeof v !== 'number') return undefined;
  if (v >= 0 && v <= 5) return Math.round((v / 5) * 100);
  if (v >= 0 && v <= 100) return Math.round(v);
  return undefined;
}

export function normalizeJobInsights(evaluation?: JobEvaluation | null): NormalizedJobInsights {
  if (!evaluation) {
    return { keySkills: [], skillGaps: [], breakdown: {}, evaluationResults: [] };
  }

  const reportJson = evaluation.reportJson ?? {};

  const matchedSkills = asStringArray(reportJson.matchedSkills).concat(asNameArray(reportJson.matchedSkills));
  const skillsFromJson = asStringArray(reportJson.skills).concat(asNameArray(reportJson.skills));
  const skillGaps = asStringArray(reportJson.skillGaps).concat(asNameArray(reportJson.skillGaps)).concat(
    asStringArray(reportJson.missingSkills).concat(asNameArray(reportJson.missingSkills))
  );

  const keySkills = [...new Set([...matchedSkills, ...skillsFromJson])].slice(0, 20);

  const rawBreakdown: Record<string, unknown> = {};
  if (reportJson.breakdown && typeof reportJson.breakdown === 'object' && reportJson.breakdown !== null) {
    Object.assign(rawBreakdown, reportJson.breakdown);
  }

  // T1101: the two fallbacks that read `evaluation.scores.cvMatch` / `evaluation.scores.levelFit`
  // are GONE, because that member is gone - `POST /jobs/:id/evaluate` no longer returns the six
  // per-dimension numbers, and neither does `GET /jobs/evaluations`. Rescaling a 1-5 rubric into a
  // 0-100 percentage is the derived verdict 06 sec. E.6 forbids, so removing the wire member is
  // what removes the arithmetic, not a loss of information. `reportJson.breakdown` above stays: it
  // is whatever the evaluator's prose JSON carries, not a number this client computed.
  const breakdown: JobMatchBreakdown = {};

  const aliasMap: Record<string, string[]> = {
    skills: ['skills', 'skillMatch'],
    experience: ['experience', 'experienceFit'],
    keywords: ['keywords', 'keywordMatch'],
    seniority: ['seniority', 'levelFit'],
  };

  for (const [category, aliases] of Object.entries(aliasMap)) {
    for (const alias of aliases) {
      const raw = rawBreakdown[alias];
      const clamped = clampToPercent(raw);
      if (clamped !== undefined) {
        breakdown[category as keyof JobMatchBreakdown] = clamped;
        break;
      }
    }
  }

  const evaluationResults = asStringArray(reportJson.evaluationResults).concat(asStringArray(reportJson.results));

  return {
    keySkills,
    skillGaps: [...new Set(skillGaps)],
    breakdown,
    evaluationResults: [...new Set(evaluationResults)],
  };
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.closest('[contenteditable="true"]')) return true;
  return false;
}
