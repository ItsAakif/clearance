// Official job-aggregator APIs (BYOK) - Adzuna, USAJobs, Reed, Findwork.
//
// Unlike scraping, these are official, stable endpoints that aggregate listings
// from LinkedIn/Indeed/ATS platforms natively. They offer permanent free tiers
// and need no anti-bot workarounds. The user supplies their own key in Settings
// (BYOK), so quota stays on them and the app is free to self-host at scale.
//
//   - Adzuna:     app_id + app_key (free 2,500 req/mo), global, structured JSON.
//   - USAJobs:    email + API key (fully free, no paid tier), US federal.
//   - Reed:      single API key via Basic auth, UK, 100 results/request.
//   - Findwork:  single token, dev/design aggregator.
//
// All four are leased via the AIProviderKey table (provider names below) with
// env fallback (ADZUNA_APP_ID/ADZUNA_APP_KEY, USAJOBS_EMAIL/USAJOBS_API_KEY,
// REED_API_KEY, FINDWORK_API_KEY).

import { leaseNextKey, markKeySuccess, markKeyFailure } from '../ai/keyManager.js';
import type { KeyRecord } from '../ai/keyManager.js';
import type { RawJob } from './index.js';
import { fetchUsaJobs } from './aggregators.usajobs.js';
import { fetchReed } from './aggregators.reed.js';
import { fetchFindwork } from './aggregators.findwork.js';

// Runtime board set. Adzuna is unchanged; careerjet/jooble were retired (see
// .planning/decisions/ADR-006) because their keys need partner/publisher approval.
export const AGGREGATOR_PROVIDERS = ['adzuna', 'usajobs', 'reed', 'findwork'] as const;
export type AggregatorProvider = (typeof AGGREGATOR_PROVIDERS)[number];

// Retired providers. Kept as data (not deleted) so dispatch can explain itself and so
// stored keys/boards stay identifiable. No key or board row is ever deleted for these.
export const DEPRECATED_AGGREGATOR_PROVIDERS = ['careerjet', 'jooble'] as const;

export function isAggregatorProvider(value: string | null | undefined): value is AggregatorProvider {
  return !!value && (AGGREGATOR_PROVIDERS as readonly string[]).includes(value);
}

export function isDeprecatedAggregatorProvider(value: string | null | undefined): boolean {
  return !!value && (DEPRECATED_AGGREGATOR_PROVIDERS as readonly string[]).includes(value);
}

export interface AggregatorConfig {
  query: string;
  location?: string;
  resultsWanted?: number;
  userId?: string;
}

// D3: slot for a fetcher to hand back the exact DB KeyRecord it leased, so
// fetchAggregator marks success/failure on the SAME row. A second
// leaseNextKey call would rotate (keyManager.ts) and could attribute the
// outcome (incl. 429 cooldown) to a different key.
export interface AggregatorKeySlot {
  record?: KeyRecord | null;
}

// ---------------------------------------------------------------------------
// Adzuna  (https://developer.adzuna.com/)
// Auth: APP_ID + APP_KEY as query params. Free tier: 2,500 req/mo, 250/day.
// Endpoint: GET /api/jobs/{country}/search/1?app_id=&app_key=&what=&where=&results=
// ---------------------------------------------------------------------------

// Country defaults to "us". A "<cc>:" prefix on the location (e.g. "in:",
// "gb:") overrides it and is stripped from the query location; otherwise
// common location strings are mapped (India, UK, ...); default 'us'.
export function resolveAdzunaCountry(location?: string): { country: string; location?: string } {
  if (location) {
    const prefix = location.match(/^\s*([a-z]{2})\s*:\s*(.*)$/i);
    if (prefix) {
      const cc = prefix[1].toLowerCase();
      const rest = prefix[2].trim();
      return { country: cc, location: rest || undefined };
    }
    const lower = location.toLowerCase();
    const has = (...terms: string[]) => terms.some((t) => lower.includes(t));
    if (has('india', 'bengaluru', 'bangalore', 'mumbai', 'delhi', 'hyderabad', 'chennai', 'pune', 'kolkata')) {
      return { country: 'in', location };
    }
    if (has('united kingdom', 'great britain', 'england', 'scotland', 'wales', 'london', 'manchester', 'birmingham') || /\buk\b/.test(lower)) {
      return { country: 'gb', location };
    }
    if (has('canada', 'toronto', 'vancouver', 'montreal')) return { country: 'ca', location };
    if (has('australia', 'sydney', 'melbourne', 'brisbane')) return { country: 'au', location };
    if (has('germany', 'berlin', 'munich', 'deutschland')) return { country: 'de', location };
    if (has('france', 'paris')) return { country: 'fr', location };
  }
  return { country: 'us', location };
}

