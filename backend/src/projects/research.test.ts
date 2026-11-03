// =====================================================================================
// projects/research.test.ts - the OPTIONAL public-research stage (T1100; 06 sec. E.5,
// "public research", and its GitHub criteria).
//
// THE RULING THIS FILE ENCODES. The project engine's deterministic core runs with no network
// at all, and the research stage is ENRICHMENT: when it cannot run it says so, with a
// machine-readable reason, and the candidates are produced anyway. These are the two directions
// that has to hold:
//
//   - DECLINED (`enabled: false`)          -> `not_requested`
//   - NOTHING TO SEARCH FOR (no terms)    -> `no_search_terms`
//   - NO FETCH, OR THE PROVIDER REFUSES   -> `research_unavailable`
//   - THE PROVIDER ANSWERED, NOTHING PASSED -> `no_references_passed`, WITH the refusals
//
// THE THREE THINGS THAT MUST NEVER HAPPEN, each with a test:
//   - a reference is INVENTED to fill the shape (every accepted reference came from a provider
//     response, and the test counts them against the fake's own hits);
//   - a reference is RECORDED without its licence and activity snapshot (the screen's job, and
//     `references.test.ts`'s);
//   - the module reaches the network on its own (the fetch is INJECTED; with none, the stage
//     reports unavailable rather than dialling out).
// =====================================================================================

import { describe, it, expect } from 'vitest';

import {
  GITHUB_SEARCH_ENDPOINT,
  MAX_README_FETCH_CHARS,
  MAX_RESULTS_PER_SEARCH,
  MAX_SEARCHES_PER_RUN,
  MIN_REFERENCE_STARS,
  RESEARCH_REASONS,
  factsFromSearchItem,
  readmeUrlFor,
  researchReferences,
  searchTermsForGaps,
  tagsUrlFor,
  worthFetchingReadme,
  withReadme,
  type ResearchFetch,
  type ResearchReport,
} from './research.js';
import { screenReference, type ReferenceAcceptance } from './references.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');

const README = [
  '# Queuewright',
  '',
  'A small at-least-once job queue for Node services, with idempotent workers and exponential',
  'backoff on failure. It is deliberately tiny: one queue, one worker, one acknowledgement',
  'protocol, and nothing else.',
  '',
  '## Usage',
  '',
  'const q = new Queuewright("mailer");',
  'await q.push({ to: "a@example.com" });',
].join('\n');

/** One provider hit, in the shape GitHub's search endpoint actually returns. */
function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: 'queuewright/queuewright',
    html_url: 'https://github.com/queuewright/queuewright',
    stargazers_count: 120,
    forks_count: 9,
    open_issues_count: 3,
    pushed_at: '2026-06-01T00:00:00.000Z',
    archived: false,
    size: 180,
    topics: ['queue'],
    license: { spdx_id: 'mit' },
    releases_count: 3,
    ...overrides,
  };
}

interface FakeOptions {
  readonly items?: ReadonlyArray<Record<string, unknown>>;
  readonly readme?: string | null;
  readonly tags?: unknown;
  readonly ok?: boolean;
  readonly throwOn?: 'search' | 'readme' | 'tags';
}

/** A fake provider answering every endpoint the stage uses, recording the URLs it was asked for. */
function fakeFetch(options: FakeOptions = {}) {
  const items = options.items ?? [item()];
  const readme = options.readme === undefined ? README : options.readme;
  const tags = options.tags === undefined ? [{ name: 'v1.0.0' }] : options.tags;
  const ok = options.ok ?? true;
  const calls: string[] = [];
  const fetchImpl: ResearchFetch = async (url) => {
    calls.push(url);
    if (url.includes('/tags')) {
      if (options.throwOn === 'tags') throw new Error('network down');
      return { ok: true, status: 200, json: async () => tags };
    }
    const isReadme = url.endsWith('/readme');
    if (options.throwOn === (isReadme ? 'readme' : 'search')) throw new Error('network down');
    if (!ok) return { ok: false, status: 503, json: async () => ({}) };
    if (isReadme) {
      if (readme === null) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: Buffer.from(readme, 'utf8').toString('base64'),
          encoding: 'base64',
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ total_count: items.length, items }) };
  };
  return Object.assign(fetchImpl, { calls });
}

