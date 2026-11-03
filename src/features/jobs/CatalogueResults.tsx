import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { SearchDocument } from '@/services/api/jobs';
import { JobRow } from '@/features/jobs/JobRow';

export interface CatalogueResultsProps {
  rows: SearchDocument[];
  total: number;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onSelect: (job: SearchDocument) => void;
  onClearAll: () => void;
  hasNextPage: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Id of the row currently open in the detail sheet. */
  selectedId?: string;
  /** Fixed clock for deterministic row tests; production leaves it undefined. */
  now?: number;
}

/** The scannable Browse list: dense rows, a quiet empty state, Load more. */
export function CatalogueResults({
  rows,
  total,
  loading,
  error,
  onRetry,
  onSelect,
  onClearAll,
  hasNextPage,
  loadingMore,
  onLoadMore,
  selectedId,
  now,
}: CatalogueResultsProps) {
  if (loading && rows.length === 0) {
    return (
      <div className="space-y-1 py-4" aria-label="Loading jobs" aria-busy="true">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="space-y-2 rounded-control border border-border bg-card p-4">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (error && rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 py-8">
        <p className="text-sm text-ink-2">Could not load the catalogue.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 py-8">
        <p className="text-sm text-ink-2">No jobs match these filters.</p>
        <Button variant="outline" size="sm" onClick={onClearAll}>
          Clear all
        </Button>
      </div>
    );
  }

  return (
    <div>
      <ul aria-label="Jobs" aria-busy={loading || undefined} className="m-0 list-none p-0">
        {rows.map((job) => (
          <li key={job.id}>
            <JobRow job={job} onSelect={onSelect} selected={selectedId === job.id} now={now} />
          </li>
        ))}
      </ul>

      {hasNextPage && (
        <div className="flex items-center justify-between py-4 text-xs text-ink-3">
          <span>
            Showing {rows.length.toLocaleString()} of {total.toLocaleString()}
          </span>
          <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
