import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Wave 7 (T744) contract pins for the /jobs/search orchestrator port.
//
// STEP 5 (`sources: []` keeps today's meaning) and STEP 4 (legacy request vs
// equivalent intent agreement) are pinned here BEFORE the route changes, so
// the port is reviewable against recorded behaviour.
//
// NOTE on fixtures: `prismaMocks` deliberately has NO `company` model mock
// (mirroring jobs.search-seed.test.ts). The ported route must stay on the
// boards-only path for company (company remains a post-filter, exactly as
// today) and must never touch the company registry; if it does, these tests
// fail with a 500 instead of a 200.

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

// Keep the real boardToConfig so config wiring is exercised; stub only runSource
// so no board network is ever hit.
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
import { dedupeJobs } from '../discovery/dedupe.js';
import { filterAndOrder } from './jobs.js';

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

// Raw per-board rows, in the exact order each board's fetcher returns them.
// Every description deliberately avoids the word "engineer" so the token-OR
// query post-filter scores survivors on title only (score 1 each) and the
// final order is purely postedAt desc.
const JSON_ROWS = [
  {
    externalId: 'json-1',
    source: 'json',
    sourceUrl: 'https://example.com/jobs/1',
    title: 'Backend Engineer',
    company: 'Acme Corp',
    location: 'Berlin',
    description: 'Build backend APIs.',
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
    description: 'Build web UIs.',
    applyUrl: 'https://example.com/jobs/2',
    postedAt: new Date(NOW - 3 * DAY_MS),
  },
  {
    externalId: 'json-3',
    source: 'json',
    sourceUrl: 'https://example.com/jobs/3',
    title: 'Backend Engineer',
    company: 'OtherCo',
    location: 'Berlin',
    description: 'Build backend APIs.',
    applyUrl: 'https://example.com/jobs/3',
    postedAt: new Date(NOW - 2 * DAY_MS),
  },
  {
    externalId: 'json-4',
    source: 'json',
    sourceUrl: 'https://example.com/jobs/4',
    title: 'Backend Engineer',
    company: 'Acme Corp',
    location: 'Paris',
    description: 'Build backend APIs.',
    applyUrl: 'https://example.com/jobs/4',
    postedAt: new Date(NOW - 4 * DAY_MS),
  },
];

const JOBICY_ROWS = [
  {
    externalId: 'jobicy-9',
    source: 'jobicy',
    sourceUrl: 'https://jobicy.com/jobs/9',
    title: 'DevOps Engineer',
    company: 'Acme Corp',
    location: 'Berlin',
    description: 'Run cloud infra.',
    applyUrl: 'https://jobicy.com/jobs/9',
    postedAt: new Date(NOW - 2 * 60 * 60 * 1000),
  },
  {
    externalId: 'jobicy-10',
    source: 'jobicy',
    sourceUrl: 'https://jobicy.com/jobs/10',
    title: 'Java Developer',
    company: 'Acme Corp',
    location: 'Berlin',
    description: 'Spring shop.',
    applyUrl: 'https://jobicy.com/jobs/10',
    postedAt: new Date(NOW - 60 * 60 * 1000),
  },
];

// Transcribed VERBATIM from the pre-port GET /search pipeline
// (routes/jobs.ts): dedupe -> company filter -> source filter ->
// filterAndOrder(q, postedWithin) -> location filter -> limit slice.
// This is the "legacy request" side of the STEP 4 equivalence.
function legacySearchPipeline(all: any[], opts: { q: string; company?: string; sourceTypes?: string[]; locations: string[]; limit: number }) {
  const filtered = filterAndOrder(
    dedupeJobs(all)
      .filter((job) => !opts.company || (job.company || '').toLowerCase().includes(opts.company.toLowerCase()))
      .filter((job) => !opts.sourceTypes || (opts.sourceTypes as string[]).includes(job.source)),
    opts.q,
    undefined,
  );
  const locationFiltered =
    opts.locations.length > 0
      ? filtered.filter((job) => {
          const jobLocation = (job.location || '').toLowerCase();
          return opts.locations.some((needle) => jobLocation.includes(needle.toLowerCase()));
        })
      : filtered;
  return locationFiltered.slice(0, opts.limit);
}

