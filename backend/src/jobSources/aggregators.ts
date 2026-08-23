// Official job-aggregator APIs (BYOK) - Adzuna, Careerjet, Jooble.
//
// Unlike scraping, these are official, stable endpoints that aggregate listings
// from LinkedIn/Indeed/ATS platforms natively. They offer permanent free tiers
// and need no anti-bot workarounds. The user supplies their own key in Settings
// (BYOK), so quota stays on them and the app is free to self-host at scale.
//
//   - Adzuna:     app_id + app_key (free 2,500 req/mo), global, structured JSON.
//   - Careerjet:  affiliate ID (free, 90+ countries), JSON/XML. Needs attribution.
//   - Jooble:     single API key (free via partner portal), JSON POST.
//
// All three are leased via the AIProviderKey table (provider names below) with
// env fallback (ADZUNA_APP_ID/ADZUNA_APP_KEY, CAREERJET_AFFID, JOOBLE_API_KEY).

import { leaseNextKey, markKeySuccess, markKeyFailure } from '../ai/keyManager.js';
import type { RawJob } from './index.js';

export type AggregatorProvider = 'adzuna' | 'careerjet' | 'jooble';

export interface AggregatorConfig {
  query: string;
  location?: string;
  resultsWanted?: number;
  userId?: string;
}

// ---------------------------------------------------------------------------
// Adzuna  (https://developer.adzuna.com/)
// Auth: APP_ID + APP_KEY as query params. Free tier: 2,500 req/mo, 250/day.
// Endpoint: GET /api/jobs/{country}/search/1?app_id=&app_key=&what=&where=&results=
// ---------------------------------------------------------------------------

async function fetchAdzuna(config: AggregatorConfig): Promise<RawJob[]> {
  // Adzuna needs two secrets; we store them as a single DB key "id:key" or via
  // env ADZUNA_APP_ID + ADZUNA_APP_KEY. Prefer env split, else parse DB key.
  const appId = process.env.ADZUNA_APP_ID || '';
  const appKey = process.env.ADZUNA_APP_KEY || '';
  let leasedKey = '';
  if (!appId || !appKey) {
    // DB key may hold "appId:appKey" combined
    const rec = await leaseNextKey('adzuna', config.userId);
    leasedKey = rec.apiKey;
  }
  const [id, key] = appId && appKey ? [appId, appKey] : leasedKey.split(':');

  if (!id || !key) {
    throw new Error('Adzuna requires APP_ID and APP_KEY. Set ADZUNA_APP_ID/ADZUNA_APP_KEY or store "appId:appKey" as an Adzuna key.');
  }

  // Country defaults to "us"; allow a country code via location prefix "us:" later.
  const country = 'us';
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`);
  url.searchParams.set('app_id', id);
  url.searchParams.set('app_key', key);
  url.searchParams.set('what', config.query);
  if (config.location) url.searchParams.set('where', config.location);
  url.searchParams.set('results', String(Math.min(config.resultsWanted ?? 20, 50)));
  url.searchParams.set('content-type', 'application/json');

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
  }));
}

// ---------------------------------------------------------------------------
// Careerjet  (https://www.careerjet.com/partners/)
// Auth: affiliate ID. Free basic key. Returns JSON (accept JSON header).
// Endpoint: GET https://www.careerjet.com/api/1.0?affid=&q=&location=&n=
// Requires an attribution link on results (free tier condition).
// ---------------------------------------------------------------------------

async function fetchCareerjet(config: AggregatorConfig): Promise<RawJob[]> {
  const affid = process.env.CAREERJET_AFFID || '';
  let leased = '';
  if (!affid) {
    const rec = await leaseNextKey('careerjet', config.userId);
    leased = rec.apiKey;
  }
  const id = affid || leased;
  if (!id) throw new Error('Careerjet requires an affiliate ID. Set CAREERJET_AFFID or store it as a Careerjet key.');

  const url = new URL('https://www.careerjet.com/api/1.0');
  url.searchParams.set('affid', id);
  url.searchParams.set('q', config.query);
  if (config.location) url.searchParams.set('location', config.location);
  url.searchParams.set('n', String(Math.min(config.resultsWanted ?? 20, 50)));

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Careerjet failed: ${res.status}`);
  const data: any = await res.json();
  const items: any[] = data.jobs || [];
  return items.map((j, i) => ({
    externalId: `careerjet-${j.jobid ?? i}`,
    source: 'careerjet',
    sourceUrl: j.url || '',
    title: j.title || 'Untitled Role',
    company: j.company || 'Unknown',
    location: j.locations || config.location || undefined,
    description: j.description || '',
    applyUrl: j.url || '',
    postedAt: j.date ? new Date(j.date) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Jooble  (https://jooble.org/api/)
// Auth: single API key. POST JSON to https://jooble.org/api/{key}
// Body: { keywords, location, page }
// ---------------------------------------------------------------------------

async function fetchJooble(config: AggregatorConfig): Promise<RawJob[]> {
  const envKey = process.env.JOOBLE_API_KEY || '';
  let key = envKey;
  if (!key) {
    const rec = await leaseNextKey('jooble', config.userId);
    key = rec.apiKey;
  }
  if (!key) throw new Error('Jooble requires an API key. Set JOOBLE_API_KEY or store it as a Jooble key.');

  const res = await fetch(`https://jooble.org/api/${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keywords: config.query,
      location: config.location || '',
      page: 1,
    }),
  });
  if (!res.ok) throw new Error(`Jooble failed: ${res.status}`);
  const data: any = await res.json();
  const items: any[] = data.jobs || [];
  return items.map((j, i) => ({
    externalId: `jooble-${j.id ?? i}`,
    source: 'jooble',
    sourceUrl: j.link || '',
    title: j.title || 'Untitled Role',
    company: j.company || 'Unknown',
    location: j.location || config.location || undefined,
    description: j.snippet || j.description || '',
    applyUrl: j.link || '',
    postedAt: j.updated ? new Date(j.updated) : undefined,
  }));
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function fetchAggregator(provider: AggregatorProvider, config: AggregatorConfig): Promise<RawJob[]> {
  const fn = provider === 'adzuna' ? fetchAdzuna : provider === 'careerjet' ? fetchCareerjet : fetchJooble;
  try {
    const jobs = await fn(config);
    // best-effort success marking (only works for DB keys)
    try {
      const rec = await leaseNextKey(provider, config.userId);
      await markKeySuccess(rec);
    } catch { /* env key - nothing to mark */ }
    return jobs;
  } catch (e) {
    try {
      const rec = await leaseNextKey(provider, config.userId);
      await markKeyFailure(rec, String((e as Error).message).includes('429'));
    } catch { /* env key */ }
    throw e;
  }
}
