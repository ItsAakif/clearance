// T783 route tests - the search flow publishes the orchestrator's evaluation
// summary into the run snapshot AFTER persistence, additively.
//
// - GET /search and GET /scan items keep their EXACT pre-existing key set
//   (no field lost, none renamed, none added on the deterministic path);
// - the snapshot gains `evaluation` (zeros on the fast+deterministic legacy
//   path: zero AI calls, zero estimate) while every pre-existing snapshot
//   field stays intact;
// - the search path never touches the JobEvaluation model (no auto-apply,
//   no background evaluation: evaluation happens inside the request).
//
// NOTE on fixtures: `prismaMocks` deliberately has NO `jobEvaluation` (and
// no `company`) model mock. The search flow must stay on the boards-only
// path and must never persist evaluations; if it tries, these tests fail
// with a 500 instead of a 200.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { prismaMocks, runSourceMock, seedMock, healthMocks } = vi.hoisted(() => ({
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
  runSourceMock: vi.fn(),
  seedMock: vi.fn(),
  healthMocks: { recordSourceSuccess: vi.fn(), recordSourceFailure: vi.fn() },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

vi.mock('../jobSources/defaultBoards.js', () => ({
  seedDefaultBoardsForUser: (...args: any[]) => seedMock(...args),
}));

vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

vi.mock('../jobSources/sourceHealth.js', () => ({
  recordSourceSuccess: (...args: any[]) => healthMocks.recordSourceSuccess(...args),
  recordSourceFailure: (...args: any[]) => healthMocks.recordSourceFailure(...args),
}));

import jobsRouter from './jobs.js';
import { resetRunsForTests, getRun } from '../jobSources/discoveryRuns.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

function boardRow(overrides: Record<string, any> = {}) {
  return {
    id: 'board-1',
    name: 'Board One',
    type: 'json',
    boardId: null,
    feedUrl: 'https://remotive.com/api/remote-jobs',
    searchQuery: null,
    searchSite: null,
    scraperProvider: null,
    scraperLocation: null,
    scraperResults: null,
    scraperUseProxy: false,
    aggregatorProvider: null,
    aggregatorLocation: null,
    ...overrides,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

// Descriptions clear the pipeline's 50-char evaluability gate so the
// collected set is fully evaluable; titles carry the query token so the
// token-OR post-filter keeps every row.
const JSON_ROWS = [
  {
    externalId: 'json-1',
    source: 'json',
    sourceUrl: 'https://example.com/jobs/1',
    title: 'Backend Engineer',
    company: 'Acme Corp',
    location: 'Berlin',
    description:
      'Build backend Engineer APIs with Postgres and Docker for a growing platform team in Berlin.',
    applyUrl: 'https://example.com/jobs/1',
    postedAt: new Date(NOW - DAY_MS),
  },
  {
    externalId: 'json-2',
    source: 'json',
    sourceUrl: 'https://example.com/jobs/2',
    title: 'Frontend Engineer',
    company: 'Acme Corp',
    location: 'Remote',
    description:
      'Build web Engineer UIs with React and TypeScript for a distributed remote-first product team.',
    applyUrl: 'https://example.com/jobs/2',
    postedAt: new Date(NOW - 3 * DAY_MS),
  },
];

// The exact GET /jobs/search item key set (T744 contract): the twelve
// shapeListingResponse keys + the T743 additive cancelled/partial. The
// deterministic evaluation path adds NO per-item key.
const EXPECTED_ITEM_KEYS = new Set([
  'id',
  'source',
  'title',
  'company',
  'location',
  'applyUrl',
  'postedUrl',
  'postedAt',
  'isActive',
  'postedAtSource',
  'dateLabel',
  'sources',
  'cancelled',
  'partial',
]);

// Fast + deterministic legacy path: zero AI calls, zero estimate.
const ZERO_EVALUATION = {
  requested: 0,
  completed: 0,
  skipped: 0,
  estimate: { calls: 0, approxTokens: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRunsForTests();
  prismaMocks.jobListing.findUnique.mockResolvedValue(null);
  prismaMocks.jobListing.upsert.mockImplementation(async ({ create }: any) => ({
    id: `id-${create.source}-${create.externalId}`,
    source: create.source,
    title: create.title,
    company: create.company,
    location: create.location,
    applyUrl: create.applyUrl,
    sourceUrl: create.sourceUrl,
    postedAt: create.postedAt ?? null,
    isActive: true,
  }));
  prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow()]);
  runSourceMock.mockImplementation(async () => [...JSON_ROWS]);
});

describe('T783 - /search publishes the evaluation summary post-persist', () => {
  it('items keep every field (none lost or renamed) and the snapshot carries the summary', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', runId: 'eval-run-0001' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    for (const item of res.body) {
      expect(new Set(Object.keys(item))).toEqual(EXPECTED_ITEM_KEYS);
      expect(item).toMatchObject({ cancelled: false, partial: false });
    }

    // Persistence happened first (the summary attaches to stored rows).
    expect(prismaMocks.jobListing.upsert).toHaveBeenCalledTimes(2);

    const snap = getRun('eval-run-0001', 'user-1');
    expect(snap).toBeDefined();
    expect(snap!.finishedAt).toBeTruthy();
    expect(snap!.totalListings).toBe(2);
    expect(snap!.evaluation).toEqual(ZERO_EVALUATION);
  });

  it('a search without a runId is byte-identical in shape to before', async () => {
    const res = await request(makeApp()).get('/jobs/search').query({ q: 'engineer' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const item of res.body) {
      expect(new Set(Object.keys(item))).toEqual(EXPECTED_ITEM_KEYS);
    }
  });
});

describe('T783 - /scan publishes the evaluation summary post-persist', () => {
  it('snapshot carries the summary; items unchanged', async () => {
    const res = await request(makeApp())
      .get('/jobs/scan')
      .query({ query: 'engineer', runId: 'eval-scan-0001' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    for (const item of res.body) {
      expect(new Set(Object.keys(item))).toEqual(EXPECTED_ITEM_KEYS);
    }
    const snap = getRun('eval-scan-0001', 'user-1');
    expect(snap).toBeDefined();
    expect(snap!.evaluation).toEqual(ZERO_EVALUATION);
  });
});

describe('T783 - no evaluation persistence on the search path (N10)', () => {
  it('the search flow has no JobEvaluation seam to call', async () => {
    expect((prismaMocks as any).jobEvaluation).toBeUndefined();
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', runId: 'eval-n10-0001' });
    expect(res.status).toBe(200);
    expect((prismaMocks as any).jobEvaluation).toBeUndefined();
  });
});
