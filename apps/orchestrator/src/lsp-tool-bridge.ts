import {
  isLspToolError,
  LspToolError,
  TypeScriptLspBridge,
  detectTypeScriptProject,
  type LspBridgeResponse,
  type LspCallOptions,
  type LspToolRequest
} from "@joko/tool-lsp";
import type { OperationalStore } from "@joko/store";

import type {
  BridgeToolCallContext,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";

export const LSP_BRIDGE_PROVIDER_ID = "joko_lsp";
export const LANGUAGE_TOOL_SETTING_KEY = "settings.language_tools";

export function languageToolsEnabled(value: unknown): boolean {
  return isRecord(value) && value["enabled"] === true;
}

export function resolveAuthenticatedLspTarget(
  store: Pick<OperationalStore, "getSession" | "getTarget">,
  context: BridgeToolCallContext
): AuthenticatedLspTarget {
  const session = store.getSession(context.sessionId).descriptor;
  if (session.targetId !== context.targetId || session.binding.generation !== context.generation) {
    throw new Error("Authenticated language target context is stale.");
  }
  const target = store.getTarget(context.targetId).descriptor;
  if (session.worktree !== undefined && session.worktree.state !== "active") {
    throw new Error("The isolated language workspace is no longer active.");
  }
  return {
    workspaceRoot: session.worktree?.path ?? target.workspaceRoot,
    trusted: target.trusted
  };
}

const MAXIMUM_PATH_CHARACTERS = 32_768;
const MAXIMUM_QUERY_CHARACTERS = 1_024;
const MAXIMUM_RESULTS = 100_000;

const FILE_PROPERTY = Object.freeze({
  type: "string",
  minLength: 1,
  maxLength: MAXIMUM_PATH_CHARACTERS,
  description: "Workspace-relative TypeScript or JavaScript source path."
});
const LINE_PROPERTY = Object.freeze({
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: "One-based editor line."
});
const CHARACTER_PROPERTY = Object.freeze({
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: "One-based UTF-16 editor character."
});
const MAXIMUM_RESULTS_PROPERTY = Object.freeze({
  type: "integer",
  minimum: 1,
  maximum: MAXIMUM_RESULTS,
  description: "Optional maximum number of returned items."
});

const POSITION_SCHEMA = objectSchema({
  file: FILE_PROPERTY,
  line: LINE_PROPERTY,
  character: CHARACTER_PROPERTY,
  max_results: MAXIMUM_RESULTS_PROPERTY
}, ["file", "line", "character"]);

const TOOLS: readonly McpToolDescriptor[] = Object.freeze([
  directTool(
    "hover",
    "hover",
    "Return TypeScript or JavaScript hover and type information at an exact source position.",
    POSITION_SCHEMA
  ),
  directTool(
    "goto_definition",
    "goto_definition",
    "Find workspace definitions for the symbol at an exact source position.",
    POSITION_SCHEMA
  ),
  directTool(
    "find_references",
    "find_references",
    "Find exact workspace references for the symbol at an exact source position.",
    POSITION_SCHEMA
  ),
  directTool(
    "outline",
    "file_outline",
    "Return the semantic outline for one TypeScript or JavaScript source file.",
    objectSchema({ file: FILE_PROPERTY, max_results: MAXIMUM_RESULTS_PROPERTY }, ["file"])
  ),
  directTool(
    "workspace_symbol",
    "workspace_symbols",
    "Search symbols across the authenticated TypeScript or JavaScript workspace.",
    objectSchema({
      query: {
        type: "string",
        minLength: 1,
        maxLength: MAXIMUM_QUERY_CHARACTERS,
        description: "Non-empty symbol-name query."
      },
      max_results: MAXIMUM_RESULTS_PROPERTY
    }, ["query"])
  ),
  directTool(
    "incoming_calls",
    "incoming_calls",
    "Find workspace functions and methods that call the symbol at an exact source position.",
    POSITION_SCHEMA
  )
]);

export interface AuthenticatedLspTarget {
  readonly workspaceRoot: string;
  readonly trusted: boolean;
}

/** The snapshot check is intentionally separate from the authenticated call
 * resolution because snapshots do not yet have a Session identity. */
export interface LspToolTargetResolver {
  resolveSnapshot(targetId: string): AuthenticatedLspTarget;
  resolveAuthenticated(context: BridgeToolCallContext): AuthenticatedLspTarget | Promise<AuthenticatedLspTarget>;
}

export interface LspToolBackend {
  call(request: LspToolRequest, options?: LspCallOptions): Promise<LspBridgeResponse>;
  dispose?(): void;
}

export interface LspToolBridgeProviderOptions {
  readonly targetResolver: LspToolTargetResolver;
  readonly backend?: LspToolBackend;
  readonly isUserEnabled?: () => boolean;
  readonly detectProject?: (workspaceRoot: string) => boolean;
}

/** Six read-only language tools exposed as direct Pi runtime tools. The
 * workspace root is resolved only from the authenticated bridge context and
 * is never accepted from model-controlled tool arguments. */
export class LspToolBridgeProvider implements BridgeToolProvider {
  readonly id = LSP_BRIDGE_PROVIDER_ID;
  readonly generation = 1;
  readonly available = true;
  readonly tools = TOOLS;
  readonly #targetResolver: LspToolTargetResolver;
  readonly #backend: LspToolBackend;
  readonly #ownsBackend: boolean;
  readonly #isUserEnabled: () => boolean;
  readonly #detectProject: (workspaceRoot: string) => boolean;
  #disposed = false;

  constructor(options: LspToolBridgeProviderOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("LSP bridge options are required.");
    if (options.targetResolver === null || typeof options.targetResolver !== "object"
      || typeof options.targetResolver.resolveSnapshot !== "function"
      || typeof options.targetResolver.resolveAuthenticated !== "function") {
      throw new TypeError("LSP bridge requires an authenticated target resolver.");
    }
    if (options.isUserEnabled !== undefined && typeof options.isUserEnabled !== "function") {
      throw new TypeError("Language tool enablement must be a function.");
    }
    if (options.detectProject !== undefined && typeof options.detectProject !== "function") {
      throw new TypeError("Language project detection must be a function.");
    }
    this.#targetResolver = options.targetResolver;
    this.#backend = options.backend ?? new TypeScriptLspBridge();
    this.#ownsBackend = options.backend === undefined;
    this.#isUserEnabled = options.isUserEnabled ?? (() => false);
    this.#detectProject = options.detectProject ?? detectTypeScriptProject;
  }

  includeForTarget(targetId: string): boolean {
    if (this.#disposed || typeof targetId !== "string" || targetId.length === 0) return false;
    try {
      if (!this.#isUserEnabled()) return false;
      const target = this.#targetResolver.resolveSnapshot(targetId);
      return target.trusted === true
        && typeof target.workspaceRoot === "string"
        && this.#detectProject(target.workspaceRoot);
    } catch {
      return false;
    }
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<McpCallResult> {
    if (!isBridgeToolName(name)) throw new Error("Language tool is not part of this provider generation.");
    let response: LspBridgeResponse;
    try {
      if (this.#disposed) throw new LspToolError("INTERNAL", "The language tool provider has been disposed.");
      const parsed = parseArguments(name, arguments_);
      const target = await this.#targetResolver.resolveAuthenticated(context);
      if (target === null || typeof target !== "object" || target.trusted !== true
        || typeof target.workspaceRoot !== "string") {
        throw new LspToolError("WORKSPACE_UNSAFE", "Language tools are available only for a trusted target.");
      }
      const request = requestFor(name, parsed, target.workspaceRoot);
      response = await this.#backend.call(request, signal === undefined ? undefined : { signal });
    } catch (error) {
      response = failureResponse(error);
    }
    return responseResult(response);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#ownsBackend) this.#backend.dispose?.();
  }
}

type BridgeToolName = "find_references" | "goto_definition" | "hover" | "incoming_calls" | "outline" | "workspace_symbol";

interface ParsedArguments {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly query?: string;
  readonly maxResults?: number;
}

function parseArguments(
  name: BridgeToolName,
  value: Readonly<Record<string, unknown>>
): ParsedArguments {
  if (!isRecord(value)) throw invalidArgument("arguments", "Tool arguments must be an object.");
  if (name === "workspace_symbol") {
    requireOnlyKeys(value, ["query", "max_results"]);
    return {
      query: requiredString(value["query"], "query"),
      ...optionalMaximumResults(value["max_results"])
    };
  }
  if (name === "outline") {
    requireOnlyKeys(value, ["file", "max_results"]);
    return {
      file: requiredString(value["file"], "file"),
      ...optionalMaximumResults(value["max_results"])
    };
  }
  requireOnlyKeys(value, ["file", "line", "character", "max_results"]);
  return {
    file: requiredString(value["file"], "file"),
    line: positiveInteger(value["line"], "line"),
    column: positiveInteger(value["character"], "character"),
    ...optionalMaximumResults(value["max_results"])
  };
}

function requestFor(
  name: BridgeToolName,
  parsed: ParsedArguments,
  workspaceRoot: string
): LspToolRequest {
  const limit = parsed.maxResults === undefined ? {} : { maxResults: parsed.maxResults };
  if (name === "workspace_symbol") {
    return { action: "workspace_symbol", workspaceRoot, query: parsed.query ?? "", ...limit };
  }
  if (name === "outline") {
    return { action: "outline", workspaceRoot, file: parsed.file ?? "", ...limit };
  }
  return {
    action: name,
    workspaceRoot,
    file: parsed.file ?? "",
    line: parsed.line ?? 0,
    column: parsed.column ?? 0,
    ...limit
  };
}

function failureResponse(error: unknown): LspBridgeResponse {
  const accepted = isLspToolError(error)
    ? error
    : new LspToolError("INTERNAL", "The language tool operation failed safely.");
  return Object.freeze({ ok: false, error: accepted.toJSON() });
}

function responseResult(response: LspBridgeResponse): McpCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    structuredContent: response as unknown as Readonly<Record<string, unknown>>,
    isError: !response.ok
  };
}

function directTool(
  name: BridgeToolName,
  runtimeName: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>
): McpToolDescriptor {
  return Object.freeze({
    serverId: LSP_BRIDGE_PROVIDER_ID,
    name,
    runtimeName,
    description,
    inputSchema,
    requiresPermission: false
  });
}

function objectSchema(
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  required: readonly string[]
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    properties: Object.freeze({ ...properties }),
    required: Object.freeze([...required]),
    additionalProperties: false
  });
}

function optionalMaximumResults(value: unknown): { readonly maxResults?: number } {
  return value === undefined ? {} : { maxResults: boundedInteger(value, "max_results", 1, MAXIMUM_RESULTS) };
}

function positiveInteger(value: unknown, field: string): number {
  return boundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new LspToolError("INVALID_ARGUMENT", `${field} is outside its allowed integer range.`, {
      field,
      minimum,
      maximum
    });
  }
  return value as number;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalidArgument(field, `${field} must be a string.`);
  return value;
}

function requireOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw invalidArgument("arguments", "Tool arguments contain unsupported fields.");
  }
}

function invalidArgument(field: string, message: string): LspToolError {
  return new LspToolError("INVALID_ARGUMENT", message, { field });
}

function isBridgeToolName(value: string): value is BridgeToolName {
  return value === "hover" || value === "goto_definition" || value === "find_references"
    || value === "outline" || value === "workspace_symbol" || value === "incoming_calls";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
