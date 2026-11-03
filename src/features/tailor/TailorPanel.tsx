// TailorPanel.tsx - the tailoring surface for ONE resume (T1080; 06 sec.E.3).
//
// THE FOUR MOVES, IN THE ORDER THE PANEL PERMITS THEM:
//   1. PROPOSE. `POST /resumes/:id/tailor`. AI-OPTIONAL: with no provider the panel says so in
//      words and stays usable, because `apply` takes operations from the request body (ADR-041
//      D5). A panel that only worked with a key would make the whole feature a function of an
//      account the user may not have.
//   2. DECIDE, per operation. The server's verdict is shown with its code, and an operation it
//      refused cannot be accepted - `isAcceptable`, in `tailorModel.ts`.
//   3. APPLY. `POST /resumes/:id/tailor/apply` with the accepted operations. The response's
//      `parent` is displayed next to the new revision so the immutability claim is VISIBLE and
//      not merely asserted.
//   4. REVIEW. `GET /resumes/:id/tailor/changes`, the change log with the source claim
//      statements - including the declined rows, which is what makes "suggested, declined"
//      mean anything.
//
// THE PANEL NEVER RENDERS A RESUME. There is no layout here, no page preview, and no
// "tailored resume" tab: the document that comes back lives in the Studio, and this surface's
// whole output is a set of operations and a revision id.

import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Scissors, Wand2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiClientError } from "@/services/api/client";
import { tailorApi, type TailorChangeRowWithClaims, type TailorOperation } from "@/services/api/tailor";
import { OperationCard } from "./OperationCard";
import {
  acceptedOperations,
  diffRowsForChanges,
  diffRowsForOperations,
  isAcceptable,
  summariseProposal,
  type TailorDiffRow,
} from "./tailorModel";

export interface TailorPanelProps {
  resumeId: string;
}

function messageFor(caught: unknown, fallback: string): string {
  if (caught instanceof ApiClientError) {
    // The server's own words, code included when it sent one. A paraphrase here is the one
    // place a machine reason gets lost, and the refusal code IS the reason.
    return caught.code ? `${caught.message} (${caught.code})` : caught.message;
  }
  return fallback;
}

