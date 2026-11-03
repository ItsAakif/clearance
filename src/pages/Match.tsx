// Match (V2 evidence-level match report) - T1070, 06 sec. E.2, E.6, E.11 flow 7.
//
// WHAT THIS PAGE WAS. The V1 "Job Match" screen: paste a job description, pick a resume (or
// upload a PDF), press "Analyse Match", and read a `matchScore` out of the legacy
// `POST /ats/match-job` response, with keyword lists and "Build tailored resume" wired to
// the frozen V1 builder. That is exactly the surface 06 sec. E.6 orders replaced - it computed
// and displayed a single number.
//
// WHAT IT IS NOW. The four-bucket report over the user's CONFIRMED career claims: Direct /
// Contextual / Potential / Gap as four plain integers, each requirement with its evidence and
// Confirm/Reject on the two proposal levels, and the gaps listed by name. There is no score,
// no percentage and no total-fit figure anywhere on this page, and
// `features/match/noScore.test.ts` fails if one is added.
//
// THE RULES THE PAGE ITSELF ENFORCES:
//   - NOTHING IS SCORED. No arithmetic over the counts, here or in the presentation module.
//   - AN INFERENCE IS NEVER EXPERIENCE. A suggestion stays a suggestion until the user
//     presses Confirm, and the button says so in full ("Confirm this is my experience").
//   - AFTER EVERY DECISION THE REPORT IS RE-READ, not patched in place. A Confirm creates a
//     confirmed statement through the verification service and a Reject creates a named gap,
//     and both decisions can be REFUSED server-side (409: already rejected, already
//     confirmed, an unmappable requirement kind). The screen the user is about to act on
//     must reflect what the database says, including the counters.
//   - A MISSING PROVIDER IS NOT AN ERROR. The report says the suggestion stage was skipped
//     and that the counts are unaffected, because they are derived from confirmed statements.
//
// FLAG GATED by the EXISTING `v2ResumeStudio` flag, like every other V2 page - but the ROUTE
// is not gated, only its element. `/app/match` is registered in BOTH flag states (one
// registration in `src/App.tsx` with a flag-aware element): with the flag off it renders
// `MatchLegacy`, the V1 page restored verbatim, because nine flag-off links already point at
// this path and leaving it unregistered 404'd every one of them. No new flag is introduced
// and the cross-runtime flag-name contract is untouched.

import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { PageShell } from "@/components/layout/PageShell";
import { SectionView } from "@/components/layout/SectionView";
import { MatchSectionTabs } from "@/components/layout/SectionTabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { EvidenceLevelBadge } from "@/features/match/EvidenceLevelBadge";
import { LevelCounters } from "@/features/match/LevelCounters";
import { NamedGaps } from "@/features/match/NamedGaps";
import { RequirementList } from "@/features/match/RequirementList";
import {
  INFERENCE_RULE,
  isEmptyReport,
  proposalStageMessage,
} from "@/features/match/matchPresentation";
import { ApiClientError } from "@/services/api/client";
import { matchApi, type MatchReport, type MatchRequirement } from "@/services/api/match";
import {
  projectDiscoveryApi,
  type ProjectOpportunity,
} from "@/services/api/projectDiscovery";

const SAMPLE_JD = `Staff Platform Engineer

Requirements
- Strong Kubernetes and Terraform skills
- 5+ years of relevant experience
- PostgreSQL and Python`;

function messageFor(caught: unknown, fallback: string): string {
  if (caught instanceof ApiClientError) return caught.message;
  return fallback;
}

/**
 * The three-line preview under a finished report.
 *
 * Only rendered when the discovery call actually stored candidates: an empty run is
 * not an empty card, it is nothing. Nothing here is a verdict - the hours are the
 * two-day BUDGET and the stack is what the candidate would run on.
 */
