import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isWithin } from "@joko/core/policy";
import {
  ComputerToolArgumentError,
  ComputerToolProvider,
  ComputerToolProviderError,
  isComputerPublicToolName,
  normalizeComputerToolArguments,
  type ComputerSessionFence,
  type ComputerToolCallResult,
  type ComputerToolDescriptor
} from "@joko/tool-computer";
import type { OperationalStore } from "@joko/store";

import type {
  BridgeToolCallContext,
  BridgeToolProvider,
  McpCallResult,
  McpToolDescriptor
} from "./mcp-router.js";

export const COMPUTER_BRIDGE_PROVIDER_ID = "joko_computer";

const LIST_TOOLS_DESCRIPTION =
  "Discover local desktop computer-use tools. These tools operate on the user desktop through the installed driver. "
  + "Use read-only status/get_accessibility_tree/list_apps/list_windows/get_window_state before click/type_text/press_key/hotkey.";
const CALL_TOOL_DESCRIPTION =
  "Invoke a local desktop computer-use tool. Arguments are validated before dispatching to the host driver.";
const COMPUTER_TOOL_WORKFLOW =
  "Start with status and check_permissions. Use get_accessibility_tree/list_windows, optionally narrow list_windows with query/workspace_root/process_name (for example, {\"process_name\":\"Simulator\"}), inspect a target with get_window_state, perform one action, and call get_window_state again to verify. Targeted actions such as click/type_text require pid; include window_id whenever the target window is known, and always for coordinates. Use get_window_state with {\"capture_mode\":\"vision\"} for screenshots and normally omit screenshot_out_file. Element indices are only valid for the latest snapshot of the same pid/window_id: pass the snapshot_id from get_window_state along with element_index, and re-observe when an action is rejected with STALE_SNAPSHOT. Use start_recording/stop_recording/replay_trajectory only when the user explicitly asks for recording or replay.";
const EMPTY_OBJECT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false
});

/**
 * Projects the installed computer MCP catalog through Orchestrator's authenticated
 * per-Session bridge. New snapshots honor owner opt-in while grants already
 * held by active Sessions remain callable until their normal expiry.
 */
export class ComputerToolBridgeProvider implements BridgeToolProvider {
  readonly id = COMPUTER_BRIDGE_PROVIDER_ID;
  readonly generation = 1;
  readonly #provider: ComputerToolProvider;
  readonly #store: OperationalStore;
  readonly #enabledForNewSessions: () => boolean;
  readonly #sessionFences = new Map<string, ComputerSessionFence>();
  #catalog: readonly ComputerToolDescriptor[] = [];
  #catalogByName: ReadonlyMap<string, ComputerToolDescriptor> = new Map();
  #bridgeTools: readonly McpToolDescriptor[] = [];
  #prepareTail: Promise<void> = Promise.resolve();

  constructor(input: {
    readonly provider: ComputerToolProvider;
    readonly store: OperationalStore;
    readonly enabledForNewSessions: () => boolean;
  }) {
    this.#provider = input.provider;
    this.#store = input.store;
    this.#enabledForNewSessions = input.enabledForNewSessions;
  }

  get tools(): readonly McpToolDescriptor[] {
    return this.#bridgeTools;
  }

  get available(): boolean {
    return this.#catalog.length > 0;
  }

  get includeInSnapshot(): boolean {
    return this.available && this.#enabledForNewSessions();
  }

