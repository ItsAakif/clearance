// Dork template registry (Wave 5, T700) - DATA ONLY.
//
// Templates are DATA, not code: adding one is a one-entry change in
// DORK_TEMPLATES below and must never require touching `expand.ts` (T701).
//
// STABLE ID SURFACE: `id` values are recorded in saved intents (wave 12) and
// run snapshots. Renaming an id is a BREAKING CHANGE - add a new entry and
// leave the old one in place instead.
//
// NO EXECUTION HERE: no fetch, no HTTP, no LLM. Expansion lives in
// `expand.ts` (T701); execution lives in `index.ts`. This module performs
// no I/O and imports nothing except types.
//
// DATE PROVENANCE (ADR-028): templates carry no dates and no date language.
// A dorked row's only timestamp is the search index date, which is NEVER a
// posted date. Provenance (`postedAtSource: 'index-date'`, `postedAt: null`)
// is assigned at execution time, never by a template.
//
// NO COMPANY NAMES (N13 spirit): no template embeds a hiring-company or
// brand name. Company scoping comes from the search intent at expansion
// time (wave 7) or from the user's own query - never from this registry.
// Role/location variants are likewise NOT hardcoded here; expansion builds
// quoted terms from user data at use time.
//
// EXPANSION CONTRACT FOR T701 (`expand.ts` must honour this):
// For each selected template, in registry order, expansion emits one query:
//  1. `site:<value>` prefix when the template declares `site`. For the
//     `company-site` family (which declares no `site`) the site value comes
//     from the intent's company domain, never from the template.
//  2. Quoted role/skill/seniority terms from the intent joined as
//     `("a" OR "b")`, or the user's raw query honoured verbatim. An intent
//     with neither roles nor query still emits the path clause for the
//     generic families - expansion never fabricates a company name.
//  3. When `pathHints` is non-empty, one `inurl:` alternation group over
//     those hints, in order. Empty `pathHints` means no `inurl:` clause.
//  4. A quoted location phrase appended when the intent carries one.
//  5. Exclusions appended as `-"term"` tokens.
//  6. No date operators (`after:`/`before:`) and no posted-date language,
//     ever.
// CHECKABLE INVARIANT: `operators` lists every operator marker an emitted
// query for that template may contain, and `pathHints` lists every path
// fragment it may contain. A template whose declared markers do not match
// its generated query is a defect (asserted in T701).

export interface DorkTemplate {
  /** Stable API surface - see the breaking-change note above. */
  id: string;
  family: 'ats-board' | 'career-page' | 'job-index' | 'company-site';
  /** A UI sentence. Never a company name, never date-posted language. */
  label: string;
  /** The `site:` operator value. `company-site` templates omit it. */
  site?: string;
  /** The operator markers expansion may emit for this template. */
  operators: readonly string[];
  /** Path fragments expansion may emit via `inurl:`. Empty = no path clause. */
  pathHints: readonly string[];
  /** Explicit on every template - no implicit defaults. */
  enabledByDefault: boolean;
}

// ATS HOST DUPLICATION RECORD (task STEP 2):
// The host table lives in `registry/atsUrl.ts` (T641, ADR-026 decision 2)
// as a private HOST_RULES array - it is not exported, so this registry
// cannot derive the `site:` values without changing that module (out of
// scope for this data-only task). The `site:` values below therefore
// DUPLICATE that host table. Reviewer check: compare each ats-board
// template's `site` against HOST_RULES in `backend/src/registry/atsUrl.ts`.
// Mapping applied: exact-match rules -> the exact host; suffix rules ->
// the base domain (`site:` matches subdomains, so one entry covers the
// whole suffix family). Greenhouse has two exact hosts, hence two entries.
// If a host rule is added to atsUrl.ts, add the matching template here.

