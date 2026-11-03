// Registry parity tests (T620): the registry must cover exactly the 14
// JobSourceConfig types and reproduce the Wave-0 JOB_SOURCE_VALUES set.
// No network access: only pure registry lookups and assertProviderConfig.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PROVIDERS,
  getProvider,
  sourceIdsFor,
  allSourceIds,
  assertProviderConfig,
  configForRegistryRow,
  SourceConfigError,
  UnknownSourceTypeError,
  type ProviderDescriptor,
} from './providerRegistry.js';
import { JOB_SOURCE_VALUES } from '../shared/validation.js';
import { SUPPORTED_SCRAPER_PROVIDERS, type JobSourceConfig } from './index.js';
import { AGGREGATOR_PROVIDERS } from './aggregators.js';

// Mirrors the JobSourceConfig['type'] union in index.ts. Typed as such so an
// extra entry is a compile error; omission/extra vs PROVIDERS fails below.
const UNION_TYPES: Array<JobSourceConfig['type']> = [
  'greenhouse', 'ashby', 'lever', 'workday', 'rss', 'json', 'search',
  'smartrecruiters', 'recruitee', 'personio', 'jobicy', 'hnalgolia',
  'scraper', 'aggregator',
  // Wave 4 (T681): tier-1 group-A adapters.
  'workable', 'bamboohr', 'breezyhr', 'jobvite',
  // Wave 4 (T682): tier-1 group-B adapters (rippling deferred: no entry).
  'teamtailor', 'pinpoint', 'freshteam',
  // Wave 4 (T683): tier-3 career-page adapter.
  'career-page',
  // Wave 5 (T702): template-driven dorking (additive: descriptor appended
  // last, existing ids keep their positions - N1).
  'dorking',
  // Wave 6 (T724): tier-4 browser adapter (additive: descriptor appended
  // last, existing ids keep their positions - N1). Disabled by default,
  // never seeded, deep-mode only.
  'browser',
];

// sourceIds ground truth per descriptor, verified against the fetcher return
// statements (see providerRegistry.ts header for file:line evidence).
const EXPECTED_SOURCE_IDS: Record<string, readonly string[]> = {
  greenhouse: ['greenhouse'],
  ashby: ['ashby'],
  lever: ['lever'],
  workday: ['workday'],
  rss: ['rss'],
  json: ['json', 'jobicy'],
  search: ['search'],
  smartrecruiters: ['smartrecruiters'],
  recruitee: ['recruitee'],
  personio: ['personio'],
  jobicy: ['jobicy'],
  hnalgolia: ['hnalgolia'],
  scraper: [...SUPPORTED_SCRAPER_PROVIDERS, 'scraper'],
  aggregator: [...AGGREGATOR_PROVIDERS],
  // Wave 4 (T681): tier-1 group-A adapters, one source id each.
  workable: ['workable'],
  bamboohr: ['bamboohr'],
  breezyhr: ['breezyhr'],
  jobvite: ['jobvite'],
  // Wave 4 (T682): tier-1 group-B adapters, one source id each
  // (rippling deferred: no descriptor, no entry).
  teamtailor: ['teamtailor'],
  pinpoint: ['pinpoint'],
  freshteam: ['freshteam'],
  // Wave 4 (T683): tier-3 career-page adapter, one source id.
  'career-page': ['career-page'],
  // Wave 5 (T702): dorking emits its own source id (stamped in
  // dorking/index.ts); kind 'search', tier 5.
  dorking: ['dorking'],
  // Wave 6 (T724): browser rows parsed from the rendered page itself carry
  // 'browser' (stamped in browser/tier.ts); kind 'browser', tier 4.
  browser: ['browser'],
};

function mustGet(type: string): ProviderDescriptor {
  const d = getProvider(type);
  expect(d, `getProvider('${type}')`).toBeDefined();
  return d!;
}

