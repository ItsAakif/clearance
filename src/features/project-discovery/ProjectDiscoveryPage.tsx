// The two-day project engine page (T1100, 06 sec. E.5 flow, E.11).
//
// WHY THE PAGE LIVES IN `features/` AND NOT IN `src/pages/`. Every other V2 surface has a
// `pages/*.tsx` because the route table lazy-imports from there by convention. This one is
// imported from `src/features/project-discovery/` for one reason: the whole surface is ONE
// feature - the run, the gap selection, the cards and the lifecycle - and splitting the route's
// element away from it would put a two-line page between a directory and its own components.
// `src/App.tsx` lazy-imports THIS file, so the code-splitting boundary is the same either way.
//
// WHAT THE PAGE DOES, in the order a user walks it:
//   1. NAME A JOB. A `jobId` or a `matchReportId`, both optional in the box because the honest
//      default is "the job I am looking at", which is read from the URL when the page is opened
//      from the match report.
//   2. RUN THE DISCOVERY. Both optional stages are left ON, and whatever each one does is
//      printed underneath the run - including "no network", which is not an error state and
//      does not change the candidates.
//   3. SHOW THE FOUR COUNTS, THE SELECTED GAPS AND THE REFUSALS, so "why is my Kubernetes
//      requirement not here" has an answer on the screen rather than a feeling.
//   4. DRIVE THE LOOP per candidate: accept, complete, confirm - and render the server's own
//      message after each one, because the message after `complete` ("your profile has NOT
//      changed") is the promise this feature exists to keep.
//
// NO SCORE, NO PERCENTAGE, NO ARITHMETIC over the counts. `features/project-discovery/
// noVerdict.test.ts` fails if one is added, and `src/noDerivedScore.test.ts` sweeps every
// `.tsx` in the app for the same shapes.

import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageShell } from "@/components/layout/PageShell";
import { SectionView } from "@/components/layout/SectionView";
import { MatchSectionTabs } from "@/components/layout/SectionTabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { GapSelection } from "./GapSelection";
import { ProjectCandidateCard } from "./ProjectCandidateCard";
import { RunCounts } from "./RunCounts";
import {
  CANDIDATE_NOTE,
  decisionMessage,
  proposalStageMessage,
  researchStageMessage,
  type DecisionAction,
} from "./projectPresentation";
import { ApiClientError } from "@/services/api/client";
import {
  projectDiscoveryApi,
  type ProjectDecision,
  type ProjectDiscovery,
  type ProjectOpportunity,
} from "@/services/api/projectDiscovery";

function messageFor(caught: unknown, fallback: string): string {
  if (caught instanceof ApiClientError) return caught.message;
  return fallback;
}

