// InterviewPrep.tsx - derived interview risks and grounded questions (T1090; 06 sec. E.4,
// E.11 flow 8).
//
// FLAG GATED by the EXISTING `v2ResumeStudio` flag, exactly as the Studio and the tailoring
// surface are: `src/App.tsx` does not register these routes at all with the flag off, so
// `/app/interview-prep` is a 404 like any other unknown path and the chunk is never fetched.
// No new flag, so the cross-runtime flag-name contract in `src/lib/flags.test.ts` holds.
//
// TWO ROUTES, AND WHY THE CHOOSER IS SEPARATE. A prep run operates on a REVISION of a resume,
// and the only way a `modelVersion: 2` resume comes into existence is the Studio
// (`features/studio` owns that path), so this page names the resume and then shows what was
// derived. It deliberately does NOT offer to create one: a prep surface that could make a
// resume would be a second data path next to the Studio's.
//
// THE THREE RULES THE PAGE ITSELF ENFORCES, and they are the whole point of the screen:
//   - THE RISKS ARE DERIVED, and every card shows the rows it was read from. A warning with
//     nothing behind it is not shown; `features/interview-prep/RiskList.tsx` refuses it.
//   - A MISSING PROVIDER IS NOT AN ERROR. The risks and the anchored questions are computed
//     from the caller's own rows, so with no key configured this screen is still useful and
//     says plainly that no model answers were written.
//   - A REFUSED ANSWER IS SHOWN AS A REFUSAL. When an answer named something the evidence does
//     not contain it was discarded, and the page reports which entities caused it, because the
//     refusal is the evidence - not an absence of findings.
//
// NOTHING HERE COMPUTES A NUMBER OUT OF THE NUMBERS. `features/interview-prep/noVerdict.test.ts`
// fails if a score-shaped member or arithmetic over the counts ever appears in this feature.

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PageShell } from "@/components/layout/PageShell";
import { SectionView } from "@/components/layout/SectionView";
import { InterviewSectionTabs } from "@/components/layout/SectionTabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, MessagesSquare, RefreshCw } from "lucide-react";

import { RiskList } from "@/features/interview-prep/RiskList";
import { QuestionCard } from "@/features/interview-prep/QuestionCard";
import {
  INTERVIEW_RISK_KINDS,
  answerSummaryMessage,
  emptyPrepMessage,
  orderedRisks,
  riskKindPresentation,
} from "@/features/interview-prep/riskPresentation";
import { ApiClientError } from "@/services/api/client";
import { interviewApi, type InterviewPrep } from "@/services/api/interview";

function messageFor(caught: unknown, fallback: string): string {
  if (caught instanceof ApiClientError) return caught.message;
  return fallback;
}

/**
 * The counter row: one integer per risk kind, and nothing derived from them.
 *
 * A plain READ of `riskCounts[kind]`. Not a total, not a ratio, not "readiness" - 06 sec. E.6
 * forbids a single number over named counts, and a row of seven named integers is exactly what
 * E.6 asks for instead.
 */
function RiskCounters({ prep }: { prep: InterviewPrep }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Risk counts by kind">
      {INTERVIEW_RISK_KINDS.filter((kind) => (prep.riskCounts[kind] ?? 0) > 0).map((kind) => (
        <div key={kind} className="border-t border-rule pt-2">
            <dt className="text-xs2 font-medium text-ink-3">{riskKindPresentation(kind).label}</dt>
            <dd className="num text-2xl font-semibold text-ink">
              {prep.riskCounts[kind] ?? 0}
            </dd>
        </div>
      ))}
    </dl>
  );
}

function InterviewPrepChooser() {
  const [resumeId, setResumeId] = useState("");
  const navigate = useNavigate();
  return (
    <PageShell title="Interview" width="data">
      <InterviewSectionTabs />
      <SectionView
        title="Interview prep"
        description="Risks derived from your resume and your confirmed evidence, each with the rows it came from."
      />
      <div className="space-y-6">
        <Alert>
          <AlertTitle>Prep is derived from a resume, not written for you</AlertTitle>
          <AlertDescription>
            Open the Resume Studio to create a resume from your career profile, then come back with
            its id. Nothing here is invented: every risk names the row it was read from.
          </AlertDescription>
        </Alert>

        <section className="surface-card p-5">
  <h2 className="section-title">Open a resume</h2>
  <div className="mt-2 border-t border-rule" />
  <p className="mt-3 text-sm text-ink-3">Resume ids appear in the URL of a resume you have already opened in the Studio.</p>
  <div className="mt-3 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="prep-resume-id" className="text-xs2">
                Resume id
              </Label>
              <input
                id="prep-resume-id"
                value={resumeId}
                onChange={(event) => setResumeId(event.target.value)}
                className="w-full rounded-control border border-border bg-card px-3 py-2 text-sm text-ink focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
              />
            </div>
            <Button
              size="sm"
              disabled={resumeId.trim().length === 0}
              onClick={() => navigate(`/app/interview/prep/${resumeId.trim()}`)}
            >
              <MessagesSquare className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Open
            </Button>
          </div>
        </section>
      </div>
    </PageShell>
  );
}

