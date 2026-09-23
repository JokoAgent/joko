import { promises as fs } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readDocumentInput } from "./input.js";
import { applyReportTemplate, extractHtmlTitle } from "./pdfTemplate.js";
import { captureDirectorySnapshot, inlineLocalResources, sameDirectorySnapshot } from "./pdfResources.js";
import { decodePdfText, PdfResourceError } from "./pdfText.js";
import { DOCS_THEME_NAMES, resolveDocsTheme } from "./themes.js";

export const RENDER_PDF_MAX_HTML_BYTES = 16 * 1024 * 1024;
export const RENDER_PDF_TIMEOUT_MS = 30_000;
export const RENDER_PDF_FONT_TIMEOUT_MS = 5_000;
export const PDF_PAGE_SIZES = ["A3", "A4", "A5", "Legal", "Letter", "Tabloid"] as const;

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const SUSPICIOUS_PDF_BYTES = 2_048;
const margin = z.number().finite().min(0).max(5).default(0.4);
const PdfRenderSchema = z.strictObject({
  htmlPath: z.string().min(1).max(4_096).optional(),
  html: z.string().min(1).max(RENDER_PDF_MAX_HTML_BYTES).optional(),
  pageSize: z.enum(PDF_PAGE_SIZES).default("A4"),
  landscape: z.boolean().default(false),
  printBackground: z.boolean().default(true),
  margins: z.strictObject({ top: margin, bottom: margin, left: margin, right: margin }).optional(),
  template: z.enum(["auto", "report", "none"]).default("auto"),
  theme: z.enum(DOCS_THEME_NAMES).default("light")
});

export type PdfPageSize = (typeof PDF_PAGE_SIZES)[number];
export type PdfMargins = { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number };

export interface PdfRenderRequest {
  readonly html: string;
  readonly pageSize: PdfPageSize;
  readonly landscape: boolean;
  readonly printBackground: boolean;
  readonly margins: PdfMargins;
  readonly timeoutMs: number;
  readonly fontTimeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface PdfRenderOutput { readonly buffer: Uint8Array; readonly fontsReady: boolean }
export interface PdfRenderer { render(input: PdfRenderRequest): Promise<PdfRenderOutput> }

export class PdfRenderError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "UNSUPPORTED_FORMAT" | "FILE_TOO_LARGE" | "RENDER_EMPTY" | "RENDER_TIMEOUT" | "RENDER_FAILED", message: string) {
    super(message);
    this.name = "PdfRenderError";
  }
}

export interface RenderPdfResult {
  readonly buffer: Buffer;
  readonly pageSize: PdfPageSize;
  readonly landscape: boolean;
  readonly fontsReady: boolean;
  readonly template: "auto" | "report" | "none";
  readonly theme: (typeof DOCS_THEME_NAMES)[number];
  readonly templateApplied: boolean;
  readonly title?: string;
  readonly warning?: string;
}

/** Prepare a closed local HTML snapshot before handing bytes to an isolated renderer. */
export async function renderPdf(input: unknown, root: string, renderer: PdfRenderer, signal?: AbortSignal): Promise<RenderPdfResult> {
  const parsed = PdfRenderSchema.safeParse(input);
  if (!parsed.success) throw new PdfRenderError("INVALID_ARGUMENT", "PDF render arguments are invalid.");
  const request = parsed.data;
  if (Boolean(request.htmlPath) === Boolean(request.html)) {
    throw new PdfRenderError("INVALID_ARGUMENT", "Supply exactly one of htmlPath or html.");
  }
  signal?.throwIfAborted();
  const canonicalRoot = await fs.realpath(root).catch(() => { throw new PdfResourceError("PATH_NOT_ALLOWED", "Task working directory is unavailable."); });
  let sourceHtml: string;
  let sourcePath: string;
  let sourceDirectory: Awaited<ReturnType<typeof captureDirectorySnapshot>> | undefined;
  if (request.htmlPath) {
    sourcePath = resolve(canonicalRoot, request.htmlPath);
    const rel = relative(canonicalRoot, sourcePath);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new PdfResourceError("PATH_NOT_ALLOWED", "HTML source must stay in the task working directory.");
    }
    sourceDirectory = await captureDirectorySnapshot(dirname(sourcePath));
    const bytes = await readDocumentInput({ root: canonicalRoot, inPath: request.htmlPath, maxBytes: RENDER_PDF_MAX_HTML_BYTES, ...(signal ? { signal } : {}) });
    if (extname(request.htmlPath).toLowerCase() !== ".html") throw new PdfRenderError("UNSUPPORTED_FORMAT", "HTML source must be a .html file.");
    if (!sameDirectorySnapshot(sourceDirectory, await captureDirectorySnapshot(dirname(sourcePath)))) {
      throw new PdfResourceError("PATH_NOT_ALLOWED", "HTML source directory changed while reading.");
    }
    sourceHtml = decodePdfText(bytes);
  } else {
    sourceHtml = request.html!;
    if (Buffer.byteLength(sourceHtml, "utf8") > RENDER_PDF_MAX_HTML_BYTES) throw new PdfRenderError("FILE_TOO_LARGE", "HTML source exceeds 16 MiB.");
    sourcePath = join(canonicalRoot, "__joko_inline__.html");
  }
  signal?.throwIfAborted();
  const snapshot = await inlineLocalResources(canonicalRoot, sourcePath, sourceHtml,
    sourceDirectory, sourceDirectory ? new Map([[dirname(sourcePath), sourceDirectory]]) : undefined, signal);
  signal?.throwIfAborted();
  const wrapped = applyReportTemplate(snapshot, resolveDocsTheme(request.theme), request.template);
  if (Buffer.byteLength(wrapped.html, "utf8") > MAX_SNAPSHOT_BYTES) throw new PdfRenderError("FILE_TOO_LARGE", "HTML snapshot exceeds 64 MiB.");
  const margins: PdfMargins = request.margins ?? (wrapped.applied
    ? { top: 0, bottom: 0, left: 0, right: 0 }
    : { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 });
  let rendered: PdfRenderOutput;
  try {
    rendered = await renderer.render({ html: wrapped.html, pageSize: request.pageSize,
      landscape: request.landscape, printBackground: request.printBackground, margins,
      timeoutMs: RENDER_PDF_TIMEOUT_MS, fontTimeoutMs: RENDER_PDF_FONT_TIMEOUT_MS,
      ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof PdfRenderError) throw error;
    throw new PdfRenderError("RENDER_FAILED", "PDF renderer failed.");
  }
  signal?.throwIfAborted();
  if (!rendered.buffer || rendered.buffer.byteLength === 0) throw new PdfRenderError("RENDER_EMPTY", "PDF renderer returned no bytes.");
  if (rendered.buffer.byteLength > MAX_PDF_BYTES) throw new PdfRenderError("FILE_TOO_LARGE", "Rendered PDF exceeds 64 MiB.");
  const buffer = Buffer.from(rendered.buffer);
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new PdfRenderError("RENDER_FAILED", "PDF renderer returned invalid content.");
  const warnings: string[] = [];
  if (buffer.byteLength < SUSPICIOUS_PDF_BYTES) warnings.push("PDF size is unusually small; inspect the PDF before delivery.");
  if (!rendered.fontsReady) warnings.push("Fonts were not ready before printing; inspect the PDF and confirm typography.");
  const title = extractHtmlTitle(snapshot);
  return {
    buffer, pageSize: request.pageSize, landscape: request.landscape,
    fontsReady: rendered.fontsReady, template: request.template, theme: request.theme,
    templateApplied: wrapped.applied,
    ...(title ? { title } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {})
  };
}
