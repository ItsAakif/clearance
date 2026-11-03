// Shared HTML-to-text cleaning for job fetchers (ADR-014).
//
// Descriptions arrive from ATS boards as HTML fragments. The fetchers store
// them into RawJob.description, which is also concatenated into matchesQuery
// inputs and sent to the LLM - so cleaning happens here, once, instead of at
// render time. The renderer stays plain text; no dangerouslySetInnerHTML.
//
// Pure module: no imports, no I/O, never throws.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Decode HTML entities: &amp; &lt; &gt; &quot; &apos; &nbsp; &#39; &#x27;
 * plus the general numeric forms &#NN; (decimal) and &#xHH; (hex).
 * Unknown entities are left literally. Never throws.
 */
export function decodeHtmlEntities(s: string): string {
  try {
    return String(s).replace(
      /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
      (match: string, body: string): string => {
        if (body.charAt(0) === '#') {
          const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
          const digits = isHex ? body.slice(2) : body.slice(1);
          if (!digits) return match;
          const code = parseInt(digits, isHex ? 16 : 10);
          if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        const named = NAMED_ENTITIES[body];
        return named === undefined ? match : named;
      },
    );
  } catch {
    return s;
  }
}

/**
 * Strip markup from a string that already had entities decoded: drop
 * <script>/<style> bodies, turn block/break tags into newlines, then strip
 * whatever tags remain (no attribute parsing - text is all we need).
 */
function stripMarkup(s: string): string {
  // Drop executable/style bodies entirely (case-insensitive, non-greedy).
  let out = s.replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  // Block/break tags become newlines BEFORE remaining tags are stripped.
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  // Strip whatever tags remain (no attribute parsing - text is all we need).
  out = out.replace(/<[^>]*>/g, '');
  return out;
}

/**
 * Convert an HTML fragment to plain text. Total function: coerces
 * null/undefined to '', decodes entities FIRST so entity-encoded markup
 * (e.g. &lt;ul&gt;, a lone &lt;/ul&gt;) becomes real tags before stripping,
 * strips tags, then decodes+strips once more for double-escaped fragments
 * (e.g. &amp;lt;ul&amp;gt;), keeps paragraph/line breaks from <br>/</p>/
 * </div>/</li>/</tr>/</h1..h6>, removes <script>/<style> bodies, and
 * normalises whitespace. Idempotent.
 */
export function htmlToText(input: string | undefined | null): string {
  if (input === undefined || input === null) return '';
  let s = String(input);
  // Fast path: plain text needs no work (also makes the common case cheap).
  if (s.indexOf('<') === -1 && s.indexOf('&') === -1) return s.trim();
  // Decode-then-strip, twice: the first decode reveals entity-encoded tags
  // (including lone closers like &lt;/ul&gt;) to the stripper; the second
  // pass catches double-escaped fragments whose first decode only yields
  // still-encoded markup.
  s = stripMarkup(decodeHtmlEntities(s));
  s = stripMarkup(decodeHtmlEntities(s));
  // Normalise: CRLF -> LF, 3+ newlines -> 2, runs of 3+ spaces -> 1, trim.
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.replace(/ {3,}/g, ' ');
  return s.trim();
}