  prepare(signal?: AbortSignal): Promise<void> {
    const task = this.#prepareTail.then(async () => {
      if (this.#catalog.length > 0) return;
      const fence = await this.#provider.openSession("catalog", signal);
      try {
        const tools = await this.#provider.listTools(fence, signal);
        const catalog = Object.freeze(tools.map(freezeToolDescriptor));
        if (catalog.length === 0) throw new Error("Computer automation reported no tools.");
        const catalogByName = new Map<string, ComputerToolDescriptor>();
        for (const tool of catalog) {
          if (catalogByName.has(tool.name)) throw new Error("Computer automation reported a duplicate tool name.");
          catalogByName.set(tool.name, tool);
        }
        this.#catalog = catalog;
        this.#catalogByName = catalogByName;
        this.#bridgeTools = createBridgeToolDescriptors(catalog);
      } finally {
        await this.#provider.closeSession(fence).catch(() => undefined);
      }
    });
    this.#prepareTail = task.then(() => undefined, () => undefined);
    return task;
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    context: BridgeToolCallContext
  ): Promise<McpCallResult> {
    if (name === "list_tools") {
      if (Object.keys(arguments_).length > 0) return invalidWrapperArguments("list_tools");
      return textResult({
        ok: true,
        tools: this.#catalog.map((tool) => ({
          name: tool.name,
          description: tool.description?.trim() || tool.title?.trim() || `Computer automation: ${tool.name}`,
          readOnly: tool.annotations?.["readOnlyHint"] === true,
          inputSchema: tool.inputSchema
        })),
        workflow: COMPUTER_TOOL_WORKFLOW
      });
    }
    if (name !== "call_tool") {
      return textResult({ ok: false, errorCode: "UNKNOWN_TOOL", data: { requested: name } }, true);
    }
    const call = parseCallToolArguments(arguments_, this.#catalog);
    if ("error" in call) return call.error;
    const definition = this.#catalogByName.get(call.name);
    if (definition === undefined) {
      return textResult({ ok: false, errorCode: "UNKNOWN_TOOL", data: { requested: call.name } }, true);
    }
    let normalizedArguments = call.arguments;
    if (isComputerPublicToolName(call.name)) {
      try {
        normalizedArguments = normalizeComputerToolArguments(call.name, normalizedArguments);
      } catch (error) {
        if (error instanceof ComputerToolArgumentError) {
          return invalidSelectedToolArguments(call.name, definition, error.field);
        }
        throw error;
      }
    }
    if (signal?.aborted === true) return requestCancelledResult();
    const workspaceRoot = this.#store.getTarget(context.targetId).descriptor.workspaceRoot;
    let safeArguments: Readonly<Record<string, unknown>>;
    try {
      safeArguments = await constrainWorkspacePaths(normalizedArguments, workspaceRoot);
    } catch (error) {
      return textResult({
        ok: false,
        errorCode: "PATH_NOT_ALLOWED",
        data: {
          tool: call.name,
          ...(error instanceof ComputerWorkspacePathError ? { arg: error.argument } : {}),
          message: safeErrorMessage(error)
        }
      }, true, workspaceRoot);
    }
    try {
      const result = await this.#callWithSession(
        context.sessionId,
        call.name,
        safeArguments,
        signal,
        workspaceRoot
      );
      return mapSelectedToolResult(call.name, result, workspaceRoot);
    } catch (error) {
      if (isAbortError(error)) return requestCancelledResult();
      if (error instanceof ComputerToolProviderError) {
        if (error.code === "unknown_tool") {
          return textResult({ ok: false, errorCode: "UNKNOWN_TOOL", data: { requested: call.name } }, true);
        }
        if (error.code === "invalid_arguments") {
          return invalidSelectedToolArguments(call.name, definition);
        }
        if (error.code === "stale_snapshot") {
          return textResult({
            ok: false,
            errorCode: "STALE_SNAPSHOT",
            data: {
              tool: call.name,
              hint: "The element_index comes from a window snapshot that is no longer the latest observation of this window, so the target element may have moved or changed. Call get_window_state again for this pid/window_id, then retry with the fresh snapshot_id and element_index."
            }
          }, true);
        }
      }
      return textResult({
        ok: false,
        errorCode: "COMPUTER_DRIVER_ERROR",
        data: { message: safeErrorMessage(error) }
      }, true, workspaceRoot);
    }
  }

  close(): Promise<void> {
    this.#sessionFences.clear();
    return this.#provider.closeAll();
  }

  async closeSession(sessionId: string): Promise<void> {
    const fence = this.#sessionFences.get(sessionId);
    if (fence === undefined) return;
    this.#sessionFences.delete(sessionId);
    try {
      await this.#provider.closeSession(fence);
    } catch (error) {
      if (!(error instanceof ComputerToolProviderError) || error.code !== "stale_session") throw error;
    }
  }

  async #callWithSession(
    sessionId: string,
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    workspaceRoot: string
  ): Promise<ComputerToolCallResult> {
    let fence = this.#sessionFences.get(sessionId);
    if (fence === undefined) {
      fence = await this.#provider.openSession(sessionId, signal);
      this.#sessionFences.set(sessionId, fence);
    }
    try {
      return await this.#provider.callTool(fence, name, arguments_, signal, { workspaceRoot });
    } catch (error) {
      if (!(error instanceof ComputerToolProviderError) || error.code !== "stale_session") throw error;
      this.#sessionFences.delete(sessionId);
      const replacement = await this.#provider.openSession(sessionId, signal);
      this.#sessionFences.set(sessionId, replacement);
      return this.#provider.callTool(replacement, name, arguments_, signal, { workspaceRoot });
    }
  }
}

