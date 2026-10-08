import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import {
  createInProcessDevicePeerHarness,
  type DevicePeerMultiplexEvent,
  type DevicePeerRequestFrame,
  type DevicePeerResponseFrame
} from "@joko/device-peer";
import { OperationalStore, type ConnectionRecord } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type DevicePeerAuthority,
  DevicePeerOwner,
  type DevicePeerSelectionIdentity
} from "./device-peer-owner.js";
import {
  RemoteDesktopCoordinator,
  type RemoteDesktopCoordinatorOptions
} from "./remote-desktop-coordinator.js";

const signal = new AbortController().signal;
const connection = connectionRecord();
const identity = selectionIdentity();
const coordinators: RemoteDesktopCoordinator[] = [];
const stores: OperationalStore[] = [];

afterEach(async () => {
  await Promise.allSettled(coordinators.splice(0).map((coordinator) => coordinator.close()));
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RemoteDesktopCoordinator", () => {
  it("delivers start with the authenticated controller Device identity", async () => {
    const store = new OperationalStore(":memory:");
    stores.push(store);
    const controller = store.createConnection({
      id: "connection-controller",
      deviceId: "device-controller",
      device: { defaultName: "Controller", kind: "mobile", platform: "ios" },
      name: "Controller",
      authKeyDigest: "controller-digest"
    });
    const target = store.createConnection({
      id: "connection-target",
      deviceId: "device-target",
      device: { defaultName: "Target Desktop", kind: "desktop", platform: "windows" },
      name: "Target Desktop",
      authKeyDigest: "target-digest"
    });
    store.setDeviceRemoteControlEnabled(target.deviceId, true);
    const received: DevicePeerRequestFrame[] = [];
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: target.deviceId,
      capabilities: ["remote_desktop"],
      agent: {
        handle: async (frame) => {
          received.push(frame);
          if (frame.action === "startRemoteDesktop") {
            return { outcome: "completed", value: result("remoteDesktopLease", remoteDesktopLease()) };
          }
          if (frame.action === "stopRemoteDesktop") {
            return { outcome: "completed", value: acknowledgementResult() };
          }
          throw new Error(`Unexpected action: ${frame.action}`);
        }
      }
    });
    const owner = new DevicePeerOwner({ store });
    owner.registerRoute(target, harness.transport);
    const selected = owner.listForCapabilities(controller, ["remote_desktop"], { kind: "desktop" })[0]!;
    const coordinator = track(new RemoteDesktopCoordinator({
      owner,
      onRevoked: () => () => undefined
    }));

    await coordinator.start(controller, selected, {
      displayId: "display-1",
      mode: contract.RemoteDesktopStartMode.NEW
    }, signal);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      controllerDeviceId: controller.deviceId,
      targetDeviceId: target.deviceId,
      capability: "remote_desktop",
      action: "startRemoteDesktop"
    });
    expect(received[0]!.payload).toMatchObject({
      controllerDeviceId: controller.deviceId,
      capability: contract.DevicePeerCapabilityKind.REMOTE_DESKTOP,
      action: { case: "startRemoteDesktop" }
    });
  });

  it("forwards explicit clipboard requests only for the exact active control generation", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);

    const copied = await coordinator.transferClipboardText(
      connection,
      identity,
      create(contract.RemoteDesktopClipboardTextRequestSchema, {
        leaseId: lease.leaseId,
        controlGeneration: lease.controlGeneration,
        action: {
          case: "copy",
          value: create(contract.RemoteDesktopClipboardTextCopyActionSchema)
        }
      }),
      signal
    );
    expect(copied.text).toBe("desktop text");
    const command = fake.calls.at(-1)?.input.payload as contract.DevicePeerCommand;
    expect(fake.calls.at(-1)?.authority.controllerDeviceId).toBe(connection.deviceId);
    expect(command).toMatchObject({
      action: {
        case: "transferRemoteDesktopClipboardText",
        value: { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration }
      }
    });

    const begun = await coordinator.transferClipboardContent(
      connection,
      identity,
      create(contract.RemoteDesktopClipboardContentRequestSchema, {
        leaseId: lease.leaseId,
        controlGeneration: lease.controlGeneration,
        action: {
          case: "begin",
          value: create(contract.RemoteDesktopClipboardContentBeginActionSchema, { length: 24 })
        }
      }),
      signal
    );
    expect(begun.transferId).toBe("transfer-1");

    await expect(coordinator.transferClipboardText(
      connection,
      identity,
      create(contract.RemoteDesktopClipboardTextRequestSchema, {
        leaseId: lease.leaseId,
        controlGeneration: lease.controlGeneration + 1n,
        action: {
          case: "copy",
          value: create(contract.RemoteDesktopClipboardTextCopyActionSchema)
        }
      }),
      signal
    )).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED }
    });
    expect(fake.actions().filter((action) => action === "transferRemoteDesktopClipboardText")).toHaveLength(1);

    const stopped = await coordinator.setControl(connection, identity, {
      leaseId: lease.leaseId,
      enabled: false
    }, signal);
    await expect(coordinator.transferClipboardContent(
      connection,
      identity,
      create(contract.RemoteDesktopClipboardContentRequestSchema, {
        leaseId: lease.leaseId,
        controlGeneration: stopped.controlGeneration,
        action: {
          case: "copy",
          value: create(contract.RemoteDesktopClipboardContentCopyActionSchema)
        }
      }),
      signal
    )).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.VIEW_ONLY }
    });
  });

  it("lists lease-bound modes and retires the exact controlling lease after a successful mode write", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);

    await expect(coordinator.listDisplayModes(
      connection,
      identity,
      lease.leaseId,
      signal
    )).resolves.toMatchObject([
      { modeId: "101", width: 1920, height: 1080, current: true, native: true }
    ]);
    expect(fake.calls.at(-1)?.input).toMatchObject({
      action: "listRemoteDesktopDisplayModes",
      effectKind: "read_only"
    });

    await expect(coordinator.setDisplayMode(connection, identity, {
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration + 1n,
      modeId: "101"
    }, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED }
    });
    expect(fake.actions().filter((action) => action === "setRemoteDesktopDisplayMode")).toHaveLength(0);

    await expect(coordinator.setDisplayMode(connection, identity, {
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration,
      modeId: "101"
    }, signal)).resolves.toBeUndefined();
    const command = fake.calls.at(-1)?.input.payload as contract.DevicePeerCommand;
    expect(command).toMatchObject({
      action: {
        case: "setRemoteDesktopDisplayMode",
        value: {
          leaseId: lease.leaseId,
          controlGeneration: lease.controlGeneration,
          modeId: "101"
        }
      }
    });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });
  });

  it("keeps the lease only for a typed pre-effect display-mode failure", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);
    const previousDispatch = fake.dispatchHandler;
    fake.dispatchHandler = async (authority, input) => input.action === "setRemoteDesktopDisplayMode"
      ? failedRemoteDesktop(contract.RemoteDesktopFailureReason.DISPLAY_MODE_MISSING)
      : previousDispatch(authority, input);

    await expect(coordinator.setDisplayMode(connection, identity, {
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration,
      modeId: "999"
    }, signal)).rejects.toMatchObject({
      code: "not_found",
      detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_MODE_MISSING }
    });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toMatchObject({
      controlling: true,
      controlGeneration: lease.controlGeneration
    });
  });

  it("allows only one display-mode write in flight for a lease", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);
    const previousDispatch = fake.dispatchHandler;
    let finish: ((response: DevicePeerResponseFrame) => void) | undefined;
    fake.dispatchHandler = (authority, input) => input.action === "setRemoteDesktopDisplayMode"
      ? new Promise<DevicePeerResponseFrame>((resolve) => { finish = resolve; })
      : previousDispatch(authority, input);

    const first = coordinator.setDisplayMode(connection, identity, {
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration,
      modeId: "101"
    }, signal);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(coordinator.setDisplayMode(connection, identity, {
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration,
      modeId: "101"
    }, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_BUSY }
    });
    expect(fake.actions().filter((action) => action === "setRemoteDesktopDisplayMode")).toHaveLength(1);
    finish?.(completed(acknowledgementResult()));
    await expect(first).resolves.toBeUndefined();
  });

  it.each([
    ["unavailable", contract.DevicePeerFailureCode.UNAVAILABLE],
    ["cancelled", contract.DevicePeerFailureCode.CANCELLED]
  ] as const)("retires the old lease after a post-dispatch %s result without domain proof", async (
    errorCode,
    failureCode
  ) => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);
    const previousDispatch = fake.dispatchHandler;
    fake.dispatchHandler = async (authority, input) => input.action === "setRemoteDesktopDisplayMode"
      ? {
          protocolVersion: 1,
          kind: "response",
          requestId: "mode-failed",
          targetDeviceId: identity.targetDeviceId,
          routeGeneration: identity.routeGeneration,
          outcome: "failed",
          errorCode,
          failure: create(contract.DevicePeerFailureSchema, {
            code: failureCode,
            retryable: true
          })
        }
      : previousDispatch(authority, input);

    await expect(coordinator.setDisplayMode(connection, identity, {
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration,
      modeId: "101"
    }, signal)).rejects.toMatchObject({ code: errorCode });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });
  });

  it("retires an outcome-unknown mode write even when it carries a pre-effect-looking detail", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);
    const previousDispatch = fake.dispatchHandler;
    fake.dispatchHandler = async (authority, input) => input.action === "setRemoteDesktopDisplayMode"
      ? {
          protocolVersion: 1,
          kind: "response",
          requestId: "mode-unknown",
          targetDeviceId: identity.targetDeviceId,
          routeGeneration: identity.routeGeneration,
          outcome: "outcome_unknown",
          errorCode: "receipt_lost",
          failure: create(contract.DevicePeerFailureSchema, {
            code: contract.DevicePeerFailureCode.NOT_FOUND,
            retryable: false,
            remoteDesktop: create(contract.RemoteDesktopFailureSchema, {
              reason: contract.RemoteDesktopFailureReason.DISPLAY_MODE_MISSING,
              retryable: false
            })
          })
        }
      : previousDispatch(authority, input);

    await expect(coordinator.setDisplayMode(connection, identity, {
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration,
      modeId: "101"
    }, signal)).rejects.toMatchObject({ code: "aborted" });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });
  });

  it("never returns a lower control generation when concurrent control replies arrive out of order", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    await start(coordinator);
    const previousDispatch = fake.dispatchHandler;
    let finishOlder: ((response: DevicePeerResponseFrame) => void) | undefined;
    let finishNewer: ((response: DevicePeerResponseFrame) => void) | undefined;
    fake.dispatchHandler = (authority, input) => {
      if (input.action !== "setRemoteDesktopControl") return previousDispatch(authority, input);
      const command = input.payload as contract.DevicePeerCommand;
      if (command.action.case !== "setRemoteDesktopControl") throw new Error("Expected control action.");
      const enabled = command.action.value.enabled;
      return new Promise<DevicePeerResponseFrame>((resolve) => {
        if (enabled) finishNewer = resolve;
        else finishOlder = resolve;
      });
    };

    const older = coordinator.setControl(connection, identity, { leaseId: "lease-1", enabled: false }, signal);
    const newer = coordinator.setControl(connection, identity, { leaseId: "lease-1", enabled: true }, signal);
    finishNewer?.(completed(result("remoteDesktopControlState", create(
      contract.RemoteDesktopControlStateSchema,
      { controlling: true, controlGeneration: 3n }
    ))));
    await expect(newer).resolves.toMatchObject({ controlling: true, controlGeneration: 3n });
    finishOlder?.(completed(result("remoteDesktopControlState", create(
      contract.RemoteDesktopControlStateSchema,
      { controlling: false, controlGeneration: 2n }
    ))));
    await expect(older).resolves.toMatchObject({ controlling: true, controlGeneration: 3n });

    await expect(coordinator.transferClipboardText(
      connection,
      identity,
      create(contract.RemoteDesktopClipboardTextRequestSchema, {
        leaseId: "lease-1",
        controlGeneration: 3n,
        action: {
          case: "copy",
          value: create(contract.RemoteDesktopClipboardTextCopyActionSchema)
        }
      }),
      signal
    )).resolves.toMatchObject({ text: "desktop text" });
  });

  it("renews the twelve-second lease on heartbeat and expires it at the exact boundary", async () => {
    let now = 1_000;
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake, { now: () => now }).coordinator;
    await start(coordinator);

    now = 12_999;
    await expect(coordinator.heartbeat(connection, identity, "lease-1", signal)).resolves.toMatchObject({
      controlling: true
    });
    now = 24_998;
    await expect(coordinator.setControl(connection, identity, {
      leaseId: "lease-1",
      enabled: false
    }, signal)).resolves.toMatchObject({ controlling: false });

    now = 24_999;
    await expect(coordinator.heartbeat(connection, identity, "lease-1", signal)).rejects.toMatchObject({
      code: "failed_precondition",
      detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED }
    });
    expect(fake.actions()).toEqual([
      "startRemoteDesktop",
      "heartbeatRemoteDesktop",
      "setRemoteDesktopControl",
      "stopRemoteDesktop"
    ]);
  });

  it("does not renew presentation when the exact target proof does not advance", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const proofSequence = 0n;
    const fake = new FakeDevicePeerOwner();
    const previousDispatch = fake.dispatchHandler;
    fake.dispatchHandler = (authority, input) => input.action === "probeRemoteDesktopPresentation"
      ? Promise.resolve(completed(result("remoteDesktopPresentationProof", create(
          contract.RemoteDesktopPresentationProofSchema,
          { leaseId: "lease-1", proofSequence }
        ))))
      : previousDispatch(authority, input);
    const coordinator = fakeCoordinator(fake, { now: () => now }).coordinator;
    const lease = await start(coordinator);

    await expect(coordinator.setPresentation(connection, identity, {
      leaseId: lease.leaseId,
      enabled: true
    }, signal)).resolves.toMatchObject({ controlling: false, controlGeneration: 2n });
    expect(fake.actions()).toEqual([
      "startRemoteDesktop",
      "setRemoteDesktopPresentation",
      "probeRemoteDesktopPresentation"
    ]);

    now = 4_000;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.actions().filter((action) => action === "probeRemoteDesktopPresentation")).toHaveLength(2);
    expect(fake.actions()).not.toContain("heartbeatRemoteDesktop");

    now = 12_999;
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toMatchObject({
      controlling: false,
      controlGeneration: 2n
    });
    expect(fake.actions()).not.toContain("heartbeatRemoteDesktop");

    now = 13_000;
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED }
    });
  });

  it("renews presentation after a strictly newer target proof", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    let proofSequence = 0n;
    const fake = new FakeDevicePeerOwner();
    const previousDispatch = fake.dispatchHandler;
    fake.dispatchHandler = (authority, input) => input.action === "probeRemoteDesktopPresentation"
      ? Promise.resolve(completed(result("remoteDesktopPresentationProof", create(
          contract.RemoteDesktopPresentationProofSchema,
          { leaseId: "lease-1", proofSequence }
        ))))
      : previousDispatch(authority, input);
    const coordinator = fakeCoordinator(fake, { now: () => now }).coordinator;
    const lease = await start(coordinator);
    await coordinator.setPresentation(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);

    proofSequence = 1n;
    now = 4_000;
    await vi.advanceTimersByTimeAsync(3_000);
    now = 15_999;
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toBeDefined();
    now = 16_000;
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED }
    });
  });

  it("lets a temporary presentation probe failure age out without renewing or immediate retirement", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    let probes = 0;
    const fake = new FakeDevicePeerOwner();
    const previousDispatch = fake.dispatchHandler;
    fake.dispatchHandler = (authority, input) => {
      if (input.action !== "probeRemoteDesktopPresentation") return previousDispatch(authority, input);
      probes += 1;
      if (probes === 1) {
        return Promise.resolve(completed(result("remoteDesktopPresentationProof", create(
          contract.RemoteDesktopPresentationProofSchema,
          { leaseId: "lease-1", proofSequence: 0n }
        ))));
      }
      return Promise.reject(new DOMException("temporary timeout", "TimeoutError"));
    };
    const coordinator = fakeCoordinator(fake, { now: () => now }).coordinator;
    const lease = await start(coordinator);
    await coordinator.setPresentation(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);

    now = 4_000;
    await vi.advanceTimersByTimeAsync(3_000);
    now = 4_001;
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toBeDefined();
    now = 13_000;
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED }
    });
  });

  it("retires a lease when the presentation side-effect outcome is unknown", async () => {
    const fake = new FakeDevicePeerOwner();
    const previousDispatch = fake.dispatchHandler;
    fake.dispatchHandler = (authority, input) => input.action === "setRemoteDesktopPresentation"
      ? Promise.resolve({
          protocolVersion: 1,
          kind: "response",
          requestId: "presentation-unknown",
          targetDeviceId: identity.targetDeviceId,
          routeGeneration: identity.routeGeneration,
          outcome: "outcome_unknown",
          errorCode: "authority_changed"
        })
      : previousDispatch(authority, input);
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);

    await expect(coordinator.setPresentation(connection, identity, {
      leaseId: lease.leaseId,
      enabled: true
    }, signal)).rejects.toMatchObject({ code: "aborted" });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });
    expect(fake.actions()).toContain("stopRemoteDesktop");
  });

  it("rejects a heartbeat whose lease expires before the async completion", async () => {
    let now = 1_000;
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake, { now: () => now }).coordinator;
    await start(coordinator);
    const previousDispatch = fake.dispatchHandler;
    let finishHeartbeat: ((response: DevicePeerResponseFrame) => void) | undefined;
    fake.dispatchHandler = (authority, input) => input.action === "heartbeatRemoteDesktop"
      ? new Promise<DevicePeerResponseFrame>((resolve) => { finishHeartbeat = resolve; })
      : previousDispatch(authority, input);

    const heartbeat = coordinator.heartbeat(connection, identity, "lease-1", signal);
    expect(finishHeartbeat).toBeTypeOf("function");
    now = 13_000;
    finishHeartbeat?.(completed(result("remoteDesktopControlState", create(
      contract.RemoteDesktopControlStateSchema,
      { controlling: true, controlGeneration: 1n }
    ))));

    await expect(heartbeat).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED }
    });
    expect(fake.actions()).toContain("stopRemoteDesktop");
  });

  it("does not return ICE configuration after the lease is revoked in flight", async () => {
    const fake = new FakeDevicePeerOwner();
    const revocations = new RevocationHarness();
    let finishConfiguration: ((servers: readonly contract.RemoteDesktopIceServer[]) => void) | undefined;
    const coordinator = fakeCoordinator(fake, {
      onRevoked: revocations.subscribe,
      iceConfiguration: {
        getConfiguration: () => new Promise((resolve) => { finishConfiguration = resolve; })
      }
    }).coordinator;
    await start(coordinator);

    const configuration = coordinator.getIceConfiguration(connection, identity, "lease-1", signal);
    expect(finishConfiguration).toBeTypeOf("function");
    revocations.revoke(connection.id);
    finishConfiguration?.([]);

    await expect(configuration).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });
    expect(fake.actions()).toContain("stopRemoteDesktop");
  });

  it("fences the lease to the exact controller Connection and peer identity", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    await start(coordinator);

    await expect(coordinator.heartbeat(
      { ...connection, id: "connection-other" },
      identity,
      "lease-1",
      signal
    )).rejects.toMatchObject({
      code: "permission_denied",
      detail: { reason: contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED }
    });
    await expect(coordinator.heartbeat(
      { ...connection, deviceId: "device-other" },
      identity,
      "lease-1",
      signal
    )).rejects.toMatchObject({
      code: "permission_denied",
      detail: { reason: contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED }
    });

    const mismatchedPeers: DevicePeerSelectionIdentity[] = [
      { ...identity, targetDeviceId: "target-other" },
      { ...identity, targetDeviceRevision: identity.targetDeviceRevision + 1n },
      { ...identity, relationId: "relation-other" },
      { ...identity, relationRevision: identity.relationRevision + 1n },
      { ...identity, routeGeneration: identity.routeGeneration + 1 }
    ];
    for (const peer of mismatchedPeers) {
      await expect(coordinator.heartbeat(connection, peer, "lease-1", signal)).rejects.toMatchObject({
        code: "aborted",
        detail: { reason: contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED }
      });
    }
    await expect(coordinator.heartbeat(connection, identity, "lease-1", signal)).resolves.toBeDefined();
  });

  it("permits RESUME only from the current exact Connection, peer, and display", async () => {
    const fake = new FakeDevicePeerOwner();
    const revocations = new RevocationHarness();
    const previousDispatch = fake.dispatchHandler;
    let starts = 0;
    fake.dispatchHandler = (authority, input) => {
      if (input.action !== "startRemoteDesktop") return previousDispatch(authority, input);
      starts += 1;
      return Promise.resolve(completed(result(
        "remoteDesktopLease",
        remoteDesktopLease(starts === 1 ? "lease-1" : "lease-2")
      )));
    };
    const coordinator = fakeCoordinator(fake, { onRevoked: revocations.subscribe }).coordinator;
    await start(coordinator);
    const dispatchesAfterStart = fake.calls.length;

    await expect(coordinator.start(
      connectionRecord("connection-reconnected", connection.deviceId),
      identity,
      { displayId: "display-1", mode: contract.RemoteDesktopStartMode.RESUME },
      signal
    )).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.STOPPED } });
    await expect(coordinator.start(
      connection,
      identity,
      { displayId: "display-2", mode: contract.RemoteDesktopStartMode.RESUME },
      signal
    )).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.STOPPED } });
    expect(fake.calls).toHaveLength(dispatchesAfterStart);

    await expect(coordinator.start(
      connection,
      identity,
      { displayId: "display-1", mode: contract.RemoteDesktopStartMode.RESUME },
      signal
    )).resolves.toMatchObject({ leaseId: "lease-2" });

    revocations.revoke(connection.id);
    await expect(coordinator.start(
      connectionRecord("connection-reconnected", connection.deviceId),
      identity,
      { displayId: "display-1", mode: contract.RemoteDesktopStartMode.RESUME },
      signal
    )).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.STOPPED } });
    expect(starts).toBe(2);
  });

  it("keeps a newer TAKEOVER when an earlier NEW start completes late", async () => {
    const fake = new FakeDevicePeerOwner();
    const previousDispatch = fake.dispatchHandler;
    let finishNew: ((response: DevicePeerResponseFrame) => void) | undefined;
    let finishTakeover: ((response: DevicePeerResponseFrame) => void) | undefined;
    fake.dispatchHandler = (authority, input) => {
      if (input.action !== "startRemoteDesktop") return previousDispatch(authority, input);
      const command = input.payload as contract.DevicePeerCommand;
      if (command.action.case !== "startRemoteDesktop") throw new Error("Expected Remote Desktop start.");
      const action = command.action as Extract<
        contract.DevicePeerCommand["action"],
        { case: "startRemoteDesktop" }
      >;
      return new Promise<DevicePeerResponseFrame>((resolve) => {
        if (action.value.mode === contract.RemoteDesktopStartMode.NEW) finishNew = resolve;
        else if (action.value.mode === contract.RemoteDesktopStartMode.TAKEOVER) finishTakeover = resolve;
        else throw new Error("Unexpected Remote Desktop start mode.");
      });
    };
    const coordinator = fakeCoordinator(fake).coordinator;

    const first = coordinator.start(connection, identity, {
      displayId: "display-1",
      mode: contract.RemoteDesktopStartMode.NEW
    }, signal);
    const takeover = coordinator.start(connection, identity, {
      displayId: "display-1",
      mode: contract.RemoteDesktopStartMode.TAKEOVER
    }, signal);
    expect(finishNew).toBeTypeOf("function");
    expect(finishTakeover).toBeTypeOf("function");

    finishTakeover?.(completed(result("remoteDesktopLease", remoteDesktopLease("lease-takeover"))));
    await expect(takeover).resolves.toMatchObject({ leaseId: "lease-takeover" });
    finishNew?.(completed(result("remoteDesktopLease", remoteDesktopLease("lease-new"))));
    await expect(first).rejects.toMatchObject({
      code: "aborted",
      detail: { reason: contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED }
    });

    await expect(coordinator.heartbeat(connection, identity, "lease-takeover", signal)).resolves.toBeDefined();
    expect(stoppedLeaseIds(fake)).toContain("lease-new");
  });

  it("keeps a newer TAKEOVER when an earlier RESUME completes late", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    await start(coordinator);
    const previousDispatch = fake.dispatchHandler;
    let finishResume: ((response: DevicePeerResponseFrame) => void) | undefined;
    let finishTakeover: ((response: DevicePeerResponseFrame) => void) | undefined;
    fake.dispatchHandler = (authority, input) => {
      if (input.action !== "startRemoteDesktop") return previousDispatch(authority, input);
      const command = input.payload as contract.DevicePeerCommand;
      if (command.action.case !== "startRemoteDesktop") throw new Error("Expected Remote Desktop start.");
      const action = command.action as Extract<
        contract.DevicePeerCommand["action"],
        { case: "startRemoteDesktop" }
      >;
      return new Promise<DevicePeerResponseFrame>((resolve) => {
        if (action.value.mode === contract.RemoteDesktopStartMode.RESUME) finishResume = resolve;
        else if (action.value.mode === contract.RemoteDesktopStartMode.TAKEOVER) finishTakeover = resolve;
        else throw new Error("Unexpected Remote Desktop start mode.");
      });
    };

    const resume = coordinator.start(connection, identity, {
      displayId: "display-1",
      mode: contract.RemoteDesktopStartMode.RESUME
    }, signal);
    const takeover = coordinator.start(connection, identity, {
      displayId: "display-1",
      mode: contract.RemoteDesktopStartMode.TAKEOVER
    }, signal);
    expect(finishResume).toBeTypeOf("function");
    expect(finishTakeover).toBeTypeOf("function");

    finishTakeover?.(completed(result("remoteDesktopLease", remoteDesktopLease("lease-takeover"))));
    await expect(takeover).resolves.toMatchObject({ leaseId: "lease-takeover" });
    finishResume?.(completed(result("remoteDesktopLease", remoteDesktopLease("lease-resume"))));
    await expect(resume).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });

    await expect(coordinator.heartbeat(connection, identity, "lease-takeover", signal)).resolves.toBeDefined();
    expect(stoppedLeaseIds(fake)).toContain("lease-resume");
  });

  it("distinguishes an exact expired RESUME until a NEW lease replaces it", async () => {
    let now = 1_000;
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake, { now: () => now }).coordinator;
    await start(coordinator);
    now = 13_000;

    await expect(coordinator.heartbeat(connection, identity, "lease-1", signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED }
    });
    const startsAfterExpiry = fake.actions().filter((action) => action === "startRemoteDesktop").length;
    await expect(coordinator.start(connection, identity, {
      displayId: "display-1",
      mode: contract.RemoteDesktopStartMode.RESUME
    }, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED }
    });
    await expect(coordinator.start(connectionRecord("connection-other", connection.deviceId), identity, {
      displayId: "display-1",
      mode: contract.RemoteDesktopStartMode.RESUME
    }, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });
    expect(fake.actions().filter((action) => action === "startRemoteDesktop")).toHaveLength(startsAfterExpiry);

    await expect(start(coordinator)).resolves.toMatchObject({ leaseId: "lease-1" });
    await coordinator.stop(connection, identity, "lease-1", signal);
    await expect(coordinator.start(connection, identity, {
      displayId: "display-1",
      mode: contract.RemoteDesktopStartMode.RESUME
    }, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });
  });

  it("does not install a NEW lease whose completion arrives after close", async () => {
    const fake = new FakeDevicePeerOwner();
    const previousDispatch = fake.dispatchHandler;
    let finishStart: ((response: DevicePeerResponseFrame) => void) | undefined;
    fake.dispatchHandler = (authority, input) => input.action === "startRemoteDesktop"
      ? new Promise<DevicePeerResponseFrame>((resolve) => { finishStart = resolve; })
      : previousDispatch(authority, input);
    const coordinator = fakeCoordinator(fake).coordinator;

    const starting = start(coordinator);
    expect(finishStart).toBeTypeOf("function");
    await coordinator.close();
    finishStart?.(completed(result("remoteDesktopLease", remoteDesktopLease("lease-late"))));

    await expect(starting).rejects.toMatchObject({ code: "unavailable" });
    expect(stoppedLeaseIds(fake)).toContain("lease-late");
  });

  it("invalidates the local lease before awaiting target stop", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    await start(coordinator);
    const previousDispatch = fake.dispatchHandler;
    let finishStop: ((response: DevicePeerResponseFrame) => void) | undefined;
    fake.dispatchHandler = (authority, input) => input.action === "stopRemoteDesktop"
      ? new Promise<DevicePeerResponseFrame>((resolve) => { finishStop = resolve; })
      : previousDispatch(authority, input);

    const stopping = coordinator.stop(connection, identity, "lease-1", signal);
    expect(finishStop).toBeTypeOf("function");
    await expect(coordinator.heartbeat(connection, identity, "lease-1", signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });

    finishStop?.(completed(acknowledgementResult()));
    await expect(stopping).resolves.toBeUndefined();
  });

  it("preserves typed target failure detail and maps its public error code", async () => {
    const fake = new FakeDevicePeerOwner();
    const detail = create(contract.RemoteDesktopFailureSchema, {
      reason: contract.RemoteDesktopFailureReason.DISPLAY_MISSING,
      retryable: true
    });
    fake.dispatchHandler = async () => ({
      protocolVersion: 1,
      kind: "response",
      requestId: "request-failed",
      targetDeviceId: identity.targetDeviceId,
      routeGeneration: identity.routeGeneration,
      outcome: "failed",
      errorCode: "not_found",
      failure: create(contract.DevicePeerFailureSchema, {
        code: contract.DevicePeerFailureCode.NOT_FOUND,
        retryable: true,
        remoteDesktop: detail
      })
    });
    const coordinator = fakeCoordinator(fake).coordinator;

    await expect(start(coordinator)).rejects.toMatchObject({
      code: "not_found",
      detail: {
        $typeName: "joko.v1.RemoteDesktopFailure",
        reason: contract.RemoteDesktopFailureReason.DISPLAY_MISSING,
        retryable: true
      }
    });
  });

  it("rejects representative input, SDP, ICE, and JPEG over-budget boundaries", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    await start(coordinator);
    const dispatchesAfterStart = fake.calls.length;

    const releases = Array.from({ length: 65 }, () => create(contract.RemoteDesktopInputEventSchema, {
      event: { case: "release", value: create(contract.RemoteDesktopReleaseInputSchema) }
    }));
    await expect(coordinator.sendInput(connection, identity, {
      leaseId: "lease-1",
      sequence: 1n,
      events: releases
    }, signal)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(coordinator.createOffer(connection, identity, {
      leaseId: "lease-1",
      attemptId: "attempt-1",
      offerSdp: "s".repeat(64 * 1024 + 1),
      cursorOverlay: false
    }, signal)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(coordinator.createOffer(connection, identity, {
      leaseId: "lease-1",
      attemptId: "attempt-1",
      offerSdp: "v=0\r\n",
      settings: create(contract.RemoteDesktopVideoSettingsSchema, {
        fps: 24,
        quality: contract.RemoteDesktopVideoQuality.HD,
        audio: true
      }),
      cursorOverlay: false
    }, signal)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(coordinator.createOffer(connection, identity, {
      leaseId: "lease-1",
      attemptId: "attempt-1",
      offerSdp: "v=0\r\n",
      settings: create(contract.RemoteDesktopVideoSettingsSchema, {
        fps: 30,
        quality: contract.RemoteDesktopVideoQuality.UNSPECIFIED,
        audio: false
      }),
      cursorOverlay: false
    }, signal)).rejects.toMatchObject({ code: "invalid_argument" });
    const candidate = create(contract.RemoteDesktopIceCandidateSchema, {
      candidate: "candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host"
    });
    await expect(coordinator.exchangeIce(connection, identity, {
      leaseId: "lease-1",
      attemptId: "attempt-1",
      candidates: Array.from({ length: 17 }, () => candidate),
      after: 0
    }, signal)).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fake.calls).toHaveLength(dispatchesAfterStart);

    const previousDispatch = fake.dispatchHandler;
    fake.dispatchHandler = (authority, input) => input.action === "getRemoteDesktopFrame"
      ? Promise.resolve(completed(result("remoteDesktopFrame", create(contract.RemoteDesktopFrameResultSchema, {
        frame: create(contract.RemoteDesktopFrameSchema, { jpeg: new Uint8Array(180_001) })
      }))))
      : previousDispatch(authority, input);
    await expect(coordinator.getFrame(connection, identity, {
      leaseId: "lease-1",
      cursorOverlay: false
    }, signal)).rejects.toMatchObject({
      code: "internal"
    });

    fake.dispatchHandler = (authority, input) => input.action === "getRemoteDesktopFrame"
      ? Promise.resolve(completed(result("remoteDesktopFrame", create(contract.RemoteDesktopFrameResultSchema, {
          frame: create(contract.RemoteDesktopFrameSchema, {
            jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
            cursor: create(contract.RemoteDesktopCursorSchema, {
              visible: true,
              x: 0.5,
              y: 0.25,
              width: 32,
              height: 32,
              hotX: 4,
              hotY: 5,
              png: cursorPngBytes(513, 32)
            })
          })
        }))))
      : previousDispatch(authority, input);
    await expect(coordinator.getFrame(connection, identity, {
      leaseId: "lease-1",
      cursorOverlay: true
    }, signal)).rejects.toMatchObject({ code: "internal" });
  });

  it("removes leases and revocation subscriptions on revoke and close", async () => {
    const fake = new FakeDevicePeerOwner();
    const revocations = new RevocationHarness();
    const coordinator = fakeCoordinator(fake, { onRevoked: revocations.subscribe }).coordinator;
    await start(coordinator);
    expect(revocations.active(connection.id)).toBe(true);

    revocations.revoke(connection.id);
    expect(revocations.active(connection.id)).toBe(false);
    expect(revocations.stops).toHaveLength(1);
    expect(fake.actions().filter((action) => action === "stopRemoteDesktop")).toHaveLength(1);
    await expect(coordinator.heartbeat(connection, identity, "lease-1", signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });

    await start(coordinator);
    expect(revocations.active(connection.id)).toBe(true);
    await coordinator.close();
    expect(revocations.active(connection.id)).toBe(false);
    expect(revocations.stops).toHaveLength(2);
    expect(fake.actions().filter((action) => action === "stopRemoteDesktop")).toHaveLength(2);
    await coordinator.close();
    await expect(coordinator.getCapabilities(connection, identity, signal)).rejects.toMatchObject({
      code: "unavailable"
    });
  });

  it("invalidates an exact route close without sending cleanup to its replacement", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    await start(coordinator);
    expect(fake.activeRouteSubscriptions()).toBe(1);

    const replacement = Object.freeze({ ...identity, routeGeneration: identity.routeGeneration + 1 });
    fake.replaceRoute(replacement);
    expect(fake.activeRouteSubscriptions()).toBe(0);
    await expect(coordinator.heartbeat(connection, identity, "lease-1", signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });
    expect(fake.actions().filter((action) => action === "stopRemoteDesktop")).toHaveLength(0);

    await startForIdentity(coordinator, replacement);
    await expect(coordinator.heartbeat(connection, replacement, "lease-1", signal)).resolves.toBeDefined();
    expect(fake.actions().filter((action) => action === "stopRemoteDesktop")).toHaveLength(0);
  });
});

