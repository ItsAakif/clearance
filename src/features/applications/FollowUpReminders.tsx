import { Card } from '@/components/ui/card';
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
    <Card className="p-4">
      <h4 className="mb-3 text-sm font-medium">Follow-up Reminders</h4>
      {reminders.length === 0 ? (
        <p className="text-xs text-muted-foreground">No follow-ups scheduled</p>
      ) : (
        <div className="space-y-2">
          {reminders.map((app) => {
            const isOverdue = new Date(app.followUpAt!) < now;
            return (
              <div key={app.id} className={cn('flex items-center justify-between rounded-md border p-2', isOverdue ? 'border-destructive/40 bg-destructive/5' : 'border-border')}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{app.jobListing?.title} - {app.jobListing?.company}</p>
                  <p className={cn('text-xs', isOverdue ? 'text-destructive' : 'text-muted-foreground')}>
                    {isOverdue ? 'Overdue: ' : ''}{format(new Date(app.followUpAt!), 'PP')}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Input
                    type="date"
                    className="h-7 w-32 text-xs"
                    defaultValue={app.followUpAt?.slice(0, 10)}
                    onBlur={(e) => {
                      const val = e.target.value;
                      if (val) onSetReminder(app, new Date(`${val}T00:00:00`).toISOString());
                    }}
                  />
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => onSetReminder(app, null)} aria-label="Clear reminder">
                    <BellOff className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
