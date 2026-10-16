import { Worker } from "node:worker_threads";
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const parentPid = Number(process.env["JOKO_PARENT_PROCESS_ID"]);
if (!process.send || !Number.isSafeInteger(parentPid) || parentPid <= 1 || process.ppid !== parentPid) throw new Error("PDF parser owner process is unavailable.");
// Only this small pure-JS watchdog uses a thread. PDF/native modules run on the
// process main thread; its blocked parser cannot prevent orphan retirement.
const parentWatchdog = new Worker(`
  const { workerData } = require('node:worker_threads');
  const check = () => {
    try {
      if (process.ppid !== workerData.parentPid) throw new Error('Owner changed');
      process.kill(workerData.parentPid, 0);
    } catch { process.kill(process.pid, 'SIGKILL'); }
  };
  check(); setInterval(check, 250);
`, { eval: true, execArgv: [], env: {}, workerData: { parentPid },
  resourceLimits: { maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 1 } });
parentWatchdog.on("error", () => process.kill(process.pid, "SIGKILL"));
parentWatchdog.unref();

interface WorkerRequest {
  readonly kind: "inspect";
  readonly data: Uint8Array;
  readonly pages: readonly number[];
  readonly maxPages: number;
}

interface TextWorkerRequest {
  readonly kind: "extract_text";
  readonly data: Uint8Array;
  readonly maxPages: number;
  readonly maxChars: number;
}

export type PdfParserRequest = WorkerRequest | TextWorkerRequest;

export interface PdfTextWorkerResult {
  readonly sections: readonly string[];
  readonly numPages: number;
  readonly pagesInspected: number;
  readonly clipped: boolean;
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

async function extractText(request: TextWorkerRequest): Promise<PdfTextWorkerResult> {
  const loading = pdfjs.getDocument({ data: request.data,
    useWorkerFetch: false, useWasm: false, stopAtErrors: true, maxImageSize: 1,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, disableFontFace: true,
    enableXfa: false, disableRange: true, disableStream: true, disableAutoFetch: true, verbosity: 0 });
  let document: Awaited<typeof loading.promise> | undefined;
  try {
    document = await loading.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 0) throw new Error("Invalid PDF page count.");
    const sections: string[] = [];
    let totalChars = 0, pagesInspected = 0, clipped = false;
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, request.maxPages); pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        pagesInspected = pageNumber;
        const parts: string[] = [];
        for (const item of content.items) {
          if (item && "str" in item && typeof item.str === "string") parts.push(item.str, item.hasEOL ? "\n" : " ");
        }
        const text = parts.join("").replace(/[ \t]+\n/gu, "\n").replace(/[ \t]{2,}/gu, " ").trim();
        if (text === "") continue;
        const section = `--- Page ${pageNumber} ---\n${text}`;
        const separators = sections.length > 0 ? 2 : 0;
        const remaining = request.maxChars - totalChars - separators;
        if (section.length > remaining) {
          if (remaining > 0) {
            let end = remaining;
            if (end < section.length && /[\uD800-\uDBFF]/u.test(section[end - 1]!)) end -= 1;
            sections.push(section.slice(0, end));
          }
          clipped = true; break;
        }
        sections.push(section); totalChars += separators + section.length;
      } finally { page.cleanup(); }
    }
    return { sections, numPages: document.numPages, pagesInspected, clipped };
  } finally {
    if (document) await document.destroy().catch(() => undefined);
    else await loading.destroy().catch(() => undefined);
  }
}

// The native PDF library lives only in a dedicated Node process's main thread.
// A Windows native teardown fault cannot terminate the caller's host process.
if (process.send) process.once("message", (request: PdfParserRequest) => {
  if (!(request?.data instanceof Uint8Array) || request.data.byteLength === 0 || request.data.byteLength > 64 * 1024 * 1024
    || !Number.isInteger(request.maxPages) || request.maxPages < 1 || request.maxPages > (request.kind === "extract_text" ? 40 : 50)
    || (request.kind === "extract_text" && (request.data.byteLength > 20 * 1024 * 1024
      || !Number.isInteger(request.maxChars) || request.maxChars < 1 || request.maxChars > 48_000))) {
    process.send?.({ ok: false }, () => process.disconnect?.()); return;
  }
  const job = request.kind === "inspect" ? inspect(request)
    : request.kind === "extract_text" ? extractText(request) : Promise.reject(new Error("Unknown PDF worker request."));
  void job.then(
    result => process.send?.({ ok: true, result }, () => process.disconnect?.()),
    () => process.send?.({ ok: false }, () => process.disconnect?.())
  );
});
