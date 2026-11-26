import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { OperationalStore, SessionRuntimeHandoffStore } from "@joko/store";
import { CodexBackendAdapter, StdioJsonRpcTransport, CODEX_MANAGED_PROVIDER_SUPPORT, type CodexNativeExecutionInput } from "@joko/adapter-codex";
import type { AdapterContext, EventPayload, ManagedProviderRuntimePort, NativeSessionBinding, NativeToolAuthorization,
  OrderedPolicyRule, PolicySnapshot, ProviderModel, SessionDescriptor, TargetDescriptor } from "@joko/core";
import { createNativeCodexExecution } from "./native-codex-execution.js";
import { reviewNativeToolPolicy } from "./native-tool-policy.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { SessionHost } from "./session-host.js";

const binary = process.env["JOKO_CODEX_HOSTED_TEST_BINARY"];

describe.skipIf(!binary)("ordinary actual Codex native execution", () => {
  it("forks native history between the owner-selected native and managed Providers on the original task", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-provider-handoff-")));
    const home = join(root, "native-home"), workspace = join(root, "workspace");
    await Promise.all([mkdir(home), mkdir(workspace)]);
    const requests: { path?: string; key?: string; model: string; history: string }[] = [];
    const wire: { method: string; params: unknown }[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; input: unknown };
      requests.push({ path: request.url, key: request.headers.authorization, model: body.model, history: JSON.stringify(body.input) });
      const id = String(requests.length);
      const item = { type: "message", id: "answer-" + id, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "REPLY " + id, annotations: [] }] };
      const events = [
        { type: "response.created", response: { id, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }
      ];
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(events.map(event => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n").join(""));
    });
    const store = new OperationalStore(join(root, "store.sqlite"));
    let host: SessionHost | undefined, adapter: CodexBackendAdapter | undefined;
    try {
      await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ready); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("The controlled model listener is unavailable.");
      const endpoint = `http://127.0.0.1:${address.port}`;
      await writeFile(join(home, "config.toml"), `model_provider = "openai"\nopenai_base_url = "${endpoint}/native/v1"\ncli_auth_credentials_store = "file"\n[features]\napi_key_model_discovery = false\nenable_request_compression = false\n`);
      await writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture-native-model-key" }));
      const model: ProviderModel = { providerId: "fixture-managed", modelId: "managed-model", displayName: "Managed model", api: "openai-responses",
        contextWindow: 32000, maxOutputTokens: 4096, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const port: ManagedProviderRuntimePort = { support: CODEX_MANAGED_PROVIDER_SUPPORT, environment: { JOKO_HANDOFF_KEY: "fixture-managed-model-key" },
        secretEnvironmentNames: ["JOKO_HANDOFF_KEY"], dispose: () => undefined, hasProvider: id => id === model.providerId, listModels: () => [model],
        getThinkingLevelMap: () => ({}), listProviders: () => [{ providerId: model.providerId, displayName: "Managed", api: model.api,
          authenticationState: "authenticated", loginMethods: ["api_key"], supportsLogin: false, supportsLogout: false, supportsRefresh: false, supportsModelRefresh: false }],
        prepare: async () => ({ providerId: model.providerId, model, thinkingLevelMap: {}, protocol: "openai-responses", revision: "fixture-v1",
          baseUrl: endpoint + "/managed/v1", apiKeyEnvironment: "JOKO_HANDOFF_KEY", assertCurrent: () => undefined,
          activate: async () => ({ release: () => undefined }), dispose: () => undefined }) };
      const env = { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], HOME: home, USERPROFILE: home,
        LOCALAPPDATA: home, APPDATA: home, CODEX_HOME: home, TEMP: root, TMP: root };
      adapter = new CodexBackendAdapter({ instanceGeneration: 1, profileDirectory: home, managedProviders: port,
        appServer: { transport: { command: binary!, env }, transportFactory: options => {
          const transport = new StdioJsonRpcTransport({ ...options, command: binary!, requestTimeoutMs: 30_000 });
          const dispatch = transport.request.bind(transport);
          transport.request = (method, params, options) => { wire.push({ method, params }); return dispatch(method, params, options); };
          return transport;
        } } });
      const registry = new BackendInstanceRegistry(store);
      await registry.provision([{ instanceId: adapter.id, adapterKind: "codex", displayName: "Codex", create: () => adapter! }]);
      const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
      await artifacts.initialize();
      host = new SessionHost(store, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true });
      await host.initialize();
      const target = { id: "codex-handoff-target", backendId: adapter.id, displayName: "Original workspace", workspaceRoot: workspace, managed: false, trusted: true };
      await host.registerTarget(target);
      const connection = store.createConnection({ id: "owner", name: "Original owner", authKeyDigest: "fixture-digest" });
      const native = registry.get(adapter.id).descriptor.models.find(candidate => candidate.providerId === "openai" && candidate.modelId === "gpt-5.5");
      expect(native).toBeDefined();
      const { sessionId } = (await host.createSession({ operationId: "create-original", connection, targetId: target.id, title: "Original task",
        providerId: native!.providerId, modelId: native!.modelId, permissionMode: "bypassPermissions", planMode: false, fastMode: false })).value;
      const handoffs = new SessionRuntimeHandoffStore(store);
      const send = async (id: string, text: string) => {
        const queued = host!.enqueueInput({ operationId: id, connection, sessionId,
          prompt: { text, images: [], files: [], mentions: [], disposition: "prompt" } }).value;
        await expect.poll(() => {
          const row = store.getQueueItem(queued.queueItemId);
          return { state: row.state, error: row.error, handoff: handoffs.read(sessionId)?.pending?.phase };
        }, { timeout: 30_000 }).toEqual({ state: "completed", error: undefined, handoff: undefined });
      };
      const assertOwner = () => undefined;
      await send("send-native", "FIRST NATIVE USER INPUT");
      const source = store.getSession(sessionId).descriptor.binding;
      expect(await host.stageUserModelProviderHandoff({ sessionId, patch: { providerId: model.providerId, modelId: model.modelId }, assertOwner })).toBe(true);
      expect(store.getSession(sessionId).descriptor.binding).toEqual(source);
      expect(handoffs.read(sessionId)?.pending).toMatchObject({ phase: "pending", nativeProvider: true });
      await send("send-managed", "SECOND MANAGED USER INPUT");
      const managed = store.getSession(sessionId).descriptor.binding;
      expect(managed.generation).toBeGreaterThan(source.generation);
      expect(managed.nativeSessionId).not.toBe(source.nativeSessionId);
      const control = host.getSessionRuntimeControl(sessionId);
      expect(await host.setSessionRuntimeControl({ sessionId, expectedGeneration: control.generation,
        patch: { backendId: adapter.id, providerId: native!.providerId, modelId: native!.modelId },
        allowNativeProviderHandoff: true, assertAuthority: assertOwner })).toMatchObject({ status: "deferred", effectiveBoundary: "next_send" });
      await send("send-native-again", "THIRD NATIVE USER INPUT");
      const final = store.getSession(sessionId).descriptor;
      expect(final).toMatchObject({ id: sessionId, targetId: target.id, backendId: adapter.id,
        providerId: native!.providerId, modelId: native!.modelId, permissionMode: "bypassPermissions" });
      expect(final.binding.generation).toBeGreaterThan(managed.generation);
      expect(final.binding.nativeSessionId).not.toBe(managed.nativeSessionId);
      expect(wire.filter(row => row.method === "thread/fork").map(row => row.params)).toEqual([
        expect.objectContaining({ threadId: source.nativeSessionId, modelProvider: "joko-managed", excludeTurns: true }),
        expect.objectContaining({ threadId: managed.nativeSessionId, modelProvider: "openai", excludeTurns: true })
      ]);
      expect(requests.map(({ path, key, model }) => [path, key, model])).toEqual([
        ["/native/v1/responses", "Bearer fixture-native-model-key", native!.modelId],
        ["/managed/v1/responses", "Bearer fixture-managed-model-key", model.modelId],
        ["/native/v1/responses", "Bearer fixture-native-model-key", native!.modelId]
      ]);
      expect(requests[1]?.history).toContain("FIRST NATIVE USER INPUT");
      expect(requests[1]?.history).toContain("REPLY 1");
      expect(requests[2]?.history).toContain("FIRST NATIVE USER INPUT");
      expect(requests[2]?.history).toContain("SECOND MANAGED USER INPUT");
      expect(requests[2]?.history).toContain("THIRD NATIVE USER INPUT");
      expect(store.listRuns({ sessionId }).map(row => row.descriptor.state)).toEqual(["succeeded", "succeeded", "succeeded"]);
    } finally {
      try { if (host) await host.dispose(); else await adapter?.dispose(); }
      finally {
        store.close();
        server.closeAllConnections();
        if (server.listening) await new Promise<void>(closed => server.close(() => closed()));
        const owned = relative(resolve(tmpdir()), resolve(root));
        if (isAbsolute(owned) || owned === ".." || owned.startsWith(`..${sep}`) || !owned.startsWith("joko-codex-provider-handoff-")) throw new Error("Native fixture cleanup escaped its temporary root.");
        await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    }
  }, 180_000);

  it("enforces ordered command policy in FullAccess and executes only under the next allowed turn owner", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-ordinary-native-")));
    const project = join(root, "project"), home = join(root, "native-home");
    await Promise.all([mkdir(project), mkdir(home)]);
    const target: TargetDescriptor = { id: "ordinary-native-target", backendId: "codex", displayName: "Ordinary native task",
      workspaceRoot: project, managed: false, trusted: true };
    const sessionId = "ordinary-native-session", events: EventPayload[] = [];
    const calls: { method: string; params: unknown }[] = [];
    const reviews: { owner: string | undefined; generation: string; toolName: string; input: unknown; verdict: string }[] = [];
    const requests: { phase: string; input: Record<string, unknown>; authorization: string; path: string }[] = [];
    const failures: unknown[] = [];
    let phase: "deny" | "allow" = "deny", native: CodexNativeExecutionInput | undefined, binding: NativeSessionBinding | undefined;
    let adapter: CodexBackendAdapter | undefined;
    const policyFor = (effect: "deny" | "allow", generation: string): PolicySnapshot => {
      const command: OrderedPolicyRule = { id: "ordinary-command", subjectKind: "command", effect, ceiling: "critical", priority: 0, order: 0 };
      return { generation, backendId: target.backendId, targetId: target.id, workspaceRoot: project, rules: [command] };
    };
    let policy = policyFor("deny", "1");
    const authority: NativeToolAuthorization = { required: false, snapshot: () => policy, capture: () => policy.generation,
      assertCurrent: expected => { if (expected !== undefined && expected !== policy.generation) throw new Error("The original native policy changed."); },
      review: async request => {
        const selected = policy;
        const decision = reviewNativeToolPolicy(selected, request);
        reviews.push({ owner: native?.currentContext().operationId, generation: selected.generation,
          toolName: request.toolName, input: request.input, verdict: decision.verdict });
        return { ...decision, authorizationRevision: selected.generation };
      } };
    const context = (operationId: string): AdapterContext => ({ sessionId, generation: 1, backendInstanceGeneration: 1, target,
      ...(binding ? { binding } : {}), operationId, policySnapshot: policy, nativeToolAuthorization: authority,
      modelSelection: { providerId: "fixture", modelId: "fixture-model" }, signal: new AbortController().signal,
      emit: async event => { events.push(event); }, requestInteraction: async () => { throw new Error("FullAccess ordered allow/deny must not request owner input."); },
      artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No artifacts are generated by this test."); } });
    const store = { getTarget: () => ({ descriptor: target, metadata: {}, createdAt: 1, updatedAt: 1, revision: 1n }),
      getSession: () => ({ descriptor: { id: sessionId, targetId: target.id, backendId: target.backendId, archived: false,
        binding: binding ?? { opaqueRef: "native-preparation", generation: 1 } } as SessionDescriptor, revision: 1n }) };
    const execution = createNativeCodexExecution({ store, executable: binary!, remoteExecution: {
      workspace: async () => { throw new Error("An ordinary local task must not acquire another execution transport."); }
    } });
    const modelServer = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          if (size > 16 * 1024 * 1024) throw new Error("The controlled model request exceeded its fixture budget.");
          chunks.push(Buffer.from(chunk));
        }
        const input = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        requests.push({ phase, input, authorization: request.headers.authorization ?? "", path: request.url ?? "" });
        const callId = `ordinary-${phase}-call`;
        const output = Array.isArray(input.input) && input.input.some(item => item !== null && typeof item === "object"
          && item.type === "function_call_output" && item.call_id === callId);
        const marker = phase === "deny" ? "denied.txt" : "allowed.txt";
        const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},${JSON.stringify(`ORDINARY ${phase.toUpperCase()} OK`)})`;
        const quote = (value: string) => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
        const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} -e ${quote(source)}`;
        const item = !output
          ? { type: "function_call", id: `ordinary-${phase}-item`, call_id: callId, name: "exec_command", status: "completed",
              arguments: JSON.stringify({ cmd: command, workdir: project, login: false, yield_time_ms: 1000, max_output_tokens: 1000 }) }
          : { type: "message", id: `ordinary-${phase}-answer`, role: "assistant", status: "completed",
              content: [{ type: "output_text", text: `ORDINARY ${phase.toUpperCase()} DONE`, annotations: [] }] };
        const responseId = `ordinary-response-${requests.length}`;
        const stream = [{ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
          { type: "response.output_item.done", output_index: 0, item },
          { type: "response.completed", response: { id: responseId, status: "completed", output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(stream.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
      } catch (error) {
        failures.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
    try {
      await new Promise<void>((ready, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", ready); });
      const address = modelServer.address();
      if (!address || typeof address === "string") throw new Error("The controlled model listener is unavailable.");
      const model: ProviderModel = { providerId: "fixture", modelId: "fixture-model", displayName: "Fixture model", api: "openai-responses",
        contextWindow: 32000, maxOutputTokens: 4096, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const managedProviders: ManagedProviderRuntimePort = { support: CODEX_MANAGED_PROVIDER_SUPPORT,
        environment: { JOKO_FIXTURE_PROVIDER_TOKEN: "ordinary-local-fixture-token" }, secretEnvironmentNames: ["JOKO_FIXTURE_PROVIDER_TOKEN"],
        dispose: () => undefined, hasProvider: id => id === "fixture", listModels: () => [model], getThinkingLevelMap: () => ({}),
        listProviders: () => [{ providerId: "fixture", displayName: "Fixture", api: "openai-responses", authenticationState: "authenticated",
          loginMethods: ["api_key"], supportsLogin: false, supportsLogout: false, supportsRefresh: false, supportsModelRefresh: false }],
        prepare: async () => ({ providerId: "fixture", model, thinkingLevelMap: {}, protocol: "openai-responses", revision: "fixture-v1",
          baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnvironment: "JOKO_FIXTURE_PROVIDER_TOKEN", assertCurrent: () => undefined,
          activate: async () => ({ release: () => undefined }), dispose: () => undefined }) };
      const env = { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], HOME: home, USERPROFILE: home,
        LOCALAPPDATA: home, APPDATA: home, CODEX_HOME: home, TEMP: root, TMP: root };
      adapter = new CodexBackendAdapter({ instanceGeneration: 1, profileDirectory: home, managedProviders,
        nativeExecution: { openExecServer: async input => {
          expect(input.remote).toBe(false);
          expect(input.openExecServerProcess).toBeUndefined();
          native = input;
          return execution.openExecServer(input);
        } }, appServer: { transport: { command: binary!, env }, transportFactory: options => {
          const transport = new StdioJsonRpcTransport({ ...options, command: binary!, requestTimeoutMs: 30_000 });
          const dispatch = transport.request.bind(transport);
          transport.request = (method, params, options) => { calls.push({ method, params }); return dispatch(method, params, options); };
          return transport;
        } } });
      binding = await adapter.createSession({ target, providerId: "fixture", modelId: "fixture-model", fastMode: false,
        permissionMode: "bypassPermissions" }, context("ordinary-prepare"));
      expect(binding.nativeSessionId).toBeTruthy();
      expect(native).toBeDefined();
      const start = calls.find(call => call.method === "thread/start")?.params;
      expect(start).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access",
        modelProvider: "joko-managed",
        environments: [{ environmentId: expect.any(String), cwd: project, runtimeWorkspaceRoots: [project] }] });
      expect(calls.some(call => call.method === "environment/add")).toBe(true);
      const prompt = { text: "Execute the supplied controlled file command once and report its result.", images: [], files: [], mentions: [], disposition: "prompt" as const };
      await adapter.send(prompt, context("ordinary-denied-turn"));
      await expect.poll(() => events.filter(event => event.type === "done"), { timeout: 40_000 }).toHaveLength(1);
      expect(events.filter(event => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
      await expect(readFile(join(project, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(reviews).toContainEqual(expect.objectContaining({ owner: "ordinary-denied-turn", generation: "1", toolName: "bash", verdict: "block" }));
      const outputs = (selected: string) => requests.filter(request => request.phase === selected).flatMap(request =>
        Array.isArray(request.input.input) ? request.input.input.filter(item => item !== null && typeof item === "object" && item.type === "function_call_output") : []);
      expect(JSON.stringify(outputs("deny"))).toContain("Not allowed in this workspace");
      phase = "allow";
      policy = policyFor("allow", "2");
      await adapter.send(prompt, context("ordinary-allowed-turn"));
      await expect.poll(() => events.filter(event => event.type === "done"), { timeout: 40_000 }).toHaveLength(2);
      expect(events.filter(event => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }, { type: "done", outcome: "completed" }]);
      expect(await readFile(join(project, "allowed.txt"), "utf8")).toBe("ORDINARY ALLOW OK");
      await expect(readFile(join(project, "denied.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(reviews).toContainEqual(expect.objectContaining({ owner: "ordinary-allowed-turn", generation: "2", toolName: "bash", verdict: "allow" }));
      expect(JSON.stringify(outputs("allow"))).toContain("Process exited with code 0");
      expect(requests).toHaveLength(4);
      expect(requests.every(request => request.authorization === "Bearer ordinary-local-fixture-token" && request.path === "/v1/responses")).toBe(true);
      expect(failures).toEqual([]);
      const turnEnvironments = calls.filter(call => call.method === "turn/start").map(call => (call.params as { environments?: unknown }).environments);
      expect(turnEnvironments).toHaveLength(2);
      expect(turnEnvironments.every(environments => JSON.stringify(environments) === JSON.stringify((start as { environments: unknown }).environments))).toBe(true);
    } finally {
      try { await adapter?.dispose(); }
      finally {
        modelServer.closeAllConnections();
        if (modelServer.listening) await new Promise<void>(closed => modelServer.close(() => closed()));
        const owned = relative(resolve(tmpdir()), resolve(root));
        if (isAbsolute(owned) || owned === ".." || owned.startsWith(`..${sep}`) || !owned.startsWith("joko-codex-ordinary-native-")) throw new Error("Native fixture cleanup escaped its temporary root.");
        await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    }
  }, 180_000);
});
