// Search API integration for job discovery (like career-ops websearch).
// Preference: Tavily (BYOK) when a key is configured; otherwise a KEYLESS
// DuckDuckGo HTML scrape so job discovery works with zero paid API keys.
// This keeps the app fully free / self-hostable out of the box.

import { leaseNextSearchKey, hasSearchKey, type KeyRecord } from '../ai/keyManager.js';
import type { RawJob } from './index.js';

export interface SearchConfig {
  query: string;       // e.g. '"Software Engineer" OR "Backend" remote'
  site?: string;       // e.g. "jobs.ashbyhq.com" - optional site: filter
  maxResults?: number; // default 10
}

/**
 * Search for jobs. Uses Tavily if a key is configured, else falls back to the
 * keyless Arbeitnow API so job discovery works with zero paid API keys.
 */
export async function searchJobs(config: SearchConfig, userId?: string): Promise<RawJob[]> {
  const hasKey = await hasSearchKey(userId).catch(() => false);
  if (hasKey) {
    try {
      return await searchJobsWithKey(config, userId);
    } catch {
      // Fall through to keyless on search-provider failure (expired key, rate limit).
    }
  }
  return searchJobsKeyless(config);
}

async function searchJobsWithKey(config: SearchConfig, userId?: string): Promise<RawJob[]> {
  const key: KeyRecord = await leaseNextSearchKey(userId);
  if (key.provider === 'exa') {
    return searchJobsExa(config, key.apiKey);
  }
  return searchJobsTavily(config, key.apiKey);
}

async function searchJobsTavily(config: SearchConfig, apiKey: string): Promise<RawJob[]> {
  let q = config.query;
  if (config.site) {
    // Tavily supports `site:` operator in the query string
    q = `site:${config.site} ${q}`;
  }

  const url = `https://api.tavily.com/search?api_key=${encodeURIComponent(apiKey)}` +
    `&query=${encodeURIComponent(q)}` +
    `&max_results=${config.maxResults || 10}` +
    `&search_depth=basic&include_raw_content=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status}`);
  }

  const data: any = await res.json();
  const results: any[] = data.results || [];

  return results
    .filter((r) => r.url && r.title)
    .map((r, i) => ({
      externalId: `tavily-${i}-${Buffer.from(r.url).toString('base64').slice(0, 16)}`,
      source: 'search',
      sourceUrl: r.url,
      title: r.title || 'Untitled Role',
      company: extractCompanyFromUrl(r.url) || extractCompanyFromTitle(r.title) || 'Unknown',
      location: extractLocation(r.content || ''),
      description: r.content || r.raw_content || '',
      applyUrl: r.url,
      postedAt: r.published_date ? new Date(r.published_date) : undefined,
    }));
}

async function searchJobsExa(config: SearchConfig, apiKey: string): Promise<RawJob[]> {
  let q = config.query;
  if (config.site) {
    // Exa supports the `site:` operator in the query string
    q = `site:${config.site} ${q}`;
  }

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: q,
      numResults: config.maxResults || 10,
      contents: { text: true, livecrawl: 'preferred' },
    }),
  });
  if (!res.ok) {
    throw new Error(`Exa search failed: ${res.status}`);
  }

  const data: any = await res.json();
  const results: any[] = data.results || [];

  return results
    .filter((r) => r.url && r.title)
    .map((r, i) => ({
      externalId: `exa-${i}-${Buffer.from(r.url).toString('base64').slice(0, 16)}`,
      source: 'search',
      sourceUrl: r.url,
      title: r.title || 'Untitled Role',
      company: extractCompanyFromUrl(r.url) || extractCompanyFromTitle(r.title) || 'Unknown',
      location: extractLocation(r.text || ''),
      description: r.text || r.summary || '',
      applyUrl: r.url,
      postedAt: r.publishedDate ? new Date(r.publishedDate) : undefined,
    }));
}

/**
 * Keyless job discovery fallback when no Tavily key is configured.
 * Uses Arbeitnow's free, no-key Job Board API (ATS-aggregated postings).
 * Reliable and zero-cost so the app stays free out of the box. Less targeted
 * than a keyword search (returns the latest board postings), but sufficient to
 * surface live roles without any paid dependency.
 */
async function searchJobsKeyless(config: SearchConfig): Promise<RawJob[]> {
  const url = 'https://www.arbeitnow.com/api/job-board-api';
  const res = await fetch(url, { headers: { 'User-Agent': 'ClearanceJobBot/1.0' } });
  if (!res.ok) throw new Error(`Arbeitnow search failed: ${res.status}`);
  const data: any = await res.json();
  const items: any[] = Array.isArray(data?.data) ? data.data : [];
  if (items.length === 0) return [];

  const q = (config.query || '').toLowerCase();
  const filtered = q
    ? items.filter((j) =>
        `${j.title || ''} ${j.company_name || ''} ${j.tags ? j.tags.join(' ') : ''}`.toLowerCase().includes(q.split('"')[0].split(' OR ')[0].trim())
      )
    : items;

  const limit = config.maxResults || 10;
  return filtered.slice(0, limit).map((j, i) => ({
    externalId: `arbeitnow-${j.id ?? i}-${Buffer.from(String(j.url || j.id)).toString('base64').slice(0, 12)}`,
    source: 'search',
    sourceUrl: j.url || '',
    title: j.title || 'Untitled Role',
    company: j.company_name || 'Unknown',
    location: j.location || (Array.isArray(j.tags) ? undefined : undefined),
    description: j.description || '',
    applyUrl: j.url || '',
    postedAt: j.created_at ? new Date(j.created_at) : undefined,
  }));
}

function extractCompanyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    // Known job board hosts
    const known: Record<string, string> = {
      'jobs.ashbyhq.com': parsed.pathname.split('/')[1] || 'Ashby',
      'job-boards.greenhouse.io': parsed.pathname.split('/')[1] || 'Greenhouse',
      'boards.greenhouse.io': parsed.pathname.split('/')[1] || 'Greenhouse',
      'jobs.lever.co': parsed.pathname.split('/')[1] || 'Lever',
      'apply.workable.com': parsed.pathname.split('/')[1] || 'Workable',
    };
    if (known[host]) return known[host];
    // Generic: use subdomain or domain name
    const parts = host.split('.');
    if (parts.length >= 2) {
      return parts[parts.length - 2].charAt(0).toUpperCase() + parts[parts.length - 2].slice(1);
    }
    return host;
  } catch {
    return null;
  }
}

function extractCompanyFromTitle(title: string): string | null {
  // "Software Engineer at Acme Corp" → "Acme Corp"
  const match = title.match(/\bat\s+([A-Z][\w&.,\s]+?)(?:\s*(?:–|-|\|)|$)/);
  return match ? match[1].trim() : null;
}

function extractLocation(text: string): string | undefined {
  // Simple heuristics: look for "Location: X" or "Remote" / city patterns
  const remoteMatch = text.match(/\b(remote|work from home|wfh)\b/i);
  if (remoteMatch) return 'Remote';
  const locMatch = text.match(/(?:location|based in|located in)[:\s]+([A-Z][\w\s,]+?)(?:\.|\n|$)/i);
  return locMatch ? locMatch[1].trim() : undefined;
}