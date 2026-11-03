import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks, normalizeJobDescriptionMock } = vi.hoisted(() => ({
  authState: { enabled: true },
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn(), groupBy: vi.fn() },
    resume: { findUnique: vi.fn() },
    aIProviderKey: { findFirst: vi.fn(), findMany: vi.fn() },
    appSetting: { findUnique: vi.fn() },
    careerProfile: { findUnique: vi.fn() },
    jobEvaluation: { create: vi.fn() },
  },
  normalizeJobDescriptionMock: vi.fn(),
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

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

// Keep the pure helpers (cleanDescription, normalizationHash,
// NormalizationError) real; only the LLM boundary is faked.
vi.mock('../ai/jdNormalizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/jdNormalizer.js')>();
  return {
    ...actual,
    normalizeJobDescription: (...args: any[]) => normalizeJobDescriptionMock(...args),
  };
});

vi.mock('../ai/evaluation.js', () => ({
  evaluateJob: vi.fn(),
}));

vi.mock('../jobSources/liveness.js', () => ({
  checkLiveness: vi.fn(async () => true),
}));

vi.mock('../jobSources/sourceHealth.js', () => ({
  recordSourceSuccess: vi.fn(),
  recordSourceFailure: vi.fn(),
}));

import jobsRouter, { mapNormalizeErrorToResponse } from './jobs.js';
import { NormalizationError, normalizationHash, cleanDescription } from '../ai/jdNormalizer.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

const LONG_DESCRIPTION = 'Senior backend engineer role building distributed systems. '.repeat(10); // 590 chars

function uuid(seed: string): string {
  // Deterministic uuid-shaped id from a short seed (hex-padded).
  const hex = Buffer.from(seed).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const ID_A = uuid('listing-a');
const ID_B = uuid('listing-b');
const ID_C = uuid('listing-c');

function listingRow(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    source: 'greenhouse',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: LONG_DESCRIPTION,
    descriptionMd: null,
    descriptionMdHash: null,
    descriptionMdAt: null,
    applyUrl: 'https://example.com/jobs/1',
    sourceUrl: 'https://example.com/jobs/1',
    isActive: true,
    ...overrides,
  };
}

function normalizedResult(markdown = '## Role\n\n- Build things\n') {
  return {
    result: {
      markdown,
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Remote',
      sections: { summary: ['Build things'] },
    },
    model: 'test-model-x',
    provider: 'groq',
  };
}

// In-memory listing store backing the prisma mock.
let store: Map<string, any>;

function installStore(rows: any[]) {
  store = new Map(rows.map((row) => [row.id, { ...row }]));
  prismaMocks.jobListing.findUnique.mockImplementation(async ({ where }: any) => {
    const row = store.get(where.id);
    return row ? { ...row } : null;
  });
  prismaMocks.jobListing.update.mockImplementation(async ({ where, data }: any) => {
    const row = store.get(where.id);
    if (!row) {
      const err: any = new Error('Record not found');
      err.code = 'P2025';
      throw err;
    }
    const next = { ...row, ...data };
    store.set(where.id, next);
    return { ...next };
  });
}

// Key presence for the route's read-only peek: DB rows + process.env.
function setKeysPresent(present: boolean) {
  if (present) {
    prismaMocks.aIProviderKey.findMany.mockResolvedValue([{ provider: 'groq' }]);
  } else {
    prismaMocks.aIProviderKey.findMany.mockResolvedValue([]);
  }
}

const ENV_KEYS = ['GROQ_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'];
let savedEnv: Record<string, string | undefined>;

function clearEnvKeys() {
  for (const key of [...ENV_KEYS, 'JD_MD_MODEL']) {
    delete process.env[key];
  }
  for (let i = 1; i <= 20; i += 1) {
    delete process.env[`GROQ_API_KEY_${i}`];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.enabled = true;
  savedEnv = {};
  for (const key of [...ENV_KEYS, 'JD_MD_MODEL']) {
    savedEnv[key] = process.env[key];
  }
  clearEnvKeys();
  process.env.JD_MD_MODEL = 'test-model-x';
  prismaMocks.appSetting.findUnique.mockResolvedValue(null);
  setKeysPresent(true);
  installStore([listingRow(ID_A), listingRow(ID_B), listingRow(ID_C)]);
  normalizeJobDescriptionMock.mockResolvedValue(normalizedResult());
});

