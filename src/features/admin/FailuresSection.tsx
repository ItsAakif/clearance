// Failures section (Wave 13): the bounded failure feed.
//
// Failed run units, registry page errors and key rate-limit events,
// newest first. Rendered as a list (the feed requirement), read-only:
// viewing never increments any failure count. Existing shadcn primitives
// only, no charting.

import { useQuery } from '@tanstack/react-query';
import { adminApi } from '@/services/api/admin';
import type { FailureKind } from '@/services/api/admin';
import { Badge } from '@/components/ui/badge';
import {
  SectionShell,
  SectionLoading,
  CountsRow,
  EmptyState,
  QueryError,
  Time,
} from './AdminShared';

function kindVariant(kind: FailureKind): 'destructive' | 'outline' | 'secondary' {
  if (kind === 'run-unit') return 'destructive';
  if (kind === 'registry-page') return 'outline';
  return 'secondary';
}

function kindLabel(kind: FailureKind): string {
  if (kind === 'run-unit') return 'run unit';
  if (kind === 'registry-page') return 'registry page';
  return 'rate limit';
}

function contextText(item: {
  runId: string | null;
  boardName: string | null;
  boardType: string | null;
  pageUrl: string | null;
  provider: string | null;
}): string {
  const parts: string[] = [];
  if (item.runId !== null) parts.push(`run ${item.runId}`);
  if (item.boardName !== null) {
    parts.push(
      item.boardType !== null ? `board ${item.boardName} (${item.boardType})` : `board ${item.boardName}`,
    );
  }
  if (item.pageUrl !== null) parts.push(`page ${item.pageUrl}`);
  if (item.provider !== null) parts.push(`provider ${item.provider}`);
  return parts.join(' - ') || '-';
}

export function FailuresSection() {
  const query = useQuery({
    queryKey: ['admin', 'failures'],
    queryFn: () => adminApi.getFailures(),
  });

  const envelope = query.data;
  const data = envelope?.data;
  const failures = data?.failures ?? [];

  return (
    <SectionShell
      title="Failures"
      description="Bounded failure feed, newest first (read-only)"
      generatedAt={envelope?.generatedAt}
      onRefresh={() => query.refetch()}
      refreshing={query.isFetching}
    >
      {query.isPending ? <SectionLoading /> : null}
      {query.isError ? (
        <QueryError
          message={query.error instanceof Error ? query.error.message : 'Request failed'}
          onRetry={() => query.refetch()}
        />
      ) : null}
      {data !== undefined && !query.isPending ? (
        <>
          <CountsRow items={[{ label: 'failures in feed', value: String(data.failureCount) }]} />
          {!data.hasData || failures.length === 0 ? (
            <EmptyState
              title="No failures recorded"
              body="No source failures, registry failures or rate-limit events in the current window."
            />
          ) : (
            <ul className="space-y-2">
              {failures.map((item, index) => (
                <li
                  // Feed items carry no stable id; index plus coordinates keep keys stable.
                  key={`${item.kind}-${item.runId ?? ''}-${item.boardId ?? ''}-${item.pageId ?? ''}-${item.at ?? ''}-${index}`}
                  className="border-b border-rule py-2.5 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={kindVariant(item.kind)}>{kindLabel(item.kind)}</Badge>
                    <span className="text-muted-foreground">
                      <Time value={item.at} />
                    </span>
                  </div>
                  <p className="mt-1 font-medium text-foreground">{item.reason}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{contextText(item)}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </SectionShell>
  );
}
