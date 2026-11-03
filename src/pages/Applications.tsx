import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { PageBody } from '@/components/layout';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { useApplications, useUpdateApplication } from '@/hooks/useJobs';
import { applicationsQueryKey } from '@/hooks/useJobs';
import { ApplicationAnalytics } from '@/features/applications/ApplicationAnalytics';
import { FollowUpReminders } from '@/features/applications/FollowUpReminders';
import { ApplicationPipeline } from '@/features/applications/ApplicationPipeline';
import { ApplicationTable } from '@/features/applications/ApplicationTable';
import { JobComparisonDialog } from '@/features/applications/JobComparisonDialog';
import type { Application, ApplicationStatus } from '@/services/api';

type ViewMode = 'board' | 'table';

export default function ApplicationsPage() {
  const { data: apps = [], isLoading } = useApplications();
  const updateApp = useUpdateApplication();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [view, setView] = useState<ViewMode>('board');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showAnalytics, setShowAnalytics] = useState(false);

  const handleToggleCompare = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id].slice(-3);
    });
  };

  const handleStatusChange = async (app: Application, status: ApplicationStatus) => {
    const prev = qc.getQueryData<Application[]>(applicationsQueryKey);
    qc.setQueryData<Application[]>(applicationsQueryKey, (old) =>
      old ? old.map((a) => (a.id === app.id ? { ...a, status } : a)) : old,
    );
    try {
      await updateApp.mutateAsync({ id: app.id, status });
    } catch (e) {
      qc.setQueryData(applicationsQueryKey, prev);
      toast({ title: 'Update failed', description: (e as Error).message, variant: 'destructive' });
      throw e;
    }
  };

  const handleSetReminder = (app: Application, date: string | null) => {
    updateApp.mutate({ id: app.id, followUpAt: date });
  };

  const openWorkspace = (app: Application) => {
    navigate(`/app/applications/${app.id}`);
  };

  const summary = useMemo(() => {
    const waiting = apps.filter((a) => a.status === 'applied' || a.status === 'tailored').length;
    const conversation = apps.filter((a) => a.status === 'interview').length;
    return `${apps.length} application${apps.length === 1 ? '' : 's'}: ${waiting} waiting to hear back, ${conversation} in conversation.`;
  }, [apps]);

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-ink-3" /></div>;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-paper px-8 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="page-title text-ink">Applications</h1>
            <p className="mt-1 text-sm text-ink-3">{summary}</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1 rounded-full bg-secondary p-1" role="group" aria-label="Applications view">
              {(['board', 'table'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  aria-pressed={view === mode}
                  className={cn(
                    'rounded-full px-3 py-1 text-sm transition-colors duration-150',
                    view === mode
                      ? 'bg-card text-ink shadow-e1'
                      : 'text-ink-3 hover:text-ink',
                  )}
                >
                  {mode === 'board' ? 'Board' : 'Table'}
                </button>
              ))}
            </div>
            <Button onClick={() => navigate('/app/jobs')}>New application</Button>
          </div>
        </div>
      </header>
      <PageBody width="full" className="flex-1 overflow-auto px-8 py-6">
        {apps.length === 0 ? (
          <div className="surface-card max-w-md p-5">
            <p className="text-sm text-ink-3">No applications yet. Save an evaluated job to start the pipeline.</p>
            <button
              type="button"
              onClick={() => navigate('/app/jobs')}
              className="mt-2 text-sm text-accent-dark underline-offset-4 hover:underline"
            >
              Browse jobs
            </button>
          </div>
        ) : (
          <div className="space-y-8">
            <FollowUpReminders apps={apps} onSetReminder={handleSetReminder} />
            {view === 'board' ? (
              <ApplicationPipeline
                apps={apps}
                selectedIds={selectedIds}
                onToggleCompare={handleToggleCompare}
                onOpen={openWorkspace}
                onStatusChange={handleStatusChange}
              />
            ) : (
              <ApplicationTable apps={apps} onOpen={openWorkspace} onStatusChange={handleStatusChange} />
            )}
            <div>
              <button
                type="button"
                onClick={() => setShowAnalytics((s) => !s)}
                className="text-xs2 text-ink-3 underline-offset-4 hover:text-ink hover:underline"
                aria-expanded={showAnalytics}
              >
                {showAnalytics ? 'Hide analytics' : 'Show analytics'}
              </button>
              {showAnalytics && (
                <div className="mt-4">
                  <ApplicationAnalytics apps={apps} />
                </div>
              )}
            </div>
          </div>
        )}
      </PageBody>

      <JobComparisonDialog apps={apps} selectedIds={selectedIds} open={selectedIds.length >= 2} onOpenChange={(open) => !open && setSelectedIds([])} />
    </div>
  );
}
