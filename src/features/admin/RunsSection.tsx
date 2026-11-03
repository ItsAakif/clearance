// Runs section (Wave 13): recent runs from the in-memory registry.
//
// Runs are NOT persisted (ADR-013), so the section carries a "data is
// in-memory, last 5 minutes" caveat: an empty run list means "nothing in
// memory", not "nothing ever runs". A snapshot that expired mid-view shows
// as expired with a refresh affordance, not a stale spinner. Read-only,
// existing shadcn primitives only, no charting.

import { useQuery } from '@tanstack/react-query';
import { adminApi } from '@/services/api/admin';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  SectionShell,
  SectionLoading,
  CountsRow,
  EmptyState,
  QueryError,
  Time,
} from './AdminShared';
import { RUN_TTL_LABEL, isRunExpired, latencyLabel } from './format';

export function RunsSection() {
  const query = useQuery({
    queryKey: ['admin', 'runs'],
    queryFn: () => adminApi.getRuns(),
  });

  const envelope = query.data;
  const data = envelope?.data;
  const runs = data?.runs ?? [];
  const cancelled = runs.filter((run) => run.cancelled).length;
  const totalListings = runs.reduce((sum, run) => sum + run.totalListings, 0);

  return (
    <SectionShell
      title="Runs"
      description={`Recent discovery runs. Data is in-memory only, last ${RUN_TTL_LABEL} - an empty list means no runs are currently held in memory, not that nothing ever runs.`}
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
          <CountsRow
            items={[
              { label: 'runs in memory', value: String(data.runCount) },
              { label: 'listings', value: String(totalListings) },
              { label: 'cancelled', value: String(cancelled) },
            ]}
          />
          {!data.hasData || runs.length === 0 ? (
            <EmptyState
              title="No runs in memory yet"
              body={`The server holds the last ${RUN_TTL_LABEL} of runs only (nothing is persisted). Run a search to populate this view.`}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Listings</TableHead>
                  <TableHead>Units</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const expired = isRunExpired(run.startedAt);
                  return (
                    <TableRow key={run.runId}>
                      <TableCell className="num text-xs">{run.runId}</TableCell>
                      <TableCell>
                        <Time value={run.startedAt} />
                      </TableCell>
                      <TableCell>
                        <Time value={run.finishedAt} />
                      </TableCell>
                      <TableCell>{run.mode ?? '-'}</TableCell>
                      <TableCell>{run.totalListings}</TableCell>
                      <TableCell>
                        {run.units
                          .map(
                            (unit) =>
                              `${unit.type}:${unit.status}(${unit.resultCount}, ${latencyLabel(unit.latencyMs)})`,
                          )
                          .join(', ') || '-'}
                      </TableCell>
                      <TableCell>
                        {expired ? (
                          <Badge variant="destructive">Expired - refresh</Badge>
                        ) : run.cancelled ? (
                          <Badge variant="outline">Cancelled</Badge>
                        ) : run.finishedAt !== null ? (
                          <Badge variant="secondary">Finished</Badge>
                        ) : (
                          <Badge variant="default">Live</Badge>
                        )}
                        {run.truncated ? (
                          <Badge variant="outline" className="ml-1">
                            Truncated
                          </Badge>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </>
      ) : null}
    </SectionShell>
  );
}
