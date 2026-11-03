import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  authState,
  prismaMocks,
  normalizeJobDescriptionMock,
  runSourceMock,
  seedMock,
  healthMocks,
} = vi.hoisted(() => ({
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
  runSourceMock: vi.fn(),
  seedMock: vi.fn(),
  healthMocks: { recordSourceSuccess: vi.fn(), recordSourceFailure: vi.fn() },
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

// Keep the pure helpers real; only the LLM boundary is faked.
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
  recordSourceSuccess: (...args: any[]) => healthMocks.recordSourceSuccess(...args),
  recordSourceFailure: (...args: any[]) => healthMocks.recordSourceFailure(...args),
}));

vi.mock('../jobSources/defaultBoards.js', () => ({
  seedDefaultBoardsForUser: (...args: any[]) => seedMock(...args),
}));

vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: (...args: any[]) => runSourceMock(...args) };
});

import jobsRouter, {
  autoNormalizeDiscoveredListings,
  scheduleAutoNormalization,
  AUTO_NORMALIZE_MAX_ROWS,
  AUTO_NORMALIZE_CONCURRENCY,
} from './jobs.js';
import { NormalizationError } from '../ai/jdNormalizer.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

const LONG_DESCRIPTION = 'Senior backend engineer role building distributed systems. '.repeat(10);

function uuid(seed: string): string {
  const hex = Buffer.from(seed).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

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

function boardRow(overrides: Record<string, any> = {}) {
  return {
    id: 'board-1',
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

let store: Map<string, any>;

function installStore(rows: any[]) {
  store = new Map(rows.map((row) => [row.id, { ...row }]));
  prismaMocks.jobListing.findUnique.mockImplementation(async ({ where }: any) => {
    const row = store.get(where.id);
    return row ? { ...row } : null;
  });
  prismaMocks.jobListing.update.mockImplementation(async ({ where, data }: any) => {
    const row = store.get(where.id);
    const base = row ? { ...row } : { id: where.id };
    const next = { ...base, ...data };
    store.set(where.id, next);
    return { ...next };
  });
}

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

function flushBackground(times = 10) {
  return (async () => {
    for (let i = 0; i < times; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
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
  seedMock.mockResolvedValue(undefined);
  runSourceMock.mockResolvedValue([]);
  setKeysPresent(true);
  installStore([]);
  normalizeJobDescriptionMock.mockResolvedValue(normalizedResult());
});

afterEach(() => {
  for (const key of [...ENV_KEYS, 'JD_MD_MODEL']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('auto-normalize constants', () => {
  it('caps at 20 rows with concurrency 2', () => {
    expect(AUTO_NORMALIZE_MAX_ROWS).toBe(20);
    expect(AUTO_NORMALIZE_CONCURRENCY).toBe(2);
  });
});

describe('autoNormalizeDiscoveredListings', () => {
  it('respects the 20-row cap', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => uuid(`cap-${i}`));
    installStore(ids.map((id) => listingRow(id)));
    const summary = await autoNormalizeDiscoveredListings(
      'user-1',
      ids.map((id) => ({ id, descriptionMd: null })),
    );
    expect(summary.attempted).toBe(20);
    expect(normalizeJobDescriptionMock).toHaveBeenCalledTimes(20);
    expect(summary.succeeded).toBe(20);
    expect(summary.failed).toBe(0);
    expect(summary.skippedNoKey).toBe(false);
  });

  it('skips rows that already have stored markdown', async () => {
    const idA = uuid('has-md');
    const idB = uuid('needs-md');
    installStore([listingRow(idA, { descriptionMd: '## Cached\n' }), listingRow(idB)]);
    const summary = await autoNormalizeDiscoveredListings('user-1', [
      { id: idA, descriptionMd: '## Cached\n' },
      { id: idB, descriptionMd: null },
    ]);
    expect(summary.attempted).toBe(1);
    expect(normalizeJobDescriptionMock).toHaveBeenCalledTimes(1);
    expect(normalizeJobDescriptionMock.mock.calls[0][1]).toBe(LONG_DESCRIPTION);
  });

  it('skips entirely without an LLM call when no key is configured', async () => {
    setKeysPresent(false);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      const ids = [uuid('nokey-a'), uuid('nokey-b')];
      installStore(ids.map((id) => listingRow(id)));
      const summary = await autoNormalizeDiscoveredListings(
        'user-1',
        ids.map((id) => ({ id, descriptionMd: null })),
      );
      expect(summary).toEqual({ attempted: 0, succeeded: 0, failed: 0, skippedNoKey: true });
      expect(normalizeJobDescriptionMock).not.toHaveBeenCalled();
      expect(prismaMocks.jobListing.update).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledTimes(1);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('isolates a per-row failure: one bad row never blocks the rest', async () => {
    const idA = uuid('iso-a');
    const idB = uuid('iso-b');
    const idC = uuid('iso-c');
    installStore([listingRow(idA), listingRow(idB), listingRow(idC)]);
    // Fail exactly the second attempted id by rejecting once in order.
    let callCount = 0;
    normalizeJobDescriptionMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 2) throw new NormalizationError('LLM output was not a JSON object.');
      return normalizedResult();
    });
    const summary = await autoNormalizeDiscoveredListings('user-1', [
      { id: idA, descriptionMd: null },
      { id: idB, descriptionMd: null },
      { id: idC, descriptionMd: null },
    ]);
    expect(summary.attempted).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
    expect(store.get(idA).descriptionMd).toContain('## Role');
    expect(store.get(idB).descriptionMd).toBeNull();
    expect(store.get(idC).descriptionMd).toContain('## Role');
  });

  it('never runs more than 2 normalizations concurrently', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => uuid(`conc-${i}`));
    installStore(ids.map((id) => listingRow(id)));
    let active = 0;
    let maxActive = 0;
    normalizeJobDescriptionMock.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return normalizedResult();
    });
    await autoNormalizeDiscoveredListings(
      'user-1',
      ids.map((id) => ({ id, descriptionMd: null })),
    );
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });

  it('scheduleAutoNormalization never throws or rejects', async () => {
    setKeysPresent(false);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      expect(() =>
        scheduleAutoNormalization('user-1', [{ id: uuid('sched-a'), descriptionMd: null }]),
      ).not.toThrow();
      await flushBackground(3);
      expect(normalizeJobDescriptionMock).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
    }
  });
});

