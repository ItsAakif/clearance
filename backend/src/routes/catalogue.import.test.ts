// POST /catalogue/import - auth/admin, integrity, size cap and https-only.
//
// The route is mounted with injected import deps so the real sha256 check runs
// end-to-end without a database.

import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id || typeof id !== 'string') return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id, email: 'test@example.com', isAdmin: req.headers['x-test-admin'] === 'true' };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({
  default: {
    jobListing: { count: vi.fn(), findMany: vi.fn() },
    appSetting: { findUnique: vi.fn() },
  },
}));

import { createCatalogueRouter, type CatalogueRouterDeps } from './catalogue.js';
import {
  buildSnapshotManifest,
  encodeSnapshotJsonl,
  gzipSnapshot,
  type SnapshotRecord,
} from '../search/snapshot.js';

const RECORD: SnapshotRecord = {
  id: 'row-1',
  canonicalKey: 'sha256-canonical-1',
  source: 'greenhouse',
  externalId: 'gh-1',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Remote - US',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  postedAt: '2026-09-01T10:00:00.000Z',
  firstSeenAt: '2026-09-02T10:00:00.000Z',
  isActive: true,
  workMode: 'remote',
  seniority: 'senior',
  specialization: 'backend-engineer',
  skills: ['typescript'],
  salary: null,
  region: 'us',
  descriptionExcerpt: 'Excerpt only.',
  docVersion: '1',
};

function artifact(records: SnapshotRecord[] = [RECORD]) {
  const gzip = gzipSnapshot(encodeSnapshotJsonl(records));
  const manifest = buildSnapshotManifest({
    generatedAt: '2026-10-01T00:00:00.000Z',
    records,
    bytes: gzip,
  });
  return { gzip, manifest };
}

function makeApp(overrides: Partial<CatalogueRouterDeps> = {}) {
  const upsertJobs = vi.fn(async (jobs: Array<{ source: string; externalId?: string }>) =>
    jobs.map((job) => ({ source: job.source, externalId: job.externalId })),
  );
  const app = express();
  app.use(express.json());
  app.use(
    '/catalogue',
    createCatalogueRouter({
      importDeps: { upsertJobs, loadInactiveKeys: async () => [] },
      recordImportedAt: vi.fn(async () => undefined),
      readStatus: async () => ({ total: 10, active: 9, importedAt: '2026-10-01T00:00:00.000Z' }),
      feedUrl: 'https://example.com/catalogue.jsonl.gz',
      nodeEnv: 'test',
      ...overrides,
    }),
  );
  return app;
}

function authed(app: express.Express, admin = true) {
  return request(app).post('/catalogue/import').set('x-test-user', 'user-1').set('x-test-admin', admin ? 'true' : 'false');
}

describe('POST /catalogue/import - access', () => {
  it('returns 401 without a session', async () => {
    const response = await request(makeApp()).post('/catalogue/import').field('manifest', '{}');
    expect(response.status).toBe(401);
  });

  it('returns 403 for a non-admin session', async () => {
    const { gzip, manifest } = artifact();
    const response = await authed(makeApp(), false)
      .field('manifest', JSON.stringify(manifest))
      .attach('file', gzip, { filename: 'catalogue.jsonl.gz', contentType: 'application/gzip' });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Admin access required');
  });
});

