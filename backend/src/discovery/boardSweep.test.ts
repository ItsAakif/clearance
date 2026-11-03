// Unit contract for the Deep catalogue sweep (fakes only - no Prisma, no
// network). Pins: keyset cursor, bounded concurrency, per-board timeout
// isolation, maxRows stop, dedupe-before-persist, exhausted cursor, empty
// registry, and the failure list.

import { describe, it, expect, vi } from 'vitest';
import {
  applyPageResult,
  sweepBackoffMs,
  sweepBoards,
  PAGE_ERROR_MAX_CHARS,
  SWEEP_DEACTIVATE_AFTER,
  SWEEP_EMPTY_QUERY,
  type PageWriteState,
  type SweepPage,
  type SweepOptions,
} from './boardSweep.js';
import type { RawJob } from '../jobSources/adapters/http.js';

function job(n: number, overrides: Partial<RawJob> = {}): RawJob {
  return {
    externalId: `ext-${n}`,
    source: 'workable',
    sourceUrl: `https://example.com/jobs/${n}`,
    title: `Engineer ${n}`,
    company: 'Acme',
    location: 'Remote',
    description: `Job ${n}`,
    applyUrl: `https://example.com/jobs/${n}`,
    ...overrides,
  };
}

function page(n: number, provider = 'workable'): SweepPage {
  return {
    id: `p${String(n).padStart(3, '0')}`,
    provider,
    boardToken: `token-${n}`,
  };
}

function options(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return {
    cursor: '',
    maxBoards: 10,
    concurrency: 2,
    maxRows: 100,
    perBoardTimeoutMs: 1000,
    ...overrides,
  };
}

function keysetPages(all: SweepPage[]) {
  return vi.fn(async ({ cursor, take }: { cursor: string; take: number }) =>
    all.filter((p) => p.id > cursor).slice(0, take),
  );
}

describe('sweepBoards - keyset cursor', () => {
  it('reads a keyset batch from the cursor and resumes after the last page id', async () => {
    const all = [page(1), page(2), page(3), page(4)];
    const pages = keysetPages(all);
    const fetchBoard = vi.fn(async () => [job(1)]);

    const first = await sweepBoards(
      { pages, fetchBoard, persist: async (rows) => rows.length },
      options({ cursor: '', maxBoards: 2 }),
    );
    expect(pages).toHaveBeenCalledWith({ cursor: '', take: 2 });
    expect(first.boards).toBe(2);
    expect(first.nextCursor).toBe('p002');
    expect(first.exhausted).toBe(false);

    const second = await sweepBoards(
      { pages, fetchBoard, persist: async (rows) => rows.length },
      options({ cursor: first.nextCursor, maxBoards: 3 }),
    );
    expect(pages).toHaveBeenLastCalledWith({ cursor: 'p002', take: 3 });
    expect(second.nextCursor).toBe('p004');
    // A short batch is the exhaustion signal.
    expect(second.exhausted).toBe(true);
    expect(fetchBoard).toHaveBeenCalledWith('workable', 'token-3', SWEEP_EMPTY_QUERY);
    expect(fetchBoard).toHaveBeenCalledWith('workable', 'token-4', SWEEP_EMPTY_QUERY);
  });

  it('always fetches with the documented empty query', async () => {
    const fetchBoard = vi.fn(async () => [job(1)]);
    await sweepBoards(
      { pages: async () => [page(1)], fetchBoard, persist: async (rows) => rows.length },
      options({ maxBoards: 5 }),
    );
    expect(SWEEP_EMPTY_QUERY).toBe('');
    expect(fetchBoard).toHaveBeenCalledWith('workable', 'token-1', '');
  });
});

describe('sweepBoards - bounded concurrency', () => {
  it('never runs more than `concurrency` board fetches at once', async () => {
    const gates: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const fetchBoard = vi.fn(async (_provider: string, token: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
      return [job(Number(token.slice('token-'.length)))];
    });

    const run = sweepBoards(
      {
        pages: async () => [1, 2, 3, 4, 5, 6].map((n) => page(n)),
        fetchBoard,
        persist: async (rows) => rows.length,
      },
      options({ maxBoards: 6, concurrency: 2 }),
    );

    // Let the pages read and the first worker wave start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(2);
    expect(maxActive).toBe(2);

    // Release one at a time; the pool keeps the cap while draining.
    while (gates.length > 0) {
      const gate = gates.shift();
      gate?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await run;
    expect(maxActive).toBe(2);
    expect(fetchBoard).toHaveBeenCalledTimes(6);
  });
});

describe('sweepBoards - timeout isolation', () => {
  it('records a timed-out board as failed and keeps the rest of the batch', async () => {
    const fetchBoard = vi.fn(async (_provider: string, token: string) => {
      if (token === 'token-hang') return new Promise<RawJob[]>(() => {});
      const n = Number(token.slice('token-'.length));
      return [job(n)];
    });

    const result = await sweepBoards(
      {
        pages: async () => [page(1), { ...page(2), boardToken: 'token-hang' }, page(3)],
        fetchBoard,
        persist: async (rows) => rows.length,
      },
      options({ maxBoards: 3, concurrency: 2, perBoardTimeoutMs: 5 }),
    );

    expect(result.ok).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      { pageId: 'p002', provider: 'workable', reason: 'timeout' },
    ]);
    expect(result.rowsFetched).toBe(2);
    expect(result.rowsPersisted).toBe(2);
  });

  it('records non-timeout failures with their message and never rejects the batch', async () => {
    const fetchBoard = vi.fn(async (_provider: string, token: string) => {
      if (token === 'token-bad') throw new Error('upstream 502');
      return [job(1)];
    });

    const result = await sweepBoards(
      {
        pages: async () => [page(1), { ...page(2), boardToken: 'token-bad' }],
        fetchBoard,
        persist: async (rows) => rows.length,
      },
      options({ maxBoards: 2 }),
    );

    expect(result.ok).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([
      { pageId: 'p002', provider: 'workable', reason: 'upstream 502' },
    ]);
  });
});

