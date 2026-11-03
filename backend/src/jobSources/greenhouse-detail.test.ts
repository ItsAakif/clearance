import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGreenhouse, fetchGreenhouseDetail } from './index.js';

function stubFetch(handler: (url: string) => { ok: boolean; status: number; body: unknown }) {
  return vi.fn(async (url: string) => {
    const r = handler(String(url));
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return {
      ok: r.ok,
      status: r.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
}

const LIST_WITH_EMPTY = {
  jobs: [
    {
      id: 111,
      title: 'Backend Engineer',
      absolute_url: 'https://boards.greenhouse.io/testco/jobs/111',
      location: { name: 'Remote' },
      content: '',
      updated_at: '2026-09-01T10:00:00Z',
    },
    {
      id: 222,
      title: 'Backend Engineer II',
      absolute_url: 'https://boards.greenhouse.io/testco/jobs/222',
      location: { name: 'Remote' },
      content: '<p>Build APIs.</p>',
      updated_at: '2026-09-02T10:00:00Z',
    },
  ],
};

const DETAIL_111 = { id: 111, title: 'Backend Engineer', content: '<p>Build &amp; ship <b>APIs</b>.</p>' };

describe('greenhouse per-job detail fallback', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fills an empty list-row description from the per-job detail endpoint', async () => {
    const spy = stubFetch((url) =>
      url.includes('/jobs/111') && !url.includes('content=true')
        ? { ok: true, status: 200, body: DETAIL_111 }
        : { ok: true, status: 200, body: LIST_WITH_EMPTY },
    );
    vi.stubGlobal('fetch', spy);
    const jobs = await fetchGreenhouse('testco', 'engineer');
    expect(jobs).toHaveLength(2);
    const backfilled = jobs.find((j) => j.externalId === '111');
    expect(backfilled?.description).toBe('Build & ship APIs.');
    // Row that already had content is untouched.
    expect(jobs.find((j) => j.externalId === '222')?.description).toBe('Build APIs.');
  });

  it('skips the detail fetch when the list row already has a description', async () => {
    const spy = stubFetch(() => ({ ok: true, status: 200, body: { jobs: [LIST_WITH_EMPTY.jobs[1]] } }));
    vi.stubGlobal('fetch', spy);
    const jobs = await fetchGreenhouse('testco', 'engineer');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe('Build APIs.');
    // Only the list call happened - no per-job detail request.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps an empty description without throwing when the detail is also empty', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) =>
        url.includes('content=true')
          ? { ok: true, status: 200, body: { jobs: [LIST_WITH_EMPTY.jobs[0]] } }
          : { ok: true, status: 200, body: { id: 111, content: '' } },
      ),
    );
    const jobs = await fetchGreenhouse('testco', 'engineer');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe('');
  });

  it('keeps an empty description without throwing when the detail fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) =>
        url.includes('content=true')
          ? { ok: true, status: 200, body: LIST_WITH_EMPTY }
          : { ok: false, status: 404, body: 'not found' },
      ),
    );
    const jobs = await fetchGreenhouse('testco', 'engineer');
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.externalId === '111')?.description).toBe('');
    expect(jobs.find((j) => j.externalId === '222')?.description).toBe('Build APIs.');
  });

  it('fetchGreenhouseDetail returns cleaned text and swallows failures', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: true, status: 200, body: DETAIL_111 })));
    await expect(fetchGreenhouseDetail('testco', 111)).resolves.toBe('Build & ship APIs.');
    vi.stubGlobal('fetch', stubFetch(() => ({ ok: false, status: 500, body: 'boom' })));
    await expect(fetchGreenhouseDetail('testco', 111)).resolves.toBe('');
  });
});
