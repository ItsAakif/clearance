// Pure ATS provider + board-token extraction (ADR-026 decision 2).
//
// `extractAts` maps a career-page URL to { provider, boardToken } using ONLY the
// host table from ADR-026 decision 2. Unknown hosts yield { null, null } and the
// caller stores tier 3 (HTTP page). Malformed input never throws - it yields
// nulls. No network, no DNS, no fetch, no Prisma.

export interface AtsIdentity {
  provider: string | null;
  boardToken: string | null;
}

const NULL_IDENTITY: AtsIdentity = { provider: null, boardToken: null };

type TokenStrategy = 'path' | 'subdomain';

interface HostRule {
  provider: string;
  strategy: TokenStrategy;
  /** Exact hostname match (lowercased). */
  exact?: string;
  /**
   * Wildcard suffix match (lowercased, without the "*."): matches the bare
   * base host itself or any subdomain of it.
   */
  suffix?: string;
}

// One row per host-pattern in the ADR-026 decision 2 host table.
// - Exact ATS hosts and path-shaped boards (greenhouse, lever, ashby,
//   workable, smartrecruiters, jobvite) take the token from the first path
//   segment: e.g. jobs.smartrecruiters.com/<Token>/... or
//   boards.greenhouse.io/<token>.
// - Subdomain-shaped boards (recruitee, personio, bamboohr, breezy,
//   teamtailor, pinpointhq, rippling, freshteam) take the token from the
//   subdomain: e.g. <token>.recruitee.com. When the URL sits on the bare
//   base host with no subdomain, these fall back to the first path segment.
const HOST_RULES: readonly HostRule[] = [
  { provider: 'greenhouse', strategy: 'path', exact: 'boards.greenhouse.io' },
  { provider: 'greenhouse', strategy: 'path', exact: 'job-boards.greenhouse.io' },
  { provider: 'lever', strategy: 'path', exact: 'jobs.lever.co' },
  { provider: 'ashby', strategy: 'path', exact: 'jobs.ashbyhq.com' },
  { provider: 'workable', strategy: 'path', exact: 'apply.workable.com' },
  { provider: 'recruitee', strategy: 'subdomain', suffix: 'recruitee.com' },
  { provider: 'personio', strategy: 'subdomain', suffix: 'jobs.personio.de' },
  { provider: 'smartrecruiters', strategy: 'path', suffix: 'smartrecruiters.com' },
  { provider: 'bamboohr', strategy: 'subdomain', suffix: 'bamboohr.com' },
  { provider: 'breezy', strategy: 'subdomain', suffix: 'breezy.hr' },
  { provider: 'jobvite', strategy: 'path', suffix: 'jobvite.com' },
  { provider: 'teamtailor', strategy: 'subdomain', suffix: 'teamtailor.com' },
  { provider: 'pinpointhq', strategy: 'subdomain', suffix: 'pinpointhq.com' },
  // Rippling's public boards live at ats.rippling.com/{slug}/jobs, so the
  // token is the FIRST PATH SEGMENT. The generic subdomain rule below would
  // store the host label "ats" for every row (the live registry bug).
  { provider: 'rippling', strategy: 'path', exact: 'ats.rippling.com' },
  { provider: 'rippling', strategy: 'subdomain', suffix: 'rippling.com' },
  { provider: 'freshteam', strategy: 'subdomain', suffix: 'freshteam.com' },
];

function findRule(host: string): HostRule | undefined {
  for (const rule of HOST_RULES) {
    if (rule.exact !== undefined && host === rule.exact) return rule;
    if (
      rule.suffix !== undefined &&
      (host === rule.suffix || host.endsWith(`.${rule.suffix}`))
    ) {
      return rule;
    }
  }
  return undefined;
}

/** First non-empty path segment, percent-decoded; null when there is none. */
function firstPathSegment(pathname: string): string | null {
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** Portion of `host` before `.${suffix}`; null when host is the bare base. */
function subdomainPrefix(host: string, suffix: string): string | null {
  if (host === suffix) return null;
  const prefix = host.slice(0, -(suffix.length + 1));
  return prefix === '' ? null : prefix;
}

/**
 * Extract { provider, boardToken } from a career-page URL.
 *
 * - Unknown host -> { provider: null, boardToken: null } (caller stores tier 3).
 * - Known host with no derivable token -> { provider, boardToken: null }.
 * - Never throws: non-URL strings, empty strings and non-strings yield nulls.
 * - Host matching is case-insensitive; board tokens preserve their case.
 * - Query strings and fragments are ignored (token comes from host/path only).
 */
export function extractAts(url: string): AtsIdentity {
  if (typeof url !== 'string') return { ...NULL_IDENTITY };
  const text = url.trim();
  if (text === '') return { ...NULL_IDENTITY };

  let parsed: URL;
  try {
    // Tolerate scheme-less career-page values ("boards.greenhouse.io/acme").
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)
      ? text
      : `https://${text}`;
    parsed = new URL(withScheme);
  } catch {
    return { ...NULL_IDENTITY };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === '') return { ...NULL_IDENTITY };
  const rule = findRule(host);
  if (rule === undefined) return { ...NULL_IDENTITY };

  if (rule.strategy === 'subdomain' && rule.suffix !== undefined) {
    const prefix = subdomainPrefix(host, rule.suffix);
    if (prefix !== null) return { provider: rule.provider, boardToken: prefix };
  }
  return { provider: rule.provider, boardToken: firstPathSegment(parsed.pathname) };
}
