// Pure filter state and wire serialisation for the faceted Jobs catalogue
// (`GET /jobs/catalogue`).
//
// The backend accepts repeated and comma-joined arrays; this module emits the
// comma-joined form (the same convention the legacy search client uses). Every
// filter change resets `page` to 1 - the single place that rule lives, so a
// test can hold it still.
//
// No React, no clock, no network.

import type {
  CatalogueParams,
  CataloguePostedWithin,
  CatalogueSort,
} from '../../services/api/jobs';

export type CatalogueFacetGroup =
  | 'workMode'
  | 'seniority'
  | 'specialization'
  | 'skills'
  | 'source';

export interface CatalogueFilterState {
  q: string;
  location: string;
  workMode: string[];
  seniority: string[];
  specialization: string[];
  skills: string[];
  salaryMin: number | null;
  postedWithin: CataloguePostedWithin | null;
  source: string[];
  company: string;
  sort: CatalogueSort;
  page: number;
  limit: number;
}

export const CATALOGUE_PAGE_SIZE = 20;

/** A fresh empty state. Returns new arrays every call (never a shared mutable). */
export function createEmptyCatalogueFilters(): CatalogueFilterState {
  return {
    q: '',
    location: '',
    workMode: [],
    seniority: [],
    specialization: [],
    skills: [],
    salaryMin: null,
    postedWithin: null,
    source: [],
    company: '',
    sort: 'newest',
    page: 1,
    limit: CATALOGUE_PAGE_SIZE,
  };
}

function uniqueTrimmed(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values ?? []) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Apply a filter patch and reset to page 1. Any mutation that changes the
 * filtered set MUST go through this helper (or call it), which is what keeps
 * "Load more" from appending a stale page after a filter change.
 */
export function applyCatalogueFilterChange(
  current: CatalogueFilterState,
  patch: Partial<CatalogueFilterState>,
): CatalogueFilterState {
  const next: CatalogueFilterState = {
    ...current,
    ...patch,
    workMode: uniqueTrimmed(patch.workMode ?? current.workMode),
    seniority: uniqueTrimmed(patch.seniority ?? current.seniority),
    specialization: uniqueTrimmed(patch.specialization ?? current.specialization),
    skills: uniqueTrimmed(patch.skills ?? current.skills),
    source: uniqueTrimmed(patch.source ?? current.source),
    page: 1,
  };
  const q = next.q.trim();
  // Relevance is only meaningful with a query. Clearing the query falls back
  // to newest so the sort select can never hold an unavailable option.
  if (!q && next.sort === 'relevance') next.sort = 'newest';
  next.page = 1;
  return next;
}

/** Toggle one value in a multi-select facet group. */
export function toggleCatalogueFacet(
  current: CatalogueFilterState,
  group: CatalogueFacetGroup,
  value: string,
): CatalogueFilterState {
  const existing = current[group];
  const has = existing.includes(value);
  const next = has ? existing.filter((entry) => entry !== value) : [...existing, value];
  return applyCatalogueFilterChange(current, { [group]: next });
}

/** Toggle a single-choice posted-within bucket (same value clears it). */
export function togglePostedWithin(
  current: CatalogueFilterState,
  days: CataloguePostedWithin,
): CatalogueFilterState {
  return applyCatalogueFilterChange(current, {
    postedWithin: current.postedWithin === days ? null : days,
  });
}

/** The plain object handed to `jobsApi.catalogue` (and the tests). */
export function buildCatalogueParams(filters: CatalogueFilterState): CatalogueParams {
  const q = filters.q.trim();
  const location = filters.location.trim();
  const company = filters.company.trim();
  return {
    ...(q ? { q } : {}),
    ...(location ? { location } : {}),
    workMode: filters.workMode,
    seniority: filters.seniority,
    specialization: filters.specialization,
    skills: filters.skills,
    ...(filters.salaryMin !== null && filters.salaryMin >= 0
      ? { salaryMin: Math.floor(filters.salaryMin) }
      : {}),
    ...(filters.postedWithin !== null ? { postedWithin: filters.postedWithin } : {}),
    source: filters.source,
    ...(company ? { company } : {}),
    sort: filters.sort,
    page: filters.page,
    limit: filters.limit,
  };
}

/** Serialise the wire params themselves. `jobsApi.catalogue` calls this. */
export function serialiseCatalogueParams(params: CatalogueParams): string {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.location) search.set('location', params.location);
  const setList = (key: string, values: readonly string[] | undefined) => {
    const cleaned = uniqueTrimmed(values);
    if (cleaned.length > 0) search.set(key, cleaned.join(','));
  };
  setList('workMode', params.workMode);
  setList('seniority', params.seniority);
  setList('specialization', params.specialization);
  setList('skills', params.skills);
  setList('source', params.source);
  if (params.salaryMin !== undefined) search.set('salaryMin', String(params.salaryMin));
  if (params.postedWithin !== undefined) search.set('postedWithin', String(params.postedWithin));
  if (params.company) search.set('company', params.company);
  if (params.sort) search.set('sort', params.sort);
  if (params.page !== undefined) search.set('page', String(params.page));
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  return search.toString();
}

/** The query string the page actually requests. */
export function buildCatalogueQueryString(filters: CatalogueFilterState): string {
  return serialiseCatalogueParams(buildCatalogueParams(filters));
}

/** Stable query key for the infinite catalogue query (page is supplied by the
 * hook's `pageParam`, so it must not split the key). */
