// Registry provider capability vocabulary (T644; wave-2 spec SCOPE item 6).
//
// Waves 4 (ATS adapters) and 7 (orchestrator) need to know, per provider,
// which config a provider requires and at which tier it is reachable -
// without a second hand-maintained list. This module is the REGISTRY side of
// that agreement: a data table (not an if-ladder) mapping registry provider
// ids to their capability. Agreement with the wave-1 adapter registry
// (`jobSources/providerRegistry.ts` PROVIDERS) and with the generated
// contract (`shared/job-sources.json`, emitted by T624's emitter) is enforced
// by `providers.test.ts`, not by imports: this module is self-contained and
// pure (no fetcher, Prisma, or network imports) so waves 4/7 can consume it
// without pulling the fetcher graph.
//
// Ground truth for tier/requires (must match the PROVIDERS descriptor or the
// cross-check test fails):
//   greenhouse/ashby/lever/smartrecruiters/recruitee/personio -> tier 1,
//     requires ['board'] (providerRegistry.ts)
//   workday -> tier 2, requires ['feedUrl'] (generic feed parser)
//   jobicy/hnalgolia -> tier 1, requires [] (keyless, no company token)
//   adzuna/usajobs/reed/findwork -> tier 1, requires ['aggregatorProvider']
//     (each routes through the single 'aggregator' adapter; AGGREGATOR_PROVIDERS
//     in jobSources/aggregators.ts)
//   search -> tier 5, requires [] (empty effective query is intentional empty)
//   workable/bamboohr/jobvite/teamtailor/freshteam -> tier 1, requires
//     ['board'] (Wave 4, T681/T682; registry id === adapter type)
//   breezy/pinpointhq -> tier 1, requires ['board'] (Wave 4; these are the
//     extractAts host-table ids for the breezyhr/pinpoint adapters - the
//     adapter column names the backing PROVIDERS type, same mapping the
//     tier-3 career-page delegation uses)
//   null-provider placeholder -> tier 3, requires [] (wave 4 career-page adapter)
//     with adapter 'career-page' (CompanyCareerPage rows store provider null,
//     never the string 'career-page'; the row URL supplies the page)
//   rippling -> DEFERRED (research doc section 7: no keyless endpoint
//     verified): extractAts can emit it, but it has NO entry here and NO
//     adapter, so it resolves to undefined/null ("not yet routable", never
//     an error signal)
//
// TIER RULE (T684, ADR-026/ADR-027 priority): tiers 1/2/3 are ALL reachable
// by a plain HTTP path (keyless board APIs, feeds, owned page fetch) and
// NOTHING in this wave may require a browser (N2 - the browser tier is wave
// 6, which does not exist yet). Pinned structurally by
// `providerRegistry.test.ts` ("no adapter imports the browser module").
//
// RULE (STEP 4): a `CompanyCareerPage` row with `provider: null` is a tier-3
// HTTP page and is NOT an error. Unknown hosts yield `{ null, null }` from
// `extractAts` (atsUrl.ts) and the importer stores `tier: 3` (importer.ts
// `prepareRow`: `tier: provider === null ? 3 : 1`). Such rows wait for wave
// 4's career-page adapter; nothing here throws for them - `capabilityFor`
// maps null/undefined/'' to the placeholder entry and `adapterTypeFor`
// returns 'career-page' (T684), which callers route to `fetchCareerPage`
// via `configForRegistryRow` (jobSources/providerRegistry.ts).
//
// STEP 3 DECISION (recorded): this vocabulary does NOT join
// `shared/job-sources.json`. Reasons:
//   1. The T624 emitter derives the artifact SOLELY from wave-1 PROVIDERS
//      (14 board types, 17 source ids, per-provider kind/auth/requires/
//      enabledByDefault/explain). This vocabulary is a different axis:
//      registry career-page provider ids (15 entries incl. aggregator members
//      and a null placeholder that has no adapter and no kind/auth/explain).
//   2. Merging would either overload the `providers` array with non-adapter
//      entries (breaking the parity test's provider-count invariant and every
//      frontend consumer of the artifact) or add a second top-level key with
//      a second derivation path - effectively a second emitter in the same
//      file plus parity-test surgery, which the task forbids.
//   3. No frontend consumer needs it: waves 4/7 are backend-only. Wave 4's
//      task decides whether the vocabulary belongs in the contract (e.g. once
//      the career-page adapter lands and the placeholder gains a real
//      adapter, the two vocabularies may merge).
// Hence: no second emitter, no second contract file, no emitter change.
//
// Do NOT add providers beyond the extractAts vocabulary plus the tier-3
// placeholder: rippling is deferred (no keyless adapter) and stays unlisted.
// An unlisted non-empty id resolves to undefined here so wave-4-future
// additions fail loudly at the lookup site instead of silently routing.

