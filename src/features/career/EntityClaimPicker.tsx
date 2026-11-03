// EntityClaimPicker.tsx - file an existing statement under one entry, or take it back out
// (T1054).
//
// WHAT THIS IS NOT. It is not a confirmation surface, and the copy above the buttons says so
// in one line: attaching places a statement under an entry and changes nothing about whether
// the user has asserted it. There is no Confirm here, there is no status control, and there is
// nothing in this file that could write one - the only call it makes is `attachClaim`, whose
// body carries a kind and an entity id.
//
// WHY THE CANDIDATE LIST IS FILTERED CLIENT-SIDE. `entityKindsForClaimKind` is the mirror of
// the server's `ENTITY_CLAIM_KINDS`, and an education statement is not offered under a project
// because the server would refuse that pairing with a 409. The filter is a courtesy, NOT the
// enforcement: `EntityList` shows a count of the statements that are deliberately NOT offered
// here, so hiding them never reads as "they are gone".
//
// STATUS IS ICON PLUS TEXT. Each row carries the shared `StatusBadge`, so a statement's state
// is legible without colour - and a REJECTED statement is refused by the server with an
// explicit "reopen it first", which is why a rejected row still appears in the list: the user
// has to be able to see what it is they cannot file.

import { useState } from "react";
import { Loader2, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StatusBadge } from "./StatusBadge";
import { kindLabel } from "./claimPresentation";
import { ENTITY_KIND_SINGULAR } from "./entityModel";
import type { CareerClaim, CareerEntityKind } from "@/services/api/career";

const PICK = "__pick__";

export interface EntityClaimPickerProps {
  kind: CareerEntityKind;
  /** A readable name for the entry, used in every sentence. */
  entityLabel: string;
  /** The statements already filed under it. */
  attached: readonly CareerClaim[];
  /** The statements the server would accept here and that are not filed anywhere yet. */
  candidates: readonly CareerClaim[];
  /** How many statements are hidden because the pairing does not apply to this kind. */
  unavailableCount: number;
  busy: boolean;
  error?: string | null;
  onAttach: (claimId: string) => Promise<void>;
  onDetach: (claimId: string) => Promise<void>;
}

export function EntityClaimPicker({
  kind,
  entityLabel,
  attached,
  candidates,
  unavailableCount,
  busy,
  error,
  onAttach,
  onDetach,
}: EntityClaimPickerProps) {
  return (
    <div className="mt-3 space-y-2 border-t border-rule pt-2" data-testid="career-claim-picker">
      <p className="text-xs2 text-ink-3">
        Statements filed under this {ENTITY_KIND_SINGULAR[kind]} appear on the resume page here.
        Filing one is not a confirmation: it keeps whatever status it already has, and only a
        statement you have confirmed can be rendered.
      </p>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {attached.length === 0 ? (
        <p className="text-sm text-ink-3">
          Nothing filed here yet, so this entry contributes no statements to the page.
        </p>
      ) : (
        <ul className="space-y-1">
          {attached.map((claim) => (
            <li key={claim.id} className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs2 text-ink-3">
                  {kindLabel(claim.kind)}
                </p>
                <p className="text-sm text-ink">{claim.statement}</p>
                <StatusBadge status={claim.status} />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                aria-label={`Take "${claim.statement}" out of ${entityLabel}`}
                onClick={() => void onDetach(claim.id)}
              >
                <X className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                Take out
              </Button>
            </li>
          ))}
        </ul>
      )}

      {candidates.length === 0 ? (
        <p className="text-sm text-ink-3">
          {unavailableCount > 0
            ? `None of your unfiled statements are the kind of fact a ${ENTITY_KIND_SINGULAR[kind]} takes, so there is nothing to offer here.`
            : "Every statement that could go here is already filed under something."}
        </p>
      ) : (
        <AttachControl candidates={candidates} busy={busy} onAttach={onAttach} />
      )}

      {unavailableCount > 0 ? (
        <p className="text-xs2 text-ink-3">
          {unavailableCount} other statement{unavailableCount === 1 ? " is" : "s are"} not offered
          here: the model does not allow that pairing. They are not lost - they appear on the
          page under whichever entry does take them, or nowhere yet.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The attach control: pick a statement, then file it. A `<select>` rather than a second list,
 * because the candidate list can be every statement the user has, and a long column of
 * identical buttons is a worse way to choose one than a labelled dropdown.
 */
function AttachControl({
  candidates,
  busy,
  onAttach,
}: {
  candidates: readonly CareerClaim[];
  busy: boolean;
  onAttach: (claimId: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState(PICK);
  const chosen = candidates.find((claim) => claim.id === picked) ?? null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-[16rem] flex-1 space-y-1">
        <label htmlFor={`career-file-under-${candidates[0]?.id ?? "none"}`} className="text-xs2">
          File a statement under this entry
        </label>
        <Select value={picked} onValueChange={setPicked}>
          <SelectTrigger id={`career-file-under-${candidates[0]?.id ?? "none"}`} className="h-9">
            <SelectValue placeholder="Choose a statement" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((claim) => (
              <SelectItem key={claim.id} value={claim.id}>
                {claim.statement}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        size="sm"
        disabled={busy || chosen === null}
        aria-label={chosen ? `File "${chosen.statement}" under this entry` : "File the chosen statement"}
        onClick={() => {
          if (chosen) void onAttach(chosen.id);
        }}
      >
        {busy ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Paperclip className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
        )}
        File it here
      </Button>
    </div>
  );
}

export default EntityClaimPicker;