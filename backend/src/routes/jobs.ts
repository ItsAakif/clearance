// Job Discovery & Evaluation Routes
// Search public ATS sources (zero-token) and evaluate listings with the career-ops rubric.

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, jobSearchSchema, evaluateJobSchema } from '../shared/validation.js';
import { runSource, boardToConfig, type JobSourceConfig, type RawJob } from '../jobSources/index.js';
import { recordSourceSuccess, recordSourceFailure } from '../jobSources/sourceHealth.js';
import { dedupeJobs, withDeterministicExternalId } from '../jobSources/jobIdentity.js';
import { checkLiveness } from '../jobSources/liveness.js';
import { evaluateJob } from '../ai/evaluation.js';

const router = Router();

/**
 * Upsert flattened, deduped source results into JobListing.
 * Every job is guaranteed a deterministic externalId so repeated scans
 * update the same row instead of creating duplicates.
 */
export async function upsertDiscoveredJobs(jobs: RawJob[]) {
  const upserted = [];
  for (const job of jobs) {
    const withId = job.externalId ? job : withDeterministicExternalId(job);
    const rec = await prisma.jobListing.upsert({
      where: { source_externalId: { source: withId.source, externalId: withId.externalId! } },
      update: { title: withId.title, company: withId.company, location: withId.location, description: withId.description, applyUrl: withId.applyUrl, sourceUrl: withId.sourceUrl, postedAt: withId.postedAt },
      create: {
        source: withId.source,
        externalId: withId.externalId,
        sourceUrl: withId.sourceUrl,
        title: withId.title,
        company: withId.company,
        location: withId.location,
        description: withId.description,
        applyUrl: withId.applyUrl,
        postedAt: withId.postedAt,
      },
    });
    upserted.push(rec);
  }
  return upserted;
}

