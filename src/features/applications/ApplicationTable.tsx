import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ExternalLink } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import type { Application, ApplicationStatus } from '@/services/api';
import { STATUS_LABELS } from './applicationConstants';

interface Props {
  apps: Application[];
  onOpen: (app: Application) => void;
  onStatusChange: (app: Application, status: ApplicationStatus) => void;
}

type SortDir = 'asc' | 'desc';

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

export function ApplicationTable({ apps, onOpen, onStatusChange }: Props) {
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sorted = useMemo(() => {
    const copy = [...apps];
    copy.sort((a, b) => {
      const ad = new Date(a.appliedAt ?? a.createdAt).getTime();
      const bd = new Date(b.appliedAt ?? b.createdAt).getTime();
      return sortDir === 'desc' ? bd - ad : ad - bd;
    });
    return copy;
  }, [apps, sortDir]);

  return (
    <div className="surface-card overflow-x-auto p-2">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Applications</caption>
        <thead>
          <tr className="border-b border-rule text-left text-xs text-ink-3">
            <th className="px-3 py-2 font-medium">Company</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Match</th>
            <th className="px-3 py-2 font-medium">Applied</th>
            <th className="px-3 py-2 font-medium">
              <button type="button" onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))} className="inline-flex items-center gap-1">
                Last activity
              </button>
            </th>
            <th className="px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((app) => {
            const listing = app.job ?? app.jobListing;
            return (
              <tr key={app.id} className="border-b border-rule hover:bg-paper-2">
                <td className="px-3 py-2.5 text-ink-3">{listing?.company}</td>
                <td className="px-3 py-2.5 font-medium text-ink">{listing?.title}</td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[app.status]}`} aria-hidden="true" />
                    <span className="text-ink">{STATUS_LABELS[app.status]}</span>
                  </span>
                </td>
                <td className="num px-3 py-2.5 text-ink-2">
                  {app.match ? `${app.match.direct}/${app.match.total}` : '—'}
                </td>
                <td className="px-3 py-2.5 text-ink-3">
                  {app.appliedAt ? format(new Date(app.appliedAt), 'PP') : '—'}
                </td>
                <td className="px-3 py-2.5 text-ink-3">
                  {formatDistanceToNow(new Date(app.appliedAt ?? app.createdAt), { addSuffix: true })}
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => onOpen(app)}>Open</Button>
                    {listing?.applyUrl && (
                      <a href={listing.applyUrl} target="_blank" rel="noreferrer" className="text-ink-2 hover:underline">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
