// EntityList.tsx - one kind's entries: add, edit, remove, reorder, and the statements filed
// under them (T1054).
//
// WHY THE ENTRIES EXIST. The resume is projected from these rows
// (`backend/src/resume/json/project.ts`): a statement only appears on the page once it is
// attached to one, and an empty list is the reason a freshly imported profile renders an empty
// document. So this panel is not a nicety beside the statement list - it is the other half of
// the same screen.
//
// EVERY CONTROL HERE IS A PLAIN CRUD CALL. Nothing on this panel infers a field, writes a
// status, or asks the server anything the user did not ask. Attaching and detaching are
// BOOKKEEPING: `EntityClaimPicker` says so in words, and the page re-reads both lists
// afterwards rather than patching them in place, because a refusal (a rejected statement, or a
// pairing the model does not intend) has to be visible as the database's answer.
//
// NO INVENTED ORDER. Reorder is two real buttons per row, disabled at the ends, issuing one
// `sortOrder` patch per entry - and a kind the schema gives no order column (a certification)
// has no buttons at all, and says why, rather than hiding the control.
//
// THE FORM IS DATA, NOT MARKUP. Fields, labels, types and the required flags come from
// `entityModel.ts#ENTITY_FIELDS`, whose agreement with the server is asserted by
// `entityModel.test.ts`. A new kind is a row in that table, not a new component.

import { useState } from "react";
import { Loader2, MoreHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { CareerClaim, CareerEntity, CareerEntityKind } from "@/services/api/career";
import { EntityClaimPicker } from "./EntityClaimPicker";
import {
  ENTITY_FIELDS,
  ENTITY_KIND_LABELS,
  ENTITY_KIND_SINGULAR,
  attachmentFieldOf,
  buildEntityInput,
  canAttach,
  draftFromEntity,
  emptyDraft,
  emptyEntityState,
  entityDetail,
  entityListNote,
  entitySummary,
  isReorderable,
  missingRequiredFields,
  moveEntity,
  statementsFor,
  type EntityDraft,
  type EntityReorderPatch,
} from "./entityModel";

/** What a create or an update body may contain. Mirrors the server's field types. */
export type EntityWriteBody = Record<string, string | number | boolean | string[]>;

export interface EntityListProps {
  kind: CareerEntityKind;
  entities: CareerEntity[];
  /** Every statement of the profile: the picker's candidate list, and the count's denominator. */
  claims: readonly CareerClaim[];
  /** True while any call for this kind is in flight. */
  busy: boolean;
  error?: string | null;
  onCreate: (kind: CareerEntityKind, input: EntityWriteBody) => Promise<void>;
  onUpdate: (kind: CareerEntityKind, id: string, patch: EntityWriteBody) => Promise<void>;
  onRemove: (kind: CareerEntityKind, id: string) => Promise<void>;
  onReorder: (kind: CareerEntityKind, patches: EntityReorderPatch[]) => Promise<void>;
  onAttach: (claimId: string, kind: CareerEntityKind, entityId: string) => Promise<void>;
  onDetach: (claimId: string, kind: CareerEntityKind, entityId: string) => Promise<void>;
}


function EntityForm({
  kind,
  entityId,
  draft,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  kind: CareerEntityKind;
  entityId: string;
  draft: EntityDraft;
  busy: boolean;
  onChange: (next: EntityDraft) => void;
  onSubmit: (body: EntityWriteBody) => void;
  onCancel: () => void;
}) {
  const missing = missingRequiredFields(kind, draft);
  const set = (name: string, value: string | boolean) => onChange({ ...draft, [name]: value });
  return (
    <form
      className="mt-2 space-y-2 border-l-2 border-rule pl-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (missing.length === 0) onSubmit(buildEntityInput(kind, draft));
      }}
    >
      {ENTITY_FIELDS[kind]
        // `sortOrder` is a reorder control, not a typed field: the buttons own it, and a hand
        // typed number here would be a second way to say the same thing with other results.
        .filter((field) => field.name !== "sortOrder")
        .map((field) => {
          const inputId = `entity-${entityId}-${field.name}`;
          const value = draft[field.name];
          if (field.type === "boolean") {
            return (
              <div key={field.name} className="flex items-center gap-2">
                <Checkbox
                  id={inputId}
                  checked={value === true}
                  onCheckedChange={(checked) => set(field.name, checked === true)}
                />
                <Label htmlFor={inputId} className="text-xs2">
                  {field.label}
                </Label>
              </div>
            );
          }
          if (field.type === "multiline") {
            return (
              <div key={field.name} className="space-y-1">
                <Label htmlFor={inputId} className="text-xs2">
                  {field.label}
                  {field.required ? "" : " (optional)"}
                </Label>
                <Textarea
                  id={inputId}
                  rows={3}
                  value={String(value ?? "")}
                  onChange={(event) => set(field.name, event.target.value)}
                />
              </div>
            );
          }
          return (
            <div key={field.name} className="space-y-1">
              <Label htmlFor={inputId} className="text-xs2">
                {field.label}
                {field.required ? "" : " (optional)"}
              </Label>
              <Input
                id={inputId}
                value={String(value ?? "")}
                placeholder={field.placeholder}
                onChange={(event) => set(field.name, event.target.value)}
              />
            </div>
          );
        })}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || missing.length > 0}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {missing.length > 0 ? (
          <p className="text-xs2 text-ink-3">Still needed: {missing.join(", ")}.</p>
        ) : null}
      </div>
    </form>
  );
}

