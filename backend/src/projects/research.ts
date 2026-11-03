// =====================================================================================
// projects/research.ts - OPTIONAL PUBLIC RESEARCH FOR PROJECT CANDIDATES (T1100; 06-design
// sec. E.5, "public research", and sec. E.9's data-minimisation posture).
//
// WHAT THIS MODULE IS, AND WHAT IT IS NOT. It is the ONLY network call the project engine
// makes, it is OPTIONAL, and it is the last thing in the flow rather than the first: the
// deterministic core (gap selection, candidate generation, the feasibility screen, the
// anti-copy guard, and the whole accept -> complete -> confirm lifecycle) runs with no network
// and no provider at all, and this module only ever ADDS references to a candidate that has
// already passed every deterministic check. If it never runs, the feature is smaller and not
// broken - which is the design the orchestrator ruling names and the reason the flow is written
// in this order.
//
// WHY IT IS OPTIONAL IN BOTH DIRECTIONS. There are exactly two ways it cannot run and both
// are reported rather than swallowed:
//   - NO NETWORK / the provider is unreachable -> `research_unavailable`.
//   - THE CALLER DECLINED (`enabled: false`, or no search terms were derived) -> `not_requested`.
// In both cases the candidate that would have carried the reference is still produced, with
// `references: []` and the reason stated, so "no references" is never read as "we checked and
// there were none". A reference is never INVENTED to fill the shape: `ResearchOutcome`
// carries either acceptances or rejections, and an empty acceptance list is a real answer.
//
// THE ONLY ENDPOINT IS THE PUBLIC GITHUB SEARCH, and it is keyless by default.
// `api.github.com/search/repositories` needs no credential, so the stage runs on a fresh
// install with nothing configured - which is the whole point of it being enrichment. When an
// operator HAS put a token in `GITHUB_TOKEN` it is sent, because the unauthenticated rate
// limit is small and the screen is the honest thing to do with a 403 rather than the reason to
// fail. The token is read from the environment and never logged, never stored, and never part
// of a `ProjectReference`.
//
// WHY THE FETCH IS INJECTED. `searchRepositories` takes the fetch implementation as a
// parameter. That is what lets the criteria be tested against real GitHub JSON with no network
// in the test run, and it is also the honest shape: the module has no ambient capability, so a
// caller that does not pass a fetch cannot make one happen by accident.
//
// WHAT THE PROVIDER RESPONSE IS TRUSTED FOR, and what it is not. It is trusted for the fields
// the criteria need - name, url, licence, `pushed_at`, stars, forks, size, README text - and
// for NOTHING else. The README is the only text read, it is capped, and every value that
// reaches a decision goes through `screenReference`, which is where the licences, the 18-month
// window, the documentation floor, the two-day budget and the paid-service check live. There
// is no second path from a provider response to a stored reference.
//
// SSRF POSTURE. The endpoint is a CONSTANT (`GITHUB_SEARCH_ENDPOINT`), never caller-derived,
// and the terms are percent-encoded into the query string. Nothing in this module can be
// pointed at an internal address, which is the difference between this and the JD URL fetch in
// `jobs/analyze.ts` (E.1), where the URL is genuinely user-supplied and therefore needs the
// full guard.
// =====================================================================================

import {
  activityCutoff,
  ALLOWED_LICENCES,
  hasDocumentedUsage,
  screenReference,
  type ReferenceAcceptance,
  type ReferenceRejection,
  type RepositoryFacts,
} from './references.js';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** The only endpoint this module ever calls for a SEARCH. Constant, never caller-derived. */
export const GITHUB_SEARCH_ENDPOINT = 'https://api.github.com/search/repositories';

/**
 * The only endpoint this module ever calls for a README. Constant prefix + a repository's OWN
 * `owner/name`, which comes from the provider and is percent-encoded - so it cannot be pointed
 * at an internal address either.
 */
export const GITHUB_README_ENDPOINT = 'https://api.github.com/repos';

/** How long a single research call waits. A stage that hangs is worse than one that skips. */
export const RESEARCH_TIMEOUT_MS = 5_000;

/** How many repositories one search may consider. Bounded, because every one is screened. */
export const MAX_RESULTS_PER_SEARCH = 8;

/**
 * A STAR FLOOR for the query, in the QUERY and not in the screen.
 *
 * It is a filter, never a decision: `screenReference` still applies all six criteria to whatever
 * comes back, and a repository this floor hides is one the licence, activity, documentation and
 * two-day checks were unlikely to pass anyway. What it does buy is a LIST OF PROJECTS instead of
 * a list of curated lists - `terraform in:name,description,readme` returns awesome-lists, which
 * are unlicensed, unversioned and enormous, and every one of them is refused for a reason a user
 * would have to read to understand.
 */
