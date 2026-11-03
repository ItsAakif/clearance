// =====================================================================================
// routes/matches.ts - the HTTP surfaces of MATCHING (T1070) and PROJECT DISCOVERY (T1100);
// 06 sec. E.2, E.5, E.6, E.10.
//
// TWO ROUTERS IN ONE MODULE, and why that is the shape rather than two files:
//
//   The MATCH router (default export, T1070), four routes:
//     POST /jobs/:id/match                        a Job's requirements x confirmed claims
//     GET  /matches/:id                           one MatchReport, re-derived
//     POST /matches/:id/potential/:pmId/confirm   confirm a proposal -> a confirmed claim
//     POST /matches/:id/potential/:pmId/reject    reject a proposal -> a named gap
//
//   The PROJECT router (`projectDiscoveryRouter`, T1100), four routes:
//     POST /project-discovery                     named gaps -> project candidates
//     POST /project-discovery/:id/accept          proposed -> accepted
//     POST /project-discovery/:id/complete        accepted -> completed, and NOTHING ELSE
//     POST /project-discovery/:id/confirm         completed -> a CONFIRMED CLAIM
//
// WHY THEY SHARE A FILE. The project engine's INPUT is the match report's named gaps
// (`match/levels.ts#MatchGap[]`), so a reader who wants to know what "a gap" means on this
// surface has ONE place to look, and `routes/index.ts` gains one mount line rather than a
// whole import block for a feature that is one stage downstream of this one. This is the SAME
// shape `routes/resumes.ts` (which exports `careerRouter` alongside its default) and
// `routes/tailor.ts` (which exports `tailorV2Router`) already use, so it is the repo's
// existing convention for a second surface in an existing module rather than a new one.
//
// THE PROJECT ROUTER IS MOUNTED ONCE, AT ITS OWN PREFIX. Unlike the match router (mounted
// twice, at `/jobs` and `/matches`), the project router is mounted exactly once at
// `/project-discovery`, which is disjoint from every other group by construction - nothing else
// in this file or in `routes/index.ts` serves that prefix - so there is no ordering question to
// answer and no shadowing to reason about.
//
// Every decision lives in `match/report.ts` (I/O) and `match/levels.ts` (pure). The project
// engine lives in `backend/src/projects/**`: `gaps.ts` (which gaps a two-day project could
// close), `research.ts` (the OPTIONAL public research), `references.ts` (the licence and
// activity criteria plus the anti-copy guard), `generate.ts` (the candidates and the
// feasibility screen) and `lifecycle.ts` (persistence and the three decisions). This file
// only: validates the envelope, checks auth, calls the service and maps typed errors onto
// status codes - the `routes/jobs.analyze.ts` / `routes/applications.ts` convention.
//
// MOUNTING. The MATCH router is mounted TWICE (`routes/index.ts`): at `/jobs` BEFORE the
// legacy discovery router, which serves `POST /:id/match`; and at `/matches`, which serves the
// other three. They are disjoint in both directions: no legacy route ends in `/match`, and
// no `/matches` path collides with anything mounted today. Mounting the `/jobs` side first
// means the ordering is a property of `routes/index.ts` rather than something a reader has
// to re-derive. The PROJECT router is mounted ONCE, at `/project-discovery` - disjoint from
// every other group by construction, so it has no ordering question to answer.
//
// THE CONFIRM HANDLER DELEGATES AND DOES NOTHING ELSE, and the same is true of the project
// router's confirm. There is no `prisma.careerClaim` call in this file and no claim status in
// any body schema, so "a claim became confirmed" and "a ClaimVerification row was written" are
// the same event here by construction on BOTH surfaces:
// `projects/lifecycle.ts#confirmOpportunity` calls `career/userDecisions.ts`, which calls
// `career/verification.ts`, the only writer of `CareerClaim.status` in the system.
// `matches.test.ts` asserts the audit row exists on the match path and
// `project-discovery.test.ts` asserts it on the project path, which is what makes that a fact
// rather than a claim about the code.
//
// NOTHING AUTO-CONFIRMS, AND THE PROJECT ROUTER'S ENVELOPES MAKE THAT STRUCTURAL. The accept
// body and the complete body are both EMPTY objects: there is no member a client could send to
// name a status, a provenance, a claim kind or a claim id. The only body that carries prose is
// `confirm`, and its members are `{statement?, note?}` - words the user chose, never a state.
// `complete` writes `completedAt` and nothing else; the claim is written by `confirm`, through
// the verification service, in the same transaction as its audit row.
//
// NO SCORE IN ANY ENVELOPE (E.6). Every body schema is `.strict()` and no member could be read
// as a verdict: the match bodies are `{resumeId?}` / `{statement?, note?}` / `{reason?, note?}`
// and the project bodies are `{matchReportId?, jobId?, research?, runProvider?}` / `{}` / `{}`
// / `{statement?, note?}`. The project response has four integers over NAMED things
// (`counts.considered|selected|excluded|candidates`) and no derived figure anywhere.
// `matches.test.ts` greps this file for the field names E.6 bans.
// =====================================================================================

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError } from '../shared/errors.js';
import { validateInput } from '../shared/validation.js';
import {
  confirmPotentialMatch,
  getMatchReport,
  matchJob,
  rejectPotentialMatch,
  type MatchStore,
} from '../match/report.js';
import {
  acceptOpportunity,
  completeOpportunity,
  confirmOpportunity,
  discoverProjects,
  type ProjectStore,
} from '../projects/lifecycle.js';
import { globalResearchFetch } from '../projects/research.js';