describe('discovery routes fire-and-forget auto-normalization', () => {
  it('GET /search returns before normalization completes', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow({ id: 'board-1' })]);
    runSourceMock.mockResolvedValue([
      {
        externalId: 'remotive-1',
        source: 'json',
        sourceUrl: 'https://remotive.com/jobs/1',
        title: 'Senior Backend Engineer',
        company: 'RemotiveCo',
        location: 'Worldwide',
        description: LONG_DESCRIPTION,
        applyUrl: 'https://remotive.com/jobs/1',
      },
    ]);
    const rowId = uuid('search-row');
    const stored = listingRow(rowId);
    prismaMocks.jobListing.upsert.mockResolvedValue({ ...stored, descriptionMd: null });
    installStore([stored]);
    prismaMocks.jobListing.findUnique.mockImplementation(async () => ({ ...stored }));

    let releaseLlm!: (value: any) => void;
    const gate = new Promise((resolve) => {
      releaseLlm = resolve;
    });
    normalizeJobDescriptionMock.mockImplementation(async () => {
      await gate;
      return normalizedResult();
    });

    const res = await request(makeApp()).get('/jobs/search?q=engineer');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    // The response is back while the LLM call is still gated: proof the
    // handler did not await normalization.
    expect(normalizeJobDescriptionMock).toHaveBeenCalled();
    expect(store.get(rowId).descriptionMd).toBeNull();

    releaseLlm(normalizedResult());
    await flushBackground(15);
    expect(store.get(rowId).descriptionMd).toContain('## Role');
  });

  it('GET /scan triggers background normalization without delaying the response', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow({ id: 'board-1' })]);
    runSourceMock.mockResolvedValue([
      {
        externalId: 'scan-1',
        source: 'json',
        sourceUrl: 'https://example.com/jobs/9',
        title: 'Backend Engineer',
        company: 'Acme',
        location: 'Remote',
        description: LONG_DESCRIPTION,
        applyUrl: 'https://example.com/jobs/9',
      },
    ]);
    const rowId = uuid('scan-row');
    const stored = listingRow(rowId);
    prismaMocks.jobListing.upsert.mockResolvedValue({ ...stored, descriptionMd: null });
    installStore([stored]);

    const res = await request(makeApp()).get('/jobs/scan?query=engineer');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    await flushBackground(15);
    expect(normalizeJobDescriptionMock).toHaveBeenCalled();
    expect(store.get(rowId).descriptionMd).toContain('## Role');
  });

  it('GET /search still succeeds when normalization fails for every row', async () => {
    prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow({ id: 'board-1' })]);
    runSourceMock.mockResolvedValue([
      {
        externalId: 'fail-1',
        source: 'json',
        sourceUrl: 'https://example.com/jobs/5',
        title: 'Backend Engineer',
        company: 'Acme',
        location: 'Remote',
        description: LONG_DESCRIPTION,
        applyUrl: 'https://example.com/jobs/5',
      },
    ]);
    const rowId = uuid('fail-row');
    const stored = listingRow(rowId);
    prismaMocks.jobListing.upsert.mockResolvedValue({ ...stored, descriptionMd: null });
    installStore([stored]);
    normalizeJobDescriptionMock.mockRejectedValue(new NormalizationError('LLM output was not a JSON object.'));

    const res = await request(makeApp()).get('/jobs/search?q=engineer');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    await flushBackground(5);
    expect(store.get(rowId).descriptionMd).toBeNull();
  });

  it('GET /search with no LLM key returns normally and makes no LLM call', async () => {
    setKeysPresent(false);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    try {
      prismaMocks.jobBoard.findMany.mockResolvedValue([boardRow({ id: 'board-1' })]);
      runSourceMock.mockResolvedValue([
        {
          externalId: 'nokey-1',
          source: 'json',
          sourceUrl: 'https://example.com/jobs/6',
          title: 'Backend Engineer',
          company: 'Acme',
          location: 'Remote',
          description: LONG_DESCRIPTION,
          applyUrl: 'https://example.com/jobs/6',
        },
      ]);
      const stored = listingRow(uuid('nokey-row'));
      prismaMocks.jobListing.upsert.mockResolvedValue({ ...stored, descriptionMd: null });

      const res = await request(makeApp()).get('/jobs/search?q=engineer');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      await flushBackground(5);
      expect(normalizeJobDescriptionMock).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
    }
  });
});
