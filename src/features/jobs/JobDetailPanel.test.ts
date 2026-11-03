import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { vi } from 'vitest';

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: null, isLoading: false, isError: false }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => () => undefined,
  Link: (props: any) => props.children,
}));

vi.mock('@/hooks/useResumeApi', () => ({
  useResumes: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/hooks/useJobs', () => ({
  useEvaluateJob: () => ({ mutate: () => undefined, isPending: false }),
  useCreateApplication: () => ({ mutate: () => undefined, isPending: false }),
  useUpdateApplication: () => ({ mutate: () => undefined, isPending: false }),
  useApplications: () => ({ data: [] }),
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: () => undefined }),
}));

import { JobDetailPanel } from './JobDetailPanel';

const job: any = {
  id: 'job-1',
  title: 'Engineer',
  company: 'Acme',
  location: 'Remote',
  source: 'greenhouse',
  sourceUrl: null,
  applyUrl: null,
  postedAt: '2026-10-27T12:00:00Z',
  firstSeenAt: '2026-10-27T12:00:00Z',
  isActive: true,
  workMode: 'remote',
  seniority: 'senior',
  specialization: null,
  skills: [],
  salary: null,
  region: 'us',
  descriptionExcerpt: '',
  docVersion: '1',
};

describe('JobDetailPanel - ghost', () => {
  it('renders Posting health and each evidence line for watch', () => {
    const html = renderToStaticMarkup(
      createElement(JobDetailPanel, {
        job,
        ghost: { level: 'watch', evidence: ['first seen 62 days ago', 'not verified in 21 days'] },
      }),
    );
    assert.match(html, /Posting health/);
    assert.match(html, /first seen 62 days ago/);
    assert.match(html, /not verified in 21 days/);
  });

  it('renders nothing for clear', () => {
    const html = renderToStaticMarkup(
      createElement(JobDetailPanel, {
        job,
        ghost: { level: 'clear', evidence: [] },
      }),
    );
    assert.equal(html.includes('Posting health'), false);
  });
});
