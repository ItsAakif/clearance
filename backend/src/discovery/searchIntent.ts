// SearchIntent - the structured, serialisable unit of every search (Wave 7,
// ADR-027 decision 1, master-spec N18).
//
// A SearchIntent is a validated zod value that downstream stages (the wave-7
// orchestrator, wave-11/12 saved searches and alerts) pass around instead of
// a raw query string. Derivation from free text is DETERMINISTIC and LLM-FREE:
// no network, no model call, no clock, no randomness - the same input yields
// the same intent in every process. (N18 is enforced for the whole program
// here, at the point where unstructured text becomes structure.)
//
// MODE VOCABULARY (ADR-033 decision 1): the canonical wire values are `fast`,
// `standard`, `deep`, and `full`. `fast` remains the default when mode is
// omitted, preserving legacy payloads; `deep` keeps its literal wire value.
// During `deriveIntent`, unknown mode strings coerce to `fast`, while the
// legacy `deep: true` input still selects `deep` (direct schema parsing keeps
// the canonical enum strict).
//
// TOKENISATION RULE (deriveIntent), documented and pinned by tests:
//   1. The raw text is lowercased; `site:<host>` operators are removed; quote,
//      paren, bracket, comma, semicolon and colon characters become spaces -
//      the same normalisation as `parseQuery` in
//      `backend/src/jobSources/queryMatch.ts`, so intent tokens and the
//      legacy token-OR filter speak the same language.
//   2. Whitespace-separated tokens starting with `-` (e.g. `-php`) become
//      `exclusions` and are removed from the pool.
//   3. The first seniority keyword in token order wins: junior/jr -> junior,
//      mid/middle -> mid, senior/sr -> senior, staff -> staff, lead -> lead,
//      principal -> principal.
//   4. Remote markers (`remote`, `remote-only`, `remoteonly`, `wfh`,
//      `work from home` in any dash/space spelling) set `remoteOnly: true`
//      and are removed from the pool (along with the bare words `only`,
//      `work`, `home` when - and only when - a remote marker matched).
//   5. Tokens in SKILL_VOCAB (fixed list below, matched case-insensitively)
//      become `skills`.
//   6. Leftover tokens (length >= 2, stopwords dropped) become `roles`, one
//      token per entry, first-seen order, case-insensitive dedupe. LIMITATION:
//      multi-word role phrases are NOT reconstructed ("backend engineer"
//      yields ["backend", "engineer"]); what is preserved is the token SET,
//      which is exactly what the token-OR query semantics consume.
//   7. `locations` and `companies` are NEVER derived from free text. There is
//      no gazetteer and no NER in this module, so a company name can never be
//      invented: `companies` is populated only from the explicit `company` /
//      `companies` input fields. Same for locations (`location` /
//      `locations` only).
//
// LEGACY MAPPING TABLE (`jobSearchSchema` at `shared/validation.ts:215-227`
// maps LOSSLESSLY onto an intent; `sources` are canonical JobListing.source
// ids from `allSourceIds()`):
//
// | legacy field | intent field  | rule                                    |
// |--------------|---------------|-----------------------------------------|
// | `q`          | `query`       | retained verbatim (trimmed, max 200)    |
// | `q`          | `roles`/`skills`/`seniority`/`exclusions` | derived by the rule above    |
// | `sources`    | `sourceGroups`| via SOURCE_ID_TO_GROUP below            |
// | `location[]` | `locations`   | copied verbatim                         |
// | `company`    | `companies`   | `[company]` (single string -> one entry)|
// | `limit`      | `limit`       | copied (default 30)                     |
// | `postedWithin`| `postedWithin`| copied (`day`/`week`/`month`)           |
//
// SOURCE_ID_TO_GROUP (many-to-one; every one of the 27 canonical source ids
// appears exactly once):
//   ats         <- greenhouse, ashby, lever, smartrecruiters, recruitee,
//                  personio, jobicy, hnalgolia, workable, bamboohr,
//                  breezyhr, jobvite, teamtailor, pinpoint, freshteam
//   feeds       <- workday, rss, json, career-page
//   aggregators <- adzuna, usajobs, reed, findwork
//   search      <- search
//   dorking     <- dorking
//   scraper     <- scraper
//   browser     <- browser
//
// LIMITATION (stated): the mapping is many-to-one, so a `sources` subset maps
// to a SUPERSET guarantee - every requested source id's group is present, so
// no requested source is ever dropped, but sibling ids in the same group are
// included too. Exact-id filtering stays the route's post-filter job (the
// existing `sourceTypes.includes(job.source)` semantics, ported in T744);
// the intent only promises never to narrow. `sources: undefined` or an
// explicit `sources: []` both mean "no source filter" (today's meaning,
// pinned by the existing route tests) and map to DEFAULT_SOURCE_GROUPS.
// `browser` is a valid `sourceGroups` value but is NOT in the defaults: the
// tier is optional (N2) and must be opted into, never swept by default.
//
// intentToQuery ROUND-TRIP LIMITATION (stated): rendering an intent back to a
// single string does NOT reproduce the input verbatim. Casing is lowered,
// token order is normalised (roles, skills, seniority, `remote`, locations,
// quoted companies, `-exclusions`), and multi-word roles split in step 6 are
// not re-joined. What IS preserved is the token SET that
// `filterAndOrder`/`matchesQuery` consume: every role/skill/seniority token
// of the intent appears in the rendered string, so
// `parseQuery(intentToQuery(i))` covers `parseQuery` of the equivalent legacy
// query (asserted in tests).

