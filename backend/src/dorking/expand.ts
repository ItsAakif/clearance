// Deterministic dork query expansion (Wave 5, T701).
//
// Pure query BUILDER only: no fetch, no HTTP, no LLM (master-spec N18).
// Execution lives in `index.ts` (T702); the template registry lives in
// `templates.ts` (T700). This module carries no dates and emits no date
// operators (`after:`/`before:`) - a dorked row's only timestamp is the
// search index date, which is NEVER a posted date (ADR-028).
//
// RETURN-SHAPE CHOICE (task STEP 4): `expand()` returns
// `{ queries, dropped, truncated }` rather than a bare array, so overflow
// is never silent. `dropped` is the number of candidate queries beyond
// `MAX_DORK_QUERIES_PER_RUN`; `truncated` is the number of emitted queries
// cut at `MAX_DORK_QUERY_CHARS`. The exported function name is `expand`
// per the wave spec.
//
// PRIORITY ORDER (caps): candidates are ordered by family in registry
// `DORK_FAMILIES` order (ats-board, career-page, job-index, company-site),
// then by template registry order within the family, then by company input
// order for company-site expansion. The first `MAX_DORK_QUERIES_PER_RUN`
// candidates are emitted; the rest are counted in `dropped`. Wave 7 owns
// company priority; input order is the priority here.
//
// FAMILY SELECTION: `opts.families` restricts to those families (unknown
// names are ignored). Without it, an intent with roles/skills/seniority or
// a query expands all families; an intent with neither roles nor query
// yields ONLY the generic career-page and job-index families and NEVER
// fabricates a company name. company-site templates expand one query per
// company host and yield nothing when the intent names no companies.
//
// VERBATIM RULES: a user query containing `site:` keeps the user's scoping
// verbatim - no template `site:` prefix is added and `DorkQuery.site` is
// left undefined so a downstream executor cannot re-apply it. A user query
// containing a `-term` keeps the user's exclusions verbatim - no intent
// exclusions are appended. Otherwise roles/skills become quoted terms
// joined as `("a" OR "b")`, seniority appends its quoted level word,
// locations append the first location as a quoted phrase, and exclusions
// append as `-"term"` tokens.
//
// SENIORITY (ADR-009): the level word is the stored enum value itself
// (`junior|mid|senior|staff|lead|principal`) - no new level words are
// invented. A value outside that vocabulary is ignored, never guessed.
//
// CHARACTER CAP: any `q` longer than `MAX_DORK_QUERY_CHARS` is cut at the
// cap and counted in `truncated`.
//
// IGNORED BY DESIGN: `remoteOnly` has no dork operator - it is a
// downstream filter, not a query term, so expansion ignores it.
//
// SearchIntent NOTE: the canonical `SearchIntent` schema lands in wave 7
// (T740). The structural interface below mirrors T740's field names so the
// canonical type is assignable here without an edit; this module reads only
// the fields it needs and treats every array field as optional.
//
// DETERMINISM: same intent + same template set => same output, same order,
// across calls and processes. No clocks, no randomness, no Set/Map/object-
// key iteration - only array operations in input/registry order.

import { DORK_FAMILIES, DORK_TEMPLATES } from './templates.js';
import type { DorkTemplate } from './templates.js';

// Structural intent (see the SearchIntent NOTE above). Field names match
// the T740 schema so the canonical zod type stays assignable.
export interface SearchIntent {
  query?: string;
  roles?: string[];
  skills?: string[];
  seniority?: 'junior' | 'mid' | 'senior' | 'staff' | 'lead' | 'principal' | null;
  exclusions?: string[];
  locations?: string[];
  remoteOnly?: boolean;
  companies?: string[];
}

export interface DorkQuery {
  templateId: string;
  q: string;
  site?: string;
  maxResults: number;
}

export interface DorkExpansion {
  queries: DorkQuery[];
  dropped: number;
  truncated: number;
}

export interface ExpandOptions {
  families?: string[];
}

// Per-run query cap: covers the non-company queries of the current
// registry with headroom for one company expansion, while bounding a
// 500-company domain-scoped intent (T740 allows 500 companies) to a
// reportable, finite run.
export const MAX_DORK_QUERIES_PER_RUN = 20;
// Matches the existing `search` board's per-query result count.
export const MAX_DORK_RESULTS_PER_QUERY = 10;
// Practical engine query length; overflow is cut and counted, never silent.
export const MAX_DORK_QUERY_CHARS = 300;

// ADR-009 stored-enum vocabulary. Seniority maps to one of these words and
// nothing else; anything outside this list is ignored, never invented.
export const SENIORITY_LEVELS: readonly string[] = [
  'junior',
  'mid',
  'senior',
  'staff',
  'lead',
  'principal',
];

// Intent with neither roles nor query still emits these generic families.
const GENERIC_FAMILIES: readonly string[] = ['career-page', 'job-index'];

// Strip quotes (they would break the emitted quoting), collapse whitespace,
// trim. Deterministic string ops only.
function cleanTerm(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

// Case-insensitive dedupe preserving first-seen order, using arrays only
// (no Set iteration order dependence).
function dedupeKeepOrder(values: string[]): string[] {
  const out: string[] = [];
  const seenLower: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seenLower.indexOf(key) === -1) {
      seenLower.push(key);
      out.push(value);
    }
  }
  return out;
}

function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const cleaned: string[] = [];
  for (const value of values) {
    const term = cleanTerm(value);
    if (term.length > 0) cleaned.push(term);
  }
  return dedupeKeepOrder(cleaned);
}

