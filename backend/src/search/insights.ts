// Catalogue insights: measured rollups only (no model, no estimates).

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';

export type InsightsClient = Pick<PrismaClient, '$queryRaw'>;

export interface CatalogueInsights {
  totalOpen: number;
  postedLast30: number;
  topSkills: { skill: string; count: number }[];
  workMode: { mode: 'remote' | 'hybrid'; count: number }[];
  seniority: { level: string; count: number }[];
  salaryByRegion: { region: string; currency: string; median: number; count: number }[];
  topCompanies: { company: string; count: number }[];
  workModeStated: number;
  seniorityStated: number;
  updatedAt: string;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value && typeof value === 'object' && 'toNumber' in (value as any)) {
    return Number((value as any).toNumber());
  }
  return Number(value);
}

export async function getCatalogueInsights(
  client: InsightsClient,
  now: Date = new Date(),
): Promise<CatalogueInsights> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [totalRows, postedRows, skillRows, workModeRows, seniorityRows, salaryRows, companyRows] =
    await Promise.all([
      client.$queryRaw<Array<{ count: number }>>(
        Prisma.sql`SELECT count(*)::int AS count FROM "JobListing" WHERE "isActive" = true`,
      ),
      client.$queryRaw<Array<{ count: number }>>(
        Prisma.sql`SELECT count(*)::int AS count FROM "JobListing" WHERE "isActive" = true AND coalesce("postedAt", "firstSeenAt") >= ${cutoff}::timestamptz`,
      ),
      client.$queryRaw<Array<{ skill: string; count: number }>>(
        Prisma.sql`SELECT s.skill AS skill, count(*)::int AS count FROM "JobListing", jsonb_array_elements_text(coalesce("searchDocument"->'skills', '[]'::jsonb)) AS s(skill) WHERE "isActive" = true GROUP BY s.skill ORDER BY count(*) DESC, s.skill ASC LIMIT 12`,
      ),
      client.$queryRaw<Array<{ mode: string | null; count: number }>>(
        Prisma.sql`SELECT "searchDocument"->>'workMode' AS mode, count(*)::int AS count FROM "JobListing" WHERE "isActive" = true AND "searchDocument"->>'workMode' IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC, 1 ASC`,
      ),
      client.$queryRaw<Array<{ level: string; count: number }>>(
        Prisma.sql`SELECT "searchDocument"->>'seniority' AS level, count(*)::int AS count FROM "JobListing" WHERE "isActive" = true AND "searchDocument"->>'seniority' IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC, 1 ASC`,
      ),
      client.$queryRaw<Array<{ region: string; currency: string; median: any; count: number }>>(
        Prisma.sql`SELECT region, currency, percentile_cont(0.5) WITHIN GROUP (ORDER BY salary_value) AS median, count(*)::int AS count FROM ( SELECT "searchDocument"->>'region' AS region, "searchDocument"->'salary'->>'currency' AS currency, ("searchDocument"->'salary'->>'max')::numeric AS salary_value FROM "JobListing" WHERE "isActive" = true AND "searchDocument"->>'region' IS NOT NULL AND jsonb_typeof("searchDocument"->'salary') = 'object' AND jsonb_typeof("searchDocument"->'salary'->'min') = 'number' AND jsonb_typeof("searchDocument"->'salary'->'max') = 'number' AND "searchDocument"->'salary'->>'currency' IS NOT NULL AND (("searchDocument"->'salary'->>'max')::numeric) > 0 AND (("searchDocument"->'salary'->>'min')::numeric) > 0 AND (("searchDocument"->'salary'->>'max')::numeric) >= (("searchDocument"->'salary'->>'min')::numeric) ) t GROUP BY region, currency HAVING count(*) >= 5 ORDER BY region ASC, currency ASC`,
      ),
      client.$queryRaw<Array<{ company: string; count: number }>>(
        Prisma.sql`SELECT coalesce("searchDocument"->>'company', "company") AS company, count(*)::int AS count FROM "JobListing" WHERE "isActive" = true GROUP BY 1 ORDER BY count(*) DESC, 1 ASC LIMIT 10`,
      ),
    ]);

  const topSkills = (skillRows ?? []).map((r) => ({
    skill: String(r.skill),
    count: toNumber(r.count),
  }));

  const workMode = (workModeRows ?? [])
    .filter((r) => r.mode === 'remote' || r.mode === 'hybrid')
    .map((r) => ({
      mode: r.mode as 'remote' | 'hybrid',
      count: toNumber(r.count),
    }));

  const seniority = (seniorityRows ?? []).map((r) => ({
    level: String(r.level),
    count: toNumber(r.count),
  }));

  const salaryByRegion = (salaryRows ?? [])
    .map((r) => ({
      region: String(r.region),
      currency: String(r.currency),
      median: toNumber(r.median),
      count: toNumber(r.count),
    }))
    .filter((r) => {
      if (r.currency === null || r.currency === '' || r.currency === 'null') return false;
      if (!Number.isFinite(r.median) || r.median <= 0) return false;
      if (r.count < 5) return false;
      return true;
    });

  const topCompanies = (companyRows ?? [])
    .filter((r) => r.company && String(r.company).trim().length > 0)
    .map((r) => ({
      company: String(r.company),
      count: toNumber(r.count),
    }));

  const workModeStated = (workModeRows ?? []).reduce((sum, r) => sum + toNumber(r.count), 0);
  const seniorityStated = seniority.reduce((sum, r) => sum + r.count, 0);

  return {
    totalOpen: toNumber(totalRows?.[0]?.count ?? 0),
    postedLast30: toNumber(postedRows?.[0]?.count ?? 0),
    topSkills,
    workMode,
    seniority,
    salaryByRegion,
    topCompanies,
    workModeStated,
    seniorityStated,
    updatedAt: now.toISOString(),
  };
}
