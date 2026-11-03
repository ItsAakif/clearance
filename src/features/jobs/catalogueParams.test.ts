import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  activeCatalogueFilterCount,
  applyCatalogueFilterChange,
  buildCatalogueParams,
  buildCatalogueQueryString,
  catalogueQueryKey,
  createEmptyCatalogueFilters,
  describeCatalogueFilters,
  toggleCatalogueFacet,
  togglePostedWithin,
} from './catalogueParams';

function parse(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('catalogueParams - wire serialisation', () => {
  it('serialises multi-value facet groups comma-joined', () => {
    const filters = applyCatalogueFilterChange(createEmptyCatalogueFilters(), {
      workMode: ['remote', 'hybrid'],
      seniority: ['senior', 'staff'],
      specialization: ['backend-engineer'],
      skills: ['TypeScript', 'React'],
      source: ['greenhouse', 'ashby'],
    });

    const params = parse(buildCatalogueQueryString(filters));
    assert.equal(params.get('workMode'), 'remote,hybrid');
    assert.equal(params.get('seniority'), 'senior,staff');
    assert.equal(params.get('specialization'), 'backend-engineer');
    assert.equal(params.get('skills'), 'TypeScript,React');
    assert.equal(params.get('source'), 'greenhouse,ashby');
  });

  it('omits empty groups instead of sending empty strings', () => {
    const params = parse(buildCatalogueQueryString(createEmptyCatalogueFilters()));
    assert.equal(params.has('workMode'), false);
    assert.equal(params.has('seniority'), false);
    assert.equal(params.has('salaryMin'), false);
    assert.equal(params.has('postedWithin'), false);
    assert.equal(params.get('sort'), 'newest');
    assert.equal(params.get('page'), '1');
    assert.equal(params.get('limit'), '20');
  });

  it('sends postedWithin and salaryMin as scalar values', () => {
    const filters = applyCatalogueFilterChange(createEmptyCatalogueFilters(), {
      postedWithin: 7,
      salaryMin: 120000,
    });
    const params = parse(buildCatalogueQueryString(filters));
    assert.equal(params.get('postedWithin'), '7');
    assert.equal(params.get('salaryMin'), '120000');
  });

  it('buildCatalogueParams exposes the same values as the query string', () => {
    const filters = applyCatalogueFilterChange(createEmptyCatalogueFilters(), {
      q: '  platform engineer ',
      location: ' Berlin ',
      workMode: ['remote'],
      salaryMin: 90000.9,
    });
    const params = buildCatalogueParams(filters);
    assert.equal(params.q, 'platform engineer');
    assert.equal(params.location, 'Berlin');
    assert.deepEqual(params.workMode, ['remote']);
    assert.equal(params.salaryMin, 90000);
  });
});

describe('catalogueParams - page reset', () => {
  it('resets page to 1 on any filter patch, even when the caller passes page 3', () => {
    const current = { ...createEmptyCatalogueFilters(), page: 3 };
    const next = applyCatalogueFilterChange(current, { q: 'rust' });
    assert.equal(next.page, 1);
  });

  it('resets page to 1 when a facet is toggled', () => {
    const current = { ...createEmptyCatalogueFilters(), page: 4 };
    const next = toggleCatalogueFacet(current, 'workMode', 'remote');
    assert.equal(next.page, 1);
    assert.deepEqual(next.workMode, ['remote']);
  });

  it('resets page to 1 when postedWithin is toggled', () => {
    const current = { ...createEmptyCatalogueFilters(), page: 2 };
    assert.equal(togglePostedWithin(current, 7).page, 1);
  });

  it('falls back from relevance to newest when the query is cleared', () => {
    const current = applyCatalogueFilterChange(createEmptyCatalogueFilters(), {
      q: 'designer',
      sort: 'relevance',
    });
    const cleared = applyCatalogueFilterChange(current, { q: '' });
    assert.equal(cleared.sort, 'newest');
  });
});

describe('catalogueParams - counts, summary and query key', () => {
  it('counts each active user-visible filter once', () => {
    const filters = applyCatalogueFilterChange(createEmptyCatalogueFilters(), {
      q: 'react',
      location: 'remote',
      workMode: ['remote'],
      seniority: ['senior'],
      skills: ['TypeScript'],
      salaryMin: 100000,
      postedWithin: 14,
      source: ['greenhouse'],
    });
    assert.equal(activeCatalogueFilterCount(filters), 8);
  });

  it('describes the active filters as plain text', () => {
    const filters = applyCatalogueFilterChange(createEmptyCatalogueFilters(), {
      q: 'react',
      location: 'Berlin',
      workMode: ['remote'],
      seniority: ['senior'],
      salaryMin: 120000,
      postedWithin: 7,
    });
    const summary = describeCatalogueFilters(filters);
    assert.match(summary, /"react"/);
    assert.match(summary, /in Berlin/);
    assert.match(summary, /Remote/);
    assert.match(summary, /Senior/);
    assert.match(summary, /from 120k/);
    assert.match(summary, /posted in 7 days/);
  });

  it('keeps page and limit out of the query key so Load more does not re-key', () => {
    const filters = createEmptyCatalogueFilters();
    const key = catalogueQueryKey({ ...filters, page: 3, limit: 50 });
    const serialised = JSON.stringify(key);
    assert.equal(serialised.includes('"page"'), false);
    assert.equal(serialised.includes('"limit"'), false);
  });
});
