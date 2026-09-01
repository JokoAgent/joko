import { useEffect, useRef, useState, type JSX } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask
} from "pdfjs-dist";

import { Spinner } from "./ui.js";

export const WORKSPACE_PDF_RENDER_SCALE = 1.5;
export const WORKSPACE_PDF_CMAP_URL = "/pdfjs/cmaps/";
export const WORKSPACE_PDF_STANDARD_FONT_DATA_URL = "/pdfjs/standard_fonts/";

export interface WorkspacePdfCanvasProps {
  /** Authenticated artifact URL acquired by the gateway. */
  readonly url: string;
  readonly label: string;
  readonly loadingLabel: string;
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

/** Renders every PDF page into its own high-DPI canvas. */
export function WorkspacePdfCanvas({ url, label, loadingLabel, onError }: WorkspacePdfCanvasProps): JSX.Element {
  const pagesRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let document: PDFDocumentProxy | undefined;
    let renderTask: RenderTask | undefined;
    const pages = pagesRef.current;
    if (pages === null) return;
    pages.replaceChildren();
    setLoading(true);

    void (async () => {
      try {
        const pdfJs = await loadPdfJs();
        if (cancelled) return;
        loadingTask = pdfJs.getDocument({
          url,
          cMapUrl: WORKSPACE_PDF_CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: WORKSPACE_PDF_STANDARD_FONT_DATA_URL
        });
        document = await loadingTask.promise;
        if (cancelled) return;

        const dpr = window.devicePixelRatio || 1;
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          const page = await document.getPage(pageNumber);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: WORKSPACE_PDF_RENDER_SCALE });
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          canvas.setAttribute("aria-label", `${label} ${pageNumber}`);
          renderTask = page.render({
            canvas,
            viewport,
            transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0]
          });
          await renderTask.promise;
          renderTask = undefined;
          if (cancelled) return;
          pages.appendChild(canvas);
          page.cleanup();
        }
        if (!cancelled) setLoading(false);
      } catch {
        if (!cancelled) onErrorRef.current();
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      void loadingTask?.destroy();
      void document?.destroy();
    };
  }, [label, url]);

  return <div className="workspace-file-body__pdf-document" aria-label={label}>
    <div ref={pagesRef} className="workspace-file-body__pdf-pages" />
    {loading && <div className="workspace-file-body__pdf-loading" role="status"><Spinner label={loadingLabel} /><span>{loadingLabel}</span></div>}
  </div>;
}
