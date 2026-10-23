import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema,
  GetPromptRequestSchema, ListRootsRequestSchema, ListRootsResultSchema, GetTaskRequestSchema, GetTaskPayloadRequestSchema, CreateTaskResultSchema,
  ResultSchema, ResourceUpdatedNotificationSchema, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { AdapterContext } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { McpRouter, type BridgeToolCallContext } from "./mcp-router.js";
import { HostedAgentSourceMcp } from "./hosted-agent-source-mcp.js";
import { HostedAgentNativeMcp } from "./hosted-agent-native-mcp.js";
import { ExecutorWorkspace } from "./hosted-agent-workspace.js";
import { McpAppsManager } from "./mcp-apps/manager.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(setup?: (input: { router: McpRouter; credentials: CredentialManager; workspace: string }) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-mcp-"))), workspace = join(root, "project"); await mkdir(workspace);
  const store = new OperationalStore(join(root, "store.db")), backend = new FakeBackendAdapter(PI_LIKE_PROFILE), descriptor = await backend.describe(); store.upsertBackend(descriptor);
  const target = { id: "project", backendId: backend.id, displayName: "Original", workspaceRoot: workspace, trusted: true, managed: false }; store.upsertTarget(target);
  store.createSession({ id: "task", backendId: backend.id, targetId: target.id, title: "Original", binding: { opaqueRef: "original-native", generation: 1 },
    pinned: false, archived: false, permissionMode: "bypassPermissions", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  store.runOperation({ id: "original-operation", kind: "input.enqueue", body: {} }, transaction => {
    transaction.createRun({ id: "run", sessionId: "task", source: "user", state: "queued", createdAt: 1 });
    transaction.createAttempt({ id: "attempt", runId: "run", ordinal: 1, generation: 1, startedAt: 1 });
    transaction.enqueueQueueItem({ id: "queue", sessionId: "task", runId: "run", attemptId: "attempt", operationId: "original-operation", disposition: "prompt",
      body: { text: "Use original tools", images: [], files: [], mentions: [], disposition: "prompt" } }); return {};
  }); store.claimNextQueueItem({ sessionId: "task", backendInstanceGeneration: descriptor.instanceGeneration });
  const vault = await CredentialVault.open(join(root, "vault.key")), credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") }); await credentials.initialize();
  let apps: McpAppsManager;
  const router = new McpRouter({ store, credentials, onAppConnectionOpen: connection => apps.host.registerConnection(connection),
    onAppConnectionRelease: connection => apps.host.releaseConnection(connection), onAppToolCall: input => apps.capture(input) });
  apps = new McpAppsManager({ store, vault, config: id => router.appServerConfig(id), redact: value => credentials.redactText(value),
    authorizeTool: async () => {}, sendMessage: async () => {} });
  await router.initialize();
  const calls: { args: Readonly<Record<string, unknown>>; context: BridgeToolCallContext }[] = [];
  router.registerBridgeToolProvider({ id: "original_tools", generation: 1, available: true,
    tools: ["echo", "owner_input"].map(name => ({ serverId: "original_tools", name, description: "Original task tool", inputSchema: { type: "object", properties: { path: { type: "string" } } },
      ...(name === "owner_input" ? { requiresNativeRoot: true as const } : {}), requiresPermission: false })),
    callTool: async (_name, args, _signal, context) => { context.assertCurrent?.(); context.assertNativeRoot?.(); calls.push({ args, context });
      return { content: [{ type: "text", text: String(args.path ?? "ORIGINAL_MCP_BYTES") }], structuredContent: { source: context.sessionId }, isError: false }; } });
  const abort = new AbortController(); let current = true;
  const context: AdapterContext = { sessionId: "task", target, generation: 1, backendInstanceGeneration: descriptor.instanceGeneration, operationId: "original-operation", inputQueueItemId: "queue",
    binding: store.getSession("task").descriptor.binding, signal: abort.signal, emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }),
    artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No output Artifact."); } };
  const assert = () => { abort.signal.throwIfAborted(); if (!current || store.getSession("task").descriptor.binding.generation !== 1) throw new Error("Original MCP authority changed."); };
  await setup?.({ router, credentials, workspace });
  const source = new HostedAgentSourceMcp({ store, router, context, assertCurrent: assert, includeToolPolicy: () => true });
  const paths = new ExecutorWorkspace({ workingDir: workspace, aliases: [{ from: "/native/workspace", to: workspace }] }); paths.setVirtualRoot("/native/workspace");
  const owner = { sessionId: "native-task", targetId: "native-target", generation: 1 };
  const native = await HostedAgentNativeMcp.create({ owner, signal: abort.signal, assertCurrent: assert, execute: (request, signal) => source.execute(request, context, paths, signal) });
  cleanup.push(async () => { await native.close(); await source.close(); await router.dispose(); await apps.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, store, router, source, native, calls, owner, context, abort, apps, paths, retire: () => { current = false; } };
}

it("keeps Source tools and scope on the original node and consumes only native root proofs for owner-only calls", async () => {
  const f = await fixture(), bridge = f.native.pi();
  const call = async (requestId: string, toolName: string, proof?: string) => fetch(bridge.endpoint, { method: "POST", headers: { authorization: "Bearer " + bridge.token, "content-type": "application/json" },
    body: JSON.stringify({ ...f.owner, requestId, serverId: "original_tools", toolName, arguments: { path: "/native/workspace/proof.txt" }, ...(proof ? { nativeRootProof: proof } : {}) }) });
  expect(await (await call("echo", "echo")).json()).toMatchObject({ content: [{ text: "/native/workspace/proof.txt" }], isError: false });
  expect(f.calls[0]?.args.path).toBe(join(f.workspace, "proof.txt")); expect(f.calls[0]?.context).toMatchObject({ sessionId: "task", targetId: "project", generation: 1 });
  expect((await call("root", "owner_input")).ok).toBe(false);
  const proof = bridge.captureRootCall!({ requestId: "root", serverId: "original_tools", toolName: "owner_input", arguments: { path: "/native/workspace/proof.txt" }, assertCurrent: () => {} });
  expect((await call("root", "owner_input", proof)).ok).toBe(true); expect((await call("root", "owner_input", proof)).ok).toBe(false); expect(f.calls).toHaveLength(2);
  f.retire(); expect((await call("late", "echo")).ok).toBe(false);
});

it("provides the original tools through Claude's Query port and rejects withdrawn root and task authority", async () => {
  const f = await fixture(), lease = f.native.claude().open({ ...f.owner, signal: f.abort.signal });
  expect(lease.tools.map(tool => tool.name)).toEqual(["echo", "owner_input"]);
  expect(await lease.call({ serverId: "original_tools", toolName: "owner_input", requestId: "claude-root", arguments: {}, signal: f.abort.signal,
    nativeRootCall: { arguments: {}, assertCurrent: () => {} } })).toMatchObject({ content: [{ text: "ORIGINAL_MCP_BYTES" }], structuredContent: { source: "task" } });
  f.store.updateSession("task", { binding: { ...f.context.binding!, generation: 2 } });
  await expect(lease.call({ serverId: "original_tools", toolName: "echo", requestId: "late", arguments: {}, signal: f.abort.signal })).rejects.toThrow();
  lease.release(); expect(f.calls).toHaveLength(1);
});

it("retires prior native MCP leases and one-use root proofs when the confirmed native context is replaced", async () => {
  const f = await fixture(), bridge = f.native.pi(), oldLease = f.native.claude().open({ ...f.owner, signal: f.abort.signal });
  const proof = bridge.captureRootCall!({ requestId: "before-rewind", serverId: "original_tools", toolName: "owner_input", arguments: {}, assertCurrent: () => {} });
  f.native.replaceOwnerGeneration(2);
  expect(() => f.native.replaceOwnerGeneration(4)).toThrow("generation");
  await expect(oldLease.call({ serverId: "original_tools", toolName: "echo", requestId: "late-lease", arguments: {}, signal: f.abort.signal })).rejects.toThrow();
  const stale = await fetch(bridge.endpoint, { method: "POST", headers: { authorization: "Bearer " + bridge.token, "content-type": "application/json" },
    body: JSON.stringify({ ...f.owner, generation: 2, requestId: "before-rewind", serverId: "original_tools", toolName: "owner_input", arguments: {}, nativeRootProof: proof }) });
  expect(stale.ok).toBe(false); expect(f.calls).toHaveLength(0);
  const nextLease = f.native.claude().open({ ...f.owner, generation: 2, signal: f.abort.signal });
  expect(await nextLease.call({ serverId: "original_tools", toolName: "echo", requestId: "current-context", arguments: {}, signal: f.abort.signal }))
    .toMatchObject({ isError: false, structuredContent: { source: "task" } });
  expect(f.calls).toHaveLength(1); oldLease.release(); nextLease.release();
});

it("serves the original MCP protocol through Codex's native route and verifies its native root thread", { timeout: 20_000 }, async () => {
  const f = await fixture(); let rootCurrent = true;
  const lease = await f.native.codex({ ...f.owner, signal: f.abort.signal, assertSessionCurrent: () => {}, beginToolCall: threadId => {
    if (threadId !== "root-thread") throw new Error("Foreign native thread.");
    return { signal: f.abort.signal, assertCurrent: () => {}, release: () => {}, assertNativeRoot: () => { if (!rootCurrent) throw new Error("Native root retired."); } };
  } });
  const client = new Client({ name: "native-sdk", version: "1" }, { capabilities: {} }); cleanup.push(async () => { await client.close(); await lease.release(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(lease.routes[0]!.url)));
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["echo", "owner_input"]);
  expect(await client.callTool({ name: "owner_input", arguments: {}, _meta: { threadId: "root-thread" } })).toMatchObject({ content: [{ text: "ORIGINAL_MCP_BYTES" }], isError: false });
  rootCurrent = false;
  await expect(client.callTool({ name: "owner_input", arguments: {}, _meta: { threadId: "root-thread" } })).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});

const SECRET = "original-node-only-mcp-secret";
const TASK = { taskId: "job", status: "working" as const, createdAt: "2026-10-23T00:00:00Z", lastUpdatedAt: "2026-10-23T00:00:00Z", ttl: 60_000, pollInterval: 1000 };
async function externalFixture(backend: "codex" | "claude") {
  const sessions = new Map<string, { server: Server; transport: SSEServerTransport }>(), responses = new Set<ServerResponse>();
  const calls: string[] = [], authorizations: unknown[] = []; let slowStarted = false, slowCancelled = false, originalPath = "";
  const http = createServer((request, response) => {
    responses.add(response); response.on("close", () => responses.delete(response)); authorizations.push(request.headers.authorization);
    if (request.headers.authorization !== SECRET) { response.writeHead(401).end(); return; }
    if (request.method === "GET" && request.url === "/events") {
      const server = new Server({ name: "original-external-server", version: "1" }, { instructions: `Source instructions ${SECRET}`,
        capabilities: { tools: {}, resources: { listChanged: true }, prompts: {}, tasks: { requests: { tools: { call: {} } } } } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: "form", description: "Original App", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://source/form" } } },
        { name: "app_only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
        ...["roots", "slow", "task"].map(name => ({ name, inputSchema: { type: "object" as const }, ...(name === "task" ? { execution: { taskSupport: "optional" as const } } : {}) }))
      ] }));
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        calls.push(request.params.name);
        if (request.params.name === "slow") {
          slowStarted = true;
          await new Promise<void>(resolve => { const cancel = () => { slowCancelled = true; resolve(); }; extra.signal.addEventListener("abort", cancel, { once: true }); if (extra.signal.aborted) cancel(); });
          extra.signal.throwIfAborted();
        }
        if (request.params.name === "roots") return { content: [{ type: "text", text: JSON.stringify(await server.request({ method: "roots/list" }, ListRootsResultSchema, { signal: extra.signal })) }] };
        if (request.params.name === "task") return { task: TASK, _meta: { privateResult: "view-only" } };
        const token = request.params._meta?.progressToken;
        if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 1 } });
        return { content: [{ type: "text", text: `form ${SECRET}` }], _meta: { privateResult: "view-only" } };
      });
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: pathToFileURL(originalPath).href, name: "Original file" }] }));
      server.setRequestHandler(ReadResourceRequestSchema, async request => {
        if (request.params.uri.startsWith("file://")) {
          expect(request.params.uri).toBe(pathToFileURL(originalPath).href);
          return { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "Original file resource" }] };
        }
        return { contents: [{ uri: request.params.uri, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><title>Original</title><div>Original form</div>" }] };
      });
      server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: "original" }] }));
      server.setRequestHandler(GetPromptRequestSchema, async () => ({ messages: [{ role: "user", content: { type: "text", text: `Prompt ${SECRET}` } }] }));
      server.setRequestHandler(GetTaskRequestSchema, async () => ({ ...TASK, status: "completed" }));
      server.setRequestHandler(GetTaskPayloadRequestSchema, async () => ({ content: [{ type: "text", text: "Task complete" }], _meta: { privateResult: "view-only" } }));
      const transport = new SSEServerTransport("/messages", response); sessions.set(transport.sessionId, { server, transport }); void server.connect(transport).catch(() => response.end());
    } else if (request.method === "POST") {
      const id = new URL(request.url ?? "", "http://localhost").searchParams.get("sessionId"), session = id && sessions.get(id);
      if (!session) { response.writeHead(404).end(); return; } void session.transport.handlePostMessage(request, response).catch(() => response.end());
    } else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { await Promise.allSettled([...sessions.values()].map(session => session.server.close())); for (const response of responses) response.end();
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address(); if (!address || typeof address === "string") throw new Error("Missing original MCP listener.");
  const f = await fixture(async ({ router, credentials, workspace }) => {
    originalPath = join(workspace, "proof.txt"); const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, SECRET);
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "original-mcp", displayName: "Original MCP", kind: "header_secret" });
    expect((await router.upsert({ id: "external", displayName: "Original MCP", transport: "sse", endpoint: `http://127.0.0.1:${address.port}/events`, enabled: true,
      credentialBindings: [{ target: "header", name: "Authorization", credentialReferenceId: "original-mcp" }] })).state).toBe("connected");
  });
  const admissions = vi.fn(); let transport: Transport, serving: Promise<void> | undefined, url = "";
  if (backend === "codex") {
    const lease = await f.native.codex({ ...f.owner, assertSessionCurrent: () => {}, beginToolCall: thread => {
      expect(thread).toBe("native-root"); admissions(); return { signal: f.abort.signal, assertCurrent: () => {}, release: () => {}, assertNativeRoot: () => {} };
    } }); cleanup.push(() => lease.release()); url = lease.routes.find(route => route.serverId === "external")!.url;
    transport = new StreamableHTTPClientTransport(new URL(url));
  } else {
    const lease = f.native.claude().open({ ...f.owner, signal: f.abort.signal }); cleanup.push(async () => lease.release());
    const pair = InMemoryTransport.createLinkedPair(); transport = pair[0];
    serving = lease.models!.find(model => model.serverId === "external")!.connect(pair[1], async call => {
      admissions(); return lease.call({ serverId: "external", toolName: call.toolName, requestId: call.modelCallId, arguments: call.arguments, signal: call.signal, modelCallId: call.modelCallId });
    });
  }
  const client = new Client({ name: "native-model", version: "1" }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: "file:///native/workspace", name: "Native root" }] }));
  cleanup.push(() => client.close()); await Promise.all([client.connect(transport), serving]);
  const notifications: unknown[] = [], receive = transport.onmessage;
  transport.onmessage = message => { if ("method" in message && message.method === "notifications/progress") notifications.push(message.params); receive?.(message); };
  return { ...f, client, transport, url, calls, sessions, admissions, authorizations, notifications,
    meta: backend === "codex" ? { threadId: "native-root" } : { "claudecode/toolUseId": "native-tool" }, slow: () => ({ started: slowStarted, cancelled: slowCancelled }) };
}

