import { AppLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ExternalLink, Trash2, Briefcase, Loader2 } from "lucide-react";
import { useApplications, useUpdateApplication } from "@/hooks/useJobs";
import type { Application } from "@/services/api";

const STAGES = ['saved', 'tailored', 'applied', 'interview', 'offer', 'rejected'] as const;
const STAGE_STYLE: Record<string, string> = {
  saved: "bg-secondary text-secondary-foreground",
  tailored: "bg-primary/10 text-primary",
  applied: "bg-blue-500/10 text-blue-500",
  interview: "bg-amber-500/10 text-amber-500",
  offer: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
};

function AppColumn({ stage, apps }: { stage: string; apps: Application[] }) {
  const update = useUpdateApplication();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold capitalize text-foreground">{stage}</h3>
        <Badge variant="secondary">{apps.length}</Badge>
      </div>
      {apps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">Empty</div>
      ) : (
        apps.map((app) => (
          <Card key={app.id} className="p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{app.jobListing?.title}</p>
                <p className="truncate text-xs text-muted-foreground">{app.jobListing?.company}</p>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => update.mutate({ id: app.id, status: 'rejected' })}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {app.jobListing?.applyUrl && (
              <a href={app.jobListing.applyUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline">
                Posting <ExternalLink className="h-3 w-3" />
              </a>
            )}
            <Select value={app.status} onValueChange={(s) => update.mutate({ id: app.id, status: s })}>
              <SelectTrigger className="mt-2 h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {STAGES.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </Card>
        ))
      )}
    </div>
  );
}

export default function ApplicationsPage() {
  const { data: apps = [], isLoading } = useApplications();

  if (isLoading) {
    return <AppLayout><div className="flex h-full items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div></AppLayout>;
  }

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-card px-6 py-4">
          <h1 className="text-lg font-semibold text-foreground">Application Pipeline</h1>
          <p className="text-sm text-muted-foreground">Track every application - you stay in control of submissions</p>
        </header>
        <div className="flex-1 overflow-auto">
          {apps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground">
              <Briefcase className="mb-3 h-10 w-10 opacity-40" />
              <p className="text-sm">No applications yet. Evaluate a job and save it to the pipeline.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              {STAGES.map((stage) => (
                <AppColumn key={stage} stage={stage} apps={apps.filter((a) => a.status === stage)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
