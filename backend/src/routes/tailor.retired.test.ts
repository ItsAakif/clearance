// T1110 - the RETIRED legacy whole-document tailor (FREEZE A-39) answers 410 Gone.
//
// WHAT IS ASSERTED, AND WHY EACH THING MATTERS:
//   1. 410 + the EXACT body, per published path. `routes/ai.retired.test.ts` does the same for
//      the AI surface; this file is the `/tailor` half of the same contract. The body is asserted
//      verbatim because a client branches on `code` and `successor` and nothing else.
//   2. ALL FOUR published paths, including `GET /:id/export` and `GET /` - the two READ paths. A
//      retirement that only 410s the writes would leave `GET /tailor` listing `TailoredResume`
//      rows and `GET /tailor/:id/export` rendering one through Playwright, which is the opposite
//      of retired.
//   3. THE V2 SUCCESSOR IS THE LIVE SURFACE, on the same process: `POST /resumes/:id/tailor`
//      still answers 404 (not 500) for an unknown resume, i.e. it is registered, it runs its own
//      auth/ownership path, and the retirement did not break the router that replaced it.
//   4. THE THREE DELETED MODULES ARE GONE from disk, which is the reachability proof as a gate:
//      `ats/improver.ts` and `ats/refiner.ts` were reachable ONLY from `POST /tailor/pipeline`,
//      and with that handler gone there is nothing left that can import them.
//   5. NO PLAYWRIGHT AND NO `html-to-docx` in this module any more. The Letter export pipeline
//      behind `GET /:id/export` left with the handler, and this is the assertion that it did -
//      a source-level read of the file, because the imports are compile-time, not runtime.
//   6. THE ROUTER IS IMPORTED ONCE, AT MODULE SCOPE - the flake fix, and why.
//
// WHY THE FLAKE FIX IS A STRUCTURAL ONE. This file used to call `loadRouter()` - a
// `vi.resetModules()` plus a dynamic `import('./tailor.js')` - once per test, twelve times. The
// graph behind `routes/tailor.ts` (the AI key manager, the provider models, the render template
// registry, the revision writer, the claim belt, the tailor ops/validate/apply trio) has to be
// TRANSFORMED once, and that first transform measured **2510 ms** - half of the 5000 ms per-test
// budget before a single assertion ran. Every later load measured 29-48 ms, which is the whole
// story: one wall-clock-bound 2.5 s event charged to whichever test happened to import first, and
// a margin that collapses as soon as the parallel suite has other files competing for the same
// CPU. That is the same failure mode as the T906 flake, and the same discipline answers it: do not
// raise the timeout, do not retry, do not weaken an assertion - remove the real-time dependency.
//
// The dependency was REDUNDANT work, not real work. Nothing in this file reads a flag or mutates a
// module-level binding: `authState` is a `vi.hoisted` object read per request, the prisma mock is
// stateless, and an express Router is immutable once built. Re-importing the same module twelve
// times bought isolation that nothing depended on and cost eleven redundant graph evaluations plus
// the per-test transform. A single static import at module scope keeps every assertion verbatim,
// drops the file from 12 loads to 1, and moves the one unavoidable transform into the file's import
// phase where it is charged once and not to any test. Nothing else about the file changed: the same
// 12 tests, the same expectations, the same bodies.
//
// WHAT IT DOES NOT DO. No `testTimeout`, no `hookTimeout`, no retry, no skipped case, and no
// `vi.mock` of a dependency to make the graph smaller - stubbing a module the module-under-test
// imports in order to buy time is exactly how a real coupling gets hidden.
//
// WHAT DID GO WITH IT. `afterAll(vi.resetModules)` existed only to tear down the dynamic graph, and
// `loadRouter` itself. The `it("the V2 router and the deprecation router are SEPARATE…")` case is
// now synchronous because there is no `await` left to make.
//
// WHAT DID NOT GO WITH IT.
//
// WHAT WENT WITH THE SURFACE, AND WHY THAT IS ACCOUNTED FOR RATHER THAN LOST:
//   `backend/src/ai/resumeGenerator.ts` (A-40), `backend/src/ats/improver.ts` and
//   `backend/src/ats/refiner.ts` (A-41) are deleted. `routes/ai.gating.test.ts`, the only test
//   file that covered them, went with them and was replaced by `routes/ai.retired.test.ts`; the
//   two cases in `ai/providerBaseUrl.test.ts` that drove `improveResumeBullet` to prove provider
//   base-URL selection now drive `interviewGenerator` through the identical BYOK chain, with
//   every assertion unchanged. Net test-file delta for the whole backend half is in
//   `.planning/progress/T1110-cutover-backend-and-score.md`.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const { authState } = vi.hoisted(() => ({ authState: { enabled: true } }));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.enabled) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

