import { createServer, type ServerResponse } from "node:http";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema, CompleteRequestSchema, CreateTaskResultSchema, GetPromptRequestSchema,
  GetTaskPayloadRequestSchema, GetTaskRequestSchema, ListPromptsRequestSchema, ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema, ListRootsRequestSchema, ListRootsResultSchema, ListToolsRequestSchema,
  LoggingMessageNotificationSchema, ReadResourceRequestSchema, ResourceUpdatedNotificationSchema,
  ResultSchema, SetLevelRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema,
  LATEST_PROTOCOL_VERSION, McpError, ErrorCode, type ServerCapabilities, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { CredentialManager } from "../credential-manager.js";
import { CredentialVault } from "../credential-vault.js";
import { McpRouter } from "../mcp-router.js";
import { CodexMcpBridgeManager } from "../remote-codex-mcp-bridge.js";
import { createClaudeMcpBridge } from "../claude-mcp-bridge.js";
import { mkdtemp } from "../test-paths.js";
import { McpAppsManager } from "./manager.js";
import type { AppConnection } from "./connection.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const SECRET = "fixture-private-header-value";
const TASK = { taskId: "job", status: "working" as const, createdAt: "2026-10-21T00:00:00Z", lastUpdatedAt: "2026-10-21T00:00:00Z", ttl: 60_000, pollInterval: 1_000 };
const TOOLS: Tool[] = [
  { name: "form", description: "Open form", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://fixture/form" } } },
  { name: "app_only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
  { name: "roots", inputSchema: { type: "object" } },
  { name: "slow", inputSchema: { type: "object" } },
  { name: "task", inputSchema: { type: "object" }, execution: { taskSupport: "optional" } },
];

async function fixture(resourceOnly = false, backend: "codex" | "claude" = "codex") {
  const sessions = new Map<string, { protocol: Server; transport: SSEServerTransport; calls: string[] }>();
  const responses = new Set<ServerResponse>();
  const levels: string[] = [], subscriptions: string[] = [], progressTokens: unknown[] = [];
  let slowStarted = false, slowCancelled = false;
  const capabilities: ServerCapabilities = {
    resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true }, completions: {}, logging: {},
    ...(resourceOnly ? {} : { tools: { listChanged: true }, tasks: { requests: { tools: { call: {} } } } }),
  };
  const http = createServer((request, response) => {
    responses.add(response); response.on("close", () => responses.delete(response));
    if (request.method === "GET" && request.url === "/events") {
      if (request.headers.authorization !== SECRET) { response.writeHead(401).end(); return; }
      const calls: string[] = [];
      const protocol = new Server({ name: "independent-model-server", version: "1" }, { capabilities, instructions: `Use the form. ${SECRET}` });
      if (!resourceOnly) {
        protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
        protocol.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          calls.push(request.params.name);
          if (request.params.name === "slow") {
            slowStarted = true;
            await new Promise<void>(resolve => {
              const cancel = () => { slowCancelled = true; resolve(); };
              extra.signal.addEventListener("abort", cancel, { once: true }); if (extra.signal.aborted) cancel();
            });
            extra.signal.throwIfAborted();
          }
          if (request.params.name === "task") return { task: TASK, _meta: { privateResult: "view-only" } };
          if (request.params.name === "roots") {
            const roots = await protocol.request({ method: "roots/list" }, ListRootsResultSchema, { signal: extra.signal });
            return { content: [{ type: "text", text: JSON.stringify(roots.roots) }] };
          }
          const progressToken = request.params._meta?.progressToken;
          progressTokens.push(progressToken);
          if (progressToken !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress: 1, total: 1 } });
          return { content: [{ type: "text", text: request.params.name }], _meta: { privateResult: "view-only" } };
        });
        protocol.setRequestHandler(GetTaskRequestSchema, async () => ({ ...TASK, status: "completed" }));
        protocol.setRequestHandler(GetTaskPayloadRequestSchema, async () => ({ content: [{ type: "text", text: "Task complete" }], _meta: { privateResult: "view-only" } }));
      }
      protocol.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "ui://fixture/form", name: "Form" }] }));
      protocol.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [{ uriTemplate: "data://fixture/{id}", name: "Data" }] }));
      protocol.setRequestHandler(ReadResourceRequestSchema, async request => {
        if (request.params.uri === "data://fixture/error") throw new McpError(ErrorCode.InvalidParams, `Rejected ${SECRET}`, { detail: SECRET });
        return { contents: [{ uri: request.params.uri, mimeType: "text/html;profile=mcp-app", text: `<!doctype html><title>Form</title><div data-calls="${calls.length}">${SECRET}</div>`, _meta: { ui: { prefersBorder: false } } }] };
      });
      protocol.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "example" }] }));
      protocol.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [{ role: "user", content: { type: "text", text: `Example ${SECRET}` } }] }));
      protocol.setRequestHandler(CompleteRequestSchema, async () => ({ completion: { values: ["completed"] } }));
      protocol.setRequestHandler(SetLevelRequestSchema, async request => { levels.push(request.params.level); return {}; });
      protocol.setRequestHandler(SubscribeRequestSchema, async request => { subscriptions.push(request.params.uri); return {}; });
      protocol.setRequestHandler(UnsubscribeRequestSchema, async request => { subscriptions.push(`-${request.params.uri}`); return {}; });
      const transport = new SSEServerTransport("/messages", response);
      sessions.set(transport.sessionId, { transport, protocol, calls });
      void protocol.connect(transport).catch(() => response.end());
    } else if (request.method === "POST") {
      const id = new URL(request.url ?? "", "http://localhost").searchParams.get("sessionId"), session = id && sessions.get(id);
      if (!session) { response.writeHead(404).end(); return; }
      void session.transport.handlePostMessage(request, response).catch(() => response.end());
    } else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await Promise.allSettled([...sessions.values()].map(session => session.protocol.close()));
    for (const response of responses) response.end();
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const address = http.address(); if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const root = await mkdtemp(join(tmpdir(), "joko-model-facade-"));
  const store = new OperationalStore(join(root, "store.db"));
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const vault = await CredentialVault.open(join(root, "vault.key"));
  const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") }); await credentials.initialize();
  const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, SECRET);
  await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "cred_facade_fixture", displayName: "Fixture", kind: "header_secret" });
  const backendId = backend === "claude" ? "claude-code" : "codex";
  store.upsertBackend({ id: backendId, displayName: "Native runtime", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 1,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId, displayName: "Workspace", workspaceRoot: root, managed: false, trusted: true });
  store.createSession({ id: "task", backendId, targetId: "target", title: "Task", binding: { opaqueRef: "native", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  let apps: McpAppsManager;
  const connections: AppConnection[] = [];
  const router = new McpRouter({ store, credentials,
    onAppConnectionOpen: connection => { connections.push(connection); apps?.host.registerConnection(connection); },
    onAppConnectionRelease: connection => apps.host.releaseConnection(connection),
    onAppToolCall: input => apps.capture(input),
  });
  apps = new McpAppsManager({ store, vault, config: id => router.appServerConfig(id), redact: value => credentials.redactText(value),
    authorizeTool: async () => {}, sendMessage: async () => {} });
  cleanups.push(async () => { await router.dispose(); await apps.dispose(); });
  await router.initialize();
  const server = await router.upsert({ id: "server", displayName: "Fixture", transport: "sse", endpoint: `http://127.0.0.1:${address.port}/events`, enabled: true,
    credentialBindings: [{ target: "header", name: "Authorization", credentialReferenceId: "cred_facade_fixture" }] });
  expect(server.state).toBe("connected");
  const manager = new CodexMcpBridgeManager({ router }); cleanups.push(() => manager.shutdown());
  let active = true;
  const admissions = vi.fn((threadId: string) => {
    if (!active || threadId !== "native") throw new Error("Inactive native actor");
    return { signal: new AbortController().signal, assertCurrent: () => { if (!active) throw new Error("Retired native actor"); }, release: () => {} };
  });
  let lease: Awaited<ReturnType<CodexMcpBridgeManager["openLocal"]>>, transport: Transport, serving: Promise<void> | undefined;
  if (backend === "codex") {
    lease = await manager.openLocal({ sessionId: "task", targetId: "target", generation: 1, threadId: "native",
      assertSessionCurrent: () => { if (!active) throw new Error("Retired query"); }, beginToolCall: admissions });
    expect(lease.routes).toHaveLength(1); transport = new StreamableHTTPClientTransport(new URL(lease.routes[0]!.url));
  } else {
    const native = createClaudeMcpBridge({ router, includeToolPolicy: () => true,
      assertSessionCurrent: () => { if (!active) throw new Error("Retired query"); },
    }).open({ sessionId: "task", targetId: "target", generation: 1, signal: new AbortController().signal });
    lease = { routes: [], assertCurrent: () => native.assertCurrent(), release: async () => native.release() };
    cleanups.push(async () => native.release());
    const pair = InMemoryTransport.createLinkedPair(); transport = pair[0];
    serving = native.models![0]!.connect(pair[1], async call => {
      const admission = admissions("native"); admission.assertCurrent();
      const result = await native.call({ serverId: "server", toolName: call.toolName, requestId: call.modelCallId, arguments: call.arguments, signal: call.signal, modelCallId: call.modelCallId });
      admission.assertCurrent(); return result;
    });
  }
  const client = new Client({ name: "independent-native-model", version: "1" }, { capabilities: { roots: { listChanged: true } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: "file:///fixture", name: "Fixture root" }] }));
  cleanups.push(() => client.close()); await Promise.all([client.connect(transport), serving]);
  const notifications: unknown[] = [], receive = transport.onmessage;
  transport.onmessage = message => { if ("method" in message && message.method === "notifications/progress") notifications.push(message.params); receive?.(message); };
  return { client, transport, lease, store, apps, router, sessions, capabilities, levels, subscriptions, progressTokens, admissions, notifications, connections,
    meta: (toolUseId: string) => backend === "claude" ? { "claudecode/toolUseId": toolUseId } : { threadId: "native" },
    retire: () => { active = false; }, slow: () => ({ started: slowStarted, cancelled: slowCancelled }) };
}

