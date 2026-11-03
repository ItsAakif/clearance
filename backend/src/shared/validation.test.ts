import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import {
  JOB_SOURCE_VALUES,
  jobSearchSchema,
  jobSourceEnum,
  savedSearchCreateSchema,
  savedSearchUpdateSchema,
  createJobAlertSchema,
  updateJobAlertSchema,
  NO_SEARCH_CRITERIA_MESSAGE,
  FULL_MODE_NOT_PERSISTABLE_CODE,
  FULL_MODE_NOT_PERSISTABLE_MESSAGE,
  FullModeNotPersistableError,
  intentCarriesCriteria,
  validateInput,
} from './validation.js';
import { searchIntentSchema, deriveIntent } from '../discovery/searchIntent.js';

const { prismaMocks, runSourceMock, seedMock, healthMocks } = vi.hoisted(() => ({
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { upsert: vi.fn(), update: vi.fn() },
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

import jobsRouter from '../routes/jobs.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

describe('jobSearchSchema source validation (T308)', () => {
  // Keep in step with SOURCES in src/pages/Jobs.tsx (frontend, T310): any
  // source value offered by the frontend filter must appear here, and any
  // value here must be offered there. This pins the documented 25-value list
  // exactly so drift in either direction fails loudly.
  // (Wave 4, T681: grown additively by workable, bamboohr, breezyhr,
  // jobvite; T682: grown additively by teamtailor, pinpoint, freshteam;
  // T683: grown additively by career-page; Wave 5, T702: grown additively
  // by dorking; Wave 6, T724: grown additively by browser - existing ids
  // keep their positions.)
  it('JOB_SOURCE_VALUES exactly equals the documented 27-value list', () => {
    expect([...JOB_SOURCE_VALUES]).toEqual([
      'greenhouse', 'ashby', 'lever', 'workday', 'rss', 'json', 'smartrecruiters', 'recruitee',
      'personio', 'jobicy', 'hnalgolia', 'adzuna', 'usajobs', 'reed', 'findwork',
      'workable', 'bamboohr', 'breezyhr', 'jobvite',
      'teamtailor', 'pinpoint', 'freshteam', 'career-page', 'search', 'scraper',
      'dorking', 'browser',
    ]);
    expect(JOB_SOURCE_VALUES).toHaveLength(27);
  });

  it('jobSourceEnum accepts every JOB_SOURCE_VALUES entry', () => {
    for (const value of JOB_SOURCE_VALUES) {
      expect(jobSourceEnum.safeParse(value).success).toBe(true);
    }
  });

  it('jobSearchSchema accepts each source value and a comma-joined subset', () => {
    for (const value of JOB_SOURCE_VALUES) {
      const parsed = jobSearchSchema.safeParse({ q: 'engineer', sources: [value] });
      expect(parsed.success).toBe(true);
    }
    const subset = ['json', 'jobicy', 'adzuna', 'search', 'scraper'];
    const parsed = jobSearchSchema.safeParse({ q: 'engineer', sources: subset });
    expect(parsed.success).toBe(true);
  });

  it("rejects 'nonsense' as a source", () => {
    const parsed = jobSearchSchema.safeParse({ q: 'engineer', sources: ['nonsense'] });
    expect(parsed.success).toBe(false);
  });

  it("accepts postedWithin 'day' and rejects 'year'", () => {
    expect(jobSearchSchema.safeParse({ q: 'engineer', postedWithin: 'day' }).success).toBe(true);
    expect(jobSearchSchema.safeParse({ q: 'engineer', postedWithin: 'week' }).success).toBe(true);
    expect(jobSearchSchema.safeParse({ q: 'engineer', postedWithin: 'month' }).success).toBe(true);
    expect(jobSearchSchema.safeParse({ q: 'engineer', postedWithin: 'year' }).success).toBe(false);
  });

  it("runId accepts 'abcdefgh' and rejects 'short' and a 65-char value", () => {
    expect(jobSearchSchema.safeParse({ q: 'engineer', runId: 'abcdefgh' }).success).toBe(true);
    expect(jobSearchSchema.safeParse({ q: 'engineer', runId: 'short' }).success).toBe(false);
    expect(jobSearchSchema.safeParse({ q: 'engineer', runId: 'a'.repeat(65) }).success).toBe(false);
    expect(jobSearchSchema.safeParse({ q: 'engineer', runId: 'a'.repeat(64) }).success).toBe(true);
  });
});

describe('GET /jobs/search param validation (T308)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.jobBoard.findMany.mockResolvedValue([]);
    runSourceMock.mockResolvedValue([]);
    prismaMocks.jobListing.upsert.mockImplementation(async ({ create }: any) => ({
      id: `id-${create.source}-${create.externalId}`,
      source: create.source,
      title: create.title,
      company: create.company,
      location: create.location,
      applyUrl: create.applyUrl,
      sourceUrl: create.sourceUrl,
      postedAt: null,
      isActive: true,
    }));
  });

  it('accepts all 25 source values as a comma-joined list', async () => {
    const res = await request(makeApp()).get(
      `/jobs/search?q=engineer&sources=${[...JOB_SOURCE_VALUES].join(',')}`,
    );
    expect(res.status).toBe(200);
  });

  it('rejects an unknown source with 400', async () => {
    const res = await request(makeApp()).get('/jobs/search?q=engineer&sources=json,nonsense');
    expect(res.status).toBe(400);
  });

  it('rejects an invalid postedWithin with 400 and accepts day/week/month', async () => {
    const bad = await request(makeApp()).get('/jobs/search?q=engineer&postedWithin=year');
    expect(bad.status).toBe(400);
    for (const window of ['day', 'week', 'month']) {
      const ok = await request(makeApp()).get(`/jobs/search?q=engineer&postedWithin=${window}`);
      expect(ok.status).toBe(200);
    }
  });

  it('rejects an invalid runId with 400 and accepts a valid one', async () => {
    const bad = await request(makeApp()).get('/jobs/search?q=engineer&runId=bad!!');
    expect(bad.status).toBe(400);
    const short = await request(makeApp()).get('/jobs/search?q=engineer&runId=short');
    expect(short.status).toBe(400);
    const ok = await request(makeApp()).get('/jobs/search?q=engineer&runId=abcdefgh');
    expect(ok.status).toBe(200);
  });
});

