// Keyset registry reader tests (T884, T905). Prisma is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FULL_BATCH_PAGES } from './budgets.js';
import {
  countActiveRegistryPages,
  resolveRegistryPageBatch,
  type RegistrySweepPage,
} from './registrySweep.js';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    companyCareerPage: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

interface Row {
  id: string;
  url: string;
  provider: string | null;
  boardToken: string | null;
  tier: number;
  isActive: boolean;
  company: { name: string };
}

const rows: Row[] = [
  { id: 'page-01', url: 'https://one.example.test/careers', provider: 'greenhouse', boardToken: 'one', tier: 1, isActive: true, company: { name: 'One Co' } },
  { id: 'page-02', url: 'https://two.example.test/careers', provider: null, boardToken: null, tier: 3, isActive: true, company: { name: 'Two Co' } },
  { id: 'page-03', url: 'https://three.example.test/careers', provider: 'lever', boardToken: 'three', tier: 1, isActive: true, company: { name: 'Three Co' } },
  { id: 'page-04', url: 'https://four.example.test/careers', provider: 'ashby', boardToken: 'four', tier: 2, isActive: true, company: { name: 'Four Co' } },
  { id: 'page-05', url: 'https://five.example.test/careers', provider: 'workday', boardToken: 'five', tier: 1, isActive: true, company: { name: 'Five Co' } },
  { id: 'page-06', url: 'https://six.example.test/careers', provider: 'smartrecruiters', boardToken: 'six', tier: 3, isActive: true, company: { name: 'Six Co' } },
  { id: 'page-07', url: 'https://seven.example.test/careers', provider: 'workable', boardToken: 'seven', tier: 2, isActive: true, company: { name: 'Seven Co' } },
  { id: 'page-inactive', url: 'https://inactive.example.test/careers', provider: 'greenhouse', boardToken: 'inactive', tier: 1, isActive: false, company: { name: 'Inactive Co' } },
];

// Match the production predicate: only active rows, `(tier asc, id asc)`, and
// resume-after-(tier,id) when a cursor is supplied.
function activeRowsAfter(payload: { tier: number; id: string } | null): Row[] {
  const filtered = rows
    .filter((row) => row.isActive)
    .filter((row) => {
      if (payload === null) return true;
      return row.tier > payload.tier || (row.tier === payload.tier && row.id > payload.id);
    });
  return filtered.sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));
}

