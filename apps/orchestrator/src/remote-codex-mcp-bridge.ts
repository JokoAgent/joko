import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type CodexMcpOpenInput,
  type CodexMcpRuntimeLease
} from "@joko/adapter-codex";
import type { RemoteForwardingTransportPort, RemoteReverseForwardHandle } from "@joko/remote-ssh";
import { Server as ProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type CallToolResult,
  type RequestId
} from "@modelcontextprotocol/sdk/types.js";
import { type McpRouter, type PiMcpBridgeSnapshot } from "./mcp-router.js";

const DEFAULT_GRANT_TTL_MS = 60_000;
const MINIMUM_GRANT_TTL_MS = 1_000;
const MAXIMUM_REQUEST_BYTES = 2 * 1_024 * 1_024;
const SHUTDOWN_TIMEOUT_MS = 2_000;

type FrozenTool = PiMcpBridgeSnapshot["mcpBridge"]["tools"][number];

export interface RemoteCodexMcpForwardingAuthority {
  readonly forwarding?: RemoteForwardingTransportPort;
  readonly assertCurrent: () => void;
  readonly assertForwardingCurrent: () => void;
}

export interface CodexMcpBridgeManagerOptions {
  readonly router: McpRouter;
  readonly includeToolPolicy?: (sessionId: string, targetId: string, policyId: string) => boolean;
  readonly grantTtlMs?: number;
}

interface ProtocolSession {
  readonly serverId: string;
  readonly server: ProtocolServer;
  readonly transport: StreamableHTTPServerTransport;
}

interface ActiveRoute {
  readonly lease: CodexMcpRuntimeLease;
  release(): Promise<void>;
}

/**
 * Session-scoped standard MCP facade for Codex app-server runtimes. The raw
 * McpRouter bearer stays in this process; Codex receives only an unguessable
 * loopback route, directly for local runtimes or through the captured reverse
 * forward for remote runtimes.
 */
export class CodexMcpBridgeManager {
  readonly #router: McpRouter;
  readonly #includeToolPolicy: CodexMcpBridgeManagerOptions["includeToolPolicy"];
  readonly #grantTtlMs: number;
  readonly #routes = new Set<ActiveRoute>();
  #closed = false;

