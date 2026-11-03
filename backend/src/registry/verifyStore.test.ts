// verifyStore contract tests (T904): the column list inside writePageVerification
// must be byte-identical to the pre-refactor inlined call that lived at
// crawler.ts:631-650. We assert this by driving writePageVerification with a
// spy on `prisma.companyCareerPage.update` and comparing the `data` key set.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPageForUpdate, writePageVerification } from './verifyStore.js';
import type { StoredCareerPage, VerificationUpdate } from './crawler.js';

const updateMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  default: {
    companyCareerPage: {
      update: (...args: unknown[]) => updateMock(...args),
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  },
}));

const pageId = 'page-test-1';
const storedRow: StoredCareerPage = {
  id: pageId,
  url: 'https://example.test/careers',
  provider: 'greenhouse',
  boardToken: 'tok',
  tier: 1,
  isActive: true,
  verifyStatus: 'unverified',
  verifyMethod: null,
  verifiedAt: null,
  lastCheckedAt: null,
  httpStatus: null,
  resultCount: 0,
  failureCount: 0,
  nextCheckAt: null,
  lastError: null,
};

const fullUpdate: VerificationUpdate = {
  verifyStatus: 'ok',
  verifyMethod: 'adapter',
  verifiedAt: new Date('2026-09-21T00:00:00.000Z'),
  lastCheckedAt: new Date('2026-09-21T00:00:00.000Z'),
  httpStatus: null,
  resultCount: 5,
  failureCount: 0,
  nextCheckAt: new Date('2026-09-22T00:00:00.000Z'),
  lastError: null,
  provider: 'greenhouse',
  boardToken: 'tok',
};

beforeEach(() => {
  updateMock.mockReset();
  findUniqueMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('writePageVerification column list', () => {
  it('writes the exact pre-refactor column list (byte-identical key set)', async () => {
    updateMock.mockResolvedValue(undefined);
    await writePageVerification(pageId, fullUpdate);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const call = updateMock.mock.calls[0][0] as { where: { id: string }; data: Record<string, unknown> };
    expect(call.where).toEqual({ id: pageId });
    // The byte-identical column list (assertion against the pre-refactor inlined call):
    const expectedKeys = [
      'verifyStatus',
      'verifyMethod',
      'verifiedAt',
      'lastCheckedAt',
      'httpStatus',
      'resultCount',
      'failureCount',
      'nextCheckAt',
      'lastError',
      'provider',
      'boardToken',
    ];
    expect(Object.keys(call.data).sort()).toEqual([...expectedKeys].sort());
    // No column is silently added or removed.
    expect(Object.keys(call.data)).toHaveLength(expectedKeys.length);
    // Spot-check that the values are forwarded as-is (no defensive copy that
    // could drop a column).
    expect(call.data.verifyStatus).toBe('ok');
    expect(call.data.verifyMethod).toBe('adapter');
    expect(call.data.resultCount).toBe(5);
    expect(call.data.failureCount).toBe(0);
    expect(call.data.provider).toBe('greenhouse');
    expect(call.data.boardToken).toBe('tok');
  });

  it('forwards null values through verbatim (a verified null is not omitted)', async () => {
    updateMock.mockResolvedValue(undefined);
    await writePageVerification(pageId, {
      ...fullUpdate,
      httpStatus: null,
      verifiedAt: null,
      lastError: null,
    });
    const call = updateMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data.httpStatus).toBeNull();
    expect(call.data.verifiedAt).toBeNull();
    expect(call.data.lastError).toBeNull();
  });
});

describe('readPageForUpdate', () => {
  it('returns the stored row when present', async () => {
    findUniqueMock.mockResolvedValue({ ...storedRow });
    const out = await readPageForUpdate(pageId);
    expect(out).toEqual(storedRow);
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { id: pageId } });
  });

  it('returns null when the row is missing (deleted between plan and write)', async () => {
    findUniqueMock.mockResolvedValue(null);
    const out = await readPageForUpdate(pageId);
    expect(out).toBeNull();
  });
});