function createBridgeToolDescriptors(catalog: readonly ComputerToolDescriptor[]): readonly McpToolDescriptor[] {
  return Object.freeze([
    Object.freeze({
      serverId: COMPUTER_BRIDGE_PROVIDER_ID,
      name: "list_tools",
      description: LIST_TOOLS_DESCRIPTION,
      inputSchema: EMPTY_OBJECT_SCHEMA,
      requiresPermission: true
    }),
    Object.freeze({
      serverId: COMPUTER_BRIDGE_PROVIDER_ID,
      name: "call_tool",
      description: CALL_TOOL_DESCRIPTION,
      inputSchema: Object.freeze({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: Object.freeze({
          name: Object.freeze({
            type: "string",
            enum: Object.freeze(catalog.map((tool) => tool.name)),
            description: "Tool name from list_tools"
          }),
          args: Object.freeze({
            type: "object",
            description: "Arguments object for the selected tool（传 JSON 对象本身，不要序列化成字符串）",
            additionalProperties: Object.freeze({})
          })
        }),
        required: Object.freeze(["name", "args"]),
        additionalProperties: false
      }),
      requiresPermission: true
    })
  ]);
}

function freezeToolDescriptor(tool: ComputerToolDescriptor): ComputerToolDescriptor {
  return Object.freeze({
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: freezeJsonRecord(tool.inputSchema),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: freezeJsonRecord(tool.outputSchema) }),
    ...(tool.annotations === undefined ? {} : { annotations: freezeJsonRecord(tool.annotations) })
  });
}

function freezeJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeJsonValue(item)])));
}

function freezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJsonValue));
  if (isRecord(value)) return freezeJsonRecord(value);
  return value;
}

function parseCallToolArguments(
  value: Readonly<Record<string, unknown>>,
  catalog: readonly ComputerToolDescriptor[]
): { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> } | { readonly error: McpCallResult } {
  const keys = Object.keys(value);
  const name = value["name"];
  const parsedArguments = parseJsonObject(value["args"]);
  if (
    keys.length !== 2
    || !keys.includes("name")
    || !keys.includes("args")
    || typeof name !== "string"
    || parsedArguments === undefined
  ) return { error: invalidWrapperArguments("call_tool", catalog) };
  return { name, arguments: parsedArguments };
}

function parseJsonObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) as unknown; } catch { return undefined; }
  }
  return isRecord(candidate) ? candidate : undefined;
}

function invalidWrapperArguments(
  tool: "list_tools" | "call_tool",
  catalog: readonly ComputerToolDescriptor[] = []
): McpCallResult {
  const schema = tool === "list_tools"
    ? EMPTY_OBJECT_SCHEMA
    : createBridgeToolDescriptors(catalog)[1]!.inputSchema;
  return textResult({
    ok: false,
    errorCode: "INVALID_ARGS",
    data: {
      tool,
      validation_errors: [{ path: [], message: `Arguments for ${tool} do not match its strict schema.` }],
      schema
    }
  }, true);
}

