// Tiered multi-source dedupe with source union (ADR-032 decisions 1-2, N12).
//
// Today a job that exists on three sources must appear ONCE, visibly, with
// all three named. The old single-key dedupe kept the first row per canonical
// key and silently destroyed the rest (provenance lost). This module replaces
// it with six ordered tiers plus source union:
//
//   T1 canonical URL ............ exact normalized URL (applyUrl || sourceUrl)
//   T2 provider + external id ... same `source` AND same `externalId`
//   T3 normalised URL ........... T1 loosened: scheme/www-insensitive, and
//                                 applyUrl <-> sourceUrl cross-compared
//   T4 content hash ............. title + company + description (no location)
//   T5 company+title+location ... PLUS a corroborating signal (never alone)
//   T6 fuzzy .................... constant-gated, OFF BY DEFAULT (N12)
//
// NON-NEGOTIABLE N12: title-alone merging is PROHIBITED. Every tier requires
// strictly more than a title: T1/T3 need a URL, T2 needs provider+id, T4
// needs company+description, T5 needs company+location+corroboration, T6
// needs same-company plus a token-overlap gate. There is no code path that
// merges two rows on title similarity alone.
//
// FIELD PRECEDENCE inside a group (pinned by tests; explicitly NOT
// "first wins", which is the behaviour being replaced):
//   1. title / company / location / description: the longest non-empty
//      trimmed value wins (the most informative copy); ties keep the
//      earliest row. Rationale: sources truncate differently, and the full
//      text is always more useful than the stub.
//   2. applyUrl: an apply URL whose normalized form equals the group's T1
//      identity wins (the canonical identity URL); else the first non-empty
//      applyUrl; else the first non-empty sourceUrl. Every URL is preserved
//      verbatim inside `sources[]` regardless of which one the survivor
//      carries.
//   3. postedAt / postedAtSource / postedAtRaw: kept together as a triple
//      from the first row that carries a defined postedAt (never mix a date
//      from one source with the provenance label of another).
//   4. externalId: first non-empty wins, else a deterministic content hash
//      (via `withDeterministicExternalId` on the merged row).
//   5. sources: union of every member's SourceRef in first-seen order,
//      de-duplicated on source||sourceUrl||applyUrl||externalId.
//   6. canonicalKey: stable hash of the group's STRONGEST identity present -
//      T1 if any member has a canonical URL, else T2, else T3, else T4 -
//      hashed with sha256 exactly like `jobExternalId` (`sha256-<hex>`).
//      The strongest-tier key is the lexicographically smallest member key,
//      so the value is independent of input order (stable across re-runs).
//
// This module is pure: no DB, no Prisma, no I/O, no clock, no network.
// Zero new dependencies.

import { createHash } from 'node:crypto';
import type { RawJob } from '../jobSources/adapters/http.js';
import {
  sanitizeRawJob,
  withDeterministicExternalId,
} from '../jobSources/jobIdentity.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One provenance entry for a surviving row: which source saw this listing. */
export interface SourceRef {
  source: string;
  sourceUrl?: string;
  applyUrl?: string;
  externalId?: string;
}

/** A RawJob with the additive dedupe output attached. */
export type DedupedJob = RawJob & {
  sources?: SourceRef[];
  canonicalKey?: string;
};

export interface DedupeOptions {
  /**
   * Enable the T6 fuzzy tier. Default off (see DEDUPE_FUZZY_ENABLED).
   * Fuzzy merging must always be an explicit opt-in.
   */
  enableFuzzy?: boolean;
}

/** T6 constant gate: fuzzy matching is OFF unless explicitly enabled. */
export const DEDUPE_FUZZY_ENABLED = false;

