// Registry section (Wave 13): aggregates wave-8 registry health.
//
// Carries a "last check" time and an actionable empty state naming the wave-2
// import command when the registry is still empty. Read-only, existing
// shadcn primitives only, no charting.

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
import { IMPORT_COMMAND, timestampText } from './format';

export function RegistrySection() {
  const query = useQuery({
    queryKey: ['admin', 'registry'],
    queryFn: () => adminApi.getRegistry(),
  });

  const envelope = query.data;
  const data = envelope?.data;
  const counts = data?.counts;
  const failures = data?.recentFailures ?? [];

  // Last check: the most recent page check in the bounded failure window,
  // falling back to the envelope generation time.
  const lastCheck = failures.reduce<string | null>(
    (latest, row) =>
      row.lastCheckedAt !== null && (latest === null || row.lastCheckedAt > latest)
        ? row.lastCheckedAt
        : latest,
    null,
  );
  const lastCheckText =
    lastCheck !== null ? timestampText(lastCheck) : 'no checks recorded yet';

  return (
    <SectionShell
      title="Registry"
      description="Company career-page registry health (read-only)"
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
      {data !== undefined && counts !== undefined && !query.isPending ? (
        <>
          <CountsRow
            items={[
              { label: 'companies', value: String(counts.companies) },
              { label: 'career pages', value: String(counts.pages) },
              { label: 'active', value: String(counts.active) },
              { label: 'inactive', value: String(counts.inactive) },
              { label: 'recent failures', value: String(failures.length) },
              { label: 'last check', value: lastCheckText ?? '-' },
            ]}
          />
          {counts.pages === 0 ? (
            <EmptyState
              title="Registry is empty - no career pages imported yet"
              body={
                <>
                  <p>This is a fresh install: the wave 2 importer has not run.</p>
                  <code className="mt-1 block text-xs text-ink-2">{IMPORT_COMMAND}</code>
                </>
              }
            />
          ) : (
            <>
              {failures.length === 0 ? (
                <EmptyState
                  title="No registry failures"
                  body="Every recently checked career page verified cleanly."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Page</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last error</TableHead>
                      <TableHead>Last checked</TableHead>
                      <TableHead>HTTP</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {failures.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.host}</TableCell>
                        <TableCell>{row.provider ?? '-'}</TableCell>
                        <TableCell>{row.verifyStatus}</TableCell>
                        <TableCell className="max-w-xs truncate">{row.lastError ?? '-'}</TableCell>
                        <TableCell>
                          <Time value={row.lastCheckedAt} />
                        </TableCell>
                        <TableCell>{row.httpStatus ?? '-'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </>
      ) : null}
    </SectionShell>
  );
}
