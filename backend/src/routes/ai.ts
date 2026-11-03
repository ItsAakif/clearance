// AI Routes - the RETIRED fabricating surface (T1110; FREEZE A-36/A-37/A-38).
//
// WHAT THIS FILE IS NOW: FIVE DEPRECATION HANDLERS AND NOTHING ELSE.
//
// Every route this router used to serve is gone. They were the only five routes on the
// `/ai` prefix, so the router itself is now a deprecation surface: the paths stay PUBLISHED and
// answer `410 Gone` with a machine-readable body naming the V2 successor, which is the contract
// in `.planning/tasks/T1110-cutover.md` ("the fabricating AI endpoints return the deprecation
// response") and the disposition FREEZE records for A-36/A-37/A-38.
//
// WHY 410 AND NOT 404. These paths were published for the life of the V1 app; an old client, a
// bookmarked integration or a stale mobile build still POSTs them. A 404 says "this never
// existed", which is false and which sends an integrator looking for a typo. A 410 says "this
// existed and is deliberately gone", and it is the only status that REQUIRES the answer to name
// the replacement.
//
// WHY UNCONDITIONAL, WITH NO FLAG. `V2_DISABLE_FREE_AI_GENERATION` used to gate the two
// free-generation routes behind a `409` (T1003). That was a transitional state: a flag could not
// bring the behaviour back, because the flag only ever said "stop". Now the implementation they
// guarded is DELETED (FREEZE A-40, `backend/src/ai/resumeGenerator.ts`), so a flag that turned
// the `410` off would have to resurrect code that no longer exists - a flag whose OFF state is
// unreachable is a lie an operator would read as "generation is available again". The env KEY
// stays in `backend/src/config/flags.ts` and in `src/lib/flags.ts` because
// `src/lib/flags.test.ts` asserts the two runtimes name the same three keys; it is now a
// recognised-and-ignored key. The only flag that still governs anything is `V2_TYPST_RENDER`.
//
// WHAT WAS DELETED ALONG WITH THESE HANDLERS, AND WHY IT IS NOT RESTORABLE BY A CALLER:
//   A-36 `POST /generate-resume`, `POST /build-from-jd` - the prompt in the deleted generator
//        asked the model for "[Generate a professional placeholder name]" and for 2-3 invented
//        employers, titles, dates and quantified achievements, then wrote the result straight to
//        a `Resume` row with no human gate.
//   A-37 `POST /improve-bullet`, `POST /generate-summary` - single-shot whole-fragment rewrites
//        with no schema validation and no before/after, so a claim could change without a diff.
//   A-38 `POST /generate-interview-answer` - a free-form answer generator rather than a
//        risk-derived, evidence-grounded one.
//
// WHAT IS DELIBERATELY STILL HERE. The BYOK key infrastructure (`ai/keyManager.ts`,
// `ai/providerModels.ts`, `ai/providerRegistry.ts` - FREEZE B-12/B-13, "KEEP VERBATIM") is
// untouched and is used by the V2 surfaces: `routes/tailor.ts` (the tailoring proposal stage),
// `routes/interview-prep.ts`, `career/claimWriterAI.ts`, `ats/llmEvaluator.ts` and
// `ats/matchEnhancer.ts`. The deterministic scanners and the 3-factor scorer
// (`ats/scanner.ts`, `ats/atsScorer.ts` - FREEZE B-17/B-18) still run; they are INTERNAL signals
// and are never presented as a number.

import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * Why each retired endpoint is retired, in the words a user needs.
 *
 * `error` is the human sentence. `code` is the stable machine token a client branches on. The
 * rest is the successor: a `method` + `route` pair a caller can actually POST to, and the UI
 * path a human can be sent to. Every field here is asserted verbatim by
 * `routes/ai.retired.test.ts`, so this table is the contract rather than a comment about one.
 */
interface Deprecation {
  /** The sentence a user reads. Names what the endpoint did wrong and what to do instead. */
  error: string;
  /** Stable machine token. Never changes for a given endpoint. */
  code: string;
  /** Why it went, as a token - `reason` is for logs and telemetry, not for rendering. */
  reason:
    | 'fabricated_candidate_history'
    | 'unguarded_whole_fragment_rewrite'
    | 'unguarded_whole_document_rewrite'
    | 'free_form_answer_generator';
  /** The HTTP method + route that replaces it. */
  successor: { method: 'POST' | 'GET'; route: string; surface: string };
  /** Where a human goes instead. Every one of these is a live route in `src/App.tsx`. */
  successorUi: string;
}

