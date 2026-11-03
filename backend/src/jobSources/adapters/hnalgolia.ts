// HN Algolia adapter - moved verbatim from `jobSources/index.ts` (Wave 1,
// T621). Helper visibility is unchanged: only `mapHNThreadComments` and
// `fetchHNAlgolia` are exported.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { matchHaystack, type RawJob } from './http.js';

// ---- Hacker News "who is hiring" (keyless Algolia API) ----
// HN's monthly "Ask HN: Who is hiring?" thread is a goldmine of startup/US roles.
// Fetched via the public Algolia HN search API (no key, no rate limit).
// Shape: find the newest who-is-hiring story, then fetch its top-level
// comments via /items/{objectID} and map each comment to a RawJob.
const HN_USER_AGENT = 'ClearanceJobBot/1.0 (+https://clearance.app)';

async function fetchHNThread(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': HN_USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res.json();
}

function hnCommentText(child: any): string {
  return htmlToText(String(child?.text || ''));
}

function hnFirstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 140);
  }
  return '';
}

// Pure mapping of an HN thread's top-level comments to RawJob rows, filtered
// by the T301 token-OR query matcher. Exported for unit testing; kept thin
// so fetchHNAlgolia only does fetch + parse + delegate.
export function mapHNThreadComments(
  story: { objectID: string },
  children: any[],
  query: string,
): RawJob[] {
  void story;
  const kids = Array.isArray(children) ? children : [];
  const needle = parseQuery(query);
  return kids
    .filter((child) => child && child.id !== undefined && child.id !== null)
    .map((child) => {
      const text = hnCommentText(child);
      const firstLine = hnFirstLine(text);
      const sourceUrl = `https://news.ycombinator.com/item?id=${child.id}`;
      const title = firstLine || 'HN Job Post';
      const location = extractHNLocation(firstLine)
        || (/\bREMOTE\b/i.test(firstLine) ? 'Remote' : undefined);
      return {
        externalId: String(child.id),
        source: 'hnalgolia',
        sourceUrl,
        title,
        company: extractHNCompany(firstLine) || 'Hacker News',
        location,
        description: text,
        applyUrl: sourceUrl,
        postedAt: child.created_at ? new Date(child.created_at) : undefined,
        // Wave 3 (T662, ADR-028): the Algolia comment `created_at` is the
        // comment's posting time -> `source-posted`.
        postedAtSource: child.created_at ? ('source-posted' as const) : undefined,
        postedAtRaw: child.created_at ?? undefined,
      };
    })
    .filter((job) => matchesQuery(matchHaystack({
      title: job.title,
      company: job.company,
      location: job.location,
      description: job.description,
    }), needle))
    .slice(0, 100);
}

export async function fetchHNAlgolia(query: string): Promise<RawJob[]> {
  const storySearch = `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent('Ask HN Who is hiring')}&hitsPerPage=5`;
  const authorFallback = `https://hn.algolia.com/api/v1/search?tags=story,author_whoishiring&hitsPerPage=5`;
  const hiringRe = /who\s+is\s+hiring/i;

  const pickNewestHiringStory = (hits: any[]): any | undefined => {
    const matching = (Array.isArray(hits) ? hits : []).filter((h) =>
      h && h.objectID && hiringRe.test(String(h.title || '')));
    matching.sort((a, b) => {
      const at = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bt - at;
    });
    return matching[0];
  };

  const first = await fetchHNThread(storySearch);
  let story = pickNewestHiringStory(first?.hits);
  if (!story) {
    const fallback = await fetchHNThread(authorFallback);
    story = pickNewestHiringStory(fallback?.hits);
  }
  if (!story) throw new Error('No current HN "Who is hiring?" story found');

  const thread: any = await fetchHNThread(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
  return mapHNThreadComments({ objectID: String(story.objectID) }, thread?.children, query);
}

function extractHNCompany(text: string): string {
  // "CompanyName (Remote) is hiring ..." or "CompanyName is hiring ..."
  const m = text.match(/^([^(|\n]+?)\s*(?:\([^)]*\))?\s+is hiring/i);
  return m ? m[1].trim() : 'Hacker News';
}

function extractHNLocation(text: string): string | undefined {
  const m = text.match(/\(([^)]*remote[^)]*)\)/i) || text.match(/\(([^)]*)\)/i);
  return m ? m[1].trim() : undefined;
}
