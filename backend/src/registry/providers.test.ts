// T644: registry provider vocabulary agrees with the wave-1 adapter
// registry. Pure lookups only: no network, no Prisma, no fetcher calls.
// Fixture hosts are synthetic (`example.test`); company tokens are "acme".
import { describe, it, expect } from 'vitest';
import {
  REGISTRY_PROVIDERS,
  NULL_REGISTRY_PROVIDER_ID,
  capabilityFor,
  tierForProvider,
  adapterTypeFor,
} from './providers.js';
import { PROVIDERS, getProvider } from '../jobSources/providerRegistry.js';
import { AGGREGATOR_PROVIDERS, isAggregatorProvider } from '../jobSources/aggregators.js';
import { extractAts } from './atsUrl.js';

// Pinned vocabulary: wave-1 ATS parsers + aggregator family + search
// family + wave-4 tier-1 adapters (T681/T682) + the null-provider
// placeholder. Registry ids are the extractAts host-table vocabulary, so the
// wave-4 aliases appear under their host-table spellings (`breezy` for the
// breezyhr adapter, `pinpointhq` for the pinpoint adapter); `rippling` is
// deferred (no keyless adapter) and stays unlisted. Adding a provider means
// extending this list AND the agreement checks below.
const EXPECTED_IDS: readonly string[] = [
  'greenhouse',
  'ashby',
  'lever',
  'workday',
  'smartrecruiters',
  'recruitee',
  'personio',
  'jobicy',
  'hnalgolia',
  'adzuna',
  'usajobs',
  'reed',
  'findwork',
  'search',
  // Wave 4 (T681): tier-1 group-A adapters.
  'workable',
  'bamboohr',
  'breezy',
  'jobvite',
  // Wave 4 (T682): tier-1 group-B adapters (rippling deferred: unlisted).
  'teamtailor',
  'pinpointhq',
  'freshteam',
  NULL_REGISTRY_PROVIDER_ID,
];

describe('REGISTRY_PROVIDERS vocabulary shape', () => {
  it('is data: pins exactly the 22 expected ids in declaration order', () => {
    expect(REGISTRY_PROVIDERS.map((p) => p.id)).toEqual([...EXPECTED_IDS]);
  });

  it('has no duplicate ids', () => {
    const ids = REGISTRY_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses only the descriptor requires vocabulary (board/feedUrl/aggregatorProvider or empty)', () => {
    const knownFields = new Set(['board', 'feedUrl', 'searchQuery', 'scraperProvider', 'aggregatorProvider']);
    for (const entry of REGISTRY_PROVIDERS) {
      for (const field of entry.requires) {
        expect(knownFields.has(field), `${entry.id} requires "${field}"`).toBe(true);
      }
    }
  });
});

describe('registry providers resolve to a known adapter with a reachable handler (STEP 2)', () => {
  it('every registry id - placeholder included - has a known adapter whose handler is reachable', () => {
    for (const entry of REGISTRY_PROVIDERS) {
      const backing = adapterTypeFor(entry.id);
      expect(backing, `backing adapter for "${entry.id}"`).not.toBeNull();
      const descriptor = getProvider(backing!);
      expect(descriptor, `descriptor for "${backing}"`).toBeDefined();
      expect(typeof descriptor!.handler, `handler for "${backing}"`).toBe('function');
    }
  });

  it('fails on an unknown registry id (no silent routing)', () => {
    expect(capabilityFor('nope')).toBeUndefined();
    expect(adapterTypeFor('nope')).toBeNull();
    expect(tierForProvider('nope')).toBeUndefined();
  });

  it('covers every provider T681/T682 added: each new adapter type is reachable from a registry id', () => {
    // Registry id -> backing adapter (aliases included). Rippling is
    // deferred (unlisted, no adapter); career-page is reached via null.
    const reachable = new Set(
      REGISTRY_PROVIDERS.map((p) => adapterTypeFor(p.id)),
    );
    for (const type of [
      'workable', 'bamboohr', 'breezyhr', 'jobvite',
      'teamtailor', 'pinpoint', 'freshteam', 'career-page',
    ] as const) {
      expect(reachable.has(type), `adapter "${type}" reachable`).toBe(true);
    }
  });

  it('provider null routes to fetchCareerPage (tier-3 page, not an error)', () => {
    expect(adapterTypeFor(null)).toBe('career-page');
    const descriptor = getProvider(adapterTypeFor(null)!);
    expect(descriptor).toBeDefined();
    expect(typeof descriptor!.handler).toBe('function');
  });

  it('adapterTypeFor maps aggregator members to the single aggregator adapter', () => {
    for (const member of AGGREGATOR_PROVIDERS) {
      expect(REGISTRY_PROVIDERS.some((p) => p.id === member), `member "${member}"`).toBe(true);
      expect(adapterTypeFor(member)).toBe('aggregator');
    }
  });

  it('adapterTypeFor is identity for direct ATS/search ids, aliased for breezy/pinpointhq, null for deferred rippling', () => {
    expect(adapterTypeFor('greenhouse')).toBe('greenhouse');
    expect(adapterTypeFor('workday')).toBe('workday');
    expect(adapterTypeFor('search')).toBe('search');
    // Wave-4 identity ids (registry id === adapter type).
    expect(adapterTypeFor('workable')).toBe('workable');
    expect(adapterTypeFor('bamboohr')).toBe('bamboohr');
    expect(adapterTypeFor('jobvite')).toBe('jobvite');
    expect(adapterTypeFor('teamtailor')).toBe('teamtailor');
    expect(adapterTypeFor('freshteam')).toBe('freshteam');
    // Wave-4 aliases: the extractAts host-table id differs from the adapter
    // type (same mapping the tier-3 delegation uses).
    expect(adapterTypeFor('breezy')).toBe('breezyhr');
    expect(adapterTypeFor('pinpointhq')).toBe('pinpoint');
    // Deferred with no keyless adapter (research doc section 7): null means
    // "not yet routable", never an error signal.
    expect(adapterTypeFor('rippling')).toBeNull();
    expect(capabilityFor('rippling')).toBeUndefined();
  });
});