function InterviewPrepRun() {
  const { resumeId = "" } = useParams();
  const [prep, setPrep] = useState<InterviewPrep | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Read what the last run stored, then derive a fresh one.
   *
   * The GET first is what makes a re-entry useful: a page opened from a bookmark shows the last
   * run instead of an empty screen, and the POST then refreshes it. Both are shown with the same
   * component, because they are the same data - the difference is only which fields are `null`.
   */
  const run = useCallback(async () => {
    if (resumeId.trim().length === 0) return;
    setRunning(true);
    setError(null);
    try {
      try {
        setPrep(await interviewApi.get(resumeId.trim()));
      } catch (caught) {
        // A first run has nothing stored, and an empty list is a normal answer rather than an
        // error. It is swallowed so the POST below is what reports a real failure.
        if (!(caught instanceof ApiClientError)) throw caught;
      }
      setPrep(await interviewApi.prepare({ resumeId: resumeId.trim() }));
    } catch (caught) {
      setError(messageFor(caught, "The interview prep could not be produced."));
    } finally {
      setRunning(false);
    }
  }, [resumeId]);

  useEffect(() => {
    void run();
  }, [run]);

  const summary = prep ? answerSummaryMessage(prep.answerStageSummary) : null;

  return (
    <PageShell title="Interview" width="data">
      <InterviewSectionTabs />
      <SectionView
        title="Interview prep"
        description="Risks derived from your resume and your confirmed evidence, each with the rows it came from. Nothing on this page is generated freely."
      />
      <div className="space-y-6">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>
              {error}{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => void run()}>
                Retry
              </button>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs2 text-ink-3">
            {prep?.revision
              ? `Derived from revision ${prep.revision.revisionNumber}: ${prep.revision.usageCount} claim usage${prep.revision.usageCount === 1 ? "" : "s"} and ${prep.revision.changeCount} change${prep.revision.changeCount === 1 ? "" : "s"}.`
              : "The last stored run. Run it again to re-derive from the current revision."}
          </p>
          <Button size="sm" onClick={() => void run()} disabled={running}>
            {running ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Deriving...
              </>
            ) : (
              <>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Re-derive
              </>
            )}
          </Button>
        </div>

        {prep && summary ? (
          <>
            {prep.risks.length > 0 ? <RiskCounters prep={prep} /> : null}

            <p className="text-xs2 text-ink-3">
              <span className="font-medium text-ink">{summary.headline}</span>{" "}
              {summary.detail}
            </p>

            {prep.risks.length === 0 ? (
              <div className="surface-card p-5">
                <p className="section-title">Nothing risky was derived</p>
                <p className="mt-2 text-sm text-ink-3">{emptyPrepMessage(prep)}</p>
              </div>
            ) : (
              <RiskList risks={orderedRisks(prep.risks)} />
            )}

            {prep.questions.length > 0 ? (
              <section className="surface-card space-y-3 p-5" aria-label="Interview questions">
                <h2 className="section-title">
                  Questions, each anchored to the risk it came from ({prep.questions.length})
                </h2>
                <div className="border-t border-rule" />
                {prep.questions.map((question) => (
                  <QuestionCard key={question.questionId} question={question} />
                ))}
              </section>
            ) : null}

            <footer className="space-y-1 border-t border-rule pt-4 text-xs2 text-ink-3">
              <p className="text-sm text-ink">{prep.notes}</p>
              <p>{prep.rule}</p>
            </footer>
          </>
        ) : running ? (
          <p className="flex items-center gap-2 rounded-control border border-border bg-card p-4 text-sm text-ink-3">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Reading the rows your risks will be derived from...
          </p>
        ) : (
          <div className="surface-card p-5">
            <p className="section-title">Nothing to show yet</p>
            <p className="mt-2 text-sm text-ink-3">
              Press Re-derive to read this resume&apos;s claim usages, its applied changes and,
              when you name a match report, its named gaps.
            </p>
          </div>
        )}
      </div>
    </PageShell>
  );
}

export default function InterviewPrep() {
  const { resumeId } = useParams();
  return resumeId === undefined ? <InterviewPrepChooser /> : <InterviewPrepRun />;
}