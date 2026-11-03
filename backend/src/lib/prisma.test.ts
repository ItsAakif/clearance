import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  buildPooledDatabaseUrl,
  connectWithRetry,
  isTerminatedConnectionError,
  withDbRetry,
} from './prisma.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lib/prisma connection resilience', () => {
  it('retries once on E57P01 administrator-command termination then succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('terminating connection due to administrator command'), {
          code: 'E57P01',
        }),
      )
      .mockResolvedValueOnce({ ok: true });

    const result = await withDbRetry(operation);

    expect(result).toEqual({ ok: true });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('retries once on closed-connection (kind Closed) then succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('Server has closed the connection'), { kind: 'Closed' }),
      )
      .mockResolvedValueOnce('recovered');

    await expect(withDbRetry(operation)).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not retry non-termination errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const operation = vi.fn().mockRejectedValueOnce(new Error('Unique constraint failed'));

    await expect(withDbRetry(operation)).rejects.toThrow('Unique constraint failed');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('detects terminated-connection error shapes', () => {
    expect(
      isTerminatedConnectionError(
        Object.assign(new Error('terminating connection due to administrator command'), {
          code: 'E57P01',
        }),
      ),
    ).toBe(true);
    expect(
      isTerminatedConnectionError(
        Object.assign(new Error('Server has closed the connection'), { kind: 'Closed' }),
      ),
    ).toBe(true);
    expect(isTerminatedConnectionError(new Error('Unique constraint failed'))).toBe(false);
  });

  it('appends small-pool params for serverless poolers', () => {
    const url = buildPooledDatabaseUrl('postgresql://u:p@host:5432/db?schema=public');
    expect(url).toContain('connection_limit=2');
    expect(url).toContain('pool_timeout=20');
    expect(url).toContain('connect_timeout=10');
    expect(url).toContain('schema=public');
  });

  it('keeps explicit pool params instead of overriding them', () => {
    const url = buildPooledDatabaseUrl(
      'postgresql://u:p@host:5432/db?schema=public&connection_limit=1&pool_timeout=30',
    );
    expect(url).toContain('connection_limit=1');
    expect(url).toContain('pool_timeout=30');
  });

  it('startup probe retries with backoff and succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const queryRaw = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce([{ '?column?': 1 }]);
    const client = { $queryRaw: queryRaw } as never;

    await connectWithRetry(client, 3, 1);

    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});