describe('POST /catalogue/import - uploads', () => {
  it('imports a multipart snapshot and returns the pinned result shape', async () => {
    const { gzip, manifest } = artifact();
    const recordImportedAt = vi.fn(async () => undefined);
    const response = await authed(makeApp({ recordImportedAt }))
      .field('manifest', JSON.stringify(manifest))
      .attach('file', gzip, { filename: 'catalogue.jsonl.gz', contentType: 'application/gzip' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      imported: 1,
      reactivated: 0,
      skipped: 0,
      snapshotGeneratedAt: manifest.generatedAt,
    });
    expect(recordImportedAt).toHaveBeenCalledTimes(1);
  });

  it('refuses a tampered file with 400 and a sha mismatch code', async () => {
    const { gzip, manifest } = artifact();
    const tampered = Buffer.from(gzip);
    tampered[tampered.length - 1] ^= 0xff;
    const response = await authed(makeApp())
      .field('manifest', JSON.stringify(manifest))
      .attach('file', tampered, { filename: 'catalogue.jsonl.gz', contentType: 'application/gzip' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('snapshot_sha_mismatch');
  });

  it('requires a manifest alongside the file', async () => {
    const { gzip } = artifact();
    const response = await authed(makeApp()).attach('file', gzip, {
      filename: 'catalogue.jsonl.gz',
      contentType: 'application/gzip',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/manifest is required/);
  });

  it('accepts a raw octet-stream body with the manifest header', async () => {
    const { gzip, manifest } = artifact();
    const response = await authed(makeApp())
      .set('Content-Type', 'application/octet-stream')
      .set('x-snapshot-manifest', JSON.stringify(manifest))
      .send(gzip);

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(1);
  });

  it('rejects an octet-stream body above the injected size cap with 413', async () => {
    const { manifest } = artifact();
    const app = makeApp({ maxBytes: 32 });
    const response = await authed(app)
      .set('Content-Type', 'application/octet-stream')
      .set('x-snapshot-manifest', JSON.stringify(manifest))
      .send(Buffer.alloc(100, 1));

    expect(response.status).toBe(413);
    expect(response.body.code).toBe('snapshot_too_large');
  });
});

describe('POST /catalogue/import - remote URL', () => {
  it('allows only https and never calls fetch for http', async () => {
    const fetchImpl = vi.fn();
    const response = await authed(makeApp({ fetchImpl })).send({
      url: 'http://example.com/catalogue.jsonl.gz',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('downloads the snapshot and its sibling manifest over https', async () => {
    const { gzip, manifest } = artifact();
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-length' ? String(gzip.length) : null) },
        arrayBuffer: async () => (url.endsWith('manifest.json') ? manifestBytes : gzip),
      });
    });

    const response = await authed(
      makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).send({
      url: 'https://example.com/catalogue.jsonl.gz',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(1);
  });
});

function syncRequest(app: express.Express, admin = true) {
  return request(app)
    .post('/catalogue/sync')
    .set('x-test-user', 'user-1')
    .set('x-test-admin', admin ? 'true' : 'false');
}

function feedFetch(gzip: Buffer, manifest: object) {
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-length' ? String(gzip.length) : null) },
      arrayBuffer: async () => (url.endsWith('manifest.json') ? manifestBytes : gzip),
    };
  });
}

describe('POST /catalogue/sync', () => {
  it('requires a session and admin', async () => {
    expect((await request(makeApp()).post('/catalogue/sync')).status).toBe(401);

    const response = await syncRequest(makeApp(), false);
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Admin access required');
  });

  it('imports the configured feed and returns the published shape', async () => {
    const { gzip, manifest } = artifact();
    const fetchImpl = feedFetch(gzip, manifest);
    const response = await syncRequest(
      makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      imported: 1,
      reactivated: 0,
      skipped: 0,
      generatedAt: manifest.generatedAt,
      feedUrl: 'https://example.com/catalogue.jsonl.gz',
    });
  });

  it('answers 502 with a readable message when the feed is not published', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.alloc(0),
    }));
    const response = await syncRequest(
      makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch }),
    );

    expect(response.status).toBe(502);
    expect(response.body.error).toMatch(/daily snapshot is not published yet/i);
    expect(response.body.error).toMatch(/404/);
  });

  it('keeps the size cap as 413, not "not published"', async () => {
    const gzip = Buffer.alloc(100, 1);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-length' ? String(gzip.length) : null) },
      arrayBuffer: async () => gzip,
    }));
    const response = await syncRequest(
      makeApp({ fetchImpl: fetchImpl as unknown as typeof fetch, maxBytes: 32 }),
    );

    expect(response.status).toBe(413);
    expect(response.body.error).toMatch(/byte limit/);
  });

  it('allows loopback http in development only', async () => {
    const { gzip, manifest } = artifact();
    const fetchImpl = feedFetch(gzip, manifest);
    const devApp = makeApp({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      feedUrl: 'http://127.0.0.1:8123/catalogue.jsonl.gz',
      nodeEnv: 'development',
    });
    const devResponse = await syncRequest(devApp);
    expect(devResponse.status).toBe(200);

    const prodResponse = await syncRequest(
      makeApp({
        feedUrl: 'http://127.0.0.1:8123/catalogue.jsonl.gz',
        nodeEnv: 'production',
      }),
    );
    expect(prodResponse.status).toBe(400);
    expect(prodResponse.body.error).toMatch(/https/);
  });
});
