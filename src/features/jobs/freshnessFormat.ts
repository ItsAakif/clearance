// Freshness display for catalogue rows. Pure formatting, no React.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Format the age of a posting as `just now`, `12m ago`, `2h ago`, `3d ago`,
 * `5mo ago` or `2y ago`. Future timestamps clamp to `just now`. An absent or
 * unparseable timestamp yields `null` so the row omits the line.
 */
export function formatFreshness(
  value: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const diff = Math.max(0, now - ms);
  if (diff < MINUTE_MS) return 'just now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  const days = Math.floor(diff / DAY_MS);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
