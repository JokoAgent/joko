import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { createInProcessDevicePeerHarness, type DevicePeerRequestFrame } from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { DevicePeerOwner } from "./device-peer-owner.js";

it("captured native cleanup terminates only its controller and route after connection revocation", async () => {
  const store = new OperationalStore(":memory:");
  const controller = store.createConnection({ id: "controller", deviceId: "controller-device", name: "Controller",
    device: { defaultName: "Controller", kind: "mobile", platform: "ios" }, authKeyDigest: "controller-digest" });
  const target = store.createConnection({ id: "target", deviceId: "target-device", name: "Desktop",
    device: { defaultName: "Desktop", kind: "desktop", platform: "macos" }, authKeyDigest: "target-digest" });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  const first: DevicePeerRequestFrame[] = [], replacement: DevicePeerRequestFrame[] = [];
  const route = (received: DevicePeerRequestFrame[]) => createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId,
    capabilities: ["remote_desktop"], agent: { handle: async (frame) => {
      received.push(frame);
      return { outcome: "completed", value: { case: "acknowledgement", value: create(contract.DevicePeerAcknowledgementSchema) } };
    } } });
  const owner = new DevicePeerOwner({ store });
  try {
    owner.registerRoute(target, route(first).transport);
    const peer = owner.listForCapabilities(controller, ["remote_desktop"], { kind: "desktop" })[0]!;
    const authority = owner.capture(controller, peer, ["remote_desktop"]);
    const cleanup = owner.captureRemoteDesktopCredentialCleanup(authority);
    store.revokeConnection(controller.id);
    expect(() => authority.assertCurrent()).toThrow();
    const handle = "12345678-1234-4234-8234-123456789abc";
    await cleanup(handle, new AbortController().signal);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ controllerDeviceId: controller.deviceId, targetDeviceId: target.deviceId,
      routeGeneration: peer.routeGeneration, action: "closeRemoteDesktopCredentials", payload: {
        controllerDeviceId: controller.deviceId, action: { case: "closeRemoteDesktopCredentials", value: { handle } }
      } });
    owner.registerRoute(target, route(replacement).transport);
    await cleanup(handle, new AbortController().signal);
    expect(replacement).toHaveLength(0);
    expect(first).toHaveLength(1);
    await expect(cleanup("caller-supplied-id")).rejects.toMatchObject({ code: "invalid_identity" });
  } finally { owner.shutdown(); store.close(); }
});

it("an accepted native open receipt lost to revocation is cleaned before its handle is suppressed", async () => {
  const store = new OperationalStore(":memory:");
  const controller = store.createConnection({ id: "controller", deviceId: "controller-device", name: "Controller",
    device: { defaultName: "Controller", kind: "mobile", platform: "ios" }, authKeyDigest: "controller-digest" });
  const target = store.createConnection({ id: "target", deviceId: "target-device", name: "Desktop",
    device: { defaultName: "Desktop", kind: "desktop", platform: "macos" }, authKeyDigest: "target-digest" });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  const received: DevicePeerRequestFrame[] = [];
  const handle = "12345678-1234-4234-8234-123456789abc";
  const route = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["remote_desktop"],
    agent: { handle: async (frame) => {
      received.push(frame);
      if (frame.action === "requestRemoteDesktopCredentials") {
        store.revokeConnection(controller.id);
        return { outcome: "completed", value: { case: "remoteDesktopCredentials",
          value: create(contract.RemoteDesktopCredentialResultSchema, { result: { case: "opened", value: { handle, offer: "signed.offer" } } }) } };
      }
      return { outcome: "completed", value: { case: "acknowledgement", value: create(contract.DevicePeerAcknowledgementSchema) } };
    } } });
  const owner = new DevicePeerOwner({ store });
  try {
    owner.registerRoute(target, route.transport);
    const peer = owner.listForCapabilities(controller, ["remote_desktop"], { kind: "desktop" })[0]!;
    const response = await owner.dispatch(owner.capture(controller, peer, ["remote_desktop"]), {
      capability: "remote_desktop", effectKind: "side_effect", action: "requestRemoteDesktopCredentials",
      payload: create(contract.DevicePeerCommandSchema, { capability: contract.DevicePeerCapabilityKind.REMOTE_DESKTOP,
        effect: contract.DevicePeerEffectKind.SIDE_EFFECT, action: { case: "requestRemoteDesktopCredentials",
          value: { request: { case: "open", value: { offer: "signed.offer" } } } } })
    });
    expect(response).toMatchObject({ outcome: "outcome_unknown", errorCode: "authority_changed" });
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ controllerDeviceId: controller.deviceId, action: "closeRemoteDesktopCredentials",
      payload: { action: { case: "closeRemoteDesktopCredentials", value: { handle } } } });
  } finally { owner.shutdown(); store.close(); }
});
