import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
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
import { createHostedAgentClaudeAdapter } from "./hosted-agent-claude-factory.js";
import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { SessionHost } from "./session-host.js";

describe("Claude native Source product Session", () => {
  it("uses the durable product Queue, Source image and MCP, and persisted native history before closing the real SDK", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-claude-source-session-"))), workspace = join(root, "workspace"), nativeRoot = join(root, "model-node");
    await mkdir(workspace); await mkdir(nativeRoot);
    const requests: Record<string, unknown>[] = [], headers: Headers[] = [];
    const selectedModel: ProviderModel = { providerId: "claude-code", modelId: "claude-sonnet-4-6", displayName: "Native model", api: "anthropic-messages",
      contextWindow: 200000, maxOutputTokens: 16384, supportsImages: true, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const sourceStore = new OperationalStore(join(root, "source.sqlite")), nativeStore = new OperationalStore(join(root, "native.sqlite")), slots = new HostedAgentSessionSlots();
    const vault = await CredentialVault.open(join(root, "vault.key")), credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") }); await credentials.initialize();
    const providers = new ProviderCatalogManager({ store: nativeStore, credentials, nativeBackendId: "native-owner" }); providers.initialize();
    const gate = createCommandConcurrencyGate({ readMaximum: () => 1 });
    const principal = { id: "source-hub", deviceId: "source-device", trust: "owner" as const, assertCurrent: () => undefined };
    let created = 0, nativeWorkspace = "", nativeRunId = "", dispatchFingerprint = "";
    const nativeFailures: unknown[] = [], token = "sk-ant-oat01-controlled-source-queue-account";
    const serialized = JSON.stringify({ format: 1, type: "oauth", accessToken: token, refreshToken: "controlled-source-refresh", expiresAt: Date.now() + 60 * 60_000,
      scopes: ["user:inference"], subscriptionType: "max", rateLimitTier: "default_claude_max_5x" });
    const assertModelAllowed = (providerId: string, modelId: string) => {
      if (providerId !== selectedModel.providerId || modelId !== selectedModel.modelId) throw new Error("The selected native model is unavailable.");
    };
    const nativeHost = new HostedAgentHost({ authorize: () => ({ root: nativeRoot, store: new HostedAgentStore(nativeStore), slots, artifactCapacityBytes: 1024 * 1024,
      modelIds: [selectedModel.modelId], assertCurrent: () => undefined, assertModelAllowed,
      createAdapter: async creation => {
        expect(creation.nativeOwner.backendInstanceGeneration).toBe(1); created++; nativeWorkspace = creation.execution.workspace.root;
        const adapter = await createHostedAgentClaudeAdapter({ creation: { ...creation, providerIds: [selectedModel.providerId], assertModelAllowed },
          backendId: "claude-code", providers, credentialPort: { readSerialized: async () => serialized, compareAndSet: async () => false,
            restoreExact: async () => false, deleteExact: async () => false },
          environment: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", ENABLE_TOOL_SEARCH: "false" },
          fetch: (async (url, init) => {
            expect(String(url).startsWith("https://api.anthropic.com/v1/messages")).toBe(true);
            if (String(url).includes("count_tokens")) return new Response('{"input_tokens":5}', { headers: { "content-type": "application/json" } });
            const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")) as Record<string, unknown>; requests.push(body); headers.push(new Headers(init?.headers));
            const tools = body.tools as { name: string }[], name = tools.find(tool => tool.name.endsWith("__Write"))?.name;
            const used = JSON.stringify(body.messages).includes("created successfully");
            return modelResponse(body, requests.length, !used && name ? [{ type: "tool_use", id: "source-queue-write", name,
              input: { file_path: join(nativeWorkspace, "queue-proof.txt"), content: "ORIGINAL SOURCE QUEUE" } }] : [{ type: "text", text: "ORIGINAL SOURCE QUEUE" }]);
          }) as typeof fetch });
        const create = adapter.createSession.bind(adapter);
        adapter.createSession = async (input, context) => { try { return await create(input, context); } catch (error) { nativeFailures.push(error); throw error; } };
        const send = adapter.sendWithDurableNativeDispatchFence.bind(adapter);
        adapter.sendWithDurableNativeDispatchFence = (input, context, persist) => send(input, context, async preparation => {
          expect(preparation.nativeHistory.activeLineage).toEqual([]); dispatchFingerprint = preparation.inputFingerprint;
          expect(requests).toHaveLength(0); await persist(preparation); expect(requests).toHaveLength(0);
        });
        return adapter;
      } }) });
    const nativeCall = nativeHost.call.bind(nativeHost);
    nativeHost.call = async (...args) => { try { return await nativeCall(...args); } catch (error) { nativeFailures.push(error); throw error; } };
    const client = new HostedAgentConnectClient(createClient(HostedAgentService, createRouterTransport(router => router.service(HostedAgentService,
      createHostedAgentConnectService({ host: nativeHost, authenticate: () => principal })))), principal.assertCurrent);
    const poller = new HostedAgentPoller(client), sourceId = "source-native-claude";
    const capabilities: Capability[] = ["session.resume", "session.detach", "turn.stream", "turn.abort", "turn.follow_up", "input.text", "input.image", "model.list", "model.switch",
      "permission.change", "context.usage", "runtime.tools"].map(key => ({ key, supported: true }));
    capabilities.push({ key: "permission.modes", supported: true, options: ["ask", "bypassPermissions"] });
    const descriptor: BackendDescriptor = { id: sourceId, adapterKind: "hosted", instanceGeneration: 1, displayName: "Claude on paired device", version: "0.3.280",
      installationState: "installed", health: "healthy", authenticationState: "authenticated", capabilities: new Map(capabilities.map(capability => [capability.key, capability])),
      models: [selectedModel], tools: [], diagnostics: [] };
    const assertContext = (context: AdapterContext) => { if (context.target.id !== "original-target" || context.target.workspaceRoot !== workspace) throw new Error("Wrong task Source."); };
    let sourceArtifacts: ArtifactStore;
    const adapter = new HostedAgentSourceAdapter({ id: sourceId, source: { controllerDeviceId: principal.deviceId, targetDeviceId: "model-node", backendId: "claude-code" },
      describe: () => descriptor, assertContext, workspace: () => ({ platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false }),
      readPolicy: () => ({ permissionMode: "bypassPermissions", fastMode: false }), capture: async runId => { nativeRunId = runId; return { client, assertCurrent: principal.assertCurrent,
        close: () => client.close(runId, new AbortController().signal), createController: input => createHostedAgentSourceController({ ...input, poller,
          temporaryRoot: join(root, "incoming"), assertCurrent: principal.assertCurrent, assertContext, commandConcurrencyGate: gate,
          readBlob: async blob => (await sourceArtifacts.readBlob(blob)).data,
          readPolicy: () => ({ revision: "source-policy", permissionMode: "bypassPermissions", planMode: false, approvedRoots: [], confirmCredentials: true }) }) }; } });
    const registry = new BackendInstanceRegistry(sourceStore);
    let host: SessionHost | undefined;
    try {
      await registry.provision([{ instanceId: sourceId, adapterKind: "hosted", displayName: descriptor.displayName, create: () => adapter }]);
      const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(sourceStore), ingestRoots: [root] }); await artifacts.initialize();
      sourceArtifacts = artifacts;
      host = new SessionHost(sourceStore, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true });
      await host.initialize(); await host.registerTarget({ id: "original-target", backendId: sourceId, displayName: "Original workspace", workspaceRoot: workspace, managed: true, trusted: true });
      const connection = sourceStore.createConnection({ id: "owner", name: "Task Source", authKeyDigest: "fixture-digest" });
      const createdSession = await host.createSession({ operationId: "create-native-source", connection, targetId: "original-target", title: "Claude Source task", providerId: selectedModel.providerId,
        modelId: selectedModel.modelId, permissionMode: "bypassPermissions", planMode: false, fastMode: false }).catch(error => {
          throw new Error(JSON.stringify({ source: error.storedError, native: nativeFailures.map(error => error instanceof Error ? { ...error, message: error.message } : error) }));
        });
      const sessionId = createdSession.value.sessionId, binding = sourceStore.getSession(sessionId).descriptor.binding.opaqueRef;
      expect(created).toBe(1); expect(slots.summary().total).toBe(1); expect(binding).not.toContain(nativeRoot);
      const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const image = await artifacts.ingestBytes(imageBytes, { fileName: "source.png", mimeType: "image/png" });
      const imageBlob = { id: image.id, sha256: image.sha256, byteLength: image.byteLength, mimeType: image.mimeType, fileName: image.fileName! };
      const admitted = host.enqueueInput({ operationId: "native-source-prompt", sessionId, connection,
        prompt: { text: "Write the controlled Source file and report its result.", images: [{ blob: imageBlob }], files: [], mentions: [], disposition: "prompt" } }).value;
      host.requestQueueDrain(sessionId);
      await vi.waitFor(() => expect(["completed", "failed"]).toContain(sourceStore.getQueueItem(admitted.queueItemId).state), { timeout: 40_000 });
      const queued = sourceStore.getQueueItem(admitted.queueItemId);
      expect({ state: queued.state, error: queued.error, errors: sourceStore.listEvents({ sessionId, limit: 1000 }).filter(event => event.payload.type === "error").map(event => event.payload),
        nativeFailures: nativeFailures.map(error => error instanceof Error ? { ...error, message: error.message } : error) })
        .toEqual({ state: "completed", error: undefined, errors: [], nativeFailures: [] });
      expect(requests).toHaveLength(2); expect(headers.every(header => header.get("authorization") === "Bearer " + token)).toBe(true);
      expect(JSON.stringify(requests[0])).toContain(imageBytes.toString("base64"));
      expect(await readFile(join(workspace, "queue-proof.txt"), "utf8")).toBe("ORIGINAL SOURCE QUEUE");
      await expect(readFile(join(nativeWorkspace, "queue-proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const events = sourceStore.listEvents({ sessionId, limit: 1000 });
      expect(events.some(event => event.payload.type === "done" && event.runId === admitted.runId)).toBe(true);
      expect(sourceStore.getSession(sessionId).descriptor.binding.opaqueRef).toBe(binding);
      expect(JSON.stringify(events.map(event => event.payload))).not.toContain(token); expect(gate.snapshot().running).toBe(0);
      const nativeHistory = await client.call(nativeRunId, randomUUID(), { kind: "history" }, new AbortController().signal) as NativeHistoryProjection;
      expect(nativeHistory.events.filter(event => event.projectionKind === "message_user").map(event => event.metadata?.fields["nativeDispatchFingerprint"]))
        .toContain(dispatchFingerprint);
      await host.dispose(); host = undefined; expect(slots.summary().total).toBe(0);
    } finally {
      await host?.dispose(); await adapter.dispose(); await poller.close(); await nativeHost.dispose(); gate.close(); sourceStore.close(); nativeStore.close();
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe native Source cleanup.");
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 90_000);
});

function modelResponse(body: Record<string, unknown>, count: number, content: ({ type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "text"; text: string })[]): Response {
  const stop = content[0]?.type === "tool_use" ? "tool_use" : "end_turn";
  const message = { id: "source-queue-message-" + count, type: "message", role: "assistant", model: "claude-sonnet-4-6", content,
    stop_reason: stop, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
  if (body.stream === false) return new Response(JSON.stringify(message), { headers: { "content-type": "application/json" } });
  const events: Record<string, unknown>[] = [{ type: "message_start", message: { ...message, content: [], stop_reason: null } }];
  content.forEach((block, index) => {
    if (block.type === "tool_use") events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    else events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  return new Response(events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