// Derive a `site:` host from an intent company entry: lowercase, strip
// scheme/`www.`/path/query/port. A bare name is used verbatim (never
// mapped to an invented domain); an entry with nothing left is dropped.
function toSiteHost(value: string): string {
  let host = value.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, '');
  if (host.startsWith('www.')) host = host.slice('www.'.length);
  const cut = host.search(/[\/?#:]/);
  if (cut !== -1) host = host.slice(0, cut);
  return host.trim().replace(/\.+$/, '');
}

interface BuiltQuery {
  query: DorkQuery;
  wasTruncated: boolean;
}

function buildQuery(
  template: DorkTemplate,
  host: string | undefined,
  core: {
    rawQuery: string;
    hasUserSite: boolean;
    hasUserExclusion: boolean;
    coreTerms: string[];
    locationPhrase: string;
    exclusions: string[];
  },
): BuiltQuery {
  const parts: string[] = [];
  const templateSite =
    template.family === 'company-site' ? host : template.site;
  if (templateSite && !core.hasUserSite) parts.push(`site:${templateSite}`);

  if (core.rawQuery.length > 0) {
    // User terms verbatim: no role/skill wrapping, no intitle: wrapping.
    parts.push(core.rawQuery);
  } else if (core.coreTerms.length > 0) {
    const group = core.coreTerms.map((t) => `"${t}"`).join(' OR ');
    // Data-driven: any template declaring `intitle:` scopes the core group
    // with it, so adding a titled template never requires touching this
    // module (T700 one-entry rule).
    const titled = template.operators.indexOf('intitle:') !== -1;
    parts.push(titled ? `intitle:(${group})` : `(${group})`);
  }

  if (template.pathHints.length > 0) {
    const alts = template.pathHints.map((h) => `inurl:"${h}"`).join(' OR ');
    parts.push(`(${alts})`);
  }

  if (core.locationPhrase.length > 0) parts.push(core.locationPhrase);

  if (!core.hasUserExclusion) {
    for (const exclusion of core.exclusions) parts.push(`-"${exclusion}"`);
  }

  let q = parts.join(' ');
  let wasTruncated = false;
  if (q.length > MAX_DORK_QUERY_CHARS) {
    q = q.slice(0, MAX_DORK_QUERY_CHARS).replace(/\s+$/, '');
    wasTruncated = true;
  }

  const query: DorkQuery = {
    templateId: template.id,
    q,
    maxResults: MAX_DORK_RESULTS_PER_QUERY,
  };
  if (templateSite && !core.hasUserSite) query.site = templateSite;
  return { query, wasTruncated };
}

export function expand(
  intent: SearchIntent,
  opts?: ExpandOptions,
): DorkExpansion {
  const safe: SearchIntent = intent ?? {};
  const roles = cleanList(safe.roles);
  const skills = cleanList(safe.skills);
  const exclusions = cleanList(safe.exclusions);
  const locations = cleanList(safe.locations);
  const companies = cleanList(safe.companies);
  const rawQuery =
    typeof safe.query === 'string' ? safe.query.trim() : '';

  const seniorityRaw =
    typeof safe.seniority === 'string'
      ? safe.seniority.trim().toLowerCase()
      : '';
  const seniority =
    SENIORITY_LEVELS.indexOf(seniorityRaw) !== -1 ? seniorityRaw : '';

  const coreTerms = dedupeKeepOrder(
    seniority !== '' ? [...roles, ...skills, seniority] : [...roles, ...skills],
  );
  const hasTerms = coreTerms.length > 0 || rawQuery.length > 0;
  const hasUserSite = /site:/i.test(rawQuery);
  const hasUserExclusion = /(^|\s)-[^\s]/.test(rawQuery);
  // One quoted location phrase: the first location in input order.
  const locationPhrase =
    locations.length > 0 ? `"${locations[0]}"` : '';

  const hosts = dedupeKeepOrder(
    companies.map(toSiteHost).filter((h) => h.length > 0),
  );

  const knownFamilies: string[] = [...DORK_FAMILIES];
  let selected: string[];
  if (opts && Array.isArray(opts.families)) {
    selected = [];
    for (const family of opts.families) {
      if (
        knownFamilies.indexOf(family) !== -1 &&
        selected.indexOf(family) === -1
      ) {
        selected.push(family);
      }
    }
  } else if (hasTerms) {
    selected = [...knownFamilies];
  } else {
    selected = [...GENERIC_FAMILIES];
  }
  const orderedFamilies = knownFamilies.filter(
    (f) => selected.indexOf(f) !== -1,
  );

  // Candidate list in documented priority order: family, then template
  // registry order, then company input order.
  const candidates: Array<{ template: DorkTemplate; host?: string }> = [];
  for (const family of orderedFamilies) {
    for (const template of DORK_TEMPLATES) {
      if (template.family !== family) continue;
      if (family === 'company-site') {
        for (const host of hosts) candidates.push({ template, host });
      } else {
        candidates.push({ template });
      }
    }
  }

  const core = {
    rawQuery,
    hasUserSite,
    hasUserExclusion,
    coreTerms,
    locationPhrase,
    exclusions,
  };
  const queries: DorkQuery[] = [];
  let truncated = 0;
  const total = candidates.length;
  const take =
    total < MAX_DORK_QUERIES_PER_RUN ? total : MAX_DORK_QUERIES_PER_RUN;
  for (let i = 0; i < take; i++) {
    const candidate = candidates[i];
    const built = buildQuery(candidate.template, candidate.host, core);
    queries.push(built.query);
    if (built.wasTruncated) truncated += 1;
  }
  return { queries, dropped: total - take, truncated };
}
