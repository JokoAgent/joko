import { useCallback, useEffect, useRef, useState, type JSX, type RefObject } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask
} from "pdfjs-dist";

import { Spinner } from "./ui.js";

export const WORKSPACE_PDF_RENDER_SCALE = 1.5;
export const WORKSPACE_PDF_CMAP_URL = "/pdfjs/cmaps/";
export const WORKSPACE_PDF_STANDARD_FONT_DATA_URL = "/pdfjs/standard_fonts/";
const MAX_PDF_DEVICE_PIXEL_RATIO = 2;
const MAX_PDF_CANVAS_PIXELS = 4_000_000;
const PDF_PAGE_PREFETCH_MARGIN = "400px 0px";
const PDF_PAGE_PLACEHOLDER = { width: 918, height: 1188 };

export interface WorkspacePdfCanvasProps {
  /** Authenticated artifact URL acquired by the gateway. */
  readonly url: string;
  readonly label: string;
  readonly loadingLabel: string;
  readonly scrollRoot: RefObject<HTMLDivElement | null>;
  readonly onError: () => void;
}

type PdfJs = typeof import("pdfjs-dist");

let pdfJsPromise: Promise<PdfJs> | undefined;

/**
 * Loading pdf.js lazily keeps server-rendered/component tests DOM-independent.
 * The worker URL is emitted by Vite and configured once for every document.
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfJsPromise ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  ]).then(([pdfJs, worker]) => {
    pdfJs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfJs;
  });
  return pdfJsPromise;
}

export function WorkspacePdfCanvas(props: WorkspacePdfCanvasProps): JSX.Element {
  return <WorkspacePdfDocument key={props.url} {...props} />;
}

function WorkspacePdfDocument({ url, label, loadingLabel, scrollRoot, onError }: WorkspacePdfCanvasProps): JSX.Element {
  const pagesRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const failedRef = useRef(false);
  const [{ failed, pdf }, setDocument] = useState<{ readonly failed?: true; readonly pdf?: PDFDocumentProxy }>({});
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(() => new Set());
  const [hasRenderedPage, setHasRenderedPage] = useState(false);
  const reportRenderedPage = useCallback(() => setHasRenderedPage(true), []);
  const reportError = useCallback(() => {
    if (pagesRef.current === null || failedRef.current) return;
    failedRef.current = true;
    setDocument({ failed: true });
    onErrorRef.current();
  }, []);

  useEffect(() => {
    if (failed) return;
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;

    void (async () => {
      try {
        const pdfJs = await loadPdfJs();
        if (cancelled || pagesRef.current === null) return;
        loadingTask = pdfJs.getDocument({
          url,
          cMapUrl: WORKSPACE_PDF_CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: WORKSPACE_PDF_STANDARD_FONT_DATA_URL
        });
        const loaded = await loadingTask.promise;
        if (!cancelled && pagesRef.current !== null) setDocument({ pdf: loaded });
      } catch {
        if (!cancelled) reportError();
      }
    })();

    return () => {
      cancelled = true;
      // The loading task owns the worker and transport after parsing as well.
      void loadingTask?.destroy().catch(() => undefined);
    };
  }, [failed, reportError, url]);

  useEffect(() => {
    const pages = pagesRef.current;
    if (!pdf || failed || !pages) return;
    const Observer = pages.ownerDocument.defaultView?.IntersectionObserver;
    const root = scrollRoot.current;
    if (Observer === undefined || root === null) {
      setVisiblePages(new Set([1]));
      return;
    }
    let disposed = false;
    const observer = new Observer(entries => {
      if (disposed || pagesRef.current !== pages || failedRef.current) return;
      setVisiblePages(current => {
        const next = new Set(current);
        let changed = false;
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.pdfPage);
          if (entry.isIntersecting) {
            if (!next.has(pageNumber)) { next.add(pageNumber); changed = true; }
          } else if (next.delete(pageNumber)) changed = true;
        }
        return changed ? next : current;
      });
    }, { root, rootMargin: PDF_PAGE_PREFETCH_MARGIN, threshold: 0 });
    for (const page of pages.children) observer.observe(page);
    return () => { disposed = true; observer.disconnect(); };
  }, [failed, pdf, scrollRoot]);

  const loading = !failed && !hasRenderedPage;
  return <div className="workspace-file-body__pdf-document" aria-label={label} aria-busy={loading}>
    {loading && <div className="workspace-file-body__pdf-loading" role="status"><Spinner label={loadingLabel} /><span>{loadingLabel}</span></div>}
    <div ref={pagesRef} className="workspace-file-body__pdf-pages">
      {!failed && pdf && Array.from({ length: pdf.numPages }, (_, index) => <WorkspacePdfPage
        key={index + 1} pdf={pdf} pageNumber={index + 1} label={`${label} ${index + 1}`}
        visible={visiblePages.has(index + 1)} onError={reportError} onRendered={reportRenderedPage}
      />)}
    </div>
  </div>;
}

function WorkspacePdfPage({ pdf, pageNumber, label, visible, onError, onRendered }: {
  readonly pdf: PDFDocumentProxy;
  readonly pageNumber: number;
  readonly label: string;
  readonly visible: boolean;
  readonly onError: () => void;
  readonly onRendered: () => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(PDF_PAGE_PLACEHOLDER);

  useEffect(() => {
    const host = hostRef.current;
    if (!visible || host === null) return;
    let cancelled = false;
    let canvas: HTMLCanvasElement | undefined;
    let renderTask: RenderTask | undefined;
    const isCurrent = () => !cancelled && hostRef.current === host;

    void (async () => {
      let page: PDFPageProxy | undefined;
      try {
        const loaded = await pdf.getPage(pageNumber);
        if (!isCurrent()) return;
        page = loaded;
        const viewport = page.getViewport({ scale: WORKSPACE_PDF_RENDER_SCALE });
        const { width, height } = viewport;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new Error("Invalid PDF page dimensions.");
        }
        setSize({ width: Math.max(1, Math.floor(width)), height: Math.max(1, Math.floor(height)) });
        const dpr = host.ownerDocument.defaultView?.devicePixelRatio ?? 1;
        const pixelRatio = pdfPixelRatio(width, height, dpr);
        canvas = host.ownerDocument.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(height * pixelRatio));
        canvas.setAttribute("aria-label", label);
        renderTask = page.render({
          canvas, viewport,
          transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0]
        });
        await renderTask.promise;
        if (isCurrent()) {
          host.appendChild(canvas);
          onRendered();
        }
      } catch (error) {
        if (isCurrent() && !(error instanceof Error && error.name === "RenderingCancelledException")) onError();
      } finally {
        renderTask = undefined;
        page?.cleanup();
      }
    })();

    return () => {
      cancelled = true;
      try { renderTask?.cancel(); } catch { /* The document may already be destroying its worker. */ }
      if (canvas !== undefined) {
        canvas.width = 0;
        canvas.height = 0;
        canvas.remove();
      }
    };
  }, [label, onError, onRendered, pageNumber, pdf, visible]);

  return <div data-pdf-page={pageNumber} className="workspace-file-body__pdf-page">
    <div ref={hostRef} className="workspace-file-body__pdf-sheet" style={size} />
  </div>;
}

function pdfPixelRatio(width: number, height: number, dpr: number): number {
  const deviceRatio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  // Dividing separately avoids overflow for very large finite page sizes.
  const areaRatio = Math.sqrt(MAX_PDF_CANVAS_PIXELS) / Math.sqrt(safeWidth) / Math.sqrt(safeHeight);
  // Even a very thin page keeps a one-pixel minimum on each side.
  const sideRatio = MAX_PDF_CANVAS_PIXELS / Math.max(safeWidth, safeHeight);
  return Math.min(deviceRatio, MAX_PDF_DEVICE_PIXEL_RATIO, areaRatio, sideRatio);
}
