// Application Tracking Routes - pipeline (saved -> tailored -> applied -> interview -> offer/rejected)
// Human-in-the-loop: the app only tracks; it never submits applications.

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, createApplicationSchema, updateApplicationSchema, createApplicationEventSchema, updateApplicationEventSchema } from '../shared/validation.js';

const router = Router();

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { jobListingId, tailoredResumeId, status, notes } = validateInput(createApplicationSchema, req.body);
    const listing = await prisma.jobListing.findUnique({ where: { id: jobListingId } });
    if (!listing) throw new NotFoundError('Job Listing');
    if (tailoredResumeId) {
      const tr = await prisma.tailoredResume.findUnique({ where: { id: tailoredResumeId } });
      if (tr) await ensureOwnership(req.user!.id, tr.userId, 'Tailored Resume');
    }

    const app = await prisma.application.create({
      data: { userId: req.user!.id, jobListingId, tailoredResumeId, status, notes, appliedAt: status === 'applied' ? new Date() : null },
    });
    res.status(201).json(app);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const apps = await prisma.application.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      include: { jobListing: { select: { title: true, company: true, location: true, sourceUrl: true, applyUrl: true } }, tailoredResume: { select: { id: true, title: true, templateId: true, sourceResumeId: true } } },
    });
    const enriched = await Promise.all(apps.map(async (app) => {
      const match = await applicationMatch(req.user!.id, app.jobListingId);
      const matchGaps = await applicationGaps(req.user!.id, app.jobListingId);
      return { ...app, match, matchGaps, job: app.jobListing };
    }));
    res.json(enriched);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const app = await prisma.application.findUnique({
      where: { id: req.params.id },
      include: {
        jobListing: { select: { title: true, company: true, location: true, description: true, sourceUrl: true, applyUrl: true, searchDocument: true } },
        tailoredResume: { select: { id: true, title: true, templateId: true, sourceResumeId: true } },
      },
    });
    if (!app) throw new NotFoundError('Application');
    await ensureOwnership(req.user!.id, app.userId, 'Application');
    const match = await applicationMatch(req.user!.id, app.jobListingId);
    const matchGaps = await applicationGaps(req.user!.id, app.jobListingId);
    res.json({ ...app, match, matchGaps, job: app.jobListing });
  } catch (error) {
    handleApiError(error, res);
  }
});

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { status, notes, appliedAt, followUpAt, ghostedAt, withdrawnAt } = validateInput(updateApplicationSchema, req.body);
    const app = await prisma.application.findUnique({ where: { id: req.params.id } });
    if (!app) throw new NotFoundError('Application');
    await ensureOwnership(req.user!.id, app.userId, 'Application');

    const updated = await prisma.application.update({
      where: { id: app.id },
      data: {
        ...(status ? { status } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(appliedAt ? { appliedAt: new Date(appliedAt) } : {}),
        ...(followUpAt !== undefined ? { followUpAt: followUpAt ? new Date(followUpAt) : null } : {}),
        ...(ghostedAt !== undefined ? { ghostedAt: ghostedAt ? new Date(ghostedAt) : null } : {}),
        ...(withdrawnAt !== undefined ? { withdrawnAt: withdrawnAt ? new Date(withdrawnAt) : null } : {}),
        ...(status === 'applied' && !app.appliedAt ? { appliedAt: new Date() } : {}),
      },
    });
    res.json(updated);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const app = await prisma.application.findUnique({ where: { id: req.params.id } });
    if (!app) throw new NotFoundError('Application');
    await ensureOwnership(req.user!.id, app.userId, 'Application');
    await prisma.application.delete({ where: { id: app.id } });
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== APPLICATION EVENTS ====================

router.get('/:id/events', requireAuth, async (req: Request, res: Response) => {
  try {
    const app = await prisma.application.findUnique({ where: { id: req.params.id } });
    if (!app) throw new NotFoundError('Application');
    await ensureOwnership(req.user!.id, app.userId, 'Application');
    const events = await prisma.applicationEvent.findMany({
      where: { applicationId: app.id },
      orderBy: { createdAt: 'asc' },
    });
    res.json(events);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/:id/events', requireAuth, async (req: Request, res: Response) => {
  try {
    const app = await prisma.application.findUnique({ where: { id: req.params.id } });
    if (!app) throw new NotFoundError('Application');
    await ensureOwnership(req.user!.id, app.userId, 'Application');
    const body = validateInput(createApplicationEventSchema, req.body);
    const event = await prisma.applicationEvent.create({
      data: {
        applicationId: app.id,
        type: body.type,
        fromStatus: body.fromStatus ?? null,
        toStatus: body.toStatus ?? null,
        title: body.title ?? null,
        description: body.description ?? null,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
        completedAt: body.completedAt ? new Date(body.completedAt) : null,
      },
    });
    res.status(201).json(event);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.patch('/:id/events/:eventId', requireAuth, async (req: Request, res: Response) => {
  try {
    const app = await prisma.application.findUnique({ where: { id: req.params.id } });
    if (!app) throw new NotFoundError('Application');
    await ensureOwnership(req.user!.id, app.userId, 'Application');
    const event = await prisma.applicationEvent.findUnique({ where: { id: req.params.eventId } });
    if (!event || event.applicationId !== app.id) throw new NotFoundError('Application Event');
    const body = validateInput(updateApplicationEventSchema, req.body);
    const updated = await prisma.applicationEvent.update({
      where: { id: event.id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.scheduledAt !== undefined ? { scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null } : {}),
        ...(body.completedAt !== undefined ? { completedAt: body.completedAt ? new Date(body.completedAt) : null } : {}),
      },
    });
    res.json(updated);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== MATCH ENRICHMENT (additive) ====================

async function applicationMatch(userId: string, jobListingId: string | null | undefined) {
  if (!jobListingId) return null;
  const jobDelegate = (prisma as any).job;
  if (!jobDelegate || typeof jobDelegate.findFirst !== 'function') return null;
  const job = await jobDelegate.findFirst({ where: { userId, jobListingId } });
  if (!job) return null;
  const reportDelegate = (prisma as any).matchReport;
  if (!reportDelegate || typeof reportDelegate.findFirst !== 'function') return null;
  const report = await reportDelegate.findFirst({ where: { jobId: job.id, userId }, orderBy: { createdAt: 'desc' } });
  if (!report) return null;
  const counts = extractMatchCounts(report);
  if (!counts) return null;
  return counts;
}

async function applicationGaps(userId: string, jobListingId: string | null | undefined) {
  if (!jobListingId) return null;
  const jobDelegate = (prisma as any).job;
  if (!jobDelegate || typeof jobDelegate.findFirst !== 'function') return null;
  const job = await jobDelegate.findFirst({ where: { userId, jobListingId } });
  if (!job) return null;
  const reportDelegate = (prisma as any).matchReport;
  if (!reportDelegate || typeof reportDelegate.findFirst !== 'function') return null;
  const report = await reportDelegate.findFirst({ where: { jobId: job.id, userId }, orderBy: { createdAt: 'desc' } });
  if (!report) return null;
  const gaps = (report as any).gaps;
  return Array.isArray(gaps) ? gaps : null;
}

function readCount(src: any, key: string): number | undefined {
  if (!src || typeof src !== 'object') return undefined;
  const camel = key + 'Count';
  if (typeof src[key] === 'number') return src[key];
  if (typeof src[camel] === 'number') return src[camel];
  return undefined;
}

function extractMatchCounts(report: any) {
  const candidates = [
    report,
    report?.reportJson,
    report?.counts,
    report?.reportJson?.counts,
    report?.buckets,
    report?.bucketCounts,
    report?.reportJson?.buckets,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const d = readCount(c, 'direct');
    const cx = readCount(c, 'contextual');
    const p = readCount(c, 'potential');
    const u = readCount(c, 'unsupported');
    if (d !== undefined || cx !== undefined || p !== undefined || u !== undefined) {
      const direct = d ?? 0;
      const contextual = cx ?? 0;
      const potential = p ?? 0;
      const unsupported = u ?? 0;
      return { direct, contextual, potential, unsupported, total: direct + contextual + potential + unsupported };
    }
  }
  return null;
}

export default router;
