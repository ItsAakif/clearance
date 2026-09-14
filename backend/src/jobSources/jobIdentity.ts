import { createHash } from 'node:crypto';
import type { RawJob } from './index.js';

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

function buildCanonical(job: Pick<RawJob, 'title' | 'company' | 'location' | 'description' | 'sourceUrl' | 'applyUrl'>): string {
  const applyUrl = normalizeUrl(job.applyUrl);
  const sourceUrl = normalizeUrl(job.sourceUrl);
  if (applyUrl || sourceUrl) {
    return `url:${applyUrl || sourceUrl}`;
  }
  return `content:${normalizeText(job.title)}|${normalizeText(job.company)}|${normalizeText(job.location)}|${normalizeText(job.description)}`;
}

export function canonicalizeJobIdentity(job: Pick<RawJob, 'title' | 'company' | 'location' | 'description' | 'sourceUrl' | 'applyUrl'>): string {
  return buildCanonical(job);
}

export function jobExternalId(job: Pick<RawJob, 'title' | 'company' | 'location' | 'description' | 'sourceUrl' | 'applyUrl'>): string {
  const canonical = buildCanonical(job);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `sha256-${digest}`;
}

export function withDeterministicExternalId(job: RawJob): RawJob {
  return { ...job, externalId: jobExternalId(job) };
}

export function dedupeJobs(jobs: RawJob[]): RawJob[] {
  const seen = new Map<string, RawJob>();
  for (const job of jobs) {
    const key = canonicalizeJobIdentity(job);
    if (!seen.has(key)) {
      seen.set(key, withDeterministicExternalId(job));
    }
  }
  return Array.from(seen.values());
}
