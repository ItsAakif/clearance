// Admin observability builders (Wave 13, T860).
//
// PURE logic module: every export here is a synchronous builder over
// caller-supplied data. All I/O (Prisma reads, discoveryRuns reads) lives in
// the thin router `routes/admin.observability.ts`, which is mounted on the
// existing admin router and inherits its `requireAuth, requireAdmin` gate.
//
// SECURITY (highest-risk requirement): every builder is an explicit
// ALLOW-LIST projection - each output object literal picks the fields it
// allows. Nothing is ever spread from a DB row and then trimmed (a deny-list
// leaks the field someone adds later). In particular no builder emits an API
// key, token, password, or full provider key value - only presence/absence
// booleans, counts, and last-used timestamps.
import { PROVIDERS } from '../jobSources/providerRegistry.js';
import { MAX_RUNS, type RunListEntry } from '../jobSources/discoveryRuns.js';

// ---------------------------------------------------------------------------
// Envelope + bounds
// ---------------------------------------------------------------------------

/** Every new admin observability endpoint returns `{ generatedAt, data }`
 * so the UI can show freshness without guessing. The two legacy routes
 * (`/status`, `/templates`) keep their bare bodies - never wrap them. */
export function envelope<T>(data: T): { generatedAt: string; data: T } {
  return { generatedAt: new Date().toISOString(), data };
}

// Documented default/maximum limits. Over-large values are CLAMPED to the
// maximum (the /registry convention); invalid values are a 400.
export const OBS_PROVIDERS_DEFAULT_LIMIT = 50;
export const OBS_PROVIDERS_MAX_LIMIT = 200;
export const OBS_RUNS_DEFAULT_LIMIT = 20;
/** Runs live in memory bounded by MAX_RUNS (ADR-013): the cap IS the max. */
export const OBS_RUNS_MAX_LIMIT = MAX_RUNS;
export const OBS_SOURCES_DEFAULT_LIMIT = 20;
export const OBS_SOURCES_MAX_LIMIT = 100;
export const OBS_REGISTRY_FAILURES_DEFAULT_LIMIT = 20;
export const OBS_REGISTRY_FAILURES_MAX_LIMIT = 100;
export const OBS_COSTS_DEFAULT_LIMIT = 20;
export const OBS_COSTS_MAX_LIMIT = MAX_RUNS;
export const OBS_FAILURES_DEFAULT_LIMIT = 20;
export const OBS_FAILURES_MAX_LIMIT = 100;
/** Safety scan cap for the key-presence fold (not a user-facing limit). */
export const OBS_KEYS_MAX_SCAN = 500;

export function parseLimit(
  raw: unknown,
  def: number,
  max: number,
): { limit: number; error?: string } {
  if (raw === undefined) return { limit: def };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { limit: 0, error: 'Invalid limit' };
  }
  return { limit: Math.min(parsed, max) };
}

/** Normalize a Prisma DateTime (Date) or ISO string to ISO or null. */
export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

// ---------------------------------------------------------------------------
// GET /providers - straight read from the wave-1 registry. NO second list:
// the projection walks PROVIDERS itself, so the endpoint's type set always
// equals the registry's (asserted in the test against PROVIDERS).
// ---------------------------------------------------------------------------

export interface ProviderView {
  type: string;
  sourceIds: string[];
  kind: string;
  tier: number;
  auth: 'keyless' | { byok: string };
  requires: string[];
  enabledByDefault: boolean;
}

export function buildProvidersPayload(): ProviderView[] {
  return PROVIDERS.map((d) => ({
    type: d.type,
    sourceIds: [...d.sourceIds],
    kind: d.kind,
    tier: d.tier,
    // Presence of the BYOK provider name only - never any key material.
    auth: d.auth === 'keyless' ? 'keyless' : { byok: d.auth.byok },
    requires: [...d.requires],
    enabledByDefault: d.enabledByDefault ?? false,
  }));
}

export interface ProvidersData {
  count: number;
  limit: number;
  providers: ProviderView[];
}

export function buildProvidersData(limit: number): ProvidersData {
  const providers = buildProvidersPayload().slice(0, limit);
  return { count: buildProvidersPayload().length, limit, providers };
}

// ---------------------------------------------------------------------------
// GET /runs - recent in-memory runs. `hasData` distinguishes "no data yet"
// (server restarted, nothing in memory) from a real zero.
// ---------------------------------------------------------------------------

