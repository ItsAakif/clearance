// Derived catalogue search document (V2 browse).
//
// ONE pure, deterministic, total function converts a stored `JobListing` row into
// the JSONB `searchDocument` that IS the public browse wire shape. A later page
// read therefore needs no joins: the row already carries every display field.
//
// "Never guess" rules (05-canonical-model.md philosophy):
//   * every member is always present, with `null` / `[]` as the typed default;
//   * an unknown value is `null`, NOT the most likely value. In particular
//     `workMode` is only ever `remote` or `hybrid` when the location or title
//     says so explicitly - `onsite` is never inferred;
//   * salary is only emitted for a clear annual range with a currency and two
//     sane bounds; a day/hour rate is not an annual salary and yields `null`;
//   * region is only emitted from a curated location-token map. An ambiguous
//     location (tokens for more than one region) yields `null`.
//
// No locale/date formatting here: timestamps are ISO strings, or `null`.

import { SKILL_SYNONYMS } from '../evaluation/matcher.js';
import { inferSeniorityLevel } from '../evaluation/hardFilters.js';
import { htmlToText } from '../jobSources/htmlText.js';

/** Stamp written into every document. A later derivation change bumps this and
 * the backfill picks up rows whose stored `docVersion` differs. */
export const SEARCH_DOC_VERSION = '1';

export const WORK_MODES = ['remote', 'hybrid'] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const SENIORITY_LEVELS = ['junior', 'mid', 'senior', 'staff', 'lead', 'principal'] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

export const SPECIALIZATION_IDS = [
  'data-scientist',
  'data-analyst',
  'devops-engineer',
  'security-engineer',
  'qa-engineer',
  'mobile-engineer',
  'fullstack-engineer',
  'frontend-engineer',
  'backend-engineer',
  'engineering-manager',
  'product-manager',
  'designer',
  'marketing',
  'software-engineer',
] as const;
export type SpecializationId = (typeof SPECIALIZATION_IDS)[number];

export const REGION_IDS = ['us', 'uk', 'eu', 'latam', 'mena', 'africa', 'apac', 'cis'] as const;
export type RegionId = (typeof REGION_IDS)[number];

export const SALARY_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type SalaryCurrency = (typeof SALARY_CURRENCIES)[number];

export interface SearchSalary {
  min: number;
  max: number;
  currency: SalaryCurrency;
}

/** The wire shape. `searchDocument` stores exactly this object. */
export interface SearchDocument {
  id: string;
  title: string;
  company: string;
  location: string | null;
  source: string;
  sourceUrl: string | null;
  applyUrl: string | null;
  postedAt: string | null;
  firstSeenAt: string | null;
  isActive: boolean;
  workMode: WorkMode | null;
  seniority: SeniorityLevel | null;
  specialization: SpecializationId | null;
  skills: string[];
  salary: SearchSalary | null;
  region: RegionId | null;
  descriptionExcerpt: string;
  docVersion: string;
  ghost?: { level: 'clear' | 'watch'; evidence: string[] };
}

/**
 * The subset of `JobListing` this derivation reads. Every member is optional and
 * nullable because the function is total: arbitrary/incomplete input yields a
 * typed default, never a throw.
 */
export interface SearchDocumentSource {
  id: string;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  applyUrl?: string | null;
  postedAt?: Date | string | null;
  firstSeenAt?: Date | string | null;
  isActive?: boolean | null;
  description?: string | null;
}

/** Characters 0x00-0x1F and 0x7F are stripped/replaced before display. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

/** Trim, strip control characters and collapse runs of whitespace. */
function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
}

function cleanNullableText(value: unknown): string | null {
  const text = cleanText(value);
  return text.length > 0 ? text : null;
}

