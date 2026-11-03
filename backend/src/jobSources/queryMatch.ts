// Shared token-OR query matching for keyless job fetchers (ADR-012, R1).
// Raw-substring filtering on the full user query empties multi-word searches,
// so each fetcher parses the query into deduped tokens and matches ANY token
// (case-insensitive substring) against title/company/location/description text.
// A query that leaves no token is non-meaningful and matches everything.

export interface QueryNeedle {
  tokens: string[];
  isMeaningful: boolean;
}

const STOPWORDS = new Set([
  'remote',
  'remoteonly',
  'job',
  'jobs',
  'hiring',
  'the',
  'and',
  'or',
  'not',
  'for',
  'with',
  'from',
  'in',
  'at',
  'of',
  'to',
  'a',
  'an',
  'is',
  'are',
  'be',
]);

const MAX_TOKENS = 12;

export function parseQuery(raw: string | undefined): QueryNeedle {
  if (typeof raw !== 'string') return { tokens: [], isMeaningful: false };
  // Lowercase first so site:/boolean handling is case-insensitive.
  let s = raw.toLowerCase();
  // Remove site:<host> operators entirely (host must not contribute tokens).
  s = s.replace(/site:[^\s]*/g, ' ');
  // Strip quote/paren/bracket/comma/semicolon/colon characters.
  s = s.replace(/["'()\[\]{},;:]/g, ' ');
  const parts = s.split(/[^a-z0-9+#.]+/);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of parts) {
    // Trim edge dots from sentence punctuation ("engineer." -> "engineer")
    // while keeping interior dots ("node.js") and +/# ("c++", "c#").
    const token = part.replace(/^\.+|\.+$/g, '');
    if (!token || token.length < 2) continue;
    if (token === 'or' || token === 'and' || token === 'not') continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= MAX_TOKENS) break;
  }
  return { tokens, isMeaningful: tokens.length > 0 };
}

function needleOf(needle: QueryNeedle | undefined | null): QueryNeedle {
  if (needle && Array.isArray(needle.tokens) && typeof needle.isMeaningful === 'boolean') {
    return needle;
  }
  return { tokens: [], isMeaningful: false };
}

function haystackOf(jobText: unknown): string {
  return typeof jobText === 'string' ? jobText.toLowerCase() : '';
}

export function matchesQuery(jobText: string, needle: QueryNeedle): boolean {
  const n = needleOf(needle);
  if (!n.isMeaningful) return true;
  const hay = haystackOf(jobText);
  if (!hay) return false;
  for (const token of n.tokens) {
    if (token && hay.includes(token)) return true;
  }
  return false;
}

export function queryScore(jobText: string, needle: QueryNeedle): number {
  const n = needleOf(needle);
  if (!n.isMeaningful) return 0;
  const hay = haystackOf(jobText);
  if (!hay) return 0;
  let score = 0;
  for (const token of n.tokens) {
    if (token && hay.includes(token)) score += 1;
  }
  return score;
}
