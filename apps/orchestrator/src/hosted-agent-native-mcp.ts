import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PiMcpBridgeOptions } from "@joko/adapter-pi";
import type { ClaudeMcpBridgePort, ClaudeMcpCallResult } from "@joko/adapter-claude-code";
import type { CodexMcpSessionInput, CodexMcpRuntimeLease } from "@joko/adapter-codex";
import { operationBodyHash } from "@joko/store";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpBridgeCallResult } from "./mcp-router.js";
import type { HostedMcpCatalog, HostedMcpFrame, HostedMcpRequest } from "./hosted-agent-mcp-wire.js";

type NativeFrame = Extract<HostedMcpFrame, { kind: "native_call" }>;
interface Pipe { readonly id: string; readonly transport: Transport; readonly abort: AbortController; readonly settled: Promise<void>; close(): Promise<void> }
interface RootCall { readonly requestId: string; readonly serverId: string; readonly toolName: string; readonly arguments: Readonly<Record<string, unknown>>; readonly assertCurrent: () => void; readonly expiresAt: number }
interface CodexRoute { readonly input: CodexMcpSessionInput; readonly serverId: string; readonly transports: Map<string, { readonly transport: StreamableHTTPServerTransport; readonly pipe: Pipe }>; active: boolean }
interface HostedAgentNativeMcpOptions { readonly owner: { readonly sessionId: string; readonly targetId: string; readonly generation: number };
  readonly execute: (request: HostedMcpRequest, signal: AbortSignal) => Promise<Record<string, unknown>>; readonly signal: AbortSignal; readonly assertCurrent: () => void }
const MAXIMUM_BYTES = 2 * 1024 * 1024;

/** Native-side facade. It uses the provider's SDK root attestation but every
 * actual MCP operation is executed by the original Source Router. */