it.each(["codex", "claude"] as const)("preserves actual handshake, ordinary methods, callbacks and visibility (%s)", async backend => {
  const f = await fixture(false, backend);
  expect(f.client.getServerCapabilities()).toEqual(f.capabilities);
  expect(f.client.getInstructions()).toContain("Use the form."); expect(f.client.getInstructions()).not.toContain(SECRET);
  expect((await f.client.listTools()).tools.map(tool => tool.name)).toEqual(["form", "roots", "slow", "task"]);
  expect((await f.client.listResources()).resources).toMatchObject([{ uri: "ui://fixture/form" }]);
  expect((await f.client.listResourceTemplates()).resourceTemplates).toMatchObject([{ uriTemplate: "data://fixture/{id}" }]);
  expect((await f.client.listPrompts()).prompts).toEqual([{ name: "example" }]);
  expect(JSON.stringify(await f.client.getPrompt({ name: "example" }))).not.toContain(SECRET);
  expect(JSON.stringify(await f.client.readResource({ uri: "ui://fixture/form" }))).not.toContain(SECRET);
  const rejected = await f.client.readResource({ uri: "data://fixture/error" }).catch(error => error);
  expect(rejected).toBeInstanceOf(McpError); expect(rejected.code).toBe(ErrorCode.InvalidParams);
  expect(JSON.stringify({ message: rejected.message, data: rejected.data })).not.toContain(SECRET);
  expect(await f.client.complete({ ref: { type: "ref/prompt", name: "example" }, argument: { name: "name", value: "c" } })).toEqual({ completion: { values: ["completed"] } });
  await f.client.setLoggingLevel("debug"); await f.client.subscribeResource({ uri: "ui://fixture/form" }); await f.client.unsubscribeResource({ uri: "ui://fixture/form" });
  expect(f.levels).toEqual(["debug"]); expect(f.subscriptions).toEqual(["ui://fixture/form", "-ui://fixture/form"]);
  const model = [...f.sessions.values()].find(session => session.protocol.getClientCapabilities()?.roots);
  expect(model).toBeDefined();
  const updated = vi.fn(), logging = vi.fn(); f.client.setNotificationHandler(ResourceUpdatedNotificationSchema, updated); f.client.setNotificationHandler(LoggingMessageNotificationSchema, logging);
  await model!.protocol.notification({ method: "notifications/resources/updated", params: { uri: "ui://fixture/form" } });
  await model!.protocol.notification({ method: "notifications/message", params: { level: "info", data: `Message ${SECRET}` } });
  await vi.waitFor(() => { expect(updated).toHaveBeenCalledOnce(); expect(logging).toHaveBeenCalledOnce(); });
  expect(JSON.stringify(logging.mock.calls)).not.toContain(SECRET);
  expect(await f.client.callTool({ name: "roots", arguments: {}, _meta: f.meta("native-roots") })).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Fixture root") }] });
  const progress = vi.fn();
  const errors: string[] = [], upstream = await f.connections.at(-1)!.getClient(); upstream.onerror = error => { errors.push(error.message); };
  const result = await f.client.callTool({ name: "form", arguments: {}, _meta: f.meta("native-form") }, undefined, { onprogress: progress });
  expect(result.content).toEqual([{ type: "text", text: "form" }]); expect(JSON.stringify(result)).not.toContain("view-only"); expect(f.progressTokens).toEqual([expect.any(Number)]);
  expect(errors).toEqual([]);
  // Inspect protocol bytes independently of this SDK client's progress cleanup.
  expect(f.notifications).toEqual([expect.objectContaining({ progressToken: expect.any(Number), progress: 1, total: 1 })]);
  expect(model!.calls).toEqual(["roots", "form"]);
  const card = f.store.listEvents({ sessionId: "task" }).findLast(event => event.payload.type === "mcp_app_changed");
  if (card?.payload.type !== "mcp_app_changed") throw new Error("Missing captured App");
  const document = await f.apps.host.open("viewer", "task", card.payload.card.id, { platform: "desktop", theme: "dark", locale: "en" });
  expect(document.html).toContain('data-calls="2"');
  await expect(f.client.callTool({ name: "app_only", arguments: {}, _meta: f.meta("native-app-only") })).rejects.toThrow("MCP_TOOL_NOT_VISIBLE");
  expect(f.admissions).toHaveBeenCalledTimes(2);
  await f.lease.release();
  await expect(f.client.listResources()).rejects.toThrow();
  // A visible App retains this original upstream connection until its View ends.
  expect(f.connections.at(-1)!.isClosed).toBe(false);
  await f.apps.host.teardown("viewer", "task", document.viewId);
  expect(f.connections.at(-1)!.isClosed).toBe(true);
});

