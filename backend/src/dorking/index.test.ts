// Dorking execution tests (Wave 5, T702). Hermetic: every test injects a
// mock `DorkSearchTransport`, so the suite issues no live search calls. The
// one test that omits the transport mocks the `searchJobs` module itself.
//
// Asserted here (task STEP 7 + acceptance):
//   - every row is `index-date` with a nullish `postedAt`, via `classify`
//     (even when the backend row carried a date claim);
//   - an ATS-host result keeps `index-date` and gains the ATS hint;
//   - a 429 marks the query failed and is never retried in-run;
//   - a 5xx retries at most once (then succeeds or is marked failed);
//   - non-5xx/non-429 errors are not retried;
//   - one failed query does not abort the rest (failure isolation);
//   - expansion caps bound the run and drops are reported;
//   - no browser/LLM import anywhere under `backend/src/dorking/`;
//   - no identity/egress-switching or challenge-solving mechanism exists in
//     the execution module;
//   - N3: the descriptor carries no suppression/exclusivity field, and
//     dorked rows merge additively with other providers' rows.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  runDorking,
  runDorkingDetailed,
  DORKING_SOURCE_ID,
  DORK_RETRY_DELAY_MS,
  MAX_DORK_QUERIES_PER_RUN,
} from './index.js';
import type { DorkSearchTransport, DorkedJob } from './index.js';
import { expand } from './expand.js';
import type { SearchIntent } from './expand.js';
import type { RawJob } from '../jobSources/index.js';
import type { SearchConfig } from '../jobSources/search.js';
import { getProvider } from '../jobSources/providerRegistry.js';

vi.mock('../jobSources/search.js', () => ({
  searchJobs: vi.fn(async () => []),
}));

import { searchJobs } from '../jobSources/search.js';

const mockedSearchJobs = vi.mocked(searchJobs);

const INTENT: SearchIntent = {
  roles: ['React Engineer'],
  skills: ['TypeScript'],
};

function upstreamRow(overrides: Partial<RawJob> = {}): RawJob {
  return {
    externalId: 'upstream-1',
    source: 'search',
    sourceUrl: 'https://careers.acme.example.test/jobs/1',
    title: 'Senior Engineer at Acme',
    company: 'Acme',
    description: 'Build things.',
    applyUrl: 'https://careers.acme.example.test/jobs/1',
    // A genuine posted claim from the backend - execution must still null
    // it via `classify` (the N4 proof point: provenance, not hand-write).
    postedAt: new Date('2026-01-15T00:00:00Z'),
    postedAtSource: 'source-posted',
    postedAtRaw: '2026-01-15',
    ...overrides,
  };
}

// A transport returning `rowsPerQuery` upstream rows for every query, while
// recording every call it receives.
function recordingTransport(
  rowsPerQuery: number,
  calls: SearchConfig[],
  rowFor?: (queryIndex: number, rowIndex: number) => RawJob,
): DorkSearchTransport {
  let queryIndex = -1;
  return async (config: SearchConfig) => {
    calls.push(config);
    queryIndex += 1;
    const rows: RawJob[] = [];
    for (let i = 0; i < rowsPerQuery; i++) {
      rows.push(
        rowFor ? rowFor(queryIndex, i) : upstreamRow({ externalId: `up-${queryIndex}-${i}` }),
      );
    }
    return rows;
  };
}

