import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { CalendarIcon, RefreshCw, PenLine, Clock, CalendarDays, Award, XCircle, Ban, Circle, type LucideIcon } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { Application, ApplicationEvent, CreateApplicationEventInput, UpdateApplicationEventInput } from '@/services/api';
import { APPLICATION_EVENT_TYPES } from './applicationConstants';

interface Props {
  app: Application;
  events: ApplicationEvent[];
  onAddEvent: (data: CreateApplicationEventInput) => void;
  onUpdateEvent: (eventId: string, data: UpdateApplicationEventInput) => void;
  isSaving: boolean;
}

const EVENT_ICONS: Record<string, LucideIcon> = {
  status_change: RefreshCw,
  note_added: PenLine,
  follow_up: Clock,
  interview_scheduled: CalendarDays,
  offer_received: Award,
  rejected: XCircle,
  withdrawn: Ban,
};

export function ApplicationTimeline({ app, events, onAddEvent, onUpdateEvent, isSaving }: Props) {
  const [addOpen, setAddOpen] = useState(false);
  const [eventType, setEventType] = useState<string>('note_added');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledAt, setScheduledAt] = useState<Date | undefined>();
  const [completed, setCompleted] = useState(false);

  const requiresScheduled = ['follow_up', 'interview_scheduled', 'offer_received'].includes(eventType);

  const handleAdd = () => {
    const payload: CreateApplicationEventInput = {
      type: eventType as CreateApplicationEventInput['type'],
      title: title || undefined,
      description: description || undefined,
      scheduledAt: requiresScheduled && scheduledAt ? scheduledAt.toISOString() : undefined,
      completedAt: completed ? new Date().toISOString() : undefined,
    };
    onAddEvent(payload);
    setTitle('');
    setDescription('');
    setScheduledAt(undefined);
    setCompleted(false);
    setAddOpen(false);
  };

  const toggleCompleted = (event: ApplicationEvent) => {
    onUpdateEvent(event.id, {
      completedAt: event.completedAt ? null : new Date().toISOString(),
    });
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h4 className="section-label">Timeline</h4>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>Add event</Button>
      </div>
      <div className="space-y-4">
        {events.length === 0 && <p className="text-xs text-ink-3">No events yet.</p>}
        {events.map((ev) => (
          <div key={ev.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              {(() => {
                const EventIcon = EVENT_ICONS[ev.type] ?? Circle;
                return <EventIcon className="h-4 w-4 text-ink-3" aria-hidden="true" />;
              })()}
              <div className="mt-1 h-full w-px bg-rule" />
            </div>
            <div className="flex-1 pb-4">
              <p className="text-sm font-medium text-ink">
                {ev.type === 'status_change' ? `Status changed to ${ev.toStatus || 'unknown'}` : ev.title || ev.type.replace(/_/g, ' ')}
              </p>
              {ev.description && <p className="mt-0.5 text-xs text-ink-3 whitespace-pre-wrap">{ev.description}</p>}
              <div className="mt-1 flex items-center gap-2 text-xs text-ink-3">
                <span>{format(new Date(ev.createdAt), 'PP')}</span>
                {ev.scheduledAt && <span>Scheduled: {format(new Date(ev.scheduledAt), 'PP')}</span>}
                {ev.type !== 'status_change' && (
                  <label className="flex items-center gap-1">
                    <Checkbox checked={!!ev.completedAt} onCheckedChange={() => toggleCompleted(ev)} />
                    <span>Completed</span>
                  </label>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add event</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Select value={eventType} onValueChange={setEventType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {APPLICATION_EVENT_TYPES.map((et) => (
                  <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
            {requiresScheduled && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn('w-full justify-start text-left font-normal', !scheduledAt && 'text-ink-3')}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {scheduledAt ? format(scheduledAt, 'PPP') : 'Pick a date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar mode="single" selected={scheduledAt} onSelect={setScheduledAt} />
                </PopoverContent>
              </Popover>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={isSaving || requiresScheduled ? !scheduledAt : false}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