// The exact GET /jobs/search item key set (pre-port contract):
// shapeListingResponse's twelve keys + the T743 additive cancelled/partial.
// `sources` rides every row because dedupeJobs always attaches a non-empty
// union (verified in discovery/dedupe.ts mergeGroup).
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
  prismaMocks.jobBoard.findMany.mockResolvedValue([
    boardRow({ id: 'board-1', name: 'Board One' }),
    boardRow({ id: 'board-2', name: 'Board Two', type: 'jobicy', feedUrl: null }),
  ]);
  runSourceMock.mockImplementation(async (config: any) =>
    config.type === 'jobicy' ? [...JOBICY_ROWS] : [...JSON_ROWS],
  );
});

describe('T744 STEP 5 - explicit sources: [] keeps today\'s meaning', () => {
  it('an explicit empty sources array returns [] with 200 and still searches the boards', async () => {
    // `sources=,,,` parses (String split + Boolean filter) to a real []
    // through the route's own parsing, exercising the validated [] path.
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', sources: ',,,' });
    expect(res.status).toBe(200);
    // Today's meaning: [] is truthy, so the exact-id post-filter
    // (`sourceTypes.includes(job.source)`) drops every row. The boards are
    // still fanned out to (no silent narrowing) - the [] comes from the
    // post-filter, exactly as before.
    expect(res.body).toEqual([]);
    expect(runSourceMock).toHaveBeenCalledTimes(2);
    expect(healthMocks.recordSourceSuccess).toHaveBeenCalledTimes(2);
  });
});

describe('T744 STEP 4 - orchestrated search agrees with the legacy pipeline', () => {
  it('same result set, same order, same response fields (q + company + location + runId)', async () => {
    const res = await request(makeApp())
      .get('/jobs/search')
      .query({ q: 'engineer', company: 'acme', location: ['Berlin', 'Remote'], runId: 'equiv-run-0001' });
    expect(res.status).toBe(200);

    const expected = legacySearchPipeline([...JSON_ROWS, ...JOBICY_ROWS], {
      q: 'engineer',
      company: 'acme',
      sourceTypes: undefined,
      locations: ['Berlin', 'Remote'],
      limit: 30,
    });
    // json-3 (OtherCo) and json-4 (Paris) fall to the company/location
    // filters; jobicy-10 (Java Developer) falls to the token-OR query
    // post-filter. Survivors score 1 each, so postedAt desc rules.
    expect(expected.map((j: any) => j.externalId)).toEqual(['jobicy-9', 'json-1', 'json-2']);

    // Same result set in the same order through the orchestrated path.
    expect(res.body).toHaveLength(expected.length);
    expect(res.body.map((j: any) => `${j.source}/${j.title}/${j.location}`)).toEqual(
      expected.map((j: any) => `${j.source}/${j.title}/${j.location}`),
    );

    // Same response fields: the exact pre-port key set, no rename/removal.
    for (const item of res.body) {
      expect(new Set(Object.keys(item))).toEqual(EXPECTED_ITEM_KEYS);
      expect(item).toMatchObject({ cancelled: false, partial: false });
      expect(Array.isArray(item.sources)).toBe(true);
    }

    // Same persistence + health + run-registry behaviour.
    expect(prismaMocks.jobListing.upsert).toHaveBeenCalledTimes(3);
    expect(healthMocks.recordSourceSuccess).toHaveBeenCalledTimes(2);
    expect(healthMocks.recordSourceFailure).not.toHaveBeenCalled();
    const snap = getRun('equiv-run-0001', 'user-1');
    expect(snap).toBeDefined();
    expect(snap!.finishedAt).toBeTruthy();
    expect(snap!.totalListings).toBe(3);
    expect(snap!.boards).toHaveLength(2);
    for (const b of snap!.boards) expect(b.status).toBe('ok');
  });
});
