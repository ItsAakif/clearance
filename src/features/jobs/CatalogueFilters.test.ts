import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CatalogueFacets } from '@/services/api/jobs';
import { CatalogueFilters } from './CatalogueFilters';
import { createEmptyCatalogueFilters } from './catalogueParams';

const FACETS: CatalogueFacets = {
  region: { us: 900, eu: 120 },
  workMode: { remote: 248, hybrid: 0 },
  seniority: { senior: 12, junior: 0 },
  specialization: { 'backend-engineer': 40 },
  skills: { TypeScript: 31 },
  source: { greenhouse: 77 },
  postedWithin: { '1': 5, '7': 19, '30': 0 },
};

function render(facets: CatalogueFacets = FACETS): string {
  return renderToStaticMarkup(
    createElement(CatalogueFilters, {
      facets,
      filters: createEmptyCatalogueFilters(),
      onChange: () => undefined,
      onClearAll: () => undefined,
      showSalary: true,
      currency: 'USD',
    }),
  );
}

describe('CatalogueFilters - facet rail', () => {
  it('renders the fixed group order: work mode, seniority, specialization, skills, salary, posted, region, source', () => {
    const html = render();
    const labels = ['Work mode', 'Seniority', 'Specialization', 'Skills', 'Salary', 'Posted', 'Region', 'Source'];
    const positions = labels.map((label) => html.indexOf(label));
    for (const position of positions) assert.ok(position >= 0, 'all groups render');
    const sorted = [...positions].sort((a, b) => a - b);
    assert.deepEqual(positions, sorted);
  });

  it('renders counts right-aligned beside each value', () => {
    const html = render();
    assert.match(html, />Remote</);
    assert.match(html, />248</);
    assert.match(html, />Senior</);
    assert.match(html, />12</);
    assert.match(html, />TypeScript</);
    assert.match(html, />31</);
    assert.match(html, />Greenhouse</);
    assert.match(html, />77</);
  });

  it('hides facet values and groups whose count is zero or absent', () => {
    const html = render();
    assert.equal(html.includes('>Hybrid<'), false);
    assert.equal(html.includes('>Junior<'), false);
    assert.equal(html.includes('>30 days<'), false);

    const withoutSkills = render({ ...FACETS, skills: {}, source: {} });
    assert.equal(withoutSkills.includes('Skills'), false);
    assert.equal(withoutSkills.includes('Source'), false);
  });

  it('uses native checkboxes with a fieldset per group', () => {
    const html = render();
    assert.match(html, /<fieldset/);
    assert.match(html, /type="checkbox"/);
    assert.match(html, /aria-label="Work mode"/);
  });

  it('renders the salary control only when rows carry a range', () => {
    const withSalary = render();
    assert.match(withSalary, /Minimum annual salary/);
    const withoutSalary = renderToStaticMarkup(
      createElement(CatalogueFilters, {
        facets: FACETS,
        filters: createEmptyCatalogueFilters(),
        onChange: () => undefined,
        onClearAll: () => undefined,
        showSalary: false,
      }),
    );
    assert.equal(withoutSalary.includes('Minimum annual salary'), false);
  });

  it('renders Region as plain count rows, not dead checkboxes', () => {
    const html = render();
    assert.match(html, /United States/);
    assert.match(html, />900</);
    const regionIndex = html.indexOf('>Region<');
    assert.ok(regionIndex >= 0);
    const detailsEnd = html.indexOf('</details>', regionIndex);
    const regionMarkup = html.slice(regionIndex, detailsEnd);
    assert.equal(regionMarkup.includes('<input'), false);
  });
});
