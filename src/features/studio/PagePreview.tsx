// PagePreview.tsx - the A4 preview, which is the TYPESETTER'S OUTPUT (T1050; ADR-037 item 3).
//
// THE ONE RULE THIS COMPONENT EXISTS TO KEEP. The preview is the artifact `POST
// /resumes/:id/render` produced, streamed from `GET /resumes/:id/documents/:docId` and
// displayed. It is NOT a re-layout of the same content in the browser. There is exactly one
// layout authority, so the page a user sees while editing cannot drift from the page that
// prints - and the alternative (a CSS mirror of the template) is precisely what this program
// has been deleting.
//
// CONSEQUENCES THAT ARE NOT NEGOTIABLE HERE:
//   - there is NO local layout of the document in this file, and none may be added. The
//     source-level assertion in `pagePreview.test.ts` is what holds that line.
//   - when the render path is unavailable - the render flag off, no render port installed, the
//     broker down, the pre-render gate refusing the revision, any machine error - the
//     component shows THE MACHINE'S OWN REASON, verbatim, in an empty state. It does not draw
//     a placeholder "resume" and it does not fall back to anything. A fake preview would be
//     worse than no preview: it would let a user believe a blocked resume was ready to send.
//
// THE BYTES ARE FETCHED HERE; THE PAGES ARE PAINTED BY `PdfPages`. The pdf.js rasteriser is a
// shared component (`PdfPages.tsx`) so the Studio preview and the application workspace use
// the same parser and the same canvases. It paints the artifact; it never lays out the resume
// JSON. The bytes are still fetched through the same authenticated client as everything else.
//
// THE GATE IS SURFACED, NOT HIDDEN. A blocked revision answers 409 with `code` and `reason`
// from `career/claimUsage.ts`. That reason - "confirm these claims" - is the most important
// thing this component can tell a user, so it is rendered as text with the claim count, not
// collapsed into a generic "preview unavailable".

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { studioApi, renderPortRefusal } from '@/services/api/studio';
import type { ResumeDocumentJson } from '@/services/api/studio';
import { PdfPages } from './PdfPages';

/** The toolbar's zoom range. `fit width` supplies the base scale; these are relative steps. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;

/**
 * A burst of dependency changes (mount plus the resolved template/document) must spend ONE
 * render, not one per change: the broker admits only two renders and one per user, and the
 * page would otherwise refuse its own second request with `RENDER_BUSY`.
 */
const RENDER_DEBOUNCE_MS = 300;

/** The broker's own backoff, in order. Three retries after the first attempt. */
const RENDER_BUSY_RETRY_DELAYS_MS = [1200, 2400, 4800] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface PagePreviewProps {
  resumeId: string | null;
  /** The revision to render. `null` while nothing has been saved yet. */
  revisionId: string | null;
  /** The revision number. Kept in the props so callers need not know the caption is gone. */
  revisionNumber: number | null;
  /** The document being edited. Unused by the panel; kept as a stable prop surface. */
  document: ResumeDocumentJson | null;
  /**
   * The selected template. SENT, as a render-time choice and nothing more: it is a member of
   * the render request, never of the document, so switching it produces a different ARTIFACT
   * of the SAME revision rather than a new revision with a different hash. The caption below
   * still reports which template the bytes came from, read back from the `ResumeDocument`
   * row, so a refusal or a substitution is visible rather than implied.
   */
  templateId: string;
  /**
   * Reports the machine code of the last refusal (or `null` after a success), so the page can
   * offer the template picker the server's own code. The reason is NOT passed up because
   * `apiClient` does not surface the body `reason` (see `renderPortRefusal`).
   */
  onRefusal?: (code: string | null) => void;
  /**
   * The downloadable artifact, when one is ready. The Studio's top bar uses this to offer the
   * same download as the slim preview toolbar without fetching the bytes twice. `null` while
   * nothing is ready, so the top-bar action is disabled rather than pointing at a stale file.
   */
  onArtifact?: (artifact: { url: string; filename: string } | null) => void;
}

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      /** The broker refused with `RENDER_BUSY`; a retry is scheduled. Not an error to show. */
      kind: 'retrying';
      attempt: number;
    }
  | {
      kind: 'ready';
      bytes: Blob;
      objectUrl: string;
      pageCount: number | null;
      /** The `templateId` the `ResumeDocument` row recorded for these bytes. */
      renderedTemplateId: string | null;
      hash: string;
    }
  | {
      /**
       * The HTTP render limiter answered 429. Retrying cannot help (the client maps 429 to
       * RENDER_BUSY, so the broker backoff would spin against a per-minute budget), so this is
       * a quiet stop, distinct from a broker-busy retry.
       */
      kind: 'paused';
    }
  | {
      kind: 'unavailable';
      code: string;
      reason: string | null;
      message: string;
      /** `true` when the failure was the pre-render gate, which is fixable in the Studio. */
      gate: boolean;
    };