export const MIN_REFERENCE_STARS = 50;

/** How many searches one run may make. Two terms per gap is plenty for a weekend project. */
export const MAX_SEARCHES_PER_RUN = 3;

/** How much README text is read for one repository. Read, screened, then capped again. */
export const MAX_README_FETCH_CHARS = 4_000;

/**
 * Why research did or did not happen. A CLOSED set, because the client renders a different
 * sentence per member and an unknown value would render nothing.
 */
export const RESEARCH_REASONS = Object.freeze([
  /** At least one reference was accepted and recorded. */
  'ok',
  /** The caller did not ask for research. Nothing was fetched. */
  'not_requested',
  /** The run produced no search terms, so there was nothing to look for. */
  'no_search_terms',
  /** No network, the provider refused, or the response was not the JSON we expect. */
  'research_unavailable',
  /** The provider answered and every repository it named failed the criteria. */
  'no_references_passed',
] as const);

export type ResearchReason = (typeof RESEARCH_REASONS)[number];

/** What the optional stage did. Reported either way, exactly as `proposalStage` is. */
export interface ResearchReport {
  readonly status: 'applied' | 'skipped';
  readonly reason: ResearchReason;
  /** How many searches were actually issued. `0` on every skipped path. */
  readonly searchCount: number;
  /** How many repositories the provider named, before any screening. */
  readonly consideredCount: number;
  /** How many passed every criterion. */
  readonly acceptedCount: number;
  /** Every refusal, with the criterion that fired. Never silently discarded. */
  readonly rejected: readonly ReferenceRejection[];
  /** The terms the search actually used. `[]` when nothing was searched for. */
  readonly terms: readonly string[];
}

// ---------------------------------------------------------------------------
// The search terms, derived from the gaps
// ---------------------------------------------------------------------------

/**
 * The search terms for a set of gaps, derived from their SKILL TARGETS.
 *
 * A gap's targets are already the canonical technology names the matcher derived
 * (`projects/gaps.ts` reads them with `tailor/factDelta.ts`), so the term is the vocabulary the
 * rest of the system already agrees on rather than a phrase invented here. One term per gap's
 * first target, de-duplicated case-insensitively and capped.
 */
