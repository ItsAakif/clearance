// Catalogue browse query: zod input -> a deterministic plan -> page + facets.
//
// FACETS CHOICE (documented deliberately): facet counts are computed over the
// SAME filtered set as the page, i.e. every active filter is applied, including
// the facet's own group. This is the "filtered browse" model: selecting
// `workMode=remote` narrows the seniority/region/skill/source counts to remote
// rows. It is a simple, honest count of "what you would see if you kept this
// selection", not a multi-select OR across groups.
//
// MULTI-VALUE SEMANTICS: values within one group are OR-ed (any selected source
// matches, any selected skill matches); different groups are AND-ed. `salaryMin`
// means "the advertised range reaches at least this much" (doc.salary.max >=
// salaryMin). `postedWithin` uses `postedAt ?? firstSeenAt`.

import { z } from 'zod';
import { computeGhost } from './ghost.js';
import { HttpError } from '../shared/errors.js';
import { validateInput } from '../shared/validation.js';
import {
  REGION_IDS,
  SENIORITY_LEVELS,
  SPECIALIZATION_IDS,
  WORK_MODES,
  canonicalSkill,
  type RegionId,
  type SearchDocument,
  type SeniorityLevel,
  type SpecializationId,
  type WorkMode,
} from './document.js';

export const CATALOGUE_INVALID_QUERY_CODE = 'catalogue_invalid_query';
export const CATALOGUE_PAGE_TOO_DEEP_CODE = 'catalogue_page_too_deep';

/** Offset + limit may not exceed this. Deep pages are refused with a code. */
export const CATALOGUE_MAX_OFFSET_PLUS_LIMIT = 10_000;
export const CATALOGUE_DEFAULT_LIMIT = 20;
export const CATALOGUE_MAX_LIMIT = 50;

export const POSTED_WITHIN_DAYS = [1, 3, 7, 14, 30] as const;
export type PostedWithinDays = (typeof POSTED_WITHIN_DAYS)[number];

export const CATALOGUE_SORTS = ['newest', 'relevance'] as const;
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

const postedWithinSchema = z.coerce
  .number()
  .int()
  .refine(
    (value): value is PostedWithinDays =>
      (POSTED_WITHIN_DAYS as readonly number[]).includes(value),
    { message: `postedWithin must be one of ${POSTED_WITHIN_DAYS.join(', ')}` },
  );

export const catalogueQuerySchema = z.object({
  q: z.string().trim().max(200, 'Query too long').optional(),
  location: z.string().trim().max(80, 'Location too long').optional(),
  workMode: z.array(z.enum(WORK_MODES)).max(WORK_MODES.length).optional(),
  seniority: z.array(z.enum(SENIORITY_LEVELS)).max(SENIORITY_LEVELS.length).optional(),
  specialization: z.array(z.enum(SPECIALIZATION_IDS)).max(SPECIALIZATION_IDS.length).optional(),
  skills: z.array(z.string().trim().min(1, 'Skill is required').max(50, 'Skill too long')).max(20).optional(),
  salaryMin: z.coerce.number().int().min(0, 'salaryMin must be >= 0').max(1_000_000, 'salaryMin too large').optional(),
  postedWithin: postedWithinSchema.optional(),
  source: z.array(z.string().trim().min(1, 'Source is required').max(100, 'Source too long')).max(20).optional(),
  company: z.string().trim().max(100, 'Company too long').optional(),
  sort: z.enum(CATALOGUE_SORTS).optional(),
  page: z.coerce.number().int().min(1, 'page must be >= 1').optional(),
  limit: z.coerce.number().int().min(1, 'limit must be >= 1').max(CATALOGUE_MAX_LIMIT, `limit must be <= ${CATALOGUE_MAX_LIMIT}`).optional(),
});

export type CatalogueQueryInput = z.infer<typeof catalogueQuerySchema>;

export interface CataloguePlan {
  q: string | null;
  location: string | null;
  workMode: readonly WorkMode[];
  seniority: readonly SeniorityLevel[];
  specialization: readonly SpecializationId[];
  skills: readonly string[];
  salaryMin: number | null;
  postedWithin: PostedWithinDays | null;
  source: readonly string[];
  company: string | null;
  sort: CatalogueSort;
  page: number;
  limit: number;
  offset: number;
  now: Date;
}

export interface CatalogueFacets {
  region: Record<string, number>;
  workMode: Record<string, number>;
  seniority: Record<string, number>;
  specialization: Record<string, number>;
  skills: Record<string, number>;
  source: Record<string, number>;
  postedWithin: Record<string, number>;
}

