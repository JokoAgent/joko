import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { AdapterContext, BackendAdapter, CreateNativeSessionInput, NativeSessionBinding, ProviderModel } from "@joko/core";
import { createInProcessDevicePeerHarness, NodeDevicePeerAgentExecutor, type DevicePeerRequestFrame } from "@joko/device-peer";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { DevicePeerOwner } from "./device-peer-owner.js";
import { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { createHostedAgentPeerPort } from "./hosted-agent-peer-port.js";
import { createHostedAgentPeerTransport } from "./hosted-agent-peer-transport.js";
import { createHostedAgentGuestPeerCapture } from "./hosted-agent-guest-peer-capture.js";
import type { ConnectionManager } from "./connection-manager.js";

it("keeps an onward person guest over a real owner Device route and retains only exact terminal cleanup after both grants end", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-owner-guest-relay-"))), source = new OperationalStore(":memory:"), modelStore = new OperationalStore(":memory:");
  const controller = source.createConnection({ id: "group-connection", deviceId: "group-computer", device: { defaultName: "Group", kind: "service", platform: process.platform }, name: "Group", authKeyDigest: "group-digest" });
  const target = source.createConnection({ id: "native-connection", deviceId: "native-computer", device: { defaultName: "Model member", kind: "service", platform: process.platform }, name: "Model member", authKeyDigest: "model-digest" });
  source.setDeviceRemoteControlEnabled(target.deviceId, true);
  let captured: AdapterContext | undefined, created = 0, cleanupUnknown = false, guestCurrent = true, removed = false;
  const model: ProviderModel = { providerId: "provider", modelId: "model", displayName: "Model", api: "native", contextWindow: 32768,
    maxOutputTokens: 1024, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const runtime = new HostedAgentRuntime({ store: modelStore, root: join(root, "native"), artifactCapacityBytes: 1024,
    connections: { authenticate: () => { throw new Error("No foreign HTTP owner grant."); } } as unknown as ConnectionManager,
    factories: [{ backendId: "native", providerIds: () => ["provider", "foreign"], isolatedGuests: () => true,
      models: () => [model, { ...model, providerId: "foreign", modelId: "foreign-model" }], create: () => ({ id: "native", hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
        createSession: async (_input: CreateNativeSessionInput, context: AdapterContext) => { captured = context; created++; return { opaqueRef: "private-guest-binding", nativeSessionId: "native-child", generation: 1 }; },
        inspectSession: async (binding: NativeSessionBinding) => ({ binding, streaming: false, compacting: false, pendingMessages: 0, fastMode: false, permissionMode: "ask" }),
        dispose: async () => { if (cleanupUnknown) throw new Error("Native child closure is unconfirmed."); }
      } as unknown as BackendAdapter) }] });
  let settings = runtime.settings.update({ kind: "remote_control", enabled: true }, 0n);
  settings = runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, settings.revision);
  const peer = createHostedAgentPeerPort(runtime, "group-home"), owner = new DevicePeerOwner({ store: source }), frames: DevicePeerRequestFrame[] = [];
  const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "recent.json"), nativeAgents: peer });
  const harness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["native_agents"], agent: { handle: async (frame, signal) => {
    frames.push(frame); let value: contract.DevicePeerAgentResult["payload"] | undefined;
    await executor.execute(frame.payload as contract.DevicePeerCommand, signal, async result => { if (result.phase === contract.DevicePeerResponsePhase.COMPLETED) value = result.payload; });
    return { outcome: "completed", value };
  }, retire: () => executor.retire() } });
  owner.registerRoute(target, harness.transport);
  const authority = owner.captureBinding(controller.deviceId, target.deviceId, ["native_agents"]), recipient = { shareId: "approved-group-share", memberId: "approved-person", generation: 1, name: "Recipient", avatarUrl: null };
  const capturedGuest = createHostedAgentGuestPeerCapture({ owner, authority, recipient, backendId: "native", providerId: "provider", modelIds: ["model"],
    assertCurrent: () => { if (!guestCurrent) throw new Error("Original per-person grant was withdrawn."); }, shouldPurge: () => removed });
  const active = new AbortController().signal;
  try {
    const catalog = await capturedGuest.client.catalog(active); expect(catalog.backends[0]!.providers.map(row => row.providerId)).toEqual(["provider"]);
    const input = { runId: "onward-run", nativeSessionId: "onward-context", start: "create" as const, sessionId: "original-task", targetId: "original-workspace", generation: 1,
      backendId: "native", providerId: "provider", modelId: "model", permissionMode: "ask" as const, fastMode: false,
      workspace: { platform: process.platform as "win32" | "linux" | "darwin", shell: "bash", isGitRepository: false } };
    await capturedGuest.client.open(input, active); await capturedGuest.client.call(input.runId, "ready", { kind: "state" }, active);
    expect(created).toBe(1); expect(captured?.hostedExecution).toMatchObject({ trust: "guest", providerId: "provider", modelIds: ["model"] });
    expect(captured?.hostedExecution?.trust === "guest" && captured.hostedExecution.guestHome).toBe(join(root, "native", new HostedAgentStore(modelStore).list()[0]!.key));
    const ownClient = createClient(contract.HostedAgentService, createHostedAgentPeerTransport({ owner, authority }));
    expect((await ownClient.getHostedAgentSettings({})).settings?.remoteControlEnabled).toBe(true);
    await expect(capturedGuest.client.open({ ...input, runId: "foreign-scope", nativeSessionId: "foreign-context", providerId: "foreign", modelId: "foreign-model" }, active)).rejects.toBeDefined();
    expect(created).toBe(1);
    const record = new HostedAgentStore(modelStore).list()[0]!, privateRoot = join(root, "native", record.key);
    expect(frames[0]?.payload).toMatchObject({ action: { case: "invokeHostedAgent", value: { method: contract.HostedAgentPeerMethod.GUEST_RELAY_CATALOG } } });
    settings = runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: false }, settings.revision);
    await expect(capturedGuest.client.catalog(active)).rejects.toBeDefined();
    settings = runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: true }, settings.revision);
    expect((await capturedGuest.client.catalog(active)).backends[0]!.providers[0]!.providerId).toBe("provider");
    guestCurrent = false; removed = true;
    source.setDeviceControlRelation({ controllerDeviceId: controller.deviceId, targetDeviceId: target.deviceId, inboundAllowed: false });
    settings = runtime.settings.update({ kind: "provider", backendId: "native", providerId: "provider", enabled: false }, settings.revision);
    const count = frames.length; await expect(capturedGuest.client.call(input.runId, "retired-person", { kind: "state" }, active)).rejects.toBeDefined(); expect(frames).toHaveLength(count);
    cleanupUnknown = true; await expect(capturedGuest.close(input.runId, active)).rejects.toBeDefined(); expect(runtime.slots.summary().total).toBe(1); expect((await stat(privateRoot)).isDirectory()).toBe(true);
    cleanupUnknown = false; await capturedGuest.close(input.runId, active); expect(runtime.slots.summary().total).toBe(0); expect(new HostedAgentStore(modelStore).list()).toEqual([]);
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(frames.at(-1)?.payload).toMatchObject({ action: { case: "invokeHostedAgent", value: { method: contract.HostedAgentPeerMethod.GUEST_RELAY_CLOSE } } });
    await expect(ownClient.getHostedAgentSettings({})).rejects.toBeDefined();
  } finally { cleanupUnknown = false; owner.shutdown(); await executor.retire(); await runtime.close(); source.close(); modelStore.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe guest relay fixture cleanup."); await rm(root, { recursive: true, force: true }); }
});
