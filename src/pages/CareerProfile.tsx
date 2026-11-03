// CareerProfile (V2 evidence + verification) - T1020, 06 E.11 flows 1-3.
//
// This page is the user-visible half of the career layer: it imports a resume, lists the
// candidate claims it produced, shows each one's provenance, and gives the user the three
// decisions. Everything it renders comes from `backend/src/routes/career.ts`; nothing
// here computes a claim's status, and no control on this page can confirm a claim other
// than by calling the confirm endpoint - which writes the status change AND its
// `ClaimVerification` audit row in one server-side transaction (ADR-036 item 3).
//
// FLAG GATED by the EXISTING `v2ResumeStudio` flag (`src/lib/flags.ts`). With the flag
// off, `src/App.tsx` does not register this route at all, so `/app/career` is a 404 like
// any other unknown path, and the V1 Profile page at `/app/profile` is untouched. No new
// flag is introduced and the cross-runtime flag-name contract is not touched.
//
// DATA IS REFETCHED AFTER EVERY DECISION rather than patched in place. A confirm can be
// REFUSED (409: the claim was rejected first, or somebody else's session changed it), and
// a list the user is about to act on must reflect what the database actually says -
// including the counter, which is the number they are working towards.

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageShell } from "@/components/layout/PageShell";
import { SectionView } from "@/components/layout/SectionView";
import { ProfileSectionTabs } from "@/components/layout/SectionTabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { ImportWizard } from "@/features/career/ImportWizard";
import { ClaimList, type ClaimDecisionHandlers } from "@/features/career/ClaimList";
import { EntityList, type EntityWriteBody } from "@/features/career/EntityList";
import { CAREER_ENTITY_KINDS, type CareerEntityKind } from "@/features/career/entityModel";
import { StatusCounter } from "@/features/career/StatusCounter";
import { CLAIM_KINDS, CLAIM_STATUSES, kindLabel, statusPresentation } from "@/features/career/claimPresentation";
import { ApiClientError } from "@/services/api/client";
import {
  careerApi,
  type CareerClaim,
  type CareerClaimCounts,
  type CareerClaimKind,
  type CareerClaimStatus,
  type CareerEntity,
  type CareerEntityDeleteResult,
  type CareerEvidenceSource,
  type CareerImportResult,
  type CareerProfileResponse,
} from "@/services/api/career";
import { uploadedFilesApi, type UploadedFileSummary } from "@/services/api/resume";
import type { EntityReorderPatch } from "@/features/career/entityModel";

const ALL = "__all__";

/** An empty row per kind, so a profile with no entries at all renders six honest empty states. */
function emptyEntities(): Record<CareerEntityKind, CareerEntity[]> {
  return {
    experience: [],
    education: [],
    project: [],
    skill: [],
    certification: [],
    achievement: [],
  };
}

/** A short label per entry kind for the summary rail. */
const ENTITY_SUMMARY_LABELS: Record<CareerEntityKind, string> = {
  experience: "Experience",
  education: "Education",
  project: "Projects",
  skill: "Skills",
  certification: "Certifications",
  achievement: "Awards",
};

function messageFor(caught: unknown, fallback: string): string {
  if (caught instanceof ApiClientError) return caught.message;
  return fallback;
}

