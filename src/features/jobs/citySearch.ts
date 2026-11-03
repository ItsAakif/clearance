import { CITY_ALIASES } from './cityAliases';
import type { LocationSuggestion } from '@/services/api';

/** Row shape of public/data/cities.min.json. Must match the generated file exactly. */
export interface CityRow { n: string; c: string; a?: string }

/** BASE_URL-relative so a subpath deployment still resolves it. */
export const CITY_ASSET_URL = `${import.meta.env.BASE_URL}data/cities.min.json`;

export const CITY_RESULT_LIMIT = 20;

/**
 * How many of the pooled suggestions the dropdown shows before a "show more"
 * expander. The search pool above is deliberately larger so mid-recall queries
 * (e.g. "san") keep candidates behind the expander instead of dropping them.
 */
export const CITY_UI_LIMIT = 8;

// Module-scope cache: one asset fetch per page session. A failure resolves to
// [] and is cached too, so later keystrokes never re-request a broken asset.
let cache: CityRow[] | null = null;
let inflight: Promise<CityRow[]> | null = null;

/**
 * Lazy load with a module-scope promise cache. Resolves [] on ANY failure -
 * never rejects, never throws, never retries per keystroke. The control
 * degrades to DB-only plus free text when the asset is unavailable.
 */
export function loadCities(): Promise<CityRow[]> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  let request: Promise<Response>;
  try {
    request = fetch(CITY_ASSET_URL);
  } catch {
    cache = [];
    return Promise.resolve(cache);
  }
  inflight = request.then(
    (res) => {
      if (!res.ok) return [] as CityRow[];
      return res.json().then(
        (body: unknown) => (Array.isArray(body) ? (body as CityRow[]) : []),
        () => [] as CityRow[],
      );
    },
    () => [] as CityRow[],
  ).then((rows) => {
    cache = rows;
    inflight = null;
    return rows;
  });
  return inflight;
}

function toSuggestion(row: CityRow): LocationSuggestion {
  // No `count` key on purpose: a static city has no frequency, and consumers
  // tell "no frequency" by the key being absent with source === 'city'.
  return {
    value: row.n,
    display: row.a ? `${row.n}, ${row.a}, ${row.c}` : `${row.n}, ${row.c}`,
    source: 'city',
  };
}

/**
 * Pure. Alias-aware recall search over a loaded list; population order
 * (file order) preserved within each rank tier, never re-sorted.
 *
 * Two tiers: prefix matches on `n` first, then substring/token matches fill
 * the rest of the pool, so "york" still surfaces "New York City" and
 * "francisco" surfaces "San Francisco" without drowning exact prefixes.
 */
export function searchCities(
  cities: CityRow[],
  query: string,
  limit: number = CITY_RESULT_LIMIT,
): LocationSuggestion[] {
  const q = query.trim().toLowerCase();
  // Empty query answers with the file head (the most populous cities).
  if (q.length === 0) return cities.slice(0, limit).map(toSuggestion);
  // A one-character query over the whole list is noise; the head is better.
  if (q.length === 1) return [];
  const qTokens = q.split(/[\s\-']+/).filter(Boolean);
  // Alias expansion affects matching only. Keys that start with the query rank
  // with the prefix tier; keys that merely contain it rank with the substring
  // tier. Row collection stays a file-order pass per tier so ranking is stable.
  const prefixAliasTargets = new Set<string>();
  const subAliasTargets = new Set<string>();
  for (const [key, target] of Object.entries(CITY_ALIASES)) {
    if (key.startsWith(q)) prefixAliasTargets.add(target.toLowerCase());
    else if (key.includes(q)) subAliasTargets.add(target.toLowerCase());
  }
  const out: LocationSuggestion[] = [];
  const seen = new Set<string>();
  const push = (row: CityRow): void => {
    const key = row.n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(toSuggestion(row));
  };
  // Multi-word queries match order-independently ("san fran" hits San Francisco).
  const matchesAllTokens = (name: string): boolean =>
    qTokens.length > 1 && qTokens.every((t) => name.includes(t));
  // Tier 1: prefix matches first, in file (population) order.
  for (const row of cities) {
    if (out.length >= limit) break;
    const name = row.n.toLowerCase();
    if (name.startsWith(q) || prefixAliasTargets.has(name)) push(row);
  }
  // Tier 2: substring + token + substring-alias matches fill the pool.
  if (out.length < limit) {
    for (const row of cities) {
      if (out.length >= limit) break;
      const name = row.n.toLowerCase();
      if (seen.has(name)) continue;
      if (name.includes(q) || matchesAllTokens(name) || subAliasTargets.has(name)) {
        push(row);
      }
    }
  }
  return out;
}

/**
 * Pure. Local-first concatenation, deduped case-insensitively on `value`.
 * The city row wins ties because it comes first. The default cap is the full
 * search pool; the dropdown shows the first CITY_UI_LIMIT behind a show-more
 * expander rather than dropping the tail.
 */
export function mergeSuggestions(
  cities: LocationSuggestion[],
  listings: LocationSuggestion[],
  limit: number = CITY_RESULT_LIMIT,
): LocationSuggestion[] {
  const out: LocationSuggestion[] = [];
  const seen = new Set<string>();
  for (const row of [...cities, ...listings]) {
    const key = row.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