import { z } from 'zod';
import { seniorityEnum } from '../shared/seniority.js';
import type { SearchMode } from './budgets.js';

// ---------------------------------------------------------------------------
// Source groups
// ---------------------------------------------------------------------------

export const SOURCE_GROUP_ORDER = [
  'ats',
  'feeds',
  'aggregators',
  'search',
  'dorking',
  'scraper',
  'browser',
] as const;

export type SourceGroup = (typeof SOURCE_GROUP_ORDER)[number];

export const sourceGroupEnum = z.enum(SOURCE_GROUP_ORDER);

// `browser` is valid but NOT a default (N2: the tier is optional, the
// orchestrator reports it unavailable rather than hiding it).
export const DEFAULT_SOURCE_GROUPS: readonly SourceGroup[] = [
  'ats',
  'feeds',
  'aggregators',
  'search',
  'dorking',
  'scraper',
];

export const SOURCE_ID_TO_GROUP: Readonly<Record<string, SourceGroup>> = {
  greenhouse: 'ats',
  ashby: 'ats',
  lever: 'ats',
  smartrecruiters: 'ats',
  recruitee: 'ats',
  personio: 'ats',
  jobicy: 'ats',
  hnalgolia: 'ats',
  workable: 'ats',
  bamboohr: 'ats',
  breezyhr: 'ats',
  jobvite: 'ats',
  teamtailor: 'ats',
  pinpoint: 'ats',
  freshteam: 'ats',
  workday: 'feeds',
  rss: 'feeds',
  json: 'feeds',
  'career-page': 'feeds',
  adzuna: 'aggregators',
  usajobs: 'aggregators',
  reed: 'aggregators',
  findwork: 'aggregators',
  search: 'search',
  dorking: 'dorking',
  scraper: 'scraper',
  browser: 'browser',
};

export const GROUP_TO_SOURCE_IDS: Readonly<Record<SourceGroup, readonly string[]>> = {
  ats: [
    'greenhouse', 'ashby', 'lever', 'smartrecruiters', 'recruitee',
    'personio', 'jobicy', 'hnalgolia', 'workable', 'bamboohr',
    'breezyhr', 'jobvite', 'teamtailor', 'pinpoint', 'freshteam',
  ],
  feeds: ['workday', 'rss', 'json', 'career-page'],
  aggregators: ['adzuna', 'usajobs', 'reed', 'findwork'],
  search: ['search'],
  dorking: ['dorking'],
  scraper: ['scraper'],
  browser: ['browser'],
};

