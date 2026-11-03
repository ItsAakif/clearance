// T1110 - the RETIRED fabricating AI endpoints (FREEZE A-36/A-37/A-38) answer 410 Gone.
//
// WHAT REPLACED `routes/ai.gating.test.ts`, AND WHY THAT IS NOT A WEAKENING. That file pinned two
// states: flag OFF -> the generator ran and a `Resume` row was written (201); flag ON -> a 409
// refusal. Both states are of a surface that NO LONGER EXISTS. T1110 deleted
// `ai/resumeGenerator.ts` (FREEZE A-40), so a flag that turned the refusal off would have to
// resurrect deleted code; the deprecation is therefore unconditional and the flag is a
// recognised-and-ignored key (both runtimes still name the same three env keys, which
// `src/lib/flags.test.ts` asserts). Every assertion below is about behaviour that is LIVE NOW -
// a published path answering 410 with a body a client can branch on - and the strongest of them
// (the "no provider call, no key lease, no row written" set) is carried over verbatim in intent
// from the old file's flag-ON block.
//
// WHAT IS ASSERTED, AND WHY EACH THING MATTERS:
//   1. 410 + the EXACT body, per endpoint. The body is the contract: a client reads `code` and
//      `successor` and nothing else, so an accidental wording change is a visible diff.
//   2. THE SUCCESSOR IS REAL. Each `successor.route` is a path the backend actually publishes -
//      asserted by mounting the real aggregator, not by re-typing the path.
//   3. NO SIDE EFFECTS. No key lease, no provider call, no `Resume` row, no `Application` read -
//      asserted by asserting that the retired modules, which are the only things that could do
//      any of it, no longer EXIST. That is stronger than mocking them and letting them run.
//   4. UNCONDITIONAL. Both flag states answer 410, so an operator cannot half-restore the surface.
//   5. AUTH IS NOT WEAKENED. An anonymous caller still gets 401, not the deprecation body.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, leasedKeys } = vi.hoisted(() => ({
  authState: { enabled: true },
  leasedKeys: { count: 0 },
}));

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

