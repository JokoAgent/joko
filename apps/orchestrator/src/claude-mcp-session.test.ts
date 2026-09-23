import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeCodeAdapter,
  CLAUDE_AGENT_SDK_VERSION,
  type ClaudeSdkInitializationResult,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams,
  type ClaudeSdkRuntime,
  type ClaudeSdkSessionInfo
} from "@joko/adapter-claude-code";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { createClaudeMcpBridge } from "./claude-mcp-bridge.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { McpRouter, type BridgeToolCallContext } from "./mcp-router.js";
import { SessionHost } from "./session-host.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("Claude MCP durable Session and Queue", () => {
  it.each(["local", "remote"] as const)("creates an isolated %s Query before Store commit and binds Router tools before queued input", async (location) => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-mcp-session-"));
    const store = new OperationalStore(join(root, "store.db"));
    const artifacts = new ArtifactStore({
      rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root]
    });
    await artifacts.initialize();
    const vault = await CredentialVault.open(join(root, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
    await credentials.initialize();
    const router = new McpRouter({ store, credentials });
    await router.initialize();
    const remote = location === "remote";
    const nativeRoot = remote ? "/srv/project" : root;
    const sdk = new ControlledSdkRuntime(nativeRoot);
    const calls: BridgeToolCallContext[] = [];
    router.registerBridgeToolProvider({
      id: "approved-tools", generation: 1, available: true,
      tools: [{
        serverId: "approved-tools", name: "echo", description: "Echo a value",
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
    const adapter = new ClaudeCodeAdapter({
      id: "claude-code", instanceGeneration: 1, runtime: remote ? new ControlledSdkRuntime(root) : sdk,
      ...(remote ? { remoteRuntimes: {
        resolve: async () => ({ runtime: sdk, workspaceRoot: nativeRoot, remote: true, assertCurrent: () => undefined }),
        close: async () => undefined
      } } : {}),
      initializationTimeoutMs: 1_000, admissionTimeoutMs: 1_000, teardownTimeoutMs: 500,
      mcpBridge: createClaudeMcpBridge({
        router,
        includeToolPolicy: () => true,
        assertSessionCurrent: (sessionId, targetId, generation) => {
          const session = store.getSession(sessionId).descriptor;
          if (session.backendId !== "claude-code" || session.targetId !== targetId
            || session.binding.generation !== generation || session.deletedAt !== undefined) {
            throw new Error("The durable Session changed.");
          }
        }
      })
    });
    const descriptor = await adapter.describe();
    const host = new SessionHost(store, artifacts, [adapter], { backendDescriptors: [descriptor] });
    cleanups.push(async () => {
      await host.dispose().catch(() => undefined);
      await adapter.dispose().catch(() => undefined);
      await router.dispose();
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    await host.initialize();
    const targetId = remote ? "target-remote" : "target-local";
    await host.registerTarget({
      id: targetId, backendId: "claude-code", displayName: location, workspaceRoot: root,
      managed: !remote, trusted: true,
      ...(remote ? { remoteWorkspace: { hostTargetId: targetId, hostId: "host-a", workspaceRoot: nativeRoot } } : {})
    });
    const connection = store.createConnection({ id: "connection-local", name: "Local", authKeyDigest: "digest" });
    const create = await host.createSession({
      operationId: "create-claude-mcp", connection, targetId, title: "Authorized tools",
      providerId: "claude-code", modelId: "model-a", fastMode: false, permissionMode: "ask", planMode: false
    });
    const sessionId = create.value.sessionId;
    expect(sdk.queries).toHaveLength(1);
    expect(sdk.queries[0]!.params.options).toMatchObject({ strictMcpConfig: true, mcpServers: {} });
    expect(sdk.queries[0]!.params.options.mcpTools).toBeUndefined();
    expect(store.getSession(sessionId).descriptor.binding.nativeSessionId).toBeDefined();
    const queued = host.enqueueInput({
      operationId: "send-claude-mcp", connection, sessionId,
      prompt: { text: "Call the approved tool", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => sdk.queries.length === 2 && sdk.queries[1]!.received.length === 1);
    expect(sdk.retired).toEqual([sdk.queries[0]]);
    const query = sdk.queries[1]!;
    expect(query.params.options.resume).toBe(store.getSession(sessionId).descriptor.binding.nativeSessionId);
    expect(query.params.options.mcpTools).toMatchObject([{
      serverId: "approved-tools", name: "echo", outputSchema: { type: "object" }
    }]);
    const toolUseId = "queued-root-tool";
    const toolName = `mcp__joko_${createHash("sha256").update("approved-tools").digest("hex").slice(0, 24)}__echo`;
    query.push({
      type: "assistant", session_id: query.nativeSessionId, parent_tool_use_id: null, uuid: randomUUID(),
      message: { id: randomUUID(), role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: toolName, input: { value: "durable" } }] }
    });
    await eventually(() => store.listEvents({ sessionId, limit: 100 }).some((event) => event.payload.type === "tool_start"));
    const tool = query.params.options.mcpTools![0]!;
    expect(await tool.call({ value: "durable" }, { toolUseId, signal: new AbortController().signal }))
      .toMatchObject({ content: [{ type: "text", text: "durable" }], structuredContent: { echoed: "durable" } });
    expect(calls).toMatchObject([{ sessionId, targetId, generation: 1 }]);
    query.push({
      type: "result", subtype: "success", session_id: query.nativeSessionId, uuid: randomUUID(),
      origin: { kind: "human" }, user_message_uuid: query.received[0]!.uuid,
      result: "Done", is_error: false, duration_ms: 10, duration_api_ms: 10, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, queued_turn_count: 0
    });
    await eventually(() => store.getRun(queued.value.runId).descriptor.state === "completed");
    await expect(tool.call({ value: "late" }, { toolUseId, signal: new AbortController().signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

class Output implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly #queued: unknown[] = [];
  readonly #readers: Array<(value: IteratorResult<unknown>) => void> = [];
  #closed = false;
  push(value: unknown): void {
    const reader = this.#readers.shift();
    if (reader === undefined) this.#queued.push(value);
    else reader({ value, done: false });
  }
  close(): void {
    this.#closed = true;
    for (const reader of this.#readers.splice(0)) reader({ value: undefined, done: true });
  }
  next(): Promise<IteratorResult<unknown>> {
    if (this.#queued.length > 0) return Promise.resolve({ value: this.#queued.shift(), done: false });
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.#readers.push(resolve));
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> { return this; }
}

class ControlledQuery implements ClaudeSdkQuery {
  readonly output = new Output();
  readonly received: Array<{ readonly uuid: string }> = [];
  readonly nativeSessionId: string;
  constructor(readonly params: ClaudeSdkQueryParams, readonly cwd: string, readonly init: ClaudeSdkInitializationResult) {
    this.nativeSessionId = params.options.resume ?? params.options.sessionId!;
    void this.consume();
  }
  async consume(): Promise<void> {
    for await (const message of this.params.prompt) {
      this.received.push(message);
      this.push({
        type: "system", subtype: "init", session_id: this.nativeSessionId, uuid: randomUUID(),
        claude_code_version: "2.1.259", apiKeySource: "none", cwd: this.cwd, model: "model-a",
        permissionMode: "default", tools: ["Read"], capabilities: ["interrupt_receipt_v1"]
      });
      this.push({ ...message, isReplay: true, session_id: this.nativeSessionId });
    }
  }
  push(value: unknown): void { this.output.push(value); }
  [Symbol.asyncIterator](): AsyncIterator<unknown> { return this.output; }
  interrupt() { return Promise.resolve({ still_queued: [] }); }
  stopTask() { return Promise.resolve(); }
  setPermissionMode() { return Promise.resolve(); }
  setModel() { return Promise.resolve(); }
  applyFlagSettings() { return Promise.resolve(); }
  initializationResult() { return Promise.resolve(this.init); }
  supportedModels() { return Promise.resolve(this.init.models); }
  accountInfo() { return Promise.resolve(this.init.account); }
  close(): void { this.output.close(); }
}

class ControlledSdkRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly bundledCliVersion = "2.1.259";
  readonly queries: ControlledQuery[] = [];
  readonly retired: ClaudeSdkQuery[] = [];
  readonly sessions = new Map<string, ClaudeSdkSessionInfo>();
  readonly init: ClaudeSdkInitializationResult = {
    models: [{ value: "model-a", displayName: "Model A", description: "Controlled", supportsFastMode: false }],
    account: { email: "fixture@example.test" }
  };
  constructor(readonly cwd: string) {}
  probe() { return Promise.resolve({ installed: true, packageVersion: this.packageVersion, initialization: this.init, cliVersion: this.bundledCliVersion, apiKeySource: "none" }); }
  query(params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery> {
    const id = params.options.resume ?? params.options.sessionId!;
    if (params.options.sessionId !== undefined) this.sessions.set(id, { sessionId: id, summary: "Controlled", lastModified: Date.now(), cwd: this.cwd });
    const query = new ControlledQuery(params, this.cwd, this.init);
    this.queries.push(query);
    return Promise.resolve(query);
  }
  retireQuery(query: ClaudeSdkQuery) { this.retired.push(query); return Promise.resolve(); }
  getSessionInfo(id: string) { return Promise.resolve(this.sessions.get(id)); }
  getSessionMessages() { return Promise.resolve([]); }
  listSessions() { return Promise.resolve([...this.sessions.values()]); }
  deleteSession(id: string) { this.sessions.delete(id); return Promise.resolve(); }
  forkSession() { return Promise.reject(new Error("Unexpected native fork.")); }
  ownsSessionFork() { return false; }
  closeSessionOperations() { return Promise.resolve(); }
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("The controlled product chain did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