/**
 * Map legacy `sources` (canonical source ids) onto intent `sourceGroups`.
 * `undefined` or an explicit `[]` means "no source filter" and yields the
 * defaults. Unknown ids are ignored (never throw). Output is deduped and
 * ordered by SOURCE_GROUP_ORDER, so the function is deterministic.
 */
export function sourceGroupsForSources(sources: readonly string[] | undefined): SourceGroup[] {
  if (!sources || sources.length === 0) return [...DEFAULT_SOURCE_GROUPS];
  const seen = new Set<SourceGroup>();
  for (const id of sources) {
    const group = SOURCE_ID_TO_GROUP[id];
    if (group) seen.add(group);
  }
  if (seen.size === 0) return [...DEFAULT_SOURCE_GROUPS];
  return SOURCE_GROUP_ORDER.filter((g) => seen.has(g));
}

/**
 * Expand intent `sourceGroups` back to the canonical source ids they cover,
 * in deterministic (SOURCE_GROUP_ORDER, then listed) order.
 */
export function sourceIdsForGroups(groups: readonly SourceGroup[]): string[] {
  const ordered = SOURCE_GROUP_ORDER.filter((g) => (groups as readonly string[]).includes(g));
  return ordered.flatMap((g) => [...GROUP_TO_SOURCE_IDS[g]]);
}

// ---------------------------------------------------------------------------
// Schema (field-for-field per the wave-7 spec; seniorityEnum IMPORTED)
// ---------------------------------------------------------------------------

/**
 * Canonical four-value wire vocabulary shared by intent validation and route
 * validation (ADR-033 decision 1). Keep this tuple as the single list consumed
 * by `searchIntentSchema` and by downstream mode checks.
 */
export const SEARCH_MODES = ['fast', 'standard', 'deep', 'full'] as const satisfies readonly SearchMode[];

export const searchIntentSchema = z.object({
  query: z.string().max(200).optional(),
  roles: z.array(z.string().max(100)).max(10).default([]),
  skills: z.array(z.string().max(50)).max(30).default([]),
  seniority: seniorityEnum.optional(),
  exclusions: z.array(z.string().max(50)).max(20).default([]),
  locations: z.array(z.string().max(80)).max(10).default([]),
  remoteOnly: z.boolean().default(false),
  companies: z.array(z.string().max(120)).max(500).default([]),
  sourceGroups: z
    .array(z.enum(['ats', 'feeds', 'aggregators', 'search', 'dorking', 'scraper', 'browser']))
    .default([...DEFAULT_SOURCE_GROUPS]),
  mode: z.enum(SEARCH_MODES).default('fast'),
  // Wave 9 (T783, ADR-027, N18): evaluation depth for the run. DEFAULT
  // 'deterministic' - passes 1-2 always run, the AI pass never runs unless
  // explicitly opted into 'ai-subset'. Fast mode additionally suppresses the
  // AI pass in the orchestrator (effective mode downgrades to
  // 'deterministic'), so a fast search performs zero AI calls whatever is
  // requested here. There is no legacy query-param mapping: legacy searches
  // derive the default.
  evaluate: z.enum(['off', 'deterministic', 'ai-subset']).default('deterministic'),
  limit: z.number().int().min(1).max(100).default(30),
  postedWithin: z.enum(['day', 'week', 'month']).optional(),
});

export type SearchIntent = z.infer<typeof searchIntentSchema>;

// ---------------------------------------------------------------------------
// Deterministic derivation (N18: no LLM, no clock, no randomness)
// ---------------------------------------------------------------------------

