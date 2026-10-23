import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { createInProcessDevicePeerHarness, NodeDevicePeerAgentExecutor, type DevicePeerRequestFrame } from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { DevicePeerOwner } from "./device-peer-owner.js";
import { createHostedAgentPeerTransport } from "./hosted-agent-peer-transport.js";

it("uses only the captured native Device route and preserves an exact close after relation revocation without reviving ordinary calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-native-peer-transport-")), store = new OperationalStore(":memory:");
  const controller = store.createConnection({ id: "source-connection", deviceId: "source-controller", device: { defaultName: "Source", kind: "web", platform: "web" }, name: "Source", authKeyDigest: "source-digest" });
  const target = store.createConnection({ id: "node-connection", deviceId: "model-node", device: { defaultName: "Model node", kind: "service", platform: process.platform }, name: "Model node", authKeyDigest: "node-digest" });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  const owner = new DevicePeerOwner({ store }), received: DevicePeerRequestFrame[] = [], closed: string[] = [];
  const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(root, "recent.json"), nativeAgents: {
    invoke: async (method, bytes) => {
      if (method === contract.HostedAgentPeerMethod.GET_SETTINGS) return toBinary(contract.GetHostedAgentSettingsResponseSchema,
        create(contract.GetHostedAgentSettingsResponseSchema, { settings: { remoteControlEnabled: true } }));
      if (method === contract.HostedAgentPeerMethod.CLOSE) {
        closed.push(fromBinary(contract.CloseHostedAgentRequestSchema, bytes).runId);
        return toBinary(contract.CloseHostedAgentResponseSchema, create(contract.CloseHostedAgentResponseSchema, { format: 1 }));
      }
      throw new Error("Unexpected native fixture method.");
    }, retire: async () => {}
  } });
  const harness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["native_agents"], agent: {
    handle: async (frame, signal) => {
      received.push(frame); let value: contract.DevicePeerAgentResult["payload"] | undefined;
      await executor.execute(frame.payload as contract.DevicePeerCommand, signal, async result => { if (result.phase === contract.DevicePeerResponsePhase.COMPLETED) value = result.payload; });
      return { outcome: "completed", value };
    }, retire: () => executor.retire()
  } });
  owner.registerRoute(target, harness.transport);
  try {
    expect(owner.list(controller)).toEqual([]);
    expect(owner.listForCapabilities(controller, ["native_agents"])).toHaveLength(1);
    const authority = owner.captureBinding(controller.deviceId, target.deviceId, ["native_agents"]);
    const client = createClient(contract.HostedAgentService, createHostedAgentPeerTransport({ owner, authority }));
    expect((await client.getHostedAgentSettings({})).settings?.remoteControlEnabled).toBe(true);
    expect(received[0]).toMatchObject({ controllerDeviceId: controller.deviceId, capability: "native_agents", effectKind: "read_only", action: "invokeHostedAgent" });
    expect((received[0]?.payload as contract.DevicePeerCommand).controllerDeviceId).toBe(controller.deviceId);
    const cleanup = owner.captureHostedAgentCleanup(authority, "owned-native-run");
    store.setDeviceControlRelation({ controllerDeviceId: controller.deviceId, targetDeviceId: target.deviceId, inboundAllowed: false });
    await expect(client.getHostedAgentSettings({})).rejects.toBeDefined(); expect(received).toHaveLength(1);
    await cleanup(); expect(closed).toEqual(["owned-native-run"]); expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ controllerDeviceId: controller.deviceId, capability: "native_agents", effectKind: "side_effect" });
    owner.retireRoute({ targetDeviceId: target.deviceId, routeGeneration: authority.identity.routeGeneration }, "shutdown");
    await expect(cleanup()).rejects.toBeDefined(); expect(closed).toEqual(["owned-native-run"]);
  } finally {
    owner.shutdown(); await executor.retire(); store.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true });
  }
});
