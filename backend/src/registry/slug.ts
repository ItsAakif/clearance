// Deterministic Company.slug derivation (T642; wave-2 spec DESIGN Importer).
//
// slug = f(normalizedName, normalizedHost):
//   1. lowercase + NFKD accent-strip each input,
//   2. replace every non-[a-z0-9] run with a single '-', trim edge dashes,
//      truncate to 48 chars (so the slug stays index-friendly),
//   3. append the first 10 hex chars of SHA-256("<namePart>\n<hostPart>").
//
// Properties:
// - Same input -> same slug, stably, across runs and processes: the function
//   is pure (no randomness, no timestamps, no iteration order dependence).
// - Case-insensitive stability: the hash runs over the NORMALIZED parts, so
//   "Acme" and "acme" on the same host yield the same slug.
// - Never merges on name alone: host is part of the hashed input, so two
//   datasets with the same company name and different hosts produce two
//   different slugs (wave-2 spec edge cases).
// - Total length is bounded: <= 48 + 1 + 48 + 1 + 10 = 108 chars.

import { createHash } from 'node:crypto';

export const SLUG_PART_MAX = 48;
export const SLUG_HASH_CHARS = 10;

/** Normalize one slug component: lowercase, accent-strip, dash-join. */
export function slugPart(value: string): string {
  const dashed = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return dashed.slice(0, SLUG_PART_MAX).replace(/-+$/g, '');
}

/**
 * Deterministic company slug from display name + career-page host.
 * Empty/degenerate inputs fall back to 'company' / 'unknown-host' so the
 * function is total (never throws, never returns '').
 */
export function companySlug(name: string, host: string): string {
  const namePart = slugPart(name) || 'company';
  const hostPart = slugPart(host) || 'unknown-host';
  const digest = createHash('sha256')
    .update(`${namePart}\n${hostPart}`, 'utf8')
    .digest('hex')
    .slice(0, SLUG_HASH_CHARS);
  return `${namePart}-${hostPart}-${digest}`;
}
