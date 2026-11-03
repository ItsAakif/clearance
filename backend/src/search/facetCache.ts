// Cache for the UNFILTERED catalogue facet payload.
//
// The common browse request (`sort`/`page`/`limit` only) returns the same facet
// counts for every visitor, and computing them over 350k rows is the expensive
// part of the catalogue read. The exact same `CatalogueFacets` object is stored
// in `AppSetting` (JSON text) and served until it is older than 10 minutes.
//
// Filtered requests (any facet value, a search query, location, salary, ...)
// never use this cache: their counts are computed live against the partial
// expression indexes. The cache is therefore an optimisation of one predictable
// shape, not a change to the facet semantics.

import type { PrismaClient } from '@prisma/client';
import type { CatalogueFacets, CataloguePlan } from './query.js';

export const CATALOGUE_FACET_CACHE_KEY = 'catalogue:facets:v1';
export const CATALOGUE_FACET_CACHE_TTL_MS = 10 * 60 * 1000;

const FACET_KEYS = [
  'region',
  'workMode',
  'seniority',
  'specialization',
  'skills',
  'source',
  'postedWithin',
] as const;

/**
 * The store only needs these two Prisma methods. `appSetting` is optional so
 * the existing unit fakes (which only implement `$queryRaw`) keep compiling and
 * simply run without the cache.
 */
export type FacetCacheStore = Partial<Pick<PrismaClient, 'appSetting'>>;

/** True when the plan has no filter or search term: sort/page/limit are ignored. */
export function isUnfilteredCataloguePlan(plan: CataloguePlan): boolean {
  return (
    plan.q === null &&
    plan.location === null &&
    plan.workMode.length === 0 &&
    plan.seniority.length === 0 &&
    plan.specialization.length === 0 &&
    plan.skills.length === 0 &&
    plan.salaryMin === null &&
    plan.postedWithin === null &&
    plan.source.length === 0 &&
    plan.company === null
  );
}

function isFacets(value: unknown): value is CatalogueFacets {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return FACET_KEYS.every((key) => {
    const group = record[key];
    return group !== null && typeof group === 'object' && !Array.isArray(group);
  });
}

/** Fresh cache payload, or null when absent, unreadable or older than the TTL. */
export async function readCatalogueFacetCache(
  store: FacetCacheStore,
  now: Date,
): Promise<CatalogueFacets | null> {
  if (!store.appSetting) return null;
  try {
    const row = await store.appSetting.findUnique({
      where: { key: CATALOGUE_FACET_CACHE_KEY },
      select: { value: true, updatedAt: true },
    });
    if (!row) return null;
    const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
    if (!Number.isFinite(updatedAt.getTime())) return null;
    if (now.getTime() - updatedAt.getTime() > CATALOGUE_FACET_CACHE_TTL_MS) return null;
    const parsed: unknown = JSON.parse(row.value);
    return isFacets(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Best-effort write: a cache failure must never fail the browse request. */
export async function writeCatalogueFacetCache(
  store: FacetCacheStore,
  facets: CatalogueFacets,
): Promise<void> {
  if (!store.appSetting) return;
  try {
    const value = JSON.stringify(facets);
    await store.appSetting.upsert({
      where: { key: CATALOGUE_FACET_CACHE_KEY },
      update: { value },
      create: { key: CATALOGUE_FACET_CACHE_KEY, value },
    });
  } catch {
    // Ignore: the next request recomputes.
  }
}
