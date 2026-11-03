// Findwork (https://findwork.dev/developers/) - dev/design aggregator.
// Auth: token-based. Public write-ups disagree on the scheme (Token vs
// Bearer), so the first attempt uses `Token` and a 401/403 retries once
// with `Bearer`. Endpoint: GET https://findwork.dev/api/jobs/?search=&location=

import { leaseNextKey } from '../ai/keyManager.js';
import type { AggregatorConfig, AggregatorKeySlot } from './aggregators.js';
import type { RawJob } from './index.js';

/** Build the Findwork search URL (exported for tests). No ordering param sent. */
export function buildFindworkUrl(config: AggregatorConfig): string {
  const url = new URL('https://findwork.dev/api/jobs/');
  if (config.query) url.searchParams.set('search', config.query);
  if (config.location) url.searchParams.set('location', config.location);
  return url.toString();
}

export async function fetchFindwork(config: AggregatorConfig, slot?: AggregatorKeySlot): Promise<RawJob[]> {
  let key = process.env.FINDWORK_API_KEY || '';
  if (!key) {
    try {
      const rec = await leaseNextKey('findwork', config.userId);
      if (slot) slot.record = rec;
      key = rec.apiKey || '';
    } catch {
      key = '';
    }
  }
  if (!key) {
    throw new Error('Findwork requires an API key. Set FINDWORK_API_KEY or store it as a Findwork key.');
  }

  const url = buildFindworkUrl(config);
  async function requestWith(scheme: 'Token' | 'Bearer'): Promise<Response> {
    return fetch(url, {
      headers: { Authorization: `${scheme} ${key}`, Accept: 'application/json' },
    });
  }

  let res = await requestWith('Token');
  if (res.status === 401 || res.status === 403) {
    res = await requestWith('Bearer');
  }
  if (!res.ok) throw new Error(`Findwork failed: ${res.status}`);
  const data: any = await res.json();
  const items: any[] = Array.isArray(data) ? data : (data?.results ?? data?.jobs ?? []);
  const jobs: RawJob[] = items.map((j: any, i: number) => {
    const id = j?.id ?? j?.slug ?? j?.url;
    let postedAt: Date | undefined;
    if (j?.date_posted) {
      const date = new Date(j.date_posted);
      if (Number.isFinite(date.getTime())) postedAt = date;
    }
    return {
      externalId: `findwork-${String(id ?? i)}`,
      source: 'findwork',
      title: j?.role || j?.title || j?.position || 'Untitled Role',
      company: j?.company_name || j?.company || 'Unknown',
      location: j?.location || (j?.remote === true ? 'Remote' : undefined),
      description: j?.text || j?.description || '',
      applyUrl: j?.url || j?.apply_url || '',
      sourceUrl: j?.url || j?.apply_url || '',
      postedAt,
      // Wave 3 (T662, ADR-028): `date_posted` is an explicit posted claim ->
      // `source-posted`.
      postedAtSource: j?.date_posted ? ('source-posted' as const) : undefined,
      postedAtRaw: j?.date_posted ?? undefined,
    };
  });
  if (jobs.some((j) => j.postedAt)) {
    jobs.sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0));
  }
  return jobs;
}