it.each(["codex", "claude"] as const)("retains the original standard MCP protocol, App ownership and private credentials (%s)", { timeout: 25_000 }, async backend => {
  const f = await externalFixture(backend);
  expect(f.client.getInstructions()).toContain("Source instructions"); expect(f.client.getInstructions()).not.toContain(SECRET);
  expect((await f.client.listTools()).tools.map(tool => tool.name)).toEqual(["form", "roots", "slow", "task"]);
  expect((await f.client.listResources()).resources).toMatchObject([{ uri: "file:///native/workspace/proof.txt" }]);
  expect(await f.client.readResource({ uri: "file:///native/workspace/proof.txt" })).toMatchObject({ contents: [{ uri: "file:///native/workspace/proof.txt", text: "Original file resource" }] });
  expect((await f.client.listPrompts()).prompts).toEqual([{ name: "original" }]);
  expect(JSON.stringify(await f.client.getPrompt({ name: "original" }))).not.toContain(SECRET);
  expect(JSON.stringify(await f.client.readResource({ uri: "ui://source/form" }))).not.toContain(SECRET);
  const updated = vi.fn(); f.client.setNotificationHandler(ResourceUpdatedNotificationSchema, updated);
  const model = [...f.sessions.values()].find(session => session.server.getClientCapabilities()?.roots); expect(model).toBeDefined();
  await model!.server.notification({ method: "notifications/resources/updated", params: { uri: "ui://source/form" } });
  await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(await f.client.callTool({ name: "roots", arguments: {}, _meta: f.meta })).toMatchObject({ content: [{ text: expect.stringContaining("Native root") }] });
  const result = await f.client.callTool({ name: "form", arguments: {}, _meta: f.meta }, undefined, { onprogress: () => {} });
  expect(JSON.stringify(result)).not.toContain(SECRET); expect(JSON.stringify(result)).not.toContain("view-only");
  await vi.waitFor(() => expect(f.notifications).toEqual([expect.objectContaining({ progressToken: expect.any(Number), progress: 1, total: 1 })]));
  const card = f.store.listEvents({ sessionId: "task" }).findLast(event => event.payload.type === "mcp_app_changed");
  if (card?.payload.type !== "mcp_app_changed") throw new Error("The App did not remain on its original task.");
  const view = await f.apps.host.open("viewer", "task", card.payload.card.id, { platform: "desktop", theme: "dark", locale: "en" });
  expect(view.html).toContain("<title>Original</title>"); expect(view.html).not.toContain(SECRET); await f.apps.host.teardown("viewer", "task", view.viewId);
  await expect(f.client.callTool({ name: "app_only", arguments: {}, _meta: f.meta })).rejects.toThrow("MCP_TOOL_NOT_VISIBLE");
  expect(await f.client.request({ method: "tools/call", params: { name: "task", arguments: {}, task: { ttl: 60_000 }, _meta: f.meta } }, CreateTaskResultSchema)).toEqual({ task: TASK });
  expect(await f.client.request({ method: "tasks/get", params: { taskId: "job" } }, ResultSchema)).toMatchObject({ status: "completed" });
  expect(await f.client.request({ method: "tasks/result", params: { taskId: "job" } }, ResultSchema)).toEqual({ content: [{ type: "text", text: "Task complete" }] });
  expect(f.admissions).toHaveBeenCalledTimes(3); expect(f.authorizations.length).toBeGreaterThan(0); expect(f.authorizations.every(value => value === SECRET)).toBe(true);
  expect(JSON.stringify(f.source.catalog())).not.toContain(SECRET);
  f.retire(); await expect(f.client.listResources()).rejects.toThrow();
});