export function TailorPanel({ resumeId }: TailorPanelProps) {
  const [jobId, setJobId] = useState("");
  const [baseRevision, setBaseRevision] = useState<{ id: string; revisionNumber: number; jsonHash: string } | null>(null);
  const [proposal, setProposal] = useState<{ status: string; reason: string } | null>(null);
  const [operations, setOperations] = useState<TailorOperation[]>([]);
  /** The indices of the proposed operations the user declined, by position. */
  const [declined, setDeclined] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [applied, setApplied] = useState<{ id: string; revisionNumber: number; jsonHash: string } | null>(null);
  const [parent, setParent] = useState<{ id: string; revisionNumber: number; jsonHash: string } | null>(null);
  const [log, setLog] = useState<TailorChangeRowWithClaims[]>([]);
  const [busy, setBusy] = useState<"propose" | "apply" | "log" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const propose = useCallback(async () => {
    setBusy("propose");
    setError(null);
    try {
      const result = await tailorApi.propose(resumeId, jobId.trim() ? { jobId: jobId.trim() } : {});
      setProposal(result.proposal);
      setBaseRevision(result.baseRevision);
      setOperations(result.operations);
      setDeclined(new Set<number>());
      setApplied(null);
      setLog([]);
    } catch (caught) {
      setError(messageFor(caught, "The tailoring pass could not be started."));
    } finally {
      setBusy(null);
    }
  }, [resumeId, jobId]);

  const apply = useCallback(async () => {
    setBusy("apply");
    setError(null);
    try {
      // The operations the user kept, in proposal order. The server re-validates every one of
      // them regardless - the client's decision is a UI concern and the server's verdict is
      // the truth - which is why a decline here cannot make an invalid operation apply.
      const kept = operations.filter((_, index) => !declined.has(index));
      const result = await tailorApi.apply(resumeId, acceptedOperations(kept), {
        ...(baseRevision ? { baseRevisionId: baseRevision.id } : {}),
      });
      setParent(result.parent);
      setApplied(result.revision);
      setBaseRevision({
        id: result.revision.id,
        revisionNumber: result.revision.revisionNumber,
        jsonHash: result.revision.jsonHash,
      });
    } catch (caught) {
      setError(messageFor(caught, "The operations were not applied."));
    } finally {
      setBusy(null);
    }
  }, [resumeId, operations, declined, baseRevision]);

  const loadLog = useCallback(async () => {
    if (!applied) return;
    setBusy("log");
    setError(null);
    try {
      const result = await tailorApi.listChanges(resumeId, applied.revisionNumber);
      setLog(result.changes);
    } catch (caught) {
      setError(messageFor(caught, "The change log could not be read."));
    } finally {
      setBusy(null);
    }
  }, [resumeId, applied]);

  /**
   * Decline / re-include ONE operation.
   *
   * A separate list rather than a flag on the operation, so `acceptedOperations` reads the
   * same list the cards render from and there is no second copy of the decision to keep in
   * step. The operation keeps its proposal (and, once applied, its change row and its code) -
   * "suggested, declined" only means something if the user can still see it.
   */
  const decline = useCallback((index: number) => {
    setDeclined((current) => new Set(current).add(index));
  }, []);
  const reincluded = useCallback((index: number) => {
    setDeclined((current) => {
      const next = new Set(current);
      next.delete(index);
      return next;
    });
  }, []);

  const summary = useMemo(
    () => (proposal === null ? null : summariseProposal(operations, proposal)),
    [proposal, operations],
  );
  const applicable = useMemo(
    () =>
      operations.filter(isAcceptable).length -
      [...declined].filter((index) => isAcceptable(operations[index] ?? ({} as TailorOperation))).length,
    [operations, declined],
  );
  const rows: TailorDiffRow[] = useMemo(
    () => (log.length > 0 ? diffRowsForChanges(log) : diffRowsForOperations(operations)),
    [log, operations],
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Propose operations</CardTitle>
          <CardDescription>
            The engine proposes individual operations against your confirmed claims - never a
            rewritten document. Every operation is checked before it is shown: the target has to
            exist, the wording has to trace to a confirmed claim, and no new employer, date,
            metric or technology may appear. Applying them writes a new revision; the current
            one is never changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="tailor-job-id" className="text-xs2 font-medium text-ink">
              Job id (optional)
            </label>
            <Input
              id="tailor-job-id"
              value={jobId}
              placeholder="paste a job id to target its requirements"
              onChange={(event) => setJobId(event.target.value)}
            />
          </div>
          <Button disabled={busy !== null} onClick={() => void propose()}>
            {busy === "propose" ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Wand2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
            )}
            Propose
          </Button>
          {summary ? <p className="text-xs2 text-ink-3">{summary.headline}</p> : null}
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Nothing was applied</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {rows.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {log.length > 0 ? "What this revision changed" : "Proposed operations"}
            </CardTitle>
            <CardDescription>
              Before, after, the reason, and the confirmed claim each change rests on. An
              operation the engine refused is shown with its code rather than hidden.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {rows.map((row, index) => (
              <OperationCard
                key={row.key}
                row={row}
                {...(log.length === 0
                  ? {
                      onToggle: declined.has(index) ? () => reincluded(index) : () => decline(index),
                      included: !declined.has(index),
                    }
                  : {})}
              />
            ))}
            {log.length === 0 ? (
              <div className="flex items-center gap-2">
                <Button disabled={busy !== null || applicable === 0} onClick={() => void apply()}>
                  {busy === "apply" ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Scissors className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  )}
                  Apply {applicable} accepted operation{applicable === 1 ? "" : "s"}
                </Button>
                {applicable === 0 ? (
                  <span className="inline-flex items-center gap-1 text-xs2 text-ink-3">
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                    Nothing to apply: every proposed operation was refused.
                  </span>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {applied && parent ? (
        <Card>
          <CardHeader>
            <CardTitle>A new revision was written</CardTitle>
            <CardDescription>
              Revision {parent.revisionNumber} is unchanged; the operations you accepted are
              revision {applied.revisionNumber}. The hashes below are the proof: they differ,
              because the parent snapshot was never edited.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-xs2 text-ink-3">
            <p>
              Parent revision {parent.revisionNumber} - jsonHash <code>{parent.jsonHash}</code>
            </p>
            <p>
              New revision {applied.revisionNumber} - jsonHash <code>{applied.jsonHash}</code>
            </p>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void loadLog()}>
              {busy === "log" ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              Show the change log
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default TailorPanel;