describe('provider registry coverage', () => {
  it('covers exactly the 24 JobSourceConfig types (fails on omission or extra)', () => {
    expect(UNION_TYPES).toHaveLength(24);
    expect(PROVIDERS).toHaveLength(24);
    expect([...PROVIDERS.map((p) => p.type)].sort()).toEqual([...UNION_TYPES].sort());
    for (const t of UNION_TYPES) {
      expect(getProvider(t), `getProvider('${t}')`).toBeDefined();
    }
  });

  it('allSourceIds() deep-equals JOB_SOURCE_VALUES exactly (27 ids)', () => {
    expect([...allSourceIds()].sort()).toEqual([...JOB_SOURCE_VALUES].sort());
    expect(allSourceIds()).toHaveLength(27);
    expect(allSourceIds()).toHaveLength(JOB_SOURCE_VALUES.length);
  });

  it("getProvider('nope') returns undefined and sourceIdsFor('nope') is []", () => {
    expect(getProvider('nope')).toBeUndefined();
    expect(sourceIdsFor('nope')).toEqual([]);
  });

  it('pins every descriptor sourceIds against the fetcher ground truth', () => {
    for (const [type, ids] of Object.entries(EXPECTED_SOURCE_IDS)) {
      expect(sourceIdsFor(type), `sourceIdsFor('${type}')`).toEqual(ids);
    }
  });

  it('every descriptor has a handler, kind, auth, requires, and explain', () => {
    for (const d of PROVIDERS) {
      expect(typeof d.handler, `${d.type}.handler`).toBe('function');
      expect(['api', 'feed', 'json', 'search', 'scraper', 'aggregator', 'browser']).toContain(d.kind);
      expect(d.explain.trim().length, `${d.type}.explain`).toBeGreaterThan(0);
      expect(
        d.auth === 'keyless' || (typeof d.auth === 'object' && typeof d.auth.byok === 'string'),
        `${d.type}.auth`,
      ).toBe(true);
    }
  });
});