type DispatchInput = Parameters<DevicePeerOwner["dispatch"]>[1];
type DispatchHandler = (
  authority: DevicePeerAuthority,
  input: DispatchInput
) => Promise<DevicePeerResponseFrame>;

class FakeDevicePeerOwner {
  readonly calls: { readonly authority: DevicePeerAuthority; readonly input: DispatchInput }[] = [];
  readonly captures: {
    readonly connection: ConnectionRecord;
    readonly identity: DevicePeerSelectionIdentity;
    readonly capabilities: readonly string[];
  }[] = [];
  readonly #routeSubscriptions = new Set<{
    readonly identity: DevicePeerSelectionIdentity;
    readonly listener: (event: DevicePeerMultiplexEvent) => void;
  }>();
  #currentIdentity: DevicePeerSelectionIdentity | undefined = identity;
  dispatchHandler: DispatchHandler;

  constructor() {
    this.dispatchHandler = async (_authority, input) => defaultResponse(input);
  }

  asOwner(): DevicePeerOwner {
    return this as unknown as DevicePeerOwner;
  }

  capture(
    controller: ConnectionRecord,
    peer: DevicePeerSelectionIdentity,
    capabilities: readonly "remote_desktop"[]
  ): DevicePeerAuthority {
    this.captures.push({ connection: controller, identity: peer, capabilities });
    return this.#authority(peer, controller.id, controller.deviceId);
  }

  captureBinding(
    controllerDeviceId: string,
    targetDeviceId: string,
    _capabilities: readonly "remote_desktop"[]
  ): DevicePeerAuthority {
    const current = this.#currentIdentity;
    if (current === undefined || current.targetDeviceId !== targetDeviceId) throw new Error("route unavailable");
    return this.#authority(current, undefined, controllerDeviceId);
  }

  subscribe(
    authority: DevicePeerAuthority,
    listener: (event: DevicePeerMultiplexEvent) => void
  ): { dispose(): void } {
    authority.assertCurrent(["remote_desktop"]);
    const subscription = { identity: authority.identity, listener };
    this.#routeSubscriptions.add(subscription);
    return { dispose: () => { this.#routeSubscriptions.delete(subscription); } };
  }

  replaceRoute(next: DevicePeerSelectionIdentity): void {
    const previous = this.#currentIdentity;
    this.#currentIdentity = next;
    if (previous !== undefined) this.#emitRouteClosed(previous, "replaced");
  }

  activeRouteSubscriptions(): number {
    return this.#routeSubscriptions.size;
  }

  #authority(
    peer: DevicePeerSelectionIdentity,
    controllerConnectionId: string | undefined,
    controllerDeviceId: string
  ): DevicePeerAuthority {
    return Object.freeze({
      ...(controllerConnectionId === undefined ? {} : { controllerConnectionId }),
      controllerDeviceId,
      identity: Object.freeze({ ...peer }),
      capabilities: Object.freeze(["remote_desktop"] as const),
      assertCurrent: () => {
        if (this.#currentIdentity === undefined || !sameSelectionIdentity(this.#currentIdentity, peer)) {
          throw new Error("route authority changed");
        }
      }
    });
  }

  async dispatch(authority: DevicePeerAuthority, input: DispatchInput): Promise<DevicePeerResponseFrame> {
    authority.assertCurrent([input.capability]);
    this.calls.push({ authority, input });
    return this.dispatchHandler(authority, input);
  }

  actions(): string[] {
    return this.calls.map(({ input }) => input.action);
  }

  #emitRouteClosed(
    closed: DevicePeerSelectionIdentity,
    reason: "replaced" | "connection_closed" | "authority_changed" | "shutdown"
  ): void {
    const event: DevicePeerMultiplexEvent = Object.freeze({
      protocolVersion: 1,
      kind: "route_closed",
      targetDeviceId: closed.targetDeviceId,
      routeGeneration: closed.routeGeneration,
      reason
    });
    for (const subscription of [...this.#routeSubscriptions]) {
      if (sameSelectionIdentity(subscription.identity, closed)) subscription.listener(event);
    }
  }
}