  constructor(options: CodexMcpBridgeManagerOptions) {
    this.#router = options.router;
    this.#includeToolPolicy = options.includeToolPolicy;
    this.#grantTtlMs = options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    if (!Number.isSafeInteger(this.#grantTtlMs) || this.#grantTtlMs < MINIMUM_GRANT_TTL_MS) {
      throw new Error("Codex MCP grant lifetime is invalid.");
    }
  }

  async open(
    authority: RemoteCodexMcpForwardingAuthority,
    input: CodexMcpOpenInput
  ): Promise<CodexMcpRuntimeLease> {
    return this.#open(authority, input);
  }

  async openLocal(input: CodexMcpOpenInput): Promise<CodexMcpRuntimeLease> {
    return this.#open(undefined, input);
  }

  async #open(
    authority: RemoteCodexMcpForwardingAuthority | undefined,
    input: CodexMcpOpenInput
  ): Promise<CodexMcpRuntimeLease> {
    this.#assertOpen();
    input.signal?.throwIfAborted();
    input.assertSessionCurrent();
    authority?.assertCurrent();

    const routeSecret = randomBytes(32).toString("base64url");
    const snapshot = this.#router.createPiBridgeSnapshot({
      endpoint: `http://127.0.0.1/${routeSecret}`,
      sessionId: input.sessionId,
      targetId: input.targetId,
      expectedPiGeneration: input.generation,
      ttlMs: this.#grantTtlMs,
      ...(this.#includeToolPolicy === undefined ? {} : {
        includeToolPolicy: (policyId) => this.#includeToolPolicy!(input.sessionId, input.targetId, policyId)
      })
    });
    const toolsByServer = groupTools(snapshot.mcpBridge.tools);
    if (toolsByServer.size === 0) {
      snapshot.revoke();
      let released = false;
      const lease: CodexMcpRuntimeLease = Object.freeze({
        routes: [],
        assertCurrent: () => {
          this.#assertOpen();
          if (released) throw new Error("Codex MCP route is retired.");
          input.assertSessionCurrent();
          authority?.assertCurrent();
        },
        release: async () => { released = true; }
      });
      return lease;
    }

    let http: HttpServer | undefined;
    let forward: RemoteReverseForwardHandle | undefined;
    const sessions = new Map<string, ProtocolSession>();
    const pathServers = new Map<string, { readonly serverId: string; readonly tools: readonly FrozenTool[] }>();
    const routeAbort = new AbortController();
    let active: ActiveRoute | undefined;
    let released = false;
    let renewalTimer: NodeJS.Timeout | undefined;

    const assertCurrent = (): void => {
      this.#assertOpen();
      if (released || active === undefined || !this.#routes.has(active)) throw new Error("Codex MCP route is retired.");
      routeAbort.signal.throwIfAborted();
      input.assertSessionCurrent();
      authority?.assertCurrent();
      authority?.assertForwardingCurrent();
      snapshot.assertCurrent();
    };

    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      if (active !== undefined) this.#routes.delete(active);
      if (renewalTimer !== undefined) clearInterval(renewalTimer);
      snapshot.revoke();
      routeAbort.abort();
      const currentSessions = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(currentSessions.map((session) => session.server.close()));
      await forward?.close().catch(() => undefined);
      if (http !== undefined) await closeHttpServer(http);
    };

    try {
      for (const [serverId, tools] of toolsByServer) {
        pathServers.set(`/${routeSecret}/${encodeURIComponent(serverId)}`, { serverId, tools });
      }
      http = createServer((request, response) => {
        void this.#handleRequest({
          request,
          response,
          input,
          snapshot,
          pathServers,
          sessions,
          routeAbort: routeAbort.signal,
          assertCurrent
        });
      });
      await listenLoopback(http, input.signal);
      const address = http.address() as AddressInfo;
      let routeHost = "127.0.0.1";
      let routePort = address.port;
      if (authority !== undefined) {
        authority.assertForwardingCurrent();
        if (authority.forwarding === undefined) throw new Error("Remote Codex MCP forwarding is unavailable.");
        forward = await authority.forwarding.listen({
          localDestinationHost: "127.0.0.1",
          localDestinationPort: address.port,
          remoteListenHost: "127.0.0.1",
          ...(input.signal === undefined ? {} : { signal: input.signal })
        });
        authority.assertForwardingCurrent();
        routeHost = forward.remoteHost === "::1" ? "[::1]" : forward.remoteHost;
        routePort = forward.remotePort;
      }
      input.assertSessionCurrent();
      const routes = [...toolsByServer.keys()].sort().map((serverId) => Object.freeze({
        serverId,
        name: codexServerName(input, serverId, routeSecret),
        url: `http://${routeHost}:${routePort}/${routeSecret}/${encodeURIComponent(serverId)}`
      }));
      const lease: CodexMcpRuntimeLease = Object.freeze({
        routes: Object.freeze(routes),
        assertCurrent,
        release
      });
      active = { lease, release };
      this.#routes.add(active);
      assertCurrent();
      renewalTimer = setInterval(() => {
        try {
          assertCurrent();
          snapshot.renew(this.#grantTtlMs);
        } catch {
          void release();
        }
      }, Math.max(250, Math.floor(this.#grantTtlMs / 3)));
      renewalTimer.unref?.();
      return lease;
    } catch (error) {
      await release();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const routes = [...this.#routes];
    this.#routes.clear();
    await Promise.allSettled(routes.map((route) => route.release()));
  }

  async #handleRequest(input: {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly input: CodexMcpOpenInput;
    readonly snapshot: PiMcpBridgeSnapshot;
    readonly pathServers: ReadonlyMap<string, { readonly serverId: string; readonly tools: readonly FrozenTool[] }>;
    readonly sessions: Map<string, ProtocolSession>;
    readonly routeAbort: AbortSignal;
    readonly assertCurrent: () => void;
  }): Promise<void> {
    const { request, response } = input;
    let transientSession: ProtocolSession | undefined;
    try {
      input.assertCurrent();
      if (!loopbackAddress(request.socket.remoteAddress)) return end(response, 404);
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.search.length > 0 || url.hash.length > 0) return end(response, 404);
      const route = input.pathServers.get(url.pathname);
      if (route === undefined) return end(response, 404);
      const sessionId = singleHeader(request.headers["mcp-session-id"]);
      let parsedBody: unknown;
      if (request.method === "POST") parsedBody = await readJsonBody(request);
      let session = sessionId === undefined ? undefined : input.sessions.get(sessionId);
      if (session !== undefined && session.serverId !== route.serverId) return end(response, 404);
      if (session === undefined) {
        if (sessionId !== undefined || request.method !== "POST" || !isInitializeRequest(parsedBody)) {
          return end(response, sessionId === undefined ? 400 : 404);
        }
        session = await this.#createProtocolSession(route, input.input, input.snapshot, input.routeAbort, input.assertCurrent, input.sessions);
        transientSession = session;
      }
      await session.transport.handleRequest(request, response, parsedBody);
    } catch {
      if (!response.headersSent) end(response, 500);
      else response.end();
    } finally {
      if (transientSession !== undefined && transientSession.transport.sessionId === undefined) {
        await transientSession.server.close().catch(() => undefined);
      }
    }
  }

  async #createProtocolSession(
    route: { readonly serverId: string; readonly tools: readonly FrozenTool[] },
    input: CodexMcpOpenInput,
    snapshot: PiMcpBridgeSnapshot,
    routeAbort: AbortSignal,
    assertCurrent: () => void,
    sessions: Map<string, ProtocolSession>
  ): Promise<ProtocolSession> {
    const server = new ProtocolServer(
      { name: `joko-codex-${route.serverId}`, version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    let session: ProtocolSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => { sessions.set(sessionId, session); },
      onsessionclosed: (sessionId) => { sessions.delete(sessionId); }
    });
    session = { serverId: route.serverId, server, transport };
    transport.onclose = () => {
      if (transport.sessionId !== undefined && sessions.get(transport.sessionId) === session) {
        sessions.delete(transport.sessionId);
      }
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      assertCurrent();
      return {
        tools: route.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: objectSchema(tool.inputSchema),
          ...(tool.outputSchema === undefined ? {} : { outputSchema: objectSchema(tool.outputSchema) })
        }))
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      assertCurrent();
      const threadId = codexThreadId(request.params._meta);
      const call = input.beginToolCall(threadId);
      const signal = AbortSignal.any([extra.signal, call.signal, routeAbort]);
      const requestId = bridgeRequestId(extra.sessionId, extra.requestId, threadId);
      try {
        signal.throwIfAborted();
        call.assertCurrent();
        const result = await this.#router.executeBridgeCall({
          authorization: `Bearer ${snapshot.mcpBridge.token}`,
          requestId,
          generation: input.generation,
          sessionId: input.sessionId,
          targetId: input.targetId,
          serverId: route.serverId,
          toolName: request.params.name,
          arguments: request.params.arguments,
          signal
        });
        signal.throwIfAborted();
        call.assertCurrent();
        assertCurrent();
        return bridgeCallResult(result);
      } finally {
        call.release();
      }
    });
    try {
      await server.connect(transport);
      return session;
    } catch (error) {
      await server.close().catch(() => undefined);
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Codex MCP bridge manager is closed.");
  }
}