export function EntityList({
  kind,
  entities,
  claims,
  busy,
  error,
  onCreate,
  onUpdate,
  onRemove,
  onReorder,
  onAttach,
  onDetach,
}: EntityListProps) {
  const [adding, setAdding] = useState(false);
  const [newDraft, setNewDraft] = useState<EntityDraft>(() => emptyDraft(kind));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EntityDraft>(() => emptyDraft(kind));
  const [openId, setOpenId] = useState<string | null>(null);
  const reorderable = isReorderable(kind);
  const filed = statementsFor(claims, kind, null).length;

  return (
    <Card data-testid={`career-entity-list-${kind}`}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span>
            {ENTITY_KIND_LABELS[kind]}{" "}
            <span className="text-xs2 font-normal text-ink-3">({entities.length})</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || adding}
            onClick={() => {
              setNewDraft(emptyDraft(kind));
              setAdding((value) => !value);
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Add {ENTITY_KIND_SINGULAR[kind]}
          </Button>
        </CardTitle>
        <CardDescription className="text-xs2">{entityListNote(kind, filed)}</CardDescription>
        {reorderable ? null : (
          <p className="text-xs2 text-ink-3">
            Listed by name: the model stores no order for these, so they cannot be reordered.
          </p>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {adding ? (
          <EntityForm
            kind={kind}
            entityId={`new-${kind}`}
            draft={newDraft}
            busy={busy}
            onChange={setNewDraft}
            onSubmit={(body) => {
              void onCreate(kind, body).then(() => setAdding(false));
            }}
            onCancel={() => setAdding(false)}
          />
        ) : null}

        {entities.length === 0 && !adding ? (
          <p className="text-xs2 text-ink-3" data-testid={`career-entity-empty-${kind}`}>
            {emptyEntityState(kind, { hasStatements: claims.length > 0 })}
          </p>
        ) : null}

        {entities.length > 0 ? (
          <ul className="divide-y divide-rule border-t border-rule">
            {entities.map((entity, index) => {
              const row = entity as unknown as Record<string, unknown>;
              const summary = entitySummary(kind, row);
              const detail = entityDetail(kind, row);
              const here = statementsFor(claims, kind, entity.id);
              const open = openId === entity.id;
              return (
                <li key={entity.id} className="p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-ink">{summary}</p>
                      {detail ? <p className="text-xs2 text-ink-3">{detail}</p> : null}
                      <p className="text-xs2 text-ink-3">
                        {here.length} statement{here.length === 1 ? "" : "s"} filed here
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        className="text-xs2 text-ink-2 underline-offset-4 hover:text-ink hover:underline"
                        aria-expanded={open}
                        aria-label={`${open ? "Hide" : "Show"} statements for ${summary}`}
                        onClick={() => setOpenId(open ? null : entity.id)}
                      >
                        Statements
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-ink-3"
                            aria-label={`More actions for ${summary}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {reorderable ? (
                            <>
                              <DropdownMenuItem
                                className="text-xs2"
                                disabled={busy || index === 0}
                                onClick={() => {
                                  const outcome = moveEntity(kind, entities as unknown as Record<string, unknown>[], entity.id, "up");
                                  if (outcome.moved) void onReorder(kind, outcome.patches);
                                }}
                              >
                                Move up
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-xs2"
                                disabled={busy || index === entities.length - 1}
                                onClick={() => {
                                  const outcome = moveEntity(kind, entities as unknown as Record<string, unknown>[], entity.id, "down");
                                  if (outcome.moved) void onReorder(kind, outcome.patches);
                                }}
                              >
                                Move down
                              </DropdownMenuItem>
                            </>
                          ) : null}
                          <DropdownMenuItem
                            className="text-xs2"
                            disabled={busy}
                            onClick={() => {
                              setEditDraft(draftFromEntity(kind, row));
                              setEditingId(entity.id);
                              setOpenId(entity.id);
                            }}
                          >
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-xs2 text-destructive"
                            disabled={busy}
                            onClick={() => void onRemove(kind, entity.id)}
                          >
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {editingId === entity.id ? (
                    <EntityForm
                      kind={kind}
                      entityId={entity.id}
                      draft={editDraft}
                      busy={busy}
                      onChange={setEditDraft}
                      onSubmit={(body) => {
                        void onUpdate(kind, entity.id, body).then(() => setEditingId(null));
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : null}

                  {open && editingId !== entity.id ? (
                    <EntityClaimPicker
                      kind={kind}
                      entityLabel={summary}
                      attached={here}
                      candidates={claims.filter(
                        (claim) =>
                          claim[attachmentFieldOf(kind)] === null &&
                          canAttach(claim.kind, kind),
                      )}
                      unavailableCount={claims.filter(
                        (claim) =>
                          claim[attachmentFieldOf(kind)] === null && !canAttach(claim.kind, kind),
                      ).length}
                      busy={busy}
                      onAttach={(claimId) => onAttach(claimId, kind, entity.id)}
                      onDetach={(claimId) => onDetach(claimId, kind, entity.id)}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {busy ? (
          <p className="flex items-center gap-2 text-xs2 text-ink-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Saving your entries
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default EntityList;