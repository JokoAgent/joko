import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { createInProcessDevicePeerHarness, NodeDevicePeerAgentExecutor } from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { DevicePeerOwner } from "./device-peer-owner.js";
import { SessionHost } from "./session-host.js";
import { HostedAgentSources } from "./hosted-agent-sources.js";
import { toProtoCapability } from "./proto-mapper.js";
import { decodeHostedAgentInvocation, encodeHostedAgentValue } from "./hosted-agent-wire.js";

it("publishes actual paired native sources, retains paused and offline choices, and restores the same identity from the Source database", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-native-source-catalog-"));
  let store = new OperationalStore(join(root, "source.sqlite")), peers = new DevicePeerOwner({ store });
  let registry = new BackendInstanceRegistry(store);
  let host = new SessionHost(store, new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }), []);
  const readPolicy = () => ({ revision: "source-policy", permissionMode: "ask" as const, planMode: false, approvedRoots: [], confirmCredentials: true });
  const readBlob = async () => { throw new Error("No image dispatch in this catalog fixture."); };
  const reviewTool = async () => ({ verdict: "ask" as const });
  const resolveTextResources = async () => [];
  let sources = new HostedAgentSources({ store, peers, registry, host, temporaryRoot: join(root, "incoming"), readPolicy, readBlob, reviewTool, resolveTextResources });
  const controller = store.createConnection({ id: "source-connection", deviceId: "original-device", device: { defaultName: "Original", kind: "web", platform: "web" }, name: "Original", authKeyDigest: "original-digest" });
  const target = store.createConnection({ id: "node-connection", deviceId: "model-node", device: { defaultName: "Native computer", kind: "service", platform: process.platform }, name: "Native computer", authKeyDigest: "node-digest" });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  let remoteEnabled = true, malformed = false, inferred = 0;
  const native = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "recent.json"), nativeAgents: {
    invoke: async (method, bytes, _signal, authority) => {
      expect(authority.controllerDeviceId).toBe(controller.deviceId);
      if (method === contract.HostedAgentPeerMethod.CALL) {
        const request = fromBinary(contract.CallHostedAgentRequestSchema, bytes), command = decodeHostedAgentInvocation(request.commandJson);
        expect(command).toMatchObject({ kind: "infer", request: { backendId: "native-sdk", backendInstanceGeneration: 1, providerId: "provider", modelId: "native-model", system: "Private reply", user: "Hello", maxTokens: 256 } });
        inferred++;
        return toBinary(contract.CallHostedAgentResponseSchema, create(contract.CallHostedAgentResponseSchema, { format: 1, resultJson: encodeHostedAgentValue("Source isolated reply") }));
      }
      expect(method).toBe(contract.HostedAgentPeerMethod.GET_CATALOG);
      const backend = { backendId: "native-sdk", instanceGeneration: 1n, displayName: "Native Agent", version: "1", capabilities: [
        { name: "input.text", support: contract.CapabilitySupport.SUPPORTED }, { name: "model.switch", support: contract.CapabilitySupport.SUPPORTED },
        ...["runtime.commands", "subagents.list", "subagents.detail", "subagents.transcript", "subagents.resume", "session.rewind", "session.rewind_to_start", "session.fork", "session.clone"]
          .map(name => ({ name, support: contract.CapabilitySupport.SUPPORTED })),
        toProtoCapability({ key: "permission.modes", supported: true, options: ["ask", "acceptEdits", "auto", "bypassPermissions"] })
      ], providers: [{ providerId: "provider", displayName: "Provider", connected: true, remoteInvocationEnabled: remoteEnabled,
        models: [{ backendId: "native-sdk", key: { providerId: "provider", modelId: "native-model" }, displayName: "Model", logicalId: "stable-model", api: "openai-responses",
          contextWindowTokens: 32768n, maximumOutputTokens: 1024n, inputModalities: [contract.ModelInputModality.TEXT], description: "Native model description",
          displayThinkingLevels: ["low", "high"], defaultVisible: false, declaredSupportsFastMode: false, referenceApi: "openai-responses",
          inputCostMicrosPerMillion: 2500000n, currencyCode: "USD", priceSource: contract.ModelPriceSource.UPSTREAM }] }] };
      return toBinary(contract.GetHostedAgentCatalogResponseSchema, create(contract.GetHostedAgentCatalogResponseSchema, {
        format: 1, remoteControlEnabled: true, backends: malformed ? [backend, { ...backend, backendId: "invalid", providers: backend.providers }] : [backend]
      }));
    }, retire: async () => {}
  } });
  const harness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["native_agents"], agent: {
    handle: async (frame, signal) => {
      let value: contract.DevicePeerAgentResult["payload"] | undefined;
      await native.execute(frame.payload as contract.DevicePeerCommand, signal, async result => { if (result.phase === contract.DevicePeerResponsePhase.COMPLETED) value = result.payload; });
      return { outcome: "completed", value };
    }, retire: () => native.retire()
  } });
  peers.registerRoute(target, harness.transport);
  try {
    await sources.initialize(); await host.initialize(); await sources.refresh(controller);
    const descriptor = store.listBackends()[0]!.descriptor, id = descriptor.id;
    expect(sources.source(id)).toEqual({ controllerDeviceId: controller.deviceId, targetDeviceId: target.deviceId, backendId: "native-sdk" });
    expect(descriptor).toMatchObject({ adapterKind: "hosted", health: "healthy", displayName: "Native Agent · Native computer", instanceGeneration: 1 });
    expect(descriptor.capabilities.get("input.text")?.supported).toBe(true);
    for (const key of ["runtime.commands", "subagents.list", "subagents.detail", "subagents.transcript", "subagents.resume", "session.rewind", "session.rewind_to_start"]) {
      expect(descriptor.capabilities.get(key)?.supported).toBe(true);
    }
    for (const key of ["session.fork", "session.clone"]) expect(descriptor.capabilities.get(key)).toMatchObject({ supported: false, reason: "upstream_missing" });
    expect(descriptor.capabilities.get("permission.modes")?.options).toEqual(["ask", "acceptEdits", "auto", "bypassPermissions"]);
    expect(descriptor.capabilities.get("runtime.resources")).toMatchObject({ supported: true, options: ["skill", "prompt"] });
    expect(descriptor.capabilities.get("input.mention")).toMatchObject({ supported: true, options: ["resource"] });
    expect(descriptor.providers?.[0]?.displayName).toBe("Provider · Native Agent · Native computer");
    expect(descriptor.models[0]).toMatchObject({ logicalId: "stable-model", displayThinkingLevels: ["low", "high"], defaultVisible: false,
      declaredSupportsFastMode: false, cost: { input: 2.5 }, pricing: { source: "upstream", currencyCode: "USD" } });
    expect(host.currentAdapter(id)?.id).toBe(id); expect(sources.modelAvailable(id, "provider", "native-model")).toBe(true);
    expect(await host.currentAdapter(id)!.inferNativeText!({ backendInstanceGeneration: descriptor.instanceGeneration, providerId: "provider", modelId: "native-model",
      system: "Private reply", user: "Hello", maxTokens: 256, timeoutMs: 10_000, signal: new AbortController().signal,
      assertCurrent() {}, assertModelAllowed(providerId, modelId) { expect([providerId, modelId]).toEqual(["provider", "native-model"]); } })).toBe("Source isolated reply");
    expect(inferred).toBe(1); expect(store.listSessions()).toEqual([]);
    remoteEnabled = false; await sources.refresh(controller);
    expect(sources.modelAvailable(id, "provider", "native-model")).toBe(false); expect(store.getBackend(id).descriptor.models).toHaveLength(1);
    remoteEnabled = true; malformed = true; await sources.refresh(controller);
    expect(store.listBackends()).toHaveLength(1); expect(sources.modelAvailable(id, "provider", "native-model")).toBe(false);
    malformed = false; await sources.refresh(controller); expect(sources.modelAvailable(id, "provider", "native-model")).toBe(true);
    const staleTarget = { id: "stale-target", backendId: id, displayName: "Original", workspaceRoot: root, managed: false, trusted: true };
    await host.registerTarget(staleTarget);
    store.createSession({ id: "stale-task", backendId: id, targetId: staleTarget.id, title: "Retired occurrence", binding: { opaqueRef: "retained", generation: 2 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    await expect(host.currentAdapter(id)!.createSession({ target: staleTarget, providerId: "provider", modelId: "native-model", permissionMode: "ask", fastMode: false }, {
      sessionId: "stale-task", generation: 1, backendInstanceGeneration: descriptor.instanceGeneration, target: staleTarget, operationId: "retired-create",
      signal: new AbortController().signal, emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024,
      storeArtifact: async () => { throw new Error("No stale artifacts."); }
    })).rejects.toThrow(/Source task authority changed/u);
    await host.dispose(); await sources.close(); await peers.shutdown(); await native.retire(); store.close();
    store = new OperationalStore(join(root, "source.sqlite")); peers = new DevicePeerOwner({ store }); registry = new BackendInstanceRegistry(store);
    host = new SessionHost(store, new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }), []);
    sources = new HostedAgentSources({ store, peers, registry, host, temporaryRoot: join(root, "incoming"), readPolicy, readBlob });
    await sources.initialize(); await host.initialize();
    expect(store.getBackend(id).descriptor).toMatchObject({ id, health: "unavailable", instanceGeneration: 2 });
    expect(sources.modelAvailable(id, "provider", "native-model")).toBe(false); expect(host.currentAdapter(id)?.id).toBe(id);
    expect(store.getBackend(id).descriptor.models[0]?.modelId).toBe("native-model");
  } finally {
    await host.dispose(); await sources.close(); await peers.shutdown(); store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});