afterEach(() => {
  for (const key of [...ENV_KEYS, 'JD_MD_MODEL']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('mapNormalizeErrorToResponse', () => {
  it('maps a missing-key error to 409 llm_key_missing', () => {
    const mapped = mapNormalizeErrorToResponse(
      new Error('No groq API keys configured. Add a key in Settings (BYOK) or set GROQ_API_KEY.'),
    );
    expect(mapped).toEqual({
      status: 409,
      body: {
        error: 'No LLM key configured. Add an LLM provider key in Settings (BYOK) to format descriptions.',
        code: 'llm_key_missing',
      },
    });
  });

  it('maps an error containing 429 to 429 rate_limited', () => {
    const err = new Error('LLM call failed (provider=groq, model=m): 429 Too Many Requests');
    expect(mapNormalizeErrorToResponse(err)).toEqual({
      status: 429,
      body: {
        error: 'The LLM provider rate-limited this normalization. Try again shortly.',
        code: 'rate_limited',
      },
    });
  });

  it('maps a status-429 provider error to 429 rate_limited', () => {
    const err = Object.assign(new Error('rate limit exceeded'), { status: 429 });
    const mapped = mapNormalizeErrorToResponse(err);
    expect(mapped?.status).toBe(429);
    expect(mapped?.body.code).toBe('rate_limited');
  });

  it('maps NormalizationError to 502 normalization_failed', () => {
    const mapped = mapNormalizeErrorToResponse(new NormalizationError('LLM output was not a JSON object.'));
    expect(mapped).toEqual({
      status: 502,
      body: {
        error: 'The AI response could not be parsed as a normalized description. The original text was kept.',
        code: 'normalization_failed',
      },
    });
  });

  it('returns null for a generic error so the caller rethrows', () => {
    expect(mapNormalizeErrorToResponse(new Error('Something exploded'))).toBeNull();
  });

  it('never echoes key material in mapped messages', () => {
    const mapped = mapNormalizeErrorToResponse(new NormalizationError('bad output for key sk-secret-abc123'));
    expect(JSON.stringify(mapped)).not.toContain('sk-secret-abc123');
    const mappedKey = mapNormalizeErrorToResponse(new Error('No LLM API keys configured, secret=sk-abc123'));
    expect(JSON.stringify(mappedKey)).not.toContain('sk-abc123');
  });
});

describe('POST /jobs/:id/normalize (single)', () => {
  it('returns 400 no_description for a short raw description and stores nothing', async () => {
    installStore([listingRow(ID_A, { description: 'too short' })]);
    const res = await request(makeApp()).post(`/jobs/${ID_A}/normalize`).send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'This listing has no usable description to normalize.',
      code: 'no_description',
    });
    expect(normalizeJobDescriptionMock).not.toHaveBeenCalled();
    expect(prismaMocks.jobListing.update).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid id', async () => {
    const res = await request(makeApp()).post('/jobs/not-a-uuid/normalize').send({});
    expect(res.status).toBe(400);
    expect(normalizeJobDescriptionMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown listing', async () => {
    const res = await request(makeApp()).post(`/jobs/${uuid('missing')}/normalize`).send({});
    expect(res.status).toBe(404);
  });

  it('returns 409 llm_key_missing when no key exists', async () => {
    setKeysPresent(false);
    const res = await request(makeApp()).post(`/jobs/${ID_A}/normalize`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('llm_key_missing');
    expect(normalizeJobDescriptionMock).not.toHaveBeenCalled();
    expect(prismaMocks.jobListing.update).not.toHaveBeenCalled();
  });

  it('normalizes on a cache miss, persists markdown/hash/at, and returns cached:false', async () => {
    const res = await request(makeApp()).post(`/jobs/${ID_A}/normalize`).send({});
    expect(res.status).toBe(200);
    expect(normalizeJobDescriptionMock).toHaveBeenCalledTimes(1);
    expect(normalizeJobDescriptionMock.mock.calls[0][1]).toBe(LONG_DESCRIPTION);
    expect(res.body).toMatchObject({
      markdown: '## Role\n\n- Build things\n',
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Remote',
      cached: false,
      model: 'test-model-x',
      provider: 'groq',
    });
    expect(res.body.sections).toEqual({ summary: ['Build things'] });
    const stored = store.get(ID_A);
    expect(stored.descriptionMd).toBe('## Role\n\n- Build things\n');
    expect(stored.descriptionMdHash).toBe(normalizationHash(cleanDescription(LONG_DESCRIPTION), 'test-model-x'));
    expect(stored.descriptionMdAt).toBeInstanceOf(Date);
  });

  it('returns cached:true with zero LLM calls when the stored hash matches', async () => {
    const hash = normalizationHash(cleanDescription(LONG_DESCRIPTION), 'test-model-x');
    installStore([listingRow(ID_A, {
      descriptionMd: '## Cached\n',
      descriptionMdHash: hash,
      descriptionMdAt: new Date(),
    })]);
    const res = await request(makeApp()).post(`/jobs/${ID_A}/normalize`).send({});
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.body.markdown).toBe('## Cached\n');
    expect(res.body.model).toBe('test-model-x');
    expect(normalizeJobDescriptionMock).not.toHaveBeenCalled();
    expect(prismaMocks.jobListing.update).not.toHaveBeenCalled();
  });

  it('re-normalizes when the stored hash was computed under a different model', async () => {
    const staleHash = normalizationHash(cleanDescription(LONG_DESCRIPTION), 'other-model');
    installStore([listingRow(ID_A, { descriptionMd: '## Stale\n', descriptionMdHash: staleHash })]);
    const res = await request(makeApp()).post(`/jobs/${ID_A}/normalize`).send({});
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(normalizeJobDescriptionMock).toHaveBeenCalledTimes(1);
  });

  it('returns 429 rate_limited when the provider rate-limits', async () => {
    normalizeJobDescriptionMock.mockRejectedValue(
      Object.assign(new Error('rate limit exceeded'), { status: 429 }),
    );
    const res = await request(makeApp()).post(`/jobs/${ID_A}/normalize`).send({});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(store.get(ID_A).descriptionMd).toBeNull();
  });

  it('returns 502 normalization_failed on unparseable LLM output and stores nothing', async () => {
    normalizeJobDescriptionMock.mockRejectedValue(new NormalizationError('LLM output was not a JSON object.'));
    const res = await request(makeApp()).post(`/jobs/${ID_A}/normalize`).send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('normalization_failed');
    expect(store.get(ID_A).descriptionMd).toBeNull();
  });

  it('still returns the generic 500 path for unknown errors', async () => {
    normalizeJobDescriptionMock.mockRejectedValue(new Error('Something exploded'));
    const res = await request(makeApp()).post(`/jobs/${ID_A}/normalize`).send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'An unexpected error occurred' });
  });
});