describe('JOB_SOURCE_VALUES registry derivation (T623, ADR-025)', () => {
  it('equals allSourceIds() exactly (membership AND order)', async () => {
    const { allSourceIds } = await import('../jobSources/providerRegistry.js');
    expect([...JOB_SOURCE_VALUES]).toEqual([...allSourceIds()]);
    expect(JOB_SOURCE_VALUES).toHaveLength(27);
  });

  it('jobSearchSchema still accepts 27 sources and rejects 28', () => {
    const twentyFive = [...JOB_SOURCE_VALUES];
    expect(jobSearchSchema.safeParse({ q: 'engineer', sources: twentyFive }).success).toBe(true);
    expect(
      jobSearchSchema.safeParse({ q: 'engineer', sources: [...twentyFive, twentyFive[0]] }).success,
    ).toBe(false);
  });
});

describe('Wave 12 (T842): optional intent on saved-search and alert schemas', () => {
  // A criteria-bearing intent with NO `query` text (roles/skills only), one
  // carrying only a location, and the empty intent - all built through wave
  // 7's own schema so the fixtures are valid by construction.
  const criteriaIntent = searchIntentSchema.parse({ roles: ['frontend'], skills: ['react'] });
  const locationIntent = searchIntentSchema.parse({ locations: ['Berlin'] });
  const emptyIntent = searchIntentSchema.parse({});
  const derivedIntent = deriveIntent({ query: 'senior frontend engineer remote -php' });

  it('intentCarriesCriteria is the single shared predicate', () => {
    expect(intentCarriesCriteria(undefined)).toBe(false);
    expect(intentCarriesCriteria(emptyIntent)).toBe(false);
    expect(intentCarriesCriteria(criteriaIntent)).toBe(true);
    expect(intentCarriesCriteria(locationIntent)).toBe(true);
    expect(intentCarriesCriteria(derivedIntent)).toBe(true);
  });

  it('legacy saved-search payload without intent validates unchanged', () => {
    const payload = {
      name: 'S',
      query: 'frontend',
      location: ['Remote', 'Berlin'],
      company: 'Acme',
      boards: ['board-1'],
    };
    const parsed = savedSearchCreateSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(payload);
  });

  it('legacy alert payload without intent validates unchanged', () => {
    const payload = {
      name: 'A',
      query: 'frontend',
      location: 'Remote',
      sources: ['rss'],
      remoteOnly: true,
    };
    const parsed = createJobAlertSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(payload);
  });

  it('a criteria-bearing intent with no query validates (both create schemas)', () => {
    expect(savedSearchCreateSchema.safeParse({ name: 'S', intent: criteriaIntent }).success).toBe(true);
    expect(createJobAlertSchema.safeParse({ name: 'A', intent: criteriaIntent }).success).toBe(true);
    expect(savedSearchCreateSchema.safeParse({ name: 'S', intent: locationIntent }).success).toBe(true);
    expect(createJobAlertSchema.safeParse({ name: 'A', intent: derivedIntent }).success).toBe(true);
  });

  it('a criteria-bearing intent with an empty query validates', () => {
    expect(
      savedSearchCreateSchema.safeParse({ name: 'S', query: '', intent: criteriaIntent }).success,
    ).toBe(true);
    expect(
      createJobAlertSchema.safeParse({ name: 'A', query: '', intent: criteriaIntent }).success,
    ).toBe(true);
  });

  it('a usable query with an empty intent stays accepted (additive)', () => {
    expect(
      savedSearchCreateSchema.safeParse({ name: 'S', query: 'frontend', intent: emptyIntent }).success,
    ).toBe(true);
    expect(
      createJobAlertSchema.safeParse({ name: 'A', query: 'frontend', intent: emptyIntent }).success,
    ).toBe(true);
  });

  it('neither a usable query nor an intent is rejected (both create schemas)', () => {
    expect(savedSearchCreateSchema.safeParse({ name: 'S' }).success).toBe(false);
    expect(createJobAlertSchema.safeParse({ name: 'A' }).success).toBe(false);
  });

  it('an empty intent with no usable query is rejected with the documented error', () => {
    const cases: Array<{ schema: z.ZodTypeAny; name: string }> = [
      { schema: savedSearchCreateSchema, name: 'S' },
      { schema: createJobAlertSchema, name: 'A' },
    ];
    const payloads: unknown[] = [
      { intent: emptyIntent },
      { query: '', intent: emptyIntent },
      { query: '   ', intent: emptyIntent },
    ];
    for (const { schema, name } of cases) {
      for (const payload of payloads) {
        const parsed = schema.safeParse({ name, ...(payload as Record<string, unknown>) });
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          const issue = parsed.error.issues.find((i) => i.path.join('.') === 'query');
          expect(issue?.message).toBe(NO_SEARCH_CRITERIA_MESSAGE);
        }
      }
    }
  });

  it('the saved-search legacy min-1 query rejection still holds (asserted)', () => {
    const empty = savedSearchCreateSchema.safeParse({ name: 'S', query: '' });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues).toHaveLength(1);
      expect(empty.error.issues[0].path).toEqual(['query']);
      expect(empty.error.issues[0].message).toBe('String must contain at least 1 character(s)');
    }
    const missing = savedSearchCreateSchema.safeParse({ name: 'S' });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      const issue = missing.error.issues.find((i) => i.path.join('.') === 'query');
      expect(issue?.message).toBe('Required');
    }
  });

  it('legacy query messages are byte-identical (both schemas)', () => {
    const tooLongSearch = savedSearchCreateSchema.safeParse({ name: 'S', query: 'x'.repeat(201) });
    expect(tooLongSearch.success).toBe(false);
    if (!tooLongSearch.success) {
      expect(tooLongSearch.error.issues[0].path).toEqual(['query']);
      expect(tooLongSearch.error.issues[0].message).toBe(
        'String must contain at most 200 character(s)',
      );
    }
    const missingAlert = createJobAlertSchema.safeParse({ name: 'A' });
    expect(missingAlert.success).toBe(false);
    if (!missingAlert.success) {
      expect(missingAlert.error.issues.find((i) => i.path.join('.') === 'query')?.message).toBe(
        'Required',
      );
    }
    const emptyAlert = createJobAlertSchema.safeParse({ name: 'A', query: '' });
    expect(emptyAlert.success).toBe(false);
    if (!emptyAlert.success) {
      expect(emptyAlert.error.issues).toHaveLength(1);
      expect(emptyAlert.error.issues[0].path).toEqual(['query']);
      expect(emptyAlert.error.issues[0].message).toBe('Query is required');
    }
    const tooLongAlert = createJobAlertSchema.safeParse({ name: 'A', query: 'x'.repeat(501) });
    expect(tooLongAlert.success).toBe(false);
    if (!tooLongAlert.success) {
      expect(tooLongAlert.error.issues[0].path).toEqual(['query']);
      expect(tooLongAlert.error.issues[0].message).toBe('Query too long');
    }
    const numericSearch = savedSearchCreateSchema.safeParse({ name: 'S', query: 123 });
    expect(numericSearch.success).toBe(false);
    if (!numericSearch.success) {
      expect(numericSearch.error.issues[0].path).toEqual(['query']);
      expect(numericSearch.error.issues[0].message).toBe('Expected string, received number');
    }
    const numericAlert = createJobAlertSchema.safeParse({ name: 'A', query: 123 });
    expect(numericAlert.success).toBe(false);
    if (!numericAlert.success) {
      expect(numericAlert.error.issues[0].path).toEqual(['query']);
      expect(numericAlert.error.issues[0].message).toBe('Expected string, received number');
    }
  });

  it('an over-cap intent fails with the wave-7 message, not a local limit', () => {
    const tooManyRoles = { roles: Array(11).fill('engineer') };
    const direct = searchIntentSchema.safeParse(tooManyRoles);
    expect(direct.success).toBe(false);
    const viaSearch = savedSearchCreateSchema.safeParse({
      name: 'S',
      query: 'engineer',
      intent: tooManyRoles,
    });
    expect(viaSearch.success).toBe(false);
    if (!viaSearch.success && !direct.success) {
      const viaIssue = viaSearch.error.issues.find((i) => i.path[0] === 'intent');
      expect(viaIssue?.message).toBe(direct.error.issues[0].message);
      expect(viaIssue?.message).toBe('Array must contain at most 10 element(s)');
    }
    const tooManyCompanies = { companies: Array(501).fill('Acme') };
    const viaAlert = createJobAlertSchema.safeParse({
      name: 'A',
      query: 'engineer',
      intent: tooManyCompanies,
    });
    expect(viaAlert.success).toBe(false);
    if (!viaAlert.success) {
      expect(viaAlert.error.issues.find((i) => i.path[0] === 'intent')?.message).toBe(
        'Array must contain at most 500 element(s)',
      );
    }
    const nonObject = savedSearchCreateSchema.safeParse({
      name: 'S',
      query: 'engineer',
      intent: 'nope',
    });
    expect(nonObject.success).toBe(false);
  });

  it('a partial update carrying only a name validates (both update schemas)', () => {
    expect(savedSearchUpdateSchema.safeParse({ name: 'New' }).success).toBe(true);
    expect(updateJobAlertSchema.safeParse({ name: 'New' }).success).toBe(true);
    expect(updateJobAlertSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(savedSearchUpdateSchema.safeParse({ sortBy: 'newest' }).success).toBe(true);
  });

  it('an update accepts a valid intent and stays permissive without criteria', () => {
    expect(
      savedSearchUpdateSchema.safeParse({ name: 'N', intent: criteriaIntent }).success,
    ).toBe(true);
    expect(updateJobAlertSchema.safeParse({ remoteOnly: true, intent: criteriaIntent }).success).toBe(
      true,
    );
    // No criteria rule on updates by design: the stored row (not the patch
    // body) carries the criteria - T843/T844 own that merge.
    expect(updateJobAlertSchema.safeParse({ name: 'N', intent: emptyIntent }).success).toBe(true);
    const overCap = updateJobAlertSchema.safeParse({
      intent: { roles: Array(11).fill('engineer') },
    });
    expect(overCap.success).toBe(false);
  });

  it('an update still rejects a supplied empty query (original min rule)', () => {
    const search = savedSearchUpdateSchema.safeParse({ query: '' });
    expect(search.success).toBe(false);
    if (!search.success) {
      expect(search.error.issues[0].path).toEqual(['query']);
      expect(search.error.issues[0].message).toBe('String must contain at least 1 character(s)');
    }
    const alert = updateJobAlertSchema.safeParse({ query: '' });
    expect(alert.success).toBe(false);
    if (!alert.success) {
      expect(alert.error.issues[0].path).toEqual(['query']);
      expect(alert.error.issues[0].message).toBe('Query is required');
    }
  });

  it('a no-criteria alert fails validateInput with a 400 carrying the documented error', () => {
    let caught: unknown;
    try {
      validateInput(createJobAlertSchema, { name: 'A', intent: emptyIntent });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { statusCode?: number }).statusCode).toBe(400);
    expect((caught as Error).message).toContain(NO_SEARCH_CRITERIA_MESSAGE);
  });

  it('a multi-field legacy failure still rejects with both issues', () => {
    // `{ name: '' }` with no query: the base object reports `name`, and the
    // refinement still runs (refinements run on dirty bases) to add the
    // legacy `query: Required` issue - the same two issues, in the same
    // order, as the pre-wave-12 schema.
    const parsed = savedSearchCreateSchema.safeParse({ name: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toHaveLength(2);
      expect(parsed.error.issues[0].path).toEqual(['name']);
      expect(parsed.error.issues[1].path).toEqual(['query']);
      expect(parsed.error.issues[1].message).toBe('Required');
    }
  });
});

