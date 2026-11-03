import { describe, expect, it, vi } from 'vitest';
import { getCatalogueInsights, type InsightsClient } from './insights.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');

function makeClient(overrides: Record<string, unknown[]> = {}): InsightsClient {
  const q = vi.fn((query: any) => {
    const sql = String(query.sql);
    if (sql.includes('jsonb_array_elements_text')) return Promise.resolve(overrides.skills ?? []);
    if (sql.includes('"searchDocument"->>\'workMode\'')) return Promise.resolve(overrides.workMode ?? []);
    if (sql.includes('"searchDocument"->>\'seniority\'')) return Promise.resolve(overrides.seniority ?? []);
    if (sql.includes('percentile_cont')) return Promise.resolve(overrides.salary ?? []);
    if (sql.includes('coalesce("searchDocument"->>\'company\'')) return Promise.resolve(overrides.companies ?? []);
    if (sql.includes('postedAt", "firstSeenAt"') || sql.includes('coalesce("postedAt"')) return Promise.resolve(overrides.posted ?? [{ count: 0 }]);
    if (sql.includes('count(*)::int AS count FROM "JobListing" WHERE "isActive" = true')) return Promise.resolve(overrides.total ?? [{ count: 0 }]);
    return Promise.resolve([]);
  });
  return { $queryRaw: q } as unknown as InsightsClient;
}

describe('getCatalogueInsights', () => {
  it('drops bad salary rows and keeps valid us/USD/180000/207', async () => {
    const client = makeClient({
      total: [{ count: 1812 }],
      posted: [{ count: 52 }],
      salary: [
        { region: 'us', currency: null, median: 100, count: 10 },
        { region: 'us', currency: 'null', median: 100, count: 10 },
        { region: 'us', currency: '', median: 100, count: 10 },
        { region: 'us', currency: 'USD', median: 0, count: 10 },
        { region: 'us', currency: 'USD', median: 100, count: 4 },
        { region: 'us', currency: 'USD', median: 180000, count: 207 },
      ],
      workMode: [{ mode: 'remote', count: 248 }, { mode: 'hybrid', count: 62 }],
      seniority: [{ level: 'lead', count: 724 }],
    });

    const result = await getCatalogueInsights(client, NOW);

    expect(result.salaryByRegion).toEqual([
      { region: 'us', currency: 'USD', median: 180000, count: 207 },
    ]);
    expect(result.workMode).toEqual([
      { mode: 'remote', count: 248 },
      { mode: 'hybrid', count: 62 },
    ]);
    expect(result.workModeStated).toBe(310);
    expect(result.seniorityStated).toBe(724);
  });

  it('workMode has no null bucket', async () => {
    const client = makeClient({
      total: [{ count: 10 }],
      workMode: [{ mode: 'remote', count: 5 }],
    });
    const result = await getCatalogueInsights(client, NOW);
    expect(result.workMode.every((w) => w.mode === 'remote' || w.mode === 'hybrid')).toBe(true);
  });

  it('empty catalogue returns empty arrays', async () => {
    const client = makeClient({});
    const result = await getCatalogueInsights(client, NOW);
    expect(result.totalOpen).toBe(0);
    expect(result.topSkills).toEqual([]);
    expect(result.workMode).toEqual([]);
    expect(result.seniority).toEqual([]);
    expect(result.salaryByRegion).toEqual([]);
    expect(result.topCompanies).toEqual([]);
    expect(result.workModeStated).toBe(0);
    expect(result.seniorityStated).toBe(0);
  });

  it('ignores malformed string salary values instead of throwing', async () => {
    // A stored salary like {"min":"100k","max":"120k","currency":"USD"} has
    // string bounds, so jsonb_typeof(...->'min'/'max') = 'number' is false and
    // the row must be filtered out before the ::numeric casts (otherwise the
    // endpoint 500s). Simulate Postgres: throw unless both guards are present.
    const calls: string[] = [];
    const q = vi.fn((query: any) => {
      const sql = String(query.sql);
      calls.push(sql);
      if (sql.includes('percentile_cont')) {
        if (
          !sql.includes("jsonb_typeof(\"searchDocument\"->'salary'->'min') = 'number'") ||
          !sql.includes("jsonb_typeof(\"searchDocument\"->'salary'->'max') = 'number'")
        ) {
          return Promise.reject(new Error('invalid input syntax for type numeric'));
        }
        return Promise.resolve([]);
      }
      if (sql.includes('jsonb_array_elements_text')) return Promise.resolve([]);
      if (sql.includes('"searchDocument"->>\'workMode\'')) return Promise.resolve([]);
      if (sql.includes('"searchDocument"->>\'seniority\'')) return Promise.resolve([]);
      if (sql.includes('coalesce("searchDocument"->>\'company\'')) return Promise.resolve([]);
      if (sql.includes('postedAt", "firstSeenAt"') || sql.includes('coalesce("postedAt"')) return Promise.resolve([{ count: 0 }]);
      if (sql.includes('count(*)::int AS count FROM "JobListing" WHERE "isActive" = true')) return Promise.resolve([{ count: 0 }]);
      return Promise.resolve([]);
    });
    const client = { $queryRaw: q } as unknown as InsightsClient;
    await expect(getCatalogueInsights(client, NOW)).resolves.toBeDefined();
    const salarySql = calls.find((s) => s.includes('percentile_cont'))!;
    expect(salarySql).toContain("jsonb_typeof(\"searchDocument\"->'salary'->'min') = 'number'");
    expect(salarySql).toContain("jsonb_typeof(\"searchDocument\"->'salary'->'max') = 'number'");
  });
});