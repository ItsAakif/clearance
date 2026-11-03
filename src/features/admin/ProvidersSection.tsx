// Providers section (Wave 13): every provider descriptor from the registry.
//
// Read-only straight read of the wave-1 registry via GET /api/admin/providers
// - no second list. Existing shadcn primitives only, no charting.

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
} from './AdminShared';

function authLabel(auth: { byok: string } | 'keyless'): string {
  return auth === 'keyless' ? 'keyless' : `BYOK: ${auth.byok}`;
}

export function ProvidersSection() {
  const query = useQuery({
    queryKey: ['admin', 'providers'],
    queryFn: () => adminApi.getProviders(),
  });

  const envelope = query.data;
  const data = envelope?.data;
  const providers = data?.providers ?? [];
  const keyless = providers.filter((p) => p.auth === 'keyless').length;

  return (
    <SectionShell
      title="Providers"
      description="Every provider descriptor from the registry (read-only)"
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
              { label: 'providers', value: String(data.count) },
              { label: 'keyless', value: String(keyless) },
              { label: 'bring-your-own-key', value: String(providers.length - keyless) },
            ]}
          />
          {providers.length === 0 ? (
            <EmptyState
              title="No providers registered"
              body="The provider registry is empty. No discovery source can run until providers exist."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Source IDs</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>Requires</TableHead>
                  <TableHead>Enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider) => (
                  <TableRow key={provider.type}>
                    <TableCell className="font-medium">{provider.type}</TableCell>
                    <TableCell>{provider.sourceIds.join(', ') || '-'}</TableCell>
                    <TableCell>{provider.kind}</TableCell>
                    <TableCell>{provider.tier}</TableCell>
                    <TableCell>
                      <Badge variant={provider.auth === 'keyless' ? 'secondary' : 'outline'}>
                        {authLabel(provider.auth)}
                      </Badge>
                    </TableCell>
                    <TableCell>{provider.requires.join(', ') || '-'}</TableCell>
                    <TableCell>{provider.enabledByDefault ? 'Yes' : 'No'}</TableCell>
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