// Mirrors the STOPWORDS in `backend/src/jobSources/queryMatch.ts` so intent
// tokens and the legacy token-OR filter drop the same noise words.
const STOPWORDS: ReadonlySet<string> = new Set([
  'remote',
  'remoteonly',
  'job',
  'jobs',
  'hiring',
  'the',
  'and',
  'or',
  'not',
  'for',
  'with',
  'from',
  'in',
  'at',
  'of',
  'to',
  'a',
  'an',
  'is',
  'are',
  'be',
]);

// Fixed skill vocabulary (lowercase, matched case-insensitively). Deliberately
// a closed list: anything not listed stays a `roles` token, and an empty
// field stays empty - nothing is ever guessed.
const SKILL_VOCAB: ReadonlySet<string> = new Set([
  'javascript', 'typescript', 'python', 'java', 'go', 'golang', 'rust',
  'ruby', 'php', 'swift', 'kotlin', 'scala', 'c++', 'c#', 'net', 'dotnet',
  'react', 'reactjs', 'angular', 'vue', 'vuejs', 'svelte', 'nextjs',
  'next.js', 'nuxt', 'node', 'nodejs', 'node.js', 'express', 'nestjs',
  'django', 'flask', 'fastapi', 'spring', 'rails', 'laravel',
  'sql', 'postgres', 'postgresql', 'mysql', 'mongodb', 'redis',
  'elasticsearch', 'graphql', 'rest',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'k8s', 'terraform',
  'ansible', 'jenkins', 'linux', 'git',
  'spark', 'hadoop', 'airflow', 'kafka', 'rabbitmq',
  'tensorflow', 'pytorch', 'pandas', 'numpy',
  'html', 'css', 'sass', 'tailwind', 'redux', 'vite', 'webpack',
  'jest', 'cypress', 'playwright', 'figma', 'excel', 'tableau', 'powerbi',
]);

const SENIORITY_TOKENS: Readonly<Record<string, z.infer<typeof seniorityEnum>>> = {
  junior: 'junior',
  jr: 'junior',
  mid: 'mid',
  middle: 'mid',
  senior: 'senior',
  sr: 'senior',
  staff: 'staff',
  lead: 'lead',
  principal: 'principal',
};

const REMOTE_PATTERN = /\bremote(-\s*only|\s+only)?\b|\bremoteonly\b|\bwfh\b|\bwork[\s-]+from[\s-]+home\b/;
const REMOTE_DROPS: ReadonlySet<string> = new Set(['remote', 'remoteonly', 'wfh', 'only', 'work', 'home']);

const VALID_POSTED_WITHIN: ReadonlySet<string> = new Set(['day', 'week', 'month']);
const VALID_MODES: ReadonlySet<string> = new Set(SEARCH_MODES);
const VALID_EVALUATE: ReadonlySet<string> = new Set(['off', 'deterministic', 'ai-subset']);
const VALID_SENIORITY: ReadonlySet<string> = new Set(
  (seniorityEnum.options as readonly string[]).slice(),
);

function normalizeToken(raw: string): string {
  return raw.replace(/^\.+|\.+$/g, '');
}

/** Shared normalisation: lowercase, drop site: ops and punctuation, split. */
function tokenizeText(text: string): string[] {
  let s = text.toLowerCase();
  s = s.replace(/site:[^\s]*/g, ' ');
  s = s.replace(/["'()\[\]{},;:]/g, ' ');
  const parts = s.split(/[^a-z0-9+#.]+/);
  const out: string[] = [];
  for (const part of parts) {
    const token = normalizeToken(part);
    if (!token || token.length < 2) continue;
    out.push(token);
  }
  return out;
}

function dedupeKeepOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function cleanStringList(
  values: unknown,
  maxItems: number,
  maxChars: number,
): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, maxChars));
    if (out.length >= maxItems) break;
  }
  return dedupeKeepOrder(out);
}

