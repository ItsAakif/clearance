import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Auth passthrough: no x-test-user header -> 401, mirroring the real middleware.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id || typeof id !== 'string') return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

// The router only builds the Prisma store lazily in its default export.
vi.mock('../lib/prisma.js', () => ({ default: {} }));

import { createCatalogueRouter } from './jobs.catalogue.js';
import { createInMemoryCatalogueStore } from '../search/query.js';
import { buildSearchDocument, type SearchDocument } from '../search/document.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const DOCS: SearchDocument[] = [
  buildSearchDocument({
    id: 'r1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote - US',
    source: 'greenhouse',
    sourceUrl: 'https://example.com/r1',
    postedAt: new Date(NOW - 1 * DAY),
    description: 'TypeScript and AWS. Salary $150,000-$180,000.',
  }),
  buildSearchDocument({
    id: 'r2',
    title: 'Frontend Engineer',
    company: 'Beta',
    location: 'Berlin, Germany',
    source: 'lever',
    postedAt: new Date(NOW - 2 * DAY),
    description: 'React and CSS.',
  }),
  buildSearchDocument({
    id: 'r3',
    title: 'Product Manager',
    company: 'Gamma',
    location: 'Hybrid - London',
    source: 'ashby',
    postedAt: new Date(NOW - 20 * DAY),
    description: 'Roadmaps and user research.',
  }),
];

const WIRE_KEYS = [
  'id',
  'title',
  'company',
  'location',
  'source',
  'sourceUrl',
  'applyUrl',
  'postedAt',
  'firstSeenAt',
  'isActive',
  'workMode',
  'seniority',
  'specialization',
  'skills',
  'salary',
  'region',
  'descriptionExcerpt',
  'docVersion',
  'ghost',
];

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/jobs', createCatalogueRouter(createInMemoryCatalogueStore(DOCS)));
  return app;
}

function get(path: string, authenticated = true) {
  const call = request(makeApp()).get(path);
  return authenticated ? call.set('x-test-user', 'user-1') : call;
}

describe('GET /jobs/catalogue - auth', () => {
  it('returns 401 without a user', async () => {
    const response = await get('/jobs/catalogue', false);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Unauthorized' });
  });
});

describe('GET /jobs/catalogue - validation', () => {
  it('rejects an unsupported postedWithin with a machine-readable code', async () => {
    const response = await get('/jobs/catalogue?postedWithin=5');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('catalogue_invalid_query');
    expect(typeof response.body.error).toBe('string');
  });

  it('rejects limit above the maximum', async () => {
    const response = await get('/jobs/catalogue?limit=51');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('catalogue_invalid_query');
  });

  it('refuses pages beyond the offset+limit cap', async () => {
    const response = await get('/jobs/catalogue?page=501&limit=20');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('catalogue_page_too_deep');
  });
});

describe('GET /jobs/catalogue - response', () => {
  it('returns the data/meta envelope with the no-join wire shape', async () => {
    const response = await get('/jobs/catalogue');
    expect(response.status).toBe(200);
    expect(response.body.meta).toMatchObject({ total: 3, page: 1, limit: 20 });
    expect(response.body.data.map((row: any) => row.id)).toEqual(['r1', 'r2', 'r3']);
    expect(Object.keys(response.body.data[0])).toEqual(WIRE_KEYS);
    expect(response.body.meta.facets.workMode).toEqual({ hybrid: 1, remote: 1 });
    expect(response.body.meta.facets.region).toEqual({ eu: 1, uk: 1, us: 1 });
  });

  it('accepts repeated and comma-joined multi-value filters', async () => {
    const repeated = await get('/jobs/catalogue?workMode=remote&workMode=hybrid');
    expect(repeated.body.data.map((row: any) => row.id)).toEqual(['r1', 'r3']);

    const joined = await get('/jobs/catalogue?workMode=remote,hybrid');
    expect(joined.body.data.map((row: any) => row.id)).toEqual(['r1', 'r3']);
  });

  it('combines q, a facet filter, recency, sort and limit', async () => {
    const response = await get(
      '/jobs/catalogue?q=engineer&workMode=remote&postedWithin=7&sort=newest&limit=5',
    );
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: any) => row.id)).toEqual(['r1']);
    expect(response.body.data[0].workMode).toBe('remote');
    expect(response.body.meta.facets.source).toEqual({ greenhouse: 1 });
  });

  it('pages with offset/limit', async () => {
    const response = await get('/jobs/catalogue?page=2&limit=1');
    expect(response.body.data.map((row: any) => row.id)).toEqual(['r2']);
    expect(response.body.meta).toMatchObject({ total: 3, page: 2, limit: 1 });
  });
});
