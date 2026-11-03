// Costs section (Wave 13): AI usage aggregates from in-memory run snapshots.
//
// Nothing is persisted: the per-run wave-9 estimate recorded on the run
// snapshot is the source. When no live run carries an estimate the section
// reports "no data" - never a zero that would masquerade as measured.
// Existing shadcn primitives only, no charting.

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
import {
  SectionShell,
  SectionLoading,
  CountsRow,
  EmptyState,
  QueryError,
  Time,
} from './AdminShared';
import { RUN_TTL_LABEL, countLabel } from './format';

export function CostsSection() {
  const query = useQuery({
    queryKey: ['admin', 'costs'],
    queryFn: () => adminApi.getCosts(),
  });

  const envelope = query.data;
  const data = envelope?.data;
  const perRun = data?.perRun ?? [];

  return (
    <SectionShell
      title="Costs"
      description="AI evaluation usage from in-memory runs (read-only, nothing persisted)"
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
              { label: 'runs seen', value: countLabel(data.hasData, data.totalRunsSeen) },
              { label: 'runs with estimates', value: countLabel(data.hasData, data.runsWithEstimates) },
              { label: 'AI calls', value: countLabel(data.hasData, data.totalCalls) },
              { label: 'approx tokens', value: countLabel(data.hasData, data.totalApproxTokens) },
            ]}
          />
          {!data.hasData || perRun.length === 0 ? (
            <EmptyState
              title="No cost data yet"
              body={`No in-memory run carries an AI estimate (runs live ${RUN_TTL_LABEL} and estimates exist only for evaluated runs). This is missing data, not zero cost.`}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Skipped</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Approx tokens</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perRun.map((row) => (
                  <TableRow key={row.runId}>
                    <TableCell className="num text-xs">{row.runId}</TableCell>
                    <TableCell>
                      <Time value={row.startedAt} />
                    </TableCell>
                    <TableCell>{row.requested}</TableCell>
                    <TableCell>{row.completed}</TableCell>
                    <TableCell>{row.skipped}</TableCell>
                    <TableCell>{row.calls}</TableCell>
                    <TableCell>{row.approxTokens}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      ) : null}
    </SectionShell>
  );
}