const DEPRECATIONS: Readonly<Record<string, Deprecation>> = {
  '/generate-resume': {
    error:
      'This endpoint generated a resume for you, including a name, employers, dates and achievements ' +
      'you never supplied, and saved it as one of your documents. It is retired. Import a document you ' +
      'actually wrote: every statement in it starts as an unverified draft and nothing is confirmed ' +
      'for you.',
    code: 'free_generation_retired',
    reason: 'fabricated_candidate_history',
    successor: { method: 'POST', route: '/career/import/resume', surface: 'career import' },
    successorUi: '/app/upload',
  },
  '/build-from-jd': {
    error:
      'This endpoint built a whole document from a job description and saved it as one of your ' +
      'resumes. It is retired, for the same reason: a generated draft is not a record of your work. ' +
      'Import what you wrote, then tailor toward the job as reviewable operations.',
    code: 'free_generation_retired',
    reason: 'fabricated_candidate_history',
    successor: { method: 'POST', route: '/career/import/resume', surface: 'career import' },
    successorUi: '/app/career',
  },
  '/improve-bullet': {
    error:
      'This endpoint rewrote one bullet in place, with no validation and no before/after, so a claim ' +
      'could change without anything showing you what changed. It is retired. The tailoring surface ' +
      'proposes OPERATIONS instead: each one carries its before text, its after text, the reason, and ' +
      'the confirmed statement that grounds it - and a fact change is refused.',
    code: 'unguarded_rewrite_retired',
    reason: 'unguarded_whole_fragment_rewrite',
    successor: { method: 'POST', route: '/resumes/:id/tailor', surface: 'tailoring operations' },
    successorUi: '/app/tailor',
  },
  '/generate-summary': {
    error:
      'This endpoint wrote a professional summary from a role and a list of skills, with no record of ' +
      'where any of it came from. It is retired. The tailoring surface proposes a summary as a ' +
      'reviewable operation, grounded in the statements you have confirmed.',
    code: 'unguarded_rewrite_retired',
    reason: 'unguarded_whole_fragment_rewrite',
    successor: { method: 'POST', route: '/resumes/:id/tailor', surface: 'tailoring operations' },
    successorUi: '/app/tailor',
  },
  '/generate-interview-answer': {
    error:
      'This endpoint answered an interview question from free-form text, with nothing anchoring the ' +
      'answer to anything you have actually done. It is retired. Interview prep now starts from the ' +
      'risks and gaps in your own evidence and asks questions about those.',
    code: 'unguarded_answer_generator_retired',
    reason: 'free_form_answer_generator',
    successor: { method: 'POST', route: '/interview-prep', surface: 'interview prep' },
    successorUi: '/app/interview-prep',
  },
};

/**
 * The one body builder, so every retired endpoint answers the same SHAPE.
 *
 * `operationsContainDocument: false` is carried over from T1080 deliberately: the successor is an
 * operation list and never a document, and a client that used to receive a whole generated resume
 * must be able to assert that the answer it got back is not one.
 */
function deprecationBody(method: string, route: string, spec: Deprecation): Record<string, unknown> {
  return {
    error: spec.error,
    code: spec.code,
    retired: true,
    httpStatus: 410,
    endpoint: `${method} /ai${route}`,
    reason: spec.reason,
    successor: spec.successor,
    successorUi: spec.successorUi,
    operationsContainDocument: false,
  };
}

/**
 * Register ONE retired endpoint.
 *
 * `requireAuth` still runs first, and that is on purpose: this route used to read and write the
 * caller's rows, so dropping authentication would turn "gone" into "open to anyone". The refusal
 * is the same for an anonymous caller (401) and an authenticated one (410), and both come before
 * any body parsing, any key lease and any database access - which is what retiring a fabricating
 * endpoint has to mean.
 */
function retired(method: 'POST' | 'GET', route: string): void {
  const spec = DEPRECATIONS[route];
  if (!spec) {
    // A typo in the table above would otherwise register a route that 410s without a body.
    throw new Error(`ai.ts: no deprecation recorded for ${route}`);
  }
  const handler = (_req: unknown, res: Response) => {
    res.status(410).json(deprecationBody(method, route, spec));
  };
  if (method === 'POST') router.post(route, requireAuth, handler);
  else router.get(route, requireAuth, handler);
}

// ==================== THE RETIRED SURFACE (A-36 / A-37 / A-38) ====================

retired('POST', '/generate-resume');
retired('POST', '/build-from-jd');
retired('POST', '/improve-bullet');
retired('POST', '/generate-summary');
retired('POST', '/generate-interview-answer');

/**
 * A catch-all over the rest of the `/ai` prefix, so a path that was never published is also a
 * `410` rather than the router's default 404.
 *
 * This is NOT a wildcard that could shadow another router: `routes/index.ts` mounts this router
 * at `/ai` and nothing else declares that prefix, so the fall-through is the last word on it. It
 * answers `404` for a genuinely unknown path - "this was never here" is the honest answer there -
 * and `410` for the five recorded ones, which are declared above and therefore matched first.
 */
router.use((req, res) => {
  res.status(404).json({
    error: 'No AI endpoint is published at this path.',
    code: 'ai_path_not_found',
    retired: true,
    publishedAiPaths: Object.keys(DEPRECATIONS).map((route) => `POST /ai${route}`),
  });
});

export default router;

/** The retired-path table, exported so a test can assert the routes and the table agree. */
export const RETIRED_AI_PATHS = Object.keys(DEPRECATIONS);