function groupTools(tools: readonly FrozenTool[]): Map<string, readonly FrozenTool[]> {
  const mutable = new Map<string, FrozenTool[]>();
  for (const tool of tools) {
    const group = mutable.get(tool.serverId) ?? [];
    group.push(tool);
    mutable.set(tool.serverId, group);
  }
  return new Map([...mutable].map(([serverId, group]) => [serverId, Object.freeze([...group])])) as Map<string, readonly FrozenTool[]>;
}

function codexServerName(input: CodexMcpOpenInput, serverId: string, routeSecret: string): string {
  const slug = serverId.replace(/[^A-Za-z0-9_-]/gu, "_").replace(/^_+|_+$/gu, "").slice(0, 24) || "tools";
  const digest = createHash("sha256")
    .update(input.sessionId).update("\0")
    .update(input.targetId).update("\0")
    .update(String(input.generation)).update("\0")
    .update(input.threadId).update("\0")
    .update(serverId).update("\0")
    .update(routeSecret)
    .digest("hex").slice(0, 12);
  return `joko_${slug}_${digest}`;
}

function objectSchema(value: Readonly<Record<string, unknown>>): { readonly type: "object"; readonly [key: string]: unknown } {
  return { ...value, type: "object" };
}

function codexThreadId(meta: unknown): string {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Codex MCP call is missing native thread identity.");
  const threadId = (meta as Record<string, unknown>)["threadId"];
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 512 || /[\u0000-\u001f\u007f]/u.test(threadId)) {
    throw new Error("Codex MCP call has invalid native thread identity.");
  }
  return threadId;
}

function bridgeRequestId(sessionId: string | undefined, requestId: RequestId, threadId: string): string {
  return createHash("sha256")
    .update(sessionId ?? "uninitialized").update("\0")
    .update(typeof requestId).update(":").update(String(requestId)).update("\0")
    .update(threadId)
    .digest("hex");
}

function bridgeCallResult(result: Awaited<ReturnType<McpRouter["executeBridgeCall"]>>): CallToolResult {
  const structured = result.details?.["mcpStructuredContent"];
  const bridgeDetails = result.details?.["jokoMcpBridge"];
  return {
    content: (result.content.length > 0
      ? result.content
      : result.error === undefined ? [] : [{ type: "text", text: result.error }]) as CallToolResult["content"],
    isError: result.isError,
    ...(structured !== null && typeof structured === "object" && !Array.isArray(structured)
      ? { structuredContent: structured as Record<string, unknown> }
      : {}),
    ...(bridgeDetails === undefined ? {} : { _meta: { jokoMcpBridge: bridgeDetails } })
  };
}

async function listenLoopback(server: HttpServer, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      server.close();
      reject(signal?.reason ?? new Error("Codex MCP route setup was cancelled."));
    };
    const onError = (error: Error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      signal?.removeEventListener("abort", onAbort);
      server.off("error", onError);
      resolve();
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      timer.unref?.();
    })
  ]);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAXIMUM_REQUEST_BYTES) throw new Error("Codex MCP request is too large.");
    chunks.push(buffer);
  }
  if (bytes === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  return value.length === 1 ? value[0] : undefined;
}

function loopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function end(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.end();
}