export interface RunUnitView {
  boardId: string;
  name: string;
  type: string;
  status: string;
  resultCount: number;
  latencyMs: number | null;
  error: string | null;
  tier: number | null;
  group: string | null;
  truncated: boolean;
  skippedReason: string | null;
  unitKind: string | null;
}

export interface RunView {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  mode: string | null;
  cancelled: boolean;
  totalListings: number;
  truncated: boolean;
  skippedReasons: string[];
  evaluation: {
    requested: number;
    completed: number;
    skipped: number;
    reason: string | null;
    calls: number;
    approxTokens: number;
  } | null;
  units: RunUnitView[];
}

export interface RunsData {
  hasData: boolean;
  runCount: number;
  limit: number;
  runs: RunView[];
}

export function buildRunsData(entries: RunListEntry[], limit: number): RunsData {
  // Newest first (startedAt is ISO-8601). Sorted here - not only in listRuns -
  // so the endpoint stays newest-first whatever order a caller passes in.
  const sorted = [...entries].sort((a, b) =>
    a.snapshot.startedAt < b.snapshot.startedAt
      ? 1
      : a.snapshot.startedAt > b.snapshot.startedAt
        ? -1
        : 0,
  );
  const runs: RunView[] = sorted.slice(0, limit).map(({ snapshot }) => {
    const skippedReasons: string[] = [];
    const units: RunUnitView[] = snapshot.boards.map((b) => {
      if (b.skippedReason !== undefined) skippedReasons.push(b.skippedReason);
      return {
        boardId: b.boardId,
        name: b.name,
        type: b.type,
        status: b.status,
        resultCount: b.resultCount,
        latencyMs: b.latencyMs ?? null,
        error: b.error ?? null,
        tier: b.tier ?? null,
        group: b.group ?? null,
        truncated: b.truncated ?? false,
        skippedReason: b.skippedReason ?? null,
        unitKind: b.unitKind ?? null,
      };
    });
    return {
      runId: snapshot.runId,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt ?? null,
      mode: snapshot.mode ?? null,
      cancelled: snapshot.cancelled ?? false,
      totalListings: snapshot.totalListings,
      truncated: units.some((u) => u.truncated),
      skippedReasons,
      evaluation: snapshot.evaluation
        ? {
            requested: snapshot.evaluation.requested,
            completed: snapshot.evaluation.completed,
            skipped: snapshot.evaluation.skipped,
            reason: snapshot.evaluation.reason ?? null,
            calls: snapshot.evaluation.estimate.calls,
            approxTokens: snapshot.evaluation.estimate.approxTokens,
          }
        : null,
      units,
    };
  });
  return { hasData: entries.length > 0, runCount: entries.length, limit, runs };
}

// ---------------------------------------------------------------------------
// GET /registry - aggregates wave-8's registry health. Counts come from
// count/groupBy aggregates only (rows are never fetched to count them);
// the recent-failures list is a bounded findMany the ROUTER performs with an
// explicit allow-list select (boardToken is never selected).
// ---------------------------------------------------------------------------

export interface RegistryPageView {
  id: string;
  url: string;
  host: string;
  provider: string | null;
  tier: number;
  verifyStatus: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  httpStatus: number | null;
  resultCount: number;
  failureCount: number;
  company: { id: string; slug: string; name: string } | null;
}

export interface RegistryCountsInput {
  companies: number;
  pages: number;
  byProvider: Record<string, number>;
  byTier: Record<string, number>;
  byVerifyStatus: Record<string, number>;
  active: number;
  inactive: number;
}

export interface RegistryData {
  counts: RegistryCountsInput;
  recentFailures: RegistryPageView[];
  failuresLimit: number;
}

/** Allow-list projection of a registry page row. `boardToken` is
 * deliberately absent: it names a company token and would trip the
 * secret scan, and the admin health view has no use for it. */
export function projectRegistryPage(row: {
  id: string;
  url: string;
  host: string;
  provider: string | null;
  tier: number;
  verifyStatus: string;
  lastError: string | null;
  lastCheckedAt: Date | string | null;
  httpStatus: number | null;
  resultCount: number;
  failureCount: number;
  company?: { id: string; slug: string; name: string } | null;
}): RegistryPageView {
  return {
    id: row.id,
    url: row.url,
    host: row.host,
    provider: row.provider,
    tier: row.tier,
    verifyStatus: row.verifyStatus,
    lastError: row.lastError,
    lastCheckedAt: iso(row.lastCheckedAt),
    httpStatus: row.httpStatus,
    resultCount: row.resultCount,
    failureCount: row.failureCount,
    company: row.company
      ? { id: row.company.id, slug: row.company.slug, name: row.company.name }
      : null,
  };
}

