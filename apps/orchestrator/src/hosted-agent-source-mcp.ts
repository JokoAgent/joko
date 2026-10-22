import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AdapterContext } from "@joko/core";
import { operationBodyHash, type OperationalStore } from "@joko/store";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, CreateTaskResultSchema, ListToolsRequestSchema, isJSONRPCRequest,
  type CallToolRequest, type CallToolResult, type CreateTaskResult, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import { createMcpModelProxy, type McpModelRequestExtra } from "./mcp-apps/server-proxy.js";
import type { AppConnection } from "./mcp-apps/connection.js";
import type { McpBridgeCallResult, McpRouter, PiMcpBridgeSnapshot } from "./mcp-router.js";
import { hostedMcpRequestSchema, type HostedMcpFrame, type HostedMcpMessage, type HostedMcpCatalog } from "./hosted-agent-mcp-wire.js";
import type { ExecutorWorkspace } from "./hosted-agent-workspace.js";
import { pathTextContext } from "./hosted-agent-workspace.js";

interface NativeCall {
  readonly pipe: Pipe; readonly context: AdapterContext; readonly serverId: string; readonly toolName: string; readonly requestId: string;
  readonly arguments: Readonly<Record<string, unknown>>; readonly request: CallToolRequest; readonly extra: McpModelRequestExtra;
  readonly connection?: AppConnection; readonly resolve: (result: McpBridgeCallResult) => void; readonly reject: (error: Error) => void;
  called: boolean; result?: McpBridgeCallResult;
}
interface Pipe {
  readonly serverId: string; readonly server: Server | McpServer; readonly transport: Transport;
  readonly frames: HostedMcpFrame[]; readonly requests: Map<RequestId, AdapterContext>; readonly waiters: Set<() => void>;
  bytes: number; closed: boolean;
}
const TTL_MS = 60_000, MAXIMUM_PIPE_BYTES = 16 * 1024 * 1024;

/** Original-node MCP authority. Neither the Router grant nor upstream
 * addresses, headers or credentials enter the hosted native runtime. */
