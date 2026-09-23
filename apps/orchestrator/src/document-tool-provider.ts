import { createPptxBuffer, createXlsxBuffer, markdownToDocxBuffer, publishDocumentOutput, readDocumentInput, readSheet, inspectPdf, renderPdf, DOCS_THEME_NAMES, DocumentInputError, DocumentOutputError, PptxDocumentError, XlsxDocumentError, SheetReadError, PdfInspectError, PdfRenderError, PdfResourceError, PPTX_LAYOUT_NAMES, PPTX_MAX_SLIDES, PPTX_MAX_BULLETS_PER_SLIDE, MAX_XLSX_SHEETS, MAX_XLSX_ROWS_PER_SHEET, MAX_XLSX_COLUMNS, MAX_XLSX_CELL_TEXT_CHARS, MAX_XLSX_FORMULA_CHARS, PDF_PAGE_SIZES, RENDER_PDF_MAX_HTML_BYTES, type DocsThemeName, type PdfRenderer } from "@joko/tool-document";
import type { OperationalStore } from "@joko/store";
import type { BridgeToolCallContext, BridgeToolProvider, McpCallResult, McpToolDescriptor } from "./mcp-router.js";

export const DOCUMENT_TOOL_PROVIDER_ID = "joko-document-tools";

const TOOLS: readonly McpToolDescriptor[] = Object.freeze([{
  serverId: DOCUMENT_TOOL_PROVIDER_ID,
  name: "make_docx",
  runtimeName: "make_docx",
  description: "Create an editable Word document from Markdown in this task's working directory. Headings, emphasis, links, lists, tables, quotes, code and explicit page breaks remain editable. An existing file is never replaced unless overwrite is true.",
  inputSchema: {
    type: "object",
    properties: {
      markdown: { type: "string", minLength: 1, maxLength: 4 * 1024 * 1024, description: "Markdown body, at most 4 MiB UTF-8." },
      outPath: { type: "string", minLength: 1, maxLength: 4_096, description: "Workspace-relative or in-workspace absolute .docx output path." },
      title: { type: "string", maxLength: 4 * 1024, description: "Optional document title and cover title." },
      subtitle: { type: "string", maxLength: 16 * 1024, description: "Optional cover subtitle." },
      cover: { type: "boolean", description: "With a title, include a cover by default." },
      theme: { type: "string", enum: [...DOCS_THEME_NAMES], description: "Document color theme." },
      overwrite: { type: "boolean", description: "Explicitly replace an existing regular file." }
    },
    required: ["markdown", "outPath"],
    additionalProperties: false
  },
  requiresPermission: true
}, {
  serverId: DOCUMENT_TOOL_PROVIDER_ID,
  name: "make_pptx",
  runtimeName: "make_pptx",
  description: "Create an editable PowerPoint deck in this task's working directory. Use cover, section, content, comparison, metrics and image layouts. Supports notes, two-column comparisons, metric cards, bounded PNG/JPEG/GIF images and three themes. Existing files require overwrite: true.",
  inputSchema: {
    type: "object",
    properties: {
      slides: {
        type: "array", minItems: 1, maxItems: PPTX_MAX_SLIDES,
        items: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 1_000 },
            layout: { type: "string", enum: [...PPTX_LAYOUT_NAMES], default: "content" },
            subtitle: { type: "string", maxLength: 32_000 },
            bullets: { type: "array", maxItems: PPTX_MAX_BULLETS_PER_SLIDE, items: { type: "string", maxLength: 4_000 } },
            body: { type: "string", maxLength: 32_000 },
            notes: { type: "string", maxLength: 64_000 },
            imagePath: { type: "string", minLength: 1, maxLength: 4_096, description: "PNG, JPEG or GIF inside this task's working directory; only for content or image layout." },
            columns: {
              type: "array", minItems: 2, maxItems: 2,
              items: { type: "object", properties: {
                title: { type: "string", minLength: 1, maxLength: 1_000 },
                bullets: { type: "array", maxItems: 5, items: { type: "string", minLength: 1, maxLength: 4_000 } },
                body: { type: "string", maxLength: 32_000 }
              }, required: ["title"], additionalProperties: false }
            },
            metrics: {
              type: "array", minItems: 2, maxItems: 4,
              items: { type: "object", properties: {
                value: { oneOf: [{ type: "string", maxLength: 1_000 }, { type: "number" }] },
                label: { type: "string", minLength: 1, maxLength: 1_000 },
                detail: { type: "string", maxLength: 32_000 }
              }, required: ["value", "label"], additionalProperties: false }
            }
          }, required: ["title"], additionalProperties: false
        }
      },
      outPath: { type: "string", minLength: 1, maxLength: 4_096, description: "Workspace-relative or in-workspace absolute .pptx output path." },
      title: { type: "string", maxLength: 1_000, description: "Deck title and footer label." },
      theme: { type: "string", enum: [...DOCS_THEME_NAMES], default: "light" },
      footer: { type: "boolean", default: true },
      overwrite: { type: "boolean", default: false }
    },
    required: ["slides", "outPath"],
    additionalProperties: false
  },
  requiresPermission: true
}, {
  serverId: DOCUMENT_TOOL_PROVIDER_ID,
  name: "make_xlsx",
  runtimeName: "make_xlsx",
  description: "Create an editable Excel workbook from one or more sheets in this task's working directory. Cells may contain text, numbers, booleans, blanks, or formulas with required cached results. Headers are styled, frozen and filterable; columns have readable widths and number formats. Existing files require overwrite: true.",
  inputSchema: {
    type: "object",
    properties: {
      sheets: {
        type: "array", minItems: 1, maxItems: MAX_XLSX_SHEETS,
        items: { type: "object", properties: {
          name: { type: "string", minLength: 1, maxLength: 31 },
          header: { type: "array", maxItems: MAX_XLSX_COLUMNS, items: { type: "string", maxLength: MAX_XLSX_CELL_TEXT_CHARS } },
          rows: { type: "array", maxItems: MAX_XLSX_ROWS_PER_SHEET, items: {
            type: "array", maxItems: MAX_XLSX_COLUMNS,
            items: { oneOf: [
              { type: "string", maxLength: MAX_XLSX_CELL_TEXT_CHARS },
              { type: "number" }, { type: "boolean" }, { type: "null" },
              { type: "object", properties: {
                formula: { type: "string", minLength: 1, maxLength: MAX_XLSX_FORMULA_CHARS },
                result: { oneOf: [{ type: "string", maxLength: MAX_XLSX_CELL_TEXT_CHARS }, { type: "number" }, { type: "boolean" }] }
              }, required: ["formula", "result"], additionalProperties: false }
            ] }
          } }
        }, required: ["name", "rows"], additionalProperties: false }
      },
      outPath: { type: "string", minLength: 1, maxLength: 4_096, description: "Workspace-relative or in-workspace absolute .xlsx output path." },
      theme: { type: "string", enum: [...DOCS_THEME_NAMES], default: "light" },
      zebra: { type: "boolean", default: true },
      overwrite: { type: "boolean", default: false }
    },
    required: ["sheets", "outPath"],
    additionalProperties: false
  },
  requiresPermission: true
}, {
  serverId: DOCUMENT_TOOL_PROVIDER_ID,
  name: "read_sheet",
  runtimeName: "read_sheet",
  description: "Read a task-local XLSX, XLSM, CSV or TSV file into a bounded row and column window. Returns total dimensions and explicit continuation coordinates; workbook formulas return cached values. The call only reads files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096, description: "Task-local .xlsx, .xlsm, .csv, .tsv, .tab or .txt path." },
      sheet: { oneOf: [{ type: "string", minLength: 1, maxLength: 31 }, { type: "integer", minimum: 1 }], description: "Workbook sheet name or one-based index; defaults to first." },
      startRow: { type: "integer", minimum: 1, default: 1 },
      maxRows: { type: "integer", minimum: 1, maximum: 5_000, default: 200 },
      startColumn: { type: "integer", minimum: 1, default: 1 },
      maxColumns: { type: "integer", minimum: 1, maximum: 256, default: 64 }
    },
    required: ["path"],
    additionalProperties: false
  },
  requiresPermission: false
}, {
  serverId: DOCUMENT_TOOL_PROVIDER_ID,
  name: "inspect_pdf",
  runtimeName: "inspect_pdf",
  description: "Read structural evidence from a task-local PDF: page count, paper size, rotation, text preview, paint and image operations, and structurally blank pages. Inspect at most 50 pages per call. Continue with nextPages, inspectedThrough, previousVerdict and previousPdfSha256 until all pages are covered. Structural inspection does not confirm visual layout.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, maxLength: 4_096, description: "Task-local .pdf path." },
      pages: { type: "array", maxItems: 50, items: { type: "integer", minimum: 1 }, description: "One-based pages to inspect; defaults to the first maxPages pages." },
      inspectedThrough: { type: "integer", minimum: 0, default: 0, description: "Previous contiguous coverage cursor." },
      previousVerdict: { type: "string", enum: ["ok", "blank", "partial-blank", "warning", "incomplete"], description: "Verdict returned by the previous batch." },
      previousPdfSha256: { type: "string", pattern: "^[a-f0-9]{64}$", description: "SHA-256 returned by the previous batch." },
      maxPages: { type: "integer", minimum: 1, maximum: 50, default: 10 }
    },
    required: ["path"],
    additionalProperties: false
  },
  requiresPermission: false
}, {
  serverId: DOCUMENT_TOOL_PROVIDER_ID,
  name: "render_pdf",
  runtimeName: "render_pdf",
  description: "Render task-local HTML to PDF with an isolated offline Chromium job. Supply exactly one of htmlPath or html. Task-local relative styles, images and fonts are snapshotted before rendering. Report styling is added to unstyled HTML unless template is none. Existing files require overwrite: true. Inspect the PDF before delivery.",
  inputSchema: {
    type: "object",
    properties: {
      htmlPath: { type: "string", minLength: 1, maxLength: 4_096, description: "Task-local .html file path; exclusive with html." },
      html: { type: "string", minLength: 1, maxLength: RENDER_PDF_MAX_HTML_BYTES, description: "Inline HTML, at most 16 MiB UTF-8; exclusive with htmlPath." },
      outPath: { type: "string", minLength: 1, maxLength: 4_096, description: "Task-local .pdf output path." },
      pageSize: { type: "string", enum: [...PDF_PAGE_SIZES], default: "A4" },
      landscape: { type: "boolean", default: false },
      printBackground: { type: "boolean", default: true },
      margins: { type: "object", properties: {
        top: { type: "number", minimum: 0, maximum: 5, default: 0.4 },
        bottom: { type: "number", minimum: 0, maximum: 5, default: 0.4 },
        left: { type: "number", minimum: 0, maximum: 5, default: 0.4 },
        right: { type: "number", minimum: 0, maximum: 5, default: 0.4 }
      }, additionalProperties: false },
      template: { type: "string", enum: ["auto", "report", "none"], default: "auto" },
      theme: { type: "string", enum: [...DOCS_THEME_NAMES], default: "light" },
      overwrite: { type: "boolean", default: false }
    },
    required: ["outPath"],
    additionalProperties: false
  },
  requiresPermission: true
}]);