it.each(["codex", "claude"] as const)("keeps task delegation on native admission and hides View metadata (%s)", async backend => {
  const f = await fixture(false, backend);
  const result = await f.client.request({ method: "tools/call", params: { name: "task", arguments: {}, task: { ttl: 60_000 }, _meta: f.meta("native-task") } }, CreateTaskResultSchema);
  expect(result).toEqual({ task: TASK }); expect(f.admissions).toHaveBeenCalledOnce();
  expect(await f.client.request({ method: "tasks/get", params: { taskId: "job" } }, ResultSchema)).toMatchObject({ taskId: "job", status: "completed" });
  expect(await f.client.request({ method: "tasks/result", params: { taskId: "job" } }, ResultSchema)).toEqual({ content: [{ type: "text", text: "Task complete" }] });
  expect(f.store.listEvents({ sessionId: "task" }).filter(event => event.payload.type === "mcp_app_changed")).toHaveLength(0);
  f.retire(); await expect(f.client.request({ method: "tasks/get", params: { taskId: "job" } }, ResultSchema)).rejects.toThrow();
});

it("cancels numeric request ID zero without dispatching a second tool call", async () => {
  const f = await fixture(), abort = new AbortController();
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": f.transport.sessionId!, "mcp-protocol-version": LATEST_PROTOCOL_VERSION };
  const call = fetch(f.lease.routes[0]!.url, { method: "POST", headers, signal: abort.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "slow", arguments: {}, _meta: { threadId: "native", progressToken: 0 } } }) }).catch(() => undefined);
  try {
    await vi.waitFor(() => expect(f.slow().started).toBe(true));
    const cancelled = await fetch(f.lease.routes[0]!.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 0 } }) });
    expect(cancelled.ok).toBe(true); await vi.waitFor(() => expect(f.slow().cancelled).toBe(true)); expect(f.admissions).toHaveBeenCalledOnce();
  } finally { abort.abort(); await call; }
});

it("preserves numeric progress token zero on the standard response stream", async () => {
  const f = await fixture();
  const response = await fetch(f.lease.routes[0]!.url, { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": f.transport.sessionId!, "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
  }, body: JSON.stringify({ jsonrpc: "2.0", id: "progress-zero", method: "tools/call", params: { name: "form", arguments: {}, _meta: { threadId: "native", progressToken: 0 } } }) });
  expect(response.ok).toBe(true); expect(response.headers.get("content-type")).toContain("text/event-stream");
  const messages = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
  expect(messages).toMatchObject([{ method: "notifications/progress", params: { progressToken: 0, progress: 1 } }, { id: "progress-zero", result: { content: [{ type: "text", text: "form" }] } }]);
  expect(JSON.stringify(messages)).not.toContain("view-only"); expect(f.admissions).toHaveBeenCalledOnce();
});

it.each(["codex", "claude"] as const)("retains a resource-only server without inventing tools (%s)", async backend => {
  const f = await fixture(true, backend);
  expect(f.client.getServerCapabilities()).toEqual(f.capabilities); expect(f.client.getServerCapabilities()?.tools).toBeUndefined();
  expect((await f.client.listResources()).resources).toHaveLength(1); expect(f.admissions).not.toHaveBeenCalled();
});