/** Minimum token-set Jaccard overlap for two titles to count as fuzzy-similar. */
export const FUZZY_TITLE_JACCARD_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Normalisation (same semantics as jobIdentity.ts, which owns the originals)
// ---------------------------------------------------------------------------

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeUrl(raw: unknown): string {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  try {
    const url = new URL(str);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    const cleaned = new URL(url.href);
    // Collect keys first: deleting during iteration skips entries.
    const keys: string[] = [];
    for (const [key] of cleaned.searchParams) keys.push(key);
    for (const key of keys) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) {
        cleaned.searchParams.delete(key);
      }
    }
    let result = cleaned.href;
    if (result.endsWith('/') && result.length > cleaned.origin.length + 1) {
      result = result.slice(0, -1);
    }
    return result;
  } catch {
    return normalizeText(str);
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function hostOf(raw: unknown): string {
  const str = String(raw ?? '').trim();
  if (!str) return '';
  try {
    return new URL(str).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Tier keys (exported for unit tests)
// ---------------------------------------------------------------------------

/** T1: exact canonical URL (applyUrl preferred, else sourceUrl). '' when none. */
export function canonicalUrlKey(
  job: Pick<RawJob, 'sourceUrl' | 'applyUrl'>,
): string {
  return normalizeUrl(job.applyUrl) || normalizeUrl(job.sourceUrl);
}

/** T2: provider + external id. '' unless BOTH are present. */
export function providerKey(
  job: Pick<RawJob, 'source' | 'externalId'>,
): string {
  const source = normalizeText(job.source);
  const externalId = String(job.externalId ?? '').trim();
  if (!source || !externalId) return '';
  return `${source}||${externalId}`;
}

/**
 * Loosen one URL for T3: scheme-insensitive, www-insensitive, trailing-slash
 * insensitive, tracking params and fragments already stripped by normalizeUrl.
 */
export function loosenUrl(raw: unknown): string {
  const normal = normalizeUrl(raw);
  if (!normal) return '';
  try {
    const url = new URL(normal);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let path = url.pathname.replace(/\/+$/, '');
    if (path === '/') path = '';
    return `${host}${path}${url.search}`.toLowerCase();
  } catch {
    return normalizeText(normal);
  }
}

/** T3 keys: loosened applyUrl and sourceUrl (cross-comparable). */
export function looseUrlKeys(
  job: Pick<RawJob, 'sourceUrl' | 'applyUrl'>,
): string[] {
  const keys = new Set<string>();
  for (const raw of [job.applyUrl, job.sourceUrl]) {
    const loose = loosenUrl(raw);
    if (loose) keys.add(loose);
  }
  return [...keys];
}

/**
 * T4: content hash over title + company + description (location excluded on
 * purpose: multi-city reposts of one role share content but differ in
 * location). '' unless title AND company are present - content without a
 * named company is not an identity.
 */
export function contentKey(
  job: Pick<RawJob, 'title' | 'company' | 'description'>,
): string {
  const title = normalizeText(job.title);
  const company = normalizeText(job.company);
  if (!title || !company) return '';
  return `content:${title}|${company}|${normalizeText(job.description)}`;
}

/**
 * T5 anchor: company + title + location. '' unless ALL THREE are present.
 * NEVER sufficient on its own - `hasCorroboration` must also hold.
 */
export function companyTitleLocationKey(
  job: Pick<RawJob, 'title' | 'company' | 'location'>,
): string {
  const company = normalizeText(job.company);
  const title = normalizeText(job.title);
  const location = normalizeText(job.location);
  if (!company || !title || !location) return '';
  return `${company}|${title}|${location}`;
}

/**
 * T5 corroborating signals: the two rows share a non-empty normalized
 * description, a URL host, or an external id. Company+title+location alone
 * is explicitly NOT enough (false negatives preferred over false merges).
 */
export function hasCorroboration(
  a: Pick<RawJob, 'description' | 'sourceUrl' | 'applyUrl' | 'externalId'>,
  b: Pick<RawJob, 'description' | 'sourceUrl' | 'applyUrl' | 'externalId'>,
): boolean {
  const descA = normalizeText(a.description);
  const descB = normalizeText(b.description);
  if (descA && descA === descB) return true;
  const hostsA = new Set(
    [hostOf(a.applyUrl), hostOf(a.sourceUrl)].filter(Boolean),
  );
  if (hostsA.size > 0) {
    for (const h of [hostOf(b.applyUrl), hostOf(b.sourceUrl)]) {
      if (h && hostsA.has(h)) return true;
    }
  }
  const idA = String(a.externalId ?? '').trim();
  const idB = String(b.externalId ?? '').trim();
  if (idA && idA === idB) return true;
  return false;
}

function titleTokens(title: unknown): Set<string> {
  const words = normalizeText(title).split(/[^a-z0-9]+/g).filter(Boolean);
  return new Set(words);
}

/**
 * T6 fuzzy predicate: same non-empty company AND title token-set Jaccard at
 * or above FUZZY_TITLE_JACCARD_THRESHOLD. Company equality is mandatory -
 * title similarity alone can never merge (N12).
 */
export function titlesFuzzilySimilar(
  a: Pick<RawJob, 'title' | 'company'>,
  b: Pick<RawJob, 'title' | 'company'>,
): boolean {
  const companyA = normalizeText(a.company);
  const companyB = normalizeText(b.company);
  if (!companyA || companyA !== companyB) return false;
  const tokensA = titleTokens(a.title);
  const tokensB = titleTokens(b.title);
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection += 1;
  }
  const union = tokensA.size + tokensB.size - intersection;
  if (union === 0) return false;
  return intersection / union >= FUZZY_TITLE_JACCARD_THRESHOLD;
}

// ---------------------------------------------------------------------------
// canonicalKey: stable hash of the group's strongest identity
// ---------------------------------------------------------------------------

/**
 * Stable group identity: T1 if any member has a canonical URL, else T2,
 * else T3, else T4. The lexicographically smallest member key wins so the
 * result is independent of input order. Format `sha256-<hex>`, matching
 * `jobExternalId`.
 */
export function groupCanonicalKey(members: RawJob[]): string {
  const pick = (keys: string[], prefix: string): string | null => {
    const nonEmpty = keys.filter(Boolean).sort();
    return nonEmpty.length > 0 ? `sha256-${sha256Hex(`${prefix}:${nonEmpty[0]}`)}` : null;
  };
  const t1 = pick(members.map(canonicalUrlKey), 'url');
  if (t1) return t1;
  const t2 = pick(members.map(providerKey), 'provider');
  if (t2) return t2;
  const t3 = pick(members.flatMap(looseUrlKeys), 'nurl');
  if (t3) return t3;
  const survivorContent = contentKey(members[0] ?? {});
  const fallback = survivorContent || 'empty';
  return `sha256-${sha256Hex(fallback)}`;
}

// ---------------------------------------------------------------------------
// Group merge (field precedence documented in the module header)
// ---------------------------------------------------------------------------

function longestNonEmpty(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const v of values) {
    const trimmed = typeof v === 'string' ? v.trim() : '';
    if (!trimmed) continue;
    if (best === undefined || trimmed.length > best.trim().length) {
      best = v;
    }
  }
  return best;
}

function toSourceRef(job: RawJob): SourceRef {
  const ref: SourceRef = { source: job.source };
  if (job.sourceUrl) ref.sourceUrl = job.sourceUrl;
  if (job.applyUrl) ref.applyUrl = job.applyUrl;
  if (job.externalId) ref.externalId = job.externalId;
  return ref;
}

function sourceRefKey(ref: SourceRef): string {
  return `${ref.source}||${ref.sourceUrl ?? ''}||${ref.applyUrl ?? ''}||${ref.externalId ?? ''}`;
}

function mergeGroup(members: RawJob[]): DedupedJob {
  const first = members[0];
  const survivor: RawJob = { ...first };

  const text = (pick: (j: RawJob) => string | undefined): string => {
    const won = longestNonEmpty(members.map(pick));
    return (won ?? pick(first) ?? '') as string;
  };
  survivor.title = text((j) => j.title);
  survivor.company = text((j) => j.company);
  if (members.some((m) => m.location != null)) {
    survivor.location = text((j) => j.location);
  }
  survivor.description = text((j) => j.description);

  // applyUrl: the member URL matching the group T1 identity wins; else the
  // first non-empty applyUrl; else the first non-empty sourceUrl.
  const groupT1Keys = new Set(members.map(canonicalUrlKey).filter(Boolean));
  const canonicalMember = members.find(
    (m) => m.applyUrl && groupT1Keys.has(normalizeUrl(m.applyUrl)),
  );
  const firstApply = members.find((m) => m.applyUrl);
  const firstSource = members.find((m) => m.sourceUrl);
  const chosenApply =
    canonicalMember?.applyUrl ?? firstApply?.applyUrl ?? firstSource?.sourceUrl;
  if (chosenApply !== undefined) {
    survivor.applyUrl = chosenApply;
  }

  // Date triple: kept together from the first row carrying a postedAt.
  const dated = members.find((m) => m.postedAt !== undefined);
  if (dated) {
    survivor.postedAt = dated.postedAt;
    survivor.postedAtSource = dated.postedAtSource;
    survivor.postedAtRaw = dated.postedAtRaw;
  } else {
    survivor.postedAt = first.postedAt;
    survivor.postedAtSource = first.postedAtSource;
    survivor.postedAtRaw = first.postedAtRaw;
  }

  // externalId: first non-empty wins, else deterministic content hash.
  const withId = members.find((m) => String(m.externalId ?? '').trim() !== '');
  const mergedBase: RawJob = {
    ...survivor,
    externalId: withId?.externalId,
  };
  const identified = withDeterministicExternalId(mergedBase);

  // Source union in first-seen order, de-duplicated.
  const seenRefs = new Set<string>();
  const sources: SourceRef[] = [];
  for (const m of members) {
    const ref = toSourceRef(m);
    const key = sourceRefKey(ref);
    if (!seenRefs.has(key)) {
      seenRefs.add(key);
      sources.push(ref);
    }
  }

  return {
    ...identified,
    sources,
    canonicalKey: groupCanonicalKey(members),
  };
}

// ---------------------------------------------------------------------------
// Tiered grouping (union-find; tiers applied in T1..T6 order)
// ---------------------------------------------------------------------------

function find(parent: number[], i: number): number {
  let root = i;
  while (parent[root] !== root) root = parent[root];
  // Path compression.
  let cur = i;
  while (parent[cur] !== root) {
    const next = parent[cur];
    parent[cur] = root;
    cur = next;
  }
  return root;
}

function union(
  parent: number[],
  rank: number[],
  a: number,
  b: number,
): void {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra === rb) return;
  if (rank[ra] < rank[rb]) {
    parent[ra] = rb;
  } else if (rank[ra] > rank[rb]) {
    parent[rb] = ra;
  } else {
    parent[rb] = ra;
    rank[ra] += 1;
  }
}