/** One registry provider's capability: what config it needs, what tier serves it. */
export interface RegistryProviderCapability {
  readonly id: string;
  readonly tier: number;
  readonly requires: readonly string[];
  /**
   * Backing adapter-registry type (`PROVIDERS` entry in
   * jobSources/providerRegistry.ts). Omitted when the registry id IS the
   * adapter type (identity) or when the entry derives its adapter from its
   * own `requires` data (aggregator members -> 'aggregator'). Set explicitly
   * only where the extractAts host-table id differs from the adapter type
   * ('breezy' -> 'breezyhr', 'pinpointhq' -> 'pinpoint') and for the
   * null-provider placeholder (rows store null, never 'career-page', so the
   * placeholder names its adapter explicitly).
   */
  readonly adapter?: string;
}

/**
 * Placeholder id for `CompanyCareerPage` rows whose `provider` is null.
 * A string id keeps REGISTRY_PROVIDERS a uniform data table; `capabilityFor`
 * maps null/undefined/'' to this entry.
 */
export const NULL_REGISTRY_PROVIDER_ID = 'unknown';

export const REGISTRY_PROVIDERS: readonly RegistryProviderCapability[] = [
  { id: 'greenhouse', tier: 1, requires: ['board'] },
  { id: 'ashby', tier: 1, requires: ['board'] },
  { id: 'lever', tier: 1, requires: ['board'] },
  { id: 'workday', tier: 2, requires: ['feedUrl'] },
  { id: 'smartrecruiters', tier: 1, requires: ['board'] },
  { id: 'recruitee', tier: 1, requires: ['board'] },
  { id: 'personio', tier: 1, requires: ['board'] },
  { id: 'jobicy', tier: 1, requires: [] },
  { id: 'hnalgolia', tier: 1, requires: [] },
  { id: 'adzuna', tier: 1, requires: ['aggregatorProvider'] },
  { id: 'usajobs', tier: 1, requires: ['aggregatorProvider'] },
  { id: 'reed', tier: 1, requires: ['aggregatorProvider'] },
  { id: 'findwork', tier: 1, requires: ['aggregatorProvider'] },
  { id: 'search', tier: 5, requires: [] },
  // Wave 4 (T681/T682, T684): tier-1 group-A/B adapters. Registry ids are
  // the extractAts host-table vocabulary (atsUrl.ts); five of the seven are
  // identical to their adapter type, while `breezy`/`pinpointhq` name their
  // backing adapter explicitly (same alias the tier-3 career-page delegation
  // uses). Rippling is deferred (no keyless adapter) and stays unlisted.
  { id: 'workable', tier: 1, requires: ['board'] },
  { id: 'bamboohr', tier: 1, requires: ['board'] },
  { id: 'breezy', tier: 1, requires: ['board'], adapter: 'breezyhr' },
  { id: 'jobvite', tier: 1, requires: ['board'] },
  { id: 'teamtailor', tier: 1, requires: ['board'] },
  { id: 'pinpointhq', tier: 1, requires: ['board'], adapter: 'pinpoint' },
  { id: 'freshteam', tier: 1, requires: ['board'] },
  // Placeholder for `provider: null` rows: tier-3 HTTP page, NOT an error.
  // Wave 4's career-page adapter serves these from the row URL alone
  // (see `configForRegistryRow` in jobSources/providerRegistry.ts).
  { id: NULL_REGISTRY_PROVIDER_ID, tier: 3, requires: [], adapter: 'career-page' },
];

/**
 * Capability for a registry provider id. Null/undefined/'' (a
 * `CompanyCareerPage` row with no extracted provider) resolves to the tier-3
 * placeholder - never undefined, never a throw. Unlisted non-empty ids (wave
 * 4's future adapters) resolve to undefined.
 */
export function capabilityFor(
  provider: string | null | undefined,
): RegistryProviderCapability | undefined {
  if (provider === null || provider === undefined || provider === '') {
    return REGISTRY_PROVIDERS.find((p) => p.id === NULL_REGISTRY_PROVIDER_ID);
  }
  return REGISTRY_PROVIDERS.find((p) => p.id === provider);
}

/** Tier routing hint for a registry provider id. Null -> 3 (tier-3 page). */
export function tierForProvider(provider: string | null | undefined): number | undefined {
  return capabilityFor(provider)?.tier;
}

/**
 * Adapter-registry type (`PROVIDERS` entry) backing a registry provider id:
 * the explicit `adapter` column when set (breezyhr/pinpoint aliases, the
 * tier-3 'career-page' placeholder), else the single 'aggregator' adapter
 * for entries whose own `requires` data names 'aggregatorProvider'
 * (derived, not a second list), else the id itself (identity). Null,
 * undefined and '' (a `CompanyCareerPage` row with no extracted provider)
 * resolve to 'career-page'. Unlisted non-empty ids (deferred providers such
 * as rippling) resolve to null: "not yet routable", never an error signal.
 */
export function adapterTypeFor(provider: string | null | undefined): string | null {
  const cap = capabilityFor(provider);
  if (cap === undefined) return null;
  if (cap.adapter !== undefined) return cap.adapter;
  if (cap.requires.includes('aggregatorProvider')) return 'aggregator';
  return cap.id;
}