/** Run the stage and collect what it accepted, which is what the sink would have persisted. */
async function run(
  gaps: ReadonlyArray<{ readonly skillTargets: readonly string[] }>,
  options: Parameters<typeof researchReferences>[1],
): Promise<{ report: ResearchReport; accepted: ReferenceAcceptance[] }> {
  const accepted: ReferenceAcceptance[] = [];
  const report = await researchReferences(
    gaps,
    options,
    (acceptance) => {
      accepted.push(acceptance);
    },
  );
  return { report, accepted };
}

const ONE_GAP = [{ skillTargets: ['kubernetes'] }];

// ---------------------------------------------------------------------------
// The terms
// ---------------------------------------------------------------------------

describe('the search terms come from the gaps\' OWN vocabulary', () => {
  it('one term per skill target, de-duplicated case-insensitively and bounded', () => {
    expect(searchTermsForGaps(ONE_GAP)).toEqual(['kubernetes']);
    expect(searchTermsForGaps([{ skillTargets: ['Kubernetes', 'KUBERNETES'] }])).toEqual(['Kubernetes']);
    expect(searchTermsForGaps([])).toEqual([]);
    expect(searchTermsForGaps([{ skillTargets: [] }])).toEqual([]);
    // Bounded: one run makes at most `MAX_SEARCHES_PER_RUN` searches, which is also the point
    // at which this returns.
    const many = [{ skillTargets: Array.from({ length: 20 }, (_, i) => `technology-${i}`) }];
    expect(searchTermsForGaps(many)).toHaveLength(MAX_SEARCHES_PER_RUN);
  });

  it('the search URL is the constant endpoint with the term encoded into the query', async () => {
    const fake = fakeFetch();
    await run(ONE_GAP, { now: NOW, fetchImpl: fake });
    expect(fake.calls[0].startsWith(`${GITHUB_SEARCH_ENDPOINT}?q=`)).toBe(true);
    expect(fake.calls[0]).toContain('kubernetes');
    // A star floor and a project-shaped scope, so the hits are repositories rather than lists.
    expect(fake.calls[0]).toContain(`stars%3A%3E${MIN_REFERENCE_STARS}`);
    expect(fake.calls[0]).toContain('in%3Aname%2Cdescription');
    // `per_page` bounds how many hits one search may consider, and every one of them is screened.
    expect(fake.calls[0]).toContain(`per_page=${MAX_RESULTS_PER_SEARCH}`);
  });
});

// ---------------------------------------------------------------------------
// The four skips
// ---------------------------------------------------------------------------

