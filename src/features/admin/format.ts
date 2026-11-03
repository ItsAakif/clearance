// Pure display helpers for the Wave 13 admin observability sections.
//
// Every rule worth testing lives here (ADR-031 decision 3: pure `.test.ts`
// modules only, no jsdom / `.test.tsx`). Section components under
// `src/features/admin/` call these helpers and add no mapping logic of
// their own.

/** In-memory run time-to-live, mirroring backend `RUN_TTL_MS` (ADR-013). */
export const RUN_TTL_MS = 5 * 60 * 1000;

/** Human label for the in-memory bound shown on the Runs section. */
export const RUN_TTL_LABEL = '5 minutes';

/**
 * Wave 2 registry importer command, named so an empty registry state is
 * actionable instead of a bare "no data".
 */
export const IMPORT_COMMAND =
  'cd backend && npx tsx scripts/import-company-registry.ts --dataset <dataset-id>';

/**
 * Latency label. A source that never ran reports null and renders "-";
 * a real measured zero renders "0ms" so the two are distinguishable.
 */
export function latencyLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  return `${ms}ms`;
}

/** Absolute timestamp label. Falls back to the raw string when unparseable. */
export function absoluteLabel(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  return new Date(iso).toLocaleString();
}

/**
 * Relative age label ("5m ago"). A timestamp ahead of the local clock
 * reports skew explicitly instead of a negative age.
 */
export function relativeAge(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (iso === null || iso === undefined) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  const diffMs = nowMs - time;
  if (diffMs < 0) return 'ahead of local clock (clock skew?)';
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Combined timestamp text: absolute plus relative age, never only the
 * relative age (clock skew between `generatedAt` and stored times would
 * make a lone "2m ago" unverifiable). Null renders null - callers show
 * "-" or "never" for the empty case.
 */
export function timestampText(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  const absolute = absoluteLabel(iso);
  if (absolute === null) return null;
  const relative = relativeAge(iso, nowMs);
  if (relative === null) return absolute;
  return `${absolute} (${relative})`;
}

/**
 * Whether a run snapshot that was live when fetched has since expired
 * (started longer than the in-memory TTL ago). Expired rows render an
 * "expired" badge with a refresh affordance, not a stale spinner.
 */
export function isRunExpired(
  startedAt: string,
  nowMs: number = Date.now(),
  ttlMs: number = RUN_TTL_MS,
): boolean {
  const time = new Date(startedAt).getTime();
  if (Number.isNaN(time)) return false;
  return nowMs - time > ttlMs;
}

/**
 * Count label that distinguishes "no data" from a real zero: when nothing
 * was measured, the UI must not print 0.
 */
export function countLabel(hasData: boolean, value: number): string {
  if (!hasData) return 'no data';
  return String(value);
}

/**
 * Cooldown label for a rate-limited key. Null (not in cooldown) renders
 * null - callers show the healthy state instead.
 */
export function cooldownText(
  until: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (until === null || until === undefined) return null;
  const text = timestampText(until, nowMs);
  if (text === null) return null;
  return `in cooldown until ${text}`;
}