describe('sweepBoards - maxRows stop', () => {
  it('stops launching new boards once rowsFetched reaches maxRows', async () => {
    const fetchBoard = vi.fn(async (_provider: string, token: string) => {
      const n = Number(token.slice('token-'.length));
      return [job(n * 10), job(n * 10 + 1)];
    });

    const result = await sweepBoards(
      {
        pages: async () => [page(1), page(2), page(3), page(4), page(5)],
        fetchBoard,
        persist: async (rows) => rows.length,
      },
      options({ maxBoards: 5, concurrency: 2, maxRows: 2 }),
    );

    // Both first-wave boards were in flight; no NEW board launched afterwards.
    expect(fetchBoard).toHaveBeenCalledTimes(2);
    expect(result.boards).toBe(2);
    expect(result.rowsFetched).toBe(4);
    expect(result.nextCursor).toBe('p002');
    expect(result.exhausted).toBe(false);
  });
});

describe('sweepBoards - dedupe before persist', () => {
  it('persists one deduped batch, not the raw fetch rows', async () => {
    const duplicate = job(1);
    const persist = vi.fn(async (rows: RawJob[]) => rows.length);
    const fetchBoard = vi.fn(async (_provider: string, token: string) =>
      token === 'token-1' ? [duplicate, job(2)] : [{ ...duplicate }],
    );

    const result = await sweepBoards(
      {
        pages: async () => [page(1), page(2)],
        fetchBoard,
        persist,
      },
      options({ maxBoards: 2, concurrency: 1 }),
    );

    expect(persist).toHaveBeenCalledTimes(1);
    const persisted = persist.mock.calls[0][0];
    expect(persisted).toHaveLength(2);
    expect(new Set(persisted.map((r) => r.sourceUrl)).size).toBe(2);
    expect(result.rowsFetched).toBe(3);
    expect(result.rowsPersisted).toBe(2);
  });
});

