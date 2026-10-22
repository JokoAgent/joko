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

it("dispatches the durable product queue through a native Source Adapter and restores the exact native owner after Source restart", { timeout: 90_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-product-native-"))), workspace = join(root, "workspace"), modelRoot = join(root, "model-node");
  await mkdir(workspace); await mkdir(modelRoot); await writeFile(join(workspace, "proof.txt"), "ORIGINAL_WORKSPACE_BYTES");
  await writeFile(join(workspace, "AGENTS.md"), "SOURCE_PROJECT_GUIDANCE: preserve the original task workspace.");
  let modelRequests = 0;
  let imageRequests = 0;
  const complete = (response: ServerResponse, tool: boolean) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: `native-${modelRequests}`, object: "chat.completion.chunk", created: 1, model: "native-model",
      choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [{ index: 0, id: `read-${modelRequests}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: "proof.txt" }) } }] }
        : { role: "assistant", content: "The original workspace contains ORIGINAL_WORKSPACE_BYTES." }, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  };
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.headers.authorization).toBe("Bearer model-node-private-key");
    const body = Buffer.concat(chunks).toString(); modelRequests++;
    expect(body).toContain("SOURCE_PROJECT_GUIDANCE");
    if (body.includes("data:image/png;base64,")) imageRequests++;
    if (modelRequests % 2 === 0) expect(body).toContain("ORIGINAL_WORKSPACE_BYTES");
    complete(response, modelRequests % 2 === 1);
  });
  await new Promise<void>(ready => model.listen(0, "127.0.0.1", ready));
  const address = model.address(); if (!address || typeof address === "string") throw new Error("Missing model listener.");
  const nativeDatabase = new OperationalStore(join(root, "native.sqlite")), slots = new HostedAgentSessionSlots();
  const nativeStore = new HostedAgentStore(nativeDatabase), principal = { id: "source-hub", deviceId: "original-device", trust: "owner" as const, assertCurrent: () => {} };
  let enabled = true;
  const nativeHost = new HostedAgentHost({ authorize: () => ({ root: modelRoot, store: nativeStore, slots, artifactCapacityBytes: 1024 * 1024, modelIds: ["native-model"],
    assertCurrent: () => { if (!enabled) throw new Error("Provider access was paused."); },
    assertModelAllowed: (providerId, modelId) => { if (!enabled || providerId !== "provider" || modelId !== "native-model") throw new Error("Unavailable Provider model."); },
    createAdapter: async ({ home, readBlob, execution }) => {
      const instructions = execution.workspace.contextFiles?.find(file => file.path.endsWith(`${sep}AGENTS.md`));
      expect(instructions?.path).toBe(join(execution.workspace.root, "AGENTS.md"));
      expect(instructions?.path).not.toBe(join(workspace, "AGENTS.md"));
      expect(await readFile(instructions!.path, "utf8")).toContain("SOURCE_PROJECT_GUIDANCE");
      return createPiAdapter({ agentHome: home, sessionRoot: home, includeManagedSubagentTools: () => false,
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
  const descriptor: BackendDescriptor = { id: sourceId, adapterKind: "hosted", instanceGeneration: 1, displayName: "Native model on paired device", version: "1",
    health: "healthy", installationState: "installed", authenticationState: "authenticated", capabilities: new Map(capabilities.map(capability => [capability.key, capability])),
    models: [modelDescriptor], tools: [], diagnostics: [] };
  let database: OperationalStore | undefined, sourceHost: SessionHost | undefined, adapter: HostedAgentSourceAdapter | undefined, poller: HostedAgentPoller | undefined;
  let sessionId = "", retainedBinding = "";
  const startSource = async () => {
    database = new OperationalStore(join(root, "source.sqlite"));
    const store = database, artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
    await artifacts.initialize(); poller = new HostedAgentPoller(client); const sharedPoller = poller;
    const assertContext = (context: AdapterContext) => {
      if (context.target.id !== "original-target" || context.target.workspaceRoot !== workspace) throw new Error("Wrong Source authority.");
    };
    const readPolicy = (_context: AdapterContext): HostedAgentExecutorPolicy => ({ revision: "original-policy", permissionMode: "bypassPermissions",
      planMode: false, approvedRoots: [], confirmCredentials: true });
    adapter = new HostedAgentSourceAdapter({ id: sourceId, source: { targetDeviceId: "model-node", backendId: "pi", controllerDeviceId: principal.deviceId },
      onRuntimeUnavailable: context => sourceHost?.invalidateRuntime({ backendId: sourceId,
        backendInstanceGeneration: context.backendInstanceGeneration!, sessionId: context.sessionId, generation: context.generation }),
      describe: () => descriptor, assertContext, workspace: async context => ({ platform: process.platform as "win32" | "linux" | "darwin", shell: "bash", isGitRepository: false,
        contextFiles: await snapshotSourceProjectFiles(context, { assertCurrent: () => assertContext(context) }) }),
      readPolicy: () => ({ permissionMode: "bypassPermissions", fastMode: false }), capture: async runId => ({ client, assertCurrent: principal.assertCurrent,
        close: () => client.close(runId, new AbortController().signal),
        createController: input => createHostedAgentSourceController({ ...input, poller: sharedPoller, temporaryRoot: join(root, "incoming"), readPolicy,
          readBlob: async blob => (await artifacts.readBlob(blob)).data,
          assertContext, assertCurrent: principal.assertCurrent }) }) });
    const registry = new BackendInstanceRegistry(store);
    await registry.provision([{ instanceId: sourceId, adapterKind: "hosted", displayName: descriptor.displayName, create: () => adapter! }]);
    sourceHost = new SessionHost(store, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true });
    await sourceHost.initialize();
    await sourceHost.registerTarget({ id: "original-target", backendId: sourceId, displayName: "Original workspace", workspaceRoot: workspace, managed: true, trusted: true });
    return { store, host: sourceHost, adapter, artifacts };
  };
  try {
    let source = await startSource();
    const connection = source.store.createConnection({ id: "owner-connection", name: "Original device", authKeyDigest: "digest" });
    sessionId = (await source.host.createSession({ operationId: "source-create", connection, targetId: "original-target", title: "Original task",
      providerId: "provider", modelId: "native-model", permissionMode: "bypassPermissions", planMode: false, fastMode: false })).value.sessionId;
    retainedBinding = source.store.getSession(sessionId).descriptor.binding.opaqueRef;
    expect(JSON.parse(retainedBinding)).toMatchObject({ format: 1, backendId: sourceId, sessionId, source: { targetDeviceId: "model-node", controllerDeviceId: principal.deviceId } });
    expect(retainedBinding).not.toContain(modelRoot); expect(retainedBinding).not.toContain("model-node-private-key");
    const image = await source.artifacts.ingestBytes(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), { fileName: "input.png", mimeType: "image/png" });
    const imageBlob = { id: image.id, sha256: image.sha256, byteLength: image.byteLength, mimeType: image.mimeType, fileName: image.fileName! };
    for (const operationId of ["first-source-turn", "restored-source-turn"]) {
      const input = { operationId, sessionId, connection, prompt: { text: "Read proof.txt and report its contents.", images: [{ blob: imageBlob }], files: [], mentions: [], disposition: "prompt" as const } };
      const accepted = source.host.enqueueInput(input).value; source.host.requestQueueDrain(sessionId);
      await vi.waitFor(() => expect(source.store.getQueueItem(accepted.queueItemId).state).toBe("completed"), { timeout: 30_000 });
      const events = source.store.listEvents({ sessionId, limit: 1000 });
      expect(events.some(event => event.payload.type === "done" && event.runId === accepted.runId)).toBe(true);
      expect(events.filter(event => event.payload.type === "error")).toEqual([]);
      expect(source.store.getSession(sessionId).descriptor.binding.opaqueRef).toBe(retainedBinding);
      expect(await readFile(join(workspace, "proof.txt"), "utf8")).toBe("ORIGINAL_WORKSPACE_BYTES");
      if (operationId === "first-source-turn") {
        expect(modelRequests).toBe(2); await source.host.dispose(); await poller?.close(); source.store.close(); database = undefined; sourceHost = undefined;
        source = await startSource(); expect(source.store.getSession(sessionId).descriptor.binding.opaqueRef).toBe(retainedBinding);
      }
    }
    expect(modelRequests).toBe(4);
    expect(imageRequests).toBe(4);
    enabled = false; await nativeHost.sweep();
    const last = source.host.enqueueInput({ operationId: "paused-source-turn", sessionId, connection,
      prompt: { text: "Do not select a local substitute.", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
    source.host.requestQueueDrain(sessionId);
    await vi.waitFor(() => expect(source.store.getQueueItem(last.queueItemId).state).toBe("failed"), { timeout: 15_000 });
    expect(modelRequests).toBe(4); expect(source.store.getSession(sessionId).descriptor.backendId).toBe(sourceId);
    enabled = true; await source.host.resume(sessionId);
    await source.host.deleteNativeSession(sessionId, "delete-source-native");
    expect(slots.summary().total).toBe(0); expect(modelRequests).toBe(4);
    expect(await readFile(join(workspace, "proof.txt"), "utf8")).toBe("ORIGINAL_WORKSPACE_BYTES");
  } finally {
    await sourceHost?.dispose(); await adapter?.dispose(); await poller?.close(); database?.close(); await nativeHost.dispose(); nativeDatabase.close();
    model.closeAllConnections(); await new Promise<void>(closed => model.close(() => closed()));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
