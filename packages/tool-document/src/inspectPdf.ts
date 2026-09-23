import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { readDocumentInput } from "./input.js";
import type { PdfPageInspection, PdfWorkerResult } from "./inspectPdf-worker.js";

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 50;

const InspectPdfSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  pages: z.array(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)).max(HARD_MAX_PAGES).optional(),
  inspectedThrough: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  previousVerdict: z.enum(["ok", "blank", "partial-blank", "warning", "incomplete"]).optional(),
  previousPdfSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  maxPages: z.number().int().min(1).max(HARD_MAX_PAGES).default(DEFAULT_MAX_PAGES)
});

type Verdict = "ok" | "blank" | "partial-blank" | "warning" | "incomplete";

export class PdfInspectError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "UNSUPPORTED_FORMAT" | "EMPTY_FILE" | "PDF_CHANGED" | "NO_PAGES_INSPECTED" | "INSPECT_TIMEOUT" | "INSPECT_FAILED", message: string) {
    super(message);
    this.name = "PdfInspectError";
  }
}

export interface InspectPdfResult {
  readonly path: string;
  readonly bytes: number;
  readonly pdfSha256: string;
  readonly numPages: number;
  readonly pagesInspected: number;
  readonly inspectedThrough: number;
  readonly pages: (PdfPageInspection & { readonly paper: string })[];
  readonly blankPages: number[];
  readonly visibilityUnverifiedPages: number[];
  readonly nextPages?: number[];
  readonly verdict: Verdict;
  readonly warning?: string;
}

const PAPER_SIZES = [
  { name: "A3", width: 841.89, height: 1190.55 },
  { name: "A4", width: 595.28, height: 841.89 },
  { name: "A5", width: 419.53, height: 595.28 },
  { name: "Letter", width: 612, height: 792 },
  { name: "Legal", width: 612, height: 1008 },
  { name: "Tabloid", width: 792, height: 1224 }
] as const;

function describePaper(width: number, height: number): string {
  for (const paper of PAPER_SIZES) {
    if (Math.abs(width - paper.width) <= 2 && Math.abs(height - paper.height) <= 2) return paper.name;
    if (Math.abs(width - paper.height) <= 2 && Math.abs(height - paper.width) <= 2) return `${paper.name} landscape`;
  }
  return `${(width / 72).toFixed(2)}×${(height / 72).toFixed(2)} in`;
}

type WorkerMessage = { readonly ok: true; readonly result: PdfWorkerResult } | { readonly ok: false };

