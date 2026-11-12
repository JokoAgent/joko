import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as claude from "@joko/adapter-claude-code";
import * as codex from "@joko/adapter-codex";
import { FakeCodexAppServer, type ScriptedRpcTransport } from "@joko/adapter-codex/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorApplication } from "./application.js";
import type { OrchestratorConfig } from "./config.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type NativeBackend = "codex" | "claude-code";
interface NativePromptRequest {
  readonly kind: "start" | "resume";
  readonly nativeId?: string;
  readonly prompt?: string;
}

describe("Application ordinary native Maker Memory", () => {
  it.each(["codex", "claude-code"] as const)("injects %s startup and current same-task snapshots without persisting or duplicating them", async backendId => {
    const f = await fixture(backendId), { application } = f, memory = application.makerMemory!;
    const originalPrompt = "Owner instructions remain unchanged.";
    const created = await f.create("empty-index", originalPrompt);
    const sessionId = created.value.sessionId, original = application.store.getSession(sessionId).descriptor.binding;
    expect(f.last()).toMatchObject({ kind: "start" });
    expect(f.last().prompt).toContain(originalPrompt);
    expect(f.last().prompt?.match(/# Maker Memory/gu)).toHaveLength(1);
    expect(f.last().prompt).toContain("## Current index");
    const initialRequests = f.requests().length;
    await application.sessionHost.getCommands(sessionId);
    expect(f.requests()).toHaveLength(initialRequests);
    expect(application.store.getSession(sessionId).descriptor.binding).toEqual(original);

    const entry = memory.write(f.targetId, { kind: "project", name: "report-style", title: "Report style",
      description: "Original local index marker", body: "Private body is read on demand." });
    const other = memory.write(f.foreignTargetId, { kind: "user", name: "foreign-style", title: "Foreign marker",
      description: "Another Target must remain isolated", body: "Foreign body." });
    expect(memory.writeCompactionDigest({ backendId, targetId: f.targetId, sessionId, reason: "auto", summary: "Search-only digest marker" })).toBe(true);

    // An idle activation observes the new index and uses the existing native
    // binding through the Host's ordinary prompt refresh boundary.
    await application.sessionHost.resume(sessionId);
    expect(f.last()).toMatchObject({ kind: "resume", nativeId: original.nativeSessionId });
    expect(f.last().prompt?.match(/# Maker Memory/gu)).toHaveLength(1);
    expect(f.last().prompt).toContain(`(id: ${entry.id})`);
    expect(f.last().prompt).not.toContain(entry.body);
    expect(f.last().prompt).not.toContain(other.id);
    expect(f.last().prompt).not.toContain("Search-only digest marker");

    const second = await f.create("populated-index", originalPrompt);
    expect(f.last()).toMatchObject({ kind: "start" });
    expect(f.last().prompt).toContain(entry.description);
    const beforeReplay = f.requests().length;
    expect((await f.create("populated-index", originalPrompt)).replayed).toBe(true);
    expect(f.requests()).toHaveLength(beforeReplay);
    const next = memory.write(f.targetId, { kind: "project", name: entry.slug, title: entry.title,
      description: "Current local index marker", body: entry.body, mode: "update" });
    await application.sessionHost.close(sessionId);
    await application.sessionHost.resume(sessionId);
    expect(f.last()).toMatchObject({ kind: "resume", nativeId: original.nativeSessionId });
    expect(f.last().prompt).toContain(next.description);
    expect(f.last().prompt).not.toContain(entry.description);
    for (const id of [sessionId, second.value.sessionId]) {
      expect(application.store.getSession(id).descriptor.appendSystemPrompt).toBe(originalPrompt);
    }
    expect(JSON.stringify(application.store.getOperation("populated-index").body)).not.toContain(entry.description);

    const disabled = application.partnerMemoryPreferences!.update(f.targetId, undefined, { enabled: false });
    await application.sessionHost.restart(sessionId);
    expect(f.last()).toMatchObject({ kind: "resume", nativeId: original.nativeSessionId });
    expect(f.last().prompt).toContain(originalPrompt);
    expect(f.last().prompt).not.toContain("# Maker Memory");
    await f.create("target-memory-disabled", originalPrompt);
    expect(f.last().prompt).not.toContain("# Maker Memory");
    application.partnerMemoryPreferences!.update(f.targetId, disabled.revision, { enabled: true });

    await memory.update({ makerEnabled: false });
    await application.sessionHost.restart(sessionId);
    expect(f.last()).toMatchObject({ kind: "resume", nativeId: original.nativeSessionId });
    expect(f.last().prompt).not.toContain("# Maker Memory");
    await f.create("shared-memory-disabled", originalPrompt);
    expect(f.last().prompt).not.toContain("# Maker Memory");

    // The ordinary setting must not replace the Partner's independent owner.
    const model = application.store.getBackend(backendId).descriptor.models.find(candidate =>
      candidate.providerId === f.providerId && candidate.modelId === f.modelId)!;
    const effort = model.defaultEffort ?? model.thinkingLevels[0];
    const partner = await application.partners!.createPartner({ requestId: "independent-partner",
      expectedDirectoryRevision: application.partners!.directory().state.revision,
      displayName: "Independent memory", avatar: "orbit", templateId: "general", identitySource: "Private partner identity.",
      usesDirectoryDefaults: false, capabilities: { modelChain: [{ backendId, providerId: f.providerId, modelId: f.modelId, fastMode: false,
        ...(effort === undefined ? {} : { effort }) }],
        permissionMode: "ask", planMode: false } });
    expect(partner.initializationState).toBe("ready");
    const partnerMemory = memory.write(partner.homeTargetId, { kind: "user", name: "partner-style", title: "Partner memory",
      description: "Independent private index marker", body: "Private Partner body." });
    await application.sessionHost.resume(partner.canonicalSessionId!);
    expect(f.last().prompt?.match(/# Maker Memory/gu)).toHaveLength(1);
    expect(f.last().prompt).toContain(partnerMemory.id);
    expect(f.last().prompt).not.toContain(entry.id);
    expect(f.last().prompt).not.toContain(other.id);
  }, 60_000);

  it.each(["codex", "claude-code"] as const)("fails %s creation before native effects when its scoped snapshot cannot be read", async backendId => {
    const f = await fixture(backendId), { application } = f;
    application.store.setSetting("target", f.targetId, "partner-memory.preferences", { format: 1, enabled: "invalid" });
    const before = f.requests().length;
    await expect(f.create("invalid-memory-owner")).rejects.toThrow();
    expect(f.requests()).toHaveLength(before);
    expect(application.store.getOperation("invalid-memory-owner").status).toBe("failed");
    application.store.deleteSetting("target", f.targetId, "partner-memory.preferences");
    await expect(f.create("invalid-memory-owner")).rejects.toThrow();
    expect(f.requests()).toHaveLength(before);
    await f.create("healthy-memory-owner");
    expect(f.last().prompt?.match(/# Maker Memory/gu)).toHaveLength(1);
  }, 60_000);

  it.each(["codex", "claude-code"] as const)("prepares the original Pi Target's memory for the first %s handoff and preserves the source on failure", async backendId => {
    const f = await fixture(backendId), { application } = f;
    const source = await f.createPi("pi-memory-handoff");
    const original = application.store.getSession(source).descriptor;
    const entry = application.makerMemory!.write(original.targetId, { kind: "project", name: "handoff-memory", title: "Handoff memory",
      description: "Original Target index for the new Backend", body: "The private body stays in the original Target." });
    application.makerMemory!.write(f.targetId, { kind: "project", name: "other-target", title: "Other Target marker",
      description: "Do not read the Backend default Target", body: "Unrelated Target." });
    await application.sessionHost.setSessionRuntimeControl({ sessionId: source,
      expectedGeneration: application.sessionHost.getSessionRuntimeControl(source).generation,
      patch: { backendId, providerId: f.providerId, modelId: f.modelId, fastMode: false } });
    application.store.setSetting("target", original.targetId, "partner-memory.preferences", { format: 1, enabled: "invalid" });
    const before = f.requests().length;
    const queued = application.sessionHost.enqueueInput({ operationId: "handoff-memory-input", sessionId: source, connection: f.connection,
      prompt: { text: "Continue the original task", disposition: "prompt", images: [], files: [], mentions: [] } }).value;
    const failures = () => application.store.listEvents({ sessionId: source }).filter(event =>
      event.payload.type === "error" && event.payload.error.code === "RUNTIME_HANDOFF_BLOCKED").length;
    await vi.waitFor(() => expect(failures()).toBe(1));
    expect(f.requests()).toHaveLength(before);
    expect(application.store.getSession(source).descriptor).toMatchObject({ backendId: "pi", binding: original.binding, targetId: original.targetId });
    expect(application.store.getQueueItem(queued.queueItemId).state).toBe("accepted");

    application.store.deleteSetting("target", original.targetId, "partner-memory.preferences");
    const adopt = application.store.adoptSessionRuntimeHandoff.bind(application.store);
    let failAdoption = true;
    vi.spyOn(application.store, "adoptSessionRuntimeHandoff").mockImplementation((...args) => {
      if (failAdoption) { failAdoption = false; throw new Error("Controlled pre-adoption failure."); }
      const result = adopt(...args);
      // This assertion stops at the actual native startup/adoption boundary;
      // no model turn is needed to inspect the prepared target instructions.
      application.store.setQueuePaused({ sessionId: source, paused: true, traceId: "inspect-prepared-memory" });
      return result;
    });
    application.sessionHost.requestQueueDrain(source);
    await vi.waitFor(() => expect(failures()).toBe(2));
    const targetStartup = f.requests().slice(before).find(request => request.kind === "start")!;
    expect(targetStartup.prompt).toContain(entry.description);
    expect(targetStartup.prompt?.match(/# Maker Memory/gu)).toHaveLength(1);
    expect(targetStartup.prompt).not.toContain("Do not read the Backend default Target");
    expect(application.store.getSession(source).descriptor).toMatchObject({ backendId: "pi", binding: original.binding });
    const preparedCount = f.requests().length;
    application.sessionHost.requestQueueDrain(source);
    await vi.waitFor(() => expect(application.store.getSession(source).descriptor.backendId).toBe(backendId));
    expect(f.requests()).toHaveLength(preparedCount);
    expect(application.store.getSession(source).descriptor).toMatchObject({ id: source, targetId: original.targetId,
      appendSystemPrompt: "Original Pi owner instructions." });
    expect(application.store.getQueueItem(queued.queueItemId).state).toBe("accepted");
  }, 60_000);
});

async function fixture(backendId: NativeBackend) {
  const root = await mkdtemp(join(tmpdir(), "joko-application-maker-memory-"));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const workspace = join(root, "workspace"), dataDirectory = join(root, "data"), codexProfile = join(root, "codex"), claudeProfile = join(root, "claude");
  await Promise.all([mkdir(workspace), mkdir(codexProfile), mkdir(claudeProfile)]);
  vi.stubEnv("CODEX_HOME", codexProfile);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeProfile);
  const fake = new FakeCodexAppServer(), transports: ScriptedRpcTransport[] = [];
  vi.spyOn(codex, "createCodexAdapter").mockImplementation(options => new codex.CodexBackendAdapter({
    ...options, profileDirectory: codexProfile,
    nativeExecution: { openExecServer: async () => ({ execServerUrl: "ws://127.0.0.1:43123/ws/exec-server",
      authBearerToken: "x".repeat(43), assertCurrent: () => undefined, close: async () => undefined }) },
    appServer: { ...options.appServer, transportFactory: () => { const transport = fake.createTransport(); transports.push(transport); return transport; } }
  }));
  const sdk = new PromptSdkRuntime();
  let credentialPort: claude.ClaudeCodeCredentialPort | undefined;
  vi.spyOn(claude, "createClaudeCodeAdapter").mockImplementation(options => {
    credentialPort = options.credentialPort;
    return new claude.ClaudeCodeAdapter({ ...options, runtime: sdk, initializationTimeoutMs: 1_000, teardownTimeoutMs: 500 });
  });
  const config: OrchestratorConfig = {
    host: "127.0.0.1", port: 0, internalPort: 4327,
    publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4327",
    dataDirectory, databasePath: join(dataDirectory, "orchestrator.db"),
    allowInsecureLoopback: true, allowInsecureLan: false, lanDiscoveryEnabled: false, voiceDictionaryLanDiscoveryEnabled: false,
    codexExecutable: join(root, "missing-codex"), piAgentHome: join(dataDirectory, "pi"),
    workspace: { id: "maker-memory-workspace", root: workspace, displayName: "Maker memory", trusted: true },
    artifactDirectory: join(dataDirectory, "artifacts"), webDirectory: join(root, "no-web-build"), corsOrigins: []
  };
  const application = await createOrchestratorApplication(config);
  cleanups.push(() => application.close());
  if (backendId === "claude-code") {
    const expiresAt = Date.now() + 60 * 60_000;
    expect(await credentialPort!.compareAndSet({
      expected: undefined,
      value: JSON.stringify({ format: 1, type: "oauth", accessToken: "fixture-access", refreshToken: "fixture-refresh",
        expiresAt, scopes: ["user:inference"], subscriptionType: null, rateLimitTier: null }),
      expiresAt
    })).toBe(true);
    await application.refreshBackendDescriptor(backendId);
  }
  const challenge = application.connections.issuePairing("Maker memory owner");
  const paired = application.connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Maker memory owner" });
  const targetId = `${config.workspace.id}:${backendId}`;
  const providerId = backendId === "codex" ? "openai" : "claude-code", modelId = backendId === "codex" ? "gpt-test" : "model-a";
  const requests = (): NativePromptRequest[] => backendId === "claude-code"
    ? sdk.queries.map<NativePromptRequest>(query => ({ kind: query.params.options.resume === undefined ? "start" : "resume",
        nativeId: query.params.options.resume ?? query.params.options.sessionId, prompt: query.params.options.systemPrompt.append }))
    : transports.flatMap(transport => transport.requests.flatMap(request => {
        if (request.method !== "thread/start" && request.method !== "thread/resume") return [];
        const params = request.params as { readonly threadId?: string; readonly developerInstructions?: string; readonly approvalPolicy?: string };
        // Host reapplies permissions on the loaded thread after attaching it.
        if (request.method === "thread/resume" && params.approvalPolicy !== undefined) return [];
        return [{ kind: request.method === "thread/start" ? "start" as const : "resume" as const,
          nativeId: params.threadId, prompt: params.developerInstructions }];
      }));
  return { application, targetId, providerId, modelId, requests, connection: paired.connection, last: () => requests().at(-1)!,
    foreignTargetId: `${config.workspace.id}:${backendId === "codex" ? "claude-code" : "codex"}`,
    createPi: async (operationId: string) => {
      const providerId = "pi-memory-fixture", modelId = "memory-test";
      await application.providers!.upsert({ backendId: "pi", credentialOrigin: "http://127.0.0.1:1", displayName: "Pi memory fixture",
        enabled: true, kind: "local_keyless", credentialBindings: {}, supportsLogin: false, supportsLogout: false, supportsRefresh: false,
        provider: { id: providerId, baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", keyless: true,
          models: [{ id: modelId, contextWindow: 32_000, maxTokens: 4_000, input: ["text"] }] } });
      await application.refreshPiGeneration?.();
      const { sessionId } = (await application.sessionHost.createSession({ operationId, connection: paired.connection,
        targetId: config.workspace.id, title: operationId, providerId, modelId, permissionMode: "ask", fastMode: false, planMode: false,
        appendSystemPrompt: "Original Pi owner instructions." })).value;
      const binding = application.store.getSession(sessionId).descriptor.binding;
      await writeFile(binding.opaqueRef, `${JSON.stringify({ type: "session", version: 3, id: binding.nativeSessionId,
        timestamp: new Date().toISOString(), cwd: workspace })}\n`);
      return sessionId;
    },
    create: (operationId: string, appendSystemPrompt?: string) => application.sessionHost.createSession({ operationId,
      connection: paired.connection, targetId, title: operationId, providerId, modelId, permissionMode: "ask", fastMode: false, planMode: false,
      ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }) }) };
}

class PromptQuery implements claude.ClaudeSdkQuery {
  readonly #readers: Array<(value: IteratorResult<unknown>) => void> = [];
  #closed = false;
  constructor(readonly params: claude.ClaudeSdkQueryParams, readonly init: claude.ClaudeSdkInitializationResult) {}
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return { next: () => this.#closed ? Promise.resolve({ value: undefined, done: true })
      : new Promise(resolve => this.#readers.push(resolve)) };
  }
  interrupt() { return Promise.resolve({ still_queued: [] }); }
  stopTask() { return Promise.resolve(); }
  setPermissionMode() { return Promise.resolve(); }
  setModel() { return Promise.resolve(); }
  applyFlagSettings() { return Promise.resolve(); }
  initializationResult() { return Promise.resolve(this.init); }
  supportedModels() { return Promise.resolve(this.init.models); }
  accountInfo() { return Promise.resolve(this.init.account); }
  close(): void { this.#closed = true; for (const resolve of this.#readers.splice(0)) resolve({ value: undefined, done: true }); }
}

class PromptSdkRuntime implements claude.ClaudeSdkRuntime {
  readonly packageVersion = claude.CLAUDE_AGENT_SDK_VERSION;
  readonly bundledCliVersion = claude.CLAUDE_AGENT_SDK_CLI_VERSION;
  readonly queries: PromptQuery[] = [];
  readonly sessions = new Map<string, claude.ClaudeSdkSessionInfo>();
  readonly init: claude.ClaudeSdkInitializationResult = {
    models: [{ value: "model-a", displayName: "Model A", description: "Controlled", supportsFastMode: false }],
    account: { email: "fixture@example.test" }
  };
  probe() { return Promise.resolve({ installed: true, packageVersion: this.packageVersion, initialization: this.init,
    cliVersion: this.bundledCliVersion, apiKeySource: "none" }); }
  query(params: claude.ClaudeSdkQueryParams): Promise<claude.ClaudeSdkQuery> {
    const id = params.options.resume ?? params.options.sessionId!;
    if (params.options.sessionId !== undefined) this.sessions.set(id, { sessionId: id, summary: "Controlled", lastModified: Date.now(), cwd: params.options.cwd });
    const query = new PromptQuery(params, this.init); this.queries.push(query); return Promise.resolve(query);
  }
  retireQuery() { return Promise.resolve(); }
  getSessionInfo(id: string) { return Promise.resolve(this.sessions.get(id)); }
  getSessionMessages() { return Promise.resolve([]); }
  listSessions() { return Promise.resolve([...this.sessions.values()]); }
  deleteSession(id: string) { this.sessions.delete(id); return Promise.resolve(); }
  forkSession() { return Promise.reject(new Error("Unexpected native fork.")); }
  ownsSessionFork() { return false; }
  closeSessionOperations() { return Promise.resolve(); }
}
