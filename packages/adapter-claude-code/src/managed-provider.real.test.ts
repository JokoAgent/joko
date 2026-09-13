import { mkdtemp, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, EventPayload, ManagedProviderRuntimePort, ManagedProviderRouteBinding, ProviderModel, TargetDescriptor } from "@joko/core";
import { expect, test, vi } from "vitest";
import { ClaudeCodeAdapter } from "./adapter.js";

const enabled = process.env["JOKO_CLAUDE_LOCAL_GATEWAY_PROBE"] === "1";

test.skipIf(!enabled)("uses the fixed SDK against a local gateway and scrubs the proxy credential from native tool children", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-claude-local-gateway-"));
  const workspaceRoot = join(directory, "workspace");
  const configDirectory = join(directory, "profile");
  await mkdir(workspaceRoot);
  await mkdir(configDirectory);
  const token = "local-gateway-fixture-credential";
  const model: ProviderModel = { providerId: "local-gateway", modelId: "joko-local-model", displayName: "Local model",
    api: "anthropic-messages", contextWindow: 64_000, maxOutputTokens: 4_000, supportsImages: false, thinkingLevels: ["high"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const requests: { path: string; model: unknown; authenticated: boolean; messages: unknown; outputConfig: unknown; hasBashTool: boolean }[] = [];
  const failures: string[] = [];
  const deniedPaths: string[] = [];
  let currentOperation: Parameters<ManagedProviderRouteBinding["activate"]>[0] | undefined;
  let disposed = false;
  let released = false;
  const server = createServer((request, response) => {
    void (async () => {
      if (!["/v1/messages", "/v1/messages/count_tokens"].includes(request.url?.split("?")[0] ?? "")) {
        deniedPaths.push(request.url ?? "");
        response.writeHead(404);
        response.end();
        return;
      }
      if (currentOperation === undefined || disposed || released) throw new Error(`No active request lease for ${request.url}: active=${currentOperation !== undefined}, disposed=${disposed}, released=${released}.`);
      currentOperation.assertCurrent();
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2_000_000) throw new Error("Local fixture body exceeded its bound.");
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown; messages?: unknown; output_config?: unknown; tools?: { name?: string }[] };
      const authenticated = request.headers["x-api-key"] === token;
      requests.push({ path: request.url ?? "", model: body.model, authenticated, messages: body.messages, outputConfig: body.output_config,
        hasBashTool: body.tools?.some((tool) => tool.name === "Bash") === true });
      if (!authenticated || body.model !== model.modelId) throw new Error("Unexpected local route identity.");
      if (request.url?.split("?")[0] === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (request.url?.split("?")[0] !== "/v1/messages") throw new Error("Unexpected local request path.");
      const hasToolResult = JSON.stringify(body.messages).includes("tool_result");
      sendMessage(response, model.modelId, hasToolResult);
    })().catch((error: unknown) => {
      failures.push(error instanceof Error ? error.message : "Local fixture rejected a request.");
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Local fixture rejected the request." } }));
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The local gateway did not bind.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const port: ManagedProviderRuntimePort = {
    support: { protocols: ["anthropic-messages"], fields: ["headers"] },
    environment: { JOKO_MODEL_PROXY_TOKEN: token }, secretEnvironmentNames: ["JOKO_MODEL_PROXY_TOKEN"],
    dispose: () => { disposed = true; },
    hasProvider: (providerId) => providerId === model.providerId,
    listModels: () => [model], listProviders: () => [],
    getThinkingLevelMap: () => ({ high: "xhigh" }),
    prepare: async (owner) => {
      expect(owner).toMatchObject({ providerId: model.providerId, modelId: model.modelId });
      const assertCurrent = () => { if (disposed) throw new Error("The local route has retired."); };
      return { providerId: model.providerId, model, thinkingLevelMap: { high: "xhigh" }, protocol: "anthropic-messages", revision: "local-one", baseUrl,
        apiKeyEnvironment: "JOKO_MODEL_PROXY_TOKEN", assertCurrent,
        activate: async (operation) => { assertCurrent(); operation.assertCurrent(); currentOperation = operation; return { release: () => { released = true; } }; },
        dispose: () => { disposed = true; }
      };
    }
  };
  const adapter = new ClaudeCodeAdapter({ instanceGeneration: 1, managedProviders: port,
    initializationTimeoutMs: 30_000, admissionTimeoutMs: 10_000, teardownTimeoutMs: 3_000,
    environment: { CLAUDE_CONFIG_DIR: configDirectory }, probeCwd: workspaceRoot });
  const target: TargetDescriptor = { id: "local-gateway-target", backendId: adapter.id, displayName: "Local gateway fixture",
    workspaceRoot, managed: false, trusted: true };
  const events: EventPayload[] = [];
  const cancellation = new AbortController();
  const context: AdapterContext = { sessionId: "local-gateway-session", generation: 1, backendInstanceGeneration: 1,
    target, signal: cancellation.signal, modelSelection: { providerId: model.providerId, modelId: model.modelId },
    emit: async (event) => { events.push(event); }, requestInteraction: async () => ({ kind: "selected", value: "allow_for_session" }),
    artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No artifact is expected."); } };
  try {
    const binding = await adapter.createSession({ target, providerId: model.providerId, modelId: model.modelId,
      effort: "high", fastMode: false, permissionMode: "ask", nativeStart: { kind: "new" } }, context);
    expect(requests).toEqual([]);
    await adapter.send({ text: "Run the supplied local environment check, then finish.", images: [], files: [], mentions: [], disposition: "prompt" },
      { ...context, binding, operationId: "local-gateway-turn" });
    await vi.waitFor(() => expect(events.some((event) => event.type === "done")).toBe(true), { timeout: 30_000, interval: 25 });
    expect(events.at(-1), JSON.stringify(events.filter((event) => event.type === "error"))).toEqual({ type: "done", outcome: "completed" });
    expect(failures).toEqual([]);
    expect(requests.filter((request) => request.path.split("?")[0] === "/v1/messages").length).toBeGreaterThanOrEqual(2);
    const messages = requests.flatMap((request) => request.messages as { content: { type: string; content?: unknown; is_error?: boolean }[] | string }[]);
    const toolResults = messages.flatMap((message) => typeof message.content === "string" ? [] : message.content)
      .filter((block) => block.type === "tool_result");
    expect(toolResults.some((block) => block.is_error !== true && JSON.stringify(block.content).includes("joko-tool-environment-scrubbed")), JSON.stringify(toolResults)).toBe(true);
    expect(deniedPaths.every((path) => path === "/api/hello")).toBe(true);
    expect(requests.every((request) => request.authenticated && request.model === model.modelId)).toBe(true);
    const turnRequests = requests.filter((request) => request.path.split("?")[0] === "/v1/messages"
      && request.hasBashTool && JSON.stringify(request.messages).includes("Run the supplied local environment check, then finish."));
    expect(turnRequests.length).toBeGreaterThanOrEqual(2);
    expect(turnRequests.every((request) => (request.outputConfig as { effort?: unknown } | undefined)?.effort === "xhigh"),
      JSON.stringify(turnRequests.map((request) => ({ path: request.path, outputConfig: request.outputConfig })))).toBe(true);
    expect(released).toBe(true);
    expect(() => currentOperation!.assertCurrent()).toThrow();
    expect(JSON.stringify(events)).not.toContain(token);
    await adapter.closeSession(binding, { ...context, binding });
    for (const contents of await persistedFiles(directory)) expect(contents.includes(token)).toBe(false);
  } finally {
    cancellation.abort();
    await adapter.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(directory, { recursive: true, force: true });
  }
}, 75_000);

function sendMessage(response: ServerResponse, model: string, hasToolResult: boolean): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type: string, value: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send("message_start", { message: { id: hasToolResult ? "msg_local_done" : "msg_local_tool", type: "message", role: "assistant",
    model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send("content_block_start", { index: 0, content_block: hasToolResult ? { type: "text", text: "" }
    : { type: "tool_use", id: "toolu_local_environment", name: "Bash", input: {} } });
  send("content_block_delta", { index: 0, delta: hasToolResult ? { type: "text_delta", text: "Local check complete." }
    : { type: "input_json_delta", partial_json: JSON.stringify({ command: 'test -z "${ANTHROPIC_API_KEY-}" && test -z "${ANTHROPIC_AUTH_TOKEN-}" && test -z "${JOKO_MODEL_PROXY_TOKEN-}" && printf joko-tool-environment-scrubbed', description: "Check the local tool environment without printing credentials" }) } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: hasToolResult ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", {});
  response.end();
}

async function persistedFiles(directory: string): Promise<Buffer[]> {
  const contents: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...await persistedFiles(path));
    else if (entry.isFile()) contents.push(await readFile(path));
  }
  return contents;
}
