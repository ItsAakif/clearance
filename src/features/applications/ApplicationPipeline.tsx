import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ExternalLink, CheckSquare, Square } from 'lucide-react';
import type { Application, ApplicationStatus } from '@/services/api';
import { FUNNEL_STAGES, TERMINAL_STAGES, ALL_APPLICATION_STATUSES, STATUS_LABELS, STATUS_COLORS } from './applicationConstants';

interface Props {
  apps: Application[];
  selectedIds: string[];
  onToggleCompare: (id: string) => void;
  onOpen: (app: Application) => void;
  onStatusChange: (app: Application, status: ApplicationStatus) => void;
}

export function ApplicationPipeline({ apps, selectedIds, onToggleCompare, onOpen, onStatusChange }: Props) {
  const allColumns = [...FUNNEL_STAGES, ...TERMINAL_STAGES];

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {allColumns.map((stage) => {
        const stageApps = apps.filter((a) => a.status === stage);
        const isTerminal = TERMINAL_STAGES.includes(stage);
        return (
          <div key={stage} className="flex min-w-[260px] flex-col gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold capitalize text-foreground">{STATUS_LABELS[stage]}</h3>
              <Badge variant={isTerminal ? 'outline' : 'secondary'}>{stageApps.length}</Badge>
            </div>
            {stageApps.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">Empty</div>
            ) : (
              stageApps.map((app) => {
                const isSelected = selectedIds.includes(app.id);
                const maxedOut = selectedIds.length >= 3 && !isSelected;
                return (
                  <Card key={app.id} className="p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{app.jobListing?.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{app.jobListing?.company}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground"
                        onClick={() => onToggleCompare(app.id)}
                        disabled={maxedOut}
                        aria-label={isSelected ? 'Remove from compare' : 'Add to compare'}
                      >
                        {isSelected ? <CheckSquare className="h-3.5 w-3.5 text-primary" /> : <Square className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                    {app.jobListing?.match && (
                      <p className="mt-1 text-xs text-muted-foreground">Match: {app.jobListing.match.overallScore}</p>
                    )}
                    {app.followUpAt && (
                      <Badge variant="outline" className="mt-1 text-xs">Follow-up</Badge>
                    )}
                    {app.jobListing?.applyUrl && (
                      <a href={app.jobListing.applyUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                        Posting <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    <Select value={app.status} onValueChange={(s) => onStatusChange(app, s as ApplicationStatus)}>
                      <SelectTrigger className="mt-2 h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ALL_APPLICATION_STATUSES.map((s) => (
                          <SelectItem key={s} value={s} className="capitalize">{STATUS_LABELS[s]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" className="mt-2 w-full text-xs" onClick={() => onOpen(app)}>
                      Details
                    </Button>
                  </Card>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}
