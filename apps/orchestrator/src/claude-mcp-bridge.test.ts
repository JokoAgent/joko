import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalStore } from "@joko/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeMcpBridge } from "./claude-mcp-bridge.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { McpRouter, type BridgeToolCallContext } from "./mcp-router.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("Claude product MCP Router bridge", () => {
  it("requires a durable Session, forwards exact schema/result without exposing the Router bearer, and retires on scope loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-mcp-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    await credentials.initialize();
    const router = new McpRouter({ store, credentials });
    await router.initialize();
    cleanups.push(async () => { await router.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
    store.upsertBackend({
      id: "claude-code", displayName: "Claude", version: "test", health: "healthy", adapterKind: "fixture",
      instanceGeneration: 1, installationState: "installed", authenticationState: "authenticated",
      capabilities: new Map(), models: [], tools: [], diagnostics: []
    });
    store.upsertTarget({
      id: "target-local", backendId: "claude-code", displayName: "Local", workspaceRoot: root,
      managed: false, trusted: true
    });
    const calls: BridgeToolCallContext[] = [];
    router.registerBridgeToolProvider({
      id: "approved-tools", generation: 1, available: true,
      tools: [{
        serverId: "approved-tools", name: "echo", description: "Echo one value",
        inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
        requiresPermission: false
      }],
      callTool: async (_name, arguments_, _signal, context) => {
        calls.push(context);
        const echoed = String(arguments_["value"] ?? "");
        return { content: [{ type: "text", text: echoed }], structuredContent: { echoed }, isError: false };
      }
    });
    const bridge = createClaudeMcpBridge({
      router,
      includeToolPolicy: () => true,
      assertSessionCurrent: (sessionId, targetId, generation) => {
        const session = store.getSession(sessionId).descriptor;
        if (session.targetId !== targetId || session.binding.generation !== generation || session.deletedAt !== undefined) {
          throw new Error("The Session is stale.");
        }
      }
    });
    const open = () => bridge.open({
      sessionId: "session-local", targetId: "target-local", generation: 1,
      signal: new AbortController().signal
    });
    expect(open).toThrow();
    store.createSession({
      id: "session-local", backendId: "claude-code", targetId: "target-local", title: "Local",
      binding: { opaqueRef: "native-uuid", generation: 1 }, pinned: false, archived: false,
      permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1
    });
    const lease = open();
    expect(lease.tools).toMatchObject([{
      serverId: "approved-tools", name: "echo", inputSchema: { type: "object" }, outputSchema: { type: "object" }
    }]);
    expect(JSON.stringify(lease)).not.toContain("Bearer");
    expect(await lease.call({
      serverId: "approved-tools", toolName: "echo", requestId: "native-tool-use-one",
      arguments: { value: "approved" }, signal: new AbortController().signal
    })).toMatchObject({ content: [{ type: "text", text: "approved" }], structuredContent: { echoed: "approved" }, isError: false });
    expect(calls).toHaveLength(1);
    lease.release();
    await expect(lease.call({
      serverId: "approved-tools", toolName: "echo", requestId: "late-tool",
      arguments: { value: "late" }, signal: new AbortController().signal
    })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("discovers newly advertised HTTP tools for a new Query while the existing Query and SDK client stay fenced", { timeout: 20_000 }, async () => {
    const echo: Tool = { name: "echo", inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } };
    const upstream = await toolCatalogServer(echo);
    const root = await mkdtemp(join(tmpdir(), "joko-claude-mcp-catalog-"));
    const store = new OperationalStore(join(root, "orchestrator.db"));
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    await credentials.initialize();
    const router = new McpRouter({ store, credentials });
    cleanups.push(async () => { await router.dispose(); store.close(); await rm(root, { recursive: true, force: true }); });
    await router.initialize();
    store.upsertBackend({ id: "claude-code", displayName: "Claude", version: "test", health: "healthy", adapterKind: "fixture",
      instanceGeneration: 1, installationState: "installed", authenticationState: "authenticated",
      capabilities: new Map(), models: [], tools: [], diagnostics: [] });
    store.upsertTarget({ id: "target-local", backendId: "claude-code", displayName: "Local", workspaceRoot: root, managed: false, trusted: true });
    store.createSession({ id: "session-local", backendId: "claude-code", targetId: "target-local", title: "Local",
      binding: { opaqueRef: "native-uuid", generation: 1 }, pinned: false, archived: false,
      permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    const original = await router.upsert({ id: "live-http", displayName: "Live HTTP", transport: "streamable_http", endpoint: upstream.endpoint,
      enabled: true, credentialBindings: [] });
    expect(original.state).toBe("connected");
    const bridge = createClaudeMcpBridge({ router, includeToolPolicy: () => true, assertSessionCurrent: () => {} });
    const open = async () => {
      const lease = bridge.open({ sessionId: "session-local", targetId: "target-local", generation: 1, signal: new AbortController().signal });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const model = lease.models?.find(candidate => candidate.serverId === "live-http");
      if (model === undefined) throw new Error("The original App model channel was unavailable.");
      const client = new Client({ name: "native-query-fixture", version: "1" });
      cleanups.push(async () => { lease.release(); await client.close(); });
      await model.connect(serverTransport, call => lease.call({ serverId: model.serverId, toolName: call.toolName,
        requestId: call.toolUseId, arguments: call.arguments, modelCallId: call.modelCallId, signal: call.signal }));
      await client.connect(clientTransport);
      return client;
    };
    const previous = await open();
    expect((await previous.listTools()).tools).toMatchObject([echo]);
    const updatedEcho: Tool = { ...echo, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } };
    const added: Tool = { name: "added", inputSchema: { type: "object" } };
    await upstream.publish([updatedEcho, added, { name: "card_only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } }]);
    await vi.waitFor(() => expect(router.list()[0]).toMatchObject({ runtimeGeneration: original.runtimeGeneration,
      version: original.version, tools: [{ name: "echo" }, { name: "added" }, { name: "card_only", modelVisible: false }] }), { timeout: 5_000 });
    const next = await open();
    expect((await next.listTools()).tools).toMatchObject([updatedEcho, added]);
    expect((await previous.listTools()).tools).toMatchObject([echo]);
    await expect(previous.callTool({ name: "added", arguments: {}, _meta: { "claudecode/toolUseId": "old-added" } })).rejects.toThrow("MCP_TOOL_NOT_VISIBLE");
    expect(await next.callTool({ name: "added", arguments: {}, _meta: { "claudecode/toolUseId": "new-added" } })).toMatchObject({
      isError: false, content: [{ type: "text", text: "added" }]
    });
    expect(await router.callTool({ serverId: "live-http", expectedGeneration: original.runtimeGeneration, toolName: "echo" })).toMatchObject({
      structuredContent: { value: "original SDK schema" }
    });
    const pi = router.createPiBridgeSnapshot({ endpoint: "http://127.0.0.1/pi-mcp" });
    expect(pi.mcpBridge.tools.map(tool => tool.name)).toEqual(["echo"]);
    pi.revoke();
  });
});

async function toolCatalogServer(firstTool: Tool) {
  let tools = [firstTool];
  const protocols = new Map<string, { protocol: Server; transport: StreamableHTTPServerTransport }>();
  const eventStreams = new Set<ServerResponse>();
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const sessionId = request.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? protocols.get(sessionId)?.transport : undefined;
    if (transport === undefined) {
      if (sessionId !== undefined || request.method !== "POST") { response.writeHead(404).end(); return; }
      const protocol = new Server({ name: "loopback-tools", version: "1" }, { capabilities: { tools: { listChanged: true } } });
      protocol.setRequestHandler(ListToolsRequestSchema, async request => {
        if (request.params?.cursor === "remaining") return { tools: tools.slice(1) };
        return { tools: tools.slice(0, 1), ...(tools.length > 1 ? { nextCursor: "remaining" } : {}) };
      });
      protocol.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: "text", text: request.params.name }],
        ...(request.params.name === "echo" ? { structuredContent: { value: "original SDK schema" } } : {}) }));
      const initialized = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized: id => { protocols.set(id, { protocol, transport: initialized }); } });
      await protocol.connect(initialized);
      transport = initialized;
    }
    if (request.method === "GET") {
      eventStreams.add(response);
      response.on("close", () => eventStreams.delete(response));
    }
    await transport.handleRequest(request, response);
  };
  const http = createServer((request, response) => { void handle(request, response).catch(() => response.destroy()); });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("The fixture address is unavailable.");
  cleanups.push(async () => {
    await Promise.allSettled([...protocols.values()].map(({ protocol }) => protocol.close()));
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  });
  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    publish: async (next: Tool[]) => {
      await vi.waitFor(() => expect([...eventStreams].some(response => response.headersSent)).toBe(true), { timeout: 5_000 });
      tools = next;
      await Promise.all([...protocols.values()].map(({ protocol }) => protocol.sendToolListChanged()));
    }
  };
}