export interface CataloguePage {
  rows: SearchDocument[];
  total: number;
}

/** The seam a store implements; the Prisma implementation is in `store.ts`. */
export interface CatalogueStore {
  page(plan: CataloguePlan): Promise<CataloguePage>;
  facets(plan: CataloguePlan): Promise<CatalogueFacets>;
}

export interface CatalogueResult {
  data: SearchDocument[];
  meta: {
    total: number;
    page: number;
    limit: number;
    facets: CatalogueFacets;
  };
}

/** A machine-readable catalogue error (`code` + message) for the route. */
export class CatalogueError extends HttpError {
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(statusCode, message);
    this.name = 'CatalogueError';
    this.code = code;
  }
}

function nonBlank(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dedupeStrings(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function dedupeSkills(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const canonical = canonicalSkill(raw);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/** Turn validated input into the plan. `sort` defaults to relevance when a q
 * is present, otherwise newest. */
export function buildCataloguePlan(
  input: CatalogueQueryInput,
  now: Date = new Date(),
): CataloguePlan {
  const q = nonBlank(input.q);
  const page = input.page ?? 1;
  const limit = input.limit ?? CATALOGUE_DEFAULT_LIMIT;
  const offset = (page - 1) * limit;
  return {
    q,
    location: nonBlank(input.location),
    workMode: dedupeStrings(input.workMode) as WorkMode[],
    seniority: dedupeStrings(input.seniority) as SeniorityLevel[],
    specialization: dedupeStrings(input.specialization) as SpecializationId[],
    skills: dedupeSkills(input.skills),
    salaryMin: input.salaryMin ?? null,
    postedWithin: input.postedWithin ?? null,
    source: dedupeStrings(input.source),
    company: nonBlank(input.company),
    sort: input.sort ?? (q ? 'relevance' : 'newest'),
    page,
    limit,
    offset,
    now,
  };
}

function assertPagination(plan: CataloguePlan): void {
  if (plan.offset + plan.limit > CATALOGUE_MAX_OFFSET_PLUS_LIMIT) {
    throw new CatalogueError(
      400,
      CATALOGUE_PAGE_TOO_DEEP_CODE,
      `Page is too deep: offset + limit may not exceed ${CATALOGUE_MAX_OFFSET_PLUS_LIMIT}`,
    );
  }
}

/** The one public entry point. Validates, plans, checks the pagination cap,
 * then asks the store for the page and its facets. */
export async function catalogueQuery(
  store: CatalogueStore,
  rawInput: unknown,
  options: { now?: Date } = {},
): Promise<CatalogueResult> {
  const input = validateInput(catalogueQuerySchema, rawInput) as CatalogueQueryInput;
  const plan = buildCataloguePlan(input, options.now ?? new Date());
  assertPagination(plan);
  const [page, facets] = await Promise.all([store.page(plan), store.facets(plan)]);
  return {
    data: page.rows,
    meta: {
      total: page.total,
      page: plan.page,
      limit: plan.limit,
      facets,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers used by the in-memory test store (and by query tests). They
// mirror the SQL semantics in `store.ts`; production reads still go to SQL.
// ---------------------------------------------------------------------------

export function emptyFacets(): CatalogueFacets {
  return {
    region: {},
    workMode: {},
    seniority: {},
    specialization: {},
    skills: {},
    source: {},
    postedWithin: {},
  };
}

export function effectiveDateMs(doc: SearchDocument): number | null {
  const value = doc.postedAt ?? doc.firstSeenAt;
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

export function matchesCataloguePlan(doc: SearchDocument, plan: CataloguePlan): boolean {
  if (plan.q) {
    const tokens = plan.q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const haystack = `${doc.title} ${doc.company} ${doc.descriptionExcerpt}`.toLowerCase();
    if (tokens.length > 0 && !tokens.every((token) => haystack.includes(token))) return false;
  }
  if (plan.location && !normalizedText(doc.location).includes(plan.location.toLowerCase())) return false;
  if (plan.workMode.length > 0 && (!doc.workMode || !plan.workMode.includes(doc.workMode))) return false;
  if (plan.seniority.length > 0 && (!doc.seniority || !plan.seniority.includes(doc.seniority))) return false;
  if (plan.specialization.length > 0 && (!doc.specialization || !plan.specialization.includes(doc.specialization))) return false;
  if (plan.skills.length > 0) {
    const have = new Set(doc.skills.map((skill) => canonicalSkill(skill)));
    if (!plan.skills.some((skill) => have.has(skill))) return false;
  }
  if (plan.salaryMin !== null && (doc.salary === null || doc.salary.max < plan.salaryMin)) return false;
  if (plan.postedWithin !== null) {
    const ms = effectiveDateMs(doc);
    if (ms === null) return false;
    if (plan.now.getTime() - ms > plan.postedWithin * DAY_MS) return false;
  }
  if (plan.source.length > 0 && !plan.source.includes(doc.source)) return false;
  if (plan.company && !normalizedText(doc.company).includes(plan.company.toLowerCase())) return false;
  return true;
}

export function relevanceScore(doc: SearchDocument, q: string | null): number {
  if (!q) return 0;
  const tokens = q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const haystack = `${doc.title} ${doc.company} ${doc.descriptionExcerpt}`.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

/** Stable sort matching the SQL ORDER BY (relevance desc, date desc nulls last,
 * id asc; or date desc, id asc). */
export function sortCatalogueDocs(docs: readonly SearchDocument[], plan: CataloguePlan): SearchDocument[] {
  const decorated = docs.map((doc) => ({
    doc,
    rank: plan.sort === 'relevance' ? relevanceScore(doc, plan.q) : 0,
    time: effectiveDateMs(doc),
  }));
  decorated.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (a.time === null && b.time !== null) return 1;
    if (a.time !== null && b.time === null) return -1;
    if (a.time !== null && b.time !== null && b.time !== a.time) return b.time - a.time;
    return a.doc.id.localeCompare(b.doc.id);
  });
  return decorated.map((entry) => entry.doc);
}

function sortedRecord(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .forEach(([key, count]) => {
      out[key] = count;
    });
  return out;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** In-memory facet counter; the same shape the SQL store builds. */
export function buildFacetsFromDocuments(
  docs: readonly SearchDocument[],
  plan: CataloguePlan,
): CatalogueFacets {
  const region = new Map<string, number>();
  const workMode = new Map<string, number>();
  const seniority = new Map<string, number>();
  const specialization = new Map<string, number>();
  const skills = new Map<string, number>();
  const source = new Map<string, number>();
  const postedWithin = new Map<string, number>();

  for (const doc of docs) {
    if (doc.region) bump(region, doc.region);
    if (doc.workMode) bump(workMode, doc.workMode);
    if (doc.seniority) bump(seniority, doc.seniority);
    if (doc.specialization) bump(specialization, doc.specialization);
    for (const skill of doc.skills) bump(skills, skill);
    if (doc.source) bump(source, doc.source);

    const ms = effectiveDateMs(doc);
    if (ms !== null) {
      const ageMs = plan.now.getTime() - ms;
      for (const bucket of POSTED_WITHIN_DAYS) {
        if (ageMs <= bucket * DAY_MS) bump(postedWithin, String(bucket));
      }
    }
  }

  return {
    region: sortedRecord(region),
    workMode: sortedRecord(workMode),
    seniority: sortedRecord(seniority),
    specialization: sortedRecord(specialization),
    skills: sortedRecord(skills),
    source: sortedRecord(source),
    postedWithin: sortedRecord(postedWithin),
  };
}

/** In-memory store used by unit tests. Production uses the Prisma store. */
export function createInMemoryCatalogueStore(docs: readonly SearchDocument[]): CatalogueStore {
  return {
    async page(plan) {
      const filtered = docs.filter((doc) => matchesCataloguePlan(doc, plan));
      const sorted = sortCatalogueDocs(filtered, plan);
      const now = plan.now;
      const rows = sorted.slice(plan.offset, plan.offset + plan.limit).map((doc) => {
        if ((doc as any).ghost) return doc;
        const ghost = computeGhost(
          { isActive: doc.isActive, postedAt: doc.postedAt, firstSeenAt: doc.firstSeenAt },
          {
            repostCount: 1,
            sourceCount: 1,
            firstSeenAt: doc.firstSeenAt,
            lastVerifiedAt: null,
            postedAt: doc.postedAt,
            isActive: doc.isActive,
          },
          now,
        );
        return { ...doc, ghost } as SearchDocument;
      });
      return {
        rows,
        total: sorted.length,
      };
    },
    async facets(plan) {
      const filtered = docs.filter((doc) => matchesCataloguePlan(doc, plan));
      return buildFacetsFromDocuments(filtered, plan);
    },
  };
}

export type { RegionId };
