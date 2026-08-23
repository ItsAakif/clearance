import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MapPin, ArrowUpRight, ShieldAlert } from "lucide-react";
import type { JobListingSummary } from "@/services/api";

interface JobCardProps {
  job: JobListingSummary;
  onEvaluate: (job: JobListingSummary) => void;
}

export function JobCard({ job, onEvaluate }: JobCardProps) {
  return (
    <Card className="flex flex-col p-4 transition hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-foreground">{job.title}</h3>
          <p className="truncate text-sm text-muted-foreground">{job.company}</p>
        </div>
        <Badge variant="secondary" className="shrink-0 capitalize">{job.source}</Badge>
      </div>

      <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        <MapPin className="h-3.5 w-3.5" />
        <span className="truncate">{job.location || "Remote / Unspecified"}</span>
      </div>

      {!job.isActive && (
        <div className="mt-2 flex items-center gap-1 text-xs text-warning">
          <ShieldAlert className="h-3.5 w-3.5" /> Possibly closed
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        {job.applyUrl ? (
          <a href={job.applyUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
            View posting
          </a>
        ) : (
          <span />
        )}
        <Button size="sm" onClick={() => onEvaluate(job)}>
          Evaluate
          <ArrowUpRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    </Card>
  );
}
