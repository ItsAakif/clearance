import { useState, useMemo } from 'react';
import { AppLayout } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Briefcase, Loader2, ChevronRight } from 'lucide-react';
import { useApplications, useUpdateApplication, useCreateApplicationEvent } from '@/hooks/useJobs';
import { ApplicationAnalytics } from '@/features/applications/ApplicationAnalytics';
import { FollowUpReminders } from '@/features/applications/FollowUpReminders';
import { ApplicationPipeline } from '@/features/applications/ApplicationPipeline';
import { ApplicationDetailDialog } from '@/features/applications/ApplicationDetailDialog';
import { JobComparisonDialog } from '@/features/applications/JobComparisonDialog';
import { FUNNEL_STAGES, TERMINAL_STAGES, ALL_APPLICATION_STATUSES } from '@/features/applications/applicationConstants';
import type { Application, ApplicationStatus, CreateApplicationEventInput } from '@/services/api';

type StatusFilter = 'all' | ApplicationStatus;

const FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  ...FUNNEL_STAGES.map((s) => ({ value: s as StatusFilter, label: s.charAt(0).toUpperCase() + s.slice(1) })),
  ...TERMINAL_STAGES.map((s) => ({ value: s as StatusFilter, label: s.charAt(0).toUpperCase() + s.slice(1) })),
];

export default function ApplicationsPage() {
  const { data: apps = [], isLoading } = useApplications();
  const updateApp = useUpdateApplication();
  const createEvent = useCreateApplicationEvent();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailApp, setDetailApp] = useState<Application | null>(null);

  const filteredApps = useMemo(() => {
    if (filter === 'all') return apps;
    return apps.filter((a) => a.status === filter);
  }, [apps, filter]);

  const handleToggleCompare = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id].slice(-3);
    });
  };

  const handleStatusChange = (app: Application, status: ApplicationStatus) => {
    updateApp.mutate({ id: app.id, status });
  };

  const handleSetReminder = (app: Application, date: string | null) => {
    updateApp.mutate({ id: app.id, followUpAt: date });
  };

  const handleAddEvent = (data: CreateApplicationEventInput) => {
    if (!detailApp) return;
    createEvent.mutate({ applicationId: detailApp.id, ...data });
  };

  if (isLoading) {
    return <AppLayout><div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div></AppLayout>;
  }

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-card px-6 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-lg font-semibold text-foreground">Application Pipeline</h1>
              <p className="text-sm text-muted-foreground">Track every application - you stay in control of submissions</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" disabled={selectedIds.length < 2} onClick={() => {}}>
                Compare selected ({selectedIds.length}/3)
              </Button>
              <Select value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FILTER_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-6">
          {apps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
              <Briefcase className="mb-3 h-10 w-10 opacity-40" />
              <p className="text-sm">No applications yet. Evaluate a job and save it to the pipeline.</p>
              <Button variant="link" className="mt-2" onClick={() => (window.location.href = '/app/jobs')}>Browse jobs</Button>
            </div>
          ) : (
            <div className="space-y-4">
              <ApplicationAnalytics apps={apps} />
              <FollowUpReminders apps={apps} onSetReminder={handleSetReminder} />
              <ApplicationPipeline
                apps={filteredApps}
                selectedIds={selectedIds}
                onToggleCompare={handleToggleCompare}
                onOpen={setDetailApp}
                onStatusChange={handleStatusChange}
              />
            </div>
          )}
        </div>
      </div>

      <ApplicationDetailDialog app={detailApp} onClose={() => setDetailApp(null)} onStatusChange={handleStatusChange} onSetReminder={handleSetReminder} />
      <JobComparisonDialog apps={apps} selectedIds={selectedIds} open={selectedIds.length >= 2} onOpenChange={(open) => !open && setSelectedIds([])} />
    </AppLayout>
  );
}
