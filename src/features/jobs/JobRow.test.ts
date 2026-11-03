import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SearchDocument } from '@/services/api/jobs';
import { JobRow } from './JobRow';

const NOW = Date.parse('2026-10-30T12:00:00Z');

function document(overrides: Partial<SearchDocument> = {}): SearchDocument {
  return {
    id: 'job-1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Berlin, DE',
    source: 'greenhouse',
    sourceUrl: 'https://example.test/job',
    applyUrl: 'https://example.test/apply',
    postedAt: '2026-10-27T12:00:00Z',
    firstSeenAt: '2026-10-27T12:00:00Z',
    isActive: true,
    workMode: 'remote',
    seniority: 'senior',
    specialization: 'backend-engineer',
    skills: ['TypeScript', 'PostgreSQL', 'AWS', 'Ignored fourth skill'],
    salary: { min: 120000, max: 150000, currency: 'USD' },
    region: 'eu',
    descriptionExcerpt: 'Build things.',
    docVersion: '1',
    ...overrides,
  };
}

function render(job: SearchDocument): string {
  return renderToStaticMarkup(
    createElement(JobRow, { job, onSelect: () => undefined, now: NOW }),
  );
}

describe('JobRow - dense catalogue row', () => {
  it('renders title, company, work mode, seniority and the first three skills', () => {
    const html = render(document());
    assert.match(html, /Senior Backend Engineer/);
    assert.match(html, /Acme/);
    assert.match(html, /Remote/);
    assert.match(html, /Senior/);
    assert.match(html, /TypeScript/);
    assert.match(html, /PostgreSQL/);
    assert.match(html, /AWS/);
    assert.equal(html.includes('Ignored fourth skill'), false);
  });

  it('renders the salary range and freshness when both are present', () => {
    const html = render(document());
    assert.match(html, /\$120k–\$150k/);
    assert.match(html, /3d ago/);
  });

  it('omits the salary element entirely when salary is null', () => {
    const html = render(document({ salary: null }));
    assert.equal(html.includes('$'), false);
    assert.equal(/salary/i.test(html), false);
    // The row still renders its other lines.
    assert.match(html, /Senior Backend Engineer/);
    assert.match(html, /3d ago/);
  });

  it('falls back to firstSeenAt when postedAt is absent', () => {
    const html = render(
      document({ postedAt: null, firstSeenAt: '2026-10-23T12:00:00Z' }),
    );
    assert.match(html, /7d ago/);
  });

  it('omits both salary and freshness when the row carries neither', () => {
    const html = render(
      document({ salary: null, postedAt: null, firstSeenAt: null }),
    );
    assert.equal(/salary/i.test(html), false);
    assert.equal(/ago/.test(html), false);
  });
});