const router = Router();

/**
 * T1100: the PROJECT router. A SEPARATE `Router` from the match one, exported alongside it and
 * mounted ONCE at `/project-discovery` - so it can never be reached through the `/jobs` or
 * `/matches` mounts, which is the trap `routes/index.mount-order.test.ts` documents for a
 * router that carries a one-segment catch-all.
 */
const projectDiscoveryRouter = Router();

/**
 * THE ONE NETWORK CAPABILITY THE PROJECT ENGINE IS GIVEN.
 *
 * `projects/research.ts` never reaches for `fetch` itself - the stage is a pure function of an
 * INJECTED fetch, which is what lets its six criteria be tested against real provider JSON with
 * no network in the test run, and what makes "no fetch, so the stage reports unavailable rather
 * than dialling out" a property rather than a hope. This is the call site that supplies it:
 * `globalResearchFetch` is the global, narrowed to the two members the stage reads.
 *
 * The optional GitHub token is read from the environment here and passed in, so the module never
 * reads configuration and a token never reaches a `ProjectReference`.
 */
const PROJECT_RESEARCH_FETCH = globalResearchFetch;
const PROJECT_GITHUB_TOKEN = process.env.GITHUB_TOKEN;

/**
 * `POST /jobs/:id/match`.
 *
 * `.strict()`, so an unknown member is a 400 rather than a silently ignored field: a client
 * that sends `score: true` - the kind of thing a caller reaching for a verdict tries -
 * learns that there is no such thing here instead of quietly getting a report without it.
 */