export function buildRegistryData(
  counts: RegistryCountsInput,
  recentFailures: RegistryPageView[],
  failuresLimit: number,
): RegistryData {
  return { counts, recentFailures, failuresLimit };
}

// ---------------------------------------------------------------------------
// GET /sources - per-source aggregates. User-board health (JobSourceHealth)
// and global registry health are labelled with DISTINCT `healthKind` values
// (`user-board` vs `global-registry`) so an operator cannot confuse them.
// A source that never ran reports latency null (renders "-"), never 0ms.
// ---------------------------------------------------------------------------

export const USER_BOARD_HEALTH_KIND = 'user-board';
export const REGISTRY_HEALTH_KIND = 'global-registry';

export interface UserBoardHealthInput {
  boardId: string;
  boardName: string;
  boardType: string;
  isActive: boolean;
  status: string;
  consecutiveFailures: number;
  lastRunAt: Date | string | null;
  lastSuccessAt: Date | string | null;
  lastFailureAt: Date | string | null;
  lastError: string | null;
  lastResultCount: number;
  lastLatencyMs: number | null;
}

export interface KeyPresenceInput {
  provider: string;
  hasKey: boolean;
  keyCount: number;
  inCooldown: boolean;
  rateLimitedUntil: Date | string | null;
  lastUsedAt: Date | string | null;
}

export interface SourceTypeAggregate {
  type: string;
  boards: number;
  successes: number;
  failures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  avgLatencyMs: number | null;
  totalListings: number;
  rateLimited: boolean;
}

export interface SourcesData {
  userBoardHealth: {
    healthKind: typeof USER_BOARD_HEALTH_KIND;
    boardCount: number;
    limit: number;
    byType: SourceTypeAggregate[];
    boards: UserBoardHealthInput[];
  };
  registryHealth: {
    healthKind: typeof REGISTRY_HEALTH_KIND;
    active: number;
    inactive: number;
    byProvider: Record<string, number>;
    byTier: Record<string, number>;
    byVerifyStatus: Record<string, number>;
  };
  keyCooldowns: KeyPresenceInput[];
}

/** Fold one user's board-health window into per-type aggregates. The window
 * is the bounded board list the router fetched (max OBS_SOURCES_MAX_LIMIT);
 * aggregates cover that window only - documented, never a full fetch. */
export function buildSourcesData(
  boards: UserBoardHealthInput[],
  keys: KeyPresenceInput[],
  registry: {
    active: number;
    inactive: number;
    byProvider: Record<string, number>;
    byTier: Record<string, number>;
    byVerifyStatus: Record<string, number>;
  },
  limit: number,
): SourcesData {
  const byType = new Map<string, SourceTypeAggregate>();
  for (const b of boards) {
    let agg = byType.get(b.boardType);
    if (!agg) {
      agg = {
        type: b.boardType,
        boards: 0,
        successes: 0,
        failures: 0,
        lastError: null,
        lastSuccessAt: null,
        avgLatencyMs: null,
        totalListings: 0,
        rateLimited: false,
      };
      byType.set(b.boardType, agg);
    }
    agg.boards += 1;
    if (b.status === 'ok') agg.successes += 1;
    if (b.status === 'error' || b.status === 'failed') agg.failures += 1;
    if (b.lastError !== null) agg.lastError = b.lastError;
    const successAt = iso(b.lastSuccessAt);
    if (successAt !== null && (agg.lastSuccessAt === null || successAt > agg.lastSuccessAt)) {
      agg.lastSuccessAt = successAt;
    }
    agg.totalListings += b.lastResultCount;
  }
  // Average latency over boards that actually reported one; null when none
  // did (renders "-" - never 0ms for a source that never ran).
  for (const agg of byType.values()) {
    const latencies = boards
      .filter((b) => b.boardType === agg.type && b.lastLatencyMs !== null)
      .map((b) => b.lastLatencyMs as number);
    agg.avgLatencyMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, c) => a + c, 0) / latencies.length)
        : null;
  }
  return {
    userBoardHealth: {
      healthKind: USER_BOARD_HEALTH_KIND,
      boardCount: boards.length,
      limit,
      byType: [...byType.values()],
      boards: boards.slice(0, limit),
    },
    registryHealth: {
      healthKind: REGISTRY_HEALTH_KIND,
      active: registry.active,
      inactive: registry.inactive,
      byProvider: registry.byProvider,
      byTier: registry.byTier,
      byVerifyStatus: registry.byVerifyStatus,
    },
    keyCooldowns: keys,
  };
}