function invalidSelectedToolArguments(
  name: string,
  definition: ComputerToolDescriptor,
  field?: string
): McpCallResult {
  return textResult({
    ok: false,
    errorCode: "INVALID_ARGS",
    data: {
      tool: name,
      validation_errors: [{
        path: field === undefined ? [] : [field],
        message: field === undefined
          ? "Arguments do not match the selected tool schema."
          : `Argument ${field} does not match the selected tool schema.`
      }],
      schema: definition.inputSchema
    }
  }, true);
}

function mapSelectedToolResult(
  name: string,
  result: ComputerToolCallResult,
  workspaceRoot: string
): McpCallResult {
  const data = sanitizeResultValue(computerResultData(result), workspaceRoot);
  if (result.isError === true) {
    if (isRecord(data) && data["ok"] === false && typeof data["errorCode"] === "string") {
      return textResult(data, true);
    }
    return textResult({
      ok: false,
      errorCode: "COMPUTER_DRIVER_ERROR",
      data: { message: computerResultErrorMessage(data, name) }
    }, true, workspaceRoot);
  }
  const snapshotId = name === "get_window_state" && isRecord(data) && typeof data["snapshot_id"] === "string"
    ? data["snapshot_id"]
    : undefined;
  return textResult({
    ok: true,
    tool: name,
    ...(snapshotId === undefined ? {} : { snapshot_id: snapshotId }),
    data
  }, false, workspaceRoot);
}

function computerResultData(result: ComputerToolCallResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const hasNonText = result.content.some((item) => isRecord(item) && item["type"] !== "text");
    if (hasNonText) return result;
    for (const item of result.content) {
      if (!isRecord(item) || item["type"] !== "text" || typeof item["text"] !== "string") continue;
      try { return JSON.parse(item["text"]) as unknown; } catch { return item["text"]; }
    }
  }
  if (result.toolResult !== undefined) return result.toolResult;
  return result;
}

function computerResultErrorMessage(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim() !== "") return boundedMessage(value);
  if (isRecord(value)) {
    for (const candidate of [value["message"], value["error"], value["stderr"]]) {
      if (typeof candidate === "string" && candidate.trim() !== "") return boundedMessage(candidate);
    }
  }
  return `Computer automation tool ${name} returned an error.`;
}

function requestCancelledResult(): McpCallResult {
  return textResult({
    ok: false,
    errorCode: "REQUEST_CANCELLED",
    data: { message: "Trajectory replay stopped because the request was cancelled." }
  }, true);
}

function textResult(value: unknown, isError = false, workspaceRoot?: string): McpCallResult {
  const safe = workspaceRoot === undefined ? value : sanitizeResultValue(value, workspaceRoot);
  return {
    content: [{ type: "text", text: JSON.stringify(safe) }],
    isError
  };
}

function safeErrorMessage(error: unknown): string {
  return boundedMessage(error instanceof Error ? error.message : String(error));
}

function boundedMessage(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (normalized === "") return "Computer automation request failed.";
  return normalized.length <= 8 * 1024 ? normalized : `${normalized.slice(0, 8 * 1024 - 1)}…`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function constrainWorkspacePaths(
  value: Readonly<Record<string, unknown>>,
  workspaceRoot: string
): Promise<Readonly<Record<string, unknown>>> {
  const canonicalRoot = await realpath(workspaceRoot).catch(() => undefined);
  return rewriteArgumentRecord(value, workspaceRoot, canonicalRoot, 0);
}

async function rewriteArgumentRecord(
  value: Readonly<Record<string, unknown>>,
  workspaceRoot: string,
  canonicalRoot: string | undefined,
  depth: number
): Promise<Readonly<Record<string, unknown>>> {
  if (depth > 16) throw new Error("Computer automation arguments are too deeply nested.");
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && isPathArgument(key)) {
      if (item.includes("\0") || item.trim() === "") {
        throw new ComputerWorkspacePathError(key, "Computer automation file path is invalid.");
      }
      const candidate = resolve(workspaceRoot, item);
      if (!isWithin(candidate, workspaceRoot)) {
        throw new ComputerWorkspacePathError(key, "Computer automation file path escapes the active workspace.");
      }
      if (canonicalRoot !== undefined) {
        try {
          await assertCanonicalPathBoundary(candidate, canonicalRoot);
        } catch (error) {
          throw new ComputerWorkspacePathError(key, safeErrorMessage(error));
        }
      }
      result[key] = candidate;
    } else if (Array.isArray(item)) {
      result[key] = await rewriteArgumentArray(item, workspaceRoot, canonicalRoot, depth + 1);
    } else if (isRecord(item)) {
      result[key] = await rewriteArgumentRecord(item, workspaceRoot, canonicalRoot, depth + 1);
    } else {
      result[key] = item;
    }
  }
  return result;
}

