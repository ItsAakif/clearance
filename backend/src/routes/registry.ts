// Company / career-page registry read surface + on-demand crawl trigger
// (Wave 2 stats/pages; Wave 8 health/crawl. ADR-026 / ADR-030).
//
// Singleton-admin only: every route on this router sits behind requireAuth +
// requireAdmin. There is intentionally NO public or unauthenticated registry
// route. The registry is global, read-mostly data (no userId, no ownership
// checks); only counts/aggregates and bounded lists are exposed here. No
// response carries secrets - the page rows contain no credentials by
// construction, and lastError audit text names providers and page URLs only.
//
// Consumed by wave 8's crawler (the /pages work queue) and wave 13's admin UI.
import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { handleApiError } from '../shared/errors.js';
import { crawlBatch, CRAWL_BATCH_SIZE } from '../registry/crawler.js';
import { REGISTRY_FAILURE_STATUSES } from '../registry/verifyStatus.js';

const router = Router();

router.use(requireAuth, requireAdmin);

// Wave-13 bounded-list constraint applies from here on: every list endpoint
// takes an explicit limit with a documented default and maximum.
export const REGISTRY_PAGES_DEFAULT_LIMIT = 50;
export const REGISTRY_PAGES_MAX_LIMIT = 200;

// A null provider means the ATS host was unknown at import time (stored with
// tier 3, never dropped). It is surfaced under this label in stats so the
// aggregate map has no null key.
export const REGISTRY_UNKNOWN_PROVIDER = 'unknown';

// GET /api/registry/stats - aggregate counts only. Uses count/groupBy so a
// very large registry never materialises rows for this view.
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const [companies, pages, byProviderRows, byTierRows, byStatusRows] =
      await Promise.all([
        prisma.company.count(),
        prisma.companyCareerPage.count(),
        prisma.companyCareerPage.groupBy({
          by: ['provider'],
          _count: { _all: true },
        }),
        prisma.companyCareerPage.groupBy({
          by: ['tier'],
          _count: { _all: true },
        }),
        prisma.companyCareerPage.groupBy({
          by: ['verifyStatus'],
          _count: { _all: true },
        }),
      ]);

    const byProvider: Record<string, number> = {};
    for (const row of byProviderRows) {
      byProvider[row.provider ?? REGISTRY_UNKNOWN_PROVIDER] = row._count._all;
    }
    const byTier: Record<string, number> = {};
    for (const row of byTierRows) {
      byTier[String(row.tier)] = row._count._all;
    }
    const byVerifyStatus: Record<string, number> = {};
    for (const row of byStatusRows) {
      byVerifyStatus[row.verifyStatus] = row._count._all;
    }

    res.json({ companies, pages, byProvider, byTier, byVerifyStatus });
  } catch (error) {
    handleApiError(error, res);
  }
});

function parsePagesQuery(query: Request['query']): {
  where: Record<string, unknown>;
  limit: number;
  offset: number;
  error?: string;
} {
  const where: Record<string, unknown> = {};

  if (query.provider !== undefined) {
    const provider = String(query.provider);
    if (provider.length === 0 || provider.length > 100) {
      return { where, limit: 0, offset: 0, error: 'Invalid provider filter' };
    }
    where.provider = provider === REGISTRY_UNKNOWN_PROVIDER ? null : provider;
  }

  if (query.tier !== undefined) {
    const tier = Number(query.tier);
    if (!Number.isInteger(tier) || tier < 1) {
      return { where, limit: 0, offset: 0, error: 'Invalid tier filter' };
    }
    where.tier = tier;
  }

  if (query.verifyStatus !== undefined) {
    const verifyStatus = String(query.verifyStatus);
    if (verifyStatus.length === 0 || verifyStatus.length > 50) {
      return { where, limit: 0, offset: 0, error: 'Invalid verifyStatus filter' };
    }
    where.verifyStatus = verifyStatus;
  }

  if (query.isActive !== undefined) {
    const raw = String(query.isActive);
    if (raw !== 'true' && raw !== 'false') {
      return { where, limit: 0, offset: 0, error: 'Invalid isActive filter' };
    }
    where.isActive = raw === 'true';
  }

  let limit = REGISTRY_PAGES_DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    const parsed = Number(query.limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { where, limit: 0, offset: 0, error: 'Invalid limit' };
    }
    limit = Math.min(parsed, REGISTRY_PAGES_MAX_LIMIT);
  }

  let offset = 0;
  if (query.offset !== undefined) {
    const parsed = Number(query.offset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { where, limit: 0, offset: 0, error: 'Invalid offset' };
    }
    offset = parsed;
  }

  return { where, limit, offset };
}