export class HostedAgentSourceMcp {
  readonly #snapshot: PiMcpBridgeSnapshot;
  readonly #pipes = new Map<string, Pipe>();
  readonly #calls = new Map<string, NativeCall>();
  readonly #renewal: NodeJS.Timeout;
  #closed = false;
  constructor(private readonly options: { readonly router: McpRouter; readonly store: OperationalStore; readonly context: AdapterContext;
    readonly assertCurrent: () => void; readonly includeToolPolicy: (policyId: string) => boolean }) {
    options.assertCurrent();
    this.#snapshot = options.router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1/hosted-source-mcp", sessionId: options.context.sessionId,
      targetId: options.context.target.id, expectedPiGeneration: options.context.generation, includeToolPolicy: options.includeToolPolicy, ttlMs: TTL_MS });
    this.#renewal = setInterval(() => { try { this.#assert(); this.#snapshot.renew(TTL_MS); } catch { void this.close(); } }, TTL_MS / 2);
    this.#renewal.unref();
  }
  catalog(): HostedMcpCatalog {
    this.#assert();
    return { tools: this.#snapshot.mcpBridge.tools.map(tool => ({ ...tool })), modelServerIds: [...this.#snapshot.modelServerIds] };
  }
  async execute(raw: unknown, context: AdapterContext, workspace: ExecutorWorkspace, signal: AbortSignal, assertChannel: () => void = () => {}): Promise<Record<string, unknown>> {
    const request = hostedMcpRequestSchema.parse(raw), guard = () => { signal.throwIfAborted(); context.signal.throwIfAborted(); assertChannel(); this.#assert();
      if (context.sessionId !== this.options.context.sessionId || context.generation !== this.options.context.generation
        || context.target.id !== this.options.context.target.id || context.target.workspaceRoot !== this.options.context.target.workspaceRoot) throw new Error("The original MCP task changed."); };
    guard();
    switch (request.kind) {
      case "catalog": return { catalog: this.catalog() };
      case "call": {
        const pending = request.modelCallId === undefined ? undefined : this.#calls.get(request.modelCallId);
        if (request.modelCallId !== undefined && (!pending || pending.called || pending.context.operationId !== context.operationId || pending.serverId !== request.serverId
          || pending.toolName !== request.toolName || pending.requestId !== request.requestId || operationBodyHash(pending.arguments) !== operationBodyHash(request.arguments))) throw new Error("The MCP call left its original model request.");
        const assertOwner = () => {
          guard(); if (!context.operationId || !context.inputQueueItemId) throw new Error("MCP tools require their original durable input owner.");
          const item = this.options.store.getQueueItem(context.inputQueueItemId);
          if (item.sessionId !== context.sessionId || item.operationId !== context.operationId || !["dispatching", "backend_accepted"].includes(item.state)
            || item.backendInstanceGeneration !== context.backendInstanceGeneration) throw new Error("The original MCP input owner retired.");
        }; assertOwner();
        const active = pending ? AbortSignal.any([signal, pending.extra.signal]) : signal;
        active.throwIfAborted(); if (pending) pending.called = true;
        const arguments_ = mapArguments(request.arguments, workspace) as Readonly<Record<string, unknown>>;
        const rootRequired = this.#snapshot.mcpBridge.tools.some(tool => tool.serverId === request.serverId && tool.name === request.toolName && tool.requiresNativeRoot);
        if (rootRequired && !request.root) throw new Error("The MCP tool requires the original native root call.");
        const result = await this.options.router.executeBridgeCall({ authorization: `Bearer ${this.#snapshot.mcpBridge.token}`,
          generation: context.generation, sessionId: context.sessionId, targetId: context.target.id, requestId: request.requestId,
          serverId: request.serverId, toolName: request.toolName, arguments: arguments_, signal: active,
          assertCallerCurrent: assertOwner,
          ...(rootRequired ? { nativeRootProof: this.#snapshot.mcpBridge.captureRootCall!({ requestId: request.requestId, serverId: request.serverId,
            toolName: request.toolName, arguments: arguments_, assertCurrent: assertOwner }) } : {}),
          ...(pending?.connection ? { appCall: { connection: pending.connection, params: { ...pending.request.params, arguments: arguments_ },
            ...(pending.request.params._meta?.progressToken === undefined ? {} : { onprogress: progress => {
              try { guard(); pending.extra.signal.throwIfAborted(); } catch { return; }
              void pending.extra.sendNotification({ method: "notifications/progress", params: { ...progress, progressToken: pending.request.params._meta!.progressToken! } }).catch(() => {});
            } }) } } : {}) });
        assertOwner(); active.throwIfAborted();
        const projected = projectResult(result, workspace) as McpBridgeCallResult;
        if (pending) pending.result = projected;
        return { result: projected };
      }
      case "model_open": await this.#open(request.pipeId, request.serverId, workspace); guard(); return {};
      case "model_send": {
        const pipe = this.#pipe(request.pipeId);
        if (isJSONRPCRequest(request.message)) {
          if (pipe.requests.has(request.message.id) || pipe.requests.size >= 256) throw new Error("The MCP protocol request identity is unavailable.");
          pipe.requests.set(request.message.id, context);
        }
        // Tool arguments keep their exact native identity until admission.
        const message = isJSONRPCRequest(request.message) && request.message.method === "tools/call"
          ? request.message : restoreProtocolUris(request.message, workspace) as HostedMcpMessage;
        pipe.transport.onmessage?.(message); guard(); return {};
      }
      case "model_poll": {
        const pipe = this.#pipe(request.pipeId);
        if (!pipe.frames.length) await waitForFrames(pipe, signal);
        guard(); const frames = pipe.frames.splice(0); pipe.bytes = 0; return { frames };
      }
      case "model_reply": {
        const call = this.#calls.get(request.callId);
        if (!call || call.pipe !== this.#pipe(request.pipeId)) throw new Error("The native MCP reply belongs to another request.");
        this.#calls.delete(request.callId);
        if (request.ok && call.called && call.result) call.resolve(call.result); else call.reject(new Error("The original native MCP call failed."));
        return {};
      }
      case "model_close": await this.#closePipe(request.pipeId); return {};
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; clearInterval(this.#renewal);
    for (const call of this.#calls.values()) call.reject(new Error("The original MCP runtime closed.")); this.#calls.clear();
    await Promise.allSettled([...this.#pipes.keys()].map(id => this.#closePipe(id))); this.#snapshot.revoke();
  }
  async #open(id: string, serverId: string, workspace: ExecutorWorkspace): Promise<void> {
    this.#assert();
    if (this.#pipes.has(id) || this.#pipes.size >= 32) throw new Error("The MCP protocol connection is unavailable.");
    const tools = this.#snapshot.mcpBridge.tools.filter(tool => tool.serverId === serverId);
    if (!tools.length && !this.#snapshot.modelServerIds.includes(serverId)) throw new Error("The MCP server is outside its original snapshot.");
    let pipe!: Pipe;
    const transport: Transport = { start: async () => {}, close: async () => { if (pipe) { pipe.closed = true; for (const wake of pipe.waiters) wake(); } },
      send: async (message, options) => { this.#assert(); if ("id" in message && !isJSONRPCRequest(message) && message.id !== undefined && message.id !== null) pipe.requests.delete(message.id);
        this.#enqueue(pipe, { kind: "message", message: projectResult(message, workspace) as HostedMcpMessage, ...(options?.relatedRequestId === undefined ? {} : { relatedRequestId: options.relatedRequestId }) }); } };
    const callTool = async (request: CallToolRequest, extra: McpModelRequestExtra, connection?: AppConnection): Promise<CallToolResult | CreateTaskResult> => {
      this.#assert(); extra.signal.throwIfAborted(); const context = pipe.requests.get(extra.requestId);
      if (!context || this.#calls.size >= 256) throw new Error("The MCP model request has no original input owner.");
      const callId = randomUUID(), requestId = `source-mcp:${callId}`;
      const abort = () => { const call = this.#calls.get(callId); this.#calls.delete(callId); call?.reject(new Error("The original MCP request was cancelled.")); };
      const result = await new Promise<McpBridgeCallResult>((resolve, reject) => {
        this.#calls.set(callId, { pipe, context, serverId, toolName: request.params.name, requestId, arguments: structuredClone(request.params.arguments ?? {}),
          request, extra, ...(connection ? { connection } : {}), resolve, reject, called: false });
        this.#enqueue(pipe, { kind: "native_call", callId, serverId, toolName: request.params.name, requestId, arguments: request.params.arguments ?? {},
          ...(request.params._meta ? { metadata: request.params._meta } : {}) });
        extra.signal.addEventListener("abort", abort, { once: true }); if (extra.signal.aborted) abort();
      }).finally(() => { this.#calls.delete(callId); extra.signal.removeEventListener("abort", abort); });
      extra.signal.throwIfAborted(); this.#assert();
      if (request.params.task) { if (result.isError) throw new Error("The MCP task failed."); return CreateTaskResultSchema.parse(result.details?.["mcpTask"]); }
      return { content: result.content as CallToolResult["content"], isError: result.isError,
        ...(result.details?.["mcpStructuredContent"] === undefined ? {} : { structuredContent: result.details["mcpStructuredContent"] as Record<string, unknown> }),
        ...(result.details?.["jokoMcpBridge"] === undefined ? {} : { _meta: { jokoMcpBridge: result.details["jokoMcpBridge"] } }) };
    };
    const model = this.#snapshot.modelServerIds.includes(serverId) ? createMcpModelProxy({ name: "joko-source-mcp", tools,
      open: peer => this.options.router.createAppModelChannel(this.#snapshot, serverId, peer, () => this.#assert()), callTool,
      redact: value => this.options.router.redactModelValue(value) }) : undefined;
    let server: Server | McpServer;
    if (model) server = model;
    else {
      const plain = new Server({ name: "joko-source-mcp", version: "1" }, { capabilities: { tools: {} } });
      plain.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: { ...tool.inputSchema, type: "object" as const },
        ...(tool.outputSchema ? { outputSchema: { ...tool.outputSchema, type: "object" as const } } : {}) })) }));
      plain.setRequestHandler(CallToolRequestSchema, callTool); server = plain;
    }
    pipe = { serverId, server, transport, frames: [], requests: new Map(), waiters: new Set(), bytes: 0, closed: false };
    this.#pipes.set(id, pipe);
    try { await server.connect(transport); this.#assert(); } catch (error) { await this.#closePipe(id); throw error; }
  }
  #enqueue(pipe: Pipe, frame: HostedMcpFrame): void {
    if (pipe.closed) throw new Error("The MCP protocol connection closed.");
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (pipe.frames.length >= 256 || pipe.bytes + bytes > MAXIMUM_PIPE_BYTES) throw new Error("The MCP protocol output capacity is exhausted.");
    pipe.bytes += bytes; pipe.frames.push(frame); for (const wake of pipe.waiters) wake();
  }
  #pipe(id: string): Pipe { this.#assert(); const pipe = this.#pipes.get(id); if (!pipe || pipe.closed) throw new Error("The MCP protocol connection is unavailable."); return pipe; }
  async #closePipe(id: string): Promise<void> {
    const pipe = this.#pipes.get(id); if (!pipe) return; this.#pipes.delete(id); pipe.closed = true;
    for (const [key, call] of this.#calls) if (call.pipe === pipe) { call.reject(new Error("The MCP protocol connection closed.")); this.#calls.delete(key); }
    for (const wake of pipe.waiters) wake(); pipe.waiters.clear(); await pipe.server.close();
  }
  #assert(): void { if (this.#closed) throw new Error("The original MCP runtime is closed."); this.options.assertCurrent(); this.#snapshot.assertCurrent(); }
}

