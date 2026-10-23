import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { HostedAgentSourceAdapter } from "@joko/adapter-hosted";
import { HostedAgentService } from "@joko/contracts";
import type { AdapterContext, BackendDescriptor, Capability, NativeHistoryProjection, ProviderModel } from "@joko/core";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { createCommandConcurrencyGate } from "@joko/runtime-governance";
import { describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { HostedAgentHost } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { HostedAgentPoller } from "./hosted-agent-poller.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { createHostedAgentSourceController } from "./hosted-agent-source-controller.js";
import { createHostedAgentCodexAdapter } from "./hosted-agent-codex-factory.js";
import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { SessionHost } from "./session-host.js";
import { McpRouter } from "./mcp-router.js";
import { HostedAgentSourceMcp } from "./hosted-agent-source-mcp.js";
import { hostedDirectoryId } from "./hosted-agent-directories.js";

const binary = process.env["JOKO_CODEX_HOSTED_TEST_BINARY"];
describe.skipIf(!binary)("Codex native Source product Session", () => {
  it.each([true, false])("persists the product Queue and native fence with Source MCP enabled=%s before native create completes", async withMcpTools => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-source-session-"))), workspace = join(root, "workspace"), nativeRoot = join(root, "model-node");
    await mkdir(workspace); await mkdir(nativeRoot);
    const additional = join(root, "approved-additional"); await mkdir(additional); await writeFile(join(additional, "proof-extra.txt"), "ORIGINAL CODEX EXTRA DIRECTORY");
    let nativeAdditional = "";
    const requests: Record<string, unknown>[] = [], selectedModel: ProviderModel = { providerId: "fixture", modelId: "native-model", displayName: "Native model",
      api: "openai-responses", contextWindow: 32768, maxOutputTokens: 1024, supportsImages: true, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    let networkAuthorization = "";
    const model = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>); networkAuthorization = request.headers.authorization ?? "";
      const tool = requests.length === 1;
      const script = `const fs=require("node:fs");fs.writeFileSync("queue-proof.txt","ORIGINAL SOURCE QUEUE");process.stdout.write(fs.readFileSync(${JSON.stringify(join(nativeAdditional, "proof-extra.txt"))},"utf8"));`;
      const command = process.platform === "win32"
        ? `& '${process.execPath.replaceAll("'", "''")}' -e '${script.replaceAll("'", "''")}'`
        : `'${process.execPath.replaceAll("'", "'\"'\"'")}' -e '${script.replaceAll("'", "'\"'\"'")}'`;
      const item = tool ? { type: "function_call", id: "source-tool", call_id: "source-tool-call", name: "exec_command", status: "completed",
        arguments: JSON.stringify({ cmd: command, login: false, yield_time_ms: 1000, max_output_tokens: 1000 }) }
        : requests.length === 2 && withMcpTools ? { type: "function_call", id: "source-mcp", call_id: "source-mcp-call", namespace: `mcp__joko_source_${createHash("sha256").update("original_tools").digest("hex").slice(0, 24)}`, name: "owner_echo", status: "completed", arguments: "{}" }
        : { type: "message", id: "source-answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ORIGINAL SOURCE QUEUE", annotations: [] }] };
      const events = [{ type: "response.created", response: { id: "source-response-" + requests.length, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "source-response-" + requests.length, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
    await new Promise<void>(ready => model.listen(0, "127.0.0.1", ready));
    const address = model.address(); if (!address || typeof address === "string") throw new Error("Missing controlled model listener.");
    const sourceStore = new OperationalStore(join(root, "source.sqlite")), nativeStore = new OperationalStore(join(root, "native.sqlite")), slots = new HostedAgentSessionSlots();
    const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "vault.key")), storagePath: join(root, "credentials.json") }); await credentials.initialize();
    const sourceRouter = new McpRouter({ store: sourceStore, credentials }); await sourceRouter.initialize(); let sourceMcp: HostedAgentSourceMcp | undefined;
    if (withMcpTools) sourceRouter.registerBridgeToolProvider({ id: "original_tools", generation: 1, available: true,
      tools: [{ serverId: "original_tools", name: "owner_echo", description: "Original task owner tool", inputSchema: { type: "object", properties: {} }, requiresPermission: false, requiresNativeRoot: true }],
      callTool: async (_name, _args, _signal, context) => { context.assertCurrent?.(); context.assertNativeRoot?.(); expect(context.targetId).toBe("original-target");
        return { content: [{ type: "text", text: "ORIGINAL_CODEX_MCP_BYTES" }], isError: false }; } });
    const providers = new ProviderCatalogManager({ store: nativeStore, credentials, nativeBackendId: "native-owner" }); providers.initialize();
    const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, "model-node-private-key");
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "source-provider-key", displayName: "Native source Provider", kind: "api_key" });
    const endpoint = `http://127.0.0.1:${address.port}`;
    await providers.upsertConfiguration({ providerId: selectedModel.providerId, displayName: "Native source Provider", kind: "custom_endpoint", enabled: true, expectedVersion: 0n,
      runtimes: [{ backendId: "codex", provider: { id: selectedModel.providerId, api: "openai-responses", baseUrl: endpoint + "/v1", apiKeyEnv: "SOURCE_NATIVE_PROVIDER_KEY",
        models: [{ id: selectedModel.modelId, input: ["text", "image"], contextWindow: selectedModel.contextWindow, maxTokens: selectedModel.maxOutputTokens }] },
        credentialBindings: { SOURCE_NATIVE_PROVIDER_KEY: "source-provider-key" }, credentialOrigin: endpoint }] });
    const gate = createCommandConcurrencyGate({ readMaximum: () => 1 });
    const principal = { id: "source-hub", deviceId: "source-device", trust: "owner" as const, assertCurrent: () => undefined };
    let created = 0, nativeWorkspace = "", nativeHome = "", nativeRunId = "", dispatchFingerprint = "";
    const nativeFailures: unknown[] = [];
    const assertModelAllowed = (providerId: string, modelId: string) => { if (providerId !== selectedModel.providerId || modelId !== selectedModel.modelId) throw new Error("The selected native model is unavailable."); };
    const captureNativeAuthentication = vi.fn(async () => { throw new Error("A managed-only run cannot borrow the original native account."); });
    const nativeHost = new HostedAgentHost({ authorize: () => ({ root: nativeRoot, store: new HostedAgentStore(nativeStore), slots, artifactCapacityBytes: 1024 * 1024,
      modelIds: [selectedModel.modelId], assertCurrent: () => undefined,
      assertModelAllowed,
      createAdapter: async creation => {
        expect(creation.nativeOwner.backendInstanceGeneration).toBe(1); expect(creation.nativeOwner.generation).toBe(1);
        created++; nativeWorkspace = creation.execution.workspace.root; nativeHome = creation.home;
        nativeAdditional = creation.execution.workspace.additionalRoots[0]!;
        expect(nativeAdditional).toContain("approved-"); expect(nativeAdditional).not.toBe(additional);
        const adapter = await createHostedAgentCodexAdapter({ creation: { ...creation, providerIds: [selectedModel.providerId], assertModelAllowed },
          backendId: "codex", providers, executable: binary!, captureNativeAuthentication });
        const create = adapter.createSession.bind(adapter);
        adapter.createSession = async (input, context) => { try { return await create(input, context); } catch (error) { nativeFailures.push(error); throw error; } };
        const send = adapter.sendWithDurableNativeDispatchFence.bind(adapter);
        adapter.sendWithDurableNativeDispatchFence = (input, context, persist) => send(input, context, async preparation => {
          expect(preparation.nativeHistory.activeLineage).toEqual([]); dispatchFingerprint = preparation.inputFingerprint; await persist(preparation);
        });
        return adapter;
      } }) });
    const nativeCall = nativeHost.call.bind(nativeHost);
    nativeHost.call = async (...args) => { try { return await nativeCall(...args); } catch (error) { nativeFailures.push(error); throw error; } };
    const client = new HostedAgentConnectClient(createClient(HostedAgentService, createRouterTransport(router => router.service(HostedAgentService,
      createHostedAgentConnectService({ host: nativeHost, authenticate: () => principal })))), principal.assertCurrent);
    const poller = new HostedAgentPoller(client), sourceId = "source-native-codex";
    const capabilities: Capability[] = ["session.resume", "session.detach", "session.rewind", "session.rewind_to_start", "turn.stream", "turn.abort", "turn.steer", "turn.follow_up", "input.text", "input.image", "model.list", "model.switch",
      "permission.change", "context.usage", "context.compact", "runtime.tools", "tool.mcp"].map(key => ({ key, supported: true }));
    capabilities.push({ key: "permission.modes", supported: true, options: ["ask", "bypassPermissions"] });
    capabilities.push({ key: "workspace.extra_dirs", supported: true });
    const descriptor: BackendDescriptor = { id: sourceId, adapterKind: "hosted", instanceGeneration: 1, displayName: "Codex on paired device", version: "0.159.2",
      installationState: "installed", health: "healthy", authenticationState: "authenticated", capabilities: new Map(capabilities.map(capability => [capability.key, capability])),
      models: [selectedModel], tools: [], diagnostics: [] };
    const assertContext = (context: AdapterContext) => { if (context.target.id !== "original-target" || context.target.workspaceRoot !== workspace) throw new Error("Wrong task Source."); };
    let sourceArtifacts: ArtifactStore;
    const adapter = new HostedAgentSourceAdapter({ id: sourceId, source: { controllerDeviceId: principal.deviceId, targetDeviceId: "model-node", backendId: "codex" },
      describe: () => descriptor, assertContext, releaseWorkspace: async () => { await sourceMcp?.close(); }, workspace: context => {
        sourceMcp = new HostedAgentSourceMcp({ store: sourceStore, router: sourceRouter, context, assertCurrent: () => assertContext(context), includeToolPolicy: () => true });
        return { platform: process.platform as "win32" | "darwin" | "linux", shell: "powershell", isGitRepository: false, mcpEnabled: true,
          additionalDirectoryIds: (context.extraDirectories ?? []).map(hostedDirectoryId) }; },
      readPolicy: () => ({ permissionMode: "bypassPermissions", fastMode: false }), capture: async runId => { nativeRunId = runId; return { client, assertCurrent: principal.assertCurrent,
        close: () => client.close(runId, new AbortController().signal), createController: input => createHostedAgentSourceController({ ...input, poller,
          mcp: sourceMcp!,
          temporaryRoot: join(root, "incoming"), assertCurrent: principal.assertCurrent, assertContext, codexExecutable: binary!, commandConcurrencyGate: gate,
          readBlob: async blob => (await sourceArtifacts.readBlob(blob)).data,
          readPolicy: context => ({ revision: "source-policy", permissionMode: "bypassPermissions", planMode: false, approvedRoots: context.extraDirectories ?? [], confirmCredentials: true }) }) }; } });
    const registry = new BackendInstanceRegistry(sourceStore);
    let host: SessionHost | undefined;
    try {
      await registry.provision([{ instanceId: sourceId, adapterKind: "hosted", displayName: descriptor.displayName, create: () => adapter }]);
      const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(sourceStore), ingestRoots: [root] }); await artifacts.initialize();
      sourceArtifacts = artifacts;
      host = new SessionHost(sourceStore, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true });
      await host.initialize(); await host.registerTarget({ id: "original-target", backendId: sourceId, displayName: "Original workspace", workspaceRoot: workspace, managed: true, trusted: true });
      const connection = sourceStore.createConnection({ id: "owner", name: "Task Source", authKeyDigest: "fixture-digest" });
      await host.extraDirectories.add({ workspaceId: "original-target", serverPath: additional, access: "read_only" });
      const createdSession = await host.createSession({ operationId: "create-native-source", connection, targetId: "original-target", title: "Codex Source task", providerId: selectedModel.providerId,
        modelId: selectedModel.modelId, permissionMode: "bypassPermissions", planMode: false, fastMode: false }).catch(error => {
          throw new Error(JSON.stringify({ source: error.storedError, native: nativeFailures.map(error => error instanceof Error ? { ...error, message: error.message } : error) }));
        });
      const sessionId = createdSession.value.sessionId, binding = sourceStore.getSession(sessionId).descriptor.binding.opaqueRef;
      expect(created).toBe(1); expect(slots.summary().total).toBe(1); expect(binding).not.toContain(nativeRoot);
      const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const image = await artifacts.ingestBytes(imageBytes, { fileName: "source.png", mimeType: "image/png" });
      const imageBlob = { id: image.id, sha256: image.sha256, byteLength: image.byteLength, mimeType: image.mimeType, fileName: image.fileName! };
      const admitted = host.enqueueInput({ operationId: "native-source-prompt", sessionId, connection,
        prompt: { text: "Run the controlled file command and report its result.", images: [{ blob: imageBlob }], files: [], mentions: [], disposition: "prompt" } }).value;
      host.requestQueueDrain(sessionId);
      await vi.waitFor(() => expect(["completed", "failed"]).toContain(sourceStore.getQueueItem(admitted.queueItemId).state), { timeout: 30_000 });
      const queued = sourceStore.getQueueItem(admitted.queueItemId);
      expect({ state: queued.state, error: queued.error, errors: sourceStore.listEvents({ sessionId, limit: 1000 }).filter(event => event.payload.type === "error").map(event => event.payload),
        nativeFailures: nativeFailures.map(error => error instanceof Error ? { ...error, message: error.message } : error) })
        .toEqual({ state: "completed", error: undefined, errors: [], nativeFailures: [] });
      expect(requests).toHaveLength(withMcpTools ? 3 : 2);
      if (withMcpTools) {
        expect(requests[0]!["tools"]).toEqual(expect.arrayContaining([expect.objectContaining({ type: "namespace",
          name: `mcp__joko_source_${createHash("sha256").update("original_tools").digest("hex").slice(0, 24)}`,
          tools: expect.arrayContaining([expect.objectContaining({ name: "owner_echo" })]) })]));
        const mcpOutput = (requests[2]!["input"] as Record<string, unknown>[]).find(item => item["type"] === "function_call_output" && item["call_id"] === "source-mcp-call");
        expect(mcpOutput).toMatchObject({ output: expect.arrayContaining([expect.objectContaining({ type: "input_text", text: "ORIGINAL_CODEX_MCP_BYTES" })]) });
      } else expect((requests[0]!["tools"] as { name?: string }[]).filter(tool => tool.name?.startsWith("mcp__"))).toEqual([]);
      expect(networkAuthorization).toBe("Bearer model-node-private-key");
      expect(JSON.stringify(requests[1])).toContain("ORIGINAL CODEX EXTRA DIRECTORY");
      expect(captureNativeAuthentication).not.toHaveBeenCalled();
      await expect(readFile(join(nativeHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(requests[0])).toContain("data:image/png;base64," + imageBytes.toString("base64"));
      expect(await readFile(join(workspace, "queue-proof.txt"), "utf8")).toBe("ORIGINAL SOURCE QUEUE");
      await expect(readFile(join(nativeWorkspace, "queue-proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const events = sourceStore.listEvents({ sessionId, limit: 1000 });
      expect(events.filter(event => event.payload.type === "error")).toEqual([]);
      expect(events.some(event => event.payload.type === "done" && event.runId === admitted.runId)).toBe(true);
      expect(sourceStore.getSession(sessionId).descriptor.binding.opaqueRef).toBe(binding);
      expect(JSON.stringify(events.map(event => event.payload))).not.toContain("model-node-private-key"); expect(gate.snapshot().running).toBe(0);
      const nativeHistory = await client.call(nativeRunId, randomUUID(), { kind: "history" }, new AbortController().signal) as NativeHistoryProjection;
      expect(nativeHistory.events.filter(event => event.projectionKind === "message_user").map(event => event.metadata?.fields["nativeDispatchFingerprint"]))
        .toContain(dispatchFingerprint);
      const sourceBinding = sourceStore.getSession(sessionId).descriptor.binding;
      await host.navigateTree(sessionId, { kind: "session_start" }, false, undefined, sourceBinding.generation,
        { connection, operationId: "rewind-native-source", protocol: { kind: "internal" } }).catch(error => {
          throw new Error(JSON.stringify({ source: error.storedError, native: nativeFailures.map(error => error instanceof Error ? { ...error, message: error.message } : error) }));
        });
      expect(sourceStore.getSession(sessionId).descriptor.binding).toEqual(sourceBinding);
      const rewound = await client.call(nativeRunId, randomUUID(), { kind: "history" }, new AbortController().signal) as NativeHistoryProjection;
      expect(rewound.events.filter(event => event.projectionKind === "message_user" || event.projectionKind === "message_assistant")).toEqual([]);
      expect(nativeStore.listSettingsByKeyPrefix("service", "native-hosted-navigation.v1", "")).toEqual([]);
      expect(requests).toHaveLength(withMcpTools ? 3 : 2);
      await host.dispose(); host = undefined; expect(slots.summary().total).toBe(0);
    } finally {
      await host?.dispose(); await adapter.dispose(); await poller.close(); await nativeHost.dispose(); await sourceMcp?.close(); await sourceRouter.dispose(); gate.close(); sourceStore.close(); nativeStore.close();
      model.closeAllConnections(); await new Promise<void>(closed => model.close(() => closed()));
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe native Source cleanup.");
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 90_000);
});
