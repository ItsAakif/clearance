// PdfPages.tsx - the shared pdf.js rasteriser (extracted from PagePreview).
//
// ONE JOB: take the TYPESETTER'S PDF BYTES and paint every page onto a canvas. It does not
// fetch, it does not choose a template, it does not read a resume document, and it lays
// nothing out. Both the Studio preview (`PagePreview`) and the application workspace use this
// component, so the pdf.js plumbing exists exactly once.
//
// WHY PDF.JS AND NOT AN OBJECT EMBED: the render route streams a PDF with
// `Content-Disposition: attachment`, so a plain `<iframe src>` would download rather than
// display it, and the browser's built-in viewer brings its own dark chrome into a panel much
// shorter than a page. pdf.js parses the same authenticated bytes and paints them onto
// canvases we own. The bytes are still the artifact; this is a PDF renderer, not a resume
// layout.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Vite rewrites this to the hashed worker URL in the build, so parsing runs off the main
// thread and never falls back to the browser's PDF plug-in.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Relative zoom steps around the fit-width base. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
/** The artifact-fit range: a page never draws smaller than half or larger than 3x. */
const FIT_SCALE_MIN = 0.5;
const FIT_SCALE_MAX = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface PdfPagesProps {
  /** The PDF bytes the typesetter produced. `null` draws nothing, honestly. */
  bytes: Blob | null;
  /** Fill the host's width. The base scale; `zoom` multiplies it. */
  fitWidth?: boolean;
  zoom?: number;
  /** Extra classes for the scroll host. The host owns the height. */
  className?: string;
  testId?: string;
  /** Text shown while the parse/paint is in flight. `null` hides the line. */
  loadingLabel?: string | null;
  /** Reports the parsed page count. */
  onPageCount?: (count: number) => void;
  /** Reports which page currently owns the reading area. */
  onVisiblePage?: (page: number) => void;
}

export function PdfPages({
  bytes,
  fitWidth = true,
  zoom = 1,
  className,
  testId,
  loadingLabel = null,
  onPageCount,
  onVisiblePage,
}: PdfPagesProps) {
  const [pages, setPages] = useState(0);
  const [paneWidth, setPaneWidth] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Canvases live here. React never owns these children; the paint loop replaces them. */
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const mountedRef = useRef(false);
  /** The newest load wins: a slower older load must not install itself over a newer one. */
  const loadRef = useRef(0);
  /** Bumped for every paint so a slow page from an old zoom cannot overwrite a newer one. */
  const generationRef = useRef(0);

  const onPageCountRef = useRef(onPageCount);
  onPageCountRef.current = onPageCount;
  const onVisiblePageRef = useRef(onVisiblePage);
  onVisiblePageRef.current = onVisiblePage;

  // Release the pdf.js document (and its worker) on unmount. A re-render destroys the
  // previous document before loading the next one, so switching templates cannot accumulate
  // workers.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pdf = pdfRef.current;
      pdfRef.current = null;
      if (pdf) void pdf.destroy();
    };
  }, []);

  // Parse the bytes. `pages` becoming non-zero is what lets the paint effect below run.
  useEffect(() => {
    const token = loadRef.current + 1;
    loadRef.current = token;
    const current = () => mountedRef.current && token === loadRef.current;

    const previous = pdfRef.current;
    pdfRef.current = null;
    if (previous) void previous.destroy();
    setPages(0);
    if (canvasHostRef.current) canvasHostRef.current.replaceChildren();
    if (!bytes) return;

    void (async () => {
      try {
        const data = new Uint8Array(await bytes.arrayBuffer());
        const pdf = await pdfjsLib.getDocument({ data }).promise;
        if (!current()) {
          void pdf.destroy();
          return;
        }
        pdfRef.current = pdf;
        setPages(pdf.numPages);
        onPageCountRef.current?.(pdf.numPages);
      } catch {
        // A document that cannot be parsed stays undrawn. Nothing is fabricated in its place.
        if (current()) setPages(0);
      }
    })();
  }, [bytes]);

  // The scroll host is the sizing authority for "fit width": measure it rather than assume an
  // A4 width, so the page fills a phone, a split pane and a wide monitor alike.
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const update = () => setPaneWidth(host.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Paint every page into its own canvas at devicePixelRatio. This is a PDF rasteriser: no
  // member of any resume document is read here.
  useEffect(() => {
    const pdf = pdfRef.current;
    const host = canvasHostRef.current;
    const scroll = scrollRef.current;
    if (!pdf || !host || !scroll || pages === 0 || paneWidth <= 0) return;

    let cancelled = false;
    const generation = ++generationRef.current;

    const paint = async () => {
      try {
        const first = await pdf.getPage(1);
        if (cancelled || generation !== generationRef.current) return;
        const base = first.getViewport({ scale: 1 });
        // 32px of host padding plus the 1px page border on each side.
        const available = Math.max(scroll.clientWidth - 34, 120);
        const fitScale = clamp(available / base.width, FIT_SCALE_MIN, FIT_SCALE_MAX);
        const scale = clamp(
          (fitWidth ? fitScale : 1) * zoom,
          FIT_SCALE_MIN,
          FIT_SCALE_MAX,
        );
        host.replaceChildren();
        for (let number = 1; number <= pdf.numPages; number += 1) {
          if (cancelled || generation !== generationRef.current) return;
          const page = await pdf.getPage(number);
          if (cancelled || generation !== generationRef.current) return;
          const viewport = page.getViewport({ scale });
          const pixelRatio = window.devicePixelRatio || 1;
          const canvas = window.document.createElement('canvas');
          canvas.width = Math.floor(viewport.width * pixelRatio);
          canvas.height = Math.floor(viewport.height * pixelRatio);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          // White page on the paper-2 mat, 8px apart from its neighbour (the host's gap-2).
          canvas.className =
            'block shrink-0 rounded-[2px] border border-rule bg-white shadow-e1';
          canvas.dataset.pageNumber = String(number);
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `Page ${number} of ${pdf.numPages}`);
          host.appendChild(canvas);
          const context = canvas.getContext('2d');
          if (!context) continue;
          await page.render({
            canvasContext: context,
            viewport,
            transform:
              pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined,
          }).promise;
        }
      } catch {
        // A page that cannot be painted stays undrawn. The empty mat is visibly not the
        // typesetter's page.
      }
    };

    void paint();
    return () => {
      cancelled = true;
    };
  }, [pages, fitWidth, zoom, paneWidth]);

  /** Which page owns the reading area, read from the canvases rather than guessed. */
  const trackPage = useCallback(() => {
    const scroll = scrollRef.current;
    const host = canvasHostRef.current;
    if (!scroll || !host) return;
    const anchor = scroll.getBoundingClientRect().top + scroll.clientHeight * 0.35;
    let visible = 1;
    for (const canvas of Array.from(host.querySelectorAll('canvas'))) {
      if (canvas.getBoundingClientRect().top <= anchor) {
        visible = Number(canvas.dataset.pageNumber ?? visible);
      }
    }
    onVisiblePageRef.current?.(visible);
  }, []);

  return (
    <div
      ref={scrollRef}
      onScroll={trackPage}
      className={`relative flex flex-1 flex-col items-center gap-2 overflow-auto bg-paper-2 p-4 ${className ?? ''}`.trim()}
      data-testid={testId}
    >
      <div ref={canvasHostRef} className="flex w-full flex-col items-center gap-2" />
      {pages === 0 && loadingLabel ? (
        <p className="flex items-center gap-2 py-8 text-[13px] text-ink-3">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {loadingLabel}
        </p>
      ) : null}
    </div>
  );
}

export default PdfPages;