async function inspectInWorker(data: Buffer, pages: readonly number[], maxPages: number, signal: AbortSignal | undefined): Promise<PdfWorkerResult> {
  signal?.throwIfAborted();
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const workerFile = fileURLToPath(new URL(sourceMode ? "./inspectPdf-worker.ts" : "./inspectPdf-worker.js", import.meta.url));
  const execArgv = sourceMode ? ["--import", import.meta.resolve("tsx")] : [];
  return await new Promise<PdfWorkerResult>((resolveResult, reject) => {
    const worker = new Worker(workerFile, {
      workerData: { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), pages, maxPages },
      transferList: [data.buffer as ArrayBuffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      execArgv
    });
    let settled = false;
    const finish = (result?: PdfWorkerResult, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else resolveResult(result!);
    };
    const abort = (): void => finish(undefined, new PdfInspectError("INSPECT_FAILED", "PDF inspection was cancelled."));
    const timer = setTimeout(() => finish(undefined, new PdfInspectError("INSPECT_TIMEOUT", "PDF inspection timed out.")), TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.once("message", (message: WorkerMessage) => {
      if (message?.ok === true) finish(message.result);
      else finish(undefined, new PdfInspectError("INSPECT_FAILED", "PDF could not be inspected."));
    });
    worker.once("error", () => finish(undefined, new PdfInspectError("INSPECT_FAILED", "PDF parser failed.")));
    worker.once("exit", () => finish(undefined, new PdfInspectError("INSPECT_FAILED", "PDF parser exited without a result.")));
  });
}

/** Inspect structural PDF evidence; this does not confirm rendered appearance. */
export async function inspectPdf(input: unknown, root: string, signal?: AbortSignal): Promise<InspectPdfResult> {
  const parsed = InspectPdfSchema.safeParse(input);
  if (!parsed.success) throw new PdfInspectError("INVALID_ARGUMENT", "PDF inspection arguments are invalid.");
  const request = parsed.data;
  if (request.inspectedThrough > 0 && (!request.previousVerdict || !request.previousPdfSha256)) {
    throw new PdfInspectError("INVALID_ARGUMENT", "A continued inspection requires the previous verdict and PDF digest.");
  }
  const data = await readDocumentInput({ root, inPath: request.path, maxBytes: MAX_INPUT_BYTES, ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  if (extname(request.path).toLowerCase() !== ".pdf") throw new PdfInspectError("UNSUPPORTED_FORMAT", "PDF inspection requires a .pdf file.");
  if (data.byteLength === 0) throw new PdfInspectError("EMPTY_FILE", "PDF file is empty.");
  const pdfSha256 = createHash("sha256").update(data).digest("hex");
  if (request.inspectedThrough > 0 && request.previousPdfSha256 !== pdfSha256) {
    throw new PdfInspectError("PDF_CHANGED", "PDF content changed between inspection batches.");
  }
  const bytes = data.byteLength;
  const inspection = await inspectInWorker(data, request.pages ?? [], request.maxPages, signal);
  signal?.throwIfAborted();
  if (request.inspectedThrough > inspection.numPages) {
    throw new PdfInspectError("INVALID_ARGUMENT", "Inspection cursor exceeds the PDF page count.");
  }
  const pages = inspection.pages.map(page => ({ ...page, paper: describePaper(page.width, page.height) }));
  if (pages.length === 0) throw new PdfInspectError("NO_PAGES_INSPECTED", "No PDF pages were inspected; requested pages may be out of range.");
  const blankPages = pages.filter(page => page.blank).map(page => page.page);
  const visibilityUnverifiedPages = pages.filter(page => page.visibilityUnverified).map(page => page.page);
  const pageSet = new Set(pages.map(page => page.page));
  let inspectedThrough = request.inspectedThrough;
  while (pageSet.has(inspectedThrough + 1)) inspectedThrough += 1;
  const partial = inspectedThrough < inspection.numPages;
  const nextPages: number[] = [];
  if (partial) for (let page = inspectedThrough + 1; page <= inspection.numPages && nextPages.length < request.maxPages; page += 1) nextPages.push(page);
  const carried = request.previousVerdict ?? "incomplete";
  const allBlank = blankPages.length === pages.length && (request.inspectedThrough === 0 || carried === "blank");
  const foundBlank = blankPages.length > 0 || carried === "blank" || carried === "partial-blank";
  const uncertain = visibilityUnverifiedPages.length > 0 || carried === "warning";
  const verdict: Verdict = allBlank ? "blank" : foundBlank ? "partial-blank" : uncertain ? "warning" : partial ? "incomplete" : "ok";
  const warning = verdict === "blank" ? "Every inspected page is structurally blank. Check the PDF before delivery."
    : verdict === "partial-blank" ? "At least one inspected page is structurally blank. Check the listed pages and prior batches."
      : verdict === "warning" ? "Some page paint operators could not be verified. Open the PDF to confirm visibility."
        : partial ? "Inspection has not covered every page." : undefined;
  return {
    path: resolve(root, request.path), bytes, pdfSha256,
    numPages: inspection.numPages, pagesInspected: pages.length,
    inspectedThrough, pages, blankPages, visibilityUnverifiedPages,
    ...(partial ? { nextPages } : {}), verdict,
    ...(warning ? { warning } : {})
  };
}