async function waitForFrames(pipe: Pipe, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const clear = () => { clearTimeout(timer); pipe.waiters.delete(finish); signal.removeEventListener("abort", abort); };
    const finish = () => { clear(); resolve(); };
    const abort = () => { clear(); reject(signal.reason); };
    const timer = setTimeout(finish, 20_000); timer.unref(); pipe.waiters.add(finish); signal.addEventListener("abort", abort, { once: true });
    if (pipe.frames.length || pipe.closed) finish(); else if (signal.aborted) abort();
  });
}

const PATH_ARGUMENTS = new Set(["path", "paths", "filepath", "filepaths", "directory", "directories", "dir", "dirs", "workingdir", "workdir", "cwd", "root", "libraryroot", "sourcepath", "destinationpath", "savedir", "outpath", "htmlpath", "imagepath", "iconsource", "attachments", "extradirs", "writabledirs", "debugimageout"]);
function restoreProtocolUris(value: unknown, workspace: ExecutorWorkspace): unknown {
  if (typeof value === "string" && value.startsWith("file://")) {
    try {
      const uri = new URL(value), native = fileURLToPath(uri, { windows: /^\/[A-Za-z]:\//u.test(uri.pathname) || !!uri.hostname }), source = workspace.mapAlias(native);
      if (native !== source) { const original = pathToFileURL(source); original.search = uri.search; original.hash = uri.hash; return original.href; }
    } catch {}
    return value;
  }
  if (Array.isArray(value)) return value.map(item => restoreProtocolUris(item, workspace));
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreProtocolUris(item, workspace)])) : value;
}
function mapArguments(value: unknown, workspace: ExecutorWorkspace, key = ""): unknown {
  if (typeof value === "string") {
    if (key === "args") { try { const parsed: unknown = JSON.parse(value); if (parsed && typeof parsed === "object") return JSON.stringify(mapArguments(parsed, workspace)); } catch {} }
    if (/^(?:cmd|command)$/u.test(key)) return workspace.mapCommand(value);
    const context = pathTextContext(key);
    return context === "ambiguous-path" ? workspace.mapTextFromAgent(value, context) : context === "path" || PATH_ARGUMENTS.has(key.replace(/_/gu, "").toLowerCase()) ? workspace.mapAlias(value) : value;
  }
  if (Array.isArray(value)) return value.map(item => mapArguments(item, workspace, key));
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapArguments(item, workspace, key)])) : value;
}
function projectResult(value: unknown, workspace: ExecutorWorkspace, key = ""): unknown {
  if (typeof value === "string") {
    if (value.startsWith("file://")) { try { const url = new URL(value), local = fileURLToPath(url), virtual = workspace.toAgentPath(local);
      if (local !== virtual) { url.host = ""; url.pathname = virtual.replace(/\\/gu, "/"); return url.href; } } catch {} }
    return workspace.mapTextForAgent(value, pathTextContext(key));
  }
  if (Array.isArray(value)) return value.map(item => projectResult(item, workspace, key));
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectResult(item, workspace, key)])) : value;
}