class ComputerWorkspacePathError extends Error {
  constructor(readonly argument: string, message: string) {
    super(message);
    this.name = "ComputerWorkspacePathError";
  }
}

async function rewriteArgumentArray(
  value: readonly unknown[],
  workspaceRoot: string,
  canonicalRoot: string | undefined,
  depth: number
): Promise<readonly unknown[]> {
  if (depth > 16) throw new Error("Computer automation arguments are too deeply nested.");
  return Promise.all(value.map(async (item) => Array.isArray(item)
    ? rewriteArgumentArray(item, workspaceRoot, canonicalRoot, depth + 1)
    : isRecord(item)
      ? rewriteArgumentRecord(item, workspaceRoot, canonicalRoot, depth + 1)
      : item));
}

async function assertCanonicalPathBoundary(candidate: string, canonicalRoot: string): Promise<void> {
  let current = candidate;
  for (;;) {
    try {
      const canonical = await realpath(current);
      if (!isWithin(canonical, canonicalRoot)) {
        throw new Error("Computer automation file path resolves outside the active workspace.");
      }
      return;
    } catch (error) {
      if (error instanceof Error && /resolves outside/u.test(error.message)) throw error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error("Computer automation file path could not be resolved safely.");
      }
      const parent = dirname(current);
      if (parent === current) throw new Error("Computer automation file path could not be resolved safely.");
      current = parent;
    }
  }
}

function isPathArgument(key: string): boolean {
  const normalized = key.replace(/([a-z\d])([A-Z])/gu, "$1_$2");
  if (normalized.toLowerCase() === "workspace_root") return true;
  return /(?:^|_)(?:path|file|dir|directory|output|recording|trajectory)(?:$|_)/iu.test(normalized);
}

function sanitizeResultValue(value: unknown, workspaceRoot: string, depth = 0): unknown {
  if (depth > 24) return "[truncated]";
  if (typeof value === "string") return redactWorkspaceRoot(value, workspaceRoot);
  if (Array.isArray(value)) return value.map((item) => sanitizeResultValue(item, workspaceRoot, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redactWorkspaceRoot(key, workspaceRoot),
    sanitizeResultValue(item, workspaceRoot, depth + 1)
  ]));
}

function redactWorkspaceRoot(value: string, workspaceRoot: string): string {
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/$/u, "");
  const normalizedValue = value.replaceAll("\\", "/");
  if (normalizedRoot === "") return redactExternalLocalPaths(normalizedValue);
  if (process.platform !== "win32") {
    return redactExternalLocalPaths(normalizedValue.replaceAll(normalizedRoot, "."));
  }
  const comparableValue = normalizedValue.toLowerCase();
  const comparableRoot = normalizedRoot.toLowerCase();
  let redacted = "";
  let offset = 0;
  for (let match = comparableValue.indexOf(comparableRoot, offset); match >= 0; match = comparableValue.indexOf(comparableRoot, offset)) {
    redacted += `${normalizedValue.slice(offset, match)}.`;
    offset = match + normalizedRoot.length;
  }
  return redactExternalLocalPaths(`${redacted}${normalizedValue.slice(offset)}`);
}

function redactExternalLocalPaths(value: string): string {
  return value
    .replace(/\b[A-Za-z]:\/(?!\/)[^\s"'<>\])}]+/gu, "[local-path]")
    .replace(/\/(?:Users|home|tmp|var|private)\/[^\s"'<>\])}]+/gu, "[local-path]");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
