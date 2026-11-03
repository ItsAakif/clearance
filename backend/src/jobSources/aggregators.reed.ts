// Reed.co.uk Jobseeker API (https://www.reed.co.uk/developers/jobseeker).
// Auth: HTTP Basic with the API key as the username and an empty password.
// Endpoint: GET https://www.reed.co.uk/api/1.0/search?keywords=&locationName=&resultsToTake=

import { leaseNextKey } from '../ai/keyManager.js';
import type { AggregatorConfig, AggregatorKeySlot } from './aggregators.js';
import type { RawJob } from './index.js';

/** Build the Reed search URL + auth headers (exported for tests). Needs the key. */
export function buildReedSearchUrl(
  config: AggregatorConfig,
  creds: { apiKey: string }
): { url: string; headers: Record<string, string> } {
  const url = new URL('https://www.reed.co.uk/api/1.0/search');
  if (config.query) url.searchParams.set('keywords', config.query);
  if (config.location) url.searchParams.set('locationName', config.location);
  url.searchParams.set('resultsToTake', String(Math.min(config.resultsWanted ?? 20, 50)));
  const headers = {
    Authorization: `Basic ${Buffer.from(`${creds.apiKey}:`, 'utf8').toString('base64')}`,
  };
  return { url: url.toString(), headers };
}

export async function fetchReed(config: AggregatorConfig, slot?: AggregatorKeySlot): Promise<RawJob[]> {
  let key = process.env.REED_API_KEY || '';
  if (!key) {
    try {
      const rec = await leaseNextKey('reed', config.userId);
      if (slot) slot.record = rec;
      key = rec.apiKey || '';
    } catch {
      key = '';
    }
  }
  if (!key) {
    throw new Error('Reed requires an API key. Set REED_API_KEY or store it as a Reed key.');
  }

  const { url, headers } = buildReedSearchUrl(config, { apiKey: key });
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Reed failed: ${res.status}`);
  const data: any = await res.json();
  const items: any[] = data?.results ?? [];
  return items.map((j) => ({
    externalId: `reed-${String(j.jobId)}`,
    source: 'reed',
    title: j.jobTitle || 'Untitled Role',
    company: j.employerName || 'Unknown',
    location: j.locationName || config.location,
    description: j.description || '',
    applyUrl: `https://www.reed.co.uk/jobs/${j.jobId}`,
    sourceUrl: `https://www.reed.co.uk/jobs/${j.jobId}`,
    postedAt: undefined,
  }));
}
