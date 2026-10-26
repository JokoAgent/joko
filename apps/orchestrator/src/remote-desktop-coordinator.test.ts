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
  type RemoteDesktopCoordinatorOptions,
  type RemoteDesktopIceConfigurationProvider
} from "./remote-desktop-coordinator.js";
import { ConnectionManager } from "./connection-manager.js";

const signal = new AbortController().signal;
const connection = connectionRecord();
const identity = selectionIdentity();
const coordinators: RemoteDesktopCoordinator[] = [];
const stores: OperationalStore[] = [];
type IceConfigurationInput = Parameters<RemoteDesktopIceConfigurationProvider["getConfiguration"]>[0];

afterEach(async () => {
  await Promise.allSettled(coordinators.splice(0).map((coordinator) => coordinator.close()));
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RemoteDesktopCoordinator", () => {
  it("binds optional UDP offer/trickle to the exact attempt, translates native cursors and retires it on revocation", async () => {
    const fake = new FakeDevicePeerOwner(), revocations = new RevocationHarness();
    let context!: Parameters<NonNullable<RemoteDesktopCoordinatorOptions["udpMapping"]>["mapAnswer"]>[0];
    fake.dispatchHandler = async (_authority, input) => {
      const command = input.payload as contract.DevicePeerCommand;
      if (command.action.case === "createRemoteDesktopOffer") return completed(result("remoteDesktopOffer", create(contract.RemoteDesktopOfferResultSchema, { attemptId: command.action.value.attemptId, answerSdp: "v=0\r\n" })));
      if (command.action.case === "exchangeRemoteDesktopIce") { expect(command.action.value.after).toBe(7); return completed(result("remoteDesktopIce", create(contract.RemoteDesktopIceExchangeResultSchema, { attemptId: command.action.value.attemptId, candidates: [], next: 7, complete: true }))); }
      return defaultResponse(input);
    };
    const udp = { mapAnswer: vi.fn(async (input, answer) => { context = input; input.assertCurrent(); return answer; }),
      exchangeIce: vi.fn(async (input, _after, dispatch) => { input.assertCurrent(); const native = await dispatch(7); return { ...native, next: 0 }; }),
      releaseLease: vi.fn(async () => {}), retireLocalCapture: vi.fn(async () => {}), close: vi.fn(async () => {}) } satisfies NonNullable<RemoteDesktopCoordinatorOptions["udpMapping"]>;
    const coordinator = fakeCoordinator(fake, { onRevoked: revocations.subscribe, udpMapping: udp }).coordinator;
    const lease = await start(coordinator); const offer = (attemptId: string) => coordinator.createOffer(connection, identity, { leaseId: lease.leaseId, attemptId, offerSdp: "v=0\r\n", cursorOverlay: false }, signal);
    await offer("first"); const first = context;
    await coordinator.exchangeIce(connection, identity, { leaseId: lease.leaseId, attemptId: "first", after: 0, candidates: [] }, signal);
    await offer("second"); expect(first.lifetimeSignal.aborted).toBe(true); expect(() => first.assertCurrent()).toThrow();
    const before = fake.calls.length; await expect(coordinator.exchangeIce(connection, identity, { leaseId: lease.leaseId, attemptId: "first", after: 0, candidates: [] }, signal)).rejects.toMatchObject({ code: "aborted" }); expect(fake.calls.length).toBe(before);
    revocations.revoke(connection.id); expect(context.lifetimeSignal.aborted).toBe(true); expect(udp.releaseLease).toHaveBeenCalledWith(lease.leaseId);
  });

  it("rejects a late UDP answer after the coordinator has selected another media attempt", async () => {
    const fake = new FakeDevicePeerOwner(); let release!: () => void; let observed = false;
    fake.dispatchHandler = async (_authority, input) => { const command = input.payload as contract.DevicePeerCommand; return command.action.case === "createRemoteDesktopOffer"
      ? completed(result("remoteDesktopOffer", create(contract.RemoteDesktopOfferResultSchema, { attemptId: command.action.value.attemptId, answerSdp: "v=0\r\n" }))) : defaultResponse(input); };
    const udp = { mapAnswer: vi.fn(async (input, sdp) => { if (input.attemptId === "old") { observed = true; await new Promise<void>(resolve => { release = resolve; }); } return sdp; }), exchangeIce: vi.fn(async (_input, after, dispatch) => dispatch(after)), releaseLease: vi.fn(async () => {}), retireLocalCapture: vi.fn(async () => {}), close: vi.fn(async () => {}) } satisfies NonNullable<RemoteDesktopCoordinatorOptions["udpMapping"]>;
    const coordinator = fakeCoordinator(fake, { udpMapping: udp }).coordinator, lease = await start(coordinator);
    const offer = (attemptId: string) => coordinator.createOffer(connection, identity, { leaseId: lease.leaseId, attemptId, offerSdp: "v=0\r\n", cursorOverlay: false }, signal);
    const old = offer("old"); const rejected = expect(old).rejects.toBeDefined(); await vi.waitFor(() => expect(observed).toBe(true)); await offer("new"); release(); await rejected;
  });
  it("fences a capture retired by its original Main before a late native offer can publish UDP", async () => {
    const fake = new FakeDevicePeerOwner(); let complete!: (value: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = async (_authority, input) => input.action === "createRemoteDesktopOffer" ? new Promise(resolve => { complete = resolve; }) : defaultResponse(input);
    const udp = { mapAnswer: vi.fn(async (_input, sdp) => sdp), exchangeIce: vi.fn(async (_input, after, dispatch) => dispatch(after)), releaseLease: vi.fn(async () => {}), retireLocalCapture: vi.fn(async () => {}), close: vi.fn(async () => {}) } satisfies NonNullable<RemoteDesktopCoordinatorOptions["udpMapping"]>;
    const coordinator = fakeCoordinator(fake, { udpMapping: udp }).coordinator, lease = await start(coordinator);
    const pending = coordinator.createOffer(connection, identity, { leaseId: lease.leaseId, attemptId: "capture", offerSdp: "v=0\r\n", cursorOverlay: false }, signal);
    const rejected = expect(pending).rejects.toBeDefined(); await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    await coordinator.retireLocalMedia({ ...connection, id: "managed-host-connection", deviceId: identity.targetDeviceId }, lease.leaseId, "capture");
    complete(completed(result("remoteDesktopOffer", create(contract.RemoteDesktopOfferResultSchema, { attemptId: "capture", answerSdp: "v=0\r\n" }))));
    await rejected; expect(udp.mapAnswer).not.toHaveBeenCalled(); expect(udp.retireLocalCapture).toHaveBeenCalledWith({ hostConnectionId: "managed-host-connection", targetDeviceId: identity.targetDeviceId, leaseId: lease.leaseId, attemptId: "capture" });
  });
  it("Linux system audio failure preserves view and heartbeat for the same lease muted offer", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    fake.dispatchHandler = async (_authority, input) => {
      if (input.action === "getRemoteDesktopCapabilities") return completed(result("remoteDesktopCapabilities",
        create(contract.RemoteDesktopCapabilitiesSchema, { protocolVersion: 1, platform: "linux", systemAudio: true,
          videoSettings: true, permissions: { screenRecording: contract.RemoteDesktopPermissionStatus.GRANTED,
            accessibility: contract.RemoteDesktopPermissionStatus.GRANTED } })));
      if (input.action === "createRemoteDesktopOffer") {
        const command = input.payload as contract.DevicePeerCommand;
        if (command.action.case !== "createRemoteDesktopOffer") throw new Error("Unexpected command.");
        if (command.action.value.settings?.audio) return failedRemoteDesktop(contract.RemoteDesktopFailureReason.AUDIO_UNAVAILABLE);
        return completed(result("remoteDesktopOffer", create(contract.RemoteDesktopOfferResultSchema,
          { attemptId: command.action.value.attemptId, answerSdp: "v=0\r\n" })));
      }
      return defaultResponse(input);
    };
    await expect(coordinator.getCapabilities(connection, identity, signal)).resolves.toMatchObject({ platform: "linux", systemAudio: true });
    const lease = await start(coordinator);
    const offer = (audio: boolean, attemptId: string) => coordinator.createOffer(connection, identity,
      { leaseId: lease.leaseId, attemptId, offerSdp: "v=0\r\n", cursorOverlay: false,
        settings: create(contract.RemoteDesktopVideoSettingsSchema, { fps: 30, quality: contract.RemoteDesktopVideoQuality.AUTO, audio }) }, signal);
    await expect(offer(true, "audio-attempt")).rejects.toMatchObject({ code: "unavailable",
      detail: { reason: contract.RemoteDesktopFailureReason.AUDIO_UNAVAILABLE, retryable: false } });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toBeDefined();
    await expect(coordinator.getFrame(connection, identity, { leaseId: lease.leaseId, cursorOverlay: false }, signal))
      .resolves.toMatchObject({ frame: { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) } });
    await expect(offer(false, "muted-attempt")).resolves.toMatchObject({ attemptId: "muted-attempt" });
    expect(stoppedLeaseIds(fake)).toHaveLength(0);
  });

  it("preserves a portal lease and heartbeat through finite capture pending until a real frame arrives", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);
    let pending = true;
    fake.dispatchHandler = async (_authority, input) => {
      if (pending && (input.action === "getRemoteDesktopFrame" || input.action === "createRemoteDesktopOffer")) {
        return { ...failedRemoteDesktop(contract.RemoteDesktopFailureReason.CAPTURE_PENDING),
          failure: create(contract.DevicePeerFailureSchema, { code: contract.DevicePeerFailureCode.CONFLICT, retryable: true,
            remoteDesktop: { reason: contract.RemoteDesktopFailureReason.CAPTURE_PENDING, retryable: true } }) };
      }
      return defaultResponse(input);
    };
    await expect(coordinator.getFrame(connection, identity, { leaseId: lease.leaseId, cursorOverlay: false }, signal))
      .rejects.toMatchObject({ code: "failed_precondition", detail: { reason: contract.RemoteDesktopFailureReason.CAPTURE_PENDING, retryable: true } });
    await expect(coordinator.createOffer(connection, identity, { leaseId: lease.leaseId, attemptId: "portal-attempt", offerSdp: "v=0\r\n", cursorOverlay: false }, signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.CAPTURE_PENDING } });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toBeDefined();
    pending = false;
    await expect(coordinator.getFrame(connection, identity, { leaseId: lease.leaseId, cursorOverlay: false }, signal))
      .resolves.toMatchObject({ frame: { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) } });
    expect(stoppedLeaseIds(fake)).toHaveLength(0);
    fake.replaceRoute(Object.freeze({ ...identity, routeGeneration: identity.routeGeneration + 1 }));
    await expect(coordinator.getFrame(connection, identity, { leaseId: lease.leaseId, cursorOverlay: false }, signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.STOPPED } });
  });

  it("admits Linux cursor, physical modes and mirror capabilities while retaining exact platform gates", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const capabilities = create(contract.RemoteDesktopCapabilitiesSchema, { protocolVersion: 1, platform: "linux", cursorOverlay: true,
      permissions: create(contract.RemoteDesktopPermissionsSchema, {
        screenRecording: contract.RemoteDesktopPermissionStatus.GRANTED,
        accessibility: contract.RemoteDesktopPermissionStatus.GRANTED
      }) });
    fake.dispatchHandler = async () => completed(result("remoteDesktopCapabilities", capabilities));
    await expect(coordinator.getCapabilities(connection, identity, signal)).resolves.toMatchObject({ cursorOverlay: true });
    capabilities.displayModes = true;
    capabilities.viewerDisplay = true;
    capabilities.viewerDisplayRestore = true;
    await expect(coordinator.getCapabilities(connection, identity, signal)).resolves.toMatchObject({ displayModes: true, viewerDisplay: true });
    capabilities.displayModes = false;
    capabilities.platform = "win32";
    await expect(coordinator.getCapabilities(connection, identity, signal)).rejects.toMatchObject({ code: "internal" });
  });

  it("accepts the implemented Windows native cursor capability without widening Linux-only actions", async () => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
    const capabilities = create(contract.RemoteDesktopCapabilitiesSchema, { protocolVersion: 1, platform: "win32", cursorOverlay: true,
      permissions: { screenRecording: contract.RemoteDesktopPermissionStatus.GRANTED, accessibility: contract.RemoteDesktopPermissionStatus.GRANTED } });
    fake.dispatchHandler = async () => completed(result("remoteDesktopCapabilities", capabilities));
    await expect(coordinator.getCapabilities(connection, identity, signal)).resolves.toMatchObject({ cursorOverlay: true });
    capabilities.workspaceNavigation = true;
    await expect(coordinator.getCapabilities(connection, identity, signal)).rejects.toMatchObject({ code: "internal" });
  });

  it("forwards native credential preparation, opening and exchange without a media or control lease", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const handle = "12345678-1234-4234-8234-123456789abc";
    fake.dispatchHandler = async (_authority, input) => {
      const command = input.payload as contract.DevicePeerCommand;
      if (command.action.case === "getRemoteDesktopLockState") return completed(result("remoteDesktopLockState",
        create(contract.RemoteDesktopLockStateResultSchema, { state: contract.RemoteDesktopLockState.LOCKED })));
      if (command.action.case !== "requestRemoteDesktopCredentials") throw new Error("Unexpected credential action.");
      const request = command.action.value.request;
      return completed(result("remoteDesktopCredentials", create(contract.RemoteDesktopCredentialResultSchema, {
        result: request.case === "prepare" ? { case: "prepared", value: { descriptor: '{"publicKey":"key"}' } }
          : request.case === "open" ? { case: "opened", value: { handle, offer: "signed.offer" } }
            : { case: "exchanged", value: { ciphertext: "sealed.reply" } }
      })));
    };
    await expect(coordinator.getLockState(connection, identity, signal)).resolves.toMatchObject({ state: contract.RemoteDesktopLockState.LOCKED });
    for (const request of [
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "prepare", value: {} } }),
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "open", value: { offer: "signed.offer", descriptor: "public identity" } } }),
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle, ciphertext: "sealed.request" } } })
    ]) await coordinator.requestCredentials(connection, identity, request, signal);
    expect(fake.actions()).toEqual(["getRemoteDesktopLockState", "requestRemoteDesktopCredentials", "requestRemoteDesktopCredentials", "requestRemoteDesktopCredentials"]);
    expect(fake.calls[0]).toMatchObject({ authority: { controllerDeviceId: connection.deviceId }, input: { effectKind: "read_only" } });
    expect(fake.calls[1]).toMatchObject({ authority: { controllerDeviceId: connection.deviceId }, input: { effectKind: "side_effect" } });
    fake.dispatchHandler = async () => completed(result("remoteDesktopCredentials", create(contract.RemoteDesktopCredentialResultSchema,
      { result: { case: "closed", value: {} } })));
    await expect(coordinator.requestCredentials(connection, identity, create(contract.RemoteDesktopCredentialRequestSchema,
      { request: { case: "exchange", value: { handle, ciphertext: "sealed.revoke" } } }), signal)).resolves.toMatchObject({ result: { case: "closed" } });
  });

  it("rejects missing, oversized UTF8 and invalid native credential envelopes before dispatch", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const handle = "12345678-1234-4234-8234-123456789abc";
    const requests = [
      create(contract.RemoteDesktopCredentialRequestSchema),
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "open", value: { offer: "" } } }),
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "open", value: { offer: "signed.offer", descriptor: "中".repeat(1_366) } } }),
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "open", value: { offer: "x".repeat(4_097) } } }),
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle: "caller-id", ciphertext: "ciphertext" } } }),
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle, ciphertext: "非ASCII" } } }),
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle, ciphertext: "x".repeat(2 * 1_024 * 1_024 + 1) } } })
    ];
    for (const request of requests) await expect(coordinator.requestCredentials(connection, identity, request, signal)).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects mismatched native credential replies and invalid lock state", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    fake.dispatchHandler = async () => completed(result("remoteDesktopCredentials", create(contract.RemoteDesktopCredentialResultSchema,
      { result: { case: "closed", value: {} } })));
    await expect(coordinator.requestCredentials(connection, identity, create(contract.RemoteDesktopCredentialRequestSchema,
      { request: { case: "prepare", value: {} } }), signal)).rejects.toMatchObject({ code: "internal" });
    fake.dispatchHandler = async () => completed(result("remoteDesktopCredentials", create(contract.RemoteDesktopCredentialResultSchema,
      { result: { case: "opened", value: { handle: "not-a-native-handle", offer: "signed.offer" } } })));
    await expect(coordinator.requestCredentials(connection, identity, create(contract.RemoteDesktopCredentialRequestSchema,
      { request: { case: "open", value: { offer: "signed.offer" } } }), signal)).rejects.toMatchObject({ code: "internal" });
    fake.dispatchHandler = async () => completed(result("remoteDesktopLockState", create(contract.RemoteDesktopLockStateResultSchema)));
    await expect(coordinator.getLockState(connection, identity, signal)).rejects.toMatchObject({ code: "internal" });
  });

  it("rejects a late native credential receipt after exact route replacement", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    let complete!: (value: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = async () => new Promise((resolve) => { complete = resolve; });
    const pending = coordinator.requestCredentials(connection, identity, create(contract.RemoteDesktopCredentialRequestSchema,
      { request: { case: "prepare", value: {} } }), signal);
    const rejected = expect(pending).rejects.toThrow("route authority changed");
    fake.replaceRoute({ ...identity, routeGeneration: identity.routeGeneration + 1 });
    complete(completed(result("remoteDesktopCredentials", create(contract.RemoteDesktopCredentialResultSchema,
      { result: { case: "prepared", value: { descriptor: "public identity" } } }))));
    await rejected;
  });

  it("retires exact native credential handles on connection revoke without closing another controller", async () => {
    const fake = new FakeDevicePeerOwner(), revocations = new RevocationHarness();
    const coordinator = fakeCoordinator(fake, { onRevoked: revocations.subscribe }).coordinator;
    const handle = "12345678-1234-4234-8234-123456789abc";
    fake.dispatchHandler = async (_authority, input) => input.action === "closeRemoteDesktopCredentials"
      ? completed(acknowledgementResult()) : completed(result("remoteDesktopCredentials", create(contract.RemoteDesktopCredentialResultSchema,
        { result: { case: "opened", value: { handle, offer: "signed.offer" } } })));
    await coordinator.requestCredentials(connection, identity, create(contract.RemoteDesktopCredentialRequestSchema,
      { request: { case: "open", value: { offer: "signed.offer" } } }), signal);
    await expect(coordinator.requestCredentials(connectionRecord("other-connection", "other-device"), identity,
      create(contract.RemoteDesktopCredentialRequestSchema, { request: { case: "exchange", value: { handle, ciphertext: "ciphertext" } } }), signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.CREDENTIAL_EXPIRED } });
    revocations.revoke(connection.id);
    await Promise.resolve();
    expect(fake.calls.at(-1)).toMatchObject({ authority: { controllerDeviceId: connection.deviceId }, input: {
      action: "closeRemoteDesktopCredentials", payload: { action: { value: { handle } } } } });
    await expect(coordinator.requestCredentials(connection, identity, create(contract.RemoteDesktopCredentialRequestSchema,
      { request: { case: "exchange", value: { handle, ciphertext: "ciphertext" } } }), signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.CREDENTIAL_EXPIRED } });
  });

  it("marks an accepted native credential effect with unknown outcome for receipt-only recovery", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const handle = "12345678-1234-4234-8234-123456789abc";
    fake.dispatchHandler = async () => completed(result("remoteDesktopCredentials", create(contract.RemoteDesktopCredentialResultSchema,
      { result: { case: "opened", value: { handle, offer: "signed.offer" } } })));
    await coordinator.requestCredentials(connection, identity, create(contract.RemoteDesktopCredentialRequestSchema,
      { request: { case: "open", value: { offer: "signed.offer" } } }), signal);
    fake.dispatchHandler = async () => ({ ...completed(undefined), outcome: "outcome_unknown", errorCode: "authority_changed" });
    await expect(coordinator.requestCredentials(connection, identity, create(contract.RemoteDesktopCredentialRequestSchema,
      { request: { case: "exchange", value: { handle, ciphertext: "sealed.password" } } }), signal))
      .rejects.toMatchObject({ code: "aborted", detail: { reason: contract.RemoteDesktopFailureReason.CREDENTIAL_OUTCOME_UNKNOWN, retryable: false } });
    expect(fake.actions()).toEqual(["requestRemoteDesktopCredentials", "requestRemoteDesktopCredentials"]);
  });

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

  it.each([contract.RemoteDesktopSystemActionKind.WORKSPACE_LEFT, contract.RemoteDesktopSystemActionKind.WORKSPACE_RIGHT,
    contract.RemoteDesktopSystemActionKind.SYSTEM_MENU])("forwards system action %s only for the owning exact control", async action => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    const request = create(contract.RemoteDesktopSystemActionRequestSchema, {
      leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, action
    });
    await expect(coordinator.performSystemAction(connection, identity, request, signal)).resolves.toMatchObject({ action });
    expect(fake.calls.at(-1)).toMatchObject({ authority: { controllerDeviceId: connection.deviceId }, input: {
      action: "performRemoteDesktopSystemAction", effectKind: "side_effect",
      payload: { action: { case: "performRemoteDesktopSystemAction", value: request } }
    } });
    await expect(coordinator.performSystemAction({ ...connection, id: "another-controller" }, identity, request, signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED } });
    await expect(coordinator.performSystemAction(connection, { ...identity, relationRevision: identity.relationRevision + 1n }, request, signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.AUTHORITY_CHANGED } });
    await expect(coordinator.performSystemAction(connection, identity, { ...request, controlGeneration: 99n }, signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.SYSTEM_ACTION_EXPIRED } });
    expect(fake.actions().filter(value => value === "performRemoteDesktopSystemAction")).toHaveLength(1);
    await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: false }, signal);
    await expect(coordinator.performSystemAction(connection, identity, request, signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.VIEW_ONLY } });
  });

  it.each([0, -1, 4, Number.NaN])("rejects invalid system action %s before any target effect", async action => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
    await expect(coordinator.performSystemAction(connection, identity, create(contract.RemoteDesktopSystemActionRequestSchema,
      { leaseId: "lease-1", controlGeneration: 1n, action }), signal)).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["failed", "outcome_unknown", "wrong echo", "wrong result"] as const)(
    "returns system action %s without replay or retiring the viewer", async outcome => {
      const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
      const action = contract.RemoteDesktopSystemActionKind.WORKSPACE_RIGHT;
      fake.dispatchHandler = async (_authority, input) => {
        if (input.action !== "performRemoteDesktopSystemAction") return defaultResponse(input);
        if (outcome === "failed") return failedRemoteDesktop(contract.RemoteDesktopFailureReason.SYSTEM_ACTION_UNAVAILABLE);
        if (outcome === "outcome_unknown") return { ...completed(undefined), outcome: "outcome_unknown", errorCode: "outcome_unknown" };
        if (outcome === "wrong echo") return completed(result("remoteDesktopSystemAction",
          create(contract.RemoteDesktopSystemActionResultSchema, { action: contract.RemoteDesktopSystemActionKind.WORKSPACE_LEFT })));
        return completed(result("remoteDesktopHostMute", create(contract.RemoteDesktopHostMuteResultSchema, { enabled: true })));
      };
      await expect(coordinator.performSystemAction(connection, identity, create(contract.RemoteDesktopSystemActionRequestSchema,
        { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, action }), signal)).rejects.toMatchObject({
        code: outcome === "failed" ? "unavailable" : outcome === "outcome_unknown" ? "aborted" : "internal"
      });
      await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toMatchObject({ controlling: true });
      expect(fake.actions().filter(value => value === "performRemoteDesktopSystemAction")).toHaveLength(1);
      expect(stoppedLeaseIds(fake)).toHaveLength(0);
    });

  it.each(["control", "presentation", "route", "revoke", "stop", "display"] as const)(
    "rejects a late system action acknowledgement after %s changes", async retirement => {
      const fake = new FakeDevicePeerOwner(), revocations = new RevocationHarness();
      const coordinator = fakeCoordinator(fake, { onRevoked: revocations.subscribe }).coordinator, lease = await start(coordinator);
      let complete!: (response: DevicePeerResponseFrame) => void;
      fake.dispatchHandler = async (_authority, input) => input.action === "performRemoteDesktopSystemAction"
        ? new Promise(resolve => { complete = resolve; }) : defaultResponse(input);
      const action = contract.RemoteDesktopSystemActionKind.WORKSPACE_LEFT;
      const pending = coordinator.performSystemAction(connection, identity, create(contract.RemoteDesktopSystemActionRequestSchema,
        { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, action }), signal);
      const reason = retirement === "control" || retirement === "presentation" || retirement === "display"
        ? contract.RemoteDesktopFailureReason.SYSTEM_ACTION_EXPIRED : contract.RemoteDesktopFailureReason.STOPPED;
      const rejected = expect(pending).rejects.toMatchObject({ detail: { reason } });
      if (retirement === "control") await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);
      else if (retirement === "presentation") await coordinator.setPresentation(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);
      else if (retirement === "route") fake.replaceRoute({ ...identity, routeGeneration: identity.routeGeneration + 1 });
      else if (retirement === "revoke") revocations.revoke(connection.id);
      else if (retirement === "stop") await coordinator.stop(connection, identity, { leaseId: lease.leaseId, lockScreen: false, controlGeneration: 0n }, signal);
      else {
        fake.dispatchHandler = async (_authority, input) => input.action === "setRemoteDesktopDisplayMode"
          ? completed(result("remoteDesktopDisplayMode", create(contract.RemoteDesktopDisplayModeResultSchema, { lease: {
            leaseId: lease.leaseId, display: lease.display, controlling: false, controlGeneration: 2n
          } }))) : defaultResponse(input);
        await coordinator.setDisplayMode(connection, identity, { leaseId: lease.leaseId, controlGeneration: 1n, modeId: "101", temporary: true }, signal);
      }
      complete(completed(result("remoteDesktopSystemAction", create(contract.RemoteDesktopSystemActionResultSchema, { action }))));
      await rejected;
    });

  it("rejects a late failed system effect from an earlier control without changing the current viewer", async () => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    let complete!: (response: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = async (_authority, input) => input.action === "performRemoteDesktopSystemAction"
      ? new Promise(resolve => { complete = resolve; }) : defaultResponse(input);
    const pending = coordinator.performSystemAction(connection, identity, create(contract.RemoteDesktopSystemActionRequestSchema,
      { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, action: contract.RemoteDesktopSystemActionKind.SYSTEM_MENU }), signal);
    const rejected = expect(pending).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.SYSTEM_ACTION_EXPIRED } });
    await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);
    complete(failedRemoteDesktop(contract.RemoteDesktopFailureReason.SYSTEM_ACTION_UNAVAILABLE));
    await rejected;
    expect(stoppedLeaseIds(fake)).toHaveLength(0);
  });

  it("snapshots the requested system action and control while awaiting its exact result", async () => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    let complete!: (response: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = async () => new Promise(resolve => { complete = resolve; });
    const action = contract.RemoteDesktopSystemActionKind.WORKSPACE_LEFT;
    const request = create(contract.RemoteDesktopSystemActionRequestSchema, { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, action });
    const pending = coordinator.performSystemAction(connection, identity, request, signal);
    request.action = contract.RemoteDesktopSystemActionKind.WORKSPACE_RIGHT;
    request.controlGeneration = 99n;
    complete(completed(result("remoteDesktopSystemAction", create(contract.RemoteDesktopSystemActionResultSchema, { action }))));
    await expect(pending).resolves.toMatchObject({ action });
    expect((fake.calls.at(-1)!.input.payload as contract.DevicePeerCommand).action).toMatchObject({ value: { controlGeneration: 1n, action } });
    fake.dispatchHandler = async (_authority, input) => defaultResponse(input);
  });

  it.each(["darwin", "win32", "view only", "menu alone", "missing navigation", "missing menu"])(
    "rejects system action capabilities with %s", async defect => {
      const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
      const capabilities = create(contract.RemoteDesktopCapabilitiesSchema, { protocolVersion: 1, platform: "linux", canControl: true,
        workspaceNavigation: true, systemMenu: true, permissions: { screenRecording: contract.RemoteDesktopPermissionStatus.GRANTED,
          accessibility: contract.RemoteDesktopPermissionStatus.GRANTED } });
      if (defect === "darwin" || defect === "win32") capabilities.platform = defect;
      if (defect === "view only") capabilities.canControl = false;
      if (defect === "menu alone") capabilities.workspaceNavigation = false;
      if (defect === "missing navigation") delete (capabilities as Partial<contract.RemoteDesktopCapabilities>).workspaceNavigation;
      if (defect === "missing menu") delete (capabilities as Partial<contract.RemoteDesktopCapabilities>).systemMenu;
      fake.dispatchHandler = async () => completed(result("remoteDesktopCapabilities", capabilities));
      await expect(coordinator.getCapabilities(connection, identity, signal)).rejects.toMatchObject({ code: "internal" });
    });

  it.each([false, true])("admits independently optional Linux system menu %s with workspace navigation", async systemMenu => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
    fake.dispatchHandler = async () => completed(result("remoteDesktopCapabilities", create(contract.RemoteDesktopCapabilitiesSchema,
      { protocolVersion: 1, platform: "linux", canControl: true, workspaceNavigation: true, systemMenu,
        permissions: { screenRecording: contract.RemoteDesktopPermissionStatus.GRANTED, accessibility: contract.RemoteDesktopPermissionStatus.GRANTED } })));
    await expect(coordinator.getCapabilities(connection, identity, signal)).resolves.toMatchObject({ workspaceNavigation: true, systemMenu });
  });

  it("forwards host mute for authenticated exact control and preserves the lease on host failure", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);
    const request = create(contract.RemoteDesktopHostMuteRequestSchema, {
      leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true
    });
    await expect(coordinator.setHostMute(connection, identity, request, signal)).resolves.toMatchObject({ enabled: true });
    expect(fake.calls.at(-1)).toMatchObject({
      authority: { controllerDeviceId: connection.deviceId },
      input: { action: "setRemoteDesktopHostMute", effectKind: "side_effect", payload: { action: {
        case: "setRemoteDesktopHostMute", value: request
      } } }
    });
    fake.dispatchHandler = async (_authority, input) => input.action === "setRemoteDesktopHostMute"
      ? failedRemoteDesktop(contract.RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE) : defaultResponse(input);
    await expect(coordinator.setHostMute(connection, identity, request, signal)).rejects.toMatchObject({
      code: "unavailable", detail: { reason: contract.RemoteDesktopFailureReason.HOST_MUTE_UNAVAILABLE }
    });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toMatchObject({ controlling: true });
    await expect(coordinator.setHostMute(connection, identity,
      create(contract.RemoteDesktopHostMuteRequestSchema, { ...request, controlGeneration: 99n }), signal
    )).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.HOST_MUTE_EXPIRED } });
    expect(fake.actions().filter((action) => action === "setRemoteDesktopHostMute")).toHaveLength(2);
    await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: false }, signal);
    await expect(coordinator.setHostMute(connection, identity, request, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.VIEW_ONLY }
    });
  });

  it.each(["control", "route", "revoke"] as const)("rejects a late host mute acknowledgement after %s retirement", async (retirement) => {
    const fake = new FakeDevicePeerOwner();
    const revocations = new RevocationHarness();
    const coordinator = fakeCoordinator(fake, { onRevoked: revocations.subscribe }).coordinator;
    const lease = await start(coordinator);
    let complete!: (value: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = async (_authority, input) => input.action === "setRemoteDesktopHostMute"
      ? new Promise((resolve) => { complete = resolve; }) : defaultResponse(input);
    const pending = coordinator.setHostMute(connection, identity, create(contract.RemoteDesktopHostMuteRequestSchema, {
      leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true
    }), signal);
    const reason = retirement === "control" ? contract.RemoteDesktopFailureReason.HOST_MUTE_EXPIRED
      : contract.RemoteDesktopFailureReason.STOPPED;
    const rejected = expect(pending).rejects.toMatchObject({ detail: { reason } });
    if (retirement === "control") {
      await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);
    } else if (retirement === "route") {
      fake.replaceRoute({ ...identity, routeGeneration: identity.routeGeneration + 1 });
    } else {
      revocations.revoke(connection.id);
    }
    complete(completed(result("remoteDesktopHostMute", create(contract.RemoteDesktopHostMuteResultSchema, { enabled: true }))));
    await rejected;
  });

  it("rejects a host mute result that does not acknowledge the requested effect", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);
    fake.dispatchHandler = async () => completed(result("remoteDesktopHostMute", create(contract.RemoteDesktopHostMuteResultSchema, { enabled: false })));
    await expect(coordinator.setHostMute(connection, identity, create(contract.RemoteDesktopHostMuteRequestSchema, {
      leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true
    }), signal)).rejects.toMatchObject({ code: "internal" });
  });

  it("forwards privacy intent and latest lock preference only for exact control, preserving viewing after native failure", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    const request = create(contract.RemoteDesktopPrivacyScreenRequestSchema, {
      leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true, lockOnExit: true
    });
    await expect(coordinator.setPrivacyScreen(connection, identity, request, signal)).resolves.toMatchObject({ enabled: true });
    expect(fake.calls.at(-1)).toMatchObject({ authority: { controllerDeviceId: connection.deviceId },
      input: { action: "setRemoteDesktopPrivacyScreen", effectKind: "side_effect", payload: { action: { value: request } } } });
    fake.dispatchHandler = async (_authority, input) => input.action === "setRemoteDesktopPrivacyScreen"
      ? failedRemoteDesktop(contract.RemoteDesktopFailureReason.PRIVACY_FAILED) : defaultResponse(input);
    await expect(coordinator.setPrivacyScreen(connection, identity, request, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.PRIVACY_FAILED }
    });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toMatchObject({ controlling: true });
    await expect(coordinator.setPrivacyScreen(connection, identity, create(contract.RemoteDesktopPrivacyScreenRequestSchema, {
      ...request, controlGeneration: 99n
    }), signal)).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.PRIVACY_EXPIRED } });
    expect(fake.actions().filter(action => action === "setRemoteDesktopPrivacyScreen")).toHaveLength(2);
    await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: false }, signal);
    await expect(coordinator.setPrivacyScreen(connection, identity, request, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.VIEW_ONLY }
    });
  });

  it.each(["control", "presentation", "route", "revoke"] as const)("rejects a late privacy acknowledgement after %s retirement", async (retirement) => {
    const fake = new FakeDevicePeerOwner(), revocations = new RevocationHarness();
    const coordinator = fakeCoordinator(fake, { onRevoked: revocations.subscribe }).coordinator, lease = await start(coordinator);
    let complete!: (value: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = async (_authority, input) => input.action === "setRemoteDesktopPrivacyScreen"
      ? new Promise(resolve => { complete = resolve; }) : defaultResponse(input);
    const pending = coordinator.setPrivacyScreen(connection, identity, create(contract.RemoteDesktopPrivacyScreenRequestSchema, {
      leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true
    }), signal);
    const reason = retirement === "control" || retirement === "presentation" ? contract.RemoteDesktopFailureReason.PRIVACY_EXPIRED
      : contract.RemoteDesktopFailureReason.STOPPED;
    const rejected = expect(pending).rejects.toMatchObject({ detail: { reason } });
    if (retirement === "control") await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);
    else if (retirement === "presentation") await coordinator.setPresentation(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);
    else if (retirement === "route") fake.replaceRoute({ ...identity, routeGeneration: identity.routeGeneration + 1 });
    else revocations.revoke(connection.id);
    complete(completed(result("remoteDesktopPrivacyScreen", create(contract.RemoteDesktopPrivacyScreenResultSchema, { enabled: true }))));
    await rejected;
  });

  it.each(["completed", "failed"] as const)("rejects an old privacy %s receipt superseded by a newer off request on the same control", async (outcome) => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    let complete!: (value: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = async (_authority, input) => {
      const command = input.payload as contract.DevicePeerCommand;
      return command.action.case === "setRemoteDesktopPrivacyScreen" && command.action.value.enabled
        ? new Promise(resolve => { complete = resolve; }) : defaultResponse(input);
    };
    const request = create(contract.RemoteDesktopPrivacyScreenRequestSchema, { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true });
    const pending = coordinator.setPrivacyScreen(connection, identity, request, signal);
    const rejected = expect(pending).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.PRIVACY_EXPIRED } });
    await expect(coordinator.setPrivacyScreen(connection, identity, create(contract.RemoteDesktopPrivacyScreenRequestSchema, { ...request, enabled: false }), signal))
      .resolves.toMatchObject({ enabled: false });
    complete(outcome === "failed" ? failedRemoteDesktop(contract.RemoteDesktopFailureReason.PRIVACY_FAILED)
      : completed(result("remoteDesktopPrivacyScreen", create(contract.RemoteDesktopPrivacyScreenResultSchema, { enabled: true }))));
    await rejected;
  });

  it("rejects a privacy result that does not acknowledge the requested effect", async () => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    fake.dispatchHandler = async () => completed(result("remoteDesktopPrivacyScreen", create(contract.RemoteDesktopPrivacyScreenResultSchema, { enabled: false })));
    await expect(coordinator.setPrivacyScreen(connection, identity, create(contract.RemoteDesktopPrivacyScreenRequestSchema, {
      leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true
    }), signal)).rejects.toMatchObject({ code: "internal" });
  });

  it("routes opt-in counters and inline content with authenticated control and sync occurrence", async () => {
    const fake = new FakeDevicePeerOwner(); installClipboardSyncResponses(fake);
    const coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    const scope = { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration };
    const enabled = await coordinator.setClipboardSync(connection, identity,
      create(contract.RemoteDesktopClipboardSyncRequestSchema, { ...scope, enabled: true }), signal);
    const versionRequest = create(contract.RemoteDesktopClipboardVersionRequestSchema, { ...scope, syncGeneration: enabled.syncGeneration });
    await expect(coordinator.getClipboardVersion(connection, identity, versionRequest, signal)).resolves.toMatchObject({ version: "7" });
    expect(fake.calls.at(-1)).toMatchObject({ authority: { controllerDeviceId: connection.deviceId }, input: {
      action: "getRemoteDesktopClipboardVersion", effectKind: "read_only", payload: { action: { value: versionRequest } }
    } });
    const copied = await coordinator.transferClipboardContent(connection, identity, create(contract.RemoteDesktopClipboardContentRequestSchema, {
      ...scope, sync: true, syncGeneration: enabled.syncGeneration, version: "7", inline: true, action: { case: "copy", value: {} }
    }), signal);
    expect(copied).toMatchObject({ data: '{"text":"system clipboard"}', length: 27 });
    await expect(coordinator.transferClipboardContent(connection, identity, create(contract.RemoteDesktopClipboardContentRequestSchema, {
      ...scope, sync: true, syncGeneration: enabled.syncGeneration, version: "7", action: { case: "paste", value: { data: '{"text":"new copy"}' } }
    }), signal)).resolves.toMatchObject({ version: "8" });
    expect(fake.calls.at(-1)?.input.payload).toMatchObject({ action: { case: "transferRemoteDesktopClipboardContent", value: {
      ...scope, sync: true, syncGeneration: enabled.syncGeneration, version: "7", inline: false,
      action: { case: "paste", value: { data: '{"text":"new copy"}' } }
    } } });
  });

  it("routes opaque clipboard fingerprints through version reads and conditional system writes", async () => {
    const fake = new FakeDevicePeerOwner(); installClipboardSyncResponses(fake);
    const coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    const scope = { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration };
    const enabled = await coordinator.setClipboardSync(connection, identity,
      create(contract.RemoteDesktopClipboardSyncRequestSchema, { ...scope, enabled: true }), signal);
    const version = "abcdef0123456789".repeat(4), next = "fedcba9876543210".repeat(4);
    const original = fake.dispatchHandler;
    fake.dispatchHandler = async (authority, input) => input.action === "getRemoteDesktopClipboardVersion"
      ? completed(result("remoteDesktopClipboardVersion", create(contract.RemoteDesktopClipboardVersionResultSchema, { version })))
      : input.action === "transferRemoteDesktopClipboardContent"
        ? completed(result("remoteDesktopClipboardContent", create(contract.RemoteDesktopClipboardContentResultSchema, { version: next })))
        : original(authority, input);
    await expect(coordinator.getClipboardVersion(connection, identity, create(contract.RemoteDesktopClipboardVersionRequestSchema, {
      ...scope, syncGeneration: enabled.syncGeneration
    }), signal)).resolves.toMatchObject({ version });
    await expect(coordinator.transferClipboardContent(connection, identity, create(contract.RemoteDesktopClipboardContentRequestSchema, {
      ...scope, sync: true, syncGeneration: enabled.syncGeneration, version,
      action: { case: "paste", value: { data: '{"text":"new system copy"}' } }
    }), signal)).resolves.toMatchObject({ version: next });
    expect(fake.calls.at(-1)?.input.payload).toMatchObject({ action: { value: { version } } });
  });

  it("keeps viewing after an unknown clipboard write without authorizing automatic effect replay", async () => {
    const fake = new FakeDevicePeerOwner(); installClipboardSyncResponses(fake);
    const coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    const scope = { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration };
    const enabled = await coordinator.setClipboardSync(connection, identity,
      create(contract.RemoteDesktopClipboardSyncRequestSchema, { ...scope, enabled: true }), signal);
    const original = fake.dispatchHandler;
    fake.dispatchHandler = async (authority, input) => input.action === "transferRemoteDesktopClipboardContent"
      ? { protocolVersion: 1, kind: "response", requestId: "unknown-clipboard", targetDeviceId: identity.targetDeviceId,
        routeGeneration: identity.routeGeneration, outcome: "outcome_unknown", errorCode: "target_failed" }
      : original(authority, input);
    await expect(coordinator.transferClipboardContent(connection, identity, create(contract.RemoteDesktopClipboardContentRequestSchema, {
      ...scope, sync: true, syncGeneration: enabled.syncGeneration, version: "abcdef0123456789".repeat(4),
      action: { case: "paste", value: { data: '{"text":"unknown system copy"}' } }
    }), signal)).rejects.toMatchObject({ code: "aborted", detail: {
      reason: contract.RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE, retryable: false
    } });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toBeDefined();
    expect(fake.actions().filter(action => action === "transferRemoteDesktopClipboardContent")).toHaveLength(1);
  });

  it("rejects an old counter receipt after off/on even with the same current control generation", async () => {
    const fake = new FakeDevicePeerOwner(); installClipboardSyncResponses(fake);
    const coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    const scope = { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration };
    const enabled = await coordinator.setClipboardSync(connection, identity,
      create(contract.RemoteDesktopClipboardSyncRequestSchema, { ...scope, enabled: true }), signal);
    const original = fake.dispatchHandler;
    let complete!: (value: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = async (authority, input) => input.action === "getRemoteDesktopClipboardVersion"
      ? new Promise(resolve => { complete = resolve; }) : original(authority, input);
    const request = create(contract.RemoteDesktopClipboardVersionRequestSchema, { ...scope, syncGeneration: enabled.syncGeneration });
    const pending = coordinator.getClipboardVersion(connection, identity, request, signal);
    const rejected = expect(pending).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED } });
    await coordinator.setClipboardSync(connection, identity, create(contract.RemoteDesktopClipboardSyncRequestSchema, { ...scope, enabled: false }), signal);
    await coordinator.setClipboardSync(connection, identity, create(contract.RemoteDesktopClipboardSyncRequestSchema, { ...scope, enabled: true }), signal);
    complete(completed(result("remoteDesktopClipboardVersion", create(contract.RemoteDesktopClipboardVersionResultSchema, { version: "7" }))));
    await rejected;
    await expect(coordinator.getClipboardVersion(connection, identity, request, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED }
    });
    expect(fake.actions().filter(action => action === "getRemoteDesktopClipboardVersion")).toHaveLength(1);
  });

  it.each(["control", "route", "revoke"] as const)("rejects an old sync write receipt after %s retirement", async retirement => {
    const fake = new FakeDevicePeerOwner(); installClipboardSyncResponses(fake);
    const revocations = new RevocationHarness();
    const coordinator = fakeCoordinator(fake, { onRevoked: revocations.subscribe }).coordinator, lease = await start(coordinator);
    const scope = { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration };
    const enabled = await coordinator.setClipboardSync(connection, identity,
      create(contract.RemoteDesktopClipboardSyncRequestSchema, { ...scope, enabled: true }), signal);
    const original = fake.dispatchHandler;
    let complete!: (value: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = async (authority, input) => input.action === "transferRemoteDesktopClipboardContent"
      ? new Promise(resolve => { complete = resolve; }) : original(authority, input);
    const pending = coordinator.transferClipboardContent(connection, identity, create(contract.RemoteDesktopClipboardContentRequestSchema, {
      ...scope, sync: true, syncGeneration: enabled.syncGeneration, version: "7", action: { case: "paste", value: { data: '{"text":"new copy"}' } }
    }), signal);
    const rejected = expect(pending).rejects.toMatchObject({ detail: { reason: retirement === "control"
      ? contract.RemoteDesktopFailureReason.CLIPBOARD_EXPIRED : contract.RemoteDesktopFailureReason.STOPPED } });
    if (retirement === "control") await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: false }, signal);
    else if (retirement === "route") fake.replaceRoute({ ...identity, routeGeneration: identity.routeGeneration + 1 });
    else revocations.revoke(connection.id);
    complete(completed(result("remoteDesktopClipboardContent", create(contract.RemoteDesktopClipboardContentResultSchema, { version: "8" }))));
    await rejected;
    expect(fake.actions().filter(action => action === "transferRemoteDesktopClipboardContent")).toHaveLength(1);
  });

  it("validates sync options before dispatch and requires the native version acknowledgement", async () => {
    const fake = new FakeDevicePeerOwner(); installClipboardSyncResponses(fake);
    const coordinator = fakeCoordinator(fake).coordinator, lease = await start(coordinator);
    const scope = { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration };
    const enabled = await coordinator.setClipboardSync(connection, identity,
      create(contract.RemoteDesktopClipboardSyncRequestSchema, { ...scope, enabled: true }), signal);
    for (const options of [
      { sync: false, syncGeneration: enabled.syncGeneration, version: "7" },
      { sync: true, syncGeneration: enabled.syncGeneration },
      { sync: true, syncGeneration: enabled.syncGeneration, version: "invalid" }
    ]) await expect(coordinator.transferClipboardContent(connection, identity, create(contract.RemoteDesktopClipboardContentRequestSchema, {
      ...scope, ...options, action: { case: "copy", value: {} }
    }), signal)).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fake.actions().filter(action => action === "transferRemoteDesktopClipboardContent")).toHaveLength(0);
    fake.dispatchHandler = async () => completed(result("remoteDesktopClipboardContent", create(contract.RemoteDesktopClipboardContentResultSchema)));
    await expect(coordinator.transferClipboardContent(connection, identity, create(contract.RemoteDesktopClipboardContentRequestSchema, {
      ...scope, sync: true, syncGeneration: enabled.syncGeneration, version: "7", action: { case: "paste", value: { data: '{"text":"new copy"}' } }
    }), signal)).rejects.toMatchObject({ code: "internal" });
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

  it("adopts mirror geometry and restores only the immutable source while preserving source-based resume", async () => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
    const original = await start(coordinator);
    let current = original;
    fake.dispatchHandler = async (_authority, input) => {
      const command = input.payload as contract.DevicePeerCommand;
      if (command.action.case === "setRemoteDesktopViewerDisplay" || command.action.case === "restoreRemoteDesktopViewerDisplay") {
        const restored = command.action.case === "restoreRemoteDesktopViewerDisplay";
        current = create(contract.RemoteDesktopLeaseSchema, { ...current, controlling: false,
          controlGeneration: current.controlGeneration + 1n,
          display: { ...original.display!, displayId: restored ? original.display!.displayId : "mirror-1",
            width: restored ? 1920 : 800, height: restored ? 1080 : 1200 } });
        return completed(result("remoteDesktopViewerDisplay", create(contract.RemoteDesktopViewerDisplayResultSchema, { lease: current })));
      }
      if (command.action.case === "startRemoteDesktop") {
        current = create(contract.RemoteDesktopLeaseSchema, { ...current, leaseId: "restored-resume",
          display: original.display, controlling: false, controlGeneration: current.controlGeneration + 1n });
        return completed(result("remoteDesktopLease", current));
      }
      if (command.action.case === "setRemoteDesktopControl") {
        current = create(contract.RemoteDesktopLeaseSchema, { ...current, controlling: true, controlGeneration: current.controlGeneration + 1n });
        return completed(result("remoteDesktopControlState", create(contract.RemoteDesktopControlStateSchema, {
          controlling: current.controlling, controlGeneration: current.controlGeneration
        })));
      }
      return defaultResponse(input);
    };
    await expect(coordinator.setViewerDisplay(connection, identity, { leaseId: original.leaseId,
      controlGeneration: original.controlGeneration, width: 800, height: 1200 }, signal)).resolves.toMatchObject({
      lease: { leaseId: original.leaseId, controlling: false, controlGeneration: 2n, display: { displayId: "mirror-1", width: 800, height: 1200 } }
    });
    await expect(coordinator.start(connection, identity, { displayId: "mirror-1", mode: contract.RemoteDesktopStartMode.RESUME }, signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.STOPPED } });
    const control = await coordinator.setControl(connection, identity, { leaseId: original.leaseId, enabled: true }, signal);
    await expect(coordinator.restoreViewerDisplay(connection, identity, { leaseId: original.leaseId,
      controlGeneration: control.controlGeneration }, signal)).resolves.toMatchObject({ lease: {
      leaseId: original.leaseId, controlling: false, controlGeneration: 4n, display: original.display
    } });
    const refitControl = await coordinator.setControl(connection, identity, { leaseId: original.leaseId, enabled: true }, signal);
    await coordinator.setViewerDisplay(connection, identity, { leaseId: original.leaseId,
      controlGeneration: refitControl.controlGeneration, width: 800, height: 1200 }, signal);
    await expect(coordinator.start(connection, identity, { displayId: original.display!.displayId, mode: contract.RemoteDesktopStartMode.RESUME }, signal))
      .resolves.toMatchObject({ leaseId: "restored-resume", controlling: false, controlGeneration: 7n, display: original.display });
    await expect(coordinator.heartbeat(connection, identity, original.leaseId, signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.STOPPED } });
    await expect(coordinator.heartbeat(connection, identity, "restored-resume", signal)).resolves.toBeDefined();
  });

  it.each(["old-mirror", "third-display", "old-lease", "stale-generation", "controlling"] as const)(
    "rejects a fitted RESUME %s receipt instead of adopting unrelated or unrestored geometry", async invalid => {
      const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
      const original = await start(coordinator);
      fake.dispatchHandler = async (_authority, input) => {
        if (input.action === "setRemoteDesktopViewerDisplay") return completed(result("remoteDesktopViewerDisplay",
          create(contract.RemoteDesktopViewerDisplayResultSchema, { lease: { ...original, controlling: false,
            controlGeneration: 2n, display: { ...original.display!, displayId: "mirror-1" } } })));
        if (input.action === "startRemoteDesktop") return completed(result("remoteDesktopLease", create(contract.RemoteDesktopLeaseSchema, {
          ...original, leaseId: invalid === "old-lease" ? original.leaseId : "resumed-lease",
          controlling: invalid === "controlling", controlGeneration: invalid === "stale-generation" ? 2n : 3n,
          display: { ...original.display!, displayId: invalid === "old-mirror" ? "mirror-1"
            : invalid === "third-display" ? "unrelated-display" : original.display!.displayId }
        })));
        return defaultResponse(input);
      };
      await coordinator.setViewerDisplay(connection, identity, { leaseId: original.leaseId,
        controlGeneration: original.controlGeneration, width: 800, height: 1200 }, signal);
      await expect(coordinator.start(connection, identity, { displayId: original.display!.displayId,
        mode: contract.RemoteDesktopStartMode.RESUME }, signal)).rejects.toMatchObject({ code: "internal" });
    }
  );

  it("allows a fitted physical-mode receipt to return to its immutable source", async () => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator), previous = fake.dispatchHandler;
    fake.dispatchHandler = async (authority, input) => input.action === "setRemoteDesktopViewerDisplay"
      ? completed(result("remoteDesktopViewerDisplay", create(contract.RemoteDesktopViewerDisplayResultSchema, {
        lease: { ...lease, controlling: false, controlGeneration: 2n, display: { ...lease.display!, displayId: "mirror-1" } }
      }))) : input.action === "setRemoteDesktopControl"
        ? completed(result("remoteDesktopControlState", create(contract.RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 3n })))
        : input.action === "setRemoteDesktopDisplayMode"
          ? completed(result("remoteDesktopDisplayMode", create(contract.RemoteDesktopDisplayModeResultSchema, {
            lease: { ...lease, controlling: false, controlGeneration: 4n, display: { ...lease.display!, width: 1280, height: 720 } }
          }))) : previous(authority, input);
    await coordinator.setViewerDisplay(connection, identity, { leaseId: lease.leaseId, controlGeneration: 1n, width: 800, height: 1200 }, signal);
    await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);
    await expect(coordinator.setDisplayMode(connection, identity, { leaseId: lease.leaseId,
      controlGeneration: 3n, modeId: "102", temporary: true }, signal)).resolves.toMatchObject({ lease: { display: { displayId: lease.display!.displayId } } });
  });

  it.each(["setRemoteDesktopViewerDisplay", "restoreRemoteDesktopViewerDisplay", "setRemoteDesktopDisplayMode"] as const)(
    "retains an unknown %s occurrence until an actual stop and blocks media, control and replacement", async (action) => {
      const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
      const lease = await start(coordinator), previous = fake.dispatchHandler;
      let generation = lease.controlGeneration;
      if (action === "setRemoteDesktopDisplayMode") {
        fake.dispatchHandler = async (authority, input) => input.action === "setRemoteDesktopViewerDisplay"
          ? completed(result("remoteDesktopViewerDisplay", create(contract.RemoteDesktopViewerDisplayResultSchema, { lease: {
            ...lease, controlling: false, controlGeneration: 2n, display: { ...lease.display!, displayId: "mirror-1" }
          } }))) : input.action === "setRemoteDesktopControl"
            ? completed(result("remoteDesktopControlState", create(contract.RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 3n })))
            : previous(authority, input);
        await coordinator.setViewerDisplay(connection, identity, { leaseId: lease.leaseId, controlGeneration: 1n, width: 800, height: 1200 }, signal);
        await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal);
        generation = 3n;
      }
      let stopFails = true;
      fake.dispatchHandler = async (authority, input) => input.action === action
        ? { protocolVersion: 1, kind: "response", requestId: "mirror-unknown", targetDeviceId: identity.targetDeviceId,
          routeGeneration: identity.routeGeneration, outcome: "outcome_unknown", errorCode: "receipt_lost" }
        : input.action === "stopRemoteDesktop" && stopFails
          ? failedRemoteDesktop(contract.RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE) : previous(authority, input);
      const input = { leaseId: lease.leaseId, controlGeneration: generation, width: 800, height: 1200 };
      await expect(action === "setRemoteDesktopViewerDisplay" ? coordinator.setViewerDisplay(connection, identity, input, signal)
        : action === "restoreRemoteDesktopViewerDisplay" ? coordinator.restoreViewerDisplay(connection, identity, input, signal)
          : coordinator.setDisplayMode(connection, identity, { ...input, modeId: "102", temporary: true }, signal)).rejects.toMatchObject({ code: "aborted" });
      await expect(coordinator.getFrame(connection, identity, { leaseId: lease.leaseId, cursorOverlay: false }, signal))
        .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_BUSY } });
      await expect(coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: true }, signal))
        .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_BUSY } });
      await expect(start(coordinator)).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_BUSY } });
      const exit = { leaseId: lease.leaseId, controlGeneration: generation, lockScreen: false };
      await expect(coordinator.stop(connection, identity, exit, signal)).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_RESTORE_UNAVAILABLE } });
      await expect(start(coordinator)).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_BUSY } });
      stopFails = false;
      await coordinator.stop(connection, identity, exit, signal);
      await expect(start(coordinator)).resolves.toMatchObject({ leaseId: lease.leaseId });
      expect(fake.actions().filter(value => value === action)).toHaveLength(1);
    });

  it("adopts a temporary physical mode on the same lease with actual geometry and a fresh control generation", async () => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator), previous = fake.dispatchHandler;
    const updated = create(contract.RemoteDesktopLeaseSchema, { ...lease, controlling: false,
      controlGeneration: lease.controlGeneration + 1n, display: { ...lease.display!, width: 1280, height: 720 } });
    fake.dispatchHandler = async (authority, input) => input.action === "setRemoteDesktopDisplayMode"
      ? completed(result("remoteDesktopDisplayMode", create(contract.RemoteDesktopDisplayModeResultSchema, { lease: updated })))
      : previous(authority, input);
    await expect(coordinator.setDisplayMode(connection, identity, { leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration, modeId: "102", temporary: true }, signal)).resolves.toMatchObject({ lease: updated });
    expect(fake.calls.at(-1)?.input.payload).toMatchObject({ action: { value: { temporary: true } } });
    await expect(coordinator.setHostMute(connection, identity, create(contract.RemoteDesktopHostMuteRequestSchema,
      { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true }), signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.VIEW_ONLY } });
    await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).resolves.toMatchObject({
      controlling: false, controlGeneration: updated.controlGeneration });
  });

  it("blocks media and controls during a temporary write and rejects an old-geometry frame receipt", async () => {
    const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator), previous = fake.dispatchHandler;
    let completeFrame!: (value: DevicePeerResponseFrame) => void, completeMode!: (value: DevicePeerResponseFrame) => void;
    fake.dispatchHandler = (authority, input) => input.action === "getRemoteDesktopFrame"
      ? new Promise(resolve => { completeFrame = resolve; })
      : input.action === "setRemoteDesktopDisplayMode" ? new Promise(resolve => { completeMode = resolve; }) : previous(authority, input);
    const frame = coordinator.getFrame(connection, identity, { leaseId: lease.leaseId, cursorOverlay: false }, signal);
    const staleFrame = expect(frame).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED } });
    const mode = coordinator.setDisplayMode(connection, identity, { leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration, modeId: "102", temporary: true }, signal);
    await expect(coordinator.getFrame(connection, identity, { leaseId: lease.leaseId, cursorOverlay: false }, signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_BUSY } });
    await expect(coordinator.setHostMute(connection, identity, create(contract.RemoteDesktopHostMuteRequestSchema,
      { leaseId: lease.leaseId, controlGeneration: lease.controlGeneration, enabled: true }), signal))
      .rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_BUSY } });
    completeFrame(completed(result("remoteDesktopFrame", create(contract.RemoteDesktopFrameResultSchema))));
    await staleFrame;
    completeMode(completed(result("remoteDesktopDisplayMode", create(contract.RemoteDesktopDisplayModeResultSchema, {
      lease: { ...lease, controlling: false, controlGeneration: 2n, display: { ...lease.display!, width: 1280, height: 720 } }
    }))));
    await expect(mode).resolves.toMatchObject({ lease: { leaseId: lease.leaseId, controlGeneration: 2n } });
  });

  it.each(["other-lease", "other-display", "controlling", "same-generation"] as const)(
    "rejects a temporary mode receipt with %s and retires the old coordinates", async (kind) => {
      const fake = new FakeDevicePeerOwner(), coordinator = fakeCoordinator(fake).coordinator;
      const lease = await start(coordinator);
      const updated = create(contract.RemoteDesktopLeaseSchema, { ...lease,
        leaseId: kind === "other-lease" ? "replacement" : lease.leaseId, controlling: kind === "controlling",
        controlGeneration: lease.controlGeneration + (kind === "same-generation" ? 0n : 1n),
        display: { ...lease.display!, displayId: kind === "other-display" ? "other" : lease.display!.displayId } });
      fake.dispatchHandler = async () => completed(result("remoteDesktopDisplayMode",
        create(contract.RemoteDesktopDisplayModeResultSchema, { lease: updated })));
      await expect(coordinator.setDisplayMode(connection, identity, { leaseId: lease.leaseId,
        controlGeneration: lease.controlGeneration, modeId: "102", temporary: true }, signal)).rejects.toMatchObject({ code: "internal" });
      await expect(coordinator.heartbeat(connection, identity, lease.leaseId, signal)).rejects.toMatchObject({
        detail: { reason: contract.RemoteDesktopFailureReason.STOPPED } });
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
      modeId: "101", temporary: false
    }, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LEASE_EXPIRED }
    });
    expect(fake.actions().filter((action) => action === "setRemoteDesktopDisplayMode")).toHaveLength(0);

    await expect(coordinator.setDisplayMode(connection, identity, {
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration,
      modeId: "101", temporary: false
    }, signal)).resolves.toEqual(create(contract.RemoteDesktopDisplayModeResultSchema));
    const command = fake.calls.at(-1)?.input.payload as contract.DevicePeerCommand;
    expect(command).toMatchObject({
      action: {
        case: "setRemoteDesktopDisplayMode",
        value: {
          leaseId: lease.leaseId,
          controlGeneration: lease.controlGeneration,
          modeId: "101", temporary: false
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
      modeId: "999", temporary: false
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
      modeId: "101", temporary: false
    }, signal);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(coordinator.setDisplayMode(connection, identity, {
      leaseId: lease.leaseId,
      controlGeneration: lease.controlGeneration,
      modeId: "101", temporary: false
    }, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.DISPLAY_BUSY }
    });
    expect(fake.actions().filter((action) => action === "setRemoteDesktopDisplayMode")).toHaveLength(1);
    finish?.(completed(result("remoteDesktopDisplayMode", create(contract.RemoteDesktopDisplayModeResultSchema))));
    await expect(first).resolves.toEqual(create(contract.RemoteDesktopDisplayModeResultSchema));
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
      modeId: "101", temporary: false
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
      modeId: "101", temporary: false
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

  it.each(["viewer", "host"])("does not release %s ICE configuration after the lease is revoked in flight", async recipient => {
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

    const configuration = recipient === "viewer"
      ? coordinator.getIceConfiguration(connection, identity, "lease-1", signal)
      : coordinator.createOffer(connection, identity,
        { leaseId: "lease-1", attemptId: "attempt", offerSdp: "v=0\r\n", cursorOverlay: false }, signal);
    expect(finishConfiguration).toBeTypeOf("function");
    revocations.revoke(connection.id);
    finishConfiguration?.([]);

    await expect(configuration).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });
    expect(fake.actions()).toContain("stopRemoteDesktop");
    expect(fake.actions()).not.toContain("createRemoteDesktopOffer");
  });

  it("aborts hosted ICE after durable Connection revocation and releases only the original real DevicePeer lease", async () => {
    const store = new OperationalStore(":memory:"); stores.push(store);
    const controller = store.createConnection({ id: "turn-controller", deviceId: "turn-controller-device",
      device: { defaultName: "Controller", kind: "mobile", platform: "ios" }, name: "Controller", authKeyDigest: "controller-digest" });
    const target = store.createConnection({ id: "turn-target", deviceId: "turn-target-device",
      device: { defaultName: "Host", kind: "desktop", platform: "windows" }, name: "Host", authKeyDigest: "target-digest" });
    store.setDeviceRemoteControlEnabled(target.deviceId, true);
    const connections = new ConnectionManager(store);
    const harness = createInProcessDevicePeerHarness({ targetDeviceId: target.deviceId, capabilities: ["remote_desktop"], agent: {
      handle: async frame => frame.action === "startRemoteDesktop"
        ? { outcome: "completed", value: result("remoteDesktopLease", remoteDesktopLease()) }
        : { outcome: "completed", value: acknowledgementResult() }
    } });
    const owner = new DevicePeerOwner({ store }); owner.registerRoute(target, harness.transport);
    const selected = owner.listForCapabilities(controller, ["remote_desktop"], { kind: "desktop" })[0]!;
    let request: IceConfigurationInput | undefined;
    const getConfiguration = vi.fn((input: IceConfigurationInput) => new Promise<readonly contract.RemoteDesktopIceServer[]>((_resolve, reject) => {
      request = input;
      input.signal.addEventListener("abort", () => reject(new Error("Hosted ICE was cancelled.")), { once: true });
    }));
    const cleanupObservations: { readonly state: string; readonly aborted: boolean }[] = [];
    const releaseConfiguration = vi.fn(async (_leaseId: string) => {
      cleanupObservations.push({ state: store.getConnection(controller.id).state, aborted: request?.signal.aborted === true });
      throw new Error("The provider cleanup is temporarily unavailable.");
    });
    const coordinator = track(new RemoteDesktopCoordinator({ owner,
      onRevoked: (id, listener) => connections.onRevoked(id, listener), iceConfiguration: { getConfiguration, releaseConfiguration } }));
    const lease = await coordinator.start(controller, selected, { displayId: "display-1", mode: contract.RemoteDesktopStartMode.NEW }, signal);
    const pending = coordinator.getIceConfiguration(controller, selected, lease.leaseId, signal);
    const rejected = expect(pending).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.STOPPED } });
    expect(request).toMatchObject({ leaseId: lease.leaseId, controllerDeviceId: controller.deviceId, targetDeviceId: target.deviceId });
    request!.assertCurrent!();
    connections.revoke(controller.id);
    await rejected;
    expect(() => request!.assertCurrent!()).toThrow();
    expect(releaseConfiguration).toHaveBeenCalledExactlyOnceWith(lease.leaseId);
    expect(cleanupObservations).toEqual([{ state: "revoked", aborted: true }]);
    await expect(coordinator.getIceConfiguration(controller, selected, lease.leaseId, signal)).rejects.toThrow();
    expect(getConfiguration).toHaveBeenCalledOnce();
    expect(store.getConnection(target.id).state).toBe("active");
  });

  it.each(["route", "viewer", "service"] as const)("aborts in-flight ICE and releases its exact handle when the %s lifetime ends", async lifetime => {
    const fake = new FakeDevicePeerOwner();
    let request: IceConfigurationInput | undefined;
    const cleanupObservations: boolean[] = [];
    const releaseConfiguration = vi.fn(async (_leaseId: string) => { cleanupObservations.push(request?.signal.aborted === true); });
    const close = vi.fn(async () => undefined);
    const coordinator = fakeCoordinator(fake, { iceConfiguration: { releaseConfiguration, close,
      getConfiguration: input => new Promise<readonly contract.RemoteDesktopIceServer[]>((_resolve, reject) => {
        request = input;
        input.signal.addEventListener("abort", () => reject(new Error("Hosted ICE was cancelled.")), { once: true });
      }) } }).coordinator;
    const lease = await start(coordinator);
    const pending = coordinator.createOffer(connection, identity,
      { leaseId: lease.leaseId, attemptId: "turn-attempt", offerSdp: "v=0\r\n", cursorOverlay: false }, signal);
    const rejected = expect(pending).rejects.toThrow();
    expect(request?.signal.aborted).toBe(false);
    if (lifetime === "route") fake.replaceRoute({ ...identity, routeGeneration: identity.routeGeneration + 1 });
    else if (lifetime === "viewer") await coordinator.stop(connection, identity,
      { leaseId: lease.leaseId, lockScreen: false, controlGeneration: 0n }, signal);
    else await coordinator.close();
    await rejected;
    expect(releaseConfiguration).toHaveBeenCalledExactlyOnceWith(lease.leaseId);
    expect(cleanupObservations).toEqual([true]);
    expect(fake.actions()).not.toContain("createRemoteDesktopOffer");
    expect(close).toHaveBeenCalledTimes(lifetime === "service" ? 1 : 0);
  });

  it("keeps repeated service close pending until the owned ICE provider has actually retired", async () => {
    const fake = new FakeDevicePeerOwner();
    let finishCleanup!: () => void;
    const close = vi.fn(() => new Promise<void>(resolve => { finishCleanup = resolve; }));
    const coordinator = fakeCoordinator(fake, { iceConfiguration: { getConfiguration: async () => [], close } }).coordinator;
    await start(coordinator);
    const first = coordinator.close();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    let secondFinished = false;
    const second = coordinator.close().then(() => { secondFinished = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(secondFinished).toBe(false);
    } finally { finishCleanup(); await Promise.all([first, second]); }
    expect(close).toHaveBeenCalledOnce();
  });

  it("loads separate fresh scoped ICE material for viewer and host before dispatching the host offer", async () => {
    const fake = new FakeDevicePeerOwner();
    const getConfiguration = vi.fn(async () => [create(contract.RemoteDesktopIceServerSchema, {
      urls: ["turns:relay.example.test:5349?transport=tcp"], username: "temporary", credential: "secret",
      expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 600) }
    })]);
    const coordinator = fakeCoordinator(fake, { iceConfiguration: { getConfiguration } }).coordinator;
    await start(coordinator);
    fake.dispatchHandler = async (_authority, request) => request.action === "createRemoteDesktopOffer"
      ? completed(result("remoteDesktopOffer", create(contract.RemoteDesktopOfferResultSchema,
        { attemptId: "attempt", answerSdp: "v=0\r\n" }))) : defaultResponse(request);
    await coordinator.getIceConfiguration(connection, identity, "lease-1", signal);
    await coordinator.createOffer(connection, identity,
      { leaseId: "lease-1", attemptId: "attempt", offerSdp: "v=0\r\n", cursorOverlay: false }, signal);
    expect(getConfiguration).toHaveBeenCalledTimes(2);
    expect(getConfiguration).toHaveBeenLastCalledWith({ controllerDeviceId: connection.deviceId,
      targetDeviceId: identity.targetDeviceId, leaseId: "lease-1", signal: expect.any(AbortSignal), assertCurrent: expect.any(Function) });
    const command = fake.calls.find(call => call.input.action === "createRemoteDesktopOffer")?.input.payload as contract.DevicePeerCommand;
    expect(command.action.value).toMatchObject({ iceServers: [{ username: "temporary", credential: "secret" }] });
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
    await coordinator.stop(connection, identity, { leaseId: "lease-1", lockScreen: false, controlGeneration: 0n }, signal);
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

    const stopping = coordinator.stop(connection, identity, { leaseId: "lease-1", lockScreen: false, controlGeneration: 0n }, signal);
    expect(finishStop).toBeTypeOf("function");
    await expect(coordinator.heartbeat(connection, identity, "lease-1", signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.STOPPED }
    });

    finishStop?.(completed(acknowledgementResult()));
    await expect(stopping).resolves.toBeUndefined();
  });

  it("fences lock on exit by the exact lease generation while allowing view-only exit", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);
    const state = await coordinator.setControl(connection, identity, { leaseId: lease.leaseId, enabled: false }, signal);
    expect(state.controlling).toBe(false);
    for (const generation of [0n, lease.controlGeneration, 2n ** 63n]) {
      await expect(coordinator.stop(connection, identity, {
        leaseId: lease.leaseId, lockScreen: true, controlGeneration: generation
      }, signal)).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.LOCK_EXPIRED } });
    }
    expect(fake.actions()).not.toContain("stopRemoteDesktop");
    const exit = { leaseId: lease.leaseId, lockScreen: true, controlGeneration: state.controlGeneration };
    await expect(coordinator.stop(connection, identity, exit, signal)).resolves.toBeUndefined();
    expect(fake.calls.at(-1)).toMatchObject({ input: { action: "stopRemoteDesktop", effectKind: "side_effect",
      payload: { action: { case: "stopRemoteDesktop", value: exit } } } });
    await expect(coordinator.stop(connection, identity, exit, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LOCK_EXPIRED }
    });
    expect(fake.actions().filter((action) => action === "stopRemoteDesktop")).toHaveLength(1);
  });

  it.each(["revoke", "route", "shutdown"] as const)("cancels a captured lock exit after %s and rejects its late acknowledgement", async (retirement) => {
    const fake = new FakeDevicePeerOwner();
    const revocations = new RevocationHarness();
    const coordinator = fakeCoordinator(fake, { onRevoked: revocations.subscribe }).coordinator;
    const lease = await start(coordinator);
    let finish!: (value: DevicePeerResponseFrame) => void;
    let targetSignal: AbortSignal | undefined;
    fake.dispatchHandler = async (_authority, input) => {
      targetSignal = input.signal;
      return new Promise((resolve) => { finish = resolve; });
    };
    const pending = coordinator.stop(connection, identity, {
      leaseId: lease.leaseId, lockScreen: true, controlGeneration: lease.controlGeneration
    }, signal);
    const rejected = expect(pending).rejects.toMatchObject({ detail: { reason: contract.RemoteDesktopFailureReason.LOCK_EXPIRED } });
    expect(targetSignal?.aborted).toBe(false);
    if (retirement === "revoke") revocations.revoke(connection.id);
    else if (retirement === "route") fake.replaceRoute({ ...identity, routeGeneration: identity.routeGeneration + 1 });
    else await coordinator.close();
    expect(targetSignal?.aborted).toBe(true);
    finish(completed(acknowledgementResult()));
    await rejected;
    expect(fake.activeRouteSubscriptions()).toBe(0);
    expect(revocations.active(connection.id)).toBe(false);
  });

  it("reports native lock failure without restoring a reusable or retryable ending lease", async () => {
    const fake = new FakeDevicePeerOwner();
    const coordinator = fakeCoordinator(fake).coordinator;
    const lease = await start(coordinator);
    fake.dispatchHandler = async () => failedRemoteDesktop(contract.RemoteDesktopFailureReason.LOCK_FAILED);
    const exit = { leaseId: lease.leaseId, lockScreen: true, controlGeneration: lease.controlGeneration };
    await expect(coordinator.stop(connection, identity, exit, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LOCK_FAILED }
    });
    await expect(coordinator.stop(connection, identity, exit, signal)).rejects.toMatchObject({
      detail: { reason: contract.RemoteDesktopFailureReason.LOCK_EXPIRED }
    });
    expect(fake.actions().filter((action) => action === "stopRemoteDesktop")).toHaveLength(1);
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
  localDesktopRouteConnectionId(): string { return "managed-host-connection"; }

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

  captureRemoteDesktopCredentialCleanup(authority: DevicePeerAuthority): (handle: string) => Promise<void> {
    authority.assertCurrent(["remote_desktop"]);
    return async (handle) => {
      if (this.#currentIdentity === undefined || !sameSelectionIdentity(this.#currentIdentity, authority.identity)) return;
      const command = create(contract.DevicePeerCommandSchema, { capability: contract.DevicePeerCapabilityKind.REMOTE_DESKTOP,
        effect: contract.DevicePeerEffectKind.SIDE_EFFECT, action: { case: "closeRemoteDesktopCredentials",
          value: { handle } } });
      const input: DispatchInput = { capability: "remote_desktop", effectKind: "side_effect", action: "closeRemoteDesktopCredentials", payload: command };
      this.calls.push({ authority, input });
      await this.dispatchHandler(authority, input);
    };
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
    readonly udpMapping?: RemoteDesktopCoordinatorOptions["udpMapping"];
  } = {}
): { readonly coordinator: RemoteDesktopCoordinator } {
  return {
    coordinator: track(new RemoteDesktopCoordinator({
      owner: owner.asOwner(),
      onRevoked: options.onRevoked ?? (() => () => undefined),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.iceConfiguration === undefined ? {} : { iceConfiguration: options.iceConfiguration }),
      ...(options.udpMapping === undefined ? {} : { udpMapping: options.udpMapping })
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

function installClipboardSyncResponses(fake: FakeDevicePeerOwner): void {
  let generation = 0n;
  fake.dispatchHandler = async (_authority, input) => {
    const command = input.payload as contract.DevicePeerCommand;
    if (command.action.case === "setRemoteDesktopClipboardSync") return completed(result("remoteDesktopClipboardSync",
      create(contract.RemoteDesktopClipboardSyncResultSchema, { enabled: command.action.value.enabled, syncGeneration: ++generation })));
    if (command.action.case === "getRemoteDesktopClipboardVersion") return completed(result("remoteDesktopClipboardVersion",
      create(contract.RemoteDesktopClipboardVersionResultSchema, { version: "7" })));
    if (command.action.case === "transferRemoteDesktopClipboardContent" && command.action.value.sync) {
      const request = command.action.value, data = '{"text":"system clipboard"}';
      return completed(result("remoteDesktopClipboardContent", create(contract.RemoteDesktopClipboardContentResultSchema,
        request.action.case === "copy" && request.inline ? { data, length: data.length } : { version: "8" })));
    }
    return defaultResponse(input);
  };
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
      return completed(result("remoteDesktopDisplayMode", create(contract.RemoteDesktopDisplayModeResultSchema)));
    case "setRemoteDesktopHostMute":
      return completed(result("remoteDesktopHostMute", create(contract.RemoteDesktopHostMuteResultSchema, {
        enabled: command.action.case === "setRemoteDesktopHostMute" && command.action.value.enabled
      })));
    case "performRemoteDesktopSystemAction":
      return completed(result("remoteDesktopSystemAction", create(contract.RemoteDesktopSystemActionResultSchema, {
        action: command.action.case === "performRemoteDesktopSystemAction" ? command.action.value.action : contract.RemoteDesktopSystemActionKind.UNSPECIFIED
      })));
    case "setRemoteDesktopPrivacyScreen":
      return completed(result("remoteDesktopPrivacyScreen", create(contract.RemoteDesktopPrivacyScreenResultSchema, {
        enabled: command.action.case === "setRemoteDesktopPrivacyScreen" && command.action.value.enabled
      })));
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