export function catalogueQueryKey(filters: CatalogueFilterState) {
  const { page: _page, limit: _limit, ...filterKey } = filters;
  return ['jobs', 'catalogue', filterKey] as const;
}

/** Number of active, user-visible filters (q is counted separately). */
export function activeCatalogueFilterCount(filters: CatalogueFilterState): number {
  let count = 0;
  if (filters.q.trim()) count++;
  if (filters.location.trim()) count++;
  if (filters.workMode.length > 0) count++;
  if (filters.seniority.length > 0) count++;
  if (filters.specialization.length > 0) count++;
  if (filters.skills.length > 0) count++;
  if (filters.salaryMin !== null) count++;
  if (filters.postedWithin !== null) count++;
  if (filters.source.length > 0) count++;
  if (filters.company.trim()) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Display labels
// ---------------------------------------------------------------------------

export const SENIORITY_FACET_ORDER: readonly string[] = [
  'intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'executive',
];

export const REGION_FACET_ORDER: readonly string[] = [
  'us', 'uk', 'eu', 'latam', 'mena', 'africa', 'apac', 'cis',
];

export const POSTED_FACET_ORDER: readonly CataloguePostedWithin[] = [1, 3, 7, 14, 30];

const SENIORITY_LABELS: Readonly<Record<string, string>> = {
  intern: 'Intern',
  junior: 'Junior',
  mid: 'Mid',
  senior: 'Senior',
  staff: 'Staff',
  principal: 'Principal',
  lead: 'Lead',
  executive: 'Executive',
};

const WORK_MODE_LABELS: Readonly<Record<string, string>> = {
  remote: 'Remote',
  hybrid: 'Hybrid',
};

const REGION_LABELS: Readonly<Record<string, string>> = {
  us: 'United States',
  uk: 'United Kingdom',
  eu: 'Europe',
  latam: 'Latin America',
  mena: 'Middle East & North Africa',
  africa: 'Africa',
  apac: 'Asia-Pacific',
  cis: 'CIS',
};

const SPECIALIZATION_LABELS: Readonly<Record<string, string>> = {
  'data-scientist': 'Data scientist',
  'data-analyst': 'Data analyst',
  'devops-engineer': 'DevOps engineer',
  'security-engineer': 'Security engineer',
  'qa-engineer': 'QA engineer',
  'mobile-engineer': 'Mobile engineer',
  'fullstack-engineer': 'Fullstack engineer',
  'frontend-engineer': 'Frontend engineer',
  'backend-engineer': 'Backend engineer',
  'engineering-manager': 'Engineering manager',
  'product-manager': 'Product manager',
  designer: 'Designer',
  marketing: 'Marketing',
  'software-engineer': 'Software engineer',
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  greenhouse: 'Greenhouse',
  ashby: 'Ashby',
  lever: 'Lever',
  workday: 'Workday',
  rss: 'RSS',
  json: 'JSON',
  smartrecruiters: 'SmartRecruiters',
  recruitee: 'Recruitee',
  personio: 'Personio',
  jobicy: 'Jobicy',
  hnalgolia: 'Hacker News',
  adzuna: 'Adzuna',
  usajobs: 'USAJobs',
  reed: 'Reed',
  findwork: 'Findwork',
  workable: 'Workable',
  bamboohr: 'BambooHR',
  breezyhr: 'Breezy HR',
  jobvite: 'Jobvite',
  teamtailor: 'Teamtailor',
  pinpoint: 'Pinpoint',
  freshteam: 'Freshteam',
  'career-page': 'Career page',
  search: 'Web search',
  scraper: 'Scraper',
  dorking: 'Dorking',
  browser: 'Browser',
};

function titleCaseWords(value: string): string {
  const text = value.replace(/[-_]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : value;
}

/** Sentence-case label for one facet value. */
export function facetValueLabel(group: string, value: string): string {
  switch (group) {
    case 'workMode':
      return WORK_MODE_LABELS[value] ?? titleCaseWords(value);
    case 'seniority':
      return SENIORITY_LABELS[value] ?? titleCaseWords(value);
    case 'specialization':
      return SPECIALIZATION_LABELS[value] ?? titleCaseWords(value);
    case 'region':
      return REGION_LABELS[value] ?? titleCaseWords(value);
    case 'source':
      return SOURCE_LABELS[value] ?? titleCaseWords(value);
    default:
      return value;
  }
}

/** Human label for a posted-within bucket. */
export function postedWithinLabel(days: number): string {
  if (days <= 1) return 'Today';
  return `${days} days`;
}

function compactMoney(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/** The plain-text active-filter summary shown beside the result count. */
export function describeCatalogueFilters(filters: CatalogueFilterState): string {
  const parts: string[] = [];
  const q = filters.q.trim();
  if (q) parts.push(`"${q}"`);
  if (filters.location.trim()) parts.push(`in ${filters.location.trim()}`);
  for (const value of filters.workMode) parts.push(facetValueLabel('workMode', value));
  for (const value of filters.seniority) parts.push(facetValueLabel('seniority', value));
  for (const value of filters.specialization) parts.push(facetValueLabel('specialization', value));
  for (const value of filters.skills) parts.push(value);
  if (filters.salaryMin !== null) parts.push(`from ${compactMoney(filters.salaryMin)}`);
  if (filters.postedWithin !== null) {
    parts.push(filters.postedWithin === 1 ? 'posted today' : `posted in ${filters.postedWithin} days`);
  }
  for (const value of filters.source) parts.push(facetValueLabel('source', value));
  if (filters.company.trim()) parts.push(filters.company.trim());
  return parts.join(' · ');
}