export function searchTermsForGaps(gaps: readonly { readonly skillTargets: readonly string[] }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const gap of gaps) {
    for (const target of gap.skillTargets ?? []) {
      const term = target.replace(/\s+/g, ' ').trim();
      const key = term.toLowerCase();
      if (term.length < 2 || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length >= MAX_SEARCHES_PER_RUN) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The fetch seam
// ---------------------------------------------------------------------------

/** The slice of `fetch` this module uses. Narrower than the global, so a fake is three lines. */
export type ResearchFetch = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal?: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}>;

/**
 * The GLOBAL `fetch`, behind the narrow seam above.
 *
 * This is the one place in the project engine that reaches for a network capability, and it is
 * exported rather than reached for inside this module so that the capability is visible at the
 * call site: `routes/matches.ts` passes `globalResearchFetch` to `discoverProjects`, and a test
 * passes three lines instead. With no fetch passed, the stage reports `research_unavailable` -
 * it never dials out on its own.
 */
export const globalResearchFetch: ResearchFetch = async (url, init) => {
  const response = await fetch(url, { method: 'GET', headers: init.headers, signal: init.signal });
  return { ok: response.ok, status: response.status, json: () => response.json() };
};

/** How a research call is configured. Every field is optional because every field can be absent. */
export interface ResearchOptions {
  /** `false` skips the stage entirely and reports `not_requested`. Default `true`. */
  readonly enabled?: boolean;
  /** The fetch implementation. Required to actually search: no ambient network. */
  readonly fetchImpl?: ResearchFetch;
  /** An optional GitHub token, from the environment. Sent when present; never stored. */
  readonly token?: string | undefined;
  /** Injected clock, so the 18-month window is testable with a literal. */
  readonly now: Date;
}

// ---------------------------------------------------------------------------
// The provider response
// ---------------------------------------------------------------------------

/** The GitHub search response, as far as this module reads it. */
interface GitHubSearchResponse {
  readonly items?: ReadonlyArray<Record<string, unknown>>;
}

/** The README endpoint's response, when the provider ignored the raw media type. */
interface GitHubReadmeResponse {
  readonly content?: unknown;
  readonly encoding?: unknown;
}

/**
 * One search hit -> `RepositoryFacts`.
 *
 * DEFENSIVE ON EVERY FIELD because this is the only place untyped external JSON enters the
 * project engine. `license` is `null` or `{spdx_id}` upstream and both reach the screen as
 * "no licence", which is the refusal we want; a malformed value is not allowed to become a
 * licence.
 */
export function factsFromSearchItem(item: Record<string, unknown>): RepositoryFacts {
  const license =
    item.license !== null && typeof item.license === 'object'
      ? { spdxId: (item.license as Record<string, unknown>).spdx_id as string | null }
      : null;
  return {
    fullName: typeof item.full_name === 'string' ? item.full_name : null,
    htmlUrl: typeof item.html_url === 'string' ? item.html_url : null,
    description: typeof item.description === 'string' ? item.description : null,
    stargazersCount: typeof item.stargazers_count === 'number' ? item.stargazers_count : null,
    forksCount: typeof item.forks_count === 'number' ? item.forks_count : null,
    openIssuesCount: typeof item.open_issues_count === 'number' ? item.open_issues_count : null,
    pushedAt: typeof item.pushed_at === 'string' ? item.pushed_at : null,
    archived: typeof item.archived === 'boolean' ? item.archived : null,
    size: typeof item.size === 'number' ? item.size : null,
    language: typeof item.language === 'string' ? item.language : null,
    topics: Array.isArray(item.topics) ? (item.topics.filter((t) => typeof t === 'string') as string[]) : null,
    // THE LICENCE. Carried through because the licence criterion cannot be evaluated without
    // it, and because a reference is never recorded without one: `no_licence` is the refusal,
    // and it is only reachable because an absent or malformed value lands here as `null`.
    license,
    // The search endpoint does not return a README body. It is therefore ABSENT here, and the
    // stage fetches one per hit that is worth a request (`worthFetchingReadme`), because
    // screening first would refuse every repository for "no README" when the answer is "we have
    // not looked yet".
    readme: null,
    // GitHub's search response does not carry a release count either. A caller that has one
    // (a repository lookup, a test fixture) can supply it and the usage criterion will read it;
    // `null` here simply means "unknown", which the usage-section criterion then decides.
    releasesCount: typeof item.releases_count === 'number' ? item.releases_count : null,
  };
}

/**
 * Attach a README to a hit, so the documentation and usage criteria can be checked.
 *
 * CAPPED at `MAX_README_FETCH_CHARS` on the way IN, and again at
 * `MAX_README_EXCERPT_CHARS` on the way out (in `references.ts`). The first cap bounds what
 * leaves the network; the second bounds what is stored. Two caps because they protect two
 * different things: a public README is unbounded, and a stored reference should be an excerpt
 * nobody can copy a project out of.
 */
export function withReadme(facts: RepositoryFacts, readme: string): RepositoryFacts {
  return { ...facts, readme: readme.slice(0, MAX_README_FETCH_CHARS) };
}

/**
 * Is this hit's README worth ONE more request?
 *
 * A PRE-GATE, and its power is deliberately negative: it can only decide NOT to fetch, never to
 * accept. `screenReference` remains the single authority on every criterion - a repository this
 * pre-gate lets through and the screen then refuses costs one wasted request, which is the cheap
 * direction to be wrong in. It exists because the unauthenticated GitHub rate limit is small and
 * eight README fetches per search for repositories that are unlicensed or abandoned is a way to
 * get the whole stage refused with a 403.
 *
 * The two checks it repeats are the two that do not need the README at all: the licence
 * allowlist and the 18-month activity window.
 */
export function worthFetchingReadme(facts: RepositoryFacts, now: Date): boolean {
  const licence =
    typeof facts.license?.spdxId === 'string'
      ? facts.license.spdxId.replace(/\s+/g, ' ').trim().toUpperCase()
      : '';
  if (!ALLOWED_LICENCES.includes(licence)) return false;
  const pushedAt = typeof facts.pushedAt === 'string' ? facts.pushedAt : null;
  if (pushedAt === null || Number.isNaN(new Date(pushedAt).getTime())) return false;
  return new Date(pushedAt).getTime() >= activityCutoff(now).getTime();
}

/**
 * The README URL for one search hit, or `null` when the hit names no repository.
 *
 * Built from the provider's OWN `full_name`, percent-encoded per segment: `a/b` becomes
 * `a%2Fb`, and a `full_name` that is not two path segments yields `null` rather than a URL that
 * points somewhere else.
 */
export function readmeUrlFor(facts: RepositoryFacts): string | null {
  const ownerRepo = ownerRepoOf(facts);
  return ownerRepo === null ? null : `${GITHUB_README_ENDPOINT}/${ownerRepo}/readme`;
}

/**
 * The tag listing for one search hit, or `null`.
 *
 * E.5's releases criterion is "a tag count > 0 OR documented usage", and neither half is in the
 * search response. `per_page=1` is enough: the criterion asks whether there is AT LEAST ONE tag,
 * so an empty array is the answer and the length never has to be right.
 */
export function tagsUrlFor(facts: RepositoryFacts): string | null {
  const ownerRepo = ownerRepoOf(facts);
  return ownerRepo === null ? null : `${GITHUB_README_ENDPOINT}/${ownerRepo}/tags?per_page=1`;
}

/** `owner/name`, or `null` when the hit does not name exactly two path segments. */
function ownerRepoOf(facts: RepositoryFacts): string | null {
  const fullName = typeof facts.fullName === 'string' ? facts.fullName.trim() : '';
  const segments = fullName.split('/');
  if (segments.length !== 2) return null;
  const [owner, name] = segments.map((part) => encodeURIComponent(part));
  if (owner.length === 0 || name.length === 0) return null;
  return `${owner}/${name}`;
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

function skipped(reason: ResearchReason, terms: readonly string[] = []): ResearchReport {
  return {
    status: 'skipped',
    reason,
    searchCount: 0,
    consideredCount: 0,
    acceptedCount: 0,
    rejected: [],
    terms,
  };
}

/** One repository the provider named, with its README when one was fetched. */
export interface ResearchCandidate {
  readonly facts: RepositoryFacts;
  /** `null` when no README was fetched for this repository. */
  readonly readme: string | null;
}

/**
 * One README, or `null`.
 *
 * The JSON media type is requested DELIBERATELY rather than `application/vnd.github.raw`: the
 * fetch seam this stage is given exposes `json()` and nothing else, so asking for markdown would
 * hand the seam a body it cannot read and every repository would be refused for "no README".
 * The JSON shape is `{ content: <base64>, encoding: "base64" }`, which is decoded once and capped
 * by `withReadme` before any criterion sees it.
 *
 * EVERY FAILURE IS `null`, NOT A THROWN ERROR: a repository whose README cannot be read is
 * screened without one and refused on the documentation criterion, which is the honest outcome
 * for a stage that could not look.
 */
async function fetchReadme(
  url: string,
  options: ResearchOptions,
  headers: Record<string, string>,
): Promise<string | null> {
  if (typeof options.fetchImpl !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS);
  try {
    const response = await options.fetchImpl(url, {
      headers: { ...headers, Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as GitHubReadmeResponse;
    if (typeof payload?.content !== 'string') return null;
    if (payload.encoding === 'base64') return Buffer.from(payload.content, 'base64').toString('utf8');
    return payload.content;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many tags a repository has, capped at two - which is all the criterion needs.
 *
 * `-1` is the "the listing could not be read" answer, and it is deliberately NOT zero: `0` would
 * mean "this project has never been released", which is a claim about the project, while `-1`
 * means "we could not find out", which is a claim about the request. The screen then treats both
 * as "no releases known", so the refusal reason stays the same either way.
 */
async function fetchTags(
  url: string,
  options: ResearchOptions,
  headers: Record<string, string>,
): Promise<number> {
  if (typeof options.fetchImpl !== 'function') return -1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS);
  try {
    const response = await options.fetchImpl(url, {
      headers: { ...headers, Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) return -1;
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) return -1;
    return Math.min(payload.length, 2);
  } catch {
    return -1;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where research's ACCEPTED references go.
 *
 * A function rather than a shared list because the candidates are generated per gap, so a
 * reference found for gap 1 belongs on gap 1's candidate and not on every candidate. The
 * caller decides the association; this module only decides what is admissible.
 */
export type ReferenceSink = (
  acceptance: ReferenceAcceptance,
  screen: { readonly url: string; readonly terms: readonly string[] },
) => void;

/**
 * Run the optional public research.
 *
 * ORDER MATTERS AND IS THE REASONING: derive the terms, refuse to search with no terms, refuse
 * to search when the caller declined, then search, then SCREEN every hit through the one
 * criteria function. Nothing bypasses the screen, and nothing is fetched when the run would not
 * use the answer.
 *
 * EVERY FAILURE PATH IS A `skipped` REPORT WITH A REASON. A thrown error here would take the
 * whole feature down for an optional stage, which is the wrong trade: the candidate is already
 * built and screened by the time this runs.
 */
export async function researchReferences(
  gaps: readonly { readonly skillTargets: readonly string[] }[],
  options: ResearchOptions,
  sink: ReferenceSink,
): Promise<ResearchReport> {
  const terms = searchTermsForGaps(gaps);
  if (options.enabled === false) return skipped('not_requested', terms);
  if (terms.length === 0) return skipped('no_search_terms', terms);
  if (typeof options.fetchImpl !== 'function') return skipped('research_unavailable', terms);

  const accepted: ReferenceAcceptance[] = [];
  const rejected: ReferenceRejection[] = [];
  const seenUrls = new Set<string>();
  let considered = 0;
  let searchCount = 0;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'clearance-project-engine',
  };
  // The token is sent and then forgotten: it is never stored, never logged, and never
  // reaches a `ProjectReference`.
  if (typeof options.token === 'string' && options.token.length > 0) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  for (const term of terms.slice(0, MAX_SEARCHES_PER_RUN)) {
    // `in:name,description` and a star floor, for the reason on `MIN_REFERENCE_STARS`. The term
    // itself is percent-encoded, so a technology name can never inject a qualifier.
    const query = `${term} in:name,description stars:>${MIN_REFERENCE_STARS}`;
    const url =
      `${GITHUB_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}` +
      `&sort=stars&order=desc&per_page=${MAX_RESULTS_PER_SEARCH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS);
    let items: ReadonlyArray<Record<string, unknown>> = [];
    try {
      const response = await options.fetchImpl(url, { headers, signal: controller.signal });
      if (!response.ok) {
        // A provider that refuses is `research_unavailable`, not a candidate failure: nothing
        // was learned about any repository, so the whole stage reports as unavailable rather
        // than as "everything was rejected".
        return skipped('research_unavailable', terms);
      }
      const payload = (await response.json()) as GitHubSearchResponse;
      items = Array.isArray(payload?.items) ? payload.items : [];
      searchCount += 1;
    } catch {
      return skipped('research_unavailable', terms);
    } finally {
      clearTimeout(timer);
    }

    for (const item of items.slice(0, MAX_RESULTS_PER_SEARCH)) {
      const bare = factsFromSearchItem(item);
      const key = typeof bare.htmlUrl === 'string' ? bare.htmlUrl : '';
      if (key.length === 0 || seenUrls.has(key)) continue;
      seenUrls.add(key);
      considered += 1;

      // THE README IS A SECOND REQUEST, and the search response does not carry one. It has to be
      // fetched before the screen, because the documentation and usage criteria are about the
      // README - screening first would refuse every repository for "no README" when the answer
      // is "we have not looked yet". The pre-gate decides only whether the fetch is worth it.
      let facts = bare;
      if (worthFetchingReadme(bare, options.now)) {
        const url = readmeUrlFor(bare);
        if (url !== null) {
          const readme = await fetchReadme(url, options, headers);
          if (readme !== null) {
            facts = withReadme(bare, readme);
            // THE THIRD REQUEST, and it is CONDITIONAL. E.5 accepts "a tag count > 0 OR
            // documented usage"; if the README already documents usage there is nothing to learn
            // and the request is not spent. When the README does not, the tag listing is fetched,
            // because without it a genuinely released, actively maintained project is refused for
            // a reason the stage could have gone and checked.
            if (!hasDocumentedUsage(readme)) {
              const tagsUrl = tagsUrlFor(bare);
              if (tagsUrl !== null) {
                const tags = await fetchTags(tagsUrl, options, headers);
                facts = { ...facts, releasesCount: tags };
              }
            }
          }
        }
      }

      const screen = screenReference(facts, options.now);
      if ('accepted' in screen) {
        accepted.push(screen);
        sink(screen, { url: key, terms: [term] });
      } else {
        rejected.push(screen);
      }
    }
  }

  if (searchCount === 0) return skipped('research_unavailable', terms);
  if (accepted.length === 0) {
    return {
      status: 'skipped',
      reason: 'no_references_passed',
      searchCount,
      consideredCount: considered,
      acceptedCount: 0,
      rejected,
      terms,
    };
  }
  return {
    status: 'applied',
    reason: 'ok',
    searchCount,
    consideredCount: considered,
    acceptedCount: accepted.length,
    rejected,
    terms,
  };
}