// Admin observability routes (Wave 13, T860) - THIN router.
//
// All six routes are read-only GETs returning the `{ generatedAt, data }`
// envelope. This router is mounted from `routes/admin.ts` AFTER its
// `router.use(requireAuth, requireAdmin)` gate, so every route here inherits
// the existing gate - NO second gate, no new middleware, no new permission
// model, no new persistence. All projection logic lives in
// `admin/observability.ts` (pure builders); this file only does I/O.
import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { handleApiError } from '../shared/errors.js';
import { listRuns } from '../jobSources/discoveryRuns.js';
import { REGISTRY_FAILURE_STATUSES } from './registry.js';
import {
  envelope,
  parseLimit,
  buildProvidersData,
  buildRunsData,
  buildRegistryData,
  buildSourcesData,
  buildCostsData,
  buildFailuresData,
  projectRegistryPage,
  runUnitFailures,
  iso,
  OBS_PROVIDERS_DEFAULT_LIMIT,
  OBS_PROVIDERS_MAX_LIMIT,
  OBS_RUNS_DEFAULT_LIMIT,
  OBS_RUNS_MAX_LIMIT,
  OBS_SOURCES_DEFAULT_LIMIT,
  OBS_SOURCES_MAX_LIMIT,
  OBS_REGISTRY_FAILURES_DEFAULT_LIMIT,
  OBS_REGISTRY_FAILURES_MAX_LIMIT,
  OBS_COSTS_DEFAULT_LIMIT,
  OBS_COSTS_MAX_LIMIT,
  OBS_FAILURES_DEFAULT_LIMIT,
  OBS_FAILURES_MAX_LIMIT,
  OBS_KEYS_MAX_SCAN,
  type FailureItem,
  type UserBoardHealthInput,
  type KeyPresenceInput,
} from '../admin/observability.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /providers - every descriptor from the wave-1 registry. Bounded by the
// registry itself; the limit only windows the (small, fixed-size) list.
// ---------------------------------------------------------------------------

router.get('/providers', (req: Request, res: Response) => {
  try {
    const { limit, error } = parseLimit(
      req.query.limit,
      OBS_PROVIDERS_DEFAULT_LIMIT,
      OBS_PROVIDERS_MAX_LIMIT,
    );
    if (error) {
      res.status(400).json({ error });
      return;
    }
    res.json(envelope(buildProvidersData(limit)));
  } catch (err) {
    handleApiError(err, res);
  }
});

// ---------------------------------------------------------------------------
// GET /registry - aggregates wave-8's registry health. Counts use
// count/groupBy only; the failures list is a bounded findMany with an
// explicit allow-list select (boardToken is never selected).
// ---------------------------------------------------------------------------

const REGISTRY_PAGE_OBS_SELECT = {
  id: true,
  url: true,
  host: true,
  provider: true,
  tier: true,
  verifyStatus: true,
  lastError: true,
  lastCheckedAt: true,
  httpStatus: true,
  resultCount: true,
  failureCount: true,
  company: { select: { id: true, slug: true, name: true } },
} as const;