function splitLocationInput(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return cleanStringList(list, 10, 80);
}

function splitCompanyInput(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return cleanStringList(list, 500, 120);
}

export interface DeriveIntentInput {
  query?: string;
  /** Legacy alias for `query` (`jobSearchSchema.q`). */
  q?: string;
  roles?: string[];
  skills?: string[];
  seniority?: string;
  exclusions?: string[];
  locations?: string[] | string;
  /** Legacy alias for `locations` (`jobSearchSchema.location`, already parsed to an array by the route). */
  location?: string[] | string;
  remoteOnly?: boolean;
  /** Alias for `remoteOnly`. */
  remote?: boolean;
  companies?: string[] | string;
  /** Legacy alias for `companies` (`jobSearchSchema.company`, a single string). */
  company?: string;
  /** Legacy source-id filter (`jobSearchSchema.sources`); mapped via SOURCE_ID_TO_GROUP. */
  sources?: string[];
  sourceGroups?: SourceGroup[];
  mode?: string;
  /** `true` selects `deep` mode when `mode` is absent. */
  deep?: boolean;
  /** Wave 9 evaluation depth. Unknown values fall back to `'deterministic'`. */
  evaluate?: string;
  limit?: number;
  postedWithin?: string;
}

/**
 * Derive a SearchIntent deterministically from free text plus optional
 * explicit/legacy fields. Pure: no I/O, no clock, no randomness, no LLM.
 * Never invents `companies` or `locations` - those come only from explicit
 * input. Explicit structured fields are unioned with (not replaced by)
 * derived tokens, explicit first, so nothing the caller stated is lost.
 */
