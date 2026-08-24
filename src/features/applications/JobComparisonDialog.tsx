import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink } from 'lucide-react';
import { jobsApi } from '@/services/api';
import { useQuery } from '@tanstack/react-query';
import type { Application } from '@/services/api';

interface Props {
  apps: Application[];
  selectedIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ComparisonItem {
  title: string;
  company: string;
  location?: string;
  description: string;
  applyUrl?: string;
  status: string;
  match: { overallScore: number; evaluatedAt: string } | null;
}

export function JobComparisonDialog({ apps, selectedIds, open, onOpenChange }: Props) {
  const { data: items = [], isLoading, error } = useQuery({
    queryKey: ['job-comparison', selectedIds],
    queryFn: async () => {
      const raw = await jobsApi.compare(selectedIds);
      const statusMap = new Map(apps.map((a) => [a.jobListing?.title, a.status]));
      const matchMap = new Map(apps.map((a) => [a.id, a.jobListing?.match]));
      return raw.map((r) => ({
        title: r.title,
        company: r.company,
        location: r.location,
        description: r.description,
        applyUrl: r.applyUrl,
        status: statusMap.get(r.title) || 'Unknown',
        match: matchMap.get(r.id) || null,
      })) as ComparisonItem[];
    },
    enabled: open && selectedIds.length >= 2,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Compare jobs</DialogTitle>
          <DialogDescription>Comparing {selectedIds.length} of 3 selected</DialogDescription>
        </DialogHeader>
        {isLoading && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-48 w-full" />)}
          </div>
        )}
        {error && <p className="text-sm text-destructive">Failed to load comparison.</p>}
        {!isLoading && !error && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {items.map((item) => (
              <div key={item.title} className="rounded-lg border border-border p-4">
                <h4 className="font-medium text-foreground">{item.title}</h4>
                <p className="text-xs text-muted-foreground">{item.company} {item.location && `• ${item.location}`}</p>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <Badge variant="secondary" className="capitalize">{item.status}</Badge>
                  {item.match && <span className="text-muted-foreground">Match: {item.match.overallScore}</span>}
                </div>
                <p className="mt-2 line-clamp-4 text-xs text-muted-foreground">{item.description}</p>
                {item.applyUrl && (
                  <a href={item.applyUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    View posting <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
