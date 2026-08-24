import type { JobListingSummary, JobSearchFilters, JobEvaluation, JobWorkMode, NormalizedJobInsights, JobMatchBreakdown } from "@/services/api";

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

export function filterAndSortJobs(
  jobs: JobListingSummary[],
  filters: JobSearchFilters,
  evaluatedScores: Record<string, number>,
): JobListingSummary[] {
  let result = [...jobs];

  if (filters.query.trim()) {
    const q = filters.query.trim().toLowerCase();
    result = result.filter(
      (j) =>
        j.title.toLowerCase().includes(q) ||
        j.company.toLowerCase().includes(q) ||
        (j.location ?? '').toLowerCase().includes(q)
    );
  }

  if (filters.location.trim()) {
    const loc = filters.location.trim().toLowerCase();
    result = result.filter((j) => (j.location ?? '').toLowerCase().includes(loc));
  }

  if (filters.company.trim()) {
    const comp = filters.company.trim().toLowerCase();
    result = result.filter((j) => j.company.toLowerCase().includes(comp));
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

  if (breakdown.skills === undefined) {
    const cvMatch = evaluation.scores.cvMatch;
    if (typeof cvMatch === 'number' && cvMatch >= 0 && cvMatch <= 5) {
      breakdown.skills = Math.round((cvMatch / 5) * 100);
    }
  }
  if (breakdown.seniority === undefined) {
    const levelFit = evaluation.scores.levelFit;
    if (typeof levelFit === 'number' && levelFit >= 0 && levelFit <= 5) {
      breakdown.seniority = Math.round((levelFit / 5) * 100);
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
