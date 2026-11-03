// Sources section (Wave 13): per-source aggregates.
//
// User-board health and global registry health are labelled distinctly so an
// operator cannot confuse them. An unrun source shows latency as "-", never
// 0ms. A rate-limited source shows its cooldown expiry; the view is
// read-only and never increments failure counts. Existing shadcn primitives
// only, no charting.

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
import { IMPORT_COMMAND, cooldownText, latencyLabel } from './format';

export function SourcesSection() {
  const query = useQuery({
    queryKey: ['admin', 'sources'],
    queryFn: () => adminApi.getSources(),
  });

  const envelope = query.data;
  const data = envelope?.data;
  const userHealth = data?.userBoardHealth;
  const registryHealth = data?.registryHealth;
  const boards = userHealth?.boards ?? [];
  const byType = userHealth?.byType ?? [];
  const cooldowns = data?.keyCooldowns ?? [];
  const inCooldown = cooldowns.filter((key) => key.inCooldown).length;
  const registryTotal = (registryHealth?.active ?? 0) + (registryHealth?.inactive ?? 0);

  return (
    <SectionShell
      title="Sources"
      description="Per-source aggregates. Read-only: viewing this page never changes failure counts."
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
      {data !== undefined &&
      userHealth !== undefined &&
      registryHealth !== undefined &&
      !query.isPending ? (
        <>
          <CountsRow
            items={[
              { label: 'user boards (user-board)', value: String(userHealth.boardCount) },
              { label: 'registry pages (global-registry)', value: String(registryTotal) },
              { label: 'keys in cooldown', value: String(inCooldown) },
            ]}
          />
          {boards.length === 0 && registryTotal === 0 ? (
            <EmptyState
              title="No sources yet - the registry is empty"
              body={
                <>
                  <p>This is a fresh install: the wave 2 importer has not run.</p>
                  <code className="mt-1 block text-xs text-ink-2">{IMPORT_COMMAND}</code>
                </>
              }
            />
          ) : (
            <>
              <h3 className="mb-2 text-sm font-semibold text-foreground">
                User-board health
                <span className="ml-2 font-normal text-muted-foreground">
                  (per-user boards - not global registry health)
                </span>
              </h3>
              {byType.length === 0 ? (
                <EmptyState
                  title="No user boards yet"
                  body="No discovery source has been used from a user board. Per-type aggregates will appear here after the first run."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Boards</TableHead>
                      <TableHead>Successes</TableHead>
                      <TableHead>Failures</TableHead>
                      <TableHead>Avg latency</TableHead>
                      <TableHead>Listings</TableHead>
                      <TableHead>Last success</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {byType.map((row) => (
                      <TableRow key={row.type}>
                        <TableCell className="font-medium">{row.type}</TableCell>
                        <TableCell>{row.boards}</TableCell>
                        <TableCell>{row.successes}</TableCell>
                        <TableCell>{row.failures}</TableCell>
                        <TableCell>{latencyLabel(row.avgLatencyMs)}</TableCell>
                        <TableCell>{row.totalListings}</TableCell>
                        <TableCell>
                          <Time value={row.lastSuccessAt} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">
                Boards
                <span className="ml-2 font-normal text-muted-foreground">
                  (user-board health)
                </span>
              </h3>
              {boards.length === 0 ? (
                <EmptyState title="No boards in this window" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Board</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Latency</TableHead>
                      <TableHead>Results</TableHead>
                      <TableHead>Failures</TableHead>
                      <TableHead>Last error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {boards.map((board) => (
                      <TableRow key={board.boardId}>
                        <TableCell className="font-medium">{board.boardName}</TableCell>
                        <TableCell>{board.boardType}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              board.status === 'ok'
                                ? 'secondary'
                                : board.status === 'error' || board.status === 'failed'
                                  ? 'destructive'
                                  : 'outline'
                            }
                          >
                            {board.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{latencyLabel(board.lastLatencyMs)}</TableCell>
                        <TableCell>{board.lastResultCount}</TableCell>
                        <TableCell>{board.consecutiveFailures}</TableCell>
                        <TableCell className="max-w-xs truncate">
                          {board.lastError ?? '-'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">
                Key cooldowns
                <span className="ml-2 font-normal text-muted-foreground">
                  (presence and expiry only - never key values)
                </span>
              </h3>
              {cooldowns.length === 0 ? (
                <EmptyState
                  title="No provider keys recorded"
                  body="No bring-your-own-key usage has been seen. Keyless sources need no keys."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>Keys</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Last used</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cooldowns.map((key) => (
                      <TableRow key={key.provider}>
                        <TableCell className="font-medium">{key.provider}</TableCell>
                        <TableCell>{key.keyCount}</TableCell>
                        <TableCell>
                          {key.inCooldown && key.rateLimitedUntil !== null ? (
                            <Badge variant="destructive">
                              {cooldownText(key.rateLimitedUntil)}
                            </Badge>
                          ) : (
                            <Badge variant="secondary">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Time value={key.lastUsedAt} />
                        </TableCell>
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