export interface DocumentToolPublisher {
  (input: Parameters<typeof publishDocumentOutput>[0]): ReturnType<typeof publishDocumentOutput>;
}

/** Session-owned local document Tool Provider; no path or authority comes from the model. */
export class DocumentToolBridgeProvider implements BridgeToolProvider {
  readonly id = DOCUMENT_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools: readonly McpToolDescriptor[];
  readonly configurablePolicy = Object.freeze({
    id: "joko-document-tools-policy",
    displayName: "Document tools",
    description: "Create and inspect documents in a trusted local task working directory.",
    productDefaultEnabled: true
  });
  readonly #store: Pick<OperationalStore, "getSession" | "getTarget">;
  readonly #publish: DocumentToolPublisher;
  readonly #pdfRenderer: PdfRenderer | undefined;

  constructor(options: {
    readonly store: Pick<OperationalStore, "getSession" | "getTarget">;
    readonly publish?: DocumentToolPublisher;
    readonly pdfRenderer?: PdfRenderer;
  }) {
    this.#store = options.store;
    this.#publish = options.publish ?? publishDocumentOutput;
    this.#pdfRenderer = options.pdfRenderer;
    this.tools = options.pdfRenderer ? TOOLS : TOOLS.filter(tool => tool.name !== "render_pdf");
  }

