import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { ExternalLink, CalendarIcon } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { useApplicationEvents, useUpdateApplication, useCreateApplicationEvent, useUpdateApplicationEvent } from '@/hooks/useJobs';
import { ApplicationTimeline } from './ApplicationTimeline';
import { ALL_APPLICATION_STATUSES, STATUS_LABELS } from './applicationConstants';
import type { Application, ApplicationStatus, CreateApplicationEventInput, UpdateApplicationEventInput } from '@/services/api';

interface Props {
  app: Application | null;
  onClose: () => void;
  onStatusChange: (app: Application, status: ApplicationStatus) => void;
  onSetReminder: (app: Application, date: string | null) => void;
}

export function ApplicationDetailDialog({ app, onClose, onStatusChange, onSetReminder }: Props) {
  const [notes, setNotes] = useState('');
  const [reminderDate, setReminderDate] = useState('');
  const updateApp = useUpdateApplication();
  const addEvent = useCreateApplicationEvent();
  const updateEvent = useUpdateApplicationEvent();
  const { data: events = [], isLoading: eventsLoading, error: eventsError, refetch } = useApplicationEvents(app?.id ?? '');

  useEffect(() => {
    if (app) {
      setNotes(app.notes || '');
      setReminderDate(app.followUpAt?.slice(0, 10) || '');
    }
  }, [app]);

  const handleNotesSave = () => {
    if (!app) return;
    updateApp.mutate({ id: app.id, notes }, { onSuccess: () => {} });
  };

  const handleReminderSet = () => {
    if (!app) return;
    const iso = reminderDate ? new Date(`${reminderDate}T00:00:00`).toISOString() : null;
    onSetReminder(app, iso);
    if (iso) {
      addEvent.mutate({
        applicationId: app.id,
        type: 'follow_up',
        title: 'Follow-up reminder',
        scheduledAt: iso,
      } as CreateApplicationEventInput);
    }
  };

  if (!app) return null;

  return (
    <Dialog open={!!app} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{app.jobListing?.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{app.jobListing?.company} {app.jobListing?.location && `• ${app.jobListing?.location}`}</p>
            {app.jobListing?.applyUrl && (
              <a href={app.jobListing.applyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                View posting <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Select value={app.status} onValueChange={(s) => onStatusChange(app, s as ApplicationStatus)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ALL_APPLICATION_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Notes</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-[80px]" />
            <Button size="sm" onClick={handleNotesSave} disabled={updateApp.isPending}>Save notes</Button>
          </div>

          <div className="flex items-center gap-2">
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
            <Input type="date" className="w-40" value={reminderDate} onChange={(e) => setReminderDate(e.target.value)} />
            <Button size="sm" variant="outline" onClick={handleReminderSet} disabled={addEvent.isPending || !reminderDate}>
              {app.followUpAt ? 'Update reminder' : 'Set reminder'}
            </Button>
            {app.followUpAt && (
              <Button size="sm" variant="ghost" onClick={() => onSetReminder(app, null)}>Clear</Button>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-sm font-medium">Timeline</h4>
            {eventsError ? (
              <div className="space-y-2">
                <p className="text-xs text-destructive">Failed to load events.</p>
                <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
              </div>
            ) : eventsLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (
              <ApplicationTimeline
                app={app}
                events={events}
                onAddEvent={(data) => addEvent.mutate({ applicationId: app.id, ...data })}
                onUpdateEvent={(eventId, data) => {
                  const payload = data as UpdateApplicationEventInput;
                  updateEvent.mutate({ applicationId: app.id, eventId, ...payload });
                }}
                isSaving={addEvent.isPending || updateEvent.isPending}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
