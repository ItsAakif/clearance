// Studio.tsx - the Resume Studio page (T1050; 06 E.11 flows 4-5; ADR-037).
//
// T1110 (cutover): THE STUDIO IS THE EDITOR. The legacy builder at `/app/build` is deleted
// (FREEZE A-24) and `/app/build*` now redirects here, so the `v2ResumeStudio` gate this page
// used to be behind is gone from `src/App.tsx`: the route is registered unconditionally. There
// is no longer a flag state in which this page should be unreachable, because there is no
// longer a page behind it. The flag key itself stays in `src/lib/flags.ts` because
// `flags.test.ts` asserts the two runtimes name the same three keys.
//
// TWO MODES, ONE PAGE. With a `:resumeId` it edits that resume. Without one it is the CHOOSER:
// the only way a `modelVersion: 2` resume comes into existence is `POST /resumes/from-profile`
// (the enabler this task added to `routes/resumes.ts`), so the chooser is where a user creates
// their first V2 resume and opens an existing one. That is not scope creep: without it the
// Studio is unreachable, because nothing else in the application can make the row.
//
// THE DATA PATH, END TO END, AND WHAT EACH STEP PROVES:
//   1. `GET /resumes/:id/revisions` (oldest first) -> open the NEWEST revision. The document
//      being edited is therefore a snapshot the server already hashed, never something this
//      page invented.
//   2. The document becomes a `StudioModel` (see `blockModel.ts`); the editor mutates the
//      MODEL and only `serialize` turns it back into a document.
//   3. Autosave POSTs `/resumes/:id/revisions`. That route ALWAYS creates revision N+1 and
//      never updates an existing row (`resume/revisions.ts#createRevision` inserts and never
//      updates), so an edit cannot mutate history. There is no other write in this page.
//   4. The preview asks the TYPESETTER for the artifact. This page never draws a layout.
//
// WHY EDITS ARE NOT SENT ON EVERY KEYSTROKE. A save is a revision: an immutable snapshot with an
// audit row and a hash. Text fields therefore commit on blur, and autosave fires once per
// committed change after a short debounce. Typing a sentence should not produce forty revisions.
//
// THE GATE IS SHOWN, NOT SATISFIED. A revision that quotes an unconfirmed claim cannot be
// rendered, and this page says so with the server's own reason rather than hiding it: the empty
// state in 06 E.11 flow 1 is "nothing confirmed yet - a resume built now would be empty", and
// the Studio is where that sentence has to be true.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, Check, Download, Loader2, Pencil, Save } from 'lucide-react';
import { PageShell } from '@/components/layout/PageShell';
import { SectionView } from '@/components/layout/SectionView';
import { ResumeSectionTabs } from '@/components/layout/SectionTabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ApiClientError } from '@/services/api/client';
import { resumeApi } from '@/services/api/resume';
import {
  X_CLEARANCE_KEY,
  studioApi,
  type ResumeDocumentJson,
  type StudioRevision,
} from '@/services/api/studio';
import { StructureEditor, type StudioSection } from '@/features/studio/StructureEditor';
import { StudioNav } from '@/features/studio/StudioNav';
import { ImportResumeDialog } from '@/features/studio/ImportResumeDialog';
import { PagePreview } from '@/features/studio/PagePreview';
import { TemplateDialog } from '@/features/studio/TemplateDialog';
import {
  assertStatusUnchanged,
  documentProblems,
  editInlineValue,
  modelFromDocument,
  serialize,
  type InlineValue,
  type StudioModel,
} from '@/features/studio/blockModel';
import {
  INITIAL_SAVE_STATE,
  beginSave,
  markDirty,
  revisionIdentity,
  saveFailed,
  saveIndicator,
  saveSucceeded,
  shouldOfferSave,
  type StudioSaveState,
} from '@/features/studio/autosave';
import { DEFAULT_TEMPLATE_ID, findTemplate, resolveStudioTemplateId } from '@/features/studio/templates';