  includeForTarget(targetId: string): boolean {
    try {
      const target = this.#store.getTarget(targetId).descriptor;
      return target.trusted && target.remoteWorkspace === undefined;
    } catch {
      return false;
    }
  }

  async callTool(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    signal?.throwIfAborted();
    try {
      if (name !== "make_docx" && name !== "make_pptx" && name !== "make_xlsx" && name !== "read_sheet" && name !== "inspect_pdf" && name !== "render_pdf") throw new DocumentToolError("UNKNOWN_TOOL", "Document tool is not in this runtime.");
      if (name === "render_pdf" && !this.#pdfRenderer) throw new DocumentToolError("UNKNOWN_TOOL", "PDF rendering is unavailable in this runtime.");
      const root = this.#requireRoot(context);
      if (name === "make_pptx") return await this.#makePptx(args, root, signal, context);
      if (name === "make_xlsx") return await this.#makeXlsx(args, root, signal, context);
      if (name === "read_sheet") return await this.#readSheet(args, root, signal, context);
      if (name === "inspect_pdf") return await this.#inspectPdf(args, root, signal, context);
      if (name === "render_pdf") return await this.#renderPdf(args, root, signal, context);
      onlyKeys(args, ["markdown", "outPath", "title", "subtitle", "cover", "theme", "overwrite"]);
      const markdown = boundedString(args["markdown"], 4 * 1024 * 1024, false, "markdown");
      const outPath = boundedString(args["outPath"], 4_096, false, "outPath");
      if (!outPath.toLowerCase().endsWith(".docx")) throw new DocumentToolError("INVALID_EXTENSION", "Output filename must end in .docx.");
      const title = boundedString(args["title"], 4 * 1024, true, "title");
      const subtitle = boundedString(args["subtitle"], 16 * 1024, true, "subtitle");
      const cover = optionalBoolean(args["cover"], "cover");
      const overwrite = optionalBoolean(args["overwrite"], "overwrite") ?? false;
      const theme = args["theme"] === undefined ? "light" : args["theme"];
      if (typeof theme !== "string" || !DOCS_THEME_NAMES.includes(theme as DocsThemeName)) {
        throw new DocumentToolError("INVALID_ARGUMENT", "theme is invalid.");
      }
      const bytes = await markdownToDocxBuffer(markdown, {
        theme: theme as DocsThemeName,
        ...(title === undefined ? {} : { title }),
        ...(subtitle === undefined ? {} : { subtitle }),
        ...(cover === undefined ? {} : { cover })
      });
      signal?.throwIfAborted();
      if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
      const output = await this.#publish({ root, outPath, bytes, overwrite, ...(signal === undefined ? {} : { signal }) });
      signal?.throwIfAborted();
      if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
      return response({
        path: output.path,
        relativePath: output.relativePath,
        bytes: output.bytes,
        format: "docx",
        theme,
        cover: Boolean(title?.trim()) && (cover ?? true)
      }, false);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof DocumentOutputError || error instanceof DocumentInputError || error instanceof PptxDocumentError || error instanceof XlsxDocumentError || error instanceof SheetReadError || error instanceof PdfInspectError || error instanceof PdfRenderError || error instanceof PdfResourceError || error instanceof DocumentToolError) {
        return response({ errorCode: error.code, message: error.message,
          ...(error instanceof SheetReadError && error.available ? { available: error.available } : {}) }, true);
      }
      return response({ errorCode: "DOCUMENT_FAILED", message: "Document creation failed." }, true);
    }
  }

