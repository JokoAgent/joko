import { parentPort, workerData } from "node:worker_threads";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

interface WorkerRequest {
  readonly data: Uint8Array;
  readonly pages: readonly number[];
  readonly maxPages: number;
}

export interface PdfPageInspection {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly textChars: number;
  readonly textPreview: string;
  readonly drawOps: number | null;
  readonly imageOps: number | null;
  readonly blank: boolean;
  readonly visibilityUnverified: boolean;
}

export interface PdfWorkerResult {
  readonly numPages: number;
  readonly pages: PdfPageInspection[];
}

const IMAGE_OPS = new Set<number>([
  pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject,
  pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageMaskXObjectGroup,
  pdfjs.OPS.paintInlineImageXObjectGroup, pdfjs.OPS.paintImageXObjectRepeat,
  pdfjs.OPS.paintImageMaskXObjectRepeat, pdfjs.OPS.paintSolidColorImageMask
].filter((op): op is number => typeof op === "number"));

const PAINT_OPS = new Set<number>([
  pdfjs.OPS.stroke, pdfjs.OPS.closeStroke, pdfjs.OPS.fill, pdfjs.OPS.eoFill,
  pdfjs.OPS.fillStroke, pdfjs.OPS.eoFillStroke, pdfjs.OPS.closeFillStroke,
  pdfjs.OPS.closeEOFillStroke, pdfjs.OPS.shadingFill, pdfjs.OPS.showText,
  pdfjs.OPS.showSpacedText, pdfjs.OPS.nextLineShowText,
  pdfjs.OPS.nextLineSetSpacingShowText, ...IMAGE_OPS
].filter((op): op is number => typeof op === "number"));

async function inspect(request: WorkerRequest): Promise<PdfWorkerResult> {
  const loading = pdfjs.getDocument({
    data: request.data,
    useWorkerFetch: false, useWasm: false, stopAtErrors: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    disableFontFace: true, enableXfa: false, disableRange: true,
    disableStream: true, disableAutoFetch: true, verbosity: 0
  });
  let document: Awaited<typeof loading.promise> | undefined;
  try {
    document = await loading.promise;
    const numPages = document.numPages;
    if (!Number.isSafeInteger(numPages) || numPages < 0) throw new Error("Invalid PDF page count.");
    const selected = request.pages.length > 0
      ? [...new Set(request.pages)].filter(page => page <= numPages).sort((a, b) => a - b).slice(0, request.maxPages)
      : Array.from({ length: Math.min(numPages, request.maxPages) }, (_, index) => index + 1);
    const pages: PdfPageInspection[] = [];
    for (const pageNumber of selected) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items) {
        if (item && "str" in item && typeof item.str === "string") parts.push(item.str, item.hasEOL ? "\n" : " ");
      }
      const text = parts.join("").replace(/\s+/g, " ").trim();
      let drawOps: number | null = null;
      let imageOps: number | null = null;
      try {
        const operators = await page.getOperatorList();
        let draws = 0;
        let images = 0;
        for (let index = 0; index < operators.fnArray.length; index += 1) {
          const op = operators.fnArray[index]!;
          const pathPaint = op === pdfjs.OPS.constructPath ? operators.argsArray[index]?.[0] : undefined;
          if (PAINT_OPS.has(op) || (typeof pathPaint === "number" && PAINT_OPS.has(pathPaint))) draws += 1;
          if (IMAGE_OPS.has(op)) images += 1;
        }
        drawOps = draws;
        imageOps = images;
      } catch {
        // A failed operator read cannot prove a page blank.
      }
      pages.push({
        page: pageNumber,
        width: Math.round(viewport.width * 100) / 100,
        height: Math.round(viewport.height * 100) / 100,
        rotation: viewport.rotation,
        textChars: text.length,
        textPreview: text.slice(0, 400),
        drawOps,
        imageOps,
        blank: text.length === 0 && drawOps === 0 && imageOps === 0,
        visibilityUnverified: drawOps === null || imageOps === null
      });
      page.cleanup();
    }
    return { numPages, pages };
  } finally {
    if (document) await document.destroy().catch(() => undefined);
    else await loading.destroy().catch(() => undefined);
  }
}

const port = parentPort;
if (port) {
  void inspect(workerData as WorkerRequest).then(
    result => port.postMessage({ ok: true, result }),
    () => port.postMessage({ ok: false })
  );
}
