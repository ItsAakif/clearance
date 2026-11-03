// The verification list: one row per claim, with Confirm / Edit / Reject (T1020).
//
// 06 E.11 flow 1: "per-claim Confirm / Edit+Confirm / Reject". Three properties this
// component is responsible for:
//
//   1. THE ROW IS NEVER JUST A COLOUR. Each row carries a `StatusBadge` and a
//      `ProvenanceBadge`, both icon + text, so the state is legible without colour.
//   2. REJECTED ROWS START COLLAPSED (06 E.11 flow 3). A rejected claim is a decision the
//      user already made; leaving twenty of them expanded buries the work that is left.
//   3. THE CONFIRM BUTTON IS THE ONLY WAY TO CONFIRM, and it says what it will do. The
//      handler calls the confirm endpoint and lets the server write the status and the
//      audit row together - this component never claims anything locally. On failure the
//      row keeps its previous status, so an optimistic update that the server refused
//      cannot leave a claim looking confirmed when it is not.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2 } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { ProvenanceBadge } from "./ProvenanceBadge";
import {
  availableActions,
  kindLabel,
  startsCollapsed,
  statusPresentation,
} from "./claimPresentation";
import type { CareerClaim } from "@/services/api/career";

export interface ClaimDecisionHandlers {
  onConfirm: (claim: CareerClaim, input: { note?: string; statement?: string }) => Promise<void>;
  onReject: (claim: CareerClaim, input: { reason?: string }) => Promise<void>;
  onReopen: (claim: CareerClaim) => Promise<void>;
  onEdit: (claim: CareerClaim, input: { statement: string; confirm: boolean }) => Promise<void>;
}

interface ClaimListProps {
  claims: readonly CareerClaim[];
  /** Claim id currently awaiting a server response, or null. */
  busyClaimId?: string | null;
  /** A row-level error to show, keyed by claim id. */
  errors?: Record<string, string>;
  /** The four decisions. Every one of them is a server call that writes an audit row. */
  handlers: ClaimDecisionHandlers;
}

function ClaimRow({
  claim,
  busy,
  error,
  handlers,
}: {
  claim: CareerClaim;
  busy: boolean;
  error?: string;
  handlers: ClaimDecisionHandlers;
}) {
  const [open, setOpen] = useState(!startsCollapsed(claim));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(claim.statement);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const actions = availableActions(claim.status);
  const status = statusPresentation(claim.status);

  return (
    <li className="border-b border-rule py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs2 text-ink-3">
            {kindLabel(claim.kind)}
          </p>
          <p className="mt-0.5 text-sm text-ink">{claim.statement}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={claim.status} />
            <ProvenanceBadge provenance={claim.provenance} />
            {claim.producedByModel ? (
              <span className="text-xs2 text-ink-3">via {claim.producedByModel}</span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {actions.includes('confirm') ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => handlers.onConfirm(claim, {})}
            >
              {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              Confirm
            </Button>
          ) : null}
          {actions.includes('edit') ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing((v) => !v)}>
              Edit
            </Button>
          ) : null}
          {actions.includes('reject') ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setRejecting((v) => !v)}
            >
              Reject
            </Button>
          ) : null}
          {actions.includes('reopen') ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => handlers.onReopen(claim)}>
              Reopen
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" className="mt-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {editing ? (
        <div className="mt-3 space-y-2 border-l-2 border-rule pl-3">
          {/* The panel is reachable ONLY for a status whose action list contains `edit`
              (`availableActions` above), and `user_confirmed` offers `reject` only: the
              backend refuses `edit` on a confirmed claim in both variants
              (`career/verification.ts` transitions, asserted against the backend source by
              `claimPresentation.test.ts`). So there is exactly one wording to show and one
              set of buttons - the "Reword and confirm" branch and the conditional "Save and
              confirm" button that used to guard on `status !== 'user_confirmed'` were dead
              code, and a dead branch in an a11y surface is worse than no branch: it reads as
              if a confirmed statement could be re-worded in place, which the backend forbids
              precisely so a confirmed claim's audit row keeps describing the words the user
              approved. */}
          <Label htmlFor={`claim-${claim.id}-statement`} className="text-xs2">
            Reword this statement (saving it does not confirm it)
          </Label>
          <Textarea
            id={`claim-${claim.id}-statement`}
            value={draft}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || draft.trim().length === 0}
              onClick={() => handlers.onEdit(claim, { statement: draft.trim(), confirm: false })}
            >
              Save wording
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || draft.trim().length === 0}
              onClick={() => handlers.onEdit(claim, { statement: draft.trim(), confirm: true })}
            >
              Save and confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs2 text-ink-3">
            Every change is recorded with your name against this statement. Rewording an
            unconfirmed statement does not confirm it.
          </p>
        </div>
      ) : null}

      {rejecting ? (
        <div className="mt-3 space-y-2 border-l-2 border-rule pl-3">
          <Label htmlFor={`claim-${claim.id}-reason`} className="text-xs2">
            Why is this not yours? (optional, kept with the decision)
          </Label>
          <Input
            id={`claim-${claim.id}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. that was a team project, not mine"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => handlers.onReject(claim, { reason: reason.trim() || undefined })}
            >
              Reject this statement
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {!open ? (
        <button
          type="button"
          className="mt-1 text-xs2 text-ink-3 underline underline-offset-2"
          onClick={() => setOpen(true)}
        >
          Show details - {status.label.toLowerCase()}
        </button>
      ) : null}
    </li>
  );
}

export function ClaimList({ claims, busyClaimId, errors, handlers }: ClaimListProps) {
  if (claims.length === 0) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-ink-3">
          No statements match this filter.
        </CardContent>
      </Card>
    );
  }
  return (
    <ul className="border-t border-rule divide-y divide-rule" data-testid="career-claim-list">
      {claims.map((claim) => (
        <ClaimRow
          key={claim.id}
          claim={claim}
          busy={busyClaimId === claim.id}
          error={errors?.[claim.id]}
          handlers={handlers}
        />
      ))}
    </ul>
  );
}

export default ClaimList;
