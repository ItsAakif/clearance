// Saved Search routes (per-user).
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { validateInput } from '../shared/validation.js';
import { runSource, boardToConfig, type JobSourceConfig } from '../jobSources/index.js';
import { recordSourceSuccess, recordSourceFailure } from '../jobSources/sourceHealth.js';
import { dedupeJobs, withDeterministicExternalId } from '../jobSources/jobIdentity.js';
const createSchema = z.object({
  name: z.string().min(1, 'Name required').max(100),
  query: z.string().min(1).max(200),
  location: z.string().max(100).optional(),
  company: z.string().max(100).optional(),
  boards: z.array(z.string()).max(10).optional(),
});

// PATCH accepts the same client-editable fields plus ranking/display prefs.
// Server-controlled fields (lastRunAt, matchCount) are intentionally absent
// so clients can never set them.
const updateSchema = z.object({
  name: z.string().min(1, 'Name required').max(100).optional(),
  query: z.string().min(1).max(200).optional(),
  location: z.string().max(100).nullable().optional(),
  company: z.string().max(100).nullable().optional(),
  boards: z.array(z.string()).max(10).nullable().optional(),
  minMatchScore: z.number().int().min(0).max(100).nullable().optional(),
  remoteOnly: z.boolean().optional(),
  sortBy: z.string().max(50).optional(),
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

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(updateSchema, req.body);
    const s = await prisma.savedSearch.findUnique({ where: { id: req.params.id } });
    if (!s) throw new NotFoundError('Saved Search');
    if (s.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    const updated = await prisma.savedSearch.update({
      where: { id: s.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.query !== undefined ? { query: body.query } : {}),
        ...(body.location !== undefined ? { location: body.location || null } : {}),
        ...(body.company !== undefined ? { company: body.company || null } : {}),
        ...(body.boards !== undefined ? { sources: (body.boards || null) as any } : {}),
        ...(body.minMatchScore !== undefined ? { minMatchScore: body.minMatchScore } : {}),
        ...(body.remoteOnly !== undefined ? { remoteOnly: body.remoteOnly } : {}),
        ...(body.sortBy !== undefined ? { sortBy: body.sortBy } : {}),
      },
    });
    res.json(updated);
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
      userId: req.user!.id,
    }));
    const results = dedupeJobs((await Promise.all(boards.map(async (b, i) => {
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
