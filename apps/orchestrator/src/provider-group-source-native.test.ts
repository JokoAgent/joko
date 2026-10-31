import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { createPiAdapter, type PiMcpBridgeOptions } from "@joko/adapter-pi";
import { createInProcessDevicePeerHarness, NodeDevicePeerAgentExecutor } from "@joko/device-peer";
import { HostedAgentStore, OperationalStore, type ConnectionRecord } from "@joko/store";
import { expect, it, vi } from "vitest";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { createArtifactMentionResolver } from "./artifact-mention-resolver.js";
import { SessionHost } from "./session-host.js";
import { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { HostedAgentSources } from "./hosted-agent-sources.js";
import { DevicePeerOwner } from "./device-peer-owner.js";
import { ConnectionManager } from "./connection-manager.js";
import { createHostedAgentPeerPort } from "./hosted-agent-peer-port.js";
import { withProviderGroupPeerPort } from "./provider-group-peer.js";
import { ProviderGroupRuntime, providerGroupDefaultMember } from "./provider-group-runtime.js";
import { createProviderGroupHostedEndpoint } from "./provider-group-hosted.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import type { HostedAgentPrincipal } from "./hosted-agent-host.js";
import { providerSharingBackendId, type ProviderSharingDirectoryPort, type ProviderSharingReceivedIdentity } from "./provider-sharing-ports.js";
import { mkdtemp } from "./test-paths.js";
import { PiResourceManager } from "./resource-manager.js";
import { HostedAgentSourceResourceCatalog } from "./hosted-agent-source-resource-catalog.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { McpRouter } from "./mcp-router.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-group-source-native-")), calls: { node: string; body: string }[] = [], nativeTrust: { node: string; trust: string; guestHome?: string }[] = [], mcpCalls: string[] = [];
  let failA = false;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString(), node = request.url!.split("/")[1]!;
    calls.push({ node, body }); expect(request.headers.authorization).toBe(`Bearer private-${node}`);
    if (node === "A" && failA) { response.writeHead(529, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "overloaded_error at capacity", type: "overloaded_error" } })); return; }
    const messages = JSON.parse(body).messages as { role: string; content: unknown }[], latestUser = messages.map(message => message.role).lastIndexOf("user");
    const userText = messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content.map(part => typeof part?.text === "string" ? part.text : "").join("\n") : "").join("\n");
    const paths = [...new Set([...userText.matchAll(/(?:Workspace file reference|Attached file|Artifact reference):[^\n]*\nPath: ([^\r\n]+)/gu)].map(match => match[1]!))];
    if (!paths.some(path => /[\\/]proof\.txt$/u.test(path))) paths.unshift("proof.txt");
    const hasTool = messages.slice(latestUser + 1).some(message => message.role === "tool");
    const tool = !hasTool;
    response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ id: `turn-${calls.length}`, object: "chat.completion.chunk", created: 1, model: "model",
      choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [...(paths.length ? paths : ["proof.txt"]).map((path, index) => ({ index, id: `read-${calls.length}-${index}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path }) } })),
        { index: paths.length, id: `source-mcp-${calls.length}`, type: "function", function: { name: "mcp__original_tools__owner_echo", arguments: "{}" } }] }
        : { role: "assistant", content: `Executed on ${node}: ORIGINAL_SOURCE_BYTES` }, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve)); const address = model.address(); if (!address || typeof address === "string") throw new Error("No native model port.");
  const port = address.port;
  const nodes: Node[] = [];
  interface Node { id: string; root: string; store: OperationalStore; registry: BackendInstanceRegistry; host: SessionHost; sources: HostedAgentSources; peers: DevicePeerOwner;
    native: HostedAgentRuntime; groups: ProviderGroupRuntime; artifacts: ArtifactStore; connection: ConnectionRecord; close(): Promise<void>; }
  async function node(id: string, sharing?: ProviderSharingDirectoryPort): Promise<Node> {
    const directory = join(root, id); await mkdir(directory); const workspace = join(directory, "workspace"); await mkdir(workspace); await writeFile(join(workspace, "proof.txt"), "ORIGINAL_SOURCE_BYTES");
    const store = new OperationalStore(join(directory, "store.db")), registry = new BackendInstanceRegistry(store), peers = new DevicePeerOwner({ store });
    const credentials = new CredentialManager({ vault: await CredentialVault.open(join(directory, "vault.key")), storagePath: join(directory, "credentials.json") }); await credentials.initialize();
    const router = new McpRouter({ store, credentials }); await router.initialize();
    router.registerBridgeToolProvider({ id: "original_tools", generation: 1, available: true,
      tools: [{ serverId: "original_tools", name: "owner_echo", description: "Original task tool", inputSchema: { type: "object", properties: {} }, requiresPermission: false, requiresNativeRoot: true }],
      callTool: async (_name, _args, _signal, context) => { context.assertCurrent?.(); context.assertNativeRoot?.(); mcpCalls.push(id);
        return { content: [{ type: "text", text: `ORIGINAL_MCP_${id}` }], isError: false }; } });
    // Match the application factory: each Adapter owns its generation while
    // derived native contexts retain the same durable Session root.
    const makePi = (home: string, mcpBridge?: PiMcpBridgeOptions) => createPiAdapter({ agentHome: join(home, "provider-snapshots", randomUUID()), sessionRoot: home, includeManagedSubagentTools: () => false,
      ...(mcpBridge ? { mcpBridge } : { resolveMcpBridge: () => undefined }),
      settings: { compaction: { enabled: false }, retry: { enabled: false } }, environment: { NATIVE_KEY: `private-${id}` },
      providers: [{ id: "provider", api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/${id}/v1`, apiKeyEnv: "NATIVE_KEY",
        models: [{ id: "model", contextWindow: 32768, maxTokens: 1024, input: ["text"] }] }] });
    const local = makePi(join(directory, "owner")); await registry.provision([{ instanceId: local.id, adapterKind: "pi", displayName: "Native " + id, create: () => local }]);
    const resources = new PiResourceManager({ store, managedRoot: join(directory, "resources") }); await resources.initialize();
    const advice = join(directory, "source-advice.md"); await writeFile(advice, `ORIGINAL_GLOBAL_ADVICE_${id}`);
    const approved = await resources.discover({ id: "original-advice-" + id, backendId: local.id, kind: "prompt", scope: "global", source: { kind: "local", path: advice } });
    await resources.approve(approved.id, approved.discoveredRevision, "owner-" + id); await resources.install(approved.id); await resources.setEnabled(approved.id, true);
    const sourceResources = new HostedAgentSourceResourceCatalog({ store, resources, nativeBackends: new Map([["pi", local.id]]) });
    const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [directory] }); await artifacts.initialize();
    const host = new SessionHost(store, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true }); await host.initialize();
    const connection = store.createConnection({ id: "controller-" + id, deviceId: "device-" + id, name: "Owner " + id, authKeyDigest: "digest-" + id,
      device: { defaultName: "Computer " + id, kind: "service", platform: process.platform } });
    let groups!: ProviderGroupRuntime;
    const native = new HostedAgentRuntime({ store, nodeId: id, connections: new ConnectionManager(store), root: join(directory, "native"), artifactCapacityBytes: 1024 * 1024,
      decorateCatalog: catalog => groups?.decorateCatalog(catalog) ?? catalog, resolveSharedProvider: (backend, provider) => groups?.sharedProvider(backend, provider),
      factories: [{ backendId: local.id, providerIds: () => ["provider"], models: () => registry.get(local.id).descriptor.models.filter(model => model.providerId === "provider"),
        capabilities: () => registry.get(local.id).descriptor.capabilities, describe: () => registry.get(local.id).descriptor, isolatedGuests: () => true, create: creation => {
          nativeTrust.push({ node: id, trust: creation.trust, ...(creation.execution.trust === "guest" ? { guestHome: creation.execution.guestHome } : {}) }); return makePi(creation.home, creation.sourceMcp?.pi());
        } }] });
    let permissions = native.settings.update({ kind: "remote_control", enabled: true }, 0n); native.settings.update({ kind: "provider", backendId: local.id, providerId: "provider", enabled: true }, permissions.revision);
    const resolveArtifactMention = createArtifactMentionResolver({ store, artifacts, resolveTarget: session => ({ ...store.getTarget(session.descriptor.targetId).descriptor, backendId: session.descriptor.backendId }),
      assertBackendCurrent: context => { if (registry.get(context.target.backendId).generation !== context.backendInstanceGeneration) throw new Error("The original Backend changed."); } });
    const sources = new HostedAgentSources({ store, peers, registry, host, sourceDeviceId: "device-" + id, temporaryRoot: join(directory, "incoming"), ...(sharing ? { sharing } : {}),
      mcpRouter: router, resolveMemoryPrompt: () => `ORIGINAL_MEMORY_INDEX_${id}`,
      resolveTextResources: (context, kind) => sourceResources.text(context, kind),
      resolveNativeSkills: (context, signal, kind) => sourceResources.skills(context, signal, kind),
      resolveFile: blob => artifacts.resolveBlobPath(blob),
      resolveArtifactMention,
      readBlob: async blob => (await artifacts.readBlob(blob)).data, readPolicy: () => ({ revision: "policy", permissionMode: "bypassPermissions", planMode: false, approvedRoots: [], confirmCredentials: true }) }); await sources.initialize();
    groups = new ProviderGroupRuntime({ store, registry, sources, nodeId: id, nodeName: () => "Computer " + id, sessions: host.providerGroupSessionPort(), ownerGeneration: () => "owner",
      readAccountUsage: async () => ({ providerId: "provider", observedAt: Date.now(), limitReached: false,
        primaryWindow: { usedPercent: id === "A" ? 12 : 89, windowMinutes: 300, resetAt: Date.now() + 4 * 60 * 60_000 },
        secondaryWindow: { usedPercent: id === "A" ? 24 : 91, windowMinutes: 10_080, resetAt: Date.now() + 3 * 24 * 60 * 60_000 } }),
      activeTurns: (backend, provider) => host.activeProviderTurns(backend, provider) + native.endpoint.activeProviderTurns(backend, provider),
      assertRemoteAllowed: key => { if (!native.settings.providerEnabled(key.backendId, key.providerId)) throw new Error("Disabled Provider."); },
      refreshSources: async signal => { signal.throwIfAborted(); await sources.refresh(connection); signal.throwIfAborted(); }, ...(sharing ? { sharing } : {}) }); host.installProviderGroupRuntime(groups);
    native.installEndpoint(createProviderGroupHostedEndpoint({ base: native.host, runtime: groups, root: join(directory, "native"), assertSelection: (principal, input) => native.assertGuestSelection(principal, input),
      capture: (member, principal, models, current) => groups.captureHosted(member, principal, models, current) }));
    await host.registerTarget({ id: "target", backendId: local.id, displayName: "Original", workspaceRoot: workspace, managed: false, trusted: true });
    const value: Node = { id, root: directory, store, registry, host, sources, peers, native, groups, artifacts, connection,
      close: async () => { await host.dispose(); await sources.close(); await native.close(); await groups.close(); await peers.shutdown(); await router.dispose(); store.close(); } }; nodes.push(value); return value;
  }
  async function pair(controller: Node, target: Node) {
    const device = controller.store.createConnection({ id: "peer-" + target.id, deviceId: "device-" + target.id, name: "Computer " + target.id, authKeyDigest: "peer-digest-" + target.id,
      device: { defaultName: "Computer " + target.id, kind: "service", platform: process.platform } }); controller.store.setDeviceRemoteControlEnabled(device.deviceId, true);
    const port = withProviderGroupPeerPort(createHostedAgentPeerPort(target.native, "service-" + controller.id), target.groups.connectOptions(() => { throw new Error("Peer principal is inserted by its owner."); }));
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(controller.root, "recent-" + target.id + ".json"), nativeAgents: port });
    const harness = createInProcessDevicePeerHarness({ targetDeviceId: device.deviceId, capabilities: ["native_agents"], agent: { handle: async (frame, signal) => {
      let payload: contract.DevicePeerAgentResult["payload"] | undefined;
      await executor.execute(frame.payload as contract.DevicePeerCommand, signal, async result => { if (result.phase === contract.DevicePeerResponsePhase.COMPLETED) payload = result.payload; }); return { outcome: "completed", value: payload };
    }, retire: () => executor.retire() } }); controller.peers.registerRoute(device, harness.transport); await controller.sources.refresh(controller.connection);
  }
  return { root, calls, nativeTrust, mcpCalls, node, pair, fail: (value: boolean) => { failA = value; }, close: async () => { for (const node of nodes.reverse()) await node.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true, maxRetries: 3 }); } };
}
it("runs same-owner C through B's group decision directly on A with the actual Source queue, SDK tools, load and usage reports", { timeout: 90_000 }, async () => {
  const f = await fixture(); try {
    const a = await f.node("A"), b = await f.node("B"), c = await f.node("C"); await f.pair(b, a); await f.pair(c, a); await f.pair(c, b);
    const key = { backendId: "pi", providerId: "provider" }, remoteA = b.groups.sources().find(source => source.nodeId === "A" && source.providerId === "provider")!;
    b.groups.store.update(key, { strategy: "ordered", autoSwitch: true, members: [providerGroupDefaultMember(remoteA), providerGroupDefaultMember(b.groups.sources().find(source => source.kind === "local" && source.providerId === "provider")!)] }, 0n);
    const quotaGroup = b.groups.store.snapshot(key), quotaSignal = new AbortController().signal;
    const remoteQuota = await b.groups.memberAccountUsage(key, quotaGroup.revision, remoteA.key, quotaSignal);
    expect(remoteQuota).toMatchObject({ state: 'ready', accountUsage: { primaryWindow: { usedPercent: 12 } } });
    const ownMember = quotaGroup.config!.members.find(member => member.kind === 'local')!;
    expect(await b.groups.memberAccountUsage(key, quotaGroup.revision, ownMember.key, quotaSignal))
      .toMatchObject({ state: 'ready', accountUsage: { primaryWindow: { usedPercent: 89 } } });
    const staleQuota = b.groups.memberAccountUsage(key, quotaGroup.revision, remoteA.key, quotaSignal);
    b.groups.store.update(key, { ...quotaGroup.config!, members: quotaGroup.config!.members.map(member => ({ ...member, weight: member.weight + 1 })) }, quotaGroup.revision);
    await expect(staleQuota).rejects.toThrow('changed');
    await c.sources.refresh(c.connection); const bSource = c.groups.sources().find(source => source.nodeId === "B" && source.providerId === "provider")!;
    await c.host.registerTarget({ id: "remote-target", backendId: bSource.backendId, displayName: "Original C", workspaceRoot: join(c.root, "workspace"), managed: false, trusted: true });
    c.store.upsertTarget(c.store.getTarget("remote-target").descriptor, { workspaceId: "original-project-workspace" });
    const created = await c.host.createSession({ operationId: "owner-group-create", connection: c.connection, targetId: "remote-target", title: "Keep original C", providerId: "provider", modelId: "model",
      permissionMode: "bypassPermissions", planMode: false, fastMode: false }); const sessionId = created.value.sessionId;
    expect(c.sources.source(c.store.getSession(sessionId).descriptor.backendId)?.targetDeviceId).toBe("device-A");
    const resource = (await c.host.getResources(sessionId)).find(resource => resource.id === "original-advice-C")!;
    expect(resource).toMatchObject({ state: "loaded", kind: "prompt" });
    const upload = await c.artifacts.ingestBytes(Buffer.from("ORIGINAL_UPLOAD_C"), { fileName: "upload.txt", mimeType: "text/plain" });
    const origin = (await c.host.createSession({ operationId: "owner-artifact-origin", connection: c.connection, targetId: "remote-target", title: "Artifact origin", providerId: "provider", modelId: "model",
      permissionMode: "bypassPermissions", planMode: false, fastMode: false })).value.sessionId;
    const report = await c.artifacts.ingestBytes(Buffer.from("ORIGINAL_ARTIFACT_C"), { fileName: "report.txt", mimeType: "text/plain", expiresAt: Date.now() + 60_000 });
    c.store.transaction(() => c.store.adoptSessionArtifact({ blob: c.store.getArtifact(report.id).blob, sessionId: origin }));
    const queued = c.host.enqueueInput({ operationId: "owner-group-send", connection: c.connection, sessionId, prompt: { text: "Read all original inputs", images: [], files: [{ blob: c.store.getArtifact(upload.id).blob }],
      mentions: [{ kind: "workspace_file", workspaceId: "original-project-workspace", reference: "proof.txt", label: "Original proof", lineRange: { startLine: 1, endLine: 1 } },
        { kind: "artifact", reference: report.id, sourceSessionId: origin, label: "Original report" },
        { kind: "workspace_directory", workspaceId: "original-project-workspace", reference: ".", label: "Original project" },
        { kind: "resource", reference: resource.id, label: resource.name, discoveredRevision: resource.revision!, resourceVersion: resource.resourceVersion!.toString(), runtimeGeneration: resource.runtimeGeneration! }], disposition: "prompt" } }).value;
    await vi.waitFor(() => expect(c.store.getQueueItem(queued.queueItemId).state).toBe("completed"), { timeout: 30_000 }).catch(error => {
      console.info("owner native state", c.store.listRuns({ sessionId }).map(run => [run.descriptor.id, run.descriptor.state, run.descriptor.activeAttemptId, run.descriptor.error]), c.store.listDiagnostics().map(row => [row.component, row.message]),
        c.store.listEvents({ sessionId, limit: 1000 }).map(event => event.payload.type === "error" ? [event.payload.type, event.payload.error.code] : event.payload.type === "run_state" ? [event.payload.type, event.payload.state, event.traceId, event.runId, event.operationId] : event.payload.type),
        c.store.listQueueItems({ sessionId }).map(item => [item.state, item.runId, item.attemptId]), f.calls.length); throw error;
    });
    expect(f.calls.map(call => call.node)).toEqual(["A", "A"]); expect(f.calls[1]!.body).toContain("ORIGINAL_SOURCE_BYTES");
    expect(f.calls[1]!.body).toContain("ORIGINAL_UPLOAD_C"); expect(f.calls[1]!.body).toContain("ORIGINAL_ARTIFACT_C");
    expect(f.calls.every(call => !call.body.includes(upload.storagePath) && !call.body.includes(report.storagePath))).toBe(true);
    expect(await readFile(upload.storagePath, "utf8")).toBe("ORIGINAL_UPLOAD_C");
    expect(f.calls.every(call => call.body.includes("ORIGINAL_GLOBAL_ADVICE_C") && !call.body.includes("ORIGINAL_GLOBAL_ADVICE_A") && !call.body.includes("ORIGINAL_GLOBAL_ADVICE_B"))).toBe(true);
    expect(f.calls.every(call => call.body.includes("ORIGINAL_MEMORY_INDEX_C") && !call.body.includes("ORIGINAL_MEMORY_INDEX_A") && !call.body.includes("ORIGINAL_MEMORY_INDEX_B"))).toBe(true);
    expect(f.mcpCalls).toEqual(["C"]); expect(f.calls[1]!.body).toContain("ORIGINAL_MCP_C");
    expect(await readFile(join(c.root, "workspace", "proof.txt"), "utf8")).toBe("ORIGINAL_SOURCE_BYTES");
    expect(c.groups.store.binding(sessionId)).toMatchObject({ ownerNodeId: "B", memberKey: remoteA.key });
    const actualUsage = await c.groups.taskAccountUsage(sessionId, new AbortController().signal);
    expect(actualUsage?.member).toMatchObject({ nodeId: "A", nodeName: "Computer A", quotaReadable: true });
    expect(actualUsage?.snapshot?.primaryWindow?.usedPercent).toBe(12);
    await vi.waitFor(() => expect(b.groups.usage.usage.rows({ group: key }).length).toBeGreaterThan(0), { timeout: 25_000 });
    expect(b.groups.usage.usage.rows({ group: key })[0]).toMatchObject({ nodeId: "A", partyId: "owner", turns: 1 });
    expect(b.groups.leases.count(remoteA.key)).toBe(0);
  } finally { await f.close(); }
});