const matchSchema = z
  .object({
    resumeId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/** `POST /matches/:id/potential/:pmId/confirm`. `statement` overrides the requirement text. */
const confirmSchema = z
  .object({
    statement: z.string().trim().min(1).max(2_000).optional(),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

/** `POST /matches/:id/potential/:pmId/reject`. The reason is recorded, never required. */
const rejectSchema = z
  .object({
    reason: z.string().trim().max(2_000).optional(),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// POST /jobs/:id/match
// ---------------------------------------------------------------------------

router.post('/:id/match', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(matchSchema, req.body ?? {});
    const report = await matchJob(
      {
        userId: req.user!.id,
        jobId: req.params.id,
        resumeId: body.resumeId ?? null,
      },
      prisma as unknown as MatchStore,
    );
    // 200, not 201: `MatchReport` is `@@unique([jobId, resumeId])`, so matching the same
    // job twice returns the SAME report with freshly derived levels. The status therefore
    // says "here is the current report", and the body's counts say what changed.
    res.status(200).json(report);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ---------------------------------------------------------------------------
// GET /matches/:id
// ---------------------------------------------------------------------------

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const report = await getMatchReport(req.user!.id, req.params.id, prisma as unknown as MatchStore);
    res.status(200).json(report);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ---------------------------------------------------------------------------
// POST /matches/:id/potential/:pmId/confirm
// ---------------------------------------------------------------------------

router.post('/:id/potential/:pmId/confirm', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(confirmSchema, req.body ?? {});
    const decision = await confirmPotentialMatch(
      {
        userId: req.user!.id,
        matchReportId: req.params.id,
        potentialMatchId: req.params.pmId,
        statement: body.statement ?? null,
        note: body.note ?? null,
      },
      prisma as unknown as MatchStore,
    );
    // 200 on both the first confirm and an idempotent repeat (`changed: false`), because
    // the second call did not create anything and must not be reported as if it had.
    res.status(200).json(decision);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ---------------------------------------------------------------------------
// POST /matches/:id/potential/:pmId/reject
// ---------------------------------------------------------------------------

router.post('/:id/potential/:pmId/reject', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(rejectSchema, req.body ?? {});
    const decision = await rejectPotentialMatch(
      {
        userId: req.user!.id,
        matchReportId: req.params.id,
        potentialMatchId: req.params.pmId,
        reason: body.reason ?? null,
        note: body.note ?? null,
      },
      prisma as unknown as MatchStore,
    );
    res.status(200).json(decision);
  } catch (error) {
    handleApiError(error, res);
  }
});

// =====================================================================================
// T1100 - THE TWO-DAY PROJECT ENGINE (06 sec. E.5, E.10)
// =====================================================================================

/**
 * `POST /project-discovery`. The four members, and what each one can and cannot do:
 *
 *   - `matchReportId` / `jobId`: WHICH gaps. At least one is required, and a foreign id is a
 *     404 rather than a 403 - this surface names a person's career gaps.
 *   - `research`: whether to make the OPTIONAL public-research call. `false` skips it and the
 *     response says `not_requested`, which is the honest difference between "declined" and
 *     "unavailable".
 *   - `runProvider`: whether to ask the BYOK provider for additional candidates. `false` runs
 *     the deterministic-only path and the response says `not_evaluated` - deliberately NOT
 *     `no_ai_provider_configured`, because this request then checked nothing about the user's
 *     keys (the same rule `match/report.ts` applies to a read).
 *
 * `.strict()`, so an unknown member is a 400 rather than a silently ignored field - the same
 * reason `matchSchema` refuses `score: true`.
 */
const discoverySchema = z
  .object({
    matchReportId: z.string().trim().min(1).max(64).optional(),
    jobId: z.string().trim().min(1).max(64).optional(),
    research: z.boolean().optional(),
    runProvider: z.boolean().optional(),
  })
  .strict();

/**
 * The accept and complete bodies.
 *
 * EMPTY ON PURPOSE, and that emptiness is the guarantee rather than an omission: there is no
 * member through which a client could name a claim status, a provenance, a claim kind, a claim
 * id or a `verifiedClaimId`. `complete` therefore has nothing it could write besides
 * `completedAt`, and the only route that can write a claim is `confirm`, whose body carries
 * only the user's own words.
 */
const lifecycleSchema = z.object({}).strict();

/** `POST /project-discovery/:id/confirm`. Words the user chose, never a state. */
const projectConfirmSchema = z
  .object({
    /** Overrides the derived statement ("Built and documented <title>"). */
    statement: z.string().trim().min(1).max(2_000).optional(),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

/**
 * `POST /project-discovery`.
 *
 * 201, not 200: the run CREATES rows (`ProjectOpportunity`, and a `ProjectReference` per
 * accepted reference), and the body carries the stored ids the next request needs. A repeat
 * POST creates a second set rather than replacing the first - deliberate, and the opposite of
 * `routes/interview-prep.ts`, because a project's LIFECYCLE is a thing the user acts on while
 * an interview run is a derived view.
 *
 * A run with nothing teachable is a 201 with `candidates: []` and the exclusions attached, not
 * a 404: "we looked and nothing here is a two-day project" is a real answer, and an error
 * would be indistinguishable from a broken endpoint.
 */
projectDiscoveryRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(discoverySchema, req.body ?? {});
    const view = await discoverProjects(
      {
        userId: req.user!.id,
        matchReportId: body.matchReportId ?? null,
        jobId: body.jobId ?? null,
        ...(body.research !== undefined ? { research: body.research } : {}),
        ...(body.runProvider !== undefined ? { runProvider: body.runProvider } : {}),
        // The optional public-research stage's network capability, supplied HERE - the only
        // place the engine gets one - and the optional token, read from the environment.
        fetchImpl: PROJECT_RESEARCH_FETCH,
        ...(PROJECT_GITHUB_TOKEN !== undefined ? { githubToken: PROJECT_GITHUB_TOKEN } : {}),
      },
      prisma as unknown as ProjectStore,
    );
    res.status(201).json(view);
  } catch (error) {
    handleApiError(error, res);
  }
});

/**
 * `POST /project-discovery/:id/accept`. `proposed` -> `accepted`.
 *
 * 200 on both the first accept and an idempotent repeat (`changed: false`), because the second
 * call did not create anything and must not be reported as if it had.
 */
projectDiscoveryRouter.post('/:id/accept', requireAuth, async (req: Request, res: Response) => {
  try {
    validateInput(lifecycleSchema, req.body ?? {});
    const decision = await acceptOpportunity(
      { userId: req.user!.id, opportunityId: req.params.id },
      prisma as unknown as ProjectStore,
    );
    res.status(200).json(decision);
  } catch (error) {
    handleApiError(error, res);
  }
});

/**
 * `POST /project-discovery/:id/complete`. `accepted` -> `completed`.
 *
 * THE ROUTE THAT MUST NOT WRITE A CLAIM, and it cannot: the body schema is `{}`, so there is
 * nothing in the request that names a claim, and `completeOpportunity` does not call the career
 * layer at all. The response says so in a field of its own -
 * `opportunity.awaitingYourConfirmation` - rather than leaving the client to infer it from a
 * missing claim.
 */
projectDiscoveryRouter.post('/:id/complete', requireAuth, async (req: Request, res: Response) => {
  try {
    validateInput(lifecycleSchema, req.body ?? {});
    const decision = await completeOpportunity(
      { userId: req.user!.id, opportunityId: req.params.id },
      prisma as unknown as ProjectStore,
    );
    res.status(200).json(decision);
  } catch (error) {
    handleApiError(error, res);
  }
});

/**
 * `POST /project-discovery/:id/confirm`. `completed` -> a CONFIRMED CLAIM, with its audit row.
 *
 * 201 the first time (a claim row and an audit row were created) and 200 on an idempotent
 * repeat, which is the honest status for each. The response carries both the claim and the
 * `career_claim` audit row the verification service wrote, so a client can show the decision
 * rather than assert that one happened.
 */
projectDiscoveryRouter.post('/:id/confirm', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(projectConfirmSchema, req.body ?? {});
    const decision = await confirmOpportunity(
      {
        userId: req.user!.id,
        opportunityId: req.params.id,
        statement: body.statement ?? null,
        note: body.note ?? null,
      },
      prisma as unknown as ProjectStore,
    );
    res.status(decision.changed ? 201 : 200).json(decision);
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
/**
 * T1100: the project-discovery router, mounted ONCE at `/project-discovery` by
 * `routes/index.ts`. A named export rather than a second file, so the two surfaces that share
 * the "gap" vocabulary also share the code that defines it.
 */
export { projectDiscoveryRouter };