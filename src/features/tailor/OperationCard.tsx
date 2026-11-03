// OperationCard.tsx - ONE proposed operation, as the thing a user accepts or declines (T1080).
//
// THE CARD IS THE UNIT OF REVIEW. 06 sec.E.3: "The tailoring request never returns a whole
// rewritten document; it returns ops only", and this is where that becomes a decision a person
// can make: the old text, the new text, why the engine wants the change, and which CONFIRMED
// claim the new wording rests on. Nothing else is on the card, because nothing else is what
// makes the change reviewable.
//
// A REFUSED OPERATION IS STILL SHOWN, with its code. 06 sec.E.3 wants declined proposals to
// "remain visible as 'suggested, declined' so the user can see what the engine wanted and
// why" - and hiding the refusal would leave the user thinking the engine simply had no
// ideas, which is the opposite of what happened.
//
// NO SCORE. There is no "match" figure, no percentage, no rating. E.6 forbids the single
// number, and a per-operation number would be that number one layer down where nothing would
// forbid it.

import { Check, CircleSlash, Target } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { TailorDiffRow } from "./tailorModel";

export interface OperationCardProps {
  row: TailorDiffRow;
  /**
   * Present for a PROPOSAL, absent for an applied revision.
   *
   * `onToggle` flips whether this operation is part of the pass the user applies. It is ONE
   * control and two states rather than Accept and Decline, because that is what the model
   * actually does: `acceptedOperations` filters the list, so "not in the list" is the only
   * meaning the other state can have. Two buttons whose second state did nothing would be the
   * dishonest kind.
   */
  onToggle?: () => void;
  /** Whether this operation is currently part of the pass. `false` renders it as declined. */
  included?: boolean;
}

/** The `op` name, spelled for a person. The wire value stays on the target line. */
function opLabel(op: string): string {
  switch (op) {
    case "rewrite_bullet":
      return "Rewrite a bullet";
    case "reword_summary":
      return "Reword the summary";
    case "retitle":
      return "Retitle a role";
    case "reorder":
      return "Reorder entries";
    case "include":
      return "Include a statement";
    case "exclude":
      return "Exclude an entry";
    case "add_skill":
      return "Add a skill";
    case "remove_skill":
      return "Remove a skill";
    case "customize_style":
      return "Change the layout";
    default:
      return op;
  }
}

export function OperationCard({ row, onToggle, included = true }: OperationCardProps) {
  const refused = row.rejectionCode !== null;
  // A DECLINED-BY-THE-USER row is still shown, with its reason - "suggested, declined" is only
  // useful if the user can see what they turned down.
  const declinedByUser = !refused && onToggle !== undefined && !included;
  return (
    <Card className={refused || declinedByUser ? "opacity-80" : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          {opLabel(row.op)}
          {/* The machine address is shown as well as the prose, because the diff view and the
              change log both speak in `work[0].highlights[2]` and a reviewer cross-checks the
              two. */}
          <span className="num inline-flex items-center gap-1 text-xs2 font-normal text-ink-3">
            <Target className="h-3 w-3" aria-hidden="true" />
            {row.target || "(the document)"}
          </span>
          {refused ? (
            <Badge variant="destructive" className="gap-1">
              <CircleSlash className="h-3 w-3" aria-hidden="true" />
              {row.rejectionCode}
            </Badge>
          ) : declinedByUser ? (
            <Badge variant="secondary">Declined by you</Badge>
          ) : (
            <Badge variant="secondary" className="gap-1">
              <Check className="h-3 w-3" aria-hidden="true" />
              Checked against your confirmed claims
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="border-l-2 border-rule py-1 pl-2">
            <p className="mb-1 text-xs2 font-medium text-ink-3">Before</p>
            <p className="whitespace-pre-wrap text-ink">
              {row.before ?? <span className="italic text-ink-3">nothing here before</span>}
            </p>
          </div>
          <div className="border-l-2 border-rule py-1 pl-2">
            <p className="mb-1 text-xs2 font-medium text-ink-3">After</p>
            <p className="whitespace-pre-wrap text-ink">
              {row.after ?? (
                <span className="italic text-ink-3">
                  {refused ? "not applied" : "removed"}
                </span>
              )}
            </p>
          </div>
        </div>

        {row.reason ? <p className="text-xs2 text-ink-3">{row.reason}</p> : null}

        {/* THE CLAIMS, WITH THEIR STATEMENTS. An id is not something a person can check; a
            statement is. `statement` is empty for a PROPOSAL (the server sends ids there, and
            the statements arrive with the change log once the operation has been applied), so
            the id is shown in that case rather than an empty line. */}
        {row.sourceClaims.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs2 font-medium text-ink-3">
              {row.sourceClaims.some((claim) => claim.statement.length > 0)
                ? "Source claims"
                : "Source claim ids (the statements appear once the change is applied)"}
            </p>
            <ul className="space-y-1 text-xs2 text-ink-3">
              {row.sourceClaims.map((claim) => (
                <li key={claim.id} className="flex flex-wrap items-baseline gap-1">
                  <code>{claim.id}</code>
                  {claim.statement.length > 0 ? <span>{claim.statement}</span> : null}
                  {claim.status.length > 0 ? (
                    <span className="italic">({claim.status.replace(/_/g, " ")})</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {onToggle ? (
          <div className="flex gap-2 pt-1">
            {/* The control is DISABLED for a refused operation, not hidden: the operation is
                still on the screen with its reason, and a hidden control would make it look
                as though the engine had not proposed it. */}
            <Button size="sm" variant={included ? "secondary" : "default"} onClick={onToggle} disabled={refused}>
              {included ? "Decline this one" : "Include this one"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default OperationCard;