describe('T887 saved-search/alert intent mode persistence vocabulary', () => {
  const standardIntent = searchIntentSchema.parse({ roles: ['backend'], mode: 'standard' });
  const deepIntent = searchIntentSchema.parse({ roles: ['backend'], mode: 'deep' });
  const fullIntent = searchIntentSchema.parse({ roles: ['backend'], mode: 'full' });

  it('accepts standard and deep on every create/update schema', () => {
    for (const intent of [standardIntent, deepIntent]) {
      expect(savedSearchCreateSchema.safeParse({ name: 'S', intent }).success).toBe(true);
      expect(savedSearchUpdateSchema.safeParse({ intent }).success).toBe(true);
      expect(createJobAlertSchema.safeParse({ name: 'A', intent }).success).toBe(true);
      expect(updateJobAlertSchema.safeParse({ intent }).success).toBe(true);
    }
  });

  it('rejects full with one shared coded issue on every create/update schema', () => {
    const cases: Array<{ schema: z.ZodTypeAny; payload: Record<string, unknown> }> = [
      { schema: savedSearchCreateSchema, payload: { name: 'S', intent: fullIntent } },
      { schema: savedSearchUpdateSchema, payload: { intent: fullIntent } },
      { schema: createJobAlertSchema, payload: { name: 'A', intent: fullIntent } },
      { schema: updateJobAlertSchema, payload: { intent: fullIntent } },
    ];
    for (const { schema, payload } of cases) {
      const parsed = schema.safeParse(payload);
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issue = parsed.error.issues.find((candidate) => candidate.path.join('.') === 'intent.mode');
        expect(issue?.message).toBe(FULL_MODE_NOT_PERSISTABLE_MESSAGE);
        expect((issue as (typeof issue & { params?: { code?: string } }))?.params?.code).toBe(
          FULL_MODE_NOT_PERSISTABLE_CODE,
        );
      }
    }
  });

  it('validateInput turns the shared Full issue into a stable coded 400', () => {
    expect(() => validateInput(savedSearchCreateSchema, { name: 'S', intent: fullIntent })).toThrow(
      FullModeNotPersistableError,
    );
    try {
      validateInput(createJobAlertSchema, { name: 'A', intent: fullIntent });
    } catch (error) {
      expect(error).toBeInstanceOf(FullModeNotPersistableError);
      expect((error as FullModeNotPersistableError).statusCode).toBe(400);
      expect((error as FullModeNotPersistableError).code).toBe(FULL_MODE_NOT_PERSISTABLE_CODE);
      expect((error as Error).message).toBe(FULL_MODE_NOT_PERSISTABLE_MESSAGE);
    }
  });
});