function SuggestedProjects({ candidates }: { candidates: ProjectOpportunity[] }) {
  return (
    <Card aria-label="Suggested projects">
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <CardTitle>Suggested projects</CardTitle>
          <Link
            to="/app/match/projects"
            className="text-xs2 text-ink-2 underline-offset-4 hover:text-ink hover:underline"
          >
            All projects
          </Link>
        </div>
        <CardDescription>
          Two-day projects that would close the gaps above. Nothing is added to your profile
          unless you confirm it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {candidates.slice(0, 3).map((candidate) => (
            <li key={candidate.id} className="border-b border-rule pb-3 last:border-b-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-[15px] font-medium leading-snug text-ink">
                  {candidate.title}
                </h3>
                <span className="num shrink-0 text-xs2 text-ink-3">
                  {candidate.estimatedHours}h
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-ink-3">{candidate.idea}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {candidate.stack.slice(0, 3).map((technology) => (
                  <Badge key={technology} variant="secondary" className="text-xs">
                    {technology}
                  </Badge>
                ))}
                <Link
                  to="/app/match/projects"
                  className="ml-auto text-xs2 text-ink-2 underline-offset-4 hover:text-ink hover:underline"
                >
                  Open
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function Match() {
  const [jobDescription, setJobDescription] = useState("");
  const [report, setReport] = useState<MatchReport | null>(null);
  const [running, setRunning] = useState(false);
  const [busyPotentialId, setBusyPotentialId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestedProjects, setSuggestedProjects] = useState<ProjectOpportunity[]>([]);
  // `discover` CREATES rows, so it runs at most once per match report. A decision
  // re-reads the report and must not trigger it again; neither may a re-render.
  const discoveredReportIds = useRef(new Set<string>());
  // The report whose suggestions may be shown. A slow discovery for an earlier
  // match must not land under a newer report.
  const activeReportId = useRef<string | null>(null);

  /**
   * Run project discovery for a report, once.
   *
   * This is an enhancement, never a blocker: a refusal, a missing provider or an
   * empty run leaves the report exactly as it was, with no toast and no empty card.
   */
  const discoverProjects = useCallback(async (matchReportId: string) => {
    if (discoveredReportIds.current.has(matchReportId)) return;
    discoveredReportIds.current.add(matchReportId);
    try {
      const discovery = await projectDiscoveryApi.discover({ matchReportId });
      if (activeReportId.current !== matchReportId) return;
      setSuggestedProjects(discovery.candidates.slice(0, 3));
    } catch {
      // Deliberately silent: suggested projects are an enhancement to the report.
    }
  }, []);

  const proposalStage = useMemo(
    () => (report ? proposalStageMessage(report.proposalStage.status, report.proposalStage.reason) : null),
    [report],
  );

  /**
   * Analyse + match.
   *
   * Two server calls because they are two server concerns. Analysis is idempotent on the
   * cleaned text, so pasting the same JD twice is one `Job`; matching then re-derives from
   * whatever that analysis produced. Doing it in one click is what makes the page usable
   * without a job picker, and it is honest: the report names the job it matched.
   */
  const runMatch = useCallback(async () => {
    if (jobDescription.trim().length === 0) return;
    setRunning(true);
    setPageError(null);
    setRowErrors({});
    setNotice(null);
    setSuggestedProjects([]);
    try {
      const analysis = await matchApi.analyzeJob(jobDescription.trim());
      const matched = await matchApi.matchJob(analysis.jobId);
      setReport(matched);
      activeReportId.current = matched.matchReportId;
      setSuggestedProjects([]);
      void discoverProjects(matched.matchReportId);
      if (analysis.analysis.method === "deterministic" && analysis.analysis.llm.status === "skipped") {
        setNotice(
          `Requirements were found by keyword extraction (no AI provider configured). ${analysis.analysis.requirements.length} requirement${analysis.analysis.requirements.length === 1 ? "" : "s"} were read from the text you pasted.`,
        );
      }
    } catch (caught) {
      setPageError(messageFor(caught, "The match could not be produced."));
    } finally {
      setRunning(false);
    }
  }, [discoverProjects, jobDescription]);

  /**
   * One decision, then RE-READ the report.
   *
   * The response already carries the fresh report, so the screen updates from what the
   * server derived rather than from an optimistic guess - which matters because a Confirm or a
   * Reject can be refused, and a level the user was about to click must never move on a
   * guess.
   */
  const runDecision = useCallback(
    async (requirement: MatchRequirement, action: "confirm" | "reject") => {
      const proposal = requirement.potentialMatch;
      const matchReportId = report?.matchReportId ?? null;
      if (!proposal || !matchReportId) return;
      setBusyPotentialId(proposal.id);
      setRowErrors((current) => {
        const next = { ...current };
        delete next[requirement.id];
        return next;
      });
      setNotice(null);
      try {
        const decision =
          action === "confirm"
            ? await matchApi.confirmPotential(matchReportId, proposal.id)
            : await matchApi.rejectPotential(matchReportId, proposal.id, {
                reason: "Not my experience",
              });
        setReport(decision.report);
        setNotice(
          action === "confirm"
            ? decision.changed
              ? `"${requirement.text}" is now direct evidence: a statement you confirmed says it.`
              : `"${requirement.text}" was already confirmed.`
            : `"${requirement.text}" is now a named gap, and the rejection is on the record.`,
        );
      } catch (caught) {
        setRowErrors((current) => ({
          ...current,
          [requirement.id]: messageFor(caught, "That decision was not recorded."),
        }));
      } finally {
        setBusyPotentialId(null);
      }
    },
    [report],
  );

  return (
    <PageShell title="Match" width="data">
      <MatchSectionTabs />
      <SectionView
        title="Job match"
        description="Compare a job description against the statements you have confirmed. Nothing here is scored, and nothing is counted until you confirm it."
      />
      <div className="space-y-6">
        {pageError ? (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>
              {pageError}{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => void runMatch()}>
                Retry
              </button>
            </AlertDescription>
          </Alert>
        ) : null}

        {notice ? (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        <section className="surface-card p-5">
  <h2 className="section-title">Job description</h2>
  <div className="mt-2 border-t border-rule" />
  <p className="mt-3 text-sm text-ink-3">Paste the description. It is read for requirements, then compared against your
              confirmed statements. Nothing is written about you by this step.</p>
  <div className="mt-3 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="match-jd" className="text-xs2">
                Job description
              </Label>
              <Textarea
                id="match-jd"
                className="min-h-[180px] resize-none"
                placeholder={SAMPLE_JD}
                value={jobDescription}
                onChange={(event) => setJobDescription(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void runMatch()} disabled={running || jobDescription.trim().length === 0}>
                {running ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    Reading the description...
                  </>
                ) : (
                  "Show what this job asks for"
                )}
              </Button>
              {report ? (
                <span className="flex flex-wrap items-baseline gap-3 text-xs2 text-ink-3">
                  <span>
                    {report.job.title ?? "Untitled job"}
                    {report.job.company ? ` at ${report.job.company}` : ""}
                  </span>
                  <Link
                    to="/app/match/tailor"
                    className="text-ink-2 underline-offset-4 hover:text-ink hover:underline"
                  >
                    Tailor a resume for this role
                  </Link>
                </span>
              ) : null}
            </div>
          </div>
        </section>

        {report ? (
          <>
            <section className="surface-card space-y-3 p-5" aria-label="Evidence levels">
              <LevelCounters counts={report.requirementCounts} />
              {proposalStage ? (
                <p className="text-xs2 text-ink-3">
                  <span className="font-medium text-ink">{proposalStage.headline}</span>{" "}
                  {proposalStage.detail}
                </p>
              ) : null}
            </section>

            {isEmptyReport(report.requirementCounts) ? (
              <div className="surface-card p-5">
                <p className="section-title">No requirements were read from that description</p>
                <p className="mt-2 text-sm text-ink-3">
                  We found nothing to compare, which is not the same as a good match. Paste a
                  description with a requirements section.
                </p>
              </div>
            ) : (
              <>
                <RequirementList
                  requirements={report.requirements}
                  matchReportId={report.matchReportId}
                  busyPotentialId={busyPotentialId}
                  errors={rowErrors}
                  onConfirm={(requirement) => void runDecision(requirement, "confirm")}
                  onReject={(requirement) => void runDecision(requirement, "reject")}
                />
                <NamedGaps gaps={report.gaps} />
                {suggestedProjects.length > 0 ? (
                  <SuggestedProjects candidates={suggestedProjects} />
                ) : null}
              </>
            )}

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
              <p className="text-sm text-ink">{INFERENCE_RULE}</p>
              <div className="flex items-center gap-2 text-xs2 text-ink-3">
                <EvidenceLevelBadge level="direct" />
                <EvidenceLevelBadge level="contextual" />
              </div>
            </footer>
            <p className="text-xs2 text-ink-3">
              {report.confirmedClaimCount} confirmed statement
              {report.confirmedClaimCount === 1 ? "" : "s"} were eligible to be evidence.{" "}
              {report.notes}
            </p>
          </>
        ) : (
          <div className="surface-card p-5">
            <p className="section-title">No report yet</p>
            <p className="mt-2 text-sm text-ink-3">
              Paste a job description above. You will get four counts and a list of named gaps -
              no score, and nothing counted as your experience until you confirm it.
            </p>
          </div>
        )}
      </div>
    </PageShell>
  );
}