// GET /api/registry/pages - the crawler work queue and the admin view.
// Filterable by provider/tier/verifyStatus/isActive; paginated with
// limit (default 50, max 200) + offset. Deterministic order: nextCheckAt
// ascending (nulls first under Postgres ASC - never-scheduled pages sort
// first, which is what the crawler wants) with id as the stable tie-break,
// so the queue is reproducible across runs.
router.get('/pages', async (req: Request, res: Response) => {
  try {
    const { where, limit, offset, error } = parsePagesQuery(req.query);
    if (error) {
      res.status(400).json({ error });
      return;
    }

    const [total, pages] = await Promise.all([
      prisma.companyCareerPage.count({ where }),
      prisma.companyCareerPage.findMany({
        where,
        orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
        take: limit,
        skip: offset,
        include: { company: { select: { id: true, slug: true, name: true } } },
      }),
    ]);

    res.json({ pages, total, limit, offset });
  } catch (err) {
    handleApiError(err, res);
  }
});

// ---------------------------------------------------------------------------
// Health surface (Wave 8, T761).
//
// GET /api/registry/health - aggregate counts plus three bounded lists:
// - due: the N oldest due pages (next to be checked), nextCheckAt ascending
//   (nulls first under Postgres ASC - never-scheduled pages sort first) with
//   id as the stable tie-break, mirroring the /pages work-queue order;
// - recentFailures: the N most recently checked failure pages
//   (verifyStatus blocked/http_error/timeout/invalid), lastCheckedAt newest
//   first (nulls last - a failure always carries a check time) with id as
//   the stable tie-break, each carrying its lastError message;
// - suspects: the N most recently checked pages whose lastError audit text
//   carries the T760 SUSPECT marker (an `ok` page whose resultCount
//   collapsed). Suspects are DERIVED from the marker the crawler's write-back
//   already records - no new column, no schema change; if the marker is
//   absent the list is simply empty.
// Counts use count/groupBy aggregates only - rows are never fetched to count
// them. Every list is bounded: each takes an explicit limit query param with
// the documented default and maximum below (over-large values are CLAMPED to
// the maximum, following the /pages convention; invalid values are 400).
// ---------------------------------------------------------------------------

export const REGISTRY_HEALTH_DEFAULT_LIMIT = 20;
export const REGISTRY_HEALTH_MAX_LIMIT = 100;

/** verifyStatus values that count as a failure for the recent-failures list.
 *  Re-exported from the canonical registry/verifyStatus module (T903) so the
 *  routes layer does not own its own copy of the vocabulary - the
 *  routes -> domain import inversion is gone and the constant lives in
 *  exactly one place. Value and order are frozen by registry.test.ts:483. */
export { REGISTRY_FAILURE_STATUSES };

/** Audit-text marker the crawler write-back records on a suspect drop (T760). */
export const REGISTRY_SUSPECT_MARKER = 'SUSPECT';

function parseHealthLimit(raw: unknown): { limit: number; error: boolean } {
  if (raw === undefined) {
    return { limit: REGISTRY_HEALTH_DEFAULT_LIMIT, error: false };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { limit: 0, error: true };
  }
  return { limit: Math.min(parsed, REGISTRY_HEALTH_MAX_LIMIT), error: false };
}

const REGISTRY_HEALTH_COMPANY_SELECT = { id: true, slug: true, name: true } as const;

