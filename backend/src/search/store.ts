// Prisma/Postgres implementation of the catalogue store.
//
// The read path uses parameterised raw SQL (never string interpolation of user
// input) for three reasons:
//   1. `q` must hit the GIN expression index:
//      to_tsvector('simple', title || ' ' || company || ' ' || description)
//      @@ websearch_to_tsquery('simple', $q), and sort=relevance needs ts_rank;
//   2. ordering is `postedAt ?? firstSeenAt`, an expression Prisma orderBy cannot
//      express with a nulls-last per-key fallback;
//   3. facet counts need `doc->>'field'` grouping and `jsonb_array_elements_text`
//      for skills, neither of which Prisma's query API exposes.
// Every filter is a fragment in the same `WHERE`, so page, count and facets are
// guaranteed to see the same filtered set.

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  POSTED_WITHIN_DAYS,
  buildCataloguePlan,
  type CatalogueFacets,
  type CataloguePage,
  type CataloguePlan,
  type CatalogueStore,
} from './query.js';
import type { SearchDocument } from './document.js';
import { computeGhost } from './ghost.js';
import {
  isUnfilteredCataloguePlan,
  readCatalogueFacetCache,
  writeCatalogueFacetCache,
} from './facetCache.js';

export type CatalogueSqlClient = Pick<PrismaClient, '$queryRaw'> &
  Partial<Pick<PrismaClient, 'appSetting'>>;

const FTS_SQL = Prisma.sql`to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("company", '') || ' ' || coalesce("description", ''))`;
// `postedAt ?? firstSeenAt` is derived onto the document from these very columns,
// so ordering/filtering on the columns is identical and can use an expression
// index (the jsonb casts cannot).
const SORT_DATE_SQL = Prisma.sql`coalesce("postedAt", "firstSeenAt")`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function likeContains(value: string): string {
  return `%${escapeLike(value)}%`;
}

/**
 * The shared WHERE fragment. Exported so a test can prove that user input is a
 * bind parameter and that `q` compiles to the expression index, not to a
 * `LIKE` scan.
 */
export function buildCatalogueWhere(plan: CataloguePlan): Prisma.Sql {
  // The catalogue is the ACTIVE browse surface. The partial index predicate
  // below is `WHERE "isActive"`, so the query must carry the same predicate for
  // the planner to use any of the facet indexes.
  const parts: Prisma.Sql[] = [
    Prisma.sql`"searchDocument" IS NOT NULL`,
    Prisma.sql`"isActive" = true`,
  ];

  if (plan.q) {
    parts.push(Prisma.sql`${FTS_SQL} @@ websearch_to_tsquery('simple', ${plan.q})`);
  }
  if (plan.location) {
    parts.push(Prisma.sql`"searchDocument"->>'location' ILIKE ${likeContains(plan.location)} ESCAPE '\\'`);
  }
  if (plan.workMode.length > 0) {
    parts.push(Prisma.sql`"searchDocument"->>'workMode' IN (${Prisma.join(plan.workMode)})`);
  }
  if (plan.seniority.length > 0) {
    parts.push(Prisma.sql`"searchDocument"->>'seniority' IN (${Prisma.join(plan.seniority)})`);
  }
  if (plan.specialization.length > 0) {
    parts.push(Prisma.sql`"searchDocument"->>'specialization' IN (${Prisma.join(plan.specialization)})`);
  }
  if (plan.skills.length > 0) {
    parts.push(
      Prisma.sql`"searchDocument"->'skills' ?| ARRAY[${Prisma.join(plan.skills)}]::text[]`,
    );
  }
  if (plan.salaryMin !== null) {
    parts.push(
      Prisma.sql`CASE WHEN ("searchDocument"->'salary'->>'max') ~ '^[0-9]+$' THEN ("searchDocument"->'salary'->>'max')::bigint ELSE NULL END >= ${plan.salaryMin}`,
    );
  }
  if (plan.postedWithin !== null) {
    const cutoff = new Date(
      plan.now.getTime() - plan.postedWithin * 24 * 60 * 60 * 1000,
    ).toISOString();
    parts.push(Prisma.sql`${SORT_DATE_SQL} >= ${cutoff}::timestamptz`);
  }
  if (plan.source.length > 0) {
    parts.push(Prisma.sql`"searchDocument"->>'source' IN (${Prisma.join(plan.source)})`);
  }
  if (plan.company) {
    parts.push(Prisma.sql`"searchDocument"->>'company' ILIKE ${likeContains(plan.company)} ESCAPE '\\'`);
  }

  return Prisma.join(parts, ' AND ');
}