describe('POST /jobs/normalize (batch)', () => {
  it('rejects a batch of 21 ids with 400', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => uuid(`batch-${i}`));
    const res = await request(makeApp()).post('/jobs/normalize').send({ ids });
    expect(res.status).toBe(400);
    expect(normalizeJobDescriptionMock).not.toHaveBeenCalled();
  });

  it('rejects an empty batch with 400', async () => {
    const res = await request(makeApp()).post('/jobs/normalize').send({ ids: [] });
    expect(res.status).toBe(400);
  });

  it('isolates one bad id: 20 entries, the unknown one marked not_found', async () => {
    const missing = uuid('ghost');
    const ids = [ID_A, missing, ID_B];
    const res = await request(makeApp()).post('/jobs/normalize').send({ ids });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0]).toMatchObject({ id: ID_A, ok: true, cached: false });
    expect(res.body.results[0].markdown).toContain('## Role');
    expect(res.body.results[1]).toEqual({ id: missing, ok: false, errorCode: 'not_found' });
    expect(res.body.results[2]).toMatchObject({ id: ID_B, ok: true });
  });

  it('isolates a short-description item with no_description', async () => {
    installStore([listingRow(ID_A), listingRow(ID_B, { description: 'short' })]);
    const res = await request(makeApp()).post('/jobs/normalize').send({ ids: [ID_A, ID_B] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
    expect(res.body.results[1]).toEqual({ id: ID_B, ok: false, errorCode: 'no_description' });
  });

  it('dedupes repeated ids', async () => {
    const res = await request(makeApp()).post('/jobs/normalize').send({ ids: [ID_A, ID_A] });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ id: ID_A, ok: true });
  });

  it('marks llm_key_missing per item without failing the batch', async () => {
    setKeysPresent(false);
    const res = await request(makeApp()).post('/jobs/normalize').send({ ids: [ID_A, ID_B] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { id: ID_A, ok: false, errorCode: 'llm_key_missing' },
      { id: ID_B, ok: false, errorCode: 'llm_key_missing' },
    ]);
  });

  it('never runs more than 2 item calls concurrently', async () => {
    const ids = [ID_A, ID_B, ID_C, uuid('extra-d'), uuid('extra-e')];
    installStore([...ids.map((id) => listingRow(id))]);
    let active = 0;
    let maxActive = 0;
    normalizeJobDescriptionMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return normalizedResult();
    });
    const res = await request(makeApp()).post('/jobs/normalize').send({ ids });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(5);
    expect(res.body.results.every((entry: any) => entry.ok)).toBe(true);
    expect(res.body.results.map((entry: any) => entry.id)).toEqual(ids);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });
});

describe('GET /jobs/:id format=md', () => {
  it('is unchanged without format=md', async () => {
    const res = await request(makeApp()).get(`/jobs/${ID_A}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(listingRow(ID_A));
  });

  it('returns stored markdown with format=md even when no key exists', async () => {
    setKeysPresent(false);
    installStore([listingRow(ID_A, {
      descriptionMd: '## Cached\n',
      descriptionMdHash: 'hash-1',
      descriptionMdAt: new Date('2026-01-01T00:00:00.000Z'),
    })]);
    const res = await request(makeApp()).get(`/jobs/${ID_A}?format=md`);
    expect(res.status).toBe(200);
    expect(res.body.descriptionMd).toBe('## Cached\n');
    expect(res.body.descriptionMdHash).toBe('hash-1');
    expect(res.body.title).toBe('Backend Engineer');
  });

  it('returns 409 llm_key_missing for format=md with no stored markdown and no key', async () => {
    setKeysPresent(false);
    const res = await request(makeApp()).get(`/jobs/${ID_A}?format=md`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('llm_key_missing');
  });

  it('returns 200 with null markdown for format=md when a key exists but nothing is stored', async () => {
    const res = await request(makeApp()).get(`/jobs/${ID_A}?format=md`);
    expect(res.status).toBe(200);
    expect(res.body.descriptionMd).toBeNull();
    expect(res.body.descriptionMdHash).toBeNull();
  });
});