describe('registry tier/requires agree with the adapter descriptors', () => {
  it('direct and aliased entries deep-equal their backing descriptor tier and requires', () => {
    for (const entry of REGISTRY_PROVIDERS) {
      if (entry.id === NULL_REGISTRY_PROVIDER_ID) continue;
      if (isAggregatorProvider(entry.id)) continue;
      const backing = adapterTypeFor(entry.id);
      expect(backing, `backing adapter for "${entry.id}"`).not.toBeNull();
      const descriptor = getProvider(backing!);
      expect(descriptor, `descriptor for "${backing}"`).toBeDefined();
      expect(entry.tier, `${entry.id}.tier`).toBe(descriptor!.tier);
      expect([...entry.requires], `${entry.id}.requires`).toEqual([...descriptor!.requires]);
    }
  });

  it('the null-provider placeholder agrees on tier with the career-page descriptor', () => {
    const entry = capabilityFor(null)!;
    const descriptor = getProvider('career-page')!;
    expect(adapterTypeFor(null)).toBe('career-page');
    expect(entry.tier).toBe(descriptor.tier);
    expect(entry.tier).toBe(3);
    // The placeholder needs only the row URL (requires is empty); the page
    // URL itself arrives in `feedUrl` via configForRegistryRow, so the
    // descriptor's ['feedUrl'] requirement is satisfied without a stored field.
    expect(entry.requires).toEqual([]);
  });

  it('aggregator members agree with the aggregator descriptor (tier 1, aggregatorProvider)', () => {
    const aggregator = getProvider('aggregator');
    expect(aggregator).toBeDefined();
    for (const member of AGGREGATOR_PROVIDERS) {
      const entry = capabilityFor(member);
      expect(entry, `entry for "${member}"`).toBeDefined();
      expect(entry!.tier).toBe(aggregator!.tier);
      expect([...entry!.requires]).toEqual([...aggregator!.requires]);
    }
  });

  it('the registry vocabulary introduces no adapter the contract does not know', () => {
    const adapterTypes = new Set(PROVIDERS.map((p) => p.type));
    for (const entry of REGISTRY_PROVIDERS) {
      const backing = adapterTypeFor(entry.id);
      expect(backing, `backing adapter for "${entry.id}"`).not.toBeNull();
      expect(adapterTypes.has(backing!), `adapter "${backing}"`).toBe(true);
    }
  });
});

describe('provider null is a tier-3 page, NOT an error (STEP 4)', () => {
  it('capabilityFor maps null/undefined/empty to the tier-3 placeholder without throwing', () => {
    for (const missing of [null, undefined, ''] as const) {
      const cap = capabilityFor(missing);
      expect(cap, `capabilityFor(${String(missing)})`).toBeDefined();
      expect(cap!.id).toBe(NULL_REGISTRY_PROVIDER_ID);
      expect(cap!.tier).toBe(3);
      expect(tierForProvider(missing)).toBe(3);
    }
  });

  it('an unknown-host career-page URL resolves end to end to tier 3 and the career-page adapter', () => {
    const { provider } = extractAts('https://careers.acme.example.test/jobs');
    expect(provider).toBeNull();
    expect(tierForProvider(provider)).toBe(3);
    expect(adapterTypeFor(provider)).toBe('career-page');
    expect(() => capabilityFor(provider)).not.toThrow();
  });

  it('the placeholder needs only the row URL (requires is empty)', () => {
    expect(capabilityFor(null)!.requires).toEqual([]);
  });
});