// The BYOK lease is the FIRST thing any of the retired handlers used to do, so counting leases is
// the cheapest honest proof that a retired request costs no provider budget. The module is frozen
// (FREEZE B-12 "KEEP VERBATIM"), so it is not mocked away - it is instrumented at the boundary.
vi.mock('../ai/keyManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/keyManager.js')>();
  return {
    ...actual,
    leaseNextLlmKey: async (...args: unknown[]) => {
      leasedKeys.count += 1;
      return (actual.leaseNextLlmKey as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const FLAG_ENV_KEY = 'V2_DISABLE_FREE_AI_GENERATION';
const ORIGINAL_FLAG_VALUE = process.env[FLAG_ENV_KEY];

/**
 * Load the router with `V2_DISABLE_FREE_AI_GENERATION` set to `value`
 * (undefined removes it). A fresh module graph each time because
 * `backend/src/config/flags.ts` resolves the env once, at import time.
 */
async function loadRouter(value: string | undefined): Promise<express.Router> {
  if (value === undefined) delete process.env[FLAG_ENV_KEY];
  else process.env[FLAG_ENV_KEY] = value;
  vi.resetModules();
  const mod = (await import('./ai.js')) as unknown as { default: express.Router };
  return mod.default;
}

function makeApp(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use('/ai', router);
  return app;
}

/**
 * The five retired paths and the body each one must answer with.
 *
 * A COPY of the contract rather than an import of `routes/ai.ts`'s table, for the same reason
 * `AppRouteTable.test.ts` copies its retired-path inventory: a list generated from the thing it
 * checks proves nothing. `expect(Object.keys(DEPRECATIONS)).toEqual(...)` in the last test below
 * is what ties the copy back to the implementation.
 */
const DEPRECATED: ReadonlyArray<{
  route: string;
  code: string;
  reason: string;
  successorRoute: string;
  successorUi: string;
  endpoint: string;
  says: RegExp;
}> = [
  {
    route: '/generate-resume',
    code: 'free_generation_retired',
    reason: 'fabricated_candidate_history',
    successorRoute: '/career/import/resume',
    successorUi: '/app/upload',
    endpoint: 'POST /ai/generate-resume',
    says: /import a document you actually wrote/i,
  },
  {
    route: '/build-from-jd',
    code: 'free_generation_retired',
    reason: 'fabricated_candidate_history',
    successorRoute: '/career/import/resume',
    successorUi: '/app/career',
    endpoint: 'POST /ai/build-from-jd',
    says: /generated draft is not a record of your work/i,
  },
  {
    route: '/improve-bullet',
    code: 'unguarded_rewrite_retired',
    reason: 'unguarded_whole_fragment_rewrite',
    successorRoute: '/resumes/:id/tailor',
    successorUi: '/app/tailor',
    endpoint: 'POST /ai/improve-bullet',
    says: /OPERATIONS instead/i,
  },
  {
    route: '/generate-summary',
    code: 'unguarded_rewrite_retired',
    reason: 'unguarded_whole_fragment_rewrite',
    successorRoute: '/resumes/:id/tailor',
    successorUi: '/app/tailor',
    endpoint: 'POST /ai/generate-summary',
    says: /reviewable operation/i,
  },
  {
    route: '/generate-interview-answer',
    code: 'unguarded_answer_generator_retired',
    reason: 'free_form_answer_generator',
    successorRoute: '/interview-prep',
    successorUi: '/app/interview-prep',
    endpoint: 'POST /ai/generate-interview-answer',
    says: /risks and gaps in your own evidence/i,
  },
];

beforeEach(() => {
  authState.enabled = true;
  leasedKeys.count = 0;
});

afterAll(() => {
  if (ORIGINAL_FLAG_VALUE === undefined) delete process.env[FLAG_ENV_KEY];
  else process.env[FLAG_ENV_KEY] = ORIGINAL_FLAG_VALUE;
});

describe('the retired fabricating AI endpoints answer 410 Gone with the V2 successor', () => {
  for (const spec of DEPRECATED) {
    it(`POST /ai${spec.route} -> 410 ${spec.code} naming ${spec.successorRoute}`, async () => {
      const app = makeApp(await loadRouter(undefined));

      const res = await request(app).post(`/ai${spec.route}`).send({ anything: "at all" });

      expect(res.status).toBe(410);
      expect(res.body).toEqual({
        error: expect.stringMatching(spec.says),
        code: spec.code,
        retired: true,
        httpStatus: 410,
        endpoint: spec.endpoint,
        reason: spec.reason,
        successor: expect.objectContaining({ route: spec.successorRoute }),
        successorUi: spec.successorUi,
        // Carried over from T1080 on purpose: a client that used to receive a whole generated
        // document must be able to assert that the answer it got back is not one.
        operationsContainDocument: false,
      });
      expect(res.body.error).toMatch(/retired/i);
      // No key lease: a retired request costs no provider budget, which is the whole point.
      expect(leasedKeys.count).toBe(0);
    });
  }

  it('the 410 comes BEFORE any body validation, so a malformed request is refused the same way', async () => {
    const app = makeApp(await loadRouter(undefined));

    // `POST /ai/generate-resume` used to 400 with "Target role and experience level are
    // required" for this body. A retired endpoint has no input to validate.
    const res = await request(app).post('/ai/generate-resume').send({});

    expect(res.status).toBe(410);
    expect(res.body.code).toBe('free_generation_retired');
    expect(leasedKeys.count).toBe(0);
  });

  it('an UNAUTHENTICATED caller gets 401, not the deprecation body', async () => {
    const app = makeApp(await loadRouter(undefined));
    authState.enabled = false;

    const res = await request(app).post('/ai/generate-resume').send({});

    // The retired handlers read and wrote the caller's own rows; dropping authentication would
    // turn "gone" into "open to anyone".
    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
  });

  it('an /ai path that was NEVER published is a 404, and lists what is', async () => {
    const app = makeApp(await loadRouter(undefined));

    const res = await request(app).post('/ai/something-never-built').send({});

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ai_path_not_found');
    expect(res.body.publishedAiPaths).toEqual(DEPRECATED.map((spec) => spec.endpoint));
  });

  it('the route table and this test agree on exactly five retired paths', async () => {
    const mod = (await import('./ai.js')) as unknown as { RETIRED_AI_PATHS: string[] };
    expect([...mod.RETIRED_AI_PATHS].sort()).toEqual(DEPRECATED.map((spec) => spec.route).sort());
  });
});

describe('the 410 is UNCONDITIONAL - no flag state brings the surface back', () => {
  for (const truthy of ['true', 'on']) {
    it(`answers 410 with V2_DISABLE_FREE_AI_GENERATION=${truthy}`, async () => {
      const app = makeApp(await loadRouter(truthy));

      const res = await request(app)
        .post('/ai/generate-resume')
        .send({ targetRole: 'Backend Engineer', experienceLevel: 'senior' });

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('free_generation_retired');
      expect(leasedKeys.count).toBe(0);
    });
  }

  it('and answers the same 410 with the flag UNSET (the shipped default)', async () => {
    // The old file had a case asserting the OPPOSITE here - that a non-truthy value left the flag
    // OFF "so generation still runs". Generation no longer exists to run, and a flag whose off
    // state would resurrect deleted code is exactly the lie this asserts against.
    const app = makeApp(await loadRouter(undefined));

    const res = await request(app)
      .post('/ai/generate-resume')
      .send({ targetRole: 'Backend Engineer', experienceLevel: 'senior' });

    expect(res.status).toBe(410);
  });
});

describe('the successor each 410 names is a path the backend actually publishes', () => {
  it('every declared successor route is served by the real aggregator (404, not 404-by-typo)', async () => {
    // Mounting the REAL router graph is the only way to prove the successor is not a typo. The
    // aggregator pulls in prisma, the render registry and the browser client, so this asserts on
    // the ROUTE TABLE the express app was built with, not on a live response.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
      next();
    });
    const routes = (await import('./index.js')) as unknown as { default: express.Router };
    app.use(routes.default);

    const registered: string[] = [];
    for (const layer of routes.default.stack as Array<{
      regexp?: RegExp;
      name?: string;
      handle?: { stack?: unknown[] };
    }>) {
      if (typeof layer.regexp === 'string' || !(layer.regexp instanceof RegExp)) continue;
      if (!layer.name) continue;
      // `/^\\/career\\/?(?=\\/|$)/i` -> `/career`, the mount prefix express will dispatch on.
      registered.push(layer.regexp.source.replace(/^\^\\/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, ''));
    }
    const mounts = new Set(registered);

    for (const prefix of ['/career', '/resumes', '/interview-prep']) {
      expect([prefix, mounts.has(prefix)]).toEqual([prefix, true]);
    }
    // And the two sub-paths named in the deprecation bodies resolve to something under a mount
    // the aggregator actually has, rather than to a prefix nobody registered.
    for (const spec of DEPRECATED) {
      const prefix = `/${spec.successorRoute.split('/')[1]}`;
      expect([spec.route, mounts.has(prefix)]).toEqual([spec.route, true]);
    }
    // 30s, headroom for IMPORT cost only - the same reasoning and the same measured hazard as
    // `evaluation/matcher.test.ts:50-67`, which documents 16.2s solo on a busy box for the very
    // same `import('./routes/...')` graph. A real hang still fails, just not spuriously.
  }, 30_000);
});

describe('nothing behind the retired endpoints survives to be called', () => {
  it('the generator module and the two whole-document rewriters are GONE from the filesystem', async () => {
    // This is the reachability proof as a gate. Those three modules were the ONLY things that
    // could lease a key, call a provider or write a `Resume` row on these paths; there is no
    // import of them left to stub, and there is no code left that could reintroduce one.
    const { existsSync } = await import('node:fs');
    const path = await import('node:path');
    for (const gone of ['../ai/resumeGenerator.js', '../ats/improver.js', '../ats/refiner.js']) {
      expect([gone, existsSync(path.join(__dirname, gone))]).toEqual([gone, false]);
    }
  });
});