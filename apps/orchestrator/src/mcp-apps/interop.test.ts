import { createServer, type ServerResponse } from "node:http";
import { App } from "@modelcontextprotocol/ext-apps";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListToolsResultSchema, ReadResourceRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { AppConnection } from "./connection.js";
import { McpAppsHost } from "./host.js";
import { SdkMcpClientFactory } from "../mcp-router.js";
import type { McpAppMessageGuard } from "./message.js";
import type { McpAppRecord } from "./types.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

class ViewTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onerror?: Transport["onerror"];
  onclose?: Transport["onclose"];
  #closed = false;
  #after = 0;
  constructor(readonly host: McpAppsHost, readonly viewId: string, readonly caller = "viewer", readonly sessionId = "task") {}
  async start(): Promise<void> { void this.#poll(); }
  async send(message: JSONRPCMessage): Promise<void> { await this.host.dispatch(this.caller, this.sessionId, this.viewId, message); }
  async close(): Promise<void> { this.#closed = true; this.onclose?.(); }
  async #poll(): Promise<void> {
    while (!this.#closed) {
      try {
        const events = await this.host.poll(this.caller, this.sessionId, this.viewId, this.#after);
        for (const event of events) {
          this.#after = event.seq;
          if (!this.#closed && event.message !== undefined) this.onmessage?.(event.message);
        }
      } catch (error) { if (!this.#closed) { this.onerror?.(error as Error); this.#closed = true; this.onclose?.(); } return; }
    }
  }
}

async function fixture(shared = false) {
  const connections = new Map<string, { transport: SSEServerTransport; protocol: Server }>();
  const responses = new Set<ServerResponse>();
  const called: string[] = [];
  const tools = [
    { name: "form", title: "Example form", inputSchema: { type: "object" as const }, _meta: { ui: { resourceUri: "ui://example/form" } } },
    { name: "app_only", inputSchema: { type: "object" as const }, _meta: { ui: { visibility: ["app"] } } },
    { name: "model_only", inputSchema: { type: "object" as const }, _meta: { ui: { visibility: ["model"] } } }
  ];
  const http = createServer((request, response) => {
    responses.add(response); response.on("close", () => responses.delete(response));
    if (request.method === "GET" && request.url === "/events") {
      let callCount = 0;
      const protocol = new Server({ name: "independent-server", version: "1" }, { capabilities: { tools: {}, resources: {} } });
      protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
      protocol.setRequestHandler(ReadResourceRequestSchema, async request => ({ contents: [{ uri: request.params.uri,
        mimeType: "text/html;profile=mcp-app", text: `<!doctype html><title>Example form</title><div data-call-count="${callCount}"></div>`, _meta: { ui: { prefersBorder: false } } }] }));
      protocol.setRequestHandler(CallToolRequestSchema, async request => { callCount++; called.push(request.params.name); return {
        content: [{ type: "text", text: request.params.name }], _meta: { privateView: true }
      }; });
      const transport = new SSEServerTransport("/messages", response);
      connections.set(transport.sessionId, { transport, protocol });
      void protocol.connect(transport).catch(() => response.end());
    } else if (request.method === "POST") {
      const id = new URL(request.url ?? "", "http://localhost").searchParams.get("sessionId");
      const connection = id === null ? undefined : connections.get(id);
      if (connection === undefined) { response.writeHead(404).end(); return; }
      void connection.transport.handlePostMessage(request, response).catch(() => response.end());
    } else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture address");
  cleanup.push(async () => {
    await Promise.allSettled([...connections.values()].map(connection => connection.protocol.close()));
    for (const response of responses) response.end();
    http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()));
  });
  const config = { id: "server", url: `http://127.0.0.1:${address.port}/events`, transport: "sse" as const };
  const model = shared ? await new SdkMcpClientFactory().connect({ config: { id: "server", displayName: "Example", transport: "sse", endpoint: config.url,
    enabled: true, credentialBindings: [] }, generation: 1, credentials: {}, onClose: () => {}, onError: () => {} }) : undefined;
  if (model) { cleanup.push(() => model.close()); await model.callTool("form", {}); }
  const authorizeTool = vi.fn(async (_sessionId: string, _serverId: string, _tool: unknown, _args: unknown, _signal: AbortSignal) => {});
  let messageGuard: McpAppMessageGuard | undefined;
  const sendMessage = vi.fn(async (_sessionId: string, _record: McpAppRecord, _content: unknown[], guard: McpAppMessageGuard) => {
    await guard(); messageGuard = guard;
  });
  let allowed = true;
  let record: McpAppRecord;
  const host = new McpAppsHost({ owner: () => owner, config: () => config,
    readCard: async sessionId => { if (!allowed || sessionId !== "task") throw new Error("MCP_APP_CARD_UNAVAILABLE"); return record; },
    writeCard: async (_sessionId, _cardId, next) => { if (!allowed) throw new Error("MCP_APP_CARD_UNAVAILABLE"); record = next; },
    authorizeTool, sendMessage });
  const owner = {};
  record = { version: 1, serverId: config.id, serverRevision: host.serverRevision(config), tool: tools[0]!,
    resourceUri: "ui://example/form", arguments: { input: "Whole input" }, connectionId: host.registerConnection(model?.appConnection ?? new AppConnection(config)) };
  cleanup.push(() => host.reset());
  const document = await host.open("viewer", "task", "card", { platform: "desktop", theme: "dark", locale: "zh-CN" });
  const inputs = vi.fn(), results = vi.fn(), app = new App({ name: "independent-view", version: "1" }, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: false });
  app.ontoolinput = inputs; app.ontoolresult = results; app.onteardown = async () => ({});
  const transport = new ViewTransport(host, document.viewId);
  cleanup.push(async () => { await transport.close(); await app.close(); });
  await app.connect(transport);
  await vi.waitFor(() => expect(inputs).toHaveBeenCalledWith({ arguments: { input: "Whole input" } }));
  return { app, host, inputs, results, document, authorizeTool, called, sendMessage, model,
    complete: async () => host.updateResult("task", "card", { ...record, result: {
      content: [{ type: "text", text: "Public result" }], structuredContent: { value: 7 }, _meta: { privateView: true } } }),
    revoke: () => { allowed = false; }, messageGuard: () => messageGuard };
}

it("keeps the model tool and App resource on the same upstream MCP session", async () => {
  const f = await fixture(true);
  expect(f.document.html).toContain('data-call-count="1"');
  await f.app.callServerTool({ name: "app_only", arguments: {} });
  const resource = await f.model!.readResource("ui://example/form", new AbortController().signal);
  expect(resource.contents[0]).toMatchObject({ text: expect.stringContaining('data-call-count="2"') });
  expect(f.called).toEqual(["form", "app_only"]);
});

it("negotiates with the official View SDK and delivers complete inputs before private results", async () => {
  const f = await fixture();
  expect(f.document).toMatchObject({ prefersBorder: false, html: expect.stringContaining("Example form"), csp: expect.stringContaining("connect-src 'none'") });
  expect(f.results).not.toHaveBeenCalled();
  await f.complete();
  await vi.waitFor(() => expect(f.results).toHaveBeenCalledWith({ content: [{ type: "text", text: "Public result" }], structuredContent: { value: 7 }, _meta: { privateView: true } }));
  const catalog = await f.app.request({ method: "tools/list" }, ListToolsResultSchema);
  expect(catalog.tools.map(tool => tool.name)).toEqual(["form", "app_only"]);
  await expect(f.app.callServerTool({ name: "model_only" })).rejects.toThrow("MCP_APP_TOOL_NOT_VISIBLE");
  await f.app.callServerTool({ name: "app_only", arguments: { value: 1 } });
  expect(f.called).toEqual(["app_only"]);
  expect(f.authorizeTool).toHaveBeenCalledWith("task", "server", expect.objectContaining({ name: "app_only" }), { value: 1 }, expect.any(AbortSignal));
});

it("retains external model context until accepted, and revokes queued message authority on teardown", async () => {
  const f = await fixture();
  await f.app.updateModelContext({ content: [{ type: "text", text: "External context" }], structuredContent: { selected: 2 } });
  const captured = await f.host.modelContext("task");
  expect(captured.text).toContain("External context");
  await captured.assertCurrent();
  await f.app.sendMessage({ role: "user", content: [{ type: "text", text: "/raw-command" }] });
  expect(f.sendMessage).toHaveBeenCalledOnce();
  expect(f.messageGuard()?.signal.aborted).toBe(false);
  await f.host.teardown("viewer", "task", f.document.viewId);
  expect(f.messageGuard()?.signal.aborted).toBe(true);
  await expect(f.messageGuard()!()).rejects.toThrow();
  await captured.assertCurrent();
  captured.consume();
  expect((await f.host.modelContext("task")).text).toBe("");
});

it("rejects cross-caller, cross-task and revoked View requests before asking permission", async () => {
  const f = await fixture();
  await expect(f.host.dispatch("other-viewer", "task", f.document.viewId, { jsonrpc: "2.0", method: "ping", id: 1 })).rejects.toThrow("MCP_APP_VIEW_UNAVAILABLE");
  await expect(f.host.open("viewer", "other-task", "card", {})).rejects.toThrow("MCP_APP_CARD_UNAVAILABLE");
  f.revoke();
  await expect(f.app.callServerTool({ name: "app_only" })).rejects.toThrow();
  expect(f.authorizeTool).not.toHaveBeenCalled();
  expect(f.called).toEqual([]);
});
