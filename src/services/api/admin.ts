import { apiClient } from './client';

export interface AdminTemplateStatus {
  id: string;
  fileName: string;
  analyzedAt: string;
  sectionCount: number;
  hasPreview: boolean;
}

// Wave 13 observability view types. These mirror the allow-list projections
// in `backend/src/admin/observability.ts` - presence/count/timestamp fields
// only, never secret values.

/** Every new observability endpoint returns `{ generatedAt, data }`. */
export interface ObsEnvelope<T> {
  generatedAt: string;
  data: T;
}

export interface ProviderView {
  type: string;
  sourceIds: string[];
  kind: string;
  tier: number;
  auth: 'keyless' | { byok: string };
  requires: string[];
  enabledByDefault: boolean;
}

export interface ProvidersData {
  count: number;
  limit: number;
  providers: ProviderView[];
}

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

export interface RegistryData {
  counts: {
    companies: number;
    pages: number;
    byProvider: Record<string, number>;
    byTier: Record<string, number>;
    byVerifyStatus: Record<string, number>;
    active: number;
    inactive: number;
  };
  recentFailures: RegistryPageView[];
  failuresLimit: number;
}

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

export interface UserBoardHealthView {
  boardId: string;
  boardName: string;
  boardType: string;
  isActive: boolean;
  status: string;
  consecutiveFailures: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastResultCount: number;
  lastLatencyMs: number | null;
}

export interface KeyPresenceView {
  provider: string;
  hasKey: boolean;
  keyCount: number;
  inCooldown: boolean;
  rateLimitedUntil: string | null;
  lastUsedAt: string | null;
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
    healthKind: 'user-board';
    boardCount: number;
    limit: number;
    byType: SourceTypeAggregate[];
    boards: UserBoardHealthView[];
  };
  registryHealth: {
    healthKind: 'global-registry';
    active: number;
    inactive: number;
    byProvider: Record<string, number>;
    byTier: Record<string, number>;
    byVerifyStatus: Record<string, number>;
  };
  keyCooldowns: KeyPresenceView[];
}

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

export const adminApi = {
  getStatus() {
    return apiClient.get<{ email: string; isAdmin: boolean }>('/admin/status');
  },
  getTemplates() {
    return apiClient.get<AdminTemplateStatus[]>('/admin/templates');
  },
  refreshTemplates() {
    return apiClient.post<{ message: string; templates: number; ids: string[] }>('/templates/refresh');
  },
  generateTemplatePreviews() {
    return apiClient.post<{ generated: number; previews: Array<{ id: string; url: string }> }>('/templates/generate-previews');
  },
  // Wave 13 observability reads. Every call returns the
  // `{ generatedAt, data }` envelope so the UI can show freshness.
  getProviders() {
    return apiClient.get<ObsEnvelope<ProvidersData>>('/admin/providers');
  },
  getRegistry() {
    return apiClient.get<ObsEnvelope<RegistryData>>('/admin/registry');
  },
  getRuns() {
    return apiClient.get<ObsEnvelope<RunsData>>('/admin/runs');
  },
  getSources() {
    return apiClient.get<ObsEnvelope<SourcesData>>('/admin/sources');
  },
  getCosts() {
    return apiClient.get<ObsEnvelope<CostsData>>('/admin/costs');
  },
  getFailures() {
    return apiClient.get<ObsEnvelope<FailuresData>>('/admin/failures');
  },
};
