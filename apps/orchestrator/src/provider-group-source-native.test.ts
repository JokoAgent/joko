import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { createPiAdapter } from "@joko/adapter-pi";
import { createInProcessDevicePeerHarness, NodeDevicePeerAgentExecutor } from "@joko/device-peer";
import { OperationalStore, type ConnectionRecord } from "@joko/store";
import { expect, it, vi } from "vitest";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-group-source-native-")), calls: { node: string; body: string }[] = [], nativeTrust: { node: string; trust: string; guestHome?: string }[] = [];
  let failA = false;
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString(), node = request.url!.split("/")[1]!;
    calls.push({ node, body }); expect(request.headers.authorization).toBe(`Bearer private-${node}`);
    if (node === "A" && failA) { response.writeHead(529, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "overloaded_error at capacity", type: "overloaded_error" } })); return; }
    const messages = JSON.parse(body).messages as { role: string; content: unknown }[], latestUser = messages.map(message => message.role).lastIndexOf("user");
    const hasTool = messages.slice(latestUser + 1).some(message => message.role === "tool");
    const tool = !hasTool;
    response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ id: `turn-${calls.length}`, object: "chat.completion.chunk", created: 1, model: "model",
      choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [{ index: 0, id: `read-${calls.length}`, type: "function", function: { name: "read", arguments: '{"path":"proof.txt"}' } }] }
        : { role: "assistant", content: `Executed on ${node}: ORIGINAL_SOURCE_BYTES` }, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve)); const address = model.address(); if (!address || typeof address === "string") throw new Error("No native model port.");
  const port = address.port;
  const nodes: Node[] = [];
  interface Node { id: string; root: string; store: OperationalStore; registry: BackendInstanceRegistry; host: SessionHost; sources: HostedAgentSources; peers: DevicePeerOwner;
    native: HostedAgentRuntime; groups: ProviderGroupRuntime; connection: ConnectionRecord; close(): Promise<void>; }
  async function node(id: string, sharing?: ProviderSharingDirectoryPort): Promise<Node> {
    const directory = join(root, id); await mkdir(directory); const workspace = join(directory, "workspace"); await mkdir(workspace); await writeFile(join(workspace, "proof.txt"), "ORIGINAL_SOURCE_BYTES");
    const store = new OperationalStore(join(directory, "store.db")), registry = new BackendInstanceRegistry(store), peers = new DevicePeerOwner({ store });
    const makePi = (home: string) => createPiAdapter({ agentHome: home, sessionRoot: home, includeManagedSubagentTools: () => false,
      settings: { compaction: { enabled: false }, retry: { enabled: false } }, environment: { NATIVE_KEY: `private-${id}` },
      providers: [{ id: "provider", api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/${id}/v1`, apiKeyEnv: "NATIVE_KEY",
        models: [{ id: "model", contextWindow: 32768, maxTokens: 1024, input: ["text"] }] }] });
    const local = makePi(join(directory, "owner")); await registry.provision([{ instanceId: local.id, adapterKind: "pi", displayName: "Native " + id, create: () => local }]);
    const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [directory] }); await artifacts.initialize();
    const host = new SessionHost(store, artifacts, registry.availableAdapters(), { backendDescriptors: registry.descriptors(), backendDescriptorsAlreadyPublished: true }); await host.initialize();
    const connection = store.createConnection({ id: "controller-" + id, deviceId: "device-" + id, name: "Owner " + id, authKeyDigest: "digest-" + id,
      device: { defaultName: "Computer " + id, kind: "service", platform: process.platform } });
    let groups!: ProviderGroupRuntime;
    const native = new HostedAgentRuntime({ store, nodeId: id, connections: new ConnectionManager(store), root: join(directory, "native"), artifactCapacityBytes: 1024 * 1024,
      decorateCatalog: catalog => groups?.decorateCatalog(catalog) ?? catalog, resolveSharedProvider: (backend, provider) => groups?.sharedProvider(backend, provider),
      factories: [{ backendId: local.id, providerIds: () => ["provider"], models: () => registry.get(local.id).descriptor.models.filter(model => model.providerId === "provider"),
        capabilities: () => registry.get(local.id).descriptor.capabilities, describe: () => registry.get(local.id).descriptor, isolatedGuests: () => true, create: creation => {
          nativeTrust.push({ node: id, trust: creation.trust, ...(creation.execution.trust === "guest" ? { guestHome: creation.execution.guestHome } : {}) }); return makePi(creation.home);
        } }] });
    let permissions = native.settings.update({ kind: "remote_control", enabled: true }, 0n); native.settings.update({ kind: "provider", backendId: local.id, providerId: "provider", enabled: true }, permissions.revision);
    const sources = new HostedAgentSources({ store, peers, registry, host, sourceDeviceId: "device-" + id, temporaryRoot: join(directory, "incoming"), ...(sharing ? { sharing } : {}),
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
    const value: Node = { id, root: directory, store, registry, host, sources, peers, native, groups, connection,
      close: async () => { await host.dispose(); await sources.close(); await native.close(); await groups.close(); await peers.shutdown(); store.close(); } }; nodes.push(value); return value;
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
  return { root, calls, nativeTrust, node, pair, fail: (value: boolean) => { failA = value; }, close: async () => { for (const node of nodes.reverse()) await node.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true, maxRetries: 3 }); } };
}
it("runs same-owner C through B's group decision directly on A with the actual Source queue, SDK tools, load and usage reports", { timeout: 90_000 }, async () => {
  const f = await fixture(); try {
    const a = await f.node("A"), b = await f.node("B"), c = await f.node("C"); await f.pair(b, a); await f.pair(c, a); await f.pair(c, b);
    const key = { backendId: "pi", providerId: "provider" }, remoteA = b.groups.sources().find(source => source.nodeId === "A" && source.providerId === "provider")!;
    b.groups.store.update(key, { strategy: "ordered", autoSwitch: true, members: [providerGroupDefaultMember(remoteA), providerGroupDefaultMember(b.groups.sources().find(source => source.kind === "local" && source.providerId === "provider")!)] }, 0n);
    await c.sources.refresh(c.connection); const bSource = c.groups.sources().find(source => source.nodeId === "B" && source.providerId === "provider")!;
    await c.host.registerTarget({ id: "remote-target", backendId: bSource.backendId, displayName: "Original C", workspaceRoot: join(c.root, "workspace"), managed: false, trusted: true });
    const created = await c.host.createSession({ operationId: "owner-group-create", connection: c.connection, targetId: "remote-target", title: "Keep original C", providerId: "provider", modelId: "model",
      permissionMode: "bypassPermissions", planMode: false, fastMode: false }); const sessionId = created.value.sessionId;
    expect(c.sources.source(c.store.getSession(sessionId).descriptor.backendId)?.targetDeviceId).toBe("device-A");
    const queued = c.host.enqueueInput({ operationId: "owner-group-send", connection: c.connection, sessionId, prompt: { text: "Read proof.txt", images: [], files: [], mentions: [], disposition: "prompt" } }).value;
    await vi.waitFor(() => expect(c.store.getQueueItem(queued.queueItemId).state).toBe("completed"), { timeout: 30_000 }).catch(error => {
      console.info("owner native state", c.store.listRuns({ sessionId }).map(run => [run.descriptor.id, run.descriptor.state, run.descriptor.activeAttemptId, run.descriptor.error?.code]), c.store.listDiagnostics().map(row => [row.component, row.message]),
        c.store.listEvents({ sessionId, limit: 1000 }).map(event => event.payload.type === "error" ? [event.payload.type, event.payload.error.code] : event.payload.type === "run_state" ? [event.payload.type, event.payload.state, event.traceId, event.runId, event.operationId] : event.payload.type),
        c.store.listQueueItems({ sessionId }).map(item => [item.state, item.runId, item.attemptId]), f.calls.length); throw error;
    });
    expect(f.calls.map(call => call.node)).toEqual(["A", "A"]); expect(f.calls[1]!.body).toContain("ORIGINAL_SOURCE_BYTES");
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

it("relays guest C through B to isolated A, offers one native handoff and continues C on B", { timeout: 90_000 }, async () => {
  const f = await fixture(); let live = true;
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
    f.fail(true); c.host.enqueueInput({ operationId: "guest-original", connection: c.connection, sessionId, prompt: { text: "Read proof.txt once", images: [], files: [], mentions: [], disposition: "prompt" } });
    await vi.waitFor(() => {
      const runs = c.store.listRuns({ sessionId });
      expect(runs.some(run => run.descriptor.state === "completed") || runs.length > 1 && runs.every(run => ["failed", "aborted", "completed"].includes(run.descriptor.state))).toBe(true);
    }, { timeout: 45_000 }).then(() => expect(c.store.listRuns({ sessionId }).some(run => run.descriptor.state === "completed")).toBe(true)).catch(error => {
      console.info("guest native state", c.store.listRuns({ sessionId }).map(run => [run.descriptor.state, run.descriptor.error?.code, run.descriptor.error?.message]), c.store.listDiagnostics().map(row => [row.component, row.message]),
        c.store.listEvents({ sessionId, limit: 1000 }).map(event => event.payload.type === "error" ? [event.payload.type, event.payload.error.code] : event.payload.type), f.calls.length); throw error;
    });
    expect(f.calls.map(call => call.node)).toEqual(["A", "B", "B"]); expect(f.calls[2]!.body).toContain("ORIGINAL_SOURCE_BYTES");
    expect(c.store.getSession(sessionId).descriptor.binding.nativeSessionId).not.toBe(original.nativeSessionId);
    expect(c.store.listEvents({ sessionId }).filter(event => event.payload.type === "runtime_handoff")).toHaveLength(1);
    expect(c.store.listEvents({ sessionId }).filter(event => event.payload.type === "error" && event.payload.terminal)).toEqual([]);
    expect(f.nativeTrust.filter(entry => entry.node === "A" || entry.node === "B").every(entry => entry.trust === "guest" && entry.guestHome)).toBe(true);
    expect(b.groups.usage.usage.rows({ group: key }).some(row => row.partyId === "member-C" && row.nodeId === "B")).toBe(true);
    live = false; await b.native.endpoint.sweep(); expect(a.native.slots.summary().total).toBe(0); expect(b.native.slots.summary().total).toBe(0);
  } finally { await f.close(); }
});