it("tries another authorized group computer after a positively rejected native capacity admission", { timeout: 90_000 }, async () => {
  const f = await fixture(); let release: (() => void) | undefined;
  try {
    const a = await f.node("A"), b = await f.node("B"), c = await f.node("C");
    a.native.settings.update({ kind: "limits", value: { perDevice: 1, total: 1 } }, a.native.settings.snapshot().revision);
    release = a.native.slots.reserve("another-owner-device").release;
    await f.pair(b, a); await f.pair(c, b);
    const key = { backendId: "pi", providerId: "provider" }, remoteA = b.groups.sources().find(source => source.nodeId === "A" && source.providerId === "provider")!, localB = b.groups.sources().find(source => source.kind === "local" && source.providerId === "provider")!;
    b.groups.store.update(key, { strategy: "ordered", autoSwitch: true, members: [providerGroupDefaultMember(remoteA), providerGroupDefaultMember(localB)] }, 0n);
    await c.sources.refresh(c.connection);
    const sourceB = c.groups.sources().find(source => source.nodeId === "B" && source.providerId === "provider")!;
    await c.host.registerTarget({ id: "capacity-target", backendId: sourceB.backendId, displayName: "Original C", workspaceRoot: join(c.root, "workspace"), managed: false, trusted: true });
    const sessionId = (await c.host.createSession({ operationId: "capacity-original-create", connection: c.connection, targetId: "capacity-target", title: "Capacity route",
      providerId: "provider", modelId: "model", permissionMode: "bypassPermissions", planMode: false, fastMode: false })).value.sessionId;
    const queued = c.host.enqueueInput({ operationId: "capacity-original-input", connection: c.connection, sessionId,
      prompt: { text: "Read original files once", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
    await vi.waitFor(() => expect(c.store.getQueueItem(queued.queueItemId).state).toBe("completed"), { timeout: 30_000 });
    expect(f.calls.length).toBeGreaterThan(0); expect(f.calls.every(call => call.node === "B")).toBe(true);
    expect(a.native.slots.summary().total).toBe(1);
    expect(c.groups.taskMember(sessionId)).toMatchObject({ nodeId: "B", quotaReadable: true });
    expect(c.store.listRuns({ sessionId })).toHaveLength(1); expect(c.store.getOperation("capacity-original-input").status).toBe("completed");
    await c.host.detach(sessionId);
    expect(b.native.slots.summary().total).toBe(0); expect(a.native.slots.summary().total).toBe(1);
  } finally { release?.(); await f.close(); }
});

it("relays guest C through B to isolated A, offers one native handoff and continues C on B", { timeout: 90_000 }, async () => {
  const f = await fixture(); let live = true, bodyFailed = false;
  let phase: "setup" | "side-chat" | "side-chat-resume" | "side-chat-follow-up" | "clone" | "clone-follow-up" | "grant-retirement" | "completed" = "setup";
  try {
    const a = await f.node("A"), b = await f.node("B"); await f.pair(b, a);
    const key = { backendId: "pi", providerId: "provider" }, memberA = providerGroupDefaultMember(b.groups.sources().find(source => source.nodeId === "A" && source.providerId === "provider")!), localB = providerGroupDefaultMember(b.groups.sources().find(source => source.kind === "local" && source.providerId === "provider")!);
    b.groups.store.update(key, { strategy: "ordered", autoSwitch: true, members: [memberA, localB] }, 0n);
    const recipient = { shareId: "share-B", memberId: "member-C", generation: 1, name: "Person C", avatarUrl: null };
    const principal: HostedAgentPrincipal = { id: "approved-C", deviceId: "device-C", trust: "guest", assertCurrent: () => { if (!live) throw new Error("Grant was withdrawn."); },
      providerGrant: { ...key, modelIds: ["model"], cleanupKey: "a".repeat(64), recipient, assertCurrent: () => { if (!live) throw new Error("Grant was withdrawn."); } } };
    const client = new HostedAgentConnectClient(createClient(contract.HostedAgentService, createRouterTransport(router => router.service(contract.HostedAgentService,
      createHostedAgentConnectService({ ...b.native.connectOptions(), authenticate: () => principal })))), principal.assertCurrent);
    const identity: ProviderSharingReceivedIdentity = { joinId: "join-C", shareId: recipient.shareId, memberId: recipient.memberId, generation: 1, hostServerId: "B", nativeBackendId: "pi", providerId: "provider" };
    const sharing: ProviderSharingDirectoryPort = { localSourceDeviceId: "C", listReceived: () => [{ ...identity, backendId: providerSharingBackendId(identity.joinId, "pi"), displayName: "Provider", ownerName: "Computer B", models: [], state: "active", sourceNodeId: "B" }],
      subscribe: () => () => {}, assertReceived: principal.assertCurrent, canRelayToRecipient: () => { throw new Error("C may not reshare."); }, syncReshares: async () => {},
      captureNative: () => ({ client, assertCurrent: principal.assertCurrent, close: run => b.native.endpoint.closeProviderGrant("a".repeat(64), run) }) };
    const c = await f.node("C", sharing); await c.sources.refreshShared(new AbortController().signal);
    const sourceId = providerSharingBackendId(identity.joinId, "pi"); await c.host.registerTarget({ id: "shared-target", backendId: sourceId, displayName: "Original C", workspaceRoot: join(c.root, "workspace"), managed: false, trusted: true });
    const sessionId = (await c.host.createSession({ operationId: "guest-create", connection: c.connection, targetId: "shared-target", title: "Original guest C", providerId: "provider", modelId: "model", permissionMode: "bypassPermissions", planMode: false, fastMode: false })).value.sessionId;
    const original = c.store.getSession(sessionId).descriptor.binding;
    expect(await c.groups.taskAccountUsage(sessionId, new AbortController().signal)).toBeUndefined();
    const resource = (await c.host.getResources(sessionId)).find(resource => resource.id === "original-advice-C")!;
    const upload = await c.artifacts.ingestBytes(Buffer.from("GUEST_ORIGINAL_UPLOAD_C"), { fileName: "upload.txt", mimeType: "text/plain" });
    const origin = (await c.host.createSession({ operationId: "guest-artifact-origin", connection: c.connection, targetId: "shared-target", title: "Artifact origin", providerId: "provider", modelId: "model",
      permissionMode: "bypassPermissions", planMode: false, fastMode: false })).value.sessionId;
    const report = await c.artifacts.ingestBytes(Buffer.from("GUEST_ORIGINAL_ARTIFACT_C"), { fileName: "report.txt", mimeType: "text/plain", expiresAt: Date.now() + 60_000 });
    c.store.transaction(() => c.store.adoptSessionArtifact({ blob: c.store.getArtifact(report.id).blob, sessionId: origin }));
    f.fail(true); const queued = c.host.enqueueInput({ operationId: "guest-original", connection: c.connection, sessionId, prompt: { text: "Read original files once", images: [], files: [{ blob: c.store.getArtifact(upload.id).blob }],
      mentions: [{ kind: "workspace_file", workspaceId: "shared-target", reference: "proof.txt", label: "Original guest proof" },
        { kind: "artifact", reference: report.id, sourceSessionId: origin, label: "Guest original report" },
        { kind: "resource", reference: resource.id, label: resource.name, discoveredRevision: resource.revision!, resourceVersion: resource.resourceVersion!.toString(), runtimeGeneration: resource.runtimeGeneration! }], disposition: "prompt" } }).value;
    await vi.waitFor(() => {
      const runs = c.store.listRuns({ sessionId });
      expect(runs.some(run => run.descriptor.state === "completed") || runs.length > 1 && runs.every(run => ["failed", "aborted", "completed"].includes(run.descriptor.state))).toBe(true);
    }, { timeout: 45_000 }).then(() => expect(c.store.listRuns({ sessionId }).some(run => run.descriptor.state === "completed")).toBe(true)).catch(error => {
      console.info("guest native state", c.store.listRuns({ sessionId }).map(run => [run.descriptor.state, run.descriptor.error?.code, run.descriptor.error?.message]), c.store.listDiagnostics().map(row => [row.component, row.message]),
        c.store.listEvents({ sessionId, limit: 1000 }).map(event => event.payload.type === "error" ? [event.payload.type, event.payload.error.code] : event.payload.type), f.calls.length); throw error;
    });
    expect(f.calls.map(call => call.node)).toEqual(["A", "B", "B"]); expect(f.calls[2]!.body).toContain("ORIGINAL_SOURCE_BYTES");
    expect(f.calls[2]!.body).toContain("GUEST_ORIGINAL_UPLOAD_C"); expect(f.calls[2]!.body).toContain("GUEST_ORIGINAL_ARTIFACT_C");
    expect(f.calls.every(call => !call.body.includes(upload.storagePath) && !call.body.includes(report.storagePath))).toBe(true);
    expect(f.calls.every(call => call.body.includes("ORIGINAL_GLOBAL_ADVICE_C") && !call.body.includes("ORIGINAL_GLOBAL_ADVICE_A") && !call.body.includes("ORIGINAL_GLOBAL_ADVICE_B"))).toBe(true);
    expect(f.calls.every(call => call.body.includes("ORIGINAL_MEMORY_INDEX_C") && !call.body.includes("ORIGINAL_MEMORY_INDEX_A") && !call.body.includes("ORIGINAL_MEMORY_INDEX_B"))).toBe(true);
    expect(f.mcpCalls).toEqual(["C"]); expect(f.calls[2]!.body).toContain("ORIGINAL_MCP_C");
    expect(c.store.getSession(sessionId).descriptor.binding.nativeSessionId).not.toBe(original.nativeSessionId);
    expect(c.store.listEvents({ sessionId }).filter(event => event.payload.type === "runtime_handoff")).toHaveLength(1);
    expect(c.store.listEvents({ sessionId }).filter(event => event.payload.type === "error" && event.payload.terminal)).toEqual([]);
    expect(c.store.getOperation("guest-original").status).toBe("completed");
    expect(c.store.listRuns({ sessionId })).toHaveLength(2);
    expect(c.store.listRuns({ sessionId }).find(run => run.descriptor.state === "completed")?.descriptor.parentRunId).toBe(queued.runId);
    expect(c.store.findSetting("session", sessionId, `provider.group-error:${queued.runId}`)).toBeUndefined();
    expect(f.nativeTrust.filter(entry => entry.node === "A" || entry.node === "B").every(entry => entry.trust === "guest" && entry.guestHome)).toBe(true);
    expect(b.groups.usage.usage.rows({ group: key }).some(row => row.partyId === "member-C" && row.nodeId === "B")).toBe(true);
    phase = "side-chat";
    const callsBeforeSideChat = f.calls.length;
    const sideChatId = (await c.host.openSideChat({ operationId: "guest-native-side-chat", sourceSessionId: sessionId, connection: c.connection,
      title: "Read-only completed context", expectedGeneration: c.store.getSession(sessionId).descriptor.binding.generation })).value.sessionId;
    const sideChat = c.store.getSession(sideChatId).descriptor;
    expect(sideChat.derivationOrigin).toMatchObject({ sideChat: true, kind: "fork", sourceSessionId: sessionId });
    expect(sideChat.worktree).toBeUndefined(); expect(sideChat.permissionMode).toBe("ask"); expect(f.calls).toHaveLength(callsBeforeSideChat);
    const sideChatNative = new HostedAgentStore(b.store).list().find(record => record.owner.sessionId === sideChatId)!;
    expect(sideChatNative.derivation).toMatchObject({ completedSnapshot: { kind: "completed_assistant" }, adopted: true });
    phase = "side-chat-resume";
    await c.host.resume(sideChatId); await c.host.detach(sideChatId); await c.host.resume(sideChatId);
    phase = "side-chat-follow-up";
    const aside = c.host.enqueueInput({ operationId: "guest-side-chat-follow-up", connection: c.connection, sessionId: sideChatId,
      prompt: { text: "Explain the prior completed answer in this side chat only", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
    await vi.waitFor(() => expect(c.store.getQueueItem(aside.queueItemId).state).toBe("completed"), { timeout: 30_000 });
    expect(f.calls.slice(callsBeforeSideChat).every(call => call.node === "B")).toBe(true);
    phase = "clone";
    const callsBeforeClone = f.calls.length;
    const childId = (await c.host.deriveSession({ operationId: "guest-native-clone", sourceSessionId: sessionId, connection: c.connection,
      title: "Native guest history clone", kind: "clone" })).value.sessionId;
    expect(f.calls.length).toBe(callsBeforeClone);
    const child = c.store.getSession(childId).descriptor;
    expect(child.binding.nativeSessionId).not.toBe(c.store.getSession(sessionId).descriptor.binding.nativeSessionId);
    const nativeChildren = new HostedAgentStore(b.store).list().filter(record => record.owner.sessionId === childId);
    expect(nativeChildren).toHaveLength(1); expect(nativeChildren[0]!.derivation).toMatchObject({ kind: "clone", state: "settled", adopted: true });
    expect(nativeChildren[0]!.storageKey).toBe(nativeChildren[0]!.derivation!.sourceKey);
    phase = "clone-follow-up";
    const continued = c.host.enqueueInput({ operationId: "guest-clone-continue", connection: c.connection, sessionId: childId,
      prompt: { text: "Continue the cloned native history", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
    await vi.waitFor(() => expect(c.store.getQueueItem(continued.queueItemId).state).toBe("completed"), { timeout: 30_000 });
    expect(f.calls.slice(callsBeforeClone).every(call => call.node === "B")).toBe(true);
    expect(f.calls.at(-1)!.body).toContain("Read original files once");
    expect(f.calls.at(-1)!.body).not.toContain("Explain the prior completed answer in this side chat only");
    phase = "grant-retirement";
    live = false; await b.native.endpoint.sweep(); expect(a.native.slots.summary().total).toBe(0); expect(b.native.slots.summary().total).toBe(0);
    phase = "completed";
  } catch (error) { bodyFailed = true; throw error; }
  finally {
    try { await f.close(); } catch (error) {
      console.info("native source cleanup failure", { phase, bodyFailed, grantRetired: !live, cleanupFailed: true });
      // Preserve the already-failing scenario instead of replacing its cause
      // with cleanup. A successful scenario still fails on unconfirmed closure.
      if (!bodyFailed) throw error;
    }
  }
});