function unionByKey(parent: number[], rank: number[], keys: string[]): void {
  const byKey = new Map<string, number[]>();
  keys.forEach((key, index) => {
    if (!key) return;
    const list = byKey.get(key);
    if (list) list.push(index);
    else byKey.set(key, [index]);
  });
  for (const list of byKey.values()) {
    for (let i = 1; i < list.length; i += 1) {
      union(parent, rank, list[0], list[i]);
    }
  }
}

/**
 * Dedupe jobs across sources with source union.
 *
 * Keeps the exported name and `RawJob[]` return type so callers
 * (`routes/jobs.ts`, `routes/saved-searches.ts`, `routes/job-alerts.ts`)
 * are unchanged; the `sources: SourceRef[]` array and `canonicalKey` are
 * attached to each surviving row as additive optional fields.
 */
export function dedupeJobs(jobs: RawJob[], options?: DedupeOptions): DedupedJob[] {
  if (jobs.length === 0) return [];

  // Sanitize before keying so postings that differ only by
  // WIN1252-incompatible bytes still dedupe to one listing.
  const clean = jobs.map((job) => sanitizeRawJob(job));

  const parent = clean.map((_, i) => i);
  const rank = clean.map(() => 0);

  // T1 canonical URL (exact).
  unionByKey(parent, rank, clean.map(canonicalUrlKey));
  // T2 provider + external id.
  unionByKey(parent, rank, clean.map(providerKey));
  // T3 normalised URL (loosened, cross apply/source).
  {
    const byLoose = new Map<string, number[]>();
    clean.forEach((job, index) => {
      for (const key of looseUrlKeys(job)) {
        const list = byLoose.get(key);
        if (list) list.push(index);
        else byLoose.set(key, [index]);
      }
    });
    for (const list of byLoose.values()) {
      for (let i = 1; i < list.length; i += 1) {
        union(parent, rank, list[0], list[i]);
      }
    }
  }
  // T4 content hash.
  unionByKey(parent, rank, clean.map(contentKey));

  // T5 company+title+location PLUS corroboration (pairwise).
  for (let i = 0; i < clean.length; i += 1) {
    const keyI = companyTitleLocationKey(clean[i]);
    if (!keyI) continue;
    for (let j = i + 1; j < clean.length; j += 1) {
      if (find(parent, i) === find(parent, j)) continue;
      if (companyTitleLocationKey(clean[j]) !== keyI) continue;
      if (hasCorroboration(clean[i], clean[j])) {
        union(parent, rank, i, j);
      }
    }
  }

  // T6 fuzzy: constant-gated, OFF BY DEFAULT.
  const fuzzyEnabled = options?.enableFuzzy ?? DEDUPE_FUZZY_ENABLED;
  if (fuzzyEnabled) {
    for (let i = 0; i < clean.length; i += 1) {
      for (let j = i + 1; j < clean.length; j += 1) {
        if (find(parent, i) === find(parent, j)) continue;
        if (titlesFuzzilySimilar(clean[i], clean[j])) {
          union(parent, rank, i, j);
        }
      }
    }
  }

  // Collect groups in first-seen order (stable output).
  const groups = new Map<number, RawJob[]>();
  clean.forEach((job, index) => {
    const root = find(parent, index);
    const list = groups.get(root);
    if (list) list.push(job);
    else groups.set(root, [job]);
  });

  return [...groups.values()].map(mergeGroup);
}