describe('every way the stage cannot run is a skip WITH a reason', () => {
  it('DECLINED is `not_requested`, and nothing was fetched', async () => {
    const fake = fakeFetch();
    const { report } = await run(ONE_GAP, { enabled: false, now: NOW, fetchImpl: fake });
    expect(report).toEqual({
      status: 'skipped',
      reason: 'not_requested',
      searchCount: 0,
      consideredCount: 0,
      acceptedCount: 0,
      rejected: [],
      // The terms are still derived, so the body can say what it WOULD have looked for.
      terms: ['kubernetes'],
    });
    expect(fake.calls).toEqual([]);
  });

  it('NO TERMS is `no_search_terms` and the provider is never asked', async () => {
    const fake = fakeFetch();
    const { report } = await run([{ skillTargets: [] }], { now: NOW, fetchImpl: fake });
    expect([report.status, report.reason, report.searchCount]).toEqual([
      'skipped',
      'no_search_terms',
      0,
    ]);
    expect(fake.calls).toEqual([]);
  });

  it('NO FETCH is `research_unavailable`: the module has no ambient network to fall back on', async () => {
    const { report } = await run(ONE_GAP, { now: NOW });
    expect([report.status, report.reason, report.searchCount, report.consideredCount]).toEqual([
      'skipped',
      'research_unavailable',
      0,
      0,
    ]);
  });

  it('AN UNREACHABLE PROVIDER is `research_unavailable`, not "everything was rejected"', async () => {
    for (const options of [{ throwOn: 'search' as const }, { ok: false }]) {
      const { report, accepted } = await run(ONE_GAP, { now: NOW, fetchImpl: fakeFetch(options) });
      // Nothing was learned about any repository, so the whole stage reports as unavailable.
      expect([report.status, report.reason, report.rejected, accepted]).toEqual([
        'skipped',
        'research_unavailable',
        [],
        [],
      ]);
    }
  });

  it('A PROVIDER THAT ANSWERED AND NOTHING PASSED keeps every refusal, with its criterion', async () => {
    const { report } = await run(ONE_GAP, {
      now: NOW,
      fetchImpl: fakeFetch({ items: [item({ license: null })] }),
    });
    expect([report.status, report.reason, report.searchCount, report.consideredCount]).toEqual([
      'skipped',
      'no_references_passed',
      1,
      1,
    ]);
    expect(report.rejected.map((row) => [row.reason, row.url])).toEqual([
      ['no_licence', 'https://github.com/queuewright/queuewright'],
    ]);
  });

  it('every reason it can emit is in the closed vocabulary', () => {
    const reasons = new Set<string>(RESEARCH_REASONS);
    for (const reason of ['ok', 'not_requested', 'no_search_terms', 'research_unavailable', 'no_references_passed']) {
      expect(reasons.has(reason)).toBe(true);
    }
    expect(RESEARCH_REASONS).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// The happy path, and what it is allowed to hand back
// ---------------------------------------------------------------------------

describe('an accepted reference is a SCREENED row, never an invented one', () => {
  it('one accepted reference, and the counts line up with what the provider named', async () => {
    const fake = fakeFetch();
    const { report, accepted } = await run(ONE_GAP, { now: NOW, fetchImpl: fake });
    expect(report).toMatchObject({
      status: 'applied',
      reason: 'ok',
      searchCount: 1,
      consideredCount: 1,
      acceptedCount: 1,
    });
    expect(accepted).toHaveLength(1);
    // A search, then the README the pre-gate decided was worth one request for.
    expect(fake.calls).toHaveLength(2);
    expect(accepted[0]).toMatchObject({
      kind: 'github_repo',
      title: 'queuewright/queuewright',
      url: 'https://github.com/queuewright/queuewright',
      licence: 'MIT',
    });
    expect(accepted[0].activity).toMatchObject({
      stars: 120,
      pushedAt: '2026-06-01T00:00:00.000Z',
      hasReleases: true,
    });
    // The excerpt is stored, and it is an excerpt.
    expect(accepted[0].notes.length).toBeLessThanOrEqual(1_200);
  });

  it('the same repository named twice is screened once', async () => {
    const { report } = await run(ONE_GAP, {
      now: NOW,
      fetchImpl: fakeFetch({ items: [item(), item()] }),
    });
    expect(report.consideredCount).toBe(1);
    expect(report.acceptedCount).toBe(1);
  });

  it('a README that cannot be read is refused on the DOCUMENTATION criterion, not swallowed', async () => {
    const { report, accepted } = await run(ONE_GAP, {
      now: NOW,
      fetchImpl: fakeFetch({ readme: null }),
    });
    expect(accepted).toEqual([]);
    expect(report.reason).toBe('no_references_passed');
    expect(report.rejected.map((row) => row.reason)).toEqual(['no_documentation']);
    // ...and a README fetch that THROWS is the same answer.
    const thrown = await run(ONE_GAP, { now: NOW, fetchImpl: fakeFetch({ throwOn: 'readme' }) });
    expect(thrown.accepted).toEqual([]);
    expect(thrown.report.rejected.map((row) => row.reason)).toEqual(['no_documentation']);
  });

  it('the README is capped on the way IN, so a huge file cannot become a stored excerpt', async () => {
    const huge = `${README}\n\n${'filler. '.repeat(5_000)}`;
    const { accepted } = await run(ONE_GAP, { now: NOW, fetchImpl: fakeFetch({ readme: huge }) });
    expect(accepted).toHaveLength(1);
    expect(accepted[0].notes.length).toBeLessThanOrEqual(1_200);
    expect(MAX_README_FETCH_CHARS).toBeGreaterThan(1_200);
  });
});

// ---------------------------------------------------------------------------
// The pre-gate: it can only say NO
// ---------------------------------------------------------------------------

describe('the README pre-gate saves requests and admits nothing', () => {
  it('a hit that is unlicensed or stale does not cost a README request', async () => {
    expect(worthFetchingReadme(factsFromSearchItem(item()), NOW)).toBe(true);
    expect(worthFetchingReadme(factsFromSearchItem(item({ license: null })), NOW)).toBe(false);
    expect(worthFetchingReadme(factsFromSearchItem(item({ license: { spdx_id: 'gpl-3.0' } })), NOW)).toBe(false);
    expect(worthFetchingReadme(factsFromSearchItem(item({ pushed_at: '2019-01-01T00:00:00.000Z' })), NOW)).toBe(false);
    expect(worthFetchingReadme(factsFromSearchItem(item({ pushed_at: null })), NOW)).toBe(false);
    expect(worthFetchingReadme(factsFromSearchItem(item({ pushed_at: 'nonsense' })), NOW)).toBe(false);
    // ...and the refusal is still reported, because the SCREEN decides, not the pre-gate.
    const { report } = await run(ONE_GAP, {
      now: NOW,
      fetchImpl: fakeFetch({ items: [item({ license: null })] }),
    });
    expect(report.rejected.map((row) => row.reason)).toEqual(['no_licence']);
  });

  it("the README URL is built from the provider's own `owner/name`, or not at all", () => {
    expect(readmeUrlFor(factsFromSearchItem(item()))).toBe(
      'https://api.github.com/repos/queuewright/queuewright/readme',
    );
    // Anything that is not exactly two path segments yields no URL rather than a wrong one.
    for (const fullName of ['', 'queuewright', 'a/b/c', '/b', 'a/']) {
      expect([fullName, readmeUrlFor({ fullName })]).toEqual([fullName, null]);
      expect([fullName, tagsUrlFor({ fullName })]).toEqual([fullName, null]);
    }
    // ...and the name is percent-encoded, so a repository name with a space cannot inject a path.
    expect(readmeUrlFor({ fullName: 'a b/c d' })).toBe('https://api.github.com/repos/a%20b/c%20d/readme');
    expect(tagsUrlFor({ fullName: 'a b/c d' })).toBe(
      'https://api.github.com/repos/a%20b/c%20d/tags?per_page=1',
    );
  });

  it('E.5\'s releases criterion is checked: tags are fetched ONLY when the README has no usage', async () => {
    // A README with a usage section needs no second request - the criterion is already satisfied.
    const documented = fakeFetch();
    await run(ONE_GAP, { now: NOW, fetchImpl: documented });
    expect(documented.calls.filter((url) => url.includes('/tags'))).toEqual([]);

    // A README with no usage section triggers the tag listing, and a repository WITH tags is then
    // accepted on the releases half of the criterion instead of being refused for lacking one.
    const undocumented = fakeFetch({ readme: '# Name\n\n' + 'A project. '.repeat(40) + '\n' });
    const { report, accepted } = await run(ONE_GAP, { now: NOW, fetchImpl: undocumented });
    expect(undocumented.calls.filter((url) => url.includes('/tags'))).toHaveLength(1);
    expect(report.acceptedCount).toBe(1);
    expect(accepted[0].activity.hasReleases).toBe(true);

    // And a repository with NO tags is still refused, on the same criterion and for the same
    // reason - the lookup bought nothing, and nothing was invented.
    const untagged = fakeFetch({ readme: '# Name\n\n' + 'A project. '.repeat(40) + '\n', tags: [] });
    const without = await run(ONE_GAP, { now: NOW, fetchImpl: untagged });
    expect(without.accepted).toEqual([]);
    expect(without.report.rejected.map((row) => row.reason)).toEqual(['no_releases_or_documented_usage']);
  });
});

// ---------------------------------------------------------------------------
// The item mapper: defensive on every field, because this is the untrusted boundary
// ---------------------------------------------------------------------------

describe('a malformed provider item becomes no licence, never a licence', () => {
  it('every field is read defensively', () => {
    const facts = factsFromSearchItem({
      full_name: 42,
      html_url: null,
      stargazers_count: 'many',
      pushed_at: 7,
      archived: 'no',
      topics: 'queue',
      license: 'MIT',
      releases_count: '3',
    });
    expect([
      facts.fullName,
      facts.htmlUrl,
      facts.stargazersCount,
      facts.pushedAt,
      facts.archived,
      facts.topics,
      facts.license,
      facts.releasesCount,
    ]).toEqual([null, null, null, null, null, null, null, null]);
  });

  it('a licence object without an spdx_id is no licence, not a licence', () => {
    expect(factsFromSearchItem(item({ license: {} })).license).toEqual({ spdxId: undefined });
    expect(screenOf(factsFromSearchItem(item({ license: {} })))).toBe('no_licence');
    // ...and the same item WITH a usable spdx id gets as far as the next criterion, which is
    // the documentation floor: the licence is no longer what stops it.
    expect(screenOf(withReadme(factsFromSearchItem(item({ license: { spdx_id: 'mit' } })), README))).toBe(
      'accepted',
    );
  });
});

/** The screen's verdict as one word, so the mapping assertions above read as rules. */
function screenOf(facts: ReturnType<typeof factsFromSearchItem>): string {
  const screen = screenReference(facts, NOW);
  return 'accepted' in screen ? 'accepted' : screen.reason;
}