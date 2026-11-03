// RSS adapter - moved verbatim from `jobSources/index.ts` (Wave 1, T621).
// Includes the XML helpers (`cleanXmlText`, `stripTags`, `xmlTag`,
// `xmlLink`, `parseXmlFeedItems`) with their visibility unchanged.

import { parseQuery, matchesQuery } from '../queryMatch.js';
import { htmlToText } from '../htmlText.js';
import { matchHaystack, type RawJob } from './http.js';
import type { PostedAtSource } from '../../discovery/provenance.js';

// ---- RSS / JSON boards ----
// The default boards point at real XML feeds (WWR .rss, hnrss.org), so this
// fetches text first: JSON bodies parse as before, otherwise the body is
// parsed as RSS/Atom XML. HTTP failures throw so the caller records source
// health; per-source isolation in the routes turns that into [] not a 500.
export async function fetchRss(feedUrl: string, query: string): Promise<RawJob[]> {
  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'ClearanceJobBot/1.0 (+https://clearance.app)' },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${feedUrl}`);
  const text = await res.text();
  const trimmed = text.trim();
  let items: any[];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    items = Array.isArray(data) ? data : data?.items || data?.entries || [];
  } else {
    items = parseXmlFeedItems(trimmed);
  }
  const needle = parseQuery(query);
  return items
    .filter((j) => matchesQuery(matchHaystack({
      title: j.title,
      author: j.author,
      location: j.location,
      description: htmlToText(j.content || j.summary || j.description || ''),
    }), needle))
    .map((j) => {
      // Wave 3 (T662, ADR-028): the XML parser records which tag the date
      // came from (`date_tag`); an `updated`-only item is an update claim ->
      // `source-updated`, everything else posted-like -> `source-posted`.
      // Generic JSON bodies only carry pubDate-ish keys -> `source-posted`.
      const postedRaw = j.date_published ?? j.pubDate;
      const postedSource: PostedAtSource | undefined = postedRaw
        ? (j.date_tag === 'updated' ? 'source-updated' : 'source-posted')
        : undefined;
      return {
        externalId: j.guid || j.id || j.link,
        source: 'rss',
        sourceUrl: j.link || j.url,
        title: j.title,
        company: j.author || j.company || 'RSS',
        location: j.location,
        description: htmlToText(j.content || j.summary || j.description || ''),
        applyUrl: j.link || j.url,
        postedAt: j.date_published ? new Date(j.date_published) : j.pubDate ? new Date(j.pubDate) : undefined,
        postedAtSource: postedSource,
        postedAtRaw: postedRaw ?? undefined,
      };
    });
}

// Unwrap CDATA and trim; titles/locations are tag-stripped by the caller.
function cleanXmlText(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

function xmlTag(block: string, names: string[]): string | undefined {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (m) {
      const text = cleanXmlText(m[1]);
      if (text) return text;
    }
  }
  return undefined;
}

// Wave 3 (T662, ADR-028): same first-match precedence as `xmlTag`, but also
// reports WHICH tag produced the date so `fetchRss` can classify `updated`
// as `source-updated` and everything else as `source-posted`. Additive only:
// `date_published` values are unchanged.
function xmlDateTag(block: string, names: string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (m) {
      const text = cleanXmlText(m[1]);
      if (text) return { name, value: text };
    }
  }
  return undefined;
}

function xmlLink(block: string): string | undefined {
  // Atom: <link href="..."/> ; RSS: <link>...</link>
  const atom = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
  if (atom) return atom[1].trim();
  return xmlTag(block, ['link']);
}

// Minimal RSS (<item>) / Atom (<entry>) / RDF parsing into the shape fetchRss
// maps above. Returns [] for unparseable bodies (no items, no crash).
// We Work Remotely emits <region>/<country>/<state>/<city> and never
// <location>, so those are joined into `location` when no <location> tag
// exists. Exported for unit testing.
export function parseXmlFeedItems(xml: string): any[] {
  const blocks: string[] = [];
  const itemRe = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    blocks.push(m[1]);
  }
  return blocks.map((block) => {
    const link = xmlLink(block);
    const title = xmlTag(block, ['title']);
    const description = xmlTag(block, ['content:encoded', 'content', 'description', 'summary']);
    const dateHit = xmlDateTag(block, ['pubDate', 'published', 'updated', 'date']);
    const pubDate = dateHit?.value;
    const author =
      xmlTag(block, ['author', 'creator', 'dc:creator']) ||
      (() => {
        const inner = block.match(/<author[^>]*>([\s\S]*?)<\/author>/i);
        return inner ? xmlTag(inner[1], ['name']) : undefined;
      })();
    return {
      guid: xmlTag(block, ['guid', 'id']) || link,
      title: title ? stripTags(title) : title,
      link,
      author: author ? stripTags(author) : author,
      company: undefined,
      location: (() => {
        const loc = xmlTag(block, ['location']);
        if (loc) return stripTags(loc);
        // WWR-style: join region/country/state/city when <location> is absent.
        const parts = ['region', 'country', 'state', 'city']
          .map((name) => {
            const v = xmlTag(block, [name]);
            return v ? stripTags(v) : undefined;
          })
          .filter((v): v is string => !!v && v.length > 0);
        return parts.length > 0 ? parts.join(', ') : undefined;
      })(),
      employmentType: (() => {
        const v = xmlTag(block, ['type', 'employmentType']);
        return v ? stripTags(v) : undefined;
      })(),
      content: description,
      date_published: pubDate,
      // Wave 3 (T662, ADR-028): which XML tag the date came from (additive;
      // `date_published` precedence is unchanged).
      date_tag: dateHit?.name,
    };
  });
}
