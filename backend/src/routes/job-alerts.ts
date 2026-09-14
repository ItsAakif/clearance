// Job Alert routes - per-user alert management

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, createJobAlertSchema, updateJobAlertSchema } from '../shared/validation.js';
import { runSource, boardToConfig, type JobSourceConfig } from '../jobSources/index.js';
import { recordSourceSuccess, recordSourceFailure } from '../jobSources/sourceHealth.js';
import { dedupeJobs, withDeterministicExternalId } from '../jobSources/jobIdentity.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const alerts = await prisma.jobAlert.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(alerts);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(createJobAlertSchema, req.body);

    if (body.savedSearchId) {
      const search = await prisma.savedSearch.findUnique({ where: { id: body.savedSearchId } });
      if (!search) throw new NotFoundError('Saved Search');
      if (search.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    }

    const alert = await prisma.jobAlert.create({
      data: {
        userId: req.user!.id,
        name: body.name,
        query: body.query,
        location: body.location ?? null,
        sources: (body.sources ?? null) as any,
        savedSearchId: body.savedSearchId ?? null,
        minMatchScore: body.minMatchScore ?? null,
        remoteOnly: body.remoteOnly ?? false,
        isActive: body.isActive ?? true,
        notifyInApp: body.notifyInApp ?? true,
        notifyEmail: body.notifyEmail ?? false,
      },
    });

    res.status(201).json(alert);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(updateJobAlertSchema, req.body);
    const alert = await prisma.jobAlert.findUnique({ where: { id: req.params.id } });
    if (!alert) throw new NotFoundError('Job Alert');
    await ensureOwnership(req.user!.id, alert.userId, 'Job Alert');

    if (body.savedSearchId !== undefined) {
      if (body.savedSearchId) {
        const search = await prisma.savedSearch.findUnique({ where: { id: body.savedSearchId } });
        if (!search) throw new NotFoundError('Saved Search');
        if (search.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const updated = await prisma.jobAlert.update({
      where: { id: alert.id },
      data: {
        name: body.name,
        query: body.query,
        location: body.location,
        sources: body.sources as any,
        savedSearchId: body.savedSearchId,
        minMatchScore: body.minMatchScore,
        remoteOnly: body.remoteOnly,
        isActive: body.isActive,
        notifyInApp: body.notifyInApp,
        notifyEmail: body.notifyEmail,
      },
    });

    res.json(updated);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const alert = await prisma.jobAlert.findUnique({ where: { id: req.params.id } });
    if (!alert) throw new NotFoundError('Job Alert');
    await ensureOwnership(req.user!.id, alert.userId, 'Job Alert');
    await prisma.jobAlert.delete({ where: { id: alert.id } });
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/:id/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const alert = await prisma.jobAlert.findUnique({ where: { id: req.params.id } });
    if (!alert) throw new NotFoundError('Job Alert');
    await ensureOwnership(req.user!.id, alert.userId, 'Job Alert');

    let configs: JobSourceConfig[] = [];
    let sourceBoards: { id: string }[] = [];
    let query = alert.query;

    if (alert.savedSearchId) {
      const search = await prisma.savedSearch.findUnique({ where: { id: alert.savedSearchId } });
      if (!search) throw new NotFoundError('Saved Search');

      const boardIds = (search.sources as string[] | null) || undefined;
      const boards = await prisma.jobBoard.findMany({
        where: { userId: req.user!.id, isActive: true, ...(boardIds ? { id: { in: boardIds } } : {}) },
      });
      sourceBoards = boards;
      configs = boards.map((b) => ({
        ...boardToConfig(b),
        query: search.query,
        userId: req.user!.id,
      }));
      query = search.query;
    } else if (alert.sources) {
      const sourceIds = alert.sources as string[];
      const boards = await prisma.jobBoard.findMany({
        where: { userId: req.user!.id, isActive: true, id: { in: sourceIds } },
      });
      sourceBoards = boards;
      configs = boards.map((b) => ({
        ...boardToConfig(b),
        query: alert.query,
        userId: req.user!.id,
      }));
    }

    const results = dedupeJobs((await Promise.all(sourceBoards.map(async (b, i) => {
      const c = configs[i];
      const startedAt = Date.now();
      try {
        const jobs = await runSource(c);
        const latencyMs = Date.now() - startedAt;
        try {
          await recordSourceSuccess(b.id, jobs.length, latencyMs);
        } catch {
          // Health writes must never fail the request (sourceHealth also swallows errors).
        }
        return jobs;
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        try {
          await recordSourceFailure(b.id, error, latencyMs);
        } catch {
          // Health writes must never fail the request (sourceHealth also swallows errors).
        }
        return [];
      }
    }))).flat());

    const upserted = [];
    for (const job of results.slice(0, Number(req.query.limit) || 100)) {
      const withId = job.externalId ? job : withDeterministicExternalId(job);
      const rec = await prisma.jobListing.upsert({
        where: { source_externalId: { source: withId.source, externalId: withId.externalId! } },
        update: { title: withId.title, company: withId.company, location: withId.location, description: withId.description, applyUrl: withId.applyUrl, sourceUrl: withId.sourceUrl, postedAt: withId.postedAt },
        create: {
          source: withId.source, externalId: withId.externalId, sourceUrl: withId.sourceUrl, title: withId.title,
          company: withId.company, location: withId.location, description: withId.description, applyUrl: withId.applyUrl, postedAt: withId.postedAt,
        },
      });
      upserted.push(rec);
    }
    const matchCount = upserted.length;

    await prisma.jobAlert.update({
      where: { id: alert.id },
      data: { lastRunAt: new Date(), lastMatchCount: matchCount },
    });

    res.json({
      matchCount,
      results: upserted.slice(0, 50).map((j) => ({
        id: j.id, source: j.source, title: j.title, company: j.company,
        location: j.location, applyUrl: j.applyUrl, postedUrl: j.sourceUrl, postedAt: j.postedAt, isActive: j.isActive,
      })),
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
