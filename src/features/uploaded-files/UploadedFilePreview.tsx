// Inline preview of a user's own uploaded file (ADR-007).
//
// Three render paths, chosen from `file.fileType` (case-insensitive):
// - PDF  -> <iframe> over a blob: URL from GET /uploaded-files/:id/view
// - DOCX -> docx-preview `renderAsync` over the user's own blob (read-only)
// - anything else (DOC / TXT / unknown / empty fileType) -> stored extracted text
//
// This component never routes through builder templates: it does not import or
// call DocxPreview, TemplateRenderer, template preview routes,
// resumeApi.export*, or any
// builder renderer. `renderAsync` on the user's own blob is the only DOCX path.
import { useCallback, useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { uploadedFilesApi, ApiClientError } from '@/services/api';
import type { UploadedFileSummary } from '@/services/api';
import { useUploadedFileText } from '@/hooks/useJobs';
import { Button } from '@/components/ui/button';
// Reuse the docx-preview page styling; do not copy this stylesheet.
//
// T1110 (cutover): the stylesheet MOVED here. It used to be
// `src/features/resume-builder/DocxPreview.css` - FREEZE A-09 schedules that file for removal
// with the builder - but this component, which the cutover must NOT touch (C-08: `features/
// uploaded-files` is out of scope), imported it, and `vite build` failed to resolve the path the
// moment the builder directory went. So the file is REHOMED to the one surface that uses it
// rather than deleted or duplicated: same rules, same class names, one copy. Nothing about the
// styling changed; only its address.
//
// Note the styles are `.docx-preview-*` - the layout of the `docx-preview` library's own output,
// not a resume layout - so rehoming it does not carry any page geometry with it.
import './docxPreview.css';

export interface UploadedFilePreviewProps {
  file: UploadedFileSummary | null;
  className?: string;
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEXT_MIME = 'text/plain';

type PreviewKind = 'pdf' | 'docx' | 'text';

function previewKindOf(fileType: string | null | undefined): PreviewKind {
  const normalized = (fileType ?? '').trim().toLowerCase();
  if (normalized === PDF_MIME) return 'pdf';
  if (normalized === DOCX_MIME) return 'docx';
  return 'text';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function statusCodeOf(err: unknown): number | null {
  return err instanceof ApiClientError ? err.statusCode : null;
}

// Status-aware preview failure message: surfaces the HTTP status, the stored
// file type, and an actionable hint (auth / base-url / empty-bytes) so the
// dialog never fails blank.
function previewErrorMessage(err: unknown, fileType: string | null | undefined): string {
  const status = statusCodeOf(err);
  const base = errorMessage(err, 'Preview failed to load.');
  const statusPart = status !== null ? ` (HTTP ${status})` : '';
  const typePart = fileType ? ` File type: ${fileType}.` : '';
  let hint: string;
  if (status === 401) {
    hint = ' Your session may have expired; sign in again and retry.';
  } else if (status === 403) {
    hint = ' You do not have access to this file.';
  } else if (status === 404) {
    hint = ' The file no longer exists.';
  } else if (status === 422) {
    hint = ' The stored file has no bytes; re-upload the file.';
  } else {
    hint =
      ' Check your connection and API base URL, then retry. If the stored file is empty (0 bytes), re-upload it.';
  }
  return `We could not load a preview of this file${statusPart}: ${base}.${typePart}${hint}`;
}

export function UploadedFilePreview({ file, className }: UploadedFilePreviewProps) {
  const fileId = file?.id;
  const kind: PreviewKind = file ? previewKindOf(file.fileType) : 'text';

  // ---- PDF path state (blob: URL owned by this component) ----
  // Raw error (not stringified) so the status-aware message keeps ApiClientError.statusCode.
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<unknown>(null);
  const viewUrlRef = useRef<string | null>(null);

  // ---- DOCX path state ----
  const containerRef = useRef<HTMLDivElement>(null);
  const [docxLoading, setDocxLoading] = useState(false);
  const [docxError, setDocxError] = useState<unknown>(null);

  // ---- shared download state ----
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // ---- text path (the only path cached in React Query) ----
  const textQuery = useUploadedFileText(
    fileId,
    file !== null && kind === 'text',
  );

  const handleDownload = useCallback(async () => {
    if (!file) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const blob = await uploadedFilesApi.download(file.id);
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setDownloadError(errorMessage(err, 'Download failed.'));
    } finally {
      setDownloading(false);
    }
  }, [file]);

  // ---- PDF load effect: fetch once per selected file, revoke exactly once ----
  useEffect(() => {
    if (!file || kind !== 'pdf') return;
    const id = file.id;
    let cancelled = false;
    setPdfLoading(true);
    setPdfError(null);
    setViewUrl(null);
    uploadedFilesApi
      .viewUrl(id)
      .then((url) => {
        if (cancelled) {
          // Response arrived after unmount / file switch: do not leak it.
          URL.revokeObjectURL(url);
          return;
        }
        viewUrlRef.current = url;
        setViewUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPdfError(err ?? new Error('Preview failed to load.'));
      })
      .finally(() => {
        if (!cancelled) setPdfLoading(false);
      });
    return () => {
      cancelled = true;
      if (viewUrlRef.current) {
        URL.revokeObjectURL(viewUrlRef.current);
        viewUrlRef.current = null;
      }
    };
    // Keyed on the file id (not the file object) so row switching revokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, kind]);

  // ---- DOCX load effect: render the user's own blob, read-only ----
  useEffect(() => {
    if (!file || kind !== 'docx') return;
    const id = file.id;
    let cancelled = false;
    setDocxLoading(true);
    setDocxError(null);
    const container = containerRef.current;
    if (container) container.innerHTML = '';
    uploadedFilesApi
      .getBlob(id)
      .then(async (blob) => {
        if (cancelled) return;
        if (!container) setDocxLoading(false);
        if (!container) return;
        container.innerHTML = '';
        await renderAsync(blob, container, undefined, {
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          renderHeaders: true,
          renderFooters: true,
          breakPages: true,
          renderEndnotes: true,
          renderFootnotes: true,
        });
        // Never made contenteditable: this preview is read-only.
        if (!cancelled) setDocxLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (container) container.innerHTML = '';
        setDocxError(err ?? new Error('Preview failed to load.'));
        setDocxLoading(false);
      });
    return () => {
      cancelled = true;
      if (container) container.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, kind]);

  if (file === null) return null;

  const downloadButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void handleDownload()}
      disabled={downloading}
    >
      {downloading ? 'Downloading...' : 'Download file'}
    </Button>
  );

  const renderFailure = (message: string) => (
    <div className="flex flex-col items-start gap-3">
      <p role="status" className="text-sm text-ink-3">
        {message}
      </p>
      {downloadButton}
      {downloadError ? (
        <p role="status" className="text-sm text-ink-3">
          {downloadError}
        </p>
      ) : null}
    </div>
  );

  if (kind === 'pdf') {
    return (
      <div className={className}>
        {pdfLoading ? (
          <p role="status" className="text-sm text-ink-3">
            Loading preview...
          </p>
        ) : null}
        {pdfError ? renderFailure(previewErrorMessage(pdfError, file.fileType)) : null}
        {!pdfLoading && !pdfError && viewUrl ? (
          <iframe
            src={viewUrl}
            title={file.fileName}
            className="h-[70vh] w-full rounded-control border border-rule bg-paper"
          />
        ) : null}
        {!pdfLoading && !pdfError && !viewUrl
          ? renderFailure(
              `We could not load a preview of this file: no preview bytes were returned. File type: ${file.fileType || 'unknown'}. If the stored file is empty (0 bytes), re-upload it.`
            )
          : null}
      </div>
    );
  }

  if (kind === 'docx') {
    return (
      <div className={className}>
        {docxLoading ? (
          <p role="status" className="text-sm text-ink-3">
            Rendering document...
          </p>
        ) : null}
        {docxError ? renderFailure(previewErrorMessage(docxError, file.fileType)) : null}
        <div
          ref={containerRef}
          className="max-h-[70vh] overflow-auto rounded-control border border-rule bg-paper"
        />
      </div>
    );
  }

  // ---- text path: DOC / TXT / unknown / empty fileType ----
  const normalizedType = (file.fileType ?? '').trim().toLowerCase();
  const showTypeNotice = normalizedType !== TEXT_MIME;
  const text = textQuery.data?.text ?? '';
  const truncated = textQuery.data?.truncated ?? false;

  return (
    <div className={className}>
      {textQuery.isLoading ? (
        <p role="status" className="text-sm text-ink-3">
          Loading text...
        </p>
      ) : null}
      {!textQuery.isLoading && textQuery.isError ? (
        renderFailure('We could not load the extracted text for this file.')
      ) : null}
      {!textQuery.isLoading && !textQuery.isError ? (
        text.trim() === '' ? (
          <div className="flex flex-col items-start gap-3">
            <p role="status" className="text-sm text-ink-3">
              We could not read any text from this file.
            </p>
            {downloadButton}
            {downloadError ? (
              <p role="status" className="text-sm text-ink-3">
                {downloadError}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {showTypeNotice ? (
              <p className="text-sm text-ink-3">
                Your browser cannot render this file type, so the text we extracted at upload
                time is shown instead.
              </p>
            ) : null}
            <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-control border border-rule bg-paper p-4 text-sm">
              {text}
            </pre>
            {truncated ? (
              <p className="text-sm text-ink-3">Text truncated.</p>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

export default UploadedFilePreview;
