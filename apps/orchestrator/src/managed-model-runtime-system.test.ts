import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { CLAUDE_MANAGED_PROVIDER_SUPPORT } from "@joko/adapter-claude-code";
import { CODEX_MANAGED_PROVIDER_SUPPORT } from "@joko/adapter-codex";
import { createPiAdapter, piProviderModel } from "@joko/adapter-pi";
import * as contract from "@joko/contracts";
import { OLLAMA_LOOPBACK_ORIGIN, OLLAMA_OPENAI_BASE_URL, OllamaLoopbackClient, OllamaRuntimeLauncher, llamaCppModelId,
  type LocalRuntimeStatus, type OllamaModelDetails } from "@joko/local-model-runtime";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import type { AdapterContext, EventPayload, NativeSessionBinding, TargetDescriptor } from "@joko/core";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { createManagedModelRuntimeSystem } from "./managed-model-runtime-system.js";
import { MANAGED_GGUF_PROVIDER_ID } from "./managed-gguf-provider.js";
import { LocalModelProviderCoordinator, MANAGED_LOCAL_PROVIDER_ID } from "./local-model-runtime-coordinator.js";
import { ManagedProviderProxy } from "./managed-provider-proxy.js";
import { ConnectionManager } from "./connection-manager.js";
import { createPublicServer } from "./server.js";
import type { OrchestratorApplication } from "./application.js";
import { SessionHost } from "./session-host.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-gguf-system-")), database = join(root, "node.db");
  const store = new OperationalStore(database);
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "vault.key")), storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "backend-a" }); providers.initialize();
  for (const id of ["backend-a", "backend-b", "backend-c"]) {
    store.upsertBackend(await new FakeBackendAdapter({ ...PI_LIKE_PROFILE, id,
      capabilities: [...PI_LIKE_PROFILE.capabilities, { key: "provider.managed_catalog", supported: true }] }).describe());
  }
  const streaming = vi.fn<typeof fetch>(async () => { throw new Error("This cold inventory journey must not download or start a runtime."); });
  const changed = vi.fn(async () => undefined);
  const system = await createManagedModelRuntimeSystem({ store, providers, dataDirectory: root, ownerId: "node-owner", ownerGeneration: 1,
    claudeBackendId: "backend-b", codexBackendId: "backend-c", fetchStreaming: streaming, onProviderChanged: changed });
  return { root, database, store, credentials, providers, system, streaming, changed };
}
describe("node-owned managed model runtime composition", () => {
  it("serves a stopped disk model through authenticated generated HTTP, saves related context and deletes the connection without its files", async () => {
    const f = await fixture(), selection = { repository: "bartowski/Qwen3.8-Flash-Next-GGUF", file: "Model-Q4.gguf" }, id = llamaCppModelId(selection);
    const bytes = Buffer.from("GGUF"), modelDirectory = join(f.root, "managed-model-runtime", "llama-cpp", "llamacpp-runtime", "models", id);
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(join(modelDirectory, selection.file), bytes);
    await writeFile(join(modelDirectory, "model.json"), JSON.stringify({ format: 1, ...selection, id, revision: "a".repeat(40), sizeBytes: bytes.length,
      shards: [{ name: selection.file, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] }));
    const connections = new ConnectionManager(f.store), challenge = connections.issuePairing("Local model reader");
    const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Local model reader" });
    const artifacts = new ArtifactStore({ rootDirectory: join(f.root, "artifacts"), repository: new OperationalArtifactRepository(f.store), ingestRoots: [f.root] });
    await artifacts.initialize();
    const host = new SessionHost(f.store, artifacts, []); await host.initialize();
    const server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true, allowInsecureLan: false,
      corsOrigins: [], webDirectory: join(f.root, "no-web"), dataDirectory: f.root }, store: f.store, connections, providers: f.providers,
      artifacts: {}, blobTransfers: {}, artifactRepository: {}, workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [],
      sessionHost: host, managedModelRuntime: f.system.registry, removeManagedModelProvider: (providerId: string) => f.system.removeProvider(providerId),
      refreshBackendDescriptor: async () => undefined, refreshPiGeneration: async () => undefined } as unknown as OrchestratorApplication);
    server.log.level = "silent";
    try {
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [next => request => {
        request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request);
      }] });
      const client = createClient(contract.ManagedModelRuntimeService, transport);
      const unconnected = await client.getManagedModelRuntime({ runtimeId: "llama-cpp" });
      expect(unconnected.runtime?.installedModels).toMatchObject([{ modelName: id, repositoryModel: selection }]);
      expect(unconnected.runtime?.providerRoutes).toEqual([]); expect(f.providers.listConfigurations()).toEqual([]);
      const added = await client.ensureManagedModelRuntimeProvider({ runtimeId: "llama-cpp" });
      expect(added.runtime?.providerRoutes).toHaveLength(3);
      expect(added.runtime?.capabilities).toMatchObject({ supportsRepositoryModels: true, canDeleteModels: false,
        startupPolicy: contract.ManagedModelRuntimeStartupPolicy.ON_USE });
      const targets = added.runtime!.providerRoutes.map(route => ({ backendId: route.backendId, providerId: route.providerId, modelId: id, repositoryModel: selection }));
      const saved = await client.setManagedModelContext({ runtimeId: "llama-cpp", target: targets[0], relatedTargets: [targets[1]!], contextWindowTokens: 1_000_000n });
      expect(saved.context).toMatchObject({ effectiveContextWindowTokens: 1_000_000n, pendingApply: false, mixed: false });
      expect(f.providers.listConfigurations()[0]?.runtimes.map(runtime => runtime.provider.models[0]?.contextWindow)).toEqual([1_000_000, 1_000_000, 262144]);
      await expect(createClient(contract.ManagedModelRuntimeService, createConnectTransport({ baseUrl, httpVersion: "1.1" }))
        .getManagedModelRuntime({ runtimeId: "llama-cpp" })).rejects.toMatchObject({ code: Code.Unauthenticated });
      const operations = createClient(contract.OperationService, transport);
      const submitted = await operations.submitOperation({ operationId: "remove-local-model-provider", connectionId: paired.connection.id,
        mutation: { payload: { case: "deleteProvider", value: { providerId: MANAGED_GGUF_PROVIDER_ID } } } });
      await vi.waitFor(async () => expect((await operations.getOperation({ operationId: submitted.operation!.operationId })).operation?.state).toBe(contract.OperationState.SUCCEEDED));
      expect((await client.getManagedModelRuntime({ runtimeId: "llama-cpp" })).runtime?.providerRoutes).toEqual([]);
      expect(f.providers.listConfigurations()).toEqual([]); expect(await readFile(join(modelDirectory, selection.file))).toEqual(bytes);
      expect(f.streaming).not.toHaveBeenCalled();
    } finally { await server.close(); await host.dispose(); await f.system.close(); f.store.close(); }
    const reopenedStore = new OperationalStore(f.database);
    try {
      const reopenedProviders = new ProviderCatalogManager({ store: reopenedStore, credentials: f.credentials, nativeBackendId: "backend-a" }); reopenedProviders.initialize();
      const reopenedSystem = await createManagedModelRuntimeSystem({ store: reopenedStore, providers: reopenedProviders, dataDirectory: f.root,
        ownerId: "node-owner", ownerGeneration: 2, fetchStreaming: f.streaming });
      try {
        const state = await reopenedSystem.registry.get("llama-cpp")!.snapshot();
        expect(state.installedModels.map(model => model.name)).toEqual([id]); expect(state.providerRoutes).toEqual([]);
        expect(reopenedProviders.listConfigurations()).toEqual([]);
      } finally { await reopenedSystem.close(); }
    } finally { reopenedStore.close(); }
  });
  it("skips local on-use startup for remote Workspaces and unrelated Providers, and rejects a removed local connection", async () => {
    const f = await fixture(); try {
      const signal = new AbortController().signal;
      await f.system.prepareProviderRuntime({ signal, target: { backendId: "backend-a", remoteWorkspace: { kind: "ssh" } },
        modelSelection: { providerId: MANAGED_GGUF_PROVIDER_ID, modelId: "missing" } } as unknown as AdapterContext);
      await f.system.prepareProviderRuntime({ signal, target: { backendId: "backend-a" }, modelSelection: { providerId: "ordinary", modelId: "missing" } } as unknown as AdapterContext);
      await expect(f.system.prepareProviderRuntime({ signal, target: { backendId: "backend-a" },
        modelSelection: { providerId: MANAGED_GGUF_PROVIDER_ID, modelId: "missing" } } as unknown as AdapterContext)).rejects.toMatchObject({ code: "RUNTIME_ERROR" });
      expect(f.streaming).not.toHaveBeenCalled(); expect(f.providers.listConfigurations()).toEqual([]);
    } finally { await f.system.close(); f.store.close(); }
  });
  it("starts an installed managed Ollama route once for concurrent task uses and fences changed routes", async () => {
    const f = await fixture();
    const owner = { ownerId: "node-owner", generation: 1 };
    const coordinator = new LocalModelProviderCoordinator({ providers: f.providers, backendId: "backend-a", currentOwner: () => owner });
    const modelId = "fixture:latest";
    await coordinator.sync(owner, [{ id: modelId, displayName: "Fixture model", supportsImages: false, supportsTools: false }]);
    let status: LocalRuntimeStatus = { runtime: "ollama", source: "cli", state: "stopped", capabilities: {
      canInstall: false, canStart: true, canListModels: false, canPullModels: false, canDeleteModels: false, canPausePulls: false
    } };
    const probe = vi.spyOn(OllamaRuntimeLauncher.prototype, "status").mockImplementation(async () => status);
    let beforeLaunch: Promise<void> = Promise.resolve();
    const start = vi.spyOn(OllamaRuntimeLauncher.prototype, "start").mockImplementation(async ({ assertCurrent }) => {
      await beforeLaunch;
      assertCurrent?.();
      status = { ...status, state: "ready" };
      return status;
    });
    const tags = vi.spyOn(OllamaLoopbackClient.prototype, "tags").mockResolvedValue([{ name: modelId }]);
    try {
      const prepare = (target: { backendId: string; remoteWorkspace?: unknown }) => f.system.prepareProviderRuntime({ target,
        signal: new AbortController().signal, modelSelection: { providerId: MANAGED_LOCAL_PROVIDER_ID, modelId } } as AdapterContext);
      await prepare({ backendId: "backend-a", remoteWorkspace: { kind: "ssh" } });
      await expect(prepare({ backendId: "backend-b" })).rejects.toMatchObject({ code: "MODEL_UNAUTHORIZED" });
      expect(start).not.toHaveBeenCalled();
      await Promise.all([prepare({ backendId: "backend-a" }), prepare({ backendId: "backend-a" })]);
      expect(start).toHaveBeenCalledOnce();
      expect(tags).toHaveBeenCalledTimes(2);
      status = { ...status, state: "port_conflict", publicErrorCode: "PORT_CONFLICT" };
      await expect(prepare({ backendId: "backend-a" })).rejects.toMatchObject({ code: "PORT_CONFLICT" });
      expect(start).toHaveBeenCalledOnce();
      status = { ...status, state: "stopped" };
      let release!: () => void;
      beforeLaunch = new Promise<void>(resolve => { release = resolve; });
      const waiting = expect(prepare({ backendId: "backend-a" })).rejects.toMatchObject({ code: "MODEL_UNAUTHORIZED" });
      try {
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
        await coordinator.sync(owner, []);
      } finally { release(); }
      await waiting;
      expect(tags).toHaveBeenCalledTimes(2);
      expect(f.streaming).not.toHaveBeenCalled();
    } finally { tags.mockRestore(); start.mockRestore(); probe.mockRestore(); await f.system.close(); f.store.close(); }
  });

  it("materializes the curated Ollama profiles and sends the saved Pi thinking selection through the published client", async () => {
    const f = await fixture();
    const modelId = "qwen3.8:27b";
    const tags = vi.spyOn(OllamaLoopbackClient.prototype, "tags").mockResolvedValue([
      { name: modelId }, { name: "qwen3.8:27b-mlx" }, { name: "qwen3.8:27b-mxfp8" }, { name: "qwen3.8:latest" }
    ]);
    const show = vi.spyOn(OllamaLoopbackClient.prototype, "show").mockImplementation(async name => ({
      capabilities: ["tools"], ...(name === "qwen3.8:27b-mlx" ? { contextLength: 2_048 } : {})
    }));
    const probe = vi.spyOn(OllamaRuntimeLauncher.prototype, "status").mockResolvedValue({
      runtime: "ollama", source: "running", state: "ready", version: "0.14.0",
      capabilities: { canInstall: false, canStart: true, canListModels: true, canPullModels: true, canDeleteModels: true, canPausePulls: true }
    });
    const received: { path: string; body: Record<string, unknown> }[] = [];
    const modelServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received.push({ path: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const completion = {
        id: `fixture-${received.length}`, model: modelId, object: "chat.completion.chunk", created: 1,
        choices: [{ index: 0, delta: { role: "assistant", content: "Local fixture response." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
      };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`);
    });
    let adapter: ReturnType<typeof createPiAdapter> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        modelServer.once("error", reject);
        modelServer.listen(0, "127.0.0.1", resolve);
      });
      const address = modelServer.address();
      if (address === null || typeof address === "string") throw new Error("The model fixture endpoint is unavailable.");
      const fixtureEndpoint = `http://127.0.0.1:${address.port}/v1`;
      await f.system.registry.get("ollama")!.snapshot();
      await f.providers.upsertConfiguration({
        providerId: "custom", displayName: "Custom", kind: "local_keyless", enabled: true, expectedVersion: 0n,
        runtimes: [{ backendId: "backend-a", credentialOrigin: "", credentialBindings: {}, provider: {
          id: "custom", api: "openai-completions", baseUrl: fixtureEndpoint, keyless: true, models: [{ id: modelId }]
        } }]
      });
      const snapshot = await f.providers.createPiGenerationSnapshot({ snapshotsRoot: join(f.root, "pi-catalog") });
      const managed = snapshot.providers.find(provider => provider.id === MANAGED_LOCAL_PROVIDER_ID)!;
      expect(managed.baseUrl).toBe(OLLAMA_OPENAI_BASE_URL);
      const selected = piProviderModel(managed, managed.models.find(model => model.id === modelId)!);
      expect(selected).toMatchObject({
        defaultEffort: "xhigh", thinkingLevels: ["off", "xhigh"], contextWindow: 32_768, maxOutputTokens: 16_000, supportsImages: true
      });
      const generated = JSON.parse(await readFile(join(snapshot.agentHome, "models.json"), "utf8"));
      expect(generated.providers[MANAGED_LOCAL_PROVIDER_ID].models).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: modelId, reasoning: true, maxTokens: 16_000 }),
        expect.objectContaining({ id: "qwen3.8:27b-mlx", reasoning: true, contextWindow: 2_048, maxTokens: 2_047 }),
        expect.objectContaining({ id: "qwen3.8:27b-mxfp8", reasoning: true, maxTokens: 16_000 })
      ]));
      expect(generated.providers[MANAGED_LOCAL_PROVIDER_ID].models.find((model: { id: string }) => model.id === "qwen3.8:latest"))
        .not.toHaveProperty("samplingParams");
      expect(generated.providers.custom.models[0]).not.toHaveProperty("thinkingLevelMap");

      const workspaceRoot = join(f.root, "pi-workspace"), sessionRoot = join(f.root, "pi-sessions");
      await mkdir(workspaceRoot);
      const startAdapter = (generation: number) => createPiAdapter({
        agentHome: join(f.root, `pi-agent-${generation}`), sessionRoot, externalSessionRoots: [],
        providers: [{ ...managed, baseUrl: fixtureEndpoint }],
        settings: { compaction: { enabled: false }, retry: { enabled: false } }, includeManagedSubagentTools: () => false
      });
      const events: EventPayload[] = [];
      let binding: NativeSessionBinding | undefined;
      const target: TargetDescriptor = { id: "pi-target", backendId: "pi", displayName: "Local workspace", workspaceRoot, managed: true, trusted: true };
      const context = (operationId: string): AdapterContext => ({
        sessionId: "ollama-qwen", generation: 1, target, ...(binding === undefined ? {} : { binding }),
        operationId, signal: new AbortController().signal, modelSelection: { providerId: MANAGED_LOCAL_PROVIDER_ID, modelId },
        emit: async event => { events.push(event); }, requestInteraction: async () => ({ kind: "cancelled" }),
        artifactCapacityBytes: 1_024, storeArtifact: async () => { throw new Error("The fixture has no artifacts."); }
      });
      const send = async (text: string) => {
        const completed = events.filter(event => event.type === "done").length;
        await adapter!.send({ text, disposition: "prompt", images: [], files: [], mentions: [] }, context(text));
        await vi.waitFor(() => expect(events.filter(event => event.type === "done")).toHaveLength(completed + 1), { timeout: 15_000 });
        expect(events.filter(event => event.type === "done").at(-1)).toMatchObject({ outcome: "completed" });
      };
      adapter = startAdapter(1);
      binding = await adapter.createSession({ target, providerId: MANAGED_LOCAL_PROVIDER_ID, modelId, effort: selected.defaultEffort,
        permissionMode: "ask", fastMode: false }, context("create"));
      await send("Use the default reasoning level.");
      await adapter.setEffort("off", context("save-off"));
      await adapter.dispose();
      adapter = startAdapter(2);
      expect((await adapter.resumeSession(binding, context("restore"))).effort).toBe("off");
      await send("Use the saved reasoning level.");

      expect(received).toHaveLength(2);
      for (const [index, packet] of received.entries()) {
        expect(packet.path).toBe("/v1/chat/completions");
        expect(packet.body).toMatchObject({
          model: modelId, chat_template_kwargs: { enable_thinking: index === 0, preserve_thinking: true },
          max_completion_tokens: 16_000, temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0
        });
        expect(packet.body).not.toHaveProperty("reasoning_effort");
        expect(packet.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system" })]));
        expect(packet.body.messages).not.toEqual(expect.arrayContaining([expect.objectContaining({ role: "developer" })]));
      }
    } finally {
      await adapter?.dispose();
      modelServer.closeAllConnections();
      if (modelServer.listening) await new Promise<void>(resolve => modelServer.close(() => resolve()));
      probe.mockRestore(); show.mockRestore(); tags.mockRestore();
      await f.system.close(); f.store.close();
    }
  }, 60_000);

  it("registers eligible Ollama models at each coding Backend's floor, executes their selected routes, and retires them on inventory changes", async () => {
    const f = await fixture();
    const modelId = "eligible:latest";
    let version: string | undefined;
    let installed = [modelId, "without-tools:latest", "requires-upgrade:latest"];
    const details = new Map<string, OllamaModelDetails>([
      [modelId, { capabilities: ["tools"], requiredRuntimeVersion: "0.13.3", contextLength: 32_768 }],
      ["without-tools:latest", { capabilities: [] }],
      ["requires-upgrade:latest", { capabilities: ["tools"], requiredRuntimeVersion: "0.15.0" }]
    ]);
    const probe = vi.spyOn(OllamaRuntimeLauncher.prototype, "status").mockImplementation(async () => ({
      runtime: "ollama", source: "running", state: "ready", version,
      capabilities: { canInstall: false, canStart: true, canListModels: true, canPullModels: true, canDeleteModels: true, canPausePulls: true }
    }));
    const tags = vi.spyOn(OllamaLoopbackClient.prototype, "tags").mockImplementation(async () => installed.map(name => ({ name })));
    const show = vi.spyOn(OllamaLoopbackClient.prototype, "show").mockImplementation(async name => details.get(name)!);
    const remove = vi.spyOn(OllamaLoopbackClient.prototype, "delete").mockImplementation(async name => {
      installed = installed.filter(value => value !== name);
    });
    const stream = "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
    const chatStream = 'data: {"id":"ollama-chat","choices":[{"index":0,"delta":{"content":"Codex loopback"},"finish_reason":null}]}\n\n'
      + 'data: {"id":"ollama-chat","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n'
      + "data: [DONE]\n\n";
    const outbound = vi.fn<typeof fetch>(async () => { throw new Error("The Ollama request must use loopback."); });
    const loopback = vi.fn<typeof fetch>(async (endpoint) => new Response(
      endpoint.toString() === `${OLLAMA_OPENAI_BASE_URL}/chat/completions` ? chatStream : stream,
      { headers: { "content-type": "text/event-stream" } }
    ));
    const proxy = new ManagedProviderProxy({ providers: f.providers, assertOwner: () => undefined, fetch: outbound,
      fetchForRoute: route => route.providerId === MANAGED_LOCAL_PROVIDER_ID && route.requestPath === undefined && (
        (route.backendId === "backend-b" && route.api === "anthropic-messages" && route.baseUrl === OLLAMA_LOOPBACK_ORIGIN)
        || (route.backendId === "backend-c" && route.api === "openai-completions" && route.baseUrl === OLLAMA_OPENAI_BASE_URL)
      ) ? loopback : undefined });
    try {
      const ollama = f.system.registry.get("ollama")!;
      const runtimeBackends = async () => (await ollama.snapshot()).providerRoutes?.map(route => route.backendId);
      expect(await runtimeBackends()).toEqual(["backend-a"]);
      version = "0.13.2";
      expect(await runtimeBackends()).toEqual(["backend-a"]);
      version = "0.13.3";
      expect(await runtimeBackends()).toEqual(["backend-a", "backend-c"]);
      version = "0.14.0";
      expect(await runtimeBackends()).toEqual(["backend-a", "backend-b", "backend-c"]);
      const saved = f.providers.listConfigurations().find(config => config.providerId === MANAGED_LOCAL_PROVIDER_ID)!;
      expect(saved.runtimes).toHaveLength(3);
      expect(saved.runtimes.every(runtime => runtime.version === saved.version)).toBe(true);
      expect(f.providers.get("backend-a", MANAGED_LOCAL_PROVIDER_ID).provider.models.map(model => model.id)).toEqual([...installed].sort());
      expect(f.changed).toHaveBeenLastCalledWith(expect.arrayContaining(["backend-a", "backend-b", "backend-c"]));

      await proxy.start();
      const port = proxy.createRuntime({ backendId: "backend-b", generation: 1, support: CLAUDE_MANAGED_PROVIDER_SUPPORT,
        assertCurrent: () => undefined });
      const codex = proxy.createRuntime({ backendId: "backend-c", generation: 1, support: CODEX_MANAGED_PROVIDER_SUPPORT,
        assertCurrent: () => undefined });
      expect(port.listModels()).toMatchObject([{ modelId, api: "anthropic-messages", contextWindow: 32_768, supportsTools: true }]);
      expect(codex.listModels()).toMatchObject([{ modelId, api: "openai-completions", contextWindow: 32_768, supportsTools: true }]);
      const signal = new AbortController().signal;
      const prepare = (remote: boolean, backendId = "backend-b") => f.system.prepareProviderRuntime({
        target: { backendId, ...(remote ? { remoteWorkspace: { kind: "ssh" } } : {}) },
        signal, modelSelection: { providerId: MANAGED_LOCAL_PROVIDER_ID, modelId }
      } as AdapterContext);
      await expect(prepare(true)).rejects.toMatchObject({ code: "MODEL_UNAUTHORIZED" });
      await prepare(false);
      const binding = await port.prepare({ backendId: "backend-b", backendInstanceGeneration: 1, targetId: "target",
        sessionId: "session", sessionGeneration: 1, providerId: MANAGED_LOCAL_PROVIDER_ID, modelId });
      const lease = await binding.activate({ operationId: "send", signal, assertCurrent: () => undefined });
      try {
        const body = JSON.stringify({ model: modelId, max_tokens: 16, stream: true, messages: [{ role: "user", content: "Fixture input" }] });
        const response = await fetch(`${binding.baseUrl}/v1/messages`, {
          method: "POST", headers: { "x-api-key": port.environment[binding.apiKeyEnvironment]! }, body
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(stream);
        expect(loopback).toHaveBeenCalledOnce();
        const [endpoint, request] = loopback.mock.calls[0]!;
        expect(endpoint.toString()).toBe(`${OLLAMA_LOOPBACK_ORIGIN}/v1/messages`);
        expect(request?.body?.toString()).toBe(body);
        expect(new Headers(request?.headers).has("x-api-key")).toBe(false);
        expect(outbound).not.toHaveBeenCalled();
      } finally { lease.release(); binding.dispose(); }

      await expect(prepare(true, "backend-c")).rejects.toMatchObject({ code: "MODEL_UNAUTHORIZED" });
      await prepare(false, "backend-c");
      const chat = await codex.prepare({ backendId: "backend-c", backendInstanceGeneration: 1, targetId: "codex-target",
        sessionId: "codex-session", sessionGeneration: 1, providerId: MANAGED_LOCAL_PROVIDER_ID, modelId });
      const chatLease = await chat.activate({ operationId: "codex-send", signal, assertCurrent: () => undefined });
      try {
        const response = await fetch(`${chat.baseUrl}/responses`, {
          method: "POST", headers: { authorization: `Bearer ${codex.environment[chat.apiKeyEnvironment]!}` },
          body: JSON.stringify({ model: modelId, input: "Codex fixture input", stream: true, max_output_tokens: 16 })
        });
        const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
        expect(events.at(-1)).toMatchObject({ type: "response.completed", response: {
          id: "ollama-chat", model: modelId, output: [{ type: "message", content: [{ type: "output_text", text: "Codex loopback" }] }],
          usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
        } });
        const [endpoint, request] = loopback.mock.calls[1]!;
        expect(endpoint.toString()).toBe(`${OLLAMA_OPENAI_BASE_URL}/chat/completions`);
        expect(JSON.parse(request?.body?.toString() ?? "")).toMatchObject({
          model: modelId, messages: [{ role: "user", content: "Codex fixture input" }], max_tokens: 16, stream: true
        });
        const headers = new Headers(request?.headers);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("x-joko-provider-proxy-token")).toBe(false);
        expect(outbound).not.toHaveBeenCalled();
      } finally { chatLease.release(); chat.dispose(); }

      details.set(modelId, { capabilities: [] });
      await expect(prepare(false)).rejects.toMatchObject({ code: "MODEL_UNAUTHORIZED" });
      await expect(prepare(false, "backend-c")).rejects.toMatchObject({ code: "MODEL_UNAUTHORIZED" });
      details.set(modelId, { capabilities: ["tools"] });
      version = "0.13.2";
      await expect(prepare(false, "backend-c")).rejects.toMatchObject({ code: "MODEL_UNAUTHORIZED" });
      version = "0.13.9";
      await ollama.snapshot();
      expect(port.listModels()).toEqual([]);
      expect(codex.listModels().map(model => model.modelId)).toEqual([modelId]);
      version = "0.14.0";
      await ollama.snapshot();
      expect(port.listModels().map(model => model.modelId)).toEqual([modelId]);
      const current = f.providers.listConfigurations().find(config => config.providerId === MANAGED_LOCAL_PROVIDER_ID)!;
      await f.providers.upsertConfiguration({
        ...current,
        enabled: false,
        expectedVersion: current.version,
        runtimes: current.runtimes.map(runtime => ({ backendId: runtime.backendId, provider: runtime.provider,
          credentialOrigin: runtime.credentialOrigin, credentialBindings: {} }))
      });
      version = "0.14.1";
      await ollama.snapshot();
      await expect(prepare(false)).rejects.toMatchObject({ code: "MODEL_UNAUTHORIZED" });
      await expect(prepare(false, "backend-c")).rejects.toMatchObject({ code: "MODEL_UNAUTHORIZED" });
      await ollama.deleteModel(modelId);
      expect(port.listModels()).toEqual([]);
      expect(codex.listModels()).toEqual([]);
      expect(() => f.providers.get("backend-b", MANAGED_LOCAL_PROVIDER_ID)).toThrow(/does not exist/u);
      expect(() => f.providers.get("backend-c", MANAGED_LOCAL_PROVIDER_ID)).toThrow(/does not exist/u);
      const pi = f.providers.get("backend-a", MANAGED_LOCAL_PROVIDER_ID);
      expect(pi.enabled).toBe(false);
      expect(pi.provider.models.map(model => model.id)).toEqual([...installed].sort());
      port.dispose(); codex.dispose();
    } finally {
      remove.mockRestore(); show.mockRestore(); tags.mockRestore(); probe.mockRestore();
      await proxy.close(); await f.system.close(); f.store.close();
    }
  });
});
