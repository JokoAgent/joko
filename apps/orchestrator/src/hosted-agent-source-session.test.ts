import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { createPiAdapter } from "@joko/adapter-pi";
import { HostedAgentSourceAdapter } from "@joko/adapter-hosted";
import type { AdapterContext, BackendDescriptor, Capability } from "@joko/core";
import { HostedAgentService } from "@joko/contracts";
import { OperationalStore, HostedAgentStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { SessionHost } from "./session-host.js";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { HostedAgentHost } from "./hosted-agent-host.js";
import { HostedAgentSessionSlots } from "./hosted-agent-limits.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { HostedAgentPoller } from "./hosted-agent-poller.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { createHostedAgentSourceController } from "./hosted-agent-source-controller.js";
import type { HostedAgentExecutorPolicy } from "./hosted-agent-executor.js";
import { snapshotSourceProjectFiles } from "./hosted-agent-project-files.js";
import { snapshotSourceInstructions } from "./hosted-agent-source-instructions.js";
import { HostedAgentSourceResources } from "./hosted-agent-source-resources.js";
import { hostedDirectoryId } from "./hosted-agent-directories.js";
import { createArtifactMentionResolver } from "./artifact-mention-resolver.js";
import { HostedAgentSourceAttachments } from "./hosted-agent-source-attachments.js";
import { prepareSourceWorkspaceInput } from "./hosted-agent-source-input.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { McpRouter } from "./mcp-router.js";
import { MakerMemoryBridgeProvider, MakerMemoryController } from "./maker-memory.js";
import { HostedAgentSourceMcp } from "./hosted-agent-source-mcp.js";

it("dispatches the durable product queue through a native Source Adapter and restores the exact native owner after Source restart", { timeout: 90_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-product-native-"))), workspace = join(root, "workspace"), modelRoot = join(root, "model-node");
  await mkdir(workspace); await mkdir(modelRoot); await writeFile(join(workspace, "proof.txt"), "ORIGINAL_WORKSPACE_BYTES");
  await writeFile(join(workspace, "AGENTS.md"), "SOURCE_PROJECT_GUIDANCE: preserve the original task workspace.");
  await writeFile(join(root, "AGENTS.md"), "SOURCE_ANCESTOR_GUIDANCE: preserve the original computer.");
  const additional = join(root, "approved-additional"); await mkdir(additional); await writeFile(join(additional, "proof-extra.txt"), "ORIGINAL_EXTRA_BYTES");
  let nativeAdditional = "";
  let modelRequests = 0;
  let imageRequests = 0;
  const complete = (response: ServerResponse, tool: boolean, paths: readonly string[]) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: `native-${modelRequests}`, object: "chat.completion.chunk", created: 1, model: "native-model",
      choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [...[modelRequests === 3 ? join(nativeAdditional, "proof-extra.txt") : "proof.txt", ...paths].map((path, index) => ({ index, id: `read-${modelRequests}-${index}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } })),
        { index: paths.length + 1, id: `root-${modelRequests}`, type: "function", function: { name: "mcp__original_tools__owner_echo", arguments: "{}" } },
        { index: paths.length + 2, id: `memory-${modelRequests}`, type: "function", function: modelRequests === 1
          ? { name: "mcp__joko_memory__memory_write", arguments: JSON.stringify({ type: "project", name: "source-proof", title: "Source proof", description: "Durable original source decision", body: "ORIGINAL_MEMORY_BODY" }) }
          : { name: "mcp__joko_memory__memory_search", arguments: JSON.stringify({ query: "ORIGINAL_MEMORY_BODY" }) } }] }
        : { role: "assistant", content: "The original workspace contains ORIGINAL_WORKSPACE_BYTES." }, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  };
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.headers.authorization).toBe("Bearer model-node-private-key");
    const body = Buffer.concat(chunks).toString(); modelRequests++;
    expect(body).toContain("SOURCE_PROJECT_GUIDANCE");
    expect(body).toContain("SOURCE_ANCESTOR_GUIDANCE"); expect(body).toContain("SOURCE_APPROVED_PROMPT");
    expect(body).toContain("SOURCE_MEMORY_INDEX_FROM_ORIGINAL");
    if (body.includes("data:image/png;base64,")) imageRequests++;
    const messages = JSON.parse(body).messages as { role: string; content: unknown }[];
    const userText = messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : "").join("\n");
    const paths = [...new Set([...userText.matchAll(/Attached file:[^\n]*\nPath: ([^\r\n]+)/gu)].map(match => match[1]!))];
    expect(paths).toHaveLength(1);
    if (modelRequests % 2 === 0) {
      const latestUser = messages.map(message => message.role).lastIndexOf("user"), results = JSON.stringify(messages.slice(latestUser + 1).filter(message => message.role === "tool"));
      expect(results).toContain(modelRequests === 4 ? "ORIGINAL_EXTRA_BYTES" : "ORIGINAL_WORKSPACE_BYTES"); expect(results).toContain("RETAINED_SOURCE_UPLOAD");
      expect(results).toContain("ORIGINAL_ROOT_MCP_BYTES");
      if (modelRequests === 4) expect(results).toContain("ORIGINAL_MEMORY_BODY");
    }
    complete(response, modelRequests % 2 === 1, paths);
  });
  await new Promise<void>(ready => model.listen(0, "127.0.0.1", ready));
  const address = model.address(); if (!address || typeof address === "string") throw new Error("Missing model listener.");
  const nativeDatabase = new OperationalStore(join(root, "native.sqlite")), slots = new HostedAgentSessionSlots();
  const nativeStore = new HostedAgentStore(nativeDatabase), principal = { id: "source-hub", deviceId: "original-device", trust: "owner" as const, assertCurrent: () => {} };
  let enabled = true;
  const nativeHost = new HostedAgentHost({ authorize: () => ({ root: modelRoot, store: nativeStore, slots, artifactCapacityBytes: 1024 * 1024, modelIds: ["native-model"],
    assertCurrent: () => { if (!enabled) throw new Error("Provider access was paused."); },
    assertModelAllowed: (providerId, modelId) => { if (!enabled || providerId !== "provider" || modelId !== "native-model") throw new Error("Unavailable Provider model."); },
    createAdapter: async ({ home, readBlob, execution, sourceMcp }) => {
      nativeAdditional = execution.workspace.additionalRoots[0]!;
      expect(nativeAdditional).toContain("approved-"); expect(nativeAdditional).not.toBe(additional);
      const instructions = execution.workspace.contextFiles?.find(file => file.path.endsWith(`${sep}AGENTS.md`));
      expect(instructions?.path).toBe(join(execution.workspace.root, "AGENTS.md"));
      expect(instructions?.path).not.toBe(join(workspace, "AGENTS.md"));
      expect(await readFile(instructions!.path, "utf8")).toContain("SOURCE_PROJECT_GUIDANCE");
      return createPiAdapter({ agentHome: home, sessionRoot: home, includeManagedSubagentTools: () => false,
      ...(sourceMcp ? { mcpBridge: sourceMcp.pi() } : {}),
      readBlob: async blob => ({ data: await readBlob(blob), mimeType: blob.mimeType }),
      settings: { compaction: { enabled: false }, retry: { enabled: false } }, environment: { MODEL_NODE_KEY: "model-node-private-key" },
      providers: [{ id: "provider", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "MODEL_NODE_KEY",
        models: [{ id: "native-model", contextWindow: 32768, maxTokens: 1024, input: ["text", "image"] }] }] });
    } }) });
  const client = new HostedAgentConnectClient(createClient(HostedAgentService, createRouterTransport(router => {
    router.service(HostedAgentService, createHostedAgentConnectService({ host: nativeHost, authenticate: () => principal }));
  })), principal.assertCurrent);
  const sourceId = "paired-native-instance", modelDescriptor = { providerId: "provider", modelId: "native-model", displayName: "Native model", api: "openai-completions",
    contextWindow: 32768, maxOutputTokens: 1024, supportsImages: true, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const capabilities: Capability[] = ["session.resume", "session.detach", "turn.stream", "turn.abort", "turn.steer", "turn.follow_up", "input.text", "model.list", "model.switch",
    "input.image", "permission.change", "context.usage", "context.compact", "context.auto_compact", "context.auto_retry", "runtime.tools", "runtime.user_shell"].map(key => ({ key, supported: true }));
  capabilities.push({ key: "permission.modes", supported: true, options: ["ask", "bypassPermissions"] });
  capabilities.push({ key: "workspace.extra_dirs", supported: true }, { key: "runtime.resources", supported: true, options: ["skill", "prompt"] },
    { key: "input.mention", supported: true, options: ["resource"] }, { key: "input.file", supported: true }, { key: "tool.mcp", supported: true });
  const descriptor: BackendDescriptor = { id: sourceId, adapterKind: "hosted", instanceGeneration: 1, displayName: "Native model on paired device", version: "1",
    health: "healthy", installationState: "installed", authenticationState: "authenticated", capabilities: new Map(capabilities.map(capability => [capability.key, capability])),
    models: [modelDescriptor], tools: [], diagnostics: [] };
  let database: OperationalStore | undefined, sourceHost: SessionHost | undefined, adapter: HostedAgentSourceAdapter | undefined, poller: HostedAgentPoller | undefined;
  let routerForCleanup: McpRouter | undefined, memoryForCleanup: MakerMemoryController | undefined;
  let sessionId = "", retainedBinding = "";
  const startSource = async () => {
    database = new OperationalStore(join(root, "source.sqlite"));
    const store = database, artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
    const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, "vault.key")), storagePath: join(root, "credentials.json") }); await credentials.initialize();
    const router = routerForCleanup = new McpRouter({ store, credentials }); await router.initialize();
    const memory = memoryForCleanup = new MakerMemoryController({ store }); router.registerBridgeToolProvider(new MakerMemoryBridgeProvider(memory));
    router.registerBridgeToolProvider({ id: "original_tools", generation: 1, available: true,
      tools: [{ serverId: "original_tools", name: "owner_echo", description: "Original root tool", inputSchema: { type: "object", properties: {} }, requiresPermission: false, requiresNativeRoot: true }],
      callTool: async (_name, _args, _signal, context) => { context.assertCurrent?.(); context.assertNativeRoot?.(); expect(context.targetId).toBe("original-target"); expect(context.sessionId).toBe(sessionId);
        return { content: [{ type: "text", text: "ORIGINAL_ROOT_MCP_BYTES" }], isError: false }; } });
    await artifacts.initialize(); poller = new HostedAgentPoller(client); const sharedPoller = poller;
    const assertContext = (context: AdapterContext) => {
      if (context.target.id !== "original-target" || context.target.workspaceRoot !== workspace) throw new Error("Wrong Source authority.");
    };
    const attachments = new HostedAgentSourceAttachments({ store, root: join(root, "incoming", "inputs"), resolveFile: blob => artifacts.resolveBlobPath(blob), assertContext,
      resolveArtifactMention: createArtifactMentionResolver({ store, artifacts, resolveTarget: session => store.getTarget(session.descriptor.targetId).descriptor, assertBackendCurrent: assertContext }) });
    await attachments.initialize();
    const readPolicy = (context: AdapterContext, shadow: string): HostedAgentExecutorPolicy => ({ revision: "original-policy", permissionMode: "bypassPermissions",
      planMode: false, approvedRoots: [...context.extraDirectories ?? [], ...attachments.authority(context, shadow).files.map((file, index) => ({ id: `input-${index}`, path: file.path, access: "read_only" as const }))], confirmCredentials: true });
    const resources = new HostedAgentSourceResources();
    const mcps = new Map<number, HostedAgentSourceMcp>();
    adapter = new HostedAgentSourceAdapter({ id: sourceId, source: { targetDeviceId: "model-node", backendId: "pi", controllerDeviceId: principal.deviceId },
      onRuntimeUnavailable: context => sourceHost?.invalidateRuntime({ backendId: sourceId,
        backendInstanceGeneration: context.backendInstanceGeneration!, sessionId: context.sessionId, generation: context.generation }),
      describe: () => descriptor, assertContext, resources: context => resources.resources(context), releaseWorkspace: async context => { await mcps.get(context.generation)?.close(); mcps.delete(context.generation); await attachments.release(context); await resources.release(context); },
      deleteWorkspace: context => attachments.forget(context.sessionId),
      prepareInput: (input, context, shadow) => prepareSourceWorkspaceInput(input, context, { shadow, workspaceId: "original-target", resources, assertCurrent: () => assertContext(context), attachments: attachments.begin(context, shadow) }),
      workspace: async context => { await attachments.capture(context); mcps.set(context.generation, new HostedAgentSourceMcp({ store, router, context, assertCurrent: () => assertContext(context), includeToolPolicy: () => true }));
        return { platform: process.platform as "win32" | "linux" | "darwin", shell: "bash", isGitRepository: false, mcpEnabled: true, memoryInstructions: memory.runtimePrompt(context.target.id),
        additionalDirectoryIds: (context.extraDirectories ?? []).map(hostedDirectoryId),
        contextFiles: [...await snapshotSourceInstructions(context, { nativeKind: "pi", assertCurrent: () => assertContext(context),
          files: await snapshotSourceProjectFiles(context, { assertCurrent: () => assertContext(context) }) }),
          ...resources.capture(context, [{ id: "source-approved", kind: "prompt", name: "Source advice", revision: "sha256:source-advice", resourceVersion: 1n,
            content: "SOURCE_APPROVED_PROMPT: inspect the original task files.", assertCurrent: () => assertContext(context) }])] }; },
      readPolicy: () => ({ permissionMode: "bypassPermissions", fastMode: false }), capture: async runId => ({ client, assertCurrent: principal.assertCurrent,
        close: () => client.close(runId, new AbortController().signal),
        createController: input => createHostedAgentSourceController({ ...input, poller: sharedPoller, temporaryRoot: join(root, "incoming"), readPolicy: context => readPolicy(context, input.shadow),
          mcp: mcps.get(input.context.generation)!,
          aliases: context => attachments.authority(context, input.shadow).aliases, inputFiles: context => attachments.authority(context, input.shadow).files,
          readBlob: async blob => (await artifacts.readBlob(blob)).data,
          assertContext, assertCurrent: principal.assertCurrent }) }) });
    const registry = new BackendInstanceRegistry(store);
    await registry.provision([{ instanceId: sourceId, adapterKind: "hosted", displayName: descriptor.displayName, create: () => adapter! }]);
    sourceHost = new SessionHost(store, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true });
    await sourceHost.initialize();
    await sourceHost.registerTarget({ id: "original-target", backendId: sourceId, displayName: "Original workspace", workspaceRoot: workspace, managed: true, trusted: true });
    return { store, host: sourceHost, adapter, artifacts, router, memory };
  };
  try {
    let source = await startSource();
    source.memory.write("original-target", { kind: "project", name: "source-seed", title: "Source seed", description: "SOURCE_MEMORY_INDEX_FROM_ORIGINAL", body: "Source seed body" });
    const connection = source.store.createConnection({ id: "owner-connection", name: "Original device", authKeyDigest: "digest" });
    await source.host.extraDirectories.add({ workspaceId: "original-target", serverPath: additional, access: "read_only" });
    sessionId = (await source.host.createSession({ operationId: "source-create", connection, targetId: "original-target", title: "Original task",
      providerId: "provider", modelId: "native-model", permissionMode: "bypassPermissions", planMode: false, fastMode: false })).value.sessionId;
    retainedBinding = source.store.getSession(sessionId).descriptor.binding.opaqueRef;
    expect(JSON.parse(retainedBinding)).toMatchObject({ format: 1, backendId: sourceId, sessionId, source: { targetDeviceId: "model-node", controllerDeviceId: principal.deviceId } });
    expect(retainedBinding).not.toContain(modelRoot); expect(retainedBinding).not.toContain("model-node-private-key");
    const image = await source.artifacts.ingestBytes(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), { fileName: "input.png", mimeType: "image/png" });
    const imageBlob = { id: image.id, sha256: image.sha256, byteLength: image.byteLength, mimeType: image.mimeType, fileName: image.fileName! };
    const upload = await source.artifacts.ingestBytes(Buffer.from("RETAINED_SOURCE_UPLOAD"), { fileName: "upload.txt", mimeType: "text/plain" });
    const uploadBlob = source.store.getArtifact(upload.id).blob;
    for (const operationId of ["first-source-turn", "restored-source-turn"]) {
      const resource = (await source.host.getResources(sessionId)).find(value => value.id === "source-approved")!;
      expect(resource.state).toBe("loaded");
      const input = { operationId, sessionId, connection, prompt: { text: "Read the original files and the retained upload.", images: [{ blob: imageBlob }], files: operationId === "first-source-turn" ? [{ blob: uploadBlob }] : [],
        mentions: [{ kind: "resource" as const, reference: resource.id, label: resource.name, discoveredRevision: resource.revision!, resourceVersion: resource.resourceVersion!.toString(), runtimeGeneration: resource.runtimeGeneration! }], disposition: "prompt" as const } };
      const accepted = source.host.enqueueInput(input).value; source.host.requestQueueDrain(sessionId);
      await vi.waitFor(() => expect(source.store.getQueueItem(accepted.queueItemId).state).toBe("completed"), { timeout: 30_000 });
      const events = source.store.listEvents({ sessionId, limit: 1000 });
      expect(events.some(event => event.payload.type === "done" && event.runId === accepted.runId)).toBe(true);
      expect(events.filter(event => event.payload.type === "error")).toEqual([]);
      expect(source.store.getSession(sessionId).descriptor.binding.opaqueRef).toBe(retainedBinding);
      expect(await readFile(join(workspace, "proof.txt"), "utf8")).toBe("ORIGINAL_WORKSPACE_BYTES");
      if (operationId === "first-source-turn") {
        expect(source.store.findMakerMemoryEntry("original-target", "project", "source-proof")?.body).toBe("ORIGINAL_MEMORY_BODY");
        expect(modelRequests).toBe(2); await source.host.dispose(); await poller?.close(); await source.router.dispose(); source.memory.dispose(); source.store.close(); database = undefined; sourceHost = undefined;
        source = await startSource(); expect(source.store.getSession(sessionId).descriptor.binding.opaqueRef).toBe(retainedBinding);
      }
    }
    expect(modelRequests).toBe(4);
    expect(imageRequests).toBe(4);
    expect(source.store.listSettingsByKeyPrefix("service", "hosted-inputs.v1", "")).toHaveLength(1);
    enabled = false; await nativeHost.sweep();
    const last = source.host.enqueueInput({ operationId: "paused-source-turn", sessionId, connection,
      prompt: { text: "Do not select a local substitute.", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
    source.host.requestQueueDrain(sessionId);
    await vi.waitFor(() => expect(source.store.getQueueItem(last.queueItemId).state).toBe("failed"), { timeout: 15_000 });
    expect(modelRequests).toBe(4); expect(source.store.getSession(sessionId).descriptor.backendId).toBe(sourceId);
    enabled = true; await source.host.resume(sessionId);
    await source.host.deleteNativeSession(sessionId, "delete-source-native");
    expect(slots.summary().total).toBe(0); expect(modelRequests).toBe(4);
    expect(source.store.listSettingsByKeyPrefix("service", "hosted-inputs.v1", "")).toEqual([]);
    expect(await readFile(upload.storagePath, "utf8")).toBe("RETAINED_SOURCE_UPLOAD");
    expect(await readFile(join(workspace, "proof.txt"), "utf8")).toBe("ORIGINAL_WORKSPACE_BYTES");
  } finally {
    await sourceHost?.dispose(); await adapter?.dispose(); await poller?.close(); await routerForCleanup?.dispose(); memoryForCleanup?.dispose(); database?.close(); await nativeHost.dispose(); nativeDatabase.close();
    model.closeAllConnections(); await new Promise<void>(closed => model.close(() => closed()));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