function publicPage(row: Row): RegistrySweepPage {
  return {
    id: row.id,
    companyName: row.company.name,
    url: row.url,
    provider: row.provider,
    boardToken: row.boardToken,
    tier: row.tier,
    cursor: `t:${row.tier}|${row.id}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.companyCareerPage.count.mockImplementation(async () => rows.filter((row) => row.isActive).length);
  prismaMocks.companyCareerPage.findMany.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    // Mirror the production OR predicate: `tier > at` OR `(tier == at AND id > ai)`.
    let decoded: { tier: number; id: string } | null = null;
    if (Array.isArray(where.OR)) {
      const tierGt = where.OR[0]?.tier?.gt;
      const tierEq = where.OR[1]?.tier;
      const idGt = where.OR[1]?.id?.gt;
      if (typeof tierGt === 'number' && typeof idGt === 'string') {
        decoded = { tier: tierGt, id: idGt };
      } else if (tierEq !== undefined && typeof idGt === 'string') {
        decoded = { tier: Number(tierEq), id: idGt };
      }
    }
    return activeRowsAfter(decoded).slice(0, args.take as number);
  });
});

describe('resolveRegistryPageBatch', () => {
  it('returns the lowest active (tier, id) rows, total, and a cursor for a full first batch', async () => {
    const batch = await resolveRegistryPageBatch(null, 3);

    // (tier asc, id asc): page-01 (t1), page-03 (t1), page-05 (t1).
    expect(batch.pages).toEqual([publicPage(rows[0]), publicPage(rows[2]), publicPage(rows[4])]);
    expect(batch.total).toBe(7);
    expect(batch.hasMore).toBe(true);
    expect(batch.nextCursor).toBe('t:1|page-05');
    // Wave 15 (T905) / ADR-034 D3 - this replaces the previous
    // `orderBy: { id: 'asc' }` pin. The new compound order is on the
    // IMMUTABLE pair `(tier, id)`: `nextCheckAt` is mutable registry
    // scheduling state and so cannot participate in a stable keyset, while
    // ordering by `tier` puts the 47,630 fast tier-1 JSON rows ahead of the
    // 22,030 slow tier-3 HTML rows so an aborted sweep has already covered
    // the rows that yield (spec section 5, AC24 rationale).
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ tier: 'asc' }, { id: 'asc' }],
      take: 3,
      include: { company: { select: { name: true } } },
    });
    expect(prismaMocks.companyCareerPage.count).toHaveBeenCalledWith({
      where: { isActive: true },
    });
  });

  it('uses the stored cursor as a keyset and never repeats the first batch', async () => {
    const first = await resolveRegistryPageBatch(null, 3);
    const second = await resolveRegistryPageBatch(first.nextCursor, 3);

    // After (tier=1, id=page-05): tier-2 rows in id order (page-04, page-07),
    // then tier-3 rows in id order (page-02 BEFORE page-06 in id order).
    expect(second.pages.map((page) => page.id)).toEqual(['page-04', 'page-07', 'page-02']);
    expect(second.pages.map((page) => page.companyName)).toEqual(['Four Co', 'Seven Co', 'Two Co']);
    expect(second.nextCursor).toBe('t:3|page-02');
    expect(second.hasMore).toBe(true);
    expect(second.pages.some((page) => first.pages.some((previous) => previous.url === page.url))).toBe(false);
    // Wave 15 (T905) / ADR-034 D3 - this replaces the previous
    // `where: { isActive: true, id: { gt: 'page-03' } }` pin. The compound
    // OR is asserted explicitly so the predicate cannot regress to a bare
    // `id` cursor.
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          OR: [
            { tier: { gt: 1 } },
            { tier: 1, id: { gt: 'page-05' } },
          ],
        },
        orderBy: [{ tier: 'asc' }, { id: 'asc' }],
        take: 3,
      }),
    );
  });

  it('marks a short final batch complete and returns no continuation cursor', async () => {
    // After (tier=3, id=page-06) there are no remaining active rows, so the
    // fetch returns an empty short batch with hasMore=false / nextCursor=null.
    const batch = await resolveRegistryPageBatch('t:3|page-06', 3);

    expect(batch.pages).toEqual([]);
    expect(batch.total).toBe(7);
    expect(batch.hasMore).toBe(false);
    expect(batch.nextCursor).toBeNull();
  });

  it('never returns inactive pages and keeps the active total', async () => {
    const batch = await resolveRegistryPageBatch(null, FULL_BATCH_PAGES);

    expect(batch.total).toBe(7);
    expect(batch.pages.map((page) => page.companyName)).not.toContain('Inactive Co');
    expect(batch.pages.map((page) => page.url)).not.toContain('https://inactive.example.test/careers');
    expect(batch.hasMore).toBe(false);
    expect(batch.nextCursor).toBeNull();
  });

  it('clamps an oversized or fractional limit to an integer take at the Full batch ceiling', async () => {
    await resolveRegistryPageBatch(null, FULL_BATCH_PAGES + 500);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: FULL_BATCH_PAGES }),
    );

    vi.clearAllMocks();
    prismaMocks.companyCareerPage.count.mockResolvedValue(7);
    prismaMocks.companyCareerPage.findMany.mockResolvedValue([]);
    await resolveRegistryPageBatch(null, 2.9);
    expect(prismaMocks.companyCareerPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2 }),
    );
  });

  it('returns an empty, complete batch for non-positive and non-finite limits', async () => {
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      vi.clearAllMocks();
      prismaMocks.companyCareerPage.count.mockResolvedValue(7);
      const batch = await resolveRegistryPageBatch(null, limit);

      expect(batch).toEqual({
        pages: [],
        total: 7,
        hasMore: false,
        nextCursor: null,
      });
      expect(prismaMocks.companyCareerPage.findMany).not.toHaveBeenCalled();
    }
  });

  it('a malformed after-cursor restarts from the beginning (never skips a row)', async () => {
    // Spec AC (T905 E): an unparseable/absent cursor restarts from the
    // beginning. Repeats are idempotent through the upsert path so a silent
    // skip would not be recoverable; this test pins that contract.
    const malformed = ['garbage', 't:not-a-number|page-03', 't:1|', 't:', '!@#$', 'page-03'];
    for (const value of malformed) {
      vi.clearAllMocks();
      prismaMocks.companyCareerPage.count.mockResolvedValue(7);
      prismaMocks.companyCareerPage.findMany.mockImplementation(async (args: any) => {
        const where = args?.where ?? {};
        let decoded: { tier: number; id: string } | null = null;
        if (Array.isArray(where.OR)) {
          const tierGt = where.OR[0]?.tier?.gt;
          const idGt = where.OR[1]?.id?.gt;
          if (typeof tierGt === 'number' && typeof idGt === 'string') {
            decoded = { tier: tierGt, id: idGt };
          }
        }
        return activeRowsAfter(decoded).slice(0, args.take as number);
      });
      const batch = await resolveRegistryPageBatch(value, 3);
      expect(batch.pages.map((page) => page.id)).toEqual(['page-01', 'page-03', 'page-05']);
      expect(batch.nextCursor).toBe('t:1|page-05');
      expect(batch.hasMore).toBe(true);
      // No OR predicate is sent to prisma on a malformed cursor restart.
      const findCallArgs = prismaMocks.companyCareerPage.findMany.mock.calls[0]?.[0];
      expect(findCallArgs?.where?.OR).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// T905 / ADR-034 D3 - exactly-once property test over a mixed-tier fixture
// (spec section 5 / acceptance criterion).
// ---------------------------------------------------------------------------

describe('keyset traversal: exactly-once over a mixed-tier fixture', () => {
  // Mixed-tier fixture (the pattern from the spec section 5 / acceptance
  // criterion). Tiers are interleaved deliberately so a pure `id` ordering
  // would step on a tier boundary mid-batch. Two inactive rows are also
  // present so the property test also rejects them.
  const mixedIds = Array.from({ length: 20 }, (_, index) => `m-${String(index + 1).padStart(2, '0')}`);
  const tierPattern: number[] = [1, 1, 3, 1, 3, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2];
  const mixedRows: Row[] = mixedIds.map((id, index) => ({
    id,
    url: `https://${id}.example.test/careers`,
    provider: 'greenhouse',
    boardToken: id,
    tier: tierPattern[index] ?? 1,
    isActive: true,
    company: { name: `Co ${id}` },
  }));
  const mixedInactive: Row[] = [
    { id: 'm-inactive-1', url: 'https://nope1.example.test/careers', provider: null, boardToken: null, tier: 1, isActive: false, company: { name: 'Inactive A' } },
    { id: 'm-inactive-3', url: 'https://nope2.example.test/careers', provider: null, boardToken: null, tier: 3, isActive: false, company: { name: 'Inactive B' } },
  ];
  const allMixed: Row[] = [...mixedRows, ...mixedInactive];

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.companyCareerPage.count.mockImplementation(async () => mixedRows.length);
    prismaMocks.companyCareerPage.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      let decoded: { tier: number; id: string } | null = null;
      if (Array.isArray(where.OR)) {
        const tierGt = where.OR[0]?.tier?.gt;
        const tierEq = where.OR[1]?.tier;
        const idGt = where.OR[1]?.id?.gt;
        if (typeof tierGt === 'number' && typeof idGt === 'string') {
          decoded = { tier: tierGt, id: idGt };
        } else if (tierEq !== undefined && typeof idGt === 'string') {
          decoded = { tier: Number(tierEq), id: idGt };
        }
      }
      return allMixed
        .filter((row) => row.isActive)
        .filter((row) => {
          if (decoded === null) return true;
          return row.tier > decoded.tier || (row.tier === decoded.tier && row.id > decoded.id);
        })
        .sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id))
        .slice(0, args.take as number);
    });
  });

  it('visits every active row exactly once in (tier, id) order at batch size 3', async () => {
    const BATCH = 3;
    const visited: string[] = [];
    const batchSizes: number[] = [];
    let cursor: string | null = null;
    let batches = 0;
    while (true) {
      const batch = await resolveRegistryPageBatch(cursor, BATCH);
      batchSizes.push(batch.pages.length);
      for (const page of batch.pages) visited.push(page.id);
      batches += 1;
      if (!batch.hasMore) break;
      cursor = batch.nextCursor;
      if (batches > 100) throw new Error('infinite loop in property test');
    }

    // Every active row visited exactly once.
    expect(visited).toHaveLength(mixedRows.length);
    expect(new Set(visited).size).toBe(visited.length);
    expect(new Set(visited)).toEqual(new Set(mixedRows.map((row) => row.id)));

    // No inactive row ever appears.
    expect(visited).not.toContain('m-inactive-1');
    expect(visited).not.toContain('m-inactive-3');

    // Visited order is the canonical `(tier asc, id asc)`.
    const expectedOrder = [...mixedRows]
      .sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id))
      .map((row) => row.id);
    expect(visited).toEqual(expectedOrder);

    // 20 active rows at batch size 3 -> six 3-row full batches + one 2-row
    // short batch. `hasMore` is true until the short final batch.
    expect(batchSizes).toEqual([3, 3, 3, 3, 3, 3, 2]);
    expect(batches).toBe(7);
  });

  it('a short final batch has hasMore=false and nextCursor=null', async () => {
    // Drive the same mixed fixture to its last batch and pin the short
    // final batch semantics end-to-end: hasMore false, nextCursor null,
    // and the partial count is exactly what's left (never padded out to
    // `take` with repeats / fabricated ids).
    let cursor: string | null = null;
    let last: Awaited<ReturnType<typeof resolveRegistryPageBatch>> | null = null;
    while (true) {
      const batch = await resolveRegistryPageBatch(cursor, 3);
      if (!batch.hasMore) {
        last = batch;
        break;
      }
      cursor = batch.nextCursor;
    }
    expect(last).not.toBeNull();
    expect(last!.hasMore).toBe(false);
    expect(last!.nextCursor).toBeNull();
    expect(last!.pages).not.toHaveLength(3);
    // No tier-2 / tier-3 row was repeated from any earlier batch either.
    const seenIds = new Set<string>();
    cursor = null;
    while (true) {
      const batch = await resolveRegistryPageBatch(cursor, 3);
      for (const page of batch.pages) {
        expect(seenIds.has(page.id)).toBe(false);
        seenIds.add(page.id);
      }
      if (!batch.hasMore) break;
      cursor = batch.nextCursor;
    }
  });
});

describe('countActiveRegistryPages', () => {
  it('counts only active career pages', async () => {
    await expect(countActiveRegistryPages()).resolves.toBe(7);
    expect(prismaMocks.companyCareerPage.count).toHaveBeenCalledWith({
      where: { isActive: true },
    });
  });
});

describe('module boundaries', () => {
  it('has no scheduler, timer, write, or secret logging in the reader', () => {
    const source = readFileSync(path.join(__dirname, 'registrySweep.ts'), 'utf8');
    expect(source).not.toMatch(/setInterval|setTimeout|cron/i);
    expect(source).not.toMatch(/\b(create|update|upsert|delete|deleteMany)\s*\(/);
    expect(source).not.toMatch(/console\.(log|warn|error)/);
  });
});