function buildOrder(plan: CataloguePlan): Prisma.Sql {
  if (plan.sort === 'relevance' && plan.q) {
    return Prisma.sql`ts_rank(${FTS_SQL}, websearch_to_tsquery('simple', ${plan.q})) DESC, ${SORT_DATE_SQL} DESC NULLS LAST, "id" ASC`;
  }
  return Prisma.sql`${SORT_DATE_SQL} DESC NULLS LAST, "id" ASC`;
}

interface FacetQueryRow {
  grp: string;
  value: string | null;
  count: number;
}

function sortedRecord(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([key, count]) => {
      out[key] = count;
    });
  return out;
}

function shapeFacets(rows: readonly FacetQueryRow[]): CatalogueFacets {
  const region = new Map<string, number>();
  const workMode = new Map<string, number>();
  const seniority = new Map<string, number>();
  const specialization = new Map<string, number>();
  const skills = new Map<string, number>();
  const source = new Map<string, number>();
  const postedWithin = new Map<string, number>();
  // The SQL groups each row into its SMALLEST age bucket. The wire shape is
  // CUMULATIVE ("posted within 7 days" includes the 1- and 3-day rows), so the
  // buckets are accumulated after shaping.
  const postedBuckets = new Map<string, number>();

  const bump = (map: Map<string, number>, key: string, count: number): void => {
    map.set(key, (map.get(key) ?? 0) + count);
  };

  for (const row of rows) {
    // GROUPING SETS emits a NULL value for "this row is not in this group" and
    // for rows where the grouped column itself is NULL. The old query's
    // `IS NOT NULL` predicates excluded both; do the same here.
    if (row.value === null || row.value === undefined) continue;
    const value = String(row.value);
    const count = Number(row.count);
    if (!value || !Number.isFinite(count)) continue;
    switch (row.grp) {
      case 'region':
        bump(region, value, count);
        break;
      case 'workMode':
        bump(workMode, value, count);
        break;
      case 'seniority':
        bump(seniority, value, count);
        break;
      case 'specialization':
        bump(specialization, value, count);
        break;
      case 'skill':
        bump(skills, value, count);
        break;
      case 'source':
        bump(source, value, count);
        break;
      case 'postedWithin':
        bump(postedBuckets, value, count);
        break;
      default:
        break;
    }
  }

  let cumulative = 0;
  for (const bucket of POSTED_WITHIN_DAYS) {
    cumulative += postedBuckets.get(String(bucket)) ?? 0;
    if (cumulative > 0) postedWithin.set(String(bucket), cumulative);
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

export function createPrismaCatalogueStore(client: CatalogueSqlClient): CatalogueStore {
  return {
    async page(plan: CataloguePlan): Promise<CataloguePage> {
      const where = buildCatalogueWhere(plan);
      const [countRows, rowResult] = await Promise.all([
        client.$queryRaw<Array<{ count: number }>>(
          Prisma.sql`SELECT count(*)::int AS count FROM "JobListing" WHERE ${where}`,
        ),
        client.$queryRaw<Array<{ id: string; canonicalKey: string | null; doc: SearchDocument }>>(
          Prisma.sql`SELECT "id", "canonicalKey", "searchDocument" AS doc FROM "JobListing" WHERE ${where} ORDER BY ${buildOrder(plan)} LIMIT ${plan.limit} OFFSET ${plan.offset}`,
        ),
      ]);

      // Aggregate context in ONE query, grouped by canonicalKey (coalesced with
      // id so null keys never merge into one bucket).
      const ids = rowResult.map((row) => row.id);
      let aggRows: Array<{
        groupKey: string;
        repostCount: number;
        sourceCount: number;
        firstSeenAt: Date | string | null;
        lastVerifiedAt: Date | string | null;
        postedAt: Date | string | null;
      }> = [];
      if (ids.length > 0) {
        try {
          aggRows = await client.$queryRaw<typeof aggRows>(Prisma.sql`
            SELECT COALESCE("canonicalKey", "id") AS "groupKey",
                   count(*)::int AS "repostCount",
                   count(DISTINCT "source")::int AS "sourceCount",
                   min("firstSeenAt") AS "firstSeenAt",
                   max("lastVerifiedAt") AS "lastVerifiedAt",
                   min("postedAt") AS "postedAt"
            FROM "JobListing"
            WHERE COALESCE("canonicalKey", "id") IN (
              SELECT COALESCE("canonicalKey", "id") FROM "JobListing" WHERE "id" = ANY(${ids}::text[])
            )
            GROUP BY 1
          `);
        } catch {
          aggRows = [];
        }
      }

      const aggMap = new Map(aggRows.map((row) => [String(row.groupKey), row]));

      const rows = rowResult.map((row) => {
        const groupKey = row.canonicalKey ?? row.id;
        const agg = aggMap.get(String(groupKey));
        const firstSeen = agg?.firstSeenAt
          ? (agg.firstSeenAt instanceof Date ? agg.firstSeenAt.toISOString() : String(agg.firstSeenAt))
          : row.doc.firstSeenAt;
        const lastVerified = agg?.lastVerifiedAt
          ? (agg.lastVerifiedAt instanceof Date ? agg.lastVerifiedAt.toISOString() : String(agg.lastVerifiedAt))
          : null;
        const posted = agg?.postedAt
          ? (agg.postedAt instanceof Date ? agg.postedAt.toISOString() : String(agg.postedAt))
          : row.doc.postedAt;

        let ghost;
        try {
          ghost = computeGhost(
            { isActive: row.doc.isActive, postedAt: row.doc.postedAt, firstSeenAt: row.doc.firstSeenAt },
            {
              repostCount: agg ? Number(agg.repostCount) : 1,
              sourceCount: agg ? Number(agg.sourceCount) : 1,
              firstSeenAt: firstSeen,
              lastVerifiedAt: lastVerified,
              postedAt: posted,
              isActive: row.doc.isActive,
            },
            plan.now,
          );
        } catch {
          ghost = { level: 'clear', evidence: [] };
        }
        if (!ghost) ghost = { level: 'clear', evidence: [] };

        const out: any = { ...row.doc, ghost };
        return out;
      });

      // Fail-soft: if aggregate query failed entirely, ensure clear ghosts.
      if (aggRows.length === 0 && rowResult.length > 0) {
        // Could be legitimately empty? If aggregate query failed, rows already
        // got clear via catch above. Nothing more to do.
      }

      return {
        rows: rows as SearchDocument[],
        total: Number(countRows[0]?.count ?? 0),
      };
    },

    async facets(plan: CataloguePlan): Promise<CatalogueFacets> {
      const cacheable = isUnfilteredCataloguePlan(plan);
      if (cacheable) {
        const cached = await readCatalogueFacetCache(client, plan.now);
        if (cached) return cached;
      }

      const facets = await computeFacets(client, plan);

      if (cacheable) await writeCatalogueFacetCache(client, facets);
      return facets;
    },
  };
}

/**
 * One pass over the filtered rows builds every scalar facet AND the recency
 * buckets (GROUPING SETS). Skills need the document's array expanded, so they
 * are the one additional aggregation. Two passes total, instead of the previous
 * seven scans of the same CTE (which Postgres inlined into seven heap scans).
 *
 * Recency rows carry the SMALLEST matching bucket; `shapeFacets` accumulates
 * them into the cumulative 1/3/7/14/30 values the wire shape exposes.
 */
function buildFacetScalarQuery(where: Prisma.Sql, nowIso: string): Prisma.Sql {
  return Prisma.sql`
WITH base AS (
  SELECT
    "searchDocument"->>'region' AS region,
    "searchDocument"->>'workMode' AS workmode,
    "searchDocument"->>'seniority' AS seniority,
    "searchDocument"->>'specialization' AS specialization,
    "searchDocument"->>'source' AS source,
    CASE
      WHEN coalesce("postedAt", "firstSeenAt") >= ${nowIso}::timestamptz - interval '1 day' THEN '1'
      WHEN coalesce("postedAt", "firstSeenAt") >= ${nowIso}::timestamptz - interval '3 days' THEN '3'
      WHEN coalesce("postedAt", "firstSeenAt") >= ${nowIso}::timestamptz - interval '7 days' THEN '7'
      WHEN coalesce("postedAt", "firstSeenAt") >= ${nowIso}::timestamptz - interval '14 days' THEN '14'
      WHEN coalesce("postedAt", "firstSeenAt") >= ${nowIso}::timestamptz - interval '30 days' THEN '30'
      ELSE NULL
    END AS posted_bucket
  FROM "JobListing"
  WHERE ${where}
)
SELECT
  CASE
    WHEN GROUPING(region) = 0 THEN 'region'
    WHEN GROUPING(workmode) = 0 THEN 'workMode'
    WHEN GROUPING(seniority) = 0 THEN 'seniority'
    WHEN GROUPING(specialization) = 0 THEN 'specialization'
    WHEN GROUPING(source) = 0 THEN 'source'
    ELSE 'postedWithin'
  END AS grp,
  CASE
    WHEN GROUPING(region) = 0 THEN region
    WHEN GROUPING(workmode) = 0 THEN workmode
    WHEN GROUPING(seniority) = 0 THEN seniority
    WHEN GROUPING(specialization) = 0 THEN specialization
    WHEN GROUPING(source) = 0 THEN source
    ELSE posted_bucket
  END AS value,
  count(*)::int AS count
FROM base
GROUP BY GROUPING SETS (
  (region), (workmode), (seniority), (specialization), (source), (posted_bucket)
)
`;
}

async function computeFacets(
  client: CatalogueSqlClient,
  plan: CataloguePlan,
): Promise<CatalogueFacets> {
  const where = buildCatalogueWhere(plan);
  const nowIso = plan.now.toISOString();
  const [scalarRows, skillRows] = await Promise.all([
    client.$queryRaw<FacetQueryRow[]>(buildFacetScalarQuery(where, nowIso)),
    client.$queryRaw<FacetQueryRow[]>(Prisma.sql`
SELECT 'skill' AS grp, s.skill AS value, count(*)::int AS count
  FROM "JobListing",
       jsonb_array_elements_text(coalesce("searchDocument"->'skills', '[]'::jsonb)) AS s(skill)
  WHERE ${where}
  GROUP BY 1, 2
`),
  ]);
  return shapeFacets([...scalarRows, ...skillRows]);
}

/**
 * Recompute and store the unfiltered facet payload. Called after a catalogue
 * import; a stale cache is also recomputed lazily by `facets`.
 */
export async function refreshCatalogueFacets(
  client: CatalogueSqlClient,
  now: Date = new Date(),
): Promise<CatalogueFacets> {
  const facets = await computeFacets(client, buildCataloguePlan({}, now));
  await writeCatalogueFacetCache(client, facets);
  return facets;
}
