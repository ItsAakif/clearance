import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  buildCataloguePlan,
  type CataloguePlan,
} from './query.js';
import { buildSearchDocument } from './document.js';
import {
  buildCatalogueWhere,
  createPrismaCatalogueStore,
  type CatalogueSqlClient,
} from './store.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');

function plan(overrides: Parameters<typeof buildCataloguePlan>[0] = {}): CataloguePlan {
  return buildCataloguePlan(overrides, NOW);
}

function where(overrides: Parameters<typeof buildCataloguePlan>[0] = {}): Prisma.Sql {
  return buildCatalogueWhere(plan(overrides));
}

describe('buildCatalogueWhere - full text', () => {
  it('binds q and compiles the expression-index FTS predicate, never LIKE', () => {
    const sql = where({ q: 'remote engineer' });
    expect(sql.sql).toContain(
      `to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("company", '') || ' ' || coalesce("description", ''))`,
    );
    expect(sql.sql).toContain(`@@ websearch_to_tsquery('simple', ?)`);
    expect(sql.sql).not.toContain('LIKE');
    expect(sql.values).toEqual(['remote engineer']);
    // User input is a bind value, never part of the SQL text.
    expect(sql.sql).not.toContain('remote engineer');
  });

  it('requires an active document; no filters means no extra predicates', () => {
    const sql = where();
    expect(sql.sql).toBe(`"searchDocument" IS NOT NULL AND "isActive" = true`);
    expect(sql.values).toEqual([]);
  });
});

describe('buildCatalogueWhere - filters', () => {
  it('binds multi-value groups and ORs within each group', () => {
    const sql = where({ workMode: ['remote', 'hybrid'], source: ['greenhouse', 'lever'] });
    expect(sql.sql).toContain(`"searchDocument"->>'workMode' IN (?,?)`);
    expect(sql.sql).toContain(`"searchDocument"->>'source' IN (?,?)`);
    expect(sql.values).toEqual(['remote', 'hybrid', 'greenhouse', 'lever']);
  });

  it('binds LIKE patterns with escaped wildcards', () => {
    const sql = where({ location: '50%_off', company: 'Acme' });
    expect(sql.sql).toContain(`ILIKE ? ESCAPE '\\'`);
    expect(sql.values).toEqual([`%50\\%\\_off%`, '%Acme%']);
  });

  it('binds the skills array to the JSONB existence operator', () => {
    const sql = where({ skills: ['AWS', 'React'] });
    expect(sql.sql).toContain(`"searchDocument"->'skills' ?| ARRAY[?,?]::text[]`);
    expect(sql.values).toEqual(['amazon web services', 'react']);
  });

  it('guards salary.max with a numeric regex before the cast', () => {
    const sql = where({ salaryMin: 120_000 });
    expect(sql.sql).toContain(`("searchDocument"->'salary'->>'max') ~ '^[0-9]+$'`);
    expect(sql.sql).toContain('::bigint ELSE NULL END >= ?');
    expect(sql.values).toEqual([120_000]);
  });

  it('computes the postedWithin cutoff from the plan clock', () => {
    const sql = where({ postedWithin: 7 });
    expect(sql.sql).toContain(`coalesce("postedAt", "firstSeenAt")`);
    expect(sql.sql).toContain(`>= ?::timestamptz`);
    expect(sql.values).toEqual(['2026-10-23T12:00:00.000Z']);
  });

  it('does not emit an onsite work-mode default', () => {
    const sql = where({ workMode: ['remote'] });
    expect(sql.sql).not.toContain('onsite');
    expect(sql.values).not.toContain('onsite');
  });
});

interface CapturedQuery {
  sql: string;
  values: unknown[];
}

function captureClient(
  pageRows: unknown[],
  total: number,
  facetRows: unknown[],
  skillRows: unknown[] = [],
): { client: CatalogueSqlClient; queries: CapturedQuery[] } {
  const queries: CapturedQuery[] = [];
  const queryRaw = vi.fn((query: Prisma.Sql) => {
    queries.push({ sql: query.sql, values: query.values });
    if (query.sql.includes('GROUPING SETS')) return Promise.resolve(facetRows);
    if (query.sql.includes('jsonb_array_elements_text')) return Promise.resolve(skillRows);
    if (query.sql.includes('GROUP BY 1')) return Promise.resolve([]);
    if (query.sql.includes('count(*)::int AS count')) return Promise.resolve([{ count: total }]);
    return Promise.resolve(
      pageRows.map((row: any) => ({
        id: row?.id ?? '00000000-0000-0000-0000-000000000000',
        canonicalKey: row?.canonicalKey ?? null,
        doc: row?.doc ?? row,
      })),
    );
  });
  return { client: { $queryRaw: queryRaw } as unknown as CatalogueSqlClient, queries };
}

