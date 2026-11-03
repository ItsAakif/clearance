// Route Aggregator - Mount all API routes
import { Router } from 'express';

import authRoutes from './auth.js';
import resumeRoutes from './resume.js';
// T1030: the V2 resume-derivation surface. Mounted ALONGSIDE the frozen legacy builder
// router (07 keeps the legacy CRUD serving during the transition), not instead of it.
// There is no path collision - the legacy `/:id` matches exactly one segment, so
// `/:id/revisions`, `/:id/diff` and `/:id/render` fall through to this router.
import resumeV2Routes, { careerRouter } from './resumes.js';
// T1020: the career import + verification surface. Mounted at the SAME `/career`
// prefix, AFTER T1030's router, and the two path sets are disjoint
// (`/import/json` vs `/import/resume`, `/sources`, `/profile`, `/claims*`), so
// express walks one and falls through to the other without either shadowing.
import careerVerificationRoutes from './career.js';
import atsRoutes from './ats.js';
import jobMatchRoutes from './job-match.js';
import templateRoutes from './templates.js';
import aiRoutes from './ai.js';
import exportRoutes from './export.js';
import adminRoutes from './admin.js';
import keysRoutes from './keys.js';
import jobsRoutes from './jobs.js';
// Faceted catalogue browse (`GET /jobs/catalogue`). Mounted BEFORE the legacy
// discovery router because that router's one-segment `GET /:id` is a catch-all
// and would otherwise answer `/jobs/catalogue`.
import catalogueRoutes from './jobs.catalogue.js';
import insightsRoutes from './insights.js';
// T1060: the V2 job-analysis surface (`POST /jobs/analyze`, `GET /jobs/:id/analysis`).
// Mounted at the SAME `/jobs` prefix and BEFORE the legacy discovery router. Disjoint
// either way (the legacy `GET /:id` matches exactly one segment, and this router declares
// no `POST /:id`), so nothing is shadowed - mounted first so the ordering is a property of
// this file rather than something a reader has to re-derive.
import jobsAnalyzeRoutes from './jobs.analyze.js';
// T1070: the V2 evidence-level matching surface. ONE router mounted TWICE: at `/jobs`
// (serving `POST /:id/match`) and at `/matches` (serving `GET /:id` and the two
// potential-match decisions). See the MOUNT ORDER note at the `/jobs` mounts below: the
// `/jobs` mount is placed AFTER the legacy discovery router, because `matches.ts` also
// carries `GET /:id`, which at the `/jobs` prefix is a one-segment CATCH-ALL.
import matchesRoutes, { projectDiscoveryRouter } from './matches.js';
// T1080: the FROZEN V1 tailor router stays at `/tailor`, byte-identical (the default export
// is unchanged and neither router reads a flag). The V2 tailoring surface is a SEPARATE
// router exported from the same module and mounted here at `/resumes`, alongside the other
// V2 resume routers. Its paths are `/:id/tailor`, `/:id/tailor/apply` and
// `/:id/tailor/changes`; the legacy `/resumes` router's `/:id` matches exactly one segment,
// so nothing is shadowed, and `GET /resumes/:id/diff` remains T1030's structural diff -
// untouched, and disjoint from `/tailor/*`.
import tailorRoutes, { tailorV2Router } from './tailor.js';
// T1090: the V2 interview-prep surface (`POST /interview-prep`,
// `GET /interview-prep/:resumeId`). A NEW prefix, mounted once, disjoint from every other
// group by construction - nothing else in this file serves `/interview-prep`, so there is no
// ordering question to answer. It reads the career evidence, the match report and the
// tailoring change log, and it touches the manual `QuestionAnswer` bank at `/question-answers`
// not at all.
import interviewPrepRoutes from './interview-prep.js';
import applicationsRoutes from './applications.js';
import profileRoutes from './profile.js';
import boardsRoutes from './boards.js';
import searchesRoutes from './saved-searches.js';
import uploadedFilesRoutes from './uploaded-files.js';
import jobAlertsRoutes from './job-alerts.js';
import questionAnswersRoutes from './question-answers.js';
import settingsRoutes from './settings.js';
import providersRoutes from './providers.js';
import registryRoutes from './registry.js';
// Catalogue snapshot import/status. A NEW prefix (`/catalogue`) that no other
// router serves, so there is no ordering question here: `POST /catalogue/import`
// and `GET /catalogue/status` cannot shadow or be shadowed by `/jobs`, `/settings`
// or any other mount.
import catalogueSnapshotRoutes from './catalogue.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/resumes', resumeRoutes);
router.use('/resumes', resumeV2Routes);
router.use('/resumes', tailorV2Router);
router.use('/career', careerRouter);
router.use('/career', careerVerificationRoutes);
router.use('/ats', atsRoutes);
router.use('/job-match', jobMatchRoutes);
router.use('/templates', templateRoutes);
router.use('/ai', aiRoutes);
router.use('/export', exportRoutes);
router.use('/admin', adminRoutes);
router.use('/keys', keysRoutes);
router.use('/jobs', jobsAnalyzeRoutes);
// MOUNT ORDER AT `/jobs`, AND WHY THE LEGACY ROUTER COMES FIRST (T1052).
//
// What each of the two routers claims AT THIS PREFIX, exhaustively:
//
//   jobs.analyze.ts   POST /analyze            (1 segment, literal)
//                      GET  /:id/analysis        (2 segments)
//   jobs.ts           GET  /search /scan /full-scan /evaluations /locations  (1 seg, literal)
//                      GET  /runs/:runId         (2 segments)
//                      POST /runs/:runId/cancel  (2 segments)
//                      POST /normalize           (1 segment, literal)
//                      POST /:id/normalize       (2 segments)
//                      POST /:id/evaluate        (2 segments)
//                      GET  /:id                 (1 segment, PARAM - the catch-all, last)
//   matches.ts        POST /:id/match                                   (2 segments)
//                      POST /:id/potential/:pmId/confirm, .../reject    (4 segments)
//                      GET  /:id                 (1 segment, PARAM)
//
// The collision is the two `GET /:id`s. Mounting `matches.ts` first made its `/:id` answer
// EVERY one-segment GET under `/jobs`, so `GET /jobs/evaluations` (the job-evaluation ranking
// read path), `/search`, `/scan`, `/full-scan` and `/locations` were all routed into
// `getMatchReport(req.user.id, 'evaluations')` and answered 404 - and `GET /jobs/:id`, the job
// detail read, with it. The bug was the reasoning, not the line: `matches.ts`'s `GET /:id` is
// only INTENDED for the `/matches` mount, but mounting the whole router at `/jobs` brings it
// along, and "no legacy route ends in `/match`" says nothing about the routes that do not.
//
// The fix is ORDER, not a split router, because order is the only lever that needs no new
// mount point and no edit to `matches.ts`. `jobs.ts` before `matches.ts` is safe in both
// directions, and it is worth being explicit about why rather than "it happened to work":
//   - every one-segment GET literal in `jobs.ts` (`/evaluations` among them) now matches
//     before `matches.ts`'s `/:id` can, which is the whole point;
//   - `POST /:id/match` and the two 4-segment potential-match POSTs match NOTHING in `jobs.ts`
//     (its POSTs are `/normalize`, `/:id/normalize`, `/:id/evaluate`, `/runs/:runId/cancel`),
//     so they still fall through to `matches.ts` - matched, not shadowed;
//   - `jobs.analyze.ts` stays first, and neither of its paths collides with anything in the
//     other two (`/analyze` is a 1-segment POST where `jobs.ts` has only `/normalize`, and
//     `/:id/analysis` is 2 segments);
//   - the `/matches` mount is a different prefix and is untouched by this ordering, so
//     `GET /matches/:id` and the two decisions keep resolving to `matches.ts`.
// `routes/index.mount-order.test.ts` resolves the winning layer for each of these paths, so
// the claim above is a test rather than a comment.
// The catalogue router is mounted BEFORE `jobs.ts` so its literal one-segment
// `/catalogue` wins over the legacy `GET /:id` catch-all. It is disjoint from
// every other `/jobs` path (`/analyze` is POST, `/:id/analysis` is two
// segments), and the legacy `/search`/`/scan`/`/full-scan` handlers are
// untouched.
router.use('/jobs', catalogueRoutes());
router.use('/jobs', jobsRoutes);
router.use('/jobs', matchesRoutes);
router.use('/matches', matchesRoutes);
// T1100: the two-day project engine (06 sec. E.5). ONE mount, on its OWN prefix, and that is
// the whole ordering argument: nothing else in this file serves `/project-discovery`, so unlike
// the `/jobs` pair above there is no catch-all to reason about and no way to shadow anything.
//
// The router is a NAMED export of `matches.ts` rather than a file of its own, because the
// project engine's input IS the match report's named gaps: one module owns what "a gap" means
// on both surfaces. It is deliberately NOT mounted at `/jobs` or `/matches`, because it has no
// one-segment catch-all and would add nothing at either - and mounting it at `/matches` would
// put `POST /` in competition with nothing, which is exactly the kind of accidental adjacency
// `index.mount-order.test.ts` exists to catch if a route is ever added to it.
router.use('/project-discovery', projectDiscoveryRouter);
router.use('/tailor', tailorRoutes);
router.use('/applications', applicationsRoutes);
router.use('/profile', profileRoutes);
router.use('/boards', boardsRoutes);
router.use('/searches', searchesRoutes);
router.use('/uploaded-files', uploadedFilesRoutes);
router.use('/job-alerts', jobAlertsRoutes);
router.use('/question-answers', questionAnswersRoutes);
// T1090: derived interview risks + grounded questions. Mounted AFTER `/question-answers` and
// deliberately a DIFFERENT prefix, because the two surfaces must not be confusable: the manual
// Q&A bank is hand-written by the user, and this one is derived from their evidence.
router.use('/interview-prep', interviewPrepRoutes);
router.use('/settings', settingsRoutes);
router.use('/catalogue', catalogueSnapshotRoutes());
router.use('/providers', providersRoutes);
router.use('/registry', registryRoutes);
router.use('/insights', insightsRoutes());

export default router;
