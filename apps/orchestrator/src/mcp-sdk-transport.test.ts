import { createServer, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { SdkMcpClientFactory, type McpClientConnection } from "./mcp-router.js";

type FixtureMode = "ready" | "redirectGet" | "redirectPost" | "foreignEndpoint" | "credentialEndpoint" | "missingEndpoint";

async function fixture(mode: FixtureMode) {
  const requests: Array<{ method: string; path: string; authorization?: string }> = [];
  const responses = new Set<ServerResponse>();
  const protocol = new McpServer({ name: "fixture-tools", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
  protocol.setRequestHandler(CallToolRequestSchema, async (request) => ({ content: [{ type: "text", text: String(request.params.arguments?.value) }] }));
  protocol.setRequestHandler(ReadResourceRequestSchema, async (request) => ({ contents: [{ uri: request.params.uri, mimeType: "audio/wav", blob: "UklGRg==" }] }));
  let transport: SSEServerTransport | undefined;
  const http = createServer((request, response) => {
    requests.push({ method: request.method ?? "", path: request.url ?? "", ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }) });
    responses.add(response);
    response.on("close", () => responses.delete(response));
    if (request.method === "GET" && request.url === "/events") {
      if (mode === "redirectGet") { response.writeHead(302, { location: "/forbidden" }); response.end(); return; }
      if (mode === "missingEndpoint") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": waiting\n\n"); return; }
      const post = mode === "foreignEndpoint" ? "http://127.0.0.1:1/messages"
        : mode === "credentialEndpoint" ? `http://user:password@${request.headers.host}/messages` : "/messages";
      if (mode === "foreignEndpoint" || mode === "credentialEndpoint") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`event: endpoint\ndata: ${post}\n\n`);
        return;
      }
      transport = new SSEServerTransport(post, response);
      void protocol.connect(transport).catch(() => response.end());
    } else if (request.method === "POST" && request.url?.startsWith("/messages") === true) {
      if (mode === "redirectPost") { response.writeHead(302, { location: "/forbidden" }); response.end(); return; }
      void transport!.handlePostMessage(request, response).catch(() => response.end());
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("Fixture address is unavailable.");
  const connect = () => new SdkMcpClientFactory(mode === "missingEndpoint" ? 100 : 2_000).connect({
    config: {
      id: "fixture", displayName: "Fixture", enabled: true, transport: "sse", endpoint: `http://127.0.0.1:${address.port}/events`,
      credentialBindings: [{ target: "header", name: "Authorization", credentialReferenceId: "fixture-credential" }]
    },
    credentials: { "header:Authorization": "Bearer fixture-secret" }, generation: 1, onClose: vi.fn(), onError: vi.fn()
  });
  return {
    requests, connect,
    async dispose() {
      await protocol.close();
      for (const response of responses) response.end();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  };
}

it("connects the explicit SSE transport, authenticates GET and POST, discovers and calls tools", async () => {
  const server = await fixture("ready");
  let connection: McpClientConnection | undefined;
  try {
    connection = await server.connect();
    expect(await connection.listTools()).toMatchObject({ tools: [{ name: "echo" }] });
    expect(await connection.callTool("echo", { value: "local result" })).toMatchObject({ content: [{ type: "text", text: "local result" }], isError: false });
    const uri = "https://media.example.test/track?signature=ephemeral";
    expect(await connection.readResource(uri, new AbortController().signal)).toMatchObject({ contents: [{ uri, mimeType: "audio/wav", blob: "UklGRg==" }] });
    expect(server.requests[0]).toEqual({ method: "GET", path: "/events", authorization: "Bearer fixture-secret" });
    expect(server.requests.filter((request) => request.method === "POST").length).toBeGreaterThanOrEqual(3);
    expect(server.requests.every((request) => request.authorization === "Bearer fixture-secret")).toBe(true);
  } finally { await connection?.close(); await server.dispose(); }
});

it.each(["redirectGet", "redirectPost", "foreignEndpoint", "credentialEndpoint", "missingEndpoint"] as const)("closes a failed %s SSE handshake without retrying another transport or destination", async (mode) => {
  const server = await fixture(mode);
  try {
    await expect(server.connect()).rejects.toThrow();
    expect(server.requests.filter((request) => request.method === "GET")).toHaveLength(1);
    expect(server.requests.some((request) => request.path === "/forbidden")).toBe(false);
    if (mode === "foreignEndpoint" || mode === "credentialEndpoint" || mode === "missingEndpoint") {
      expect(server.requests.some((request) => request.method === "POST")).toBe(false);
    }
  } finally { await server.dispose(); }
});