router.get('/registry', async (req: Request, res: Response) => {
  try {
    const { limit: failuresLimit, error } = parseLimit(
      req.query.failuresLimit,
      OBS_REGISTRY_FAILURES_DEFAULT_LIMIT,
      OBS_REGISTRY_FAILURES_MAX_LIMIT,
    );
    if (error) {
      res.status(400).json({ error: 'Invalid failuresLimit' });
      return;
    }
    const [
      companies,
      pages,
      byProviderRows,
      byTierRows,
      byStatusRows,
      active,
      inactive,
      failureRows,
    ] = await Promise.all([
      prisma.company.count(),
      prisma.companyCareerPage.count(),
      prisma.companyCareerPage.groupBy({ by: ['provider'], _count: { _all: true } }),
      prisma.companyCareerPage.groupBy({ by: ['tier'], _count: { _all: true } }),
      prisma.companyCareerPage.groupBy({ by: ['verifyStatus'], _count: { _all: true } }),
      prisma.companyCareerPage.count({ where: { isActive: true } }),
      prisma.companyCareerPage.count({ where: { isActive: false } }),
      prisma.companyCareerPage.findMany({
        where: { verifyStatus: { in: [...REGISTRY_FAILURE_STATUSES] } },
        orderBy: [{ lastCheckedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        take: failuresLimit,
        select: REGISTRY_PAGE_OBS_SELECT,
      }),
    ]);
    const byProvider: Record<string, number> = {};
    for (const row of byProviderRows) {
      byProvider[row.provider ?? 'unknown'] = row._count._all;
    }
    const byTier: Record<string, number> = {};
    for (const row of byTierRows) {
      byTier[String(row.tier)] = row._count._all;
    }
    const byVerifyStatus: Record<string, number> = {};
    for (const row of byStatusRows) {
      byVerifyStatus[row.verifyStatus] = row._count._all;
    }
    res.json(
      envelope(
        buildRegistryData(
          { companies, pages, byProvider, byTier, byVerifyStatus, active, inactive },
          failureRows.map((row) => projectRegistryPage(row)),
          failuresLimit,
        ),
      ),
    );
  } catch (err) {
    handleApiError(err, res);
  }
});

// ---------------------------------------------------------------------------
// GET /runs - recent in-memory runs (bounded by MAX_RUNS via listRuns).
// ---------------------------------------------------------------------------

router.get('/runs', (req: Request, res: Response) => {
  try {
    const { limit, error } = parseLimit(
      req.query.limit,
      OBS_RUNS_DEFAULT_LIMIT,
      OBS_RUNS_MAX_LIMIT,
    );
    if (error) {
      res.status(400).json({ error });
      return;
    }
    res.json(envelope(buildRunsData(listRuns(), limit)));
  } catch (err) {
    handleApiError(err, res);
  }
});

// ---------------------------------------------------------------------------
// GET /sources - per-source aggregates. User-board health and global
// registry health are labelled distinctly (see healthKind); key cooldowns
// report presence + rateLimitedUntil only - the apiKey column is never
// selected, so no secret value can reach the response.
// ---------------------------------------------------------------------------

router.get('/sources', async (req: Request, res: Response) => {
  try {
    const { limit, error } = parseLimit(
      req.query.limit,
      OBS_SOURCES_DEFAULT_LIMIT,
      OBS_SOURCES_MAX_LIMIT,
    );
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const [boardRows, keyRows, byProviderRows, byTierRows, byStatusRows, active, inactive] =
      await Promise.all([
        prisma.jobBoard.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: limit,
          select: {
            id: true,
            name: true,
            type: true,
            isActive: true,
            sourceHealth: {
              select: {
                status: true,
                consecutiveFailures: true,
                lastRunAt: true,
                lastSuccessAt: true,
                lastFailureAt: true,
                lastError: true,
                lastResultCount: true,
                lastLatencyMs: true,
              },
            },
          },
        }),
        prisma.aIProviderKey.findMany({
          take: OBS_KEYS_MAX_SCAN,
          select: {
            provider: true,
            isActive: true,
            lastUsedAt: true,
            rateLimitedUntil: true,
          },
        }),
        prisma.companyCareerPage.groupBy({ by: ['provider'], _count: { _all: true } }),
        prisma.companyCareerPage.groupBy({ by: ['tier'], _count: { _all: true } }),
        prisma.companyCareerPage.groupBy({ by: ['verifyStatus'], _count: { _all: true } }),
        prisma.companyCareerPage.count({ where: { isActive: true } }),
        prisma.companyCareerPage.count({ where: { isActive: false } }),
      ]);
    const boards: UserBoardHealthInput[] = boardRows.map((row) => ({
      boardId: row.id,
      boardName: row.name,
      boardType: row.type,
      isActive: row.isActive,
      status: row.sourceHealth?.status ?? 'unknown',
      consecutiveFailures: row.sourceHealth?.consecutiveFailures ?? 0,
      lastRunAt: iso(row.sourceHealth?.lastRunAt ?? null),
      lastSuccessAt: iso(row.sourceHealth?.lastSuccessAt ?? null),
      lastFailureAt: iso(row.sourceHealth?.lastFailureAt ?? null),
      lastError: row.sourceHealth?.lastError ?? null,
      lastResultCount: row.sourceHealth?.lastResultCount ?? 0,
      lastLatencyMs: row.sourceHealth?.lastLatencyMs ?? null,
    }));
    // Fold stored keys by provider: presence/count/cooldown only. Only
    // active rows count as "has key"; env-fallback keys carry no per-key
    // metadata, so presence there is reported as a boolean without values.
    const now = new Date();
    const byProvider = new Map<string, { count: number; lastUsedAt: string | null; cooldownUntil: string | null }>();
    for (const key of keyRows) {
      if (!key.isActive) continue;
      let agg = byProvider.get(key.provider);
      if (!agg) {
        agg = { count: 0, lastUsedAt: null, cooldownUntil: null };
        byProvider.set(key.provider, agg);
      }
      agg.count += 1;
      const usedAt = iso(key.lastUsedAt);
      if (usedAt !== null && (agg.lastUsedAt === null || usedAt > agg.lastUsedAt)) {
        agg.lastUsedAt = usedAt;
      }
      if (key.rateLimitedUntil !== null && key.rateLimitedUntil > now) {
        const until = iso(key.rateLimitedUntil);
        if (until !== null && (agg.cooldownUntil === null || until > agg.cooldownUntil)) {
          agg.cooldownUntil = until;
        }
      }
    }
    const keys: KeyPresenceInput[] = [...byProvider.entries()].map(([provider, agg]) => ({
      provider,
      hasKey: agg.count > 0,
      keyCount: agg.count,
      inCooldown: agg.cooldownUntil !== null,
      rateLimitedUntil: agg.cooldownUntil,
      lastUsedAt: agg.lastUsedAt,
    }));
    const regByProvider: Record<string, number> = {};
    for (const row of byProviderRows) {
      regByProvider[row.provider ?? 'unknown'] = row._count._all;
    }
    const regByTier: Record<string, number> = {};
    for (const row of byTierRows) {
      regByTier[String(row.tier)] = row._count._all;
    }
    const regByVerifyStatus: Record<string, number> = {};
    for (const row of byStatusRows) {
      regByVerifyStatus[row.verifyStatus] = row._count._all;
    }
    res.json(
      envelope(
        buildSourcesData(
          boards,
          keys,
          {
            active,
            inactive,
            byProvider: regByProvider,
            byTier: regByTier,
            byVerifyStatus: regByVerifyStatus,
          },
          limit,
        ),
      ),
    );
  } catch (err) {
    handleApiError(err, res);
  }
});