export function deriveIntent(input: DeriveIntentInput): SearchIntent {
  const rawQuery = input.query ?? input.q;
  const queryText = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 200) : '';
  const hasQuery = queryText.length > 0;

  // Step 2: pull `-exclusions` out before the main tokenisation.
  const exclusionSeeds: string[] = [];
  let poolText = queryText;
  if (hasQuery) {
    const kept: string[] = [];
    for (const chunk of queryText.split(/\s+/)) {
      if (chunk.startsWith('-') && chunk.length > 1) {
        const token = normalizeToken(chunk.slice(1).toLowerCase().replace(/["'()\[\]{},;:]/g, ''));
        if (token && token.length >= 2) exclusionSeeds.push(token);
      } else {
        kept.push(chunk);
      }
    }
    poolText = kept.join(' ');
  }

  const tokens = hasQuery ? tokenizeText(poolText) : [];
  const remoteHinted = hasQuery ? REMOTE_PATTERN.test(queryText.toLowerCase()) : false;

  // Step 3: seniority - first keyword in token order.
  let derivedSeniority: z.infer<typeof seniorityEnum> | undefined;
  for (const token of tokens) {
    const hit = SENIORITY_TOKENS[token];
    if (hit) {
      derivedSeniority = hit;
      break;
    }
  }

  // Steps 4-6: remote, skills, roles.
  const derivedSkills: string[] = [];
  const derivedRoles: string[] = [];
  for (const token of tokens) {
    if (token in SENIORITY_TOKENS) continue;
    if (REMOTE_DROPS.has(token) && (remoteHinted || token === 'remote' || token === 'remoteonly' || token === 'wfh')) {
      // Bare `remote`/`remoteonly`/`wfh` always imply remoteOnly; `only`/
      // `work`/`home` are dropped only when a remote marker matched.
      if (token === 'only' || token === 'work' || token === 'home') {
        if (!remoteHinted) {
          if (!STOPWORDS.has(token)) derivedRoles.push(token);
        }
        continue;
      }
      continue;
    }
    if (SKILL_VOCAB.has(token)) {
      derivedSkills.push(token);
      continue;
    }
    if (STOPWORDS.has(token)) continue;
    derivedRoles.push(token);
  }

  const explicitSeniority =
    typeof input.seniority === 'string' && VALID_SENIORITY.has(input.seniority)
      ? (input.seniority as z.infer<typeof seniorityEnum>)
      : undefined;

  const roles = dedupeKeepOrder([
    ...cleanStringList(input.roles, 10, 100),
    ...derivedRoles,
  ]).slice(0, 10);
  const skills = dedupeKeepOrder([
    ...cleanStringList(input.skills, 30, 50),
    ...derivedSkills,
  ]).slice(0, 30);
  const exclusions = dedupeKeepOrder([
    ...cleanStringList(input.exclusions, 20, 50),
    ...exclusionSeeds,
  ]).slice(0, 20);

  const locations = [...splitLocationInput(input.locations), ...splitLocationInput(input.location)];
  const dedupedLocations = dedupeKeepOrder(locations).slice(0, 10);
  const companies = [...splitCompanyInput(input.companies), ...splitCompanyInput(input.company)];
  const dedupedCompanies = dedupeKeepOrder(companies).slice(0, 500);

  const remoteOnly = input.remoteOnly ?? input.remote ?? (hasQuery ? remoteHinted : false);

  const sourceGroups =
    input.sourceGroups && input.sourceGroups.length > 0
      ? SOURCE_GROUP_ORDER.filter((g) => (input.sourceGroups as readonly string[]).includes(g))
      : sourceGroupsForSources(input.sources);

  const mode: SearchMode =
    typeof input.mode === 'string' && VALID_MODES.has(input.mode)
      ? (input.mode as SearchMode)
      : input.deep === true
        ? 'deep'
        : 'fast';

  const evaluate: 'off' | 'deterministic' | 'ai-subset' =
    typeof input.evaluate === 'string' && VALID_EVALUATE.has(input.evaluate)
      ? (input.evaluate as 'off' | 'deterministic' | 'ai-subset')
      : 'deterministic';

  const limit =
    typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.min(100, Math.max(1, Math.floor(input.limit)))
      : 30;

  const postedWithin =
    typeof input.postedWithin === 'string' && VALID_POSTED_WITHIN.has(input.postedWithin)
      ? (input.postedWithin as 'day' | 'week' | 'month')
      : undefined;

  return searchIntentSchema.parse({
    ...(hasQuery ? { query: queryText } : {}),
    roles,
    skills,
    ...(explicitSeniority ?? derivedSeniority ? { seniority: explicitSeniority ?? derivedSeniority } : {}),
    exclusions,
    locations: dedupedLocations,
    remoteOnly,
    companies: dedupedCompanies,
    sourceGroups,
    mode,
    evaluate,
    limit,
    ...(postedWithin ? { postedWithin } : {}),
  });
}

/**
 * Render an intent back to a single query string for consumers that need one
 * (dorking expansion, alerts/saved-search display).
 *
 * ROUND-TRIP LIMITATION (stated): `intentToQuery(deriveIntent(x))` need not
 * equal `x` verbatim - casing is lowered, order is normalised to
 * roles/skills/seniority/`remote`/locations/quoted-companies/`-exclusions`,
 * and multi-word roles are not re-joined. What is preserved is the token SET
 * the token-OR query semantics consume: every role/skill/seniority token of
 * the intent appears in the rendered string.
 */
export function intentToQuery(intent: SearchIntent): string {
  const parsed = searchIntentSchema.parse(intent);
  const parts: string[] = [];
  for (const role of parsed.roles) parts.push(role);
  for (const skill of parsed.skills) parts.push(skill);
  if (parsed.seniority) parts.push(parsed.seniority);
  if (parsed.remoteOnly) parts.push('remote');
  for (const location of parsed.locations) parts.push(location);
  for (const company of parsed.companies) parts.push(`"${company}"`);
  for (const exclusion of parsed.exclusions) parts.push(`-${exclusion}`);
  return parts.join(' ').slice(0, 200);
}
