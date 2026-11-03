// Source-group vocabulary resolved from the generated contract (Wave 10,
// T801, ADR-031 decision 1).
//
// The toggle list and every group membership come from
// `shared/job-sources.json` (T624/T625) - never a local array. The contract
// carries no `groups` map (the emitter is wave-1 owned and this task must not
// touch the backend), so provider -> group is a documented mapping over the
// contract's own `providers[].kind`/`type` fields, pinned field-for-field to
// the backend's `SOURCE_ID_TO_GROUP` in
// `backend/src/discovery/searchIntent.ts` (T740), lines 118-146. If the
// registry gains a kind this rule does not know, the affected ids resolve to
// NO group (they stay individually toggleable through the per-source boxes,
// which render `contract.sources` directly) and the parity test below fails
// loudly instead of silently mis-grouping.
//
// Pure: no React, no network, no clock. The group NAMES (`ats`, `feeds`, ...)
// are the backend-validated intent vocabulary (`sourceGroupEnum`, same file,
// line 105) mirrored the way `JobSort` mirrors its backend union - they appear
// only as mapping outputs and a type union, never as a hand-maintained list.

import sourceContract from '../../../shared/job-sources.json';

/** Intent source-group vocabulary. Mirrors backend `SourceGroup` (T740). */
export type SourceGroup =
  | 'ats'
  | 'feeds'
  | 'aggregators'
  | 'search'
  | 'dorking'
  | 'scraper'
  | 'browser';

/** The N2 opt-in tier: valid, never a default, always toggleable. */
export const BROWSER_GROUP: SourceGroup = 'browser';

interface ContractProviderLike {
  type: string;
  kind: string;
  sourceIds: readonly string[];
}

/**
 * Provider -> group over the contract's own fields. `kind` carries the
 * family; the `search` kind splits on `type` because the registry runs both
 * the web-search provider and the dorking provider through it (see the
 * contract: provider `search` vs provider `dorking`). Unknown kinds yield
 * null (no group) so a registry addition can never silently mis-group.
 */
export function groupForContractProvider(kind: string, type: string): SourceGroup | null {
  switch (kind) {
    case 'api':
      return 'ats';
    case 'feed':
    case 'json':
      return 'feeds';
    case 'aggregator':
      return 'aggregators';
    case 'search':
      return type === 'dorking' ? 'dorking' : 'search';
    case 'scraper':
      return 'scraper';
    case 'browser':
      return 'browser';
    default:
      return null;
  }
}

function contractProviders(): ContractProviderLike[] {
  const providers = (sourceContract as { providers?: unknown }).providers;
  if (!Array.isArray(providers)) return [];
  const out: ContractProviderLike[] = [];
  for (const p of providers) {
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    if (typeof rec.type !== 'string' || typeof rec.kind !== 'string') continue;
    if (!Array.isArray(rec.sourceIds)) continue;
    out.push({
      type: rec.type,
      kind: rec.kind,
      sourceIds: rec.sourceIds.filter((id): id is string => typeof id === 'string'),
    });
  }
  return out;
}

function contractSourceIds(): string[] {
  const sources = (sourceContract as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  return sources.filter((id): id is string => typeof id === 'string');
}

export interface ResolvedSourceGroups {
  /** Groups in first-seen order over the contract's `sources` list. */
  groups: SourceGroup[];
  /** Canonical member source ids per group, in contract `sources` order. */
  members: Record<SourceGroup, string[]>;
  /** Canonical ids no provider rule claimed (individually toggleable). */
  ungrouped: string[];
}

/**
 * Resolve the toggle list + membership from the contract. Each canonical id
 * is claimed by its OWNING provider (the provider whose `type` equals the
 * id) so shared ids follow their primary family - e.g. `jobicy` is listed
 * under both the `json` and `jobicy` providers but resolves to `ats` via its
 * owner, matching the backend table. Ids with no owner fall back to the
 * first provider listing them; ids no rule claims land in `ungrouped`.
 */
export function resolveSourceGroups(): ResolvedSourceGroups {
  const providers = contractProviders();
  const ownerByType = new Map<string, ContractProviderLike>();
  for (const p of providers) {
    if (!ownerByType.has(p.type)) ownerByType.set(p.type, p);
  }
  const emptyMembers = (): Record<SourceGroup, string[]> => ({
    ats: [],
    feeds: [],
    aggregators: [],
    search: [],
    dorking: [],
    scraper: [],
    browser: [],
  });
  const members = emptyMembers();
  const seenGroups: SourceGroup[] = [];
  const ungrouped: string[] = [];
  for (const id of contractSourceIds()) {
    const owner =
      ownerByType.get(id) ?? providers.find((p) => p.sourceIds.includes(id));
    const group = owner ? groupForContractProvider(owner.kind, owner.type) : null;
    if (!group) {
      ungrouped.push(id);
      continue;
    }
    if (!seenGroups.includes(group)) seenGroups.push(group);
    members[group].push(id);
  }
  return { groups: seenGroups, members, ungrouped };
}

const RESOLVED = resolveSourceGroups();

/** Toggle list for the filter sheet, derived from the generated contract. */
export const SOURCE_GROUPS: readonly SourceGroup[] = RESOLVED.groups;

/** Canonical member source ids per group, derived from the contract. */
export const SOURCE_GROUP_MEMBERS: Readonly<Record<SourceGroup, readonly string[]>> =
  RESOLVED.members;

/** Narrow unknown filter state back to the known vocabulary (dedupe, contract order). */
export function cleanSourceGroups(values: readonly string[] | undefined): SourceGroup[] {
  if (!Array.isArray(values)) return [];
  const out: SourceGroup[] = [];
  for (const group of SOURCE_GROUPS) {
    if (values.includes(group) && !out.includes(group)) out.push(group);
  }
  return out;
}

/**
 * A group toggle edits a SET of source ids (the legacy `sources` filter):
 * on unions the members in, off subtracts them out. Existing order is kept;
 * newly added members append in contract order.
 */
export function toggleSourceGroup(
  sources: readonly string[],
  members: readonly string[],
  on: boolean,
): string[] {
  const current = Array.isArray(sources) ? [...sources] : [];
  if (on) {
    for (const id of members) {
      if (!current.includes(id)) current.push(id);
    }
    return current;
  }
  const drop = new Set(members);
  return current.filter((id) => !drop.has(id));
}

/** Groups fully covered by the current `sources` selection. */
export function selectedSourceGroups(
  sources: readonly string[],
  members: Readonly<Record<SourceGroup, readonly string[]>>,
): SourceGroup[] {
  const current = Array.isArray(sources) ? sources : [];
  return (SOURCE_GROUPS as readonly SourceGroup[]).filter((group) => {
    const ids = members[group] ?? [];
    return ids.length > 0 && ids.every((id) => current.includes(id));
  });
}

/** Tri-state for the group checkbox: full coverage, partial, or none. */
export function groupCheckState(
  sources: readonly string[],
  members: readonly string[],
): boolean | 'indeterminate' {
  const current = Array.isArray(sources) ? sources : [];
  if (members.length === 0) return false;
  const hit = members.filter((id) => current.includes(id)).length;
  if (hit === 0) return false;
  if (hit === members.length) return true;
  return 'indeterminate';
}