// ---------------------------------------------------------------------------
// GET /costs - AI usage aggregates from the wave-9 per-run estimate recorded
// on the run snapshot. NOTHING new is persisted. `hasData` is true only when
// at least one live run carries an estimate - otherwise the section reports
// "no data", never a zero that would masquerade as measured.
// ---------------------------------------------------------------------------

export interface CostRunView {
  runId: string;
  startedAt: string;
  requested: number;
  completed: number;
  skipped: number;
  reason: string | null;
  calls: number;
  approxTokens: number;
}

export interface CostsData {
  hasData: boolean;
  totalRunsSeen: number;
  runsWithEstimates: number;
  totalCalls: number;
  totalApproxTokens: number;
  limit: number;
  perRun: CostRunView[];
}

export function buildCostsData(entries: RunListEntry[], limit: number): CostsData {
  const withEstimates = entries
    .filter((e) => e.snapshot.evaluation !== undefined)
    // Newest first, same contract as /runs.
    .sort((a, b) =>
      a.snapshot.startedAt < b.snapshot.startedAt
        ? 1
        : a.snapshot.startedAt > b.snapshot.startedAt
          ? -1
          : 0,
    );
  const perRun: CostRunView[] = withEstimates.slice(0, limit).map(({ snapshot }) => ({
    runId: snapshot.runId,
    startedAt: snapshot.startedAt,
    requested: snapshot.evaluation!.requested,
    completed: snapshot.evaluation!.completed,
    skipped: snapshot.evaluation!.skipped,
    reason: snapshot.evaluation!.reason ?? null,
    calls: snapshot.evaluation!.estimate.calls,
    approxTokens: snapshot.evaluation!.estimate.approxTokens,
  }));
  return {
    hasData: withEstimates.length > 0,
    totalRunsSeen: entries.length,
    runsWithEstimates: withEstimates.length,
    totalCalls: withEstimates.reduce((a, e) => a + e.snapshot.evaluation!.estimate.calls, 0),
    totalApproxTokens: withEstimates.reduce(
      (a, e) => a + e.snapshot.evaluation!.estimate.approxTokens,
      0,
    ),
    limit,
    perRun,
  };
}

// ---------------------------------------------------------------------------
// GET /failures - bounded, newest-first failure feed from run snapshots
// (failed units) and registry lastError rows, plus key rate-limit events.
// ---------------------------------------------------------------------------

export type FailureKind = 'run-unit' | 'registry-page' | 'rate-limit';

export interface FailureItem {
  kind: FailureKind;
  reason: string;
  at: string | null;
  runId: string | null;
  boardId: string | null;
  boardName: string | null;
  boardType: string | null;
  pageId: string | null;
  pageUrl: string | null;
  provider: string | null;
}

export interface FailuresData {
  hasData: boolean;
  failureCount: number;
  limit: number;
  failures: FailureItem[];
}

/** Merge pre-projected failure items newest-first (null timestamps last)
 * and bound to `limit`. Viewing never increments any failure count. */
export function buildFailuresData(items: FailureItem[], limit: number): FailuresData {
  const sorted = [...items].sort((a, b) => {
    if (a.at === null && b.at === null) return 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
  });
  const failures = sorted.slice(0, limit);
  return { hasData: items.length > 0, failureCount: items.length, limit, failures };
}

/** Project failed run units (`failed` status) into failure items. */
export function runUnitFailures(entries: RunListEntry[]): FailureItem[] {
  const out: FailureItem[] = [];
  for (const { snapshot } of entries) {
    const at = snapshot.finishedAt ?? snapshot.startedAt;
    for (const b of snapshot.boards) {
      if (b.status !== 'failed') continue;
      out.push({
        kind: 'run-unit',
        reason: b.error ?? 'failed',
        at,
        runId: snapshot.runId,
        boardId: b.boardId,
        boardName: b.name,
        boardType: b.type,
        pageId: null,
        pageUrl: null,
        provider: null,
      });
    }
  }
  return out;
}