function asIsoString(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `text` contains `term` as a whole word/phrase (ASCII boundaries). */
function containsPhrase(text: string, term: string): boolean {
  if (!text || !term) return false;
  const escaped = escapeRegExp(term);
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

// ---------------------------------------------------------------------------
// workMode
// ---------------------------------------------------------------------------

// ONLY the two explicit states are derivable. `onsite` is never emitted: an
// unstated mode is unknown, and "unknown" is `null`.
export function deriveWorkMode(location: string | null, title: string): WorkMode | null {
  // Location is the stronger signal, then the title. Hybrid checked first so a
  // "Remote (hybrid)" string resolves to the narrower, explicit state.
  if (location) {
    if (containsPhrase(location, 'hybrid')) return 'hybrid';
    if (containsPhrase(location, 'remote')) return 'remote';
  }
  if (containsPhrase(title, 'hybrid')) return 'hybrid';
  if (containsPhrase(title, 'remote')) return 'remote';
  return null;
}

// ---------------------------------------------------------------------------
// specialization
// ---------------------------------------------------------------------------

// Ordered: more specific titles win over the generic "software engineer".
const SPECIALIZATION_RULES: ReadonlyArray<{
  id: SpecializationId;
  terms: readonly string[];
}> = [
  { id: 'data-scientist', terms: ['data scientist', 'machine learning engineer', 'ml engineer', 'deep learning engineer'] },
  { id: 'data-analyst', terms: ['data analyst', 'business analyst', 'bi analyst', 'analytics engineer'] },
  { id: 'devops-engineer', terms: ['devops', 'site reliability', 'sre', 'platform engineer', 'infrastructure engineer', 'cloud engineer'] },
  { id: 'security-engineer', terms: ['security engineer', 'security analyst', 'application security', 'appsec'] },
  { id: 'qa-engineer', terms: ['qa engineer', 'quality assurance', 'test engineer', 'sdet', 'automation engineer'] },
  { id: 'mobile-engineer', terms: ['mobile engineer', 'ios engineer', 'android engineer', 'ios developer', 'android developer'] },
  { id: 'fullstack-engineer', terms: ['full stack', 'fullstack', 'full-stack'] },
  { id: 'frontend-engineer', terms: ['frontend', 'front-end', 'front end', 'react developer', 'ui developer', 'web developer'] },
  { id: 'backend-engineer', terms: ['backend', 'back-end', 'back end', 'server engineer', 'api engineer'] },
  { id: 'engineering-manager', terms: ['engineering manager', 'head of engineering', 'director of engineering'] },
  { id: 'product-manager', terms: ['product manager', 'product owner', 'product lead', 'technical product manager'] },
  { id: 'designer', terms: ['product designer', 'ux designer', 'ui designer', 'ui/ux', 'interaction designer', 'visual designer'] },
  { id: 'marketing', terms: ['marketing', 'seo specialist', 'content strategist', 'growth marketer', 'demand generation'] },
  { id: 'software-engineer', terms: ['software engineer', 'software developer', 'programmer', 'application developer'] },
];

export function deriveSpecialization(title: string): SpecializationId | null {
  const text = cleanText(title);
  if (!text) return null;
  for (const rule of SPECIALIZATION_RULES) {
    if (rule.terms.some((term) => containsPhrase(text, term))) return rule.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

/** Canonical skill key for a free-text skill, using SKILL_SYNONYMS. */
export function canonicalSkill(skill: string): string {
  const needle = cleanText(skill).toLowerCase();
  if (!needle) return '';
  for (const [canonical, synonyms] of Object.entries(SKILL_SYNONYMS)) {
    if (needle === canonical || synonyms.some((synonym) => needle === synonym)) {
      return canonical;
    }
  }
  return needle;
}

const SKILL_CAP = 12;
const SKILL_KEYS = Object.keys(SKILL_SYNONYMS);

export function deriveSkills(text: string): string[] {
  const haystack = cleanText(text);
  if (!haystack) return [];
  const found: string[] = [];
  for (const canonical of SKILL_KEYS) {
    const variants = [canonical, ...(SKILL_SYNONYMS[canonical] ?? [])];
    if (variants.some((variant) => containsPhrase(haystack, variant))) {
      found.push(canonical);
      if (found.length >= SKILL_CAP) break;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// salary
// ---------------------------------------------------------------------------

const AMOUNT_PATTERN = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const CURRENCY_PATTERN = String.raw`\$|€|£|\bUSD\b|\bEUR\b|\bGBP\b`;
const SALARY_RANGE_RE = new RegExp(
  String.raw`(${CURRENCY_PATTERN})\s*(${AMOUNT_PATTERN})\s*([kK])?\s*(?:-|–|—|to)\s*(${CURRENCY_PATTERN})?\s*(${AMOUNT_PATTERN})\s*([kK])?`,
  'gi',
);

const MIN_ANNUAL_SALARY = 10_000;
const MAX_ANNUAL_SALARY = 1_000_000;
const RATE_UNIT_RE =
  /(?:\/|per)\s*(?:hour|hr|day|week|month)|\b(?:hourly|daily|weekly|monthly)\b|\bday\s+rate\b|\bhourly\s+rate\b/i;

function currencyOf(token: string | undefined): SalaryCurrency | null {
  const value = (token ?? '').trim().toLowerCase();
  if (value === '$' || value === 'usd') return 'USD';
  if (value === '€' || value === 'eur') return 'EUR';
  if (value === '£' || value === 'gbp') return 'GBP';
  return null;
}

function amountOf(raw: string, thousands: string | undefined): number | null {
  const parsed = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return null;
  return thousands ? parsed * 1000 : parsed;
}

/**
 * Extract a conservative annual salary range. Both bounds and a currency are
 * required, `min <= max`, `min >= 10,000`, `max <= 1,000,000`. A range below
 * 10k is not an annual salary (this is what rejects `$500-$700/day`); a range
 * with annual-scale bounds but an explicit day/hour unit is rejected too.
 */
export function extractSalary(description: string | null | undefined): SearchSalary | null {
  const text = cleanText(htmlToText(description ?? ''));
  if (!text) return null;

  SALARY_RANGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SALARY_RANGE_RE.exec(text)) !== null) {
    const currency = currencyOf(match[1]);
    const secondCurrency = match[4] === undefined ? currency : currencyOf(match[4]);
    if (!currency || !secondCurrency || currency !== secondCurrency) continue;

    const min = amountOf(match[2], match[3]);
    const max = amountOf(match[5], match[6]);
    if (min === null || max === null) continue;
    if (min > max) continue;
    if (min < MIN_ANNUAL_SALARY || max > MAX_ANNUAL_SALARY) continue;

    const windowStart = Math.max(0, match.index - 30);
    const windowEnd = Math.min(text.length, match.index + match[0].length + 30);
    if (RATE_UNIT_RE.test(text.slice(windowStart, windowEnd))) continue;

    return { min, max, currency };
  }
  return null;
}

// ---------------------------------------------------------------------------
// region
// ---------------------------------------------------------------------------

// Curated location tokens. A bare "CA" is deliberately absent: it is Canada
// (or California) and this closed region set has no honest bucket for it.
const REGION_TOKENS: Readonly<Record<RegionId, readonly string[]>> = {
  us: [
    'united states', 'usa', 'u.s.', 'u.s.a.', 'us', 'new york', 'san francisco',
    'seattle', 'austin', 'boston', 'chicago', 'los angeles', 'denver', 'atlanta',
    'miami', 'dallas', 'houston', 'philadelphia', 'phoenix', 'san diego',
    'san jose', 'washington dc', 'washington, dc', 'portland', 'minneapolis',
  ],
  uk: [
    'united kingdom', 'uk', 'u.k.', 'england', 'scotland', 'wales',
    'northern ireland', 'london', 'manchester', 'edinburgh', 'birmingham',
    'leeds', 'glasgow', 'bristol', 'liverpool', 'sheffield',
  ],
  eu: [
    'germany', 'berlin', 'munich', 'france', 'paris', 'netherlands', 'amsterdam',
    'spain', 'madrid', 'barcelona', 'italy', 'rome', 'milan', 'poland',
    'warsaw', 'krakow', 'portugal', 'lisbon', 'ireland', 'dublin', 'sweden',
    'stockholm', 'denmark', 'copenhagen', 'norway', 'oslo', 'finland',
    'helsinki', 'belgium', 'brussels', 'austria', 'vienna', 'switzerland',
    'zurich', 'czech', 'prague', 'greece', 'athens', 'hungary', 'budapest',
    'romania', 'bucharest', 'estonia', 'tallinn', 'latvia', 'riga', 'lithuania',
    'vilnius',
  ],
  latam: [
    'brazil', 'sao paulo', 'são paulo', 'rio de janeiro', 'argentina',
    'buenos aires', 'mexico', 'mexico city', 'mexico df', 'colombia', 'bogota',
    'bogotá', 'chile', 'santiago', 'peru', 'lima', 'uruguay', 'montevideo',
  ],
  mena: [
    'uae', 'united arab emirates', 'dubai', 'abu dhabi', 'saudi arabia',
    'riyadh', 'jeddah', 'qatar', 'doha', 'israel', 'tel aviv', 'egypt', 'cairo',
    'turkey', 'istanbul', 'ankara', 'morocco', 'casablanca',
  ],
  africa: [
    'nigeria', 'lagos', 'kenya', 'nairobi', 'south africa', 'johannesburg',
    'cape town', 'ghana', 'accra', 'ethiopia', 'addis ababa', 'tanzania',
    'dar es salaam', 'uganda', 'kampala',
  ],
  apac: [
    'india', 'bengaluru', 'bangalore', 'mumbai', 'delhi', 'new delhi',
    'hyderabad', 'pune', 'chennai', 'singapore', 'japan', 'tokyo', 'osaka',
    'australia', 'sydney', 'melbourne', 'brisbane', 'new zealand', 'auckland',
    'china', 'beijing', 'shanghai', 'shenzhen', 'hong kong', 'south korea',
    'seoul', 'taiwan', 'taipei', 'indonesia', 'jakarta', 'malaysia',
    'kuala lumpur', 'philippines', 'manila', 'thailand', 'bangkok', 'vietnam',
    'ho chi minh', 'hanoi',
  ],
  cis: [
    'russia', 'moscow', 'saint petersburg', 'st petersburg', 'kazakhstan',
    'almaty', 'astana', 'ukraine', 'kyiv', 'kiev', 'belarus', 'minsk',
    'armenia', 'yerevan', 'uzbekistan', 'tashkent', 'azerbaijan', 'baku',
    'tbilisi',
  ],
};

export function deriveRegion(location: string | null): RegionId | null {
  const text = cleanText(location);
  if (!text) return null;
  const matches = (Object.entries(REGION_TOKENS) as Array<[RegionId, readonly string[]]>)
    .filter(([, tokens]) => tokens.some((token) => containsPhrase(text, token)))
    .map(([region]) => region);
  // Ambiguous location => unknown. Never pick the "most likely" region.
  return matches.length === 1 ? matches[0] : null;
}

// ---------------------------------------------------------------------------
// excerpt
// ---------------------------------------------------------------------------

export const EXCERPT_MAX_CHARS = 280;

export function deriveExcerpt(description: string | null | undefined): string {
  const text = htmlToText(description ?? '').replace(/\s+/g, ' ').trim();
  return text.slice(0, EXCERPT_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

/**
 * Build the derived document. Total: every field is present and typed, and
 * unknown fields are `null` / `[]`. The object literal order is fixed, so two
 * runs over key-shuffled input produce deep-equal JSON.
 */
export function buildSearchDocument(listing: SearchDocumentSource): SearchDocument {
  const title = cleanText(listing.title);
  const company = cleanText(listing.company);
  const location = cleanNullableText(listing.location);
  const description = listing.description ?? '';
  const plainDescription = htmlToText(description);

  const level = inferSeniorityLevel(title);
  const seniority: SeniorityLevel | null =
    level === 'unknown' ? null : (SENIORITY_LEVELS as readonly string[]).includes(level)
      ? (level as SeniorityLevel)
      : null;

  return {
    id: cleanText(listing.id),
    title,
    company,
    location,
    source: cleanText(listing.source),
    sourceUrl: cleanNullableText(listing.sourceUrl),
    applyUrl: cleanNullableText(listing.applyUrl),
    postedAt: asIsoString(listing.postedAt),
    firstSeenAt: asIsoString(listing.firstSeenAt),
    isActive: listing.isActive !== false,
    workMode: deriveWorkMode(location, title),
    seniority,
    specialization: deriveSpecialization(title),
    skills: deriveSkills(`${title} ${company} ${plainDescription}`),
    salary: extractSalary(description),
    region: deriveRegion(location),
    descriptionExcerpt: deriveExcerpt(description),
    docVersion: SEARCH_DOC_VERSION,
  };
}