function errWithStatus(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

describe('dorking execution provenance (N4)', () => {
  it('stamps every row index-date with a nullish postedAt, via classify', async () => {
    const calls: SearchConfig[] = [];
    const jobs = await runDorking(INTENT, {
      transport: recordingTransport(2, calls),
      retryDelayMs: 0,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(jobs.length).toBe(calls.length * 2);
    for (const job of jobs) {
      expect(job.postedAtSource).toBe('index-date');
      // Nullish (the repo N4 invariant is `undefined`; the task's "null"
      // is read as null-or-undefined - strict TS forbids a literal null
      // on `RawJob.postedAt`, see provenance.ts).
      expect(job.postedAt == null).toBe(true);
      expect(job.postedAt).toBeUndefined();
      expect(job.source).toBe(DORKING_SOURCE_ID);
    }
  });

  it('nulls a backend date claim (classify proof, not hand-written fields)', async () => {
    const jobs = await runDorking(INTENT, {
      transport: async () => [upstreamRow()],
      retryDelayMs: 0,
    });
    expect(jobs).toHaveLength(expand(INTENT).queries.length);
    for (const job of jobs) {
      expect(job.postedAt).toBeUndefined();
      expect(job.postedAtSource).toBe('index-date');
    }
  });

  it('carries the producing template id in the provenance payload', async () => {
    const snapshot = await runDorkingDetailed(INTENT, {
      transport: recordingTransport(1, []),
      retryDelayMs: 0,
    });
    expect(snapshot.jobs.length).toBe(snapshot.queries.length);
    snapshot.attempts.forEach((attempt, i) => {
      expect(attempt.query.templateId).toBe(snapshot.queries[i].templateId);
      expect(attempt.jobs).toHaveLength(1);
      expect(attempt.jobs[0].dorkProvenance.templateId).toBe(
        attempt.query.templateId,
      );
    });
  });

  it('labels an ATS-host result with the ATS hint but keeps index-date', async () => {
    const jobs = await runDorking(INTENT, {
      transport: async () => [
        upstreamRow({
          sourceUrl: 'https://jobs.lever.co/acme/abc123',
          applyUrl: 'https://jobs.lever.co/acme/abc123',
        }),
      ],
      retryDelayMs: 0,
    });
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.dorkProvenance.atsProvider).toBe('lever');
      expect(job.postedAtSource).toBe('index-date');
      expect(job.postedAt).toBeUndefined();
    }
  });

  it('leaves atsProvider null for non-ATS result URLs', async () => {
    const jobs = await runDorking(INTENT, {
      transport: recordingTransport(1, []),
      retryDelayMs: 0,
    });
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.dorkProvenance.atsProvider).toBeNull();
    }
  });

  it('forwards the expanded query, site, and per-query cap to the transport', async () => {
    const calls: SearchConfig[] = [];
    const snapshot = await runDorkingDetailed(INTENT, {
      transport: recordingTransport(0, calls),
      retryDelayMs: 0,
    });
    expect(calls).toHaveLength(snapshot.queries.length);
    calls.forEach((call, i) => {
      expect(call.query).toBe(snapshot.queries[i].q);
      expect(call.site).toBe(snapshot.queries[i].site);
      expect(call.maxResults).toBe(snapshot.queries[i].maxResults);
    });
  });
});

