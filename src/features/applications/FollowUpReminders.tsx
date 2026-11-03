import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BellOff } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import type { Application } from '@/services/api';

interface Props {
  apps: Application[];
  onSetReminder: (app: Application, date: string | null) => void;
}

export function FollowUpReminders({ apps, onSetReminder }: Props) {
  const reminders = apps
    .filter((a) => a.followUpAt)
    .sort((a, b) => new Date(a.followUpAt!).getTime() - new Date(b.followUpAt!).getTime());

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  return (
    <section className="surface-card p-5">
      <h4 className="section-title">Follow-up reminders</h4>
      <div className="mt-2 border-t border-border" />
      {reminders.length === 0 ? (
        <p className="py-2 text-xs2 text-ink-3">No follow-ups scheduled</p>
      ) : (
        <div>
          {reminders.map((app) => {
            const isOverdue = new Date(app.followUpAt!) < now;
            return (
              <div key={app.id} className="flex items-center justify-between gap-3 border-b border-rule py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{app.jobListing?.title} - {app.jobListing?.company}</p>
                  <p className={cn('text-xs2', isOverdue ? 'text-destructive' : 'text-ink-3')}>
                    {isOverdue ? 'Overdue: ' : ''}{format(new Date(app.followUpAt!), 'PP')}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Input
                    type="date"
                    className="h-7 w-32 text-xs2"
                    defaultValue={app.followUpAt?.slice(0, 10)}
                    onBlur={(e) => {
                      const val = e.target.value;
                      if (val) onSetReminder(app, new Date(`${val}T00:00:00`).toISOString());
                    }}
                  />
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-ink-3" onClick={() => onSetReminder(app, null)} aria-label="Clear reminder">
                    <BellOff className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