export default function CareerProfile() {
  const [profile, setProfile] = useState<CareerProfileResponse | null>(null);
  const [claims, setClaims] = useState<CareerClaim[]>([]);
  const [counts, setCounts] = useState<CareerClaimCounts | null>(null);
  const [sources, setSources] = useState<CareerEvidenceSource[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [kindFilter, setKindFilter] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);
  const [busyClaimId, setBusyClaimId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pageError, setPageError] = useState<string | null>(null);
  const [newStatement, setNewStatement] = useState("");
  const [newKind, setNewKind] = useState<CareerClaimKind>("skill");
  // The six entity lists (T1054). One record rather than six states, because they are always
  // rendered together and a kind whose load failed must not blank the other five.
  const [entities, setEntities] = useState<Record<CareerEntityKind, CareerEntity[]>>(emptyEntities);
  const [entitiesBusy, setEntitiesBusy] = useState(false);
  const [entityErrors, setEntityErrors] = useState<Record<string, string>>({});
  const [entityNote, setEntityNote] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      status: statusFilter === ALL ? undefined : (statusFilter as CareerClaimStatus),
      kind: kindFilter === ALL ? undefined : (kindFilter as CareerClaimKind),
    }),
    [statusFilter, kindFilter],
  );

  const load = useCallback(async () => {
    setPageError(null);
    try {
      // The counts come from the CLAIMS response (whole-profile, filter-independent) and
      // the profile from the PROFILE response; asking for both means the counter and the
      // list cannot be from different moments.
      const [claimsResponse, profileResponse, sourcesResponse] = await Promise.all([
        // EVERY claim, not just the API's default page. The page derives each entry's
        // "filed here" count from this list, so a cap silently reports zero under entries
        // whose statements happen to be older than the page boundary.
        careerApi.getClaims({ ...query, limit: 500 }),
        careerApi.getProfile(),
        careerApi.getSources(),
      ]);
      setClaims(claimsResponse.claims);
      setCounts(claimsResponse.counts);
      setProfile(profileResponse);
      setSources(sourcesResponse.sources);
    } catch (caught) {
      setPageError(messageFor(caught, 'Your career profile could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Best-effort: the "already uploaded" list is a convenience, and a failure here must
    // not take the verification list down with it.
    uploadedFilesApi
      .list()
      .then((files) => setUploadedFiles(files))
      .catch(() => setUploadedFiles([]));
  }, []);

  /**
   * All six entity lists, in one round trip.
   *
   * `Promise.all` rather than six sequential awaits, and a per-kind catch rather than one:
   * "the skills list could not be loaded" must not blank the roles, educations and projects a
   * user has already entered. The server answers an empty list for a profile that does not
   * exist, so this needs no special case for "no profile yet".
   */
  const loadEntities = useCallback(async () => {
    setEntitiesBusy(true);
    const results = await Promise.all(
      CAREER_ENTITY_KINDS.map(async (kind) => {
        try {
          return (await careerApi.listEntities(kind)).entities;
        } catch {
          return null;
        }
      }),
    );
    setEntities((current) => {
      const next = { ...current };
      CAREER_ENTITY_KINDS.forEach((kind, index) => {
        const rows = results[index];
        if (rows !== null) next[kind] = rows;
      });
      return next;
    });
    setEntitiesBusy(false);
  }, []);

  useEffect(() => {
    void loadEntities();
  }, [loadEntities]);

  /**
   * Run one entity call, then RE-READ both lists.
   *
   * Re-read rather than patch in place, for the same reason every decision on this page does:
   * an attach can be REFUSED (409 - a rejected statement, or a pairing the model does not
   * intend) and a list the user is about to act on must show what the database says.
   */
  const runEntityCall = useCallback(
    async (
      kind: CareerEntityKind,
      action: () => Promise<string | void>,
      failure: string,
    ): Promise<void> => {
      setEntitiesBusy(true);
      setEntityErrors((current) => {
        const next = { ...current };
        delete next[kind];
        return next;
      });
      setEntityNote(null);
      try {
        const note = await action();
        if (typeof note === "string") setEntityNote(note);
        await Promise.all([loadEntities(), load()]);
      } catch (caught) {
        setEntityErrors((current) => ({
          ...current,
          [kind]: messageFor(caught, failure),
        }));
      } finally {
        setEntitiesBusy(false);
      }
    },
    [load, loadEntities],
  );

  const runDecision = useCallback(
    async (claimId: string, action: () => Promise<unknown>, failure: string) => {
      setBusyClaimId(claimId);
      setRowErrors((current) => {
        const next = { ...current };
        delete next[claimId];
        return next;
      });
      try {
        await action();
        await load();
      } catch (caught) {
        setRowErrors((current) => ({
          ...current,
          [claimId]: messageFor(caught, failure),
        }));
      } finally {
        setBusyClaimId(null);
      }
    },
    [load],
  );

  const handlers: ClaimDecisionHandlers = useMemo(
    () => ({
      onConfirm: (claim, input) =>
        runDecision(
          claim.id,
          () => careerApi.confirmClaim(claim.id, input),
          'The statement was not confirmed.',
        ),
      onReject: (claim, input) =>
        runDecision(
          claim.id,
          () => careerApi.rejectClaim(claim.id, input),
          'The statement was not rejected.',
        ),
      onReopen: (claim) =>
        runDecision(claim.id, () => careerApi.reopenClaim(claim.id), 'The statement was not reopened.'),
      onEdit: (claim, input) =>
        runDecision(
          claim.id,
          () => careerApi.createClaim({ id: claim.id, statement: input.statement, confirm: input.confirm }),
          'The wording was not saved.',
        ),
    }),
    [runDecision],
  );

  const onImported = useCallback((_result: CareerImportResult) => {
    void load();
  }, [load]);

  const entityHandlers = useMemo(
    () => ({
      onCreate: (kind: CareerEntityKind, input: EntityWriteBody) =>
        runEntityCall(kind, () => careerApi.createEntity(kind, input).then(() => undefined), "The entry was not added."),
      onUpdate: (kind: CareerEntityKind, id: string, patch: EntityWriteBody) =>
        runEntityCall(kind, () => careerApi.updateEntity(kind, id, patch).then(() => undefined), "The entry was not saved."),
      onRemove: (kind: CareerEntityKind, id: string) =>
        runEntityCall(kind, async () => {
          const removed: CareerEntityDeleteResult = await careerApi.deleteEntity(kind, id);
          // The statements are kept; this says how many lost their placement, because "the
          // entry is gone" would not tell the user what happened to the facts under it.
          return removed.detachedClaims === 0
            ? "Entry removed."
            : `Entry removed. ${removed.detachedClaims} statement${removed.detachedClaims === 1 ? "" : "s"} kept, but no longer filed under an entry, so the resume will not place ${removed.detachedClaims === 1 ? "it" : "them"}.`;
        }, "The entry was not removed."),
      onReorder: (kind: CareerEntityKind, patches: EntityReorderPatch[]) =>
        runEntityCall(
          kind,
          async () => {
            // Sequential, and each one is its own call: a partial failure leaves a real order
            // that the next visit re-reads, which is better than a bulk endpoint that either
            // renumbers everything or nothing.
            for (const patch of patches) {
              await careerApi.updateEntity(kind, patch.id, { sortOrder: patch.sortOrder });
            }
            return "Order saved.";
          },
          "The new order was not saved.",
        ),
      onAttach: (claimId: string, kind: CareerEntityKind, entityId: string) =>
        runEntityCall(
          kind,
          () => careerApi.attachClaim(claimId, { kind, entityId }).then(() => "Statement filed under that entry."),
          "The statement was not filed under that entry.",
        ),
      onDetach: (claimId: string, kind: CareerEntityKind, entityId: string) =>
        runEntityCall(
          kind,
          () =>
            careerApi.detachClaim(claimId, { kind, entityId }).then((result) =>
              result.changed
                ? "Statement taken out. It is kept, and keeps its status."
                : "Nothing to do: that statement was not filed under this entry.",
            ),
          "The statement was not taken out.",
        ),
    }),
    [runEntityCall],
  );

  const addStatement = useCallback(async () => {
    const statement = newStatement.trim();
    if (statement.length === 0) return;
    setBusyClaimId('__new__');
    try {
      // Created UNCONFIRMED: typing a fact is not verifying it. The wizard's own copy says
      // so, and the row appears in the list with the "Inferred" badge until confirmed.
      await careerApi.createClaim({ kind: newKind, statement });
      setNewStatement('');
      await load();
    } catch (caught) {
      setPageError(messageFor(caught, 'The statement was not added.'));
    } finally {
      setBusyClaimId(null);
    }
  }, [load, newKind, newStatement]);

  // The summary rail reads only what this page already holds: the entity lists and the
  // whole-profile claim counts. Nothing is inferred, and no number is derived from another.
  const confirmedClaims = counts?.user_confirmed ?? 0;
  const unconfirmedClaims = counts?.unconfirmed ?? 0;

  return (
    <PageShell
      title="Profile"
      width="data"
      toolbar={
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="career-status-filter" className="text-xs2">
              Status
            </Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger id="career-status-filter" className="h-9 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {CLAIM_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {statusPresentation(status).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="career-kind-filter" className="text-xs2">
              Kind
            </Label>
            <Select value={kindFilter} onValueChange={setKindFilter}>
              <SelectTrigger id="career-kind-filter" className="h-9 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All kinds</SelectItem>
                {CLAIM_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {kindLabel(kind)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        </div>
      }
    >
      <ProfileSectionTabs />
      <SectionView
        title="Career Profile"
        description="Everything here starts unconfirmed. A claim can only enter a resume after you confirm it."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <aside className="lg:order-2 lg:sticky lg:top-6 lg:self-start">
          <section className="surface-card p-5" aria-labelledby="career-summary-title">
            <h2 id="career-summary-title" className="section-title">Summary</h2>
            <div className="mt-2 border-t border-rule" />
            <dl className="mt-3 space-y-2 text-sm">
              {CAREER_ENTITY_KINDS.map((kind) => (
                <div key={kind} className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-3">{ENTITY_SUMMARY_LABELS[kind]}</dt>
                  <dd className="num text-ink">{entities[kind].length}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 border-t border-rule pt-3">
              <h3 className="section-label">Statements</h3>
              <dl className="mt-2 space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-3">Confirmed</dt>
                  <dd className="num text-ink">{confirmedClaims}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-3">Unconfirmed</dt>
                  <dd className="num text-ink">{unconfirmedClaims}</dd>
                </div>
              </dl>
            </div>
            <div className="mt-4 flex flex-col items-start gap-2 border-t border-rule pt-3 text-sm">
              <a href="#career-entries" className="text-ink-2 underline underline-offset-2 hover:text-ink">
                Add entry
              </a>
              <a href="#career-statements" className="text-ink-2 underline underline-offset-2 hover:text-ink">
                Confirm pending
              </a>
            </div>
          </section>
        </aside>

        <div className="min-w-0 space-y-6 lg:order-1">
        {pageError ? (
          <Alert variant="destructive">
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>
              {pageError}{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => void load()}
              >
                Retry
              </button>
            </AlertDescription>
          </Alert>
        ) : null}

        {entityNote ? (
          <Alert>
            <AlertDescription>{entityNote}</AlertDescription>
          </Alert>
        ) : null}

        <section id="career-entries">
  <h2 className="section-title">Your entries</h2>
  <div className="mt-2 border-t border-rule" />
  <p className="mt-3 text-sm text-ink-3">The resume is projected from these entries: a statement only appears on the page once it is
              filed under one. Nothing here is inferred for you - every field is yours to type, and
              filing a statement is not a confirmation.</p>
  <div className="mt-3 space-y-4">
            {CAREER_ENTITY_KINDS.map((kind) => (
              <EntityList
                key={kind}
                kind={kind}
                entities={entities[kind]}
                claims={claims}
                busy={entitiesBusy}
                error={entityErrors[kind] ?? null}
                {...entityHandlers}
              />
            ))}
          </div>
        </section>

        <StatusCounter claims={claims} counts={counts} sourcesCount={sources.length} />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="space-y-6">
            <ImportWizard
              profileId={profile?.profile?.id ?? null}
              uploadedFiles={uploadedFiles}
              onImported={onImported}
            />

            <section className="surface-card p-5">
  <h2 className="section-title">Add a statement yourself</h2>
  <div className="mt-2 border-t border-rule" />
  <p className="mt-3 text-sm text-ink-3">Typed statements are recorded as yours, but they still start unconfirmed.</p>
  <div className="mt-3 space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="career-new-kind" className="text-xs2">
                    Kind
                  </Label>
                  <Select
                    value={newKind}
                    onValueChange={(value) => setNewKind(value as CareerClaimKind)}
                  >
                    <SelectTrigger id="career-new-kind" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CLAIM_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {kindLabel(kind)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="career-new-statement" className="text-xs2">
                    Statement
                  </Label>
                  <Input
                    id="career-new-statement"
                    value={newStatement}
                    placeholder="e.g. Reduced p99 latency by 40%"
                    onChange={(event) => setNewStatement(event.target.value)}
                  />
                </div>
                <Button
                  size="sm"
                  disabled={newStatement.trim().length === 0 || busyClaimId === '__new__'}
                  onClick={() => void addStatement()}
                >
                  {busyClaimId === '__new__' ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  Add as unconfirmed
                </Button>
              </div>
            </section>

            <section className="surface-card p-5">
  <h2 className="section-title">Where these came from</h2>
  <div className="mt-2 border-t border-rule" />
  <p className="mt-3 text-sm text-ink-3">Each import is recorded so you can see which file produced which
                  statements.</p>
  <div className="mt-3 ">
                {sources.length === 0 ? (
                  <p className="text-sm text-ink-3">
                    No sources yet. Import a file to create one.
                  </p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {sources.map((source) => (
                      <li key={source.id} className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-ink">{source.title}</span>
                        <span className="shrink-0 text-xs2 text-ink-3">
                          {source.kind}
                          {source.byteSize !== null ? ` - ${Math.round(source.byteSize / 1024)} KB` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          <div id="career-statements" className="surface-card space-y-3 p-5">
            <h2 className="section-title">Check each statement</h2>
            <div className="border-t border-rule" />
            {loading ? (
              <p className="flex items-center gap-2 text-sm text-ink-3">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Loading your statements
              </p>
            ) : (
              <ClaimList
                claims={claims}
                busyClaimId={busyClaimId}
                errors={rowErrors}
                handlers={handlers}
              />
            )}
          </div>
        </div>
        </div>
      </div>
    </PageShell>
  );
}