import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { createInProcessDevicePeerHarness, type DevicePeerRequestFrame } from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";

import { ConnectionManager, digestAuthKey } from "./connection-manager.js";
import { createRemoteDesktopConnectService } from "./remote-desktop-connect-service.js";
import { RemoteDesktopCoordinator } from "./remote-desktop-coordinator.js";
import { DevicePeerOwner } from "./device-peer-owner.js";

it("routes generated Linux system actions through authenticated current control and sanitizes host failures", async () => {
  const store = new OperationalStore(":memory:"), key = "system-action-controller-key";
  const controller = store.createConnection({ id: "system-action-controller", deviceId: "mobile-controller", name: "Controller",
    device: { defaultName: "Controller", kind: "mobile", platform: "android" }, authKeyDigest: digestAuthKey(key) });
  const target = store.createConnection({ id: "system-action-target", deviceId: "linux-host", name: "Linux Host",
    device: { defaultName: "Linux Host", kind: "desktop", platform: "linux" }, authKeyDigest: digestAuthKey("system-action-target-key") });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  const connections = new ConnectionManager(store), received: DevicePeerRequestFrame[] = [];
  let outcome: "completed" | "failed" | "outcome_unknown" | "wrong echo" = "completed";
  const harness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["remote_desktop"], agent: {
    handle: async frame => {
      received.push(frame);
      const command = frame.payload as contract.DevicePeerCommand;
      if (command.action.case === "getRemoteDesktopCapabilities") return { outcome: "completed", value: { case: "remoteDesktopCapabilities",
        value: create(contract.RemoteDesktopCapabilitiesSchema, { protocolVersion: 1, platform: "linux", canControl: true,
          workspaceNavigation: true, systemMenu: true, permissions: { screenRecording: contract.RemoteDesktopPermissionStatus.GRANTED,
            accessibility: contract.RemoteDesktopPermissionStatus.GRANTED } }) } };
      if (command.action.case === "startRemoteDesktop") return { outcome: "completed", value: { case: "remoteDesktopLease",
        value: create(contract.RemoteDesktopLeaseSchema, { leaseId: "linux-current-lease", controlling: true, controlGeneration: 1n,
          display: { displayId: "primary", name: "Primary", width: 1920, height: 1080 } }) } };
      if (command.action.case === "heartbeatRemoteDesktop") return { outcome: "completed", value: { case: "remoteDesktopControlState",
        value: create(contract.RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n }) } };
      if (command.action.case === "stopRemoteDesktop") return { outcome: "completed", value: { case: "acknowledgement",
        value: create(contract.DevicePeerAcknowledgementSchema) } };
      if (command.action.case !== "performRemoteDesktopSystemAction") throw new Error("Unexpected target action.");
      if (outcome === "failed") return { outcome: "failed", errorCode: "private_target_error",
        failure: create(contract.DevicePeerFailureSchema, { code: contract.DevicePeerFailureCode.UNAVAILABLE, retryable: false,
          remoteDesktop: { reason: contract.RemoteDesktopFailureReason.SYSTEM_ACTION_UNAVAILABLE, retryable: false } }) };
      if (outcome === "outcome_unknown") return { outcome: "outcome_unknown", errorCode: "outcome_unknown" };
      return { outcome: "completed", value: { case: "remoteDesktopSystemAction",
        value: create(contract.RemoteDesktopSystemActionResultSchema, { action: outcome === "wrong echo"
          ? contract.RemoteDesktopSystemActionKind.WORKSPACE_LEFT : command.action.value.action }) } };
    }
  } });
  const owner = new DevicePeerOwner({ store }); owner.registerRoute(target, harness.transport);
  const coordinator = new RemoteDesktopCoordinator({ owner, onRevoked: (id, listener) => connections.onRevoked(id, listener) });
  try {
    const client = createClient(contract.RemoteDesktopService, createRouterTransport(router => {
      router.service(contract.RemoteDesktopService, createRemoteDesktopConnectService({ owner, connections, coordinator }));
    }));
    const options = { headers: { authorization: `Bearer ${key}` } };
    const peer = (await client.listRemoteDesktopHosts({}, options)).hosts[0]!.route;
    await expect(client.getRemoteDesktopCapabilities({ peer }, options))
      .resolves.toMatchObject({ peer, capabilities: { platform: "linux", workspaceNavigation: true, systemMenu: true } });
    const lease = (await client.startRemoteDesktop({ peer, displayId: "primary", mode: contract.RemoteDesktopStartMode.NEW }, options)).lease!;
    const scope = { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration };
    for (const action of [contract.RemoteDesktopSystemActionKind.WORKSPACE_LEFT, contract.RemoteDesktopSystemActionKind.WORKSPACE_RIGHT,
      contract.RemoteDesktopSystemActionKind.SYSTEM_MENU]) {
      await expect(client.performRemoteDesktopSystemAction({ peer, request: { ...scope, action } }, options))
        .resolves.toMatchObject({ peer, result: { action } });
      expect(received.at(-1)).toMatchObject({ controllerDeviceId: controller.deviceId, targetDeviceId: target.deviceId,
        action: "performRemoteDesktopSystemAction", effectKind: "side_effect",
        payload: { action: { case: "performRemoteDesktopSystemAction", value: { ...scope, action } } } });
    }
    const action = contract.RemoteDesktopSystemActionKind.WORKSPACE_RIGHT, request = { ...scope, action };
    await expect(client.performRemoteDesktopSystemAction({ peer, request })).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(client.performRemoteDesktopSystemAction({ peer }, options)).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(client.performRemoteDesktopSystemAction({ peer, request: { ...request, action: 0 } }, options))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(client.performRemoteDesktopSystemAction({ peer, request: { ...request, action: 4 as contract.RemoteDesktopSystemActionKind } }, options))
      .rejects.toMatchObject({ code: Code.InvalidArgument });
    const stale = await client.performRemoteDesktopSystemAction({ peer, request: { ...request, controlGeneration: 99n } }, options)
      .catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: Code.FailedPrecondition });
    expect((stale as { findDetails(schema: typeof contract.RemoteDesktopFailureSchema): contract.RemoteDesktopFailure[] })
      .findDetails(contract.RemoteDesktopFailureSchema)).toMatchObject([{ reason: contract.RemoteDesktopFailureReason.SYSTEM_ACTION_EXPIRED }]);
    const effectCount = () => received.filter(frame => frame.action === "performRemoteDesktopSystemAction").length;
    expect(effectCount()).toBe(3);
    for (const failure of ["failed", "outcome_unknown", "wrong echo"] as const) {
      outcome = failure;
      const error = await client.performRemoteDesktopSystemAction({ peer, request }, options).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: failure === "failed" ? Code.Unavailable : failure === "outcome_unknown" ? Code.Aborted : Code.Internal });
      expect((error as Error).message).not.toContain("private_target_error");
      await expect(client.heartbeatRemoteDesktop({ peer, leaseId: lease.leaseId }, options)).resolves.toMatchObject({ state: { controlling: true } });
    }
    expect(effectCount()).toBe(6);
    expect(received.filter(frame => frame.action === "stopRemoteDesktop")).toHaveLength(0);
  } finally { await coordinator.close(); store.close(); }
});

