import { describe, expect, it } from 'vitest';
import { ValidationError } from '../shared/validation.js';
import { buildSearchDocument, type SearchDocument } from './document.js';
import {
  CATALOGUE_MAX_OFFSET_PLUS_LIMIT,
  CATALOGUE_PAGE_TOO_DEEP_CODE,
  CatalogueError,
  buildCataloguePlan,
  catalogueQuery,
  createInMemoryCatalogueStore,
} from './query.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');

function doc(overrides: Parameters<typeof buildSearchDocument>[0]): SearchDocument {
  return buildSearchDocument({
    source: 'greenhouse',
    sourceUrl: 'https://example.com/job',
    isActive: true,
    ...overrides,
  });
}

const DOCS: SearchDocument[] = [
  doc({
    id: 'd1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Remote - US',
    source: 'greenhouse',
    postedAt: new Date('2026-10-29T12:00:00.000Z'),
    description: 'TypeScript, AWS and Node.js. Salary $150,000-$180,000.',
  }),
  doc({
    id: 'd2',
    title: 'Frontend Engineer',
    company: 'Beta',
    location: 'Berlin, Germany',
    source: 'lever',
    postedAt: new Date('2026-10-20T12:00:00.000Z'),
    description: 'React and CSS.',
  }),
  doc({
    id: 'd3',
    title: 'Data Scientist',
    company: 'Gamma',
    location: 'London, United Kingdom',
    source: 'ashby',
    postedAt: new Date('2026-10-01T12:00:00.000Z'),
    description: 'Machine learning and Python.',
  }),
  doc({
    id: 'd4',
    title: 'Product Manager',
    company: 'Delta',
    location: null,
    source: 'greenhouse',
    postedAt: null,
    firstSeenAt: new Date('2026-10-28T12:00:00.000Z'),
    description: 'Roadmaps and user research.',
  }),
  doc({
    id: 'd5',
    title: 'Staff Platform Engineer',
    company: 'Acme',
    location: 'San Francisco, CA',
    source: 'ashby',
    postedAt: new Date('2026-09-01T12:00:00.000Z'),
    description: 'Kubernetes and Terraform.',
  }),
];

const store = createInMemoryCatalogueStore(DOCS);

async function ids(input: Record<string, unknown>): Promise<string[]> {
  const result = await catalogueQuery(store, input, { now: NOW });
  return result.data.map((row) => row.id);
}

describe('catalogueQuery - filters combine', () => {
  it('filters by workMode and returns only explicit remote rows', async () => {
    expect(await ids({ workMode: ['remote'] })).toEqual(['d1']);
  });

  it('ANDs different groups, ORs values within one group', async () => {
    expect(await ids({ workMode: ['remote'], seniority: ['senior'] })).toEqual(['d1']);
    expect(await ids({ workMode: ['remote'], seniority: ['staff'] })).toEqual([]);
    expect(await ids({ workMode: ['remote', 'hybrid'] })).toEqual(['d1']);
  });

  it('matches skills by canonical key so AWS finds amazon web services', async () => {
    expect(await ids({ skills: ['AWS'] })).toEqual(['d1']);
    expect(await ids({ skills: ['react'] })).toEqual(['d2']);
  });

  it('applies salaryMin to the advertised maximum', async () => {
    expect(await ids({ salaryMin: 160000 })).toEqual(['d1']);
    expect(await ids({ salaryMin: 200000 })).toEqual([]);
  });

  it('does case-insensitive substring matching for location and company', async () => {
    expect(await ids({ location: 'berlin' })).toEqual(['d2']);
    expect(await ids({ company: 'acme' })).toEqual(['d1', 'd5']);
  });

  it('uses postedAt ?? firstSeenAt for postedWithin and drops undated rows', async () => {
    expect(await ids({ postedWithin: 3 })).toEqual(['d1', 'd4']);
    expect(await ids({ postedWithin: 1 })).toEqual(['d1']);
  });

  it('combines q with a facet filter', async () => {
    expect(await ids({ q: 'engineer', workMode: ['remote'] })).toEqual(['d1']);
  });
});

