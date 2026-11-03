import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  matchHaystack,
  fetchGreenhouse,
  fetchAshby,
  fetchLever,
  fetchWorkday,
  fetchRss,
  fetchJsonBoard,
  fetchSmartRecruiters,
  fetchRecruitee,
  fetchPersonio,
  fetchJobicy,
  mapHNThreadComments,
} from './index.js';

// ADR-021 decision 1: every fetcher's matchesQuery input includes the
// description, so a query token that appears ONLY in the JD body keeps the row.
// The token below is meaningful (length >= 2, not a stopword) and appears in
// no title/company/location used here.
const TOKEN_QUERY = 'terraform';

afterEach(() => {
  vi.unstubAllGlobals();
});

const okJson = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

const stubFetchJson = (data: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async () => okJson(data)));
};

describe('matchHaystack helper', () => {
  it('joins parts with single spaces and skips undefined/empty', () => {
    expect(matchHaystack({ title: 'A', location: undefined, description: '' })).toBe('A');
    expect(matchHaystack({ title: 'A', company: 'B', location: 'C', description: 'D' })).toBe('A B C D');
    expect(matchHaystack({})).toBe('');
  });
});

describe('body-only keyword hits are kept (T408)', () => {
  it('greenhouse: token only in j.content', async () => {
    stubFetchJson({
      jobs: [
        {
          id: 1, title: 'Backend Engineer', location: { name: 'Berlin' },
          content: '<p>We need terraform experience.</p>',
          absolute_url: 'https://u/1', updated_at: '2026-09-01T00:00:00.000Z',
        },
        {
          id: 2, title: 'Backend Engineer', location: { name: 'Berlin' },
          content: 'Java role with Spring.',
          absolute_url: 'https://u/2', updated_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
    const rows = await fetchGreenhouse('acme', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('1');
  });

  it('ashby: token only in descriptionPlain', async () => {
    stubFetchJson({
      jobs: [
        {
          id: 'a1', title: 'Backend Engineer', companyName: 'Acme', location: 'Berlin',
          descriptionPlain: 'Must know terraform inside out.',
          jobUrl: 'https://u/a1', isListed: true,
        },
        {
          id: 'a2', title: 'Backend Engineer', companyName: 'Acme', location: 'Berlin',
          descriptionPlain: 'Java role with Spring.',
          jobUrl: 'https://u/a2', isListed: true,
        },
      ],
    });
    const rows = await fetchAshby('acme', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('a1');
  });

  it('lever: token only in descriptionPlain', async () => {
    stubFetchJson([
      {
        id: 'l1', text: 'Backend Engineer', hostedUrl: 'https://u/l1',
        categories: { location: 'Berlin', team: 'Eng' },
        descriptionPlain: 'Deep terraform knowledge required.',
      },
      {
        id: 'l2', text: 'Backend Engineer', hostedUrl: 'https://u/l2',
        categories: { location: 'Berlin', team: 'Eng' },
        descriptionPlain: 'Java role with Spring.',
      },
    ]);
    const rows = await fetchLever('acme', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('l1');
  });

  it('workday: token only in description', async () => {
    stubFetchJson({
      jobs: [
        {
          jobId: 'w1', title: 'Backend Engineer', location: 'Berlin',
          url: 'https://u/w1', description: 'We run everything on terraform.',
        },
        {
          jobId: 'w2', title: 'Backend Engineer', location: 'Berlin',
          url: 'https://u/w2', description: 'Java role with Spring.',
        },
      ],
    });
    const rows = await fetchWorkday('https://example.com/feed', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('w1');
  });

  it('rss: token only in description', async () => {
    stubFetchJson({
      items: [
        {
          title: 'Backend Engineer', author: 'Acme', link: 'https://u/r1',
          description: 'Come do terraform with us.',
        },
        {
          title: 'Backend Engineer', author: 'Acme', link: 'https://u/r2',
          description: 'Java role with Spring.',
        },
      ],
    });
    const rows = await fetchRss('https://example.com/feed', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceUrl).toBe('https://u/r1');
  });

  it('json board: token only in description', async () => {
    stubFetchJson({
      jobs: [
        {
          title: 'Backend Engineer', company: 'Acme', location: 'Berlin',
          url: 'https://u/j1', description: 'terraform modules all day.',
        },
        {
          title: 'Backend Engineer', company: 'Acme', location: 'Berlin',
          url: 'https://u/j2', description: 'Java role with Spring.',
        },
      ],
    });
    const rows = await fetchJsonBoard('https://example.com/api', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceUrl).toBe('https://u/j1');
  });

  it('smartrecruiters: token only in description', async () => {
    stubFetchJson({
      content: [
        {
          id: 's1', name: 'Backend Engineer', company: { name: 'Acme' },
          location: { city: 'Berlin' }, description: 'terraform guru wanted.',
          applyUrl: 'https://u/s1',
        },
        {
          id: 's2', name: 'Backend Engineer', company: { name: 'Acme' },
          location: { city: 'Berlin' }, description: 'Java role with Spring.',
          applyUrl: 'https://u/s2',
        },
      ],
    });
    const rows = await fetchSmartRecruiters('acme', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('s1');
  });

  it('recruitee: token only in description', async () => {
    stubFetchJson({
      offers: [
        {
          id: 11, title: 'Backend Engineer', location: 'Berlin',
          url: 'https://u/c1', description: 'You love terraform.',
        },
        {
          id: 12, title: 'Backend Engineer', location: 'Berlin',
          url: 'https://u/c2', description: 'Java role with Spring.',
        },
      ],
    });
    const rows = await fetchRecruitee('acme', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('11');
  });

  it('personio: token only in jobDescriptions[0].value', async () => {
    stubFetchJson({
      jobPostings: [
        {
          id: 21, name: 'Backend Engineer', officeName: 'Berlin',
          jobDescriptions: [{ value: '<p>terraform experience a must.</p>' }],
          applicationUrl: 'https://u/p1',
        },
        {
          id: 22, name: 'Backend Engineer', officeName: 'Berlin',
          jobDescriptions: [{ value: 'Java role with Spring.' }],
          applicationUrl: 'https://u/p2',
        },
      ],
    });
    const rows = await fetchPersonio('acme', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('21');
  });

  it('jobicy: token only in job_description', async () => {
    stubFetchJson({
      jobs: [
        {
          id: 31, job_title: 'Backend Engineer', employer_name: 'Acme',
          job_location: 'Remote', job_description: 'terraform remote role.',
          job_url: 'https://u/b1',
        },
        {
          id: 32, job_title: 'Backend Engineer', employer_name: 'Acme',
          job_location: 'Remote', job_description: 'Java role with Spring.',
          job_url: 'https://u/b2',
        },
      ],
    });
    const rows = await fetchJobicy(TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('31');
  });

  it('hnalgolia: token only in the comment body (past the first line)', () => {
    const rows = mapHNThreadComments(
      { objectID: '1' },
      [
        { id: 101, text: 'Backend Engineer at Acme (Remote)\nWe need terraform skills.', created_at: '2026-09-01T00:00:00.000Z' },
        { id: 102, text: 'Backend Engineer at Acme (Remote)\nJava role with Spring.', created_at: '2026-09-01T00:00:00.000Z' },
      ],
      TOKEN_QUERY,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe('101');
  });
});

describe('title-only hits still match; no-field rows are dropped (T408)', () => {
  it('lever: token in the title with an empty description still matches', async () => {
    stubFetchJson([
      {
        id: 'l9', text: 'Terraform Engineer', hostedUrl: 'https://u/l9',
        categories: { location: 'Berlin', team: 'Eng' },
        descriptionPlain: '', description: '',
      },
    ]);
    const rows = await fetchLever('acme', TOKEN_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Terraform Engineer');
  });

  it('lever: token in none of the fields drops the row', async () => {
    stubFetchJson([
      {
        id: 'l0', text: 'Backend Engineer', hostedUrl: 'https://u/l0',
        categories: { location: 'Berlin', team: 'Eng' },
        descriptionPlain: 'Java role with Spring.',
      },
    ]);
    const rows = await fetchLever('acme', TOKEN_QUERY);
    expect(rows).toHaveLength(0);
  });
});
