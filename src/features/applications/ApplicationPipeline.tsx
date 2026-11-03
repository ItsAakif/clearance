import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { Application, ApplicationStatus } from '@/services/api';
import { STATUS_LABELS } from './applicationConstants';

interface Props {
  apps: Application[];
  selectedIds: string[];
  onToggleCompare: (id: string) => void;
  onOpen: (app: Application) => void;
  onStatusChange: (app: Application, status: ApplicationStatus) => void | Promise<void>;
}

interface ColumnDef {
  key: string;
  label: string;
  statuses: ApplicationStatus[];
  dropStatus: ApplicationStatus;
  dotClass: string;
}

const DOT_CLASS: Record<ApplicationStatus, string> = {
  saved: 'bg-[hsl(var(--status-draft))]',
  tailored: 'bg-[hsl(var(--status-sent))]',
  applied: 'bg-[hsl(var(--status-sent))]',
  interview: 'bg-[hsl(var(--status-interview))]',
  offer: 'bg-[hsl(var(--status-offer))]',
  rejected: 'bg-[hsl(var(--status-rejected))]',
  withdrawn: 'bg-[hsl(var(--status-draft))]',
  ghosted: 'bg-[hsl(var(--status-draft))]',
};

const COLUMNS: ColumnDef[] = [
  { key: 'saved', label: 'Saved', statuses: ['saved'], dropStatus: 'saved', dotClass: DOT_CLASS.saved },
  { key: 'tailored', label: 'Tailored', statuses: ['tailored'], dropStatus: 'tailored', dotClass: DOT_CLASS.tailored },
  { key: 'sent', label: 'Sent', statuses: ['applied'], dropStatus: 'applied', dotClass: DOT_CLASS.applied },
  { key: 'interview', label: 'Interview', statuses: ['interview'], dropStatus: 'interview', dotClass: DOT_CLASS.interview },
  { key: 'offer', label: 'Offer', statuses: ['offer'], dropStatus: 'offer', dotClass: DOT_CLASS.offer },
  { key: 'closed', label: 'Closed', statuses: ['rejected', 'withdrawn', 'ghosted'], dropStatus: 'rejected', dotClass: DOT_CLASS.rejected },
];

export function ApplicationPipeline({ apps, selectedIds, onToggleCompare, onOpen, onStatusChange }: Props) {
  const [dragId, setDragId] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, app: Application) => {
    e.dataTransfer.setData('text/plain', app.id);
    e.dataTransfer.effectAllowed = 'move';
    setDragId(app.id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, column: ColumnDef) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    const app = apps.find((a) => a.id === id);
    if (!app) return;
    if (app.status === column.dropStatus) return;
    void onStatusChange(app, column.dropStatus);
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {COLUMNS.map((column) => {
        const columnApps = apps.filter((a) => column.statuses.includes(a.status));
        return (
          <div
            key={column.key}
            className="surface-card flex min-w-[280px] flex-1 flex-col p-3"
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, column)}
          >
            <div className="flex items-center justify-between px-1 pb-2.5">
              <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                <span className={`h-2 w-2 rounded-full ${column.dotClass}`} aria-hidden="true" />
                {column.label}
              </span>
              <span className="num rounded-full bg-paper-2 px-2 py-0.5 text-xs2 text-ink-2">{columnApps.length}</span>
            </div>
            <div className="flex min-h-[320px] flex-1 flex-col gap-2 border-t border-border pt-3">
              {columnApps.length === 0 ? (
                <div className="flex flex-1 items-center justify-center rounded-control border border-dashed border-border px-2 py-6">
                  <p className="text-xs2 text-ink-3">Empty</p>
                </div>
              ) : (
                columnApps.map((app) => {
                  const isSelected = selectedIds.includes(app.id);
                  const maxedOut = selectedIds.length >= 3 && !isSelected;
                  const listing = app.job ?? app.jobListing;
                  const lastActivity = app.appliedAt ?? app.createdAt;
                  return (
                    <div
                      key={app.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, app)}
                      onClick={() => onOpen(app)}
                      className={`group relative cursor-grab rounded-control border p-3 transition-colors ${
                        isSelected
                          ? 'border-accent-hi/50 bg-accent shadow-e1'
                          : 'border-border bg-card shadow-e1 hover:border-rule-strong hover:bg-paper-2'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs2 text-ink-3">{listing?.company}</p>
                          <p className="truncate text-sm font-semibold text-ink">{listing?.title}</p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 shrink-0 text-ink-3"
                              onClick={(e) => e.stopPropagation()}
                              aria-label="Move to…"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {Object.keys(STATUS_LABELS).map((s) => (
                              <DropdownMenuItem
                                key={s}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onStatusChange(app, s as ApplicationStatus);
                                }}
                              >
                                {STATUS_LABELS[s as ApplicationStatus]}
                              </DropdownMenuItem>
                            ))}
                            {listing?.applyUrl ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem asChild>
                                  <a
                                    href={listing.applyUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    Open posting
                                  </a>
                                </DropdownMenuItem>
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <p className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-xs2 text-ink-2">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[app.status]}`} aria-hidden="true" />
                        <span className="shrink-0">{STATUS_LABELS[app.status]}</span>
                        {listing?.location ? (
                          <>
                            <span className="text-ink-3">·</span>
                            <span className="min-w-0 truncate text-ink-3" title={listing.location}>
                              {listing.location}
                            </span>
                          </>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate text-xs2 text-ink-3">
                        {formatDistanceToNow(new Date(lastActivity), { addSuffix: true })}
                      </p>
                      {app.match && (
                        <p className="num mt-1 text-xs2 text-ink-2">
                          {app.match.direct}/{app.match.total} match
                        </p>
                      )}
                      <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                        <button
                          type="button"
                          className="text-xs2 text-ink-3 transition-colors hover:text-ink disabled:opacity-50"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleCompare(app.id);
                          }}
                          disabled={maxedOut}
                        >
                          {isSelected ? 'Compared' : 'Compare'}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