describe('createPrismaCatalogueStore - page', () => {
  it('binds limit/offset, orders by relevance then effective date, and returns rows + total', async () => {
    const doc = buildSearchDocument({ id: 'a1', title: 'Engineer', company: 'Acme', description: 'x' });
    const { client, queries } = captureClient([doc], 42, []);
    const store = createPrismaCatalogueStore(client);

    const result = await store.page(plan({ q: 'engineer', page: 3, limit: 10 }));

    expect(result).toEqual({
      rows: [{ ...doc, ghost: { level: 'clear', evidence: [] } }],
      total: 42,
    });
    const pageQuery = queries.find((query) => query.sql.includes('searchDocument" AS doc'));
    expect(pageQuery).toBeDefined();
    expect(pageQuery!.sql).toContain('ts_rank(');
    expect(pageQuery!.sql).toContain(`websearch_to_tsquery('simple', ?)`);
    expect(pageQuery!.sql).toContain('DESC NULLS LAST, "id" ASC');
    expect(pageQuery!.sql).toContain('LIMIT ? OFFSET ?');
    expect(pageQuery!.values).toEqual(['engineer', 'engineer', 10, 20]);
  });

  it('uses effective-date ordering when there is no relevance sort', async () => {
    const { client, queries } = captureClient([], 0, []);
    await createPrismaCatalogueStore(client).page(plan({ limit: 5 }));
    const pageQuery = queries.find((query) => query.sql.includes('searchDocument" AS doc'));
    expect(pageQuery!.sql).not.toContain('ts_rank(');
    expect(pageQuery!.sql).toContain(`coalesce("postedAt", "firstSeenAt")`);
  });
});

describe('createPrismaCatalogueStore - facets', () => {
  it('groups JSONB fields in one pass, explodes skills, accumulates recency, and sorts counts', async () => {
    const { client, queries } = captureClient(
      [],
      0,
      [
        { grp: 'workMode', value: 'remote', count: 2 },
        { grp: 'workMode', value: 'hybrid', count: 2 },
        { grp: 'region', value: 'us', count: 3 },
        // GROUPING SETS emits NULL for "not in this group"; it is not a facet key.
        { grp: 'region', value: null, count: 99 },
        // Smallest matching bucket per row; shapeFacets makes these cumulative.
        { grp: 'postedWithin', value: '3', count: 2 },
        { grp: 'postedWithin', value: '7', count: 1 },
      ],
      [{ grp: 'skill', value: 'react', count: 1 }],
    );
    const store = createPrismaCatalogueStore(client);

    const facets = await store.facets(plan({ q: 'engineer' }));

    expect(facets.workMode).toEqual({ hybrid: 2, remote: 2 });
    expect(facets.region).toEqual({ us: 3 });
    expect(facets.skills).toEqual({ react: 1 });
    expect(facets.postedWithin).toEqual({ '3': 2, '7': 3, '14': 3, '30': 3 });
    expect(facets.seniority).toEqual({});

    const facetQuery = queries.find((query) => query.sql.includes('GROUPING SETS'));
    expect(facetQuery).toBeDefined();
    // One grouping pass, not seven UNION branches over the same CTE.
    expect(facetQuery!.sql).not.toContain('WITH filtered AS');
    expect(facetQuery!.sql).not.toContain('UNION ALL');
    expect(facetQuery!.sql).toContain('GROUP BY GROUPING SETS');
    expect(facetQuery!.sql).toContain(`coalesce("postedAt", "firstSeenAt")`);
    expect(facetQuery!.sql).toContain('websearch_to_tsquery');
    expect(facetQuery!.values).toEqual([
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
      'engineer',
    ]);

    const skillQuery = queries.find((query) => query.sql.includes('jsonb_array_elements_text'));
    expect(skillQuery).toBeDefined();
    expect(skillQuery!.sql).not.toContain('WITH filtered AS');
    expect(skillQuery!.sql).not.toContain('UNION ALL');
    expect(skillQuery!.values).toEqual(['engineer']);
  });
});
describe('createPrismaCatalogueStore - unfiltered facet cache', () => {
  function cacheClient(): {
    client: CatalogueSqlClient;
    queryRaw: ReturnType<typeof vi.fn>;
    appSetting: {
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
    };
  } {
    const queryRaw = vi.fn((query: Prisma.Sql) => {
      if (query.sql.includes('GROUPING SETS')) {
        return Promise.resolve([
          { grp: 'region', value: 'us', count: 3 },
          { grp: 'postedWithin', value: '1', count: 2 },
        ]);
      }
      if (query.sql.includes('jsonb_array_elements_text')) {
        return Promise.resolve([{ grp: 'skill', value: 'react', count: 1 }]);
      }
      return Promise.resolve([]);
    });
    const cache = new Map<string, { value: string; updatedAt: Date }>();
    const appSetting = {
      findUnique: vi.fn(async (args: any) => cache.get(args.where.key) ?? null),
      upsert: vi.fn(async (args: any) => {
        const row = {
          value: args.update?.value ?? args.create.value,
          updatedAt: NOW,
        };
        cache.set(args.where.key, row);
        return row;
      }),
    };
    return {
      client: { $queryRaw: queryRaw, appSetting } as unknown as CatalogueSqlClient,
      queryRaw,
      appSetting,
    };
  }

  it('serves the same payload from cache for an unfiltered request', async () => {
    const { client, queryRaw } = cacheClient();
    const store = createPrismaCatalogueStore(client);

    const live = await store.facets(plan());
    const callsAfterLive = queryRaw.mock.calls.length;
    const cached = await store.facets(plan());

    expect(cached).toEqual(live);
    expect(queryRaw.mock.calls.length).toBe(callsAfterLive);
  });

  it('does not touch the cache for a filtered request', async () => {
    const { client, appSetting } = cacheClient();
    const store = createPrismaCatalogueStore(client);

    await store.facets(plan({ workMode: ['remote'] }));

    expect(appSetting.findUnique).not.toHaveBeenCalled();
    expect(appSetting.upsert).not.toHaveBeenCalled();
  });
});

