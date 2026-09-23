import { markdownToDocxBuffer, publishDocumentOutput, DOCS_THEME_NAMES, DocumentOutputError, type DocsThemeName } from "@joko/tool-document";
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
      if (name !== "make_docx") throw new DocumentToolError("UNKNOWN_TOOL", "Document tool is not in this runtime.");
      const root = this.#requireRoot(context);
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
      if (error instanceof DocumentOutputError || error instanceof DocumentToolError) {
        return response({ errorCode: error.code, message: error.message }, true);
      }
      return response({ errorCode: "DOCUMENT_FAILED", message: "Document creation failed." }, true);
    }
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
