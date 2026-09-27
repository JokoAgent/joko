import { createInProcessDevicePeerHarness } from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevicePeerOwner } from "./device-peer-owner.js";
import { RemoteExecutionRouter } from "./remote-execution-router.js";

const stores: OperationalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("RemoteExecutionRouter", () => {
  it("resolves a durable peer binding through its frozen controller relation and current route", async () => {
    const store = new OperationalStore(":memory:");
    stores.push(store);
    const controller = store.createConnection({
      id: "controller-connection",
      deviceId: "controller-device",
      device: { name: "Controller", kind: "web", platform: "web" },
      name: "Controller",
      authKeyDigest: "controller-digest"
    });
    const target = store.createConnection({
      id: "target-connection",
      deviceId: "target-device",
      device: { name: "Target", kind: "desktop", platform: "windows" },
      name: "Target",
      authKeyDigest: "target-digest"
    });
    store.setDeviceRemoteControlEnabled(target.deviceId, true);
    const peers = new DevicePeerOwner({ store });
    peers.registerRoute(target, createInProcessDevicePeerHarness({
      targetDeviceId: target.deviceId,
      capabilities: ["files", "process", "terminal"],
      agent: { handle: async () => ({ outcome: "failed", errorCode: "not_used" }) }
    }).transport);
    const hosts = {
      captureTransportAuthority: vi.fn(),
      captureProcessAuthority: vi.fn()
    };
    const router = new RemoteExecutionRouter({ hosts: hosts as never, peers });
    const captured = await router.terminal({
      kind: "device_peer",
      controllerDeviceId: controller.deviceId,
      targetDeviceId: target.deviceId,
      workspaceRoot: "C:\\project"
    });

    expect(captured.kind).toBe("device_peer");
    expect(hosts.captureTransportAuthority).not.toHaveBeenCalled();
    expect(hosts.captureProcessAuthority).not.toHaveBeenCalled();
    expect(() => captured.assertCurrent()).not.toThrow();

    store.setDeviceControlRelation({
      controllerDeviceId: controller.deviceId,
      targetDeviceId: target.deviceId,
      inboundAllowed: false
    });
    expect(() => captured.assertCurrent()).toThrow(/authority|authorized/u);
    await expect(router.files({
      kind: "device_peer",
      controllerDeviceId: controller.deviceId,
      targetDeviceId: target.deviceId,
      workspaceRoot: "C:\\project"
    })).rejects.toThrow(/authorized/u);
  });
});