describe('sweepBoards - exhaustion and empty registry', () => {
  it('marks a short batch exhausted and keeps the incoming cursor', async () => {
    const fetchBoard = vi.fn(async () => [job(1)]);
    const result = await sweepBoards(
      {
        pages: async () => [page(1), page(2)],
        fetchBoard,
        persist: async (rows) => rows.length,
      },
      options({ cursor: 'p000', maxBoards: 5 }),
    );
    expect(result.exhausted).toBe(true);
    expect(result.nextCursor).toBe('p002');
  });

  it('returns an empty, exhausted result for an empty registry without persisting', async () => {
    const persist = vi.fn(async () => 0);
    const fetchBoard = vi.fn(async () => []);
    const result = await sweepBoards(
      { pages: async () => [], fetchBoard, persist },
      options({ cursor: 'from-before', maxBoards: 120 }),
    );
    expect(result).toMatchObject({
      boards: 0,
      ok: 0,
      failed: 0,
      rowsFetched: 0,
      rowsPersisted: 0,
      nextCursor: 'from-before',
      exhausted: true,
      failures: [],
      deactivated: 0,
      backedOff: 0,
    });
    expect(fetchBoard).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('sweepBoards - provider filter', () => {
  it('passes the optional providers filter to pages() and omits it when absent', async () => {
    const pages = vi.fn(async () => []);
    await sweepBoards(
      { pages, fetchBoard: async () => [], persist: async () => 0 },
      options({ providers: ['workable'] }),
    );
    expect(pages).toHaveBeenCalledWith({ cursor: '', take: 10, providers: ['workable'] });

    const unfiltered = vi.fn(async () => []);
    await sweepBoards(
      { pages: unfiltered, fetchBoard: async () => [], persist: async () => 0 },
      options(),
    );
    expect(unfiltered).toHaveBeenCalledWith({ cursor: '', take: 10 });
  });
});

describe('sweepBoards - registry write-back', () => {
  it('records success and failure outcomes and counts deactivations/backoffs', async () => {
    const recordPageResult = vi.fn(async (pageId: string) =>
      pageId === 'p002'
        ? { deactivated: true, backedOff: true }
        : { deactivated: false, backedOff: false },
    );
    const fetchBoard = vi.fn(async (_provider: string, token: string) => {
      if (token === 'token-bad') {
        throw Object.assign(new Error('Fetch failed 410 for https://x'), { status: 410 });
      }
      return [job(1)];
    });

    const result = await sweepBoards(
      {
        pages: async () => [page(1), { ...page(2), boardToken: 'token-bad' }],
        fetchBoard,
        persist: async (rows) => rows.length,
        recordPageResult,
      },
      options({ maxBoards: 2 }),
    );

    expect(recordPageResult).toHaveBeenCalledWith('p001', { ok: true, rows: 1 });
    expect(recordPageResult).toHaveBeenCalledWith('p002', {
      ok: false,
      status: 410,
      rows: 0,
      error: 'Fetch failed 410 for https://x',
    });
    expect(result.deactivated).toBe(1);
    expect(result.backedOff).toBe(1);
  });

  it('isolates a throwing write-back and keeps the batch result', async () => {
    const recordPageResult = vi.fn(async () => {
      throw new Error('db down');
    });
    const result = await sweepBoards(
      {
        pages: async () => [page(1)],
        fetchBoard: async () => [job(1)],
        persist: async (rows) => rows.length,
        recordPageResult,
      },
      options({ maxBoards: 1 }),
    );
    expect(result.ok).toBe(1);
    expect(result.deactivated).toBe(0);
    expect(result.backedOff).toBe(0);
  });
});

describe('applyPageResult - backoff table', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const state: PageWriteState = { failureCount: 0, isActive: true, verifiedAt: null };

  it.each([
    [1, 1],
    [2, 3],
    [3, 7],
    [4, 30],
    [9, 30],
  ])('failureCount %i -> %i days', (failures, days) => {
    expect(sweepBackoffMs(failures)).toBe(days * 24 * 60 * 60 * 1000);
    const detail = applyPageResult(
      { ...state, failureCount: failures - 1 },
      { ok: false, status: 500, rows: 0, error: 'boom' },
      now,
    );
    expect(detail.update.nextCheckAt!.getTime() - now.getTime()).toBe(
      days * 24 * 60 * 60 * 1000,
    );
    expect(detail.backedOff).toBe(true);
  });

  it('deactivates only after three consecutive 404/410 failures', () => {
    let current: PageWriteState = { ...state };
    for (let i = 1; i <= SWEEP_DEACTIVATE_AFTER - 1; i += 1) {
      const detail = applyPageResult(current, { ok: false, status: 404, rows: 0 }, now);
      expect(detail.deactivated).toBe(false);
      expect(detail.update.isActive).toBe(true);
      current = { ...current, ...detail.update };
    }
    const third = applyPageResult(current, { ok: false, status: 410, rows: 0 }, now);
    expect(third.deactivated).toBe(true);
    expect(third.update.isActive).toBe(false);
    expect(third.update.verifyStatus).toBe('http_error');
  });

  it('a 429 is blocked and never deactivates, however long the streak', () => {
    let current: PageWriteState = { ...state };
    for (let i = 0; i < 5; i += 1) {
      const detail = applyPageResult(current, { ok: false, status: 429, rows: 0 }, now);
      expect(detail.deactivated).toBe(false);
      expect(detail.update.isActive).toBe(true);
      expect(detail.update.verifyStatus).toBe('blocked');
      current = { ...current, ...detail.update };
    }
  });

  it('maps a timeout and bounds the stored error to ~200 chars', () => {
    const detail = applyPageResult(
      state,
      { ok: false, rows: 0, error: `${'x'.repeat(500)} timed out` },
      now,
    );
    expect(detail.update.verifyStatus).toBe('timeout');
    expect(detail.update.lastError!.length).toBe(PAGE_ERROR_MAX_CHARS);
  });

  it('success clears the streak, schedules no retry and records ok/empty', () => {
    const ok = applyPageResult(
      { failureCount: 5, isActive: true, verifiedAt: null },
      { ok: true, rows: 3 },
      now,
    );
    expect(ok.update).toMatchObject({
      failureCount: 0,
      lastError: null,
      nextCheckAt: null,
      resultCount: 3,
      verifyStatus: 'ok',
      verifiedAt: now,
      lastCheckedAt: now,
      isActive: true,
    });
    const empty = applyPageResult(
      { failureCount: 5, isActive: true, verifiedAt: null },
      { ok: true, rows: 0 },
      now,
    );
    expect(empty.update.verifyStatus).toBe('empty');
    expect(empty.update.resultCount).toBe(0);
  });
});
