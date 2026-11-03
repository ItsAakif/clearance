import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SearchDocument } from '@/services/api/jobs';
import { CatalogueResults } from './CatalogueResults';

function document(id: string): SearchDocument {
  return {
    id,
    title: `Role ${id}`,
    company: 'Acme',
    location: 'Remote',
    source: 'greenhouse',
    sourceUrl: null,
    applyUrl: null,
    postedAt: '2026-10-30T09:00:00Z',
    firstSeenAt: '2026-10-30T09:00:00Z',
    isActive: true,
    workMode: 'remote',
    seniority: 'mid',
    specialization: null,
    skills: [],
    salary: null,
    region: 'us',
    descriptionExcerpt: '',
    docVersion: '1',
  };
}

const noop = () => undefined;

function render(overrides: Partial<Parameters<typeof CatalogueResults>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(CatalogueResults, {
      rows: [document('1'), document('2')],
      total: 240,
      loading: false,
      error: false,
      onRetry: noop,
      onSelect: noop,
      onClearAll: noop,
      hasNextPage: true,
      loadingMore: false,
      onLoadMore: noop,
      ...overrides,
    }),
  );
}

describe('CatalogueResults - list states', () => {
  it('renders one dense row per job and a Load more control', () => {
    const html = render();
    assert.match(html, /Role 1/);
    assert.match(html, /Role 2/);
    assert.match(html, /Showing 2 of 240/);
    assert.match(html, /Load more/);
  });

  it('hides Load more on the last page', () => {
    const html = render({ hasNextPage: false });
    assert.equal(html.includes('Load more'), false);
  });

  it('shows the quiet empty state with a Clear all action', () => {
    const html = render({ rows: [], total: 0, hasNextPage: false });
    assert.match(html, /No jobs match these filters\./);
    assert.match(html, /Clear all/);
  });

  it('shows skeleton rows while the first page loads', () => {
    const html = render({ rows: [], loading: true, hasNextPage: false });
    assert.match(html, /aria-label="Loading jobs"/);
    assert.match(html, /aria-busy="true"/);
  });

  it('shows a retry action on a first-page error', () => {
    const html = render({ rows: [], error: true, hasNextPage: false });
    assert.match(html, /Could not load the catalogue\./);
    assert.match(html, /Retry/);
  });

  it('disables the Load more button while appending', () => {
    const html = render({ loadingMore: true });
    assert.match(html, /Loading…/);
    assert.match(html, /disabled/);
  });
});