// `prisma` is mocked so the retired handlers cannot reach a row and so the V2 route below can be
// driven to its OWN 404. `findUnique` returning null is what produces "not found" rather than a
// database error, which is the point: it proves the V2 route is registered AND is running its own
// body, rather than being shadowed or short-circuited by the retirement.
vi.mock('../lib/prisma.js', () => {
  const nothing = {
    resume: { findUnique: async () => null, findFirst: async () => null },
    careerClaim: { findMany: async () => [] },
    experience: { findMany: async () => [] },
  };
  return { default: nothing, prisma: nothing };
});

/** The exact body every retired `/tailor` path answers with, minus the per-path `endpoint`. */
const BODY = {
  error:
    'The legacy tailor rewrote your whole document as prose and saved the result as a new resume, ' +
    'with nothing to review and nothing recorded about why. It is retired. Tailoring now proposes ' +
    'individual operations - each with its before text, its after text, the reason, and the confirmed ' +
    'statement that grounds it - and a claim you cannot evidence is refused rather than written.',
  code: 'legacy_whole_document_tailor_retired',
  retired: true,
  httpStatus: 410,
  reason: 'unguarded_whole_document_rewrite',
  successor: {
    propose: { method: 'POST', route: '/resumes/:id/tailor', surface: 'tailoring operations' },
    apply: { method: 'POST', route: '/resumes/:id/tailor/apply', surface: 'apply accepted operations' },
    changes: { method: 'GET', route: '/resumes/:id/tailor/changes', surface: 'the operation log' },
  },
  successorUi: '/app/tailor',
  operationsContainDocument: false,
} as const;

const RETIRED: ReadonlyArray<{ method: 'POST' | 'GET'; path: string; endpoint: string }> = [
  { method: 'POST', path: '/pipeline', endpoint: 'POST /tailor/pipeline' },
  { method: 'POST', path: '/', endpoint: 'POST /tailor/' },
  { method: 'GET', path: '/:id/export', endpoint: 'GET /tailor/:id/export' },
  { method: 'GET', path: '/', endpoint: 'GET /tailor/' },
];

/**
 * Load the module fresh. A fresh graph is not needed for the flags (nothing here reads one) but
 * it keeps the router's mount state per-test, and the module reads `process.cwd()`-independent
 * paths only lazily.
 */
// ONE import, at module scope, on purpose - see the flake note below. The convention matches
// `routes/ats.noVerdict.test.ts`: the `vi.mock` calls above are hoisted above static imports.
import tailorRouter, { tailorV2Router } from './tailor.js';

function makeApp(legacy: express.Router) {
  const app = express();
  app.use(express.json());
  app.use('/tailor', legacy);
  return app;
}