export class HostedAgentNativeMcp {
  #nativeOwner: HostedAgentNativeMcpOptions["owner"];
  readonly #catalog: HostedMcpCatalog;
  readonly #server = createServer((request, response) => { void this.#http(request, response); });
  readonly #token = randomBytes(32).toString("base64url");
  readonly #piRoute = "/bridge/" + randomUUID();
  readonly #roots = new Map<string, RootCall>();
  readonly #pipes = new Set<Pipe>();
  readonly #modelCalls = new Map<string, NativeFrame>();
  readonly #codex = new Map<string, CodexRoute>();
  readonly #lifetime = new AbortController();
  readonly #httpRequests = new Set<AbortController>();
  #origin = "";
  #closed = false;
  private constructor(private readonly options: HostedAgentNativeMcpOptions, catalog: HostedMcpCatalog) { this.#catalog = catalog; this.#nativeOwner = { ...options.owner }; }
  /** Called only after the exact previous native runtime confirmed closure. */
  replaceOwnerGeneration(generation: number): void {
    this.#assert();
    if (!Number.isSafeInteger(generation) || generation !== this.#nativeOwner.generation + 1) throw new Error("The native MCP owner generation is invalid.");
    this.#roots.clear(); this.#nativeOwner = { ...this.#nativeOwner, generation };
  }
  static async create(options: HostedAgentNativeMcpOptions): Promise<HostedAgentNativeMcp> {
    options.assertCurrent(); const result = await options.execute({ kind: "catalog" }, options.signal);
    const catalog = result.catalog as HostedMcpCatalog;
    if (!catalog || !Array.isArray(catalog.tools) || catalog.tools.length > 10_000 || !Array.isArray(catalog.modelServerIds)
      || catalog.modelServerIds.length > 256 || Buffer.byteLength(JSON.stringify(catalog)) > 16 * 1024 * 1024) throw new Error("The original MCP catalog is invalid.");
    const bridge = new HostedAgentNativeMcp(options, structuredClone(catalog));
    bridge.#server.requestTimeout = 0;
    try {
      await new Promise<void>((resolve, reject) => { bridge.#server.once("error", reject); bridge.#server.listen(0, "127.0.0.1", () => { bridge.#server.removeListener("error", reject); resolve(); }); });
      const address = bridge.#server.address(); if (!address || typeof address === "string") throw new Error("The native MCP facade has no listener.");
      bridge.#origin = `http://127.0.0.1:${address.port}`; bridge.#assert(); return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }
  pi(): PiMcpBridgeOptions {
    this.#assert();
    return { endpoint: this.#origin + this.#piRoute, token: this.#token, tools: this.#catalog.tools,
      captureRootCall: input => { this.#assert(); input.assertCurrent();
        for (const [key, proof] of this.#roots) if (proof.expiresAt <= Date.now()) this.#roots.delete(key);
        if (this.#roots.size >= 1024) throw new Error("The native MCP root proof capacity is exhausted.");
        const proof = randomBytes(32).toString("base64url"); this.#roots.set(proof, { ...input, arguments: structuredClone(input.arguments), expiresAt: Date.now() + 30_000 }); return proof; } };
  }
  claude(): ClaudeMcpBridgePort {
    return { open: input => {
      this.#owner(input); let released = false; const pipes = new Set<Pipe>();
      const assert = () => { this.#owner(input); input.signal.throwIfAborted(); if (released) throw new Error("The native MCP Query retired."); };
      const tools = this.#catalog.tools.map(tool => ({ serverId: tool.serverId, name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}), ...(tool.requiresNativeRoot ? { requiresNativeRoot: true as const } : {}) }));
      return { tools, models: this.#catalog.modelServerIds.map(serverId => ({ serverId, connect: async (transport, callNative) => {
        assert(); const pipe = await this.#connect(serverId, transport, async frame => {
          const toolUseId = frame.metadata?.["claudecode/toolUseId"];
          if (typeof toolUseId !== "string" || !toolUseId || toolUseId.length > 512) throw new Error("The MCP request has no native tool owner.");
          await callNative({ toolName: frame.toolName, arguments: frame.arguments, toolUseId, signal: input.signal, modelCallId: frame.callId });
        }, input.signal, assert); pipes.add(pipe);
      } })), assertCurrent: assert,
        call: async call => { assert(); call.signal.throwIfAborted(); const frame = call.modelCallId === undefined ? undefined : this.#modelCalls.get(call.modelCallId);
          if (call.modelCallId !== undefined && (!frame || frame.serverId !== call.serverId || frame.toolName !== call.toolName || operationBodyHash(frame.arguments) !== operationBodyHash(call.arguments))) throw new Error("The native MCP call has no original model owner.");
          call.nativeRootCall?.assertCurrent();
          if (call.nativeRootCall && operationBodyHash(call.nativeRootCall.arguments) !== operationBodyHash(call.arguments)) throw new Error("The native root arguments changed.");
          const result = await this.#call({ kind: "call", requestId: frame?.requestId ?? call.requestId, serverId: call.serverId, toolName: call.toolName,
            arguments: call.arguments, root: call.nativeRootCall !== undefined, ...(frame ? { modelCallId: frame.callId } : {}) }, call.signal); assert(); call.nativeRootCall?.assertCurrent();
          return claudeResult(result);
        }, release: () => { if (released) return; released = true; for (const pipe of pipes) void pipe.close().catch(() => {}); pipes.clear(); }
      };
    } };
  }
  async codex(input: CodexMcpSessionInput): Promise<CodexMcpRuntimeLease> {
    this.#owner(input); input.assertSessionCurrent(); let released = false;
    const paths: string[] = [], servers = new Set([...this.#catalog.tools.map(tool => tool.serverId), ...this.#catalog.modelServerIds]);
    const assert = () => { this.#owner(input); input.signal?.throwIfAborted(); input.assertSessionCurrent(); if (released) throw new Error("The native MCP thread retired."); };
    const routes = [...servers].map(serverId => { const path = "/mcp/" + randomUUID(); paths.push(path); this.#codex.set(path, { input, serverId, transports: new Map(), active: true });
      return { serverId, name: "joko_source_" + createHash("sha256").update(serverId).digest("hex").slice(0, 24), url: this.#origin + path }; });
    return { routes, assertCurrent: assert, release: async () => { if (released) return; released = true;
      const pending: Promise<void>[] = []; for (const path of paths) { const route = this.#codex.get(path); this.#codex.delete(path); if (route) { route.active = false; for (const item of route.transports.values()) pending.push(item.pipe.close()); } }
      await Promise.all(pending);
    } };
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; this.#lifetime.abort(); this.#roots.clear(); this.#codex.clear();
    for (const abort of this.#httpRequests) abort.abort();
    await Promise.allSettled([...this.#pipes].map(pipe => pipe.close())); this.#server.closeAllConnections();
    if (this.#server.listening) await new Promise<void>(resolve => this.#server.close(() => resolve()));
  }
  async #call(request: Extract<HostedMcpRequest, { kind: "call" }>, signal: AbortSignal): Promise<McpBridgeCallResult> {
    this.#assert(); const active = AbortSignal.any([signal, this.options.signal, this.#lifetime.signal]);
    const value = await this.options.execute(request, active); active.throwIfAborted(); this.#assert();
    const result = value.result as McpBridgeCallResult;
    if (!result || !Array.isArray(result.content) || typeof result.isError !== "boolean") throw new Error("The original MCP result is invalid."); return result;
  }
  async #connect(serverId: string, transport: Transport, native: (frame: NativeFrame) => Promise<void>, signal: AbortSignal, assert: () => void): Promise<Pipe> {
    assert(); const id = randomUUID(), abort = new AbortController(), active = AbortSignal.any([signal, abort.signal, this.options.signal, this.#lifetime.signal]);
    await this.options.execute({ kind: "model_open", pipeId: id, serverId }, active); assert();
    let closing: Promise<void> | undefined, pipe!: Pipe;
    const close = () => closing ??= (async () => { abort.abort();
      await this.options.execute({ kind: "model_close", pipeId: id }, this.options.signal).catch(() => {});
      await transport.close(); this.#pipes.delete(pipe);
    })();
    transport.onmessage = message => { void this.options.execute({ kind: "model_send", pipeId: id, message }, active).catch(error => { transport.onerror?.(error as Error); void close(); }); };
    const disconnected = transport.onclose; transport.onclose = () => { disconnected?.(); void close(); };
    const settled = (async () => {
      for (;;) {
        active.throwIfAborted(); assert(); const batch = await this.options.execute({ kind: "model_poll", pipeId: id }, active); active.throwIfAborted(); assert();
        if (!Array.isArray(batch.frames) || batch.frames.length > 256) throw new Error("The original MCP protocol batch is invalid.");
        for (const frame of batch.frames as HostedMcpFrame[]) {
          active.throwIfAborted(); assert();
          if (frame.kind === "message") await transport.send(frame.message, frame.relatedRequestId === undefined ? undefined : { relatedRequestId: frame.relatedRequestId });
          else if (frame.kind === "native_call") {
            if (this.#modelCalls.has(frame.callId) || this.#modelCalls.size >= 256 || frame.serverId !== serverId) throw new Error("The native MCP request is invalid.");
            this.#modelCalls.set(frame.callId, frame);
            void Promise.resolve().then(async () => { let ok = false;
              try { active.throwIfAborted(); assert(); await native(frame); active.throwIfAborted(); assert(); ok = true; }
              finally { this.#modelCalls.delete(frame.callId); await this.options.execute({ kind: "model_reply", pipeId: id, callId: frame.callId, ok }, active).catch(() => {}); }
            }).catch(() => {});
          } else throw new Error("The MCP protocol frame is invalid.");
        }
      }
    })().catch(error => { if (!active.aborted) transport.onerror?.(error as Error); void close(); });
    pipe = { id, transport, abort, settled, close }; this.#pipes.add(pipe);
    try { await transport.start(); assert(); return pipe; } catch (error) { await close(); throw error; }
  }
  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    if (this.#httpRequests.size >= 64) { response.writeHead(503).end(); return; }
    const abort = new AbortController(), disconnected = () => { if (!response.writableEnded) abort.abort(); };
    this.#httpRequests.add(abort);
    request.once("aborted", disconnected); response.once("close", disconnected);
    try {
      this.#assert(); const path = request.url ?? "", signal = AbortSignal.any([this.options.signal, abort.signal, this.#lifetime.signal]);
      if (path === this.#piRoute) {
        const supplied = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from("Bearer " + this.#token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || request.method !== "POST") throw new Error("The native MCP request is unauthorized.");
        const value = await readBody(request) as { requestId: string; sessionId: string; targetId: string; generation: number; serverId: string; toolName: string; arguments?: Record<string, unknown>; nativeRootProof?: string };
        this.#owner(value); const arguments_ = value.arguments ?? {};
        const proof = value.nativeRootProof === undefined ? undefined : this.#roots.get(value.nativeRootProof);
        if (value.nativeRootProof !== undefined) {
          this.#roots.delete(value.nativeRootProof);
          if (!proof || proof.expiresAt <= Date.now() || proof.requestId !== value.requestId || proof.serverId !== value.serverId || proof.toolName !== value.toolName
            || operationBodyHash(proof.arguments) !== operationBodyHash(arguments_)) throw new Error("The native MCP root proof is invalid."); proof.assertCurrent();
        }
        const result = await this.#call({ kind: "call", requestId: value.requestId, serverId: value.serverId, toolName: value.toolName, arguments: arguments_, root: proof !== undefined }, signal);
        proof?.assertCurrent(); if (!response.destroyed) response.setHeader("content-type", "application/json").end(JSON.stringify(result)); return;
      }
      const route = this.#codex.get(path); if (!route || !route.active) throw new Error("The native MCP route is unavailable.");
      this.#owner(route.input); route.input.assertSessionCurrent(); route.input.signal?.throwIfAborted();
      const sessionId = request.headers["mcp-session-id"]; if (sessionId !== undefined && typeof sessionId !== "string") throw new Error("The MCP session is invalid.");
      let session = sessionId === undefined ? undefined : route.transports.get(sessionId);
      const body = request.method === "POST" ? await readBody(request) : undefined;
      if (!session && request.method === "POST" && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: id => { route.transports.set(id, session!); } });
        transport.onclose = () => { if (transport.sessionId) route.transports.delete(transport.sessionId); };
        const current = () => { this.#assert(); route.input.assertSessionCurrent(); if (!route.active) throw new Error("The native MCP route retired."); };
        const pipe = await this.#connect(route.serverId, transport, async frame => {
          const threadId = nativeThreadId(frame.metadata), call = route.input.beginToolCall(threadId, { requestId: frame.requestId, serverId: route.serverId, toolName: frame.toolName });
          try { call.assertCurrent(); call.signal.throwIfAborted(); call.assertNativeRoot?.();
            await this.#call({ kind: "call", requestId: frame.requestId, serverId: frame.serverId, toolName: frame.toolName, arguments: frame.arguments,
              root: call.assertNativeRoot !== undefined, modelCallId: frame.callId }, call.signal); call.assertCurrent();
          } finally { call.release(); }
        }, route.input.signal ?? this.options.signal, current); session = { transport, pipe };
      }
      if (!session) { response.writeHead(400).end(); return; }
      await session.transport.handleRequest(request, response, body);
    } catch { if (!response.headersSent && !response.destroyed) response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "MCP_SOURCE_UNAVAILABLE" })); }
    finally { this.#httpRequests.delete(abort); request.removeListener("aborted", disconnected); response.removeListener("close", disconnected); }
  }
  #owner(input: { readonly sessionId: string; readonly targetId: string; readonly generation: number }): void {
    this.#assert(); const owner = this.#nativeOwner;
    if (input.sessionId !== owner.sessionId || input.targetId !== owner.targetId || input.generation !== owner.generation) throw new Error("The native MCP owner changed.");
  }
  #assert(): void { if (this.#closed) throw new Error("The native MCP facade is closed."); this.options.signal.throwIfAborted(); this.options.assertCurrent(); }
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.byteLength; if (size > MAXIMUM_BYTES) throw new Error("The MCP request is too large."); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function nativeThreadId(metadata: Readonly<Record<string, unknown>> | undefined): string {
  const value = metadata?.["threadId"];
  if (typeof value !== "string" || !value || value.length > 1024) throw new Error("The MCP request has no native thread owner."); return value;
}
function claudeResult(result: McpBridgeCallResult): ClaudeMcpCallResult {
  return { content: result.content.length ? result.content : result.error ? [{ type: "text", text: result.error }] : [], isError: result.isError,
    ...(result.details?.["mcpStructuredContent"] === undefined ? {} : { structuredContent: result.details["mcpStructuredContent"] as Record<string, unknown> }),
    ...(result.details?.["jokoMcpBridge"] === undefined ? {} : { bridgeMetadata: result.details["jokoMcpBridge"] }),
    ...(result.details?.["mcpTask"] === undefined ? {} : { taskResult: result.details["mcpTask"] as NonNullable<ClaudeMcpCallResult["taskResult"]> }) };
}