describe('dorking rate/abuse guards and failure isolation', () => {
  it('a 429 marks the query failed and is never retried in-run', async () => {
    const calls: SearchConfig[] = [];
    let n = -1;
    const snapshot = await runDorkingDetailed(INTENT, {
      transport: async (config: SearchConfig) => {
        calls.push(config);
        n += 1;
        if (n === 0) throw new Error('Tavily search failed: 429');
        return [upstreamRow({ externalId: `up-${n}` })];
      },
      retryDelayMs: 0,
    });
    expect(snapshot.failedQueries).toBe(1);
    expect(snapshot.attempts[0].status).toBe('failed');
    expect(snapshot.attempts[0].attempts).toBe(1);
    expect(snapshot.attempts[0].jobs).toEqual([]);
    // Remaining queries continued: every other attempt ok with rows.
    for (const attempt of snapshot.attempts.slice(1)) {
      expect(attempt.status).toBe('ok');
      expect(attempt.jobs).toHaveLength(1);
    }
    expect(snapshot.jobs.length).toBe(snapshot.queries.length - 1);
    const firstQueryCalls = calls.filter((c) => c.query === snapshot.queries[0].q);
    expect(firstQueryCalls).toHaveLength(1);
  });

  it('a 429 given as a status property is likewise never retried', async () => {
    let calls = 0;
    const snapshot = await runDorkingDetailed(
      INTENT,
      {
        transport: async () => {
          calls += 1;
          throw errWithStatus('rate limited', 429);
        },
        retryDelayMs: 0,
      },
    );
    // One attempt per query, never two.
    for (const attempt of snapshot.attempts) {
      expect(attempt.attempts).toBe(1);
      expect(attempt.status).toBe('failed');
    }
    expect(calls).toBe(snapshot.queries.length);
    expect(snapshot.failedQueries).toBe(snapshot.queries.length);
    expect(snapshot.jobs).toEqual([]);
  });

  it('a 5xx retries at most once, then succeeds', async () => {
    const perQueryCalls = new Map<string, number>();
    const snapshot = await runDorkingDetailed(INTENT, {
      transport: async (config: SearchConfig) => {
        const seen = (perQueryCalls.get(config.query) ?? 0) + 1;
        perQueryCalls.set(config.query, seen);
        if (seen === 1) throw new Error('Exa search failed: 503');
        return [upstreamRow()];
      },
      retryDelayMs: 0,
    });
    expect(snapshot.failedQueries).toBe(0);
    for (const attempt of snapshot.attempts) {
      expect(attempt.status).toBe('ok');
      expect(attempt.attempts).toBe(2);
      expect(attempt.jobs).toHaveLength(1);
    }
  });

  it('a persistent 5xx fails after exactly one retry and the run continues', async () => {
    const calls: SearchConfig[] = [];
    const snapshot = await runDorkingDetailed(INTENT, {
      transport: async (config: SearchConfig) => {
        calls.push(config);
        throw errWithStatus('bad gateway: 502', 502);
      },
      retryDelayMs: 0,
    });
    for (const attempt of snapshot.attempts) {
      expect(attempt.status).toBe('failed');
      expect(attempt.attempts).toBe(2);
      expect(attempt.error).toContain('502');
    }
    // Exactly 2 calls per query: 1 initial + at most 1 retry, never more.
    expect(calls).toHaveLength(snapshot.queries.length * 2);
    expect(snapshot.failedQueries).toBe(snapshot.queries.length);
  });

  it('a non-status error is not retried', async () => {
    let calls = 0;
    const snapshot = await runDorkingDetailed(INTENT, {
      transport: async () => {
        calls += 1;
        throw new Error('socket hang up');
      },
      retryDelayMs: 0,
    });
    expect(calls).toBe(snapshot.queries.length);
    for (const attempt of snapshot.attempts) {
      expect(attempt.attempts).toBe(1);
      expect(attempt.status).toBe('failed');
    }
  });

  it('a partially failing family continues with the remaining queries', async () => {
    // Fail every third query with a mix of 429 / 500 / unknown errors.
    let n = -1;
    const snapshot = await runDorkingDetailed(INTENT, {
      transport: async () => {
        n += 1;
        if (n % 3 === 0) throw new Error('Tavily search failed: 429');
        if (n % 3 === 1) throw new Error('boom');
        return [upstreamRow({ externalId: `up-${n}` }), upstreamRow({ externalId: `up-${n}-b` })];
      },
      retryDelayMs: 0,
    });
    const ok = snapshot.attempts.filter((a) => a.status === 'ok');
    const failed = snapshot.attempts.filter((a) => a.status === 'failed');
    expect(ok.length).toBeGreaterThan(0);
    expect(failed.length).toBeGreaterThan(0);
    expect(snapshot.jobs.length).toBe(ok.length * 2);
    expect(snapshot.failedQueries).toBe(failed.length);
  });
});