/**
 * Comments removed before the source greps below.
 *
 * Necessary, and for the reason `features/match/noScore.test.ts` and `AppRouteTable.test.ts` both
 * strip comments: this file's own header, and `tailor.ts`'s, DISCUSS the deleted modules by name in
 * order to explain that they are gone. A grep that failed on its own documentation is a grep that
 * gets switched off.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

beforeEach(() => {
  authState.enabled = true;
});

describe('the retired legacy tailor answers 410 Gone on all four published paths', () => {
  for (const spec of RETIRED) {
    it(`${spec.endpoint} -> 410 legacy_whole_document_tailor_retired`, async () => {
      const app = makeApp(tailorRouter);

      const call = request(app);
      const res =
        spec.method === 'POST'
          ? await call.post(`/tailor${spec.path === '/' ? '' : spec.path}`).send({ resumeId: 'r1' })
          : await call.get(`/tailor${spec.path === '/' ? '' : spec.path}`);

      expect(res.status).toBe(410);
      expect(res.body).toEqual({ ...BODY, endpoint: spec.endpoint });
    });
  }

  it('the refusal comes BEFORE ownership, the profile read and the key lease', async () => {
    // Every old handler began with a prisma read and several ended in `leaseNextLlmKey`. Neither
    // can happen now, because neither is in the handler: a 410 that still cost a database round
    // trip or a provider lease would not be a retirement.
    const app = makeApp(tailorRouter);

    const res = await request(app)
      .post('/tailor/pipeline')
      .send({ resumeId: 'does-not-exist', jobDescription: 'x'.repeat(60) });

    // 410, and specifically NOT the 404 the old handler would have produced for that resume.
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('legacy_whole_document_tailor_retired');
  });

  it('the refusal is unconditional - there is no request body that reaches the old behaviour', async () => {
    const app = makeApp(tailorRouter);

    const empty = await request(app).post('/tailor').send({});
    const complete = await request(app)
      .post('/tailor')
      .send({ resumeId: 'r1', jobDescription: 'x'.repeat(60), templateId: 'professional-standard' });
    const list = await request(app).get('/tailor');
    const download = await request(app).get('/tailor/abc/export?format=pdf');

    for (const res of [empty, complete, list, download]) {
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('legacy_whole_document_tailor_retired');
    }
  });

  it('an UNAUTHENTICATED caller gets 401, not the deprecation body', async () => {
    const app = makeApp(tailorRouter);
    authState.enabled = false;

    const res = await request(app).post('/tailor').send({});

    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
  });
});

describe('the V2 tailoring surface is untouched by the retirement', () => {
  it('POST /resumes/:id/tailor is still registered and runs its own body (404, not 500 or 410)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/resumes', tailorV2Router);

    const res = await request(app).post('/resumes/missing/tailor').send({});

    // 404 "Resume": the route is mounted, matched, authenticated and reached its own ownership
    // lookup. Had the retirement shadowed it, this would be a 410 or a routing miss instead.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toMatch(/resume/i);
  });

  it('the V2 router and the deprecation router are SEPARATE, with disjoint prefixes', () => {
    // The property that makes "the retirement did not touch tailoring" structural rather than a
    // claim: two routers, one mounted at `/tailor` (410s) and one at `/resumes` (live), and the
    // only shared object is the module they came from.
    expect(tailorRouter).not.toBe(tailorV2Router);
    const legacyPaths = (tailorRouter.stack as Array<{ route?: { path: string } }>)
      .map((layer) => layer.route?.path)
      .filter((value): value is string => typeof value === 'string');
    // Four paths, but `/` appears TWICE: once for `POST /tailor` and once for `GET /tailor`. Sorting
    // the four declarations rather than the three distinct strings is the stronger claim - a fifth
    // route, or a lost method, both fail here.
    expect(legacyPaths.sort()).toEqual(['/', '/', '/:id/export', '/pipeline']);
  });
});

describe('the reachability proof, as a gate', () => {
  it('the two whole-document rewriters that only /tailor/pipeline imported are GONE', () => {
    // `ats/improver.ts` and `ats/refiner.ts` were reachable from exactly one place in the whole
    // tree: the `POST /tailor/pipeline` handler above. That handler is gone, so these are too.
    for (const gone of [
      path.join(__dirname, '..', 'ats', 'improver.ts'),
      path.join(__dirname, '..', 'ats', 'refiner.ts'),
      path.join(__dirname, '..', 'ai', 'resumeGenerator.ts'),
    ]) {
      expect([path.basename(gone), existsSync(gone)]).toEqual([path.basename(gone), false]);
    }
  });

  it('this module no longer imports Playwright or html-to-docx', () => {
    // Compile-time surface, so it has to be asserted by reading the source. The Letter export
    // pipeline those two imports served (`GET /:id/export` -> `chromium.page.pdf({format:'Letter'})`
    // / `HTMLtoDOCX`) went with the handler, and the dependency graph must show it.
    const source = codeOnly(readFileSync(path.join(__dirname, 'tailor.ts'), 'utf8'));
    expect(source).not.toMatch(/from ['"]playwright['"]/);
    expect(source).not.toMatch(/from ['"]html-to-docx['"]/);
    // ...and the two rewriters it used to import through them.
    expect(source).not.toMatch(/ats\/improver/);
    expect(source).not.toMatch(/ats\/refiner/);
    expect(source).not.toMatch(/ai\/resumeGenerator/);
  });

  it('and the import statements that ARE left are all live modules', () => {
    // Non-vacuity, and the other half of the same claim: a guard that only ever asserts absence
    // passes on an empty file. These five imports are what the retirement left behind, and each
    // one is still a module in the tree.
    const source = codeOnly(readFileSync(path.join(__dirname, 'tailor.ts'), 'utf8'));
    const specifiers = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(10);
    // Only RELATIVE specifiers name a file in this tree; `express`/`zod`/`@prisma/client` are
    // packages, and a missing one of those is a compile error rather than a reachability claim.
    const relative = specifiers.filter((specifier) => specifier.startsWith('.'));
    expect(relative.length).toBeGreaterThan(8);
    for (const specifier of relative) {
      const resolved = path.resolve(__dirname, specifier.replace(/\.js$/, '.ts'));
      expect([specifier, existsSync(resolved)]).toEqual([specifier, true]);
    }
  });
});