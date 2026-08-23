// Curated search queries for job discovery (adapted from career-ops portals.yml)
// These run via Tavily (BYOK) to find jobs from boards/companies without public ATS APIs.
//
// NOTE: these are intentionally ROLE-DIVERSE (not AI-engineer skewed). The default
// ATS boards already cover many AI companies; these searches broaden coverage
// across engineering, product, design, data, and DevOps roles.

export interface SearchQuery {
  name: string;
  query: string;
  site?: string;     // e.g. "jobs.ashbyhq.com"
  enabled: boolean;
}

// High-signal queries covering major job boards + aggregators.
// Users can enable/disable these from the UI later. Seeded as 'search' JobBoards.
export const DEFAULT_SEARCH_QUERIES: SearchQuery[] = [
  // ---- Ashby (role-diverse) ----
  { name: 'Ashby - Software Engineer', query: '"Software Engineer" OR "Backend Engineer" OR "Full Stack" remote', site: 'jobs.ashbyhq.com', enabled: true },
  { name: 'Ashby - Data & ML', query: '"Data Scientist" OR "Machine Learning" OR "Data Engineer" remote', site: 'jobs.ashbyhq.com', enabled: true },
  { name: 'Ashby - Product & Design', query: '"Product Manager" OR "Product Designer" OR "UX" remote', site: 'jobs.ashbyhq.com', enabled: true },
  { name: 'Ashby - DevOps & Infra', query: '"DevOps" OR "Site Reliability" OR "Platform Engineer" remote', site: 'jobs.ashbyhq.com', enabled: true },

  // ---- Greenhouse (role-diverse) ----
  { name: 'Greenhouse - Software Engineer', query: '"Software Engineer" OR "Backend" OR "Frontend" remote', site: 'job-boards.greenhouse.io', enabled: true },
  { name: 'Greenhouse - Data & ML', query: '"Data Scientist" OR "Machine Learning" OR "ML Engineer" remote', site: 'job-boards.greenhouse.io', enabled: true },
  { name: 'Greenhouse - Product & Design', query: '"Product Manager" OR "Designer" OR "UX Researcher" remote', site: 'job-boards.greenhouse.io', enabled: true },
  { name: 'Greenhouse - DevOps & Infra', query: '"DevOps" OR "SRE" OR "Infrastructure" remote', site: 'job-boards.greenhouse.io', enabled: true },

  // ---- Lever ----
  { name: 'Lever - Engineering', query: '"Software Engineer" OR "Backend" OR "Full Stack" remote', site: 'jobs.lever.co', enabled: true },
  { name: 'Lever - Product & Data', query: '"Product Manager" OR "Data Scientist" OR "Analyst" remote', site: 'jobs.lever.co', enabled: true },

  // ---- Workable ----
  { name: 'Workable - Engineering', query: '"Software Engineer" OR "Backend" OR "DevOps" remote', site: 'apply.workable.com', enabled: true },
  { name: 'Workable - Product & Design', query: '"Product Manager" OR "Designer" remote', site: 'apply.workable.com', enabled: true },

  // ---- Aggregators (general web search) ----
  { name: 'RemoteOK - Engineering', query: '"Software Engineer" OR "Backend" OR "Full Stack" OR "Frontend"', site: 'remoteok.com', enabled: true },
  { name: 'WeWorkRemotely - Product & Design', query: '"Product Manager" OR "Designer" OR "UX"', site: 'weworkremotely.com', enabled: true },
  { name: 'Remotive - Data & DevOps', query: '"Data" OR "DevOps" OR "Machine Learning" OR "Engineer"', site: 'remotive.com', enabled: true },
  { name: 'Hacker News - Who is Hiring', query: '"Software Engineer" OR "Founding Engineer" OR "Product" remote', site: 'news.ycombinator.com', enabled: false },
  { name: 'EU Remote Jobs - Engineering', query: '"Software" OR "Data" OR "DevOps" "Engineer" remote Europe', site: 'euremotejobs.com', enabled: true },
  { name: 'Working Nomads - Engineering', query: '"Software Engineer" OR "Developer" OR "DevOps"', site: 'workingnomads.com', enabled: false },
];

// Convert a SearchQuery to a JobBoard seed entry (type='search')
export function searchQueryToBoard(query: SearchQuery) {
  return {
    type: 'search' as const,
    name: query.name,
    searchQuery: query.query,
    searchSite: query.site || null,
    isActive: query.enabled,
  };
}