export function PagePreview({
  resumeId,
  revisionId,
  templateId,
  onRefusal,
  onArtifact,
}: PagePreviewProps) {
  const [state, setState] = useState<PreviewState>({ kind: 'idle' });
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pdfPages, setPdfPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const objectUrlRef = useRef<string | null>(null);
  /** False after unmount, so an in-flight load can dispose what it just created. */
  const mountedRef = useRef(false);
  /**
   * The newest request wins: a slower older attempt (including one still waiting out a
   * `RENDER_BUSY` backoff) must not install itself over a newer request.
   */
  const requestIdRef = useRef(0);
  /** Pending timers, cleared when a new request starts or the component unmounts. */
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set below; retries re-enter `render` through it without a self-referential callback. */
  const renderRef = useRef<(attempt?: number) => Promise<void>>(async () => {});
  /**
   * Callback refs, not dependencies of `render`: the preview must not re-render the artifact
   * because the parent handed it new inline functions. `onRefusal` in particular reports back
   * to the Studio, whose state update re-renders the parent and would otherwise hand back a
   * new function forever (the render loop).
   */
  const onArtifactRef = useRef(onArtifact);
  onArtifactRef.current = onArtifact;
  const onRefusalRef = useRef(onRefusal);
  onRefusalRef.current = onRefusal;
  /**
   * The auto-render key already spent. The effect below keys only on the triple, so a parent
   * re-render cannot re-request; this guard also stops a remount/re-run of the effect with the
   * same triple from spending a second render (only the Reload button resets it).
   */
  const lastAutoKeyRef = useRef<string | null>(null);

  const release = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  // Release the downloaded artifact's object URL on unmount. The pdf.js document belongs to
  // `PdfPages`, which destroys it on its own unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      release();
    };
  }, [release]);

  // Publish the current artifact to the page, and withdraw it the moment the preview stops
  // being ready. The object URL is created above and lives until the next render or unmount, so
  // the top-bar link is always a link to the bytes currently shown.
  useEffect(() => {
    if (state.kind !== 'ready') {
      onArtifactRef.current?.(null);
      return;
    }
    onArtifactRef.current?.({
      url: state.objectUrl,
      filename: `resume-${state.hash.slice(0, 8)}.pdf`,
    });
    return () => onArtifactRef.current?.(null);
  }, [state]);

  const render = useCallback(
    async (attempt = 0) => {
      if (!resumeId) return;
      // A new request supersedes anything queued or waiting out a backoff: only the newest
      // request may install its result.
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      const token = requestIdRef.current + 1;
      requestIdRef.current = token;
      // A request that is no longer the newest, or whose component is gone, must not install
      // its result. It still disposes anything it created before returning.
      const current = () => mountedRef.current && token === requestIdRef.current;
      setState({ kind: 'loading' });
      setPdfPages(0);
      setCurrentPage(1);
      try {
        const result = await studioApi.renderRevision(resumeId, {
          format: 'pdf',
          ...(revisionId ? { revisionId } : {}),
          templateId,
        });
        if (!current()) return;
        const bytes = await studioApi.downloadDocument(resumeId, result.documentId);
        if (!current()) return;
        const objectUrl = URL.createObjectURL(bytes);
        // The previous object URL is released only here, when a new one replaces it.
        release();
        objectUrlRef.current = objectUrl;
        // The row's own page count and template, read back rather than assumed: the artifact's
        // identity is the only honest source for "how many pages" and "which template". The
        // rendered page count is completed by `PdfPages` once it has parsed the bytes.
        const documents = await studioApi.listDocuments(resumeId).catch(() => []);
        if (!current()) {
          if (objectUrlRef.current === objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrlRef.current = null;
          }
          return;
        }
        const row = documents.find((entry) => entry.id === result.documentId);
        setPageCount(row?.pageCount ?? null);
        setState({
          kind: 'ready',
          bytes,
          objectUrl,
          pageCount: row?.pageCount ?? null,
          renderedTemplateId: row?.templateId ?? null,
          hash: result.hash,
        });
        onRefusalRef.current?.(null);
      } catch (caught) {
        if (!current()) return;
        const refusal = renderPortRefusal(caught);
        // A 429 is the HTTP per-user render budget, NOT the broker's admission refusal: the
        // client folds both into RENDER_BUSY, so the status code is the only distinction.
        // Retrying a spent budget just spends more attempts, so stop quietly and stop here.
        if ((caught as { statusCode?: number } | null)?.statusCode === 429) {
          release();
          setState({ kind: 'paused' });
          return;
        }
        if (
          refusal.code === 'RENDER_BUSY' &&
          attempt < RENDER_BUSY_RETRY_DELAYS_MS.length
        ) {
          // The broker is busy, not broken. Keep the quiet retrying status and try again on
          // its own backoff instead of showing the red "no preview" gate for a transient refusal.
          setState({ kind: 'retrying', attempt: attempt + 1 });
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            void renderRef.current(attempt + 1);
          }, RENDER_BUSY_RETRY_DELAYS_MS[attempt]);
          return;
        }
        release();
        setState({
          kind: 'unavailable',
          code: refusal.code,
          reason: refusal.reason ?? null,
          message: refusal.message,
          gate: refusal.code === 'PRE_RENDER_GATE_BLOCKED',
        });
        onRefusalRef.current?.(refusal.code);
      }
    },
    [release, resumeId, revisionId, templateId],
  );
  renderRef.current = render;

  // A new revision is the "live" part of 06 E.11 flow 4: the preview follows the last save.
  // Deliberately keyed on the REVISION, not on the document - an unsaved keystroke must not
  // spend a render, and the render is the expensive call in this stack. The TEMPLATE is in the
  // key too, because switching it is a render request in its own right: the cache makes a
  // second template a second artifact, so the preview has to ask for it to show it.
  // The effect is DEBOUNCED: mount plus the arrival of the resolved document/template is a
  // burst, and rendering once per change is what collided with the broker's per-user limit.
  // It is keyed ONLY on the triple below - never on `render` or a parent callback - and the
  // `lastAutoKeyRef` guard makes sure a given triple is auto-rendered at most once. Repeating
  // it is the explicit Reload button's job (which calls `render` directly).
  useEffect(() => {
    if (!resumeId || !revisionId) return;
    const key = `${resumeId}\u0000${revisionId}\u0000${templateId}`;
    if (lastAutoKeyRef.current === key) return;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      lastAutoKeyRef.current = key;
      void renderRef.current();
    }, RENDER_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [resumeId, revisionId, templateId]);

  const totalPages = pdfPages || pageCount || 1;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="studio-page-preview">
      <div className="flex items-start justify-between gap-2">
        <h3 className="section-label">A4 preview</h3>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 shrink-0 px-0"
          aria-label="Render preview"
          title="Render preview"
          disabled={!resumeId || state.kind === 'loading'}
          onClick={() => void render()}
        >
          {state.kind === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>

      {state.kind === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Rendering A4 pages with the typesetter
        </p>
      ) : null}

      {state.kind === 'retrying' ? (
        <p className="text-xs2 text-ink-3" role="status">
          Renderer busy - retrying...
        </p>
      ) : null}

      {state.kind === 'paused' ? (
        <p className="text-xs2 text-ink-3" role="status">
          Preview paused - too many renders. Reload in a minute.
        </p>
      ) : null}

      {state.kind === 'ready' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {state.renderedTemplateId && state.renderedTemplateId !== templateId ? (
            <Alert>
              <AlertTitle>Rendered with a different template</AlertTitle>
              <AlertDescription>
                You selected {templateId}; these bytes were rendered with {state.renderedTemplateId}.
                The template is a render-time choice, so your document and its revision hash are
                unchanged either way.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-control border border-rule bg-paper shadow-e1">
            {/* Our own slim toolbar: the browser PDF chrome never appears in this pane. */}
            <div className="flex flex-wrap items-center gap-1 border-b border-rule bg-paper px-2 py-1.5 text-[13px]">
              <span className="num min-w-[72px] px-1.5 text-ink-2">
                Page {currentPage} / {totalPages}
              </span>
              <span className="mx-0.5 h-5 w-px bg-rule" aria-hidden="true" />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 px-0"
                aria-label="Zoom out"
                title="Zoom out"
                disabled={zoom <= ZOOM_MIN}
                onClick={() => setZoom((value) => clamp(Math.round(value * 10 - 1) / 10, ZOOM_MIN, ZOOM_MAX))}
              >
                <Minus className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <span className="px-1 text-ink-3">Zoom</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 px-0"
                aria-label="Zoom in"
                title="Zoom in"
                disabled={zoom >= ZOOM_MAX}
                onClick={() => setZoom((value) => clamp(Math.round(value * 10 + 1) / 10, ZOOM_MIN, ZOOM_MAX))}
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button
                variant={fitWidth ? 'default' : 'outline'}
                size="sm"
                className="h-8 text-[13px]"
                aria-pressed={fitWidth}
                onClick={() => setFitWidth((value) => !value)}
              >
                Fit width
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 px-0"
                aria-label="Reload preview"
                title="Reload preview"
                onClick={() => {
                  lastAutoKeyRef.current = null;
                  void render();
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
              <Button asChild variant="outline" size="sm" className="ml-auto h-8 text-[13px]">
                <a
                  href={state.objectUrl}
                  download={`resume-${state.hash.slice(0, 8)}.pdf`}
                  aria-label="Download PDF"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Download PDF
                </a>
              </Button>
            </div>
            <PdfPages
              bytes={state.bytes}
              fitWidth={fitWidth}
              zoom={zoom}
              testId="studio-preview-pages"
              loadingLabel="Drawing the typesetter's pages"
              onPageCount={setPdfPages}
              onVisiblePage={setCurrentPage}
            />
          </div>
          <p className="num text-xs2 text-ink-3">artifact hash {state.hash.slice(0, 8)}</p>
        </div>
      ) : null}

      {state.kind === 'unavailable' ? (
        <Alert variant={state.gate ? 'default' : 'destructive'}>
          <AlertTitle className="flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {state.gate ? 'The pre-render gate refused this revision' : 'No preview available'}
          </AlertTitle>
          <AlertDescription className="space-y-1">
            {/* The machine's words, not a paraphrase. */}
            {/* deslop-ignore-next-line 34 — an error code is machine text, not terminal styling. */}
            <p className="font-mono text-xs2 text-ink-2">{state.code}</p>
            {/* deslop-ignore-next-line 34 — the server's own refusal reason, verbatim. */}
            {state.reason ? <p className="font-mono text-xs2 text-ink-3">{state.reason}</p> : null}
            <p>{state.message}</p>
            {state.gate ? (
              <p>
                Nothing is drawn here on purpose: a preview drawn by this page would be a
                different layout from the one you would send. Confirm the statements on the
                Career Evidence page, then render again.
              </p>
            ) : (
              <p>
                Nothing is drawn here on purpose: a hand-drawn page would not be the typesetter's
                output, and showing one would misrepresent what you would send.
              </p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {state.kind === 'idle' ? (
        <p className="text-xs2 text-ink-3">
          Save a revision and the preview renders it here with the typesetter. Until a render
          exists there is nothing to show - this page never draws a layout of its own.
        </p>
      ) : null}
    </div>
  );
}

export default PagePreview;