describe('catalogueQuery - sort', () => {
  it('newest-first by postedAt ?? firstSeenAt, undated last', async () => {
    expect(await ids({ sort: 'newest' })).toEqual(['d1', 'd4', 'd2', 'd3', 'd5']);
  });

  it('defaults to newest when there is no q', () => {
    expect(buildCataloguePlan({}, NOW).sort).toBe('newest');
  });

  it('defaults to relevance when a q is present', () => {
    expect(buildCataloguePlan({ q: 'engineer' }, NOW).sort).toBe('relevance');
  });

  it('relevance orders by FTS token match, then recency', async () => {
    expect(await ids({ q: 'engineer' })).toEqual(['d1', 'd2', 'd5']);
    expect(await ids({ q: 'acme' })).toEqual(['d1', 'd5']);
  });
});

describe('catalogueQuery - pagination', () => {
  it('pages with offset/limit and reports the full total', async () => {
    const result = await catalogueQuery(store, { page: 2, limit: 2 }, { now: NOW });
    expect(result.data.map((row) => row.id)).toEqual(['d2', 'd3']);
    expect(result.meta).toMatchObject({ total: 5, page: 2, limit: 2 });
  });

  it('defaults to page 1 and limit 20', async () => {
    const result = await catalogueQuery(store, {}, { now: NOW });
    expect(result.meta.page).toBe(1);
    expect(result.meta.limit).toBe(20);
  });

  it('refuses offset + limit beyond the cap with a machine code', async () => {
    await expect(
      catalogueQuery(store, { page: 501, limit: 20 }, { now: NOW }),
    ).rejects.toMatchObject({
      name: 'CatalogueError',
      code: CATALOGUE_PAGE_TOO_DEEP_CODE,
      statusCode: 400,
    });
    // Exactly at the cap is allowed.
    const atCap = await catalogueQuery(
      store,
      { page: CATALOGUE_MAX_OFFSET_PLUS_LIMIT / 20, limit: 20 },
      { now: NOW },
    );
    expect(atCap.meta.page).toBe(500);
  });

  it('rejects invalid input with a 400-class ValidationError', async () => {
    await expect(catalogueQuery(store, { postedWithin: 5 }, { now: NOW })).rejects.toBeInstanceOf(ValidationError);
    await expect(catalogueQuery(store, { limit: 0 }, { now: NOW })).rejects.toBeInstanceOf(ValidationError);
    await expect(catalogueQuery(store, { sort: 'oldest' }, { now: NOW })).rejects.toBeInstanceOf(ValidationError);
  });

  it('exposes CatalogueError as an HttpError subclass', () => {
    const error = new CatalogueError(400, 'x', 'message');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('x');
  });
});

describe('catalogueQuery - facets', () => {
  it('counts every group over the current filtered set', async () => {
    const result = await catalogueQuery(store, {}, { now: NOW });
    expect(result.meta.facets).toEqual({
      region: { us: 2, eu: 1, uk: 1 },
      workMode: { remote: 1 },
      seniority: { lead: 1, senior: 1, staff: 1 },
      specialization: {
        'backend-engineer': 1,
        'data-scientist': 1,
        'devops-engineer': 1,
        'frontend-engineer': 1,
        'product-manager': 1,
      },
      skills: {
        'amazon web services': 1,
        javascript: 1,
        kubernetes: 1,
        'machine learning': 1,
        node: 1,
        react: 1,
        typescript: 1,
      },
      source: { ashby: 2, greenhouse: 2, lever: 1 },
      postedWithin: { '1': 1, '3': 2, '7': 2, '14': 3, '30': 4 },
    });
  });

  it('narrows facet counts when a filter is applied', async () => {
    const result = await catalogueQuery(store, { workMode: ['remote'] }, { now: NOW });
    expect(result.meta.facets.region).toEqual({ us: 1 });
    expect(result.meta.facets.workMode).toEqual({ remote: 1 });
    expect(result.meta.facets.seniority).toEqual({ senior: 1 });
    expect(result.meta.facets.source).toEqual({ greenhouse: 1 });
  });

  it('returns empty objects when no row matches', async () => {
    const result = await catalogueQuery(store, { company: 'nobody' }, { now: NOW });
    expect(result.data).toEqual([]);
    expect(result.meta.facets).toEqual({
      region: {},
      workMode: {},
      seniority: {},
      specialization: {},
      skills: {},
      source: {},
      postedWithin: {},
    });
  });
});
