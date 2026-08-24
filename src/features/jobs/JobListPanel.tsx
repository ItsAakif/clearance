import { useMemo } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Briefcase, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { JobCard } from "@/features/jobs/JobCard";
import type { JobListingSummary } from "@/services/api";

export interface JobListPanelProps {
  jobs: JobListingSummary[];
  selectedId?: string;
  evaluatedScores: Record<string, number>;
  savedIds: Set<string>;
  onSelect: (job: JobListingSummary) => void;
  onSave: (job: JobListingSummary) => void;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

export function JobListPanel({
  jobs,
  selectedId,
  evaluatedScores,
  savedIds,
  onSelect,
  onSave,
  loading,
  error,
  onRetry,
}: JobListPanelProps) {
  const sortedJobs = useMemo(() => jobs, [jobs]);

  return (
    <section aria-label="Job results" className="flex h-full min-w-0 flex-col">
      <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {loading ? 'Searching…' : `${jobs.length} result${jobs.length !== 1 ? 's' : ''}`}
      </h2>

      {error && (
        <Alert variant="destructive" className="mb-3">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>Search failed. Check the backend job sources connection.</span>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry} className="gap-1">
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="flex-1 space-y-2 overflow-y-auto" aria-live="polite">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-3 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-full" />
            </div>
          ))}
        </div>
      )}

      {!loading && !error && jobs.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center text-center text-muted-foreground py-8">
          <Briefcase className="mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm">Search public job boards or scan your configured boards to get started.</p>
        </div>
      )}

      {!loading && !error && jobs.length > 0 && (
        <div className="flex-1 space-y-2 overflow-y-auto overflow-x-hidden" role="listbox" aria-label="Job list">
          {sortedJobs.map((job) => (
            <div key={job.id} role="option" aria-selected={job.id === selectedId}>
              <JobCard
                job={job}
                selected={job.id === selectedId}
                evaluatedScore={evaluatedScores[job.id]}
                saved={savedIds.has(job.id)}
                onSelect={onSelect}
                onSave={onSave}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