class RevocationHarness {
  readonly stops: ReturnType<typeof vi.fn>[] = [];
  readonly #listeners = new Map<string, () => void>();

  readonly subscribe: RemoteDesktopCoordinatorOptions["onRevoked"] = (connectionId, listener) => {
    this.#listeners.set(connectionId, listener);
    const stop = vi.fn(() => {
      if (this.#listeners.get(connectionId) === listener) this.#listeners.delete(connectionId);
    });
    this.stops.push(stop);
    return stop;
  };

  active(connectionId: string): boolean {
    return this.#listeners.has(connectionId);
  }

  revoke(connectionId: string): void {
    this.#listeners.get(connectionId)?.();
  }
}

function fakeCoordinator(
  owner: FakeDevicePeerOwner,
  options: {
    readonly now?: () => number;
    readonly onRevoked?: RemoteDesktopCoordinatorOptions["onRevoked"];
    readonly iceConfiguration?: RemoteDesktopCoordinatorOptions["iceConfiguration"];
  } = {}
): { readonly coordinator: RemoteDesktopCoordinator } {
  return {
    coordinator: track(new RemoteDesktopCoordinator({
      owner: owner.asOwner(),
      onRevoked: options.onRevoked ?? (() => () => undefined),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.iceConfiguration === undefined ? {} : { iceConfiguration: options.iceConfiguration })
    }))
  };
}