it.each(["protocol cancellation", "native close"] as const)("cancels an original external tool on %s", { timeout: 25_000 }, async action => {
  const f = await externalFixture("codex"), abort = new AbortController();
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": (f.transport as StreamableHTTPClientTransport).sessionId!, "mcp-protocol-version": LATEST_PROTOCOL_VERSION };
  const call = fetch(f.url, { method: "POST", headers, signal: abort.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "slow", arguments: {}, _meta: f.meta } }) }).catch(() => undefined);
  try {
    await vi.waitFor(() => expect(f.slow().started).toBe(true));
    if (action === "native close") await f.native.close();
    else expect((await fetch(f.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 0 } }) })).ok).toBe(true);
    await vi.waitFor(() => expect(f.slow().cancelled).toBe(true)); expect(f.calls).toEqual(["slow"]); expect(f.admissions).toHaveBeenCalledOnce();
    await f.native.close();
  } finally { abort.abort(); await call; }
});

it("rechecks the original Source channel before a deferred tool effect", async () => {
  let finish!: () => void, started!: () => void, active = true, effects = 0;
  const admitted = new Promise<void>(resolve => { started = resolve; }), proceed = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(async ({ router }) => {
    router.registerBridgeToolProvider({ id: "deferred_tools", generation: 1, available: true,
      tools: [{ serverId: "deferred_tools", name: "effect", description: "Deferred original effect", inputSchema: { type: "object" }, requiresPermission: false }],
      callTool: async (_name, _args, _signal, context) => { started(); await proceed; context.assertCurrent?.(); effects++;
        return { content: [{ type: "text", text: "effect" }], isError: false }; } });
  });
  const call = f.source.execute({ kind: "call", requestId: "late-effect", serverId: "deferred_tools", toolName: "effect", arguments: {}, root: false },
    f.context, f.paths, f.abort.signal, () => { if (!active) throw new Error("The original Source channel retired."); });
  const rejected = expect(call).rejects.toThrow(); await admitted; active = false; finish(); await rejected; expect(effects).toBe(0);
});

it("rejects MCP effects without their original durable Queue item", async () => {
  const f = await fixture();
  await expect(f.source.execute({ kind: "call", requestId: "foreign", serverId: "original_tools", toolName: "echo", arguments: {}, root: false },
    { ...f.context, inputQueueItemId: undefined }, f.paths, f.abort.signal)).rejects.toThrow("durable input owner");
  expect(f.calls).toHaveLength(0);
});
