import { create } from "@bufbuild/protobuf";
import {
  DevicePeerCapabilityKind,
  DevicePeerCommandSchema,
  DevicePeerEffectKind
} from "@joko/contracts";
import {
  createInProcessDevicePeerHarness,
  type DevicePeerAgentOutcome,
  type DevicePeerRequestFrame
} from "@joko/device-peer";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { DevicePeerAuthorityError, DevicePeerOwner } from "./device-peer-owner.js";

const stores: OperationalStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("DevicePeerOwner", () => {
  it("keeps Remote Desktop-only routes out of the existing catalog and exposes the exact Desktop capability catalog", () => {
    const fixture = setup();
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["remote_desktop"],
      agent: { handle: async () => ({ outcome: "completed", value: undefined }) }
    });
    const lease = fixture.owner.registerRoute(fixture.target, harness.transport);

    expect(fixture.owner.list(fixture.controller)).toEqual([]);
    expect(fixture.owner.listForCapabilities(
      fixture.controller,
      ["remote_desktop"],
      { kind: "desktop" }
    )).toEqual([
      expect.objectContaining({
        targetDeviceId: fixture.target.deviceId,
        routeGeneration: lease.routeGeneration,
        kind: "desktop",
        capabilities: ["remote_desktop"]
      })
    ]);
    expect(fixture.owner.listForCapabilities(
      fixture.controller,
      ["remote_desktop"],
      { kind: "service" }
    )).toEqual([]);
  });

  it("rejects caller-supplied controller identity and injects the authenticated Connection identity", async () => {
    const fixture = setup();
    const received: DevicePeerRequestFrame[] = [];
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["remote_desktop"],
      agent: {
        handle: async (frame) => {
          received.push(frame);
          return { outcome: "completed", value: undefined };
        }
      }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const selected = fixture.owner.listForCapabilities(
      fixture.controller,
      ["remote_desktop"],
      { kind: "desktop" }
    )[0]!;
    const authority = fixture.owner.capture(fixture.controller, selected, ["remote_desktop"]);
    const forged = create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.REMOTE_DESKTOP,
      effect: DevicePeerEffectKind.READ_ONLY,
      controllerDeviceId: "forged-controller",
      action: { case: "getRemoteDesktopCapabilities", value: {} }
    });

    await expect(fixture.owner.dispatch(authority, {
      capability: "remote_desktop",
      effectKind: "read_only",
      action: "getRemoteDesktopCapabilities",
      payload: forged
    })).rejects.toMatchObject({ code: "invalid_identity" });
    expect(received).toEqual([]);

    const command = create(DevicePeerCommandSchema, {
      capability: DevicePeerCapabilityKind.REMOTE_DESKTOP,
      effect: DevicePeerEffectKind.READ_ONLY,
      action: { case: "getRemoteDesktopCapabilities", value: {} }
    });
    await expect(fixture.owner.dispatch(authority, {
      capability: "remote_desktop",
      effectKind: "read_only",
      action: "getRemoteDesktopCapabilities",
      payload: command
    })).resolves.toMatchObject({ outcome: "completed" });

    expect(command.controllerDeviceId).toBe("");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      controllerDeviceId: fixture.controller.deviceId,
      payload: { controllerDeviceId: fixture.controller.deviceId }
    });
  });

  it("lists only a live, exact, authorized non-self route and fences replacement generations", async () => {
    const fixture = setup();
    const first = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process", "terminal", "forwarding"],
      agent: { handle: async () => ({ outcome: "completed", value: { path: "C:\\work" } }) }
    });
    const firstLease = fixture.owner.registerRoute(fixture.target, first.transport);
    const selected = fixture.owner.list(fixture.controller);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      targetDeviceId: fixture.target.deviceId,
      targetDeviceRevision: fixture.store.getDevice(fixture.target.deviceId).revision,
      relationRevision: 0n,
      routeGeneration: firstLease.routeGeneration,
      capabilities: ["files", "process", "terminal", "forwarding"]
    });

    const authority = fixture.owner.capture(fixture.controller, selected[0]!);
    await expect(fixture.owner.dispatch(authority, {
      capability: "files",
      effectKind: "read_only",
      action: "realpath",
      payload: { path: "C:\\work" }
    })).resolves.toMatchObject({ outcome: "completed", value: { path: "C:\\work" } });

    const replacement = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process"],
      agent: { handle: async () => ({ outcome: "completed", value: undefined }) }
    });
    const secondLease = fixture.owner.registerRoute(fixture.target, replacement.transport);
    expect(secondLease.routeGeneration).toBe(firstLease.routeGeneration + 1);
    expect(() => authority.assertCurrent()).toThrowError(DevicePeerAuthorityError);
    expect(first.retirements).toEqual([expect.objectContaining({ reason: "replaced" })]);
  });

  it("turns a completed side effect into unknown when control authority changes while it is in flight", async () => {
    const fixture = setup();
    let release: ((outcome: DevicePeerAgentOutcome) => void) | undefined;
    let accepted: (() => void) | undefined;
    const pending = new Promise<DevicePeerAgentOutcome>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { accepted = resolve; });
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process"],
      agent: {
        handle: async (_frame: DevicePeerRequestFrame) => {
          accepted?.();
          return await pending;
        }
      }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const selected = fixture.owner.list(fixture.controller)[0]!;
    const authority = fixture.owner.capture(fixture.controller, selected, ["files"]);
    const dispatched = fixture.owner.dispatch(authority, {
      requestId: "mkdir-operation-1",
      capability: "files",
      effectKind: "side_effect",
      action: "mkdir",
      payload: { path: "C:\\work\\new" }
    });
    await reached;
    fixture.store.setDeviceControlRelation({
      controllerDeviceId: fixture.controller.deviceId,
      targetDeviceId: fixture.target.deviceId,
      inboundAllowed: false
    });
    release?.({ outcome: "completed", value: { path: "C:\\work\\new" } });
    await expect(dispatched).resolves.toMatchObject({
      outcome: "outcome_unknown",
      errorCode: "authority_changed",
      requestId: "mkdir-operation-1"
    });
    expect(fixture.owner.list(fixture.controller)).toEqual([]);
  });

  it("keeps an accepted stream claim fenced after its start command completes", async () => {
    const fixture = setup();
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process"],
      agent: { handle: async () => ({ outcome: "completed", value: { processId: "process-1" } }) }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const authority = fixture.owner.capture(fixture.controller, fixture.owner.list(fixture.controller)[0]!, ["process"]);
    const events: unknown[] = [];
    const stream = await fixture.owner.dispatchStream(authority, {
      requestId: "start-process-1",
      capability: "process",
      effectKind: "side_effect",
      action: "startProcess",
      payload: { executable: "tool", arguments: [], workingDirectory: "C:\\work" }
    }, (event) => events.push(event));

    expect(stream.response).toMatchObject({ outcome: "completed", value: { processId: "process-1" } });
    harness.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "start-process-1",
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: authority.identity.routeGeneration,
      streamId: "process-1",
      sequence: 1,
      channel: "process_stdout",
      data: new Uint8Array([111, 107])
    });
    expect(events).toEqual([expect.objectContaining({ channel: "process_stdout", streamId: "process-1" })]);
    expect(fixture.owner.list(fixture.controller)).toHaveLength(1);

    stream.close();
    stream.close();
    harness.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "start-process-1",
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: authority.identity.routeGeneration,
      streamId: "process-1",
      sequence: 2,
      channel: "process_exit",
      exitCode: 0,
      signal: null
    });
    expect(fixture.owner.list(fixture.controller)).toHaveLength(1);
  });

  it("stops projecting late stream data after revocation without retiring the shared route", async () => {
    const fixture = setup();
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process"],
      agent: { handle: async () => ({ outcome: "completed", value: { processId: "process-revoked" } }) }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const authority = fixture.owner.capture(fixture.controller, fixture.owner.list(fixture.controller)[0]!, ["process"]);
    const events: unknown[] = [];
    await fixture.owner.dispatchStream(authority, {
      requestId: "start-process-revoked",
      capability: "process",
      effectKind: "side_effect",
      action: "startProcess",
      payload: { executable: "tool", arguments: [], workingDirectory: "C:\\work" }
    }, (event) => events.push(event));

    fixture.store.setDeviceControlRelation({
      controllerDeviceId: fixture.controller.deviceId,
      targetDeviceId: fixture.target.deviceId,
      inboundAllowed: false
    });
    harness.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "start-process-revoked",
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: authority.identity.routeGeneration,
      streamId: "process-revoked",
      sequence: 1,
      channel: "process_stdout",
      data: new Uint8Array([108, 97, 116, 101])
    });
    harness.emit({
      protocolVersion: 1,
      kind: "stream_event",
      requestId: "start-process-revoked",
      targetDeviceId: fixture.target.deviceId,
      routeGeneration: authority.identity.routeGeneration,
      streamId: "process-revoked",
      sequence: 2,
      channel: "process_stdout",
      data: new Uint8Array([100, 97, 116, 97])
    });
    expect(events).toEqual([expect.objectContaining({
      kind: "route_closed",
      reason: "authority_changed",
      targetDeviceId: fixture.target.deviceId
    })]);

    fixture.store.setDeviceControlRelation({
      controllerDeviceId: fixture.controller.deviceId,
      targetDeviceId: fixture.target.deviceId,
      inboundAllowed: true
    });
    expect(fixture.owner.list(fixture.controller)).toHaveLength(1);
  });

  it("re-resolves a durable controller-to-target binding and fences later relation revocation", () => {
    const fixture = setup();
    const harness = createInProcessDevicePeerHarness({
      targetDeviceId: fixture.target.deviceId,
      capabilities: ["files", "process"],
      agent: { handle: async () => ({ outcome: "completed", value: undefined }) }
    });
    fixture.owner.registerRoute(fixture.target, harness.transport);
    const authority = fixture.owner.captureBinding(
      fixture.controller.deviceId,
      fixture.target.deviceId,
      ["files"]
    );
    expect(authority.controllerConnectionId).toBeUndefined();
    expect(() => authority.assertCurrent()).not.toThrow();

    fixture.store.setDeviceControlRelation({
      controllerDeviceId: fixture.controller.deviceId,
      targetDeviceId: fixture.target.deviceId,
      inboundAllowed: false
    });
    expect(() => authority.assertCurrent()).toThrowError(DevicePeerAuthorityError);
    expect(() => fixture.owner.captureBinding(
      fixture.controller.deviceId,
      fixture.target.deviceId,
      ["files"]
    )).toThrowError(DevicePeerAuthorityError);
  });
});

function setup(): {
  readonly store: OperationalStore;
  readonly owner: DevicePeerOwner;
  readonly controller: ReturnType<OperationalStore["createConnection"]>;
  readonly target: ReturnType<OperationalStore["createConnection"]>;
} {
  const store = new OperationalStore(":memory:");
  stores.push(store);
  const controller = store.createConnection({
    id: "connection-controller",
    deviceId: "device-controller",
    device: { defaultName: "Controller", kind: "web", platform: "web" },
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
  return { store, owner: new DevicePeerOwner({ store }), controller, target };
}
