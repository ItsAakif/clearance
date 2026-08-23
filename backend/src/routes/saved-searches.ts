// Saved Search routes (per-user).
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { validateInput } from '../shared/validation.js';
import { runSource, boardToConfig, type JobSourceConfig } from '../jobSources/index.js';
const createSchema = z.object({
  name: z.string().min(1, 'Name required').max(100),
  query: z.string().min(1).max(200),
  location: z.string().max(100).optional(),
  company: z.string().max(100).optional(),
  boards: z.array(z.string()).max(10).optional(),
});

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const searches = await prisma.savedSearch.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
    res.json(searches);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, query, location, company, boards } = validateInput(createSchema, req.body);
    const search = await prisma.savedSearch.create({
      data: { userId: req.user!.id, name, query, location: location || null, company: company || null, sources: (boards || null) as any },
    });
    res.status(201).json(search);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/:id/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const s = await prisma.savedSearch.findUnique({ where: { id: req.params.id } });
    if (!s) throw new NotFoundError('Saved Search');
    if (s.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });

    // Resolve boards: either the saved search's selected boards or all active user boards
    const boardIds = (s.sources as string[] | null) || undefined;
    const boards = await prisma.jobBoard.findMany({
      where: { userId: req.user!.id, isActive: true, ...(boardIds ? { id: { in: boardIds } } : {}) },
    });
    const configs: JobSourceConfig[] = boards.map((b) => ({
      ...boardToConfig(b),
      query: s.query,
    }));
    const results = (await Promise.all(configs.map((c) => runSource(c).catch(() => [])))).flat();

    const upserted = [];
    for (const job of results.slice(0, Number(req.query.limit) || 100)) {
      const existing = job.externalId
        ? await prisma.jobListing.findUnique({ where: { source_externalId: { source: job.source, externalId: job.externalId } } }).catch(() => null)
        : null;
      const rec = await prisma.jobListing.upsert({
        where: existing ? { id: existing.id } : { source_externalId: { source: job.source, externalId: job.externalId || `manual-${Date.now()}-${Math.random()}` } },
        update: { title: job.title, company: job.company, location: job.location, description: job.description, applyUrl: job.applyUrl, sourceUrl: job.sourceUrl, postedAt: job.postedAt },
        create: {
          source: job.source, externalId: job.externalId, sourceUrl: job.sourceUrl, title: job.title,
          company: job.company, location: job.location, description: job.description, applyUrl: job.applyUrl, postedAt: job.postedAt,
        },
      });
      upserted.push(rec);
    }

    res.json(upserted.map((j) => ({
      id: j.id, source: j.source, title: j.title, company: j.company,
      location: j.location, applyUrl: j.applyUrl, postedUrl: j.sourceUrl, postedAt: j.postedAt, isActive: j.isActive,
    })));
  } catch (error) {
    handleApiError(error, res);
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const s = await prisma.savedSearch.findUnique({ where: { id: req.params.id } });
    if (!s) throw new NotFoundError('Saved Search');
    if (s.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    await prisma.savedSearch.delete({ where: { id: s.id } });
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
