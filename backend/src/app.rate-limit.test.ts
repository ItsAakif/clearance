// HTTP limiter contract tests (T884). The route aggregator is replaced with
// tiny deterministic routes so these tests exercise app.ts middleware without
// a database, network, or a completed Full-scan route.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('./middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.header('x-test-user');
    if (!id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = { id, email: 'test@example.com', isAdmin: false };
    return next();
  },
}));

vi.mock('./routes/index.js', async () => {
  const { Router } = await import('express');
  // Keep the route-level auth gate in this stand-in router, as in jobs.ts.
  // The app-level limiter must authenticate before this route is reached.
  const { requireAuth } = await import('./middleware/auth.js');
  const router = Router();
  router.get('/jobs/runs/:runId', (_req, res) => res.json({ runId: 'test-run' }));
  router.get('/jobs/full-scan', requireAuth, (req, res) => {
    res.json({ hasMore: false, userId: req.user?.id });
  });
  router.get('/jobs/search', (_req, res) => res.json([]));
  router.post('/jobs/full-scan', (_req, res) => res.json({ hasMore: false }));
  return { default: router };
});

import app, { FULL_SCAN_RATE_LIMIT_MAX, fullScanLimiter, generalLimiter } from './app.js';

const TEST_USERS = [
  'rate-limit-user',
  'limiter-user-a',
  'limiter-user-b',
  'production-user-a',
  'production-user-b',
  'production-user-after-unauth',
];

function resetIpKeys(): void {
  // Supertest normally reports either IPv4 loopback spelling depending on
  // the host/runtime. Reset both forms; this is test-only store hygiene.
  for (const key of ['127.0.0.1', '::ffff:127.0.0.1', ...TEST_USERS]) {
    generalLimiter.resetKey(key);
    fullScanLimiter.resetKey(key);
  }
}

function fullScanRequest(user = 'rate-limit-user') {
  return request(app)
    .get('/api/jobs/full-scan')
    .set('x-test-user', user);
}

beforeEach(() => {
  resetIpKeys();
});

describe('app rate-limit paths', () => {
  // The four tests below each drive 100-105 SEQUENTIAL supertest round-trips, so
  // their wall-clock cost scales with machine load while vitest's per-test
  // default (5000ms) is fixed. Load sensitivity measured on 2026-09-25: solo the
  // file is green and fast (6 tests in ~1.4s, these loops ~430ms each), but
  // under full-suite parallel load the same file took 4598ms in one passing run
  // and 11065ms in another - and in four separate full runs the POST loop and
  // the read loop both blew the 5000ms default with "Test timed out in 5000ms".
  // The 429 seen in the following test is a CASCADE of that timeout, not an
  // independent bug: vitest does not cancel a timed-out async body, so the
  // orphaned loop keeps draining the shared in-memory `generalLimiter`
  // 127.0.0.1 budget (max 100) while the next test runs.
  // 30_000 is headroom for loop cost only: a genuine hang in these loops still
  // fails, it is just no longer indistinguishable from load-induced slowness.
  // Same shape as the matcher import-cost test - see
  // .planning/progress/t892-matcher-timeout-hardening.md. The two tests in the
  // next describe block make 2-3 requests each and keep the default.
  it(
    'does not count more than 100 run snapshot reads against the general limiter',
    async () => {
      for (let i = 0; i < 105; i += 1) {
        const response = await request(app).get('/api/jobs/runs/poll-1');
        expect(response.status).toBe(200);
      }
    },
    30_000,
  );

  it(
    'uses the higher dedicated ceiling only for exact GET /jobs/full-scan',
    async () => {
      for (let i = 0; i < 105; i += 1) {
        const response = await fullScanRequest();
        expect(response.status).toBe(200);
        expect(response.headers['ratelimit-limit']).toBe(String(FULL_SCAN_RATE_LIMIT_MAX));
      }
    },
    30_000,
  );

  it(
    'does not apply the Full-scan ceiling to a POST at the same path',
    async () => {
      for (let i = 0; i < 2000; i += 1) {
        expect((await request(app).post('/api/jobs/full-scan')).status).toBe(200);
      }
      expect((await request(app).post('/api/jobs/full-scan')).status).toBe(429);
    },
    120_000,
  );

  it(
    'keeps the general ceiling on ordinary API reads',
    async () => {
      for (let i = 0; i < 2000; i += 1) {
        expect((await request(app).get('/api/jobs/search')).status).toBe(200);
      }
      const limited = await request(app).get('/api/jobs/search');
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: 'Too many requests. Please try again later.' });
    },
    120_000,
  );
});

describe('Full-scan keying in production order', () => {
  it('keys two authenticated users separately after the auth gate', async () => {
    const firstUser = await fullScanRequest('production-user-a');
    const secondUser = await fullScanRequest('production-user-b');

    expect(firstUser.status).toBe(200);
    expect(secondUser.status).toBe(200);
    expect(firstUser.body.userId).toBe('production-user-a');
    expect(secondUser.body.userId).toBe('production-user-b');
    expect(firstUser.headers['ratelimit-remaining']).toBe('1499');
    expect(secondUser.headers['ratelimit-remaining']).toBe('1499');
  });

  it('does not let unauthenticated traffic consume an authenticated user budget', async () => {
    const unauthenticated = await request(app).get('/api/jobs/full-scan');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers['ratelimit-limit']).toBeUndefined();

    const authenticated = await fullScanRequest('production-user-after-unauth');
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers['ratelimit-remaining']).toBe('1499');
  });
});