const ATS_BOARD_TEMPLATES: readonly DorkTemplate[] = [
  {
    id: 'greenhouse-boards',
    family: 'ats-board',
    label: 'Jobs on Greenhouse boards (site search)',
    site: 'boards.greenhouse.io',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: true,
  },
  {
    id: 'greenhouse-job-boards',
    family: 'ats-board',
    label: 'Jobs on Greenhouse job boards mirror (site search)',
    site: 'job-boards.greenhouse.io',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'lever-jobs',
    family: 'ats-board',
    label: 'Jobs on Lever boards (site search)',
    site: 'jobs.lever.co',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: true,
  },
  {
    id: 'ashby-jobs',
    family: 'ats-board',
    label: 'Jobs on Ashby boards (site search)',
    site: 'jobs.ashbyhq.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: true,
  },
  {
    id: 'workable-apply',
    family: 'ats-board',
    label: 'Jobs on Workable boards (site search)',
    site: 'apply.workable.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: true,
  },
  {
    id: 'recruitee-boards',
    family: 'ats-board',
    label: 'Jobs on Recruitee boards (site search)',
    site: 'recruitee.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'personio-boards',
    family: 'ats-board',
    label: 'Jobs on Personio boards (site search)',
    site: 'jobs.personio.de',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'smartrecruiters-boards',
    family: 'ats-board',
    label: 'Jobs on SmartRecruiters boards (site search)',
    site: 'smartrecruiters.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'bamboohr-boards',
    family: 'ats-board',
    label: 'Jobs on BambooHR boards (site search)',
    site: 'bamboohr.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'breezy-boards',
    family: 'ats-board',
    label: 'Jobs on Breezy boards (site search)',
    site: 'breezy.hr',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'jobvite-boards',
    family: 'ats-board',
    label: 'Jobs on Jobvite boards (site search)',
    site: 'jobvite.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'teamtailor-boards',
    family: 'ats-board',
    label: 'Jobs on Teamtailor boards (site search)',
    site: 'teamtailor.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'pinpointhq-boards',
    family: 'ats-board',
    label: 'Jobs on Pinpoint boards (site search)',
    site: 'pinpointhq.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'rippling-boards',
    family: 'ats-board',
    label: 'Jobs on Rippling boards (site search)',
    site: 'rippling.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
  {
    id: 'freshteam-boards',
    family: 'ats-board',
    label: 'Jobs on Freshteam boards (site search)',
    site: 'freshteam.com',
    operators: ['site:', '"', 'OR', '(', ')', '-'],
    pathHints: [],
    enabledByDefault: false,
  },
];

// Only the four highest-volume ATS hosts are on by default, to bound the
// default per-run query count. The rest stay selectable. Rationale recorded
// here so a reviewer can see the trade-off.

const CAREER_PAGE_PATH_HINTS: readonly string[] = [
  '/careers/',
  '/jobs/',
  '/positions/',
  '/openings/',
];

const JOB_INDEX_PATH_HINTS: readonly string[] = [
  '/jobs/',
  '/job/',
  '/listings/',
  '/vacancies/',
  '/openings/',
];

export const DORK_TEMPLATES: readonly DorkTemplate[] = [
  ...ATS_BOARD_TEMPLATES,
  {
    id: 'career-page-paths',
    family: 'career-page',
    label: 'Career pages reachable by common job-path URLs',
    operators: ['inurl:', '"', 'OR', '(', ')', '-'],
    pathHints: CAREER_PAGE_PATH_HINTS,
    enabledByDefault: true,
  },
  {
    id: 'career-page-titled',
    family: 'career-page',
    label: 'Career pages whose title names the role',
    operators: ['intitle:', 'inurl:', '"', 'OR', '(', ')', '-'],
    pathHints: CAREER_PAGE_PATH_HINTS,
    enabledByDefault: false,
  },
  {
    id: 'job-index-listings',
    family: 'job-index',
    label: 'Aggregated job listings reachable by common listing URLs',
    operators: ['inurl:', '"', 'OR', '(', ')', '-'],
    pathHints: JOB_INDEX_PATH_HINTS,
    enabledByDefault: true,
  },
  {
    id: 'job-index-titled',
    family: 'job-index',
    label: 'Aggregated listings whose title names the role',
    operators: ['intitle:', 'inurl:', '"', 'OR', '(', ')', '-'],
    pathHints: JOB_INDEX_PATH_HINTS,
    enabledByDefault: false,
  },
  {
    id: 'company-site-careers',
    family: 'company-site',
    label: 'Career openings on an employer site from the search intent',
    operators: ['site:', 'inurl:', '"', 'OR', '(', ')', '-'],
    pathHints: CAREER_PAGE_PATH_HINTS,
    enabledByDefault: true,
  },
  {
    id: 'company-site-titled',
    family: 'company-site',
    label: 'Role-titled openings on an employer site from the search intent',
    operators: ['site:', 'intitle:', 'inurl:', '"', 'OR', '(', ')', '-'],
    pathHints: CAREER_PAGE_PATH_HINTS,
    enabledByDefault: false,
  },
];

export const DORK_FAMILIES: readonly DorkTemplate['family'][] = [
  'ats-board',
  'career-page',
  'job-index',
  'company-site',
];

export function templatesForFamily(
  family: DorkTemplate['family'],
): readonly DorkTemplate[] {
  return DORK_TEMPLATES.filter((t) => t.family === family);
}