function track(coordinator: RemoteDesktopCoordinator): RemoteDesktopCoordinator {
  coordinators.push(coordinator);
  return coordinator;
}

function start(coordinator: RemoteDesktopCoordinator): Promise<contract.RemoteDesktopLease> {
  return startForIdentity(coordinator, identity);
}

function startForIdentity(
  coordinator: RemoteDesktopCoordinator,
  peer: DevicePeerSelectionIdentity
): Promise<contract.RemoteDesktopLease> {
  return coordinator.start(connection, peer, {
    displayId: "display-1",
    mode: contract.RemoteDesktopStartMode.NEW
  }, signal);
}

function sameSelectionIdentity(left: DevicePeerSelectionIdentity, right: DevicePeerSelectionIdentity): boolean {
  return left.targetDeviceId === right.targetDeviceId
    && left.targetDeviceRevision === right.targetDeviceRevision
    && left.relationId === right.relationId
    && left.relationRevision === right.relationRevision
    && left.routeGeneration === right.routeGeneration;
}

function defaultResponse(input: DispatchInput): DevicePeerResponseFrame {
  const command = input.payload as contract.DevicePeerCommand;
  switch (input.action) {
    case "startRemoteDesktop":
      return completed(result("remoteDesktopLease", remoteDesktopLease()));
    case "heartbeatRemoteDesktop":
      return completed(result("remoteDesktopControlState", create(contract.RemoteDesktopControlStateSchema, {
        controlling: true,
        controlGeneration: 1n
      })));
    case "setRemoteDesktopControl":
      return completed(result("remoteDesktopControlState", create(contract.RemoteDesktopControlStateSchema, {
        controlling: command.action.case === "setRemoteDesktopControl" && command.action.value.enabled,
        controlGeneration: 2n
      })));
    case "setRemoteDesktopPresentation":
      return completed(result("remoteDesktopControlState", create(contract.RemoteDesktopControlStateSchema, {
        controlling: false,
        controlGeneration: 2n
      })));
    case "probeRemoteDesktopPresentation":
      return completed(result("remoteDesktopPresentationProof", create(
        contract.RemoteDesktopPresentationProofSchema,
        { leaseId: "lease-1", proofSequence: 0n }
      )));
    case "stopRemoteDesktop":
    case "sendRemoteDesktopInput":
      return completed(acknowledgementResult());
    case "getRemoteDesktopFrame":
      return completed(result("remoteDesktopFrame", create(contract.RemoteDesktopFrameResultSchema, {
        frame: create(contract.RemoteDesktopFrameSchema, { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) })
      })));
    case "listRemoteDesktopDisplayModes":
      return completed(result("remoteDesktopDisplayModes", create(
        contract.DevicePeerRemoteDesktopDisplayModesResultSchema,
        {
          modes: [create(contract.RemoteDesktopDisplayModeSchema, {
            modeId: "101",
            width: 1920,
            height: 1080,
            current: true,
            native: true
          })]
        }
      )));
    case "setRemoteDesktopDisplayMode":
      return completed(acknowledgementResult());
    case "transferRemoteDesktopClipboardText":
      return completed(result("remoteDesktopClipboardText", create(
        contract.RemoteDesktopClipboardTextResultSchema,
        command.action.case === "transferRemoteDesktopClipboardText"
          && command.action.value.action.case === "copy" ? { text: "desktop text" } : {}
      )));
    case "transferRemoteDesktopClipboardContent": {
      if (command.action.case !== "transferRemoteDesktopClipboardContent") throw new Error("Unexpected command.");
      const action = command.action.value.action.case;
      return completed(result("remoteDesktopClipboardContent", create(
        contract.RemoteDesktopClipboardContentResultSchema,
        action === "copy" ? { transferId: "transfer-1", length: 24 }
          : action === "begin" ? { transferId: "transfer-1" }
            : action === "read" ? { data: "{\"text\":\"desktop text\"}" }
              : {}
      )));
    }
    default:
      throw new Error(`Unexpected action: ${input.action}`);
  }
}