export default function ProjectDiscoveryPage() {
  const [params] = useSearchParams();
  // Opened from the match report, the job is named in the URL. Typed by hand, it is not - and
  // that is why the field is editable rather than a read-only header.
  const [jobId, setJobId] = useState(params.get("jobId") ?? "");
  const [matchReportId, setMatchReportId] = useState(params.get("matchReportId") ?? "");
  const [run, setRun] = useState<ProjectDiscovery | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<{ id: string; action: DecisionAction } | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [pageError, setPageError] = useState<string | null>(null);

  const research = useMemo(
    () => (run ? researchStageMessage(run.researchStage) : null),
    [run],
  );
  const proposal = useMemo(
    () => (run ? proposalStageMessage(run.proposalStage) : null),
    [run],
  );

  const runDiscovery = useCallback(async () => {
    const job = jobId.trim();
    const report = matchReportId.trim();
    if (job.length === 0 && report.length === 0) {
      setPageError("Name a job or a match report: the engine works from the gaps one of them reported.");
      return;
    }
    setRunning(true);
    setPageError(null);
    setNotices({});
    try {
      const discovered = await projectDiscoveryApi.discover({
        ...(report.length > 0 ? { matchReportId: report } : {}),
        ...(job.length > 0 ? { jobId: job } : {}),
      });
      setRun(discovered);
    } catch (caught) {
      setPageError(messageFor(caught, "The candidates could not be produced."));
    } finally {
      setRunning(false);
    }
  }, [jobId, matchReportId]);

  /**
   * One decision, then the SERVER'S OWN message.
   *
   * The decision response is the fresh state of that opportunity, so the card updates from what
   * the server derived rather than from an optimistic guess - and the sentence underneath is the
   * server's, not this page's. That matters most after `complete`, where the honest sentence is
   * "your profile has NOT changed".
   */
  const decide = useCallback(
    async (candidate: ProjectOpportunity, action: DecisionAction) => {
      setBusy({ id: candidate.id, action });
      setNotices((current) => {
        const next = { ...current };
        delete next[candidate.id];
        return next;
      });
      try {
        const decision: ProjectDecision =
          action === "accept"
            ? await projectDiscoveryApi.accept(candidate.id)
            : action === "complete"
              ? await projectDiscoveryApi.complete(candidate.id)
              : await projectDiscoveryApi.confirm(candidate.id);
        setRun((current) =>
          current
            ? {
                ...current,
                candidates: current.candidates.map((row) =>
                  row.id === decision.opportunity.id ? decision.opportunity : row,
                ),
              }
            : current,
        );
        setNotices((current) => ({
          ...current,
          [candidate.id]: decisionMessage(decision, action),
        }));
      } catch (caught) {
        setNotices((current) => ({
          ...current,
          [candidate.id]: messageFor(caught, "That decision was not recorded."),
        }));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  return (
    <PageShell title="Match" width="data">
      <MatchSectionTabs />
      <SectionView
        title="Two-day projects"
        description="Turn the gaps this job's requirements could not cover into projects you can actually build in two days. Nothing here is recorded on your profile unless you confirm it yourself."
      />
      <div className="space-y-6">
        {pageError ? (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>
              {pageError}{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => void runDiscovery()}
              >
                Retry
              </button>
            </AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Which job</CardTitle>
            <CardDescription>{CANDIDATE_NOTE}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="project-job-id" className="text-xs2">
                  Job id
                </Label>
                <Input
                  id="project-job-id"
                  value={jobId}
                  placeholder="paste a job id, or open this page from the match report"
                  onChange={(event) => setJobId(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="project-report-id" className="text-xs2">
                  Match report id
                </Label>
                <Input
                  id="project-report-id"
                  value={matchReportId}
                  placeholder="optional: use a match report instead of a job"
                  onChange={(event) => setMatchReportId(event.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => void runDiscovery()}
                disabled={running || (jobId.trim().length === 0 && matchReportId.trim().length === 0)}
              >
                {running ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Reading the gaps
                  </>
                ) : (
                  "Show me two-day projects"
                )}
              </Button>
              <span className="text-xs2 text-ink-3">
                The public search and your AI provider are optional. Without either, the run still
                produces candidates.
              </span>
            </div>
          </CardContent>
        </Card>

        {run ? (
          <>
            <section className="space-y-3" aria-label="The run">
              <RunCounts counts={run.counts} />
              <div className="grid gap-2 sm:grid-cols-2">
                {[research, proposal].filter((message) => message !== null).map((message) => (
                  <p key={message!.headline} className="text-xs2 text-ink-3">
                    <span className="font-medium text-ink">{message!.headline}</span>{" "}
                    {message!.detail}
                  </p>
                ))}
              </div>
              {run.rejectedCandidates.length > 0 ? (
                <p className="text-xs2 text-ink-3">
                  {run.rejectedCandidates.length} candidate
                  {run.rejectedCandidates.length === 1 ? " was" : "s were"} refused:{" "}
                  {run.rejectedCandidates.map((row) => row.reason.replace(/_/g, " ")).join(", ")}.
                </p>
              ) : null}
              <p className="text-xs2 text-ink-3">{run.rule}</p>
            </section>

            <GapSelection selected={run.selectedGaps} excluded={run.excludedGaps} />

            {run.candidates.length === 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>No candidate for this run</CardTitle>
                  <CardDescription>
                    We read the named gaps and none of them is something a weekend project could
                    answer. That is a real answer, not an empty screen: the refusals are named
                    above.
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : (
              <section className="space-y-4" aria-label="Candidates">
                {run.candidates.map((candidate) => (
                  <ProjectCandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    selectedGaps={run.selectedGaps}
                    busyAction={busy?.id === candidate.id ? busy.action : null}
                    notice={notices[candidate.id] ?? null}
                    onDecide={(row, action) => void decide(row, action)}
                  />
                ))}
              </section>
            )}
          </>
        ) : null}
      </div>
    </PageShell>
  );
}