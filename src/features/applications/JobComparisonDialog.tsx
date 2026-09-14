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
    queryFn: async (): Promise<ComparisonItem[]> => {
      const selected = apps.filter((a) => selectedIds.includes(a.id));
      return Promise.all(
        selected.map(async (a) => {
          let description = '';
          let location = a.jobListing?.location ?? undefined;
          let applyUrl = a.jobListing?.applyUrl ?? undefined;
          if (a.jobListingId) {
            try {
              const detail = await jobsApi.get(a.jobListingId);
              description = detail.description || '';
              if (!location) location = detail.location ?? undefined;
              if (!applyUrl) applyUrl = detail.applyUrl ?? undefined;
            } catch {
              description = '';
            }
          }
          return {
            title: a.jobListing?.title || 'Untitled',
            company: a.jobListing?.company || 'Unknown',
            location,
            description,
            applyUrl,
            status: a.status,
            match: a.jobListing?.match ?? null,
          };
        }),
      );
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
              <div key={`${item.title}-${item.company}`} className="rounded-lg border border-border p-4">
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
