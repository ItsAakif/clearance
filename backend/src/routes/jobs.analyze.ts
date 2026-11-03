// =====================================================================================
// routes/jobs.analyze.ts - the HTTP surface of job analysis (T1060; 06 sec. E.1, E.10).
//
// WHAT THIS FILE IS. Two routes and nothing else:
//   POST /jobs/analyze        a JD (listingId | text | url | fileId) -> Job + requirements
//   GET  /jobs/:id/analysis   read one analysis back, quotes included
//
// Every decision lives in `jobs/analyze.ts` and every decision that needs no I/O lives in
// `jobs/requirements.ts`. This file only: validates the envelope, checks auth and
// ownership, calls the service, and maps typed errors onto status codes - the
// `routes/applications.ts` / `routes/resumes.ts` convention.
//
// MOUNTING. Mounted at `/jobs` BEFORE the legacy discovery router (`routes/index.ts`),
// and disjoint from it either way: the legacy `GET /:id` matches exactly one path segment,
// so `/jobs/:id/analysis` falls through to this router, and this router declares no
// `POST /:id` that could shadow anything. Mounting first anyway means the ordering is not
// a property anybody has to re-derive.
//
// AUTHORIZATION. `requireAuth` on both routes. `GET /jobs/:id/analysis` refuses another
// tenant's job with a 404, not a 403: a job id is an id, and answering 403 would confirm
// that somebody else's row exists (the same argument `routes/career.ts` makes for a
// foreign entity id). `POST /jobs/analyze` scopes its `fileId` read to the caller for the
// same reason - a foreign upload is indistinguishable from an absent one.
//
// NO V2 FLAG GATES THESE ROUTES. They are additive (`Job`/`JobRequirement` are new
// tables) and the V2 builder flags govern the LEGACY free-generation surface, not the
// derivation layer. Gating them would break the very thing the flags exist to protect.
// =====================================================================================

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError } from '../shared/errors.js';
import { validateInput } from '../shared/validation.js';
import { analyzeJob, getJobAnalysis, type JobAnalysisTransaction } from '../jobs/analyze.js';

const router = Router();

/** 400 when the caller sends a blob too large to be a job description. */
const MAX_JD_TEXT_CHARS = 200_000;
const MAX_JD_URL_CHARS = 2_048;

/**
 * Exactly ONE source, or a 400 naming what was wrong.
 *
 * `.strict()` so an unknown member is a 400 rather than a silently ignored field: a
 * client that sends `jdText` instead of `text` has a bug, and quietly analysing nothing
 * is the worse answer.
 */
const analyzeSchema = z
  .object({
    listingId: z.string().trim().min(1).max(64).optional(),
    text: z.string().trim().min(1).max(MAX_JD_TEXT_CHARS).optional(),
    url: z.string().trim().min(1).max(MAX_JD_URL_CHARS).optional(),
    fileId: z.string().trim().min(1).max(64).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    company: z.string().trim().min(1).max(200).optional(),
    location: z.string().trim().min(1).max(200).optional(),
    employmentType: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (body) => [body.listingId, body.text, body.url, body.fileId].filter(Boolean).length === 1,
    { message: 'name exactly one of listingId, text, url or fileId' },
  );

// ---------------------------------------------------------------------------
// POST /jobs/analyze
// ---------------------------------------------------------------------------

router.post('/analyze', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(analyzeSchema, req.body);
    const result = await analyzeJob(
      {
        listingId: body.listingId ?? null,
        text: body.text ?? null,
        url: body.url ?? null,
        fileId: body.fileId ?? null,
        title: body.title ?? null,
        company: body.company ?? null,
        location: body.location ?? null,
        employmentType: body.employmentType ?? null,
        userId: req.user!.id,
      },
      prisma as unknown as JobAnalysisTransaction,
    );

    // 201 on the create, 200 on the dedupe hit. The STATUS tells the client whether this
    // call made a new row or found the existing one, so "analysed twice" is observable
    // over HTTP without a second query.
    res.status(result.created ? 201 : 200).json({
      jobId: result.jobId,
      created: result.created,
      sourceKind: result.sourceKind,
      contentHash: result.contentHash,
      analysis: result.analysis,
      requirements: result.requirements,
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ---------------------------------------------------------------------------
// GET /jobs/:id/analysis
// ---------------------------------------------------------------------------

router.get('/:id/analysis', requireAuth, async (req: Request, res: Response) => {
  try {
    const view = await getJobAnalysis(req.user!.id, req.params.id, prisma);
    res.status(200).json(view);
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
