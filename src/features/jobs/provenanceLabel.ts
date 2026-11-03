// Pure provenance helpers (Wave 10, T800, ADR-031 decision 3).
//
// `JobCard` / `JobDetailPanel` (T803) stay thin and call into here. Pure: no
// React, no network, no clock.
//
// LABEL RULE mirrors `dateLabel` in `backend/src/discovery/provenance.ts`
// (T661, lines 160-170) with one deliberate frontend divergence, required by
// the wave-10 spec edge case: the backend maps every null-date class to
// `Found`, but the UI shows NO label for `unknown` (returns null) rather than
// a claim it cannot back. The N4 null invariant holds in both: an index-date
// row is NEVER `Posted` (it is `Found`).
//
// SOURCE ORDER comes from the generated contract
// (`shared/job-sources.json`, T624/T625) - never a local constant. Unknown
// ids (not in the contract) trail in first-seen order so nothing is dropped.

import sourceContract from '../../../shared/job-sources.json';

/** Contract order of source ids; the single vocabulary for badge ordering. */
const CONTRACT_SOURCE_ORDER: readonly string[] = sourceContract.sources;

export type JobSourceEntry = string | { source: string };

/** Minimal job shape the helpers read (both legacy and provenance rows). */
export interface ProvenanceJobLike {
  source: string;
  sources?: readonly JobSourceEntry[] | null;
  postedAtSource?: string | null;
}

function entrySourceId(entry: JobSourceEntry): string {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object' && typeof entry.source === 'string') {
    return entry.source.trim();
  }
  return '';
}

/**
 * Every source id for the row, deduped case-insensitively (first-seen
 * casing kept) in deterministic order: contract order first, unknown ids
 * appended in first-seen order. Falls back to the row's own `source` when
 * no usable `sources[]` is present, and always unions it in (N11: a merged
 * row names all sources).
 */
export function sourceBadges(job: ProvenanceJobLike): string[] {
  const source: ProvenanceJobLike = job ?? { source: '' };
  const seen = new Map<string, string>();
  const add = (raw: string): void => {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  };
  const extras = source.sources;
  if (Array.isArray(extras)) {
    for (const entry of extras) add(entrySourceId(entry));
  }
  add(typeof source.source === 'string' ? source.source : '');
  const rank = new Map<string, number>();
  CONTRACT_SOURCE_ORDER.forEach((id, index) => {
    if (typeof id === 'string' && !rank.has(id.toLowerCase())) rank.set(id.toLowerCase(), index);
  });
  const known: string[] = [];
  const unknown: string[] = [];
  for (const [key, original] of seen) {
    if (rank.has(key)) known.push(original);
    else unknown.push(original);
  }
  known.sort((a, b) => {
    const ra = rank.get(a.toLowerCase()) ?? 0;
    const rb = rank.get(b.toLowerCase()) ?? 0;
    return ra - rb;
  });
  return [...known, ...unknown];
}

/**
 * Date label for the row: `Posted` for posted-date claims, `Updated` for
 * update-only claims, `Found` for discovery/index signals - and null (no
 * label) for `unknown`, missing, or unrecognised provenance, never `Posted`.
 */
export function dateLabelFor(
  job: Pick<ProvenanceJobLike, 'postedAtSource'>,
): 'Posted' | 'Updated' | 'Found' | null {
  switch (job?.postedAtSource) {
    case 'source-posted':
    case 'page-derived':
      return 'Posted';
    case 'source-updated':
      return 'Updated';
    case 'discovery-at':
    case 'index-date':
      return 'Found';
    default:
      return null;
  }
}
