// =====================================================================================
// routes/index.mount-order.test.ts - WHICH ROUTER ANSWERS A PATH, proven from the table (T1052).
//
// THE DEFECT THIS PINS. `routes/index.ts` mounted `matchesRoutes` at `/jobs` BEFORE the legacy
// discovery router, on the reasoning that the two path sets were disjoint: "no legacy route ends
// in `/match`". That is true of `POST /jobs/:id/match` and it says nothing about the other route
// `matches.ts` carries - `GET /:id`, which at the `/jobs` prefix is a one-segment CATCH-ALL. It
// therefore answered every one-segment GET under `/jobs`: `/evaluations` (the job-evaluation
// ranking read path), `/search`, `/scan`, `/full-scan`, `/locations`, and `GET /jobs/:id`, the
// job detail read. Each was routed into `getMatchReport(userId, 'evaluations')` and answered 404.
//
// WHY A ROUTE-TABLE TEST AND NOT AN HTTP TEST. The failure is not a handler that computes the
// wrong answer; it is that the wrong HANDLER is reachable, which happens before any handler runs.
// An HTTP test can only observe it as "a 404 with this body", which is indistinguishable from a
// legitimate 404 unless the service behind it is mocked into saying something else - and the mock
// would be the assertion. So this resolves the route TABLE: for a path and a method it walks
// `router.stack` exactly the way express does (first layer whose matcher accepts the path AND
// whose route declares the method wins) and reports WHICH MODULE that layer came from.
//
// THE RESOLVER USES EXPRESS'S OWN MATCHER (`Layer#match`), not a hand-rolled one, and it reads the
// matched prefix back off the layer, so it cannot drift from express's dispatch on a mount it did
// not anticipate. It resolves the first matching layer and does not model a handler that calls
// `next()`: that is deliberate, because "which route claims this path first" IS the shadowing
// question, and every route in this repo terminates its own request.
//
// Two assertions at the bottom guard the guard: a path nothing claims resolves to `null` (so the
// resolver is not matching everything) and a path claimed by exactly one router resolves to it.
// =====================================================================================

import { describe, expect, it } from 'vitest';

import apiRoutes from './index.js';
import interviewPrepRoutes from './interview-prep.js';
import jobsAnalyzeRoutes from './jobs.analyze.js';
import jobsRoutes from './jobs.js';
import matchesRoutes from './matches.js';
import resumeV2Routes from './resumes.js';

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/** The slice of an express `Layer` this test reads. Untyped on purpose (see the header). */
interface LayerLike {
  /** Express's own matcher. Returns true and records the matched PREFIX on `path`. */
  match(path: string): boolean;
  /** Set by `match()` to the prefix it consumed. `/jobs` for a `use('/jobs', ...)` layer. */
  path?: string;
  /** Present on a route layer (`router.get('/x', ...)`), absent on a mount or bare middleware. */
  route?: { path: string; methods: Record<string, boolean | undefined> };
  /** A mounted sub-router, or the middleware function for a bare layer. */
  handle: { stack?: LayerLike[] } | ((...args: never[]) => unknown);
}

export interface Resolved {
  /** The mount prefix the winning route was reached through, e.g. `/jobs`. */
  readonly mount: string;
  /** The route's own path pattern, e.g. `/evaluations` or `/:id`. */
  readonly pattern: string;
  readonly method: string;
  /** Which module the winning layer belongs to. */
  readonly owner: string;
}

/**
 * The module each mounted router is, so an assertion can name it. Identity of the router OBJECT
 * is the join: `routes/index.ts` imports these exact instances, so this cannot drift from the
 * mounts the way a string would.
 */
const OWNERS: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  [jobsRoutes, 'jobs.ts'],
  [matchesRoutes, 'matches.ts'],
  [jobsAnalyzeRoutes, 'jobs.analyze.ts'],
  [resumeV2Routes, 'resumes.ts'],
  [interviewPrepRoutes, 'interview-prep.ts'],
]);

/** The first layer that would answer `method path`, or `null` if nothing claims it. */
function resolve(
  layers: LayerLike[],
  path: string,
  method: string,
  mount: string,
  owner: string,
): Resolved | null {
  const verb = method.toLowerCase();
  for (const layer of layers) {
    if (layer.route !== undefined) {
      if (layer.match(path) === true && layer.route.methods[verb] === true) {
        return { mount, pattern: layer.route.path, method, owner };
      }
      continue;
    }
    const nested = (layer.handle as { stack?: LayerLike[] }).stack;
    // A bare middleware (`app.use(express.json())`) has no stack and cannot shadow a route.
    if (nested === undefined) continue;
    if (layer.match(path) !== true) continue;
    // `match()` recorded the prefix it consumed, which is the same `trim_prefix` slice express
    // itself performs before descending. Reading it back means a PARAMETRIC mount needs no
    // special case here and the resolver cannot disagree with express about where the prefix ends.
    const prefix = layer.path ?? '';
    const rest = path.slice(prefix.length);
    const child = OWNERS.get(layer.handle) ?? owner;
    const hit = resolve(nested, rest === '' ? '/' : rest, method, `${mount}${prefix}`, child);
    if (hit !== null) return hit;
  }
  return null;
}