/** Build the Adzuna search URL (exported for tests). Caller sets credentials. */
export function buildAdzunaUrl(
  config: AggregatorConfig,
  creds: { appId: string; appKey: string },
): string {
  const { country, location } = resolveAdzunaCountry(config.location);
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
  url.searchParams.set('app_id', creds.appId);
  url.searchParams.set('app_key', creds.appKey);
  url.searchParams.set('what', config.query);
  if (location) url.searchParams.set('where', location);
  url.searchParams.set('results', String(Math.min(config.resultsWanted ?? 20, 50)));
  url.searchParams.set('content-type', 'application/json');
  return url.toString();
}

async function fetchAdzuna(config: AggregatorConfig, slot?: AggregatorKeySlot): Promise<RawJob[]> {
  // Adzuna needs two secrets; we store them as a single DB key "id:key" or via
  // env ADZUNA_APP_ID + ADZUNA_APP_KEY. Prefer env split, else parse DB key.
  const appId = process.env.ADZUNA_APP_ID || '';
  const appKey = process.env.ADZUNA_APP_KEY || '';
  let leasedKey = '';
  if (!appId || !appKey) {
    // DB key may hold "appId:appKey" combined
    const rec = await leaseNextKey('adzuna', config.userId);
    if (slot) slot.record = rec;
    leasedKey = rec.apiKey;
  }
  // Merge env halves with the leased halves so a partial env plus a stored key
  // still works. A stored key without a colon is treated as the app id with a
  // missing app key (clear error below, surfaced via source health, no crash).
  const leasedParts = leasedKey ? leasedKey.split(':') : [];
  const id = (appId || (leasedParts[0] ?? '')).trim();
  const key = (appKey || leasedParts.slice(1).join(':')).trim();

  if (!id || !key) {
    throw new Error('Adzuna requires APP_ID and APP_KEY. Set ADZUNA_APP_ID/ADZUNA_APP_KEY or store "appId:appKey" as an Adzuna key.');
  }

  // Country derived from the passed location (prefix "<cc>:" or known names).
  const url = new URL(buildAdzunaUrl(config, { appId: id, appKey: key }));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Adzuna failed: ${res.status}`);
  const data: any = await res.json();
  const items: any[] = data.results || [];
  return items.map((j, i) => ({
    externalId: `adzuna-${j.id ?? i}`,
    source: 'adzuna',
    sourceUrl: j.redirect_url || j.url || '',
    title: j.title || 'Untitled Role',
    company: j.company?.display_name || j.company || 'Unknown',
    location: j.location?.display_name || config.location || undefined,
    description: j.description || '',
    applyUrl: j.redirect_url || j.url || '',
    postedAt: j.created ? new Date(j.created) : undefined,
    // Wave 3 (T662, ADR-028): Adzuna `created` is an explicit posted claim ->
    // `source-posted`.
    postedAtSource: j.created ? ('source-posted' as const) : undefined,
    postedAtRaw: j.created ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

const AGGREGATOR_FETCHERS: Record<AggregatorProvider, (c: AggregatorConfig, slot?: AggregatorKeySlot) => Promise<RawJob[]>> = {
  adzuna: fetchAdzuna,
  usajobs: fetchUsaJobs,
  reed: fetchReed,
  findwork: fetchFindwork,
};

export async function fetchAggregator(provider: string, config: AggregatorConfig): Promise<RawJob[]> {
  if (isDeprecatedAggregatorProvider(provider)) {
    throw new Error(
      `Aggregator "${provider}" is no longer supported. Update or delete this board in Settings.`
    );
  }
  if (!isAggregatorProvider(provider)) {
    throw new Error(
      `Unknown aggregator "${provider}". Supported: ${AGGREGATOR_PROVIDERS.join(', ')}.`
    );
  }
  const fn = AGGREGATOR_FETCHERS[provider];
  const slot: AggregatorKeySlot = {};
  try {
    const jobs = await fn(config, slot);
    // Best-effort success marking on the SAME key the fetch leased. No second
    // leaseNextKey here: rotation could land on a different row. Env-key
    // fetches leave slot.record unset (nothing to mark) - also no lease.
    if (slot.record) {
      try {
        await markKeySuccess(slot.record);
      } catch { /* marking must never fail the fetch */ }
    }
    return jobs;
  } catch (e) {
    if (slot.record) {
      try {
        await markKeyFailure(slot.record, String((e as Error).message).includes('429'));
      } catch { /* marking must never fail the fetch */ }
    }
    throw e;
  }
}