it("routes generated viewer safety through authenticated Connect and the current DevicePeer lease", async () => {
  const store = new OperationalStore(":memory:");
  const key = "test-controller-key";
  const controller = store.createConnection({
    id: "controller-connection", deviceId: "controller-device", name: "Controller",
    device: { defaultName: "Controller", kind: "mobile", platform: "ios" }, authKeyDigest: digestAuthKey(key)
  });
  const target = store.createConnection({
    id: "target-connection", deviceId: "target-device", name: "Desktop",
    device: { defaultName: "Desktop", kind: "desktop", platform: "macos" }, authKeyDigest: digestAuthKey("test-target-key")
  });
  store.setDeviceRemoteControlEnabled(target.deviceId, true);
  const connections = new ConnectionManager(store);
  const received: DevicePeerRequestFrame[] = [];
  const harness = createInProcessDevicePeerHarness({
    targetDeviceId: target.deviceId, capabilities: ["remote_desktop"], agent: { handle: async (frame) => {
      received.push(frame);
      const command = frame.payload as contract.DevicePeerCommand;
      if (command.action.case === "getRemoteDesktopLockState") {
        return { outcome: "completed", value: { case: "remoteDesktopLockState", value: create(contract.RemoteDesktopLockStateResultSchema,
          { state: contract.RemoteDesktopLockState.LOCKED }) } };
      }
      if (command.action.case === "requestRemoteDesktopCredentials") {
        return { outcome: "completed", value: { case: "remoteDesktopCredentials", value: create(contract.RemoteDesktopCredentialResultSchema,
          { result: { case: "prepared", value: { descriptor: "public identity" } } }) } };
      }
      if (command.action.case === "startRemoteDesktop") {
        return { outcome: "completed", value: { case: "remoteDesktopLease", value: create(contract.RemoteDesktopLeaseSchema, {
          leaseId: "current-lease", controlling: true, controlGeneration: 1n,
          display: { displayId: "primary", name: "Primary", width: 1920, height: 1080 }
        }) } };
      }
      if (command.action.case === "setRemoteDesktopHostMute") {
        return { outcome: "completed", value: { case: "remoteDesktopHostMute", value: create(contract.RemoteDesktopHostMuteResultSchema, {
          enabled: command.action.value.enabled
        }) } };
      }
      if (command.action.case === "setRemoteDesktopDisplayMode") {
        return { outcome: "completed", value: { case: "remoteDesktopDisplayMode", value: create(contract.RemoteDesktopDisplayModeResultSchema, {
          lease: { leaseId: command.action.value.leaseId, controlling: false, controlGeneration: 2n,
            display: { displayId: "primary", name: "Primary", width: 1280, height: 720 } }
        }) } };
      }
      if (command.action.case === "setRemoteDesktopViewerDisplay" || command.action.case === "restoreRemoteDesktopViewerDisplay") {
        const fitted = command.action.case === "setRemoteDesktopViewerDisplay";
        return { outcome: "completed", value: { case: "remoteDesktopViewerDisplay", value: create(contract.RemoteDesktopViewerDisplayResultSchema, {
          lease: { leaseId: command.action.value.leaseId, controlling: false, controlGeneration: command.action.value.controlGeneration + 1n,
            display: { displayId: fitted ? "mirror" : "primary", name: "Primary", width: fitted ? 800 : 1920, height: fitted ? 1200 : 1080 } }
        }) } };
      }
      if (command.action.case === "setRemoteDesktopControl") {
        return { outcome: "completed", value: { case: "remoteDesktopControlState", value: create(contract.RemoteDesktopControlStateSchema,
          { controlling: command.action.value.enabled, controlGeneration: 3n }) } };
      }
      if (command.action.case === "setRemoteDesktopPrivacyScreen") {
        return { outcome: "completed", value: { case: "remoteDesktopPrivacyScreen", value: create(contract.RemoteDesktopPrivacyScreenResultSchema, {
          enabled: command.action.value.enabled
        }) } };
      }
      if (command.action.case === "stopRemoteDesktop") {
        return { outcome: "completed", value: { case: "acknowledgement", value: create(contract.DevicePeerAcknowledgementSchema) } };
      }
      if (command.action.case === "setRemoteDesktopClipboardSync") {
        return { outcome: "completed", value: { case: "remoteDesktopClipboardSync", value: create(contract.RemoteDesktopClipboardSyncResultSchema, {
          enabled: command.action.value.enabled, syncGeneration: command.action.value.enabled ? 1n : 2n
        }) } };
      }
      if (command.action.case === "getRemoteDesktopClipboardVersion") {
        return { outcome: "completed", value: { case: "remoteDesktopClipboardVersion", value: create(contract.RemoteDesktopClipboardVersionResultSchema, { version: "7" }) } };
      }
      if (command.action.case === "transferRemoteDesktopClipboardContent") {
        return { outcome: "completed", value: { case: "remoteDesktopClipboardContent", value: create(contract.RemoteDesktopClipboardContentResultSchema, { version: "8" }) } };
      }
      throw new Error("Unexpected target action.");
    } }
  });
  const owner = new DevicePeerOwner({ store });
  owner.registerRoute(target, harness.transport);
  const coordinator = new RemoteDesktopCoordinator({ owner, onRevoked: (id, listener) => connections.onRevoked(id, listener) });
  try {
    const service = createRemoteDesktopConnectService({ owner, connections, coordinator });
    const client = createClient(contract.RemoteDesktopService, createRouterTransport((router) => {
      router.service(contract.RemoteDesktopService, service);
    }));
    const options = { headers: { authorization: `Bearer ${key}` } };
    const hosts = await client.listRemoteDesktopHosts({}, options);
    const peer = hosts.hosts[0]?.route;
    expect(peer?.targetDeviceId).toBe(target.deviceId);
    await expect(client.getRemoteDesktopLockState({ peer }, options)).resolves.toMatchObject({ peer, result: { state: contract.RemoteDesktopLockState.LOCKED } });
    await expect(client.requestRemoteDesktopCredentials({ peer, request: { request: { case: "prepare", value: {} } } }, options))
      .resolves.toMatchObject({ peer, result: { result: { case: "prepared", value: { descriptor: "public identity" } } } });
    expect(received.at(-1)).toMatchObject({ controllerDeviceId: controller.deviceId, action: "requestRemoteDesktopCredentials" });
    expect(received.some(frame => frame.action === "startRemoteDesktop")).toBe(false);
    await expect(client.requestRemoteDesktopCredentials({ peer }, options)).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(client.requestRemoteDesktopCredentials({ peer, request: {} }, options)).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(client.getRemoteDesktopLockState({ peer })).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(client.requestRemoteDesktopCredentials({ peer, request: { request: { case: "prepare", value: {} } } }))
      .rejects.toMatchObject({ code: Code.Unauthenticated });
    const started = await client.startRemoteDesktop({ peer, displayId: "primary", mode: contract.RemoteDesktopStartMode.NEW }, options);
    const request = { leaseId: started.lease!.leaseId, controlGeneration: started.lease!.controlGeneration, enabled: true };
    await expect(client.setRemoteDesktopHostMute({ peer, request }, options)).resolves.toMatchObject({ peer, result: { enabled: true } });
    expect(received.at(-1)).toMatchObject({
      controllerDeviceId: controller.deviceId, targetDeviceId: target.deviceId, action: "setRemoteDesktopHostMute",
      payload: { action: { case: "setRemoteDesktopHostMute", value: request } }
    });
    await expect(client.setRemoteDesktopHostMute({ peer }, options)).rejects.toMatchObject({ code: Code.InvalidArgument });
    const stale = await client.setRemoteDesktopHostMute({ peer, request: { ...request, controlGeneration: 2n } }, options).catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: Code.FailedPrecondition });
    expect((stale as { findDetails(schema: typeof contract.RemoteDesktopFailureSchema): contract.RemoteDesktopFailure[] })
      .findDetails(contract.RemoteDesktopFailureSchema)).toMatchObject([{ reason: contract.RemoteDesktopFailureReason.HOST_MUTE_EXPIRED }]);
    expect(received.filter((frame) => frame.action === "setRemoteDesktopHostMute")).toHaveLength(1);
    const privacy = { ...request, lockOnExit: true };
    await expect(client.setRemoteDesktopPrivacyScreen({ peer, request: privacy }, options)).resolves.toMatchObject({ peer, result: { enabled: true } });
    expect(received.at(-1)).toMatchObject({ controllerDeviceId: controller.deviceId, action: "setRemoteDesktopPrivacyScreen",
      payload: { action: { case: "setRemoteDesktopPrivacyScreen", value: privacy } } });
    await expect(client.setRemoteDesktopPrivacyScreen({ peer }, options)).rejects.toMatchObject({ code: Code.InvalidArgument });
    const stalePrivacy = await client.setRemoteDesktopPrivacyScreen({ peer, request: { ...privacy, controlGeneration: 2n } }, options).catch((error: unknown) => error);
    expect((stalePrivacy as { findDetails(schema: typeof contract.RemoteDesktopFailureSchema): contract.RemoteDesktopFailure[] })
      .findDetails(contract.RemoteDesktopFailureSchema)).toMatchObject([{ reason: contract.RemoteDesktopFailureReason.PRIVACY_EXPIRED }]);
    expect(received.filter(frame => frame.action === "setRemoteDesktopPrivacyScreen")).toHaveLength(1);
    const sync = await client.setRemoteDesktopClipboardSync({ peer, request }, options);
    expect(sync.result).toMatchObject({ enabled: true, syncGeneration: 1n });
    await expect(client.setRemoteDesktopClipboardSync({ peer }, options)).rejects.toMatchObject({ code: Code.InvalidArgument });
    const versionRequest = { leaseId: request.leaseId, controlGeneration: request.controlGeneration, syncGeneration: sync.result!.syncGeneration };
    await expect(client.getRemoteDesktopClipboardVersion({ peer, request: versionRequest }, options)).resolves.toMatchObject({ peer, result: { version: "7" } });
    await expect(client.getRemoteDesktopClipboardVersion({ peer }, options)).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(client.transferRemoteDesktopClipboardContent({ peer, transfer: { ...versionRequest, sync: true, version: "7",
      action: { case: "paste", value: { data: '{"text":"new copy"}' } } } }, options)).resolves.toMatchObject({ peer, result: { version: "8" } });
    expect(received.at(-1)).toMatchObject({ controllerDeviceId: controller.deviceId, action: "transferRemoteDesktopClipboardContent", payload: {
      action: { value: { ...versionRequest, sync: true, version: "7", action: { case: "paste", value: { data: '{"text":"new copy"}' } } } }
    } });
    await client.setRemoteDesktopClipboardSync({ peer, request: { ...request, enabled: false } }, options);
    await expect(client.getRemoteDesktopClipboardVersion({ peer, request: versionRequest }, options)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(received.filter(frame => frame.action === "getRemoteDesktopClipboardVersion")).toHaveLength(1);
    const exit = { peer, leaseId: started.lease!.leaseId, lockScreen: true, controlGeneration: started.lease!.controlGeneration };
    const staleExit = await client.stopRemoteDesktop({ ...exit, controlGeneration: 2n }, options).catch((error: unknown) => error);
    expect((staleExit as { findDetails(schema: typeof contract.RemoteDesktopFailureSchema): contract.RemoteDesktopFailure[] })
      .findDetails(contract.RemoteDesktopFailureSchema)).toMatchObject([{ reason: contract.RemoteDesktopFailureReason.LOCK_EXPIRED }]);
    await expect(client.stopRemoteDesktop(exit, options)).resolves.toMatchObject({ peer });
    expect(received.at(-1)).toMatchObject({
      controllerDeviceId: controller.deviceId, action: "stopRemoteDesktop", payload: { action: { case: "stopRemoteDesktop", value: {
        leaseId: exit.leaseId, lockScreen: true, controlGeneration: exit.controlGeneration
      } } }
    });
    await expect(client.stopRemoteDesktop(exit, options)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(received.filter((frame) => frame.action === "stopRemoteDesktop")).toHaveLength(1);
    const next = await client.startRemoteDesktop({ peer, displayId: "primary", mode: contract.RemoteDesktopStartMode.NEW }, options);
    await expect(client.setRemoteDesktopDisplayMode({ peer, leaseId: next.lease!.leaseId,
      controlGeneration: next.lease!.controlGeneration, modeId: "102", temporary: true }, options)).resolves.toMatchObject({
      peer, result: { lease: { leaseId: next.lease!.leaseId, controlling: false, controlGeneration: 2n,
        display: { width: 1280, height: 720 } } }
    });
    expect(received.at(-1)).toMatchObject({ controllerDeviceId: controller.deviceId, action: "setRemoteDesktopDisplayMode",
      payload: { action: { value: { temporary: true, modeId: "102" } } } });
    const mirrorStart = await client.startRemoteDesktop({ peer, displayId: "primary", mode: contract.RemoteDesktopStartMode.NEW }, options);
    await expect(client.setRemoteDesktopViewerDisplay({ peer, leaseId: mirrorStart.lease!.leaseId, controlGeneration: 1n,
      width: 800, height: 1200 })).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(client.setRemoteDesktopViewerDisplay({ peer, leaseId: mirrorStart.lease!.leaseId, controlGeneration: 1n,
      width: 319, height: 1200 }, options)).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(client.setRemoteDesktopViewerDisplay({ peer, leaseId: mirrorStart.lease!.leaseId, controlGeneration: 1n,
      width: 800, height: 1200 }, options)).resolves.toMatchObject({ peer, result: { lease: {
      leaseId: mirrorStart.lease!.leaseId, controlling: false, controlGeneration: 2n, display: { displayId: "mirror", width: 800, height: 1200 }
    } } });
    expect(received.at(-1)).toMatchObject({ controllerDeviceId: controller.deviceId, action: "setRemoteDesktopViewerDisplay",
      payload: { action: { value: { leaseId: mirrorStart.lease!.leaseId, controlGeneration: 1n, width: 800, height: 1200 } } } });
    await client.setRemoteDesktopControl({ peer, leaseId: mirrorStart.lease!.leaseId, enabled: true }, options);
    await expect(client.restoreRemoteDesktopViewerDisplay({ peer, leaseId: mirrorStart.lease!.leaseId, controlGeneration: 3n }, options))
      .resolves.toMatchObject({ peer, result: { lease: { controlling: false, controlGeneration: 4n, display: { displayId: "primary", width: 1920, height: 1080 } } } });
    expect(received.at(-1)).toMatchObject({ controllerDeviceId: controller.deviceId, action: "restoreRemoteDesktopViewerDisplay",
      payload: { action: { value: { leaseId: mirrorStart.lease!.leaseId, controlGeneration: 3n } } } });
  } finally {
    await coordinator.close();
    store.close();
  }
});