/** How long after the last committed edit autosave fires. Long enough to coalesce a burst. */
const AUTOSAVE_DELAY_MS = 1200;

function messageFor(caught: unknown, fallback: string): string {
  if (caught instanceof ApiClientError) {
    // The server's own words, code included when it sent one. A paraphrase here would be the
    // one place a machine reason gets lost, and the gate's reason is the point of it.
    return caught.code ? `${caught.message} (${caught.code})` : caught.message;
  }
  return fallback;
}

/**
 * The top bar's one-line status. `saved` names the revision it is describing, because "saved"
 * without a number is a claim the user cannot check. Every other state says what is true now:
 * the autosave indicator already words it, so only the clean case is re-worded here.
 */
function topBarStatus(state: StudioSaveState, label: string): string {
  if (state.status === 'saved' && state.savedRevisionNumber !== null) {
    return `Revision ${state.savedRevisionNumber} · saved`;
  }
  return label;
}

// ---------------------------------------------------------------------------
// The chooser: how a V2 resume comes to exist
// ---------------------------------------------------------------------------

function StudioChooser() {
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState('');
  const [resumeId, setResumeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const create = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const result = await studioApi.createFromProfile(name.trim() ? { name: name.trim() } : {});
      navigate(`/app/studio/${result.resume.id}`);
    } catch (caught) {
      setError(
        messageFor(
          caught,
          'The resume could not be created. A career profile with at least one statement has to exist first.',
        ),
      );
    } finally {
      setCreating(false);
    }
  }, [name, navigate]);

  return (
    <PageShell title="Resumes" width="prose">
      <ResumeSectionTabs />
      <SectionView
        title="Resume Studio"
        description="Edit the resume as structured blocks. The A4 page you see is rendered by the typesetter, not by this page."
      />
      <div className="space-y-6">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Nothing to edit yet</AlertTitle>
            <AlertDescription>
              {error}{" "}
              <Link className="underline underline-offset-2" to="/app/profile">
                Go to the Career record
              </Link>{" "}
              to import a resume or confirm a statement, then come back.
            </AlertDescription>
          </Alert>
        ) : null}

        <section className="surface-card p-5">
          <h2 className="section-title">Start from your career profile</h2>
          <div className="mt-2 border-t border-rule" />
          <p className="mt-3 text-sm text-ink-3">
            This creates a new resume whose first revision is projected from your profile and its
            claims. Nothing is confirmed by creating it: statements you have not confirmed are
            recorded as unconfirmed, and the pre-render gate will refuse to render them until you
            do.
          </p>
          <div className="mt-3 space-y-1">
            <label htmlFor="studio-new-name" className="block text-xs2 font-medium text-ink-2">
              Name (optional)
            </label>
            <Input
              id="studio-new-name"
              value={name}
              placeholder="e.g. Backend engineer - 2026"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button className="mt-3" disabled={creating} onClick={() => void create()}>
            {creating ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Save className="mr-1.5 h-4 w-4" aria-hidden="true" />
            )}
            Create and open
          </Button>
        </section>

        <section className="surface-card p-5">
          <h2 className="section-title">Open an existing resume</h2>
          <div className="mt-2 border-t border-rule" />
          <p className="mt-3 text-sm text-ink-3">
            Resume ids appear in the URL of a resume you have already opened.
          </p>
          {picking ? (
            <div className="mt-3 space-y-1">
              <label htmlFor="studio-resume-id" className="block text-xs2 font-medium text-ink-2">
                Resume id
              </label>
              <Input
                id="studio-resume-id"
                value={resumeId}
                onChange={(event) => setResumeId(event.target.value)}
              />
              <Button
                size="sm"
                disabled={resumeId.trim().length === 0}
                onClick={() => navigate(`/app/studio/${resumeId.trim()}`)}
              >
                Open
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setPicking(true)}>
              Open one by id
            </Button>
          )}
        </section>
      </div>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

