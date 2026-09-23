import { createPptxBuffer, markdownToDocxBuffer, publishDocumentOutput, readDocumentInput, DOCS_THEME_NAMES, DocumentInputError, DocumentOutputError, PptxDocumentError, PPTX_LAYOUT_NAMES, PPTX_MAX_SLIDES, PPTX_MAX_BULLETS_PER_SLIDE, type DocsThemeName } from "@joko/tool-document";
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
}]);

export interface DocumentToolPublisher {
  (input: Parameters<typeof publishDocumentOutput>[0]): ReturnType<typeof publishDocumentOutput>;
}

/** Session-owned local document Tool Provider; no path or authority comes from the model. */
export class DocumentToolBridgeProvider implements BridgeToolProvider {
  readonly id = DOCUMENT_TOOL_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools = TOOLS;
  readonly configurablePolicy = Object.freeze({
    id: "joko-document-tools-policy",
    displayName: "Document tools",
    description: "Create and inspect documents in a trusted local task working directory.",
    productDefaultEnabled: true
  });
  readonly #store: Pick<OperationalStore, "getSession" | "getTarget">;
  readonly #publish: DocumentToolPublisher;

  constructor(options: {
    readonly store: Pick<OperationalStore, "getSession" | "getTarget">;
    readonly publish?: DocumentToolPublisher;
  }) {
    this.#store = options.store;
    this.#publish = options.publish ?? publishDocumentOutput;
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
      if (name !== "make_docx" && name !== "make_pptx") throw new DocumentToolError("UNKNOWN_TOOL", "Document tool is not in this runtime.");
      const root = this.#requireRoot(context);
      if (name === "make_pptx") return await this.#makePptx(args, root, signal, context);
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
      if (error instanceof DocumentOutputError || error instanceof DocumentInputError || error instanceof PptxDocumentError || error instanceof DocumentToolError) {
        return response({ errorCode: error.code, message: error.message }, true);
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