// ==================== SEARCH JOBS (user boards + filters) ====================
router.get('/search', requireAuth, async (req: Request, res: Response) => {
  try {
    const { q, limit } = validateInput(jobSearchSchema, {
      q: req.query.q,
      limit: req.query.limit ? Number(req.query.limit) : 30,
    });
    const location = req.query.location ? String(req.query.location) : undefined;
    const company = req.query.company ? String(req.query.company) : undefined;
    const sourceTypes = req.query.sources ? String(req.query.sources).split(',').filter(Boolean) : undefined;

    // Build source configs from the user's configured boards (per-user, no hardcoded defaults)
    const boards = await prisma.jobBoard.findMany({ where: { userId: req.user!.id, isActive: true } });
    const configs: JobSourceConfig[] = boards.map((b) => ({
      ...boardToConfig(b),
      query: q,
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
    }))).flat())
      .filter((job) => !company || (job.company || '').toLowerCase().includes(company.toLowerCase()))
      .filter((job) => !sourceTypes || sourceTypes.includes(job.source));

    const upserted = await upsertDiscoveredJobs(results.slice(0, limit));

    let filtered = upserted;
    if (location) {
      filtered = filtered.filter((j) => (j.location || '').toLowerCase().includes(location.toLowerCase()));
    }

    res.json(filtered.map((j) => ({
      id: j.id, source: j.source, title: j.title, company: j.company,
      location: j.location, applyUrl: j.applyUrl, postedUrl: j.sourceUrl, postedAt: j.postedAt, isActive: j.isActive,
    })));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== SCAN ALL MY BOARDS (optionally filtered) ====================
router.get('/scan', requireAuth, async (req: Request, res: Response) => {
  try {
    const query = req.query.query ? String(req.query.query) : '';
    const boardIds = req.query.boardIds ? String(req.query.boardIds).split(',').filter(Boolean) : undefined;

    const boards = await prisma.jobBoard.findMany({
      where: { userId: req.user!.id, isActive: true, ...(boardIds ? { id: { in: boardIds } } : {}) },
    });
    const configs: JobSourceConfig[] = boards.map((b) => ({
      ...boardToConfig(b),
      query,
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

    const upserted = await upsertDiscoveredJobs(results.slice(0, Number(req.query.limit) || 100));

    res.json(upserted.map((j) => ({
      id: j.id, source: j.source, title: j.title, company: j.company,
      location: j.location, applyUrl: j.applyUrl, postedUrl: j.sourceUrl, postedAt: j.postedAt, isActive: j.isActive,
    })));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== LIST EVALUATIONS ====================
router.get('/evaluations', requireAuth, async (req: Request, res: Response) => {
  try {
    const evals = await prisma.jobEvaluation.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      include: { jobListing: { select: { title: true, company: true, applyUrl: true } } },
    });
    res.json(evals);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET LISTING ====================
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const listing = await prisma.jobListing.findUnique({ where: { id: req.params.id } });
    if (!listing) throw new NotFoundError('Job Listing');
    res.json(listing);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== EVALUATE LISTING ====================
router.post('/:id/evaluate', requireAuth, async (req: Request, res: Response) => {
  try {
    const { resumeId, jobDescription } = validateInput(evaluateJobSchema, { ...req.body, jobDescription: req.body.jobDescription || undefined });
    const listing = await prisma.jobListing.findUnique({ where: { id: req.params.id } });
    if (!listing) throw new NotFoundError('Job Listing');

    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
    if (!resume) throw new NotFoundError('Resume');
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    // Liveness check (zero-token) before spending eval tokens
    const alive = await checkLiveness(listing.applyUrl || listing.sourceUrl);
    if (!alive) {
      await prisma.jobListing.update({ where: { id: listing.id }, data: { isActive: false } });
      res.status(409).json({ error: 'This job posting appears to be closed (dead link).' });
      return;
    }

    const hasTavily = !!(await prisma.aIProviderKey.findFirst({ where: { userId: req.user!.id, provider: 'tavily', isActive: true } }).catch(() => null));

    // Load the user's career profile (optional) to contextualize the evaluation
    const profile = await prisma.careerProfile.findUnique({ where: { userId: req.user!.id } });

    const result = await evaluateJob(req.user!.id, resume as any, jobDescription || listing.description, {
      useTavily: hasTavily,
      companyName: listing.company,
      profile: profile ? {
        targetRoles: (profile.targetRoles as string[]) || [],
        seniority: profile.seniority || undefined,
        topSkills: (profile.topSkills as string[]) || [],
        industries: (profile.industries as string[]) || [],
        redFlags: (profile.redFlags as string[]) || [],
        proofPoints: (profile.proofPoints as string[]) || [],
        minSalary: profile.minSalary ?? undefined,
        maxSalary: profile.maxSalary ?? undefined,
        currency: profile.currency || undefined,
        locationPref: profile.locationPref || undefined,
        remoteOnly: profile.remoteOnly,
        summary: profile.summary || undefined,
      } : undefined,
    });

    const evaluation = await prisma.jobEvaluation.create({
      data: {
        userId: req.user!.id,
        jobListingId: listing.id,
        resumeId,
        roleSummary: result.roleSummary,
        cvMatchScore: result.cvMatchScore,
        levelFitScore: result.levelFitScore,
        compFitScore: result.compFitScore,
        personalizationScore: result.personalizationScore,
        interviewPrepScore: result.interviewPrepScore,
        legitimacyScore: result.legitimacyScore,
        overallScore: result.overallScore,
        recommendation: result.recommendation,
        isScam: result.isScam,
        reportJson: result.reportJson as any,
      },
    });

    res.status(201).json({
      id: evaluation.id,
      overallScore: evaluation.overallScore,
      recommendation: evaluation.recommendation,
      isScam: evaluation.isScam,
      scores: {
        cvMatch: evaluation.cvMatchScore,
        levelFit: evaluation.levelFitScore,
        compFit: evaluation.compFitScore,
        personalization: evaluation.personalizationScore,
        interviewPrep: evaluation.interviewPrepScore,
        legitimacy: evaluation.legitimacyScore,
      },
      roleSummary: evaluation.roleSummary,
      reportJson: evaluation.reportJson,
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