describe('assertProviderConfig', () => {
  it('throws SourceConfigError for a greenhouse board with no board token', () => {
    expect(() => assertProviderConfig(mustGet('greenhouse'), { type: 'greenhouse' }))
      .toThrowError(SourceConfigError);
  });

  it('throws SourceConfigError for an aggregator board with no provider', () => {
    expect(() => assertProviderConfig(mustGet('aggregator'), { type: 'aggregator' }))
      .toThrowError(SourceConfigError);
  });

  it('does NOT throw for a search board with an empty effective query (intentional empty)', () => {
    const d = mustGet('search');
    expect(() => assertProviderConfig(d, { type: 'search' })).not.toThrow();
    expect(() => assertProviderConfig(d, { type: 'search', query: '  ', searchQuery: '' })).not.toThrow();
    expect(() => assertProviderConfig(d, { type: 'search', searchQuery: 'engineer' })).not.toThrow();
  });

  it('does NOT throw for jobicy/hnalgolia with no extra config', () => {
    expect(() => assertProviderConfig(mustGet('jobicy'), { type: 'jobicy' })).not.toThrow();
    expect(() => assertProviderConfig(mustGet('hnalgolia'), { type: 'hnalgolia' })).not.toThrow();
  });

  it('throws SourceConfigError for unknown scraper/aggregator provider values', () => {
    expect(() => assertProviderConfig(mustGet('scraper'), { type: 'scraper', scraperProvider: 'bogus' }))
      .toThrowError(SourceConfigError);
    expect(() => assertProviderConfig(mustGet('aggregator'), { type: 'aggregator', aggregatorProvider: 'bogus' }))
      .toThrowError(SourceConfigError);
  });

  it('throws SourceConfigError naming a retired aggregator provider', () => {
    expect(() => assertProviderConfig(mustGet('aggregator'), { type: 'aggregator', aggregatorProvider: 'careerjet' }))
      .toThrowError(/no longer supported/);
  });

  it('does NOT throw for fully configured boards', () => {
    expect(() => assertProviderConfig(mustGet('greenhouse'), { type: 'greenhouse', board: 'anthropic' })).not.toThrow();
    expect(() => assertProviderConfig(mustGet('rss'), { type: 'rss', feedUrl: 'https://example.com/feed.rss' })).not.toThrow();
    expect(() => assertProviderConfig(mustGet('scraper'), { type: 'scraper', scraperProvider: 'linkedin' })).not.toThrow();
    expect(() => assertProviderConfig(mustGet('aggregator'), { type: 'aggregator', aggregatorProvider: 'adzuna' })).not.toThrow();
  });

  // Wave 4 (T681): group-A descriptors require the research doc's
  // boardToken in `board` and route to their adapter fetcher.
  it('throws SourceConfigError for a group-A board with no board token', () => {
    for (const type of ['workable', 'bamboohr', 'breezyhr', 'jobvite'] as const) {
      expect(() => assertProviderConfig(mustGet(type), { type }), `missing board for '${type}'`)
        .toThrowError(SourceConfigError);
      expect(() => assertProviderConfig(mustGet(type), { type, board: 'acme' }), `board for '${type}'`)
        .not.toThrow();
    }
  });

  // Wave 4 (T682): group-B descriptors require the research doc's
  // subdomain in `board` and route to their adapter fetcher.
  it('throws SourceConfigError for a group-B board with no board token', () => {
    for (const type of ['teamtailor', 'pinpoint', 'freshteam'] as const) {
      expect(() => assertProviderConfig(mustGet(type), { type }), `missing board for '${type}'`)
        .toThrowError(SourceConfigError);
      expect(() => assertProviderConfig(mustGet(type), { type, board: 'acme' }), `board for '${type}'`)
        .not.toThrow();
    }
  });

  // Wave 4 (T683): the tier-3 career-page descriptor takes the page URL in
  // `feedUrl` (same field the other page-fetching descriptors use) and
  // routes to `fetchCareerPage`.
  it('routes career-page boards to the tier-3 adapter with a feedUrl requirement', () => {
    const d = mustGet('career-page');
    expect(d.tier).toBe(3);
    expect([...d.requires]).toEqual(['feedUrl']);
    expect(() => assertProviderConfig(d, { type: 'career-page' }))
      .toThrowError(SourceConfigError);
    expect(() => assertProviderConfig(d, { type: 'career-page', feedUrl: 'https://careers.acme.example.test/' }))
      .not.toThrow();
  });

  // Wave 5 (T702): the dorking descriptor is a tier-5 search board with no
  // required config (an empty intent still expands the generic families),
  // an index-date mapping, and no suppression/exclusivity field (N3).
  it('registers the dorking descriptor as an additive tier-5 search board', () => {
    const d = mustGet('dorking');
    expect(d.kind).toBe('search');
    expect(d.tier).toBe(5);
    expect([...d.sourceIds]).toEqual(['dorking']);
    expect([...d.requires]).toEqual([]);
    expect(d.enabledByDefault).toBe(false);
    expect(d.dateMapping).toEqual([{ field: 'postedAt', source: 'index-date' }]);
    for (const key of ['suppresses', 'exclusive', 'replaces', 'solo', 'only']) {
      expect(Object.keys(d), `descriptor key "${key}"`).not.toContain(key);
    }
    expect(() => assertProviderConfig(d, { type: 'dorking' })).not.toThrow();
    expect(() => assertProviderConfig(d, { type: 'dorking', query: 'engineer' })).not.toThrow();
  });

  // Wave 6 (T724, ADR-029): the browser descriptor is a tier-4,
  // deep-mode-only, ENHANCEMENT ONLY board. It requires the page URL in
  // `feedUrl` (same field the other page-fetching descriptors use) plus an
  // explicit `deepMode: true` run flag (wave 7's orchestrator supplies it;
  // boardToConfig never sets it). Disabled by default: never seeded, never
  // auto-enabled. Rows parsed from the rendered page itself carry
  // `source: 'browser'` with a source-posted/discovery-at mapping (N4).
  it('registers the browser descriptor as an additive tier-4 deep-mode-only board', () => {
    const d = mustGet('browser');
    expect(d.kind).toBe('browser');
    expect(d.tier).toBe(4);
    expect([...d.sourceIds]).toEqual(['browser']);
    expect([...d.requires]).toEqual(['feedUrl', 'deepMode']);
    expect(d.enabledByDefault).toBe(false);
    expect(d.dateMapping).toEqual([
      { field: 'postedAt', source: 'source-posted' },
      { field: 'postedAt', source: 'discovery-at' },
    ]);
    expect(d.explain).toMatch(/ENHANCEMENT ONLY/);
    // Missing page URL fails loudly; missing run-mode flag fails loudly;
    // both together pass config (availability is a runtime skip, not a
    // config error).
    expect(() => assertProviderConfig(d, { type: 'browser' }))
      .toThrowError(SourceConfigError);
    expect(() => assertProviderConfig(d, { type: 'browser', feedUrl: 'https://careers.acme.example.test/' }))
      .toThrowError(/deep mode only/);
    expect(() => assertProviderConfig(d, { type: 'browser', feedUrl: 'https://careers.acme.example.test/', deepMode: true }))
      .not.toThrow();
  });
});

