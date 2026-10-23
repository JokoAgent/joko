import { createPdfParserProcess } from "./pdf-process.js";

import type { PdfTextWorkerResult } from "./inspectPdf-worker.js";

export type { PdfTextWorkerResult } from "./inspectPdf-worker.js";
export const PDF_TEXT_MAX_BYTES = 20 * 1024 * 1024;
export const PDF_TEXT_MAX_PAGES = 40;
export const PDF_TEXT_TIMEOUT_MS = 5_000;
export const PDF_PAGE_TEXT_MAX_BYTES = 32 * 1024 * 1024;
export const PDF_PAGE_TEXT_MAX_PAGES = 20;
export const PDF_PAGE_TEXT_MAX_CHARS = 100_000;

export class PdfTextExtractionError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "TIMEOUT" | "FAILED" | "RETIREMENT_UNKNOWN") {
    super("Bounded PDF text extraction is unavailable.");
    this.name = "PdfTextExtractionError";
  }
}

export interface PdfTextWorker {
  once(event: "message", listener: (value: unknown) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
  readonly stdout?: { resume(): unknown } | null;
  readonly stderr?: { resume(): unknown } | null;
}

export async function extractPdfText(
  data: Uint8Array,
  maxChars: number,
  options: { readonly signal?: AbortSignal; readonly workerFactory?: () => PdfTextWorker } = {}
): Promise<PdfTextWorkerResult> {
  return extractBoundedPdfText(data, maxChars, options, { maximumBytes: PDF_TEXT_MAX_BYTES, maximumChars: 48_000, firstPage: 1, maximumPages: PDF_TEXT_MAX_PAGES, ranged: false });
}

/** Native-style Read selects at most twenty PDF pages, including later pages.
 * It uses the same isolated, network-free parser as ordinary document review. */
export async function extractPdfPageText(
  data: Uint8Array,
  range: { readonly first: number; readonly last: number },
  maxChars: number,
  options: { readonly signal?: AbortSignal; readonly workerFactory?: () => PdfTextWorker } = {}
): Promise<PdfTextWorkerResult> {
  if (!Number.isSafeInteger(range.first) || !Number.isSafeInteger(range.last) || range.first < 1 || range.last < range.first
    || range.last - range.first + 1 > PDF_PAGE_TEXT_MAX_PAGES) throw new PdfTextExtractionError("INVALID_INPUT");
  return extractBoundedPdfText(data, maxChars, options, { maximumBytes: PDF_PAGE_TEXT_MAX_BYTES, maximumChars: PDF_PAGE_TEXT_MAX_CHARS,
    firstPage: range.first, maximumPages: range.last - range.first + 1, ranged: true });
}

async function extractBoundedPdfText(data: Uint8Array, maxChars: number,
  options: { readonly signal?: AbortSignal; readonly workerFactory?: () => PdfTextWorker },
  limits: { readonly maximumBytes: number; readonly maximumChars: number; readonly firstPage: number; readonly maximumPages: number; readonly ranged: boolean }
): Promise<PdfTextWorkerResult> {
  options.signal?.throwIfAborted();
  if (data.byteLength === 0 || data.byteLength > limits.maximumBytes || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > limits.maximumChars) {
    throw new PdfTextExtractionError("INVALID_INPUT");
  }
  const bytes = Uint8Array.from(data);
  const worker: PdfTextWorker = options.workerFactory?.() ?? createPdfParserProcess({ kind: limits.ranged ? "extract_page_text" : "extract_text", data: bytes,
    ...(limits.ranged ? { firstPage: limits.firstPage } : {}), maxPages: limits.maximumPages, maxChars });
  worker.stdout?.resume(); worker.stderr?.resume();
  return await new Promise<PdfTextWorkerResult>((resolveResult, reject) => {
    let settled = false, exitConfirmed = false;
    let result: PdfTextWorkerResult | undefined;
    let failure: PdfTextExtractionError | undefined;
    let retirement: Promise<number> | undefined;
    const finish = (error?: PdfTextExtractionError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolveResult(result!);
    };
    const retire = (): void => {
      if (retirement !== undefined) return;
      try { retirement = worker.terminate(); }
      catch { finish(new PdfTextExtractionError("RETIREMENT_UNKNOWN")); return; }
      void retirement.then(code => {
        if (!Number.isInteger(code) || code < 0) { finish(new PdfTextExtractionError("RETIREMENT_UNKNOWN")); return; }
        exitConfirmed = true;
        finish(failure ?? (result === undefined ? new PdfTextExtractionError("FAILED") : undefined));
      }, () => finish(new PdfTextExtractionError("RETIREMENT_UNKNOWN")));
    };
    const abort = (): void => { failure = new PdfTextExtractionError("FAILED"); retire(); };
    const timer = setTimeout(() => {
      failure = new PdfTextExtractionError("TIMEOUT");
      retire();
      finish(exitConfirmed ? failure : new PdfTextExtractionError("RETIREMENT_UNKNOWN"));
    }, PDF_TEXT_TIMEOUT_MS);
    worker.once("message", value => {
      if (settled) return;
      if (isResultMessage(value, maxChars, limits.firstPage, limits.maximumPages)) result = value.result;
      else failure = new PdfTextExtractionError("FAILED");
      retire();
    });
    worker.once("error", () => { failure = new PdfTextExtractionError("FAILED"); retire(); });
    worker.once("exit", code => {
      exitConfirmed = true;
      if (!Number.isInteger(code) || code < 0 || result === undefined) failure ??= new PdfTextExtractionError("FAILED");
      finish(failure);
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

function isResultMessage(value: unknown, maxChars: number, firstPage: number, maximumPages: number): value is { readonly ok: true; readonly result: PdfTextWorkerResult } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.ok !== true || Object.keys(message).some(key => key !== "ok" && key !== "result") ||
      typeof message.result !== "object" || message.result === null || Array.isArray(message.result)) return false;
  const result = message.result as Record<string, unknown>;
  return !Object.keys(result).some(key => !["sections", "numPages", "pagesInspected", "clipped"].includes(key)) &&
    Array.isArray(result.sections) && result.sections.length <= maximumPages &&
    result.sections.every(section => typeof section === "string") && result.sections.join("\n\n").length <= maxChars &&
    Number.isSafeInteger(result.numPages) && Number(result.numPages) >= 0 &&
    Number.isSafeInteger(result.pagesInspected) && Number(result.pagesInspected) >= 0 &&
    Number(result.pagesInspected) <= Math.min(Number(result.numPages), firstPage + maximumPages - 1)
    && (Number(result.pagesInspected) === 0 || Number(result.pagesInspected) >= firstPage) && typeof result.clipped === "boolean";
}