function completed(value: unknown): DevicePeerResponseFrame {
  return {
    protocolVersion: 1,
    kind: "response",
    requestId: "request-completed",
    targetDeviceId: identity.targetDeviceId,
    routeGeneration: identity.routeGeneration,
    outcome: "completed",
    value
  };
}

function failedRemoteDesktop(reason: contract.RemoteDesktopFailureReason): DevicePeerResponseFrame {
  return {
    protocolVersion: 1,
    kind: "response",
    requestId: "request-failed",
    targetDeviceId: identity.targetDeviceId,
    routeGeneration: identity.routeGeneration,
    outcome: "failed",
    errorCode: "failed_precondition",
    failure: create(contract.DevicePeerFailureSchema, {
      code: contract.DevicePeerFailureCode.CONFLICT,
      retryable: false,
      remoteDesktop: create(contract.RemoteDesktopFailureSchema, { reason, retryable: false })
    })
  };
}

function result(caseName: contract.DevicePeerAgentResult["payload"]["case"], value: unknown): unknown {
  return { case: caseName, value };
}

function acknowledgementResult(): unknown {
  return result("acknowledgement", create(contract.DevicePeerAcknowledgementSchema));
}

function remoteDesktopLease(leaseId = "lease-1"): contract.RemoteDesktopLease {
  return create(contract.RemoteDesktopLeaseSchema, {
    leaseId,
    display: create(contract.RemoteDesktopDisplaySchema, {
      displayId: "display-1",
      name: "Primary display",
      width: 1920,
      height: 1080
    }),
    controlling: true,
    controlGeneration: 1n
  });
}

function stoppedLeaseIds(fake: FakeDevicePeerOwner): string[] {
  return fake.calls.flatMap(({ input }) => {
    const command = input.payload as contract.DevicePeerCommand;
    return command.action.case === "stopRemoteDesktop" ? [command.action.value.leaseId] : [];
  });
}

function cursorPngBytes(width = 32, height = 32): Uint8Array {
  const png = Buffer.alloc(33);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function connectionRecord(
  id = "connection-controller",
  deviceId = "device-controller"
): ConnectionRecord {
  return Object.freeze({
    id,
    deviceId,
    name: "Controller",
    authKeyDigest: "controller-digest",
    state: "active",
    pairedAt: 1,
    revision: 1n
  });
}

function selectionIdentity(): DevicePeerSelectionIdentity {
  return Object.freeze({
    targetDeviceId: "device-target",
    targetDeviceRevision: 1n,
    relationId: "device-controller:device-target",
    relationRevision: 0n,
    routeGeneration: 1
  });
}