// ---------------------------------------------------------------------------
// GET /costs - AI aggregates from the wave-9 per-run estimate on the run
// snapshot. Nothing is persisted; no-data (no estimate in memory) reports
// hasData:false rather than a zero that would masquerade as measured.
// ---------------------------------------------------------------------------

router.get('/costs', (req: Request, res: Response) => {
  try {
    const { limit, error } = parseLimit(
      req.query.limit,
      OBS_COSTS_DEFAULT_LIMIT,
      OBS_COSTS_MAX_LIMIT,
    );
    if (error) {
      res.status(400).json({ error });
      return;
    }
    res.json(envelope(buildCostsData(listRuns(), limit)));
  } catch (err) {
    handleApiError(err, res);
  }
});

// ---------------------------------------------------------------------------
// GET /failures - bounded, newest-first feed: failed run units, registry
// lastError rows, and key rate-limit events. Read-only: viewing never
// increments any failure count.
// ---------------------------------------------------------------------------

async function fetchRegistryFailureItems(take: number): Promise<FailureItem[]> {
  const rows = await prisma.companyCareerPage.findMany({
    where: { verifyStatus: { in: [...REGISTRY_FAILURE_STATUSES] } },
    orderBy: [{ lastCheckedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    take,
    select: REGISTRY_PAGE_OBS_SELECT,
  });
  return rows.map((row) => ({
    kind: 'registry-page' as const,
    reason: row.lastError ?? row.verifyStatus,
    at: iso(row.lastCheckedAt),
    runId: null,
    boardId: null,
    boardName: null,
    boardType: null,
    pageId: row.id,
    pageUrl: row.url,
    provider: row.provider,
  }));
}

async function fetchRateLimitItems(): Promise<FailureItem[]> {
  const now = new Date();
  const keys = await prisma.aIProviderKey.findMany({
    take: OBS_KEYS_MAX_SCAN,
    select: { provider: true, isActive: true, rateLimitedUntil: true },
  });
  const latest = new Map<string, string>();
  for (const key of keys) {
    if (!key.isActive || key.rateLimitedUntil === null || key.rateLimitedUntil <= now) {
      continue;
    }
    const until = iso(key.rateLimitedUntil);
    if (until === null) continue;
    const prev = latest.get(key.provider);
    if (prev === undefined || until > prev) latest.set(key.provider, until);
  }
  return [...latest.entries()].map(([provider, until]) => ({
    kind: 'rate-limit' as const,
    reason: `provider key in cooldown until ${until}`,
    at: until,
    runId: null,
    boardId: null,
    boardName: null,
    boardType: null,
    pageId: null,
    pageUrl: null,
    provider,
  }));
}

router.get('/failures', async (req: Request, res: Response) => {
  try {
    const { limit, error } = parseLimit(
      req.query.limit,
      OBS_FAILURES_DEFAULT_LIMIT,
      OBS_FAILURES_MAX_LIMIT,
    );
    if (error) {
      res.status(400).json({ error });
      return;
    }
    const [registryItems, rateLimitItems] = await Promise.all([
      fetchRegistryFailureItems(limit),
      fetchRateLimitItems(),
    ]);
    const items: FailureItem[] = [
      ...runUnitFailures(listRuns()),
      ...registryItems,
      ...rateLimitItems,
    ];
    res.json(envelope(buildFailuresData(items, limit)));
  } catch (err) {
    handleApiError(err, res);
  }
});

export default router;
