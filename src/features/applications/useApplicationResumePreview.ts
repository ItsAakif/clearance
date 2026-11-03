// useApplicationResumePreview.ts - resolve and render the resume behind an application.
//
// RESOLUTION ORDER (the only honest one in this schema):
//   1. `Application.tailoredResume.sourceResumeId` - the resume the tailored version came from.
//      `Application` has NO `resumeId` column (see `backend/prisma/schema.prisma`), so this is
//      the read path the workspace uses. If a future schema adds `Application.resumeId`, the
//      caller passes that id here and nothing else changes.
//   2. The resume's latest revision, read from `GET /resumes/:id/revisions` (oldest first).
//   3. `POST /resumes/:id/render` naming that revision.
//   4. `GET /resumes/:id/documents/:docId` for the bytes.
//
// The bytes go to the shared `PdfPages` rasteriser. A missing resume, a resume with no saved
// revision, a pre-render gate refusal and a transport failure are all DISTINCT states: the UI
// says which one happened rather than drawing a fake page.

import { useCallback, useEffect, useRef, useState } from 'react';
import { renderPortRefusal, studioApi } from '@/services/api/studio';

export type ApplicationResumePreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'empty'; message: string }
  | {
      kind: 'ready';
      bytes: Blob;
      objectUrl: string;
      hash: string;
      pageCount: number;
      revisionId: string;
      revisionNumber: number;
    }
  | {
      kind: 'refused';
      code: string;
      reason: string | null;
      message: string;
      gate: boolean;
    };

export interface ApplicationResumePreview {
  state: ApplicationResumePreviewState;
  /** Repaints the same revision with the current template. */
  reload: () => void;
  /** Called by `PdfPages` once it has parsed the artifact. */
  reportPageCount: (count: number) => void;
}

export function useApplicationResumePreview(
  resumeId: string | null,
  templateId: string,
): ApplicationResumePreview {
  const [state, setState] = useState<ApplicationResumePreviewState>({ kind: 'idle' });
  const [reloadToken, setReloadToken] = useState(0);
  const objectUrlRef = useRef<string | null>(null);
  const loadRef = useRef(0);
  const mountedRef = useRef(false);

  const release = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      release();
    };
  }, [release]);

  useEffect(() => {
    const token = loadRef.current + 1;
    loadRef.current = token;
    const current = () => mountedRef.current && token === loadRef.current;

    if (!resumeId) {
      release();
      setState({ kind: 'idle' });
      return;
    }

    setState({ kind: 'loading' });
    void (async () => {
      try {
        const revisions = await studioApi.listRevisions(resumeId);
        if (!current()) return;
        if (revisions.length === 0) {
          release();
          setState({
            kind: 'empty',
            message:
              'This resume has no saved revision yet. Open it in Studio to create one, then come back.',
          });
          return;
        }
        const latest = revisions[revisions.length - 1];
        const result = await studioApi.renderRevision(resumeId, {
          format: 'pdf',
          revisionId: latest.id,
          templateId,
        });
        if (!current()) return;
        const bytes = await studioApi.downloadDocument(resumeId, result.documentId);
        if (!current()) return;
        const objectUrl = URL.createObjectURL(bytes);
        release();
        objectUrlRef.current = objectUrl;
        setState({
          kind: 'ready',
          bytes,
          objectUrl,
          hash: result.hash,
          pageCount: 0,
          revisionId: latest.id,
          revisionNumber: latest.revisionNumber,
        });
      } catch (caught) {
        if (!current()) return;
        release();
        const refusal = renderPortRefusal(caught);
        setState({
          kind: 'refused',
          code: refusal.code,
          reason: refusal.reason ?? null,
          message: refusal.message,
          gate: refusal.code === 'PRE_RENDER_GATE_BLOCKED',
        });
      }
    })();

    return () => {
      // The token is what cancels installation of a stale result.
      loadRef.current += 1;
    };
  }, [release, resumeId, templateId, reloadToken]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  const reportPageCount = useCallback((count: number) => {
    setState((previous) =>
      previous.kind === 'ready' && previous.pageCount !== count
        ? { ...previous, pageCount: count }
        : previous,
    );
  }, []);

  return { state, reload, reportPageCount };
}