function claimed(path: string, method: string): Resolved {
  const hit = resolve(apiRoutes.stack as unknown as LayerLike[], path, method, '', 'index.ts');
  if (hit === null) throw new Error(`no route claims ${method.toUpperCase()} ${path}`);
  return hit;
}

// ---------------------------------------------------------------------------
// The routes that were shadowed
// ---------------------------------------------------------------------------

describe('GET /jobs/evaluations and its siblings reach jobs.ts, not the match catch-all', () => {
  it('resolves GET /jobs/evaluations to jobs.ts `/evaluations`', () => {
    const hit = claimed('/jobs/evaluations', 'get');
    expect(hit.owner).toBe('jobs.ts');
    expect(hit.pattern).toBe('/evaluations');
    expect(hit.mount).toBe('/jobs');
    // The negative, stated directly: the layer that answers is not `matches.ts`'s `/:id`.
    expect(hit.owner === 'matches.ts' && hit.pattern === '/:id').toBe(false);
  });

  it('resolves every one-segment GET literal under /jobs to jobs.ts', () => {
    // The whole family, because the defect was never about the word `evaluations`: it was about
    // a catch-all winning a one-segment GET. Each of these was a 404 for the same reason.
    for (const literal of ['evaluations', 'search', 'scan', 'full-scan', 'locations']) {
      const hit = claimed(`/jobs/${literal}`, 'get');
      expect(hit.owner, literal).toBe('jobs.ts');
      expect(hit.pattern, literal).toBe(`/${literal}`);
    }
  });

  it('resolves GET /jobs/:id to the JOB DETAIL, which the catch-all also answered', () => {
    // Same defect, and the more consequential of the two: the job detail read was unreachable
    // for any id, because `matches.ts` looked up a MatchReport named after the job id.
    const hit = claimed('/jobs/8f1c2a20-0000-4000-8000-000000000001', 'get');
    expect(hit.owner).toBe('jobs.ts');
    expect(hit.pattern).toBe('/:id');
  });
});

// ---------------------------------------------------------------------------
// The routes that must NOT have been shadowed by the reorder
// ---------------------------------------------------------------------------

describe('the match routes still resolve after the reorder', () => {
  it('POST /jobs/:id/match falls through jobs.ts to matches.ts', () => {
    // The half of the fix that could have gone wrong. `jobs.ts` is now mounted FIRST and its
    // POSTs are `/normalize`, `/:id/normalize`, `/:id/evaluate` and `/runs/:runId/cancel` -
    // none of which is two segments ending in `/match`, so this reaches matches.ts.
    const hit = claimed('/jobs/job-1/match', 'post');
    expect(hit.owner).toBe('matches.ts');
    expect(hit.pattern).toBe('/:id/match');
  });

  it('both potential-match decisions resolve to matches.ts at the /jobs prefix', () => {
    for (const action of ['confirm', 'reject']) {
      const hit = claimed(`/jobs/report-1/potential/pm-1/${action}`, 'post');
      expect(hit.owner, action).toBe('matches.ts');
      expect(hit.pattern, action).toBe('/:id/potential/:pmId/' + action);
    }
  });

  it('GET /matches/:id and the /matches decisions are untouched by the /jobs ordering', () => {
    // A different prefix, mounted once: the reorder cannot reach it, and this says so.
    expect(claimed('/matches/report-1', 'get').owner).toBe('matches.ts');
    expect(claimed('/matches/report-1/potential/pm-1/confirm', 'post').owner).toBe('matches.ts');
    expect(claimed('/matches/report-1/potential/pm-1/reject', 'post').owner).toBe('matches.ts');
  });

  it('the analysis router still resolves its own two paths', () => {
    expect(claimed('/jobs/analyze', 'post').owner).toBe('jobs.analyze.ts');
    expect(claimed('/jobs/job-1/analysis', 'get').owner).toBe('jobs.analyze.ts');
  });
});

// ---------------------------------------------------------------------------
// The resolver's own honesty
// ---------------------------------------------------------------------------

describe('the resolver is not simply matching everything', () => {
  it('a path nothing claims resolves to null', () => {
    // Without this the assertions above could pass against a resolver that returns the first
    // layer of the stack regardless of the path, which is the failure mode a hand-rolled
    // route-table test always has.
    const stack = apiRoutes.stack as unknown as LayerLike[];
    expect(resolve(stack, '/jobs/a/b/c/d/e', 'get', '', 'index.ts')).toBeNull();
    expect(resolve(stack, '/nothing-here', 'get', '', 'index.ts')).toBeNull();
    // Right path, wrong method: nothing claims `DELETE /jobs/evaluations`.
    expect(resolve(stack, '/jobs/evaluations', 'delete', '', 'index.ts')).toBeNull();
  });

  it('a two-segment path under another prefix still resolves through its own mount', () => {
    // The prefix arithmetic is the part a hand-rolled resolver gets wrong, so it is checked on
    // mounts that are not the one under repair. `/resumes` additionally proves that the legacy
    // builder router (mounted first at that prefix, with its own `GET /:id`) does not shadow the
    // V2 document download - the same one-segment-vs-two-segment trap, in the other direction.
    expect(claimed('/resumes/res-1/documents/doc-1', 'get').owner).toBe('resumes.ts');
    expect(claimed('/interview-prep/res-1', 'get').owner).toBe('interview-prep.ts');
  });
});