describe('createPrismaCatalogueStore - ghost aggregate', () => {
  it('aggregate rows reach computeGhost (repost/lastVerified)', async () => {
    const doc = buildSearchDocument({ id: 'job-1', title: 'Engineer', company: 'Acme', description: 'x' });
    const queryRaw = vi.fn((query: any) => {
      if (query.sql.includes('count(*)::int AS count')) return Promise.resolve([{ count: 1 }]);
      if (query.sql.includes('searchDocument" AS doc')) {
        return Promise.resolve([{ id: 'job-1', canonicalKey: null, doc }]);
      }
      if (query.sql.includes('GROUP BY 1')) {
        return Promise.resolve([
          {
            groupKey: 'job-1',
            repostCount: 3,
            sourceCount: 2,
            firstSeenAt: NOW.toISOString(),
            lastVerifiedAt: NOW.toISOString(),
            postedAt: NOW.toISOString(),
          },
        ]);
      }
      return Promise.resolve([]);
    });
    const client = { $queryRaw: queryRaw } as unknown as CatalogueSqlClient;
    const store = createPrismaCatalogueStore(client);

    const result = await store.page(plan({ limit: 1 }));

    expect(result.rows[0].ghost).toEqual({
      level: 'watch',
      evidence: ['reposted 3 times across 2 sources'],
    });
  });

  it('a throwing aggregate still returns clear ghosts', async () => {
    const doc = buildSearchDocument({ id: 'job-1', title: 'Engineer', company: 'Acme', description: 'x' });
    const queryRaw = vi.fn((query: any) => {
      if (query.sql.includes('count(*)::int AS count')) return Promise.resolve([{ count: 1 }]);
      if (query.sql.includes('searchDocument" AS doc')) {
        return Promise.resolve([{ id: 'job-1', canonicalKey: null, doc }]);
      }
      if (query.sql.includes('GROUP BY 1')) {
        throw new Error('aggregate boom');
      }
      return Promise.resolve([]);
    });
    const client = { $queryRaw: queryRaw } as unknown as CatalogueSqlClient;
    const store = createPrismaCatalogueStore(client);

    const result = await store.page(plan({ limit: 1 }));

    expect(result.rows[0].ghost).toEqual({ level: 'clear', evidence: [] });
  });
});
