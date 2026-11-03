import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MapPin, ArrowUpRight, ShieldAlert, Bookmark, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { JobListingSummary } from "@/services/api";
import { sourceBadges, dateLabelFor } from "@/features/jobs/provenanceLabel";
import { getPostedLabel } from "@/features/jobs/jobSearchUtils";

interface JobCardProps {
  job: JobListingSummary;
  onEvaluate?: (job: JobListingSummary) => void;
  selected?: boolean;
  onSelect?: (job: JobListingSummary) => void;
  onSave?: (job: JobListingSummary) => void;
  /**
   * T1101: retained on the props and still passed in, because `evaluatedScore` is what the RANKING
   * path reads (`minMatchScore`, `sortBy=matchScore`). It is no longer RENDERED here.
   */
  evaluatedScore?: number;
  saved?: boolean;
}

export function JobCard({ job, onEvaluate, selected, onSelect, onSave, evaluatedScore, saved }: JobCardProps) {
  const clickable = onSelect !== undefined;
  // Wave-10 provenance (T803, N11): every source that produced the row.
  // sourceBadges falls back to the legacy job.source badge when `sources`
  // is absent, so an old-shaped row renders exactly as today. The card is
  // density-constrained: the first three badges plus +N (the detail panel
  // shows the full list).
  const badges = sourceBadges(job);
  const visibleBadges = badges.slice(0, 3);
  const hiddenSourceCount = badges.length - visibleBadges.length;
  // dateLabelFor: Posted / Updated / Found, or null for old-shaped and
  // unknown rows - null renders no date row, so those rows show nothing
  // (an index-date row is Found here, never Posted - N4).
  const provenanceDateLabel = dateLabelFor(job);

  return (
    <Card
      className={cn(
        "flex flex-col p-4 transition hover:shadow-md",
        clickable && "cursor-pointer",
        selected && "ring-2 ring-primary shadow-md"
      )}
      onClick={clickable ? () => onSelect(job) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(job);
              }
            }
          : undefined
      }
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? "button" : undefined}
      aria-pressed={clickable ? selected === true : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-foreground">{job.title}</h3>
          <p className="truncate text-sm text-ink-3">{job.company}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* T1101: the `{evaluatedScore}% match` badge is GONE. It was the most visible of the
              job-evaluation scores - one derived percentage on EVERY card in the search results,
              with nothing on the card a reader could check it against. `evaluatedScore` is still
              passed in and still computed: `minMatchScore` filters and `sortBy=matchScore` orders
              on it (FREEZE B-16), and a filter over a signal is not a presentation. Nothing
              renders it now. `src/noDerivedScore.test.ts` fails if it comes back. */}
          {saved && !onSave && (
            <Badge variant="secondary" className="shrink-0">Saved</Badge>
          )}
          {visibleBadges.map((name) => (
            <Badge key={name.toLowerCase()} variant="secondary" className="shrink-0 capitalize">{name}</Badge>
          ))}
          {hiddenSourceCount > 0 && (
            <Badge variant="secondary" className="shrink-0" aria-label={`${hiddenSourceCount} more sources`}>+{hiddenSourceCount}</Badge>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1 text-xs text-ink-3">
        <MapPin className="h-3.5 w-3.5" />
        <span className="truncate">{job.location || "Remote / Unspecified"}</span>
      </div>

      {provenanceDateLabel && (
        <div className="mt-2 flex items-center gap-1 text-xs text-ink-3">
          <Clock className="h-3.5 w-3.5" />
          <span>{provenanceDateLabel}{job.postedAt ? ` · ${getPostedLabel(job.postedAt)}` : ""}</span>
        </div>
      )}

      {!job.isActive && (
        <div className="mt-2 flex items-center gap-1 text-xs text-warning">
          <ShieldAlert className="h-3.5 w-3.5" /> Possibly closed
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        {job.applyUrl ? (
          <a
            href={job.applyUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            View posting
          </a>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-1">
          {onSave && (
            <Button
              variant={saved ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={saved === true}
              aria-label={saved ? "Saved" : "Save job"}
              onClick={(e) => {
                e.stopPropagation();
                onSave(job);
              }}
            >
              <Bookmark className={cn("h-4 w-4", saved && "fill-current")} />
              {saved ? "Saved" : "Save"}
            </Button>
          )}
          {onEvaluate && (
            <Button
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onEvaluate(job);
              }}
            >
              Evaluate
              <ArrowUpRight className="ml-1 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