function StudioEditor({ resumeId }: { resumeId: string }) {
  const [revision, setRevision] = useState<StudioRevision | null>(null);
  const [model, setModel] = useState<StudioModel | null>(null);
  const [saveState, setSaveState] = useState<StudioSaveState>(INITIAL_SAVE_STATE);
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);
  // Set when the USER picks a template. The resume-row fetch lands asynchronously, and a
  // server value must never overwrite a choice the user has already made on this resume.
  // Switching to a different resume resets it in the effect below, so that resume's stored
  // template wins again.
  const userPickedTemplate = useRef(false);
  const [refusalCode, setRefusalCode] = useState<string | null>(null);
  // Set when the resume's stored template is not a render-registry id and could not be
  // mapped. The page renders with the default and SAYS SO, rather than silently showing a
  // layout the row did not name.
  const [templateFallback, setTemplateFallback] = useState<{ storedId: string; id: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The rail selection. One section is rendered in the editor pane at a time; Contact and
  // Summary are the two halves of `basics`.
  const [section, setSection] = useState<StudioSection>('contact');
  // The resume row's display name. Read-only: the Studio API has no rename surface, and a
  // revision is the wrong place to store one.
  const [resumeName, setResumeName] = useState<string | null>(null);
  // The artifact `PagePreview` last produced, so the top bar can offer the same download as the
  // preview toolbar without fetching the bytes twice.
  const [pdfArtifact, setPdfArtifact] = useState<{ url: string; filename: string } | null>(null);
  // Below `lg` the two panes do not fit side by side, so one is shown at a time. `editor` is
  // the default because that is the work; the preview tab exists so it can take the full
  // viewport height on a phone instead of being stacked under the form.
  const [mobilePane, setMobilePane] = useState<'editor' | 'preview'>('editor');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The model autosave will serialise. A ref, so the debounced timer always reads the LATEST
  // model rather than the one captured when the timer was scheduled - otherwise an edit made
  // during an in-flight save would be silently dropped from the revision that follows it.
  const modelRef = useRef<StudioModel | null>(null);
  modelRef.current = model;

  // UPGRADE-ON-OPEN (T1110). Set when this load created the resume's FIRST V2 revision out of a
  // V1 row, so the page can say what just happened. The message is the whole point of the
  // feature: the user's content arrived as UNVERIFIED DRAFTS and the gate will refuse to render
  // them until they confirm them.
  const [upgraded, setUpgraded] = useState<{ claims: number } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    setUpgraded(null);
    try {
      const summaries = await studioApi.listRevisions(resumeId);
      if (summaries.length === 0) {
        // No revisions means one of two things, and the difference matters: a resume nobody has
        // ever opened in V2, or a `modelVersion = 1` row the legacy builder created. The second
        // is what `/app/build/:resumeId` now redirects here with, so the page ASKS the server to
        // project it rather than showing an empty editor - the server is the only place that can
        // tell those apart, and `upgrade` is idempotent, so calling it on the first case simply
        // reports the current revision back.
        //
        // The response already carries the DOCUMENT, so the created revision is opened straight
        // from it: re-reading it by number would be a second round trip to fetch bytes the
        // upgrade just sent.
        const result = await studioApi.upgrade(resumeId);
        if (!result.upgraded) {
          // `already_upgraded` with no revision is the one state nothing can open.
          setRevision(null);
          setModel(null);
          setLoadError(
            'This resume has no revisions yet, so there is nothing to edit. Create one from your career profile instead.',
          );
          return;
        }
        setUpgraded({ claims: result.claims?.total ?? 0 });
        const created: StudioRevision = {
          id: result.revision.id,
          resumeId,
          revisionNumber: result.revision.revisionNumber,
          jsonHash: result.revision.jsonHash,
          createdAt: result.revision.createdAt,
          createdBy: 'import',
          createdByUserId: null,
          reason: null,
          document: result.revision.document,
          gate: result.gate,
        };
        setRevision(created);
        setModel(modelFromDocument(created.document));
        setSaveState({
          ...INITIAL_SAVE_STATE,
          savedRevisionNumber: created.revisionNumber,
          savedJsonHash: created.jsonHash,
        });
        return;
      }
      // The list is OLDEST FIRST (a contract, not a default), so the newest is the last entry.
      const newest = summaries[summaries.length - 1];
      const full = await studioApi.getRevision(resumeId, newest.revisionNumber);
      setRevision(full);
      setModel(modelFromDocument(full.document));
      setSaveState({
        ...INITIAL_SAVE_STATE,
        savedRevisionNumber: full.revisionNumber,
        savedJsonHash: full.jsonHash,
      });
    } catch (caught) {
      setLoadError(messageFor(caught, 'This resume could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [resumeId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // The resume's row name is not part of a revision. It is read from the existing legacy resume
  // read route (no backend change) and shown read-only in the top bar. A failure is silent: the
  // editor still works, and a name is not worth an error banner.
  //
  // THE STORED TEMPLATE IS READ HERE TOO. `templateId` is a property of the RESUME row, not of
  // a revision, so initialising the picker from `DEFAULT_TEMPLATE_ID` (the old behaviour) showed
  // "Template: ATS classic" for a resume whose own template was `latex-medium-professional` and
  // rendered the default layout. The row is the source of truth; an id this build does not know
  // falls back to the default, exactly as `findTemplate` reports it.
  useEffect(() => {
    let live = true;
    userPickedTemplate.current = false;
    resumeApi
      .getById(resumeId)
      .then((resume) => {
        if (!live) return;
        setResumeName(resume.name);
        const resolved = resolveStudioTemplateId(resume.templateId);
        if (!userPickedTemplate.current) {
          setTemplateId(resolved.id);
        }
        setTemplateFallback(
          resolved.fellBack && resolved.storedId !== null
            ? { storedId: resolved.storedId, id: resolved.id }
            : null,
        );
      })
      .catch(() => {
        if (live) setResumeName(null);
      });
    return () => {
      live = false;
    };
  }, [resumeId]);

  /**
   * Autosave. ONE call, ONE new revision, and never a mutation of the one on the server.
   *
   * The two guards before the POST are not decoration:
   *   - `documentProblems` runs the belt's rule client-side, so a document the server would
   *     refuse (a claim-rail string no `x-clearance` entry names, a claim named twice) is
   *     reported with its PATH instead of being sent and coming back as an opaque 400;
   *   - `assertStatusUnchanged` proves the editor did not touch a status on its way here.
   */
  const save = useCallback(async () => {
    const current = modelRef.current;
    if (!current || !revision) return;
    const document = serialize(current);
    const problems = documentProblems(document);
    if (problems.length > 0) {
      setSaveState((state) => saveFailed(state, problems.join('; ')));
      return;
    }
    setSaveState((state) => beginSave(state));
    try {
      const created = await studioApi.createRevision(resumeId, document);
      assertStatusUnchanged(
        revision.document[X_CLEARANCE_KEY]?.claims ?? [],
        created.document[X_CLEARANCE_KEY]?.claims ?? [],
      );
      setRevision(created);
      setModel(modelFromDocument(created.document));
      setSaveState((state) =>
        saveSucceeded(state, { revisionNumber: created.revisionNumber, jsonHash: created.jsonHash }),
      );
    } catch (caught) {
      // The edits are STILL unsaved and the reason is kept verbatim. `saveFailed` cannot clear
      // `dirty`, so a refusal never leaves the page claiming to be saved.
      setSaveState((state) => saveFailed(state, messageFor(caught, 'The revision was not saved.')));
    }
  }, [revision, resumeId]);

  /** An edit: mark dirty, then schedule the autosave. The ONLY path into the model. */
  const applyEdit = useCallback(
    (next: StudioModel) => {
      setModel(next);
      setSaveState((state) => markDirty(state));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void save();
      }, AUTOSAVE_DELAY_MS);
    },
    [save],
  );

  const applySync = useCallback((next: StudioModel) => {
    // The profile sync is a bulk user action, not a keystroke: it marks the document dirty
    // so the user can review every imported field, but it does NOT schedule an autosave.
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setModel(next);
    modelRef.current = next;
    setSaveState((state) => markDirty(state));
  }, []);

  const onEditHighlight = useCallback(
    (input: { section: 'work' | 'projects'; blockId: string; highlightIndex: number; value: InlineValue }) => {
      const current = modelRef.current;
      if (!current) return;
      // Re-wording a statement goes through `applyEdit` like every other change, so the dirty
      // indicator and the autosave timer cannot be bypassed by editing a claim-backed line.
      applyEdit(editInlineValue(current, input).model);
    },
    [applyEdit],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const indicator = saveIndicator(saveState);
  const IndicatorIcon =
    indicator.icon === 'check'
      ? Check
      : indicator.icon === 'pencil'
        ? Pencil
        : indicator.icon === 'loader'
          ? Loader2
          : AlertTriangle;
  const document = useMemo<ResumeDocumentJson | null>(() => (model ? serialize(model) : null), [model]);

  return (
    <div className="flex min-h-full flex-col bg-paper" data-testid="studio-builder">
      <header className="sticky top-0 z-40 border-b border-rule bg-paper/95 backdrop-blur print:hidden">
        <div className="mx-auto flex min-h-16 w-full max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6 lg:h-16 lg:flex-nowrap lg:py-0">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink" title={resumeName ?? undefined}>
                {resumeName ?? 'Resume'}
              </p>
              <p
                className="flex min-w-0 items-center gap-1.5 text-xs2 text-ink-3"
                title={`${indicator.description} (${revisionIdentity(saveState)})`}
              >
                <IndicatorIcon
                  className={`h-3.5 w-3.5 shrink-0 ${indicator.icon === 'loader' ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span className="truncate font-medium text-ink-2">
                  {topBarStatus(saveState, indicator.label)}
                </span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!shouldOfferSave(saveState)} onClick={() => void save()}>
              <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Save as a new revision
            </Button>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Reload
            </Button>
            <ImportResumeDialog />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {pdfArtifact ? (
              <Button asChild variant="outline" size="sm">
                <a
                  href={pdfArtifact.url}
                  download={pdfArtifact.filename}
                  aria-label="Download PDF"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Download PDF
                </a>
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled
                title="The preview is not ready yet"
                aria-label="Download PDF"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Download PDF
              </Button>
            )}
            <TemplateDialog
              value={templateId}
              refusalCode={refusalCode}
              onChange={(next) => {
                userPickedTemplate.current = true;
                setTemplateId(next);
                setRefusalCode(null);
                setTemplateFallback(null);
              }}
            />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-4 sm:px-6">
        <div className="mb-4 space-y-3">
          {upgraded ? (
            <Alert>
              <AlertTitle>This resume was upgraded from the old builder</AlertTitle>
              <AlertDescription className="space-y-1">
                <p>
                  {upgraded.claims} statement{upgraded.claims === 1 ? '' : 's'} from your old resume
                  {upgraded.claims === 1 ? ' is' : ' are'} now recorded as unverified drafts.
                  Nothing was confirmed for you: the pre-render gate refuses to render them until
                  you confirm each one in the verification UI.
                </p>
                <p>
                  <Link className="underline underline-offset-2" to="/app/profile">
                    Review and confirm these statements
                  </Link>
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          {templateFallback ? (
            <Alert>
              <AlertTitle>The saved template is not available</AlertTitle>
              <AlertDescription>
                This resume's saved template{' '}
                <span className="font-mono text-xs2">{templateFallback.storedId}</span> is not a
                template this build can render. The preview is using{' '}
                {findTemplate(templateFallback.id)?.label ?? templateFallback.id}, the default
                template, so you can still see and edit the document.
              </AlertDescription>
            </Alert>
          ) : null}

          {loadError ? (
            <Alert variant="destructive">
              <AlertTitle>This resume could not be opened</AlertTitle>
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : null}

          {saveState.error ? (
            <Alert variant="destructive">
              <AlertTitle>Not saved - your edits are still here</AlertTitle>
              <AlertDescription className="space-y-1">
                <p>{saveState.error}</p>
                <p>
                  The newest revision on the server is still{" "}
                  {saveState.savedRevisionNumber === null
                    ? 'none'
                    : `revision ${saveState.savedRevisionNumber}`}
                  . Nothing you typed was lost, and nothing on the server was changed.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}

          {loading ? (
            <p className="flex items-center gap-2 text-sm text-ink-3">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading the newest revision
            </p>
          ) : null}
        </div>

        {model && revision ? (
          <>
            {/* The section strip spans the whole content width ABOVE the editor/preview grid.
                It used to live in the ~640px editor column at 1440px, where Skills and
                Certifications were clipped. It sticks under the 64px top bar (`top-14` plus
                the 8px offset padding keeps the pills clear of it) so switching sections
                never scrolls the page. */}
            <div className="z-30 -mx-4 mb-4 border-b border-rule bg-paper/95 px-4 backdrop-blur sm:-mx-6 sm:px-6 lg:sticky lg:top-14 lg:pt-2">
              <StudioNav model={model} section={section} onSelect={setSection} />
            </div>

            <div
              className="mb-4 flex w-full max-w-xs rounded-full border border-rule bg-paper-2 p-1 lg:hidden"
              role="tablist"
              aria-label="Studio panes"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mobilePane === 'editor'}
                onClick={() => setMobilePane('editor')}
                className={cn(
                  'h-8 flex-1 rounded-full text-[13px] font-medium transition-colors duration-150 ease-out',
                  mobilePane === 'editor'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-ink-3 hover:text-ink',
                )}
              >
                Editor
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobilePane === 'preview'}
                onClick={() => setMobilePane('preview')}
                className={cn(
                  'h-8 flex-1 rounded-full text-[13px] font-medium transition-colors duration-150 ease-out',
                  mobilePane === 'preview'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-ink-3 hover:text-ink',
                )}
              >
                Preview
              </button>
            </div>

            <div className="lg:grid lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:items-start lg:gap-6">
              <div
                className={cn(
                  'min-w-0',
                  mobilePane === 'editor' ? 'block' : 'hidden lg:block',
                )}
              >
                <div className="space-y-4">
                  <StructureEditor model={model} section={section} onChange={applyEdit} onSync={applySync} />
                </div>
              </div>

              <div
                className={cn(
                  'min-w-0 flex-col',
                  mobilePane === 'preview' ? 'flex' : 'hidden lg:flex',
                  // 104px = the 64px top bar plus the 40px sticky strip it now sits below.
                  'h-[calc(100vh-9rem)] min-h-[360px] lg:sticky lg:top-[6.5rem] lg:h-[calc(100vh-7.5rem)] lg:min-h-0',
                )}
              >
                <PagePreview
                  resumeId={resumeId}
                  revisionId={revision.id}
                  revisionNumber={revision.revisionNumber}
                  document={document}
                  templateId={templateId}
                  onRefusal={(code) => setRefusalCode(code)}
                  onArtifact={setPdfArtifact}
                />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

export default function Studio() {
  const { resumeId } = useParams<{ resumeId: string }>();
  if (!resumeId) return <StudioChooser />;
  return <StudioEditor resumeId={resumeId} />;
}