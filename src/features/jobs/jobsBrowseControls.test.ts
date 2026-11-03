import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CatalogueFiltersSheet } from './CatalogueFiltersSheet';
import { createEmptyCatalogueFilters } from './catalogueParams';

const noop = () => undefined;

describe('CatalogueFiltersSheet - mobile trigger', () => {
  it('renders the Filters trigger that opens the facet sheet', () => {
    const html = renderToStaticMarkup(
      createElement(CatalogueFiltersSheet, {
        open: false,
        onOpenChange: noop,
        activeCount: 2,
        facets: undefined,
        filters: createEmptyCatalogueFilters(),
        onChange: noop,
        onClearAll: noop,
      }),
    );
    assert.match(html, /aria-label="Open filters"/);
    assert.match(html, /Filters/);
  });
});