  async #makePptx(args: Readonly<Record<string, unknown>>, root: string, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    onlyKeys(args, ["slides", "outPath", "title", "theme", "footer", "overwrite"]);
    const outPath = boundedString(args["outPath"], 4_096, false, "outPath");
    if (!outPath.toLowerCase().endsWith(".pptx")) throw new DocumentToolError("INVALID_EXTENSION", "Output filename must end in .pptx.");
    const overwrite = optionalBoolean(args["overwrite"], "overwrite") ?? false;
    const result = await createPptxBuffer({
      slides: args["slides"],
      ...(args["title"] === undefined ? {} : { title: args["title"] }),
      ...(args["theme"] === undefined ? {} : { theme: args["theme"] }),
      ...(args["footer"] === undefined ? {} : { footer: args["footer"] })
    }, async (inPath, maxBytes, imageSignal) => {
      if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
      const bytes = await readDocumentInput({ root, inPath, maxBytes, ...(imageSignal === undefined ? {} : { signal: imageSignal }) });
      if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
      return bytes;
    }, signal);
    signal?.throwIfAborted();
    if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
    const output = await this.#publish({ root, outPath, bytes: result.buffer, overwrite, ...(signal === undefined ? {} : { signal }) });
    signal?.throwIfAborted();
    if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
    return response({
      path: output.path, relativePath: output.relativePath, bytes: output.bytes,
      format: "pptx", slides: result.slides, layouts: result.layouts,
      theme: result.theme, footer: result.footer
    }, false);
  }

  async #makeXlsx(args: Readonly<Record<string, unknown>>, root: string, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    onlyKeys(args, ["sheets", "outPath", "theme", "zebra", "overwrite"]);
    const outPath = boundedString(args["outPath"], 4_096, false, "outPath");
    if (!outPath.toLowerCase().endsWith(".xlsx")) throw new DocumentToolError("INVALID_EXTENSION", "Output filename must end in .xlsx.");
    const overwrite = optionalBoolean(args["overwrite"], "overwrite") ?? false;
    const result = await createXlsxBuffer({
      sheets: args["sheets"],
      ...(args["theme"] === undefined ? {} : { theme: args["theme"] }),
      ...(args["zebra"] === undefined ? {} : { zebra: args["zebra"] })
    }, signal);
    signal?.throwIfAborted();
    if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
    const output = await this.#publish({ root, outPath, bytes: result.buffer, overwrite, ...(signal === undefined ? {} : { signal }) });
    signal?.throwIfAborted();
    if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
    return response({
      path: output.path, relativePath: output.relativePath, bytes: output.bytes,
      format: "xlsx", sheets: result.sheets, theme: result.theme, zebra: result.zebra
    }, false);
  }

  async #readSheet(args: Readonly<Record<string, unknown>>, root: string, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    onlyKeys(args, ["path", "sheet", "startRow", "maxRows", "startColumn", "maxColumns"]);
    const result = await readSheet(args, root, signal);
    signal?.throwIfAborted();
    if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
    return response({ ...result }, false);
  }

  async #inspectPdf(args: Readonly<Record<string, unknown>>, root: string, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    onlyKeys(args, ["path", "pages", "inspectedThrough", "previousVerdict", "previousPdfSha256", "maxPages"]);
    const result = await inspectPdf(args, root, signal);
    signal?.throwIfAborted();
    if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
    return response({ ...result }, false);
  }

  async #renderPdf(args: Readonly<Record<string, unknown>>, root: string, signal: AbortSignal | undefined, context: BridgeToolCallContext): Promise<McpCallResult> {
    onlyKeys(args, ["htmlPath", "html", "outPath", "pageSize", "landscape", "printBackground", "margins", "template", "theme", "overwrite"]);
    const outPath = boundedString(args["outPath"], 4_096, false, "outPath");
    if (!outPath.toLowerCase().endsWith(".pdf")) throw new DocumentToolError("INVALID_EXTENSION", "Output filename must end in .pdf.");
    const overwrite = optionalBoolean(args["overwrite"], "overwrite") ?? false;
    const { outPath: _outPath, overwrite: _overwrite, ...content } = args;
    const rendered = await renderPdf(content, root, this.#pdfRenderer!, signal);
    signal?.throwIfAborted();
    if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
    const output = await this.#publish({ root, outPath, bytes: rendered.buffer, overwrite, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (this.#requireRoot(context) !== root) throw new DocumentToolError("STALE_SCOPE", "Task working directory changed.");
    return response({ path: output.path, relativePath: output.relativePath, bytes: output.bytes,
      format: "pdf", pageSize: rendered.pageSize, landscape: rendered.landscape,
      fontsReady: rendered.fontsReady, template: rendered.template, theme: rendered.theme,
      templateApplied: rendered.templateApplied, ...(rendered.title ? { title: rendered.title } : {}),
      ...(rendered.warning ? { warning: rendered.warning } : {}),
      nextStep: "Call inspect_pdf on this path to verify page count, size, text and blank pages before delivery." }, false);
  }

  #requireRoot(context: BridgeToolCallContext): string {
    const session = this.#store.getSession(context.sessionId).descriptor;
    const target = this.#store.getTarget(context.targetId).descriptor;
    if (session.targetId !== context.targetId || session.backendId !== target.backendId
      || session.binding.generation !== context.generation || session.deletedAt !== undefined || session.archived
      || !target.trusted || target.remoteWorkspace !== undefined || session.remoteWorkspace !== undefined
      || (session.worktree !== undefined && session.worktree.state !== "active")) {
      throw new DocumentToolError("STALE_SCOPE", "Document task scope is stale or unavailable.");
    }
    return session.worktree?.path ?? target.workspaceRoot;
  }
}

class DocumentToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function onlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new DocumentToolError("INVALID_ARGUMENT", "Document arguments contain unknown fields.");
  }
}

function boundedString(value: unknown, maximumBytes: number, optional: false, name: string): string;
function boundedString(value: unknown, maximumBytes: number, optional: true, name: string): string | undefined;
function boundedString(value: unknown, maximumBytes: number, optional: boolean, name: string): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || (!optional && value.length === 0) || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new DocumentToolError("INVALID_ARGUMENT", `${name} is invalid.`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new DocumentToolError("INVALID_ARGUMENT", `${name} is invalid.`);
  return value;
}

function response(payload: Readonly<Record<string, unknown>>, isError: boolean): McpCallResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError };
}