router.get('/health', async (req: Request, res: Response) => {
  try {
    const dueLimit = parseHealthLimit(req.query.dueLimit);
    if (dueLimit.error) {
      res.status(400).json({ error: 'Invalid dueLimit' });
      return;
    }
    const failuresLimit = parseHealthLimit(req.query.failuresLimit);
    if (failuresLimit.error) {
      res.status(400).json({ error: 'Invalid failuresLimit' });
      return;
    }
    const suspectsLimit = parseHealthLimit(req.query.suspectsLimit);
    if (suspectsLimit.error) {
      res.status(400).json({ error: 'Invalid suspectsLimit' });
      return;
    }

    const now = new Date();
    const [
      byProviderRows,
      byTierRows,
      byStatusRows,
      active,
      inactive,
      due,
      recentFailures,
      suspects,
    ] = await Promise.all([
      prisma.companyCareerPage.groupBy({
        by: ['provider'],
        _count: { _all: true },
      }),
      prisma.companyCareerPage.groupBy({
        by: ['tier'],
        _count: { _all: true },
      }),
      prisma.companyCareerPage.groupBy({
        by: ['verifyStatus'],
        _count: { _all: true },
      }),
      prisma.companyCareerPage.count({ where: { isActive: true } }),
      prisma.companyCareerPage.count({ where: { isActive: false } }),
      prisma.companyCareerPage.findMany({
        where: {
          isActive: true,
          OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
        },
        orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
        take: dueLimit.limit,
        include: { company: { select: REGISTRY_HEALTH_COMPANY_SELECT } },
      }),
      prisma.companyCareerPage.findMany({
        where: { verifyStatus: { in: [...REGISTRY_FAILURE_STATUSES] } },
        orderBy: [{ lastCheckedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        take: failuresLimit.limit,
        include: { company: { select: REGISTRY_HEALTH_COMPANY_SELECT } },
      }),
      prisma.companyCareerPage.findMany({
        where: { lastError: { contains: REGISTRY_SUSPECT_MARKER } },
        orderBy: [{ lastCheckedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        take: suspectsLimit.limit,
        include: { company: { select: REGISTRY_HEALTH_COMPANY_SELECT } },
      }),
    ]);

    const byProvider: Record<string, number> = {};
    for (const row of byProviderRows) {
      byProvider[row.provider ?? REGISTRY_UNKNOWN_PROVIDER] = row._count._all;
    }
    const byTier: Record<string, number> = {};
    for (const row of byTierRows) {
      byTier[String(row.tier)] = row._count._all;
    }
    const byVerifyStatus: Record<string, number> = {};
    for (const row of byStatusRows) {
      byVerifyStatus[row.verifyStatus] = row._count._all;
    }

    res.json({
      byProvider,
      byTier,
      byVerifyStatus,
      active,
      inactive,
      due,
      dueLimit: dueLimit.limit,
      recentFailures,
      failuresLimit: failuresLimit.limit,
      suspects,
      suspectsLimit: suspectsLimit.limit,
    });
  } catch (err) {
    handleApiError(err, res);
  }
});

// ---------------------------------------------------------------------------
// On-demand crawl trigger (Wave 8, T761).
//
// POST /api/registry/crawl - takes a bounded `limit` in the JSON body
// (default CRAWL_BATCH_SIZE when omitted), runs crawlBatch(limit, { now })
// once inside this request, and returns a run-style summary: the effective
// limit, attempted count, per-status counts, wall-clock latency, the provider
// corrections the transports observed, and the skipped-with-reason list.
//
// OVER-CAP POLICY (chosen: CLAMP, documented and tested): a `limit` greater
// than CRAWL_BATCH_SIZE is clamped down to CRAWL_BATCH_SIZE - never rejected,
// never widened. This mirrors crawlBatch's own clamp, so the route and the
// crawler agree; the response echoes both `requestedLimit` and the effective
// `limit` so the clamp is always visible. No scheduler, no background work:
// `now` is the request time and is the ONLY policy time; latencyMs is a
// wall-clock measurement, never a policy input.
//
// SCOPE OF WRITES: the crawl trigger is the ONLY mutating route on this
// router. It writes registry verification fields (via crawlBatch) and
// nothing else - in particular it never writes JobSourceHealth (asserted).
// ---------------------------------------------------------------------------

router.post('/crawl', async (req: Request, res: Response) => {
  try {
    let requestedLimit = CRAWL_BATCH_SIZE;
    const rawLimit: unknown = req.body?.limit;
    if (rawLimit !== undefined) {
      if (typeof rawLimit !== 'number' && typeof rawLimit !== 'string') {
        res.status(400).json({ error: 'Invalid limit' });
        return;
      }
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ error: 'Invalid limit' });
        return;
      }
      requestedLimit = parsed;
    }
    const limit = Math.min(requestedLimit, CRAWL_BATCH_SIZE);

    const now = new Date();
    const started = Date.now();
    const outcomes = await crawlBatch(limit, { now });
    const latencyMs = Date.now() - started;

    const byStatus: Record<string, number> = {};
    for (const outcome of outcomes) {
      byStatus[outcome.status] = (byStatus[outcome.status] ?? 0) + 1;
    }
    // Transports report an observed redirect landing on a different host via
    // observedProvider/observedBoardToken; the write-back persists the
    // correction when the host is a known ATS host (previous value retained
    // in the lastError audit text). Listed here so the run shows what moved.
    const providerCorrections = outcomes
      .filter((outcome) => outcome.observedProvider != null)
      .map((outcome) => ({
        pageId: outcome.pageId,
        observedProvider: outcome.observedProvider,
        observedBoardToken: outcome.observedBoardToken ?? null,
      }));
    const skipped = outcomes
      .filter((outcome) => outcome.status === 'skipped')
      .map((outcome) => ({ pageId: outcome.pageId, reason: outcome.error ?? 'skipped' }));

    res.json({
      requestedLimit,
      limit,
      attempted: outcomes.length,
      byStatus,
      latencyMs,
      providerCorrections,
      skipped,
    });
  } catch (err) {
    handleApiError(err, res);
  }
});

export default router;