describe('dorking run bounds', () => {
  it('is bounded by MAX_DORK_QUERIES_PER_RUN and reports drops', async () => {
    const companies: string[] = [];
    for (let i = 0; i < 40; i++) companies.push(`acme${i}.example.test`);
    const intent = { roles: ['Engineer'], companies };
    const expansion = expand(intent);
    const snapshot = await runDorkingDetailed(intent, {
      transport: async () => [],
      retryDelayMs: 0,
    });
    expect(snapshot.queries.length).toBe(MAX_DORK_QUERIES_PER_RUN);
    expect(snapshot.dropped).toBe(expansion.dropped);
    expect(snapshot.dropped).toBeGreaterThan(0);
    expect(snapshot.jobs).toEqual([]);
  });

  it('is deterministic for a fixed intent and transport', async () => {
    const mk = (): DorkSearchTransport =>
      recordingTransport(1, [], (qi, i) => upstreamRow({ externalId: `up-${qi}-${i}` }));
    const first = await runDorking(INTENT, { transport: mk(), retryDelayMs: 0 });
    const second = await runDorking(INTENT, { transport: mk(), retryDelayMs: 0 });
    expect(second).toEqual(first);
  });

  it('runs through the existing search backend when no transport is injected', async () => {
    mockedSearchJobs.mockClear();
    await runDorking({ roles: ['Engineer'] });
    const expected = expand({ roles: ['Engineer'] });
    expect(mockedSearchJobs.mock.calls.length).toBe(expected.queries.length);
    expected.queries.forEach((q, i) => {
      expect(mockedSearchJobs.mock.calls[i][0]).toMatchObject({
        query: q.q,
        site: q.site,
        maxResults: q.maxResults,
      });
    });
  });
});

describe('dorking N3 guarantee (never the sole provider)', () => {
  it('the dorking descriptor carries no suppression/exclusivity field', () => {
    const d = getProvider('dorking');
    expect(d).toBeDefined();
    expect(d!.tier).toBe(5);
    expect(d!.kind).toBe('search');
    expect(d!.dateMapping).toEqual([{ field: 'postedAt', source: 'index-date' }]);
    for (const key of ['suppresses', 'exclusive', 'replaces', 'solo', 'only']) {
      expect(Object.keys(d!), `descriptor key "${key}"`).not.toContain(key);
    }
  });

  it('merges additively: other providers rows survive untouched', async () => {
    const other: RawJob[] = [
      {
        externalId: 'gh-1',
        source: 'greenhouse',
        sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
        title: 'Engineer',
        company: 'Acme',
        description: 'x',
      },
    ];
    const dorked: DorkedJob[] = await runDorking(INTENT, {
      transport: recordingTransport(1, []),
      retryDelayMs: 0,
    });
    const merged: RawJob[] = [...other, ...dorked];
    expect(merged.slice(0, other.length)).toEqual(other);
    expect(merged.length).toBe(other.length + dorked.length);
    for (const job of dorked) {
      expect(job.source).toBe(DORKING_SOURCE_ID);
    }
  });
});

describe('dorking module hygiene', () => {
  const DORKING_DIR = path.join(__dirname);

  it('has no browser or LLM import anywhere under backend/src/dorking/', () => {
    for (const file of ['index.ts', 'expand.ts', 'templates.ts']) {
      const text = readFileSync(path.join(DORKING_DIR, file), 'utf8');
      for (const line of text.split('\n')) {
        if (/^\s*import\b/.test(line) || /require\s*\(/.test(line)) {
          expect(line, `${file} import`).not.toMatch(
            /browser|playwright|puppeteer|llm|openai|anthropic/i,
          );
        }
      }
    }
  });

  it('has no identity/egress-switching or challenge-solving mechanism', () => {
    const text = readFileSync(path.join(DORKING_DIR, 'index.ts'), 'utf8');
    for (const token of ['playwright', 'puppeteer', 'captcha', 'proxy', 'rotat']) {
      expect(text.toLowerCase(), `token "${token}"`).not.toContain(token);
    }
    // The retry bound is a named constant, honoured structurally above.
    expect(DORK_RETRY_DELAY_MS).toBeGreaterThanOrEqual(0);
  });
});
