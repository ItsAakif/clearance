import { describe, it, expect } from 'vitest';
import { mapHNThreadComments } from './index.js';

const STORY = { objectID: '999' };

const CHILDREN = [
  {
    id: 111,
    created_at: '2026-09-01T10:00:00.000Z',
    text: '<p>Acme Corp (Remote) is hiring Senior React Engineers &amp; more</p><p>Apply at jobs@acme.test</p>',
  },
  {
    id: 222,
    created_at: '2026-09-02T11:00:00.000Z',
    text: '<p>Beta LLC | ONSITE Seattle | Junior Designer</p><p>Great role &lt;apply soon&gt;</p>',
  },
  {
    id: 333,
    created_at: '2026-09-03T12:00:00.000Z',
    text: '<p>   </p><p>Fallback body with no usable first line prefix</p>',
  },
];

describe('mapHNThreadComments', () => {
  it('maps N children to N rows with ids, urls, and postedAt', () => {
    const rows = mapHNThreadComments(STORY, CHILDREN, '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      externalId: '111',
      source: 'hnalgolia',
      sourceUrl: 'https://news.ycombinator.com/item?id=111',
      applyUrl: 'https://news.ycombinator.com/item?id=111',
    });
    expect(rows[0].postedAt).toEqual(new Date('2026-09-01T10:00:00.000Z'));
    expect(rows[2].externalId).toBe('333');
  });

  it('strips HTML tags and decodes entities in title/description', () => {
    const rows = mapHNThreadComments(STORY, CHILDREN, '');
    expect(rows[0].title).not.toContain('<p>');
    expect(rows[0].description).toContain('Engineers & more');
    // Decode-first htmlToText: &lt;apply soon&gt; becomes a real tag and is
    // stripped (same rule that removes surviving &lt;/ul&gt; fragments).
    expect(rows[1].description).toContain('Great role');
    expect(rows[1].description).not.toContain('<apply soon>');
    expect(rows[1].description).not.toContain('&lt;');
    expect(rows[0].title.length).toBeLessThanOrEqual(140);
  });

  it('falls back to HN Job Post when the first line is empty', () => {
    const rows = mapHNThreadComments(STORY, [{ id: 444, created_at: '2026-09-04T00:00:00Z', text: '<p>   </p>' }], '');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('HN Job Post');
    expect(rows[0].company).toBe('Hacker News');
  });

  it('sets location from a REMOTE token', () => {
    const rows = mapHNThreadComments(
      STORY,
      [{ id: 555, created_at: '2026-09-05T00:00:00Z', text: '<p>Globex REMOTE Backend Engineer wanted</p>' }],
      '',
    );
    expect(rows[0].location).toBe('Remote');
  });

  it('filters by query tokens and keeps everything on an empty query', () => {
    const all = mapHNThreadComments(STORY, CHILDREN, '');
    expect(all).toHaveLength(3);
    const react = mapHNThreadComments(STORY, CHILDREN, 'react');
    expect(react.map((r) => r.externalId)).toEqual(['111']);
    const none = mapHNThreadComments(STORY, CHILDREN, 'zzzqqq');
    expect(none).toEqual([]);
  });

  it('returns [] for a story with zero children', () => {
    expect(mapHNThreadComments(STORY, [], '')).toEqual([]);
    expect(mapHNThreadComments(STORY, undefined as any, '')).toEqual([]);
  });
});