// Wave 4 (T684, STEP 3): tiers 1/2/3 are all reachable by a plain HTTP path
// and nothing in this wave may require a browser (N2 - the browser tier is
// wave 6, which does not exist yet). The tier-3 descriptor exists alongside
// the tier-1/2 ones, and no wave-4 adapter file imports the browser module
// (structural source-level check: backend/src/browser/* does not exist).
describe('tier routing rule (tiers 1/2/3 are plain HTTP, no browser)', () => {
  it('a descriptor declares tier 3 and no tier 1/2/3 descriptor needs a browser-backed kind', () => {
    const tier3 = PROVIDERS.filter((p) => p.tier === 3);
    expect(tier3.map((p) => p.type)).toEqual(['career-page']);
    // Tiers 1/2/3 are all plain-HTTP kinds (keyless board APIs, generic
    // feeds/JSON, official aggregator APIs, owned page fetch); the only
    // non-page-fetch kinds in the registry are tier 4 (scraper backend) and
    // tier 5 (search backend) - there is no browser kind in this wave.
    for (const d of PROVIDERS) {
      expect(['api', 'feed', 'json', 'search', 'scraper', 'aggregator', 'browser']).toContain(d.kind);
      if (d.tier === 1 || d.tier === 2 || d.tier === 3) {
        expect(['api', 'feed', 'json', 'aggregator'], `${d.type}.kind`).toContain(d.kind);
      }
    }
  });

  it('no wave-4 adapter file imports the browser module (source-level check)', () => {
    // Wave 6 (T721 onward) legitimately creates backend/src/browser/* - pure
    // guardrails first, per the wave-6 spec FILES section and ADR-029
    // section 5 - so the old "browser tree does not exist yet" premise is
    // retired. What remains enforced is the real coupling rule: no wave-4
    // adapter imports the browser module.
    const wave4 = [
      'workable', 'bamboohr', 'breezyhr', 'jobvite',
      'teamtailor', 'pinpoint', 'freshteam', 'career-page',
    ];
    for (const name of wave4) {
      const file = path.join(__dirname, 'adapters', `${name}.ts`);
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (/^\s*import\b/.test(line) || /require\s*\(/.test(line)) {
          expect(line, `${name}.ts imports browser`).not.toMatch(/browser/i);
        }
      }
    }
  });
});

// Wave 4 (T684, STEP 1): registry-row -> adapter routing is data derived
// from the registry tables, not a per-provider if-ladder. `provider` names
// the adapter, `boardToken` supplies its config, `provider: null` is a
// tier-3 page served from the row URL.
describe('configForRegistryRow (registry-driven tier routing)', () => {
  it('routes an ATS row to its adapter with boardToken as board', () => {
    expect(configForRegistryRow({ provider: 'greenhouse', boardToken: 'acme', url: 'https://boards.greenhouse.io/acme' }))
      .toMatchObject({ type: 'greenhouse', board: 'acme' });
    expect(configForRegistryRow({ provider: 'workable', boardToken: 'abc123', url: 'https://apply.workable.com/abc123/' }))
      .toMatchObject({ type: 'workable', board: 'abc123' });
    expect(configForRegistryRow({ provider: 'teamtailor', boardToken: 'acme', url: 'https://acme.teamtailor.com/' }))
      .toMatchObject({ type: 'teamtailor', board: 'acme' });
  });

  it('routes host-table aliases to their backing adapter (breezyhr/pinpoint)', () => {
    expect(configForRegistryRow({ provider: 'breezy', boardToken: 'acme', url: 'https://acme.breezy.hr/' }))
      .toMatchObject({ type: 'breezyhr', board: 'acme' });
    expect(configForRegistryRow({ provider: 'pinpointhq', boardToken: 'acme', url: 'https://acme.pinpointhq.com/' }))
      .toMatchObject({ type: 'pinpoint', board: 'acme' });
  });

  it('routes provider null to fetchCareerPage with the row URL as feedUrl', () => {
    const url = 'https://careers.acme.example.test/jobs';
    const config = configForRegistryRow({ provider: null, boardToken: null, url });
    expect(config).toMatchObject({ type: 'career-page', feedUrl: url });
  });

  it('throws SourceConfigError for a new type with missing required config, never []', () => {
    expect(() => configForRegistryRow({ provider: 'workable', boardToken: null, url: 'https://apply.workable.com/acme/' }))
      .toThrowError(SourceConfigError);
    expect(() => configForRegistryRow({ provider: null, boardToken: null, url: '' }))
      .toThrowError(SourceConfigError);
  });

  it('throws UnknownSourceTypeError for a deferred or unknown provider id', () => {
    expect(() => configForRegistryRow({ provider: 'rippling', boardToken: 'acme', url: 'https://acme.rippling.com/' }))
      .toThrowError(UnknownSourceTypeError);
    expect(() => configForRegistryRow({ provider: 'nope', boardToken: 'acme', url: 'https://example.test/' }))
      .toThrowError(UnknownSourceTypeError);
  });
});
